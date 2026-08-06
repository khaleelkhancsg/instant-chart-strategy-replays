// MNQ Trend book — the shipped "neutral EV" challenge strategy.
//
// Ported from lite_backtester's mnq_trend_neutev.mjs + lib_trend_book.mjs, which
// is the config CHALLENGE_STRATEGY_SPEC.md documents: a 5-minute Donchian-30
// breakout taken WITH the break, gated on ADX >= 25, bracketed 2xATR / 12xATR
// (6:1), 8 contracts, with the daily circuit breaker applied at the rules layer.
//
// Why the numbers look odd: per-trade profit factor is ~1.01 and the win rate is
// ~25%. That is not a bug and not a target for "improvement" — this book is tuned
// to maximise PASS RATE on a finite 30-day sprint, where frequency and variance
// dominate a near-zero per-trade edge. Loosening ADX raises pass rate while
// LOWERING expectancy. If you want the version that is actually profitable to
// trade once funded, set ADX minimum to 32.
//
// One deliberate difference from the original: bars here are CLOCK-ALIGNED
// 5-minute (…:00, :05), where lib_trend_book chunked 1-min bars in fixed groups
// of 5 by index. Clock alignment is what a live bot can actually reproduce; the
// original drifts out of phase after every session gap. Expect small differences
// against the legacy numbers as a result.

import { adx, atr, donchian } from "../src/indicators.mjs";

export default {
  id: "trend_neutev",
  name: "MNQ Trend — Neutral EV (Donchian 30 / ADX 25)",
  description: "5-min Donchian breakout in an ADX-confirmed trend. Spec: 2xATR stop, 12xATR target, 8 contracts, -$150 daily breaker.",

  timeframeMin: 5,
  warmupBars: 400,

  params: [
    { key: "donchian",     label: "Donchian lookback", type: "int", min: 5,  max: 200, step: 1, default: 30, group: "Signal" },
    { key: "adxMin",       label: "ADX minimum",       type: "int", min: 0,  max: 60,  step: 1, default: 25, group: "Signal",
      hint: "Regime gate. 25 = neutral-EV/highest pass rate, 32 = positive-EV variant." },
    { key: "adxPeriod",    label: "ADX period",        type: "int", min: 2,  max: 60,  step: 1, default: 14, group: "Signal" },
    { key: "cooldownBars", label: "Cooldown bars",     type: "int", min: 1,  max: 60,  step: 1, default: 1,  group: "Signal",
      hint: "Minimum bars between consecutive signals. 1 = no spacing." },
    { key: "atrPeriod",    label: "ATR period",        type: "int", min: 2,  max: 60,  step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;

    const { adx: adxArr } = adx(H, L, C, p.adxPeriod);
    const { high: dh, low: dl } = donchian(H, L, p.donchian);
    const a = atr(H, L, C, p.atrPeriod);

    const sig = new Int8Array(n);
    let last = -Infinity;
    for (let i = p.donchian; i < n; i++) {
      if (i - last < p.cooldownBars) continue;
      if (adxArr[i] < p.adxMin) continue;
      if (C[i] > dh[i]) { sig[i] = 1; last = i; }
      else if (C[i] < dl[i]) { sig[i] = -1; last = i; }
    }

    return {
      sig,
      atr: a,
      overlays: [
        { name: `Donchian ${p.donchian} high`, pane: "price", color: "#3d7a5a", data: dh, dash: [4, 3] },
        { name: `Donchian ${p.donchian} low`,  pane: "price", color: "#7a3d3d", data: dl, dash: [4, 3] },
        { name: "ADX", pane: "sub", color: "#c9a227", data: adxArr, threshold: p.adxMin, range: [0, 60] },
      ],
    };
  },
};
