// Session VWAP deviation — fade or follow.
//
// VWAP is where the average contract actually traded today, so it is the level
// institutional execution is benchmarked against. Price stretched far from it is
// either an opportunity to fade or a sign of one-way flow to join, and this lets
// you test both.
//
// The band is measured in ATR MULTIPLES rather than percent. That matters more
// than it sounds: MNQ's 5-min ATR ran ~6 points in 2019 and ~28 in 2026, so a
// fixed percentage band means something completely different in each era, while
// an ATR band self-scales and stays comparable across the whole dataset.
//
// From the lite backtester's history: VWAP-fade was initially written off as
// having no edge, then found to be mildly positive at scale — but only reached a
// competitive pass rate at 160-184 contracts, where one stop is 559% of the
// drawdown limit. It is capped at 10 lots here, which is the honest constraint.
// Treat it as a starting point.

import { atr, adx, vwap } from "../src/indicators.mjs";

export default {
  id: "vwap_fade",
  name: "VWAP Deviation — Fade / Follow",
  description: "Distance from session VWAP measured in ATR multiples, so the band self-scales across volatility eras. Fade the stretch or join it.",

  timeframeMin: 5,
  warmupBars: 300,
  execDefaults: { slAtrMult: 1.5, tpAtrMult: 2, contracts: 10, sizingMode: "fixed" },

  params: [
    { key: "direction", label: "When stretched from VWAP", type: "select", default: "fade",
      options: [["fade", "Fade back toward it"], ["follow", "Follow the stretch"]], group: "Signal" },
    { key: "devMin", label: "Enter beyond (× ATR)", type: "float", min: 0.1, max: 6, step: 0.1, default: 1, group: "Signal" },
    { key: "devMax", label: "But not beyond (× ATR, 0 = off)", type: "float", min: 0, max: 10, step: 0.1, default: 0, group: "Signal",
      hint: "A ceiling avoids fading a genuine dislocation that keeps going." },
    { key: "adxMax", label: "ADX maximum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 30, group: "Signal",
      hint: "Fades want chop. Set 0 and use follow mode for trends." },
    { key: "cooldownBars", label: "Cooldown bars", type: "int", min: 1, max: 60, step: 1, default: 3, group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, volume: V, tday } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const vw = vwap(H, L, C, V, tday);
    const adxArr = p.adxMax > 0 ? adx(H, L, C, 14).adx : null;

    const fade = p.direction === "fade";
    const sig = new Int8Array(n);
    const upBand = new Float64Array(n).fill(NaN);
    const dnBand = new Float64Array(n).fill(NaN);
    let last = -Infinity;

    for (let i = 1; i < n; i++) {
      if (!Number.isFinite(a[i]) || a[i] <= 0) continue;
      upBand[i] = vw[i] + p.devMin * a[i];
      dnBand[i] = vw[i] - p.devMin * a[i];

      if (i - last < p.cooldownBars) continue;
      if (adxArr && adxArr[i] > p.adxMax) continue;

      const dev = (C[i] - vw[i]) / a[i];        // deviation in ATR units
      const mag = Math.abs(dev);
      if (mag < p.devMin) continue;
      if (p.devMax > 0 && mag > p.devMax) continue;

      const above = dev > 0;
      sig[i] = fade ? (above ? -1 : 1) : (above ? 1 : -1);
      last = i;
    }

    return {
      sig,
      atr: a,
      overlays: [
        { name: "Session VWAP", pane: "price", color: "#4aa3ff", data: vw },
        { name: `VWAP +${p.devMin}×ATR`, pane: "price", color: "#3d7a5a", data: upBand, dash: [4, 3] },
        { name: `VWAP −${p.devMin}×ATR`, pane: "price", color: "#7a3d3d", data: dnBand, dash: [4, 3] },
      ],
    };
  },
};
