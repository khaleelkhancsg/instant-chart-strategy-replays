// Is the hold-time optimum stable, or does it move?
//
// On 2024-26 the pass-rate sweep reads 3m 50.5%, 5m 49.0%, 8m 53.0%, 10m 50.8%,
// 12m 49.5%, 15m 49.0%. A real optimum is smooth; that one has 5 minutes as a
// local MINIMUM with peaks either side, which is what a flat noisy surface
// looks like. The deciding test is whether the ranking survives a split.
//
//   node research/orb_hold_stability.mjs

import { simulate, days, pass21, ORB_CFG } from "./joint_account.mjs";
import { dayStart, TS } from "./lib_orb.mjs";

const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const from24 = days.findIndex((d) => yearOf(d) >= 2024);
const HOLDS = [3, 5, 8, 10, 12, 15, 20];

const arrs = new Map();
for (const h of HOLDS) {
  arrs.set(h, simulate("both", { exclusive: true, donLots: 8,
                                 orbCfg: { ...ORB_CFG, maxHoldMin: h } }).arr);
}

console.log("\n" + "=".repeat(88));
console.log("HOLD TIME — DOES THE RANKING SURVIVE A SPLIT?");
console.log("=".repeat(88));

function report(label, slice) {
  const rows = HOLDS.map((h) => ({ h, p: pass21(slice(arrs.get(h))) }));
  const best = rows.slice().sort((a, b) => b.p - a.p)[0];
  console.log("\n  " + label);
  console.log("    " + rows.map((r) => (r.h + "m").padStart(8)).join(""));
  console.log("    " + rows.map((r) => (r.p.toFixed(1) + "%").padStart(8)).join("") +
              "     best " + best.h + "m");
  return best.h;
}

// Split the modern window in two, then the whole history in two, then thirds.
const n = days.length;
const mid24 = from24 + Math.floor((n - from24) / 2);
const b1 = report("2024-26, first half  (" + (mid24 - from24) + " days)",
                  (a) => a.slice(from24, mid24));
const b2 = report("2024-26, second half (" + (n - mid24) + " days)",
                  (a) => a.slice(mid24));

const from22 = days.findIndex((d) => yearOf(d) >= 2022);
const mid22 = from22 + Math.floor((n - from22) / 2);
const c1 = report("2022-26, first half  (" + (mid22 - from22) + " days)",
                  (a) => a.slice(from22, mid22));
const c2 = report("2022-26, second half (" + (n - mid22) + " days)",
                  (a) => a.slice(mid22));

console.log("\n" + "=".repeat(88));
console.log("  best hold, 2024-26 halves:  " + b1 + "m  then  " + b2 + "m");
console.log("  best hold, 2022-26 halves:  " + c1 + "m  then  " + c2 + "m");
const agree = (b1 === b2) && (c1 === c2);
console.log("\n  " + (agree
  ? "The optimum holds across splits — worth acting on."
  : "The optimum MOVES between splits. That is a flat surface with noise on"));
if (!agree) console.log("  top of it, not a hold time the market is telling us about.");

// How much of the spread is real? Compare the sweep's range against the range
// you get from re-drawing the SAME config on bootstrapped days.
console.log("\n  for scale — spread across the 7 hold values, per window:");
for (const [label, slice] of [
  ["2024-26 first half", (a) => a.slice(from24, mid24)],
  ["2024-26 second half", (a) => a.slice(mid24)],
  ["2024-26 whole", (a) => a.slice(from24)]]) {
  const ps = HOLDS.map((h) => pass21(slice(arrs.get(h))));
  console.log("    " + label.padEnd(22) + Math.min(...ps).toFixed(1) + "% to " +
              Math.max(...ps).toFixed(1) + "%   (" +
              (Math.max(...ps) - Math.min(...ps)).toFixed(1) + "pp wide)");
}
