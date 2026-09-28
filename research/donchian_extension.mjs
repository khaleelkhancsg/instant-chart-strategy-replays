// Stage 7: the theme stage 5 turned up -- breakouts that arrive after the move
// is already STRETCHED do badly in 2026 -- tested as a theme, not a rule.
//
// Stage 5 tried 872 pattern rules and 14 "held up inside 2026" (better in
// Jan-Mar AND Apr-Jul, still better with their best three 2026 days put back).
// With 139 days in 2026, rules that skip trades AT RANDOM also pass that test
// some of the time, so part 1 measures how often: that is the base rate the
// 14 have to be judged against.
//
// Part 2 maps each stretch reading across its thresholds, as SKIP and as a
// smaller size, next to the plain time-of-day cutoff it might just be a proxy
// for. Part 3 combines them into one stretch count. Weighted to 2026 as asked;
// 2025 and the full history are printed for context only.
//
// RESULT: one reading holds as a PLATEAU rather than a point -- the day's RTH
// range so far against its 10-day average ("ADR used"). Every threshold from
// 0.8 to 1.1 x ADR helps 2026 in both halves; at 0.9, half size gives +12.5
// (Jan-Mar +6.4, Apr-Jul +17.0, +3.3 with its best 3 days put back, 2025
// +0.0, all years -0.4) and skipping gives +11.9 (+8.5 with best 3 back, 2025
// -2.0). The half-size version beats all 300 random half-size rules (best
// +9.7). It is not just the clock: a plain time cutoff does about half as
// well. Skipping at >= 5-8 ATR from VWAP and skipping on 3+ stretch flags also
// hold up in 2026, but skip rules pass that test by chance 9.3% of the time.
// donchian_2026_breadth.mjs: the gains lean on June 2026 in every case.
//
//   node --max-old-space-size=8192 research/donchian_extension.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { ema, atr, stochastic } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const T0 = Date.now();
const { bars } = loadBars();
const tf = resample(bars, 2);
const { open: O, high: H, low: L, close: C, volume: V, ctMin: CT, tday: TD } = tf;
const n2 = C.length;
const A = atr(H, L, C, 14), E20 = ema(C, 20), STK = stochastic(H, L, C, 14, 3).k;
const RESC = M.RESC;

// ---- the stretch readings, at the signal bar ----------------------------------------
const rthHi = new Float64Array(n2).fill(NaN), rthLo = new Float64Array(n2).fill(NaN), rthOpen = new Float64Array(n2).fill(NaN);
const VW = new Float64Array(n2).fill(NaN);
const dayRange = new Map();
{
  let day = -1, o = NaN, h = -Infinity, l = Infinity, pv = 0, vv = 0;
  for (let i = 0; i < n2; i++) {
    if (TD[i] !== day) { if (day !== -1 && h > l) dayRange.set(day, h - l); day = TD[i]; o = NaN; h = -Infinity; l = Infinity; pv = 0; vv = 0; }
    if (CT[i] >= 510 && CT[i] < 900) {
      if (Number.isNaN(o)) o = O[i];
      if (H[i] > h) h = H[i]; if (L[i] < l) l = L[i];
      const tp = (H[i] + L[i] + C[i]) / 3; pv += tp * V[i]; vv += V[i];
      rthOpen[i] = o; rthHi[i] = h; rthLo[i] = l; VW[i] = vv > 0 ? pv / vv : tp;
    }
  }
  if (h > l) dayRange.set(day, h - l);
}
const dk = [...new Set(TD)], adr = new Map();
for (let j = 1; j < dk.length; j++) {
  const r = dk.slice(Math.max(0, j - 10), j).map((d) => dayRange.get(d)).filter((x) => x > 0);
  if (r.length) adr.set(dk[j], r.reduce((a, b) => a + b, 0) / r.length);
}
const dirAt = (k) => RESC[k];
const R = {
  range: (k) => { const a = adr.get(TD[k]); return a ? (rthHi[k] - rthLo[k]) / a : 0; },
  vwap: (k) => (Number.isFinite(VW[k]) ? (C[k] - VW[k]) * dirAt(k) / A[k] : 0),
  ema20: (k) => (C[k] - E20[k]) * dirAt(k) / A[k],
  stoch: (k) => (dirAt(k) === 1 ? STK[k] : 100 - STK[k]),
  closePos: (k) => (H[k] > L[k] ? (dirAt(k) === 1 ? C[k] - L[k] : H[k] - C[k]) / (H[k] - L[k]) : 0.5),
  move: (k) => { const a = adr.get(TD[k]); return a ? (C[k] - rthOpen[k]) * dirAt(k) / a : 0; },
  time: (k) => CT[k],
};

