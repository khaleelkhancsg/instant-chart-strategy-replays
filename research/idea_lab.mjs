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
function BATCH_NEEDS_MES() { const a = process.argv.slice(2), i = a.indexOf("--batch"); return i >= 0 && [3, 40].includes(Number(a[i + 1])); }

// VXN closes by date (data/raw/fred/VXNCLS.csv), for the day before each session
const VXN = new Map(fs.readFileSync("data/raw/fred/VXNCLS.csv", "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(",")).filter(([, v]) => v && v !== ".").map(([d, v]) => [d, Number(v)]));
const VXN_DATES = [...VXN.keys()].sort();
// batch 30: VIX and VXV (3-month VIX) closes by date; prevClose(map, dates, iso) = the last close before iso
const readFred = (f) => new Map(fs.readFileSync(f, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(",")).filter(([, v]) => v && v !== ".").map(([d, v]) => [d, Number(v)]));
const VIX = readFred("data/raw/fred/VIXCLS.csv"), VXV = readFred("data/raw/fred/VXVCLS.csv");
// batch 45: daily macro series (data/raw/fred, downloaded 2026-11-24 with the person's OK). Each is read as
// it was public before the session: yields (H.15, the Treasury's own close) from the day before, the HY
// spread (ICE, posted the next day) two days back, the broad dollar (published weekly) a week back.
// macroAt(series, iso, lagDays, back) = [the last value dated before iso - lagDays, the one `back` observations before it]
const MACRO = Object.fromEntries(["DGS2", "DGS10", "DTWEXBGS", "BAMLH0A0HYM2", "WALCL", "WTREGEN", "RRPONTSYD"].map((s) => { const m = readFred(`data/raw/fred/${s}.csv`); return [s, { m, d: [...m.keys()].sort() }]; }));
const macroAt = (s, iso, lag, back) => { const { m, d } = MACRO[s], cut = new Date(Date.parse(iso) - lag * 86400000 + 86400000).toISOString().slice(0, 10);
  let lo = 0, hi = d.length; while (lo < hi) { const md = (lo + hi) >> 1; if (d[md] < cut) lo = md + 1; else hi = md; } const k = lo - 1; return k - back >= 0 ? [m.get(d[k]), m.get(d[k - back])] : [NaN, NaN]; };
// batch 46: event files built by research/event_data_build.py into data/raw/events
const readCsv = (f) => { const [h, ...r] = fs.readFileSync(f, "utf8").trim().split(/\r?\n/).map((l) => l.split(",")); return r.map((v) => Object.fromEntries(h.map((k, j) => [k, v[j]]))); };
function BATCH_NEEDS_EVENTS() { const a = process.argv.slice(2), i = a.indexOf("--batch"); return i >= 0 && [46, 47, 49, 50, 51, 52].includes(Number(a[i + 1])); }
const EV = BATCH_NEEDS_EVENTS() ? {
  earnings: new Set(readCsv("data/raw/events/earnings.csv").map((r) => r.session)),
  // coupon auctions by date: the close in Chicago minutes, and the weakest bid-to-cover against its term's usual
  auctions: readCsv("data/raw/events/auctions.csv").reduce((m, r) => { const t = /(\d+):(\d+) (AM|PM)/.exec(r.close_et); if (!t) return m;
    const et = ((+t[1] % 12) + (t[3] === "PM" ? 12 : 0)) * 60 + +t[2], rel = r.btc_vs_prev6 ? +r.btc_vs_prev6 : NaN, o = m.get(r.date) || { ct: et - 60, rel: NaN };
    o.ct = Math.min(o.ct, et - 60); if (Number.isFinite(rel)) o.rel = Number.isFinite(o.rel) ? Math.min(o.rel, rel) : rel; m.set(r.date, o); return m; }, new Map()),
  quarterly: new Set(readCsv("data/raw/events/index_days.csv").filter((r) => r.kind !== "monthly").map((r) => r.date)),
  cot: readCsv("data/raw/events/cot_nq.csv").map((r) => ({ from: r.usable_from, oi: +r.oi, dealer: (+r.dealer_long - +r.dealer_short) / +r.oi, lev: (+r.lev_long - +r.lev_short) / +r.oi, am: (+r.am_long - +r.am_short) / +r.oi })),
} : null;
const PC = new Map(), prevClose = (map, iso) => { const key = (map === VIX ? "x" : "v") + iso; if (PC.has(key)) return PC.get(key); let best = null; for (const d of map.keys()) if (d < iso && (!best || d > best)) best = d; const v = best ? map.get(best) : NaN; PC.set(key, v); return v; };

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PLACEBOS = Number(arg("--placebos", 100)), YEAR = Number(arg("--year", 2026)), BATCH = Number(arg("--batch", 1));
// names are split on "|" when one is given (some names hold a comma), else on ","
const ONLY = arg("--only", "") ? arg("--only", "").split(arg("--only", "").includes("|") ? "|" : ",").map((s) => s.trim()) : null;
const MIN = 60000, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, RS = [0.00064, 0.001275];
// --from / --to (YYYY-MM-DD, --to exclusive) replace the year's dates, for the forward test (batch 53); the
// halves then split at the midpoint
const FROM_ARG = arg("--from", ""), TO_ARG = arg("--to", ""), FILE = arg("--file", "data/mnq_1m_beta.bin"), OTHER = FILE !== "data/mnq_1m_beta.bin";   // OTHER: another market's bars (NQ 2010-2018): a confirmation span, not a forward test
const FROM = FROM_ARG ? Date.parse(FROM_ARG) : Date.UTC(YEAR, 0, 1);
const TO = TO_ARG ? Date.parse(TO_ARG) : FROM_ARG ? Infinity : YEAR === 2026 ? Date.UTC(2026, 9, 31) : Date.UTC(YEAR + 1, 0, 1);
let H2 = FROM_ARG ? NaN : Date.UTC(YEAR, 6, 1);   // set from the data's span below when --from is given
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
  // batch 22: the average of the last 20 settlements (prior RTH closes), known before the session
  x.d20 = new Float64Array(N).fill(NaN);
  { const st = []; let td7 = -1, avg = NaN; for (let i = 0; i < N; i++) { if (TD[i] !== td7) { td7 = TD[i]; if (Number.isFinite(x.pdC[i]) && st[st.length - 1] !== x.pdC[i]) { st.push(x.pdC[i]); if (st.length > 20) st.shift(); } avg = st.length === 20 ? st.reduce((a, v) => a + v, 0) / 20 : NaN; } x.d20[i] = avg; } }
  // batch 24: how many RTH sessions in a row closed the same way (close vs open), as of the session's start
  x.streak = new Int16Array(N); x.streakDir = new Int8Array(N);
  { let td8 = -1, o = NaN, c = NaN, st = 0, sd = 0; for (let i = 0; i < N; i++) { if (TD[i] !== td8) { if (td8 >= 0 && Number.isFinite(o)) { const dd = Math.sign(c - o); if (dd && dd === sd) st++; else { st = dd ? 1 : 0; sd = dd; } } td8 = TD[i]; o = NaN; }
      if (CT[i] >= FIRST && CT[i] < 15 * 60 + 15) { if (!Number.isFinite(o)) o = O[i]; c = C[i]; } x.streak[i] = st; x.streakDir[i] = sd; } }
  // batch 25: the overnight's volume (17:00 to 08:30) against its average over the 20 sessions before
  x.onVol = new Float64Array(N).fill(NaN);
  { const hist = []; let td9 = -1, cum = 0, val = NaN; for (let i = 0; i < N; i++) { if (TD[i] !== td9) { td9 = TD[i]; cum = 0; val = NaN; }
      if (CT[i] === FIRST && !Number.isFinite(val)) { val = hist.length >= 10 ? cum / (hist.reduce((a, v) => a + v, 0) / hist.length) : NaN; hist.push(cum); if (hist.length > 20) hist.shift(); }
      if (!Number.isFinite(val) && CT[i] !== FIRST && (CT[i] >= 17 * 60 || CT[i] < FIRST)) cum += V[i]; x.onVol[i] = val; } }
  // batch 30: the day's prior VIX and VXV closes; the 5m bar before the last closed one (for inside bars)
  x.vix = new Float64Array(N).fill(NaN); x.vxv = new Float64Array(N).fill(NaN);
  { let td10 = -1, a = NaN, c = NaN; for (let i = 0; i < N; i++) { if (TD[i] !== td10) { td10 = TD[i]; const iso = new Date(TD[i] * 86400000).toISOString().slice(0, 10); a = prevClose(VIX, iso); c = prevClose(VXV, iso); } x.vix[i] = a; x.vxv[i] = c; } }
  // VXN / VIX against its median over the 60 sessions before (1 above, 0 not, -1 unknown)
  x.premHi = new Int8Array(N).fill(-1);
  { const hist = []; let td11 = -1, v = -1; for (let i = 0; i < N; i++) { if (TD[i] !== td11) { td11 = TD[i]; const r = x.vxn[i] / x.vix[i]; v = -1; if (Number.isFinite(r) && hist.length >= 30) { const so = [...hist].sort((a, b) => a - b); v = r > so[so.length >> 1] ? 1 : 0; } if (Number.isFinite(r)) { hist.push(r); if (hist.length > 60) hist.shift(); } } x.premHi[i] = v; } }
  // batch 31: each minute's range against the same clock minute's average over the 20 sessions before
  // (rr); the overnight's efficiency (17:00 open to 08:29 close over the path), against its 60-session
  // median (onErHi: 1 above, 0 not, -1 unknown)
  x.rr = new Float64Array(N).fill(NaN);
  { const ringR = new Map(); for (let i = 0; i < N; i++) { const k = CT[i]; let r = ringR.get(k); if (!r) { r = []; ringR.set(k, r); } const rg = H[i] - L[i];
      if (r.length >= 10) { const m = r.reduce((a, v) => a + v, 0) / r.length; if (m > 0) x.rr[i] = rg / m; } r.push(rg); if (r.length > 20) r.shift(); } }
  x.onErHi = new Int8Array(N).fill(-1);
  { const hist = []; let td12 = -1, o = NaN, path = 0, v = -1, done = false;
    for (let i = 0; i < N; i++) {
      if (TD[i] !== td12) { td12 = TD[i]; o = O[i]; path = 0; v = -1; done = false; }
      else if (!done && CT[i] !== FIRST) path += Math.abs(C[i] - C[i - 1]);
      if (!done && CT[i] === FIRST) { done = true; const er = path > 0 ? Math.abs(C[i - 1] - o) / path : NaN;
        if (Number.isFinite(er)) { if (hist.length >= 30) { const so = [...hist].sort((a, b) => a - b); v = er > so[so.length >> 1] ? 1 : 0; } hist.push(er); if (hist.length > 60) hist.shift(); } }
      x.onErHi[i] = v;
    } }
  // batch 32: the session before a market holiday (the next session is more than a weekday away); a
  // red-folder release on this session's date; the prior RTH session's last hour (14:00-15:00 CT), its sign
  x.preHol = new Uint8Array(N); x.newsDay = new Uint8Array(N); x.pdLastHr = new Int8Array(N);
  { const tds = [...new Set(TD)].sort((a, b) => a - b), next = new Map(tds.map((t, k) => [t, tds[k + 1]]));
    const nd = new Set(RED_FOLDER.map((r) => Math.floor((r[0] - 6 * 3600000) / 86400000)));
    let td13 = -1, c14 = NaN, c15 = NaN, prevSign = 0;
    for (let i = 0; i < N; i++) {
      if (TD[i] !== td13) { if (td13 >= 0) prevSign = Number.isFinite(c14) && Number.isFinite(c15) ? Math.sign(c15 - c14) : 0; td13 = TD[i]; c14 = NaN; c15 = NaN; }
      const nx = next.get(TD[i]), wd = new Date(TD[i] * 86400000).getUTCDay();
      x.preHol[i] = nx !== undefined && nx - TD[i] > (wd === 5 ? 3 : 1) ? 1 : 0;
      x.newsDay[i] = nd.has(TD[i]) ? 1 : 0;
      if (CT[i] === 13 * 60 + 59) c14 = C[i]; if (CT[i] === 14 * 60 + 59) c15 = C[i];
      x.pdLastHr[i] = prevSign;
    } }
  // batch 34: today's RTH range so far over yesterday's at the same clock minute (rangeVsYday); volume per
  // point of range over the last 15 minutes against the same clock minutes' average over 20 sessions (vpp)
  x.rangeVsYday = new Float64Array(N).fill(NaN); x.vpp = new Float64Array(N).fill(NaN);
  { let td14 = -1, cur = new Map(), prev = new Map(); for (let i = 0; i < N; i++) { if (TD[i] !== td14) { td14 = TD[i]; prev = cur; cur = new Map(); }
      if (Number.isFinite(x.rH[i])) { const r = x.rH[i] - x.rL[i]; cur.set(CT[i], r); const p = prev.get(CT[i]); if (p > 0) x.rangeVsYday[i] = r / p; } } }
  { const ringV = new Map(); for (let i = 15; i < N; i++) { let v = 0, r = 0; for (let k = i - 14; k <= i; k++) { v += V[k]; r += H[k] - L[k]; } const q = r > 0 ? v / r : NaN; let h = ringV.get(CT[i]); if (!h) { h = []; ringV.set(CT[i], h); }
      if (Number.isFinite(q)) { if (h.length >= 10) x.vpp[i] = q / (h.reduce((a, b) => a + b, 0) / h.length); h.push(q); if (h.length > 20) h.shift(); } } }
  // batch 39: the highest high and lowest low of the 20 RTH sessions before this one
  x.hi20 = new Float64Array(N).fill(NaN); x.lo20 = new Float64Array(N).fill(NaN);
  { const hs = [], ls = []; let td15 = -1, h = -Infinity, l = Infinity, H20 = NaN, L20 = NaN;
    for (let i = 0; i < N; i++) {
      if (TD[i] !== td15) { if (td15 >= 0 && h > -Infinity) { hs.push(h); ls.push(l); if (hs.length > 20) { hs.shift(); ls.shift(); } } td15 = TD[i]; h = -Infinity; l = Infinity;
        H20 = hs.length === 20 ? Math.max(...hs) : NaN; L20 = ls.length === 20 ? Math.min(...ls) : NaN; }
      if (CT[i] >= FIRST && CT[i] < 15 * 60 + 15) { h = Math.max(h, H[i]); l = Math.min(l, L[i]); }
      x.hi20[i] = H20; x.lo20[i] = L20;
    } }
  // batch 45: the macro readings known before each session (see MACRO): the 2-year and 10-year yields' last
  // daily change (basis points), the broad dollar's 5-observation change (%), the HY spread's 5-observation change (bp)
  x.y2chg = new Float64Array(N).fill(NaN); x.y10chg = new Float64Array(N).fill(NaN); x.usd5 = new Float64Array(N).fill(NaN); x.hy5 = new Float64Array(N).fill(NaN);
  { let td16 = -1, a = NaN, b = NaN, c = NaN, e = NaN; for (let i = 0; i < N; i++) { if (TD[i] !== td16) { td16 = TD[i]; const iso = new Date(TD[i] * 86400000).toISOString().slice(0, 10);
        const [y2, y2p] = macroAt("DGS2", iso, 1, 1), [y10, y10p] = macroAt("DGS10", iso, 1, 1), [u, up] = macroAt("DTWEXBGS", iso, 7, 5), [h, hp] = macroAt("BAMLH0A0HYM2", iso, 2, 5);
        a = (y2 - y2p) * 100; b = (y10 - y10p) * 100; c = (u / up - 1) * 100; e = (h - hp) * 100; }
      x.y2chg[i] = a; x.y10chg[i] = b; x.usd5[i] = c; x.hy5[i] = e; } }
  // batch 48: net liquidity's 4-week change ($bn) known before the session: the Fed's balance sheet (WALCL,
  // Wednesday levels posted Thursday afternoon, read 2 days back) less the Treasury's cash (WTREGEN, the
  // same) less the reverse repo (RRPONTSYD, posted the same afternoon, read a day back, 20 readings back)
  x.liq4 = new Float64Array(N).fill(NaN);
  if (BATCH === 48) { let td18 = -1, v = NaN; for (let i = 0; i < N; i++) { if (TD[i] !== td18) { td18 = TD[i]; const iso = new Date(TD[i] * 86400000).toISOString().slice(0, 10);
        const [w, wp] = macroAt("WALCL", iso, 2, 4), [t, tp] = macroAt("WTREGEN", iso, 2, 4), [r, rp] = macroAt("RRPONTSYD", iso, 1, 20);
        v = ((w - wp) - (t - tp)) / 1000 - (r - rp); } x.liq4[i] = v; } }
  // batch 46: per session, from EV: an earnings session, the coupon auction (close minute CT, strength), a
  // quarterly expiry, and positioning usable that day (leveraged funds' net share of open interest against
  // its last 52 reports: +1 top fifth, -1 bottom fifth; asset managers' net share change over 4 reports)
  if (EV) {
    x.earn = new Uint8Array(N); x.aucCt = new Int16Array(N).fill(-1); x.aucRel = new Float64Array(N).fill(NaN); x.quarterly = new Uint8Array(N); x.levCrowd = new Int8Array(N); x.amTrend = new Float64Array(N).fill(NaN);
    let td17 = -1, e = 0, ac = -1, ar = NaN, q = 0, lc = 0, at = NaN, pre = 0, season = 0, oiChg = NaN, dealerShort = 0, amCrowd = 0, levFlip = 0;
    x.amCrowd = new Uint8Array(N); x.levFlip = new Int8Array(N);
    x.preEarn = new Uint8Array(N); x.season = new Uint8Array(N); x.oiChg = new Float64Array(N).fill(NaN); x.dealerShort = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (TD[i] !== td17) { td17 = TD[i]; const iso = new Date(TD[i] * 86400000).toISOString().slice(0, 10);
        e = EV.earnings.has(iso) ? 1 : 0; const a = EV.auctions.get(iso); ac = a ? a.ct : -1; ar = a ? a.rel : NaN; q = EV.quarterly.has(iso) ? 1 : 0;
        let k = -1; for (let j = 0; j < EV.cot.length && EV.cot[j].from <= iso; j++) k = j;
        lc = 0; at = NaN;
        if (k >= 52) { const win = EV.cot.slice(k - 51, k + 1).map((c) => c.lev).sort((p, r) => p - r), v = EV.cot[k].lev; lc = v >= win[Math.floor(0.8 * 51)] ? 1 : v <= win[Math.floor(0.2 * 51)] ? -1 : 0; }
        if (k >= 4) at = EV.cot[k].am - EV.cot[k - 4].am;
        // batch 49: tomorrow's session is an earnings session; a mega-cap reported within the last 10 days
        { const nx = new Date(TD[i] * 86400000); do nx.setUTCDate(nx.getUTCDate() + 1); while (nx.getUTCDay() === 0 || nx.getUTCDay() === 6); pre = EV.earnings.has(nx.toISOString().slice(0, 10)) ? 1 : 0;
          season = 0; for (let b = 0; b <= 10 && !season; b++) if (EV.earnings.has(new Date((TD[i] - b) * 86400000).toISOString().slice(0, 10))) season = 1; }
        // batch 50: open interest's change over the last report (%); dealers' net share in the bottom fifth of the year
        oiChg = k >= 1 ? (EV.cot[k].oi / EV.cot[k - 1].oi - 1) * 100 : NaN;
        amCrowd = 0; if (k >= 52) { const win = EV.cot.slice(k - 51, k + 1).map((c) => c.am).sort((p, r) => p - r); amCrowd = EV.cot[k].am >= win[Math.floor(0.8 * 51)] ? 1 : 0; }
        levFlip = k >= 1 && Math.sign(EV.cot[k].lev) !== Math.sign(EV.cot[k - 1].lev) ? Math.sign(EV.cot[k].lev) : 0;
        dealerShort = 0; if (k >= 52) { const win = EV.cot.slice(k - 51, k + 1).map((c) => c.dealer).sort((p, r) => p - r); dealerShort = EV.cot[k].dealer <= win[Math.floor(0.2 * 51)] ? 1 : 0; } }
      x.earn[i] = e; x.aucCt[i] = ac; x.aucRel[i] = ar; x.quarterly[i] = q; x.levCrowd[i] = lc; x.amTrend[i] = at;
      x.preEarn[i] = pre; x.season[i] = season; x.amCrowd[i] = amCrowd; x.levFlip[i] = levFlip; x.oiChg[i] = oiChg; x.dealerShort[i] = dealerShort;
    }
  }
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
  // warnings split by confirmed #2 (VWAP's 15-minute slope): with it, and against it
  potSlopeWith: (x, i) => { const d = BASES.potAny(x, i); return d && Number.isFinite(x.vw[i - 15]) && d * (x.vw[i] - x.vw[i - 15]) > 0 ? d : 0; },
  potSlopeAgainst: (x, i) => { const d = BASES.potAny(x, i); return d && Number.isFinite(x.vw[i - 15]) && d * (x.vw[i] - x.vw[i - 15]) < 0 ? d : 0; },
  // warnings split by the volatility regime: VXN's last close at 21 or above, or below
  // warnings split by the multi-day trend: calling with price's side of its 20-settlement average, or against it
  potWith20: (x, i) => { const d = BASES.potAny(x, i); return d && Number.isFinite(x.d20[i]) && d * (x.C[i] - x.d20[i]) > 0 ? d : 0; },
  potAgainst20: (x, i) => { const d = BASES.potAny(x, i); return d && Number.isFinite(x.d20[i]) && d * (x.C[i] - x.d20[i]) < 0 ? d : 0; },
  // warnings split by leveraged funds' positioning (batch 47): crowded either way, or not
  potCrowded: (x, i) => (x.levCrowd && x.levCrowd[i] !== 0 ? BASES.potAny(x, i) : 0),
  potUncrowded: (x, i) => (x.levCrowd && x.levCrowd[i] === 0 ? BASES.potAny(x, i) : 0),
  // batch 51: not crowded, split by confirmed #2 (VWAP's 15-minute slope)
  potUncrowdedSlopeWith: (x, i) => (x.levCrowd && x.levCrowd[i] === 0 ? BASES.potSlopeWith(x, i) : 0),
  potUncrowdedSlopeAgainst: (x, i) => (x.levCrowd && x.levCrowd[i] === 0 ? BASES.potSlopeAgainst(x, i) : 0),
  potVxnHigh: (x, i) => (x.vxn[i] >= 21 ? BASES.potAny(x, i) : 0),
  potVxnLow: (x, i) => (x.vxn[i] < 21 ? BASES.potAny(x, i) : 0),
  lead: (x, i) => (x.e1[i] === 2 && x.e1[i - 1] !== 2 && x.e5[i] === 4 ? -1 : 0),
};

