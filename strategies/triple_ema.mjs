// Triple EMA stack — trade only when three timeframes of trend agree.
//
// Ported from lite_backtester's triple_ema.mjs. Long when fast > mid > slow,
// short when fast < mid < slow, flat whenever the stack is tangled. The tangled
// state is the point: it keeps you out of the chop between trends, which a
// two-MA cross cannot do.
//
// `requireStackWiden` adds a further condition — the gap between fast and slow
// must be growing, so you only enter a stack that is opening rather than one
// already rolling over. That is the main lever if the base version enters late.

import { ema, atr } from "../src/indicators.mjs";

export default {
  id: "triple_ema",
  name: "Triple EMA Stack",
  description: "Ported from the lite backtester. Requires three EMAs in order before taking a side, so tangled/choppy conditions produce no position at all.",

  timeframeMin: 5,
  warmupBars: 600,
  execDefaults: { slAtrMult: 2, tpAtrMult: 6, contracts: 8, sizingMode: "fixed" },

  params: [
    { key: "fast", label: "Fast EMA", type: "int", min: 2, max: 100, step: 1, default: 5, group: "Signal" },
    { key: "mid", label: "Mid EMA", type: "int", min: 3, max: 200, step: 1, default: 13, group: "Signal" },
    { key: "slow", label: "Slow EMA", type: "int", min: 5, max: 400, step: 1, default: 50, group: "Signal" },
    { key: "mode", label: "Signal on", type: "select", default: "enter",
      options: [["enter", "Stack forming (fewer trades)"], ["state", "Every stacked bar"]], group: "Signal" },
    { key: "requireStackWiden", label: "Require stack widening", type: "select", default: "off",
      options: [["off", "No"], ["on", "Yes — only opening trends"]], group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const e1 = ema(C, p.fast);
    const e2 = ema(C, Math.max(p.mid, p.fast + 1));
    const e3 = ema(C, Math.max(p.slow, p.mid + 1));

    const stackAt = (i) => (e1[i] > e2[i] && e2[i] > e3[i] ? 1 : e1[i] < e2[i] && e2[i] < e3[i] ? -1 : 0);

    const sig = new Int8Array(n);
    for (let i = 1; i < n; i++) {
      const st = stackAt(i);
      if (st === 0) continue;
      if (p.mode === "enter" && stackAt(i - 1) === st) continue;   // already stacked
      if (p.requireStackWiden === "on") {
        const gapNow = Math.abs(e1[i] - e3[i]);
        const gapPrev = Math.abs(e1[i - 1] - e3[i - 1]);
        if (gapNow <= gapPrev) continue;
      }
      sig[i] = st;
    }

    return {
      sig,
      atr: a,
      overlays: [
        { name: `EMA ${p.fast}`, pane: "price", color: "#4aa3ff", data: e1 },
        { name: `EMA ${p.mid}`, pane: "price", color: "#c9a227", data: e2 },
        { name: `EMA ${p.slow}`, pane: "price", color: "#ff9d4a", data: e3 },
      ],
    };
  },
};
