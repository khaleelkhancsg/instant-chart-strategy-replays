// Verify the two headline cells from funded_median.mjs before acting on them.
// Both looked like spikes on a single seed: 8 lots with a $500 block, and
// standing down at +$3,000. Re-run across seeds, on a finer grid, and jointly.
//
// Usage:  node research/funded_verify.mjs

import { run, dayArr, mul, days } from "./lib_shipped.mjs";

const DD = 2000, WIN = 21, TRIALS = 30000;
const cache = new Map();
function arrFor(lots, pb, br) {
  const k = lots + "|" + pb + "|" + br;
  if (!cache.has(k)) cache.set(k, dayArr(run(() => lots, { profitBlock: pb, breaker: br }), days));
  return cache.get(k);
}
function period(arr, start, stopAt) {
  let c = 0, pk = 0, lk = false;
  for (let d = 0; d < WIN; d++) {
    if (stopAt > 0 && c >= stopAt) break;
    c += arr[(start + d) % arr.length];
    if (c <= (lk ? 0 : pk - DD)) return null;
    if (c > pk) pk = c;
    if (!lk && pk >= DD) lk = true;
  }
  return c;
}
const pctl = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
function score(lots, pb, br, stopAt, seed) {
  const arr = arrFor(lots, pb, br);
  const rnd = mul(seed), v = [];
  let blown = 0, sum = 0;
  for (let t = 0; t < TRIALS; t++) {
    const r = period(arr, Math.floor(rnd() * arr.length), stopAt);
    if (r === null) { blown++; v.push(0); } else { v.push(r); sum += r; }
  }
  v.sort((a, b) => a - b);
  return { med: pctl(v, 0.5), mean: sum / TRIALS, p25: pctl(v, 0.25), p75: pctl(v, 0.75),
           blow: 100 * blown / TRIALS };
}
const SEEDS = [11, 2027, 55501, 909090, 7];
const across = (lots, pb, br, sa) => {
  const m = SEEDS.map(s => score(lots, pb, br, sa, s).med);
  const mean = m.reduce((a, b) => a + b, 0) / m.length;
  return { mean, lo: Math.min(...m), hi: Math.max(...m) };
};

console.log("\n" + "=".repeat(104));
console.log("VERIFYING THE FUNDED-ACCOUNT OPTIMUM ACROSS 5 SEEDS");
console.log("=".repeat(104));

console.log("\n-- (1) size neighbourhood, block $500, no stand-down --");
console.log("  lots   median (mean of 5 seeds)   range across seeds");
for (const k of [5, 6, 7, 8, 9, 10, 11]) {
  const a = across(k, 500, 500, 0);
  console.log("  " + String(k).padEnd(7) + ("$" + Math.round(a.mean)).padStart(14) +
    ("      $" + Math.round(a.lo) + " - $" + Math.round(a.hi)).padStart(30));
}

console.log("\n-- (2) profit block neighbourhood, 8 lots --");
console.log("  block  median (mean of 5 seeds)   range");
for (const pb of [300, 400, 500, 600, 750, 1000]) {
  const a = across(8, pb, 500, 0);
  console.log("  " + ("$" + pb).padEnd(7) + ("$" + Math.round(a.mean)).padStart(13) +
    ("      $" + Math.round(a.lo) + " - $" + Math.round(a.hi)).padStart(30));
}

console.log("\n-- (3) stand-down level, 8 lots, block $500 --");
console.log("  stop at   median (5 seeds)   range              mean profit   p25    lost");
for (const sa of [0, 1500, 2000, 2500, 3000, 3500, 4000]) {
  const a = across(8, 500, 500, sa);
  const one = score(8, 500, 500, sa, 11);
  console.log("  " + (sa === 0 ? "never" : "$" + sa).padEnd(10) +
    ("$" + Math.round(a.mean)).padStart(11) +
    ("   $" + Math.round(a.lo) + " - $" + Math.round(a.hi)).padStart(22) +
    ("$" + Math.round(one.mean)).padStart(13) + ("$" + Math.round(one.p25)).padStart(8) +
    one.blow.toFixed(1).padStart(8) + "%");
}

console.log("\n-- (4) joint: best (lots, block, stand-down) on median, averaged over seeds --");
let best = null;
for (const k of [6, 7, 8, 9])
for (const pb of [400, 500, 750])
for (const sa of [2000, 2500, 3000, 3500]) {
  const a = across(k, pb, 500, sa);
  if (!best || a.mean > best.a.mean) best = { k, pb, sa, a };
}
console.log("  best: " + best.k + " lots, block $" + best.pb + ", stand down at +$" + best.sa);
const b1 = score(best.k, best.pb, 500, best.sa, 11);
console.log("  median $" + Math.round(best.a.mean) + " (seed range $" + Math.round(best.a.lo) +
  " - $" + Math.round(best.a.hi) + ")");
console.log("  mean $" + Math.round(b1.mean) + "   25th $" + Math.round(b1.p25) +
  "   75th $" + Math.round(b1.p75) + "   account lost " + b1.blow.toFixed(1) + "%");

console.log("\n-- (5) what the shipped combine settings would earn, for comparison --");
const shipped = across(8, 750, 500, 0);
const sc = score(8, 750, 500, 0, 11);
console.log("  8 lots, block $750, no stand-down (current live config):");
console.log("  median $" + Math.round(shipped.mean) + "   mean $" + Math.round(sc.mean) +
  "   25th $" + Math.round(sc.p25) + "   account lost " + sc.blow.toFixed(1) + "%");
console.log("\n  improvement in median: $" + Math.round(best.a.mean - shipped.mean) +
  " per account per 21 trading days (" +
  (100 * (best.a.mean / shipped.mean - 1)).toFixed(0) + "%)");
