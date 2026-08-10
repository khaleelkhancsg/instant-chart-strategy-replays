// Fine sweep of the HARD unrealised cap, to locate the optimum precisely.
//
// Prediction worth testing: $1500 should be exactly optimal, because it is the
// LARGEST daily cap that can never violate the 50% consistency rule against a
// $3000 target. Below it, the cap truncates winners for no consistency benefit;
// above it, consistency violations reappear. If that reasoning is right the
// curve should peak sharply at 1500 rather than drifting.

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules, replayWindow } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();
const strat = strategies.get("donchian_eff_rth");
const tfBars = resample(bars, 2);
const ctx = buildFilterContext(tfBars);
const out = strat.compute(tfBars, resolveParams(strat, { timeframeMin: 2 }));
const masked = applyFilters(out.sig, ctx, { ...NO_FILTER, ...strat.filterDefaults });

const all = windowStarts(bars, 30, 1);
const SPLIT = Date.UTC(2023, 5, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const RULES = resolveRules({ circuitBreaker: 150, dailyProfitStop: 0 });

console.log("HARD unrealised cap, fine sweep. Prediction: a sharp peak at $1500,");
console.log("the largest cap that cannot violate 50% consistency against $3000.\n");
console.log("  cap      lots   trades     pf   exp$/tr    IS%    OOS%  worst   consistency-delayed");
let best = null;
for (const cap of [1000, 1200, 1300, 1400, 1450, 1500, 1550, 1600, 1750, 2000]) {
  for (const lots of [9, 10]) {
    const exec = resolveExec({ ...strat.execDefaults, contracts: lots, dayProfitStopUsd: cap });
    const { trades } = runBrackets(tfBars, masked, out.atr, exec);
    const st = tradeStats(trades);
    const T = flatten(trades);
    const is = fastSweep(T, IS, RULES, 1), oos = fastSweep(T, OOS, RULES, 1);
    const w = Math.min(is.pass, oos.pass);
    // How often does consistency actually delay a pass at this cap?
    let reached = 0, delayed = 0;
    for (const s of IS) {
      const r = replayWindow(trades, s, RULES);
      if (r.targetHitMs !== null) { reached++; if (r.passMs !== r.targetHitMs) delayed++; }
    }
    if (!best || w > best.w) best = { cap, lots, is: is.pass, oos: oos.pass, w };
    console.log(
      `  $${String(cap).padEnd(6)} ${String(lots).padStart(4)} ${String(trades.length).padStart(8)} ` +
      `${st.profitFactor.toFixed(3)} ${st.expectancy.toFixed(1).padStart(8)} ` +
      `${is.pass.toFixed(1).padStart(6)} ${oos.pass.toFixed(1).padStart(7)} ${w.toFixed(1).padStart(6)} ` +
      `${((100 * delayed) / Math.max(1, reached)).toFixed(1).padStart(18)}%`
    );
  }
}
console.log(`\n  BEST: $${best.cap} at ${best.lots} lots -> IS ${best.is.toFixed(1)}% / OOS ${best.oos.toFixed(1)}% (worst ${best.w.toFixed(1)}%)`);

// Does a soft stop layered ON TOP of the hard one add anything?
console.log("\n\nCan a soft entry-block be layered on top of the hard cap?\n");
console.log("  hard cap   soft stop   lots     IS%    OOS%  worst");
let best2 = null;
for (const soft of [0, 500, 750, 1000]) {
  for (const lots of [9, 10]) {
    const exec = resolveExec({ ...strat.execDefaults, contracts: lots, dayProfitStopUsd: 1500 });
    const { trades } = runBrackets(tfBars, masked, out.atr, exec);
    const rules = resolveRules({ circuitBreaker: 150, dailyProfitStop: soft });
    const T = flatten(trades);
    const is = fastSweep(T, IS, rules, 1), oos = fastSweep(T, OOS, rules, 1);
    const w = Math.min(is.pass, oos.pass);
    if (!best2 || w > best2.w) best2 = { soft, lots, is: is.pass, oos: oos.pass, w };
    console.log(`  $1500 ${(soft === 0 ? "off" : "$" + soft).padStart(11)} ${String(lots).padStart(6)} ${is.pass.toFixed(1).padStart(7)} ${oos.pass.toFixed(1).padStart(7)} ${w.toFixed(1).padStart(6)}`);
  }
}
console.log(`\n  best combined: hard $1500 + soft ${best2.soft === 0 ? "off" : "$" + best2.soft} at ${best2.lots} lots -> ${best2.w.toFixed(1)}%`);
