// Stage 3: MORE trades of the kind that already work, instead of fewer.
//
// Across this project exactly two things have raised the Donchian pass rate:
// confirming the entry (the stop-entry) and ADDING borderline signals that the
// slow trend agrees with (the rescue, +3.4pp). Every filter that removed
// trades lowered it. So this pushes on the rescue's logic along the other
// gates, each against a control that loosens the same gate WITHOUT the trend:
//
//   A  ADX 15-25 breakouts (efficiency still >= 0.5) when the 2-min EMA 125
//      is on the breakout's side of the EMA 500
//   B  efficiency 0.35-0.45 when that trend AND a second horizon agree
//   C  breakouts of a SHORTER channel (15-25 bars) that are not 30-bar
//      breakouts, when the trend agrees
//   D  the opposite: DROP counter-trend signals with only marginal efficiency
//
// Judged on 2025 and 2026, as asked (full history printed for context).
//
// RESULT: nothing survives. ADX 15-25 additions lose 0.7-3.4pp in both years
// with or without the trend; efficiency 0.35-0.45 loses 7-9pp in 2025 even
// with three trend horizons agreeing; dropping counter-trend signals loses in
// both years. Shorter-channel breakouts WITHOUT the trend check show +0.4 /
// +3.5, but after the efficiency gate they are only ~16 signals a year, and the
// 2026 figure is ONE day (2026-05-18: an added breakout's +$996 target in place
// of a -$1,000 stop) -- it is the only 2026 trade the addition changes.
//
//   node --max-old-space-size=6144 research/donchian_entry_additions.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { ema, adx, donchian } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";

const { bars } = loadBars();
const tf = resample(bars, 2);
const { high: H, low: L, close: C } = tf;
const n2 = C.length;
const { adx: ax } = adx(H, L, C, 14);
const fctx = buildFilterContext(tf);
const gate = (rawSig, effMin) => applyFilters(rawSig, fctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin });
function breakouts(n, adxMin) {
  const { high: dh, low: dl } = donchian(H, L, n);
  const r = new Int8Array(n2);
  for (let i = n; i < n2; i++) {
    if (ax[i] < adxMin) continue;
    if (C[i] > dh[i]) r[i] = 1; else if (C[i] < dl[i]) r[i] = -1;
  }
  return r;
}
const trendOf = (f, s) => { const a = ema(C, f), b = ema(C, s); return (k) => Math.sign(a[k] - b[k]); };
const T = trendOf(125, 500), T2 = trendOf(30, 120), T3 = trendOf(500, 2000);
const EFF = fctx.eff;

const RAW = breakouts(30, 25);
const G05 = gate(RAW, 0.5), G045 = gate(RAW, 0.45);
const RESC = Int8Array.from(G05);
for (let k = 0; k < n2; k++) if (G045[k] && !G05[k] && T(k) === RAW[k]) RESC[k] = G045[k];

