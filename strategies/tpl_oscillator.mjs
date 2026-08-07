// TEMPLATE — Oscillator, faded or followed.
//
// Three oscillators that all answer "is price stretched?", plus the choice of
// what to do about it:
//
//   fade    — buy oversold, sell overbought. The classic reading. Needs a market
//             that actually reverts; in a strong trend it sells every new high.
//   follow  — buy overbought, sell oversold, i.e. treat an extreme reading as
//             momentum confirmation rather than exhaustion. Counter-intuitive
//             and frequently the better half of the pair on index futures.
//
//   rsi     — bounded 0-100, smooth, slow to reach extremes.
//   stoch   — position within the recent range; reaches extremes constantly, so
//             it fires far more often at the same threshold.
//   zscore  — standard deviations from a rolling mean. Unbounded, so the
//             threshold is in sigma and the frequency depends on volatility.
//
// A "trigger" mode is also exposed: `level` fires on every bar beyond the
// threshold, `crossback` waits until the oscillator turns back through it, which
// is the usual fix for fading into a trend that keeps going.

import { atr, adx, rsi, stochastic, zscore } from "../src/indicators.mjs";

export default {
  id: "tpl_oscillator",
  name: "Template — Oscillator Fade / Follow",
  description: "RSI, Stochastic or z-score; fade the extreme or follow it; fire on the level or wait for a cross back. A tuning starting point, not a validated strategy.",

  timeframeMin: 5,
  warmupBars: 500,
  execDefaults: { slAtrMult: 1.5, tpAtrMult: 3, contracts: 8, sizingMode: "fixed" },

  params: [
    { key: "osc", label: "Oscillator", type: "select", default: "rsi",
      options: [["rsi", "RSI"], ["stoch", "Stochastic %K"], ["zscore", "Z-score"]], group: "Signal" },
    { key: "direction", label: "At an extreme", type: "select", default: "fade",
      options: [["fade", "Fade it (reversion)"], ["follow", "Follow it (momentum)"]], group: "Signal" },
    { key: "trigger", label: "Fire on", type: "select", default: "level",
      options: [["level", "Any bar beyond the level"], ["crossback", "Cross back through it"]], group: "Signal",
      hint: "Cross-back avoids fading a trend that simply keeps going." },
    { key: "period", label: "Oscillator period", type: "int", min: 2, max: 200, step: 1, default: 14, group: "Signal" },
    { key: "upper", label: "Overbought level", type: "float", min: 0, max: 100, step: 0.5, default: 70, group: "Signal",
      hint: "For z-score this is read in sigma — try 2.0." },
    { key: "lower", label: "Oversold level", type: "float", min: -100, max: 100, step: 0.5, default: 30, group: "Signal",
      hint: "For z-score use the negative of the overbought level." },
    { key: "adxMax", label: "ADX maximum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 0, group: "Signal",
      hint: "Fades work best in chop — cap ADX to stay out of trends." },
    { key: "cooldownBars", label: "Cooldown bars", type: "int", min: 1, max: 60, step: 1, default: 3, group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const adxArr = p.adxMax > 0 ? adx(H, L, C, 14).adx : null;

    let o, range;
    if (p.osc === "stoch") { o = stochastic(H, L, C, p.period, 3).k; range = [0, 100]; }
    else if (p.osc === "zscore") { o = zscore(C, p.period); range = [-4, 4]; }
    else { o = rsi(C, p.period); range = [0, 100]; }

    const fade = p.direction === "fade";
    const sig = new Int8Array(n);
    let last = -Infinity;
    for (let i = 1; i < n; i++) {
      if (i - last < p.cooldownBars) continue;
      if (!Number.isFinite(o[i]) || !Number.isFinite(o[i - 1])) continue;
      if (adxArr && adxArr[i] > p.adxMax) continue;

      let hot = 0;   // +1 overbought, -1 oversold
      if (p.trigger === "crossback") {
        // Was beyond the level last bar and has come back inside this bar.
        if (o[i - 1] >= p.upper && o[i] < p.upper) hot = 1;
        else if (o[i - 1] <= p.lower && o[i] > p.lower) hot = -1;
      } else {
        if (o[i] >= p.upper) hot = 1;
        else if (o[i] <= p.lower) hot = -1;
      }
      if (hot === 0) continue;

      // Overbought fades SHORT and follows LONG.
      const want = fade ? -hot : hot;
      sig[i] = want;
      last = i;
    }

    const overlays = [
      { name: p.osc === "zscore" ? `Z-score ${p.period}` : p.osc === "stoch" ? `Stoch %K ${p.period}` : `RSI ${p.period}`,
        pane: "sub", color: "#c9a227", data: o, threshold: p.upper, range },
    ];
    if (adxArr) overlays.push({ name: "ADX", pane: "sub", color: "#9b7dd4", data: adxArr, threshold: p.adxMax, range: [0, 60] });

    return { sig, atr: a, overlays };
  },
};
