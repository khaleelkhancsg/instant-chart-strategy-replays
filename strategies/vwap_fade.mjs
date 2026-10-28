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
import { chk, trig, verdict, cooldown, spark, mark, num, px, adxAtMost, COLOR } from "../src/explain.mjs";

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
    { key: "adxPeriod", label: "ADX period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, volume: V, tday } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const vw = vwap(H, L, C, V, tday);
    const adxArr = p.adxMax > 0 ? adx(H, L, C, Math.max(2, Math.trunc(p.adxPeriod) || 14)).adx : null;

    const fade = p.direction === "fade";
    const sig = new Int8Array(n);
    const upBand = new Float64Array(n).fill(NaN);
    const dnBand = new Float64Array(n).fill(NaN);
    let last = -Infinity, day = -1;

    for (let i = 1; i < n; i++) {
      if (!Number.isFinite(a[i]) || a[i] <= 0) continue;
      upBand[i] = vw[i] + p.devMin * a[i];
      dnBand[i] = vw[i] - p.devMin * a[i];

      // The cooldown restarts each session, so signal spacing never reaches back before today.
      if (tday[i] !== day) { day = tday[i]; last = -Infinity; }
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

    // Bar k as the loop reads it: the cooldown, the ADX ceiling, then the
    // distance from VWAP in ATRs against the band, faded or followed.
    const explain = (k) => {
      const ok = k >= 1 && Number.isFinite(a[k]) && a[k] > 0;
      const dev = ok ? (C[k] - vw[k]) / a[k] : NaN, mag = Math.abs(dev), above = dev > 0;
      const far = ok && !(mag < p.devMin);
      const checks = [trig(`Close at least ${num(p.devMin)} × ATR from VWAP`, far,
                           { text: ok ? `${above ? "+" : "−"}${num(mag)} × ATR (${px(C[k])} vs VWAP ${px(vw[k])})` : "ATR not ready",
                             spark: spark(k, [[C, COLOR.close, "close"], [vw, COLOR.line, "VWAP"], [above ? upBand : dnBand, above ? COLOR.up : COLOR.down, "band"]]) })];
      if (p.devMax > 0) checks.push(chk(`At most ${num(p.devMax)} × ATR`, !(mag > p.devMax), { text: `${num(mag)} × ATR` }));
      if (adxArr) checks.push(adxAtMost(adxArr, k, p.adxMax, Math.max(2, Math.trunc(p.adxPeriod) || 14)));
      checks.push(cooldown(sig, tday, k, p.cooldownBars));
      const cand = far ? (fade ? (above ? -1 : 1) : (above ? 1 : -1)) : 0;
      const marks = far ? [mark.level(vw[k], k - 12, k, `VWAP ${px(vw[k])}`, { color: COLOR.line }),
                           mark.level(above ? upBand[k] : dnBand[k], k - 12, k, `${above ? "+" : "−"}${num(p.devMin)} × ATR`, { color: above ? COLOR.up : COLOR.down }),
                           mark.dot(k, C[k], `close ${px(C[k])}`, { color: COLOR.close })] : [];
      return { dir: verdict(cand, checks.filter(Boolean)), checks: checks.filter(Boolean), marks,
               title: far ? `${num(mag)} × ATR ${above ? "above" : "below"} VWAP: ${fade ? "fade" : "follow"} → ${cand === 1 ? "long" : "short"}` : "Near VWAP" };
    };

    return {
      sig,
      atr: a,
      overlays: [
        { name: "Session VWAP", pane: "price", color: "#4aa3ff", data: vw },
        { name: `VWAP +${p.devMin}×ATR`, pane: "price", color: "#3d7a5a", data: upBand, dash: [4, 3] },
        { name: `VWAP −${p.devMin}×ATR`, pane: "price", color: "#7a3d3d", data: dnBand, dash: [4, 3] },
      ],
      explain,
    };
  },
};
