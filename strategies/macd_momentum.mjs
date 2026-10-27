// MACD MOMENTUM — three growing histogram bars in, three shrinking bars out.
//
// The "3 bars" research, both ways. research/fade_bars_sweep.mjs found the win
// rate of a MACD trade peaks when it leaves after the histogram has moved closer
// to zero 3 bars in a row (the lighter shade three times); research/
// build_bars_sweep.mjs found waiting for the histogram to GROW before entering
// is the best entry change in that family. This book does both, and only with
// a trend:
//
//   entry     the histogram has grown away from zero `buildBars` bars in a row
//             since it crossed, on the side of the higher-timeframe EMA trend,
//             with ADX at least `adxMin` and the day's range used at most
//             `maxAdrUsed` of its average (each 0 = off)
//   exit      `fadeBars` shrinking bars on the trade's side (0 = off), or the
//             bracket, the $600 day line, the stale exit, flat 15:05 CT
//
// ── WHAT THE SEARCH FOUND (research/combos_1250_new.mjs, $1,250 rules) ──
// 576 configurations on the lab's 2026 (Jan 2 - Jul 14).
//   3 in, 3 out  the pure book (3 growing bars in, 3 shrinking bars out) is weak:
//                its best scored calendar 39.4%, bootstrap 35.7%, PF 0.92.
//   defaults     the grid's best worst half:
//                  - 5-minute bars, 2 growing bars, no fade exit (the bracket
//                    and the session instead);
//                  - the 30-minute EMA 9 / 21 trend, the day's range used at
//                    most 0.9.
//   2026         calendar 54.5% (Jan-Mar 57.8, Apr-Jul 50.7), bootstrap 48.6%;
//                100 trades, PF 1.21. The coin-flip twin passes 28.6%.
//   halves       picked on either half, the grid's best fell to 17-24% on the
//                other, and the choice's neighbours have a median worst half of 39:
//                a lone peak.
//   forward      Sep 10 - Oct 26 2026 on TopstepX bars: 26 trades, +$154,
//                PF 1.02, level with its twin.
// The MACD crossover family has a long record of losing in this project (a
// crossover is a lagging event); this book does not change it.

import { atr, adx, macd, rthRangeUsed } from "../src/indicators.mjs";
import { htfEmaTrend } from "../src/studies.mjs";

