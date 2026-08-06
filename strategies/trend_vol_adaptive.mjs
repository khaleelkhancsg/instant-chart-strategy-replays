// Volatility-adaptive trend book — CANDIDATE, NOT VALIDATED.
//
// ── Where this came from ─────────────────────────────────────────────────────
// A grid search (research/optimise_2026.mjs) was run to maximise pass rate in
// 2026 alone, the hardest year for the incumbent book (52.1%). The top-ranked
// 2026 config reached 86.1% in-sample and then managed only 54.5% on 2019-2025 —
// i.e. optimising on one regime produced something WORSE than the incumbent
// everywhere else. That is the expected outcome: 2026's 165 window starts overlap
// so heavily that they amount to roughly 5.5 independent 30-day outcomes.
//
// This config is the one candidate from that search that did NOT collapse out of
// sample. It differs from the incumbent in two ways:
//
//   1. SIGNAL — 3-minute bars, Donchian 50, ADX >= 20, with a tight 1xATR stop
//      and an 18xATR target (18:1). Higher frequency, much wider reward:risk.
//   2. SIZING — constant dollar risk instead of constant contracts. Size is
//      derived from the stop distance so every stop-out costs about the same,
//      capped at the firm's 10 lots.
//
// ── Why constant-dollar sizing matters here ──────────────────────────────────
// MNQ's 5-min ATR ran ~5.7 points in 2019 and ~28.1 in 2026. Against a drawdown
// limit that is FIXED in dollars, a fixed 8-lot position means one 2xATR stop
// cost 10.6% of the limit in 2019 and 52.3% of it in 2026 — from ~9 affordable
// losses down to 1.9. The 2026 difficulty was never weak price action (ADX,
// %trending, efficiency and win rate are all normal for 2026); it was a risk
// envelope that no longer fitted the volatility. Sizing from the stop distance
// removes that drift.
//
// ── What the evidence actually supports ──────────────────────────────────────
// Measured (research/sizing_head_to_head.mjs), risk sizing reliably FLATTENS the
// year-to-year spread on both signals tested (sd 9.2-15.3 vs 12.2-21.5 for fixed)
// but only raises the mean on one of the two. So treat "more consistent across
// regimes" as supported, and "higher pass rate" as not established.
//
// ── Before trading this, understand the caveat ───────────────────────────────
// Its full-history expectancy is NEGATIVE (~-$1.30/trade, profit factor ~0.99).
// Like the incumbent it passes on challenge STRUCTURE — short window, stop on
// pass, lenient EOD trailing — not on edge. It also has not been walk-forward
// validated, and it was picked from an 8,748-config grid, so some of its margin
// over the incumbent is selection luck. Run a proper walk-forward before
// believing it.

import { adx, atr, donchian } from "../src/indicators.mjs";

export default {
  id: "trend_vol_adaptive",
  name: "MNQ Trend — Vol-Adaptive (3m / Donchian 50 / ADX 20)",
  description: "Candidate from the 2026 regime study. Constant-dollar-risk sizing so a stop costs the same whether ATR is 6 or 28 points. Negative per-trade edge — passes on structure. Not walk-forward validated.",

  timeframeMin: 3,
  warmupBars: 600,

  // Applied automatically when this strategy is selected: the signal was tuned
  // WITH this envelope and means little without it.
  execDefaults: {
    sizingMode: "risk",
    riskDollars: 400,
    maxContracts: 10,
    slAtrMult: 1,
    tpAtrMult: 18,
  },

  params: [
    { key: "donchian",     label: "Donchian lookback", type: "int", min: 5, max: 200, step: 1, default: 50, group: "Signal" },
    { key: "adxMin",       label: "ADX minimum",       type: "int", min: 0, max: 60,  step: 1, default: 20, group: "Signal",
      hint: "Looser than the incumbent's 25 — more trades, thinner per-trade edge." },
    { key: "adxPeriod",    label: "ADX period",        type: "int", min: 2, max: 60,  step: 1, default: 14, group: "Signal" },
    { key: "cooldownBars", label: "Cooldown bars",     type: "int", min: 1, max: 60,  step: 1, default: 1,  group: "Signal" },
    { key: "atrPeriod",    label: "ATR period",        type: "int", min: 2, max: 60,  step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;

    const { adx: adxArr } = adx(H, L, C, p.adxPeriod);
    const { high: dh, low: dl } = donchian(H, L, p.donchian);
    const a = atr(H, L, C, p.atrPeriod);

    const sig = new Int8Array(n);
    let last = -Infinity;
    for (let i = p.donchian; i < n; i++) {
      if (i - last < p.cooldownBars) continue;
      if (adxArr[i] < p.adxMin) continue;
      if (C[i] > dh[i]) { sig[i] = 1; last = i; }
      else if (C[i] < dl[i]) { sig[i] = -1; last = i; }
    }

    return {
      sig,
      atr: a,
      overlays: [
        { name: `Donchian ${p.donchian} high`, pane: "price", color: "#3d7a5a", data: dh, dash: [4, 3] },
        { name: `Donchian ${p.donchian} low`,  pane: "price", color: "#7a3d3d", data: dl, dash: [4, 3] },
        { name: "ADX", pane: "sub", color: "#c9a227", data: adxArr, threshold: p.adxMin, range: [0, 60] },
      ],
    };
  },
};
