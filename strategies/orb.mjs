// Opening-Range Breakout — session-anchored rather than indicator-anchored.
//
// Each day, mark the high and low of an opening window, then take the first break
// of that range in each direction. The premise is that the opening range frames
// the day's initial balance, and a decisive break of it tends to extend.
//
// WHY THIS ONE IS WORTH YOUR ATTENTION UNDER THE NO-OVERNIGHT RULE:
// every other book here was tuned holding positions through the close, and the
// 3:05 PM CT deadline destroys them because it truncates 37% of their winners.
// ORB is intraday by construction — it opens after the bell and is designed to
// resolve the same session, so the deadline costs it far less. In the lite
// backtester this was also the single best book on the pure total-drawdown
// challenge (~46.7% pass) with the strongest per-trade edge of anything there
// (profit factor ~1.16), and only ~0.3 correlated with the Donchian trend book.
//
// Times are in CT to match the session rules elsewhere in this tool. The RTH open
// is 8:30 AM CT (9:30 ET), so the default opening range is 8:30-9:00 CT.
//
// Recommended starting execution (from the lite backtester's validated config,
// adjusted to CT): 2.5xATR stop, 10xATR target — opening breaks that work run.
// Cut the target hard if you need it to resolve before 3:05 PM.

import { atr } from "../src/indicators.mjs";
import { chk, trig, verdict, mark, num, px, dayStart, clock, COLOR } from "../src/explain.mjs";

