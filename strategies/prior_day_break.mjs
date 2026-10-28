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
import { chk, trig, verdict, inWindow, mark, num, px, dayStart, COLOR } from "../src/explain.mjs";

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

    // Bar k as the loop reads it: the completed session's high and low (its bars
    // from bar 1 on, as the loop starts), the window, the confirmation buffer,
    // and -- one per side -- whether that side has already traded today.
    const explain = (k) => {
      const none = (text) => ({ dir: 0, checks: [trig("A completed prior session", false, { text })], marks: [] });
      if (k < 1) return none("the first bar");
      // the loop's first session is bar 1's, and has no completed one before it
      if (tday[k] === tday[1]) return none("this is the first session");
      const s0 = dayStart(tday, k);
      const p0 = Math.max(1, dayStart(tday, s0 - 1));
      let hi = -Infinity, lo = Infinity;
      for (let j = p0; j < s0; j++) { if (H[j] > hi) hi = H[j]; if (L[j] < lo) lo = L[j]; }
      if (!(Number.isFinite(a[k]) && a[k] > 0)) return none("ATR not ready");
      const ct = ctMin ? ctMin[k] : 0, buf = p.bufferAtrMult * a[k], once = p.onePerSide === "one";
      // a side is spent once it has fired today (the loop's tookLong / tookShort)
      const highSide = (j) => (brk ? sig[j] === 1 : sig[j] === -1);
      let tookHigh = false, tookLow = false;
      for (let j = Math.max(1, s0); j < k; j++) if (sig[j]) { if (highSide(j)) tookHigh = true; else tookLow = true; }
      const upB = C[k] > hi + buf, dnB = C[k] < lo - buf;
      const side = upB && (!once || !tookHigh) ? 1 : dnB && (!once || !tookLow) ? -1 : 0;
      const checks = [inWindow(ct, p.startCt, p.endCt, "Entries"),
                      trig(side ? `Close ${side === 1 ? "above the prior high" : "below the prior low"} by ${num(p.bufferAtrMult)} × ATR` : "Close beyond the prior day's range", !!side,
                           { text: side === 1 ? `${px(C[k])} > ${px(hi)} + ${num(buf)}` : side === -1 ? `${px(C[k])} < ${px(lo)} − ${num(buf)}` : `${px(C[k])} within ${px(lo - buf)} – ${px(hi + buf)}` })];
      if (once && (upB || dnB) && !side) checks.push(chk("First touch that way today", false, { text: "that side already traded" }));
      const lvl = side === 1 ? hi : lo;
      const marks = side ? [mark.level(lvl, s0, k, `prior ${side === 1 ? "high" : "low"} ${px(lvl)}`, { color: side === 1 ? COLOR.up : COLOR.down }),
                            mark.level(lvl + side * buf, k - 8, k, `+ buffer`, { color: COLOR.level, dash: [3, 3] }),
                            mark.dot(k, C[k], `close ${px(C[k])}`, { color: COLOR.close })] : [];
      const cand = side ? (brk ? side : -side) : 0;
      return { dir: verdict(cand, checks), checks, marks,
               title: side ? `${brk ? "Break" : "Rejection"} of the prior day's ${side === 1 ? "high" : "low"} → ${cand === 1 ? "long" : "short"}` : "No prior-day level crossed" };
    };

    return {
      sig,
      atr: a,
      overlays: [
        { name: "Prior day high", pane: "price", color: "#3d7a5a", data: hiLine, dash: [7, 3] },
        { name: "Prior day low", pane: "price", color: "#7a3d3d", data: loLine, dash: [7, 3] },
      ],
      explain,
    };
  },
};
