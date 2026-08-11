// Monte Carlo for donchian_eff_rth — WITHOUT replaying the historical book.
//
// Reports. The model itself lives in monte_carlo_lib.mjs; read that first for
// what is simulated and where every input comes from.
//
// Usage:  node research/monte_carlo.mjs [runs]

import { runConfig, P, RULES, RANGE_FACTOR } from "./monte_carlo_lib.mjs";

const RUNS = Number(process.argv[2]) || 10_000;

// ═════════════════════════════════════════════════════════════════════
console.log(`\nMONTE CARLO — ${RUNS.toLocaleString()} simulated 30-day windows per configuration`);
console.log(`No historical trades are used. Prices are simulated; rules are the real engine.\n`);

// ── analytic predictions, before any simulation ──────────────────────
// For a driftless random walk with barriers at -a and +b, optional stopping gives
// P(hit +b first) = a/(a+b) and E[time] = a*b/sigma^2. Both are exact.
const aNull = P.slAtr, bNull = P.tpAtr;
const pWinTheory = aNull / (aNull + bNull);
const holdBars = (aNull * bNull) / (1 / RANGE_FACTOR) ** 2;
console.log("ANALYTIC NULL (no simulation, no data — just the geometry)");
console.log(`  A ${P.slAtr}xATR stop against a ${P.tpAtr}xATR target on a COIN FLIP wins`);
console.log(`    P(win) = ${P.slAtr}/(${P.slAtr}+${P.tpAtr}) = ${(100 * pWinTheory).toFixed(1)}%          measured book: 75.8%`);
console.log(`    E[hold] = ${holdBars.toFixed(1)} bars = ${(holdBars * P.barMin).toFixed(0)} min       measured book: 43 min`);
console.log(`  Both land on the measured values. The win rate and the hold time of this`);
console.log(`  strategy are what the BRACKET dictates, and carry no information about edge.\n`);

// ── 1. the null ──────────────────────────────────────────────────────
console.log("─".repeat(70));
console.log("1. THE NULL — zero edge, everything else exactly as shipped");
const nul = runConfig({}, RUNS);
console.log(`  win rate        ${nul.winRate.toFixed(1)}%   (theory ${(100 * pWinTheory).toFixed(1)}%)`);
console.log(`  mean hold       ${nul.meanHold.toFixed(0)} min`);
console.log(`  gross/trade     $${nul.grossPerTrade.toFixed(2)}   (must be ~$0 — it is the null)`);
console.log(`  net/trade       $${nul.netPerTrade.toFixed(2)}   (= -commission)`);
console.log(`  PASS RATE       ${nul.passRate.toFixed(2)}% +/- ${(1.96 * nul.se).toFixed(2)}   ` +
            `(${nul.pass.toLocaleString()} of ${RUNS.toLocaleString()})`);
console.log(`  fail ${((100 * nul.fail) / RUNS).toFixed(1)}%   still open at 30 days ${((100 * nul.open) / RUNS).toFixed(1)}%`);
console.log(`  median final    $${nul.medianFinal.toFixed(0)}\n`);

// ── 2. how much edge is needed ───────────────────────────────────────
console.log("─".repeat(70));
console.log("2. EDGE SWEEP — drift in the trade's direction, as a fraction of ATR per bar");
console.log("   backtested book: gross $32.15/trade (net $17.15 + $15 commission)\n");
console.log("   drift/bar   gross$/trade   net$/trade   win%    PASS%");
const sweep = [];
for (const drift of [0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.04, 0.06, 0.08]) {
  const r = runConfig({ driftPerBarAtr: drift }, RUNS);
  sweep.push(r);
  console.log(`   ${drift.toFixed(3).padStart(9)}   ${("$" + r.grossPerTrade.toFixed(2)).padStart(12)}   ` +
              `${("$" + r.netPerTrade.toFixed(2)).padStart(10)}   ${r.winRate.toFixed(1).padStart(4)}   ` +
              `${(r.passRate.toFixed(2) + "%").padStart(7)}`);
}

