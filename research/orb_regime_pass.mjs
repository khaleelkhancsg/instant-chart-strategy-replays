// The regime findings, judged on pass rate instead of dollars per trade.
//
// Restricted to recent data, two changes point the same way in every window:
// a FURTHER target (6R beats 3R: $337 vs $241 a trade in 2026) and a LONGER
// hold (10 min beats 5: $252 vs $241). Both say the current regime moves too
// far for a 5-minute 3R box to contain it.
//
// Dollars per trade is not the objective though, and both changes cost
// something pass rate cares about: a longer hold locks the Donchian book out of
// the account for twice as long, and a further target does nothing on the 57%
// of trades that time out anyway. So this re-runs them on the joint sim,
// sliced to recent windows.
//
// SAMPLE SIZE: 21-day windows inside 2026 alone overlap almost completely --
// ~160 days gives ~7 independent windows. 2026 numbers here are directional at
// best. 2024-26 is the smallest window that can actually rank anything.
//
//   node research/orb_regime_pass.mjs

import { simulate, days, pass21, forward, ORB_CFG } from "./joint_account.mjs";
import { dayStart, TS } from "./lib_orb.mjs";

const yearOf = (tday) => new Date(TS[dayStart.get(tday)]).getUTCFullYear();
const firstIdx = (y) => days.findIndex((d) => yearOf(d) >= y);
const WINDOWS = [[2019, "all years"], [2024, "2024-26"], [2025, "2025-26"], [2026, "2026"]];

function score(orbOver) {
  const r = simulate("both", { exclusive: true, donLots: 8,
                               orbCfg: { ...ORB_CFG, ...orbOver } });
  const o = {};
  for (const [y, label] of WINDOWS) {
    const slice = r.arr.slice(firstIdx(y));
    o[label] = { pass: pass21(slice), n: slice.length };
  }
  o.liq = r.liqDays;
  o.perDay = r.arr.reduce((a, b) => a + b, 0) / r.arr.length;
  return o;
}

function table(title, variants) {
  console.log("\n" + "=".repeat(100));
  console.log(title);
  console.log("=".repeat(100));
  console.log("\n  variant                  " +
    WINDOWS.map(([, l]) => l.padStart(13)).join("") + "        $/day");
  for (const [label, over] of variants) {
    const s = score(over);
    console.log("  " + label.padEnd(25) +
      WINDOWS.map(([, l]) => (s[l].pass.toFixed(1) + "%").padStart(13)).join("") +
      ("$" + s.perDay.toFixed(2)).padStart(13));
  }
  console.log("\n  days in each window: " +
    WINDOWS.map(([y, l]) => l + " " + (days.length - firstIdx(y))).join(",  "));
}

table("TARGET AND HOLD, ON JOINT-ACCOUNT PASS RATE", [
  ["SHIPPED  5 min, 3R", {}],
  ["         5 min, 4R", { rMult: 4 }],
  ["         5 min, 6R", { rMult: 6 }],
  ["        10 min, 3R", { maxHoldMin: 10 }],
  ["        10 min, 4R", { maxHoldMin: 10, rMult: 4 }],
  ["        10 min, 6R", { maxHoldMin: 10, rMult: 6 }],
  ["        20 min, 4R", { maxHoldMin: 20, rMult: 4 }],
]);

table("RISK BUDGET IN THE CURRENT REGIME — median size is 5 lots in 2026", [
  ["         $400", { riskDollars: 400 }],
  ["SHIPPED  $500", {}],
  ["         $650", { riskDollars: 650 }],
  ["         $800", { riskDollars: 800 }],
  ["        $1000", { riskDollars: 1000 }],
]);

table("BEST-OF COMBINED, against shipped", [
  ["SHIPPED  5m, 3R, $500", {}],
  ["        10m, 4R, $500", { maxHoldMin: 10, rMult: 4 }],
  ["        10m, 4R, $650", { maxHoldMin: 10, rMult: 4, riskDollars: 650 }],
  ["        10m, 6R, $650", { maxHoldMin: 10, rMult: 6, riskDollars: 650 }],
]);
