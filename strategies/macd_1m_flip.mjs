// MACD crossover on 1-minute bars, and nothing else.
//
// A deliberately bare control. Long when the MACD line crosses above its signal
// line, short when it crosses below, and the only thing that ever closes a
// position is the opposite cross. No stop, no target, no session window, no ADX
// gate, no regime filter, no time stop. Always in the market once the first
// cross lands.
//
// It exists to answer "what does the raw signal do", so every result from it is
// a baseline rather than a candidate. If something more elaborate cannot beat
// this, the elaboration is not earning its keep — which is a live question in
// this project, where `momentum_roc` at its crudest already beat every ornate
// book in the library.
//
// ── HOW "NO RULES" IS EXPRESSED, since the engine always has an opinion ──
// The execution layer is built to bracket every trade, so switching it off
// takes three deliberate settings rather than one:
//
//   slAtrMult / tpAtrMult = 1000   NOT zero. `slDist` is
//       Math.max(atr * mult, tickSize), so a multiplier of 0 collapses to a
//       ONE TICK stop and the book would stop out on essentially every bar. A
//       multiple this large puts both barriers tens of thousands of points away,
//       where price cannot reach them, which is the nearest thing to "no
//       bracket" the engine offers.
//   intradayOnly = false           no 15:05 CT flatten, so positions run through
//       the overnight session. That breaks the account's real no-overnight rule
//       on purpose: this is a signal test, not a tradeable configuration.
//   circuitBreaker / dailyProfitStop = 0   the two SELF-IMPOSED daily entry
//       blocks are off. The firm's own limits are left alone — they are account
//       rules rather than strategy rules, and the whole point of this lab is to
//       measure against them.
//
// ── WHAT TO EXPECT BEFORE READING THE RESULT ────────────────────────────
// A 1-minute crossover flips constantly, and commission is charged per flip.
// At 8 lots a round trip is $12 before slippage, so the cost line will dwarf
// anything the signal does. Slippage defaults to zero here, which is generous
// rather than realistic; turn it up in the sidebar and watch what survives.

import { atr, macd } from "../src/indicators.mjs";

export default {
  id: "macd_1m_flip",
  name: "MACD 1-min crossover ONLY (bare control)",
  description: "Long on a bullish MACD cross, short on a bearish one, flipping at every cross. No stop, no target, no session window, no filters. A bare baseline for comparison, not a tradeable book.",

  timeframeMin: 1,
  // MACD's slow EMA needs a long run-up before it means anything; 300 one-minute
  // bars is comfortably past where the 26-period EMA has settled.
  warmupBars: 300,

  execDefaults: {
    contracts: 8, sizingMode: "fixed",
    // See the header: 1000 is "unreachable", 0 would be "one tick".
    slAtrMult: 1000, tpMode: "atr", tpAtrMult: 1000,
    // The cross is the entire exit mechanism, so this must stay on.
    flipOnOpposite: true,
    sameBarReentry: false,
    maxBarsInTrade: 0,
    intradayOnly: false,
    commissionModel: "per-contract", commissionPerSide: 0.75, slippageTicks: 0,
    dayProfitStopUsd: 0, dayLossStopUsd: 0,
    cooldownAfterStopMins: 0, noEntryMinsBeforeFlat: 0,
    scaleInFrac: 0,
  },
  // No session gate and no regime gate: omitting filterDefaults leaves every
  // filter at its neutral value.
  rulesDefaults: { circuitBreaker: 0, dailyProfitStop: 0 },

  params: [
    { key: "fast", label: "Fast EMA", type: "int", min: 2, max: 100, step: 1, default: 12, group: "MACD" },
    { key: "slow", label: "Slow EMA", type: "int", min: 3, max: 200, step: 1, default: 26, group: "MACD" },
    { key: "signal", label: "Signal EMA", type: "int", min: 2, max: 50, step: 1, default: 9, group: "MACD" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal",
      hint: "Not used for stops — they are switched off. The engine needs a finite ATR at entry, and the chart draws from it." },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;
    // `slow` must stay strictly above `fast` or the line is inverted nonsense.
    const slow = Math.max(p.slow, p.fast + 1);
    const m = macd(C, p.fast, slow, p.signal);
    const a = atr(H, L, C, p.atrPeriod);

    const sig = new Int8Array(n);
    for (let i = 1; i < n; i++) {
      // The histogram is line − signal, so its sign change IS the crossover.
      // Comparing it against zero rather than comparing the two lines directly
      // avoids a float equality case when they touch exactly.
      if (m.hist[i] > 0 && m.hist[i - 1] <= 0) sig[i] = 1;
      else if (m.hist[i] < 0 && m.hist[i - 1] >= 0) sig[i] = -1;
    }

    return {
      sig,
      atr: a,
      overlays: [
        { name: "MACD", pane: "sub", color: "#4aa3ff", data: m.line,
          threshold: 0, range: range2(m.line, m.signal) },
        { name: "Signal", pane: "sub", color: "#e0894a", data: m.signal,
          range: range2(m.line, m.signal) },
      ],
    };
  },
};

// MACD is unbounded and scales with price, so the sub-pane range has to come
// from the data. Both series share one range or the crossings do not line up.
function range2(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const v = Math.max(Math.abs(a[i]), Math.abs(b[i]));
    if (Number.isFinite(v) && v > m) m = v;
  }
  return [-m * 1.05 || -1, m * 1.05 || 1];
}
