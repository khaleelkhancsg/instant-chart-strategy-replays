// Give the opening-range strategy its best possible shot, then check whether
// the best shot means anything.
//
// Searching ~2,000 configurations guarantees a good-looking winner even on pure
// noise. So the same grid is run twice: once on the real direction, once with
// the long/short call shuffled. If the best REAL config scores like the best
// SHUFFLED config, the search found the shape of the search, not an edge.
//
// Sizing is fixed at $500 risk per trade throughout, which removes the $1,000
// cap truncation that produced the only positive row in round 1.
//
// Ranking is on the WORSE of the two time halves, then the held-out second half
// is reported separately, because a config picked on all history has already
// seen the data it is being judged on.
//
// Usage:  node research/orb_sweep.mjs

import { run, stat, passOf, dayArr, passOfArr, ALL, H1, H2, RECENT, inSet } from "./lib_orb.mjs";

const GRID = [];
for (const refWin of ["OR5", "OR15", "OR30", "OR60", "PRE30", "PRE60"])
for (const mode of ["confirmed", "plain"])
for (const [stopAt, stopK] of [["range", 0.25], ["range", 0.5], ["range", 1.0], ["retrace", 0], ["opposite", 0]])
for (const rMult of [1.0, 1.5, 2.0, 3.0])
for (const giveUpCt of [570, 630])
for (const maxHoldMin of [15, 60, 120, 1000])
  GRID.push({ refWin, mode, stopAt, stopK, rMult, giveUpCt, maxHoldMin,
              retraceFrac: 0.33, riskDollars: 500 });

console.log("\n" + "=".repeat(124));
console.log("ROUND 3 -- FULL PARAMETER SWEEP  |  " + GRID.length + " configs, each run twice (real vs direction-shuffled)");
console.log("=".repeat(124));

const label = (c) => (c.mode === "confirmed" ? "conf" : "plain") + " " + c.refWin.padEnd(5) +
  " stop=" + (c.stopAt === "range" ? "rng" + c.stopK : c.stopAt.slice(0, 4)).padEnd(7) +
  " " + c.rMult + "R give=" + c.giveUpCt + " hold=" + (c.maxHoldMin === 1000 ? "eod" : c.maxHoldMin + "m");

function score(cfg, flipSeed) {
  const r = run(flipSeed ? { ...cfg, flipSeed } : cfg);
  if (r.trades.length < 200) return null;             // too thin to evaluate
  const p1 = passOf(inSet(r.trades, H1), H1);
  const p2 = passOf(inSet(r.trades, H2), H2);
  const st = stat(r.trades);
  return { cfg, worse: Math.min(p1, p2), p1, p2, all: passOf(r.trades, ALL),
           rec: passOf(inSet(r.trades, RECENT), RECENT), n: st.n, exp: st.exp, pf: st.pf, win: st.win };
}

const real = [], shuf = [];
for (const c of GRID) {
  const a = score(c, 0);       if (a) real.push(a);
  const b = score(c, 99);      if (b) shuf.push(b);
}
real.sort((a, b) => b.worse - a.worse);
shuf.sort((a, b) => b.worse - a.worse);

const show = (arr, k, title) => {
  console.log("\n" + title);
  console.log("  #  config                                                        n   win%     pf  $/trade   worse    1stH    2ndH     all  recent");
  for (let i = 0; i < k && i < arr.length; i++) {
    const r = arr[i];
    console.log("  " + String(i + 1).padStart(2) + " " + label(r.cfg).padEnd(52) +
      String(r.n).padStart(6) + r.win.toFixed(1).padStart(7) + r.pf.toFixed(3).padStart(7) +
      ("$" + r.exp.toFixed(2)).padStart(9) + r.worse.toFixed(1).padStart(8) + "%" +
      r.p1.toFixed(1).padStart(7) + "%" + r.p2.toFixed(1).padStart(7) + "%" +
      r.all.toFixed(1).padStart(7) + "%" + r.rec.toFixed(1).padStart(7) + "%");
  }
};

show(real, 12, "-- best 12 of the REAL sweep, ranked on the worse time half --");
show(shuf, 12, "-- best 12 of the SHUFFLED sweep (same grid, coin-flip direction) = the selection-bias floor --");

console.log("\n-- the comparison that matters --");
console.log("  best real config, worse half:      " + real[0].worse.toFixed(1) + "%");
console.log("  best SHUFFLED config, worse half:  " + shuf[0].worse.toFixed(1) + "%   <- what searching " +
            GRID.length + " configs buys you on noise");
console.log("  edge attributable to the strategy: " + (real[0].worse - shuf[0].worse).toFixed(1) + "pp");
const rq = (arr, q) => arr[Math.floor(arr.length * q)].worse;
console.log("  real   sweep worse-half quartiles: " +
  [0.99, 0.9, 0.5, 0.1].map(q => rq(real, 1 - q).toFixed(1) + "%").join("  "));
console.log("  shuffled sweep worse-half quartiles: " +
  [0.99, 0.9, 0.5, 0.1].map(q => rq(shuf, 1 - q).toFixed(1) + "%").join("  "));

// ---- walk-forward: choose on the first half only, then look at the second --
console.log("\n-- (walk-forward) pick the config on the FIRST half only, then read the second half --");
const byH1 = real.slice().sort((a, b) => b.p1 - a.p1);
console.log("  #  chosen on 1st half                                        1stH    2ndH   delta");
for (let i = 0; i < 8; i++) {
  const r = byH1[i];
  console.log("  " + String(i + 1).padStart(2) + " " + label(r.cfg).padEnd(52) +
    r.p1.toFixed(1).padStart(7) + "%" + r.p2.toFixed(1).padStart(7) + "%" +
    (r.p2 - r.p1).toFixed(1).padStart(7) + "pp");
}
const top10 = byH1.slice(0, 10);
console.log("  mean of the top 10 picked on 1st half:  1stH " +
  (top10.reduce((a, b) => a + b.p1, 0) / 10).toFixed(1) + "%  ->  2ndH " +
  (top10.reduce((a, b) => a + b.p2, 0) / 10).toFixed(1) + "%");
console.log("  mean across ALL " + real.length + " configs:            1stH " +
  (real.reduce((a, b) => a + b.p1, 0) / real.length).toFixed(1) + "%  ->  2ndH " +
  (real.reduce((a, b) => a + b.p2, 0) / real.length).toFixed(1) + "%");
