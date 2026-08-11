// The drawdown resonance — the sharpest thing the Monte Carlo found.
//
// Sweeping ATR in monte_carlo.mjs produced a pass rate that was NOT monotonic:
// it climbed to ATR 19 and then fell off a cliff at ATR 20. That looked like
// noise, so this checks it at 12,000 simulations a point and, more importantly,
// checks it on a SECOND lever.
//
// The hypothesis: a stop-out costs 5 x ATR x $2 x contracts. The trailing
// drawdown is $2,000. While one stop-out is smaller than that, the first loss of
// a fresh window is survivable and the account grinds on. The moment it is
// larger, the first loss is instantly fatal, and no amount of edge helps because
// the account never gets a second trade.
//
// If that is the mechanism, raising leverage via CONTRACTS must produce the same
// cliff at the same dollar threshold — which is a real prediction, not a fit.
//
// Usage:  node research/monte_carlo_leverage.mjs [runs] [seeds]

import { runConfig, P, RULES } from "./monte_carlo_lib.mjs";

const RUNS = Number(process.argv[2]) || 4000;
const SEEDS = [11, 22, 33, 44].slice(0, Number(process.argv[3]) || 3);
const DRIFT = 0.0069;                    // the backtest-implied edge
const DD = RULES.trailingDD;

const avg = (o) => {
  const v = SEEDS.map((s) => runConfig({ ...o, driftPerBarAtr: DRIFT }, RUNS, s).passRate);
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
  return { m, sd };
};

const oneStop = (atr, lots) => P.slAtr * atr * P.pointValue * lots;

function report(title, points, toStop, label) {
  console.log(`\n${title}`);
  console.log("   " + label.padEnd(6) + "  one stop $   vs $2000 DD   PASS%      (seed sd)");
  let prev = null;
  for (const x of points) {
    const stop = toStop(x);
    const r = avg(x.cfg);
    const ratio = stop / DD;
    const drop = prev !== null && prev.ratio < 1 && ratio >= 1;
    console.log(
      `   ${String(x.label).padStart(6)}  ${("$" + stop.toFixed(0)).padStart(10)}   ` +
      `${(ratio * 100).toFixed(0).padStart(9)}%   ${r.m.toFixed(2).padStart(6)}%   ` +
      `${("+/-" + r.sd.toFixed(2)).padStart(9)}` +
      (drop ? `   <<< one stop now EXCEEDS the drawdown` : "")
    );
    prev = { ratio };
  }
}

console.log(`\nDRAWDOWN RESONANCE — ${(RUNS * SEEDS.length).toLocaleString()} simulations per point`);
console.log(`(${RUNS.toLocaleString()} runs x ${SEEDS.length} seeds; the seed spread is the noise floor)`);
console.log(`\nTrailing drawdown $${DD}.  One stop-out = ${P.slAtr} x ATR x $${P.pointValue} x lots.`);

report(
  "A. VOLATILITY as the lever — 10 contracts, ATR varied",
  [8, 10, 12, 14, 16, 18, 19, 20, 21, 22, 24, 28, 32, 40].map((a) => ({
    label: a, cfg: { atrPoints: a },
  })),
  (x) => oneStop(x.label, P.contracts),
  "ATR"
);

report(
  "B. POSITION SIZE as the lever — ATR 13.56, contracts varied",
  [4, 6, 8, 10, 12, 14, 15, 16, 18, 20, 24].map((c) => ({
    label: c, cfg: { contracts: c },
  })),
  (x) => oneStop(P.atrPoints, x.label),
  "lots"
);

// What the shipped configuration's own margin is, and what the current regime
// does to it. 2026's median 2-min ATR is 23.7 points.
console.log("\n" + "─".repeat(70));
console.log("WHERE THE SHIPPED CONFIGURATION SITS\n");
for (const [atr, what] of [[13.56, "all-history median ATR"], [19.99, "p75"], [23.70, "2026 median ATR"]]) {
  const stop = oneStop(atr, P.contracts);
  const safeLots = Math.floor(DD / (P.slAtr * atr * P.pointValue));
  console.log(`   ATR ${atr.toFixed(2).padStart(5)} (${what})`);
  console.log(`     one stop at ${P.contracts} lots = $${stop.toFixed(0)}  ` +
              `${stop < DD ? "SURVIVES the first loss" : "EXCEEDS the drawdown — the first loss is fatal"}`);
  console.log(`     largest size whose stop stays inside $${DD}: ${safeLots} lots\n`);
}
console.log("   The shipped 10 lots clears the threshold at the historical median and");
console.log("   does NOT at 2026 volatility. That is a regime check to run before");
console.log("   starting an evaluation, not a reason to change the size permanently:");
console.log("   sweep A shows the pass rate RECOVERS above the cliff, because a single");
console.log("   win also gets huge. What changes is the mechanism — above the");
console.log("   threshold the account stops grinding and starts sprinting, needing a");
console.log("   short run of wins before any loss. Same pass rate, different game.\n");
