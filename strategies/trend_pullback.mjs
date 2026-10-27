// TREND PULLBACK — EMA trend, ADX strength, an RSI or MACD dip, ADR room.
//
// Built for the $1,250 evaluation, where the day blocks (+$250 / -$200) make one
// good trade a day the whole game. The idea generalises the $1,250 MACD fade,
// whose edge turned out to be a pullback entry: trade WITH a trend, at the
// moment a short-term oscillator says price is pulling back against it.
//
//   trend     a fast / slow EMA pair on a longer timeframe (default the
//             10-minute 9 / 21, the Donchian bot's filter), read from its last
//             closed bar. No trend, no trade.
//   strength  ADX on the signal bars at least `adxMin` (0 = off).
//   trigger   in the trend's direction, one of:
//               macdDip   the MACD histogram crosses AGAINST the trend -- the
//                         pullback starting (the MACD fade's trigger)
//               macdTurn  the histogram crosses back WITH the trend -- it ending
//               rsiDip    RSI drops through its lower level in an uptrend (rises
//                         through its upper one in a downtrend)
//               rsiTurn   RSI comes back through that level
//   room      the day's RTH range so far at most `maxAdrUsed` of its average
//             ("ADR used", 0 = off): a late pullback has less room to resume.
//   busy      optionally, the ATR at least `minVolRatio` of its 10-session RTH
//             average.
//   per day   only the first `firstN` qualifying signals (0 = all).
// Exits are the engine's -- stop and target in ATRs, the $600 day line, the stale
// exit, an opposite signal, flat 15:05 CT -- and, with `exitOn: macdCross`, the
// next MACD histogram cross of any kind, as the MACD fade exits: a long bought
// as the histogram crossed down leaves when it crosses back up, the pullback over.
//
// ── WHAT THE SEARCH FOUND (research/combos_1250_new.mjs, $1,250 rules) ──
// 2,304 configurations on the lab's 2026 (Jan 2 - Jul 14). The defaults are the
// one with the best WORST half of 2026:
//   - buy an RSI(7) dip below 40, or sell a rise above 60, with the 5-minute
//     EMA 9 / 21;
//   - ADX >= 20, the day's range used at most 0.9 of its average, the ATR at
//     least its 10-session average;
//   - out at the next MACD histogram cross, the 5 ATR stop, or the 5.15 ATR
//     target capped at $600;
//   - market entries, 1-minute bars.
// Results:
//   2026     calendar 72.1% (Jan-Mar 82.2, Apr-Jul 60.0), bootstrap 72.4%
//            (69.2 / 73.6); 170 trades, 68% won, +$106 a trade, PF 1.83.
//   null     the coin-flip twin passes 31.2%; none of 20 seeds reached 72.1%.
//   halves   the grid's best on Jan-Mar scored 24.2 on Apr-Jul, and the best on
//            Apr-Jul 46.1 on Jan-Mar. The choice also used both halves, so it
//            had no holdout of its own.
//   forward  TopstepX bars, Sep 10 - Oct 26 2026, which the search never saw
//            (research/forward_1250.mjs): 51 trades, -$2,162, PF 0.76, 5.9% of
//            windows passed. That is WORSE than its coin-flip twin; 17 of 20
//            twins netted more.
// The MACD fade, the same opening-pullback structure, lost over those days too.
// Read this book as a pattern of early 2026 that has stopped paying, not as one
// to trade. The trigger matters most here: the best worst half with the MACD
// dip was 60.6, and with the RSI turn 57.6.

import { atr, adx, rsi, macd, rthRangeUsed, rthAtrRatio } from "../src/indicators.mjs";
import { htfEmaTrend } from "../src/studies.mjs";

const TRIGGERS = [["macdDip", "MACD histogram crosses against the trend (pullback starts)"], ["macdTurn", "MACD histogram crosses back with the trend (pullback ends)"],
                  ["rsiDip", "RSI through its level against the trend"], ["rsiTurn", "RSI back through its level with the trend"]];

