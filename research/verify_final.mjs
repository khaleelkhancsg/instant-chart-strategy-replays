// Characterise the SHIPPED configuration end to end, reading the strategy's own
// defaults so the spec cannot drift from what the repo actually runs.

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules, sweepWindows, sweepFunded, replayWindow, OUTCOME } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts, DAY } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();
const strat = strategies.get("donchian_eff_rth");
const TF = strat.timeframeMin;
const exec = resolveExec(strat.execDefaults);
const RULES = resolveRules(strat.rulesDefaults);

const tfBars = resample(bars, TF);
const ctx = buildFilterContext(tfBars);
const out = strat.compute(tfBars, resolveParams(strat, {}));
const masked = applyFilters(out.sig, ctx, { ...NO_FILTER, ...strat.filterDefaults });
const { trades } = runBrackets(tfBars, masked, out.atr, exec);
const st = tradeStats(trades);
const spanDays = (bars.ts[bars.count - 1] - bars.ts[0]) / DAY;

console.log(`SHIPPED CONFIG: ${TF}-min, hard cap $${exec.dayProfitStopUsd}, soft block $${RULES.dailyProfitStop}, ${exec.contracts} lots\n`);
console.log(`  trades              ${st.n.toLocaleString()}  (${(st.n / spanDays).toFixed(2)}/day)`);
console.log(`  win rate            ${st.winRate.toFixed(1)}%`);
console.log(`  profit factor       ${st.profitFactor.toFixed(3)}`);
console.log(`  expectancy          $${st.expectancy.toFixed(2)}`);
console.log(`  average win         $${st.avgWin.toFixed(2)}`);
console.log(`  average loss        $${st.avgLoss.toFixed(2)}`);
console.log(`  largest win/loss    $${st.maxWin.toFixed(0)} / $${st.maxLoss.toFixed(0)}`);
console.log(`  longs / shorts      ${st.longs.toLocaleString()} / ${st.shorts.toLocaleString()}`);
console.log(`  net P&L             $${st.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
console.log(`  commission          $${st.fees.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
console.log(`  gross before costs  $${(st.pnl + st.fees).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
console.log(`  commission share    ${((100 * st.fees) / (st.pnl + st.fees)).toFixed(0)}% of gross`);

const byReason = {};
let heldMin = 0;
for (const t of trades) { byReason[t.reason] = (byReason[t.reason] || 0) + 1; heldMin += (t.exitTime - t.entryTime) / 60000; }
console.log(`  exit reasons        ${Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${((100 * v) / st.n).toFixed(1)}%`).join("  ")}`);
console.log(`  mean hold           ${(heldMin / st.n).toFixed(0)} minutes`);

const T = flatten(trades);
const SPLIT = Date.UTC(2023, 5, 1);
const all = windowStarts(bars, RULES.windowDays, 1);
const IS = all.filter((t) => t < SPLIT), OOS = all.filter((t) => t >= SPLIT);
const isR = fastSweep(T, IS, RULES, 1), oosR = fastSweep(T, OOS, RULES, 1);
const sw = sweepWindows(trades, bars.ts[0], bars.ts[bars.count - 1], RULES, 1);
console.log(`\n  in-sample   ${isR.pass.toFixed(1)}% pass  ${isR.fail.toFixed(1)}% breach  (${IS.length} windows)`);
console.log(`  out-sample  ${oosR.pass.toFixed(1)}% pass  ${oosR.fail.toFixed(1)}% breach  (${OOS.length} windows)`);
console.log(`  all         ${sw.summary.passRate.toFixed(1)}% pass  ${sw.summary.failRate.toFixed(1)}% breach  ${sw.summary.openRate.toFixed(1)}% unresolved`);
console.log(`  median days to pass ${sw.summary.medianDaysToPass}`);

const byYear = new Map();
for (const w of sw.windows) {
  const y = new Date(w.startMs).getUTCFullYear();
  if (!byYear.has(y)) byYear.set(y, { n: 0, p: 0 });
  const r = byYear.get(y); r.n++; if (w.outcome === OUTCOME.PASS) r.p++;
}
console.log(`  by year: ` + [...byYear].sort().map(([y, r]) => `${y} ${((100 * r.p) / r.n).toFixed(0)}%`).join("  "));

// Sizing table under the shipped stops, since the old one predates the hard cap.
console.log(`\n  sizing (with both stops in force):`);
for (const c of [1, 4, 6, 8, 9, 10]) {
  const e2 = resolveExec({ ...strat.execDefaults, contracts: c });
  const { trades: tr2 } = runBrackets(tfBars, masked, out.atr, e2);
  const T2 = flatten(tr2);
  const a = fastSweep(T2, IS, RULES, 1), b = fastSweep(T2, OOS, RULES, 1);
  console.log(`    ${String(c).padStart(2)} lots  IS ${a.pass.toFixed(1).padStart(5)}%  OOS ${b.pass.toFixed(1).padStart(5)}%  worst ${Math.min(a.pass, b.pass).toFixed(1).padStart(5)}%`);
}

const fd = sweepFunded(trades, bars.ts[0], bars.ts[bars.count - 1], RULES, {}, 7);
console.log(`\n  funded: ${fd.summary.reachedPayout.toFixed(1)}% reach a payout, median ${fd.summary.medianDaysToFirstPayout}d to first,`);
console.log(`          median first $${(fd.summary.medianFirstPayout || 0).toFixed(0)}, mean total $${fd.summary.meanTotalPaid.toFixed(0)}/180d`);

const ex = sw.windows.find((w) => w.outcome === OUTCOME.PASS && w.daysUsed <= 10);
if (ex) {
  const r = replayWindow(trades, ex.startMs, RULES);
  console.log(`\n  example window ${new Date(ex.startMs).toISOString().slice(0, 10)}: passed in ${r.stats.daysUsed} days,`);
  console.log(`    ${r.stats.trades} trades taken / ${r.stats.skipped} skipped, net $${r.stats.netPnl.toFixed(0)},`);
  console.log(`    best day $${r.stats.maxDayPnl.toFixed(0)} (${r.stats.consistencyRatio.toFixed(0)}% of profit), closest to floor $${(r.stats.minCushion || 0).toFixed(0)}`);
}
