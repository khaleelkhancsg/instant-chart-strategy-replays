// How much money is really in the "it was nearly at target, then reversed" trades?
//
// These are the most MEMORABLE losses in the book and therefore the ones most
// likely to be over-weighted. Before proposing any fix, measure the pool: how
// many trades reach a given fraction of the target and still lose, and what do
// they cost in aggregate. Anything a fix can recover is bounded by that number,
// and every fix has to be paid for out of the winners it also interferes with.
//
// Reported for the SHIPPED configuration: 8 lots as 2+6 scale-in, 5xATR stop,
// 1.75xATR target, -$1000 hard cap, 1 tick slippage per side.
//
// Usage:  node research/giveback_diag.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const CFG = {
  contracts: 8, slAtrMult: 5.0, tpAtrMult: 1.75,
  dayLossStopUsd: 1000, dayLossStopMode: "exact", slippageTicks: 1,
  scaleInFrac: 0.25, scaleInTrigger: 0.15, scaleInWindowBars: 10,
};

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
const { trades } = runBrackets(tf, sig, A, resolveExec({ ...S.execDefaults, ...CFG }));

const pv = 2;
// MFE as a fraction of the distance the trade actually had to travel to target.
// Both come off the SLIPPED average entry, so 1.0 means "touched the target".
for (const t of trades) {
  const dist = Math.abs(t.target - t.entryPrice);
  t.mfeFrac = dist > 0 ? (t.mfe / (pv * t.contracts)) / dist : 0;
}

const wins = trades.filter(t => t.pnl > 0);
const losses = trades.filter(t => t.pnl <= 0);
const sum = a => a.reduce((s, t) => s + t.pnl, 0);

console.log(`\n${trades.length} trades   net $${sum(trades).toFixed(0)}   ` +
            `win ${(100 * wins.length / trades.length).toFixed(1)}%`);
console.log(`  winners  ${String(wins.length).padStart(5)}  $${sum(wins).toFixed(0)}`);
console.log(`  losers   ${String(losses.length).padStart(5)}  $${sum(losses).toFixed(0)}`);

// ── 1. the give-back pool ────────────────────────────────────────────
console.log("\n1. LOSING trades by how far they got toward target first");
console.log("   peak reached      n     % of all    total cost    avg      recoverable*");
let cum = 0;
const bands = [[0, .25], [.25, .5], [.5, .6], [.6, .7], [.7, .8], [.8, .9], [.9, .999], [.999, 9]];
for (const [lo, hi] of bands) {
  const g = losses.filter(t => t.mfeFrac >= lo && t.mfeFrac < hi);
  if (!g.length) continue;
  // A fix that exits at the peak would have banked mfeFrac x target instead of
  // the loss, so the swing per trade is (peak value) - (the loss taken).
  const swing = g.reduce((s, t) => {
    const dist = Math.abs(t.target - t.entryPrice);
    return s + (t.mfeFrac * dist * pv * t.contracts - t.fees) - t.pnl;
  }, 0);
  cum += swing;
  console.log(`   ${(lo * 100).toFixed(0).padStart(3)}-${(hi > 1 ? 100 : hi * 100).toFixed(0).padStart(3)}%  ` +
    `${String(g.length).padStart(6)}  ${(100 * g.length / trades.length).toFixed(2).padStart(7)}%  ` +
    `$${sum(g).toFixed(0).padStart(10)}  $${(sum(g) / g.length).toFixed(0).padStart(6)}  ` +
    `$${swing.toFixed(0).padStart(11)}`);
}
console.log("   * = P&L swing if you had exited exactly at the peak: an unreachable");
console.log("     ceiling, not a forecast. Nothing can capture more than this.");

// ── 2. the other side of the ledger ──────────────────────────────────
// Any rule that exits early on a retrace must also fire on WINNERS that dipped
// and recovered. That population is what the fix costs, and it is the number
// people forget.
console.log("\n2. WINNERS that first dipped against you (what a stop-out would cost)");
console.log("   Of the winners, how many were underwater by X of the target distance");
console.log("   at some point, i.e. would a breakeven-ish stop have knocked them out?");
for (const frac of [0, .1, .2, .3, .5]) {
  const g = wins.filter(t => {
    const dist = Math.abs(t.target - t.entryPrice);
    return (-t.mae / (pv * t.contracts)) >= frac * dist;
  });
  console.log(`     dipped >= ${(frac * 100).toFixed(0).padStart(3)}% of target against:  ` +
    `${String(g.length).padStart(5)} winners worth $${sum(g).toFixed(0)}`);
}

// ── 3. the trades a breakeven stop would ACTUALLY touch ──────────────
// The population that matters is trades that BOTH reached the arming trigger
// AND later traded back through entry. Split them by how they ended: the ones
// that went on to win are the cost, the ones that lost are the saving.
console.log("\n3. If armed at peak >= T, then stopped at breakeven:");
console.log("   trigger   armed   of those, later went below entry:  saved      cost      net");
for (const T of [.25, .4, .5, .6, .7, .8]) {
  const armed = trades.filter(t => t.mfeFrac >= T);
  // "Later went below entry" is not directly observable from MAE alone, because
  // MAE may have happened BEFORE the peak. This over-counts and is corrected by
  // the full replay in giveback_test.mjs; here it only bounds the population.
  const touched = armed.filter(t => t.mae < 0);
  const savedT = touched.filter(t => t.pnl < 0);
  const costT = touched.filter(t => t.pnl > 0);
  console.log(`   ${(T * 100).toFixed(0).padStart(5)}%  ${String(armed.length).padStart(6)}  ` +
    `${String(touched.length).padStart(30)}  ` +
    `$${(-sum(savedT)).toFixed(0).padStart(8)}  $${sum(costT).toFixed(0).padStart(8)}  ` +
    `$${(-sum(savedT) - sum(costT)).toFixed(0).padStart(8)}`);
}
console.log("   (upper bound only — MAE is not known to come after the peak. The");
console.log("    causal answer needs a bar-by-bar replay; that is giveback_test.mjs.)");
