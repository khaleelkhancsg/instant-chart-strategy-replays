// Universal signal filters. ISOMORPHIC.
//
// Regime and time-of-day gates that apply to ANY strategy's signal, rather than
// being reimplemented inside each one. Two reasons that matters:
//
//  1. A search can sweep filters ORTHOGONALLY to strategies. Every gate becomes
//     available to every book without touching a single strategy file.
//  2. The expensive part (indicators for the gates) is computed ONCE per bar set
//     and reused across every strategy and every parameter combination.
//
// The gates are deliberately two-sided. "ADX above 25" and "ADX below 25" are
// different theories about the same market, and which one a given signal wants
// is an empirical question — so every band has both a floor and a ceiling.

import { adx, atr, sma, efficiencyRatio, choppiness, bandwidth } from "./indicators.mjs";

export const NO_FILTER = {
  startCt: 0, endCt: 1440,      // session window, America/Chicago minutes
  adxMin: 0, adxMax: 0,         // 0 disables that side
  volMin: 0, volMax: 0,         // ATR as a ratio of its own moving average
  effMin: 0, effMax: 0,         // Kaufman efficiency ratio, 0..1
  chopMin: 0, chopMax: 0,       // choppiness index, ~0..100
  bwMin: 0, bwMax: 0,           // Bollinger bandwidth (squeeze gauge)
};

/**
 * Precompute every gate series for a bar set. Do this ONCE per (bars, timeframe)
 * and reuse it across all strategies and parameter combinations.
 */
export function buildFilterContext(bars, { adxPeriod = 14, atrPeriod = 14, volMaPeriod = 60, effPeriod = 20, chopPeriod = 14, bwPeriod = 20 } = {}) {
  const { high: H, low: L, close: C } = bars;
  const n = C.length;
  const a = atr(H, L, C, atrPeriod);
  const aMa = sma(a, volMaPeriod);
  const volRatio = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(aMa[i]) && aMa[i] > 0) volRatio[i] = a[i] / aMa[i];
  }
  return {
    n,
    ctMin: bars.ctMin || null,
    adx: adx(H, L, C, adxPeriod).adx,
    volRatio,
    eff: efficiencyRatio(C, effPeriod),
    chop: choppiness(H, L, C, chopPeriod),
    bw: bandwidth(C, bwPeriod, 2),
  };
}

// A band passes when the value sits inside it. A zero bound disables that side,
// and a NaN reading (indicator not yet warm) is treated as failing any active
// band — never as passing by default.
function inBand(v, min, max) {
  if (min <= 0 && max <= 0) return true;
  if (!Number.isFinite(v)) return false;
  if (min > 0 && v < min) return false;
  if (max > 0 && v > max) return false;
  return true;
}

export function barPasses(ctx, i, f) {
  if (ctx.ctMin) {
    const ct = ctx.ctMin[i];
    // A window whose end is before its start wraps past midnight.
    const inWindow = f.endCt >= f.startCt
      ? ct >= f.startCt && ct < f.endCt
      : ct >= f.startCt || ct < f.endCt;
    if (!inWindow) return false;
  }
  if (!inBand(ctx.adx[i], f.adxMin, f.adxMax)) return false;
  if (!inBand(ctx.volRatio[i], f.volMin, f.volMax)) return false;
  if (!inBand(ctx.eff[i], f.effMin, f.effMax)) return false;
  if (!inBand(ctx.chop[i], f.chopMin, f.chopMax)) return false;
  if (!inBand(ctx.bw[i], f.bwMin, f.bwMax)) return false;
  return true;
}

/**
 * Mask a signal array in place-free fashion. Returns a NEW Int8Array so the
 * caller can keep reusing the unmasked original across many filter combinations.
 */
export function applyFilters(sig, ctx, filter) {
  const f = { ...NO_FILTER, ...filter };
  const out = new Int8Array(sig.length);
  for (let i = 0; i < sig.length; i++) {
    if (sig[i] !== 0 && barPasses(ctx, i, f)) out[i] = sig[i];
  }
  return out;
}

// How many signal bars survive — useful for skipping filter combinations that
// have gated away essentially everything before paying for a bracket run.
export function countSurviving(sig, ctx, filter) {
  const f = { ...NO_FILTER, ...filter };
  let c = 0;
  for (let i = 0; i < sig.length; i++) if (sig[i] !== 0 && barPasses(ctx, i, f)) c++;
  return c;
}
