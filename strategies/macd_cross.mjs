// MACD — the family your live bot is built on.
//
// Ported from lite_backtester's macd_trend.mjs and generalised. Three trigger
// modes, because "a MACD signal" means different things to different people:
//
//   hist    — hold long while the histogram is positive. Always in the market;
//             this is what macd_trend.mjs did.
//   cross   — fire only on the bar the MACD line crosses its signal line. Far
//             fewer trades and a genuinely different distribution.
//   zero    — fire only when the MACD line crosses zero, i.e. when the fast and
//             slow EMAs actually change order. The slowest and most selective.
//
// The `requireSlope` option additionally demands the histogram be growing in the
// signal's direction, which filters crosses that immediately stall — the "angle"
// idea from mnq_macd_angle.mjs in the other repo.

import { atr, adx, macd } from "../src/indicators.mjs";
import { chk, trig, verdict, num, adxAtLeast, histSpark, COLOR } from "../src/explain.mjs";

export default {
  id: "macd_cross",
  name: "MACD — Histogram / Cross / Zero-line",
  description: "Ported from the lite backtester's MACD book and generalised: three trigger modes, optional histogram-slope confirmation and ADX gate.",

  timeframeMin: 5,
  warmupBars: 500,
  execDefaults: { slAtrMult: 2, tpAtrMult: 6, contracts: 8, sizingMode: "fixed" },

  params: [
    { key: "mode", label: "Trigger", type: "select", default: "cross",
      options: [["cross", "Signal-line cross"], ["hist", "Histogram sign (always in)"], ["zero", "Zero-line cross"]], group: "Signal" },
    { key: "fast", label: "Fast EMA", type: "int", min: 2, max: 100, step: 1, default: 12, group: "Signal" },
    { key: "slow", label: "Slow EMA", type: "int", min: 3, max: 200, step: 1, default: 26, group: "Signal" },
    { key: "signal", label: "Signal EMA", type: "int", min: 2, max: 50, step: 1, default: 9, group: "Signal" },
    { key: "requireSlope", label: "Require histogram expanding", type: "select", default: "off",
      options: [["off", "No"], ["on", "Yes — filters stalling crosses"]], group: "Signal" },
    { key: "adxMin", label: "ADX minimum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 0, group: "Signal" },
    { key: "adxPeriod", label: "ADX period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const m = macd(C, p.fast, Math.max(p.slow, p.fast + 1), p.signal);
    const adxArr = p.adxMin > 0 ? adx(H, L, C, Math.max(2, Math.trunc(p.adxPeriod) || 14)).adx : null;
    const wantSlope = p.requireSlope === "on";

    const sig = new Int8Array(n);
    for (let i = 1; i < n; i++) {
      if (adxArr && adxArr[i] < p.adxMin) continue;
      let want = 0;
      if (p.mode === "hist") {
        want = m.hist[i] > 0 ? 1 : m.hist[i] < 0 ? -1 : 0;
      } else if (p.mode === "zero") {
        if (m.line[i] > 0 && m.line[i - 1] <= 0) want = 1;
        else if (m.line[i] < 0 && m.line[i - 1] >= 0) want = -1;
      } else {
        if (m.hist[i] > 0 && m.hist[i - 1] <= 0) want = 1;
        else if (m.hist[i] < 0 && m.hist[i - 1] >= 0) want = -1;
      }
      if (want === 0) continue;
      // Histogram must be moving further in the signal's favour, not fading.
      if (wantSlope) {
        const d = m.hist[i] - m.hist[i - 1];
        if (want === 1 && d <= 0) continue;
        if (want === -1 && d >= 0) continue;
      }
      sig[i] = want;
    }

    const overlays = [
      { name: "MACD", pane: "sub", color: "#4aa3ff", data: m.line, threshold: 0, range: macdRange(m.line) },
    ];
    if (adxArr) overlays.push({ name: "ADX", pane: "sub", color: "#c9a227", data: adxArr, threshold: p.adxMin, range: [0, 60] });

    // Bar k as the loop reads it: the ADX floor, the trigger of the mode, and
    // the histogram still growing when asked.
    const explain = (k) => {
      let want = 0, label, text;
      const h = m.hist, l = m.line;
      if (p.mode === "hist") {
        want = k >= 1 ? (h[k] > 0 ? 1 : h[k] < 0 ? -1 : 0) : 0;
        label = want ? `Histogram ${want === 1 ? "above" : "below"} zero` : "Histogram off zero"; text = num(h[k]);
      } else if (p.mode === "zero") {
        want = k >= 1 ? (l[k] > 0 && l[k - 1] <= 0 ? 1 : l[k] < 0 && l[k - 1] >= 0 ? -1 : 0) : 0;
        label = want ? `MACD crossed ${want === 1 ? "above" : "below"} zero` : "A MACD zero-line cross"; text = k ? `${num(l[k - 1])} → ${num(l[k])}` : "";
      } else {
        want = k >= 1 ? (h[k] > 0 && h[k - 1] <= 0 ? 1 : h[k] < 0 && h[k - 1] >= 0 ? -1 : 0) : 0;
        label = want ? `MACD crossed ${want === 1 ? "above" : "below"} its signal line` : "A MACD / signal cross"; text = k ? `histogram ${num(h[k - 1])} → ${num(h[k])}` : "";
      }
      const checks = [trig(label, !!want, { text, spark: histSpark(k, h, [[l, COLOR.line, "MACD"], [m.signal, COLOR.sig, "signal"]]) })];
      if (adxArr) checks.push(adxAtLeast(adxArr, k, p.adxMin, Math.max(2, Math.trunc(p.adxPeriod) || 14)));
      if (wantSlope && want) {
        const d = h[k] - h[k - 1];
        checks.push(chk("Histogram expanding the trade's way", want === 1 ? !(d <= 0) : !(d >= 0), { text: `${d >= 0 ? "+" : ""}${num(d)} on the bar` }));
      }
      return { dir: verdict(want, checks), checks, marks: [], title: want ? label : "No MACD signal" };
    };
    return { sig, atr: a, overlays, explain };
  },
};

// MACD is unbounded and scales with price, so the sub-pane needs a data-derived
// range rather than a fixed one.
function macdRange(line) {
  let m = 0;
  for (let i = 0; i < line.length; i++) {
    const v = Math.abs(line[i]);
    if (Number.isFinite(v) && v > m) m = v;
  }
  return [-m * 1.05 || -1, m * 1.05 || 1];
}
