// What IS the shipped combined bot worth, and is there anything left to tune?
//
// The honest starting point: this project has already run two large searches on
// this data and both came back empty once controlled. 1,920 ORB configs gave a
// best-real of 29.4% against a best-SHUFFLED of 29.4%. 3,456 tap-level configs
// looked like +15.3pp until the right null was used, and then held ~1pp on
// held-out data. So the prior on "search harder" is poor, and a million
// simulations would reliably produce a beautiful in-sample winner that means
// nothing.
//
// What is worth doing instead, and what this does:
//   1. measure the SHIPPED configuration properly -- halves, costs, forward
//   2. a small joint sweep, selected on the FIRST half only and read on the
//      second, so the number reported is out-of-sample by construction
//   3. the same sweep against a matched NULL, so "the best config found" can be
//      compared with "the best config findable on noise"
//
// Usage:  node research/joint_optimise.mjs

import { simulate, days, pass21, forward, st, ORB_CFG } from "./joint_account.mjs";

const SHIPPED = { exclusive: true, orbCfg: ORB_CFG, donLots: 8 };
const H = days.length >> 1;
const half = (arr, first) => (first ? arr.slice(0, H) : arr.slice(H));

function score(opts) {
  const r = simulate("both", opts);
  return {
    arr: r.arr,
    all: pass21(r.arr), fwd: forward(r.arr),
    h1: pass21(half(r.arr, true)), h2: pass21(half(r.arr, false)),
    perDay: r.arr.reduce((a, b) => a + b, 0) / r.arr.length,
    liq: r.liqDays,
  };
}

console.log("\n" + "=".repeat(104));
console.log("WHAT THE SHIPPED COMBINED BOT IS WORTH");
console.log("=".repeat(104));
console.log("\n  costs   $/day   liquidated   21-day   no deadline   1st half   2nd half");
for (const cm of [1, 1.5, 2, 3]) {
  const r = score({ ...SHIPPED, costMult: cm });
  console.log("  x" + String(cm).padEnd(7) + ("$" + r.perDay.toFixed(2)).padStart(7) +
    (r.liq + " (" + (100 * r.liq / days.length).toFixed(1) + "%)").padStart(13) +
    r.all.toFixed(1).padStart(9) + "%" + r.fwd.toFixed(1).padStart(12) + "%" +
    r.h1.toFixed(1).padStart(11) + "%" + r.h2.toFixed(1).padStart(10) + "%");
}

// ---- 2. a small joint sweep, chosen on the first half only ---------------
const GRID = [];
for (const maxHoldMin of [2, 5, 10, 30])
  for (const rMult of [2.0, 3.0, 4.0])
    for (const donLots of [6, 8, 10])
      GRID.push({ maxHoldMin, rMult, donLots });

console.log("\n" + "=".repeat(104));
console.log("JOINT SWEEP -- " + GRID.length + " configs, selected on the FIRST half, read on the SECOND");
console.log("=".repeat(104));

const rows = [];
for (const g of GRID) {
  const opts = { exclusive: true, donLots: g.donLots,
                 orbCfg: { ...ORB_CFG, maxHoldMin: g.maxHoldMin, rMult: g.rMult } };
  const r = score(opts);
  rows.push({ g, ...r });
}
rows.sort((a, b) => b.h1 - a.h1);
console.log("\n  chosen on the 1st half           1stH     2ndH    delta      all   no-dl");
for (let i = 0; i < 8; i++) {
  const r = rows[i];
  console.log("  hold " + String(r.g.maxHoldMin).padStart(2) + "m, " + r.g.rMult + "R, " +
    r.g.donLots + " lots   " + r.h1.toFixed(1).padStart(8) + "%" + r.h2.toFixed(1).padStart(8) + "%" +
    (r.h2 - r.h1).toFixed(1).padStart(8) + "pp" + r.all.toFixed(1).padStart(9) + "%" +
    r.fwd.toFixed(1).padStart(7) + "%");
}
const shipRow = rows.find(r => r.g.maxHoldMin === 5 && r.g.rMult === 3.0 && r.g.donLots === 8);
const top10 = rows.slice(0, 10);
const avg = (a, k) => a.reduce((x, y) => x + y[k], 0) / a.length;
console.log("\n  best on the 1st half            -> its 2nd half:  " + rows[0].h2.toFixed(1) + "%");
console.log("  mean of the top 10 on the 1st   -> their 2nd half: " + avg(top10, "h2").toFixed(1) + "%");
console.log("  the SHIPPED config                                 " + shipRow.h2.toFixed(1) +
            "%   (ranked #" + (rows.indexOf(shipRow) + 1) + " of " + rows.length + " on the 1st half)");
console.log("  mean across ALL " + rows.length + " configs                       " +
            avg(rows, "h2").toFixed(1) + "%");

// ---- 3. the same search against a matched null ---------------------------
// Shuffling the ORB's LEVELS between days keeps the days, the geometry and the
// throughput and destroys only "this price is where the market kept turning".
// If the best config found on shuffled levels scores like the best config found
// on real ones, the search is fitting noise.
console.log("\n" + "=".repeat(104));
console.log("THE SAME SWEEP ON SHUFFLED LEVELS -- what is findable on noise");
console.log("=".repeat(104));
const nullRows = [];
for (const g of GRID) {
  const opts = { exclusive: true, donLots: g.donLots,
                 orbCfg: { ...ORB_CFG, maxHoldMin: g.maxHoldMin, rMult: g.rMult,
                           levelMode: "touchShuffled", levelSeed: 23 } };
  nullRows.push({ g, ...score(opts) });
}
nullRows.sort((a, b) => b.h1 - a.h1);
console.log("\n  best REAL config     1st half " + rows[0].h1.toFixed(1) + "%  ->  2nd half " +
            rows[0].h2.toFixed(1) + "%");
console.log("  best NULL config     1st half " + nullRows[0].h1.toFixed(1) + "%  ->  2nd half " +
            nullRows[0].h2.toFixed(1) + "%");
console.log("  gap on the held-out half: " + (rows[0].h2 - nullRows[0].h2).toFixed(1) + "pp");
console.log("\n  mean 2nd half, all configs:  real " + avg(rows, "h2").toFixed(1) +
            "%   null " + avg(nullRows, "h2").toFixed(1) + "%");
console.log("  spread of the real sweep on the 2nd half: " +
  Math.min(...rows.map(r => r.h2)).toFixed(1) + "% to " +
  Math.max(...rows.map(r => r.h2)).toFixed(1) + "%");
