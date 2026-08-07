// ADX / DI trend — go with whichever directional index is on top.
//
// Ported from lite_backtester's adx_trend.mjs. ADX measures how strongly price is
// trending without saying which way; +DI and −DI say which way. So the rule is
// "when a trend exists, take its direction."
//
// This is the most direct expression of the regime idea that gates several other
// books here, which makes it a useful control: if the ADX filter is doing the
// work in those, this one should show some of the same edge on its own.
//
// `diCrossOnly` narrows it from an always-in book to firing only when the DI
// lines actually change order — the moment the trend direction flips.

import { atr, adx } from "../src/indicators.mjs";

export default {
  id: "adx_di_trend",
  name: "ADX / DI Trend",
  description: "Ported from the lite backtester. Trade the direction of +DI vs −DI whenever ADX confirms a trend exists. A clean test of whether the regime filter itself carries edge.",

  timeframeMin: 5,
  warmupBars: 400,
  execDefaults: { slAtrMult: 2, tpAtrMult: 6, contracts: 8, sizingMode: "fixed" },

  params: [
    { key: "period", label: "ADX period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
    { key: "adxMin", label: "ADX minimum", type: "int", min: 0, max: 60, step: 1, default: 25, group: "Signal" },
    { key: "adxMax", label: "ADX maximum (0 = off)", type: "int", min: 0, max: 100, step: 1, default: 0, group: "Signal",
      hint: "A ceiling avoids entering an already-exhausted trend." },
    { key: "diCrossOnly", label: "Fire on", type: "select", default: "cross",
      options: [["cross", "DI cross only"], ["state", "Every bar (always in)"]], group: "Signal" },
    { key: "diGap", label: "Minimum DI separation", type: "float", min: 0, max: 40, step: 0.5, default: 0, group: "Signal",
      hint: "Require the winning DI to lead by this much — filters indecisive readings." },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const { adx: adxArr, pdi, ndi } = adx(H, L, C, p.period);

    const sig = new Int8Array(n);
    for (let i = 1; i < n; i++) {
      if (adxArr[i] < p.adxMin) continue;
      if (p.adxMax > 0 && adxArr[i] > p.adxMax) continue;
      if (Math.abs(pdi[i] - ndi[i]) < p.diGap) continue;

      if (p.diCrossOnly === "cross") {
        if (pdi[i] > ndi[i] && pdi[i - 1] <= ndi[i - 1]) sig[i] = 1;
        else if (ndi[i] > pdi[i] && ndi[i - 1] <= pdi[i - 1]) sig[i] = -1;
      } else {
        sig[i] = pdi[i] > ndi[i] ? 1 : ndi[i] > pdi[i] ? -1 : 0;
      }
    }

    return {
      sig,
      atr: a,
      overlays: [
        { name: "ADX", pane: "sub", color: "#c9a227", data: adxArr, threshold: p.adxMin, range: [0, 60] },
      ],
    };
  },
};
