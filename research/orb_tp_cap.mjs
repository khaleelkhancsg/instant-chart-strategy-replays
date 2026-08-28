// The other half of the idea: leave the stop where the structure puts it, and
// cap only the TARGET. On a wide-stop day 3R lands somewhere price will not
// reach inside five minutes, so the target never fires and the trade is decided
// by the clock. Capping it in absolute points takes the profit where the move
// actually goes.
//
//   node research/orb_tp_cap.mjs

import { setups, resolve, dayStart, TS } from "./lib_orb.mjs";

const BASE = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08,
               minTouch: 3, mode: "plain", stopAt: "opposite", rMult: 3.0,
               maxHoldMin: 5, giveUpCt: 570, riskDollars: 500, maxLots: 50,
               maxPerDay: 1 };
const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const sum = (a) => a.reduce((x, y) => x + y, 0);
const out = setups(BASE).out;

function run(tpCapPts, fromYear) {
  const rows = out.map((s) => ({
    ...resolve(s, { rMult: 3, maxHoldMin: 5, riskDollars: 500, maxLots: 50, tpCapPts }),
    year: yearOf(s.day) })).filter((r) => r.year >= fromYear);
  const p = (w) => 100 * rows.filter((r) => r.why === w).length / rows.length;
  return { n: rows.length,
           win: 100 * rows.filter((r) => r.pnl > 0).length / rows.length,
           tp: p("TP"), sl: p("SL"), time: p("TIME"),
           per: sum(rows.map((r) => r.pnl)) / rows.length,
           net: sum(rows.map((r) => r.pnl)) };
}

console.log("\n" + "=".repeat(96));
console.log("CAPPING THE TARGET ONLY — the stop stays where the levels put it");
console.log("=".repeat(96));
for (const [fy, label] of [[2026, "2026 only"], [2025, "2025-26"], [2019, "all years"]]) {
  console.log("\n  " + label);
  console.log("  target cap   trades   win%    TP%    SL%   TIME%    $/trade        net");
  for (const cap of [15, 20, 30, 40, 60, 80, 120, Infinity]) {
    const r = run(cap, fy);
    console.log("  " + (cap === Infinity ? "none (3R)" : cap + " pts").padEnd(13) +
      String(r.n).padStart(6) + r.win.toFixed(1).padStart(7) +
      r.tp.toFixed(1).padStart(7) + r.sl.toFixed(1).padStart(7) +
      r.time.toFixed(1).padStart(8) + ("$" + r.per.toFixed(0)).padStart(11) +
      ("$" + Math.round(r.net).toLocaleString()).padStart(11) +
      (cap === Infinity ? "   <- shipped" : ""));
  }
}
console.log("\n  Reading it: a tighter target converts TIME exits into TP exits and lifts");
console.log("  the win rate. Whether that is worth anything is the $/trade column.");
