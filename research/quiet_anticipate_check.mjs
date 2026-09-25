// Verify the two new strategies load, trade, and reproduce the research.
//
// Three things are checked, because each has bitten this project before:
//
//   1. the registry picks both up and neither throws
//   2. they produce a non-zero trade count through the real engine, which is
//      what a silently-NaN gate or indicator would destroy
//   3. the 5-minute book still reads like research/gated_fade_exit.mjs, allowing
//      for the engine now applying commission, the flip-on-opposite backstop and
//      a non-overlapping sequence rather than overlapping signals
//
// and the 1-minute twin is measured rather than shipped on an assumption.
//
//   node research/quiet_anticipate_check.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies({ force: true });

const IDS = ["macd_5m_quiet_anticipate", "macd_1m_quiet_anticipate"];
for (const id of IDS) {
  if (!strategies.has(id)) {
    console.error("  MISSING from the registry: " + id);
    process.exit(1);
  }
}

function summarise(s, over) {
  const p = resolveParams(s, over);
  const res = runStrategy(bars, s, p, s.execDefaults || {});
  const trades = res.trades || [];
  if (!trades.length) return null;
  const pnl = trades.map((t) => t.pnl);
  const pts = trades.map((t) => (t.exitPrice - t.entryPrice) * t.dir);
  const wins = pnl.filter((x) => x > 0);
  // Split on the calendar midpoint of the dataset, not the midpoint of the trade
  // list, so this is the same split the signal study reported.
  const t0 = trades[0].entryTime, t1 = trades[trades.length - 1].entryTime;
  const mid = t0 + (t1 - t0) / 2;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const avg = (a) => (a.length ? sum(a) / a.length : NaN);
  // Peak-to-trough on the realised curve, which is the number the account's
  // trailing drawdown actually watches.
  let eq = 0, peak = 0, dd = 0;
  for (const v of pnl) { eq += v; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  const byExit = {};
  for (const t of trades) byExit[t.reason] = (byExit[t.reason] || 0) + 1;
  return {
    n: trades.length,
    pnl: sum(pnl), avgPnl: avg(pnl), avgPts: avg(pts),
    win: (100 * wins.length) / trades.length,
    dd,
    hold: avg(trades.map((t) => t.bars)),
    h1: avg(trades.filter((t) => t.entryTime < mid).map((t) => t.pnl)),
    h2: avg(trades.filter((t) => t.entryTime >= mid).map((t) => t.pnl)),
    exits: Object.entries(byExit).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => k + " " + Math.round((100 * v) / trades.length) + "%").join("  "),
  };
}

const row = (lab, s) => "  " + lab.padEnd(28) + s.n.toLocaleString().padStart(7) +
  ("$" + Math.round(s.pnl).toLocaleString()).padStart(12) +
  ("$" + s.avgPnl.toFixed(2)).padStart(10) +
  s.avgPts.toFixed(2).padStart(9) + s.win.toFixed(1).padStart(7) +
  s.hold.toFixed(0).padStart(6) +
  ("$" + Math.round(s.dd).toLocaleString()).padStart(11) +
  ("$" + s.h1.toFixed(2) + " / $" + s.h2.toFixed(2)).padStart(20);

console.log("");
console.log("=".repeat(112));
console.log("NEW STRATEGIES THROUGH THE REAL ENGINE -- non-overlapping, commission charged, no stop");
console.log("=".repeat(112));
console.log("");
console.log("  config                       trades     total $     avg $   avg pts   win%  hold    max DD    1st / 2nd half");
console.log("  " + "-".repeat(104));

for (const id of IDS) {
  const s = strategies.get(id);
  console.log("");
  console.log("  " + s.name);
  for (const [lab, over] of [["fade 3 (the default)", {}],
                             ["fade 0 (hold to cross)", { fadeBars: 0 }],
                             ["fade 1", { fadeBars: 1 }],
                             ["fade 5", { fadeBars: 5 }],
                             ["gate off (any time, ADR off)", { sessionGate: "any", adrMax: 2 }],
                             ["RTH only (the complement)", { sessionGate: "rth" }]]) {
    const m = summarise(s, over);
    if (!m) { console.log("  " + lab.padEnd(28) + "      0 trades"); continue; }
    console.log(row(lab, m));
  }
  const d = summarise(s, {});
  if (d) console.log("    exits: " + d.exits);
}

console.log("");
console.log("  Commission is charged here and was not in the signal study, so avg $ lands");
console.log("  below the gross figures in research/gated_fade_exit.mjs. The gate-off and");
console.log("  RTH-only rows are the falsification checks: both should be clearly worse.");
console.log("");
