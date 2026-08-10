// Re-measure the profit stop under the rule the platform ACTUALLY enforces.
//
// The stop modelled until now blocked new ENTRIES on REALISED P&L, which let
// days overshoot the threshold — 50.3% of windows still printed a day above
// $1500 despite a $1500 stop. The real platform stop is on UNREALISED P&L and
// closes the open position the instant it is touched, so a day lands exactly ON
// the number.
//
// That should make a $1500 cap behave the way it was originally expected to: a
// day of exactly $1500 is exactly 50% of a $3000 target, so the consistency rule
// is satisfied at the boundary and no dilution grinding is needed.
//
// Note the contracts-are-a-multiplier shortcut does not apply here — the cap is
// an absolute dollar amount, so the engine must be re-run per contract count.

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules, replayWindow, OUTCOME } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();
const strat = strategies.get("donchian_eff_rth");
const TF = 2;
const tfBars = resample(bars, TF);
const ctx = buildFilterContext(tfBars);
const out = strat.compute(tfBars, resolveParams(strat, { timeframeMin: TF }));
const masked = applyFilters(out.sig, ctx, { ...NO_FILTER, ...strat.filterDefaults });

const all = windowStarts(bars, 30, 1);
const SPLIT = Date.UTC(2023, 5, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const worst = (a, b) => Math.min(a, b);

function build(lots, hardCap, softStop) {
  const exec = resolveExec({ ...strat.execDefaults, contracts: lots, dayProfitStopUsd: hardCap });
  const { trades } = runBrackets(tfBars, masked, out.atr, exec);
  const rules = resolveRules({ circuitBreaker: 150, dailyProfitStop: softStop });
  return { trades, rules, st: tradeStats(trades) };
}

console.log("SOFT entry-blocking stop (what was modelled) vs HARD unrealised cap (the platform)\n");
console.log("  mode                       lots   trades    pf   exp$    IS%    OOS%  worst   days>$1500");
const rows = [];
for (const [label, hard, soft] of [
  ["soft entry-block $750", 0, 750],
  ["soft entry-block $1500", 0, 1500],
  ["HARD unrealised $750", 750, 0],
  ["HARD unrealised $1000", 1000, 0],
  ["HARD unrealised $1250", 1250, 0],
  ["HARD unrealised $1500", 1500, 0],
  ["HARD unrealised $2000", 2000, 0],
  ["no stop at all", 0, 0],
]) {
  for (const lots of [10]) {
    const { trades, rules, st } = build(lots, hard, soft);
    const T = flatten(trades);
    const is = fastSweep(T, IS, rules, 1), oos = fastSweep(T, OOS, rules, 1);
    // How many windows still print a day above $1500?
    let over = 0;
    for (const s of IS) if (replayWindow(trades, s, rules).stats.maxDayPnl > 1500.01) over++;
    rows.push({ label, hard, soft, lots, is: is.pass, oos: oos.pass, w: worst(is.pass, oos.pass), over });
    console.log(
      `  ${label.padEnd(26)} ${String(lots).padStart(4)} ${String(trades.length).padStart(8)} ` +
      `${st.profitFactor.toFixed(3)} ${st.expectancy.toFixed(1).padStart(6)} ` +
      `${is.pass.toFixed(1).padStart(6)} ${oos.pass.toFixed(1).padStart(7)} ${worst(is.pass, oos.pass).toFixed(1).padStart(6)} ` +
      `${((100 * over) / IS.length).toFixed(1).padStart(11)}%`
    );
  }
}

const bestHard = rows.filter((r) => r.hard > 0).sort((a, b) => b.w - a.w)[0];
const bestSoft = rows.filter((r) => r.soft > 0).sort((a, b) => b.w - a.w)[0];
console.log(`\n  best SOFT: ${bestSoft.label} -> ${bestSoft.w.toFixed(1)}%`);
console.log(`  best HARD: ${bestHard.label} -> ${bestHard.w.toFixed(1)}%`);

// Now sweep the cap and the size together, since the two interact.
console.log("\n\nHARD CAP x CONTRACTS (the cap is absolute dollars, so size changes when it bites)\n");
console.log("  cap      " + [6, 7, 8, 9, 10].map((c) => `${c} lots`.padStart(9)).join(""));
let best = null;
for (const cap of [500, 750, 1000, 1250, 1500, 2000, 3000]) {
  const cells = [];
  for (const lots of [6, 7, 8, 9, 10]) {
    const { trades, rules } = build(lots, cap, 0);
    const T = flatten(trades);
    const is = fastSweep(T, IS, rules, 1), oos = fastSweep(T, OOS, rules, 1);
    const w = worst(is.pass, oos.pass);
    if (!best || w > best.w) best = { cap, lots, is: is.pass, oos: oos.pass, w };
    cells.push(`${w.toFixed(1)}%`.padStart(9));
  }
  console.log(`  $${String(cap).padEnd(7)}` + cells.join(""));
}
console.log(`\n  BEST: hard cap $${best.cap} at ${best.lots} lots -> IS ${best.is.toFixed(1)}% / OOS ${best.oos.toFixed(1)}% (worst ${best.w.toFixed(1)}%)`);
console.log(`  previously reported best (soft $750, 10 lots): 41.7%`);
