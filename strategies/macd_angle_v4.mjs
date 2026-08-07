// MNQ MACD-Angle Union Burst v4 — ported from lite_backtester.
//
// This is the most developed strategy in the other repo and, unlike everything
// else ported here, it was designed intraday from the start: RTH-only signals,
// no entries late in the session, flat by the close. That matters enormously
// under a 3:05 PM CT flatten, which removed ~43% of gross profit from every
// book that assumed it could hold overnight.
//
// ── THE SIGNAL ───────────────────────────────────────────────────────────
// FOUR MACD sets run in parallel on 2-minute bars:
//     (4,10,3)  (6,13,4)  (9,20,5)  (13,26,9)
// For each set, a "burst" is: histogram SIGN gives the direction, and the
// ATR-normalised histogram SLOPE agrees with it. Direction is the UNION of the
// sets that fire — but if any two disagree, the bar is skipped entirely.
//
// That conflict rule is the whole idea. Four speeds of the same oscillator
// agreeing is a much stronger statement than one crossing, and disagreement is
// genuinely informative rather than something to average away.
//
// It is a PERSISTENT STATE, not a cross event — which is why this config sets
// `flipOnOpposite: false`. Force-flipping on every disagreement would thrash a
// signal that is meant to be held.
//
// ── WHY 2-MINUTE ─────────────────────────────────────────────────────────
// From the original research: commission is a fixed dollar cost per trade while
// the edge is ATR-scaled, so a larger bar earns proportionally more against the
// same fee. Profit factor at DOUBLED costs rose monotonically with bar size
// (1m 1.089 → 2m 1.117 → 3m 1.180 → 5m 1.195) and the blow-up tail collapsed
// (17.1% → 11.6% → 1.5%). The geometry does not port across timeframes: at 1-min
// the optimum was the native period set with SL 2.5×ATR / TP 0.70R; at 2-3 min it
// flips to HALVED periods with a tighter stop and wider target.
//
// ── EXECUTION RULES THAT ARE PART OF THE VALIDATED CONFIG ────────────────
// The original header is emphatic that these are not optional:
//   * ONE contract. Every 2-lot variant tested scored better in selection and
//     then degraded on the holdout with 6.7% blow-ups, collapsing to 40.1% at
//     doubled costs — the same overfit signature as its rejected risk-sized
//     configs. DO NOT SIZE UP.
//   * SL 1.5×ATR, TP 1.2R (R:R, not an ATR multiple).
//   * 60-minute same-direction cooldown after a stop-out.
//   * RTH signals only, no late entries, flat by the close.
//   * NO regime gate — vol floors, chop bands and ADX filters were all displaced
//     in a 5,750-config search. The burst condition selects its own regime.
//
// ── !! ITS REPORTED EDGE DEPENDS ON A NON-CAUSAL FILL !! ─────────────────
//
// The original reports pf 1.373 and, on its own 21-day challenge, 86.5% pass.
// Investigating that here produced a result worth reading carefully.
//
// The SIGNAL port is exact. Compared bar-for-bar against the original on the
// same data: 885,130 overlapping 2-minute bars, 224,952 non-zero signals on each
// side, ZERO disagreements. Nothing about the maths below differs.
//
// The divergence is entirely in execution. `lib_faithful_eval.mjs` checks exits
// and then falls through to the entry decision in the SAME loop iteration, so a
// position stopped out during bar i can immediately re-open at bar i's OPEN.
// That open occurred BEFORE the stop-out. It is not a sequence that can be
// traded — you cannot get filled at a price that has already passed.
//
// Enabling `sameBarReentry` reproduces the original almost exactly (21.5/day,
// pf 1.340 vs their 21.3/day, pf 1.307), which identifies it as the whole of the
// difference. Requiring the re-entry to follow the exit:
//
//                        trades/day    profit factor    $/trade    pass rate
//   same-bar re-entry        21.7          1.365         +$8.37    68% / 80%
//   causal                   16.4          0.939         -$1.75     9.5%
//
// So the edge is the artefact, not a property of the signal. This was checked
// across 8 stops x 9 targets x 10 contract counts causally; nothing exceeded
// profit factor 0.94.
//
// The default below is CAUSAL. Set `sameBarReentry: true` only to reproduce the
// original's published figures — not to plan against them.

import { atr, ema } from "../src/indicators.mjs";

