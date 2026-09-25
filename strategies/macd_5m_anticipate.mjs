// Enter BEFORE the crossover, by reading the histogram's approach to zero.
//
// The histogram is macd − signal, so a crossover happens exactly when it
// reaches zero. A histogram shrinking toward zero is therefore not a hint about
// a cross, it IS the cross arriving — and nothing about seeing it requires data
// from the future. Measured over 507,831 five-minute bars
// (research/hist_precursor.mjs):
//
//   cross within 2 bars, unconditional                      14.8%
//   ...given 2 shrinking bars and |hist| < 0.25x its average 49.7%   3.35x
//
// When the cross does follow, entering on the anticipation rather than on the
// cross fills about 6.4 points better with a 1.8-bar lead. At 8 lots that is
// roughly $100 a trade, against a $12 round trip.
//
// ── THE CATCH, WHICH IS THE WHOLE EXPERIMENT ────────────────────────────
// Those 6.4 points are conditional on the cross arriving, and it does not
// arrive 36% of the time. A histogram routinely shrinks most of the way to
// zero and then re-expands, and on those bars this book has entered AGAINST a
// move that is about to resume. The 3.35x lift and the better fill are both
// real; whether they cover the 36% is what the backtest is for, and nothing
// above answers it.
//
// Direction is the side the histogram is heading TOWARD, which is the opposite
// of the side it is currently on — so this is a fade of the current push, taken
// in anticipation of the trend book's own signal.

import { atr, ema, sma, wma } from "../src/indicators.mjs";
import base from "./macd_1m_flip.mjs";

const pick = (t) => (t === "sma" ? sma : t === "wma" ? wma : ema);

export default {
  ...base,

  id: "macd_5m_anticipate",
  name: "MACD 5-min — anticipate the cross from the histogram",
  description: "Enter before the crossover, when the histogram has been shrinking toward zero and is close enough to it that a cross is likely. Holds until the opposite signal. No stop, no target, no session window.",

  timeframeMin: 5,
  warmupBars: 400,

  params: [
    ...base.params,
    { key: "shrinkBars", label: "Shrinking bars required", type: "int",
      min: 1, max: 8, step: 1, default: 2, group: "Anticipation",
      hint: "Consecutive bars moving toward zero. More raises the hit rate but fires less often." },
    { key: "prox", label: "Proximity to zero (x recent |hist|)", type: "float",
      min: 0.05, max: 1.5, step: 0.05, default: 0.25, group: "Anticipation",
      hint: "How close to the baseline the histogram must already be, as a fraction of its own trailing average — so the threshold means the same thing across regimes. 0.25 gave a 3.35x lift on the probability of a cross within 2 bars." },
    { key: "scaleBars", label: "Bars in the |hist| average", type: "int",
      min: 50, max: 500, step: 25, default: 200, group: "Anticipation" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;
    const MA = pick(p.oscMaType), SIG = pick(p.sigMaType);
    const slow = Math.max(p.slow, p.fast + 1);
    const ef = MA(C, p.fast), es = MA(C, slow);
    const line = new Float64Array(n);
    for (let i = 0; i < n; i++) line[i] = ef[i] - es[i];
    const signal = SIG(line, p.signal);
    const hist = new Float64Array(n);
    for (let i = 0; i < n; i++) hist[i] = line[i] - signal[i];

    // Trailing mean |hist|, so "close to zero" means the same thing whether the
    // histogram is running at 2 points or 20. Causal by construction: the
    // window ends at the bar being tested.
    const win = Math.max(10, Math.trunc(p.scaleBars) || 200);
    const scale = new Float64Array(n).fill(NaN);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(hist[i]);
      if (Number.isFinite(a)) sum += a;
      if (i >= win) sum -= Math.abs(hist[i - win]) || 0;
      if (i >= win - 1) scale[i] = sum / win;
    }

    const need = Math.max(1, Math.trunc(p.shrinkBars) || 1);
    const sig = new Int8Array(n);
    let run = 0;
    for (let i = 1; i < n; i++) {
      const v = hist[i], u = hist[i - 1];
      if (!Number.isFinite(v) || !Number.isFinite(u) || !Number.isFinite(scale[i])) {
        run = 0; continue;
      }
      run = Math.abs(v) < Math.abs(u) ? run + 1 : 0;
      if (run < need) continue;
      if (!(Math.abs(v) < p.prox * scale[i])) continue;
      // Heading toward the OTHER side, which is where the cross would land.
      sig[i] = v >= 0 ? -1 : 1;
    }

    const r = span(line, signal, hist);
    return {
      sig,
      atr: atr(H, L, C, p.atrPeriod),
      overlays: [
        { name: "Histogram", pane: "sub", kind: "hist", data: hist,
          colorUp: "#26a65b", colorUpFade: "#7fd4a0",
          colorDown: "#d1566e", colorDownFade: "#eda2b0",
          threshold: 0, autoRange: true, range: r },
        { name: "MACD", pane: "sub", color: "#4aa3ff", data: line, autoRange: true, range: r },
        { name: "Signal", pane: "sub", color: "#e0894a", data: signal, autoRange: true, range: r },
      ],
    };
  },
};

function span(...series) {
  let m = 0;
  for (const s of series) {
    for (let i = 0; i < s.length; i++) {
      const v = Math.abs(s[i]);
      if (Number.isFinite(v) && v > m) m = v;
    }
  }
  return [-m * 1.05 || -1, m * 1.05 || 1];
}
