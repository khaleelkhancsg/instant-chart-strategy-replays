// Measuring the RIGHT thing this time.
//
// The budget is shared, and it is REALISED P&L. A $200 win banked early means
// the -$500 breaker is $700 away for the rest of the day, not $500 -- so a win
// really does widen the room, and "capping the target frees no budget" was the
// wrong claim. Counting days where the ORB alone lost $500 measured none of it.
//
// There are two channels, and they pull opposite ways:
//   BREAKER   an ORB loss eats into the shared floor and can block the day
//   PROFIT    an ORB WIN of 3R can be $1,500, which trips the +$750 profit
//             block on its own and stops the donchian book for the session.
//             A capped, smaller win might leave the day open.
//
//   node research/orb_budget_channels.mjs

import { simulate, days, pass21, ORB_CFG } from "./joint_account.mjs";
import { dayStart, TS } from "./lib_orb.mjs";

const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const idx = (y) => days.findIndex((d) => yearOf(d) >= y);
const SHIP = { ...ORB_CFG, maxWidthPts: 31 };
const n = days.length, f24 = idx(2024), mid = f24 + Math.floor((n - f24) / 2);

function run(tpCapPts) {
  const r = simulate("both", { exclusive: true, donLots: 8,
    orbCfg: tpCapPts ? { ...SHIP, tpCapPts } : SHIP });
  const wins = r.oTr.filter((p) => p > 0);
  return { r, blk: r.blk, don: r.dTr.length,
           orbWin: 100 * wins.length / r.oTr.length,
           bigWin: r.oTr.filter((p) => p >= 750).length,
           all: pass21(r.arr), m26: pass21(r.arr.slice(idx(2026))),
           h1: pass21(r.arr.slice(f24, mid)), h2: pass21(r.arr.slice(mid)) };
}

console.log("\n" + "=".repeat(104));
console.log("WHY DAYS STOP TRADING, AND WHAT THE TARGET CAP DOES TO EACH CHANNEL");
console.log("=".repeat(104));
console.log("\n  target    days blocked by            don signals   don      ORB    ORB wins");
console.log("  cap       breaker  profit   cap      skipped      trades   win%   >= $750");
for (const cap of [null, 30, 40, 60, 80, 120]) {
  const x = run(cap);
  console.log("  " + (cap ? cap + " pts" : "none").padEnd(10) +
    String(x.blk.breaker).padStart(7) + String(x.blk.profit).padStart(8) +
    String(x.blk.cap).padStart(6) + String(x.blk.donSkipped).padStart(12) +
    String(x.don).padStart(12) + x.orbWin.toFixed(1).padStart(7) +
    String(x.bigWin).padStart(10) + (cap === null ? "   <- shipped" : ""));
}

console.log("\n" + "=".repeat(104));
console.log("AND WHAT THAT IS WORTH ON PASS RATE");
console.log("=".repeat(104));
console.log("\n  target cap    all years      2026    1st half   2nd half");
const rows = [];
for (const cap of [null, 30, 40, 60, 80, 120]) {
  const x = run(cap);
  rows.push({ cap, ...x });
  console.log("  " + (cap ? cap + " pts" : "none").padEnd(14) +
    (x.all.toFixed(1) + "%").padStart(9) + (x.m26.toFixed(1) + "%").padStart(10) +
    (x.h1.toFixed(1) + "%").padStart(12) + (x.h2.toFixed(1) + "%").padStart(11) +
    (cap === null ? "   <- shipped" : ""));
}
const ship = rows.find((r) => r.cap === null);
const best = rows.filter((r) => r.cap).sort((a, b) => b.h1 - a.h1)[0];
console.log("\n  best on the 1st half: " + best.cap + " pts -> 2nd half " +
            best.h2.toFixed(1) + "%   vs shipped " + ship.h2.toFixed(1) + "%   (" +
            (best.h2 - ship.h2 >= 0 ? "+" : "") + (best.h2 - ship.h2).toFixed(1) + "pp)");
