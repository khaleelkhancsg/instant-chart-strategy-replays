// Can the pass rate be recovered with a hard -$1000 unrealised stop in force?
//
// The cap converts the stop into a FIXED DOLLAR amount, so the effective stop is
// min(slAtrMult*ATR, 1000/(pv*q)) points. At the shipped 10 lots that is 50
// points, i.e. 3.69xATR at the median ATR of 13.56 rather than the configured
// 5xATR — a different bracket, and the win rate follows S/(S+T) straight down
// from 75.7% to 71.3%. Pass rate falls 41.0% -> 29.7%.
//
// Three candidate levers, in the order they suggest themselves:
//
//   1. FEWER CONTRACTS. The cap is worth more POINTS at a smaller size, so below
//      q = 1000/(2*5*ATR) ~ 7 lots it stops binding entirely and the native
//      geometry survives. Measured: it does not help. Throughput loss dominates
//      the geometry gain at every size, monotonically.
//
//   2. A TIGHTER TARGET, to restore the ~3.33:1 stop:target ratio the 77% win
//      rate depends on. Measured: much worse, and instructively so. At
//      tpAtrMult 0.6 the win rate reaches 86.6% and the profit factor is 0.812,
//      because the wins shrink toward the commission while the losses do not.
//      This is the clearest demonstration in the project that win rate is not
//      the objective.
//
//   3. A WIDER slAtrMult. Non-obvious but it is the one that works: with the cap
//      in force the stop is already pinned at 50 points on high-ATR days, but on
//      LOW-ATR days the raw 5xATR stop still binds well inside the cap. Widening
//      it makes the stop sit AT the cap on every day, which is the most geometry
//      recoverable while the cap exists. Paired with a wider target it lifts
//      29.7% -> ~34%.
//
// ── THE TRAP, recorded because it nearly got reported as a result ──
// The coarse grid showed a clean best of 37.0% at 9 lots / 7xATR / 2.5xATR, with
// tpAtrMult 2.5 a local maximum in EVERY row. It is an artifact. Sweeping tp
// finely, in-sample RISES monotonically (33.5 -> 39.7) while out-of-sample FALLS
// (31.8 -> 28.3); ranking on the worse of the two therefore peaks exactly where
// the two curves cross, and 2.5 is that crossing. Neighbours at 2.4 and 2.6 are
// 3-4pp lower. Always sweep an optimum finely and look at IS and OOS separately
// before believing a peak.
//
// The defensible point is tpAtrMult ~2.1, where in-sample and out-of-sample
// AGREE (34.7 / 34.0) rather than merely intersect.
//
// Usage:  node research/hard_stop_recovery.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts } from "./lib_search.mjs";

const CAP = 1000;

const { bars } = loadBars();
const S = (await loadStrategies()).get("donchian_eff_rth");
const tf = resample(bars, S.timeframeMin);
const out = S.compute(tf, resolveParams(S, {}));
const masked = applyFilters(out.sig, buildFilterContext(tf), { ...NO_FILTER, ...S.filterDefaults });
const all = windowStarts(bars, 30, 1);
const SPLIT = Date.UTC(2023, 5, 1);
const IS = all.filter((t) => t < SPLIT), OOS = all.filter((t) => t >= SPLIT);
const rules = resolveRules({ ...S.rulesDefaults });

function run(exec) {
  const x = resolveExec({ ...S.execDefaults, ...exec, slippageTicks: 1 });
  const { trades } = runBrackets(tf, masked, out.atr, x);
  const T = flatten(trades);
  const is = fastSweep(T, IS, rules, 1).pass, oos = fastSweep(T, OOS, rules, 1).pass;
  const st = tradeStats(trades);
  return { is, oos, w: Math.min(is, oos), st };
}

