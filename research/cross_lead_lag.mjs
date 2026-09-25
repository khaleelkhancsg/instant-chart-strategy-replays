// Does the 1-minute MACD cross lead the 5-minute cross, and is that usable?
//
// The observation: when the two timeframes align, the 1-minute cross always
// fires first. The 1-minute flips several times in between, but the ordering
// never reverses.
//
// That should be true almost by construction. A 5-minute MACD at 12/26/9 spans
// 60/130/45 minutes of price against the 1-minute's 12/26/9, so it is the same
// indicator viewed about five times slower, and a slower filter cannot turn
// before a faster one on the same move.
//
// ── BUT TRUE AND USABLE ARE DIFFERENT CONDITIONALS ──────────────────────
// "When they align, the 1-minute went first" is a statement about
//
//     P(a 1-minute cross came before | a 5-minute cross happened)
//
// which is measured looking BACK from the 5-minute cross, and which this file
// expects to come out near 100%. Trading needs the other direction,
//
//     P(a 5-minute cross follows | a 1-minute cross just happened)
//
// measured FORWARD from something knowable at the time. The user's own caveat --
// that the 1-minute flips several times before they align -- is exactly the gap
// between the two, and the gap is the whole question. Both are measured here.
//
// Part 3 then asks the only thing that matters: can the 1-minute crosses that DO
// lead be told apart from the ones that do not, using the 5-minute histogram's
// state at that moment?
//
// Timing is measured in knowability, not in bar index. A 1-minute cross at bar i
// is known at i. A 5-minute cross at bar k is known at srcLast[k], when that bar
// closes. Comparing anything else would invent lead time that does not exist.
//
//   node research/cross_lead_lag.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { resolveParams } from "../src/run.mjs";
import flip from "../strategies/macd_1m_flip.mjs";

const { bars } = loadBars();
const p = resolveParams(flip);
const n = bars.close.length;

const h1 = flip.compute(bars, p).overlays.find((o) => o.kind === "hist").data;
const tf5 = resample(bars, 5);
const h5 = flip.compute(tf5, p).overlays.find((o) => o.kind === "hist").data;
const n5 = h5.length;
const sgn = (v) => (v >= 0 ? 1 : -1);

// Cross lists, each stamped with the 1-minute index at which it became KNOWN.
const x1 = [];
for (let i = 1; i < n; i++) {
  if (!Number.isFinite(h1[i]) || !Number.isFinite(h1[i - 1])) continue;
  if (sgn(h1[i]) !== sgn(h1[i - 1])) x1.push({ t: i, d: sgn(h1[i]) });
}
const x5 = [];
for (let k = 1; k < n5; k++) {
  if (!Number.isFinite(h5[k]) || !Number.isFinite(h5[k - 1])) continue;
  if (sgn(h5[k]) !== sgn(h5[k - 1])) x5.push({ t: tf5.srcLast[k], d: sgn(h5[k]), k });
}

console.log("");
console.log("=".repeat(96));
console.log("DOES THE 1-MINUTE MACD CROSS LEAD THE 5-MINUTE ONE?");
console.log("=".repeat(96));
console.log("");
console.log("  1-minute crosses  " + x1.length.toLocaleString() +
  "        5-minute crosses  " + x5.length.toLocaleString() +
  "        ratio " + (x1.length / x5.length).toFixed(1) + " to 1");

// ── PART 1: looking BACK from each 5-minute cross ───────────────────────
// For each 5-minute cross, the most recent 1-minute cross in the same direction
// before it. This is the claim as stated.
const leads = [];
let noPrior = 0;
{
  let j = 0;
  const lastSame = { 1: -1, "-1": -1 };
  for (const c5 of x5) {
    while (j < x1.length && x1[j].t <= c5.t) { lastSame[x1[j].d] = x1[j].t; j++; }
    const prior = lastSame[c5.d];
    if (prior < 0) { noPrior++; continue; }
    leads.push(c5.t - prior);
  }
}
const srt = leads.slice().sort((a, b) => a - b);
const pct = (q) => srt[Math.min(srt.length - 1, Math.floor(q * srt.length))];
console.log("");
console.log("PART 1 -- looking BACK from each 5-minute cross (the claim as stated)");
console.log("");
console.log("  5-minute crosses with a same-direction 1-minute cross before them:  " +
  (100 * leads.length / x5.length).toFixed(2) + "%");
console.log("  lead time, in minutes:   p10 " + pct(0.10) + "   median " + pct(0.50) +
  "   p90 " + pct(0.90));
for (const w of [5, 15, 30, 60]) {
  const c = leads.filter((l) => l <= w).length;
  console.log("    the 1-minute cross came within " + String(w).padStart(2) +
    " min   " + (100 * c / leads.length).toFixed(1) + "%");
}
console.log("");
console.log("  So the ordering holds. The 1-minute cross leads essentially always,");
console.log("  which is what a five-times-faster filter on the same price must do.");

