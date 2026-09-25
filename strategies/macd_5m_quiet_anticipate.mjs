// Anticipate the cross, but only when the market is quiet. Fade out.
//
// The one configuration in the whole MACD family that survived a matched null,
// a split half and a change of trigger setting. Two ideas, and the second one is
// the one that actually earned its place:
//
//   ENTRY   enter before the crossover, when the histogram has been shrinking
//           toward zero and is close enough that a cross is likely
//   GATE    only overnight, and only while the day has spent under half its
//           average daily range
//   EXIT    leave after N consecutive bars closer to zero in the direction the
//           trade is in, with the opposite crossover as a backstop
//
// ── WHY THE GATE AND NOT THE ENTRY ──────────────────────────────────────
// Measured on 39,467 crossovers with the exit held identical, entry TIMING is
// worth almost nothing: the best of six delayed-entry rules gained 0.16 points
// over entering at the cross, and every single variant was net negative after
// the $12 round trip. Eleven ungated anticipation settings were also all net
// negative. Nothing that changes WHEN you enter clears commission.
//
// The gate is different because it changes WHETHER you enter at all
// (research/entry_table.mjs):
//
//   anticipate prox 0.075         0.28 pts   -$7.50   halves  0.47 / 0.10
//   + overnight                   0.76       +$0.21           0.65 / 0.87
//   + ADR used < 0.5              1.28       +$8.44           1.16 / 1.39
//   + BOTH                        1.33       +$9.34           1.22 / 1.44
//
// and all four single-condition complements LOSE, which is what makes it an
// interaction rather than one variable wearing a disguise:
//
//   RTH only                     -1.10      overnight, range spent   -0.85
//   low ADR during RTH           -2.55      range spent              -0.86
//
// ── WHAT THE EXIT COSTS AND BUYS ────────────────────────────────────────
// The fade exit is a straight trade of expectancy for win rate, monotone in
// both directions, so no setting gets both (research/gated_fade_exit.mjs):
//
//   exit            avg pts    net $   win%   avgW / avgL  hold
//   opposite cross     1.33   +$9.34   44.1   24.7 / -17.1    19
//   fade 1 bar         0.63   -$1.89   55.2   12.3 / -13.8    10
//   fade 3 bars        1.08   +$5.25   48.5   19.4 / -16.2    15
//   fade 5 bars        1.38  +$10.10   46.2   22.7 / -17.0    17
//
// The default is 3: net positive, near-50% win rate, and steadier halves than
// the tighter settings. If the objective is expectancy, set it to 0 and hold to
// the opposite cross instead. If it is pass rate, 1 or 2 may well win despite
// losing money per trade, because many small wins sit better with a trailing
// drawdown and a consistency rule than a few large ones do. That is a question
// for the challenge sweep, not for this file.
//
// ── THINGS THAT DID NOT WORK, so they are not silently missing ───────────
// Volume, ADX, ADR-as-volatility, efficiency ratio, choppiness and time-of-day
// were all tested as predictors of whether the anticipated cross ARRIVES, and
// none of them moved it off 48% (research/anticipate_gates.mjs). The gates that
// predicted arrival BEST lost the most money -- a clean trend delivers the cross
// and then resumes against the fade. Histogram steepness does predict arrival,
// 33% to 56% across deciles, and still pays nothing: it forecasts arrival SPEED,
// not arrival FAILURE, and the damaging tail sits at 25-30% regardless
// (research/anticipate_steepness.mjs). Abandoning a trade whose cross has not
// come by bar N is worse at every N than holding it out.
//
// ── THE STOP IS OFF BY DEFAULT ──────────────────────────────────────────
// Every number above was measured with no bracket, so the defaults reproduce
// them. That is a signal configuration, not a tradeable one: an unstopped
// ~95-minute overnight hold against a $2,000 trailing drawdown is a different
// risk shape entirely. Turn slAtrMult down in the sidebar to find out what a
// real stop costs -- that is the open question this strategy exists to answer.

import { atr } from "../src/indicators.mjs";
import base from "./macd_1m_flip.mjs";

