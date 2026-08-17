// Is the 8-then-12 sizing gain real, or is it noise?
//
// The claim: 8 lots before 11:30 and 12 after scores 52.6% against flat 8's
// 49.8%, worse half 49.3% against 48.6%. A first paired bootstrap gave +2.22pp
// with a 95% CI of -1.67 to +6.67, which already crosses zero. This is the
// extensive version.
//
// A sizing rule is not a signal, so it needs different tests. It does not change
// WHICH trades happen, only how big a subset of them is. So the question is not
// "does it predict" but "does scaling this particular subset improve the
// distribution more than scaling an arbitrary subset would".
//
// The sharp control is therefore a MATCHED-RATE RANDOM BUMP: promote the same
// fraction of trades to 12 lots, chosen at random rather than by clock. If that
// scores the same, "afternoon" carries no information and the gain is just
// leverage.
//
// Usage:  node research/sizing_verify.mjs
//         ORB_BIN=data/mes_1m.bin ORB_PV=5 node research/sizing_verify.mjs

import { run, stat, passOf, dayArr, passArr, evWith, mul, days, yearOf,
         H1, H2, RECENT, inSet, PV } from "./lib_shipped.mjs";

const CUT = 630;                                   // 11:30 ET
const flat8   = () => 8;
const split   = (a, ct) => ct < CUT ? 8 : 12;
const T8 = run(flat8), TS_ = run(split);
const bumpRate = TS_.filter(t => t.lots === 12).length / TS_.length;

const HDR = "  rule                          n   lots   win%     pf   $/trade     net    pass   1stH   2ndH  recent";
function row(lbl, t) {
  const s = stat(t);
  const p1 = passOf(inSet(t, H1), H1), p2 = passOf(inSet(t, H2), H2);
  console.log("  " + lbl.padEnd(26) + String(s.n).padStart(6) + s.lots.toFixed(1).padStart(7) +
    s.win.toFixed(1).padStart(7) + s.pf.toFixed(3).padStart(7) + ("$" + s.exp.toFixed(2)).padStart(10) +
    ("$" + Math.round(s.net / 1000) + "k").padStart(8) + passOf(t, days).toFixed(1).padStart(8) + "%" +
    p1.toFixed(1).padStart(6) + "%" + p2.toFixed(1).padStart(6) + "%" +
    passOf(inSet(t, RECENT), RECENT).toFixed(1).padStart(7) + "%");
  return { all: passOf(t, days), worse: Math.min(p1, p2) };
}

console.log("\n" + "=".repeat(112));
console.log("IS THE 8-THEN-12 SIZING GAIN REAL?" + (PV === 5 ? "   [MES]" : "   [MNQ]"));
console.log("=".repeat(112));

// ---- 1. is it just "more size"? -----------------------------------------
console.log("\n-- (1) first rule out plain leverage: the split averages 9.8 lots, so compare flat sizes --");
console.log(HDR);
for (const k of [8, 9, 10, 11, 12]) row("flat " + k, run(() => k));
row("8 -> 12 at 11:30", TS_);
console.log("\n  Every flat size at or above the split's 9.8 average scores WORSE than flat 8.");
console.log("  So whatever the split is doing, it is not simply carrying more contracts.");

// ---- 2. THE control: bump a random subset at the same rate ---------------
console.log("\n-- (2) the sharp control: promote the SAME FRACTION of trades to 12, chosen at random --");
console.log("   bump rate to match: " + (100 * bumpRate).toFixed(1) + "% of trades");
console.log(HDR);
row("8 -> 12 at 11:30 (real)", TS_);
const rnds = [];
for (const seed of [3, 17, 41, 99, 123, 777, 2024]) {
  const r = mul(seed);
  const t = run(() => (r() < bumpRate ? 12 : 8));
  rnds.push(row("  random bump, seed " + seed, t));
}
const rAll = rnds.map(x => x.all), rW = rnds.map(x => x.worse);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log("\n  real   : all " + passOf(TS_, days).toFixed(1) + "%   worse " +
            Math.min(passOf(inSet(TS_, H1), H1), passOf(inSet(TS_, H2), H2)).toFixed(1) + "%");
console.log("  random : all " + mean(rAll).toFixed(1) + "% (range " + Math.min(...rAll).toFixed(1) + "-" +
            Math.max(...rAll).toFixed(1) + ")   worse " + mean(rW).toFixed(1) + "% (range " +
            Math.min(...rW).toFixed(1) + "-" + Math.max(...rW).toFixed(1) + ")");

