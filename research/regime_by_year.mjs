// Why is one year harder to pass than another?
//
// Splits the question in two, because they have different answers:
//   PRICE ACTION — is the market itself less tradeable (weaker follow-through,
//                  choppier, more mean-reverting)?
//   MECHANICS    — is the market fine, but the FIXED risk envelope ($2000
//                  drawdown, 8 contracts) no longer fits its volatility?
//
// The second is easy to overlook and easy to fix, so it is worth ruling in or out
// before redesigning any signal.

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { atr, adx } from "../src/indicators.mjs";
import strat from "../strategies/trend_neutev.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { resolveExec } from "../src/engine.mjs";
import { sweepWindows, resolveRules } from "../src/challenge.mjs";

const { bars } = loadBars();
const params = resolveParams(strat, {});
const exec = resolveExec({});
const rules = resolveRules({});
const yearOf = (ms) => new Date(ms).getUTCFullYear();

// ───────────────── price-action character, per year ─────────────────
const tf = resample(bars, params.timeframeMin);
const A = atr(tf.high, tf.low, tf.close, 14);
const { adx: ADX } = adx(tf.high, tf.low, tf.close, 14);

const Y = new Map();
const get = (y) => {
  if (!Y.has(y)) Y.set(y, { n: 0, atr: 0, px: 0, adx: 0, trending: 0, absRet: 0, netStart: null, netEnd: 0, ret: [] });
  return Y.get(y);
};
for (let i = 1; i < tf.close.length; i++) {
  const y = yearOf(tf.ts[i]);
  const r = get(y);
  r.n++;
  r.atr += A[i];
  r.px += tf.close[i];
  r.adx += ADX[i];
  if (ADX[i] >= 25) r.trending++;
  const d = tf.close[i] - tf.close[i - 1];
  r.absRet += Math.abs(d);
  if (r.netStart === null) r.netStart = tf.close[i - 1];
  r.netEnd = tf.close[i];
  if (r.ret.length < 200000) r.ret.push(d);
}

// Lag-1 autocorrelation of returns: negative = mean-reverting (chop punishes
// breakouts), positive = trending (breakouts follow through).
function autocorr(a) {
  const m = a.reduce((x, v) => x + v, 0) / a.length;
  let num = 0, den = 0;
  for (let i = 1; i < a.length; i++) num += (a[i] - m) * (a[i - 1] - m);
  for (let i = 0; i < a.length; i++) den += (a[i] - m) ** 2;
  return den === 0 ? 0 : num / den;
}

// ───────────────── strategy behaviour, per year ─────────────────
const run = runStrategy(bars, strat, params, exec);
const T = new Map();
for (const t of run.trades) {
  const y = yearOf(t.entryTime);
  if (!T.has(y)) T.set(y, { n: 0, wins: 0, pnl: 0, gw: 0, gl: 0, win$: 0, loss$: 0, stopPts: 0 });
  const r = T.get(y);
  r.n++; r.pnl += t.pnl;
  if (t.pnl > 0) { r.wins++; r.gw += t.pnl; r.win$ += t.pnl; }
  else { r.gl += -t.pnl; r.loss$ += -t.pnl; }
  r.stopPts += Math.abs(t.entryPrice - t.stop);
}

// ───────────────── challenge outcomes, per year ─────────────────
const sweep = sweepWindows(run.trades, bars.ts[0], bars.ts[bars.count - 1], rules, 1);
const W = new Map();
for (const w of sweep.windows) {
  const y = yearOf(w.startMs);
  if (!W.has(y)) W.set(y, { n: 0, pass: 0, fail: 0, open: 0, cushion: [] });
  const r = W.get(y);
  r.n++;
  if (w.outcome === "PASS") r.pass++;
  else if (w.outcome === "FAIL") r.fail++;
  else r.open++;
}

// ───────────────── report ─────────────────
const years = [...Y.keys()].sort();
const DD = rules.trailingDD, PV = exec.pointValue, C = exec.contracts;

console.log("PRICE ACTION (5-min bars)\n");
console.log("year   ATR(pts)  ATR(%px)   meanADX  %trending  efficiency  lag1-autocorr");
for (const y of years) {
  const r = Y.get(y);
  const eff = Math.abs(r.netEnd - r.netStart) / r.absRet;  // Kaufman efficiency ratio
  console.log(
    `${y}  ${(r.atr / r.n).toFixed(2).padStart(8)}  ${((r.atr / r.n) / (r.px / r.n) * 100).toFixed(4).padStart(8)}  ` +
    `${(r.adx / r.n).toFixed(1).padStart(8)}  ${((r.trending / r.n) * 100).toFixed(1).padStart(8)}%  ` +
    `${eff.toFixed(5).padStart(10)}  ${autocorr(r.ret).toFixed(4).padStart(13)}`
  );
}

console.log("\n\nRISK MECHANICS — does the FIXED envelope still fit the volatility?\n");
console.log(`(${C} contracts, ${exec.slAtrMult}x ATR stop, $${PV}/pt, $${DD} trailing drawdown)\n`);
console.log("year   avg stop(pts)   avg stop($)   % of $2000 DD   losses to breach   avg win($)");
for (const y of years) {
  const t = T.get(y);
  if (!t) continue;
  const stopPts = t.stopPts / t.n;
  const stop$ = stopPts * PV * C;
  const avgWin = t.wins ? t.win$ / t.wins : 0;
  console.log(
    `${y}  ${stopPts.toFixed(2).padStart(13)}  ${stop$.toFixed(0).padStart(12)}  ` +
    `${((stop$ / DD) * 100).toFixed(1).padStart(14)}%  ${(DD / stop$).toFixed(1).padStart(17)}  ${avgWin.toFixed(0).padStart(11)}`
  );
}

console.log("\n\nSTRATEGY + OUTCOMES\n");
console.log("year   trades  win%    PF     exp$/trade      pass%   fail%   unresolved%");
for (const y of years) {
  const t = T.get(y), w = W.get(y);
  if (!t || !w) continue;
  console.log(
    `${y}  ${String(t.n).padStart(6)}  ${((t.wins / t.n) * 100).toFixed(1).padStart(5)}  ` +
    `${(t.gw / Math.max(t.gl, 1e-9)).toFixed(3).padStart(6)}  ${(t.pnl / t.n).toFixed(2).padStart(11)}  ` +
    `${((w.pass / w.n) * 100).toFixed(1).padStart(11)}  ${((w.fail / w.n) * 100).toFixed(1).padStart(6)}  ${((w.open / w.n) * 100).toFixed(1).padStart(12)}`
  );
}

// The decisive test for the mechanical explanation: hold DOLLAR risk per trade
// constant across years by scaling contracts to that year's volatility, and see
// whether the year-to-year spread in pass rate collapses.
console.log("\n\nCONTRACTS NEEDED to hold a stop at a constant $ risk (capped at 10):\n");
console.log("year   avg stop(pts)   contracts for $250 risk   for $400 risk");
for (const y of years) {
  const t = T.get(y);
  if (!t) continue;
  const stopPts = t.stopPts / t.n;
  const c250 = Math.min(10, Math.max(1, Math.round(250 / (stopPts * PV))));
  const c400 = Math.min(10, Math.max(1, Math.round(400 / (stopPts * PV))));
  console.log(`${y}  ${stopPts.toFixed(2).padStart(13)}  ${String(c250).padStart(23)}  ${String(c400).padStart(13)}`);
}
