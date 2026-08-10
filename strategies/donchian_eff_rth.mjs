// MNQ Donchian Breakout — RTH + Efficiency Gate.
//
// The best configuration found in this project, at 41.9% pass across all 2,598
// windows (42.1% in-sample / 41.7% out-of-sample), under the real account rules:
// no overnight positions, flat by 3:05 PM CT.
//
// It was not designed. It fell out of roughly 2.2 billion window simulations,
// and the shape it settled on is counter-intuitive enough to be worth spelling
// out, because every instinct here points the wrong way.
//
// ── THE SIGNAL ───────────────────────────────────────────────────────────
// A plain Donchian-30 breakout on 2-minute bars, taken WITH the break, gated on
// ADX >= 25. Nothing clever. The identical signal is what `trend_neutev` runs;
// it is `tpl_channel` at its defaults. What changed is everything around it.
//
// ── WHAT ACTUALLY MADE IT WORK ───────────────────────────────────────────
// 1. THE GATE. Only trade RTH (08:30-15:00 CT) and only when the Kaufman
//    efficiency ratio exceeds 0.5 — i.e. when price is genuinely travelling
//    rather than oscillating. That single filter keeps just 9.5% of raw signal
//    bars. Late afternoon in particular is poison: a 12:30-15:00 window scored
//    20.9% against 36.2% for full RTH.
//
// 2. INVERTED GEOMETRY. A 5xATR stop with a 1.5xATR target — roughly 0.3:1
//    reward:risk, the reverse of the 6:1 and 18:1 books this project started
//    with. Under a 3:05 PM flatten a wide target simply never arrives: the old
//    books' winners needed a median 6.5 hours while their losers resolved in 1.0,
//    so the deadline truncated 37% of winners and only 5% of losers. Inverting
//    the geometry produces a 75.8% win rate with small wins and rare large
//    losses, and it RESOLVES — mean hold time is 43 minutes.
//
// 3. MAXIMUM LEGAL SIZE. Ten contracts, flat. Every attempt at cleverness lost:
//    risking a fixed fraction of the surviving cushion scored 0.0%, because it
//    collapses size to 1-2 lots and a fixed $3000 target then becomes
//    unreachable. Against a fixed-dollar target on a deadline, throughput beats
//    risk control.
//
// 4. THE DAILY PROFIT STOP, and WHICH KIND OF STOP IT IS. This matters more than
//    its value, and the two kinds behave oppositely:
//
//    SOFT (blocks new ENTRIES on REALISED P&L) — the default here. It does not
//    cap the day: the trade that crosses the line overshoots and open positions
//    run to their bracket. At $1500 that still leaves 50.3% of windows with a day
//    over $1500, breaking the 50% consistency test and delaying 67.0% of passes.
//    At $750 only 6.4% do, so $750 wins by 4.0pp. Turning consistency off
//    reverses the ranking, which proves consistency is the mechanism.
//
//    HARD (platform stop on UNREALISED P&L, `dayProfitStopUsd`) — closes the
//    position the instant realised+open P&L touches the number. It does cap the
//    day exactly, and 0.0% of windows then exceed it. But it is WORSE overall,
//    because it truncates winners at an arbitrary dollar level while leaving
//    losses untouched: profit factor falls 1.047 -> 0.949 and expectancy goes
//    +$17.2 -> -$14.5 per trade. Best achievable is 39.7% (hard $1500 at NINE
//    lots — smaller size makes the cap bite less often, since $1500 then needs a
//    larger move) against 41.7% with the soft stop.
//
//    This is the same asymmetry that the 3:05 PM flatten and scale-out both
//    exhibit: anything that cuts winners short but not losses costs edge.
//    If your platform's profit stop can be set to block new orders rather than
//    flatten, do that. If it cannot, use $1500 at 9 lots and accept ~2pp.
//
// ── THE THING TO UNDERSTAND BEFORE TUNING IT ─────────────────────────────
// Pass rate correlates with expectancy x trades/day (0.512) far more than with
// profit factor (0.134) or trade frequency (-0.381) alone. This book has the
// LOWEST profit factor of the qualifying candidates (1.047) and the HIGHEST pass
// rate, because 2.03 trades/day beats 0.74/day at a better 1.148. Do not tune
// toward a prettier profit factor; tune toward dollars per day at legal size.
//
// ── HONEST LIMITATIONS ───────────────────────────────────────────────────
// * Commission is $80,130 against $91,640 net — 47% of gross profit. This book
//   lives or dies on execution cost. At double commission it is unprofitable.
// * Slippage is modelled as ZERO. At 5,342 trades a single tick per side costs
//   roughly $53k. Measure your real fills before trusting the numbers.
// * Per year: 2019 18%, 2020 33%, 2021 49%, 2022 53%, 2023 46%, 2024 38%,
//   2025 50%, 2026 37%. Regime still dominates any single attempt.
// * 41.9% is not 70%. Under these account rules nothing in ~2.2 billion
//   simulations reached 70%; the same search with overnight holds allowed
//   reached 83%. The flatten rule, not the strategy, is the binding constraint.

