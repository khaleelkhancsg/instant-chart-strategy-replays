// Can the Donchian book pass more by getting out of failing trades before the
// full stop -- or by anything else left to tune?
//
// Stage 1 of a two-stage search. Every family is run on the live book (the
// efficiency gate plus the slow-trend rescue, 8 lots, stop-entry, 5xATR /
// 1.75xATR bracket capped at the $1,000 day, -$500 breaker, +$750 profit
// block), on its own, with the ORB off:
//
//   EXIT SIGNALS   26 indicator readings of "this move has failed" -- back
//                  inside the channel it broke, the Turtle n-bar low, EMAs,
//                  DI cross, ADX, efficiency, Supertrend, VWAP, RSI, MACD,
//                  ROC, Heikin-Ashi, Parabolic SAR, high-volume rejection bars
//                  -- each acted on always / only under water / only 1 ATR
//                  down / only if the trade never went green, with and without
//                  a 3-bar grace period. Read on a closed bar, out at the next
//                  open.
//   STOP MOVES     breakeven, chandelier trail, n-bar structure trail, a stop
//                  that tightens with time, a tighter initial stop. Tighten
//                  only, from the bar after the decision.
//   TIME EXITS     out if still under water after N bars, if it never reached
//                  y ATR by N bars, or after N bars regardless.
//   BRACKET        stop 3-8 ATR x target 1.25-3 ATR.
//   ACCOUNT        lots, circuit breaker and profit block, re-tuned now that
//                  the ORB no longer shares the account.
//
// Every config is scored on the 21-day pass rate in 2025, in 2026 and over
// both, weighted to the current regime as asked: an improvement is anything
// that beats the live book in 2025 AND 2026, whatever it does in 2019-24 (the
// full history and its halves are printed for context). The two years check
// each other: pick the best of a family on one, read it on the other.
//
// RESULT: nothing. 1 of 482 configs beats the live book in both years (a 4 ATR
// chandelier trail once +1 ATR: +1.9 in 2025, +0.0 in 2026). None of the 216
// indicator exits does; the best of them lose 0.4-1.6pp a year and score no
// better than cutting at random at the same rate. The live bracket (5/1.75)
// and account settings (8 lots, -$500, +$750) are the best in 2026 of their
// grids. Diagnosis: 55% of windows die on the $2,000 drawdown and only 7% run
// out of time; a loser costs ~$1,000 (the day cap) against ~$370 for a winner,
// and 51% of eventual winners go 1 ATR under water first, which is why cutting
// "failing" trades cuts the winners with them.
//
//   node --max-old-space-size=6144 research/donchian_exit_search.mjs

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { ema, sma, adx, rsi, donchian, efficiencyRatio, macd, rollingMinMax, supertrend } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";

const T0 = Date.now();
const { bars } = loadBars();
const tf = resample(bars, 2);
const { open: O, high: H, low: L, close: C, volume: V, ctMin: CT, tday: TD, ts: TS } = tf;
const n2 = C.length;

// ---- the live signal ---------------------------------------------------------
const { adx: ax, pdi, ndi } = adx(H, L, C, 14);
const { high: dh, low: dl } = donchian(H, L, 30);
const raw = new Int8Array(n2);
for (let i = 30; i < n2; i++) {
  if (ax[i] < 25) continue;
  if (C[i] > dh[i]) raw[i] = 1; else if (C[i] < dl[i]) raw[i] = -1;
}
const fctx = buildFilterContext(tf);
const gated = (x) => applyFilters(raw, fctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: x });
const G05 = gated(0.5), G045 = gated(0.45);
const t125 = ema(C, 125), t500 = ema(C, 500);
const RESC = Int8Array.from(G05);
for (let k = 0; k < n2; k++)
  if (G045[k] && !G05[k] && Math.sign(t125[k] - t500[k]) === raw[k]) RESC[k] = G045[k];

