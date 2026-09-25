// What is the shipped bot's pass rate on 2026 data?
//
// Straight question, but 2026 is 139 trading days, and a 21-day window is not a
// small slice of that. The bootstrap below resamples the 139 DAYS themselves,
// which is the thing actually estimated from a limited sample -- pass21's own
// resampling of sequences only tells you how precisely it read the day
// distribution it was given, not how well those 139 days pin down 2026.
//
//   node research/pass_2026.mjs

import { simulate, days, pass21, ORB_CFG } from "./joint_account.mjs";
import { dayStart, TS } from "./lib_orb.mjs";

const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const idx = (y) => days.findIndex((d) => yearOf(d) >= y);
const SHIP = { ...ORB_CFG, maxWidthPts: 31 };     // exactly what the bot runs
const cfg = { exclusive: true, donLots: 8, orbCfg: SHIP };

const both = simulate("both", cfg);
const don = simulate("don", cfg);
const orb = simulate("orb", cfg);
const i26 = idx(2026);
const n26 = days.length - i26;
const slice = (r) => r.arr.slice(i26);

console.log("\n" + "=".repeat(88));
console.log("SHIPPED BOT, 2026 ONLY — " + n26 + " trading days");
console.log("=".repeat(88));
console.log("\n  book                21-day pass   $/day      trades");
for (const [label, r, tr] of [["donchian only", don, don.dTr.length],
                              ["ORB only", orb, orb.oTr.length],
                              ["BOTH (shipped)", both, both.dTr.length + both.oTr.length]]) {
  const a = slice(r);
  console.log("  " + label.padEnd(20) + (pass21(a).toFixed(1) + "%").padStart(9) +
    ("$" + (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2)).padStart(10) +
    String(tr).padStart(11) + (label.startsWith("BOTH") ? "   <- the answer" : ""));
}

// How precise is that, given it rests on 139 days?
function boot(arr, draws = 400, seed = 12345) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const out = [];
  for (let d = 0; d < draws; d++) {
    const re = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) re[i] = arr[(rnd() * arr.length) | 0];
    out.push(pass21(re, { draws: 1500, seed: 1000 + d }));
  }
  return out.sort((a, b) => a - b);
}
const a26 = slice(both);
const b = boot(a26);
const q = (p) => b[Math.floor(p * b.length)];
console.log("\n" + "=".repeat(88));
console.log("HOW MUCH OF THAT IS REAL — resampling the 139 days");
console.log("=".repeat(88));
console.log("\n  point estimate            " + pass21(a26).toFixed(1) + "%");
console.log("  90% interval              " + q(0.05).toFixed(1) + "%  to  " + q(0.95).toFixed(1) + "%");
console.log("  50% interval              " + q(0.25).toFixed(1) + "%  to  " + q(0.75).toFixed(1) + "%");
console.log("\n  for scale, the same bot on the full history:");
console.log("    all years (" + days.length + " days)    " + pass21(both.arr).toFixed(1) + "%");
console.log("    2024-26  (" + (days.length - idx(2024)) + " days)     " +
            pass21(both.arr.slice(idx(2024))).toFixed(1) + "%");
console.log("    2025-26  (" + (days.length - idx(2025)) + " days)     " +
            pass21(both.arr.slice(idx(2025))).toFixed(1) + "%");

const liq26 = 100 * both.liqDays / days.length;
console.log("\n  liquidation rate across the full history: " + liq26.toFixed(1) + "% of days");