// ── the ideas ──
const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const minuteOfSession = (x, i) => (x.CT[i] + 1) - FIRST;   // minutes since 08:30 at this bar's close
// batch 38: the four near misses, each exactly as its own batch wrote it (looked up by name, so they cannot drift)
const nearMisses = (x, i, d) => NEAR.reduce((n, f) => n + (f(x, i, d) ? 1 : 0), 0);
let NEAR = [];
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
  // batch 22 (screen 2026, confirm 2025): yesterday's width, the flips' record, the overnight's width,
  // the multi-day stretch, the warning bar's volume
  22: [
    { name: "any warning the day after a wide day", kind: "filter", base: "potAny", why: "volatility clusters, and the day after a wide one is spent digesting it: two-way trade where turns pay",
      pass: (x, i) => Number.isFinite(x.pdH[i]) && x.adr10[i] > 0 && x.pdH[i] - x.pdL[i] > 1.3 * x.adr10[i] },
    { name: "any warning after the day's last flip failed", kind: "filter", base: "potAny", why: "a box flip that lost its race means today's moves are not following through: a choppy day where warnings (turns) pay",
      pass: (x, i) => { for (let j = i - 1; j > i - 390 && x.TD[j] === x.TD[i]; j--) { const dj = BASES.flip1(x, j); if (!dj) continue;
          const R = 0.00064 * (x.C[j] - x.off[j]), P = x.C[j]; for (let k = j + 1; k < i; k++) { const up = x.H[k] - P >= R, dn = P - x.L[k] >= R; if (up || dn) return dj === 1 ? !(up && !dn) : !(dn && !up); } } return false; } },
    { name: "any warning after a wide overnight", kind: "filter", base: "potAny", why: "an overnight range over half the usual day's range has done the day's discovery early, so RTH trades inside it two ways",
      pass: (x, i) => x.adr10[i] > 0 && x.onR[i] > 0.5 * x.adr10[i] },
    { name: "any warning against a multi-day stretch", kind: "filter", base: "potAny", why: "price over 1.5 days' ranges from its 20-settlement average is stretched at the daily scale; intraday turns back toward it have swing traders taking profit behind them",
      pass: (x, i, d) => Number.isFinite(x.d20[i]) && x.adr10[i] > 0 && d * (x.d20[i] - x.C[i]) > 1.5 * x.adr10[i] },
    { name: "any warning on a heavy-volume bar", kind: "filter", base: "potAny", why: "a warning on a bar trading over twice the usual volume for that minute is a climax: the last forced orders the old way meeting the new side",
      pass: (x, i) => x.rv[i] > 2 },
  ],
  // batch 23 (screen 2026, confirm 2025): other balance points, after batch 21's overnight midpoint: is
  // it "toward balance" in general, or the overnight inventory in particular?
  23: [
    { name: "any warning calling toward the prior day's midpoint", kind: "filter", base: "potAny", why: "the middle of yesterday's range is where yesterday's two sides met; turns back toward it are the same inventory unwinding as the overnight midpoint, a day longer",
      pass: (x, i, d) => { const m = (x.pdH[i] + x.pdL[i]) / 2; return Number.isFinite(m) && d * (m - x.C[i]) > 0; } },
    { name: "any warning calling toward the prior day's POC", kind: "filter", base: "potAny", why: "yesterday's most-traded price is its fairest; turns toward it have value buyers (sellers) behind them",
      pass: (x, i, d) => { const m = x.pdPoc[i]; return Number.isFinite(m) && d * (m - x.C[i]) > 0; } },
    { name: "any warning calling toward the 17:00 open", kind: "filter", base: "potAny", why: "the Globex open starts the overnight inventory; turns back toward it unwind the whole session's position",
      pass: (x, i, d) => { const m = x.gO[i]; return Number.isFinite(m) && d * (m - x.C[i]) > 0; } },
    { name: "any warning calling toward the OR30 midpoint", kind: "filter", base: "potAny", why: "the opening half-hour's middle is the day's first balance; after it closes, turns back toward it are rotations inside the day's frame",
      pass: (x, i, d) => { const m = (x.or30H[i] + x.or30L[i]) / 2; return minuteOfSession(x, i) > 30 && Number.isFinite(m) && d * (m - x.C[i]) > 0; } },
    { name: "any warning calling toward the IB midpoint", kind: "filter", base: "potAny", why: "the initial balance (first hour) middle, the same after 09:30",
      pass: (x, i, d) => { const m = (x.ibH[i] + x.ibL[i]) / 2; return minuteOfSession(x, i) > 60 && Number.isFinite(m) && d * (m - x.C[i]) > 0; } },
  ],
  // batch 24 (screen 2026, confirm 2025): inside other ranges, after batch 20's prior day's range; and a
  // multi-day streak
  24: [
    { name: "any warning inside the overnight range", kind: "filter", base: "potAny", why: "inside the overnight range, prices the overnight session already accepted: two-sided trade where turns rotate",
      pass: (x, i) => Number.isFinite(x.onH[i]) && x.C[i] < x.onH[i] && x.C[i] > x.onL[i] },
    { name: "any warning inside the initial balance", kind: "filter", base: "potAny", why: "after 09:30, still inside the first hour's range: the day has not broken out, and its edges hold",
      pass: (x, i) => minuteOfSession(x, i) > 60 && Number.isFinite(x.ibH[i]) && x.C[i] < x.ibH[i] && x.C[i] > x.ibL[i] },
    { name: "any warning inside the OR30 range", kind: "filter", base: "potAny", why: "the same with the opening half-hour, after 09:00",
      pass: (x, i) => minuteOfSession(x, i) > 30 && Number.isFinite(x.or30H[i]) && x.C[i] < x.or30H[i] && x.C[i] > x.or30L[i] },
    { name: "any warning inside the prior day's value area", kind: "filter", base: "potAny", why: "inside yesterday's value area (70% of its volume) price is fair to both sides, so moves there do not run",
      pass: (x, i) => Number.isFinite(x.vah[i]) && x.C[i] < x.vah[i] && x.C[i] > x.val[i] },
    { name: "any warning against a 3-day streak", kind: "filter", base: "potAny", why: "after three RTH sessions closing the same way, the swing is extended; turns against it have profit-taking behind them",
      pass: (x, i, d) => x.streak[i] >= 3 && d === -x.streakDir[i] },
  ],
  // batch 25 (screen 2026, confirm 2025): the warning bar's size, the box split, yesterday's close
  // location, the overnight's participation
  25: [
    { name: "any warning on a narrow bar", kind: "filter", base: "potAny", why: "a warning on a bar under half the 1m ATR is momentum fading on its own, not a shock bar that a fast market can reverse straight back",
      pass: (x, i) => x.a1[i - 1] > 0 && x.H[i] - x.L[i] < 0.5 * x.a1[i - 1] },
    { name: "any warning with the 1m rows split", kind: "filter", base: "potAny", why: "with the EMA row one side and the MACD row the other, the trend is already contested, so a warning has less to turn",
      pass: (x, i) => sideOf(x.e1[i]) !== 0 && sideOf(x.m1[i]) !== 0 && sideOf(x.e1[i]) !== sideOf(x.m1[i]) },
    { name: "any warning the way yesterday closed strong", kind: "filter", base: "potAny", why: "a close in the top (bottom) fifth of yesterday's range shows buyers (sellers) holding into the bell; that pressure carries into today, so turns its way pay",
      pass: (x, i, d) => { const r = x.pdH[i] - x.pdL[i]; if (!(r > 0) || !Number.isFinite(x.pdC[i])) return false; const cl = (x.pdC[i] - x.pdL[i]) / r; return d === 1 ? cl > 0.8 : cl < 0.2; } },
    { name: "any warning after a heavy overnight", kind: "filter", base: "potAny", why: "overnight volume over 1.3x its 20-day norm means news or repositioning: RTH tends to trend on it, so turns fail",
      pass: (x, i) => x.onVol[i] > 1.3 },
  ],
  // batch 26 (screen 2026, confirm 2025): batch 23's siblings (the day's other balance prices), the
  // minutes before a release, a day already full of warnings
  26: [
    { name: "any warning calling toward the developing POC", kind: "filter", base: "potAny", why: "today's most-traded price so far is the day's balance; a sibling of batch 23's IB midpoint",
      pass: (x, i, d) => Number.isFinite(x.dpoc[i]) && minuteOfSession(x, i) > 30 && d * (x.dpoc[i] - x.C[i]) > 0 },
    { name: "any warning calling toward the day's midpoint", kind: "filter", base: "potAny", why: "the middle of today's range so far, after 09:00; a sibling of the IB midpoint that moves with the day",
      pass: (x, i, d) => Number.isFinite(x.rH[i]) && minuteOfSession(x, i) > 30 && d * ((x.rH[i] + x.rL[i]) / 2 - x.C[i]) > 0 },
    { name: "any warning calling toward the session VWAP", kind: "filter", base: "potAny", why: "the average price of everyone since 17:00, overnight included; a sibling of the overnight midpoint",
      pass: (x, i, d) => Number.isFinite(x.vws[i]) && d * (x.vws[i] - x.C[i]) > 0 },
    { name: "any warning in the 30 minutes before a release", kind: "filter", base: "potAny", why: "before a red-folder release traders flatten and wait, so moves do not follow through and turns rotate",
      pass: (x, i) => { const t = x.TS[i] + 60000; for (const r of RED_FOLDER) { if (r[0] > t + 30 * 60000) break; if (r[0] > t) return true; } return false; } },
    { name: "any warning on a day already full of warnings", kind: "filter", base: "potAny", why: "after 12 or more warnings today the box keeps calling turns that come: a rotating day",
      pass: (x, i) => { let n = 0; for (let j = i - 1; j > i - 390 && x.TD[j] === x.TD[i] && x.CT[j] >= FIRST; j--) if (BASES.potAny(x, j)) n++; return n >= 12; } },
  ],
  // batch 27 (screen 2026, confirm 2025): the trend being warned about (its volume, its size), an inside
  // bar, the 5m rows warning the other way
  27: [
    { name: "any warning ending a light-volume side", kind: "filter", base: "potAny", why: "a trend that ran on below-normal volume (the 1m MACD side's average relative volume under 0.9) had few committed traders; it turns more easily",
      pass: (x, i) => { const n = Math.min(x.ageM1[i], 120); if (n < 5) return false; let s = 0, c = 0; for (let k = i - n + 1; k <= i; k++) if (Number.isFinite(x.rv[k])) { s += x.rv[k]; c++; } return c >= 5 && s / c < 0.9; } },
    { name: "any warning ending a small move", kind: "filter", base: "potAny", why: "if the 1m MACD side moved price under one 5m ATR, there is little to give back, and the warning calls a turn in a drift that was never a trend",
      pass: (x, i) => { const n = Math.min(x.ageM1[i], 120); return n >= 5 && Math.abs(x.C[i] - x.C[i - n]) < x.A5[i]; } },
    { name: "any warning on an inside bar", kind: "filter", base: "potAny", why: "a bar inside the one before is a pause: neither side pressing, the moment a trend stalls before it turns",
      pass: (x, i) => x.H[i] <= x.H[i - 1] && x.L[i] >= x.L[i - 1] },
    { name: "any warning with a 5m row warning the other way", kind: "filter", base: "pot1", why: "a 1m warning while a 5m row warns the opposite turn is the two timeframes disagreeing about where the trend is; the 1m one has the slower chart against it",
      pass: (x, i, d) => { const w = (c) => (c === 2 ? -1 : c === 4 ? 1 : 0); return w(x.e5[i]) === -d || w(x.m5[i]) === -d; } },
  ],
  // batch 30 (screen 2026, confirm 2025): the volatility curve, the tech volatility premium, a day that has
  // broken yesterday's range, a 5m inside bar, a 15m row warning the same way
  30: [
    { name: "any warning with VIX above VXV", kind: "filter", base: "potAny", why: "an inverted volatility curve (1-month over 3-month) is a stressed market: forced selling and short covering overshoot both ways, and turns pay",
      pass: (x, i) => x.vix[i] > x.vxv[i] },
    { name: "any warning with VXN's premium over VIX above its 60-day median", kind: "filter", base: "potAny", why: "Nasdaq volatility unusually far above the S&P's means stress is in tech itself; MNQ swings wider than the index flow and comes back (against its median: in 2026 Jul-Oct the ratio never fell under 1.25)",
      pass: (x, i) => x.premHi[i] === 1 },
    { name: "any warning after yesterday's range broke today", kind: "filter", base: "potAny", why: "once today has traded beyond yesterday's high or low, the day is discovering new prices, and turns get run over",
      pass: (x, i) => Number.isFinite(x.pdH[i]) && Number.isFinite(x.rH[i]) && (x.rH[i] > x.pdH[i] || x.rL[i] < x.pdL[i]) },
    { name: "any warning on a 5m inside bar", kind: "filter", base: "potAny", why: "the last closed 5m bar inside the one before: the slower chart pausing, the 1m inside bar's near-pass at a scale with fewer, cleaner pauses",
      pass: (x, i) => { const k = i - ((x.CT[i] + 1) % 5) - 4; if (k < 5) return false; let h1 = -Infinity, l1 = Infinity, h0 = -Infinity, l0 = Infinity; for (let j = k; j < k + 5; j++) { h1 = Math.max(h1, x.H[j]); l1 = Math.min(l1, x.L[j]); } for (let j = k - 5; j < k; j++) { h0 = Math.max(h0, x.H[j]); l0 = Math.min(l0, x.L[j]); } return h1 <= h0 && l1 >= l0; } },
    { name: "1m warning with a 15m row warning the same way", kind: "filter", base: "pot1", why: "the 15m box already easing toward the same turn: the slow chart's momentum fading under the fast one",
      pass: (x, i, d) => { const w = (c) => (c === 2 ? -1 : c === 4 ? 1 : 0); return w(x.e15[i]) === d || w(x.m15[i]) === d; } },
  ],
  // batch 31 (screen 2026, confirm 2025): market structure, a warning confirmed by the next bar, the
  // overnight's efficiency, a market quiet for its time of day
  31: [
    { name: "any warning after the structure turned", kind: "filter", base: "potAny", why: "a lower swing high already printed (a higher low, for a long call) means the trend's own swings have started stepping the called way: the warning is the second sign, not the first",
      pass: (x, i, d) => { const piv = []; for (let k = i - 2; k >= i - 90 && piv.length < 2; k--) { const v = d === -1 ? x.H : x.L, s = d === -1 ? 1 : -1;
          if (s * (v[k] - v[k - 1]) > 0 && s * (v[k] - v[k - 2]) > 0 && s * (v[k] - v[k + 1]) >= 0 && s * (v[k] - v[k + 2]) >= 0) piv.push(v[k]); }
        return piv.length === 2 && (d === -1 ? piv[0] < piv[1] : piv[0] > piv[1]); } },
    { name: "a warning confirmed by the next bar", kind: "signal", why: "a warning whose next bar closes the called way has price agreeing with it; waiting one bar trades a little entry price for dropping the warnings price ignores",
      call: (x, i) => { const d = BASES.potAny(x, i - 1); return d && d * (x.C[i] - x.C[i - 1]) > 0 ? d : 0; } },
    { name: "any warning after a trending overnight", kind: "filter", base: "potAny", why: "an overnight that went one way efficiently (above its 60-session median) is directional inventory; RTH tends to keep going, so turns fail",
      pass: (x, i) => x.onErHi[i] === 1 },
    { name: "any warning when quiet for the time of day", kind: "filter", base: "potAny", why: "the last 15 minutes' bars under 0.7 of their usual size for that clock time: no one is pushing, so a trend that is easing has no fresh orders behind it",
      pass: (x, i) => { let s = 0, c = 0; for (let k = i - 14; k <= i; k++) if (Number.isFinite(x.rr[k])) { s += x.rr[k]; c++; } return c >= 10 && s / c < 0.7; } },
  ],
  // batch 32 (screen 2026, confirm 2025): the calendar and yesterday's close
  32: [
    { name: "any warning the session before a holiday", kind: "filter", base: "potAny", why: "before a market holiday desks are thin and flat: no one carries a move, so turns pay",
      pass: (x, i) => x.preHol[i] === 1 },
    { name: "any warning on a release day", kind: "filter", base: "potAny", why: "a red-folder release (CPI, NFP, FOMC ...) that day gives the market information to reprice on; it trends, so turns fail",
      pass: (x, i) => x.newsDay[i] === 1 },
    { name: "any warning in the first hour against yesterday's last hour", kind: "filter", base: "potAny", why: "the last hour's flow (closing imbalances, funds squaring) often reverses overnight and into the open; a morning turn against it is that unwinding",
      pass: (x, i, d) => minuteOfSession(x, i) <= 60 && x.pdLastHr[i] !== 0 && d === -x.pdLastHr[i] },
    { name: "any warning on a Monday morning", kind: "filter", base: "potAny", why: "Monday's first two hours price the weekend's news: directional repricing, so turns fail",
      pass: (x, i) => minuteOfSession(x, i) <= 120 && new Date(x.TD[i] * 86400000).getUTCDay() === 1 },
  ],
  // batch 33 (screen 2026, confirm 2024): every balance filter worked in 2026 and 2025 Jan-Jun and turned
  // in 2025 Jul-Dec, a steady multi-week rise; VXN does not explain it. In a multi-day trend, a turn back
  // to the day's balance that is also against that trend gets bought (sold). Finding = a "with the 20-day
  // trend" row passing both stages; the "against" rows are read beside them.
  33: [
    { name: "toward the IB midpoint, with the 20-day trend", kind: "filter", base: "potWith20", why: "a pullback to the day's balance in the multi-day trend's direction: both the day's rotation and the swing traders behind it",
      pass: (x, i, d) => { const m = (x.ibH[i] + x.ibL[i]) / 2; return minuteOfSession(x, i) > 60 && Number.isFinite(m) && d * (m - x.C[i]) > 0; } },
    { name: "toward the IB midpoint, against the 20-day trend", kind: "filter", base: "potAgainst20", why: "the other side",
      pass: (x, i, d) => { const m = (x.ibH[i] + x.ibL[i]) / 2; return minuteOfSession(x, i) > 60 && Number.isFinite(m) && d * (m - x.C[i]) > 0; } },
    { name: "toward the session VWAP, with the 20-day trend", kind: "filter", base: "potWith20", why: "the same with the session VWAP",
      pass: (x, i, d) => Number.isFinite(x.vws[i]) && d * (x.vws[i] - x.C[i]) > 0 },
    { name: "toward the session VWAP, against the 20-day trend", kind: "filter", base: "potAgainst20", why: "the other side",
      pass: (x, i, d) => Number.isFinite(x.vws[i]) && d * (x.vws[i] - x.C[i]) > 0 },
  ],
  // batch 34 (screen 2026, confirm 2025): the 15m rows' own warnings, liquidity, today against yesterday
  34: [
    { name: "15m EMA warning", kind: "signal", why: "the 15m EMA row easing toward a cross: slower money's trend fading, fewer and larger turns than the 1m and 5m rows (only those were tested before)",
      call: (x, i) => pot(x.e15[i - 1], x.e15[i]) },
    { name: "15m MACD warning", kind: "signal", why: "the same with the 15m MACD row",
      call: (x, i) => pot(x.m15[i - 1], x.m15[i]) },
    { name: "any warning in a thin market", kind: "filter", base: "potAny", why: "little volume per point of range for the time of day (under 0.7 of usual) means thin books: price overshoots on small orders and comes back, so turns pay",
      pass: (x, i) => x.vpp[i] < 0.7 },
    { name: "any warning on a day outrunning yesterday", kind: "filter", base: "potAny", why: "today's range already 1.5x yesterday's at the same time is an expansion day: a market repricing, where turns get run over",
      pass: (x, i) => x.rangeVsYday[i] > 1.5 },
  ],
  // batch 35 (screen 2026, confirm 2025): the tape's own memory over the last hour (autocorrelation, the
  // variance ratio), a move made of jumps, the edge of the hour's range
  35: [
    { name: "any warning in a mean-reverting tape", kind: "filter", base: "potAny", why: "1m returns over the last hour with lag-1 autocorrelation under -0.1: each move is being taken back, so the tape itself rewards fading",
      pass: (x, i) => { let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0; for (let k = i - 58; k <= i; k++) { const a = x.C[k - 1] - x.C[k - 2], b = x.C[k] - x.C[k - 1]; sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b; n++; }
        const cv = sxy / n - (sx / n) * (sy / n), va = sxx / n - (sx / n) ** 2, vb = syy / n - (sy / n) ** 2; return va > 0 && vb > 0 && cv / Math.sqrt(va * vb) < -0.1; } },
    { name: "any warning with the hour's variance ratio under 0.8", kind: "filter", base: "potAny", why: "5-minute moves over the hour smaller than five 1-minute moves would give (variance ratio under 0.8): the market is rotating, not trending",
      pass: (x, i) => { let v1 = 0, v5 = 0, n1 = 0, n5 = 0; for (let k = i - 59; k <= i; k++) { const r = x.C[k] - x.C[k - 1]; v1 += r * r; n1++; } for (let k = i; k >= i - 55; k -= 5) { const r = x.C[k] - x.C[k - 5]; v5 += r * r; n5++; } return v1 > 0 && (v5 / n5) / (5 * v1 / n1) < 0.8; } },
    { name: "any warning after a move made of jumps", kind: "filter", base: "potAny", why: "if the last 30 minutes' biggest bar is over a third of all the price travelled, the move came in a jump (stops, a headline), not steady buying, and jumps get faded",
      pass: (x, i) => { let p = 0, m = 0; for (let k = i - 29; k <= i; k++) { const r = Math.abs(x.C[k] - x.C[k - 1]); p += r; m = Math.max(m, r); } return p > 0 && m / p > 1 / 3; } },
    { name: "any warning at the hour's range edge, calling inside", kind: "filter", base: "potAny", why: "price in the outer fifth of the last 60 minutes' range and the warning calling back inside: the hour's rotation turning at its edge",
      pass: (x, i, d) => { let hi = -Infinity, lo = Infinity; for (let k = i - 59; k <= i; k++) { hi = Math.max(hi, x.H[k]); lo = Math.min(lo, x.L[k]); } const r = hi - lo; if (!(r > 0)) return false; const pos = (x.C[i] - lo) / r; return d === -1 ? pos > 0.8 : pos < 0.2; } },
  ],
  // batch 36 (screen 2026, confirm 2025): the two VWAPs' slopes, the hour's participation, round 25s,
  // Friday pinning
  36: [
    { name: "any warning with the two VWAPs sloping apart", kind: "filter", base: "potAny", why: "the overnight-inclusive VWAP rising while the day's falls (or the reverse): the day's traders are undoing the overnight's position, a rotation where turns pay",
      pass: (x, i) => Number.isFinite(x.vw[i - 15]) && Number.isFinite(x.vws[i - 15]) && (x.vw[i] - x.vw[i - 15]) * (x.vws[i] - x.vws[i - 15]) < 0 },
    { name: "any warning with volume rising over the hour", kind: "filter", base: "potAny", why: "the last 15 minutes' relative volume 1.3x the 45 before: participation arriving, which usually carries the move on, so turns fail",
      pass: (x, i) => { let a = 0, na = 0, b = 0, nb = 0; for (let k = i - 14; k <= i; k++) if (Number.isFinite(x.rv[k])) { a += x.rv[k]; na++; } for (let k = i - 59; k <= i - 15; k++) if (Number.isFinite(x.rv[k])) { b += x.rv[k]; nb++; } return na >= 10 && nb >= 30 && b > 0 && (a / na) / (b / nb) > 1.3; } },
    { name: "any warning just off a round 25, calling away", kind: "filter", base: "potAny", why: "the level study's nearest miss (round 25s): a warning calling away from one touched in the last 5 minutes",
      pass: (x, i, d) => { const raw = x.C[i] - x.off[i], M = Math.round(raw / 25) * 25; if (d !== Math.sign(raw - M)) return false; for (let k = i - 4; k <= i; k++) if (x.L[k] - x.off[k] <= M && x.H[k] - x.off[k] >= M) return true; return false; } },
    { name: "Friday afternoon warning toward the nearest round 100", kind: "filter", base: "potAny", why: "into the weekly options close, dealers hedging the big strikes pull price toward them: Friday after 12:00 CT, a warning calling toward the nearest round hundred",
      pass: (x, i, d) => { if (x.CT[i] < 12 * 60 || new Date(x.TD[i] * 86400000).getUTCDay() !== 5) return false; const raw = x.C[i] - x.off[i], M = Math.round(raw / 100) * 100; return d * (M - raw) > 0; } },
  ],
  // batch 37 (screen 2026, confirm 2025): jumps measured so they occur (batch 35's cut caught 4 warnings),
  // the box whipsawing, VWAP crossed back and forth in the hour, a long split box
  37: [
    { name: "any warning after a move made of jumps (3 bars, 40%)", kind: "filter", base: "potAny", why: "batch 35's idea with a cut that occurs: the last 30 minutes' 3 biggest bars over 40% of the price travelled; moves made in jumps get faded",
      pass: (x, i) => { const r = []; let p = 0; for (let k = i - 29; k <= i; k++) { const v = Math.abs(x.C[k] - x.C[k - 1]); p += v; r.push(v); } r.sort((a, b) => b - a); return p > 0 && (r[0] + r[1] + r[2]) / p > 0.4; } },
    { name: "any warning after a fake flip", kind: "filter", base: "potAny", why: "the box's last flip undone within 5 bars in the last half hour: the 1m trend is whipsawing, a chop where warnings (turns) pay",
      pass: (x, i) => { for (let j = i - 30; j < i - 1; j++) { const d = BASES.flip1(x, j); if (!d) continue; for (let k = j + 1; k <= Math.min(j + 5, i); k++) { const both = sideOf(x.e1[k]) === -d && sideOf(x.m1[k]) === -d; if (both || sideOf(x.e1[k]) !== d || sideOf(x.m1[k]) !== d) return true; } } return false; } },
    { name: "any warning after 3+ VWAP crosses in the hour", kind: "filter", base: "potAny", why: "price crossing the day's VWAP three or more times in 60 minutes is balance around fair value, where turns rotate",
      pass: (x, i) => Number.isFinite(x.vw[i - 60]) && x.TD[i - 60] === x.TD[i] && x.vwX[i] - x.vwX[i - 60] >= 3 },
    { name: "any warning after the 1m rows split for 10+ bars", kind: "filter", base: "potAny", why: "the EMA and MACD rows on opposite sides for 10 of the last 15 bars: no trend for the warning to turn, so its call is a coin flip or worse",
      pass: (x, i) => { let n = 0; for (let k = i - 14; k <= i; k++) if (sideOf(x.e1[k]) && sideOf(x.m1[k]) && sideOf(x.e1[k]) !== sideOf(x.m1[k])) n++; return n >= 10; } },
  ],
  // batch 38 (built after looking, so its 2026 screen is biased; only the 2025 run counts): the near misses
  // that lifted warnings in both halves of 2026 and beat 95+ of 100 overall, pooled. Each is its own
  // batch's rule, unchanged.
  38: [
    { name: "any warning with 2+ of the four near misses", kind: "filter", base: "potAny", why: "four weak leads with different reasons (the hour's range edge calling inside, volume rising over the hour, an inside bar, the day after a wide day); where two agree, the warning has two independent reasons behind it",
      pass: (x, i, d) => nearMisses(x, i, d) >= 2 },
    { name: "any warning with 1+ of the four near misses", kind: "filter", base: "potAny", why: "the same, read beside it at any one",
      pass: (x, i, d) => nearMisses(x, i, d) >= 1 },
  ],
  // batch 39 (screen 2026, confirm 2025): the multi-week trend as a filter of its own
  39: [
    { name: "any warning on a day that set a 20-day extreme", kind: "filter", base: "potAny", why: "today already beyond the last 20 sessions' high or low: a breakout at the swing traders' scale, a market repricing where intraday turns get run over",
      pass: (x, i) => Number.isFinite(x.hi20[i]) && Number.isFinite(x.rH[i]) && (x.rH[i] > x.hi20[i] || x.rL[i] < x.lo20[i]) },
    { name: "any warning calling with the 20-day trend", kind: "filter", base: "potAny", why: "a turn back the way of price's side of its 20-settlement average is a dip bought (rally sold) in the multi-week trend, with swing traders adding behind it",
      pass: (x, i, d) => Number.isFinite(x.d20[i]) && d * (x.C[i] - x.d20[i]) > 0 },
    { name: "any warning calling with yesterday's direction", kind: "filter", base: "potAny", why: "a turn back the way yesterday's session went (open to close) resumes the prior day's flow after today's pullback",
      pass: (x, i, d) => x.pdDir[i] !== 0 && d === x.pdDir[i] },
  ],
  // batch 40 (screen 2025, confirm 2024: MES ends 2026-03-23): MES on the warnings. Minutes MES has no bar
  // for never pass. Placebo markets flip MNQ only, so MES says nothing about them: the test is whether the
  // real MES-MNQ relation helps more than an unrelated one.
  40: [
    { name: "any warning with MES's box warning the same way", kind: "filter", base: "potAny", why: "the S&P's own 1m box easing toward the same turn: the turn is index-wide flow, not one market's noise",
      pass: (x, i, d) => { const j = x.mi[i]; if (j < 0) return false; const w = (c) => (c === 2 ? -1 : c === 4 ? 1 : 0); return w(x.mE[j]) === d || w(x.mM[j]) === d; } },
    { name: "any warning with MES failing to confirm the extreme", kind: "filter", base: "potAny", why: "MNQ set a new session high (low) in the last 10 minutes and MES did not: the push is NQ alone, without the broad index's buyers (sellers), and the warning calls it back",
      pass: (x, i, d) => { const j = x.mi[i], k = i - 10; if (j < 0 || k < 0 || x.TD[k] !== x.TD[i] || !Number.isFinite(x.mH[i]) || !Number.isFinite(x.mH[k])) return false;
        return d === -1 ? x.rHi[i] > k && !(x.mH[i] > x.mH[k]) : x.rLi[i] > k && !(x.mL[i] < x.mL[k]); } },
    { name: "any warning against NQ's 15-minute outperformance", kind: "filter", base: "potAny", why: "NQ ran ahead of ES over 15 minutes (in percent) and the warning calls it back: relative-value desks sell the stretch between the two",
      pass: (x, i, d) => { const j = x.mi[i], j0 = x.mi[i - 15]; if (j < 0 || j0 < 0) return false; const rq = x.C[i] / x.C[i - 15] - 1, re = x.mC[j] / x.mC[j0] - 1; return d * (rq - re) < 0; } },
  ],
  // batch 41 (screen 2026, confirm 2025): volatility expanding, the MACD still pressing under an EMA warning,
  // a narrow day
  41: [
    { name: "any warning with the 5m ATR rising", kind: "filter", base: "potAny", why: "5m ATR up over 10% in the last half hour: volatility expanding, which is how trends start, so turns fail",
      pass: (x, i) => x.A5[i - 30] > 0 && x.A5[i] > 1.1 * x.A5[i - 30] },
    { name: "1m EMA warning with the MACD histogram still growing", kind: "filter", base: "potE1", why: "the EMA gap easing while the 12/26/9 histogram still grows its side: the trend's momentum has not turned, so the EMA warning is early",
      pass: (x, i, d) => { const h = x.h12; return Number.isFinite(h[i - 1]) && -d * h[i] > 0 && -d * (h[i] - h[i - 1]) > 0; } },
    { name: "any warning after 11:00 on a narrow day", kind: "filter", base: "potAny", why: "past 11:00 CT with under half the usual day's range used: no one is moving the market, it rotates in a small box, and turns pay",
      pass: (x, i) => x.CT[i] >= 11 * 60 && x.used[i] < 0.5 },
  ],
  // batch 42 (screen 2026, confirm 2025): the shape of the move into the warning
  42: [
    { name: "any warning after an acceleration", kind: "filter", base: "potAny", why: "the last 5 bars moved the old trend's way more than the 10 before them: a blow-off, the late buyers (sellers) arriving at once, and nothing left to push after",
      pass: (x, i, d) => { const a = -d * (x.C[i] - x.C[i - 5]), b = -d * (x.C[i - 5] - x.C[i - 15]); return a > 0 && b > 0 && a > b; } },
    { name: "any warning soon after an opposite warning", kind: "filter", base: "potAny", why: "a warning the other way in the last 10 bars: the box is flip-flopping, a sign of a market with no direction, where turns rotate",
      pass: (x, i, d) => { for (let k = i - 10; k < i; k++) if (BASES.potAny(x, k) === -d) return true; return false; } },
    { name: "any warning against a trend running since the open", kind: "filter", base: "potAny", why: "the 1m MACD side began within the first 15 minutes and has held since: an opening drive, the day's strongest flow, which a warning rarely turns",
      pass: (x, i) => { const m = minuteOfSession(x, i); return m > 30 && x.ageM1[i] >= m - 15; } },
  ],
  // batch 43 (screen 2026, confirm 2025): a warning after a quiet box
  43: [
    { name: "the box's first warning in 30 minutes", kind: "filter", base: "potAny", why: "no warning of either kind in the last 30 bars means a trend ran clean; its first easing is a mature move tiring, where turns are likelier than in a box that keeps warning",
      pass: (x, i) => { for (let k = i - 30; k < i; k++) if (BASES.potAny(x, k)) return false; return true; } },
  ],
  // batch 45 (screen 2026, confirm 2025): outside information, the macro series known before the session
  45: [
    { name: "any warning after a 2-year yield shock", kind: "filter", base: "potAny", why: "the 2-year yield moved 8bp+ the day before: policy expectations repricing, which equity desks keep trading into the next session, so moves carry and turns fail",
      pass: (x, i) => Math.abs(x.y2chg[i]) >= 8 },
    { name: "any warning calling against yesterday's 10-year move", kind: "filter", base: "potAny", why: "Nasdaq trades against long yields; after a 5bp+ move in the 10-year, a turn the way the bond move favours (long after yields fell, short after they rose) has the rates flow behind it",
      pass: (x, i, d) => Math.abs(x.y10chg[i]) >= 5 && d === -Math.sign(x.y10chg[i]) },
    { name: "any warning against the dollar's week", kind: "filter", base: "potAny", why: "a dollar up 0.5%+ over five readings tightens conditions for global holders of US tech; turns calling short then (long after a falling dollar) have that flow behind them",
      pass: (x, i, d) => Math.abs(x.usd5[i]) >= 0.5 && d === -Math.sign(x.usd5[i]) },
    { name: "any warning after credit spreads widened", kind: "filter", base: "potAny", why: "high-yield spreads 15bp+ wider over five days is stress: forced de-risking overshoots both ways intraday, and turns pay",
      pass: (x, i) => x.hy5[i] >= 15 },
  ],
  // batch 46 (screen 2026, confirm 2025): outside events: Treasury auctions, mega-cap earnings, quarterly
  // expiry, CFTC positioning (research/event_data_build.py; data/raw/events)
  46: [
    { name: "any warning in the hour after a coupon auction", kind: "filter", base: "potAny", why: "a note or bond auction's result reprices yields at the close (12:00 CT); equities follow for the next hour, so moves carry and turns fail",
      pass: (x, i) => x.aucCt[i] >= 0 && x.CT[i] >= x.aucCt[i] && x.CT[i] < x.aucCt[i] + 60 },
    { name: "any warning after an auction, calling its way", kind: "filter", base: "potAny", why: "a weak auction (bid-to-cover under 0.95 of the term's usual) pushes yields up and Nasdaq down; a strong one (over 1.05) the reverse. After the close, a turn calling that way has the rates flow behind it",
      pass: (x, i, d) => x.aucCt[i] >= 0 && x.CT[i] >= x.aucCt[i] && Number.isFinite(x.aucRel[i]) && (x.aucRel[i] < 0.95 ? d === -1 : x.aucRel[i] > 1.05 ? d === 1 : false) },
    { name: "any warning on a mega-cap earnings session", kind: "filter", base: "potAny", why: "the first session after AAPL, MSFT, NVDA, AMZN, META, GOOGL, AVGO or TSLA reports (about 40% of the index): the index reprices, so moves carry and turns fail",
      pass: (x, i) => x.earn[i] === 1 },
    { name: "any warning on a quarterly expiry day", kind: "filter", base: "potAny", why: "quad witching and the Nasdaq-100 rebalance: dealers' hedges roll off and index funds trade at the close; pinning through the day, so turns pay",
      pass: (x, i) => x.quarterly[i] === 1 },
    { name: "any warning against leveraged funds' crowded side", kind: "filter", base: "potAny", why: "leveraged funds' net NQ position in the top (bottom) fifth of the last year: trend followers are crowded long (short), and a turn against them has their unwinding behind it",
      pass: (x, i, d) => x.levCrowd[i] !== 0 && d === -x.levCrowd[i] },
    { name: "any warning the way asset managers are adding", kind: "filter", base: "potAny", why: "asset managers' net share of open interest rising (falling) over four weeks is slow real-money buying (selling); a turn that way has it behind it",
      pass: (x, i, d) => Number.isFinite(x.amTrend[i]) && x.amTrend[i] !== 0 && d === Math.sign(x.amTrend[i]) },
  ],
  // batch 47 (screen 2026, confirm 2023: 2025 and 2024 have been used by the balance filters): does trend
  // followers' positioning say when turns back to balance work? Finding = the "crowded" row passing both
  // stages; the "not crowded" row read beside it.
  47: [
    { name: "toward the session VWAP, leveraged funds crowded", kind: "filter", base: "potCrowded", why: "with trend followers crowded on one side, a turn back to the session's balance has their unwinding behind it",
      pass: (x, i, d) => Number.isFinite(x.vws[i]) && d * (x.vws[i] - x.C[i]) > 0 },
    { name: "toward the session VWAP, leveraged funds not crowded", kind: "filter", base: "potUncrowded", why: "the other side of the split",
      pass: (x, i, d) => Number.isFinite(x.vws[i]) && d * (x.vws[i] - x.C[i]) > 0 },
  ],
  // batch 51 (independence check for batch 47, written before its 2023 result): does "toward the session
  // VWAP, leveraged funds not crowded" lift warnings on both sides of #2's split?
  51: [
    { name: "toward the session VWAP, not crowded, warnings with VWAP's slope", kind: "filter", base: "potUncrowdedSlopeWith", why: "independence from #2",
      pass: (x, i, d) => Number.isFinite(x.vws[i]) && d * (x.vws[i] - x.C[i]) > 0 },
    { name: "toward the session VWAP, not crowded, warnings against VWAP's slope", kind: "filter", base: "potUncrowdedSlopeAgainst", why: "independence from #2",
      pass: (x, i, d) => Number.isFinite(x.vws[i]) && d * (x.vws[i] - x.C[i]) > 0 },
  ],
  // batch 53: THE FORWARD TEST of the two confirmed findings, frozen exactly as they were confirmed (the rules
  // and the test written in the ledger, "Forward test", before any forward bar is read). Run only with
  // --from 2026-11-02 on bars nobody has tested.
  53: [
    { name: "F1: 1m EMA warnings agreeing with VWAP's slope", kind: "filter", base: "potE1", expect: "hurts", why: "confirmed #1 (vwap_nodes_confluence.mjs, \"1m EMA Pot. / VWAP slope agrees\")",
      pass: (x, i, d) => Number.isFinite(x.vw[i - 15]) && d * (x.vw[i] - x.vw[i - 15]) > 0 },
    { name: "F2: any box warning against VWAP slope", kind: "filter", base: "potAny", expect: "helps", why: "confirmed #2 (batch 7, \"any box warning against VWAP slope\")",
      pass: (x, i, d) => Number.isFinite(x.vw[i - 15]) && d * (x.vw[i] - x.vw[i - 15]) < 0 },
  ],
  // batch 52 (screen 2026, confirm 2025): more positioning
  52: [
    { name: "any warning with asset managers crowded long", kind: "filter", base: "potAny", why: "asset managers' net long in the top fifth of the year: real money fully invested, with no buyer left behind dips, so rallies stall and turns pay",
      pass: (x, i) => x.amCrowd[i] === 1 },
    { name: "any warning against leveraged funds' fresh flip", kind: "filter", base: "potAny", why: "in the week after trend followers flip their net side, they keep adding to the new side; a turn against that has their flow against it, so it fails",
      pass: (x, i, d) => x.levFlip[i] !== 0 && d === -x.levFlip[i] },
  ],
  // batch 48 (screen 2026, confirm 2025): Fed liquidity
  48: [
    { name: "any warning calling with net liquidity's month", kind: "filter", base: "potAny", why: "net liquidity (Fed balance sheet less Treasury cash less reverse repo) up $50bn+ over four weeks is cash looking for assets, which lifts equities; a turn calling long then (short after a $50bn drain) has that flow behind it",
      pass: (x, i, d) => Math.abs(x.liq4[i]) >= 50 && d === Math.sign(x.liq4[i]) },
    { name: "any warning while liquidity drains fast", kind: "filter", base: "potAny", why: "net liquidity down $100bn+ in four weeks tightens funding; de-risking overshoots both ways intraday, so turns pay",
      pass: (x, i) => x.liq4[i] <= -100 },
  ],
  // batch 49 (screen 2026, confirm 2025): earnings timing
  49: [
    { name: "any warning the session before mega-cap earnings", kind: "filter", base: "potAny", why: "the day before a big report traders wait and option dealers hedge a pinned market: little follow-through, so turns pay",
      pass: (x, i) => x.preEarn[i] === 1 },
    { name: "any warning in earnings season", kind: "filter", base: "potAny", why: "within 10 days after a mega-cap report the index keeps repricing on fresh numbers: moves carry, turns fail",
      pass: (x, i) => x.season[i] === 1 },
  ],
  // batch 50 (screen 2026, confirm 2025): positioning shifts
  50: [
    { name: "any warning after open interest jumped", kind: "filter", base: "potAny", why: "NQ open interest up 5%+ in the last weekly report: new positions being built behind a trend, so turns fail",
      pass: (x, i) => x.oiChg[i] >= 5 },
    { name: "any warning with dealers crowded short", kind: "filter", base: "potAny", why: "dealers' net NQ position in the bottom fifth of the year means they are short futures against client longs (ETF and options flow); their hedging buys dips and sells rips, so turns pay",
      pass: (x, i) => x.dealerShort[i] === 1 },
  ],
  // batch 44: batch 43's idea with a cut that occurs. The box warns about every 4.6 minutes in RTH; if the
  // gaps were random, 10 minutes would be about their 90th percentile. Chosen from that, not from results.
  44: [
    { name: "the box's first warning in 10 minutes", kind: "filter", base: "potAny", why: "as batch 43: a box quiet for about its longest usual gap, then a warning, is a clean trend's first easing",
      pass: (x, i) => { for (let k = i - 10; k < i; k++) if (BASES.potAny(x, k)) return false; return true; } },
  ],
  // batch 29 (screen 2026, confirm 2024: 2025's halves were seen for these filters): the balance filters
  // worked in 2026 and 2025 Jan-Jun and failed in 2025 Jul-Dec, VXN's quietest half. Do they need a
  // volatile market? The finding would be the high-VXN rows; the low-VXN rows are read beside them.
  29: [
    { name: "toward the IB midpoint, VXN 21+", kind: "filter", base: "potVxnHigh", why: "in a volatile market, swings overshoot and come back to the day's balance; in a quiet grind they do not", pass: (x, i, d) => { const m = (x.ibH[i] + x.ibL[i]) / 2; return minuteOfSession(x, i) > 60 && Number.isFinite(m) && d * (m - x.C[i]) > 0; } },
    { name: "toward the IB midpoint, VXN under 21", kind: "filter", base: "potVxnLow", why: "the other side of the split", pass: (x, i, d) => { const m = (x.ibH[i] + x.ibL[i]) / 2; return minuteOfSession(x, i) > 60 && Number.isFinite(m) && d * (m - x.C[i]) > 0; } },
    { name: "toward the session VWAP, VXN 21+", kind: "filter", base: "potVxnHigh", why: "the same with the session VWAP", pass: (x, i, d) => Number.isFinite(x.vws[i]) && d * (x.vws[i] - x.C[i]) > 0 },
    { name: "toward the session VWAP, VXN under 21", kind: "filter", base: "potVxnLow", why: "the other side of the split", pass: (x, i, d) => Number.isFinite(x.vws[i]) && d * (x.vws[i] - x.C[i]) > 0 },
  ],
  // batch 28 (independence checks, written before the 2025 runs): does a balance filter hold inside each
  // side of confirmed #2's split? A finding counts as new only if it holds in both.
  28: [
    { name: "toward the session VWAP, warnings with VWAP's slope", kind: "filter", base: "potSlopeWith", why: "independence from #2", pass: (x, i, d) => Number.isFinite(x.vws[i]) && d * (x.vws[i] - x.C[i]) > 0 },
    { name: "toward the session VWAP, warnings against VWAP's slope", kind: "filter", base: "potSlopeAgainst", why: "independence from #2", pass: (x, i, d) => Number.isFinite(x.vws[i]) && d * (x.vws[i] - x.C[i]) > 0 },
    { name: "toward the IB midpoint, warnings with VWAP's slope", kind: "filter", base: "potSlopeWith", why: "independence from #2", pass: (x, i, d) => { const m = (x.ibH[i] + x.ibL[i]) / 2; return minuteOfSession(x, i) > 60 && Number.isFinite(m) && d * (m - x.C[i]) > 0; } },
    { name: "toward the IB midpoint, warnings against VWAP's slope", kind: "filter", base: "potSlopeAgainst", why: "independence from #2", pass: (x, i, d) => { const m = (x.ibH[i] + x.ibL[i]) / 2; return minuteOfSession(x, i) > 60 && Number.isFinite(m) && d * (m - x.C[i]) > 0; } },
  ],
};
NEAR = [[35, "any warning at the hour's range edge, calling inside"], [36, "any warning with volume rising over the hour"], [27, "any warning on an inside bar"], [22, "any warning the day after a wide day"]]
  .map(([b, n]) => { const f = BATCHES[b].find((d) => d.name === n); if (!f) throw new Error(`near miss not found: ${n}`); return f.pass; });
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

