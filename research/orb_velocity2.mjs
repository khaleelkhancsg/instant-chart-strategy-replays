// Round 11 -- the velocity trade has the best per-trade numbers in this whole
// investigation and cannot pass. Find out whether that is fixable.
//
// Round 10 measured the drift directly: 4.84 of the eventual 10.4 points arrive
// in the FIRST MINUTE after the break, and the per-minute rate then falls about
// twentyfold. Velocity is real. Two things follow, and they pull opposite ways:
//
//   - a 1-minute hold runs pf 2.99, the best number produced here by a distance
//   - and it passes 3.8%, because one burst a day cannot make $3,000 in 21 days
//
// So the question is not edge, it is throughput. If the burst does not depend on
// the level being meaningful -- and round 10 says it does not, the shuffled
// control drifts 4.77 against 4.84 -- then nothing stops the same rule firing
// several times a day.
//
// Usage:  node research/orb_velocity2.mjs

import { setups, resolve, stat, passOf, ALL, H1, H2, RECENT, inSet } from "./lib_orb.mjs";

const TOUCH = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
                retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500, mode: "plain",
                stopAt: "opposite", tpMode: "R" };

const HDRV = "  cfg                             n  tr/day   win%     pf   $/trade         net    pass   1stH   2ndH recent";
function rowv(lbl, c) {
  const { out } = setups(c);
  if (out.length < 100) { console.log("  " + lbl.padEnd(30) + String(out.length).padStart(6) + "   too few"); return null; }
  const t = out.map(s => resolve(s, c));
  const st = stat(t);
  const p = passOf(t, ALL), p1 = passOf(inSet(t, H1), H1), p2 = passOf(inSet(t, H2), H2);
  console.log("  " + lbl.padEnd(30) + String(st.n).padStart(6) + (st.n / 1861).toFixed(2).padStart(8) +
    st.win.toFixed(1).padStart(7) + st.pf.toFixed(3).padStart(7) +
    ("$" + st.exp.toFixed(2)).padStart(10) + ("$" + Math.round(st.net).toLocaleString()).padStart(12) +
    p.toFixed(1).padStart(8) + "%" + p1.toFixed(1).padStart(6) + "%" + p2.toFixed(1).padStart(6) + "%" +
    passOf(inSet(t, RECENT), RECENT).toFixed(1).padStart(6) + "%");
  return { p, p1, p2, st };
}

console.log("\n" + "=".repeat(120));
console.log("ROUND 11 -- CAN THE VELOCITY TRADE BE MADE TO PASS?");
console.log("=".repeat(120));

console.log("\n-- (1) one trade a day, varying the hold. pf falls as you hold longer; pass rises. --");
console.log(HDRV);
for (const h of [1, 2, 3, 5, 8, 15, 30, 60]) rowv(h + "m hold, 2R, 1/day", { ...TOUCH, maxHoldMin: h, rMult: 2, maxPerDay: 1 });

console.log("\n-- (2) let it re-arm: same rule, more shots per day --");
console.log(HDRV);
for (const h of [2, 3, 5]) {
  for (const n of [1, 2, 3, 5, 10]) rowv(h + "m hold, 2R, up to " + n + "/day", { ...TOUCH, maxHoldMin: h, rMult: 2, maxPerDay: n });
  console.log("");
}

console.log("-- (3) and the same, hunting all session rather than stopping at 10:30 --");
console.log(HDRV);
for (const h of [2, 3, 5])
  for (const n of [5, 10, 20]) rowv(h + "m, 2R, " + n + "/day, to 15:00", { ...TOUCH, maxHoldMin: h, rMult: 2, maxPerDay: n, giveUpCt: 890 });

console.log("\n-- (4) the control: does the extra throughput survive shuffling the levels? --");
console.log(HDRV);
for (const [lbl, extra] of [["real levels", {}], ["levels shuffled", { levelMode: "touchShuffled" }]])
  rowv(lbl, { ...TOUCH, maxHoldMin: 3, rMult: 2, maxPerDay: 10, giveUpCt: 890, ...extra });

console.log("\n  shipped bot, same harness, same days: 49.8%");
