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

import { atr, adx, zscore, sma, rollingMeanStd } from "../src/indicators.mjs";
import { chk, trig, verdict, cooldown, spark, mark, num, px, adxAtMost, COLOR } from "../src/explain.mjs";

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
    { key: "adxPeriod", label: "ADX period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, tday } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const z = zscore(C, p.zLookback);
    const { adx: adxArr } = adx(H, L, C, Math.max(2, Math.trunc(p.adxPeriod) || 14));
    const atrAvg = sma(a, p.volMaPeriod);

    const sig = new Int8Array(n);
    let last = -Infinity, day = -1;
    for (let i = 1; i < n; i++) {
      // The cooldown restarts each session, so signal spacing never reaches back before today.
      if (tday[i] !== day) { day = tday[i]; last = -Infinity; }
      if (i - last < p.cooldownBars) continue;
      if (!Number.isFinite(z[i])) continue;
      if (adxArr[i] > p.adxMax) continue;
      if (Number.isFinite(atrAvg[i]) && atrAvg[i] > 0 && a[i] > atrAvg[i] * p.volMaxAtrMult) continue;

      if (z[i] >= p.zEntry) { sig[i] = -1; last = i; }        // stretched up -> fade short
      else if (z[i] <= -p.zEntry) { sig[i] = 1; last = i; }   // stretched down -> fade long
    }

    // Bar k as the loop reads it: the cooldown, the ADX ceiling, the volatility
    // ceiling, then the stretch beyond the entry threshold, faded.
    let ms = null;     // the z-score's mean and deviation, for the marks only
    const explain = (k) => {
      const v = z[k], hot = v >= p.zEntry ? 1 : v <= -p.zEntry ? -1 : 0;
      const checks = [trig(`Close at least ${num(p.zEntry)}σ from its ${p.zLookback}-bar mean`, k >= 1 && Number.isFinite(v) && !!hot,
                           { text: Number.isFinite(v) ? `z = ${num(v)}` : "not formed yet", spark: spark(k, [[z, COLOR.adx, "z"]], { refs: [p.zEntry, -p.zEntry] }) }),
                      adxAtMost(adxArr, k, p.adxMax, Math.max(2, Math.trunc(p.adxPeriod) || 14))];
      const hiVol = Number.isFinite(atrAvg[k]) && atrAvg[k] > 0 && a[k] > atrAvg[k] * p.volMaxAtrMult;
      checks.push(chk(`ATR at most ${num(p.volMaxAtrMult)} × its ${p.volMaPeriod}-bar average`, !hiVol,
                      { text: Number.isFinite(atrAvg[k]) && atrAvg[k] > 0 ? `${num(a[k] / atrAvg[k])} ×` : "no average yet" }));
      checks.push(cooldown(sig, tday, k, p.cooldownBars));
      const marks = [];
      if (hot) {
        if (!ms) ms = rollingMeanStd(C, p.zLookback);
        const m = ms.mean[k], band = m + hot * p.zEntry * ms.std[k];
        marks.push(mark.level(m, k - 20, k, `mean ${px(m)}`, { color: "#5a6b7d" }), mark.level(band, k - 20, k, `${hot === 1 ? "+" : "−"}${num(p.zEntry)}σ ${px(band)}`, { color: COLOR.level }),
                   mark.dot(k, C[k], `close ${px(C[k])}`, { color: COLOR.close }));
      }
      return { dir: verdict(-hot, checks.filter(Boolean)), checks: checks.filter(Boolean), marks,
               title: hot ? `Stretched ${hot === 1 ? "up" : "down"} ${num(Math.abs(v))}σ: fade ${hot === 1 ? "short" : "long"}` : "Not stretched" };
    };

    return {
      sig,
      atr: a,
      overlays: [
        { name: `Z-score ${p.zLookback}`, pane: "sub", color: "#c9a227", data: z, threshold: p.zEntry, range: [-4, 4] },
      ],
      explain,
    };
  },
};
