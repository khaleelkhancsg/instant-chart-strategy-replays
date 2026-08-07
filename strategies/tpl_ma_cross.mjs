// TEMPLATE — Moving-average cross, with the usual variations exposed as sliders.
//
// This is a starting point to tune, not a validated book. Every meaningful
// decision in a two-MA system is a parameter here, so you can explore the family
// without editing code:
//
//   maType     EMA reacts faster and whipsaws more; SMA is smoother and later.
//   mode       "state" holds a position for as long as fast is on one side of
//              slow, so you are always in the market. "cross" only fires on the
//              bar the lines actually cross, then waits for the bracket to
//              resolve — far fewer trades, and usually a different animal.
//   trendFilter  Optionally require price on the correct side of a long MA, so
//              you only take longs in an uptrend. Cuts frequency hard.
//   adxMin     Only trade when ADX says a trend exists at all. 0 disables it.
//
// Worth knowing before you tune: MA crosses are lagging by construction, so they
// tend to want a WIDE target and a stop that survives noise. If you shrink the
// target to something a 3:05 PM CT deadline can reach, expect the win rate to
// have to carry the whole result.

import { ema, sma, atr, adx } from "../src/indicators.mjs";

export default {
  id: "tpl_ma_cross",
  name: "Template — MA Cross",
  description: "Two moving averages, every variation on a slider: EMA or SMA, hold-the-state or trade-the-cross, optional long-MA trend filter and ADX gate. A tuning starting point, not a validated strategy.",

  timeframeMin: 5,
  warmupBars: 500,
  execDefaults: { slAtrMult: 2, tpAtrMult: 6, contracts: 8, sizingMode: "fixed" },

  params: [
    { key: "maType", label: "MA type", type: "select", default: "ema",
      options: [["ema", "EMA (faster)"], ["sma", "SMA (smoother)"]], group: "Signal" },
    { key: "fast", label: "Fast length", type: "int", min: 2, max: 100, step: 1, default: 9, group: "Signal" },
    { key: "slow", label: "Slow length", type: "int", min: 3, max: 400, step: 1, default: 21, group: "Signal" },
    { key: "mode", label: "Signal mode", type: "select", default: "cross",
      options: [["cross", "Cross only (fewer trades)"], ["state", "Hold state (always in)"]], group: "Signal" },
    { key: "trendMa", label: "Trend filter MA (0 = off)", type: "int", min: 0, max: 400, step: 5, default: 0, group: "Signal",
      hint: "Only go long above this MA, short below it." },
    { key: "adxMin", label: "ADX minimum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 0, group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;
    const MA = p.maType === "sma" ? sma : ema;

    const f = MA(C, p.fast);
    const s = MA(C, Math.max(p.slow, p.fast + 1));
    const trend = p.trendMa > 0 ? MA(C, p.trendMa) : null;
    const adxArr = p.adxMin > 0 ? adx(H, L, C, 14).adx : null;
    const a = atr(H, L, C, p.atrPeriod);

    const sig = new Int8Array(n);
    for (let i = 1; i < n; i++) {
      if (!Number.isFinite(f[i]) || !Number.isFinite(s[i])) continue;
      if (adxArr && adxArr[i] < p.adxMin) continue;

      let want = 0;
      if (p.mode === "state") {
        want = f[i] > s[i] ? 1 : f[i] < s[i] ? -1 : 0;
      } else {
        if (f[i] > s[i] && f[i - 1] <= s[i - 1]) want = 1;
        else if (f[i] < s[i] && f[i - 1] >= s[i - 1]) want = -1;
      }
      if (want === 0) continue;
      if (trend && Number.isFinite(trend[i])) {
        if (want === 1 && C[i] < trend[i]) continue;
        if (want === -1 && C[i] > trend[i]) continue;
      }
      sig[i] = want;
    }

    const overlays = [
      { name: `${p.maType.toUpperCase()} ${p.fast}`, pane: "price", color: "#4aa3ff", data: f },
      { name: `${p.maType.toUpperCase()} ${p.slow}`, pane: "price", color: "#ff9d4a", data: s },
    ];
    if (trend) overlays.push({ name: `Trend MA ${p.trendMa}`, pane: "price", color: "#9b7dd4", data: trend, dash: [5, 4] });
    if (adxArr) overlays.push({ name: "ADX", pane: "sub", color: "#c9a227", data: adxArr, threshold: p.adxMin, range: [0, 60] });

    return { sig, atr: a, overlays };
  },
};
