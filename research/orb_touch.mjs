// Round 6 -- the level definition I got wrong the first time.
//
// He does not take the high and low of the pre-open range. He counts TAPS:
// points where price came to a price and turned away, and he picks the price
// with the most of them. Crucially that level can sit INSIDE the range -- "it
// doesn't have to be just to one side. We can be hitting it to the upside. We
// could be hitting it to the downside."
//
// That is a materially different rule, and it should trade MORE than the
// extremes version, because an internal level is easier to break. Given that
// every result so far has been governed by throughput rather than trade
// quality, more trades is exactly the direction that could matter.
//
// Usage:  node research/orb_touch.mjs

import { run, setups, stat, passOf, HDR, row, ALL, H1, H2, RECENT, inSet } from "./lib_orb.mjs";

const base = { levelMode: "touch", refWin: "PRE60", pivotK: 2, tolFrac: 0.08, minTouch: 3,
               mode: "confirmed", stopAt: "level", rMult: 2.0, retraceFrac: 0.33,
               giveUpCt: 570, maxHoldMin: 120, riskDollars: 500 };

console.log("\n" + "=".repeat(124));
console.log("ROUND 6 -- LEVELS BY TAP COUNT (his actual rule), not by range extreme");
console.log("=".repeat(124));

// ---- 1. is the detector finding anything, and is it INTERNAL? -------------
console.log("\n-- (1) detector diagnostics: does a tap-counted level differ from the range extreme? --");
console.log("  window  pivotK  tol    minTaps    days with levels   avg taps   avg INSET from the extremes");
for (const refWin of ["PRE30", "PRE60", "PRE90", "PRE120"])
for (const pivotK of [2, 3])
for (const tolFrac of [0.05, 0.08, 0.15])
for (const minTouch of [3, 4]) {
  const d = setups({ ...base, refWin, pivotK, tolFrac, minTouch }).diag;
  if (!d.nLevel) { console.log("  " + refWin.padEnd(8) + pivotK + "      " + tolFrac + "   " + minTouch + "          none"); continue; }
  console.log("  " + refWin.padEnd(8) + String(pivotK).padEnd(8) + String(tolFrac).padEnd(7) +
    String(minTouch).padEnd(10) + (d.nLevel + "/" + d.days).padStart(15) +
    ((d.tapsHi + d.tapsLo) / (2 * d.nLevel)).toFixed(1).padStart(11) +
    (d.insetSum / d.nLevel).toFixed(1).padStart(25) + "%");
}

// ---- 2. his strategy on the level he actually draws ----------------------
console.log("\n-- (2) his configuration, on tap-counted levels vs range extremes --");
console.log(HDR);
for (const [lbl, lm] of [["tap-counted levels", "touch"], ["range extremes", "extremes"]]) {
  const c = { ...base, levelMode: lm };
  row(lbl + ": confirmed", run(c));
  row(lbl + ": conf shuffled", run({ ...c, flipSeed: 99 }));
  row(lbl + ": plain", run({ ...c, mode: "plain" }));
  row(lbl + ": plain shuffled", run({ ...c, mode: "plain", flipSeed: 99 }));
  console.log("");
}

// ---- 3. sweep the tap-level version, with its own shuffled null ----------
const GRID = [];
for (const refWin of ["PRE30", "PRE60", "PRE90", "PRE120"])
for (const pivotK of [2, 3])
for (const tolFrac of [0.05, 0.08, 0.15])
for (const minTouch of [3, 4])
for (const mode of ["confirmed", "plain"])
for (const [stopAt, stopK] of [["level", 0], ["range", 0.5], ["range", 1.0], ["opposite", 0]])
for (const rMult of [1.5, 2.0, 3.0])
for (const maxHoldMin of [60, 120, 1000])
  GRID.push({ ...base, refWin, pivotK, tolFrac, minTouch, mode, stopAt, stopK, rMult, maxHoldMin });

console.log("-- (3) sweep of the tap-level version: " + GRID.length + " configs, real vs direction-shuffled --");
function score(cfg, flipSeed) {
  const r = run(flipSeed ? { ...cfg, flipSeed } : cfg);
  if (r.trades.length < 200) return null;
  const p1 = passOf(inSet(r.trades, H1), H1), p2 = passOf(inSet(r.trades, H2), H2);
  const st = stat(r.trades);
  return { cfg, worse: Math.min(p1, p2), p1, p2, all: passOf(r.trades, ALL),
           rec: passOf(inSet(r.trades, RECENT), RECENT), n: st.n, exp: st.exp, pf: st.pf, win: st.win };
}
const real = [], shuf = [];
for (const c of GRID) { const a = score(c, 0); if (a) real.push(a); const b = score(c, 99); if (b) shuf.push(b); }
real.sort((a, b) => b.worse - a.worse); shuf.sort((a, b) => b.worse - a.worse);

const lbl = (c) => (c.mode === "confirmed" ? "conf " : "plain") + " " + c.refWin.padEnd(6) +
  "k" + c.pivotK + " tol" + c.tolFrac + " tap" + c.minTouch +
  " " + (c.stopAt === "range" ? "rng" + c.stopK : c.stopAt).padEnd(8) + c.rMult + "R hold=" +
  (c.maxHoldMin === 1000 ? "eod" : c.maxHoldMin + "m");
const show = (arr, t) => {
  console.log("\n" + t);
  console.log("  #  config                                                          n   win%     pf  $/trade   worse    1stH    2ndH  recent");
  for (let i = 0; i < 8 && i < arr.length; i++) { const r = arr[i];
    console.log("  " + String(i + 1).padStart(2) + " " + lbl(r.cfg).padEnd(54) + String(r.n).padStart(6) +
      r.win.toFixed(1).padStart(7) + r.pf.toFixed(3).padStart(7) + ("$" + r.exp.toFixed(2)).padStart(9) +
      r.worse.toFixed(1).padStart(8) + "%" + r.p1.toFixed(1).padStart(7) + "%" +
      r.p2.toFixed(1).padStart(7) + "%" + r.rec.toFixed(1).padStart(7) + "%"); }
};
show(real, "-- best REAL --");
show(shuf, "-- best SHUFFLED (same grid, coin-flip direction) --");
console.log("\n  best real, worse half:      " + real[0].worse.toFixed(1) + "%");
console.log("  best shuffled, worse half:  " + shuf[0].worse.toFixed(1) + "%");
console.log("  difference:                 " + (real[0].worse - shuf[0].worse).toFixed(1) + "pp");
console.log("\n  benchmarks: extremes-level sweep best 29.4% (shuffled 29.4%) | no-signal baseline 28.3% | shipped bot 49.8%");
