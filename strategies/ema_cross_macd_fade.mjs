// EMA crossover in, MACD-histogram fade out -- each on its own timeframe.
//
// ENTRY  a fast EMA crossing a slow EMA on the EMA timeframe: up = long, down =
//        short, acted on at the first base bar after that timeframe's bar closes.
// EXIT   the MACD histogram, on its OWN timeframe, fading: for a long, a positive
//        histogram that has shrunk for `fadeBars` bars in a row -- the push that
//        carried the cross running out while still on the trade's side -- and the
//        mirror for a short. Backstops: the histogram crossing against the trade
//        (optional), the EMAs crossing back (the engine's opposite-signal flip,
//        under Execution), and the bracket's stop. The target defaults to off
//        (1000 x ATR) so the fade decides the exit; set one under Execution.
//
// Both frames are rebuilt clock-aligned from the base bars the engine fills on
// (the "Signal timeframe", 1 minute by default), so they can be set apart --
// 5-minute EMAs with a 1-minute fade, or the reverse. A frame's values are used
// only from the base bar its own bar closes on; the engine acts at the next one,
// so nothing reads ahead. A frame finer than the base runs at the base.
//
// The exit is a mask the engine reads (bit 1 closes a long, 2 a short), built
// without knowing the position, so a fade already under way when a trade opens
// closes it on the next fading bar. `minHoldBars` stops that if wanted.
//
// Untested -- a starting point to measure, not a result.

import { ema, macd, atr } from "../src/indicators.mjs";
import { resample } from "../src/resample.mjs";
import { chk, trig, verdict, num, px, spark, mark } from "../src/explain.mjs";

// A frame of `min` minutes on base bars of `baseMin`: a whole multiple of the
// base, never finer than it.
const frameMin = (min, baseMin) => Math.max(1, Math.round((Number(min) || baseMin) / baseMin)) * baseMin;
const int = (v, lo, dflt) => Math.max(lo, Math.trunc(v) || dflt);

