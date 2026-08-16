// Round 5 -- is the 1-minute data hiding the edge?
//
// He trades off ~5-second bars: push, retrace, second push can all happen inside
// one of my minutes. My detector requires each leg on a strictly later bar,
// because 1-minute OHLC cannot say whether the high or the low came first. That
// is conservative, and conservative could in principle be hiding a real edge.
//
// So: drop the guard and let the pattern complete inside a single bar, resolving
// every intrabar ambiguity in the strategy's favour. That is not a realistic
// backtest -- it is an OPTIMISTIC BOUND. If the bound does not clear the noise
// floor either, the 1-minute limitation is not the reason this does not work.
//
// Usage:  node research/orb_resolution.mjs

import { run, HDR, row, setups } from "./lib_orb.mjs";

console.log("\n" + "=".repeat(124));
console.log("ROUND 5 -- OPTIMISTIC BOUND: let the whole pattern complete inside one bar");
console.log("=".repeat(124));
console.log("  (noise floor for reference: the best of 1,920 configs on a COIN FLIP scored 29.4% on its worse half)");

const cfgs = [
  ["his config (OR5, 2R, stop at level)", { refWin: "OR5", stopAt: "level", rMult: 2.0, maxHoldMin: 120 }],
  ["OR5, 2R, 0.5x range stop", { refWin: "OR5", stopAt: "range", stopK: 0.5, rMult: 2.0, maxHoldMin: 120 }],
  ["sweep best shape (PRE60, 3R, eod)", { refWin: "PRE60", stopAt: "opposite", rMult: 3.0, maxHoldMin: 1000 }],
];

for (const [lbl, c] of cfgs) {
  const base = { mode: "confirmed", retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500, ...c };
  console.log("\n-- " + lbl + " --");
  console.log(HDR);
  row("strict (1-min causal)", run(base));
  row("optimistic (same-bar legs)", run({ ...base, sameBar: true }));
  row("optimistic, dir shuffled", run({ ...base, sameBar: true, flipSeed: 99 }));
  const a = setups(base).diag, b = setups({ ...base, sameBar: true }).diag;
  console.log("  entries: strict " + a.entered + "  ->  optimistic " + b.entered +
              "  (+" + (100 * (b.entered - a.entered) / a.entered).toFixed(0) + "%)");
}
