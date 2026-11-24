// The idea loop: batches of new signals and filters for the databox, each screened on one year and
// confirmed, unchanged, on another, against placebo markets (CLAUDE.md "Verdict rules").
//
//   node --max-old-space-size=16384 research/idea_lab.mjs --batch 1 [--year 2026] [--only "a,b"] [--placebos 100]
//
// The person's request (2026-11-23): run in a loop trying new things, novel variables included, until
// five new things give significantly better results. Ledger: research/idea_lab_ledger.md.
//
// - Every idea is one of:
//     signal  a direction call (+1 up, -1 down) per New York minute; it counts at its onset (the minute
//             the call appears or changes). Its edge: its win rate less every minute's win rate in the
//             same direction and half (so the year's drift does not count).
//     filter  a yes / no on one of the box's own signals (below); its lift: the signal's win rate with
//             the filter less without it.
//   Each idea states why the market should behave that way, before it runs.
// - The box's signals (filters sit on these): the minute the 1m box turns both Long / both Short
//   ("flip1"), the 1m MACD row turns Potentially ("potM1"), the 1m EMA row ("potE1"), the 5m MACD row
//   ("potM5"), and the lead short ("lead": 1m EMA Pot. short while the 5m EMA reads Pot. long).
// - Outcome: the race of research/turn_context.mjs. From the minute's close, does price go R the called
//   way before R the other way (by 15:05; both in one minute counts against)? Primary R = 0.064% of the
//   real price (18 points in 2026); 0.1275% (37) is reported beside it.
// - Placebo markets: real bars, each minute's direction flipped at random (volume, sizes and times kept),
//   every line, level and box rebuilt on the path.
// - Screen (the year given, default 2026 to Oct 30): the 18-point reading beats 90 of 100 placebo markets
//   in BOTH halves (either tail: an idea that reliably loses is a finding too, named the other way round),
//   at least 100 events a half. Confirm: --year 2025 --only <the passes>, one run, the same tail beats 95
//   of 100 over the year.

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import { buildCatalog } from "./levels_catalog.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { resample } from "../src/resample.mjs";
import { atr, ema, macd, adx } from "../src/indicators.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";
import { RED_FOLDER } from "../src/news_calendar.mjs";
import { loadBars } from "../src/data.mjs";

// MES (micro S&P) 1-minute bars, 2019-05 to 2026-03-23, for batch 3's cross-market ideas: loaded once,
// matched to MNQ by minute. The placebo markets flip MNQ only, so MES says nothing about them.
const MES = BATCH_NEEDS_MES() ? loadBars("data/mes_1m.bin").bars : null;
function BATCH_NEEDS_MES() { const a = process.argv.slice(2), i = a.indexOf("--batch"); return i >= 0 && Number(a[i + 1]) === 3; }

