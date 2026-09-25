// Two timeframes: the 5-minute anticipation arms, the 1-minute crossover pulls.
//
// The anticipation alone is early by construction -- it spends 52.5% of its
// bars-in-trade on the wrong side of zero, because it enters before the cross
// and waits to be proven right (research/direction_audit.mjs). That offside
// stretch is where its money is made, so it cannot simply be cut, but it does
// mean the entry itself carries no confirmation at all.
//
// This splits the two jobs across the two timeframes:
//
//   ARM       the 5-minute anticipation fires and sets a DIRECTION
//   TRIGGER   a 1-minute MACD crossover in that direction opens the trade
//   CONFIRM   a 1-minute EMA cross in the same direction says stay in
//   TARGET    once it is running, 3x ATR
//
// The arm supplies the thesis, the 1-minute cross supplies the timing, and the
// EMA supplies the permission to keep holding.
//
// ── THE LOOKAHEAD THIS HAD TO AVOID ─────────────────────────────────────
// A 5-minute bar's signal is only knowable at that bar's CLOSE. The obvious
// mapping -- write the 5-minute signal onto the 1-minute bars the 5-minute bar
// covers -- would let a 09:00 trade act on information from 09:04, which is
// four minutes of free foresight and would make any result meaningless.
//
// So the arm is anchored to srcLast: the 5-minute bar's LAST 1-minute index.
// Bar k arms from srcLast[k] + 1 onward and never earlier. The engine then
// reads sig[i-1] and fills at O[i], so the first possible fill is a further bar
// later again.
//
// ── CONFIRMATION IS OFFERED FOUR WAYS ───────────────────────────────────
// The engine's exit array is per-bar and does not know when a position opened,
// so "wait for the EMA to confirm, then hold" cannot be expressed as a timer.
// These are the honest ways to say it:
//
//   hold    exit as soon as the 1-minute EMA is AGAINST the position. The EMA
//           agreeing is what keeps the trade alive.
//   entry   require the EMA to already agree at entry. Stricter, and it never
//           opens a trade the EMA disputes.
//   invert  exit when the EMA comes ROUND to the trade -- a take-profit rather
//           than a confirmation, which is what the diagnostic below implies.
//   off     no confirmation -- the bracket alone governs.
//
// ── IT DOES NOT WORK, AND THE REASON IS STRUCTURAL ──────────────────────
// Swept over arm window, confirmation mode, ATR frame, target and stop
// multiples, EMA pair, proximity and the quiet gate (research/mtf_sweep.mjs).
// Every variant loses. Against the 5-minute quiet anticipation's 25.8% pass and
// +$8.85 a trade:
//
//   confirm = hold      -$10.48    2.4% pass     (91% of exits are the EMA)
//   confirm = invert    -$10.38    1.8%          (win rate 47.9%, still losing)
//   confirm = off       -$ 8.87   12.2%
//   confirm = entry     +$ 1.87    9.1%          the only positive expectancy
//
// The diagnostic says why. Of 16,026 arms, 86.3% do get a 1-minute trigger
// within 30 bars, median wait 11 bars -- so the plumbing works. But by then:
//
//   the 5-minute histogram has ALREADY crossed   42.9% of the time
//   the 1-minute EMA agrees with the arm         35.0% of the time
//
// Both numbers are fatal and both are structural. Waiting for the 1-minute cross
// spends the anticipation: in 43% of cases the event being anticipated has
// already happened, so the entry is a plain crossover, and the plain 1-minute
// crossover is measured at exactly zero gross edge -- it loses precisely its
// commission (see macd_1m_quiet_anticipate).
//
// And a trend-following confirmation CANNOT confirm a fade. The arm fires
// against the running push; the EMA follows that push; so the EMA disagrees at
// entry 65% of the time, and using its agreement as permission to hold closes
// 91% of trades inside seven minutes. That is the same experiment as ABANDON in
// research/direction_audit.mjs, which took pass rate from 25.8% to 5.1%, run
// with a different instrument and reaching the same answer: the offside stretch
// is where this book earns, and every tool that removes it removes the edge.
//
// Kept selectable because the negative is worth being able to reproduce, and
// because the multi-timeframe plumbing here -- srcLast anchoring, ATR mapped
// between frames -- is correct and reusable for an idea that is not a fade.

import { atr, ema } from "../src/indicators.mjs";
import { resample } from "../src/resample.mjs";
import base from "./macd_1m_flip.mjs";

const MTF = 5;