// ---- scoring ------------------------------------------------------------------------
const live = M.evalCfg(M.LIVE);
live.j3 = 0;
live.n26 = live.tr.filter((t) => S.yearOf.get(t.tday) === 2026).length;
const at = (arr, ix) => S.passArr(ix.map((k) => arr[k]));
function evalSizer(fn) {
  const r = M.evalOpts(M.build(M.LIVE), fn);
  const best = M.Y26.map((k) => [k, r.arr[k] - live.arr[k]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const a = Float64Array.from(r.arr); for (const [k] of best) a[k] = live.arr[k];
  r.j3 = at(a, M.Y26) - live.y26;
  r.n26 = r.tr.filter((t) => S.yearOf.get(t.tday) === 2026 && t.lots === 8).length;
  return r;
}
const holds = (r) => r.y26 > live.y26 && r.a26 >= live.a26 && r.b26 >= live.b26 && r.j3 > 0;
const sg = (x) => ((x >= 0 ? "+" : "") + x.toFixed(1)).padStart(6);
const HDR = "  " + "".padEnd(58) + "full-size 2026".padStart(15) + "  d2026 JanMar AprJul best3back   d2025   dAll";
function row(label, r) {
  console.log("  " + label.padEnd(58) + String(r.n26).padStart(15) + " " + sg(r.y26 - live.y26) + sg(r.a26 - live.a26) +
    sg(r.b26 - live.b26) + sg(r.j3).padStart(10) + sg(r.y25 - live.y25).padStart(8) + sg(r.all - live.all).padStart(7) +
    (holds(r) ? "  <- holds up inside 2026" : ""));
}
function bar(t) { console.log("\n" + "=".repeat(124) + "\n" + t + "\n" + "=".repeat(124)); }

bar("7. STRETCHED BREAKOUTS, 2026 first.  Live 2026 " + live.y26.toFixed(1) + "% (Jan-Mar " + live.a26.toFixed(1) +
  ", Apr-Jul " + live.b26.toFixed(1) + "), 2025 " + live.y25.toFixed(1) + "%, all " + live.all.toFixed(1) + "%");

// ---- 1. the base rate -------------------------------------------------------------------
{
  const hash = (k, s) => { let x = (k * 2654435761 + s * 97531) >>> 0; x ^= x >>> 16; x = Math.imul(x, 2246822507) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };
  const rnd = S.mul(777);
  const res = { SKIP: [], HALF: [] };
  for (let t = 0; t < 300; t++) {
    const share = 0.05 + rnd() * 0.4, seed = 1000 + t;
    for (const [kind, lots] of [["SKIP", 0], ["HALF", 4]])
      res[kind].push(evalSizer((a, ct, seq, arm) => (hash(arm - 1, seed) < share ? lots : 8)));
  }
  console.log("\n  1. RANDOM rules (skip or half-size a random 5-45% of signals), 300 of each:");
  for (const kind of ["SKIP", "HALF"]) {
    const d = res[kind].map((r) => r.y26 - live.y26).sort((a, b) => a - b), p = res[kind].filter(holds).length / res[kind].length;
    console.log("     " + kind.padEnd(5) + "2026 change: median " + sg(d[150]).trim() + ", 90th pct " + sg(d[270]).trim() +
      ", 99th " + sg(d[297]).trim() + ", max " + sg(d[299]).trim() + ";  pass the inside-2026 test: " + (100 * p).toFixed(1) + "%");
    console.log("           -> of stage 5's 280 " + kind + " rules, chance alone would pass about " +
      Math.round(p * 280) + "; stage 5 found " + (kind === "SKIP" ? 11 : 2));
  }
}

// ---- 2. each stretch reading across its thresholds ---------------------------------
const sizes = [["skip", 0], ["half size", 4], ["6 lots", 6]];
const sweep = (title, key, cuts, fmt, above = true) => {
  console.log("\n  " + title + "\n" + HDR);
  for (const c of cuts) for (const [nm, lots] of sizes) {
    const bad = (k) => (above ? R[key](k) >= c : R[key](k) < c);
    row("   " + nm + " when " + fmt(c), evalSizer((a, ct, seq, arm) => (bad(arm - 1) ? lots : 8)));
  }
};
console.log("\n  2. EACH READING ACROSS ITS THRESHOLDS");
console.log(HDR); row("live book", live);
sweep("day's RTH range so far, x its 10-day average", "range", [0.7, 0.8, 0.9, 1.0, 1.1, 1.25], (c) => "day's range >= " + c + " x ADR");
sweep("distance from RTH VWAP in the break's direction, ATRs", "vwap", [3, 4, 5, 6, 7, 8], (c) => "VWAP stretch >= " + c + " ATR");
sweep("distance from EMA 20 in the break's direction, ATRs", "ema20", [2, 2.5, 3, 3.5, 4], (c) => "EMA 20 stretch >= " + c + " ATR");
sweep("stochastic %K in the break's direction", "stoch", [95, 97, 98.5, 99.5], (c) => "stochastic >= " + c);
sweep("close position in the signal bar (1 = at the extreme)", "closePos", [0.85, 0.9, 0.94, 0.97], (c) => "close position >= " + c);
sweep("day's move from the open with the break, x ADR", "move", [0.3, 0.5, 0.7, 0.9], (c) => "day's move >= " + c + " x ADR");
sweep("time of day -- the proxy to beat", "time", [600, 660, 720, 780, 840], (c) => "signal at/after " + String(Math.floor(c / 60)).padStart(2, "0") + ":" + String(c % 60).padStart(2, "0") + " CT");

// ---- 3. one stretch count ---------------------------------------------------------------
console.log("\n  3. A STRETCH COUNT: day's range >= 0.9 ADR, VWAP stretch >= 5 ATR, EMA 20 stretch >= 3 ATR, stochastic >= 98.5, close position >= 0.94\n" + HDR);
const flags = (k) => (R.range(k) >= 0.9) + (R.vwap(k) >= 5) + (R.ema20(k) >= 3) + (R.stoch(k) >= 98.5) + (R.closePos(k) >= 0.94);
for (const need of [1, 2, 3]) for (const [nm, lots] of sizes)
  row("   " + nm + " when " + need + "+ stretch flags", evalSizer((a, ct, seq, arm) => (flags(arm - 1) >= need ? lots : 8)));
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
