// A PASSED account is a different optimisation problem from a combine.
//
//   combine : race to +$3,000, consistency rule caps any one day's share,
//             failure means losing the attempt fee
//   funded  : no target, NO consistency rule, same $1,000 day cap and $2,000
//             trailing drawdown, and the objective is money taken out
//
// So neither of the two settings tuned for the combine can be assumed to carry
// over. The $750 daily profit block existed partly because the consistency rule
// punished a single outsized day; with that rule gone it may be pure cost. And
// 8 lots was the size that maximised PASS RATE, which is not the same as the
// size that maximises median profit.
//
// Objective here: MEDIAN profit per account over 21 trading days. Median, not
// mean, so a config that occasionally prints a huge number does not win on the
// strength of its tail. An account that breaches the trailing drawdown is gone
// and scores 0 -- you cannot withdraw from a closed account.
//
// Usage:  node research/funded_median.mjs

import { run, dayArr, mul, days } from "./lib_shipped.mjs";

const DD = 2000, WIN = 21, TRIALS = 30000;
const cache = new Map();
function arrFor(lots, profitBlock, breaker) {
  const k = lots + "|" + profitBlock + "|" + breaker;
  if (!cache.has(k)) cache.set(k, dayArr(run(() => lots, { profitBlock, breaker }), days));
  return cache.get(k);
}

// One funded 21-day period. Returns final P&L, or null if the account is lost.
// stopAt: once the period is up this much, stand down for the rest of it.
function period(arr, start, stopAt) {
  let c = 0, pk = 0, lk = false;
  for (let d = 0; d < WIN; d++) {
    if (stopAt > 0 && c >= stopAt) break;          // flat for the remainder
    c += arr[(start + d) % arr.length];
    if (c <= (lk ? 0 : pk - DD)) return null;      // drawdown breached, account gone
    if (c > pk) pk = c;
    if (!lk && pk >= DD) lk = true;
  }
  return c;
}
const pctl = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
function score(lots, profitBlock, breaker, stopAt = 0, seed = 20250817) {
  const arr = arrFor(lots, profitBlock, breaker);
  const rnd = mul(seed), vals = [];
  let blown = 0, sum = 0;
  for (let t = 0; t < TRIALS; t++) {
    const r = period(arr, Math.floor(rnd() * arr.length), stopAt);
    if (r === null) { blown++; vals.push(0); }
    else { vals.push(r); sum += r; }
  }
  vals.sort((a, b) => a - b);
  return { med: pctl(vals, 0.5), mean: sum / TRIALS, p25: pctl(vals, 0.25),
           p75: pctl(vals, 0.75), blow: 100 * blown / TRIALS };
}

console.log("\n" + "=".repeat(108));
console.log("FUNDED ACCOUNT: MEDIAN PROFIT PER 21 TRADING DAYS  |  no consistency rule, $2,000 trailing DD");
console.log("=".repeat(108));

console.log("\n-- (1) the daily profit block: calibrated for the combine, is it still right? (8 lots) --");
console.log("  profit block   median    mean     25th     75th   account lost");
for (const pb of [500, 750, 1000, 1500, 2000, 3000, 0]) {
  const s = score(8, pb, 500);
  console.log("  " + (pb === 0 ? "off" : "$" + pb).padEnd(15) +
    ("$" + Math.round(s.med)).padStart(7) + ("$" + Math.round(s.mean)).padStart(8) +
    ("$" + Math.round(s.p25)).padStart(9) + ("$" + Math.round(s.p75)).padStart(9) +
    s.blow.toFixed(1).padStart(14) + "%");
}

console.log("\n-- (2) size, with the block off --");
console.log("  lots   median    mean     25th     75th   account lost");
for (const k of [4, 6, 8, 10, 12, 16, 20, 25, 30]) {
  const s = score(k, 0, 500);
  console.log("  " + String(k).padEnd(7) + ("$" + Math.round(s.med)).padStart(7) +
    ("$" + Math.round(s.mean)).padStart(8) + ("$" + Math.round(s.p25)).padStart(9) +
    ("$" + Math.round(s.p75)).padStart(9) + s.blow.toFixed(1).padStart(14) + "%");
}

console.log("\n-- (3) the full grid on MEDIAN profit --");
let hdr = "  lots  ";
const PBS = [500, 750, 1500, 3000, 0];
for (const pb of PBS) hdr += (pb === 0 ? "block off" : "block $" + pb).padStart(12);
console.log(hdr);
let best = null;
for (const k of [4, 6, 8, 10, 12, 16, 20, 25]) {
  let line = "  " + String(k).padEnd(6);
  for (const pb of PBS) {
    const s = score(k, pb, 500);
    if (!best || s.med > best.s.med) best = { k, pb, br: 500, s };
    line += ("$" + Math.round(s.med)).padStart(12);
  }
  console.log(line);
}
console.log("\n  best on median: " + best.k + " lots, block " +
  (best.pb === 0 ? "off" : "$" + best.pb) + "  ->  median $" + Math.round(best.s.med) +
  ", mean $" + Math.round(best.s.mean) + ", lost " + best.s.blow.toFixed(1) + "%");

console.log("\n-- (4) the circuit breaker, at the best size/block --");
console.log("  breaker   median    mean   account lost");
for (const br of [0, 250, 500, 750, 1000]) {
  const s = score(best.k, best.pb, br);
  console.log("  " + (br === 0 ? "off" : "$" + br).padEnd(10) +
    ("$" + Math.round(s.med)).padStart(7) + ("$" + Math.round(s.mean)).padStart(8) +
    s.blow.toFixed(1).padStart(15) + "%");
}

console.log("\n-- (5) standing down once the PERIOD is up by X (protects the middle, caps the tail) --");
console.log("  stop at   median    mean     25th     75th   account lost");
for (const sa of [0, 1000, 1500, 2000, 2500, 3000, 4000, 5000]) {
  const s = score(best.k, best.pb, 500, sa);
  console.log("  " + (sa === 0 ? "never" : "$" + sa).padEnd(10) +
    ("$" + Math.round(s.med)).padStart(7) + ("$" + Math.round(s.mean)).padStart(8) +
    ("$" + Math.round(s.p25)).padStart(9) + ("$" + Math.round(s.p75)).padStart(9) +
    s.blow.toFixed(1).padStart(14) + "%");
}
