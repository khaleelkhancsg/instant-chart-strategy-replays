// Settle the recommended configuration, so the spec can state ONE answer.
//
// The document currently recommends both stops in one section and disabling the
// hard cap in another, and quotes the soft-only variant as 41.9% in one place
// and 41.4% in another (those are a $750 and a $1000 block — different configs).
// This measures the whole grid at zero and one tick, so the recommendation can
// be made on the realistic column rather than the idealised one.

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules, sweepWindows, sweepFunded, OUTCOME } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts, DAY } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();
const strat = strategies.get("donchian_eff_rth");
const tfBars = resample(bars, strat.timeframeMin);
const ctx = buildFilterContext(tfBars);
const out = strat.compute(tfBars, resolveParams(strat, {}));
const masked = applyFilters(out.sig, ctx, { ...NO_FILTER, ...strat.filterDefaults });
const all = windowStarts(bars, 30, 1);
const SPLIT = Date.UTC(2023, 5, 1);
const IS = all.filter((t) => t < SPLIT), OOS = all.filter((t) => t >= SPLIT);
const spanDays = (bars.ts[bars.count - 1] - bars.ts[0]) / DAY;

function run(hardCap, soft, lots, ticks) {
  const exec = resolveExec({ ...strat.execDefaults, contracts: lots, dayProfitStopUsd: hardCap, slippageTicks: ticks });
  const { trades } = runBrackets(tfBars, masked, out.atr, exec);
  const rules = resolveRules({ ...strat.rulesDefaults, dailyProfitStop: soft });
  const T = flatten(trades);
  const is = fastSweep(T, IS, rules, 1), oos = fastSweep(T, OOS, rules, 1);
  return { trades, rules, st: tradeStats(trades), is: is.pass, oos: oos.pass, w: Math.min(is.pass, oos.pass) };
}

console.log("FULL GRID — hard cap x soft block x size, at 0 and 1 tick of slippage\n");
console.log("  hard    soft   lots    pf     net$      0-tick worst   1-tick worst");
const rows = [];
for (const hard of [0, 1500]) {
  for (const soft of [0, 750, 1000, 1250]) {
    for (const lots of [8, 9, 10]) {
      const a = run(hard, soft, lots, 0);
      const b = run(hard, soft, lots, 1);
      rows.push({ hard, soft, lots, pf: a.st.profitFactor, net: a.st.pnl, w0: a.w, w1: b.w });
      console.log(
        `  ${(hard ? "$" + hard : "off").padStart(5)} ${(soft ? "$" + soft : "off").padStart(7)} ${String(lots).padStart(5)} ` +
        `${a.st.profitFactor.toFixed(3)} ${Math.round(a.st.pnl).toLocaleString().padStart(9)} ` +
        `${(a.w.toFixed(1) + "%").padStart(14)} ${(b.w.toFixed(1) + "%").padStart(14)}`
      );
    }
  }
}

console.log("\n\nRANKED BY 1-TICK PASS RATE (the realistic column)\n");
console.log("  hard    soft   lots    pf      net$   1-tick   0-tick   profitable?");
for (const r of rows.slice().sort((a, b) => b.w1 - a.w1).slice(0, 12)) {
  console.log(
    `  ${(r.hard ? "$" + r.hard : "off").padStart(5)} ${(r.soft ? "$" + r.soft : "off").padStart(7)} ${String(r.lots).padStart(5)} ` +
    `${r.pf.toFixed(3)} ${Math.round(r.net).toLocaleString().padStart(9)} ${(r.w1.toFixed(1) + "%").padStart(8)} ` +
    `${(r.w0.toFixed(1) + "%").padStart(8)}   ${r.pf > 1 ? "YES" : "no"}`
  );
}

