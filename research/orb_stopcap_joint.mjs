// The crowding is real and large: the ORB costs the donchian 690 trades, 316 of
// them because an ORB loss spent the day's -$500 breaker. It spends the breaker
// on 11.4% of ALL days.
//
// But a TARGET cap cannot fix that. Losses are made by the stop and the clock,
// and capping the target only turns some big time-exit wins into smaller TP
// wins -- measured, it changed breaker-spending days from 213 to 212.
//
// The lever that actually touches the budget is the STOP. A tighter stop means
// a smaller loss when it goes wrong, which leaves the breaker intact and the
// donchian book open. Standalone that looked terrible; the question here is
// whether the room it frees up pays for it. Swept against donchian lot size,
// because if the ORB stops eating the budget the donchian may afford more.
//
//   node research/orb_stopcap_joint.mjs

import { simulate, days, pass21, ORB_CFG } from "./joint_account.mjs";
import { dayStart, TS } from "./lib_orb.mjs";

const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const idx = (y) => days.findIndex((d) => yearOf(d) >= y);
const W = [[2019, "all"], [2024, "2024-26"], [2025, "2025-26"], [2026, "2026"]];
const n = days.length, f24 = idx(2024), mid = f24 + Math.floor((n - f24) / 2);
const SHIP = { ...ORB_CFG, maxWidthPts: 31 };
const alone = simulate("don", { exclusive: true, donLots: 8, orbCfg: SHIP });

function score(stopCapPts, donLots) {
  const orbCfg = stopCapPts ? { ...SHIP, stopCapPts } : SHIP;
  const r = simulate("both", { exclusive: true, donLots, orbCfg });
  const byDay = new Map();
  r.oTr.forEach((p, i) => byDay.set(r.oDay[i], (byDay.get(r.oDay[i]) || 0) + p));
  return { pass: W.map(([y]) => pass21(r.arr.slice(idx(y)))),
           h1: pass21(r.arr.slice(f24, mid)), h2: pass21(r.arr.slice(mid)),
           don: r.dTr.length, liq: r.liqDays,
           breaker: [...byDay.values()].filter((p) => p <= -500).length,
           perDay: r.arr.reduce((a, b) => a + b, 0) / r.arr.length };
}

console.log("\n" + "=".repeat(108));
console.log("TIGHTER ORB STOP -> LESS BUDGET EATEN -> MORE DONCHIAN. DOES IT PAY?");
console.log("=".repeat(108));
console.log("\n  ORB stop   don  breaker days  don trades  " +
            W.map(([, l]) => l.padStart(9)).join("") + "     $/day");
const grid = [];
for (const cap of [null, 15, 20, 30, 40]) {
  const s = score(cap, 8);
  grid.push({ cap, lots: 8, ...s });
  console.log("  " + (cap ? cap + " pts" : "none").padEnd(11) + "8" +
    String(s.breaker).padStart(14) + String(s.don).padStart(12) +
    s.pass.map((p) => (p.toFixed(1) + "%").padStart(9)).join("") +
    ("$" + s.perDay.toFixed(2)).padStart(10) +
    (cap === null ? "   <- shipped" : ""));
}
console.log("\n  (donchian alone takes " + alone.dTr.length + " trades; every row above is" +
            " what survives)");

console.log("\n  and with the freed-up room, can the donchian carry more size?");
console.log("  ORB stop   don  breaker days  don trades  " +
            W.map(([, l]) => l.padStart(9)).join("") + "     $/day");
for (const cap of [null, 20, 30]) {
  for (const lots of [8, 10, 12]) {
    if (cap === null && lots === 8) continue;
    const s = score(cap, lots);
    grid.push({ cap, lots, ...s });
    console.log("  " + (cap ? cap + " pts" : "none").padEnd(11) + String(lots) +
      String(s.breaker).padStart(13 + (lots > 9 ? 0 : 1)) + String(s.don).padStart(12) +
      s.pass.map((p) => (p.toFixed(1) + "%").padStart(9)).join("") +
      ("$" + s.perDay.toFixed(2)).padStart(10));
  }
}

console.log("\n" + "=".repeat(108));
console.log("THE SPLIT — chosen on the 1st half of 2024-26, read on the 2nd");
console.log("=".repeat(108));
grid.sort((a, b) => b.h1 - a.h1);
console.log("\n  config                 1st half   2nd half");
for (const g of grid.slice(0, 6)) {
  console.log("  " + ((g.cap ? g.cap + "pt stop" : "no cap") + ", " + g.lots + " lots").padEnd(23) +
    (g.h1.toFixed(1) + "%").padStart(9) + (g.h2.toFixed(1) + "%").padStart(11));
}
const ship = grid.find((g) => g.cap === null && g.lots === 8);
console.log("\n  SHIPPED   1st " + ship.h1.toFixed(1) + "%   2nd " + ship.h2.toFixed(1) +
            "%   rank #" + (grid.indexOf(ship) + 1) + " of " + grid.length);
console.log("  best on the 1st half: " +
  (grid[0].cap ? grid[0].cap + "pt stop" : "no cap") + ", " + grid[0].lots +
  " lots -> 2nd half " + grid[0].h2.toFixed(1) + "%  vs shipped " + ship.h2.toFixed(1) + "%");