// ── PART 2: looking FORWARD from each 1-minute cross ────────────────────
// The tradeable direction. At a 1-minute cross, does a 5-minute cross the same
// way actually follow?
console.log("");
console.log("PART 2 -- looking FORWARD from each 1-minute cross (what you could act on)");
console.log("");
const idx5 = { 1: [], "-1": [] };
for (const c of x5) idx5[c.d].push(c.t);
function followsWithin(t, d, w) {
  const arr = idx5[d];
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] >= t) { ans = arr[m]; hi = m - 1; } else lo = m + 1;
  }
  return ans >= 0 && ans - t <= w;
}
console.log("  a 5-minute cross the same way followed a 1-minute cross within:");
for (const w of [5, 15, 30, 60]) {
  const c = x1.filter((c1) => followsWithin(c1.t, c1.d, w)).length;
  console.log("    " + String(w).padStart(2) + " min   " +
    (100 * c / x1.length).toFixed(1) + "%");
}
console.log("");
console.log("  That gap is the whole problem. Looking back the ordering is near certain;");
console.log("  looking forward it is a coin flip at best, because the 1-minute throws " +
  (x1.length / x5.length).toFixed(1));
console.log("  crosses for every 5-minute one and most of them lead nowhere.");

// ── PART 3: can the leading ones be told apart in advance? ──────────────
// The 5-minute histogram's own state at the moment of the 1-minute cross is
// knowable then, so it is a legitimate filter. Does it separate them?
const SCALE = 200;
const sc5 = new Float64Array(n5).fill(NaN);
{
  let s = 0;
  for (let i = 0; i < n5; i++) {
    const a = Math.abs(h5[i]);
    if (Number.isFinite(a)) s += a;
    if (i >= SCALE) s -= Math.abs(h5[i - SCALE]) || 0;
    if (i >= SCALE - 1) sc5[i] = s / SCALE;
  }
}
// The 5-minute bar whose CLOSE is the last one known at 1-minute index t.
const known5 = new Int32Array(n).fill(-1);
{
  let k = 0, cur = -1;
  for (let i = 0; i < n; i++) {
    while (k < n5 && tf5.srcLast[k] <= i) { cur = k; k++; }
    known5[i] = cur;
  }
}
console.log("");
console.log("PART 3 -- can the 1-minute crosses that lead be separated at the time?");
console.log("");
console.log("  condition at the 1-minute cross                 crosses   5m follows in 30m   lift");
console.log("  " + "-".repeat(84));
const baseRate = (100 * x1.filter((c) => followsWithin(c.t, c.d, 30)).length) / x1.length;
console.log("  " + "(any 1-minute cross)".padEnd(46) + x1.length.toLocaleString().padStart(8) +
  baseRate.toFixed(1).padStart(16) + "%" + "      -");
const CONDS = [
  ["5m hist already same side as the cross", (c, k) => sgn(h5[k]) === c.d],
  ["5m hist opposite (a genuine lead)", (c, k) => sgn(h5[k]) !== c.d],
  ["5m |hist| < 0.25x its average", (c, k) => Math.abs(h5[k]) < 0.25 * sc5[k]],
  ["5m |hist| < 0.10x its average", (c, k) => Math.abs(h5[k]) < 0.10 * sc5[k]],
  ["5m opposite AND |hist| < 0.25x", (c, k) => sgn(h5[k]) !== c.d && Math.abs(h5[k]) < 0.25 * sc5[k]],
  ["5m opposite AND |hist| < 0.10x", (c, k) => sgn(h5[k]) !== c.d && Math.abs(h5[k]) < 0.10 * sc5[k]],
  ["5m hist shrinking toward zero 3 bars", (c, k) => k >= 3 &&
    Math.abs(h5[k]) < Math.abs(h5[k - 1]) && Math.abs(h5[k - 1]) < Math.abs(h5[k - 2]) &&
    Math.abs(h5[k - 2]) < Math.abs(h5[k - 3])],
  ["all three: opposite, <0.25x, shrinking", (c, k) => sgn(h5[k]) !== c.d &&
    Math.abs(h5[k]) < 0.25 * sc5[k] && k >= 3 &&
    Math.abs(h5[k]) < Math.abs(h5[k - 1]) && Math.abs(h5[k - 1]) < Math.abs(h5[k - 2])],
];
for (const [lab, fn] of CONDS) {
  const g = x1.filter((c) => {
    const k = known5[c.t];
    if (k < 1 || !Number.isFinite(h5[k]) || !Number.isFinite(sc5[k]) || sc5[k] <= 0) return false;
    return fn(c, k);
  });
  if (g.length < 200) { console.log("  " + lab.padEnd(46) + "   too few"); continue; }
  const r = (100 * g.filter((c) => followsWithin(c.t, c.d, 30)).length) / g.length;
  console.log("  " + lab.padEnd(46) + g.length.toLocaleString().padStart(8) +
    r.toFixed(1).padStart(16) + "%" + (r / baseRate).toFixed(2).padStart(9) + "x");
}
console.log("");