// VXN closes by date (data/raw/fred/VXNCLS.csv), for the day before each session
const VXN = new Map(fs.readFileSync("data/raw/fred/VXNCLS.csv", "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(",")).filter(([, v]) => v && v !== ".").map(([d, v]) => [d, Number(v)]));
const VXN_DATES = [...VXN.keys()].sort();

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PLACEBOS = Number(arg("--placebos", 100)), YEAR = Number(arg("--year", 2026)), BATCH = Number(arg("--batch", 1));
const ONLY = arg("--only", "") ? arg("--only", "").split(",").map((s) => s.trim()) : null;
const MIN = 60000, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, RS = [0.00064, 0.001275];
const FROM = Date.UTC(YEAR, 0, 1), TO = YEAR === 2026 ? Date.UTC(2026, 9, 31) : Date.UTC(YEAR + 1, 0, 1), H2 = Date.UTC(YEAR, 6, 1);
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

// ── the box ──
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
function boxStates(T, minutes) {
  const run = new Run(BOX, { minutes, check: false }), map = run.calc.map.bind(run.calc);
  const n = T.close.length, e = new Int8Array(n), m = new Int8Array(n);
  run.calc.map = (d, i) => { const out = map(d, i), S = run.calc.st[i]; e[i] = code(S.ema, S.emaReady); m[i] = code(S.macd, S.macdReady); return out; };
  run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
  return { e, m };
}
const sideOf = (c) => (c === 1 || c === 2 ? 1 : c === 3 || c === 4 ? -1 : 0);

// ── everything an idea may read, at minute i, from bars up to and including i ──
function context(sample) {
  const b = sample.b, N = b.close.length, TS = b.ts, O = b.open, H = b.high, L = b.low, C = b.close, V = b.volume, TD = b.tday, CT = b.ctMin;
  const cat = new Map(buildCatalog(sample).map((c) => [c.tag, c]));
  const tr = (tag) => cat.get(tag).series[0];
  const x = { b, N, TS, O, H, L, C, V, TD, CT, off: rawOffsets(b) };
  x.pwC = tr("PW close"); x.gO = tr("17:00 open");
  x.dpoc = tr("Dev POC (RTH)"); x.dvah = tr("Dev VAH (RTH)"); x.dval = tr("Dev VAL (RTH)"); x.vwUp1 = tr("VWAP +1σ (RTH)"); x.vwDn1 = tr("VWAP -1σ (RTH)");
  Object.assign(x, { vw: tr("VWAP (RTH)"), vws: tr("VWAP (session)"), onH: tr("Overnight high"), onL: tr("Overnight low"), pdH: tr("PD high"), pdL: tr("PD low"),
    pdC: tr("PD close"), or30H: tr("OR30 high"), or30L: tr("OR30 low"), ibH: tr("IB high"), ibL: tr("IB low"), vah: tr("PD VAH (RTH)"), val: tr("PD VAL (RTH)") });
  // the box on 1, 5 and 15 minutes (5 and 15 at their last closed bar)
  const s1 = boxStates(b, 1), up = (tf) => { const bb = resample(b, tf), s = boxStates(bb, tf), e = new Int8Array(N), m = new Int8Array(N), a = atr(bb.high, bb.low, bb.close, 14), A = new Float64Array(N), cl = new Uint8Array(N); let k = -1;
    for (let i = 0; i < N; i++) { while (k + 1 < bb.ts.length && bb.ts[k + 1] + tf * MIN <= TS[i] + MIN) { k++; } e[i] = k >= 0 ? s.e[k] : 0; m[i] = k >= 0 ? s.m[k] : 0; A[i] = k >= 0 ? a[k] : NaN; cl[i] = k >= 0 && bb.ts[k] + tf * MIN === TS[i] + MIN ? 1 : 0; }
    return { e, m, A, cl }; };
  const f5 = up(5), f15 = up(15);
  Object.assign(x, { e1: s1.e, m1: s1.m, e5: f5.e, m5: f5.m, e15: f15.e, m15: f15.m, A5: f5.A, A15: f15.A, close5: f5.cl });
  x.a1 = atr(H, L, C, 14);
  x.ema21 = ema(C, 21);
  x.h6 = macd(C, 6, 13, 5).hist;
  // relative volume: this minute's volume over the same clock minute's average in the 20 sessions before
  x.rv = new Float64Array(N).fill(NaN);
  const ring = new Map();
  for (let i = 0; i < N; i++) {
    const k = CT[i];
    let r = ring.get(k); if (!r) { r = []; ring.set(k, r); }
    if (r.length >= 10) x.rv[i] = V[i] / (r.reduce((s, v) => s + v, 0) / r.length);
    r.push(V[i]); if (r.length > 20) r.shift();
  }
  // the RTH session so far: its open, high, low, and the minute each extreme was set
  x.rO = new Float64Array(N).fill(NaN); x.rH = new Float64Array(N).fill(NaN); x.rL = new Float64Array(N).fill(NaN); x.rHi = new Int32Array(N).fill(-1); x.rLi = new Int32Array(N).fill(-1);
  let td = -1, o = NaN, hi = -Infinity, lo = Infinity, hiI = -1, loI = -1;
  for (let i = 0; i < N; i++) {
    const ct = CT[i];
    if (TD[i] !== td) { td = TD[i]; o = NaN; hi = -Infinity; lo = Infinity; }
    if (ct >= FIRST && ct < 15 * 60 + 15) {
      if (!Number.isFinite(o)) o = O[i];
      if (H[i] > hi) { hi = H[i]; hiI = i; } if (L[i] < lo) { lo = L[i]; loI = i; }
      x.rO[i] = o; x.rH[i] = hi; x.rL[i] = lo; x.rHi[i] = hiI; x.rLi[i] = loI;
    }
  }
  // batch 2: the day's context, all known before or at the minute
  // RTH range of each session, the average of the 10 before (adr10), and today's range used so far
  x.adr10 = new Float64Array(N).fill(NaN); x.used = new Float64Array(N).fill(NaN); x.onR = new Float64Array(N).fill(NaN); x.pdDir = new Int8Array(N);
  x.vxn = new Float64Array(N).fill(NaN); x.vxnChg = new Float64Array(N).fill(NaN); x.tom = new Uint8Array(N); x.vxnMed = new Float64Array(N).fill(NaN); x.opex = new Uint8Array(N); x.sinceNews = new Int32Array(N).fill(-1);
  { const ranges = [], dirs = []; let td2 = -1, hi = -Infinity, lo = Infinity, o = NaN, c = NaN, adr = NaN, pdir = 0, vx = NaN, vxc = NaN, vmed = NaN, isOpex = 0, tom = 0;
    let nk = 0; const NEWS = RED_FOLDER.map((r) => r[0]);
    for (let i = 0; i < N; i++) {
      if (TD[i] !== td2) {
        if (td2 >= 0 && Number.isFinite(o)) { ranges.push(hi - lo); dirs.push(Math.sign(c - o)); }
        td2 = TD[i]; hi = -Infinity; lo = Infinity; o = NaN; c = NaN;
        const last = ranges.slice(-10); adr = last.length >= 5 ? last.reduce((a, v) => a + v, 0) / last.length : NaN; pdir = dirs.length ? dirs[dirs.length - 1] : 0;
        const day = new Date(TD[i] * 86400000), iso = day.toISOString().slice(0, 10);
        let lo2 = 0, hi2 = VXN_DATES.length; while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (VXN_DATES[m] < iso) lo2 = m + 1; else hi2 = m; }
        vx = lo2 > 0 ? VXN.get(VXN_DATES[lo2 - 1]) : NaN; vxc = lo2 > 1 ? vx / VXN.get(VXN_DATES[lo2 - 2]) - 1 : NaN;
        const prev = VXN_DATES.slice(Math.max(0, lo2 - 60), lo2).map((d) => VXN.get(d)).sort((a, b) => a - b); vmed = prev.length >= 30 ? prev[prev.length >> 1] : NaN;
        isOpex = day.getUTCDay() === 5 && day.getUTCDate() >= 15 && day.getUTCDate() <= 21 ? 1 : 0;
        { const dd = day.getUTCDate(), last = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate(); tom = dd <= 3 || dd >= last - 1 ? 1 : 0; }
      }
      const ct = CT[i];
      if (ct >= FIRST && ct < 15 * 60 + 15) { if (!Number.isFinite(o)) o = O[i]; c = C[i]; hi = Math.max(hi, H[i]); lo = Math.min(lo, L[i]); x.used[i] = (hi - lo) / adr; }
      x.adr10[i] = adr; x.pdDir[i] = pdir; x.vxn[i] = vx; x.vxnChg[i] = vxc; x.tom[i] = tom; x.vxnMed[i] = vmed; x.opex[i] = isOpex;
      x.onR[i] = x.onH[i] - x.onL[i];
      while (nk < NEWS.length && NEWS[nk] <= TS[i]) nk++;
      if (nk > 0) x.sinceNews[i] = Math.round((TS[i] + MIN - NEWS[nk - 1]) / MIN);
    }
  }
  x.h12 = macd(C, 12, 26, 9).hist;
  // batch 12: RTH volume so far today against the 20 sessions before at the same minute; 30-minute efficiency ratio
  x.dayVol = new Float64Array(N).fill(NaN); x.er30 = new Float64Array(N).fill(NaN); x.onBox = new Int8Array(N);
  { const ringC = new Map(); let td6 = -1, cum = 0, ob = 0;
    for (let i = 0; i < N; i++) {
      if (TD[i] !== td6) { td6 = TD[i]; cum = 0; ob = 0; }
      if (CT[i] === FIRST - 1) { const both = (d) => sideOf(x.e1[i]) === d && sideOf(x.m1[i]) === d; ob = both(1) ? 1 : both(-1) ? -1 : 0; }
      x.onBox[i] = ob;
      if (CT[i] >= FIRST && CT[i] < 15 * 60 + 15) {
        cum += V[i];
        let r = ringC.get(CT[i]); if (!r) { r = []; ringC.set(CT[i], r); }
        if (r.length >= 10) x.dayVol[i] = cum / (r.reduce((a, v) => a + v, 0) / r.length);
        r.push(cum); if (r.length > 20) r.shift();
      }
      if (i >= 30) { let path = 0; for (let k = i - 29; k <= i; k++) path += Math.abs(C[k] - C[k - 1]); x.er30[i] = path > 0 ? Math.abs(C[i] - C[i - 30]) / path : NaN; }
    }
  }
  // batch 16: 5m ADX at the last closed 5m bar; the prior day's RTH POC; the RTH open's place against yesterday's value
  { const bb = resample(b, 5), ax = adx(bb.high, bb.low, bb.close, 14).adx; x.adx5 = new Float64Array(N).fill(NaN); let k = -1;
    for (let i = 0; i < N; i++) { while (k + 1 < bb.ts.length && bb.ts[k + 1] + 5 * MIN <= TS[i] + MIN) k++; if (k >= 0) x.adx5[i] = ax[k]; } }
  x.pdPoc = tr("PD POC (RTH)");
  x.ema105 = ema(C, 105);
  // batch 15: the 12/26 EMA gap (the EMA row's histogram)
  { const e12 = ema(C, 12), e26 = ema(C, 26); x.gap12 = new Float64Array(N); for (let i = 0; i < N; i++) x.gap12[i] = e12[i] - e26[i]; }
  // batch 13: how long each 1m row has held its side (bars), as the box's count column shows
  x.ageE1 = new Int32Array(N); x.ageM1 = new Int32Array(N);
  for (let i = 1; i < N; i++) {
    x.ageE1[i] = sideOf(x.e1[i]) && sideOf(x.e1[i]) === sideOf(x.e1[i - 1]) ? x.ageE1[i - 1] + 1 : 1;
    x.ageM1[i] = sideOf(x.m1[i]) && sideOf(x.m1[i]) === sideOf(x.m1[i - 1]) ? x.ageM1[i - 1] + 1 : 1;
  }
  // batch 11: VWAP crosses so far today (RTH)
  x.vwX = new Int16Array(N);
  { let td5 = -1, cnt = 0, side = 0; for (let i = 0; i < N; i++) { if (TD[i] !== td5) { td5 = TD[i]; cnt = 0; side = 0; }
      if (CT[i] >= FIRST && Number.isFinite(x.vw[i])) { const sd = sgn(C[i] - x.vw[i]); if (sd && side && sd !== side) cnt++; if (sd) side = sd; } x.vwX[i] = cnt; } }
  // batch 10: the box on 3-minute bars and on 1-minute Heikin-Ashi bars; the month's VWAP; VXN's last change
  if (BATCH === 10) {
    const f3 = up(3); x.e3 = f3.e; x.m3 = f3.m;
    const hc = new Float64Array(N), ho = new Float64Array(N), hh = new Float64Array(N), hl = new Float64Array(N);
    for (let i = 0; i < N; i++) { hc[i] = (O[i] + H[i] + L[i] + C[i]) / 4; ho[i] = i ? (ho[i - 1] + hc[i - 1]) / 2 : (O[i] + C[i]) / 2; hh[i] = Math.max(H[i], ho[i], hc[i]); hl[i] = Math.min(L[i], ho[i], hc[i]); }
    const ha = boxStates({ ts: TS, open: ho, high: hh, low: hl, close: hc, volume: V, tday: TD, ctMin: CT }, 1); x.eHA = ha.e; x.mHA = ha.m;
    x.vwM = cat.get("VWAP (month)").series[0];
  }
  // batch 8: the settlement before the prior one (ppC), so the prior day's settle-to-settle change is known
  x.ppC = new Float64Array(N).fill(NaN);
  { let td4 = -1, prevDayPdC = NaN, cur = NaN, lastPdC = NaN;
    for (let i = 0; i < N; i++) { if (TD[i] !== td4) { td4 = TD[i]; cur = prevDayPdC; prevDayPdC = lastPdC; } x.ppC[i] = cur; if (Number.isFinite(x.pdC[i])) lastPdC = x.pdC[i]; } }
  // batch 4: the 1m box's flips (either way) in each minute, and the close-location value of each bar
  x.flipAt = new Uint8Array(N); x.clv = new Float64Array(N).fill(NaN);
  for (let i = 1; i < N; i++) {
    const both = (k, d) => sideOf(x.e1[k]) === d && sideOf(x.m1[k]) === d;
    x.flipAt[i] = (both(i, 1) && !both(i - 1, 1)) || (both(i, -1) && !both(i - 1, -1)) ? 1 : 0;
    const rg = H[i] - L[i]; x.clv[i] = rg > 0 ? (2 * C[i] - H[i] - L[i]) / rg : 0;
  }
  // batch 3: MES matched by minute (-1 where it has no bar), its box, ATR and session extremes
  if (MES) {
    const M = MES, mi = new Int32Array(N).fill(-1);
    let k = 0;
    for (let i = 0; i < N; i++) { while (k < M.count && M.ts[k] < TS[i]) k++; if (k < M.count && M.ts[k] === TS[i]) mi[i] = k; }
    const ms = boxStates({ ts: M.ts, open: M.open, high: M.high, low: M.low, close: M.close, volume: M.volume, tday: M.tday, ctMin: M.ctMin }, 1);
    const ma = atr(M.high, M.low, M.close, 14);
    x.mi = mi; x.mC = M.close; x.mE = ms.e; x.mM = ms.m; x.mA = ma;
    x.mH = new Float64Array(N).fill(NaN); x.mL = new Float64Array(N).fill(NaN);
    let td3 = -1, hi = -Infinity, lo = Infinity;
    for (let i = 0; i < N; i++) {
      if (TD[i] !== td3) { td3 = TD[i]; hi = -Infinity; lo = Infinity; }
      const j = mi[i];
      if (j >= 0 && CT[i] >= FIRST && CT[i] < 15 * 60 + 15) { hi = Math.max(hi, M.high[j]); lo = Math.min(lo, M.low[j]); x.mH[i] = hi; x.mL[i] = lo; }
    }
  }
  // signed volume over the last 10 minutes (an order-flow stand-in: volume of up bars less down bars), over total
  x.flow = new Float64Array(N).fill(NaN);
  for (let i = 10; i < N; i++) { let s = 0, t = 0; for (let k = i - 9; k <= i; k++) { const d = C[k] - O[k]; s += d > 0 ? V[k] : d < 0 ? -V[k] : 0; t += V[k]; } x.flow[i] = t ? s / t : NaN; }
  return x;
}

// ── the box's own signals, at minute i: +1 / -1 / 0 ──
const pot = (a, z) => (z === 4 && a !== 4 ? 1 : z === 2 && a !== 2 ? -1 : 0);
const BASES = {
  flip1: (x, i) => { const both = (k, d) => sideOf(x.e1[k]) === d && sideOf(x.m1[k]) === d; return both(i, 1) && !both(i - 1, 1) ? 1 : both(i, -1) && !both(i - 1, -1) ? -1 : 0; },
  potM1: (x, i) => pot(x.m1[i - 1], x.m1[i]),
  potE1: (x, i) => pot(x.e1[i - 1], x.e1[i]),
  potM5: (x, i) => pot(x.m5[i - 1], x.m5[i]),
  potE5: (x, i) => pot(x.e5[i - 1], x.e5[i]),
  potAny: (x, i) => pot(x.m1[i - 1], x.m1[i]) || pot(x.e1[i - 1], x.e1[i]) || pot(x.m5[i - 1], x.m5[i]) || pot(x.e5[i - 1], x.e5[i]),
  pot1: (x, i) => pot(x.m1[i - 1], x.m1[i]) || pot(x.e1[i - 1], x.e1[i]),
  lead: (x, i) => (x.e1[i] === 2 && x.e1[i - 1] !== 2 && x.e5[i] === 4 ? -1 : 0),
};

// ── the ideas ──
const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const minuteOfSession = (x, i) => (x.CT[i] + 1) - FIRST;   // minutes since 08:30 at this bar's close
const BATCHES = {
  1: [
    // signals
    { name: "opening drive", kind: "signal", why: "the first 15 minutes carry the overnight order imbalance; institutions working orders keep pushing that way",
      call: (x, i) => (minuteOfSession(x, i) === 15 && Number.isFinite(x.rO[i]) ? sgn(x.C[i] - x.rO[i]) : 0) },
    { name: "failed OR30 breakout", kind: "signal", why: "a break of the 30-minute range that falls back inside traps breakout traders, whose stops fuel the reversal",
      call: (x, i) => { if (!(minuteOfSession(x, i) > 30) || !Number.isFinite(x.or30H[i])) return 0; const H = x.or30H[i], L = x.or30L[i];
        if (x.C[i] < H && x.C[i] > L) { for (let k = i - 1; k >= i - 10; k--) { if (x.C[k] > H) return -1; if (x.C[k] < L) return 1; } } return 0; } },
    { name: "failed overnight-range breakout", kind: "signal", why: "same trap at the overnight high/low, the most watched levels at the open",
      call: (x, i) => { const H = x.onH[i], L = x.onL[i]; if (!Number.isFinite(H)) return 0;
        if (x.C[i] < H && x.C[i] > L) { for (let k = i - 1; k >= i - 10; k--) { if (x.C[k] > H) return -1; if (x.C[k] < L) return 1; } } return 0; } },
    { name: "volume climax at session extreme", kind: "signal", why: "capitulation: a burst of volume making a new session high/low exhausts the side that is chasing",
      call: (x, i) => (x.rv[i] > 3 && x.rHi[i] === i && minuteOfSession(x, i) > 15 ? -1 : x.rv[i] > 3 && x.rLi[i] === i && minuteOfSession(x, i) > 15 ? 1 : 0) },
    { name: "absorption bar", kind: "signal", why: "heavy volume with a tiny range means passive orders absorbed the aggressor; price then moves away from the aggressor",
      call: (x, i) => { const rg = x.H[i] - x.L[i]; if (!(x.rv[i] > 2) || !(rg < 0.7 * x.a1[i - 1])) return 0; return -sgn(x.C[i] - x.C[i - 3]); } },
    { name: "range expansion bar", kind: "signal", why: "a bar twice the usual range on heavy volume is new information arriving; it continues",
      call: (x, i) => (x.H[i] - x.L[i] > 2 * x.a1[i - 1] && x.rv[i] > 1.5 ? sgn(x.C[i] - x.O[i]) : 0) },
    { name: "long rejection wick", kind: "signal", why: "a long wick at the bar's end shows price refused there; trapped late orders unwind the other way",
      call: (x, i) => { const rg = x.H[i] - x.L[i]; if (!(rg > x.a1[i - 1])) return 0; const up = x.H[i] - Math.max(x.O[i], x.C[i]), dn = Math.min(x.O[i], x.C[i]) - x.L[i];
        return dn > 0.6 * rg ? 1 : up > 0.6 * rg ? -1 : 0; } },
    { name: "five bars one way", kind: "signal", why: "short-term overextension at 1 minute; known minute-level reversal",
      call: (x, i) => { let u = 0, d = 0; for (let k = i - 4; k <= i; k++) { if (x.C[k] > x.O[k]) u++; else if (x.C[k] < x.O[k]) d++; } return u === 5 ? -1 : d === 5 ? 1 : 0; } },
    { name: "stretch from 1m EMA21", kind: "signal", why: "price far from its short average reverts as liquidity providers lean against the move",
      call: (x, i) => { const d = (x.C[i] - x.ema21[i]) / x.a1[i]; return d > 3 ? -1 : d < -3 ? 1 : 0; } },
    { name: "order-flow proxy", kind: "signal", why: "10 minutes of volume concentrated in up (or down) bars is persistent buying (selling) that continues",
      call: (x, i) => (x.flow[i] > 0.6 ? 1 : x.flow[i] < -0.6 ? -1 : 0) },
    { name: "gap toward settlement", kind: "signal", why: "an RTH open away from the prior settlement is partly overnight noise that the cash session corrects",
      call: (x, i) => { if (minuteOfSession(x, i) !== 1 || !Number.isFinite(x.pdC[i])) return 0; const g = x.O[i] - x.pdC[i]; return Math.abs(g) > x.A5[i] ? -sgn(g) : 0; } },
    { name: "15m box flip", kind: "signal", why: "a slower box flip is a bigger, slower trend change that should run further",
      call: (x, i) => { const both = (k, d) => sideOf(x.e15[k]) === d && sideOf(x.m15[k]) === d; return both(i, 1) && !both(i - 1, 1) ? 1 : both(i, -1) && !both(i - 1, -1) ? -1 : 0; } },
    { name: "IB break after 10:30", kind: "signal", why: "a break of the first hour's range is the day's range extension; trend days start there",
      call: (x, i) => { if (!(minuteOfSession(x, i) > 60) || !Number.isFinite(x.ibH[i])) return 0; return x.C[i] > x.ibH[i] && x.C[i - 1] <= x.ibH[i] ? 1 : x.C[i] < x.ibL[i] && x.C[i - 1] >= x.ibL[i] ? -1 : 0; } },
    { name: "lunch-lull breakout", kind: "signal", why: "a range that compresses over lunch releases with the afternoon session's flow",
      call: (x, i) => { const m = minuteOfSession(x, i); if (m < 240 || m > 330) return 0; let hi = -Infinity, lo = Infinity; for (let k = i - 60; k < i; k++) { hi = Math.max(hi, x.H[k]); lo = Math.min(lo, x.L[k]); }
        if (!(hi - lo < 4 * x.A5[i])) return 0; return x.C[i] > hi ? 1 : x.C[i] < lo ? -1 : 0; } },
    // filters on the box's signals
    { name: "flip1 with heavy volume", kind: "filter", base: "flip1", why: "a flip on above-normal participation is real money changing sides, not drift", pass: (x, i) => x.rv[i] > 1.5 },
    { name: "flip1 with 15m box agreeing", kind: "filter", base: "flip1", why: "flips with the slower trend fight no one", pass: (x, i, d) => sideOf(x.e15[i]) === d && sideOf(x.m15[i]) === d },
    { name: "flip1 in the first 90 minutes", kind: "filter", base: "flip1", why: "the morning has the most informed flow; flips then carry", pass: (x, i) => minuteOfSession(x, i) <= 90 },
    { name: "flip1 with 5m ATR rising", kind: "filter", base: "flip1", why: "expanding volatility means a move is underway; flips in compression are noise", pass: (x, i) => x.A5[i] > x.A5[i - 15] },
    { name: "flip1 with order flow agreeing", kind: "filter", base: "flip1", why: "a flip backed by volume on the same side is supported", pass: (x, i, d) => d * x.flow[i] > 0.2 },
    { name: "potM1 at session extreme", kind: "filter", base: "potM1", why: "momentum easing right at the day's high/low is where reversals start", pass: (x, i, d) => (d === -1 ? i - x.rHi[i] <= 3 : i - x.rLi[i] <= 3) },
    { name: "potM1 after a long move", kind: "filter", base: "potM1", why: "easing after a stretched move (2 x 5m ATR in 30 min) has more to give back", pass: (x, i, d) => -d * (x.C[i] - x.C[i - 30]) > 2 * x.A5[i] },
    { name: "potE1 with volume fading", kind: "filter", base: "potE1", why: "a fading move on falling volume is running out of buyers (sellers)", pass: (x, i) => x.rv[i] < 0.8 },
    { name: "lead with 15m short side", kind: "filter", base: "lead", why: "the lead short sells a failed bounce; with the 15m trend also down the bounce is weaker", pass: (x, i) => sideOf(x.e15[i]) === -1 },
    { name: "lead below VWAP", kind: "filter", base: "lead", why: "a failed bounce under VWAP: the session's average buyer is losing", pass: (x, i) => x.C[i] < x.vw[i] },
  ],
  2: [
    // signals
    { name: "news: first 5 minutes continue", kind: "signal", why: "a macro surprise is absorbed over minutes, not seconds; the first move's direction keeps going as slower money reacts",
      call: (x, i) => (x.sinceNews[i] === 5 && Number.isFinite(x.A5[i]) && Math.abs(x.C[i] - x.O[i - 4]) > 0.5 * x.A5[i] ? sgn(x.C[i] - x.O[i - 4]) : 0) },
    { name: "MACD divergence at a 30-min extreme", kind: "signal", why: "a new high on weaker momentum than the last high means fewer buyers are pushing it; the classic exhaustion sign",
      call: (x, i) => { let hi = -Infinity, lo = Infinity, hiK = -1, loK = -1; for (let k = i - 30; k < i - 3; k++) { if (x.H[k] > hi) { hi = x.H[k]; hiK = k; } if (x.L[k] < lo) { lo = x.L[k]; loK = k; } }
        if (x.H[i] > hi && x.h12[i] < x.h12[hiK] && x.h12[i] > 0) return -1; if (x.L[i] < lo && x.h12[i] > x.h12[loK] && x.h12[i] < 0) return 1; return 0; } },
    { name: "small overnight range breakout", kind: "signal", why: "a quiet night leaves orders unfilled; a break of a narrow overnight range starts a range-expansion day",
      call: (x, i) => { if (!(x.onR[i] < 0.5 * x.adr10[i])) return 0; return x.C[i] > x.onH[i] && x.C[i - 1] <= x.onH[i] ? 1 : x.C[i] < x.onL[i] && x.C[i - 1] >= x.onL[i] ? -1 : 0; } },
    { name: "range exhausted, fade the extreme", kind: "signal", why: "once a session has used its usual range, new extremes are made by the last late chasers",
      call: (x, i) => (x.used[i] > 1.1 && x.rHi[i] === i ? -1 : x.used[i] > 1.1 && x.rLi[i] === i ? 1 : 0) },
    { name: "prior day's direction, the morning fade", kind: "signal", why: "the regime-bias study's best lead: a trending day is often unwound the next morning",
      call: (x, i) => (minuteOfSession(x, i) === 30 ? -x.pdDir[i] : 0) },
    { name: "half-hour turn", kind: "signal", why: "orders worked in half-hour slices (TWAPs, rebalances) pause at :00 and :30, so the half hour's move fades",
      call: (x, i) => { const m = (x.CT[i] + 1) % 30; if (m !== 0) return 0; const mv = x.C[i] - x.C[i - 30]; return Math.abs(mv) > x.A5[i] ? -sgn(mv) : 0; } },
    // filters
    { name: "flip1 when VXN is above its 60-day median", kind: "filter", base: "flip1", why: "fearful markets trend in bursts; calm ones chop", pass: (x, i) => x.vxn[i] > x.vxnMed[i] },
    { name: "flip1 after a narrow overnight", kind: "filter", base: "flip1", why: "a narrow night sets up a trend day, where flips follow through", pass: (x, i) => x.onR[i] < 0.5 * x.adr10[i] },
    { name: "flip1 with the day's range mostly unused", kind: "filter", base: "flip1", why: "with most of the usual range left there is room to run", pass: (x, i) => x.used[i] < 0.5 },
    { name: "flip1 within 30 min of a release", kind: "filter", base: "flip1", why: "flips right after news ride the new information", pass: (x, i) => x.sinceNews[i] >= 0 && x.sinceNews[i] <= 30 },
    { name: "flip1 against the prior day", kind: "filter", base: "flip1", why: "the next-session reversal lean: flips that undo yesterday carry", pass: (x, i, d) => d === -x.pdDir[i] },
    { name: "flip1 on options-expiry Fridays", kind: "filter", base: "flip1", why: "dealer hedging pins price near strikes on expiry, so flips fail", pass: (x, i) => x.opex[i] === 1 },
    { name: "flip1 breaking the day's range", kind: "filter", base: "flip1", why: "a flip at a new session high/low is a breakout; mid-range flips are noise", pass: (x, i, d) => (d === 1 ? x.rHi[i] >= i - 2 : x.rLi[i] >= i - 2) },
    { name: "potM1 with the range used up", kind: "filter", base: "potM1", why: "easing momentum once the usual range is spent marks the day's turn", pass: (x, i) => x.used[i] > 0.9 },
    { name: "potM1 with VXN below its median", kind: "filter", base: "potM1", why: "in calm markets moves mean-revert, so easing warnings follow through", pass: (x, i) => x.vxn[i] < x.vxnMed[i] },
    { name: "potE1 near VWAP", kind: "filter", base: "potE1", why: "the screen found warnings toward VWAP help; near VWAP there is no pull, so they should not", pass: (x, i) => Math.abs(x.C[i] - x.vw[i]) < 0.25 * x.A5[i] },
  ],
  // batch 3: cross-market (screen 2025, confirm 2024: MES ends 2026-03-23), and session structure
  3: [
    { name: "MES leads, MNQ lags", kind: "signal", why: "broad-market flow and index arbitrage hit the S&P first; when MES has moved and MNQ has not, MNQ catches up",
      call: (x, i) => { const a = x.mi[i], b = x.mi[i - 3]; if (a < 0 || b < 0 || !(x.mA[a] > 0)) return 0; const me = (x.mC[a] - x.mC[b]) / x.mA[a], nq = (x.C[i] - x.C[i - 3]) / x.a1[i - 1];
        return Math.abs(me) > 1.2 && Math.abs(nq) < 0.5 ? sgn(me) : 0; } },
    { name: "MNQ new high without MES", kind: "signal", why: "a new session high in NQ that the S&P does not confirm is narrow buying, which fades",
      call: (x, i) => { const a = x.mi[i]; if (a < 0 || !(minuteOfSession(x, i) > 15)) return 0; const mesHiNow = x.mC[a] >= x.mH[i] - 0.25, mesLoNow = x.mC[a] <= x.mL[i] + 0.25;
        return x.rHi[i] === i && !mesHiNow ? -1 : x.rLi[i] === i && !mesLoNow ? 1 : 0; } },
    { name: "NQ outperforming ES, 30 min", kind: "signal", why: "rotation into (out of) tech is a flow that persists through the session",
      call: (x, i) => { const a = x.mi[i], b = x.mi[i - 30]; if (a < 0 || b < 0) return 0; const rel = Math.log(x.C[i] / x.C[i - 30]) - Math.log(x.mC[a] / x.mC[b]);
        return minuteOfSession(x, i) % 15 === 0 && Math.abs(rel) > 0.002 ? sgn(rel) : 0; } },
    { name: "flip1 with the MES box agreeing", kind: "filter", base: "flip1", why: "a flip both index futures agree on is broad-market flow, not one stock", pass: (x, i, d) => { const a = x.mi[i]; return a >= 0 && sideOf(x.mE[a]) === d && sideOf(x.mM[a]) === d; } },
    { name: "potM1 with MES already turned", kind: "filter", base: "potM1", why: "if the S&P's box has already flipped the warned way, the NQ warning is the laggard catching up", pass: (x, i, d) => { const a = x.mi[i]; return a >= 0 && sideOf(x.mM[a]) === d; } },
    { name: "flip1 one side of VWAP for an hour", kind: "filter", base: "flip1", why: "a session that never crossed VWAP is a trend day; flips its way continue",
      pass: (x, i, d) => { if (minuteOfSession(x, i) < 90) return false; for (let k = i - 60; k <= i; k++) if (sgn(x.C[k] - x.vw[k]) !== d) return false; return true; } },
    { name: "potM1 at a double top or bottom", kind: "filter", base: "potM1", why: "a second test of the session extreme that stalls has failed to find new buyers (sellers)",
      pass: (x, i, d) => { const ext = d === -1 ? x.rH[i] : x.rL[i], at = d === -1 ? x.rHi[i] : x.rLi[i]; return i - at >= 15 && Math.abs((d === -1 ? x.H[i] : x.L[i]) - ext) < 0.2 * x.A5[i]; } },
    { name: "flip1 in the last hour", kind: "filter", base: "flip1", why: "closing flows (rebalancing, MOC imbalances) push one way into the close", pass: (x, i) => minuteOfSession(x, i) >= 330 },
  ],
  // batch 4 (screen 2026, confirm 2025): session timing, chop, the developing profile, buying pressure, calendar
  4: [
    { name: "London close fade", kind: "signal", why: "Europe squares its positions into its close (10:30 CT): the morning's move is partly unwound",
      call: (x, i) => { if ((x.CT[i] + 1) % 1440 !== 10 * 60 + 30 || !Number.isFinite(x.rO[i])) return 0; const mv = x.C[i] - x.rO[i]; return Math.abs(mv) > 0.25 * x.adr10[i] ? -sgn(mv) : 0; } },
    { name: "pull to the developing POC", kind: "signal", why: "the day's busiest price is where both sides agreed; late in a balanced day price drifts back to it",
      call: (x, i) => { if (minuteOfSession(x, i) < 210 || !Number.isFinite(x.dpoc[i])) return 0; const d = x.C[i] - x.dpoc[i]; if (Math.abs(d) < x.A5[i]) return 0;
        return x.C[i] < x.dvah[i] && x.C[i] > x.dval[i] ? -sgn(d) : 0; } },
    { name: "acceptance outside value", kind: "signal", why: "price that has held 15 minutes outside the developing value area is being accepted there: the auction moves on",
      call: (x, i) => { if (minuteOfSession(x, i) < 60 || !Number.isFinite(x.dvah[i])) return 0; let up = true, dn = true; for (let k = i - 14; k <= i; k++) { if (!(x.C[k] > x.dvah[k])) up = false; if (!(x.C[k] < x.dval[k])) dn = false; } return up ? 1 : dn ? -1 : 0; } },
    { name: "closing at the highs, five bars", kind: "signal", why: "bars that keep closing at their highs show buyers in control through each minute (sellers mirrored)",
      call: (x, i) => { let s5 = 0; for (let k = i - 4; k <= i; k++) s5 += x.clv[k]; s5 /= 5; return s5 > 0.6 ? 1 : s5 < -0.6 ? -1 : 0; } },
    { name: "VWAP 1-sigma band fade", kind: "signal", why: "a stretch to VWAP's 1-sigma band in a range day attracts the session's mean-reverting liquidity",
      call: (x, i) => (minuteOfSession(x, i) > 60 && x.H[i] >= x.vwUp1[i] && x.H[i - 1] < x.vwUp1[i - 1] ? -1 : minuteOfSession(x, i) > 60 && x.L[i] <= x.vwDn1[i] && x.L[i - 1] > x.vwDn1[i - 1] ? 1 : 0) },
    { name: "flip1 after a quiet 30 minutes", kind: "filter", base: "flip1", why: "the first flip after a long stretch without one is a real change, not chop",
      pass: (x, i) => { for (let k = i - 30; k < i; k++) if (x.flipAt[k]) return false; return true; } },
    { name: "flip1 in chop (3+ flips in an hour)", kind: "filter", base: "flip1", why: "in a choppy hour each flip is noise that reverses (expected to hurt)",
      pass: (x, i) => { let c = 0; for (let k = i - 60; k < i; k++) c += x.flipAt[k]; return c >= 3; } },
    { name: "flip1 after volume dried up", kind: "filter", base: "flip1", why: "a flip out of a low-volume lull is a release of pent-up orders",
      pass: (x, i) => { let s = 0, n = 0; for (let k = i - 10; k < i; k++) if (Number.isFinite(x.rv[k])) { s += x.rv[k]; n++; } return n >= 8 && s / n < 0.7; } },
    { name: "flip1 in the first 3 days of a month", kind: "filter", base: "flip1", why: "month-start inflows (pensions, payroll contributions) push index futures up; long flips gain",
      pass: (x, i, d) => { const day = new Date(x.TD[i] * 86400000).getUTCDate(); return day <= 4 && d === 1; } },
    { name: "flip1 outside today's value", kind: "filter", base: "flip1", why: "a flip away from value is the auction extending; inside value it rotates",
      pass: (x, i, d) => (d === 1 ? x.C[i] > x.dvah[i] : x.C[i] < x.dval[i]) },
  ],
  // batch 5 (screen 2026, confirm 2025): stop runs, overnight inventory, narrow days, trend days, and
  // the confirmed VWAP-slope rule tried on the other rows
  5: [
    { name: "stop run reclaimed", kind: "signal", why: "a poke under the last 20 minutes' low that closes back above it ran the stops below; with them filled, sellers are spent",
      call: (x, i) => { let lo = Infinity, hi = -Infinity; for (let k = i - 20; k <= i - 2; k++) { lo = Math.min(lo, x.L[k]); hi = Math.max(hi, x.H[k]); }
        if (x.L[i] < lo && x.C[i] > lo && x.rv[i] > 1.2) return 1; if (x.H[i] > hi && x.C[i] < hi && x.rv[i] > 1.2) return -1; return 0; } },
    { name: "overnight inventory correction", kind: "signal", why: "if the night ended heavily long (close in the top of its range), the morning unwinds some of that inventory",
      call: (x, i) => { if (minuteOfSession(x, i) !== 5 || !Number.isFinite(x.onH[i])) return 0; const r = x.onH[i] - x.onL[i]; if (!(r > 0)) return 0; const pos = (x.rO[i] - x.onL[i]) / r;
        return pos > 0.75 ? -1 : pos < 0.25 ? 1 : 0; } },
    { name: "narrow day, first-hour break", kind: "signal", why: "a day well under its usual range stores orders; the next day's first-hour break of the prior day's range releases them",
      call: (x, i) => { const m = minuteOfSession(x, i); if (m < 15 || m > 90 || !Number.isFinite(x.pdH[i])) return 0; if (!(x.pdH[i] - x.pdL[i] < 0.85 * x.adr10[i])) return 0;
        return x.C[i] > x.pdH[i] && x.C[i - 1] <= x.pdH[i] ? 1 : x.C[i] < x.pdL[i] && x.C[i - 1] >= x.pdL[i] ? -1 : 0; } },
    { name: "flip1 on a trend day (beyond the IB by half its range)", kind: "filter", base: "flip1", why: "once a day has broken out of its first hour by half that range, it is trending: flips its way continue, against it fail",
      pass: (x, i, d) => { if (!Number.isFinite(x.ibH[i]) || minuteOfSession(x, i) <= 60) return false; const r = x.ibH[i] - x.ibL[i]; return d === 1 ? x.C[i] > x.ibH[i] + 0.5 * r : x.C[i] < x.ibL[i] - 0.5 * r; } },
    { name: "potE1 against the 15m box", kind: "filter", base: "potE1", why: "a 1m warning calling a turn back toward the 15m trend is a pullback ending",
      pass: (x, i, d) => sideOf(x.e15[i]) === d },
    { name: "potE5 against VWAP slope", kind: "filter", base: "potE5", why: "confirmed #1 on 1m: warnings agreeing with VWAP's slope are weak; does it hold for the 5m EMA row",
      pass: (x, i, d) => Number.isFinite(x.vw[i - 15]) && d * (x.vw[i] - x.vw[i - 15]) < 0 },
    { name: "potM5 against VWAP slope", kind: "filter", base: "potM5", why: "the same for the 5m MACD row",
      pass: (x, i, d) => Number.isFinite(x.vw[i - 15]) && d * (x.vw[i] - x.vw[i - 15]) < 0 },
    { name: "lead in the morning", kind: "filter", base: "lead", why: "a failed bounce in the first two hours, when trends are set, carries further",
      pass: (x, i) => minuteOfSession(x, i) <= 120 },
  ],
  // batch 6 (screen 2026, confirm 2025): what the flip or warning minute itself looks like, and where it sits
  6: [
    { name: "flip1 on a strong-bodied bar", kind: "filter", base: "flip1", why: "a flip made by a bar that closes near its extreme the flip's way was pushed by real orders, not drift",
      pass: (x, i, d) => d * x.clv[i] > 0.6 && x.H[i] - x.L[i] > 0.8 * x.a1[i - 1] },
    { name: "flip1 far from the 5m EMA (chasing)", kind: "filter", base: "flip1", why: "a flip that comes after price has already run far past the 5m trend line is late (expected to hurt)",
      pass: (x, i, d) => { const e = x.ema21[i]; return d * (x.C[i] - e) > 1.2 * x.A5[i]; } },
    { name: "flip1 with room to the day's expected range", kind: "filter", base: "flip1", why: "a flip with more than half the usual range still unused its way has somewhere to go",
      pass: (x, i, d) => { if (!Number.isFinite(x.rO[i]) || !(x.adr10[i] > 0)) return false; const lim = d === 1 ? x.rL[i] + x.adr10[i] : x.rH[i] - x.adr10[i]; return d * (lim - x.C[i]) > 0.5 * x.adr10[i]; } },
    { name: "flip1 after a big swing the other way", kind: "filter", base: "flip1", why: "a flip that ends a swing of 3 x 5m ATR is a real turn after an overextension",
      pass: (x, i, d) => { let ext = d === 1 ? Infinity : -Infinity; for (let k = i - 45; k < i; k++) ext = d === 1 ? Math.min(ext, x.L[k]) : Math.max(ext, x.H[k]); let far = d === 1 ? -Infinity : Infinity;
        for (let k = i - 90; k < i - 30; k++) far = d === 1 ? Math.max(far, x.H[k]) : Math.min(far, x.L[k]); return Math.abs(far - ext) > 3 * x.A5[i]; } },
    { name: "potE1 with the 5m row warning too", kind: "filter", base: "potE1", why: "momentum easing on both timeframes at once is a broader slowdown than one row's",
      pass: (x, i, d) => (d === 1 ? x.e5[i] === 4 || x.m5[i] === 4 : x.e5[i] === 2 || x.m5[i] === 2) },
    { name: "potM1 at VWAP's 2-sigma band", kind: "filter", base: "potM1", why: "easing momentum at a statistical extreme of the session's distribution",
      pass: (x, i, d) => { const up2 = x.vw[i] + 2 * (x.vwUp1[i] - x.vw[i]), dn2 = x.vw[i] - 2 * (x.vw[i] - x.vwDn1[i]); return d === -1 ? x.H[i] >= up2 : x.L[i] <= dn2; } },
    { name: "potE1 on a doji with heavy volume", kind: "filter", base: "potE1", why: "indecision on heavy volume is a fight that the warned side is winning",
      pass: (x, i) => { const rg = x.H[i] - x.L[i]; return rg > 0 && Math.abs(x.C[i] - x.O[i]) <= 0.2 * rg && x.rv[i] > 1.2; } },
    { name: "flip1 against VWAP slope", kind: "filter", base: "flip1", why: "confirmed #1's logic on flips: a flip the way VWAP is already drifting may be late",
      pass: (x, i, d) => Number.isFinite(x.vw[i - 15]) && d * (x.vw[i] - x.vw[i - 15]) < 0 },
  ],
  // batch 7 (screen 2026, confirm 2025): published intraday momentum, time-of-day flows, the VWAP-slope rule
  // pooled over the box's rows, and weekly / Globex-open bias
  7: [
    { name: "first half-hour predicts the last", kind: "signal", why: "Gao, Han, Li & Zhou (2018): the first 30 minutes' return predicts the last 30 minutes' (late informed trading, hedging into the close)",
      call: (x, i) => { if ((x.CT[i] + 1) % 1440 !== 14 * 60 + 30) return 0; let k = i; while (k > 0 && x.TD[k] === x.TD[i] && (x.CT[k] + 1) % 1440 > 9 * 60) k--; const o = x.rO[i];
        return Number.isFinite(o) && x.TD[k] === x.TD[i] ? sgn(x.C[k] - o) : 0; } },
    { name: "same half-hour, last 20 days", kind: "signal", why: "recurring flows (fixings, hedges, rebalances) arrive at the same clock time each day, so a half-hour's usual direction repeats",
      call: (x, i) => { const m = (x.CT[i] + 1) % 1440; if (m % 30 !== 0 || m < FIRST || m > 14 * 60 + 30) return 0; let up = 0, dn = 0, days = 0;
        for (let k = i - 1; k > 0 && days < 20; k--) { if ((x.CT[k] + 1) % 1440 === m && x.TD[k] !== x.TD[i]) { const e = k + 30; if (e < i && x.TD[e] === x.TD[k]) { const r = x.C[e] - x.C[k]; if (r > 0) up++; else if (r < 0) dn++; days++; } } }
        return days >= 15 && up >= 14 ? 1 : days >= 15 && dn >= 14 ? -1 : 0; } },
    { name: "any box warning against VWAP slope", kind: "filter", base: "potAny", why: "confirmed #1 on the 1m EMA row and the same lean on the 5m rows: pooled over every row, warnings against VWAP's slope (derived from our own results, so it must pass both stages afresh)",
      pass: (x, i, d) => Number.isFinite(x.vw[i - 15]) && d * (x.vw[i] - x.vw[i - 15]) < 0 },
    { name: "flip1 with the weekly bias", kind: "filter", base: "flip1", why: "price above last week's close is the week's buyers in control; flips with them carry",
      pass: (x, i, d) => Number.isFinite(x.pwC[i]) && d * (x.C[i] - x.pwC[i]) > 0 },
    { name: "flip1 with the Globex-open bias", kind: "filter", base: "flip1", why: "price above the 17:00 open means the full session's net flow is up; flips with it carry",
      pass: (x, i, d) => Number.isFinite(x.gO[i]) && d * (x.C[i] - x.gO[i]) > 0 },
  ],
  // batch 8 (screen 2026, confirm 2025): the settlement (the prior day's RTH close, CME's settle reference)
  8: [
    { name: "settlement cross continues", kind: "signal", why: "yesterday's settlement is where the day's margin and P&L reset; a decisive cross through it puts the other side's positions underwater and they cover",
      call: (x, i) => (minuteOfSession(x, i) > 30 && Number.isFinite(x.pdC[i]) && x.C[i] > x.pdC[i] && x.C[i - 1] <= x.pdC[i] ? 1 : minuteOfSession(x, i) > 30 && x.C[i] < x.pdC[i] && x.C[i - 1] >= x.pdC[i] ? -1 : 0) },
    { name: "settlement rejection", kind: "signal", why: "a test of settlement that is pushed back off it shows the defenders there; price moves away",
      call: (x, i) => { const s0 = x.pdC[i]; if (!Number.isFinite(s0) || minuteOfSession(x, i) <= 15) return 0;
        if (x.H[i] >= s0 && x.C[i] < s0 - 0.25 * x.A5[i] && x.C[i - 1] < s0) return -1; if (x.L[i] <= s0 && x.C[i] > s0 + 0.25 * x.A5[i] && x.C[i - 1] > s0) return 1; return 0; } },
    { name: "into the settlement, toward VWAP", kind: "signal", why: "the settle is an average price over the close and MOC / hedging flows trade around the day's average, so late price is pulled toward VWAP",
      call: (x, i) => { if ((x.CT[i] + 1) % 1440 !== 14 * 60 + 30 || !Number.isFinite(x.vw[i])) return 0; const d = x.vw[i] - x.C[i]; return Math.abs(d) > 0.3 * x.A5[i] ? sgn(d) : 0; } },
    { name: "settle-to-settle momentum", kind: "signal", why: "a day that settled well above (below) the settle before leaves trend followers and margin-driven flows pushing the same way next morning",
      call: (x, i) => { if (minuteOfSession(x, i) !== 30 || !Number.isFinite(x.ppC[i])) return 0; const ch = x.pdC[i] - x.ppC[i]; return Math.abs(ch) > 0.15 * x.adr10[i] ? sgn(ch) : 0; } },
    { name: "far from settlement, fade", kind: "signal", why: "by mid-morning, a price far from settlement has stretched the day's P&L for the losing side and draws mean-reverting liquidity",
      call: (x, i) => { if ((x.CT[i] + 1) % 1440 !== 10 * 60 || !Number.isFinite(x.pdC[i])) return 0; const d = x.C[i] - x.pdC[i]; return Math.abs(d) > 0.4 * x.adr10[i] ? -sgn(d) : 0; } },
    { name: "flip1 on the settlement side", kind: "filter", base: "flip1", why: "a flip that points away from settlement, with price already beyond it, has the day's winners behind it",
      pass: (x, i, d) => Number.isFinite(x.pdC[i]) && d * (x.C[i] - x.pdC[i]) > 0 },
    { name: "flip1 just through settlement", kind: "filter", base: "flip1", why: "a flip within 15 minutes of price crossing settlement its way joins the cross",
      pass: (x, i, d) => { const s0 = x.pdC[i]; if (!Number.isFinite(s0)) return false; for (let k = i - 15; k <= i; k++) if (d * (x.C[k] - s0) > 0 && d * (x.C[k - 1] - s0) <= 0) return true; return false; } },
    { name: "potM1 at settlement", kind: "filter", base: "potM1", why: "easing momentum right at the settlement level is a defended level holding",
      pass: (x, i) => Number.isFinite(x.pdC[i]) && Math.abs(x.C[i] - x.pdC[i]) < 0.3 * x.A5[i] },
  ],
  // batch 9 (screen 2026, confirm 2025): from batch 8's reversed result, distance from settlement as a trend-day
  // sign. Daily signals, so minN 60 a half (stated before the run).
  9: [
    { name: "far from settlement at 10:00, continue", kind: "signal", minN: 60, why: "a session already 0.4 of its usual range from settlement by 10:00 is a trend day; the move keeps going",
      call: (x, i) => { if ((x.CT[i] + 1) % 1440 !== 10 * 60 || !Number.isFinite(x.pdC[i])) return 0; const d = x.C[i] - x.pdC[i]; return Math.abs(d) > 0.4 * x.adr10[i] ? sgn(d) : 0; } },
    { name: "first time 0.3 range from settlement, continue", kind: "signal", minN: 60, why: "the first time in a session that price gets 0.3 of its usual range from settlement (after 09:00) marks the day breaking away",
      call: (x, i) => { if (minuteOfSession(x, i) < 30 || !Number.isFinite(x.pdC[i]) || !(x.adr10[i] > 0)) return 0; const far = (k) => Math.abs(x.C[k] - x.pdC[k]) > 0.3 * x.adr10[k];
        if (!far(i)) return 0; for (let k = i - 1; k >= 0 && x.TD[k] === x.TD[i] && minuteOfSession(x, k) >= 30; k--) if (far(k)) return 0; return sgn(x.C[i] - x.pdC[i]); } },
    { name: "flip1 far from settlement its way", kind: "filter", base: "flip1", why: "flips that point the way a trend day has already gone from settlement",
      pass: (x, i, d) => Number.isFinite(x.pdC[i]) && d * (x.C[i] - x.pdC[i]) > 0.4 * x.adr10[i] },
  ],
  // batch 10 (screen 2026, confirm 2025): other box timeframes and inputs, time-series momentum, VXN, the turn of the month
  10: [
    { name: "3m box flip", kind: "signal", why: "a middle speed between the 1m box (late, noisy) and the 5m (late, slow) may keep more of the move",
      call: (x, i) => { const both = (k, d) => sideOf(x.e3[k]) === d && sideOf(x.m3[k]) === d; return both(i, 1) && !both(i - 1, 1) ? 1 : both(i, -1) && !both(i - 1, -1) ? -1 : 0; } },
    { name: "Heikin-Ashi box flip", kind: "signal", why: "the box read on Heikin-Ashi candles (averaged prices) filters single-bar noise before the EMAs see it",
      call: (x, i) => { const both = (k, d) => sideOf(x.eHA[k]) === d && sideOf(x.mHA[k]) === d; return both(i, 1) && !both(i - 1, 1) ? 1 : both(i, -1) && !both(i - 1, -1) ? -1 : 0; } },
    { name: "flip1 with 1m, 5m and 15m all agreeing", kind: "filter", base: "flip1", why: "a flip that completes the stack on three timeframes has every horizon's traders on one side",
      pass: (x, i, d) => sideOf(x.e5[i]) === d && sideOf(x.m5[i]) === d && sideOf(x.e15[i]) === d && sideOf(x.m15[i]) === d },
    { name: "60-minute momentum", kind: "signal", why: "time-series momentum (Moskowitz, Ooi & Pedersen) at an intraday horizon: an hour's strong move draws trend followers in",
      call: (x, i) => { if (minuteOfSession(x, i) < 60 || minuteOfSession(x, i) % 15 !== 0) return 0; const mv = x.C[i] - x.C[i - 60]; return Math.abs(mv) > 1.5 * x.A5[i] ? sgn(mv) : 0; } },
    { name: "VXN jumped, risk-off morning", kind: "signal", minN: 40, why: "a jump in the Nasdaq-100 volatility index overnight means de-risking that keeps selling into the morning (a fall, the mirror)",
      call: (x, i) => { if (minuteOfSession(x, i) !== 15 || !Number.isFinite(x.vxnChg[i])) return 0; return x.vxnChg[i] > 0.06 ? -1 : x.vxnChg[i] < -0.06 ? 1 : 0; } },
    { name: "turn of the month, long", kind: "signal", minN: 30, why: "the turn-of-the-month effect (Ariel; Lakonishok & Smidt): payroll and pension inflows lift equities in the last day and first days of a month",
      call: (x, i) => (minuteOfSession(x, i) === 15 && x.tom[i] ? 1 : 0) },
    { name: "flip1 with the month's VWAP", kind: "filter", base: "flip1", why: "price above the month's average cost has the month's buyers in profit and defending; flips with them carry",
      pass: (x, i, d) => Number.isFinite(x.vwM[i]) && d * (x.C[i] - x.vwM[i]) > 0 },
  ],
  // batch 11 (screen 2026, confirm 2025): the kind of day as context
  11: [
    { name: "any warning on a balance day", kind: "filter", base: "potAny", why: "a day that has crossed VWAP four or more times is rotating; turns called there come true",
      pass: (x, i) => x.vwX[i] >= 4 },
    { name: "flip1 its way on a trend day", kind: "filter", base: "flip1", why: "after 10:00, a day that has crossed VWAP at most once is trending; flips its way (with price on that side of VWAP) carry",
      pass: (x, i, d) => minuteOfSession(x, i) >= 60 && x.vwX[i] <= 2 && d * (x.C[i] - x.vw[i]) > 0 },
    { name: "any warning toward settlement on a far day", kind: "filter", base: "potAny", why: "on a day 0.4 of its range from settlement (a trend day), warnings calling a turn back toward settlement fight the trend (expected to hurt)",
      pass: (x, i, d) => Number.isFinite(x.pdC[i]) && Math.abs(x.C[i] - x.pdC[i]) > 0.4 * x.adr10[i] && d * (x.pdC[i] - x.C[i]) > 0 },
    { name: "narrow initial balance, its break continues", kind: "signal", why: "a first hour under 0.35 of the usual range leaves the day's range to be made later; the break of that hour starts it",
      call: (x, i) => { if (minuteOfSession(x, i) <= 60 || !Number.isFinite(x.ibH[i]) || !(x.ibH[i] - x.ibL[i] < 0.5 * x.adr10[i])) return 0;
        return x.C[i] > x.ibH[i] && x.C[i - 1] <= x.ibH[i] ? 1 : x.C[i] < x.ibL[i] && x.C[i - 1] >= x.ibL[i] ? -1 : 0; } },
    { name: "wide initial balance, fade its edges", kind: "signal", why: "a first hour over 0.8 of the usual range has spent the day's range; tests of its edges reverse",
      call: (x, i) => { if (minuteOfSession(x, i) <= 60 || !Number.isFinite(x.ibH[i]) || !(x.ibH[i] - x.ibL[i] > 0.65 * x.adr10[i])) return 0;
        return x.H[i] >= x.ibH[i] && x.H[i - 1] < x.ibH[i] ? -1 : x.L[i] <= x.ibL[i] && x.L[i - 1] > x.ibL[i] ? 1 : 0; } },
  ],
  // batch 12 (screen 2026, confirm 2025): participation and efficiency
  12: [
    { name: "any warning on a light-volume day", kind: "filter", base: "potAny", why: "with participation under 80% of normal, nobody is pushing a trend; called turns come true",
      pass: (x, i) => x.dayVol[i] < 0.8 },
    { name: "flip1 on a heavy-volume day", kind: "filter", base: "flip1", why: "with participation over 120% of normal, real money is moving; flips carry",
      pass: (x, i) => x.dayVol[i] > 1.2 },
    { name: "any warning in chop (efficiency under 0.25)", kind: "filter", base: "potAny", why: "when the last 30 minutes went nowhere for the distance travelled, price is rotating and turns follow through",
      pass: (x, i) => x.er30[i] < 0.25 },
    { name: "flip1 with an efficient move its way (over 0.35)", kind: "filter", base: "flip1", why: "a flip at the end of a straight 30-minute move joins a clean trend",
      pass: (x, i, d) => x.er30[i] > 0.35 && d * (x.C[i] - x.C[i - 30]) > 0 },
    { name: "any warning in the opening auction", kind: "filter", base: "potAny", why: "the first 30 minutes are price discovery after the open; momentum readings there are noise (expected to hurt)",
      pass: (x, i) => minuteOfSession(x, i) <= 30 },
    { name: "flip1 with the overnight box", kind: "filter", base: "flip1", why: "a flip that agrees with where the 1m box stood at 08:29 joins the overnight session's direction",
      pass: (x, i, d) => x.onBox[i] === d },
  ],
  // batch 13 (screen 2026, confirm 2025): the box's own readings - the age of the side behind a warning (its
  // count column), repeat warnings, the depth of the histogram's fall, long sides ending, the afternoon
  13: [
    { name: "potE1 after a mature side (30+ bars)", kind: "filter", base: "potE1", why: "easing after a trend has run 30 bars is exhaustion of a mature move; easing in a young trend is a pause",
      pass: (x, i) => x.ageE1[i] >= 30 },
    { name: "potM1 after a mature side (30+ bars)", kind: "filter", base: "potM1", why: "the same for the MACD row",
      pass: (x, i) => x.ageM1[i] >= 30 },
    { name: "potM1 in a young side (under 8 bars)", kind: "filter", base: "potM1", why: "easing right after a cross is the new trend's first pullback, not a turn (expected to hurt)",
      pass: (x, i) => x.ageM1[i] < 8 },
    { name: "potM1 repeated within 10 bars", kind: "filter", base: "potM1", why: "a second easing soon after the first cleared is momentum failing to rebuild",
      pass: (x, i, d) => { for (let k = i - 10; k < i; k++) if (pot(x.m1[k - 1], x.m1[k]) === d) return true; return false; } },
    { name: "potM1 with a deep histogram fall", kind: "filter", base: "potM1", why: "a histogram already 40% down from its 10-bar peak is a real loss of momentum, not a one-bar wobble",
      pass: (x, i, d) => { let pk = 0; for (let k = i - 10; k <= i; k++) pk = Math.max(pk, -d * x.h12[k]); return pk > 0 && -d * x.h12[i] < 0.6 * pk; } },
    { name: "flip1 ending a long side (40+ bars)", kind: "filter", base: "flip1", why: "a flip that ends a side held 40 bars is a real trend change; flips after short sides are chop",
      pass: (x, i) => x.ageE1[i - 1] >= 40 || x.ageM1[i - 1] >= 40 },
    { name: "any warning in the afternoon", kind: "filter", base: "potAny", why: "afternoon sessions mean-revert more than mornings (lower participation), so called turns come true",
      pass: (x, i) => minuteOfSession(x, i) >= 240 },
  ],
  // batch 14 (screen 2026, confirm 2025): more of the box's own readings
  14: [
    { name: "potE1 repeated within 10 bars", kind: "filter", base: "potE1", why: "a second easing on the EMA row soon after the first cleared is momentum failing to rebuild",
      pass: (x, i, d) => { for (let k = i - 10; k < i; k++) if (pot(x.e1[k - 1], x.e1[k]) === d) return true; return false; } },
    { name: "potM5 repeated within 15 minutes", kind: "filter", base: "potM5", why: "the same on the 5m MACD row",
      pass: (x, i, d) => { for (let k = i - 15; k < i; k++) if (pot(x.m5[k - 1], x.m5[k]) === d) return true; return false; } },
    { name: "both 1m rows warning together", kind: "filter", base: "potM1", why: "the MACD and EMA rows easing at once is a broader slowdown than one row",
      pass: (x, i, d) => (d === 1 ? x.e1[i] === 4 : x.e1[i] === 2) },
    { name: "three bars of easing", kind: "signal", why: "a MACD row that has stayed in its warning for three bars is a sustained loss of momentum, not a one-bar wobble",
      call: (x, i) => { const w = (k) => (x.m1[k] === 4 ? 1 : x.m1[k] === 2 ? -1 : 0); const d = w(i); return d && w(i - 1) === d && w(i - 2) === d && w(i - 3) !== d ? d : 0; } },
    { name: "MACD warning cleared, trend resumes", kind: "signal", why: "a warning that clears back to the plain side without a cross is a failed reversal; those who acted on it are trapped and the trend resumes",
      call: (x, i) => (x.m1[i] === 1 && x.m1[i - 1] === 2 ? 1 : x.m1[i] === 3 && x.m1[i - 1] === 4 ? -1 : 0) },
    { name: "EMA warning cleared, trend resumes", kind: "signal", why: "the same on the EMA row",
      call: (x, i) => (x.e1[i] === 1 && x.e1[i - 1] === 2 ? 1 : x.e1[i] === 3 && x.e1[i - 1] === 4 ? -1 : 0) },
    { name: "potM1 with price stalled", kind: "filter", base: "potM1", why: "momentum easing while price has also failed to make a new 10-bar extreme for 5 bars: both stalling",
      pass: (x, i, d) => { let ext = d === -1 ? -Infinity : Infinity; for (let k = i - 15; k < i - 5; k++) ext = d === -1 ? Math.max(ext, x.H[k]) : Math.min(ext, x.L[k]);
        for (let k = i - 5; k <= i; k++) if (d === -1 ? x.H[k] > ext : x.L[k] < ext) return false; return true; } },
  ],
  // batch 15 (screen 2026, confirm 2025): the 1m MACD warning beside the other rows and the trend's strength
  15: [
    { name: "potM1 with a 5m row warning too", kind: "filter", base: "potM1", why: "the 1m MACD easing while a 5m row eases the same way is a slowdown on two horizons",
      pass: (x, i, d) => (d === 1 ? x.e5[i] === 4 || x.m5[i] === 4 : x.e5[i] === 2 || x.m5[i] === 2) },
    { name: "potM1 in a strong trend (big histogram)", kind: "filter", base: "potM1", why: "easing from a big histogram (half an ATR or more) is a strong move running out, where reversals are larger",
      pass: (x, i, d) => { let pk = 0; for (let k = i - 5; k <= i; k++) pk = Math.max(pk, -d * x.h12[k]); return pk > 0.5 * x.a1[i - 1]; } },
    { name: "potE1 with a stretched EMA gap", kind: "filter", base: "potE1", why: "the 12/26 gap over 1.5 ATR is a stretched trend; easing there snaps back further",
      pass: (x, i, d) => -d * x.gap12[i] > 1.5 * x.a1[i - 1] },
    { name: "potM1 with the 5m box already turned its way", kind: "filter", base: "potM1", why: "if both 5m rows already point the warned way, the 1m warning is the last timeframe to catch up",
      pass: (x, i, d) => sideOf(x.e5[i]) === d && sideOf(x.m5[i]) === d },
  ],
  // batch 16 (screen 2026, confirm 2025): market-profile and trend-strength context
  16: [
    { name: "flip1 with value migrating its way", kind: "filter", base: "flip1", why: "today's busiest price above yesterday's means the market is accepting higher prices; long flips go with that (short mirrored)",
      pass: (x, i, d) => Number.isFinite(x.dpoc[i]) && Number.isFinite(x.pdPoc[i]) && d * (x.dpoc[i] - x.pdPoc[i]) > 0.25 * x.A5[i] },
    { name: "flip1 its way after an open outside value", kind: "filter", base: "flip1", why: "an RTH open above yesterday's value area (or below) is an imbalance open (Dalton); flips that way carry",
      pass: (x, i, d) => Number.isFinite(x.vah[i]) && (d === 1 ? x.rO[i] > x.vah[i] : x.rO[i] < x.val[i]) },
    { name: "any warning after an open inside value", kind: "filter", base: "potAny", why: "an open inside yesterday's value is a balance open; the day rotates, so called turns come true",
      pass: (x, i) => Number.isFinite(x.vah[i]) && x.rO[i] < x.vah[i] && x.rO[i] > x.val[i] },
    { name: "flip1 when 5m ADX is over 25", kind: "filter", base: "flip1", why: "a trending tape by ADX lets flips run",
      pass: (x, i) => x.adx5[i] > 25 },
    { name: "any warning when 5m ADX is under 20", kind: "filter", base: "potAny", why: "a trendless tape by ADX rotates, so called turns come true",
      pass: (x, i) => x.adx5[i] < 20 },
    { name: "flip1 its way on a big-gap day", kind: "filter", base: "flip1", why: "an RTH open half the usual range from settlement is a gap day; flips the gap's way carry the overnight news",
      pass: (x, i, d) => Number.isFinite(x.pdC[i]) && Number.isFinite(x.rO[i]) && d * (x.rO[i] - x.pdC[i]) > 0.5 * x.adr10[i] },
    { name: "any warning calling through VWAP just after a touch", kind: "filter", base: "potAny", why: "VWAP breaks more often than it holds (confirmed lean): a warning that calls price through VWAP within 3 bars of touching it",
      pass: (x, i, d) => { for (let k = i - 3; k <= i; k++) if (x.L[k] <= x.vw[k] && x.H[k] >= x.vw[k]) return d * (x.vw[i] - x.C[i]) < 0 ? false : true; return false; } },
  ],
  // batch 17 (screen 2026, confirm 2025): confirmed #1/#2 say warnings against VWAP's slope do better. Is it the session's
  // drift in general? Other measures of it, each a new variable.
  17: [
    { name: "any warning against the day's direction", kind: "filter", base: "potAny", why: "a turn called against where the session has gone since its open: the counter-drift turn #1/#2 point to",
      pass: (x, i, d) => Number.isFinite(x.rO[i]) && d * (x.C[i] - x.rO[i]) < 0 },
    { name: "any warning against the last hour's slope", kind: "filter", base: "potAny", why: "the same, with the drift as the last 60 minutes' move",
      pass: (x, i, d) => d * (x.C[i] - x.C[i - 60]) < 0 },
    { name: "any warning against the 5m EMA's slope", kind: "filter", base: "potAny", why: "the same, with the drift as the 5m-equivalent EMA (EMA 105 on 1m bars) sloping over 15 minutes",
      pass: (x, i, d) => d * (x.ema105[i] - x.ema105[i - 15]) < 0 },
    { name: "any warning against a steep VWAP slope", kind: "filter", base: "potAny", why: "if #2 is about drift, it should be stronger when VWAP moved over half a 5m ATR in 15 minutes",
      pass: (x, i, d) => Number.isFinite(x.vw[i - 15]) && d * (x.vw[i] - x.vw[i - 15]) < -0.5 * x.A5[i] },
  ],
  // batch 18 (screen 2026, confirm 2025): the box's flips
  18: [
    { name: "flip1 with the day's direction", kind: "filter", base: "flip1", why: "the mirror of the warnings' result: flips that go with where the session has gone since the open join the drift",
      pass: (x, i, d) => Number.isFinite(x.rO[i]) && d * (x.C[i] - x.rO[i]) > 0 },
    { name: "flip1 within 10 min of a 5m flip its way", kind: "filter", base: "flip1", why: "a 1m flip right after the 5m box turned the same way is the fast timeframe confirming a new slower trend",
      pass: (x, i, d) => { const b5 = (k, dd) => sideOf(x.e5[k]) === dd && sideOf(x.m5[k]) === dd; for (let k = i - 10; k <= i; k++) if (b5(k, d) && !b5(k - 1, d)) return true; return false; } },
    { name: "flip held for a second bar", kind: "signal", why: "a flip still standing one bar later has survived the first whipsaw; entering a bar late trades a little price for fewer false flips",
      call: (x, i) => { const both = (k, d) => sideOf(x.e1[k]) === d && sideOf(x.m1[k]) === d; for (const d of [1, -1]) if (both(i, d) && both(i - 1, d) && !both(i - 2, d)) return d; return 0; } },
    { name: "flip1 breaking the 30-minute range", kind: "filter", base: "flip1", why: "a flip that also takes out the last 30 minutes' high (low) is a breakout, not a wiggle inside a range",
      pass: (x, i, d) => { let hi = -Infinity, lo = Infinity; for (let k = i - 30; k < i; k++) { hi = Math.max(hi, x.H[k]); lo = Math.min(lo, x.L[k]); } return d === 1 ? x.C[i] > hi : x.C[i] < lo; } },
    { name: "flip1 with both rows crossing within 3 bars", kind: "filter", base: "flip1", why: "both lines crossing almost together is a sharp change; one row crossing long before the other is a slow drift",
      pass: (x, i, d) => { const other = sideOf(x.e1[i - 1]) === d ? x.m1 : x.e1, first = other === x.m1 ? x.e1 : x.m1; let k = i - 1; while (k > i - 30 && sideOf(first[k]) === d) k--; return i - k <= 3; } },
  ],
  // batch 19 (screen 2026, confirm 2025): new information: the box's own recent record, round numbers,
  // volatility bursts, volume flow against price, the week's drift, the 5m bar's closing minute
  19: [
    { name: "any warning after the day's last warning worked", kind: "filter", base: "potAny", why: "warnings pay in a rotating market; if today's last resolved warning reached its target first, the day is rotating, and if it failed, the day is trending through them",
      pass: (x, i, d) => { for (let j = i - 1; j > i - 390 && x.TD[j] === x.TD[i]; j--) { const dj = BASES.potAny(x, j); if (!dj) continue;
          const R = 0.00064 * (x.C[j] - x.off[j]), P = x.C[j]; for (let k = j + 1; k < i; k++) { const up = x.H[k] - P >= R, dn = P - x.L[k] >= R; if (up || dn) return dj === 1 ? up && !dn : dn && !up; } } return false; } },
    { name: "any warning just off a round 100, calling away", kind: "filter", base: "potAny", why: "round hundreds collect resting orders and option strikes; a warning that calls price away from one it touched in the last 5 minutes has those orders behind it",
      pass: (x, i, d) => { const raw = x.C[i] - x.off[i], M = Math.round(raw / 100) * 100; if (d !== Math.sign(raw - M)) return false; for (let k = i - 4; k <= i; k++) if (x.L[k] - x.off[k] <= M && x.H[k] - x.off[k] >= M) return true; return false; } },
    { name: "any warning after a volatility burst", kind: "filter", base: "potAny", why: "a burst of range (the last 5 bars' average over 1.5x the hour before) is a flush or a squeeze; once it runs out of forced orders, a turn is more likely",
      pass: (x, i) => { let a = 0, b = 0; for (let k = i - 4; k <= i; k++) a += x.H[k] - x.L[k]; for (let k = i - 64; k <= i - 5; k++) b += x.H[k] - x.L[k]; return b > 0 && a / 5 > 1.5 * (b / 60); } },
    { name: "any warning with volume flow already turned", kind: "filter", base: "potAny", why: "price rose over 30 minutes while the volume of down bars beat up bars (or the reverse): the move is running on thin participation, and the warning calls the side the volume is already on",
      pass: (x, i, d) => { let f = 0; for (let k = i - 29; k <= i; k++) { const m = x.C[k] - x.O[k]; f += m > 0 ? x.V[k] : m < 0 ? -x.V[k] : 0; } return d * (x.C[i] - x.C[i - 30]) < 0 && d * f > 0; } },
    { name: "any warning against the week's direction", kind: "filter", base: "potAny", why: "#2/#3 at a longer scale: a turn against where price has gone since last week's close",
      pass: (x, i, d) => Number.isFinite(x.pwC[i]) && d * (x.C[i] - x.pwC[i]) < 0 },
    { name: "1m warning on the 5m bar's closing minute", kind: "filter", base: "pot1", why: "5-minute chart traders act as their bar closes; a 1m warning landing on that minute gets their orders too",
      pass: (x, i) => (x.CT[i] + 1) % 5 === 0 },
  ],
  // batch 20 (screen 2026, confirm 2025): is the day balanced or one-way? the gap, stale extremes, the
  // prior day's range, fresh extremes; and the warning bar's own close
  20: [
    { name: "any warning against the opening gap", kind: "filter", base: "potAny", why: "a gap from settlement leaves overnight traders on one side; turns that call back toward settlement have gap-fill flow behind them",
      pass: (x, i, d) => Number.isFinite(x.rO[i]) && Number.isFinite(x.pdC[i]) && d * (x.rO[i] - x.pdC[i]) < 0 },
    { name: "any warning with both day extremes an hour old", kind: "filter", base: "potAny", why: "if neither the day's high nor low has moved in 60 minutes the market has found its range, and turns inside a range pay",
      pass: (x, i) => x.rHi[i] >= 0 && x.rLi[i] >= 0 && i - Math.max(x.rHi[i], x.rLi[i]) > 60 },
    { name: "any warning on a bar closing its way", kind: "filter", base: "potAny", why: "a warning whose own bar closed in the called half of its range (close location over 0.5 its way) already shows sellers (buyers) winning the minute",
      pass: (x, i, d) => d * x.clv[i] > 0.5 },
    { name: "any warning after 3+ fresh extremes in 30 min", kind: "filter", base: "potAny", why: "three or more new session highs (lows) in half an hour, with the warning calling against them, is a run that has drawn in late buyers (sellers), who give up into the turn",
      pass: (x, i, d) => { let n = 0; for (let k = i - 29; k <= i; k++) if (Number.isFinite(x.rH[k - 1]) && x.TD[k] === x.TD[k - 1] && (d === -1 ? x.rH[k] > x.rH[k - 1] : x.rL[k] < x.rL[k - 1])) n++; return n >= 3; } },
    { name: "any warning inside the prior day's range", kind: "filter", base: "potAny", why: "inside yesterday's range both sides have traded and accepted prices; turns there rotate, outside it price is discovering and runs",
      pass: (x, i) => Number.isFinite(x.pdH[i]) && x.C[i] < x.pdH[i] && x.C[i] > x.pdL[i] },
  ],
  // batch 21 (screen 2026, confirm 2025): the two VWAPs disagreeing, the forming 5m bar, Fridays, the
  // overnight midpoint, a flat VWAP
  21: [
    { name: "any warning between the session and RTH VWAPs", kind: "filter", base: "potAny", why: "between the overnight-inclusive VWAP and the day's own VWAP, the two groups' average prices disagree: a contested zone where turns rotate",
      pass: (x, i) => Number.isFinite(x.vw[i]) && Number.isFinite(x.vws[i]) && (x.C[i] - x.vw[i]) * (x.C[i] - x.vws[i]) < 0 },
    { name: "any warning with the forming 5m bar moving its way", kind: "filter", base: "potAny", why: "the 5m bar in progress (its open to this minute's close) already moving the called way: the slower chart's traders see the turn start",
      pass: (x, i, d) => { const k0 = i - ((x.CT[i]) % 5); return k0 < i && d * (x.C[i] - x.O[k0]) > 0; } },
    { name: "any warning on a Friday", kind: "filter", base: "potAny", why: "positions are squared before the weekend, so Friday moves are given back more than built on",
      pass: (x, i) => new Date(x.TS[i] - 6 * 3600000).getUTCDay() === 5 },
    { name: "any warning calling toward the overnight midpoint", kind: "filter", base: "potAny", why: "the overnight range's middle is where overnight inventory is balanced; away from it, turns back toward it are inventory unwinding",
      pass: (x, i, d) => Number.isFinite(x.onH[i]) && Number.isFinite(x.onL[i]) && d * ((x.onH[i] + x.onL[i]) / 2 - x.C[i]) > 0 },
    { name: "any warning with VWAP flat", kind: "filter", base: "potAny", why: "#2 says the drift's direction matters; with no drift (VWAP moved under a tenth of a 5m ATR in 15 minutes) both ways should rotate",
      pass: (x, i) => Number.isFinite(x.vw[i - 15]) && Math.abs(x.vw[i] - x.vw[i - 15]) < 0.1 * x.A5[i] },
  ],
};
const IDEAS = (BATCHES[BATCH] || []).filter((d) => !ONLY || ONLY.includes(d.name));
if (!IDEAS.length) throw new Error(`no ideas in batch ${BATCH}${ONLY ? " named " + ONLY.join(", ") : ""}`);

// ── one market ──
function measure(sample) {
  const x = context(sample), { N, TS, H, L, C, TD, CT, off } = x;
  // every counted minute's race, each way and size: 1 win, 0 not
  const W = [0, 1, 2, 3].map(() => new Int8Array(N)), counted = new Uint8Array(N), half = new Int8Array(N);
  const base = new Float64Array(2 * 2 * 2 * 2);   // [half][dir up/down][R] n, wins
  for (let i = 31; i + 1 < N; i++) {
    const ms = TS[i];
    if (ms < FROM || ms >= TO) continue;
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i] || !(x.A5[i] > 0) || !(x.a1[i - 1] > 0)) continue;
    counted[i] = 1; half[i] = ms < H2 ? 0 : 1;
    const P = C[i], raw = P - off[i];
    for (let r = 0; r < 2; r++) {
      const R = RS[r] * raw;
      let u = 0, d = 0;
      for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
        const up = H[j] - P >= R, dn = P - L[j] >= R;
        if (!u && (up || dn)) u = dn ? -1 : 1;
        if (!d && (up || dn)) d = up ? -1 : 1;
        if (u && d) break;
      }
      W[r * 2][i] = u === 1 ? 1 : 0; W[r * 2 + 1][i] = d === 1 ? 1 : 0;
      for (const [dir, w] of [[0, u === 1], [1, d === 1]]) { const k = ((half[i] * 2 + dir) * 2 + r) * 2; base[k]++; if (w) base[k + 1]++; }
    }
  }
  const won = (i, d, r) => W[r * 2 + (d === 1 ? 0 : 1)][i];
  const baseRate = (h, d, r) => { const k = ((h * 2 + (d === 1 ? 0 : 1)) * 2 + r) * 2; return base[k + 1] / base[k]; };
  return IDEAS.map((idea) => {
    // tallies [half][r]: n, wins, baseline-expected wins; for filters also the base signal without the filter
    const t = new Float64Array(2 * 2 * 3), u = new Float64Array(2 * 2 * 2);
    let prev = 0;
    for (let i = 31; i + 1 < N; i++) {
      if (!counted[i]) { prev = 0; continue; }
      if (idea.kind === "signal") {
        let d = 0; try { d = idea.call(x, i) || 0; } catch { d = 0; }
        const onset = d && d !== prev; prev = d;
        if (!onset) continue;
        for (let r = 0; r < 2; r++) { const k = (half[i] * 2 + r) * 3; t[k]++; t[k + 1] += won(i, d, r); t[k + 2] += baseRate(half[i], d, r); }
      } else {
        const d = BASES[idea.base](x, i);
        if (!d) continue;
        const ok = !!idea.pass(x, i, d);
        for (let r = 0; r < 2; r++) {
          if (ok) { const k = (half[i] * 2 + r) * 3; t[k]++; t[k + 1] += won(i, d, r); }
          else { const k = (half[i] * 2 + r) * 2; u[k]++; u[k + 1] += won(i, d, r); }
        }
      }
    }
    const row = { name: idea.name };
    for (let r = 0; r < 2; r++) {
      let n = 0, w = 0, e = 0, un = 0, uw = 0;
      for (let h = 0; h < 2; h++) {
        const k = (h * 2 + r) * 3, n1 = t[k], w1 = t[k + 1];
        row[`n${r}h${h}`] = n1;
        if (idea.kind === "signal") row[`edge${r}h${h}`] = n1 ? (w1 - t[k + 2]) / n1 : NaN;
        else { const ku = (h * 2 + r) * 2; row[`edge${r}h${h}`] = n1 && u[ku] ? w1 / n1 - u[ku + 1] / u[ku] : NaN; un += u[ku]; uw += u[ku + 1]; }
        n += n1; w += w1; e += t[k + 2];
      }
      row[`n${r}`] = n; row[`win${r}`] = n ? w / n : NaN;
      row[`edge${r}`] = idea.kind === "signal" ? (n ? (w - e) / n : NaN) : n && un ? w / n - uw / un : NaN;
    }
    return row;
  });
}

