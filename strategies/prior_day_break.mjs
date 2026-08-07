// Prior-day high/low break — intraday-native, designed for the flatten deadline.
//
// Yesterday's high and low are the levels every discretionary trader on the
// instrument can see, which makes them genuine decision points rather than a
// statistic derived from price. Breaking one is a commitment; failing at one is
// a rejection. Both are tradeable, and `direction` picks which theory you want.
//
// WHY THIS SHAPE: the whole library collapsed under the 3:05 PM CT flatten
// because its books needed a median 6.5 hours to reach target while losing in
// 1.0 hour. Anything designed for this account has to resolve inside a session.
// This one references a level fixed before the session even opens, so the setup
// exists from the first bar and does not need hours of range-building first.
//
// Untested. A structurally-motivated starting point, not a result.

import { atr } from "../src/indicators.mjs";

export default {
  id: "prior_day_break",
  name: "Prior-Day High/Low Break or Reject",
  description: "Trades yesterday's high and low — the levels everyone can see. Break them for continuation or fade the rejection. Intraday-native, so the 3:05 PM CT flatten costs it little.",

  timeframeMin: 5,
  warmupBars: 600,
  execDefaults: { slAtrMult: 1.5, tpAtrMult: 3, contracts: 8, sizingMode: "fixed" },

  params: [
    { key: "direction", label: "At the level", type: "select", default: "break",
      options: [["break", "Break it (continuation)"], ["reject", "Reject it (fade)"]], group: "Signal" },
    { key: "bufferAtrMult", label: "Confirmation beyond level (× ATR)", type: "float", min: 0, max: 2, step: 0.05, default: 0.15, group: "Signal",
      hint: "How decisively price must clear the level before it counts." },
    { key: "startCt", label: "No entries before (CT)", type: "time", min: 0, max: 1439, step: 5, default: 8 * 60 + 30, group: "Signal" },
    { key: "endCt", label: "No entries after (CT)", type: "time", min: 0, max: 1439, step: 5, default: 13 * 60 + 30, group: "Signal" },
    { key: "onePerSide", label: "Trades per day", type: "select", default: "one",
      options: [["one", "First touch each way"], ["many", "Every touch"]], group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, ctMin, tday } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const sig = new Int8Array(n);
    const hiLine = new Float64Array(n).fill(NaN);
    const loLine = new Float64Array(n).fill(NaN);

    // Levels come from the COMPLETED previous session only — never from bars the
    // signal has not reached yet.
    let curDay = -1, dayHi = -Infinity, dayLo = Infinity;
    let prevHi = NaN, prevLo = NaN;
    let tookLong = false, tookShort = false;
    const brk = p.direction === "break";

    for (let i = 1; i < n; i++) {
      if (tday[i] !== curDay) {
        if (curDay !== -1) { prevHi = dayHi; prevLo = dayLo; }
        curDay = tday[i];
        dayHi = -Infinity; dayLo = Infinity;
        tookLong = false; tookShort = false;
      }
      if (H[i] > dayHi) dayHi = H[i];
      if (L[i] < dayLo) dayLo = L[i];

      if (!Number.isFinite(prevHi) || !Number.isFinite(a[i]) || a[i] <= 0) continue;
      hiLine[i] = prevHi; loLine[i] = prevLo;

      const ct = ctMin ? ctMin[i] : 0;
      if (ct < p.startCt || ct >= p.endCt) continue;

      const buf = p.bufferAtrMult * a[i];
      const once = p.onePerSide === "one";

      if (C[i] > prevHi + buf && (!once || !tookLong)) {
        sig[i] = brk ? 1 : -1; tookLong = true;
      } else if (C[i] < prevLo - buf && (!once || !tookShort)) {
        sig[i] = brk ? -1 : 1; tookShort = true;
      }
    }

    return {
      sig,
      atr: a,
      overlays: [
        { name: "Prior day high", pane: "price", color: "#3d7a5a", data: hiLine, dash: [7, 3] },
        { name: "Prior day low", pane: "price", color: "#7a3d3d", data: loLine, dash: [7, 3] },
      ],
    };
  },
};