const row = (label, r) => console.log(
  `  ${label.padEnd(34)} ${r.is.toFixed(1).padStart(5)}%  ${r.oos.toFixed(1).padStart(5)}%  ` +
  `${r.w.toFixed(1).padStart(5)}%  ${r.st.winRate.toFixed(1).padStart(5)}  ` +
  `${r.st.profitFactor.toFixed(3)}  ${("$" + Math.round(r.st.pnl).toLocaleString()).padStart(9)}`);

console.log(`\n  All rows at 1 tick of slippage. 'worst' = worse of IS / OOS.\n`);
console.log("  configuration                        IS     OOS    worst   win%    pf      net$");
row("uncapped, shipped 10 lots 5/1.5", run({}));
row(`cap -$${CAP}, shipped geometry`, run({ dayLossStopUsd: CAP }));

console.log(`\n  LEVER 1 — fewer contracts (cap stops binding below ~7 lots)`);
for (const q of [4, 6, 7, 8, 9, 10]) {
  row(`  ${q} lots, 5/1.5, cap on`, run({ contracts: q, dayLossStopUsd: CAP }));
}

console.log(`\n  LEVER 2 — tighter target to restore the ratio (note the win rate)`);
for (const tp of [0.6, 1.0, 1.5]) {
  row(`  10 lots, 5/${tp}, cap on`, run({ tpAtrMult: tp, dayLossStopUsd: CAP }));
}

console.log(`\n  LEVER 3 — widen the stop so it sits AT the cap on low-ATR days too`);
for (const sl of [5, 7, 10]) {
  row(`  9 lots, ${sl}/2.1, cap on`, run({ contracts: 9, slAtrMult: sl, tpAtrMult: 2.1, dayLossStopUsd: CAP }));
}

console.log(`\n  THE ARTIFACT — sweep tp finely and watch IS and OOS diverge`);
console.log("   tpAtr     IS      OOS    worst    pf      net$      note");
for (let tp = 2.0; tp <= 3.001; tp += 0.1) {
  const r = run({ contracts: 9, slAtrMult: 7, tpAtrMult: +tp.toFixed(2), dayLossStopUsd: CAP });
  const note = Math.abs(tp - 2.5) < 1e-6 ? "  <- coarse-grid 'best': just where IS and OOS cross"
             : Math.abs(tp - 2.1) < 1e-6 ? "  <- IS and OOS agree; the defensible point" : "";
  console.log(`   ${tp.toFixed(2).padStart(5)}  ${r.is.toFixed(1).padStart(5)}%  ${r.oos.toFixed(1).padStart(5)}%  ` +
              `${r.w.toFixed(1).padStart(5)}%  ${r.st.profitFactor.toFixed(3)}  ` +
              `${("$" + Math.round(r.st.pnl).toLocaleString()).padStart(9)}${note}`);
}

console.log(`\n  VERDICT`);
const base = run({});
const capped = run({ dayLossStopUsd: CAP });
const best = run({ contracts: 9, slAtrMult: 7, tpAtrMult: 2.1, dayLossStopUsd: CAP });
console.log(`    uncapped                     ${base.w.toFixed(1)}%  pf ${base.st.profitFactor.toFixed(3)}  $${Math.round(base.st.pnl).toLocaleString()}`);
console.log(`    cap on, shipped geometry     ${capped.w.toFixed(1)}%  pf ${capped.st.profitFactor.toFixed(3)}  $${Math.round(capped.st.pnl).toLocaleString()}`);
console.log(`    cap on, re-tuned             ${best.w.toFixed(1)}%  pf ${best.st.profitFactor.toFixed(3)}  $${Math.round(best.st.pnl).toLocaleString()}`);
console.log(`\n    Re-tuning recovers ${(best.w - capped.w).toFixed(1)}pp of the ${(base.w - capped.w).toFixed(1)}pp the cap costs — about half.`);
console.log(`    It does NOT get back to ${base.w.toFixed(1)}%. But it is ${(best.st.pnl / base.st.pnl).toFixed(1)}x more profitable than`);
console.log(`    the uncapped book, which is the trade this whole project keeps making:`);
console.log(`    pass rate and profitability pull in opposite directions.\n`);