export default {
  id: "orb",
  name: "Opening Range Breakout (session-anchored)",
  description: "Marks each day's opening range in CT, then takes the first break each way. Intraday by design, so the 3:05 PM CT flatten costs it far less than the trend books.",

  timeframeMin: 5,
  warmupBars: 200,
  execDefaults: { slAtrMult: 2.5, tpAtrMult: 10, contracts: 6, sizingMode: "fixed" },

  params: [
    { key: "orStartCt", label: "Opening range starts (CT)", type: "time", min: 0, max: 1439, step: 5, default: 8 * 60 + 30, group: "Signal" },
    { key: "orEndCt", label: "Opening range ends (CT)", type: "time", min: 0, max: 1439, step: 5, default: 9 * 60, group: "Signal" },
    { key: "entryEndCt", label: "Last entry (CT)", type: "time", min: 0, max: 1439, step: 5, default: 14 * 60, group: "Signal",
      hint: "Stop taking new breaks after this, so trades have room before the flatten." },
    { key: "direction", label: "On a break", type: "select", default: "break",
      options: [["break", "Go with it (continuation)"], ["fade", "Fade it (failed break)"]], group: "Signal",
      hint: "Failed opening-range breaks are a real setup in their own right — worth testing both ways." },
    { key: "onePerSide", label: "Trades per day", type: "select", default: "one",
      options: [["one", "First break each way only"], ["many", "Every break"]], group: "Signal" },
    { key: "minRangePts", label: "Minimum range (points)", type: "float", min: 0, max: 200, step: 1, default: 0, group: "Signal",
      hint: "Skip days whose opening range is too tight to mean anything." },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, ctMin, tday } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const sig = new Int8Array(n);

    // Draw the levels so the range is visible on the chart, not just implied.
    const hiLine = new Float64Array(n).fill(NaN);
    const loLine = new Float64Array(n).fill(NaN);

    let curDay = -1, orHi = -Infinity, orLo = Infinity;
    let tookLong = false, tookShort = false, rangeReady = false;

    for (let i = 0; i < n; i++) {
      const ct = ctMin ? ctMin[i] : 0;
      if (tday[i] !== curDay) {
        curDay = tday[i];
        orHi = -Infinity; orLo = Infinity;
        tookLong = false; tookShort = false; rangeReady = false;
      }

      if (ct >= p.orStartCt && ct < p.orEndCt) {
        if (H[i] > orHi) orHi = H[i];
        if (L[i] < orLo) orLo = L[i];
        continue;                       // never trade while still building it
      }

      if (!rangeReady && ct >= p.orEndCt && Number.isFinite(orHi) && orLo !== Infinity) {
        rangeReady = orHi - orLo >= p.minRangePts;
      }
      if (!rangeReady) continue;

      hiLine[i] = orHi; loLine[i] = orLo;
      if (ct >= p.entryEndCt) continue;

      const once = p.onePerSide === "one";
      const brk = p.direction !== "fade";
      if (C[i] > orHi && (!once || !tookLong)) { sig[i] = brk ? 1 : -1; tookLong = true; }
      else if (C[i] < orLo && (!once || !tookShort)) { sig[i] = brk ? -1 : 1; tookShort = true; }
    }

    // Bar k, replaying the session's opening range up to it exactly as the loop
    // builds it: the range, its minimum size, the last entry time, the close
    // beyond it, and -- one per side -- whether that side has gone already.
    const explain = (k) => {
      const s0 = dayStart(tday, k);
      let hi = -Infinity, lo = Infinity, ready = false, o0 = -1, o1 = -1, tookUp = false, tookDn = false;
      const once = p.onePerSide === "one", brk = p.direction !== "fade";
      for (let j = s0; j <= k; j++) {
        const cj = ctMin ? ctMin[j] : 0;
        if (cj >= p.orStartCt && cj < p.orEndCt) { if (H[j] > hi) hi = H[j]; if (L[j] < lo) lo = L[j]; if (o0 < 0) o0 = j; o1 = j; continue; }
        if (!ready && cj >= p.orEndCt && Number.isFinite(hi) && lo !== Infinity) ready = hi - lo >= p.minRangePts;
        if (j < k && ready && cj < p.entryEndCt && sig[j]) { if ((sig[j] === 1) === brk) tookUp = true; else tookDn = true; }
      }
      const ct = ctMin ? ctMin[k] : 0;
      const building = ct >= p.orStartCt && ct < p.orEndCt;
      if (building || o0 < 0) return { dir: 0, checks: [trig("The opening range complete", false, { text: building ? "still building it" : `before ${clock(p.orStartCt)} CT` })], marks: [] };
      const checks = [chk(`Range at least ${num(p.minRangePts)} pts`, ready, { text: `${num(hi - lo)} pts (${px(lo)} – ${px(hi)})` }),
                      chk(`Last entry ${clock(p.entryEndCt)} CT`, !(ct >= p.entryEndCt), { text: `bar opens ${clock(ct)}` })];
      const up = C[k] > hi, dn = C[k] < lo;
      const side = up && (!once || !tookUp) ? 1 : dn && (!once || !tookDn) ? -1 : 0;
      checks.push(trig(side ? `Close ${side === 1 ? "above" : "below"} the opening range` : "Close beyond the opening range", !!side,
                       { text: side === 1 ? `${px(C[k])} > ${px(hi)}` : side === -1 ? `${px(C[k])} < ${px(lo)}` : `${px(C[k])} inside` }));
      if (once && (up || dn) && !side) checks.push(chk("The first break that way today", false, { text: "that side has gone already" }));
      const marks = [mark.zone(o0, o1, `opening range ${clock(p.orStartCt)}–${clock(p.orEndCt)}`),
                     mark.level(hi, o0, k, `OR high ${px(hi)}`, { color: COLOR.up }), mark.level(lo, o0, k, `OR low ${px(lo)}`, { color: COLOR.down })];
      if (side) marks.push(mark.dot(k, C[k], `close ${px(C[k])}`, { color: COLOR.close }));
      const cand = side ? (brk ? side : -side) : 0;
      return { dir: verdict(cand, checks), checks, marks,
               title: side ? `${brk ? "Break" : "Fade"} of the opening range ${side === 1 ? "high" : "low"} → ${cand === 1 ? "long" : "short"}` : "No opening-range break" };
    };

    return {
      sig,
      atr: a,
      overlays: [
        { name: "Opening range high", pane: "price", color: "#3d7a5a", data: hiLine, dash: [6, 3] },
        { name: "Opening range low", pane: "price", color: "#7a3d3d", data: loLine, dash: [6, 3] },
      ],
      explain,
    };
  },
};