// ---- indicators the exits read, all on the same 2-minute bars ----------------
const E = {}; for (const p of [9, 20, 21, 50]) E[p] = ema(C, p);
const DC = {}; for (const n of [5, 10, 15, 20]) DC[n] = donchian(H, L, n);      // prior n bars
const RM = {}; for (const n of [3, 5, 10, 20]) RM[n] = rollingMinMax(H, L, n);   // incl. this bar
const ER10 = efficiencyRatio(C, 10);
const ST2 = supertrend(H, L, C, 10, 2).trend, ST3 = supertrend(H, L, C, 10, 3).trend;
const RSI = rsi(C, 14);
const MH = macd(C, 12, 26, 9).hist;
const VA = sma(V, 20);
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
const HA = new Int8Array(n2);                                 // Heikin-Ashi candle colour
{
  let ho = (O[0] + C[0]) / 2, hc = (O[0] + H[0] + L[0] + C[0]) / 4;
  for (let i = 1; i < n2; i++) {
    const no = (ho + hc) / 2, nc = (O[i] + H[i] + L[i] + C[i]) / 4;
    ho = no; hc = nc; HA[i] = nc > no ? 1 : nc < no ? -1 : 0;
  }
}
const PS = new Int8Array(n2);                                 // Parabolic SAR trend
{
  let up = true, sar = L[0], ep = H[0], af = 0.02;
  for (let i = 1; i < n2; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, L[i - 1], i > 1 ? L[i - 2] : L[i - 1]);
      if (L[i] < sar) { up = false; sar = ep; ep = L[i]; af = 0.02; }
      else if (H[i] > ep) { ep = H[i]; af = Math.min(0.2, af + 0.02); }
    } else {
      sar = Math.max(sar, H[i - 1], i > 1 ? H[i - 2] : H[i - 1]);
      if (H[i] > sar) { up = true; sar = ep; ep = H[i]; af = 0.02; }
      else if (L[i] < ep) { ep = L[i]; af = Math.min(0.2, af + 0.02); }
    }
    PS[i] = up ? 1 : -1;
  }
}

// ---- scoring -------------------------------------------------------------------
// WEIGHTED TO THE CURRENT REGIME, as asked: a change counts as an improvement
// if it beats the live book in 2025 AND in 2026, whatever it does in 2019-24.
// Each of the two years is the other's out-of-sample check. The full history
// and its halves are still printed, for context only.
const days = S.days, NH = days.length >> 1;
const yIdx = (f) => days.map((d, k) => (f(S.yearOf.get(d)) ? k : -1)).filter((k) => k >= 0);
const Y25 = yIdx((y) => y === 2025), Y26 = yIdx((y) => y === 2026), Y2526 = yIdx((y) => y >= 2025);
const pass = (arr) => S.passArr(arr);
function score(opts = {}, lots = 8) {
  const tr = S.run(() => lots, { signals: RESC, ...opts });
  const arr = S.dayArr(tr, days);
  let w = 0, gw = 0, gl = 0, early = 0;
  for (const t of tr) { if (t.pnl > 0) { w++; gw += t.pnl; } else gl -= t.pnl; if (t.why === "XSIG" || t.why === "TS") early++; }
  const at = (ix) => pass(ix.map((k) => arr[k]));
  return { n: tr.length, win: (100 * w) / tr.length, pf: gw / gl, exp: (gw - gl) / tr.length, early,
           all: pass(arr), h1: pass(arr.slice(0, NH)), h2: pass(arr.slice(NH)),
           y25: at(Y25), y26: at(Y26), r2: at(Y2526), arr, tr };
}
const f1 = (x) => x.toFixed(1).padStart(6);
const sg = (x) => ((x >= 0 ? "+" : "") + x.toFixed(1)).padStart(6);
// the recent score: the WORSE of the two years' changes against the live book
const recentEdge = (r) => Math.min(r.y25 - BASE.y25, r.y26 - BASE.y26);
function row(label, r, base) {
  return "  " + label.padEnd(50) + String(r.n).padStart(6) + r.win.toFixed(1).padStart(6) +
    ("$" + r.exp.toFixed(0)).padStart(6) + String(r.early).padStart(6) + "  " +
    [r.y25, r.y26, r.r2].map(f1).join("") + (base ? sg(r.y25 - base.y25) + sg(r.y26 - base.y26) : " ".repeat(12)) +
    "   " + [r.all, r.h1, r.h2].map(f1).join("");
}
const HDR = "  " + "config".padEnd(50) + "trades".padStart(6) + "win%".padStart(6) + "$/tr".padStart(6) +
  "early".padStart(6) + "  " + ["2025", "2026", "25-26"].map((s) => s.padStart(6)).join("") +
  "  d2025 d2026" + "   " + ["all", "1stH", "2ndH"].map((s) => s.padStart(6)).join("");
function bar(t) { console.log("\n" + "=".repeat(124) + "\n" + t + "\n" + "=".repeat(124)); }

