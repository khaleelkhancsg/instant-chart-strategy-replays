// "One lot isn't much money" — in the CURRENT regime, how often is that?
//
// Pooled, 3.3% of ORB trades size to a single lot. In 2026 it is 13.6%, because
// the level spread has roughly doubled and size is $500 / spread. So the case
// worth acting on is four times more common now than the pooled number implies.
//
// A width cap is the same thing as a minimum position size: lots ~ 250 / width,
// so width <= 50pts is "at least 5 lots", width <= 83 is "at least 3".
//
//   node research/orb_minsize_regime.mjs

import { simulate, days, pass21, ORB_CFG } from "./joint_account.mjs";
import { setups, resolve, dayStart, TS } from "./lib_orb.mjs";

const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const firstIdx = (y) => days.findIndex((d) => yearOf(d) >= y);
const WINDOWS = [[2019, "all years"], [2024, "2024-26"], [2025, "2025-26"], [2026, "2026"]];
const GUARDS = [[Infinity, "none (shipped)"], [125, ">= 2 lots"], [83, ">= 3 lots"],
                [62, ">= 4 lots"], [50, ">= 5 lots"], [31, ">= 8 lots"]];

// How many trades each guard removes, per window.
console.log("\n" + "=".repeat(96));
console.log("WHAT EACH GUARD DROPS, AND WHAT THOSE TRADES WERE WORTH");
console.log("=".repeat(96));
const { out } = setups(ORB_CFG);
const tr = out.map((s) => ({ ...resolve(s, { rMult: 3, maxHoldMin: 5,
                                             riskDollars: 500, maxLots: 50 }),
                             width: s.width }));
console.log("\n  guard             2024-26 dropped        their $/trade      2026 dropped        their $/trade");
for (const [w, label] of GUARDS.slice(1)) {
  const cell = (fy) => {
    const all = tr.filter((t) => yearOf(t.tday) >= fy);
    const drop = all.filter((t) => t.width > w);
    const p = drop.length ? drop.reduce((a, b) => a + b.pnl, 0) / drop.length : 0;
    return [(drop.length + " of " + all.length).padStart(18),
            ("$" + p.toFixed(0)).padStart(21)];
  };
  const [a1, a2] = cell(2024), [b1, b2] = cell(2026);
  console.log("  " + label.padEnd(16) + a1 + a2 + b1 + b2);
}

console.log("\n" + "=".repeat(96));
console.log("THE SAME GUARDS ON JOINT-ACCOUNT PASS RATE");
console.log("=".repeat(96));
console.log("\n  guard             " + WINDOWS.map(([, l]) => l.padStart(13)).join("") + "        $/day");
const arrs = new Map();
for (const [w, label] of GUARDS) {
  const r = simulate("both", { exclusive: true, donLots: 8,
    orbCfg: w === Infinity ? ORB_CFG : { ...ORB_CFG, maxWidthPts: w } });
  arrs.set(w, r.arr);
  console.log("  " + label.padEnd(18) +
    WINDOWS.map(([y]) => (pass21(r.arr.slice(firstIdx(y))).toFixed(1) + "%").padStart(13)).join("") +
    ("$" + (r.arr.reduce((a, b) => a + b, 0) / r.arr.length).toFixed(2)).padStart(13));
}

// Same stability test that killed the hold-time idea.
console.log("\n" + "=".repeat(96));
console.log("STABILITY — does the best guard survive a split?");
console.log("=".repeat(96));
const n = days.length, f24 = firstIdx(2024);
const mid = f24 + Math.floor((n - f24) / 2);
for (const [label, slice] of [["2024-26 first half ", (a) => a.slice(f24, mid)],
                              ["2024-26 second half", (a) => a.slice(mid)]]) {
  const rows = GUARDS.map(([w, l]) => ({ l, p: pass21(slice(arrs.get(w))) }));
  const best = rows.slice().sort((a, b) => b.p - a.p)[0];
  console.log("\n  " + label);
  console.log("    " + rows.map((r) => r.l.replace("none (shipped)", "none").padStart(11)).join(""));
  console.log("    " + rows.map((r) => (r.p.toFixed(1) + "%").padStart(11)).join("") +
              "     best: " + best.l);
}
