// Supertrend — ATR-banded trend following.
//
// Ported from lite_backtester's supertrend.mjs. The band ratchets in the
// direction of the trend and only flips when price closes through it, so it
// holds a direction stubbornly and reverses late but decisively.
//
// Honest note from the other repo's research: Supertrend was the ONLY
// non-mean-reversion archetype tried in the big signal sweep there, and it came
// back weaker AND lower-frequency than the mean-reversion books (best case
// profit factor 1.048 at 0.74 trades/day). Trend-following underperformed fading
// on this instrument in that test. Included here because it is a distinct
// archetype worth having on the chart, not because it is expected to win.
//
// `flipOnly` is the interesting switch: by default the book is always in the
// market, which under a bracketed engine means it re-enters constantly. Turning
// it on emits a signal only on the bar the trend actually flips, which is far
// closer to how Supertrend is usually traded.

import { atr, adx, supertrend } from "../src/indicators.mjs";

export default {
  id: "supertrend",
  name: "Supertrend (ATR trend bands)",
  description: "Ported from the lite backtester. A distinct trend-following archetype — its research there found it weaker than mean reversion on MNQ, so treat it as a comparison point.",

  timeframeMin: 5,
  warmupBars: 400,
  execDefaults: { slAtrMult: 2, tpAtrMult: 6, contracts: 8, sizingMode: "fixed" },

  params: [
    { key: "period", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 10, group: "Signal" },
    { key: "mult", label: "Band multiplier", type: "float", min: 0.5, max: 8, step: 0.1, default: 3, group: "Signal" },
    { key: "flipOnly", label: "Signal on", type: "select", default: "flip",
      options: [["flip", "Trend flips only"], ["state", "Every bar (always in)"]], group: "Signal" },
    { key: "adxMin", label: "ADX minimum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 0, group: "Signal" },
    { key: "atrPeriod", label: "Bracket ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const st = supertrend(H, L, C, p.period, p.mult);
    const adxArr = p.adxMin > 0 ? adx(H, L, C, 14).adx : null;

    const sig = new Int8Array(n);
    for (let i = 1; i < n; i++) {
      if (adxArr && adxArr[i] < p.adxMin) continue;
      if (p.flipOnly === "flip") {
        if (st.trend[i] !== st.trend[i - 1]) sig[i] = st.trend[i];
      } else {
        sig[i] = st.trend[i];
      }
    }

    // Only the band on the active side is meaningful, so blank the other one.
    const line = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) line[i] = st.trend[i] === 1 ? st.lower[i] : st.upper[i];

    const overlays = [{ name: `Supertrend ${p.period}/${p.mult}`, pane: "price", color: "#c9a227", data: line }];
    if (adxArr) overlays.push({ name: "ADX", pane: "sub", color: "#9b7dd4", data: adxArr, threshold: p.adxMin, range: [0, 60] });

    return { sig, atr: a, overlays };
  },
};