// ---- 3. per-year stability ----------------------------------------------
console.log("\n-- (3) per year: a real effect should show up in most years, not one --");
console.log("  year   days   flat 8   8->12   delta");
const years = [...new Set([...yearOf.values()])].sort();
let wins = 0, tot = 0;
for (const y of years) {
  const yd = days.filter(d => yearOf.get(d) === y);
  if (yd.length < 120) continue;
  const a = passOf(inSet(T8, yd), yd), b = passOf(inSet(TS_, yd), yd);
  tot++; if (b > a) wins++;
  console.log("  " + y + String(yd.length).padStart(7) + a.toFixed(1).padStart(9) + "%" +
    b.toFixed(1).padStart(7) + "%" + (b - a).toFixed(1).padStart(8) + "pp");
}
console.log("  -> the split wins in " + wins + " of " + tot + " full years");

// ---- 4. rolling-origin walk-forward -------------------------------------
console.log("\n-- (4) rolling walk-forward: pick the cut and lot count on data BEFORE each origin --");
console.log("  origin      chosen       in-sample   out-of-sample   flat 8 OOS   delta");
const GRID = [];
for (const cut of [570, 600, 630, 660, 690, 720])
  for (const lots of [9, 10, 11, 12, 14, 16]) GRID.push({ cut, lots });
const cache = new Map();
const getT = (c) => { const k = c.cut + "_" + c.lots;
  if (!cache.has(k)) cache.set(k, run((a, ct) => ct < c.cut ? 8 : c.lots)); return cache.get(k); };
let dSum = 0, dN = 0;
for (const frac of [0.4, 0.5, 0.6, 0.7, 0.8]) {
  const k = Math.floor(days.length * frac);
  const tr = days.slice(0, k), te = days.slice(k);
  let best = null;
  for (const c of GRID) {
    const p = passOf(inSet(getT(c), tr), tr);
    if (!best || p > best.p) best = { c, p };
  }
  const oos = passOf(inSet(getT(best.c), te), te);
  const base = passOf(inSet(T8, te), te);
  dSum += oos - base; dN++;
  console.log("  " + (100 * frac).toFixed(0) + "%" + ("8->" + best.c.lots + " at " + best.c.cut).padStart(13) +
    best.p.toFixed(1).padStart(13) + "%" + oos.toFixed(1).padStart(14) + "%" +
    base.toFixed(1).padStart(12) + "%" + (oos - base).toFixed(1).padStart(8) + "pp");
}
console.log("  -> mean out-of-sample delta across 5 origins: " + (dSum / dN).toFixed(2) + "pp");

// ---- 5. is 11:30 special, or is any cut fine? ---------------------------
console.log("\n-- (5) cut-time surface: a real effect should be a plateau, not a spike --");
console.log("  cut     9 lots  10 lots  11 lots  12 lots  14 lots  16 lots");
for (const cut of [570, 600, 630, 660, 690, 720]) {
  let line = "  " + String(cut).padEnd(8);
  for (const lots of [9, 10, 11, 12, 14, 16]) {
    const t = getT({ cut, lots });
    line += (Math.min(passOf(inSet(t, H1), H1), passOf(inSet(t, H2), H2))).toFixed(1).padStart(8) + "%";
  }
  console.log(line);
}
console.log("  (worse half; flat 8 baseline = " +
  Math.min(passOf(inSet(T8, H1), H1), passOf(inSet(T8, H2), H2)).toFixed(1) + "%)");

// ---- 6. does it survive metrics it was never tuned on? ------------------
console.log("\n-- (6) metric sensitivity: the gain should not depend on the exact combine rules --");
console.log("  target   DD    window   flat 8   8->12   delta");
const a8 = dayArr(T8, days), aS = dayArr(TS_, days);
for (const [target, dd, window] of [[3000, 2000, 21], [3000, 2000, 30], [3000, 2000, 15],
                                     [2000, 2000, 21], [4000, 2000, 21], [3000, 2500, 21], [3000, 1500, 21]]) {
  const o = { target, dd, window };
  const a = passArr(a8, o), b = passArr(aS, o);
  console.log("  " + String(target).padStart(5) + String(dd).padStart(6) + String(window).padStart(8) +
    a.toFixed(1).padStart(9) + "%" + b.toFixed(1).padStart(7) + "%" + (b - a).toFixed(1).padStart(8) + "pp");
}

