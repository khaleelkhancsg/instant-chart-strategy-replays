// Stage 5: look for PATTERNS around a Donchian signal that say take it, size
// it down, skip it, or get out -- the way "three histogram bars in a row"
// read direction on the MACD. Weighted to 2026 above everything else, as
// asked: a pattern counts if it helps 2026, whatever it does in other years.
//
// ~40 readings are taken at the signal bar, all from bars already closed:
//   the break      how far past the channel, channel width, the signal bar's
//                  range, body and close position, closes in a row with it
//   momentum       MACD histogram bars in a row rising with the break (2-min
//                  and 5-min), histogram sign, RSI, stochastic, CCI, ADX and
//                  its slope, efficiency, choppiness
//   trend/context  slow trend and its strength, distance from EMA 20 and RTH
//                  VWAP, 15-min EMA slope, 5-min channel break, volume, ATR vs
//                  its recent average, Bollinger squeeze before the break
//   the day        time, weekday, how far the day has run vs its average
//                  range, the day's range so far, gap, prior day's direction,
//                  beyond the prior day's high/low, overnight range
//   inside the bar the two 1-minute bars that make the 2-minute signal bar,
//                  1-minute closes in a row
//   other          bars since the last signal, signals earlier today, the
//                  rescued flag, distance to the next round 100 in the way
//
// Each reading is cut at the quintiles of its own distribution over the live
// trades, and every cut is tried three ways through the real engine:
//   SKIP  the signal does not arm (it still closes an opposite position)
//   HALF  it arms at 4 lots instead of 8
//   ADD   near-miss breakouts the gates reject (efficiency or ADX too low)
//         are ADDED when the reading is on the good side of the cut
// plus in-trade ABANDON patterns read on each closed bar after the fill.
//
// Judged on 2026. Because one 2026 day moves the pass rate ~3.5pp, each rule
// also shows January-March vs April-July of 2026 and 2026 with its best three
// days put back to the live book's; the best rules are then compared with
// removing the same number of trades AT RANDOM. 2025 and the full history are
// printed for context only.
//
// RESULT: 14 of 872 rules hold up inside 2026, but that is not more than
// chance: donchian_extension.mjs measures random SKIP rules passing the same
// test 9.3% of the time (~26 of 280 expected; 11 found) and random HALF-size
// rules 0.7% (~2 expected; 2 found). Selection does not carry within 2026
// either: the best rule picked on Jan-Mar is 5-10pp WORSE than the live book
// on Apr-Jul, and the reverse is worse still. The MACD "bars rising with the
// break" reading does not separate 2026 trades. What recurs is a theme, not a
// rule: breakouts taken after the move is already stretched (the day's range
// near its average, far from VWAP, stochastic pinned) do badly in 2026 --
// followed up in donchian_extension.mjs.
//
//   node --max-old-space-size=6144 research/donchian_patterns.mjs

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { ema, sma, atr, adx, rsi, donchian, efficiencyRatio, macd, stochastic, cci } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";

const T0 = Date.now();
const { bars } = loadBars();
const tf = resample(bars, 2), tf5 = resample(bars, 5), tf15 = resample(bars, 15);
const { open: O, high: H, low: L, close: C, volume: V, ctMin: CT, tday: TD, ts: TS } = tf;
const n2 = C.length, n1 = bars.count;
const A = atr(H, L, C, 14);
const { adx: ax } = adx(H, L, C, 14);
const { high: dh, low: dl } = donchian(H, L, 30);
const RAW = new Int8Array(n2), RAW0 = new Int8Array(n2);       // RAW0: breakouts before the ADX test
for (let i = 30; i < n2; i++) {
  const d = C[i] > dh[i] ? 1 : C[i] < dl[i] ? -1 : 0;
  RAW0[i] = d; if (ax[i] >= 25) RAW[i] = d;
}
const fctx = buildFilterContext(tf);
const gate = (r, e) => applyFilters(r, fctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: e });
const G05 = gate(RAW, 0.5), G045 = gate(RAW, 0.45);
const E125 = ema(C, 125), E500 = ema(C, 500);
const RESC = Int8Array.from(G05);
for (let k = 0; k < n2; k++) if (G045[k] && !G05[k] && Math.sign(E125[k] - E500[k]) === RAW[k]) RESC[k] = G045[k];