// Interpolate the drift that reproduces the backtested gross expectancy.
const TARGET_GROSS = 32.15;
let lo = sweep[0], hi = sweep[sweep.length - 1];
for (let i = 0; i < sweep.length - 1; i++) {
  if (sweep[i].grossPerTrade <= TARGET_GROSS && sweep[i + 1].grossPerTrade >= TARGET_GROSS) {
    lo = sweep[i]; hi = sweep[i + 1]; break;
  }
}
const f = (TARGET_GROSS - lo.grossPerTrade) / Math.max(1e-9, hi.grossPerTrade - lo.grossPerTrade);
const impliedDrift = lo.p.driftPerBarAtr + f * (hi.p.driftPerBarAtr - lo.p.driftPerBarAtr);
const atBacktest = runConfig({ driftPerBarAtr: impliedDrift }, RUNS);
console.log(`\n   The backtested edge corresponds to a drift of ${impliedDrift.toFixed(4)} ATR/bar.`);
console.log(`   At that drift: gross $${atBacktest.grossPerTrade.toFixed(2)}/trade, ` +
            `PASS ${atBacktest.passRate.toFixed(2)}% +/- ${(1.96 * atBacktest.se).toFixed(2)}`);
console.log(`   Backtest over real windows: 42.6%\n`);

// ── 3. sensitivity ───────────────────────────────────────────────────
console.log("─".repeat(70));
console.log("3. SENSITIVITY at the backtest-implied edge\n");

console.log("   ATR (volatility regime) — the dollar size of every trade scales with it");
console.log("     ATR pts   context                 PASS%");
for (const [a, label] of [[5.84, "p10 / 2019-quiet"], [9.12, "p25"], [13.56, "median"],
                          [19.99, "p75"], [23.70, "2026 median"], [28.61, "p90"]]) {
  const r = runConfig({ atrPoints: a, driftPerBarAtr: impliedDrift }, RUNS);
  console.log(`     ${a.toFixed(2).padStart(7)}   ${label.padEnd(22)}  ${(r.passRate.toFixed(2) + "%").padStart(7)}`);
}

console.log("\n   TRADES PER DAY — the one backtest-derived input, swept");
console.log("     per day   PASS%");
for (const tpd of [1.0, 1.5, 2.03, 3.0, 4.0, 6.0]) {
  const r = runConfig({ tradesPerDay: tpd, driftPerBarAtr: impliedDrift }, RUNS);
  console.log(`     ${tpd.toFixed(2).padStart(7)}   ${(r.passRate.toFixed(2) + "%").padStart(7)}`);
}

console.log("\n   SLIPPAGE (ticks per side)");
console.log("     ticks   $/trade   PASS%");
for (const s of [0, 1, 2, 3]) {
  const r = runConfig({ slippageTicks: s, driftPerBarAtr: impliedDrift }, RUNS);
  console.log(`     ${String(s).padStart(5)}   ${("$" + (s * 10).toFixed(0)).padStart(7)}   ${(r.passRate.toFixed(2) + "%").padStart(7)}`);
}

console.log("\n   CONTRACTS");
console.log("     lots   PASS%");
for (const c of [4, 6, 8, 10]) {
  const r = runConfig({ contracts: c, driftPerBarAtr: impliedDrift }, RUNS);
  console.log(`     ${String(c).padStart(4)}   ${(r.passRate.toFixed(2) + "%").padStart(7)}`);
}

// ── 4. the rules themselves ──────────────────────────────────────────
console.log("\n" + "─".repeat(70));
console.log("4. WHAT THE DAILY RULES ARE WORTH, at zero edge and at the implied edge\n");
console.log("   configuration                     null PASS%   edge PASS%");
for (const [label, over] of [
  ["as shipped (+$1000 / -$150)", {}],
  ["no soft profit block", { _rules: { dailyProfitStop: 0 } }],
  ["no circuit breaker", { _rules: { circuitBreaker: 0 } }],
  ["neither", { _rules: { dailyProfitStop: 0, circuitBreaker: 0 } }],
]) {
  const saved = { ...RULES };
  Object.assign(RULES, over._rules || {});
  const a = runConfig({}, RUNS);
  const b = runConfig({ driftPerBarAtr: impliedDrift }, RUNS);
  Object.assign(RULES, saved);
  console.log(`   ${label.padEnd(32)}  ${(a.passRate.toFixed(2) + "%").padStart(9)}   ${(b.passRate.toFixed(2) + "%").padStart(9)}`);
}

