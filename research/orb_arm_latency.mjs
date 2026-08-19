// When does an ORB entry actually fire, and what does arming late cost?
//
// The live arm on 2026-08-19 was placed at 08:38 CT, eight minutes after the
// open. The backtest starts hunting at 08:30 sharp. Any break inside that gap
// is a trade the backtest books and the bot cannot -- and worse, a resting stop
// sent after price has already passed the trigger is exactly the order the
// platform refuses.
//
//   node research/orb_arm_latency.mjs

import { setups, resolve, CT } from "./lib_orb.mjs";

const CFG = {
  levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
  mode: "plain", stopAt: "opposite", rMult: 3.0, maxHoldMin: 5,
  retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500, maxLots: 50, maxPerDay: 1,
};
const OPT = { rMult: 3.0, maxHoldMin: 5, riskDollars: 500, maxLots: 50 };
const OPEN_CT = 510;

const { out } = setups(CFG);
const tr = out.map((s) => ({ ...resolve(s, OPT), mins: CT[s.bar] - OPEN_CT }));

const sum = (a) => a.reduce((x, y) => x + y, 0);
console.log("\n" + "=".repeat(88));
console.log("HOW LONG AFTER THE 08:30 OPEN THE ORB ACTUALLY FIRES");
console.log("=".repeat(88));
console.log("\n  minutes after open   trades    share    cumulative       net    $/trade");
const BUCKETS = [[0, 2], [2, 4], [4, 6], [6, 8], [8, 10], [10, 15], [15, 30], [30, 60]];
let cum = 0;
for (const [a, b] of BUCKETS) {
  const g = tr.filter((r) => r.mins >= a && r.mins < b);
  cum += g.length;
  console.log("  " + (a + "-" + b).padStart(14) + "       " +
    String(g.length).padStart(6) +
    (100 * g.length / tr.length).toFixed(1).padStart(8) + "%" +
    (100 * cum / tr.length).toFixed(1).padStart(11) + "%" +
    ("$" + Math.round(sum(g.map((r) => r.pnl))).toLocaleString()).padStart(11) +
    ("$" + (g.length ? sum(g.map((r) => r.pnl)) / g.length : 0).toFixed(2)).padStart(11));
}

console.log("\n" + "=".repeat(88));
console.log("WHAT A LATE ARM COSTS — every trade firing before the arm lands is simply lost");
console.log("=".repeat(88));
console.log("\n  arm lands at    trades lost    share of book     net lost    net kept");
const total = sum(tr.map((r) => r.pnl));
for (const d of [1, 2, 3, 4, 6, 8, 10]) {
  const lost = tr.filter((r) => r.mins < d);
  const nl = sum(lost.map((r) => r.pnl));
  console.log("  08:" + String(30 + d).padStart(2, "0") + " CT" +
    String(lost.length).padStart(15) +
    (100 * lost.length / tr.length).toFixed(1).padStart(16) + "%" +
    ("$" + Math.round(nl).toLocaleString()).padStart(13) +
    ("$" + Math.round(total - nl).toLocaleString()).padStart(12));
}
console.log("\n  the whole book: " + tr.length + " trades, $" +
            Math.round(total).toLocaleString() + " net");