// Best that is ALSO profitable — the configuration the spec should recommend.
const profitable = rows.filter((r) => r.pf > 1).sort((a, b) => b.w1 - a.w1)[0];
const anyBest = rows.slice().sort((a, b) => b.w1 - a.w1)[0];
console.log(`\n  best overall at 1 tick   : hard ${anyBest.hard || "off"}, soft ${anyBest.soft || "off"}, ${anyBest.lots} lots -> ${anyBest.w1.toFixed(1)}%  (pf ${anyBest.pf.toFixed(3)})`);
console.log(`  best PROFITABLE at 1 tick: hard ${profitable.hard || "off"}, soft ${profitable.soft || "off"}, ${profitable.lots} lots -> ${profitable.w1.toFixed(1)}%  (pf ${profitable.pf.toFixed(3)}, net $${Math.round(profitable.net).toLocaleString()})`);
console.log(`  difference: ${(anyBest.w1 - profitable.w1).toFixed(1)}pp`);

// Full detail on the recommended one.
const R = run(profitable.hard, profitable.soft, profitable.lots, 0);
const R1 = run(profitable.hard, profitable.soft, profitable.lots, 1);
console.log(`\n\nRECOMMENDED CONFIG IN DETAIL (hard ${profitable.hard || "off"}, soft $${profitable.soft}, ${profitable.lots} lots)\n`);
const st = R.st;
console.log(`  trades            ${st.n.toLocaleString()} (${(st.n / spanDays).toFixed(2)}/day)`);
console.log(`  win rate          ${st.winRate.toFixed(1)}%`);
console.log(`  profit factor     ${st.profitFactor.toFixed(3)}`);
console.log(`  expectancy        $${st.expectancy.toFixed(2)}`);
console.log(`  avg win / loss    $${st.avgWin.toFixed(0)} / $${st.avgLoss.toFixed(0)}`);
console.log(`  largest loss      $${st.maxLoss.toFixed(0)}`);
console.log(`  net / commission  $${Math.round(st.pnl).toLocaleString()} / $${Math.round(st.fees).toLocaleString()}`);
const byReason = {};
let held = 0;
for (const t of R.trades) { byReason[t.reason] = (byReason[t.reason] || 0) + 1; held += (t.exitTime - t.entryTime) / 60000; }
console.log(`  exits             ${Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${((100 * v) / st.n).toFixed(1)}%`).join("  ")}`);
console.log(`  mean hold         ${(held / st.n).toFixed(0)} min`);
console.log(`  pass  0 tick      IS ${R.is.toFixed(1)}% / OOS ${R.oos.toFixed(1)}%`);
console.log(`  pass  1 tick      IS ${R1.is.toFixed(1)}% / OOS ${R1.oos.toFixed(1)}%`);

const sw = sweepWindows(R.trades, bars.ts[0], bars.ts[bars.count - 1], R.rules, 1);
console.log(`  all windows       ${sw.summary.passRate.toFixed(1)}% pass, median ${sw.summary.medianDaysToPass} days`);
const byYear = new Map();
for (const w of sw.windows) {
  const y = new Date(w.startMs).getUTCFullYear();
  if (!byYear.has(y)) byYear.set(y, { n: 0, p: 0 });
  const r = byYear.get(y); r.n++; if (w.outcome === OUTCOME.PASS) r.p++;
}
console.log(`  by year           ` + [...byYear].sort().map(([y, r]) => `${y} ${((100 * r.p) / r.n).toFixed(0)}%`).join("  "));
const fd = sweepFunded(R.trades, bars.ts[0], bars.ts[bars.count - 1], R.rules, {}, 7);
console.log(`  funded            ${fd.summary.reachedPayout.toFixed(1)}% reach a payout, median first $${(fd.summary.medianFirstPayout || 0).toFixed(0)}, mean $${fd.summary.meanTotalPaid.toFixed(0)}/180d`);

console.log(`\n  sizing at this config (1 tick):`);
for (const c of [6, 8, 9, 10]) {
  const r = run(profitable.hard, profitable.soft, c, 1);
  console.log(`    ${String(c).padStart(2)} lots  IS ${r.is.toFixed(1).padStart(5)}%  OOS ${r.oos.toFixed(1).padStart(5)}%  worst ${r.w.toFixed(1).padStart(5)}%`);
}