const real = Lab.loadSample({ file: FILE, from: FROM, to: TO });
if (FROM_ARG) {   // the forward test's halves: split at the middle of the bars it has
  let lo = Infinity, hi = -Infinity; for (const t of real.b.ts) if (t >= FROM && t < TO) { lo = Math.min(lo, t); hi = Math.max(hi, t); }
  if (!(hi > lo)) throw new Error(`no bars from ${FROM_ARG}${TO_ARG ? " to " + TO_ARG : ""} in ${FILE}: pull and rebuild first (npm run data:pull, npm run data:build)`);
  H2 = (lo + hi) / 2;
  process.stderr.write(`  ${OTHER ? FILE + " bars" : "forward bars"}: ${new Date(lo).toISOString().slice(0, 16)} to ${new Date(hi).toISOString().slice(0, 16)} UTC, halves split ${new Date(H2).toISOString().slice(0, 10)}
`);
}
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
console.log(`batch ${BATCH}, ${OTHER ? FILE + " " : ""}${FROM_ARG ? `${OTHER ? "from" : "forward from"} ${FROM_ARG}${TO_ARG ? " to " + TO_ARG : ""}` : YEAR + (YEAR === 2026 ? " (to Oct 30)" : "")}, ${PLACEBOS} placebo markets; ${secs()}s`);
console.log(`edge: points of win rate over every minute the same way (signals) or over the box signal without the filter (filters). "hi"/"lo": placebo markets as high / as low`);
for (let r = 0; r < 2; r++) {
  console.log(`\n${r ? "37" : "18"}-point race${r ? " (beside it)" : " (the one judged)"}`);
  console.log(`${"idea".padEnd(36)}${"kind".padEnd(8)}${"n".padStart(7)}${"win".padStart(7)}${"edge".padStart(7)}${"hi".padStart(5)}${"lo".padStart(5)}${"H1".padStart(8)}${"hi".padStart(5)}${"lo".padStart(5)}${"H2".padStart(8)}${"hi".padStart(5)}${"lo".padStart(5)}`);
  R.forEach((o, k) => {
    const idea = IDEAS[k], hi = cnt(k, `edge${r}`, true), lo = cnt(k, `edge${r}`, false), h1 = cnt(k, `edge${r}h0`, true), l1 = cnt(k, `edge${r}h0`, false), h2 = cnt(k, `edge${r}h1`, true), l2 = cnt(k, `edge${r}h1`, false);
    let v = "";
    if (r === 0) {
      const mn = idea.minN || 100, enough = o.n0h0 >= mn && o.n0h1 >= mn;
      if (FROM_ARG && !OTHER && idea.expect) {   // the forward test's rule, written before it runs (ledger, "Forward test")
        const beats = idea.expect === "helps" ? 100 - hi : 100 - lo, right = idea.expect === "helps" ? o.edge0 > 0 : o.edge0 < 0;
        v = !enough ? "FORWARD: too few warnings yet" : right && beats >= 90 ? "FORWARD: holds" : !right || beats < 50 ? "FORWARD: kill" : "FORWARD: undecided";
      } else if (!OTHER && (YEAR === 2026 || !ONLY)) { if (enough && h1 <= 10 && h2 <= 10) v = "SCREEN PASS (helps)"; else if (enough && l1 <= 10 && l2 <= 10) v = "SCREEN PASS (hurts: the reverse helps)"; }
      else { v = hi <= 5 ? "CONFIRMED (helps)" : lo <= 5 ? "CONFIRMED (hurts)" : "not confirmed"; }
      verdicts.push({ name: idea.name, kind: idea.kind, verdict: v || "fails the screen", edge: o.edge0, hi, lo, h1, l1, h2, l2, n: o.n0 });
    }
    console.log(`${idea.name.padEnd(36)}${idea.kind.padEnd(8)}${String(o[`n${r}`]).padStart(7)}${pc(o[`win${r}`]).padStart(7)}${sg(o[`edge${r}`]).padStart(7)}${String(hi).padStart(5)}${String(lo).padStart(5)}${sg(o[`edge${r}h0`]).padStart(8)}${String(h1).padStart(5)}${String(l1).padStart(5)}${sg(o[`edge${r}h1`]).padStart(8)}${String(h2).padStart(5)}${String(l2).padStart(5)}${v ? "  " + v : ""}`);
  });
}
console.log(`\n(${secs()}s)`);
const tag = OTHER ? `b${BATCH}_${FILE.replace(/^.*\//, "").replace(/\.bin$/, "")}_${FROM_ARG || YEAR}` : FROM_ARG ? `b${BATCH}_fwd_${FROM_ARG}` : `b${BATCH}_${YEAR}${ONLY ? "_confirm" : ""}`;
fs.writeFileSync(`research/idea_lab_${tag}_results.json`, JSON.stringify({ run: new Date().toISOString(), batch: BATCH, year: YEAR, only: ONLY, placebos: PLACEBOS,
  ideas: IDEAS.map((d) => ({ name: d.name, kind: d.kind, base: d.base || null, why: d.why })), real: R, verdicts, placebo: pl }, null, 1));