const BASE = score();
let windowSims = 0;
const WPC = 12000 * 6;                                        // windows scored per config

// =============================================================================
bar("0. WHERE THE LIVE DONCHIAN BOOK LOSES -- before designing any rule");
// =============================================================================
{
  console.log("\n" + HDR);
  console.log(row("live book (ORB off)", BASE));
  // failure modes, same draws as the pass rate
  const ev3 = (d) => {
    let c = 0, pk = 0, lk = false, md = -1e18, hit = false;
    for (const v of d) {
      c += v; if (v > md) md = v;
      if (c <= (lk ? 0 : pk - 2000)) return 1;
      if (c > pk) pk = c;
      if (!lk && pk >= 2000) lk = true;
      if (c >= 3000) { if (md <= 0.5 * c) return 0; hit = true; }
    }
    return hit ? 3 : 2;
  };
  const rnd = S.mul(4242), cnt = [0, 0, 0, 0], buf = new Array(21);
  for (let d = 0; d < 12000; d++) {
    let mm = 0;
    while (mm < 21) { const st = Math.floor(rnd() * Math.max(1, BASE.arr.length - 5));
      for (let j = 0; j < 5 && mm < 21; j++) buf[mm++] = BASE.arr[(st + j) % BASE.arr.length]; }
    cnt[ev3(buf)]++;
  }
  console.log("\n  21-day windows: passed " + (cnt[0] / 120).toFixed(1) + "%, hit the $2,000 drawdown " +
    (cnt[1] / 120).toFixed(1) + "%, ran out of time " + (cnt[2] / 120).toFixed(1) + "%, consistency " +
    (cnt[3] / 120).toFixed(1) + "%");

  const by = new Map();
  for (const t of BASE.tr) { const o = by.get(t.why) || [0, 0]; o[0]++; o[1] += t.pnl; by.set(t.why, o); }
  console.log("\n  exit       trades      $/trade          total");
  for (const [w, o] of [...by].sort((a, b) => b[1][0] - a[1][0]))
    console.log("  " + w.padEnd(8) + String(o[0]).padStart(9) + ("$" + (o[1] / o[0]).toFixed(0)).padStart(13) +
      ("$" + Math.round(o[1]).toLocaleString()).padStart(15));
  const dayL = BASE.arr.filter((v) => v <= -900).length, dayW = BASE.arr.filter((v) => v >= 700).length;
  console.log("\n  days at or near the -$1,000 cap: " + dayL + " (" + (100 * dayL / days.length).toFixed(1) +
    "% of days);  days of +$700 or more: " + dayW);

  // Excursion anatomy: record every open trade's path through the exit hook.
  const paths = new Map();
  S.run(() => 8, { signals: RESC, exitFn: (k, dir, st) => {
    if (k < st.entBar) return false;
    let p = paths.get(st.sigBar);
    if (!p) { p = { atr: st.atr, mfe: 0, mae: 0, bars: 0 }; paths.set(st.sigBar, p); }
    const up = (C[k] - st.fill) * dir / st.atr;
    const fav = (dir === 1 ? st.mx - st.fill : st.fill - st.mn) / st.atr;
    const adv = (dir === 1 ? st.mn - st.fill : st.fill - st.mx) / st.atr;
    p.mfe = Math.max(p.mfe, fav); p.mae = Math.min(p.mae, adv, up); p.bars++;
    return false;
  } });
  const joined = BASE.tr.map((t) => ({ ...t, p: paths.get(t.sigBar) })).filter((t) => t.p);
  const losers = joined.filter((t) => t.why === "SL" || t.why === "SLcap");
  const winners = joined.filter((t) => t.why === "TP");
  console.log("\n  " + losers.length + " full-stop losers, " + winners.length + " target winners (excursions in ATRs of the signal bar)");
  console.log("  losers that had been at least x ATR in profit first:  " +
    [0.25, 0.5, 0.75, 1.0, 1.25].map((x) => x + ": " + (100 * losers.filter((t) => t.p.mfe >= x).length / losers.length).toFixed(0) + "%").join("   "));
  console.log("  winners that were at least y ATR under water first:   " +
    [0.5, 1, 1.5, 2, 3, 4].map((y) => y + ": " + (100 * winners.filter((t) => -t.p.mae >= y).length / winners.length).toFixed(0) + "%").join("   "));
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  console.log("  median bars held: full-stop losers " + med(losers.map((t) => t.held / 2)) +
    ", target winners " + med(winners.map((t) => t.held / 2)) + " (2-minute bars)");
}

