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
import { chk, trig, verdict, inWindow, mark, num, px, dayStart, COLOR } from "../src/explain.mjs";

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

    // Bar k, with the session's state the loop had there: the prior close (the
    // last bar of the session before, from bar 1 on, as the loop starts), the
    // window's first price, and whether the day had already fired.
    const explain = (k) => {
      const none = (label, text) => ({ dir: 0, checks: [trig(label, false, { text })], marks: [] });
      if (k < 1) return none("A prior session", "the first bar");
      const s0 = Math.max(1, dayStart(tday, k));
      const prev = s0 >= 2 ? C[s0 - 1] : NaN;
      if (!Number.isFinite(prev)) return none("A prior session close", "none before this session");
      const ct = ctMin ? ctMin[k] : 0;
      const win = inWindow(ct, p.entryCt, p.entryCt + p.windowMins, "Gap assessed");
      const valid = (j) => Number.isFinite(a[j]) && a[j] > 0;
      let ref = NaN, refAt = -1, fired = false;
      for (let j = s0; j <= k; j++) {
        const cj = ctMin ? ctMin[j] : 0;
        if (!valid(j) || cj < p.entryCt || cj >= p.entryCt + p.windowMins) continue;
        if (refAt < 0) { ref = C[j]; refAt = j; }
        if (j < k && sig[j]) fired = true;
      }
      if (!valid(k)) return none("ATR ready", "not yet");
      const gapAtr = (ref - prev) / a[k], mag = Math.abs(gapAtr), up = gapAtr > 0;
      const checks = [win];
      if (refAt >= 0) {
        checks.push(trig(`Gap at least ${num(p.minGapAtr)} × ATR`, !(mag < p.minGapAtr),
                         { text: `${up ? "+" : "−"}${num(mag)} × ATR: ${px(ref)} against the prior close ${px(prev)}`, note: `ATR ${num(a[k])}` }));
        if (p.maxGapAtr > 0) checks.push(chk(`Gap at most ${num(p.maxGapAtr)} × ATR`, !(mag > p.maxGapAtr), { text: `${num(mag)} × ATR` }));
        checks.push(chk("The day's first gap trade", !fired, { text: fired ? "already traded today" : "not traded yet" }));
      }
      const cand = refAt >= 0 && win.pass ? (fade ? (up ? -1 : 1) : (up ? 1 : -1)) : 0;
      const marks = refAt >= 0 ? [mark.level(prev, s0, k, `prior close ${px(prev)}`, { color: "#9b7dd4" }), mark.dot(refAt, ref, `window opens ${px(ref)}`, { color: COLOR.level }),
                                  mark.move(refAt, prev, refAt, ref, "the gap", { color: up ? COLOR.up : COLOR.down })] : [];
      return { dir: verdict(cand, checks), checks, marks,
               title: refAt >= 0 ? `Gap ${up ? "up" : "down"} ${num(mag)} × ATR: ${fade ? "fade it" : "trade the drive"}` : "Outside the gap window" };
    };

    return {
      sig,
      atr: a,
      overlays: [
        { name: "Prior session close", pane: "price", color: "#9b7dd4", data: refLine, dash: [3, 3] },
      ],
      explain,
    };
  },
};
