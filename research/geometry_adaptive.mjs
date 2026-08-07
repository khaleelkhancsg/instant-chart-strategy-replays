// Tests 1 and 2: state-dependent GEOMETRY, and scaling out.
//
//  (1) Currently the stop and target are fixed and only SIZE varies with state.
//      Here the trade PLAN itself changes: when far from target with time to
//      spare, take a wider target; when close to passing, take a nearer one that
//      resolves quickly. Same first-passage reasoning as the sizing work, applied
//      to the payoff shape rather than the stake.
//
//  (2) Scale-out banks part of the position at a nearer target and lets the rest
//      run. The earlier repo found this harmful under a 6:1 target, because it
//      amputated the fat tail the target depended on. At the current 1.5xATR
//      target there is barely a tail to amputate, so it may behave differently —
//      worth re-testing rather than inheriting the conclusion.
//
// Both need per-entry forward simulation (see lib_forward.mjs): changing the
// geometry changes the exit bar, which changes when the next trade can start, so
// the multiplier trick does not apply.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { SESSION } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { buildOutcomeTable } from "./lib_forward.mjs";
import { windowStarts, DAY } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();
const RULES = resolveRules({});
const SPLIT = Date.UTC(2023, 5, 1);
const all = windowStarts(bars, RULES.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const worst = (r) => Math.min(r.is, r.oos);

// The book from the filter search.
const TF = 2;
const tfBars = resample(bars, TF);
const ctx = buildFilterContext(tfBars);
const strat = strategies.get("momentum_roc");
const out = strat.compute(tfBars, resolveParams(strat, { timeframeMin: TF }));
const sig = applyFilters(out.sig, ctx, { ...NO_FILTER, startCt: 510, endCt: 660, effMin: 0.5 });

// Plan 0 is the incumbent; the rest are alternatives the policy may select.
const PLANS = [
  { sl: 5, tp: 1.5, t1: 0, t1Frac: 0, label: "sl5 tp1.5 (incumbent)" },
  { sl: 5, tp: 0.75, t1: 0, t1Frac: 0, label: "sl5 tp0.75 (quick)" },
  { sl: 5, tp: 3, t1: 0, t1Frac: 0, label: "sl5 tp3 (patient)" },
  { sl: 5, tp: 6, t1: 0, t1Frac: 0, label: "sl5 tp6 (very patient)" },
  { sl: 3, tp: 1.5, t1: 0, t1Frac: 0, label: "sl3 tp1.5 (tight stop)" },
  { sl: 5, tp: 3, t1: 1, t1Frac: 0.5, label: "scale: half at 1, rest at 3" },
  { sl: 5, tp: 3, t1: 1.5, t1Frac: 0.5, label: "scale: half at 1.5, rest at 3" },
  { sl: 5, tp: 6, t1: 1.5, t1Frac: 0.5, label: "scale: half at 1.5, rest at 6" },
  { sl: 5, tp: 6, t1: 1.5, t1Frac: 0.75, label: "scale: 3/4 at 1.5, rest at 6" },
];

console.log("building outcome tables (per signal bar, per plan) ...");
const t0 = Date.now();
const tbl = buildOutcomeTable(tfBars, sig, out.atr, PLANS, SESSION, 2);
console.log(`  ${tbl.count.toLocaleString()} signal bars x ${PLANS.length} plans in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const FEE_PER_LOT = 1.5;   // $0.75/side/contract round trip

/**
 * Replay with a per-trade PLAN choice and a contract count, both from state.
 * `pick(state)` returns { plan, contracts }.
 */
function replayAdaptive(startMs, pick) {
  const endMs = startMs + RULES.windowDays * DAY;
  const capPct = RULES.consistencyPct / 100;
  let cum = 0, eodPeak = 0, locked = false;
  let curDay = -2147483648, dayPnl = 0, maxDayPnl = 0, tradingDays = 0, dayHadTrade = false;
  let freeFrom = -1;   // bar index we are free to trade again from

  for (let k = 0; k < tbl.count; k++) {
    const eb = tbl.entryBar[k];
    const ts = tfBars.ts[eb];
    if (ts < startMs) continue;
    if (ts >= endMs) break;
    if (eb < freeFrom) continue;                     // still in a position

    const d = tfBars.tday[eb];
    if (d !== curDay) {
      if (curDay !== -2147483648) {
        if (cum > eodPeak) eodPeak = cum;
        if (RULES.lockAtBreakeven && !locked && eodPeak >= RULES.trailingDD) locked = true;
      }
      curDay = d; dayPnl = 0; dayHadTrade = false;
    }
    if (RULES.dailyProfitStop > 0 && dayPnl >= RULES.dailyProfitStop) continue;
    if (RULES.circuitBreaker > 0 && dayPnl <= -RULES.circuitBreaker) continue;
    if (RULES.dailyLossLimit > 0 && dayPnl <= -RULES.dailyLossLimit) continue;
    if (!dayHadTrade) { dayHadTrade = true; tradingDays++; }

    const floorNow = locked ? 0 : eodPeak - RULES.trailingDD;
    const elapsed = (ts - startMs) / DAY;
    const { plan, contracts } = pick({
      cum, cushion: cum - floorNow, need: RULES.profitTarget - cum,
      elapsed, left: RULES.windowDays - elapsed, locked,
    });

    const p = tbl.outcomes[plan].pnl[k] * contracts - FEE_PER_LOT * contracts;
    freeFrom = tbl.outcomes[plan].exitIdx[k];
    cum += p; dayPnl += p;
    if (dayPnl > maxDayPnl) maxDayPnl = dayPnl;

    const floor = locked ? 0 : eodPeak - RULES.trailingDD;
    if (cum <= floor) return -1;
    const okC = !RULES.consistencyGatesPass || maxDayPnl <= capPct * cum;
    if (cum >= RULES.profitTarget && okC && tradingDays >= RULES.minTradingDays) return 1;
  }
  return 0;
}

function sweep(starts, pick) {
  let pass = 0;
  for (const s of starts) if (replayAdaptive(s, pick) === 1) pass++;
  return (pass / starts.length) * 100;
}

// ── baseline: each fixed plan, each size ──
console.log("FIXED PLANS (no adaptation)\n");
console.log("  plan                            lots    IS%    OOS%  worst");
let best = null;
for (let p = 0; p < PLANS.length; p++) {
  let bestForPlan = null;
  for (const c of [6, 8, 10]) {
    const pick = () => ({ plan: p, contracts: c });
    const is = sweep(IS, pick), oos = sweep(OOS, pick);
    const r = { label: PLANS[p].label, p, c, is, oos };
    if (!bestForPlan || worst(r) > worst(bestForPlan)) bestForPlan = r;
    if (!best || worst(r) > worst(best)) best = r;
  }
  const b = bestForPlan;
  console.log(`  ${b.label.padEnd(32)} ${String(b.c).padStart(3)} ${b.is.toFixed(1).padStart(6)} ${b.oos.toFixed(1).padStart(7)} ${worst(b).toFixed(1).padStart(6)}`);
}
console.log(`\n  best fixed plan: ${best.label} at ${best.c} lots — worst half ${worst(best).toFixed(1)}%\n`);

// ── adaptive geometry ──
console.log("\nADAPTIVE GEOMETRY — plan chosen per trade from state\n");
const adaptives = [];
// Switch plan on how far behind schedule the run is, and on nearness to target.
for (const patient of [2, 3, 7]) {          // plan index used when behind / early
  for (const quick of [0, 1]) {             // plan index used when close to passing
    for (const nearFrac of [0.25, 0.4, 0.6]) {
      for (const c of [6, 8, 10]) {
        const pick = (s) => ({
          plan: s.need <= RULES.profitTarget * nearFrac ? quick : patient,
          contracts: c,
        });
        const is = sweep(IS, pick), oos = sweep(OOS, pick);
        adaptives.push({
          label: `patient=${PLANS[patient].label.split(" ")[0]}-${PLANS[patient].label.split(" ")[1]} quick=${PLANS[quick].label.split(" ")[1]} near${nearFrac}`,
          patient, quick, nearFrac, c, is, oos,
        });
      }
    }
  }
}
// Also: urgency-driven plan choice — behind schedule, take the wider target.
for (const behind of [2, 3] ) {
  for (const c of [6, 8, 10]) {
    const pick = (s) => {
      const expected = RULES.profitTarget * (s.elapsed / RULES.windowDays);
      const pace = expected <= 0 ? 1 : s.cum / expected;
      return { plan: pace < 0.8 ? behind : 0, contracts: c };
    };
    const is = sweep(IS, pick), oos = sweep(OOS, pick);
    adaptives.push({ label: `behind-schedule -> ${PLANS[behind].label}`, patient: behind, quick: 0, nearFrac: 0, c, is, oos });
  }
}

adaptives.sort((a, b) => worst(b) - worst(a));
console.log("  policy                                              lots    IS%    OOS%  worst");
for (const a of adaptives.slice(0, 15)) {
  console.log(`  ${a.label.padEnd(50)} ${String(a.c).padStart(3)} ${a.is.toFixed(1).padStart(6)} ${a.oos.toFixed(1).padStart(7)} ${worst(a).toFixed(1).padStart(6)}`);
}

const bestAdaptive = adaptives[0];
console.log(`\n  best adaptive : worst half ${worst(bestAdaptive).toFixed(1)}%`);
console.log(`  best fixed    : worst half ${worst(best).toFixed(1)}%`);
console.log(`  adapting the GEOMETRY is worth ${(worst(bestAdaptive) - worst(best)).toFixed(1)}pp`);

// ── scale-out verdict ──
console.log("\n\nSCALE-OUT VERDICT (fixed plans only, so the comparison is clean)\n");
for (let p = 0; p < PLANS.length; p++) {
  if (!PLANS[p].t1) continue;
  let bp = null;
  for (const c of [6, 8, 10]) {
    const pick = () => ({ plan: p, contracts: c });
    const r = { is: sweep(IS, pick), oos: sweep(OOS, pick) };
    if (!bp || worst(r) > worst(bp)) bp = { ...r, c };
  }
  console.log(`  ${PLANS[p].label.padEnd(32)} ${String(bp.c).padStart(3)} lots  worst ${worst(bp).toFixed(1)}%`);
}
console.log(`\n  versus the best non-scaling plan: ${worst(best).toFixed(1)}%`);

fs.writeFileSync("research/geometry_adaptive_results.json", JSON.stringify({ fixedBest: best, adaptives: adaptives.slice(0, 60) }, null, 1));
