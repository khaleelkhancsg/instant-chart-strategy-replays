// Optimise purely for the 2026 regime, then test the winner everywhere else.
//
// READ THIS BEFORE BELIEVING ANY NUMBER BELOW.
//
// 2026 contains 165 window start dates, but they are 30-day windows stepped one
// day at a time, so consecutive windows share ~29/30 of their trades. The
// EFFECTIVE sample is roughly 165/30 ~= 5.5 independent outcomes. Tuning a
// multi-parameter strategy against ~5 independent observations will fit noise
// almost perfectly, and the in-sample number it produces is close to meaningless.
//
// So the experiment is built to expose that rather than hide it:
//   1. Search the grid, ranked on 2026 pass rate.
//   2. Split 2026 in half — fit on H1, check H2. A config that cannot survive
//      the second half of its OWN year is pure noise-fitting.
//   3. Test on 2019-2025 (2,433 windows) as true out-of-sample.
//
// Two families are searched separately, because they embody different theories:
//   FIXED sizing  — the incumbent. Constant contracts, so dollar risk floats
//                   with volatility.
//   RISK sizing   — constant dollar risk per trade, contracts derived from the
//                   stop distance. Motivated by the mechanical finding that a
//                   2026 stop costs 52% of the whole drawdown at 8 lots.

import { loadBars } from "../src/data.mjs";
import strat from "../strategies/trend_neutev.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { resolveExec } from "../src/engine.mjs";
import { replayWindow, resolveRules, OUTCOME } from "../src/challenge.mjs";

const { bars } = loadBars();
const DAY = 86400000;
const yearOf = (ms) => new Date(ms).getUTCFullYear();

// Window starts, one per day, grouped by era.
const allStarts = [];
for (let s = bars.ts[0]; s <= bars.ts[bars.count - 1] - 30 * DAY; s += DAY) allStarts.push(s);
const starts2026 = allStarts.filter((s) => yearOf(s) === 2026);
const startsOther = allStarts.filter((s) => yearOf(s) !== 2026);
const mid2026 = starts2026[Math.floor(starts2026.length / 2)];
const s26H1 = starts2026.filter((s) => s < mid2026);
const s26H2 = starts2026.filter((s) => s >= mid2026);

console.log(`windows: ${allStarts.length} total | 2026: ${starts2026.length} (H1 ${s26H1.length} / H2 ${s26H2.length}) | other years: ${startsOther.length}`);
console.log(`effective independent 30-day outcomes in 2026: ~${(starts2026.length / 30).toFixed(1)}\n`);

function passRate(trades, starts, rules) {
  let pass = 0, fail = 0;
  for (const s of starts) {
    const r = replayWindow(trades, s, rules);
    if (r.outcome === OUTCOME.PASS) pass++;
    else if (r.outcome === OUTCOME.FAIL) fail++;
  }
  return { pass: (pass / starts.length) * 100, fail: (fail / starts.length) * 100 };
}

// ───────────────────────── the grid ─────────────────────────
const SIGNAL = [];
for (const timeframeMin of [3, 5, 15])
  for (const donchian of [20, 30, 50])
    for (const adxMin of [20, 25, 32])
      SIGNAL.push({ timeframeMin, donchian, adxMin, adxPeriod: 14, cooldownBars: 1, atrPeriod: 14 });

const EXECS = [];
for (const slAtrMult of [1, 2, 3])
  for (const tpAtrMult of [4, 8, 12, 18]) {
    for (const contracts of [2, 3, 5, 8, 10])
      EXECS.push({ sizingMode: "fixed", contracts, slAtrMult, tpAtrMult });
    for (const riskDollars of [150, 250, 400, 600])
      EXECS.push({ sizingMode: "risk", riskDollars, maxContracts: 10, slAtrMult, tpAtrMult });
  }

const BREAKERS = [0, 150, 400];

console.log(`grid: ${SIGNAL.length} signals x ${EXECS.length} execs x ${BREAKERS.length} breakers = ${(SIGNAL.length * EXECS.length * BREAKERS.length).toLocaleString()} configs\n`);

// ───────────────────────── search ─────────────────────────
const results = [];
let done = 0;
const t0 = Date.now();