import { atr, adx, donchian } from "../src/indicators.mjs";

export default {
  id: "donchian_eff_rth",
  name: "MNQ Donchian + Efficiency Gate (best found, 41.9%)",
  description: "Donchian-30 breakout on 2-min bars, ADX>=25, traded only in RTH when the efficiency ratio exceeds 0.5. Inverted geometry (5xATR stop, 1.5xATR target) so trades resolve before the 3:05 PM CT flatten. 75.8% win rate, 2.03 trades/day.",

  timeframeMin: 2,
  warmupBars: 900,

  // Every one of these is part of the measured result, not a suggestion.
  execDefaults: {
    contracts: 10, sizingMode: "fixed",
    slAtrMult: 5, tpMode: "atr", tpAtrMult: 1.5,
    flipOnOpposite: true, sameBarReentry: false,
    intradayOnly: true, flattenCt: 15 * 60 + 5, reopenCt: 17 * 60,
    noEntryMinsBeforeFlat: 10,
    commissionModel: "per-contract", commissionPerSide: 0.75, slippageTicks: 0,
  },
  filterDefaults: { startCt: 8 * 60 + 30, endCt: 15 * 60, effMin: 0.5 },
  rulesDefaults: { circuitBreaker: 150, dailyProfitStop: 750 },

  params: [
    { key: "period", label: "Donchian lookback", type: "int", min: 5, max: 200, step: 1, default: 30, group: "Signal" },
    { key: "adxMin", label: "ADX minimum", type: "int", min: 0, max: 60, step: 1, default: 25, group: "Signal",
      hint: "The regime gate. Below ~20 the breakout has nothing behind it." },
    { key: "adxPeriod", label: "ADX period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
    { key: "cooldownBars", label: "Cooldown bars", type: "int", min: 1, max: 60, step: 1, default: 1, group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;

    const { adx: adxArr } = adx(H, L, C, p.adxPeriod);
    const { high: dh, low: dl } = donchian(H, L, p.period);
    const a = atr(H, L, C, p.atrPeriod);

    const sig = new Int8Array(n);
    let last = -Infinity;
    for (let i = p.period; i < n; i++) {
      if (i - last < p.cooldownBars) continue;
      if (adxArr[i] < p.adxMin) continue;
      // The channel excludes the current bar, so this is a genuine break of
      // prior structure rather than a bar comparing against itself.
      if (C[i] > dh[i]) { sig[i] = 1; last = i; }
      else if (C[i] < dl[i]) { sig[i] = -1; last = i; }
    }

    return {
      sig,
      atr: a,
      overlays: [
        { name: `Donchian ${p.period} high`, pane: "price", color: "#3d7a5a", data: dh, dash: [4, 3] },
        { name: `Donchian ${p.period} low`, pane: "price", color: "#7a3d3d", data: dl, dash: [4, 3] },
        { name: "ADX", pane: "sub", color: "#c9a227", data: adxArr, threshold: p.adxMin, range: [0, 60] },
      ],
    };
  },
};
