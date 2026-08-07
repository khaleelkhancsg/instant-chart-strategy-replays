// State-dependent risk geometry.
//
// Everything searched so far used STATIC geometry: a fixed stop, a fixed target,
// a fixed contract count. But passing a combine is a first-passage problem —
// P(reach +$3000 before -$2000, inside 30 days) — and the optimal bet size in
// that setting is not constant. It depends on where you are:
//
//   CUSHION      distance from the current trailing floor. A big cushion can
//                absorb a bigger bet; a small one cannot.
//   DISTANCE     how far the target still is. Near it, variance is the enemy —
//                you want to lock the pass, not risk giving it back.
//   TIME LEFT    the part no standard sizing rule handles. Kelly and
//                volatility-targeting are infinite-horizon. With 25 days left
//                and $500 banked you can be patient; with 3 days left and $2500
//                to find, patience guarantees a loss. Urgency should raise
//                variance deliberately.
//   LOCKED       once the floor freezes at breakeven the risk shape changes
//                entirely, because the downside stops trailing you up.
//
// Implementation note: contracts scale P&L linearly, so this needs no new
// bracket runs at all. The trade list is generated ONCE at 1 lot and the replay
// applies a state-dependent multiplier per trade. `assertFlatParity` confirms
// that a constant policy reproduces the ordinary fixed-size sweep exactly.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts, DAY } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();
const RULES = resolveRules({});
const SPLIT = Date.UTC(2023, 5, 1);
const all = windowStarts(bars, RULES.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const worst = (r) => Math.min(r.is, r.oos);

// ───────────────────── state-aware replay ─────────────────────
// Mirrors fastWindow's rules exactly; the only addition is that the contract
// count is computed per trade from the live challenge state.
function sizedWindow(T, startMs, R, policy) {
  const endMs = startMs + R.windowDays * DAY;
  const capPct = R.consistencyPct / 100;
  const eodTrail = R.trailingMode === "eod";

  let cum = 0, peak = 0, eodPeak = 0, locked = false;
  let curDay = -2147483648, dayPnl = 0, maxDayPnl = 0;
  let tradingDays = 0, dayHadTrade = false;

  let lo = 0, hi = T.n;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (T.entry[m] < startMs) lo = m + 1; else hi = m; }

  for (let k = lo; k < T.n; k++) {
    if (T.entry[k] >= endMs) break;
    const d = T.tday[k];
    if (d !== curDay) {
      if (curDay !== -2147483648 && eodTrail) {
        if (cum > eodPeak) eodPeak = cum;
        if (R.lockAtBreakeven && !locked && eodPeak >= R.trailingDD) locked = true;
      }
      curDay = d; dayPnl = 0; dayHadTrade = false;
    }
    if (R.dailyProfitStop > 0 && dayPnl >= R.dailyProfitStop) continue;
    if (R.circuitBreaker > 0 && dayPnl <= -R.circuitBreaker) continue;
    if (R.dailyLossLimit > 0 && dayPnl <= -R.dailyLossLimit) continue;
    if (!dayHadTrade) { dayHadTrade = true; tradingDays++; }

    // ── the sizing decision ──
    const floorNow = locked ? 0 : (eodTrail ? eodPeak : peak) - R.trailingDD;
    const cushion = cum - floorNow;                       // $ before the account dies
    const need = R.profitTarget - cum;                    // $ still required
    const elapsed = (T.entry[k] - startMs) / DAY;
    const left = Math.max(0.5, R.windowDays - elapsed);
    const stop1 = T.stopUsd[k] || 1;                      // $ risk per contract

    let c = policy.base;
    if (policy.cushionFrac > 0) {
      // Risk a fixed fraction of the surviving cushion on each trade.
      c = Math.max(1, Math.round((cushion * policy.cushionFrac) / stop1));
    }
    if (policy.urgency > 0) {
      // Behind schedule -> deliberately raise variance. `pace` is how far ahead
      // (>1) or behind (<1) the run is versus a straight line to the target.
      const expected = R.profitTarget * (elapsed / R.windowDays);
      const pace = expected <= 0 ? 1 : cum / expected;
      if (pace < 1) c = Math.round(c * (1 + policy.urgency * (1 - Math.min(1, pace))));
    }
    if (policy.nearTargetFrac > 0 && need <= R.profitTarget * policy.nearTargetFrac) {
      // Close to passing: shrink to protect what is already banked.
      c = Math.round(c * policy.nearTargetMult);
    }
    if (locked && policy.postLockMult !== 1) c = Math.round(c * policy.postLockMult);
    c = Math.max(policy.min, Math.min(policy.max, c));

    const p = T.pnl[k] * c;
    cum += p; dayPnl += p;
    if (dayPnl > maxDayPnl) maxDayPnl = dayPnl;
    if (!eodTrail) {
      if (cum > peak) peak = cum;
      if (R.lockAtBreakeven && !locked && peak >= R.trailingDD) locked = true;
    }
    const floor = locked ? 0 : (eodTrail ? eodPeak : peak) - R.trailingDD;
    if (cum <= floor) return -1;
    const okC = !R.consistencyGatesPass || maxDayPnl <= capPct * cum;
    if (cum >= R.profitTarget && okC && tradingDays >= R.minTradingDays) return 1;
  }
  return 0;
}