// ── 5. stochastic volatility ─────────────────────────────────────────
// Everything above holds ATR fixed, which is the model's biggest lie: it means
// every trade is the same size in dollars, so no day can run away. That matters
// because the backtest found the soft profit block worth 26.7% -> 41.0%, and at
// fixed ATR (section 4) it is worth almost nothing. If varying volatility
// restores its value, the block's real job is capping the outsized day that a
// high-volatility session produces.
console.log("\n" + "─".repeat(70));
console.log("5. STOCHASTIC VOLATILITY — AR(1) daily ATR, empirical p1..p99 marginal\n");
const sto = { atrMode: "stochastic", driftPerBarAtr: impliedDrift };
const stoNull = runConfig({ atrMode: "stochastic" }, RUNS);
const stoEdge = runConfig(sto, RUNS);
console.log(`   null (zero edge)              PASS ${stoNull.passRate.toFixed(2)}% +/- ${(1.96 * stoNull.se).toFixed(2)}   (fixed ATR: ${nul.passRate.toFixed(2)}%)`);
console.log(`   at the backtest-implied edge  PASS ${stoEdge.passRate.toFixed(2)}% +/- ${(1.96 * stoEdge.se).toFixed(2)}   (fixed ATR: ${atBacktest.passRate.toFixed(2)}%)`);
console.log(`   backtest over real windows    42.6%\n`);

console.log("   Do the daily rules matter once volatility varies?");
console.log("   configuration                     null PASS%   edge PASS%");
for (const [label, over] of [
  ["as shipped (+$1000 / -$150)", {}],
  ["no soft profit block", { dailyProfitStop: 0 }],
  ["soft block at $1500", { dailyProfitStop: 1500 }],
  ["no circuit breaker", { circuitBreaker: 0 }],
  ["neither", { dailyProfitStop: 0, circuitBreaker: 0 }],
  ["no consistency rule", { consistencyGatesPass: false }],
]) {
  const saved = { ...RULES };
  Object.assign(RULES, over);
  const a = runConfig({ atrMode: "stochastic" }, RUNS);
  const b = runConfig(sto, RUNS);
  Object.assign(RULES, saved);
  console.log(`   ${label.padEnd(32)}  ${(a.passRate.toFixed(2) + "%").padStart(9)}   ${(b.passRate.toFixed(2) + "%").padStart(9)}`);
}

// ── 6. outcome distribution ──────────────────────────────────────────
console.log("\n" + "─".repeat(70));
console.log("6. DISTRIBUTION OF THE 10,000 OUTCOMES (stochastic vol, implied edge)\n");
const D = stoEdge;
console.log(`   pass ${((100 * D.pass) / RUNS).toFixed(1)}%   fail ${((100 * D.fail) / RUNS).toFixed(1)}%   ` +
            `unresolved at 30 days ${((100 * D.open) / RUNS).toFixed(1)}%`);
console.log(`   median days to pass  ${D.medianDaysToPass}`);
console.log(`   final account P&L    p5 $${D.p05.toFixed(0)}   p25 $${D.p25.toFixed(0)}   ` +
            `median $${D.medianFinal.toFixed(0)}   p75 $${D.p75.toFixed(0)}   p95 $${D.p95.toFixed(0)}`);
console.log(`   realised trades/day  ${D.tradesPerDay.toFixed(2)}   win rate ${D.winRate.toFixed(1)}%   ` +
            `mean hold ${D.meanHold.toFixed(0)} min`);
console.log(`\n   Attempts needed for a first pass at ${D.passRate.toFixed(1)}%:`);
const q = D.passRate / 100;
for (const n of [1, 2, 3, 5]) {
  console.log(`     ${n} attempt${n > 1 ? "s" : " "}   ${(100 * (1 - (1 - q) ** n)).toFixed(1)}% chance of at least one pass`);
}
console.log();