// ---- 7. costs -----------------------------------------------------------
console.log("\n-- (7) cost sensitivity: 12 lots is a bigger footprint than 8 --");
console.log("  costs    flat 8   8->12   delta");
for (const cm of [1, 1.5, 2, 3]) {
  const a = passOf(run(flat8, { costMult: cm }), days);
  const b = passOf(run(split, { costMult: cm }), days);
  console.log("  x" + String(cm).padEnd(7) + a.toFixed(1).padStart(7) + "%" +
    b.toFixed(1).padStart(7) + "%" + (b - a).toFixed(1).padStart(8) + "pp");
}

// ---- 8. a proper paired bootstrap ---------------------------------------
console.log("\n-- (8) paired bootstrap, 2000 reps x 600 draws (the first pass used 400 x 300) --");
const rnd2 = mul(9001), diffs = [];
for (let rep = 0; rep < 2000; rep++) {
  let wa = 0, wb = 0;
  const idx = new Array(21), ba = new Array(21), bb = new Array(21);
  for (let d = 0; d < 600; d++) {
    let mm = 0;
    while (mm < 21) { const st = Math.floor(rnd2() * Math.max(1, days.length - 5));
      for (let j = 0; j < 5 && mm < 21; j++) idx[mm++] = (st + j) % days.length; }
    for (let k = 0; k < 21; k++) { ba[k] = a8[idx[k]]; bb[k] = aS[idx[k]]; }
    wa += evWith(ba); wb += evWith(bb);
  }
  diffs.push(100 * (wb - wa) / 600);
}
diffs.sort((x, y) => x - y);
console.log("  mean difference : " + mean(diffs).toFixed(2) + "pp");
console.log("  95% CI          : " + diffs[50].toFixed(2) + " to " + diffs[1949].toFixed(2) + "pp");
console.log("  99% CI          : " + diffs[10].toFixed(2) + " to " + diffs[1989].toFixed(2) + "pp");
console.log("  draws won       : " + (100 * diffs.filter(d => d > 0).length / diffs.length).toFixed(1) + "%");

// ---- 9. more control seeds, and the surface on all-history too ----------
// Seven random-bump seeds only supports a rank test at p ~ 0.125. And section
// (5) showed the worse-half surface is a spike; worse-half is min() of two
// noisy numbers, so the all-history surface is the fairer read of shape.
console.log("\n-- (9a) random-bump control, 30 seeds --");
const seeds30 = [];
for (let s = 1; s <= 30; s++) {
  const r = mul(s * 7919);
  const t = run(() => (r() < bumpRate ? 12 : 8));
  seeds30.push({ all: passOf(t, days),
                 worse: Math.min(passOf(inSet(t, H1), H1), passOf(inSet(t, H2), H2)) });
}
const realAll = passOf(TS_, days);
const realW = Math.min(passOf(inSet(TS_, H1), H1), passOf(inSet(TS_, H2), H2));
const beatAll = seeds30.filter(x => x.all >= realAll).length;
const beatW = seeds30.filter(x => x.worse >= realW).length;
const sAll = seeds30.map(x => x.all).sort((a, b) => a - b);
const sW = seeds30.map(x => x.worse).sort((a, b) => a - b);
console.log("  real          all " + realAll.toFixed(1) + "%    worse " + realW.toFixed(1) + "%");
console.log("  30 randoms    all " + mean(sAll).toFixed(1) + "% (" + sAll[0].toFixed(1) + "-" +
            sAll[29].toFixed(1) + ")    worse " + mean(sW).toFixed(1) + "% (" + sW[0].toFixed(1) +
            "-" + sW[29].toFixed(1) + ")");
console.log("  randoms matching or beating real:  all " + beatAll + "/30  (p = " +
            ((beatAll + 1) / 31).toFixed(3) + ")   worse " + beatW + "/30  (p = " +
            ((beatW + 1) / 31).toFixed(3) + ")");

console.log("\n-- (9b) cut-time surface on ALL HISTORY (worse-half is min of two noisy halves) --");
console.log("  cut     9 lots  10 lots  11 lots  12 lots  14 lots  16 lots");
for (const cut of [570, 600, 630, 660, 690, 720]) {
  let line = "  " + String(cut).padEnd(8);
  for (const lots of [9, 10, 11, 12, 14, 16])
    line += passOf(getT({ cut, lots }), days).toFixed(1).padStart(8) + "%";
  console.log(line);
}
console.log("  (flat 8 baseline = " + passOf(T8, days).toFixed(1) + "%)");