function sizedSweep(T, starts, R, policy) {
  let pass = 0, fail = 0;
  for (const s of starts) {
    const o = sizedWindow(T, s, R, policy);
    if (o === 1) pass++; else if (o === -1) fail++;
  }
  return { pass: (pass / starts.length) * 100, fail: (fail / starts.length) * 100 };
}

const FLAT = { base: 1, min: 1, max: 10, cushionFrac: 0, urgency: 0, nearTargetFrac: 0, nearTargetMult: 1, postLockMult: 1 };

// A constant policy must reproduce the ordinary fixed-size sweep exactly, or the
// state-aware path has diverged from the shipped rules somewhere.
function assertFlatParity(T) {
  for (const c of [1, 4, 8]) {
    const a = sizedSweep(T, IS.slice(0, 500), RULES, { ...FLAT, base: c, min: c, max: c });
    const b = fastSweep(T, IS.slice(0, 500), RULES, c);
    if (Math.abs(a.pass - b.pass) > 1e-9 || Math.abs(a.fail - b.fail) > 1e-9) {
      throw new Error(`flat-policy parity failed at ${c} lots: ${a.pass} vs ${b.pass}`);
    }
  }
}

// ───────────────────── the book to size ─────────────────────
// The best config found so far: a real per-trade edge that simply fires rarely.
const TF = 2;
const GATE = { ...NO_FILTER, startCt: 510, endCt: 660, effMin: 0.5 };
const tfBars = resample(bars, TF);
const ctx = buildFilterContext(tfBars);
const strat = strategies.get("momentum_roc");
const out = strat.compute(tfBars, resolveParams(strat, { timeframeMin: TF }));
const masked = applyFilters(out.sig, ctx, GATE);
const exec = resolveExec({ intradayOnly: true, sameBarReentry: false, noEntryMinsBeforeFlat: 10, contracts: 1, slAtrMult: 5, tpAtrMult: 1.5 });
const { trades } = runBrackets(tfBars, masked, out.atr, exec);
const st = tradeStats(trades);
console.log(`book: momentum_roc tf${TF}, 08:30-11:00 CT, eff>0.5, sl5/tp1.5`);
console.log(`  ${trades.length.toLocaleString()} trades, pf ${st.profitFactor.toFixed(3)}, exp $${st.expectancy.toFixed(2)}/lot\n`);

const T = flatten(trades);
T.stopUsd = new Float64Array(trades.length);
for (let i = 0; i < trades.length; i++) {
  T.stopUsd[i] = Math.abs(trades[i].entryPrice - trades[i].stop) * 2;   // $2/pt at 1 lot
}
assertFlatParity(T);
console.log("  flat-policy parity against the shipped sweep: OK\n");

// ───────────────────── baseline ─────────────────────
console.log("BASELINE — static sizing\n  lots    IS%    OOS%  worst");
let bestFlat = null;
for (let c = 1; c <= 10; c++) {
  const is = fastSweep(T, IS, RULES, c), oos = fastSweep(T, OOS, RULES, c);
  const r = { label: `flat ${c}`, is: is.pass, oos: oos.pass };
  if (!bestFlat || worst(r) > worst(bestFlat)) bestFlat = r;
  console.log(`  ${String(c).padStart(4)} ${is.pass.toFixed(1).padStart(6)} ${oos.pass.toFixed(1).padStart(7)} ${Math.min(is.pass, oos.pass).toFixed(1).padStart(6)}`);
}
console.log(`\n  best static: ${bestFlat.label} — worst half ${worst(bestFlat).toFixed(1)}%\n`);