export default {
  ...base,

  id: "macd_mtf_confirm",
  name: "MACD multi-timeframe — 5-min arms, 1-min triggers, EMA confirms",
  description: "The 5-minute anticipation sets a direction, a 1-minute MACD crossover in that direction opens the trade, a 1-minute EMA cross confirms holding it, and the position runs to a 3x ATR target. Signals from the 5-minute frame are anchored to the close of their bar, so nothing reads ahead.",

  timeframeMin: 1,
  warmupBars: 2000,

  execDefaults: {
    ...base.execDefaults,
    slAtrMult: 2, tpMode: "atr", tpAtrMult: 3,
    flipOnOpposite: true,
    intradayOnly: false,
  },
  rulesDefaults: { circuitBreaker: 0, dailyProfitStop: 0 },

  params: [
    ...base.params,

    { key: "prox", label: "5-min proximity to zero", type: "float",
      min: 0.025, max: 1.5, step: 0.025, default: 0.075, group: "5-min arm",
      hint: "How close the 5-minute histogram must be to zero, as a fraction of its own trailing average. This is the setting the quiet gate was validated on." },
    { key: "shrinkBars", label: "5-min shrinking bars required", type: "int",
      min: 1, max: 8, step: 1, default: 3, group: "5-min arm" },
    { key: "scaleBars", label: "Bars in the |hist| average", type: "int",
      min: 50, max: 500, step: 25, default: 200, group: "5-min arm" },
    { key: "armBars", label: "Arm stays live for (1-min bars)", type: "int",
      min: 2, max: 120, step: 1, default: 30, group: "5-min arm",
      hint: "How long a 5-minute arm waits for its 1-minute trigger before expiring. Too short and the trigger never lands; too long and the arm no longer describes the tape it fires into." },

    { key: "emaFast", label: "1-min EMA fast", type: "int",
      min: 2, max: 100, step: 1, default: 9, group: "1-min confirm" },
    { key: "emaSlow", label: "1-min EMA slow", type: "int",
      min: 3, max: 300, step: 1, default: 21, group: "1-min confirm" },
    { key: "confirmMode", label: "How the EMA is used", type: "select",
      default: "hold", group: "1-min confirm",
      options: [["hold", "Exit when the EMA turns against"],
                ["entry", "Require EMA agreement at entry"],
                ["invert", "Exit when the EMA comes ROUND to the trade"],
                ["off", "Ignore the EMA"]] },

    { key: "atrTf", label: "ATR measured on", type: "select",
      default: "5m", group: "Bracket",
      options: [["1m", "1-minute bars"], ["5m", "5-minute bars"]],
      hint: "A 3x ATR target means very different things here. On 1-minute bars ATR(14) spans fourteen minutes and the target is tight; on 5-minute bars it is roughly the move of an hour." },

    { key: "sessionGate", label: "When may it enter", type: "select",
      default: "overnight", group: "Quiet gate",
      options: [["overnight", "Overnight only"], ["rth", "RTH only"], ["any", "Any time"]] },
    { key: "adrMax", label: "Max share of ADR already spent", type: "float",
      min: 0.1, max: 2, step: 0.05, default: 0.5, group: "Quiet gate",
      hint: "Set to 2 to switch the gate off. It is the only filter in this family that survived a matched null, so it is on by default." },
    { key: "adrDays", label: "Days in the ADR average", type: "int",
      min: 3, max: 40, step: 1, default: 14, group: "Quiet gate" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, ctMin, tday } = bars;
    const n = C.length;

    // ── the 1-minute layer ────────────────────────────────────────────
    // base.compute gives the 1-minute MACD and its crossover signal, which is
    // the trigger, plus the overlays the chart draws.
    const out = base.compute(bars, p);
    const hist1 = out.overlays.find((o) => o.kind === "hist").data;
    const cross1 = out.sig;

    // ── the 5-minute layer ────────────────────────────────────────────
    const tf5 = resample(bars, MTF);
    const o5 = base.compute(tf5, p);
    const hist5 = o5.overlays.find((o) => o.kind === "hist").data;
    const n5 = hist5.length;

    const win = Math.max(10, Math.trunc(p.scaleBars) || 200);
    const scale5 = new Float64Array(n5).fill(NaN);
    {
      let sum = 0;
      for (let i = 0; i < n5; i++) {
        const a = Math.abs(hist5[i]);
        if (Number.isFinite(a)) sum += a;
        if (i >= win) sum -= Math.abs(hist5[i - win]) || 0;
        if (i >= win - 1) scale5[i] = sum / win;
      }
    }

    // The anticipation, on the 5-minute frame.
    const need = Math.max(1, Math.trunc(p.shrinkBars) || 1);
    const arm5 = new Int8Array(n5);
    let run = 0;
    for (let i = 1; i < n5; i++) {
      const v = hist5[i], u = hist5[i - 1];
      if (!Number.isFinite(v) || !Number.isFinite(u) || !Number.isFinite(scale5[i])) {
        run = 0; continue;
      }
      run = Math.abs(v) < Math.abs(u) ? run + 1 : 0;
      if (run < need) continue;
      if (!(Math.abs(v) < p.prox * scale5[i])) continue;
      arm5[i] = v >= 0 ? -1 : 1;
    }

    // ── project the arm down, anchored to the 5-min bar's CLOSE ───────
    // srcLast[k] is the last 1-minute bar inside 5-minute bar k, so its signal
    // is first usable at srcLast[k] + 1. Anything earlier would be lookahead.
    const armBars = Math.max(1, Math.trunc(p.armBars) || 30);
    const armed = new Int8Array(n);
    const last5 = tf5.srcLast;
    for (let k = 0; k < n5; k++) {
      const d = arm5[k];
      if (!d) continue;
      const from = (last5 ? last5[k] : k * MTF) + 1;
      const to = Math.min(n - 1, from + armBars - 1);
      for (let i = from; i <= to; i++) armed[i] = d;
    }

    // ── the quiet gate ────────────────────────────────────────────────
    const adrDays = Math.max(2, Math.trunc(p.adrDays) || 14);
    const adrUsed = new Float64Array(n).fill(NaN);
    if (tday) {
      const ranges = [];
      let dHi = -Infinity, dLo = Infinity, adr = NaN, cur = tday[0];
      for (let i = 0; i < n; i++) {
        if (tday[i] !== cur) {
          cur = tday[i];
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
    const quiet = (i) => {
      const ct = ctMin ? ctMin[i] : 0;
      const night = ct < 510 || ct >= 900;
      if (gate === "overnight" && !night) return false;
      if (gate === "rth" && night) return false;
      if (adrMax >= 2) return true;
      return Number.isFinite(adrUsed[i]) && adrUsed[i] < adrMax;
    };

    // ── the 1-minute EMA confirmation ─────────────────────────────────
    const ef = ema(C, Math.max(2, Math.trunc(p.emaFast) || 9));
    const es = ema(C, Math.max(3, Math.trunc(p.emaSlow) || 21));
    const emaDir = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(ef[i]) || !Number.isFinite(es[i])) continue;
      emaDir[i] = ef[i] > es[i] ? 1 : ef[i] < es[i] ? -1 : 0;
    }
    const mode = p.confirmMode || "hold";

    // ── entry: armed direction AND a 1-minute cross the same way ──────
    const sig = new Int8Array(n);
    for (let i = 1; i < n; i++) {
      const d = armed[i];
      if (!d || cross1[i] !== d) continue;
      if (!quiet(i)) continue;
      if (mode === "entry" && emaDir[i] !== d) continue;
      sig[i] = d;
    }

    // ── exit: the EMA withdrawing its permission ──────────────────────
    let exitSig = null;
    if (mode === "hold" || mode === "invert") {
      // "invert" is the reading the diagnostic forces. The 1-minute EMA agrees
      // with the arm only 35% of the time at the trigger, because the arm is a
      // fade and the EMA follows the push it is fading. Treating EMA agreement
      // as a reason to LEAVE turns it from a confirmation into a take-profit:
      // the trend has caught up, the anticipation has paid, get out.
      const flipIt = mode === "invert";
      exitSig = new Int8Array(n);
      for (let i = 0; i < n; i++) {
        const d = flipIt ? -emaDir[i] : emaDir[i];
        if (d === -1) exitSig[i] |= 1;        // close longs
        else if (d === 1) exitSig[i] |= 2;    // close shorts
      }
    }

    // ── ATR for the bracket ───────────────────────────────────────────
    // On 5-minute bars the same multiple is a much wider target, so the choice
    // changes the strategy rather than merely scaling it. Mapped back down by
    // the bar each 1-minute index belongs to.
    let a = atr(H, L, C, p.atrPeriod);
    if (p.atrTf === "5m") {
      const a5 = atr(tf5.high, tf5.low, tf5.close, p.atrPeriod);
      const up = new Float64Array(n).fill(NaN);
      for (let k = 0; k < n5; k++) {
        const s = tf5.srcFirst ? tf5.srcFirst[k] : k * MTF;
        const e = Math.min(n - 1, tf5.srcLast ? tf5.srcLast[k] : s + MTF - 1);
        // Bar k's ATR is known at its close, so it applies from the NEXT bar.
        for (let i = e + 1; i <= Math.min(n - 1, e + MTF); i++) up[i] = a5[k];
      }
      let prev = NaN;
      for (let i = 0; i < n; i++) {
        if (Number.isFinite(up[i])) prev = up[i];
        up[i] = prev;
      }
      a = up;
    }

    return { ...out, sig, exitSig, atr: a };
  },
};
