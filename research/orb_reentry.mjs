// "Stopped out, then it carried on in the same direction."
//
// That is exactly what happened today: stopped at 29348.25 at 08:30:38, and the
// same two-minute bar closed at 29426.75 and topped at 29433.75 -- 85 points
// above the stop. The book takes one shot a day (maxPerDay 1), so it watched
// the rest.
//
// Whether re-entry is worth having is a pass-rate question, not a "that one
// hurt" question, so it gets the same treatment as everything else: swept,
// read on recent windows, and split to see if the answer holds.
//
//   node research/orb_reentry.mjs

import { simulate, days, pass21, ORB_CFG } from "./joint_account.mjs";
import { setups, resolve, dayStart, TS } from "./lib_orb.mjs";

const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const idx = (y) => days.findIndex((d) => yearOf(d) >= y);
const W = [[2019, "all years"], [2024, "2024-26"], [2025, "2025-26"], [2026, "2026"]];
const n = days.length, f24 = idx(2024), mid = f24 + Math.floor((n - f24) / 2);

console.log("\n" + "=".repeat(102));
console.log("RE-ENTRY AFTER A STOP-OUT — standalone book first");
console.log("=".repeat(102));
console.log("\n  shots/day   trades   win%   $/trade         net    2026 $/tr");
for (const maxPerDay of [1, 2, 3]) {
  const cfg = { ...ORB_CFG, maxPerDay };
  const t = setups(cfg).out.map((s) => resolve(s, { rMult: 3, maxHoldMin: 5,
                                riskDollars: 500, maxLots: 50 }));
  const t26 = t.filter((x) => yearOf(x.tday) >= 2026);
  console.log("  " + String(maxPerDay).padStart(7) + String(t.length).padStart(11) +
    (100 * t.filter((x) => x.pnl > 0).length / t.length).toFixed(1).padStart(7) +
    ("$" + (t.reduce((a, b) => a + b.pnl, 0) / t.length).toFixed(0)).padStart(10) +
    ("$" + Math.round(t.reduce((a, b) => a + b.pnl, 0)).toLocaleString()).padStart(12) +
    ("$" + (t26.reduce((a, b) => a + b.pnl, 0) / t26.length).toFixed(0) +
     " (" + t26.length + ")").padStart(14));
}

console.log("\n" + "=".repeat(102));
console.log("ON THE JOINT ACCOUNT — where a second ORB trade also blocks the donchian again");
console.log("=".repeat(102));
console.log("\n  shots/day  " + W.map(([, l]) => l.padStart(12)).join("") +
            "    1st half    2nd half     $/day");
const store = new Map();
for (const maxPerDay of [1, 2, 3]) {
  const r = simulate("both", { exclusive: true, donLots: 8,
    orbCfg: { ...ORB_CFG, maxPerDay, maxWidthPts: 31 } });
  store.set(maxPerDay, r.arr);
  console.log("  " + String(maxPerDay).padEnd(11) +
    W.map(([y]) => (pass21(r.arr.slice(idx(y))).toFixed(1) + "%").padStart(12)).join("") +
    (pass21(r.arr.slice(f24, mid)).toFixed(1) + "%").padStart(12) +
    (pass21(r.arr.slice(mid)).toFixed(1) + "%").padStart(12) +
    ("$" + (r.arr.reduce((a, b) => a + b, 0) / r.arr.length).toFixed(2)).padStart(10));
}
console.log("\n  (all rows carry the shipped max-width guard, so this is a change against");
console.log("  what is actually running rather than against the old book.)");