export default {
  id: "trend_pullback",
  name: "Trend pullback — EMA trend + ADX + RSI/MACD dip + ADR room",
  description: "Trades with a higher-timeframe EMA trend when a short-term MACD or RSI pullback fires against it, if ADX shows strength and the day has range left (ADR used). Built for the $1,250 eval. Strong in Jan-Jul 2026, but it lost forward (Sep-Oct 2026), as the MACD fade did.",

  timeframeMin: 1,
  warmupBars: (p) => Math.max(400, 10 * (Math.trunc(p.adxPeriod) || 14), 30 * (Math.trunc(p.rsiLen) || 14)),
  warmupSessions: (p) => Math.max(Math.trunc(p.adrDays) || 10, Math.trunc(p.volDays) || 10) + 3,

  execDefaults: {
    contracts: 4, sizingMode: "fixed",
    slAtrMult: 5, tpMode: "atr", tpAtrMult: 5.15, tpMaxUsd: 600,
    flipOnOpposite: true, sameBarReentry: false,
    entryType: "market",
    intradayOnly: true, flattenCt: 15 * 60 + 5, reopenCt: 17 * 60, noEntryMinsBeforeFlat: 10,
    commissionModel: "per-contract", commissionPerSide: 0.75, slippageTicks: 1,
    dayLossStopUsd: 600, dayLossStopMode: "exact",
    dayBreakerUsd: 200, dayProfitBlockUsd: 250,
  },
  rulesDefaults: { circuitBreaker: 0, dailyProfitStop: 0 },

  params: [
    { key: "trendTf", label: "Trend timeframe (min)", type: "int", min: 1, max: 60, step: 1, default: 5, group: "Trend",
      hint: "The EMA pair runs on bars this long, built from the signal bars, and is read from the last one that had closed." },
    { key: "trendFast", label: "Trend EMA fast", type: "int", min: 2, max: 200, step: 1, default: 9, group: "Trend" },
    { key: "trendSlow", label: "Trend EMA slow", type: "int", min: 3, max: 400, step: 1, default: 21, group: "Trend" },
    { key: "adxMin", label: "ADX minimum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 20, group: "Trend" },
    { key: "adxPeriod", label: "ADX period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Trend" },
    { key: "trigger", label: "Pullback trigger", type: "select", default: "rsiDip", group: "Trigger", options: TRIGGERS },
    { key: "macdFast", label: "MACD fast", type: "int", min: 2, max: 100, step: 1, default: 12, group: "Trigger" },
    { key: "macdSlow", label: "MACD slow", type: "int", min: 3, max: 200, step: 1, default: 26, group: "Trigger" },
    { key: "macdSignal", label: "MACD signal", type: "int", min: 2, max: 50, step: 1, default: 9, group: "Trigger" },
    { key: "rsiLen", label: "RSI length", type: "int", min: 2, max: 50, step: 1, default: 7, group: "Trigger" },
    { key: "rsiLo", label: "RSI lower level (uptrend)", type: "int", min: 5, max: 50, step: 1, default: 40, group: "Trigger" },
    { key: "rsiHi", label: "RSI upper level (downtrend)", type: "int", min: 50, max: 95, step: 1, default: 60, group: "Trigger" },
    { key: "exitOn", label: "Also exit on", type: "select", default: "macdCross", group: "Trigger",
      options: [["macdCross", "The next MACD histogram cross (as the MACD fade)"], ["bracket", "Nothing more: the bracket and the session"]] },
    { key: "maxAdrUsed", label: "Day's range used at most (x ADR, 0 = off)", type: "float", min: 0, max: 3, step: 0.05, default: 0.9, group: "Room" },
    { key: "adrDays", label: "ADR over (sessions)", type: "int", min: 2, max: 40, step: 1, default: 10, group: "Room" },
    { key: "minVolRatio", label: "ATR / its RTH average, min (0 = off)", type: "float", min: 0, max: 3, step: 0.05, default: 1, group: "Room" },
    { key: "volDays", label: "ATR average over (sessions)", type: "int", min: 2, max: 40, step: 1, default: 10, group: "Room" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 100, step: 1, default: 14, group: "Room" },
    { key: "firstN", label: "Signals per day (0 = all)", type: "int", min: 0, max: 20, step: 1, default: 0, group: "Session" },
    { key: "startCt", label: "Signals from (CT)", type: "time", min: 0, max: 1439, step: 5, default: 8 * 60 + 30, group: "Session" },
    { key: "endCt", label: "Signals until (CT)", type: "time", min: 0, max: 1440, step: 5, default: 15 * 60, group: "Session" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, ctMin: CT, tday: TD } = bars, n = C.length;
    const a = atr(H, L, C, Math.max(2, Math.trunc(p.atrPeriod) || 14));
    const tr = htfEmaTrend(bars, p.trendTf, p.trendFast, p.trendSlow);
    const ax = p.adxMin > 0 ? adx(H, L, C, Math.max(2, Math.trunc(p.adxPeriod) || 14)).adx : null;
    const mFast = Math.max(2, Math.trunc(p.macdFast) || 12);
    const m = macd(C, mFast, Math.max(mFast + 1, Math.trunc(p.macdSlow) || 26), Math.max(2, Math.trunc(p.macdSignal) || 9));
    const r = rsi(C, Math.max(2, Math.trunc(p.rsiLen) || 7));
    const used = p.maxAdrUsed > 0 ? rthRangeUsed(bars, Math.max(2, Math.trunc(p.adrDays) || 10)) : null;
    const vr = p.minVolRatio > 0 ? rthAtrRatio(bars, a, Math.max(2, Math.trunc(p.volDays) || 10)) : null;
    const h = m.hist, lo = p.rsiLo, hi = p.rsiHi;
    const sig = new Int8Array(n), exitSig = p.exitOn === "bracket" ? null : new Int8Array(n);
    let day = null, count = 0;
    for (let i = 1; i < n; i++) {
      if (exitSig && ((h[i] > 0 && h[i - 1] <= 0) || (h[i] < 0 && h[i - 1] >= 0))) exitSig[i] = 3;
      if (TD[i] !== day) { day = TD[i]; count = 0; }
      const ct = CT ? CT[i] : 0;
      if (!(ct >= p.startCt && ct < p.endCt)) continue;
      const d = tr.dir[i];
      if (!d) continue;
      let fire;
      switch (p.trigger) {
        case "macdTurn": fire = d === 1 ? h[i] > 0 && h[i - 1] <= 0 : h[i] < 0 && h[i - 1] >= 0; break;
        case "rsiDip": fire = d === 1 ? r[i] < lo && r[i - 1] >= lo : r[i] > hi && r[i - 1] <= hi; break;
        case "rsiTurn": fire = d === 1 ? r[i] >= lo && r[i - 1] < lo : r[i] <= hi && r[i - 1] > hi; break;
        default: fire = d === 1 ? h[i] < 0 && h[i - 1] >= 0 : h[i] > 0 && h[i - 1] <= 0;   // macdDip
      }
      if (!fire) continue;
      if (ax && !(ax[i] >= p.adxMin)) continue;
      if (used && !(used[i] <= p.maxAdrUsed)) continue;
      if (vr && vr[i] < p.minVolRatio) continue;
      if (p.firstN > 0 && count >= p.firstN) continue;
      count++;
      sig[i] = d;
      // A cross that is also a signal exits by flipping, as the MACD fade's do:
      // an exit signal there would close the trade and drop the new entry.
      if (exitSig) exitSig[i] = 0;
    }
    const isMacd = p.trigger === "macdDip" || p.trigger === "macdTurn" || exitSig;
    return {
      sig, atr: a, ...(exitSig ? { exitSig } : {}),
      overlays: [
        { name: `${tr.tf}m EMA ${p.trendFast}`, pane: "price", data: tr.fast, color: "#f0b429" },
        { name: `${tr.tf}m EMA ${p.trendSlow}`, pane: "price", data: tr.slow, color: "#c678dd", dash: [5, 3] },
        ...(isMacd
          ? [{ name: "MACD hist", pane: "sub", kind: "hist", data: h, autoRange: true, colorUp: "#26a65b", colorUpFade: "#7fd4a0", colorDown: "#d1566e", colorDownFade: "#eda2b0" }]
          : [{ name: `RSI ${p.rsiLen}`, pane: "sub", data: r, color: "#c678dd", range: [0, 100], threshold: 50 }]),
      ],
    };
  },
};