export default {
  id: "ema_cross_macd_fade",
  name: "EMA crossover — exit on MACD histogram fade (own timeframes)",
  description: "Enters on a fast/slow EMA crossover and exits when the MACD histogram fades, each on its own timeframe -- e.g. 5-minute EMAs with a 1-minute MACD fade. Stop from the bracket; the target is off by default so the fade decides the exit.",

  timeframeMin: 1,
  // Both EMA-based layers must have forgotten their seed by the window's first
  // bar: ten slow periods of the slower frame, in base bars.
  warmupBars: (p) => {
    const base = p.timeframeMin || 1;
    // The periods compute() actually uses: slow is at least fast + 1 (fuzz-found:
    // a fast 167 over a slow 21 runs a 168 EMA, which the bare slow understated).
    const e = Math.max(int(p.emaFast, 2, 9) + 1, int(p.emaSlow, 3, 21)) * frameMin(p.emaTfMin, base);
    const x = (Math.max(int(p.macdFast, 2, 12) + 1, int(p.macdSlow, 3, 26)) + int(p.macdSignal, 2, 9)) * frameMin(p.exitTfMin, base);
    const a = int(p.atrPeriod, 2, 14) * frameMin(p.atrTf === "macd" ? p.exitTfMin : p.atrTf === "ema" ? p.emaTfMin : base, base);
    return Math.ceil((10 * Math.max(e, x, a)) / base) + 50;
  },
  execDefaults: { contracts: 4, sizingMode: "fixed", slAtrMult: 2, tpMode: "atr", tpAtrMult: 1000, flipOnOpposite: true },

  params: [
    { key: "emaTfMin", label: "EMA timeframe (min)", type: "int", min: 1, max: 60, step: 1, default: 5, group: "Entry: EMA crossover",
      hint: "Rebuilt from the base bars (the Signal timeframe above), so it can differ from the MACD's." },
    { key: "emaFast", label: "Fast EMA", type: "int", min: 2, max: 200, step: 1, default: 9, group: "Entry: EMA crossover" },
    { key: "emaSlow", label: "Slow EMA", type: "int", min: 3, max: 400, step: 1, default: 21, group: "Entry: EMA crossover" },
    { key: "direction", label: "Trade", type: "select", default: "both", group: "Entry: EMA crossover",
      options: [["both", "Long and short"], ["long", "Long only"], ["short", "Short only"]] },
    { key: "entryFilter", label: "Entry also needs", type: "select", default: "none", group: "Entry: EMA crossover",
      options: [["none", "Nothing -- the cross alone"], ["macdSide", "MACD histogram on the trade's side"],
                ["macdRising", "MACD histogram moving the trade's way"]] },
    { key: "crossBack", label: "When the EMAs cross back", type: "select", default: "flip", group: "Entry: EMA crossover",
      options: [["flip", "Reverse (one-way books: exit)"], ["exit", "Exit, never reverse"]],
      hint: "Reversing needs Execution → 'Close on opposite signal' on, the default. Turn that off as well as choosing Exit to leave only the fade and the stop." },

    { key: "exitTfMin", label: "MACD fade timeframe (min)", type: "int", min: 1, max: 60, step: 1, default: 1, group: "Exit: MACD histogram fade" },
    { key: "macdFast", label: "MACD fast", type: "int", min: 2, max: 100, step: 1, default: 12, group: "Exit: MACD histogram fade" },
    { key: "macdSlow", label: "MACD slow", type: "int", min: 3, max: 200, step: 1, default: 26, group: "Exit: MACD histogram fade" },
    { key: "macdSignal", label: "MACD signal", type: "int", min: 2, max: 50, step: 1, default: 9, group: "Exit: MACD histogram fade" },
    { key: "fadeBars", label: "Shrinking bars that make a fade", type: "int", min: 1, max: 10, step: 1, default: 2, group: "Exit: MACD histogram fade",
      hint: "Consecutive MACD-timeframe bars of the histogram moving back toward zero. 1 exits on the first shrinking bar." },
    { key: "fadeSide", label: "A fade counts", type: "select", default: "trade", group: "Exit: MACD histogram fade",
      options: [["trade", "Only while the histogram is on the trade's side"], ["any", "On any run against the trade"]],
      hint: "'Any' also exits a long whose histogram is negative and still falling -- momentum against the trade from the start." },
    { key: "exitOnCross", label: "Also exit when the histogram crosses against", type: "select", default: "on", group: "Exit: MACD histogram fade",
      options: [["on", "Yes"], ["off", "No"]] },
    { key: "minHoldBars", label: "Ignore fades for the first (base bars)", type: "int", min: 0, max: 240, step: 1, default: 0, group: "Exit: MACD histogram fade",
      hint: "Applied after each EMA cross, since the exit mask cannot see the position. 0 = off." },

    { key: "atrTf", label: "ATR (stop / target) measured on", type: "select", default: "ema", group: "Bracket",
      options: [["base", "Base bars"], ["ema", "The EMA timeframe"], ["macd", "The MACD timeframe"]] },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Bracket" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C } = bars;
    const n = C.length;
    const base = p.timeframeMin || 1;
    const eTf = frameMin(p.emaTfMin, base), xTf = frameMin(p.exitTfMin, base);
    // A frame of the base bars, or the base itself; srcLast[k] is the base bar
    // its bar k closes on -- the first place that bar's values may be used.
    const frameOf = (m) => (m === base ? { f: bars, last: null } : (() => { const f = resample(bars, m); return { f, last: f.srcLast }; })());
    const E = frameOf(eTf), X = frameOf(xTf);
    const lastOf = (fr, k) => (fr.last ? fr.last[k] : k);
    // A frame series held at each base bar: the value of the latest frame bar
    // closed at or before it.
    const hold = (fr, src) => {
      const out = new Float64Array(n).fill(NaN);
      const m = src.length;
      for (let k = 0; k < m; k++) {
        const from = lastOf(fr, k), to = k + 1 < m ? lastOf(fr, k + 1) : n;
        for (let i = from; i < Math.min(n, to); i++) out[i] = src[k];
      }
      return out;
    };

    // ── entry: the EMA cross on its frame ──
    const ce = E.f.close, ne = ce.length;
    const fast = int(p.emaFast, 2, 9), slow = Math.max(fast + 1, int(p.emaSlow, 3, 21));
    const ef = ema(ce, fast), es = ema(ce, slow);

    // ── exit: the MACD histogram on its frame ──
    const cx = X.f.close, nx = cx.length;
    const mf = int(p.macdFast, 2, 12), ms = Math.max(mf + 1, int(p.macdSlow, 3, 26)), msig = int(p.macdSignal, 2, 9);
    const m = macd(cx, mf, ms, msig);
    const hist = m.hist;
    const histNow = hold(X, hist);
    const histPrev = hold(X, Float64Array.from(hist, (v, k) => (k ? hist[k - 1] : NaN)));

    const dir = p.direction || "both";
    const filt = p.entryFilter || "none";
    // The cross back closes the trade through the exit mask when the engine's
    // flip cannot: a one-way book never sees the opposite signal, and "exit"
    // wants no reversal (a signal exit ends the bar, so nothing re-enters).
    const backExits = p.crossBack === "exit" || dir !== "both";
    const sig = new Int8Array(n);
    const crossExit = new Int8Array(n);
    const crossAt = new Int32Array(n).fill(-1);       // base bar of the latest EMA cross, for minHoldBars
    for (let k = 1; k < ne; k++) {
      if (!Number.isFinite(ef[k]) || !Number.isFinite(es[k]) || !Number.isFinite(ef[k - 1]) || !Number.isFinite(es[k - 1])) continue;
      const d = ef[k] > es[k] && ef[k - 1] <= es[k - 1] ? 1 : ef[k] < es[k] && ef[k - 1] >= es[k - 1] ? -1 : 0;
      if (!d) continue;
      const i = lastOf(E, k);
      crossAt[i] = i;
      if (backExits) crossExit[i] = d === 1 ? 2 : 1;  // up closes shorts, down closes longs
      if ((dir === "long" && d !== 1) || (dir === "short" && d !== -1)) continue;
      const h = histNow[i], hp = histPrev[i];
      if (filt === "macdSide" && !(Number.isFinite(h) && h * d > 0)) continue;
      if (filt === "macdRising" && !(Number.isFinite(h) && Number.isFinite(hp) && (h - hp) * d > 0)) continue;
      sig[i] = d;
    }

    // The fade, per MACD-frame bar, as a mask on the base bar it closes on.
    const need = int(p.fadeBars, 1, 2);
    const anySide = p.fadeSide === "any";
    const onCross = p.exitOnCross !== "off";
    const exitSig = new Int8Array(n);
    let down = 0, up = 0;                              // consecutive bars falling / rising
    for (let k = 1; k < nx; k++) {
      const v = hist[k], u = hist[k - 1];
      if (!Number.isFinite(v) || !Number.isFinite(u)) { down = 0; up = 0; continue; }
      down = v < u ? down + 1 : 0;
      up = v > u ? up + 1 : 0;
      let mask = 0;
      if (down >= need && (anySide || v > 0)) mask |= 1;        // a long's push draining
      if (up >= need && (anySide || v < 0)) mask |= 2;          // a short's
      if (onCross && v <= 0 && u > 0) mask |= 1;
      if (onCross && v >= 0 && u < 0) mask |= 2;
      if (mask) exitSig[lastOf(X, k)] |= mask;
    }
    // Hold through FADES for the first minHoldBars base bars after each cross;
    // the cross-back exit is the cross itself, so it is merged in afterwards.
    const hold0 = Math.max(0, Math.trunc(p.minHoldBars) || 0);
    if (hold0 > 0) {
      let last = -1;
      for (let i = 0; i < n; i++) {
        if (crossAt[i] >= 0) last = i;
        if (last >= 0 && i - last < hold0) exitSig[i] = 0;
      }
    }
    for (let i = 0; i < n; i++) exitSig[i] |= crossExit[i];

    // ── ATR for the bracket, on the chosen frame, held to the base bars ──
    const A = p.atrTf === "base" ? { f: bars, last: null } : p.atrTf === "macd" ? X : E;
    const aSrc = atr(A.f.high, A.f.low, A.f.close, int(p.atrPeriod, 2, 14));
    const a = A.last ? hold(A, aSrc) : aSrc;

    let mx = 0;
    for (const v of hist) if (Number.isFinite(v) && Math.abs(v) > mx) mx = Math.abs(v);
    const r = [-mx * 1.05 || -1, mx * 1.05 || 1];

    // Bar k: the EMA cross of the frame bar that closes on it (the loop's
    // lastOf), the direction allowed, and the MACD condition at entry.
    const efH = hold(E, ef), esH = hold(E, es);
    const frameAt = (k) => {
      if (!E.last) return k;
      let lo = 0, hi = ne - 1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (E.last[m] === k) return m; if (E.last[m] < k) lo = m + 1; else hi = m - 1; }
      return -1;
    };
    const explain = (k) => {
      const q = frameAt(k);
      const ok = q >= 1 && Number.isFinite(ef[q]) && Number.isFinite(es[q]) && Number.isFinite(ef[q - 1]) && Number.isFinite(es[q - 1]);
      const d = ok ? (ef[q] > es[q] && ef[q - 1] <= es[q - 1] ? 1 : ef[q] < es[q] && ef[q - 1] >= es[q - 1] ? -1 : 0) : 0;
      const checks = [trig(d ? `${eTf}-min EMA ${fast} crossed ${d === 1 ? "above" : "below"} EMA ${slow}` : `A ${eTf}-min EMA ${fast} / ${slow} cross`, !!d,
                           { text: q < 0 ? `no ${eTf}-min bar closes on this bar` : ok ? `${px(ef[q])} vs ${px(es[q])} (were ${px(ef[q - 1])} vs ${px(es[q - 1])})` : "not formed yet",
                             spark: spark(k, [[efH, "#4aa3ff", `EMA ${fast}`], [esH, "#e0894a", `EMA ${slow}`]], { n: 40 * Math.max(1, eTf / base) }) })];
      if (d && dir !== "both") checks.push(chk(`${dir === "long" ? "Long" : "Short"} only`, dir === "long" ? d === 1 : d === -1, { text: d === 1 ? "a long cross" : "a short cross" }));
      const h = histNow[k], hp = histPrev[k];
      if (d && filt === "macdSide") checks.push(chk(`${xTf}-min MACD histogram on the trade's side`, Number.isFinite(h) && h * d > 0, { text: num(h) }));
      if (d && filt === "macdRising") checks.push(chk(`${xTf}-min MACD histogram moving the trade's way`, Number.isFinite(h) && Number.isFinite(hp) && (h - hp) * d > 0, { text: `${num(hp)} → ${num(h)}` }));
      const marks = d ? [mark.dot(k, (efH[k] + esH[k]) / 2, "EMA cross", { color: "#f0b429" })] : [];
      return { dir: verdict(d, checks), checks, marks, title: d ? `EMA ${fast} / ${slow} cross ${d === 1 ? "up" : "down"}` : "No EMA cross" };
    };
    const exitRule = `the ${xTf}-min MACD histogram ${need} bar${need === 1 ? "" : "s"} back toward zero${onCross ? ", or crossing against the trade" : ""}${backExits ? ", or the EMAs crossing back" : ""}`;

    return {
      sig, exitSig, atr: a, explain, exitRule,
      overlays: [
        { name: `EMA ${fast} (${eTf}m)`, pane: "price", color: "#4aa3ff", data: efH },
        { name: `EMA ${slow} (${eTf}m)`, pane: "price", color: "#e0894a", data: esH },
        { name: `Histogram (${xTf}m)`, pane: "sub", kind: "hist", data: histNow,
          colorUp: "#26a65b", colorUpFade: "#7fd4a0", colorDown: "#d1566e", colorDownFade: "#eda2b0",
          threshold: 0, autoRange: true, range: r },
        { name: `MACD (${xTf}m)`, pane: "sub", color: "#4aa3ff", data: hold(X, m.line), autoRange: true, range: r },
        { name: `Signal (${xTf}m)`, pane: "sub", color: "#e0894a", data: hold(X, m.signal), autoRange: true, range: r },
      ],
    };
  },
};
