// Win rate on a static $1,000 stop.
//
// The phrase covers two different trades, so both are here:
//
//   A  RISK $1,000 -- the stop stays on the opposite level and the POSITION
//      doubles, so a stop-out costs $1,000 instead of $500. Same breathing
//      room, twice the money on the table.
//
//   B  STOP AT $1,000 -- the position stays as it is and the STOP moves out to
//      wherever $1,000 of loss sits. Today that would have been 50 points
//      instead of 23.75. This is the one that answers "give it room".
//
// Both collide with the platform: $1,000 IS the daily loss limit, so a single
// full stop-out ends the trading day. resolve() caps a loss at -$1,000 for
// exactly that reason, which means these variants book the cap itself.
//
//   node research/orb_dollar_stop.mjs

import { setups, resolve, dayStart, TS } from "./lib_orb.mjs";
import { simulate, days, pass21, ORB_CFG } from "./joint_account.mjs";

const C = { ...ORB_CFG };
const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const setupsOut = setups(C).out;

function book(opt) {
  const t = setupsOut.map((s) => resolve(s, { rMult: 3, maxHoldMin: 5,
    riskDollars: opt.riskDollars ?? 500, maxLots: 50, stopUsd: opt.stopUsd }));
  const t26 = t.filter((x) => yearOf(x.tday) >= 2026);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const st = (rows) => ({
    n: rows.length,
    win: 100 * rows.filter((r) => r.pnl > 0).length / rows.length,
    sl: 100 * rows.filter((r) => r.why === "SL").length / rows.length,
    tp: 100 * rows.filter((r) => r.why === "TP").length / rows.length,
    per: sum(rows.map((r) => r.pnl)) / rows.length,
    net: sum(rows.map((r) => r.pnl)),
    lots: sum(rows.map((r) => r.lots)) / rows.length,
    capped: 100 * rows.filter((r) => r.capped).length / rows.length,
    worst: Math.min(...rows.map((r) => r.raw)),
  });
  return { all: st(t), y26: st(t26) };
}

console.log("\n" + "=".repeat(108));
console.log("WIN RATE AND EVERYTHING THAT COMES WITH IT");
console.log("=".repeat(108));
console.log("\n  variant                        avg lots   win%    SL%    TP%   $/trade" +
            "         net   at the $1k cap   worst raw");
function row(label, opt) {
  const r = book(opt).all;
  console.log("  " + label.padEnd(30) + r.lots.toFixed(1).padStart(9) +
    r.win.toFixed(1).padStart(7) + r.sl.toFixed(1).padStart(7) +
    r.tp.toFixed(1).padStart(7) + ("$" + r.per.toFixed(0)).padStart(10) +
    ("$" + Math.round(r.net).toLocaleString()).padStart(12) +
    (r.capped.toFixed(1) + "%").padStart(17) +
    ("$" + Math.round(r.worst).toLocaleString()).padStart(12));
}
row("SHIPPED  level stop, $500", {});
console.log("");
row("A  risk $1,000 (level stop)", { riskDollars: 1000 });
row("B  stop AT $1,000, size as-is", { stopUsd: 1000 });
console.log("");
console.log("  the same, 2026 only");
console.log("  variant                        avg lots   win%    SL%    TP%   $/trade         net");
for (const [label, opt] of [["SHIPPED  level stop, $500", {}],
                            ["A  risk $1,000 (level stop)", { riskDollars: 1000 }],
                            ["B  stop AT $1,000, size as-is", { stopUsd: 1000 }]]) {
  const r = book(opt).y26;
  console.log("  " + label.padEnd(30) + r.lots.toFixed(1).padStart(9) +
    r.win.toFixed(1).padStart(7) + r.sl.toFixed(1).padStart(7) +
    r.tp.toFixed(1).padStart(7) + ("$" + r.per.toFixed(0)).padStart(10) +
    ("$" + Math.round(r.net).toLocaleString()).padStart(12));
}

// Win rate as a pure function of how much room the stop gets.
console.log("\n" + "=".repeat(108));
console.log("WIN RATE vs STOP SIZE — the whole curve, so the $1,000 point has context");
console.log("=".repeat(108));
console.log("\n  stop        win%    SL%    TP%   TIME%   $/trade         net    2026 win%");
for (const stopUsd of [250, 400, 500, 650, 800, 1000, 1500, 2000]) {
  const b = book({ stopUsd });
  const t = setupsOut.map((s) => resolve(s, { rMult: 3, maxHoldMin: 5,
    riskDollars: 500, maxLots: 50, stopUsd }));
  const tm = 100 * t.filter((x) => x.why === "TIME").length / t.length;
  console.log("  $" + String(stopUsd).padEnd(10) + b.all.win.toFixed(1).padStart(6) +
    b.all.sl.toFixed(1).padStart(7) + b.all.tp.toFixed(1).padStart(7) +
    tm.toFixed(1).padStart(8) + ("$" + b.all.per.toFixed(0)).padStart(10) +
    ("$" + Math.round(b.all.net).toLocaleString()).padStart(12) +
    (b.y26.win.toFixed(1) + "%").padStart(13));
}
console.log("\n  ('level stop, $500' is the shipped book: win 53.1%, $173/trade.)");
