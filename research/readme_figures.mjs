// The README's other measured figures, re-run on the current engine:
//   node --max-old-space-size=8192 research/readme_figures.mjs
//
// 1. The no-overnight rule: trend_neutev and trend_vol_adaptive with overnight
//    holds allowed and with flat-by-15:05.
// 2. The reference strategy (trend_neutev, overnight allowed, as its spec has it):
//    pass / breach / unresolved, days to pass, per-trade edge, pass rate by year.
// 3. The funded stage: profit left in after each payout, $0 / $1,500 / $3,000.
// Calendar windows (the chart's sweep) throughout; the $3,000 evaluation.

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { runStrategy } from "../src/run.mjs";
import { resolveExec, tradeStats } from "../src/engine.mjs";
import { sweepWindows, sweepFunded, resolveRules, resolveFunded } from "../src/challenge.mjs";
import { evalBase } from "../src/evals.mjs";

const { bars } = loadBars();
const S = await loadStrategies();
const first = bars.ts[0], last = bars.ts[bars.count - 1];
const run = (id, x = {}) => {
  const s = S.get(id), b = evalBase(s, "3000");
  const exec = resolveExec({ ...b.exec, ...x });
  return { trades: runStrategy(bars, s, b.params, exec, { filter: b.filter }).trades, rules: resolveRules(b.rules) };
};
const pct = (n, d) => ((100 * n) / d).toFixed(1);

console.log("1. overnight allowed vs flat by 15:05 CT (all history)");
for (const id of ["trend_neutev", "trend_vol_adaptive"]) {
  const cells = [false, true].map((intraday) => {
    const r = run(id, { intradayOnly: intraday });
    return sweepWindows(r.trades, first, last, r.rules, 1).summary.passRate.toFixed(1) + "%";
  });
  console.log(`  ${id}: overnight ${cells[0]}, intraday-only ${cells[1]}`);
}

console.log("\n   why: trend_neutev's hold times with overnight allowed, and what a 15:05 CT deadline cuts");
{
  const tr = run("trend_neutev", { intradayOnly: false }).trades;
  const hours = (t) => (t.exitTime - t.entryTime) / 3600000;
  const at = (a, p) => { const v = a.slice().sort((x, y) => x - y); return v[Math.floor(p * (v.length - 1))]; };
  const W = tr.filter((t) => t.pnl > 0), L = tr.filter((t) => t.pnl <= 0);
  // still open at the first 15:05 CT after its entry
  const cut = (t) => (t.exitTime - t.entryTime) / 60000 > (t.entryCt < 905 ? 905 - t.entryCt : 905 + 1440 - t.entryCt);
  const gw = W.reduce((a, t) => a + t.gross, 0), gwCut = W.filter(cut).reduce((a, t) => a + t.gross, 0);
  console.log(`  winners: median hold ${at(W.map(hours), 0.5).toFixed(1)} h (90th percentile ${at(W.map(hours), 0.9).toFixed(1)} h); losers: median ${at(L.map(hours), 0.5).toFixed(1)} h`);
  console.log(`  cut by the deadline: ${pct(W.filter(cut).length, W.length)}% of winners, ${pct(L.filter(cut).length, L.length)}% of losers; ` +
              `$${(gwCut / 1e6).toFixed(2)}M of $${(gw / 1e6).toFixed(2)}M gross profit (${pct(gwCut, gw)}%) is in the cut winners`);
}

console.log("\n2. trend_neutev, overnight allowed");
{
  const r = run("trend_neutev", { intradayOnly: false });
  const sw = sweepWindows(r.trades, first, last, r.rules, 1), s = sw.summary, st = tradeStats(r.trades);
  console.log(`  ${s.n} windows: ${s.passRate.toFixed(1)}% pass, ${s.failRate.toFixed(1)}% breach, ${s.openRate.toFixed(1)}% unresolved, median ${s.medianDaysToPass} days to pass`);
  console.log(`  ${st.n} trades, PF ${st.profitFactor.toFixed(4)}, ${st.expectancy.toFixed(2)} $/trade, net ${Math.round(st.pnl)}`);
  const passNets = sw.windows.filter((w) => w.outcome === "PASS").map((w) => w.netPnl).sort((a, b) => a - b);
  console.log(`  median net of a passing window ${passNets[passNets.length >> 1]}`);
  const years = new Map();
  for (const w of sw.windows) { const y = new Date(w.startMs).getUTCFullYear(); const v = years.get(y) || [0, 0]; v[0]++; v[1] += w.outcome === "PASS"; years.set(y, v); }
  console.log("  by year: " + [...years].map(([y, [n, p]]) => `${y} ${pct(p, n)}%`).join(" | "));
  // the 5-year figure it used to be quoted on, against all history
  const cut = Date.UTC(2021, 6, 15), late = sw.windows.filter((w) => w.startMs >= cut);
  const netFrom = (lo, hi) => Math.round(r.trades.filter((t) => t.entryTime >= lo && t.entryTime < hi).reduce((a, t) => a + t.pnl, 0));
  console.log(`  from 2021-07-15 only: ${pct(late.filter((w) => w.outcome === "PASS").length, late.length)}% of ${late.length} windows, net ${netFrom(cut, Infinity)}; before it: net ${netFrom(-Infinity, cut)}`);
}

console.log("\n3. funded stage (trend_neutev, overnight allowed, 180 days): profit left in after a payout");
{
  const r = run("trend_neutev", { intradayOnly: false });
  for (const buf of [0, 1500, 3000]) {
    const f = sweepFunded(r.trades, first, last, r.rules, resolveFunded({ minBuffer: buf }), 7).summary;
    console.log(`  $${buf}: survive ${f.survived.toFixed(1)}%, median 1st payout ${f.medianFirstPayout == null ? "-" : "$" + Math.round(f.medianFirstPayout)}, mean total paid $${Math.round(f.meanTotalPaid)}, reached a payout ${f.reachedPayout.toFixed(1)}%`);
  }
  const ri = run("trend_neutev", { intradayOnly: true });
  const fi = sweepFunded(ri.trades, first, last, ri.rules, resolveFunded({}), 7).summary;
  console.log(`  flat by 15:05 instead: reached a payout ${fi.reachedPayout.toFixed(1)}%`);
}