export default {
  id: "macd_momentum",
  name: "MACD momentum — growing histogram bars with the EMA trend (the 3-bar research)",
  description: "Enters once the MACD histogram has grown away from zero N bars in a row (default 2) on the side of the higher-timeframe EMA trend, with room left in the day's range; optionally leaves after N shrinking bars (the 3-bar fade exit, off by default). Built for the $1,250 eval; validated neither in the half-split nor forward.",

  timeframeMin: 5,
  warmupBars: (p) => Math.max(400, 10 * (Math.trunc(p.adxPeriod) || 14)),
  warmupSessions: (p) => (Math.trunc(p.adrDays) || 10) + 3,

  execDefaults: {
    contracts: 4, sizingMode: "fixed",
    slAtrMult: 3, tpMode: "atr", tpAtrMult: 2, tpMaxUsd: 600,
    flipOnOpposite: true, sameBarReentry: false,
    entryType: "market",
    intradayOnly: true, flattenCt: 15 * 60 + 5, reopenCt: 17 * 60, noEntryMinsBeforeFlat: 10,
    commissionModel: "per-contract", commissionPerSide: 0.75, slippageTicks: 1,
    dayLossStopUsd: 600, dayLossStopMode: "exact",
    dayBreakerUsd: 200, dayProfitBlockUsd: 250,
  },
  rulesDefaults: { circuitBreaker: 0, dailyProfitStop: 0 },

  params: [
    { key: "fast", label: "MACD fast", type: "int", min: 2, max: 100, step: 1, default: 12, group: "MACD" },
    { key: "slow", label: "MACD slow", type: "int", min: 3, max: 200, step: 1, default: 26, group: "MACD" },
    { key: "signal", label: "MACD signal", type: "int", min: 2, max: 50, step: 1, default: 9, group: "MACD" },
    { key: "buildBars", label: "Growing bars before entry", type: "int", min: 1, max: 10, step: 1, default: 2, group: "MACD",
      hint: "Bars in a row the histogram grows away from zero after a cross before the entry. One entry per cross." },
    { key: "fadeBars", label: "Shrinking bars before exit (0 = off)", type: "int", min: 0, max: 10, step: 1, default: 0, group: "MACD",
      hint: "Win rate peaked at 3 on 1- and 5-minute bars (research/fade_bars_sweep.mjs)." },
    { key: "trendTf", label: "Trend timeframe (min)", type: "int", min: 1, max: 60, step: 1, default: 30, group: "Trend" },
    { key: "trendFast", label: "Trend EMA fast", type: "int", min: 2, max: 200, step: 1, default: 9, group: "Trend" },
    { key: "trendSlow", label: "Trend EMA slow", type: "int", min: 3, max: 400, step: 1, default: 21, group: "Trend" },
    { key: "adxMin", label: "ADX minimum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 0, group: "Trend" },
    { key: "adxPeriod", label: "ADX period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Trend" },
    { key: "maxAdrUsed", label: "Day's range used at most (x ADR, 0 = off)", type: "float", min: 0, max: 3, step: 0.05, default: 0.9, group: "Room" },
    { key: "adrDays", label: "ADR over (sessions)", type: "int", min: 2, max: 40, step: 1, default: 10, group: "Room" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 100, step: 1, default: 14, group: "Room" },
    { key: "startCt", label: "Signals from (CT)", type: "time", min: 0, max: 1439, step: 5, default: 8 * 60 + 30, group: "Session" },
    { key: "endCt", label: "Signals until (CT)", type: "time", min: 0, max: 1440, step: 5, default: 15 * 60, group: "Session" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, ctMin: CT } = bars, n = C.length;
    const a = atr(H, L, C, Math.max(2, Math.trunc(p.atrPeriod) || 14));
    const fast = Math.max(2, Math.trunc(p.fast) || 12);
    const { hist } = macd(C, fast, Math.max(fast + 1, Math.trunc(p.slow) || 26), Math.max(2, Math.trunc(p.signal) || 9));
    const tr = htfEmaTrend(bars, p.trendTf, p.trendFast, p.trendSlow);
    const ax = p.adxMin > 0 ? adx(H, L, C, Math.max(2, Math.trunc(p.adxPeriod) || 14)).adx : null;
    const used = p.maxAdrUsed > 0 ? rthRangeUsed(bars, Math.max(2, Math.trunc(p.adrDays) || 10)) : null;
    const build = Math.max(1, Math.trunc(p.buildBars) || 3), fade = Math.max(0, Math.trunc(p.fadeBars) || 0);
    const sig = new Int8Array(n), exitSig = fade > 0 ? new Int8Array(n) : null;
    let armed = 0, grow = 0, upRun = 0, dnRun = 0;
    for (let i = 1; i < n; i++) {
      const v = hist[i], u = hist[i - 1];
      if (!Number.isFinite(v) || !Number.isFinite(u)) { armed = 0; grow = 0; upRun = 0; dnRun = 0; continue; }
      const side = v >= 0 ? 1 : -1, prevSide = u >= 0 ? 1 : -1;
      // the fade exit: a run of bars closer to zero, counted per side
      if (exitSig) {
        upRun = side === 1 && prevSide === 1 && v < u ? upRun + 1 : 0;
        dnRun = side === -1 && prevSide === -1 && v > u ? dnRun + 1 : 0;
        if (upRun >= fade) exitSig[i] |= 1;
        if (dnRun >= fade) exitSig[i] |= 2;
      }
      if (side !== prevSide) { armed = side; grow = 0; continue; }   // the cross arms its side
      if (armed !== side) continue;
      grow = Math.abs(v) > Math.abs(u) ? grow + 1 : 0;
      if (grow < build) continue;
      armed = 0;                                                     // one entry per cross
      const ct = CT ? CT[i] : 0;
      if (!(ct >= p.startCt && ct < p.endCt)) continue;
      if (tr.dir[i] !== side) continue;
      if (ax && !(ax[i] >= p.adxMin)) continue;
      if (used && !(used[i] <= p.maxAdrUsed)) continue;
      sig[i] = side;
    }
    return {
      sig, atr: a, ...(exitSig ? { exitSig } : {}),
      overlays: [
        { name: `${tr.tf}m EMA ${p.trendFast}`, pane: "price", data: tr.fast, color: "#f0b429" },
        { name: `${tr.tf}m EMA ${p.trendSlow}`, pane: "price", data: tr.slow, color: "#c678dd", dash: [5, 3] },
        { name: "MACD hist", pane: "sub", kind: "hist", data: hist, autoRange: true, colorUp: "#26a65b", colorUpFade: "#7fd4a0", colorDown: "#d1566e", colorDownFade: "#eda2b0" },
      ],
    };
  },
};
