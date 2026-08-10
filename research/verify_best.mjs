// Full verification and characterisation of the 41.7% configuration, so the
// spec written from it is grounded in measured numbers rather than recollection.

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules, replayWindow, sweepWindows, sweepFunded, OUTCOME } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats, EXIT } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts, DAY } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();

const TF = 2;
const GATE = { ...NO_FILTER, startCt: 8 * 60 + 30, endCt: 15 * 60, effMin: 0.5 };
const EXEC = {
  intradayOnly: true, flattenCt: 15 * 60 + 5, reopenCt: 17 * 60, noEntryMinsBeforeFlat: 10,
  sameBarReentry: false, flipOnOpposite: true, contracts: 10,
  slAtrMult: 5, tpAtrMult: 1.5, tpMode: "atr",
  commissionModel: "per-contract", commissionPerSide: 0.75, slippageTicks: 0,
  pointValue: 2, tickSize: 0.25, atrPeriod: 14, sizingMode: "fixed",
};
const RULES = resolveRules({ circuitBreaker: 150, dailyProfitStop: 750 });

const tfBars = resample(bars, TF);
const ctx = buildFilterContext(tfBars);
const strat = strategies.get("tpl_channel");
const params = resolveParams(strat, { timeframeMin: TF });
console.log("SIGNAL PARAMETERS (tpl_channel defaults at 2-min)");
for (const d of strat.params) console.log(`  ${d.key.padEnd(16)} ${params[d.key]}`);

const out = strat.compute(tfBars, params);
let rawSig = 0;
for (let i = 0; i < out.sig.length; i++) if (out.sig[i]) rawSig++;
const masked = applyFilters(out.sig, ctx, GATE);
let gatedSig = 0;
for (let i = 0; i < masked.length; i++) if (masked[i]) gatedSig++;
console.log(`\n  2-min bars           ${tfBars.close.length.toLocaleString()}`);
console.log(`  raw signal bars      ${rawSig.toLocaleString()}`);
console.log(`  after the gate       ${gatedSig.toLocaleString()} (${((100 * gatedSig) / rawSig).toFixed(1)}% kept)`);

const { trades } = runBrackets(tfBars, masked, out.atr, resolveExec(EXEC));
const st = tradeStats(trades);
const spanDays = (bars.ts[bars.count - 1] - bars.ts[0]) / DAY;

console.log(`\nTRADE STATISTICS (10 contracts, $0.75/side/contract, no slippage)`);
console.log(`  trades               ${st.n.toLocaleString()}   (${(st.n / spanDays).toFixed(2)}/day)`);
console.log(`  win rate             ${st.winRate.toFixed(1)}%`);
console.log(`  profit factor        ${st.profitFactor.toFixed(3)}`);
console.log(`  expectancy           $${st.expectancy.toFixed(2)} per trade`);
console.log(`  average win          $${st.avgWin.toFixed(2)}`);
console.log(`  average loss         $${st.avgLoss.toFixed(2)}`);
console.log(`  largest win / loss   $${st.maxWin.toFixed(0)} / $${st.maxLoss.toFixed(0)}`);
console.log(`  longs / shorts       ${st.longs.toLocaleString()} / ${st.shorts.toLocaleString()}`);
console.log(`  net P&L              $${st.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
console.log(`  commission paid      $${st.fees.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);

const byReason = {};
let heldMin = 0;
for (const t of trades) {
  byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  heldMin += (t.exitTime - t.entryTime) / 60000;
}
console.log(`\n  exit reasons         ${Object.entries(byReason).map(([k, v]) => `${k} ${((100 * v) / st.n).toFixed(1)}%`).join("  ")}`);
console.log(`  mean hold time       ${(heldMin / st.n).toFixed(0)} minutes`);

// ── challenge results ──
const T = flatten(trades);
const SPLIT = Date.UTC(2023, 5, 1);
const all = windowStarts(bars, RULES.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const is = fastSweep(T, IS, RULES, 1), oos = fastSweep(T, OOS, RULES, 1);
console.log(`\nCHALLENGE (target $3000, trailing DD $2000 EOD, breaker $150, profit stop $750)`);
console.log(`  in-sample  2019-05..2023-06   ${is.pass.toFixed(1)}% pass  ${is.fail.toFixed(1)}% breach   (${IS.length} windows)`);
console.log(`  out-of-sample 2023-06..2026-07 ${oos.pass.toFixed(1)}% pass  ${oos.fail.toFixed(1)}% breach   (${OOS.length} windows)`);

const sw = sweepWindows(trades, bars.ts[0], bars.ts[bars.count - 1], RULES, 1);
console.log(`  all ${sw.summary.n} windows           ${sw.summary.passRate.toFixed(1)}% pass, ${sw.summary.failRate.toFixed(1)}% breach, ${sw.summary.openRate.toFixed(1)}% unresolved`);
console.log(`  median days to pass  ${sw.summary.medianDaysToPass}`);

const byYear = new Map();
for (const w of sw.windows) {
  const y = new Date(w.startMs).getUTCFullYear();
  if (!byYear.has(y)) byYear.set(y, { n: 0, p: 0 });
  const r = byYear.get(y); r.n++; if (w.outcome === OUTCOME.PASS) r.p++;
}
console.log(`\n  by year: ` + [...byYear].sort().map(([y, r]) => `${y} ${((100 * r.p) / r.n).toFixed(0)}%`).join("  "));

const fd = sweepFunded(trades, bars.ts[0], bars.ts[bars.count - 1], RULES, {}, 7);
console.log(`\nFUNDED STAGE (5 winning days over $150, 180-day horizon)`);
console.log(`  reach a payout       ${fd.summary.reachedPayout.toFixed(1)}%`);
console.log(`  median days to first ${fd.summary.medianDaysToFirstPayout}`);
console.log(`  median first payout  $${(fd.summary.medianFirstPayout || 0).toFixed(0)}`);
console.log(`  mean total paid      $${fd.summary.meanTotalPaid.toFixed(0)} per 180 days`);

// A worked example window, for the spec.
const example = sw.windows.find((w) => w.outcome === OUTCOME.PASS && w.daysUsed <= 10);
if (example) {
  const r = replayWindow(trades, example.startMs, RULES);
  console.log(`\nWORKED EXAMPLE — window starting ${new Date(example.startMs).toISOString().slice(0, 10)}`);
  console.log(`  passed after ${r.stats.daysUsed} days, ${r.stats.trades} trades taken, ${r.stats.skipped} skipped by daily rules`);
  console.log(`  net $${r.stats.netPnl.toFixed(0)}, best day $${r.stats.maxDayPnl.toFixed(0)} (${r.stats.consistencyRatio.toFixed(0)}% of profit)`);
  console.log(`  closest approach to the floor: $${(r.stats.minCushion || 0).toFixed(0)}`);
}
