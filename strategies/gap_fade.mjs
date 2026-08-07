// Overnight gap — fade it back toward the prior close, or trade the drive away.
//
// The one setup on this instrument that is unambiguously an intraday event: the
// difference between where the session opens and where the previous one settled
// is fixed the moment trading resumes, and it either closes or it does not,
// usually within hours. That timing is exactly what the 3:05 PM CT flatten
// demands and what every indicator-based book in this library fails to provide.
//
// The gap is measured in ATR multiples rather than points, so a 40-point gap in
// 2019 (ATR ~6) and a 40-point gap in 2026 (ATR ~28) are not treated as the same
// event — the first is enormous, the second is noise.
//
// Untested. A structurally-motivated starting point, not a result.

import { atr } from "../src/indicators.mjs";

export default {
  id: "gap_fade",
  name: "Overnight Gap Fade / Drive",
  description: "Fades the gap between the session open and the prior settle, back toward the old close — or trades the drive away from it. Resolves within hours by nature.",

  timeframeMin: 5,
  warmupBars: 600,
  execDefaults: { slAtrMult: 1.5, tpAtrMult: 2, contracts: 8, sizingMode: "fixed" },

  params: [
    { key: "direction", label: "On a gap", type: "select", default: "fade",
      options: [["fade", "Fade back toward prior close"], ["drive", "Trade the drive away"]], group: "Signal" },
    { key: "minGapAtr", label: "Minimum gap (× ATR)", type: "float", min: 0.1, max: 8, step: 0.1, default: 1, group: "Signal" },
    { key: "maxGapAtr", label: "Maximum gap (× ATR, 0 = off)", type: "float", min: 0, max: 20, step: 0.5, default: 0, group: "Signal",
      hint: "A ceiling avoids fading a genuine repricing on news." },
    { key: "entryCt", label: "Assess gap at (CT)", type: "time", min: 0, max: 1439, step: 5, default: 8 * 60 + 30, group: "Signal",
      hint: "Default is the 8:30 CT cash open, where the gap is most meaningful." },
    { key: "windowMins", label: "Entry window (minutes)", type: "int", min: 5, max: 480, step: 5, default: 60, group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, ctMin, tday } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const sig = new Int8Array(n);
    const refLine = new Float64Array(n).fill(NaN);

    let curDay = -1, prevClose = NaN, lastCloseOfDay = NaN;
    let openRef = NaN, fired = false;
    const fade = p.direction === "fade";

    for (let i = 1; i < n; i++) {
      if (tday[i] !== curDay) {
        prevClose = lastCloseOfDay;      // settle of the session just ended
        curDay = tday[i];
        openRef = NaN; fired = false;
      }
      lastCloseOfDay = C[i];

      if (!Number.isFinite(prevClose) || !Number.isFinite(a[i]) || a[i] <= 0) continue;
      refLine[i] = prevClose;

      const ct = ctMin ? ctMin[i] : 0;
      if (ct < p.entryCt || ct >= p.entryCt + p.windowMins) continue;
      if (!Number.isFinite(openRef)) openRef = C[i];   // first bar of the window
      if (fired) continue;

      const gapAtr = (openRef - prevClose) / a[i];
      const mag = Math.abs(gapAtr);
      if (mag < p.minGapAtr) continue;
      if (p.maxGapAtr > 0 && mag > p.maxGapAtr) continue;

      const gappedUp = gapAtr > 0;
      // Fading a gap up means selling; driving it means buying.
      sig[i] = fade ? (gappedUp ? -1 : 1) : (gappedUp ? 1 : -1);
      fired = true;
    }

    return {
      sig,
      atr: a,
      overlays: [
        { name: "Prior session close", pane: "price", color: "#9b7dd4", data: refLine, dash: [3, 3] },
      ],
    };
  },
};