export default {
  id: "macd_angle_v4",
  name: "MACD-Angle Union Burst v4 (2-min, 4-set consensus)",
  description: "The most developed book from the lite backtester, and the only ported one designed intraday from the start. Four MACD speeds must agree; any disagreement stands aside. Validated at ONE contract — its own research found sizing up overfits.",

  timeframeMin: 2,
  warmupBars: 800,

  // These are part of the validated configuration, not incidental defaults.
  execDefaults: {
    contracts: 1,
    sizingMode: "fixed",
    slAtrMult: 1.5,
    tpMode: "rr",
    tpRR: 1.2,
    flipOnOpposite: false,
    cooldownAfterStopMins: 60,
    intradayOnly: true,
    noEntryMinsBeforeFlat: 10,
  },

  params: [
    { key: "slopeBars", label: "Slope lookback (bars)", type: "int", min: 1, max: 10, step: 1, default: 1, group: "Angle gate" },
    { key: "angleThr", label: "Slope threshold", type: "float", min: 0, max: 0.5, step: 0.005, default: 0, group: "Angle gate",
      hint: "0 = any non-zero slope in the histogram's direction. A positive threshold scored WORSE at 2-min — the four-set consensus already does the filtering." },
    { key: "rthStartCt", label: "Signals from (CT)", type: "time", min: 0, max: 1439, step: 5, default: 8 * 60 + 30, group: "Session" },
    { key: "rthEndCt", label: "Signals until (CT)", type: "time", min: 0, max: 1439, step: 5, default: 15 * 60, group: "Session" },
    { key: "fast1", label: "Set 1 fast", type: "int", min: 2, max: 40, step: 1, default: 4, group: "MACD sets" },
    { key: "slow1", label: "Set 1 slow", type: "int", min: 3, max: 80, step: 1, default: 10, group: "MACD sets" },
    { key: "sig1", label: "Set 1 signal", type: "int", min: 2, max: 30, step: 1, default: 3, group: "MACD sets" },
    { key: "fast2", label: "Set 2 fast", type: "int", min: 2, max: 40, step: 1, default: 6, group: "MACD sets" },
    { key: "slow2", label: "Set 2 slow", type: "int", min: 3, max: 80, step: 1, default: 13, group: "MACD sets" },
    { key: "sig2", label: "Set 2 signal", type: "int", min: 2, max: 30, step: 1, default: 4, group: "MACD sets" },
    { key: "fast3", label: "Set 3 fast", type: "int", min: 2, max: 40, step: 1, default: 9, group: "MACD sets" },
    { key: "slow3", label: "Set 3 slow", type: "int", min: 3, max: 80, step: 1, default: 20, group: "MACD sets" },
    { key: "sig3", label: "Set 3 signal", type: "int", min: 2, max: 30, step: 1, default: 5, group: "MACD sets" },
    { key: "fast4", label: "Set 4 fast", type: "int", min: 2, max: 40, step: 1, default: 13, group: "MACD sets" },
    { key: "slow4", label: "Set 4 slow", type: "int", min: 3, max: 80, step: 1, default: 26, group: "MACD sets" },
    { key: "sig4", label: "Set 4 signal", type: "int", min: 2, max: 30, step: 1, default: 9, group: "MACD sets" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "ATR" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, ctMin } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const k = Math.max(1, Math.trunc(p.slopeBars));

    const sets = [
      [p.fast1, p.slow1, p.sig1],
      [p.fast2, p.slow2, p.sig2],
      [p.fast3, p.slow3, p.sig3],
      [p.fast4, p.slow4, p.sig4],
    ];
    const hists = sets.map(([f, s, g]) => {
      const ef = ema(C, f), es = ema(C, Math.max(s, f + 1));
      const line = new Float64Array(n);
      for (let i = 0; i < n; i++) line[i] = ef[i] - es[i];
      const sl = ema(line, g);
      const hist = new Float64Array(n);
      for (let i = 0; i < n; i++) hist[i] = line[i] - sl[i];
      return hist;
    });

    const sig = new Int8Array(n);
    const consensus = new Float64Array(n).fill(NaN);

    for (let i = k; i < n; i++) {
      const ct = ctMin ? ctMin[i] : 0;
      if (ct < p.rthStartCt || ct >= p.rthEndCt) continue;
      const av = a[i];
      if (!(av > 0)) continue;

      let dir = 0, conflict = false, agreeing = 0;
      for (const hist of hists) {
        const h = hist[i];
        // Slope normalised by ATR so the threshold means the same thing at any
        // volatility — the same reasoning as measuring bands in ATR units.
        const slope = (h - hist[i - k]) / k / av;
        let d = 0;
        if (h > 0 && slope >= p.angleThr) d = 1;
        else if (h < 0 && slope <= -p.angleThr) d = -1;
        if (!d) continue;
        agreeing++;
        if (!dir) dir = d;
        else if (dir !== d) { conflict = true; break; }
      }
      if (conflict) { consensus[i] = 0; continue; }
      sig[i] = dir;
      consensus[i] = dir * agreeing;      // −4..+4, how many sets agree
    }

    return {
      sig,
      atr: a,
      overlays: [
        { name: "Set consensus (−4..+4)", pane: "sub", color: "#c9a227", data: consensus, threshold: 0, range: [-4.5, 4.5] },
      ],
    };
  },
};
