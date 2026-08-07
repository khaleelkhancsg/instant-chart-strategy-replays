// Test 3: solve the sizing problem instead of searching it.
//
// Passing a combine is first passage with a deadline: reach +$3000 before the
// trailing floor, within the trades the window allows. That has an OPTIMAL
// state-dependent policy, and it can be computed by backward induction rather
// than guessed at by grid search.
//
// STATE   (cum, peak, tradesRemaining)
//   cum   realised P&L so far
//   peak  high-water mark, which sets the floor at peak-2000 until it locks at
//         breakeven; capped once locked because the floor stops moving
//   t     trades expected to remain before the deadline
// ACTION  contracts, 1..10
// VALUE   probability of reaching the target before the floor
//
// The transition uses the EMPIRICAL per-lot P&L distribution of the actual book,
// not a normal approximation — the payoff is deliberately skewed and a Gaussian
// would misprice exactly the tail that matters.
//
// DELIBERATE SIMPLIFICATION: the DP ignores the daily rules (circuit breaker,
// profit stop, loss limit) and treats the peak as intraday rather than EOD.
// Modelling those would explode the state space. So the DP produces a CANDIDATE
// policy, and that policy is then evaluated on the real data under the real
// rules. Theory proposes; the empirical replay judges.

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
const R = resolveRules({});
const SPLIT = Date.UTC(2023, 5, 1);
const all = windowStarts(bars, R.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const worst = (r) => Math.min(r.is, r.oos);

// ── the book ──
const TF = 2;
const tfBars = resample(bars, TF);
const ctx = buildFilterContext(tfBars);
const strat = strategies.get("momentum_roc");
const out = strat.compute(tfBars, resolveParams(strat, { timeframeMin: TF }));
const masked = applyFilters(out.sig, ctx, { ...NO_FILTER, startCt: 510, endCt: 660, effMin: 0.5 });
const exec = resolveExec({ intradayOnly: true, sameBarReentry: false, noEntryMinsBeforeFlat: 10, contracts: 1, slAtrMult: 5, tpAtrMult: 1.5 });
const { trades } = runBrackets(tfBars, masked, out.atr, exec);
const st = tradeStats(trades);
const spanDays = (bars.ts[bars.count - 1] - bars.ts[0]) / DAY;
const perDay = trades.length / spanDays;
console.log(`book: ${trades.length.toLocaleString()} trades, pf ${st.profitFactor.toFixed(3)}, $${st.expectancy.toFixed(2)}/lot, ${perDay.toFixed(2)}/day`);
console.log(`      => about ${Math.round(perDay * R.windowDays)} trades per 30-day window\n`);

// ── empirical per-lot P&L distribution ──
const NB = 61;
const pnls = trades.map((t) => t.pnl);
const lo = Math.min(...pnls), hi = Math.max(...pnls);
const binW = (hi - lo) / NB;
const binVal = new Float64Array(NB), binP = new Float64Array(NB);
for (const v of pnls) {
  const b = Math.min(NB - 1, Math.max(0, Math.floor((v - lo) / binW)));
  binP[b]++;
}
for (let b = 0; b < NB; b++) { binVal[b] = lo + (b + 0.5) * binW; binP[b] /= pnls.length; }
console.log(`per-lot P&L: min $${lo.toFixed(0)}, max $${hi.toFixed(0)}, mean $${st.expectancy.toFixed(2)}, ${NB} bins\n`);

// ── DP grid ──
const STEP = 50;                                   // dollars per bucket
const CUM_LO = -R.trailingDD - 200, CUM_HI = R.profitTarget;
const NC = Math.ceil((CUM_HI - CUM_LO) / STEP) + 1;
const NP = Math.ceil(R.trailingDD / STEP) + 1;     // peak beyond trailingDD == locked
const MAXT = Math.round(perDay * R.windowDays) + 10;
const LOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const cumIdx = (v) => Math.min(NC - 1, Math.max(0, Math.round((v - CUM_LO) / STEP)));
const cumVal = (i) => CUM_LO + i * STEP;
const peakIdx = (v) => Math.min(NP - 1, Math.max(0, Math.round(v / STEP)));
const peakVal = (i) => i * STEP;

console.log(`DP grid: ${NC} cum x ${NP} peak x ${MAXT} trades x ${LOTS.length} actions = ${(NC * NP * MAXT * LOTS.length).toLocaleString()} evaluations\n`);

let Vnext = new Float64Array(NC * NP);             // value with 0 trades left = 0
let Vcur = new Float64Array(NC * NP);
const policy = new Uint8Array(NC * NP * MAXT);

const t0 = Date.now();
for (let t = 1; t <= MAXT; t++) {
  for (let pi = 0; pi < NP; pi++) {
    const pv = peakVal(pi);
    const locked = pv >= R.trailingDD;
    const floor = locked ? 0 : pv - R.trailingDD;
    for (let ci = 0; ci < NC; ci++) {
      const cv = cumVal(ci);
      if (cv <= floor) { Vcur[ci * NP + pi] = 0; continue; }
      if (cv >= R.profitTarget) { Vcur[ci * NP + pi] = 1; continue; }

      let bestV = -1, bestC = 1;
      for (const c of LOTS) {
        let acc = 0;
        for (let b = 0; b < NB; b++) {
          const p = binP[b];
          if (p === 0) continue;
          const nc = cv + binVal[b] * c;
          if (nc <= floor) continue;                       // failed, contributes 0
          if (nc >= R.profitTarget) { acc += p; continue; } // passed
          const np = Math.max(pv, nc);
          acc += p * Vnext[cumIdx(nc) * NP + peakIdx(np)];
        }
        if (acc > bestV) { bestV = acc; bestC = c; }
      }
      Vcur[ci * NP + pi] = bestV;
      policy[(t - 1) * NC * NP + ci * NP + pi] = bestC;
    }
  }
  const tmp = Vnext; Vnext = Vcur; Vcur = tmp;
}
console.log(`  solved in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  DP's own estimate of P(pass) from a flat start: ${(Vnext[cumIdx(0) * NP + peakIdx(0)] * 100).toFixed(1)}%\n`);

// ── what does the optimal policy look like? ──
console.log("OPTIMAL LOTS, by cumulative P&L and trades remaining (peak = cum)\n");
console.log("  cum $   " + [30, 25, 20, 15, 10, 5, 3, 1].map((t) => `t=${String(t).padStart(2)}`).join("  "));
for (const cv of [-1500, -1000, -500, 0, 500, 1000, 1500, 2000, 2500]) {
  const ci = cumIdx(cv), pi = peakIdx(Math.max(0, cv));
  const row = [30, 25, 20, 15, 10, 5, 3, 1].map((t) => {
    const tt = Math.min(MAXT, t);
    return String(policy[(tt - 1) * NC * NP + ci * NP + pi]).padStart(4);
  });
  console.log(`  ${String(cv).padStart(6)}  ${row.join("  ")}`);
}

// ── evaluate the DP policy on real data, under the real rules ──
function dpPolicySweep(T, starts, urgencyScale) {
  const capPct = R.consistencyPct / 100;
  let pass = 0;
  for (const startMs of starts) {
    const endMs = startMs + R.windowDays * DAY;
    let cum = 0, eodPeak = 0, locked = false;
    let curDay = -2147483648, dayPnl = 0, maxDayPnl = 0, tradingDays = 0, dayHadTrade = false;
    let k = 0;
    while (k < T.n && T.entry[k] < startMs) k++;
    let outcome = 0;
    for (; k < T.n; k++) {
      if (T.entry[k] >= endMs) break;
      const d = T.tday[k];
      if (d !== curDay) {
        if (curDay !== -2147483648) {
          if (cum > eodPeak) eodPeak = cum;
          if (R.lockAtBreakeven && !locked && eodPeak >= R.trailingDD) locked = true;
        }
        curDay = d; dayPnl = 0; dayHadTrade = false;
      }
      if (R.dailyProfitStop > 0 && dayPnl >= R.dailyProfitStop) continue;
      if (R.circuitBreaker > 0 && dayPnl <= -R.circuitBreaker) continue;
      if (R.dailyLossLimit > 0 && dayPnl <= -R.dailyLossLimit) continue;
      if (!dayHadTrade) { dayHadTrade = true; tradingDays++; }

      // Trades expected to remain, from the deadline and the book's own rate.
      const daysLeft = Math.max(0, R.windowDays - (T.entry[k] - startMs) / DAY);
      const tRem = Math.max(1, Math.min(MAXT, Math.round(daysLeft * perDay * urgencyScale)));
      const c = policy[(tRem - 1) * NC * NP + cumIdx(cum) * NP + peakIdx(Math.max(0, locked ? R.trailingDD : eodPeak))] || 1;

      const p = T.pnl[k] * c;
      cum += p; dayPnl += p;
      if (dayPnl > maxDayPnl) maxDayPnl = dayPnl;
      const floor = locked ? 0 : eodPeak - R.trailingDD;
      if (cum <= floor) { outcome = -1; break; }
      const okC = !R.consistencyGatesPass || maxDayPnl <= capPct * cum;
      if (cum >= R.profitTarget && okC && tradingDays >= R.minTradingDays) { outcome = 1; break; }
    }
    if (outcome === 1) pass++;
  }
  return (pass / starts.length) * 100;
}

const T = flatten(trades);
console.log("\n\nEVALUATING THE DP POLICY ON REAL DATA, UNDER THE REAL RULES\n");
console.log("  best static (flat 10)              38.6% IS / 39.2% OOS");
console.log("  best searched dynamic policy       40.1% IS / 40.1% OOS\n");
console.log("  urgency scale    IS%    OOS%  worst");
const dpRows = [];
for (const u of [0.6, 0.8, 1.0, 1.25, 1.5, 2.0]) {
  const is = dpPolicySweep(T, IS, u), oos = dpPolicySweep(T, OOS, u);
  dpRows.push({ u, is, oos });
  console.log(`  ${String(u).padStart(12)} ${is.toFixed(1).padStart(7)} ${oos.toFixed(1).padStart(7)} ${Math.min(is, oos).toFixed(1).padStart(6)}`);
}
dpRows.sort((a, b) => worst(b) - worst(a));
const bestDp = dpRows[0];
console.log(`\n  BEST DP POLICY : IS ${bestDp.is.toFixed(1)}% / OOS ${bestDp.oos.toFixed(1)}%  (worst ${worst(bestDp).toFixed(1)}%)`);
console.log(`  vs searched    : 40.1%`);
console.log(`  vs static      : 38.6%`);
console.log(`\n  DP's own theoretical ceiling for this edge: ${(Vnext[cumIdx(0) * NP + peakIdx(0)] * 100).toFixed(1)}%`);
console.log(`  (ignores daily rules and uses an intraday peak, so it is optimistic —`);
console.log(`   the gap between it and the achieved number is what those rules cost)`);

fs.writeFileSync("research/dp_results.json", JSON.stringify({
  theoreticalCeiling: Vnext[cumIdx(0) * NP + peakIdx(0)], rows: dpRows,
}, null, 1));