// =============================================================================
// Stage-1 families
// =============================================================================
const upnl = (k, st) => (C[k] - st.fill) * st.dir;
const mfe = (st) => (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn);
const CONDS = {
  always: () => true,
  "under water": (k, st) => upnl(k, st) < 0,
  "1 ATR down": (k, st) => upnl(k, st) <= -st.atr,
  "never green": (k, st) => mfe(st) < 0.5 * st.atr,
};
const SIGS = {
  "back inside the channel it broke": (k, d, st) => (d === 1 ? C[k] < dh[st.sigBar] : C[k] > dl[st.sigBar]),
  "back inside by 0.25 ATR": (k, d, st) => (d === 1 ? C[k] < dh[st.sigBar] - 0.25 * st.atr : C[k] > dl[st.sigBar] + 0.25 * st.atr),
  "back inside by 0.5 ATR": (k, d, st) => (d === 1 ? C[k] < dh[st.sigBar] - 0.5 * st.atr : C[k] > dl[st.sigBar] + 0.5 * st.atr),
  "back inside by 1 ATR": (k, d, st) => (d === 1 ? C[k] < dh[st.sigBar] - st.atr : C[k] > dl[st.sigBar] + st.atr),
  "through the 30-bar midline": (k, d) => (C[k] - (dh[k] + dl[k]) / 2) * d < 0,
  "Turtle: 5-bar low": (k, d) => (d === 1 ? C[k] < DC[5].low[k] : C[k] > DC[5].high[k]),
  "Turtle: 10-bar low": (k, d) => (d === 1 ? C[k] < DC[10].low[k] : C[k] > DC[10].high[k]),
  "Turtle: 15-bar low": (k, d) => (d === 1 ? C[k] < DC[15].low[k] : C[k] > DC[15].high[k]),
  "Turtle: 20-bar low": (k, d) => (d === 1 ? C[k] < DC[20].low[k] : C[k] > DC[20].high[k]),
  "close through EMA 9": (k, d) => (C[k] - E[9][k]) * d < 0,
  "close through EMA 20": (k, d) => (C[k] - E[20][k]) * d < 0,
  "close through EMA 50": (k, d) => (C[k] - E[50][k]) * d < 0,
  "EMA 9 crosses EMA 21": (k, d) => (E[9][k] - E[21][k]) * d < 0,
  "DI cross against": (k, d) => (d === 1 ? ndi[k] > pdi[k] : pdi[k] > ndi[k]),
  "ADX below 20": (k) => ax[k] < 20,
  "efficiency(10) < 0.2, drifting against": (k, d) => ER10[k] < 0.2 && (C[k] - C[k - 10]) * d < 0,
  "Supertrend(10,2) flips": (k, d) => ST2[k] === -d,
  "Supertrend(10,3) flips": (k, d) => ST3[k] === -d,
  "close through RTH VWAP": (k, d) => (C[k] - VW[k]) * d < 0,
  "RSI(14) through 50": (k, d) => (RSI[k] - 50) * d < 0,
  "RSI(14) through 40/60": (k, d) => (d === 1 ? RSI[k] < 40 : RSI[k] > 60),
  "MACD histogram against": (k, d) => MH[k] * d < 0,
  "MACD histogram against 2 bars": (k, d) => MH[k] * d < 0 && MH[k - 1] * d < 0,
  "ROC(10) against": (k, d) => (C[k] - C[k - 10]) * d < 0,
  "Heikin-Ashi: 2 candles against": (k, d) => HA[k] === -d && HA[k - 1] === -d,
  "Parabolic SAR flips": (k, d) => PS[k] === -d,
  "high-volume bar against (2x avg, 0.5 ATR body)": (k, d, st) => V[k] >= 2 * VA[k] && (C[k] - O[k]) * d <= -0.5 * st.atr,
};
const R = [];                                                  // every stage-1 result
function add(fam, name, opts, lots) {
  const r = score(opts, lots);
  windowSims += WPC;
  delete r.arr; delete r.tr;
  R.push({ fam, name, ...r });
  return r;
}