// ───────────────────── policy search ─────────────────────
const policies = [];
for (const base of [2, 4, 6, 8, 10]) {
  for (const cushionFrac of [0, 0.05, 0.1, 0.15, 0.2, 0.3]) {
    for (const urgency of [0, 0.5, 1, 2]) {
      for (const [nearTargetFrac, nearTargetMult] of [[0, 1], [0.25, 0.5], [0.25, 0.25], [0.5, 0.5], [0.5, 0.25]]) {
        for (const postLockMult of [1, 0.5, 1.5, 2]) {
          for (const max of [6, 8, 10]) {
            policies.push({ base, min: 1, max, cushionFrac, urgency, nearTargetFrac, nearTargetMult, postLockMult });
          }
        }
      }
    }
  }
}
console.log(`POLICY SEARCH — ${policies.length.toLocaleString()} state-dependent sizing rules\n`);

const results = [];
let sims = 0;
for (const p of policies) {
  const is = sizedSweep(T, IS, RULES, p);
  sims += IS.length;
  if (is.pass < worst(bestFlat)) continue;          // must beat the static baseline
  const oos = sizedSweep(T, OOS, RULES, p);
  sims += OOS.length;
  results.push({ p, is: is.pass, oos: oos.pass });
}
results.sort((a, b) => worst(b) - worst(a));

const desc = (p) =>
  `base${String(p.base).padStart(2)} max${String(p.max).padStart(2)} ` +
  `cush${String(p.cushionFrac).padEnd(4)} urg${String(p.urgency).padEnd(3)} ` +
  `near${p.nearTargetFrac ? `${p.nearTargetFrac}x${p.nearTargetMult}` : "-   "} lock${String(p.postLockMult).padEnd(3)}`;

console.log(`  ${results.length.toLocaleString()} policies beat the static baseline in-sample\n`);
console.log("  policy                                                    IS%    OOS%  worst");
for (const r of results.slice(0, 25)) {
  console.log(`  ${desc(r.p)} ${r.is.toFixed(1).padStart(6)} ${r.oos.toFixed(1).padStart(7)} ${worst(r).toFixed(1).padStart(6)}`);
}

if (results.length) {
  const b = results[0];
  console.log(`\n  BEST DYNAMIC : IS ${b.is.toFixed(1)}% / OOS ${b.oos.toFixed(1)}%  (worst ${worst(b).toFixed(1)}%)`);
  console.log(`  BEST STATIC  : worst ${worst(bestFlat).toFixed(1)}%`);
  console.log(`  state-dependent sizing is worth ${(worst(b) - worst(bestFlat)).toFixed(1)}pp`);
}

// Which single lever carries it?
console.log("\n\nWHICH LEVER MATTERS? (best worst-half with only that one active)\n");
for (const [label, over] of [
  ["nothing (static)", {}],
  ["cushion-proportional only", { cushionFrac: 0.15 }],
  ["urgency only", { urgency: 1 }],
  ["reduce near target only", { nearTargetFrac: 0.25, nearTargetMult: 0.5 }],
  ["post-lock change only", { postLockMult: 0.5 }],
  ["post-lock increase only", { postLockMult: 2 }],
]) {
  let best = null;
  for (const base of [2, 4, 6, 8, 10]) {
    for (const max of [6, 8, 10]) {
      const p = { ...FLAT, base, max, ...over };
      const is = sizedSweep(T, IS, RULES, p);
      const oos = sizedSweep(T, OOS, RULES, p);
      sims += IS.length + OOS.length;
      const r = { is: is.pass, oos: oos.pass };
      if (!best || worst(r) > worst(best)) best = r;
    }
  }
  console.log(`  ${label.padEnd(28)} ${worst(best).toFixed(1).padStart(5)}%   (IS ${best.is.toFixed(1)} / OOS ${best.oos.toFixed(1)})`);
}

fs.writeFileSync("research/risk_geometry_results.json", JSON.stringify({ meta: { sims, policies: policies.length }, top: results.slice(0, 200) }, null, 1));
console.log(`\n  ${sims.toLocaleString()} window simulations`);
