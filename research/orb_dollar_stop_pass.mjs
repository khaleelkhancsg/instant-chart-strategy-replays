// A static $1,000 stop raises the ORB win rate from 53.1% to 57.5%. What does
// it do to the thing being optimised?
//
// The catch is that $1,000 IS the platform's daily loss limit. A full stop-out
// at that size does not cost a trade, it costs the DAY -- 9.9% of trades land
// on the cap. Win rate cannot see that; pass rate can.
//
//   node research/orb_dollar_stop_pass.mjs

import { simulate, days, pass21, ORB_CFG } from "./joint_account.mjs";
import { dayStart, TS } from "./lib_orb.mjs";

const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const idx = (y) => days.findIndex((d) => yearOf(d) >= y);
const W = [[2019, "all years"], [2024, "2024-26"], [2025, "2025-26"], [2026, "2026"]];
const n = days.length, f24 = idx(2024), mid = f24 + Math.floor((n - f24) / 2);

console.log("\n" + "=".repeat(106));
console.log("STOP SIZE ON THE JOINT ACCOUNT — win rate is on the left, pass rate on the right");
console.log("=".repeat(106));
console.log("\n  stop                " + W.map(([, l]) => l.padStart(12)).join("") +
            "    1st half    2nd half     $/day   liq days");
const SHIP = { ...ORB_CFG, maxWidthPts: 31 };          // what is actually running
for (const [label, over] of [
  ["level stop (shipped)", {}],
  ["$400", { stopUsd: 400 }],
  ["$500", { stopUsd: 500 }],
  ["$650", { stopUsd: 650 }],
  ["$800", { stopUsd: 800 }],
  ["$1,000", { stopUsd: 1000 }],
  ["$1,500", { stopUsd: 1500 }],
]) {
  const r = simulate("both", { exclusive: true, donLots: 8,
                               orbCfg: { ...SHIP, ...over } });
  console.log("  " + label.padEnd(20) +
    W.map(([y]) => (pass21(r.arr.slice(idx(y))).toFixed(1) + "%").padStart(12)).join("") +
    (pass21(r.arr.slice(f24, mid)).toFixed(1) + "%").padStart(12) +
    (pass21(r.arr.slice(mid)).toFixed(1) + "%").padStart(12) +
    ("$" + (r.arr.reduce((a, b) => a + b, 0) / r.arr.length).toFixed(2)).padStart(10) +
    (r.liqDays + " (" + (100 * r.liqDays / days.length).toFixed(1) + "%)").padStart(13));
}
console.log("\n  'liq days' are days the account was liquidated. That is the column the");
console.log("  win rate is hiding: a $1,000 stop-out IS the daily limit, so the trade");
console.log("  that loses does not just lose, it closes the day.");
