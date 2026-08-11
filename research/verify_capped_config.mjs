// Double-check the headline for the shipped capped configuration, and test the
// claim that high ATR is not a reason to stand down.
//
// Two things needed checking. Every tuning number in the last few commits came
// from fastSweep, the approximation used for large searches; the headline should
// be confirmed against the real challenge.mjs engine. And the argument for
// "high ATR is fine" rested on the per-trade edge GAP being constant across
// volatility, which is not the same claim as the pass rate being constant. Pass
// rate depends on dollars per day and on path, so it has to be measured per
// regime rather than inferred.
//
// Usage:  node research/verify_capped_config.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules, sweepWindows, replayWindow, OUTCOME } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts, assertParity, DAY } from "./lib_search.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

// ── the shipped configuration ────────────────────────────────────────
const CFG = { contracts: 8, slAtrMult: 5.0, tpAtrMult: 1.75, dayLossStopUsd: 1000, slippageTicks: 1 };
const RULES = { circuitBreaker: 500, dailyProfitStop: 750 };

const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const S = (await loadStrategies()).get("donchian_eff_rth");
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(tf.close.length);
for (let i = 30; i < raw.length; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1;
  else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const exec = resolveExec({ ...S.execDefaults, ...CFG });
const { trades } = runBrackets(tf, sig, A, exec);
const rules = resolveRules(RULES);
const T = flatten(trades);
const st = tradeStats(trades);

// ── 1. is fastSweep telling the truth? ───────────────────────────────
const allStarts = windowStarts(bars, 30, 1);
console.log("\n1. fastSweep vs the real challenge.mjs engine");
try {
  assertParity(trades, allStarts, rules, 1);
  console.log("   assertParity: OK");
} catch (e) {
  console.log("   assertParity FAILED: " + e.message);
}
let agree = 0, disagree = 0;
for (const s of allStarts) {
  const a = replayWindow(trades, s, rules).outcome === OUTCOME.PASS;
  const b = fastSweep(T, [s], rules, 1).pass > 0;
  if (a === b) agree++; else disagree++;
}
const realAll = sweepWindows(trades, bars.ts[0], bars.ts[bars.count - 1], rules, 1);
const fastAll = fastSweep(T, allStarts, rules, 1).pass;
console.log(`   window-by-window agreement: ${agree}/${agree + disagree} (${disagree} differ)`);
console.log(`   real engine ${realAll.summary.passRate.toFixed(2)}%   fastSweep ${fastAll.toFixed(2)}%\n`);

// ── 2. regime slices, real engine ────────────────────────────────────
const dayAtr = new Map();
for (let i = 900; i < A.length; i++) {
  const c = tf.ctMin[i];
  if (c < 510 || c >= 900 || !(A[i] > 0)) continue;
  const d = Math.floor(tf.ts[i] / DAY);
  if (!dayAtr.has(d)) dayAtr.set(d, []);
  dayAtr.get(d).push(A[i]);
}
const med = (v) => { v.sort((a, b) => a - b); return v[v.length >> 1]; };
const perDay = new Map([...dayAtr].map(([d, v]) => [d, med(v)]));
const winAtr = new Map();
for (const s of allStarts) {
  const d0 = Math.floor(s / DAY), v = [];
  for (let d = d0; d < d0 + 30; d++) if (perDay.has(d)) v.push(perDay.get(d));
  if (v.length >= 15) winAtr.set(s, med(v));
}
const withAtr = allStarts.filter((s) => winAtr.has(s));
const realPass = (set) => {
  let p = 0;
  for (const s of set) if (replayWindow(trades, s, rules).outcome === OUTCOME.PASS) p++;
  return set.length ? (100 * p) / set.length : 0;
};

// ── 3. THE ACTUAL QUESTION: pass rate by volatility decile ───────────
console.log("2. PASS RATE BY VOLATILITY DECILE (real engine, every window)");
console.log("   The claim under test: high ATR is not a reason to stand down.\n");
const sorted = withAtr.slice().sort((a, b) => winAtr.get(a) - winAtr.get(b));
const n = sorted.length, K = 10;
console.log("   decile   ATR range      windows   PASS%    stop     reward   ratio");
const decile = [];
for (let k = 0; k < K; k++) {
  const set = sorted.slice(Math.floor((k * n) / K), Math.floor(((k + 1) * n) / K));
  const lo = winAtr.get(set[0]), hi = winAtr.get(set[set.length - 1]);
  const midAtr = winAtr.get(set[set.length >> 1]);
  const dpp = exec.pointValue * exec.contracts;
  const stopPts = Math.min(CFG.slAtrMult * midAtr, CFG.dayLossStopUsd / dpp);
  const tgtPts = CFG.tpAtrMult * midAtr;
  const pr = realPass(set);
  decile.push({ k, lo, hi, pr, midAtr });
  console.log(
    `   ${String(k + 1).padStart(6)}   ${lo.toFixed(1).padStart(4)}-${hi.toFixed(1).padEnd(5)}  ` +
    `${String(set.length).padStart(7)}   ${pr.toFixed(1).padStart(5)}%  ` +
    `$${(stopPts * dpp).toFixed(0).padStart(6)}  $${(tgtPts * dpp).toFixed(0).padStart(6)}   ${(stopPts / tgtPts).toFixed(2)}:1`
  );
}
const lowHalf = decile.slice(0, 5).reduce((a, d) => a + d.pr, 0) / 5;
const highHalf = decile.slice(5).reduce((a, d) => a + d.pr, 0) / 5;
console.log(`\n   bottom five deciles ${lowHalf.toFixed(1)}%   top five ${highHalf.toFixed(1)}%   ` +
            `difference ${(highHalf - lowHalf >= 0 ? "+" : "")}${(highHalf - lowHalf).toFixed(1)}pp`);
console.log(`   ${highHalf > lowHalf
  ? "Higher volatility scores BETTER. The stand-down advice would have been wrong."
  : "Higher volatility scores WORSE. The stand-down advice was right and must go back."}\n`);

// ── 4. headline restated on the real engine ──────────────────────────
const cut = withAtr.map((s) => winAtr.get(s)).sort((a, b) => a - b)[Math.floor(withAtr.length * 0.7)];
const hi70 = withAtr.filter((s) => winAtr.get(s) > cut);
const mid = hi70[Math.floor(hi70.length / 2)];
console.log("3. HEADLINE, real engine, shipped config");
console.log(`   8 lots, ${CFG.slAtrMult}xATR/${CFG.tpAtrMult}xATR, cap -$${CFG.dayLossStopUsd}, breaker -$${RULES.circuitBreaker}, block $${RULES.dailyProfitStop}, ${CFG.slippageTicks} tick\n`);
console.log(`   high-vol (ATR>${cut.toFixed(1)}), ${hi70.length} windows   ${realPass(hi70).toFixed(1)}%`);
console.log(`     early half                        ${realPass(hi70.filter((s) => s < mid)).toFixed(1)}%`);
console.log(`     late half  (2024-09 -> 2026-06)   ${realPass(hi70.filter((s) => s >= mid)).toFixed(1)}%`);
console.log(`   2026 only, ${withAtr.filter((s) => new Date(s).getUTCFullYear() === 2026).length} windows (~6 independent)  ${realPass(withAtr.filter((s) => new Date(s).getUTCFullYear() === 2026)).toFixed(1)}%`);
console.log(`   all ${withAtr.length} windows                    ${realPass(withAtr).toFixed(1)}%`);
console.log(`\n   trades ${st.n.toLocaleString()}  win ${st.winRate.toFixed(1)}%  pf ${st.profitFactor.toFixed(3)}  net $${Math.round(st.pnl).toLocaleString()}`);
console.log(`   worst loss $${Math.round(st.maxLoss).toLocaleString()}   median days to pass ${realAll.summary.medianDaysToPass}`);