const real = Lab.loadSample({ file: "data/mnq_1m_beta.bin", from: FROM, to: TO });
const R = measure(real);
process.stderr.write(`  real market: ${secs()}s\n`);
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  pl.push(measure({ ...real, b: Lab.placeboBars(real.b, 7700 + BATCH * 1000 + p) }));
  if ((p + 1) % 10 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
}

// ── read ──
const cnt = (k, key, up) => { const v = R[k][key]; if (!Number.isFinite(v)) return NaN; return pl.map((o) => o[k][key]).filter(Number.isFinite).filter((z) => (up ? z >= v : z <= v)).length; };
const sg = (v) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + (100 * v).toFixed(1) : "—"), pc = (v) => (Number.isFinite(v) ? (100 * v).toFixed(1) : "—");
const verdicts = [];
console.log(`batch ${BATCH}, ${YEAR}${YEAR === 2026 ? " (to Oct 30)" : ""}, ${PLACEBOS} placebo markets; ${secs()}s`);
console.log(`edge: points of win rate over every minute the same way (signals) or over the box signal without the filter (filters). "hi"/"lo": placebo markets as high / as low`);
for (let r = 0; r < 2; r++) {
  console.log(`\n${r ? "37" : "18"}-point race${r ? " (beside it)" : " (the one judged)"}`);
  console.log(`${"idea".padEnd(36)}${"kind".padEnd(8)}${"n".padStart(7)}${"win".padStart(7)}${"edge".padStart(7)}${"hi".padStart(5)}${"lo".padStart(5)}${"H1".padStart(8)}${"hi".padStart(5)}${"lo".padStart(5)}${"H2".padStart(8)}${"hi".padStart(5)}${"lo".padStart(5)}`);
  R.forEach((o, k) => {
    const idea = IDEAS[k], hi = cnt(k, `edge${r}`, true), lo = cnt(k, `edge${r}`, false), h1 = cnt(k, `edge${r}h0`, true), l1 = cnt(k, `edge${r}h0`, false), h2 = cnt(k, `edge${r}h1`, true), l2 = cnt(k, `edge${r}h1`, false);
    let v = "";
    if (r === 0) {
      const mn = idea.minN || 100, enough = o.n0h0 >= mn && o.n0h1 >= mn;
      if (YEAR === 2026 || !ONLY) { if (enough && h1 <= 10 && h2 <= 10) v = "SCREEN PASS (helps)"; else if (enough && l1 <= 10 && l2 <= 10) v = "SCREEN PASS (hurts: the reverse helps)"; }
      else { v = hi <= 5 ? "CONFIRMED (helps)" : lo <= 5 ? "CONFIRMED (hurts)" : "not confirmed"; }
      verdicts.push({ name: idea.name, kind: idea.kind, verdict: v || "fails the screen", edge: o.edge0, hi, lo, h1, l1, h2, l2, n: o.n0 });
    }
    console.log(`${idea.name.padEnd(36)}${idea.kind.padEnd(8)}${String(o[`n${r}`]).padStart(7)}${pc(o[`win${r}`]).padStart(7)}${sg(o[`edge${r}`]).padStart(7)}${String(hi).padStart(5)}${String(lo).padStart(5)}${sg(o[`edge${r}h0`]).padStart(8)}${String(h1).padStart(5)}${String(l1).padStart(5)}${sg(o[`edge${r}h1`]).padStart(8)}${String(h2).padStart(5)}${String(l2).padStart(5)}${v ? "  " + v : ""}`);
  });
}
console.log(`\n(${secs()}s)`);
const tag = `b${BATCH}_${YEAR}${ONLY ? "_confirm" : ""}`;
fs.writeFileSync(`research/idea_lab_${tag}_results.json`, JSON.stringify({ run: new Date().toISOString(), batch: BATCH, year: YEAR, only: ONLY, placebos: PLACEBOS,
  ideas: IDEAS.map((d) => ({ name: d.name, kind: d.kind, base: d.base || null, why: d.why })), real: R, verdicts, placebo: pl }, null, 1));