// ---- readings ------------------------------------------------------------------
const MH = macd(C, 12, 26, 9).hist, E20 = ema(C, 20), RSI = rsi(C, 14), VA = sma(V, 20);
const ST = stochastic(H, L, C, 14, 3).k, CCI = cci(H, L, C, 20), ASMA = sma(A, 3000);
const lastDone = (t) => { const nX = t.close.length, out = new Int32Array(n1).fill(-1); let j = 0, cur = -1;
  for (let i = 0; i < n1; i++) { while (j < nX && t.srcLast[j] <= i) { cur = j; j++; } out[i] = cur; } return out; };
const K5 = lastDone(tf5), K15 = lastDone(tf15);
const MH5 = macd(tf5.close, 12, 26, 9).hist, DC5 = donchian(tf5.high, tf5.low, 30), E20_15 = ema(tf15.close, 20);
// the RTH session: open, running high/low, prior day's levels, average range
const rthOpen = new Float64Array(n2).fill(NaN), rthHi = new Float64Array(n2).fill(NaN), rthLo = new Float64Array(n2).fill(NaN);
const dayInfo = new Map();                                     // tday -> {o,h,l,c, onHi, onLo}
{
  let day = -1, o = NaN, h = -Infinity, l = Infinity, onH = -Infinity, onL = Infinity, c = NaN;
  for (let i = 0; i < n2; i++) {
    if (TD[i] !== day) {
      if (day !== -1) dayInfo.set(day, { o, h, l, c, onH, onL });
      day = TD[i]; o = NaN; h = -Infinity; l = Infinity; onH = -Infinity; onL = Infinity; c = NaN;
    }
    if (CT[i] >= 510 && CT[i] < 900) {
      if (Number.isNaN(o)) o = O[i];
      if (H[i] > h) h = H[i]; if (L[i] < l) l = L[i]; c = C[i];
      rthOpen[i] = o; rthHi[i] = h; rthLo[i] = l;
    } else if (Number.isNaN(o)) { if (H[i] > onH) onH = H[i]; if (L[i] < onL) onL = L[i]; }
  }
  dayInfo.set(day, { o, h, l, c, onH, onL });
}
const dayKeys = [...dayInfo.keys()], prevOf = new Map(), adr10 = new Map();
for (let j = 1; j < dayKeys.length; j++) {
  prevOf.set(dayKeys[j], dayInfo.get(dayKeys[j - 1]));
  const rng = dayKeys.slice(Math.max(0, j - 10), j).map((d) => dayInfo.get(d)).filter((x) => x.h > x.l).map((x) => x.h - x.l);
  if (rng.length) adr10.set(dayKeys[j], rng.reduce((a, b) => a + b, 0) / rng.length);
}
const VW = new Float64Array(n2).fill(NaN);                   // RTH VWAP from 08:30 CT
{
  let pv = 0, vv = 0, day = -1, on = false;
  for (let i = 0; i < n2; i++) {
    if (TD[i] !== day) { day = TD[i]; on = false; }
    if (CT[i] >= 510 && CT[i] < 960) {
      if (!on) { pv = 0; vv = 0; on = true; }
      const tp = (H[i] + L[i] + C[i]) / 3;
      pv += tp * V[i]; vv += V[i];
      VW[i] = vv > 0 ? pv / vv : tp;
    }
  }
}
const sigIdx = []; for (let k = 0; k < n2; k++) if (RESC[k]) sigIdx.push(k);
const prevSig = new Int32Array(n2).fill(-1), sigToday = new Int16Array(n2);
{ let last = -1, day = -1, cnt = 0;
  for (let k = 0; k < n2; k++) { if (TD[k] !== day) { day = TD[k]; cnt = 0; } prevSig[k] = last; sigToday[k] = cnt; if (RESC[k]) { last = k; cnt++; } } }
const runOf = (k, d, f, max = 8) => { let n = 0; while (n < max && k - n - 1 >= 0 && f(k - n) * d > 0) n++; return n; };

