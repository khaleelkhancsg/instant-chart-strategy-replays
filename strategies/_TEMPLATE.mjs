// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY TEMPLATE — copy this file, rename it, and it appears in the UI.
//
// Drop any .mjs file in this folder (names starting with "_" are ignored) and
// hit "Reload strategies" in the sidebar. No registration, no wiring.
//
// THE ONE HARD RULE: this file must stay isomorphic. It is imported by Node for
// full-history sweeps AND by the browser for live parameter previews, so import
// only from ../src/*.mjs. The moment you `import fs from "node:fs"` here, the
// live preview breaks.
//
// The `params` array below is not just config — it builds the sidebar. Every
// entry becomes a labelled slider that re-runs the strategy over the visible
// window on each move, so give each one a sane min/max.
// ─────────────────────────────────────────────────────────────────────────────

import { atr, ema } from "../src/indicators.mjs";

export default {
  id: "template",              // must be unique; the filename is a good default
  name: "Template — EMA cross",
  description: "Minimal working example. Long above the slow EMA, short below.",

  // Signal timeframe in minutes, built clock-aligned from the 1-minute source.
  timeframeMin: 5,

  // Warm-up bars (in the signal timeframe) needed before the first valid signal.
  // The window loader prefetches this much history so the indicators at the left
  // edge of a window are identical to a full-history run.
  warmupBars: 300,

  params: [
    { key: "fast",       label: "Fast EMA",    type: "int", min: 2, max: 100, step: 1, default: 9,  group: "Signal" },
    { key: "slow",       label: "Slow EMA",    type: "int", min: 5, max: 400, step: 1, default: 40, group: "Signal" },
    { key: "atrPeriod",  label: "ATR period",  type: "int", min: 2, max: 60,  step: 1, default: 14, group: "Signal" },
  ],

  /**
   * Turn bars into signals.
   *
   * @param bars {ts, open, high, low, close, volume, tday} — all typed arrays,
   *             already resampled to `timeframeMin`.
   * @param p    resolved parameter values, keyed by `params[].key`.
   *
   * @returns {
   *   sig:      Int8Array — 1 long / -1 short / 0 flat. READ AT i-1 AND FILLED AT
   *             THE OPEN OF i by the engine, so never look at bar i's own
   *             high/low/close when setting sig[i]... setting it FROM bar i's
   *             close is correct and safe, because the fill happens at i+1.
   *   atr:      Float64Array — drives stop/target width. Usually just atr(...).
   *   overlays: optional lines to draw. pane 'price' overlays the candles;
   *             pane 'sub' gets its own strip under the chart.
   * }
   */
  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;

    const fast = ema(C, p.fast);
    const slow = ema(C, p.slow);
    const a = atr(H, L, C, p.atrPeriod);

    const sig = new Int8Array(n);
    for (let i = 1; i < n; i++) {
      if (fast[i] > slow[i] && fast[i - 1] <= slow[i - 1]) sig[i] = 1;
      else if (fast[i] < slow[i] && fast[i - 1] >= slow[i - 1]) sig[i] = -1;
    }

    return {
      sig,
      atr: a,
      overlays: [
        { name: `EMA ${p.fast}`, pane: "price", color: "#4aa3ff", data: fast },
        { name: `EMA ${p.slow}`, pane: "price", color: "#ff9d4a", data: slow },
      ],
    };
  },
};
