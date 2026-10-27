// MACD FADE — the $1,250 book (tradovate/mnqMacdFade1250.js), 1-minute bars.
//
// The 1-minute MACD(12, 26, 9) histogram crosses zero inside 08:30-15:00 CT and
// the trade goes the OTHER way: a cross up is a sell. Two conditions decide
// which crosses are faded, and both refuse only the ENTRY -- every cross still
// closes the open trade and cancels a resting order the other way:
//   weak    the MACD line is already on the fade's side of zero, so the cross
//           is a bounce against the short-term trend. A strong cross (the
//           trend resuming) keeps going and is not faded.
//   moving  the 1-minute ATR(14) is at least the average of the previous 10
//           sessions' 08:30-15:00 ATR. Fades in a quiet market lose.
// So it is really a pullback entry: with the MACD line's trend, against the
// histogram's bounce.
//
// The rest is the indicator's: 4 lots; a stop 0.15 x ATR beyond the next open,
// working 10 bars and re-placed as a limit when refused; stop 5 x ATR, cut to
// the $600 day line; target 5.15 x ATR from the fill, at most $600 on the
// position (75 points at 4 lots); the next cross exits; -$200 breaker, +$250
// profit block, flat 15:05 CT.
//
// ── WHERE THE EDGE IS (research/macd_anatomy_2026.mjs, macd_optimize_2026.mjs)
// The fade has no average edge (-0.7 points a trade over 2,979 fills). It is the
// FIRST fade of the day: +10.6 points [+2.1, +19.6], and 121 of 172 trades and
// +$13.9k of +$16.1k come 08:30-09:00 -- the liquidity premium of the open. The
// day blocks make it an opening strategy. Research (lib_shipped, bootstrap,
// 2026): 67.7% (Jan-Mar 64.8, Apr-Jul 73.8) against 58.6% fading every cross.
// Forward, Sep 1 - Oct 22 2026 on TopstepX bars, it lost $1,803 and its
// coin-flip twin did better: treat the 2026 figures as a regime, not a law.
//
// The lab runs the physically consistent fills (src/engine.mjs DEFAULT_EXEC):
// an open gapping through a target or entry fills at the open, an early close
// flattens, a fired platform cap ends the day. The research engine ran the older
// conventions. The lab's figures on the $1,250 rules (research/combos_1250.mjs,
// forward_1250.mjs):
//   2026      calendar 55.8% (Jan-Mar 60.0, Apr-Jul 50.7), bootstrap 67.7%
//             (62.8 / 74.3), the research's 67.7% exactly; 172 trades.
//   null      its coin-flip twin passes 37.6%.
//   forward   Sep 10 - Oct 26 2026: 56 trades, -$2,160, PF 0.78, calendar 17.6%,
//             below its twin.
// 30 EMA, RSI, ADR and ADX variations found nothing robustly better.

import { macd, atr, rthAtrRatio } from "../src/indicators.mjs";

