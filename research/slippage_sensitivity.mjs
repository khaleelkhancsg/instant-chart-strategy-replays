// How much does slippage actually cost the PASS RATE?
//
// The "$56,000 of slippage" figure quoted earlier was cumulative over 7.2 years,
// which is the wrong denominator for this decision. Combines are independent
// 30-day attempts, and what matters is the cost inside ONE window, against a
// $3000 target and a $2000 drawdown — not the total across 5,623 trades you will
// never take consecutively.
//
// So: measure pass rate directly against slippage, and state the per-combine
// dollar cost rather than the lifetime one.

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules, replayWindow, OUTCOME } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts, DAY } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();
const strat = strategies.get("donchian_eff_rth");
const RULES = resolveRules(strat.rulesDefaults);
const tfBars = resample(bars, strat.timeframeMin);
const ctx = buildFilterContext(tfBars);
const out = strat.compute(tfBars, resolveParams(strat, {}));
const masked = applyFilters(out.sig, ctx, { ...NO_FILTER, ...strat.filterDefaults });

const all = windowStarts(bars, RULES.windowDays, 1);
const SPLIT = Date.UTC(2023, 5, 1);
const IS = all.filter((t) => t < SPLIT), OOS = all.filter((t) => t >= SPLIT);

// What one tick actually costs, per trade and per combine.
const lots = strat.execDefaults.contracts;
const perTick = 0.25 * 2 * lots;          // tick x $/pt x contracts, one side
console.log(`One tick, ${lots} lots: $${perTick.toFixed(2)} per side, $${(perTick * 2).toFixed(2)} round trip\n`);

console.log("PASS RATE vs SLIPPAGE (both stops in force, 10 lots)\n");
console.log("  ticks/side  $/trade   trades      pf    exp$    IS%    OOS%   worst   median trades/window");
const rows = [];
for (const ticks of [0, 0.25, 0.5, 1, 1.5, 2, 3]) {
  const exec = resolveExec({ ...strat.execDefaults, slippageTicks: ticks });
  const { trades } = runBrackets(tfBars, masked, out.atr, exec);
  const st = tradeStats(trades);
  const T = flatten(trades);
  const is = fastSweep(T, IS, RULES, 1), oos = fastSweep(T, OOS, RULES, 1);

  // Trades actually taken inside a window, and what slippage cost that window.
  const counts = [];
  for (const s of IS.slice(0, 600)) counts.push(replayWindow(trades, s, RULES).stats.trades);
  counts.sort((a, b) => a - b);
  const medTrades = counts[Math.floor(counts.length / 2)];

  rows.push({ ticks, is: is.pass, oos: oos.pass, w: Math.min(is.pass, oos.pass), medTrades, perTrade: ticks * perTick * 2 });
  console.log(
    `  ${String(ticks).padStart(10)} ${(ticks * perTick * 2).toFixed(2).padStart(8)} ${String(trades.length).padStart(8)} ` +
    `${st.profitFactor.toFixed(3)} ${st.expectancy.toFixed(1).padStart(7)} ` +
    `${is.pass.toFixed(1).padStart(6)} ${oos.pass.toFixed(1).padStart(6)} ${Math.min(is.pass, oos.pass).toFixed(1).padStart(7)} ${String(medTrades).padStart(20)}`
  );
}

const base = rows[0];
console.log("\n\nWHAT IT COSTS PER COMBINE, which is the decision that matters\n");
console.log("  ticks/side   cost per combine   pass rate   vs zero slippage");
for (const r of rows) {
  const perCombine = r.perTrade * r.medTrades;
  console.log(
    `  ${String(r.ticks).padStart(10)} ${("$" + perCombine.toFixed(0)).padStart(18)} ${(r.w.toFixed(1) + "%").padStart(11)} ` +
    `${((r.w - base.w >= 0 ? "+" : "") + (r.w - base.w).toFixed(1) + "pp").padStart(18)}`
  );
}
console.log(`\n  (cost per combine = round-trip slippage x the median number of trades a`);
console.log(`   window actually takes, which is ${base.medTrades} — not the 5,623 lifetime total)`);

// The same at the profitable variant, for completeness.
console.log("\n\nSAME TEST ON THE PROFITABLE VARIANT (hard cap off)\n");
console.log("  ticks/side   trades      pf    exp$    IS%    OOS%   worst");
for (const ticks of [0, 0.5, 1, 2]) {
  const exec = resolveExec({ ...strat.execDefaults, slippageTicks: ticks, dayProfitStopUsd: 0 });
  const { trades } = runBrackets(tfBars, masked, out.atr, exec);
  const st = tradeStats(trades);
  const T = flatten(trades);
  const is = fastSweep(T, IS, RULES, 1), oos = fastSweep(T, OOS, RULES, 1);
  console.log(
    `  ${String(ticks).padStart(10)} ${String(trades.length).padStart(8)} ${st.profitFactor.toFixed(3)} ${st.expectancy.toFixed(1).padStart(7)} ` +
    `${is.pass.toFixed(1).padStart(6)} ${oos.pass.toFixed(1).padStart(6)} ${Math.min(is.pass, oos.pass).toFixed(1).padStart(7)}`
  );
}
