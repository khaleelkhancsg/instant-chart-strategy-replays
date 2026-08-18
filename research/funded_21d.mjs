// The account only lives 21 trading days, so the year-long analysis was beside
// the point. Objective: over exactly 21 trading days, high ending balance AND
// high chance of still being alive to have it.
//
// Note those are not fully separate goals -- a breached account ends at zero, so
// median profit already prices survival in. What survival buys ON TOP is the
// shape of the distribution: how much of the time you finish with something.
// Both are reported, plus the 25th percentile, which is the honest "bad case".
//
// Usage:  node research/funded_21d.mjs

import { episode, mul, days } from "./lib_shipped.mjs";

const WIN = 21, TRIALS = 20000;
const pctl = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
const sizer = (lots, stopAt) => (a, ct, st) => (stopAt > 0 && st.acct >= stopAt ? 0 : lots);

function score(lots, stopAt, pb, lo = 0, hi = days.length) {
  const rnd = mul(20250817); const v = []; let dead = 0, sum = 0;
  for (let t = 0; t < TRIALS; t++) {
    const s = lo + Math.floor(rnd() * Math.max(1, hi - lo - WIN - 1));
    const r = episode(s, WIN, sizer(lots, stopAt), { profitBlock: pb });
    if (r.dead) { dead++; v.push(0); } else { v.push(r.acct); sum += r.acct; }
  }
  v.sort((a, b) => a - b);
  return { surv: 100 * (TRIALS - dead) / TRIALS, med: pctl(v, 0.5), mean: sum / TRIALS,
           p25: pctl(v, 0.25), p10: pctl(v, 0.10), p75: pctl(v, 0.75) };
}

console.log("\n" + "=".repeat(112));
console.log("21 TRADING DAYS: BALANCE AND SURVIVAL TOGETHER  |  profit block $500 unless noted");
console.log("=".repeat(112));

const all = [];
for (const k of [1, 2, 3, 4, 5, 6, 8, 10])
for (const sa of [0, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000]) {
  const s = score(k, sa, 500);
  all.push({ k, sa, ...s });
}

// Pareto frontier on (survival, median): keep anything nothing else beats on both.
const front = all.filter(x => !all.some(y => (y.surv >= x.surv && y.med > x.med) ||
                                             (y.surv > x.surv && y.med >= x.med)));
front.sort((a, b) => b.surv - a.surv);
console.log("\n-- the efficient frontier: nothing else beats these on BOTH survival and median --");
console.log("  lots   stop at    survive   median     mean      10th      25th      75th");
for (const x of front)
  console.log("  " + String(x.k).padEnd(7) + (x.sa ? "$" + x.sa : "never").padEnd(10) +
    x.surv.toFixed(1).padStart(8) + "%" + ("$" + Math.round(x.med)).padStart(9) +
    ("$" + Math.round(x.mean)).padStart(9) + ("$" + Math.round(x.p10)).padStart(10) +
    ("$" + Math.round(x.p25)).padStart(10) + ("$" + Math.round(x.p75)).padStart(10));

console.log("\n-- everything dominated by the frontier, for reference (top 10 by median) --");
console.log("  lots   stop at    survive   median      25th");
for (const x of all.filter(a => !front.includes(a)).sort((a, b) => b.med - a.med).slice(0, 10))
  console.log("  " + String(x.k).padEnd(7) + (x.sa ? "$" + x.sa : "never").padEnd(10) +
    x.surv.toFixed(1).padStart(8) + "%" + ("$" + Math.round(x.med)).padStart(9) +
    ("$" + Math.round(x.p25)).padStart(10));

console.log("\n-- does the frontier hold on the SECOND half of history? --");
console.log("  lots   stop at   all: surv/median        2nd half: surv/median     2nd-half 25th");
const H = days.length >> 1;
for (const x of front) {
  const b = score(x.k, x.sa, 500, H, days.length);
  console.log("  " + String(x.k).padEnd(7) + (x.sa ? "$" + x.sa : "never").padEnd(9) +
    (x.surv.toFixed(1) + "% / $" + Math.round(x.med)).padStart(20) +
    (b.surv.toFixed(1) + "% / $" + Math.round(b.med)).padStart(26) +
    ("$" + Math.round(b.p25)).padStart(16));
}

console.log("\n-- profit block, checked at the small sizes where it may never bind --");
console.log("  lots   stop     block $500 surv/median     block off surv/median");
for (const [k, sa] of [[1, 0], [2, 1000], [4, 1000], [8, 1000], [8, 1500]]) {
  const a = score(k, sa, 500), b = score(k, sa, 0);
  console.log("  " + String(k).padEnd(7) + (sa ? "$" + sa : "never").padEnd(9) +
    (a.surv.toFixed(1) + "% / $" + Math.round(a.med)).padStart(22) +
    (b.surv.toFixed(1) + "% / $" + Math.round(b.med)).padStart(26));
}
