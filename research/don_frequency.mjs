// How often should the donchian book fire in a day?
//
// The research header quotes 2.03 trades/day, but that is the 10-lot book with
// a market entry at the signal close and no daily loss cap. The bot runs the
// stop-entry model with a limit fallback, an 8-lot size, a -$500 breaker and a
// +$750 profit block, all of which change the count. This is what to expect
// live, and what a quiet or a busy day looks like before it is worth worrying.
//
//   node research/don_frequency.mjs

import { run, days, yearOf, stat } from "./lib_shipped.mjs";

const trades = run(() => 8);                    // shipped: 8 lots, limit entry
const perDay = new Map();
for (const d of days) perDay.set(d, 0);
for (const t of trades) perDay.set(t.tday, (perDay.get(t.tday) || 0) + 1);
const counts = [...perDay.values()];
const sum = (a) => a.reduce((x, y) => x + y, 0);
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * a.length)];

console.log("\n" + "=".repeat(88));
console.log("DONCHIAN TRADE FREQUENCY — the shipped configuration");
console.log("=".repeat(88));
console.log("\n  trading days                 " + days.length);
console.log("  trades                       " + trades.length);
console.log("  mean per day                 " + (trades.length / days.length).toFixed(2));
console.log("  median per day               " + q(counts, .5));
console.log("  days with no trade at all    " + counts.filter((c) => c === 0).length +
            "  (" + (100 * counts.filter((c) => c === 0).length / days.length).toFixed(1) + "%)");

console.log("\n  how many days had exactly N trades");
const hist = new Map();
for (const c of counts) hist.set(c, (hist.get(c) || 0) + 1);
for (const [c, k] of [...hist.entries()].sort((a, b) => a[0] - b[0])) {
  if (c > 8) continue;
  console.log("    " + String(c).padStart(2) + " trades  " + String(k).padStart(5) +
    "  " + (100 * k / days.length).toFixed(1).padStart(5) + "%  " +
    "#".repeat(Math.round(60 * k / days.length)));
}
const tail = counts.filter((c) => c > 8).length;
if (tail) console.log("    9+ trades  " + String(tail).padStart(5) +
  "  " + (100 * tail / days.length).toFixed(1).padStart(5) + "%");
console.log("\n  busiest day observed: " + Math.max(...counts) + " trades");
console.log("  p90 " + q(counts, .9) + "   p95 " + q(counts, .95) + "   p99 " + q(counts, .99));

console.log("\n" + "=".repeat(88));
console.log("BY YEAR — frequency is not stable, so 'normal' depends on the regime");
console.log("=".repeat(88));
console.log("\n  year   days   trades   per day   no-trade days   median   p90   $/trade");
for (const y of [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
  const dy = days.filter((d) => yearOf.get(d) === y);
  if (!dy.length) continue;
  const set = new Set(dy);
  const ty = trades.filter((t) => set.has(t.tday));
  const cy = dy.map((d) => perDay.get(d) || 0);
  const zero = cy.filter((c) => c === 0).length;
  console.log("  " + y + String(dy.length).padStart(7) + String(ty.length).padStart(9) +
    (ty.length / dy.length).toFixed(2).padStart(10) +
    (zero + " (" + (100 * zero / dy.length).toFixed(0) + "%)").padStart(16) +
    String(q(cy, .5)).padStart(9) + String(q(cy, .9)).padStart(6) +
    ("$" + stat(ty).exp.toFixed(0)).padStart(10));
}

console.log("\n" + "=".repeat(88));
console.log("WHAT STOPS A DAY EARLY — the two blocks are why the count is not just signal count");
console.log("=".repeat(88));
console.log("\n  configuration                    trades   per day   no-trade days");
for (const [label, opt] of [
  ["shipped (breaker 500, block 750)", {}],
  ["no profit block", { profitBlock: 0 }],
  ["no breaker", { breaker: 0 }],
  ["neither block", { breaker: 0, profitBlock: 0 }],
]) {
  const t = run(() => 8, opt);
  const pd = new Map();
  for (const d of days) pd.set(d, 0);
  for (const x of t) pd.set(x.tday, (pd.get(x.tday) || 0) + 1);
  const z = [...pd.values()].filter((c) => c === 0).length;
  console.log("  " + label.padEnd(34) + String(t.length).padStart(6) +
    (t.length / days.length).toFixed(2).padStart(10) +
    (z + " (" + (100 * z / days.length).toFixed(0) + "%)").padStart(16));
}

// When is a quiet stretch actually a broken bot? Blank days are common, so the
// useful number is how long a run of them can legitimately get.
console.log("\n" + "=".repeat(88));
console.log("DROUGHTS — how long the book can legitimately go quiet");
console.log("=".repeat(88));
let cur = 0, best = 0, bestEnd = null;
const runs = [];
for (const d of days) {
  if ((perDay.get(d) || 0) === 0) { cur++; if (cur > best) { best = cur; bestEnd = d; } }
  else { if (cur) runs.push(cur); cur = 0; }
}
if (cur) runs.push(cur);
const rh = new Map();
for (const r of runs) rh.set(r, (rh.get(r) || 0) + 1);
console.log("\n  consecutive blank days   how many times it happened");
for (const [r, k] of [...rh.entries()].sort((a, b) => a[0] - b[0])) {
  console.log("    " + String(r).padStart(2) + " in a row   " + String(k).padStart(4) +
    "   " + "#".repeat(Math.min(50, k)));
}
console.log("\n  longest observed drought: " + best + " consecutive trading days");
console.log("  so a 2-3 day gap is routine; " + (best + 1) + "+ has never happened and is");
console.log("  worth checking the feed and the arm log for.");