for (const sig of SIGNAL) {
  const params = resolveParams(strat, sig);
  for (const ex of EXECS) {
    const exec = resolveExec(ex);
    // The full-history backtest depends only on signal+exec, not on the rules,
    // so run it once and replay every breaker variant against the same trades.
    const run = runStrategy(bars, strat, params, exec);
    if (run.trades.length < 200) { done += BREAKERS.length; continue; }

    for (const cb of BREAKERS) {
      const rules = resolveRules({ circuitBreaker: cb });
      const in26 = passRate(run.trades, starts2026, rules);
      done++;
      results.push({
        sig, ex, cb,
        pass26: in26.pass, fail26: in26.fail,
        trades: run.trades.length,
        pf: run.stats.profitFactor,
        exp: run.stats.expectancy,
      });
    }
  }
  process.stdout.write(`\r  ${done.toLocaleString()} configs  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
console.log(`\n  done in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

results.sort((a, b) => b.pass26 - a.pass26);

const desc = (r) =>
  `tf${r.sig.timeframeMin} don${r.sig.donchian} adx${r.sig.adxMin} | ` +
  (r.ex.sizingMode === "risk" ? `risk$${r.ex.riskDollars}` : `${r.ex.contracts}lot`) +
  ` sl${r.ex.slAtrMult} tp${r.ex.tpAtrMult} | cb${r.cb}`;

console.log("TOP 15 BY 2026 PASS RATE (in-sample — expect these to be inflated)\n");
console.log("  2026 pass  fail   config");
for (const r of results.slice(0, 15)) {
  console.log(`  ${r.pass26.toFixed(1).padStart(8)}%  ${r.fail26.toFixed(1).padStart(4)}%  ${desc(r)}`);
}

// ───────────── validate the top candidates properly ─────────────
console.log("\n\nVALIDATION — H1/H2 split within 2026, then true out-of-sample\n");
console.log("  cfg                                          fit(H1)  test(H2)   2019-2025   verdict");
const validated = [];
for (const r of results.slice(0, 12)) {
  const params = resolveParams(strat, r.sig);
  const exec = resolveExec(r.ex);
  const rules = resolveRules({ circuitBreaker: r.cb });
  const run = runStrategy(bars, strat, params, exec);
  const h1 = passRate(run.trades, s26H1, rules);
  const h2 = passRate(run.trades, s26H2, rules);
  const oos = passRate(run.trades, startsOther, rules);
  const holds = h2.pass >= h1.pass - 15;
  validated.push({ r, h1: h1.pass, h2: h2.pass, oos: oos.pass, oosFail: oos.fail, holds });
  console.log(
    `  ${desc(r).padEnd(44)} ${h1.pass.toFixed(1).padStart(6)}%  ${h2.pass.toFixed(1).padStart(7)}%  ` +
    `${oos.pass.toFixed(1).padStart(9)}%   ${holds ? "holds in H2" : "COLLAPSES in H2"}`
  );
}

// ───────────── the incumbent, for reference ─────────────
const baseRun = runStrategy(bars, strat, resolveParams(strat, {}), resolveExec({}));
const baseRules = resolveRules({});
const b26 = passRate(baseRun.trades, starts2026, baseRules);
const bOther = passRate(baseRun.trades, startsOther, baseRules);
console.log(`\n  ${"INCUMBENT tf5 don30 adx25 | 8lot sl2 tp12 | cb150".padEnd(44)} ${"".padStart(6)}   ${b26.pass.toFixed(1).padStart(7)}%  ${bOther.pass.toFixed(1).padStart(9)}%   (2026 / other)`);

// ───────────── best OOS performer among the 2026 winners ─────────────
const bestOos = validated.slice().sort((a, b) => b.oos - a.oos)[0];
console.log(`\n\nBest OUT-OF-SAMPLE among the 2026-optimised candidates:`);
console.log(`  ${desc(bestOos.r)}`);
console.log(`  2026 ${bestOos.r.pass26.toFixed(1)}%  |  2019-2025 ${bestOos.oos.toFixed(1)}% pass / ${bestOos.oosFail.toFixed(1)}% breach`);
console.log(`  full-history PF ${bestOos.r.pf.toFixed(3)}, expectancy $${bestOos.r.exp.toFixed(2)}/trade, ${bestOos.r.trades} trades`);

// Year-by-year for that config.
const bp = resolveParams(strat, bestOos.r.sig);
const be = resolveExec(bestOos.r.ex);
const br = resolveRules({ circuitBreaker: bestOos.r.cb });
const bRun = runStrategy(bars, strat, bp, be);
console.log("\n  year-by-year:");
for (const y of [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
  const ys = allStarts.filter((s) => yearOf(s) === y);
  if (!ys.length) continue;
  const p = passRate(bRun.trades, ys, br);
  const bl = passRate(baseRun.trades, ys, baseRules);
  console.log(`    ${y}  ${p.pass.toFixed(1).padStart(5)}% pass   (incumbent ${bl.pass.toFixed(1).padStart(5)}%)   ${p.pass > bl.pass ? "better" : "worse"}`);
}