export default {
  id: "macd_fade_1250",
  name: "MACD fade — $1,250 book (1-min weak crosses, busy days)",
  description: "The shipped $1,250 MACD fade: fade a 1-min MACD histogram cross when the MACD line is already on the fade's side (a bounce against the short-term trend) and the 1-min ATR is at least its 10-session RTH average. 4 lots, stop-entry 0.15 ATR, 5 ATR stop cut at the $600 line, target 5.15 ATR capped at $600, next cross exits, -$200 / +$250 day blocks.",

  timeframeMin: 1,
  warmupBars: 400,
  // the ATR average looks back 10 RTH sessions
  warmupSessions: (p) => (Math.trunc(p.volDays) || 10) + 3,

  execDefaults: {
    contracts: 4, sizingMode: "fixed",
    slAtrMult: 5, tpMode: "atr", tpAtrMult: 5.15, tpMaxUsd: 600, tpFromFill: true,
    flipOnOpposite: true, sameBarReentry: false,
    entryType: "stop", entryTriggerAtr: 0.15, entryWindowBars: 10, entryRefused: "limit", cancelOpposite: true,
    limitFillTp: "close",
    intradayOnly: true, flattenCt: 15 * 60 + 5, reopenCt: 17 * 60, noEntryMinsBeforeFlat: 10,
    commissionModel: "per-contract", commissionPerSide: 0.75, slippageTicks: 1,
    // the platform's daily loss liquidation; the eval tab sets it to its limit
    dayLossStopUsd: 600, dayLossStopMode: "exact",
    dayBreakerUsd: 200, dayProfitBlockUsd: 250,
  },
  // the engine applies the breaker and block, so the rules layer's copies are off
  rulesDefaults: { circuitBreaker: 0, dailyProfitStop: 0 },

  params: [
    { key: "fast", label: "MACD fast", type: "int", min: 2, max: 100, step: 1, default: 12, group: "MACD" },
    { key: "slow", label: "MACD slow", type: "int", min: 3, max: 200, step: 1, default: 26, group: "MACD" },
    { key: "signal", label: "MACD signal", type: "int", min: 2, max: 50, step: 1, default: 9, group: "MACD" },
    { key: "weakOnly", label: "Fade only weak crosses", type: "select", default: "on", group: "Gates",
      options: [["on", "Yes: the MACD line already on the fade's side"], ["off", "No: every cross"]],
      hint: "58.6% -> 67.7% with the volatility gate (research, 2026)." },
    { key: "minVolRatio", label: "ATR / its 10-session RTH average, min (0 = off)", type: "float", min: 0, max: 3, step: 0.05, default: 1, group: "Gates",
      hint: "Fades in a quiet market lose. Plateau 0.8-1.1x in the research." },
    { key: "volDays", label: "ATR average over (sessions)", type: "int", min: 2, max: 40, step: 1, default: 10, group: "Gates" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 100, step: 1, default: 14, group: "Gates" },
    { key: "startCt", label: "Signals from (CT)", type: "time", min: 0, max: 1439, step: 5, default: 8 * 60 + 30, group: "Session" },
    { key: "endCt", label: "Signals until (CT)", type: "time", min: 0, max: 1440, step: 5, default: 15 * 60, group: "Session" },
  ],

  compute(bars, p) {
    const C = bars.close, n = C.length, CT = bars.ctMin;
    const fast = Math.max(2, Math.trunc(p.fast) || 12), slow = Math.max(fast + 1, Math.trunc(p.slow) || 26);
    const { line, signal, hist } = macd(C, fast, slow, Math.max(2, Math.trunc(p.signal) || 9));
    const a = atr(bars.high, bars.low, C, Math.max(2, Math.trunc(p.atrPeriod) || 14));
    const vr = p.minVolRatio > 0 ? rthAtrRatio(bars, a, Math.max(2, Math.trunc(p.volDays) || 10)) : null;
    const sig = new Int8Array(n), sizeMult = new Float64Array(n).fill(1);
    for (let i = 1; i < n; i++) {
      const ct = CT ? CT[i] : 0;
      if (!(ct >= p.startCt && ct < p.endCt)) continue;
      const up = hist[i] > 0 && hist[i - 1] <= 0, dn = hist[i] < 0 && hist[i - 1] >= 0;
      if (!up && !dn) continue;
      const d = up ? -1 : 1;                       // fade the cross
      sig[i] = d;
      if (p.weakOnly !== "off" && Math.sign(line[i]) !== d) sizeMult[i] = 0;
      if (vr && vr[i] < p.minVolRatio) sizeMult[i] = 0;   // no history yet (NaN) trades, as the research did
    }
    return {
      sig, atr: a, sizeMult,
      overlays: [
        { name: "MACD hist", pane: "sub", kind: "hist", data: hist, autoRange: true,
          colorUp: "#26a65b", colorUpFade: "#7fd4a0", colorDown: "#d1566e", colorDownFade: "#eda2b0" },
        { name: "MACD", pane: "sub", data: line, color: "#4aa3ff", autoRange: true },
        { name: "Signal", pane: "sub", data: signal, color: "#e0894a", autoRange: true },
      ],
    };
  },
};
