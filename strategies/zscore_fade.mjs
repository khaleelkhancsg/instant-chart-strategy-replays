// Z-score mean reversion — the core of the lite backtester's best-validated book.
//
// This is the signal behind mnq_reversion_scalper.mjs, which after a long search
// was that project's strongest result: fade price when it is N standard
// deviations from its own rolling mean, but ONLY when ADX says there is no trend
// to fight, and only when volatility is not extreme.
//
// The three filters each earned their place there, and are worth understanding
// before you tune them away:
//
//   zEntry       The edge only appears at genuinely rare extremes. Loosening it
//                toward higher frequency reliably diluted the profit factor —
//                measured repeatedly, across many lookbacks.
//   adxMax       Fading a trending market is what kills reversion books. This
//                filter is what made the edge survive commission at all.
//   volMaxAtrMult  Skip bars where ATR is far above its own average. Tuning this
//                from 1.6 to 1.75 was worth +3.6pp of pass rate there — a
//                surprisingly sharp local optimum, so search it finely.
//
// Shipped config there was zLookback 50, zEntry 2.5, adxMax 25, vol filter 1.75,
// with a 2.5xATR stop and 18.75xATR target (7.5:1) at 10 contracts. Note that
// wide target assumes overnight holds are allowed; under a 3:05 PM CT flatten it
// will rarely be reached.

import { atr, adx, zscore, sma } from "../src/indicators.mjs";

export default {
  id: "zscore_fade",
  name: "Z-Score Fade (regime + volatility filtered)",
  description: "The signal behind the lite backtester's best-validated book. Fades statistical extremes, gated on ADX and an ATR-vs-average volatility filter.",

  timeframeMin: 5,
  warmupBars: 600,
  execDefaults: { slAtrMult: 2.5, tpAtrMult: 18.75, contracts: 10, sizingMode: "fixed" },

  params: [
    { key: "zLookback", label: "Z-score lookback", type: "int", min: 5, max: 300, step: 5, default: 50, group: "Signal" },
    { key: "zEntry", label: "Entry threshold (σ)", type: "float", min: 0.5, max: 5, step: 0.1, default: 2.5, group: "Signal",
      hint: "The edge lives at rare extremes; loosening this reliably dilutes it." },
    { key: "adxMax", label: "ADX maximum", type: "int", min: 0, max: 60, step: 1, default: 25, group: "Signal",
      hint: "Do not fade a trend. This filter is what made the edge survive costs." },
    { key: "volMaxAtrMult", label: "Max ATR vs its average", type: "float", min: 0.5, max: 4, step: 0.05, default: 1.75, group: "Signal",
      hint: "Skip abnormally volatile bars. Sharp local optimum — search finely." },
    { key: "volMaPeriod", label: "ATR average period", type: "int", min: 5, max: 200, step: 5, default: 60, group: "Signal" },
    { key: "cooldownBars", label: "Cooldown bars", type: "int", min: 1, max: 60, step: 1, default: 1, group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const z = zscore(C, p.zLookback);
    const { adx: adxArr } = adx(H, L, C, 14);
    const atrAvg = sma(a, p.volMaPeriod);

    const sig = new Int8Array(n);
    let last = -Infinity;
    for (let i = 1; i < n; i++) {
      if (i - last < p.cooldownBars) continue;
      if (!Number.isFinite(z[i])) continue;
      if (adxArr[i] > p.adxMax) continue;
      if (Number.isFinite(atrAvg[i]) && atrAvg[i] > 0 && a[i] > atrAvg[i] * p.volMaxAtrMult) continue;

      if (z[i] >= p.zEntry) { sig[i] = -1; last = i; }        // stretched up -> fade short
      else if (z[i] <= -p.zEntry) { sig[i] = 1; last = i; }   // stretched down -> fade long
    }

    return {
      sig,
      atr: a,
      overlays: [
        { name: `Z-score ${p.zLookback}`, pane: "sub", color: "#c9a227", data: z, threshold: p.zEntry, range: [-4, 4] },
      ],
    };
  },
};
