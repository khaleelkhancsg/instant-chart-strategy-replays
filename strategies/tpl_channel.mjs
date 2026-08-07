// TEMPLATE — Price channel, tradeable in either direction.
//
// The single most useful knob here is `direction`. The same channel supports two
// opposite theories, and which one works is a property of the market, not of the
// channel:
//
//   breakout  — price leaving the channel means the move continues. Wants a
//               trending regime; pair it with a high adxMin.
//   fade      — price leaving the channel means it is stretched and snaps back.
//               Wants a ranging regime; pair it with a LOW adxMax.
//
// Flipping that one setting turns this from a momentum book into a mean-reversion
// book, which is a genuinely useful thing to be able to A/B on the same chart.
//
// Three channel types, because they measure "stretched" differently:
//   donchian  — pure prior high/low. No distribution assumption at all.
//   bollinger — standard deviations of CLOSES. Ignores gaps and wicks.
//   keltner   — ATR bands around an EMA. Responds to true range, so gaps count.

import { atr, adx, donchian, bollinger, keltner } from "../src/indicators.mjs";

export default {
  id: "tpl_channel",
  name: "Template — Channel Breakout / Fade",
  description: "One channel, two opposite theories. Donchian, Bollinger or Keltner; trade the break for momentum or fade it for reversion; ADX floor and ceiling to pin it to a regime. A tuning starting point, not a validated strategy.",

  timeframeMin: 5,
  warmupBars: 500,
  execDefaults: { slAtrMult: 2, tpAtrMult: 6, contracts: 8, sizingMode: "fixed" },

  params: [
    { key: "channel", label: "Channel type", type: "select", default: "donchian",
      options: [["donchian", "Donchian (prior high/low)"], ["bollinger", "Bollinger (std of closes)"], ["keltner", "Keltner (ATR bands)"]], group: "Signal" },
    { key: "direction", label: "Trade the break", type: "select", default: "breakout",
      options: [["breakout", "With it (momentum)"], ["fade", "Against it (reversion)"]], group: "Signal",
      hint: "This one setting flips the whole character of the book." },
    { key: "period", label: "Channel length", type: "int", min: 5, max: 200, step: 1, default: 30, group: "Signal" },
    { key: "mult", label: "Band width (Bollinger/Keltner)", type: "float", min: 0.5, max: 5, step: 0.1, default: 2, group: "Signal" },
    { key: "adxMin", label: "ADX minimum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 25, group: "Signal",
      hint: "Raise for breakouts — they need a trend." },
    { key: "adxMax", label: "ADX maximum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 0, group: "Signal",
      hint: "Set this instead for fades — they need chop." },
    { key: "cooldownBars", label: "Cooldown bars", type: "int", min: 1, max: 60, step: 1, default: 1, group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const adxArr = (p.adxMin > 0 || p.adxMax > 0) ? adx(H, L, C, 14).adx : null;

    let up, dn, mid = null;
    if (p.channel === "bollinger") {
      const b = bollinger(C, p.period, p.mult);
      up = b.upper; dn = b.lower; mid = b.mid;
    } else if (p.channel === "keltner") {
      const k = keltner(H, L, C, p.period, p.mult, p.atrPeriod);
      up = k.upper; dn = k.lower; mid = k.mid;
    } else {
      const d = donchian(H, L, p.period);
      up = d.high; dn = d.low;
    }

    const fade = p.direction === "fade";
    const sig = new Int8Array(n);
    let last = -Infinity;
    for (let i = 1; i < n; i++) {
      if (i - last < p.cooldownBars) continue;
      if (!Number.isFinite(up[i]) || !Number.isFinite(dn[i])) continue;
      if (adxArr) {
        if (p.adxMin > 0 && adxArr[i] < p.adxMin) continue;
        if (p.adxMax > 0 && adxArr[i] > p.adxMax) continue;
      }
      let want = 0;
      if (C[i] > up[i]) want = fade ? -1 : 1;
      else if (C[i] < dn[i]) want = fade ? 1 : -1;
      if (want !== 0) { sig[i] = want; last = i; }
    }

    const overlays = [
      { name: `${p.channel} upper`, pane: "price", color: "#3d7a5a", data: up, dash: [4, 3] },
      { name: `${p.channel} lower`, pane: "price", color: "#7a3d3d", data: dn, dash: [4, 3] },
    ];
    if (mid) overlays.push({ name: "mid", pane: "price", color: "#5a6b7d", data: mid, dash: [2, 4] });
    if (adxArr) overlays.push({ name: "ADX", pane: "sub", color: "#c9a227", data: adxArr, threshold: p.adxMin || p.adxMax, range: [0, 60] });

    return { sig, atr: a, overlays };
  },
};