const FEATS = [
  ["break past the channel (ATR)", (k, d) => (C[k] - (d === 1 ? dh[k] : dl[k])) * d / A[k]],
  ["channel width (ATR)", (k) => (dh[k] - dl[k]) / A[k]],
  ["signal bar range (ATR)", (k) => (H[k] - L[k]) / A[k]],
  ["signal bar body with the break (ATR)", (k, d) => (C[k] - O[k]) * d / A[k]],
  ["close position in the signal bar", (k, d) => (H[k] > L[k] ? (d === 1 ? (C[k] - L[k]) : (H[k] - C[k])) / (H[k] - L[k]) : 0.5)],
  ["2-min closes in a row with the break", (k, d) => runOf(k, d, (j) => C[j] - C[j - 1])],
  ["2-min MACD hist bars rising with the break", (k, d) => runOf(k, d, (j) => MH[j] - MH[j - 1])],
  ["2-min MACD hist on the break's side", (k, d) => (MH[k] * d > 0 ? 1 : 0)],
  ["5-min MACD hist bars rising with the break", (k, d) => { const j = K5[tf.srcLast[k]]; return j < 1 ? 0 : runOf(j, d, (x) => MH5[x] - MH5[x - 1]); }],
  ["ADX", (k) => ax[k]],
  ["ADX change over 3 bars", (k) => ax[k] - ax[k - 3]],
  ["efficiency (20)", (k) => fctx.eff[k]],
  ["choppiness (14)", (k) => fctx.chop[k]],
  ["slow trend agrees (EMA 125/500)", (k, d) => Math.sign(E125[k] - E500[k]) * d],
  ["slow trend strength with the break (ATR)", (k, d) => (E125[k] - E500[k]) * d / A[k]],
  ["stretch from EMA 20 (ATR)", (k, d) => (C[k] - E20[k]) * d / A[k]],
  ["stretch from RTH VWAP (ATR)", (k, d) => (Number.isFinite(VW[k]) ? (C[k] - VW[k]) * d / A[k] : 0)],
  ["volume vs 20-bar average", (k) => (VA[k] > 0 ? V[k] / VA[k] : 1)],
  ["ATR vs its 4-day average", (k) => (ASMA[k] > 0 ? A[k] / ASMA[k] : 1)],
  ["RSI (14) with the break", (k, d) => (d === 1 ? RSI[k] : 100 - RSI[k])],
  ["stochastic %K with the break", (k, d) => (d === 1 ? ST[k] : 100 - ST[k])],
  ["CCI (20) with the break", (k, d) => CCI[k] * d],
  ["Bollinger width vs its 100-bar average", (k) => { let s = 0, m = 0; for (let j = k - 100; j < k; j++) if (Number.isFinite(fctx.bw[j])) { s += fctx.bw[j]; m++; } return m ? fctx.bw[k - 1] / (s / m) : 1; }],
  ["15-min EMA 20 sloping with the break", (k, d) => { const j = K15[tf.srcLast[k]]; return j < 1 ? 0 : Math.sign(E20_15[j] - E20_15[j - 1]) * d; }],
  ["also a 5-min 30-bar breakout", (k, d) => { const j = K5[tf.srcLast[k]]; return j < 0 ? 0 : (d === 1 ? C[k] > DC5.high[j] : C[k] < DC5.low[j]) ? 1 : 0; }],
  ["time of day (CT minute)", (k) => CT[k]],
  ["weekday (Mon=1)", (k) => new Date(TS[k] - 5 * 3600e3).getUTCDay()],
  ["day's move so far with the break (x ADR)", (k, d) => { const a = adr10.get(TD[k]); return a ? (C[k] - rthOpen[k]) * d / a : 0; }],
  ["day's range so far (x ADR)", (k) => { const a = adr10.get(TD[k]); return a ? (rthHi[k] - rthLo[k]) / a : 0; }],
  ["gap with the break (x ADR)", (k, d) => { const a = adr10.get(TD[k]), p = prevOf.get(TD[k]); return a && p ? (rthOpen[k] - p.c) * d / a : 0; }],
  ["prior day closed with the break", (k, d) => { const p = prevOf.get(TD[k]); return p ? Math.sign(p.c - p.o) * d : 0; }],
  ["beyond the prior day's high/low", (k, d) => { const p = prevOf.get(TD[k]); return p ? ((d === 1 ? C[k] > p.h : C[k] < p.l) ? 1 : 0) : 0; }],
  ["overnight range (x ADR)", (k) => { const a = adr10.get(TD[k]), x = dayInfo.get(TD[k]); return a && x.onH > x.onL ? (x.onH - x.onL) / a : 0; }],
  ["later 1-min bar of the signal bar with the break", (k, d) => { const j = tf.srcLast[k]; return Math.sign(bars.close[j] - bars.open[j]) * d; }],
  ["1-min closes in a row with the break", (k, d) => { const j = tf.srcLast[k]; let n = 0; while (n < 8 && (bars.close[j - n] - bars.close[j - n - 1]) * d > 0) n++; return n; }],
  ["bars since the previous signal", (k) => (prevSig[k] < 0 ? 999 : Math.min(999, k - prevSig[k]))],
  ["signals earlier today", (k) => sigToday[k]],
  ["rescued (efficiency 0.45-0.5)", (k) => (G05[k] ? 0 : 1)],
  ["room to the next round 100 in the way (ATR)", (k, d) => { const nx = d === 1 ? Math.ceil(C[k] / 100) * 100 : Math.floor(C[k] / 100) * 100; return Math.abs(nx - C[k]) / A[k]; }],
  ["minutes since the RTH open", (k) => CT[k] - 510],
];