// ---- exit signals ------------------------------------------------------------
for (const [sn, sf] of Object.entries(SIGS))
  for (const [cn, cf] of Object.entries(CONDS))
    for (const g of [0, 3])
      add("exit signal", sn + " | " + cn + (g ? " | after 3 bars" : ""),
          { exitFn: (k, d, st) => k >= st.entBar + g && cf(k, st) && sf(k, d, st) });

// ---- stop moves ----------------------------------------------------------------
for (const x of [0.5, 0.75, 1.0, 1.25, 1.5])
  for (const b of [-0.25, 0, 0.25, 0.5]) {
    if (b >= x) continue;
    add("stop move", "breakeven: at +" + x + " ATR, stop to " + (b >= 0 ? "+" : "") + b + " ATR",
        { stopFn: (k, st) => (mfe(st) >= x * st.atr ? st.fill + st.dir * b * st.atr : null) });
  }
for (const x of [0, 0.5, 1.0])
  for (const m of [1, 1.5, 2, 2.5, 3, 4])
    add("stop move", "chandelier: trail " + m + " ATR" + (x ? " once +" + x + " ATR" : ""),
        { stopFn: (k, st) => (mfe(st) >= x * st.atr ? (st.dir === 1 ? st.mx - m * st.atr : st.mn + m * st.atr) : null) });
for (const n of [3, 5, 10, 20])
  for (const x of [0, 0.5, 1.0])
    add("stop move", "structure: " + n + "-bar low" + (x ? " once +" + x + " ATR" : ""),
        { stopFn: (k, st) => (mfe(st) >= x * st.atr ? (st.dir === 1 ? RM[n].low[k] : RM[n].high[k]) : null) });
for (const g of [5, 10, 15, 20, 30])
  for (const s of [1, 2, 3])
    add("stop move", "time-tightened: after " + g + " bars, stop " + s + " ATR from fill",
        { stopFn: (k, st) => (k - st.entBar >= g ? st.fill - st.dir * s * st.atr : null) });
for (const s of [1.5, 2, 2.5, 3, 3.5, 4])
  add("stop move", "tighter stop: " + s + " ATR from fill, from the next bar",
      { stopFn: (k, st) => st.fill - st.dir * s * st.atr });

// ---- time exits ------------------------------------------------------------------
for (const N of [5, 10, 15, 20, 30, 45])
  add("time exit", "still under water after " + N + " bars", { exitFn: (k, d, st) => k - st.entBar >= N && upnl(k, st) <= 0 });
for (const N of [5, 10, 20])
  for (const y of [0.5, 1.0])
    add("time exit", "never reached +" + y + " ATR by " + N + " bars", { exitFn: (k, d, st) => k - st.entBar >= N && mfe(st) < y * st.atr });
for (const N of [15, 30, 60, 90])
  add("time exit", "out after " + N + " bars regardless", { exitFn: (k, d, st) => k - st.entBar >= N });

// ---- bracket geometry ------------------------------------------------------------
for (const sl of [3, 4, 5, 6, 8])
  for (const tp of [1.25, 1.5, 1.75, 2, 2.5, 3])
    add("bracket", "stop " + sl + " ATR, target " + tp + " ATR", { slMult: sl, tpMult: tp });

// ---- account knobs -----------------------------------------------------------------
for (const lots of [6, 7, 8, 9, 10])
  for (const br of [300, 400, 500, 650, 800, 0])
    for (const pb of [500, 750, 1000, 1500, 0])
      add("account", lots + " lots, breaker " + (br ? "-$" + br : "off") + ", profit block " + (pb ? "+$" + pb : "off"),
          { breaker: br, profitBlock: pb }, lots);

// =============================================================================
bar("1. EACH FAMILY, ranked on 2025-26 -- and whether picking on one year holds in the other");
// =============================================================================
const FAMS = ["exit signal", "stop move", "time exit", "bracket", "account"];
const cvRows = [];
for (const fam of FAMS) {
  const rs = R.filter((r) => r.fam === fam);
  console.log("\n  " + fam.toUpperCase() + " -- " + rs.length + " configs, top 10 by the worse of the 2025 and 2026 changes\n" + HDR);
  console.log(row("live book", BASE));
  for (const r of rs.slice().sort((a, b) => recentEdge(b) - recentEdge(a)).slice(0, 10)) console.log(row(r.name, r, BASE));
  const b1 = rs.reduce((a, r) => (r.y25 > a.y25 ? r : a)), b2 = rs.reduce((a, r) => (r.y26 > a.y26 ? r : a));
  cvRows.push([fam, b1, b2]);
}
console.log("\n  CROSS-VALIDATED ACROSS THE TWO YEARS: pick the best on one, read it on the other");
console.log("  " + "family".padEnd(14) + "picked on 2025 -> scores in 2026 (live " + BASE.y26.toFixed(1) + ")" +
  "          picked on 2026 -> scores in 2025 (live " + BASE.y25.toFixed(1) + ")");
