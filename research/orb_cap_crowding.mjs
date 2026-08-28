// Does a tighter ORB target pay for itself by leaving the donchian more room?
//
// The standalone test said no: capping the target lifts the ORB win rate and
// takes money off the table doing it. But the standalone book cannot see the
// cost the losses actually carry. An ORB loss spends the day's -$500 breaker,
// and once that is gone the donchian book is BLOCKED for the rest of the
// session -- so a losing ORB trade does not just lose its own money, it can
// cost every donchian trade that would have followed it.
//
// That makes this a joint-account question, and it makes the donchian LOT SIZE
// part of the same question: 8 lots was chosen against a book that had whatever
// budget it had, and changing how often the ORB eats that budget changes what
// size the donchian can afford.
//
//   node research/orb_cap_crowding.mjs

import { simulate, days, pass21, ORB_CFG } from "./joint_account.mjs";
import { dayStart, TS } from "./lib_orb.mjs";

const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const idx = (y) => days.findIndex((d) => yearOf(d) >= y);
const W = [[2019, "all"], [2024, "2024-26"], [2025, "2025-26"], [2026, "2026"]];
const n = days.length, f24 = idx(2024), mid = f24 + Math.floor((n - f24) / 2);
const SHIP = { ...ORB_CFG, maxWidthPts: 31 };

function score(tpCapPts, donLots) {
  const r = simulate("both", { exclusive: true, donLots,
    orbCfg: tpCapPts ? { ...SHIP, tpCapPts } : SHIP });
  return { pass: W.map(([y]) => pass21(r.arr.slice(idx(y)))),
           h1: pass21(r.arr.slice(f24, mid)), h2: pass21(r.arr.slice(mid)),
           perDay: r.arr.reduce((a, b) => a + b, 0) / r.arr.length,
           liq: r.liqDays };
}

console.log("\n" + "=".repeat(104));
console.log("DOES THE ORB CROWD OUT THE DONCHIAN? — how often the breaker is spent first");
console.log("=".repeat(104));
console.log("\n  ORB target   don lots  " + W.map(([, l]) => l.padStart(10)).join("") +
            "   liq days     $/day");
const grid = [];
for (const cap of [null, 40, 60, 80, 120]) {
  for (const lots of [8]) {
    const s = score(cap, lots);
    grid.push({ cap, lots, ...s });
    console.log("  " + (cap ? cap + " pts" : "none (3R)").padEnd(13) +
      String(lots).padStart(5) + "     " +
      s.pass.map((p) => (p.toFixed(1) + "%").padStart(10)).join("") +
      (s.liq + " (" + (100 * s.liq / n).toFixed(1) + "%)").padStart(13) +
      ("$" + s.perDay.toFixed(2)).padStart(10));
  }
}

console.log("\n" + "=".repeat(104));
console.log("AND IF THE ORB EATS LESS BUDGET, CAN THE DONCHIAN AFFORD MORE SIZE?");
console.log("=".repeat(104));
console.log("\n  ORB target   don lots  " + W.map(([, l]) => l.padStart(10)).join("") +
            "   liq days     $/day");
for (const cap of [null, 60]) {
  for (const lots of [6, 8, 10, 12]) {
    const s = score(cap, lots);
    grid.push({ cap, lots, ...s });
    console.log("  " + (cap ? cap + " pts" : "none (3R)").padEnd(13) +
      String(lots).padStart(5) + "     " +
      s.pass.map((p) => (p.toFixed(1) + "%").padStart(10)).join("") +
      (s.liq + " (" + (100 * s.liq / n).toFixed(1) + "%)").padStart(13) +
      ("$" + s.perDay.toFixed(2)).padStart(10));
  }
}

console.log("\n" + "=".repeat(104));
console.log("THE SPLIT — chosen on the 1st half of 2024-26, read on the 2nd");
console.log("=".repeat(104));
const uniq = [];
for (const g of grid) if (!uniq.some((u) => u.cap === g.cap && u.lots === g.lots)) uniq.push(g);
uniq.sort((a, b) => b.h1 - a.h1);
console.log("\n  config                  1st half   2nd half     delta");
for (const g of uniq.slice(0, 8)) {
  console.log("  " + ((g.cap ? g.cap + " pts" : "no cap") + ", " + g.lots + " lots").padEnd(24) +
    (g.h1.toFixed(1) + "%").padStart(9) + (g.h2.toFixed(1) + "%").padStart(11) +
    ((g.h2 - g.h1 >= 0 ? "+" : "") + (g.h2 - g.h1).toFixed(1) + "pp").padStart(10));
}
const ship = uniq.find((g) => g.cap === null && g.lots === 8);
console.log("\n  SHIPPED (no cap, 8 lots)   1st " + ship.h1.toFixed(1) +
            "%   2nd " + ship.h2.toFixed(1) + "%   rank #" +
            (uniq.indexOf(ship) + 1) + " of " + uniq.length + " on the 1st half");
console.log("  best on the 1st half:      " +
  (uniq[0].cap ? uniq[0].cap + " pts" : "no cap") + ", " + uniq[0].lots + " lots" +
  "   -> 2nd half " + uniq[0].h2.toFixed(1) + "%  vs shipped " + ship.h2.toFixed(1) + "%");