// Weighted to the current regime, as asked: judged on 2025 and on 2026, each
// the other's check. The full history is printed for context only.
const days = S.days, NH = days.length >> 1;
const yIdx = (f) => days.map((d, k) => (f(S.yearOf.get(d)) ? k : -1)).filter((k) => k >= 0);
const Y25 = yIdx((y) => y === 2025), Y26 = yIdx((y) => y === 2026), Y2526 = yIdx((y) => y >= 2025);
function score(sig) {
  const tr = S.run(() => 8, { signals: sig });
  const arr = S.dayArr(tr, days);
  const at = (ix) => S.passArr(ix.map((k) => arr[k]));
  return { n: tr.length, exp: tr.reduce((a, t) => a + t.pnl, 0) / tr.length,
           all: S.passArr(arr), h1: S.passArr(arr.slice(0, NH)), h2: S.passArr(arr.slice(NH)),
           y25: at(Y25), y26: at(Y26), r2: at(Y2526) };
}
// add(extra): the live signals plus any extra bar the live set leaves empty
function withExtra(extra) {
  const s = Int8Array.from(RESC); let added = 0;
  for (let k = 0; k < n2; k++) if (!s[k] && extra[k]) { s[k] = extra[k]; added++; }
  return { s, added };
}
const f1 = (x) => x.toFixed(1).padStart(6);
const BASE = score(RESC);
const sg = (x) => ((x >= 0 ? "+" : "") + x.toFixed(1)).padStart(6);
function line(label, r, added) {
  const flag = r.y25 > BASE.y25 && r.y26 > BASE.y26 ? "  <- better in BOTH years" : "";
  console.log("  " + label.padEnd(58) + (added == null ? "" : (added >= 0 ? "+" : "") + added).padStart(7) + String(r.n).padStart(6) +
    ("$" + r.exp.toFixed(0)).padStart(6) + "  " + [r.y25, r.y26, r.r2].map(f1).join("") +
    sg(r.y25 - BASE.y25) + sg(r.y26 - BASE.y26) + "  " + [r.all, r.h1, r.h2].map(f1).join("") + flag);
}
console.log("\n  " + "".padEnd(58) + "signals".padStart(7) + "trades".padStart(6) + "  $/tr  " +
  ["2025", "2026", "25-26"].map((x) => x.padStart(6)).join("") + " d2025 d2026  " + ["all", "1stH", "2ndH"].map((x) => x.padStart(6)).join(""));
line("live (efficiency >= 0.5, rescue 0.45 with the trend)", BASE);

console.log("\n  A) ADX below 25, efficiency >= 0.5");
for (const a of [15, 17.5, 20, 22.5]) {
  const G = gate(breakouts(30, a), 0.5);
  for (const [lbl, need] of [["with the trend", true], ["no trend check (control)", false]]) {
    const ex = new Int8Array(n2);
    for (let k = 0; k < n2; k++) if (G[k] && ax[k] < 25 && (!need || T(k) === G[k])) ex[k] = G[k];
    const { s, added } = withExtra(ex);
    line("   ADX " + a + "-25, " + lbl, score(s), added);
  }
}

console.log("\n  B) efficiency below the rescue's 0.45, with more than one trend agreeing");
for (const e of [0.35, 0.4]) {
  const G = gate(RAW, e);
  for (const [lbl, fn] of [["2-min EMA 125/500 only", (k, d) => T(k) === d],
                           ["+ EMA 30/120 (1h/4h)", (k, d) => T(k) === d && T2(k) === d],
                           ["+ EMA 500/2000 (17h/67h)", (k, d) => T(k) === d && T3(k) === d],
                           ["all three", (k, d) => T(k) === d && T2(k) === d && T3(k) === d]]) {
    const ex = new Int8Array(n2);
    for (let k = 0; k < n2; k++) if (G[k] && EFF[k] < 0.45 && fn(k, G[k])) ex[k] = G[k];
    const { s, added } = withExtra(ex);
    line("   efficiency " + e + "-0.45, " + lbl, score(s), added);
  }
}

console.log("\n  C) shorter-channel breakouts that are not 30-bar breakouts (ADX >= 25, efficiency >= 0.5)");
for (const n of [15, 20, 25]) {
  const G = gate(breakouts(n, 25), 0.5);
  for (const [lbl, need] of [["with the trend", true], ["no trend check (control)", false]]) {
    const ex = new Int8Array(n2);
    for (let k = 0; k < n2; k++) if (G[k] && !RAW[k] && (!need || T(k) === G[k])) ex[k] = G[k];
    const { s, added } = withExtra(ex);
    line("   " + n + "-bar channel, " + lbl, score(s), added);
  }
}

console.log("\n  D) drop counter-trend signals whose efficiency is only marginal");
for (const x of [0.55, 0.6, 0.7]) {
  const s = Int8Array.from(RESC); let dropped = 0;
  for (let k = 0; k < n2; k++) if (s[k] && EFF[k] < x && T(k) === -s[k]) { s[k] = 0; dropped++; }
  line("   drop against-trend signals with efficiency < " + x, score(s), -dropped);
}