// ---- scoring, 2026 first -------------------------------------------------------------
const days = S.days;
const yIdx = (f) => days.map((d, k) => (f(d) ? k : -1)).filter((k) => k >= 0);
const yr = (d) => S.yearOf.get(d);
const mo = new Map(); for (let i = 0; i < n2; i++) if (!mo.has(TD[i])) mo.set(TD[i], new Date(TS[i] + 86400e3 / 2).getUTCMonth());
const Y26 = yIdx((d) => yr(d) === 2026), Y25 = yIdx((d) => yr(d) === 2025);
const Y26a = yIdx((d) => yr(d) === 2026 && mo.get(d) < 3), Y26b = yIdx((d) => yr(d) === 2026 && mo.get(d) >= 3);
const at = (arr, ix) => S.passArr(ix.map((k) => arr[k]));
function evalRun(sizer, opts = {}) {
  const tr = S.run(sizer, { signals: RESC, ...opts });
  const arr = S.dayArr(tr, days);
  return { tr, arr, n26: tr.filter((t) => yr(t.tday) === 2026).length,
           y26: at(arr, Y26), a26: at(arr, Y26a), b26: at(arr, Y26b), y25: at(arr, Y25), all: S.passArr(arr) };
}
const LIVE = evalRun(() => 8);
function jack3(r) {                                             // 2026 with its best 3 days put back
  const best = Y26.map((k) => [k, r.arr[k] - LIVE.arr[k]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const a = Float64Array.from(r.arr); for (const [k] of best) a[k] = LIVE.arr[k];
  return at(a, Y26) - LIVE.y26;
}
const sg = (x) => ((x >= 0 ? "+" : "") + x.toFixed(1)).padStart(6);
const HDR = "  " + "rule".padEnd(66) + "2026 tr".padStart(8) + "  d2026" + " JanMar AprJul  best3back" + "   d2025   dAll";
const fmt = (label, r) => "  " + label.slice(0, 64).padEnd(66) + String(r.n26).padStart(8) + " " + sg(r.y26 - LIVE.y26) +
  sg(r.a26 - LIVE.a26) + sg(r.b26 - LIVE.b26) + sg(r.j3 ?? jack3(r)).padStart(11) + sg(r.y25 - LIVE.y25).padStart(8) + sg(r.all - LIVE.all).padStart(7);
function bar(t) { console.log("\n" + "=".repeat(124) + "\n" + t + "\n" + "=".repeat(124)); }

bar("5. PATTERNS AROUND A DONCHIAN SIGNAL -- weighted to 2026.  Live: 2026 " + LIVE.y26.toFixed(1) + "% (Jan-Mar " +
  LIVE.a26.toFixed(1) + ", Apr-Jul " + LIVE.b26.toFixed(1) + "), 2025 " + LIVE.y25.toFixed(1) + "%, all " + LIVE.all.toFixed(1) + "%");

// ---- A. what each reading says about 2026 trades, directly ---------------------------
const trades = LIVE.tr.map((t) => ({ ...t, dir: RESC[t.sigBar] }));
const Fv = FEATS.map(([, f]) => new Float64Array(n2).fill(NaN));
const valAt = (fi, k) => { let v = Fv[fi][k]; if (Number.isNaN(v)) { v = FEATS[fi][1](k, RESC[k] || RAW0[k]); Fv[fi][k] = Number.isFinite(v) ? v : 0; v = Fv[fi][k]; } return v; };
const cuts = FEATS.map((_, fi) => {
  const v = trades.map((t) => valAt(fi, t.sigBar)).sort((a, b) => a - b);
  const q = [0.2, 0.4, 0.6, 0.8].map((p) => v[Math.floor(p * v.length)]);
  return [...new Set(q)];
});
console.log("\n  A) 2026 dollars per trade by quintile of each reading (all-years $/trade in brackets). Live 2026: $" +
  (trades.filter((t) => yr(t.tday) === 2026).reduce((a, t) => a + t.pnl, 0) / LIVE.n26).toFixed(0) + "/trade over " + LIVE.n26 + " trades\n");
for (let fi = 0; fi < FEATS.length; fi++) {
  const cs = cuts[fi], bins = cs.length + 1, s26 = new Array(bins).fill(0), c26 = new Array(bins).fill(0), sA = new Array(bins).fill(0), cA = new Array(bins).fill(0);
  for (const t of trades) {
    const v = valAt(fi, t.sigBar); let b = 0; while (b < cs.length && v >= cs[b]) b++;
    sA[b] += t.pnl; cA[b]++; if (yr(t.tday) === 2026) { s26[b] += t.pnl; c26[b]++; }
  }
  console.log("  " + FEATS[fi][0].padEnd(50) + s26.map((s, b) => (c26[b] ? "$" + (s / c26[b]).toFixed(0) + "/" + c26[b] : "-").padStart(10) +
    ("(" + (cA[b] ? (sA[b] / cA[b]).toFixed(0) : "-") + ")").padStart(7)).join(""));
}

// ---- B. SKIP / HALF / ADD rules through the engine -------------------------------------
const rules = [];
const near = [];                                               // near-miss breakouts the gates reject
{
  const Gloose = gate(RAW0, 0.3);
  for (let k = 0; k < n2; k++) if (Gloose[k] && !RESC[k]) near.push(k);
}
for (let fi = 0; fi < FEATS.length; fi++) {
  for (const c of cuts[fi]) for (const side of ["below", "at or above"]) {
    const bad = (k) => (side === "below" ? valAt(fi, k) < c : valAt(fi, k) >= c);
    const cutS = Number.isInteger(c) ? String(c) : c.toFixed(2);
    // SKIP and HALF act through the sizer: the signal still flips an open position
    const skip = evalRun((a, ct, seq, arm) => (bad(arm - 1) ? 0 : 8));
    rules.push({ kind: "SKIP", fi, c, side, label: "skip when " + FEATS[fi][0] + " " + side + " " + cutS, r: skip });
    const half = evalRun((a, ct, seq, arm) => (bad(arm - 1) ? 4 : 8));
    rules.push({ kind: "HALF", fi, c, side, label: "half size when " + FEATS[fi][0] + " " + side + " " + cutS, r: half });
    // ADD: near-misses on the GOOD side of the cut
    const X = Int8Array.from(RESC); let added = 0;
    for (const k of near) if (!bad(k)) { X[k] = RAW0[k]; added++; }
    const add = evalRun(() => 8, { signals: X });
    rules.push({ kind: "ADD", fi, c, side, label: "add near-misses unless " + FEATS[fi][0] + " " + side + " " + cutS, r: add, added });
  }
}

// ---- C. ABANDON patterns after the fill ---------------------------------------------
const abandon = [
  ["MACD hist falling 3 bars in a row", (k, d) => (MH[k] - MH[k - 1]) * d < 0 && (MH[k - 1] - MH[k - 2]) * d < 0 && (MH[k - 2] - MH[k - 3]) * d < 0],
  ["MACD hist falling 2 bars in a row", (k, d) => (MH[k] - MH[k - 1]) * d < 0 && (MH[k - 1] - MH[k - 2]) * d < 0],
  ["2 closes in a row against", (k, d) => (C[k] - C[k - 1]) * d < 0 && (C[k - 1] - C[k - 2]) * d < 0],
  ["3 closes in a row against", (k, d) => (C[k] - C[k - 1]) * d < 0 && (C[k - 1] - C[k - 2]) * d < 0 && (C[k - 2] - C[k - 3]) * d < 0],
  ["a bar against bigger than 1.5 ATR", (k, d, st) => (C[k] - O[k]) * d < 0 && H[k] - L[k] > 1.5 * st.atr],
  ["close back past the entry price", (k, d, st) => (C[k] - st.fill) * d < 0],
  ["close back inside the channel it broke", (k, d, st) => (d === 1 ? C[k] < dh[st.sigBar] : C[k] > dl[st.sigBar])],
  ["5-min MACD hist turns against", (k, d) => { const j = K5[tf.srcLast[k]]; return j > 0 && MH5[j] * d < 0; }],
];
for (const [nm, f] of abandon)
  for (const within of [3, 5, 10, 1e9]) {
    const r = evalRun(() => 8, { exitFn: (k, d, st) => k >= st.entBar && k - st.entBar < within && f(k, d, st) });
    rules.push({ kind: "ABANDON", label: "out if " + nm + (within < 1e9 ? " (first " + within + " bars)" : " (any time)"), r });
  }

for (const x of rules) x.r.j3 = jack3(x.r);
console.log("\n  B) " + rules.length + " rules through the engine. Top 40 by the 2026 change:\n" + HDR);
console.log(fmt("live book", LIVE));
const by26 = rules.slice().sort((a, b) => b.r.y26 - a.r.y26);
for (const x of by26.slice(0, 40)) console.log(fmt("[" + x.kind + "] " + x.label, x.r));

// ---- D. the random null for the best rules ------------------------------------------
// A SKIP or HALF rule removes exposure from a set of signals. Removing the same
// SHARE of signals at random, across all years, shows what that alone does.
bar("5D. THE BEST 2026 RULES AGAINST THE SAME CHANGE MADE AT RANDOM (30 draws each)");
console.log("\n  " + "rule".padEnd(66) + "  d2026   random: mean   90th   max    real beats");
const hash = (k, s) => { let x = (k * 2654435761 + s * 97531) >>> 0; x ^= x >>> 16; x = Math.imul(x, 2246822507) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };
for (const x of by26.filter((z) => z.kind === "SKIP" || z.kind === "HALF").slice(0, 12)) {
  const bad = (k) => (x.side === "below" ? valAt(x.fi, k) < x.c : valAt(x.fi, k) >= x.c);
  const share = sigIdx.filter(bad).length / sigIdx.length, lotsBad = x.kind === "SKIP" ? 0 : 4;
  const nul = [];
  for (let s = 1; s <= 30; s++) nul.push(evalRun((a, ct, seq, arm) => (hash(arm - 1, s) < share ? lotsBad : 8)).y26 - LIVE.y26);
  nul.sort((a, b) => a - b);
  console.log("  " + x.label.slice(0, 64).padEnd(66) + sg(x.r.y26 - LIVE.y26) + (nul.reduce((a, b) => a + b, 0) / nul.length).toFixed(1).padStart(14) +
    nul[26].toFixed(1).padStart(7) + nul[29].toFixed(1).padStart(6) + (nul.filter((v) => v < x.r.y26 - LIVE.y26).length + "/30").padStart(13));
}

// ---- E. robust 2026 candidates ---------------------------------------------------------
bar("5E. 2026 CANDIDATES THAT HOLD UP INSIDE 2026: better in Jan-Mar AND Apr-Jul, and still better with their best 3 days put back");
const keep = rules.filter((x) => x.r.y26 > LIVE.y26 && x.r.a26 >= LIVE.a26 && x.r.b26 >= LIVE.b26 && x.r.j3 > 0)
                  .sort((a, b) => b.r.j3 - a.r.j3);
console.log("\n  " + keep.length + " of " + rules.length + " rules.\n" + HDR);
console.log(fmt("live book", LIVE));
for (const x of keep.slice(0, 30)) console.log(fmt("[" + x.kind + "] " + x.label, x.r));
fs.writeFileSync(new URL("./donchian_patterns_results.json", import.meta.url), JSON.stringify(rules.map((x) => ({
  kind: x.kind, label: x.label, fi: x.fi, c: x.c, side: x.side, added: x.added,
  y26: x.r.y26, a26: x.r.a26, b26: x.r.b26, j3: x.r.j3, y25: x.r.y25, all: x.r.all, n26: x.r.n26 }))));
console.log("\n  (" + rules.length + " rules, " + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
