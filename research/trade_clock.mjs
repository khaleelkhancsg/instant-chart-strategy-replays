// What time of day do the two books actually trade?
//
// Useful for knowing when to be watching, and for spotting a live session that
// is firing at the wrong time. Times are Chicago, because that is what the bot
// logs; New York is +1, and the log's wall-clock stamps are CT+6 in summer.
//
//   node research/trade_clock.mjs

import { run, days, yearOf } from "./lib_shipped.mjs";
import { setups, resolve, CT, dayStart, TS } from "./lib_orb.mjs";

const don = run(() => 8);
const ORB_CFG = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08,
  minTouch: 3, mode: "plain", stopAt: "opposite", rMult: 3.0, maxHoldMin: 5,
  giveUpCt: 570, riskDollars: 500, maxLots: 50, maxPerDay: 1, maxWidthPts: 31 };
const orbSet = setups(ORB_CFG).out;
const orb = orbSet.map((s) => ({ ...resolve(s, { rMult: 3, maxHoldMin: 5,
  riskDollars: 500, maxLots: 50 }), entCt: CT[s.bar],
  year: new Date(TS[dayStart.get(s.day)]).getUTCFullYear() }));

const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" +
                    String(m % 60).padStart(2, "0");
const sum = (a) => a.reduce((x, y) => x + y, 0);
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * a.length)];

console.log("\n" + "=".repeat(96));
console.log("DONCHIAN ENTRIES BY HALF HOUR   (CT — New York is +1, your log stamps are CT+6)");
console.log("=".repeat(96));
console.log("\n  CT window      ET       all years          2026          $/trade   win%");
const don26 = don.filter((t) => yearOf.get(t.tday) === 2026);
for (let m = 8 * 60 + 30; m < 15 * 60; m += 30) {
  const g = don.filter((t) => t.entCt >= m && t.entCt < m + 30);
  const g26 = don26.filter((t) => t.entCt >= m && t.entCt < m + 30);
  if (!g.length) continue;
  const share = 100 * g.length / don.length;
  console.log("  " + (hhmm(m) + "-" + hhmm(m + 30)).padEnd(15) +
    hhmm(m + 60).padEnd(9) +
    (g.length + " (" + share.toFixed(1) + "%)").padStart(14) +
    (g26.length + " (" + (100 * g26.length / don26.length).toFixed(1) + "%)").padStart(14) +
    ("$" + (sum(g.map((t) => t.pnl)) / g.length).toFixed(0)).padStart(13) +
    (100 * g.filter((t) => t.pnl > 0).length / g.length).toFixed(0).padStart(6) +
    "  " + "#".repeat(Math.round(share)));
}
console.log("\n  median entry " + hhmm(q(don.map((t) => t.entCt), .5)) + " CT" +
  "   quartiles " + hhmm(q(don.map((t) => t.entCt), .25)) + " to " +
  hhmm(q(don.map((t) => t.entCt), .75)));

console.log("\n" + "=".repeat(96));
console.log("HOW LONG DONCHIAN TRADES LAST, AND WHEN THEY CLOSE");
console.log("=".repeat(96));
const held = don.map((t) => t.held);
console.log("\n  hold time   p25 " + q(held, .25) + " min   median " + q(held, .5) +
            " min   p75 " + q(held, .75) + " min   p95 " + q(held, .95) + " min");
const exits = don.map((t) => Math.min(15 * 60 + 4, t.entCt + t.held));
console.log("  exits       median " + hhmm(q(exits, .5)) + " CT" +
            "   p90 " + hhmm(q(exits, .9)) + "   flat-by rule 15:04 CT");
const late = don.filter((t) => t.entCt + t.held >= 15 * 60).length;
console.log("  trades still open at 15:00 and closed by the flatten: " + late +
            " (" + (100 * late / don.length).toFixed(1) + "%)");

console.log("\n" + "=".repeat(96));
console.log("ORB — one shot, and it is over almost immediately");
console.log("=".repeat(96));
console.log("\n  minutes after the 08:30 open   trades    share    cumulative");
let cum = 0;
for (const [a, b] of [[0, 1], [1, 2], [2, 5], [5, 10], [10, 30], [30, 60]]) {
  const g = orb.filter((t) => t.entCt - 510 >= a && t.entCt - 510 < b);
  cum += g.length;
  console.log("  " + (a + "-" + b + " min").padStart(22) + "       " +
    String(g.length).padStart(6) + (100 * g.length / orb.length).toFixed(1).padStart(8) + "%" +
    (100 * cum / orb.length).toFixed(1).padStart(12) + "%");
}
console.log("\n  ORB hold: median " + q(orb.map((t) => t.held), .5) + " min, capped at 5.");
console.log("  So the ORB is done by roughly 08:37 CT on the days it fires at all.");

console.log("\n" + "=".repeat(96));
console.log("PUTTING IT TOGETHER — when the account is actually doing something");
console.log("=".repeat(96));
console.log("\n  08:30-08:40 CT   the ORB's whole life, plus the first donchian bars");
console.log("  08:30-10:00 CT   " +
  (100 * don.filter((t) => t.entCt < 10 * 60).length / don.length).toFixed(0) +
  "% of donchian entries");
console.log("  after 12:00 CT   " +
  (100 * don.filter((t) => t.entCt >= 12 * 60).length / don.length).toFixed(0) +
  "% of donchian entries");
console.log("  after 14:00 CT   " +
  (100 * don.filter((t) => t.entCt >= 14 * 60).length / don.length).toFixed(0) + "%");