export default {
  ...base,

  id: "macd_5m_quiet_anticipate",
  name: "MACD 5-min — quiet-gated anticipation, fade exit",
  description: "Enter before the MACD crossover when the histogram is closing on zero, but only overnight and only while the day has spent under half its average range. Exit on a fading histogram, with the opposite cross as a backstop. The one MACD configuration that survived a matched null and a split half.",

  timeframeMin: 5,
  warmupBars: 400,

  params: [
    ...base.params,

    { key: "shrinkBars", label: "Shrinking bars required", type: "int",
      min: 1, max: 8, step: 1, default: 3, group: "Anticipation",
      hint: "Consecutive bars moving toward zero before the entry arms. More raises the share of anticipations whose cross actually arrives and fires less often." },
    { key: "prox", label: "Proximity to zero (x recent |hist|)", type: "float",
      min: 0.025, max: 1.5, step: 0.025, default: 0.075, group: "Anticipation",
      hint: "How close to the baseline the histogram must already be, as a fraction of its own trailing average, so the threshold means the same thing across regimes. 0.075 is the setting the gate was validated on; 0.25 is the looser book and reads about half as well gated (0.86 against 1.33 points)." },
    { key: "scaleBars", label: "Bars in the |hist| average", type: "int",
      min: 50, max: 500, step: 25, default: 200, group: "Anticipation" },
    { key: "trigger", label: "What counts as imminent", type: "select",
      default: "prox", group: "Anticipation",
      options: [["eta", "Bars until zero at the current rate"],
                ["prox", "Proximity to zero alone"]],
      hint: "ETA is level divided by slope. It is the better cross predictor and it trades worse, ungated and gated alike. Proximity stays the default because of it." },
    { key: "etaBars", label: "Max bars until zero", type: "float",
      min: 0.5, max: 8, step: 0.5, default: 2, group: "Anticipation" },
    { key: "slopeBars", label: "Bars to measure the slope over", type: "int",
      min: 1, max: 10, step: 1, default: 3, group: "Anticipation" },

    { key: "sessionGate", label: "When may it enter", type: "select",
      default: "overnight", group: "Quiet gate",
      options: [["overnight", "Overnight only"], ["rth", "RTH only"], ["any", "Any time"]],
      hint: "Overnight is outside 08:30-15:00 CT. RTH-only is the complement and LOSES 1.10 points a trade, which is the check that this is a real split rather than a lucky slice." },
    { key: "adrMax", label: "Max share of ADR already spent", type: "float",
      min: 0.1, max: 2, step: 0.05, default: 0.5, group: "Quiet gate",
      hint: "The day's high-low so far, over the mean range of the previous N completed days. Under 0.5 means the session still has room to move. Above 0.5 the same book loses 0.86 a trade. Set to 2 to switch the gate off." },
    { key: "adrDays", label: "Days in the ADR average", type: "int",
      min: 3, max: 40, step: 1, default: 14, group: "Quiet gate" },

    { key: "fadeBars", label: "Shrinking bars before exit", type: "int",
      min: 0, max: 10, step: 1, default: 3, group: "Exit",
      hint: "0 switches the fade off and holds to the opposite crossover, which is the best setting for expectancy (+$9.34 a signal against +$5.25 at 3). Lower values buy win rate and sell expectancy: 1 bar reaches 55.2% wins, the only setting in this family above 50%, and goes net negative doing it." },
  ],

  compute(bars, p) {
    // Take the histogram from the bare crossover book rather than rebuilding it,
    // so the cross this anticipates and the cross that backstops the exit are
    // the same object the rest of the family uses.
    const out = base.compute(bars, p);
    const hist = out.overlays.find((o) => o.kind === "hist").data;
    const { high: H, low: L, close: C, ctMin, tday } = bars;
    const n = hist.length;

    // ── trailing |hist| scale ─────────────────────────────────────────
    // Causal by construction: the window ends at the bar being tested. This is
    // what makes "close to zero" mean the same thing whether the histogram is
    // running at 2 points or 20, across a dataset where MNQ went from 7,000 to
    // 29,000.
    const win = Math.max(10, Math.trunc(p.scaleBars) || 200);
    const scale = new Float64Array(n).fill(NaN);
    {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(hist[i]);
        if (Number.isFinite(a)) sum += a;
        if (i >= win) sum -= Math.abs(hist[i - win]) || 0;
        if (i >= win - 1) scale[i] = sum / win;
      }
    }

    // ── the quiet gate ────────────────────────────────────────────────
    // ADR uses only COMPLETED previous days, and the day's own range only up to
    // the bar being tested, so nothing here reads forward.
    const adrDays = Math.max(2, Math.trunc(p.adrDays) || 14);
    const adrUsed = new Float64Array(n).fill(NaN);
    if (tday) {
      const ranges = [];
      let dHi = -Infinity, dLo = Infinity, adr = NaN, curDay = tday[0];
      for (let i = 0; i < n; i++) {
        if (tday[i] !== curDay) {
          curDay = tday[i];
          if (Number.isFinite(dHi - dLo)) {
            ranges.push(dHi - dLo);
            if (ranges.length > adrDays) ranges.shift();
            adr = ranges.length === adrDays
              ? ranges.reduce((a, b) => a + b, 0) / adrDays : NaN;
          }
          dHi = -Infinity; dLo = Infinity;
        }
        if (H[i] > dHi) dHi = H[i];
        if (L[i] < dLo) dLo = L[i];
        if (Number.isFinite(adr) && adr > 0) adrUsed[i] = (dHi - dLo) / adr;
      }
    }

    const gate = p.sessionGate || "overnight";
    const adrMax = Number.isFinite(p.adrMax) ? p.adrMax : 0.5;
    // A missing ADR is a warm-up bar, not a quiet one. Blocking it keeps the
    // first adrDays of the dataset out rather than letting it in untested.
    const quiet = (i) => {
      const ct = ctMin ? ctMin[i] : 0;
      const night = ct < 510 || ct >= 900;
      if (gate === "overnight" && !night) return false;
      if (gate === "rth" && night) return false;
      if (adrMax >= 2) return true;
      return Number.isFinite(adrUsed[i]) && adrUsed[i] < adrMax;
    };

    // ── the anticipation entry ────────────────────────────────────────
    const need = Math.max(1, Math.trunc(p.shrinkBars) || 1);
    const sb = Math.max(1, Math.trunc(p.slopeBars) || 3);
    const useEta = p.trigger === "eta";
    const sig = new Int8Array(n);
    let run = 0;
    for (let i = 1; i < n; i++) {
      const v = hist[i], u = hist[i - 1];
      if (!Number.isFinite(v) || !Number.isFinite(u) || !Number.isFinite(scale[i])) {
        run = 0; continue;
      }
      run = Math.abs(v) < Math.abs(u) ? run + 1 : 0;
      if (run < need) continue;
      if (!quiet(i)) continue;

      let imminent;
      if (useEta) {
        if (i < sb) continue;
        const rate = (Math.abs(hist[i - sb]) - Math.abs(v)) / sb;
        if (!(rate > 0)) continue;
        imminent = Math.abs(v) / rate <= p.etaBars;
      } else {
        imminent = Math.abs(v) < p.prox * scale[i];
      }
      if (!imminent) continue;
      // Toward the other side, which is where the cross would land. The trade is
      // therefore a fade of the push that is currently running.
      sig[i] = v >= 0 ? -1 : 1;
    }

    // ── the fading-histogram exit ─────────────────────────────────────
    // Bitmask: 1 = a long should leave, 2 = a short should leave.
    //
    // Note a long is entered while the histogram is still NEGATIVE, and the long
    // exit needs it positive and shrinking, so this cannot fire on the entry bar
    // — the trade waits for the cross it anticipated, rides the histogram, and
    // leaves when that fades. When the cross never arrives the fade can never
    // fire and flipOnOpposite is what closes the trade.
    const fadeN = Math.max(0, Math.trunc(p.fadeBars) || 0);
    let exitSig = null;
    if (fadeN > 0) {
      exitSig = new Int8Array(n);
      let upRun = 0, dnRun = 0;
      for (let i = 1; i < n; i++) {
        const v = hist[i], u = hist[i - 1];
        if (!Number.isFinite(v) || !Number.isFinite(u)) { upRun = dnRun = 0; continue; }
        const shrinking = Math.abs(v) < Math.abs(u);
        if (v >= 0) { upRun = shrinking ? upRun + 1 : 0; dnRun = 0; }
        else { dnRun = shrinking ? dnRun + 1 : 0; upRun = 0; }
        let m = 0;
        if (upRun >= fadeN) m |= 1;
        if (dnRun >= fadeN) m |= 2;
        exitSig[i] = m;
      }
    }

    return {
      ...out,
      sig,
      exitSig,
      atr: out.atr || atr(H, L, C, p.atrPeriod),
    };
  },
};