for (const [fam, b1, b2] of cvRows)
  console.log("  " + fam.padEnd(14) + (b1.y26.toFixed(1) + " (" + sg(b1.y26 - BASE.y26).trim() + ")").padStart(14) +
    "   " + b1.name.slice(0, 44).padEnd(44) + (b2.y25.toFixed(1) + " (" + sg(b2.y25 - BASE.y25).trim() + ")").padStart(14) +
    "   " + b2.name.slice(0, 44));

// =============================================================================
bar("2. ACROSS EVERYTHING -- the configs that beat the live book in BOTH 2025 and 2026");
// =============================================================================
const both = R.filter((r) => r.y25 > BASE.y25 && r.y26 > BASE.y26).sort((a, b) => recentEdge(b) - recentEdge(a));
console.log("\n  " + both.length + " of " + R.length + " configs beat the live book in both years; " +
  R.filter((r) => r.y25 > BASE.y25 + 1 && r.y26 > BASE.y26 + 1).length + " by more than 1pp in both, " +
  R.filter((r) => r.y25 > BASE.y25 + 3 && r.y26 > BASE.y26 + 3).length + " by more than 3pp in both.\n");
console.log(HDR);
console.log(row("live book", BASE));
for (const r of both.slice(0, 30)) console.log(row("[" + r.fam + "] " + r.name, r, BASE));

// =============================================================================
bar("3. THE NULL FOR THE BEST EXIT SIGNALS -- the same cuts at random bars, judged on 2025 and 2026");
// =============================================================================
// An exit signal that fires under a condition removes trades at some rate. A
// coin flipped at the same rate, on the same eligible bars, removes the same
// amount of exposure without any information. If the indicator is reading the
// move, it has to beat the coin.
{
  const top = R.filter((r) => r.fam === "exit signal").sort((a, b) => recentEdge(b) - recentEdge(a)).slice(0, 8);
  console.log("\n  " + "exit signal".padEnd(64) + "fires" + "   real 2025 / 2026" + "    coin x10 mean 2025 / 2026, best of 10 worse-year");
  for (const r of top) {
    const [sn, cn, gs] = r.name.split(" | ");
    const g = gs ? 3 : 0, sf = SIGS[sn], cf = CONDS[cn];
    let elig = 0, fired = 0;
    S.run(() => 8, { signals: RESC, exitFn: (k, d, st) => {
      if (!(k >= st.entBar + g && cf(k, st))) return false;
      elig++; const f = sf(k, d, st); if (f) fired++; return f;
    } });
    const h = fired / elig;
    const nul = [];
    for (let seed = 1; seed <= 10; seed++) {
      const rng = (k) => { let x = (k * 2654435761 + seed * 97531) >>> 0; x ^= x >>> 16; x = Math.imul(x, 2246822507) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };
      nul.push(score({ exitFn: (k, d, st) => k >= st.entBar + g && cf(k, st) && rng(k) < h }));
      windowSims += WPC;
    }
    const m = (f) => nul.reduce((a, x) => a + f(x), 0) / nul.length;
    console.log("  " + r.name.slice(0, 62).padEnd(64) + ((100 * h).toFixed(1) + "%").padStart(5) +
      (r.y25.toFixed(1) + " / " + r.y26.toFixed(1)).padStart(19) +
      (m((x) => x.y25).toFixed(1) + " / " + m((x) => x.y26).toFixed(1) + ", " +
       Math.max(...nul.map((x) => Math.min(x.y25 - BASE.y25, x.y26 - BASE.y26))).toFixed(1)).padStart(30));
  }
}

fs.writeFileSync(new URL("./donchian_exit_search_results.json", import.meta.url),
  JSON.stringify({ base: { ...BASE, arr: undefined, tr: undefined }, results: R }, null, 0));
console.log("\n  " + R.length + " configs, " + (windowSims / 1e6).toFixed(1) + "M evaluation windows scored, " +
  ((Date.now() - T0) / 1000).toFixed(0) + "s. All results: research/donchian_exit_search_results.json");
