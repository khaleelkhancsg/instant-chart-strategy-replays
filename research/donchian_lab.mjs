// The donchian_1250 idea loop: batches of rules that refuse some of the book's trades, each judged against the same
// book on 100 placebo markets, with 2025-2026 weighted first. Ledger: research/donchian_ledger.md.
//
//   node --max-old-space-size=16384 research/donchian_lab.mjs --batch 1 [--placebos 100]
//
// The person (2026-11-26): "do batch research with the donchian, just like how you did with the databox". Written
// before any batch ran:
// - The book: donchian_1250 as shipped, $1,250 settings, run by the lab's engine (runStrategy) over
//   data/mnq_1m_beta.bin (2019-05 to 2026-10-30), once on the real market and once on each placebo market (lib_levels
//   placeboBars, seeds 9100 + p: every bar's move flipped at random, its range kept; the book trades them about as
//   often as the real market, research/donchian_audit.mjs).
// - An idea is a rule on what the market showed when the trade's signal bar closed (the last 1-minute bar of the
//   2-minute signal bar, never later): keep the trade or refuse it. Each idea states who is on the other side.
// - A trade's result in ATR units: its P&L per contract over (2-minute ATR x $2), so years and markets compare.
//   An idea's lift in a period: the mean result of the trades it keeps less that of the trades it refuses.
// - Periods by entry: 2025 H1, 2025 H2, 2026 Jan-Mar, 2026 Apr 1 - Jul 14 (the screen: the person weights 2025-2026
//   first); forward Jul 15 - Oct 30 and 2019-2024 (the confirmation: no idea or the book's own tuning saw them;
//   2019-2024 did see the original breakout's choice, not these rules).
// - SCREEN PASS: the lift pooled over 2025 and 2026 beats 90 of 100 placebo markets, and is positive in 2025 and in
//   2026 separately, and the rule keeps at least 30% of the trades.
// - CONFIRMED (the person's 10% bar): a screen pass whose lift on 2019-2024 beats 90 of 100 placebo markets and is
//   positive forward (the forward bars hold about 70 trades: too few to require more; their placebo count is shown).
//   From batch 9 on (the person's choice, 2026-11-26, after batch 8): RECENCY-WEIGHTED. A screen pass is CONFIRMED when
//   its forward lift beats 90 of 100 placebo markets with 20 or more forward trades kept, and 2019-2024 does not go the
//   other way (its lift beats at least 10 of 100). Batches 1-8 keep the rule they ran under.
// - A confirmed rule then gets a full engine run (the refused trade changes what follows: flips, day blocks) for its
//   pass rate on live equity against the shipped book, 2025, 2026 and forward. Only that decides whether it ships.
// - Count every idea. A rule written after seeing a result is a lead.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { resample } from "../src/resample.mjs";
import { atr, rsi } from "../src/indicators.mjs";
import { RED_FOLDER } from "../src/news_calendar.mjs";
import { configOf } from "./lib_eval1250.mjs";
import { placeboBars, studyLines } from "./lib_levels.mjs";

const args = process.argv.slice(2), arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BATCH = Number(arg("--batch", 1)), PLACEBOS = Number(arg("--placebos", 100));
const D = (s) => Date.parse(s + "T00:00:00Z"), DAY = 86400000, MIN = 60000;
const PERIODS = [["2019-2024", "2019-01-01", "2025-01-01"], ["2025 H1", "2025-01-01", "2025-07-01"], ["2025 H2", "2025-07-01", "2026-01-01"],
  ["2026 Jan-Mar", "2026-01-01", "2026-04-01"], ["2026 Apr-Jul14", "2026-04-01", "2026-07-15"], ["forward", "2026-07-15", "2026-11-01"]].map(([l, a, b]) => ({ l, a: D(a), b: D(b) }));
const SCREEN = [1, 2, 3, 4], Y25 = [1, 2], Y26 = [3, 4], CONF = 0, FWD = 5;
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

// ── outside data: the VXN close dated before each session ──
const VXN = (() => { const m = new Map(); for (const line of fs.readFileSync("data/raw/fred/VXNCLS.csv", "utf8").split(/\r?\n/).slice(1)) { const [d, v] = line.split(","); if (d && v && v !== ".") m.set(d, Number(v)); } return m; })();
const vxnBefore = (() => { const keys = [...VXN.keys()].sort(); return (ms) => { const day = new Date(ms).toISOString().slice(0, 10); let lo = 0, hi = keys.length - 1, best = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (keys[mid] < day) { best = mid; lo = mid + 1; } else hi = mid - 1; } return best >= 0 ? VXN.get(keys[best]) : NaN; }; })();

// ── calendars: options-expiry Fridays, mega-cap earnings sessions, red-folder release times ──
const EXPIRY = new Set(fs.readFileSync("data/raw/events/index_days.csv", "utf8").split(/\r?\n/).slice(1).map((l) => l.split(",")[0]).filter(Boolean));
const EARN = new Set(fs.readFileSync("data/raw/events/earnings.csv", "utf8").split(/\r?\n/).slice(1).map((l) => l.split(",")[2]).filter(Boolean));
const NEWS = RED_FOLDER.map((r) => r[0]);
const dateOf = (td) => new Date(td * DAY).toISOString().slice(0, 10);
const newsWithin = (ms, before, after) => { let lo = 0, hi = NEWS.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (NEWS[m] < ms - before) lo = m + 1; else hi = m; } return NEWS[lo] >= ms - before && NEWS[lo] <= ms + after; };
const newsDays = new Set(NEWS.map((ms) => new Date(ms).toISOString().slice(0, 10)));

// ── daily outside series, each read from the last value dated before the session (FRED's release lag: yields 1 day,
// the dollar a week, credit 2 days; CFTC from its usable date) ──
function series(file, col = 1) {
  const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).slice(1).map((l) => l.split(",")).filter((r) => r[0] && r[col] && r[col] !== ".");
  return { d: rows.map((r) => r[0]), v: rows.map((r) => Number(r[col])) };
}
const at = (S, day, lagDays = 0, back = 0) => {   // the value `back` observations before the last one dated before day - lag
  const cut = new Date(Date.parse(day) - lagDays * DAY).toISOString().slice(0, 10);
  let lo = 0, hi = S.d.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (S.d[m] < cut) { k = m; lo = m + 1; } else hi = m - 1; }
  return k - back >= 0 ? S.v[k - back] : NaN;
};
const Y10 = series("data/raw/fred/DGS10.csv"), USD = series("data/raw/fred/DTWEXBGS.csv"), HY = series("data/raw/fred/BAMLH0A0HYM2.csv");
const VIXs = series("data/raw/fred/VIXCLS.csv"), VXV = series("data/raw/fred/VXVCLS.csv"), VXNs = series("data/raw/fred/VXNCLS.csv");
const COT = (() => { const rows = fs.readFileSync("data/raw/events/cot_nq.csv", "utf8").split(/\r?\n/).slice(1).map((l) => l.split(",")).filter((r) => r[1]);
  return { d: rows.map((r) => r[1]), v: rows.map((r) => Number(r[7]) - Number(r[8])) }; })();   // leveraged funds' net, by its usable date
const macro = new Map();
function macroOf(td) {
  if (macro.has(td)) return macro.get(td);
  const day = dateOf(td), m = {
    y10chg: at(Y10, day, 1) - at(Y10, day, 1, 1), usd5: at(USD, day, 7) - at(USD, day, 7, 1), hy5: at(HY, day, 2) - at(HY, day, 2, 5),
    vixVxv: at(VIXs, day) / at(VXV, day), vxn5: at(VXNs, day) - at(VXNs, day, 0, 5), vxnVix: at(VXNs, day) / at(VIXs, day),
    levNet: at(COT, day, -1), levNetPrev: at(COT, day, -1, 1),
  };
  macro.set(td, m); return m;
}

// ── the box's readings (the indicator's arithmetic, as databox_lengths.mjs) ──
function emaSeries(x, n) { const N = x.length, v = new Float64Array(N); let c = 0, t = 0, p = NaN; for (let i = 0; i < N; i++) { if (c < n) { c++; t += x[i]; p = t / c; } else { c++; p = p + (2 / (n + 1)) * (x[i] - p); } v[i] = p; } return v; }
function warnState(close, f, s, rule) {
  const x = Float64Array.from(close), a = emaSeries(x, f), b = emaSeries(x, s), N = x.length, w = new Int8Array(N);
  let ps = 0, pd = NaN, pm = NaN, has = false;
  for (let i = 0; i < N; i++) {
    const diff = a[i] - b[i], sd = diff > 0 ? 1 : diff < 0 ? -1 : has ? ps : 0, mv = has ? diff - pd : NaN;
    let z = 0;
    if (has && sd && Number.isFinite(pm)) z = rule === "slowing" ? (sd === 1 ? (mv < pm ? -1 : 0) : mv > pm ? 1 : 0) : sd === 1 ? (mv < 0 && mv < pm ? -1 : 0) : mv > 0 && mv > pm ? 1 : 0;
    if (i >= s) w[i] = z;
    ps = sd; pd = diff; pm = mv; has = true;
  }
  return w;
}

// ── everything an idea may read, per 1-minute bar, from bars up to and including it ──
function context(b) {
  const N = b.close.length, TS = b.ts, O = b.open, H = b.high, L = b.low, C = b.close, V = b.volume, TD = b.tday, CT = b.ctMin;
  const x = { N, TS, O, H, L, C, V, TD, CT };
  { const v = studyLines({ b }, "vwap", 1, { anchor: "rth", bands: 1 }); x.vw = v.VWAP; x.vwUp = v["+1σ"]; x.vwDn = v["−1σ"]; }
  x.ema21 = emaSeries(Float64Array.from(C), 21);
  { const f = emaSeries(Float64Array.from(C), 12), sl = emaSeries(Float64Array.from(C), 26), line = new Float64Array(N); for (let i = 0; i < N; i++) line[i] = f[i] - sl[i]; const sg = emaSeries(line, 9); x.hist = new Float64Array(N); for (let i = 0; i < N; i++) x.hist[i] = line[i] - sg[i]; }
  x.a1 = atr(H, L, C, 14);
  x.fast = warnState(C, 3, 13, "slowing");   // #3, the box's fast row
  const b5 = resample(b, 5), w5 = warnState(b5.close, 12, 26, "speed"), a5 = atr(b5.high, b5.low, b5.close, 14);
  x.e5 = new Int8Array(N); x.A5 = new Float64Array(N).fill(NaN);
  for (let i = 0, k = -1; i < N; i++) { while (k + 1 < b5.ts.length && b5.ts[k + 1] + 5 * MIN <= TS[i] + MIN) k++; if (k >= 0) { x.e5[i] = w5[k]; x.A5[i] = a5[k]; } }
  // the session's RTH open, high and low so far; the prior RTH day's high, low, close; the overnight high and low;
  // the 10-session average RTH range; cumulative RTH volume against the last 10 sessions' at the same minute
  const F = (n) => new Float64Array(n).fill(NaN);
  Object.assign(x, { rOpen: F(N), dHi: F(N), dLo: F(N), pdH: F(N), pdL: F(N), pdC: F(N), onH: F(N), onL: F(N), adr: F(N), relVol: F(N), vxn: F(N), wd: new Int8Array(N), orH: F(N), orL: F(N), sma20: F(N), c5: F(N), h5: F(N), l5: F(N), pInside: new Int8Array(N), pNR7: new Int8Array(N), drive: new Int8Array(N), ibH: F(N), ibL: F(N), pdVW: F(N), streak: new Int8Array(N), wOpen: F(N), mOpen: F(N), h20: F(N), l20: F(N) });
  let wOpen = NaN, mOpen = NaN, wk = -1, mo = -1, hl20 = [];
  let ibHi = -Infinity, ibLo = Infinity, d15 = 0, lastVW = NaN, pdVW = NaN, cl3 = [];
  x.rsi = rsi(C, 14);
  { const b15 = resample(b, 15), e = emaSeries(Float64Array.from(b15.close), 20); x.e15 = new Float64Array(N).fill(NaN); for (let i = 0, k = -1; i < N; i++) { while (k + 1 < b15.ts.length && b15.ts[k + 1] + 15 * MIN <= TS[i] + MIN) k++; if (k >= 19) x.e15[i] = e[k]; } }
  let days = [];   // finished RTH sessions: { h, l, c }
  let orH = -Infinity, orL = Infinity, closes = [];
  let lastRthClose = NaN, td = -1, rOpen = NaN, hi = -Infinity, lo = Infinity, onH = -Infinity, onL = Infinity, last = null, cum = 0, cumArr = [], ranges = [], volHist = [];
  for (let i = 0; i < N; i++) {
    if (TD[i] !== td) {
      if (td >= 0 && hi > lo) { last = { h: hi, l: lo, c: lastRthClose }; ranges.push(hi - lo); if (ranges.length > 10) ranges.shift(); volHist.push(cumArr); if (volHist.length > 10) volHist.shift(); closes.push(lastRthClose); if (closes.length > 20) closes.shift(); days.push({ h: hi, l: lo, c: lastRthClose }); if (days.length > 7) days.shift(); hl20.push([hi, lo]); if (hl20.length > 20) hl20.shift(); }
      if (td >= 0) { pdVW = lastVW; cl3.push(lastRthClose); if (cl3.length > 4) cl3.shift(); }
      td = TD[i]; rOpen = NaN; hi = -Infinity; lo = Infinity; onH = -Infinity; onL = Infinity; cum = 0; cumArr = []; orH = -Infinity; orL = Infinity; ibHi = -Infinity; ibLo = Infinity; d15 = 0;
    }
    const ct = CT[i], rth = ct >= 510 && ct < 900;
    if (rth && !Number.isFinite(rOpen)) { const d = new Date(TD[i] * DAY), w = Math.floor((TD[i] + 3) / 7), m = d.getUTCFullYear() * 12 + d.getUTCMonth(); if (w !== wk) { wk = w; wOpen = O[i]; } if (m !== mo) { mo = m; mOpen = O[i]; } }
    if (rth) { if (!Number.isFinite(rOpen)) rOpen = O[i]; hi = Math.max(hi, H[i]); lo = Math.min(lo, L[i]); cum += V[i]; cumArr[ct - 510] = cum; lastRthClose = C[i]; if (ct < 540) { orH = Math.max(orH, H[i]); orL = Math.min(orL, L[i]); } if (ct < 570) { ibHi = Math.max(ibHi, H[i]); ibLo = Math.min(ibLo, L[i]); } if (ct === 524) d15 = Math.sign(C[i] - rOpen); if (Number.isFinite(x.vw[i])) lastVW = x.vw[i]; }
    else if (!Number.isFinite(rOpen)) { onH = Math.max(onH, H[i]); onL = Math.min(onL, L[i]); }
    x.rOpen[i] = rOpen; if (rth) { x.dHi[i] = hi; x.dLo[i] = lo; }
    if (last) { x.pdH[i] = last.h; x.pdL[i] = last.l; x.pdC[i] = last.c; }
    if (onH > onL) { x.onH[i] = onH; x.onL[i] = onL; }
    if (ranges.length === 10) x.adr[i] = ranges.reduce((a, z) => a + z, 0) / 10;
    if (ct >= 540 && orH > orL) { x.orH[i] = orH; x.orL[i] = orL; }   // the opening 30 minutes, known from 09:00
    if (closes.length === 20) x.sma20[i] = closes.reduce((a, z) => a + z, 0) / 20;
    if (ct >= 525) x.drive[i] = d15;
    if (ct >= 570 && ibHi > ibLo) { x.ibH[i] = ibHi; x.ibL[i] = ibLo; }
    x.pdVW[i] = pdVW; x.wOpen[i] = wOpen; x.mOpen[i] = mOpen;
    if (hl20.length === 20) { x.h20[i] = Math.max(...hl20.map((z) => z[0])); x.l20[i] = Math.min(...hl20.map((z) => z[1])); }
    if (cl3.length === 4) { const a = Math.sign(cl3[1] - cl3[0]), b2 = Math.sign(cl3[2] - cl3[1]), c3 = Math.sign(cl3[3] - cl3[2]); x.streak[i] = a === b2 && b2 === c3 ? a : 0; }
    if (days.length === 7) {
      const L5 = days.slice(-5), y = days[6], yy = days[5];
      x.c5[i] = days[1].c; x.h5[i] = Math.max(...L5.map((d) => d.h)); x.l5[i] = Math.min(...L5.map((d) => d.l));
      x.pInside[i] = y.h <= yy.h && y.l >= yy.l ? 1 : 0;
      x.pNR7[i] = days.every((d) => d === y || y.h - y.l < d.h - d.l) ? 1 : 0;
    }
    if (rth && volHist.length === 10) { let s = 0, n = 0; for (const h of volHist) { const v = h[ct - 510]; if (v > 0) { s += v; n++; } } if (n >= 5) x.relVol[i] = cum / (s / n); }
    x.wd[i] = new Date(TS[i]).getUTCDay();
  }
  return x;
}

// ── the ideas: keep(x, j, t) with j the signal's last 1-minute bar and t the trade (dir, contracts, earlier trades) ──
const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0), closeCt = (x, j) => (x.CT[j] + 1) % 1440;
const BATCHES = {
  1: [
    { name: "with VWAP: long above, short below", why: "a breakout on the side of the day's average price has the session's buyers (sellers) in profit behind it; across VWAP it runs into the other side's average", keep: (x, j, t) => Number.isFinite(x.vw[j]) && t.dir * (x.C[j] - x.vw[j]) > 0 },
    { name: "VWAP's 15-minute slope agrees", why: "the volume-weighted flow already leans the breakout's way; against it, the break is into flow", keep: (x, j, t) => Number.isFinite(x.vw[j - 15]) && t.dir * (x.vw[j] - x.vw[j - 15]) > 0 },
    { name: "not stretched: within 2 five-minute ATRs of VWAP", why: "far from VWAP the breakout is late; mean-reverting liquidity providers lean against it", keep: (x, j) => Number.isFinite(x.vw[j]) && Math.abs(x.C[j] - x.vw[j]) < 2 * x.A5[j] },
    { name: "the day has used under 75% of its average range", why: "room to run: a breakout late in a full day has the day's range against it (the book halves size at 0.9)", keep: (x, j) => Number.isFinite(x.adr[j]) && x.dHi[j] - x.dLo[j] < 0.75 * x.adr[j] },
    { name: "beyond the prior day's high (long) / low (short)", why: "a break of yesterday's extreme triggers the stops and breakout orders resting there: forced flow its way", keep: (x, j, t) => Number.isFinite(x.pdH[j]) && (t.dir === 1 ? x.C[j] > x.pdH[j] : x.C[j] < x.pdL[j]) },
    { name: "not at lunch (11:30-13:00 CT)", why: "lunch is thin; breakouts then lack the participation to follow through", keep: (x, j) => { const c = closeCt(x, j); return c < 690 || c >= 780; } },
    { name: "the fast row (3/13) not warning against it", why: "confirmed #3: a fast-row warning calls a turn; a breakout into one starts as the move fades", keep: (x, j, t) => x.fast[j] !== -t.dir },
    { name: "volume above the last 10 sessions' at this minute", why: "a breakout on heavy participation is real buying (selling); on light volume it is a few orders", keep: (x, j) => x.relVol[j] > 1 },
    { name: "VXN above its 60-session median", why: "in volatile markets dealers are shorter gamma and hedge with the move, so breakouts extend", keep: (x, j) => x.vxnHi[j] === 1 },
  ],
  2: [
    { name: "a wide signal bar (2-minute range >= 1.4 one-minute ATRs)", why: "a breakout on a wide bar is urgent buying (selling); a narrow one drifts through the level", keep: (x, j) => Math.max(x.H[j], x.H[j - 1]) - Math.min(x.L[j], x.L[j - 1]) >= x.a1[j] * 1.4 },
    { name: "no losing trade earlier today", why: "a failed breakout earlier says the day rotates; the next one meets the same sellers (buyers)", keep: (x, j, t) => !t.before.some((z) => z.pnl < 0) },
    { name: "beyond the 30-minute opening range", why: "the opening range is the day's first auction; a break beyond it has the open's losers' stops behind it", keep: (x, j, t) => Number.isFinite(x.orH[j]) && (t.dir === 1 ? x.C[j] > x.orH[j] : x.C[j] < x.orL[j]) },
    { name: "the opening gap points the trade's way", why: "an RTH open above yesterday's close (long) is overnight demand still being worked", keep: (x, j, t) => Number.isFinite(x.pdC[j]) && t.dir * (x.rOpen[j] - x.pdC[j]) > 0 },
    { name: "beyond the overnight high (long) / low (short)", why: "the overnight extremes hold the night's stops; breaking them brings that flow", keep: (x, j, t) => Number.isFinite(x.onH[j]) && (t.dir === 1 ? x.C[j] > x.onH[j] : x.C[j] < x.onL[j]) },
    { name: "a trend day: half an ADR from the open its way", why: "a day already half a normal range from its open the trade's way is a trend day; breakouts with it keep going", keep: (x, j, t) => Number.isFinite(x.adr[j]) && t.dir * (x.C[j] - x.rOpen[j]) >= 0.5 * x.adr[j] },
    { name: "the 5m EMA row not warning toward the trade", why: "confirmed #5: a 5m warning is a continuation sign, so one pointing toward the trade means the 5m trend against it continues", keep: (x, j, t) => x.e5[j] !== t.dir },
    { name: "volatility expanding: 5m ATR above an hour ago", why: "an expanding range is new information arriving; breakouts in it follow through, in contraction they fade", keep: (x, j) => x.A5[j] > x.A5[j - 60] },
  ],
  3: [
    { name: "with the 20-session average: long above, short below", why: "the daily trend's holders add on intraday breakouts its way and fade those against it", keep: (x, j, t) => Number.isFinite(x.sma20[j]) && t.dir * (x.C[j] - x.sma20[j]) > 0 },
    { name: "yesterday closed strong its way (top / bottom fifth)", why: "a close at the extreme carries overnight and next-day continuation from late buyers (sellers)", keep: (x, j, t) => { const r = x.pdH[j] - x.pdL[j]; if (!(r > 0)) return false; const pos = (x.pdC[j] - x.pdL[j]) / r; return t.dir === 1 ? pos >= 0.8 : pos <= 0.2; } },
    { name: "at a new session high (long) / low (short)", why: "a breakout to a new day extreme has no one trapped above (below) to sell (buy) into it", keep: (x, j, t) => (t.dir === 1 ? x.H[j] >= x.dHi[j] : x.L[j] <= x.dLo[j]) },
    { name: "through a round 100 in the last 10 minutes", why: "round numbers hold resting stops and options strikes; crossing one triggers them", keep: (x, j, t) => { for (let k = j - 10; k <= j; k++) { const a = Math.floor(x.C[k - 1] / 100), z = Math.floor(x.C[k] / 100); if (t.dir === 1 ? z > a : z < a) return true; } return false; } },
    { name: "the first two hours or the last two (not 10:30-13:00)", why: "breakouts need participation: the open and the afternoon hold most of it", keep: (x, j) => { const c = closeCt(x, j); return c < 630 || c >= 780; } },
    { name: "the day's range already 1 ADR or more", why: "a wide day is a trending day; its breakouts continue (the late-size rule assumes the opposite)", keep: (x, j) => Number.isFinite(x.adr[j]) && x.dHi[j] - x.dLo[j] >= x.adr[j] },
    { name: "price on the trade's side of the RTH open", why: "the day's open is its reference; a breakout on the winning side has the day's flow with it", keep: (x, j, t) => t.dir * (x.C[j] - x.rOpen[j]) > 0 },
    { name: "VXN at 25 or above", why: "in calm markets dealers are long gamma and pin; breakouts fail. Above 25 they run", keep: (x, j) => x.vxnNow[j] >= 25 },
  ],
  4: [
    { name: "the last hour moved its way by 2 five-minute ATRs", why: "momentum: an hour of one-way flow is an order being worked; the breakout is its next leg", keep: (x, j, t) => t.dir * (x.C[j] - x.C[j - 60]) >= 2 * x.A5[j] },
    { name: "the last 5 sessions closed up (long) / down (short)", why: "the week's trend's holders buy (sell) intraday breakouts its way", keep: (x, j, t) => Number.isFinite(x.c5[j]) && t.dir * (x.pdC[j] - x.c5[j]) > 0 },
    { name: "yesterday was an inside day", why: "compression before expansion: a day inside the one before leaves orders stacked at both edges", keep: (x, j) => x.pInside[j] === 1 },
    { name: "yesterday was the narrowest of 7 (NR7)", why: "the classic volatility-contraction setup: the narrowest day is followed by a range day", keep: (x, j) => x.pNR7[j] === 1 },
    { name: "beyond the last 5 sessions' high (long) / low (short)", why: "a break of the week's range triggers the week's stops and swing traders' entries", keep: (x, j, t) => Number.isFinite(x.h5[j]) && (t.dir === 1 ? x.C[j] > x.h5[j] : x.C[j] < x.l5[j]) },
    { name: "the signal bar closes in its top (long) / bottom (short) fifth", why: "conviction: buyers held the high into the close; a breakout bar that closes off its high is already being sold", keep: (x, j, t) => { const h = Math.max(x.H[j], x.H[j - 1]), l = Math.min(x.L[j], x.L[j - 1]), r = h - l; if (!(r > 0)) return false; const pos = (x.C[j] - l) / r; return t.dir === 1 ? pos >= 0.8 : pos <= 0.2; } },
    { name: "1m RSI not stretched (below 75 long / above 25 short)", why: "a breakout already overbought is the late buyers; the next push has no one left", keep: (x, j, t) => (t.dir === 1 ? x.rsi[j] < 75 : x.rsi[j] > 25) },
    { name: "the day's first breakout its way", why: "the first break of the day takes the overnight orders; later ones are repeats into a known level", keep: (x, j, t) => !t.before.some((z) => z.dir === t.dir) },
  ],
  5: [
    { name: "no red-folder release in the last 30 minutes", why: "after CPI / NFP / FOMC the first moves are repricing whipsaws, not trends", keep: (x, j) => !newsWithin(x.TS[j], 30 * MIN, 0) },
    { name: "not a red-folder release day", why: "release days are driven by one number; breakouts before it are positioning that gets unwound", keep: (x, j) => !newsDays.has(dateOf(x.TD[j])) },
    { name: "not a Monday", why: "Mondays open on the weekend's news and drift; breakouts lack follow-through", keep: (x, j) => x.wd[j] !== 1 },
    { name: "not a Friday", why: "Friday afternoons are squared for the weekend; breakouts are unwound", keep: (x, j) => x.wd[j] !== 5 },
    { name: "not an options-expiry Friday", why: "expiry pins price near big strikes; breakouts fail", keep: (x, j) => !EXPIRY.has(dateOf(x.TD[j])) },
    { name: "not the last two sessions of the month", why: "month-end rebalancing flows run against the month's trend and whipsaw intraday", keep: (x, j) => { const d = new Date(x.TD[j] * DAY), m = d.getUTCMonth(); let n = 0; for (let k = 1; k <= 4; k++) { const e = new Date(d.getTime() + k * DAY); if (e.getUTCMonth() !== m) break; if (e.getUTCDay() % 6 !== 0) n++; } return n >= 2; } },
    { name: "not the session before mega-cap earnings", why: "before a big report traders wait and dealers pin the index; breakouts fail", keep: (x, j) => { const d = new Date(x.TD[j] * DAY); for (let k = 1; k <= 3; k++) { const e = new Date(d.getTime() + k * DAY); if (e.getUTCDay() % 6 === 0) continue; return !EARN.has(e.toISOString().slice(0, 10)); } return true; } },
    { name: "a mega-cap earnings session", why: "a big report moves the index on news; breakouts that day are information, and they run", keep: (x, j) => EARN.has(dateOf(x.TD[j])) },
  ],
  6: [
    { name: "with yesterday's 10-year yield move (falling yields, long)", why: "falling yields lift long-duration tech; the day's flow leans long, rising yields short", keep: (x, j, t) => { const v = macroOf(x.TD[j]).y10chg; return Number.isFinite(v) && v !== 0 && t.dir * -v > 0; } },
    { name: "with the dollar's week (weaker dollar, long)", why: "a weaker dollar loosens conditions and lifts risk assets; the drift favours longs", keep: (x, j, t) => { const v = macroOf(x.TD[j]).usd5; return Number.isFinite(v) && v !== 0 && t.dir * -v > 0; } },
    { name: "with credit's week (spreads narrowing, long)", why: "narrowing high-yield spreads are risk appetite; equities follow credit", keep: (x, j, t) => { const v = macroOf(x.TD[j]).hy5; return Number.isFinite(v) && v !== 0 && t.dir * -v > 0; } },
    { name: "VIX below VIX3M (a calm curve)", why: "an inverted curve is panic: whipsaws both ways; breakouts need an orderly market", keep: (x, j) => macroOf(x.TD[j]).vixVxv < 1 },
    { name: "VXN up over the last 5 sessions", why: "rising fear makes dealers shorter gamma; they hedge with the move and breakouts extend", keep: (x, j) => macroOf(x.TD[j]).vxn5 > 0 },
    { name: "VXN high relative to VIX (above 1.25)", why: "tech-specific volatility: NQ moving on its own story trends harder than on the market's", keep: (x, j) => macroOf(x.TD[j]).vxnVix > 1.25 },
    { name: "with leveraged funds' net NQ position", why: "trend followers' positioning is the trend's fuel; breakouts its way have them adding", keep: (x, j, t) => { const v = macroOf(x.TD[j]).levNet; return Number.isFinite(v) && v !== 0 && t.dir * v > 0; } },
    { name: "with the change in leveraged funds' net", why: "funds adding to a side are actively buying (selling) through the week", keep: (x, j, t) => { const m = macroOf(x.TD[j]), v = m.levNet - m.levNetPrev; return Number.isFinite(v) && v !== 0 && t.dir * v > 0; } },
  ],
  7: [
    { name: "a narrow channel: the hour's range under 4 two-minute ATRs", why: "a breakout from compression releases orders stacked at both edges; a wide channel has spent the move", keep: (x, j) => { let h = -Infinity, l = Infinity; for (let k = j - 60; k < j - 1; k++) { h = Math.max(h, x.H[k]); l = Math.min(l, x.L[k]); } return h - l < 4 * 1.4 * x.a1[j]; } },
    { name: "a tested level: 3+ bars within 0.25 ATR of it in the last hour", why: "a level touched again and again collects stops behind it; breaking it releases them", keep: (x, j, t) => { let lvl = t.dir === 1 ? -Infinity : Infinity; for (let k = j - 60; k < j - 1; k++) lvl = t.dir === 1 ? Math.max(lvl, x.H[k]) : Math.min(lvl, x.L[k]); let n = 0; for (let k = j - 60; k < j - 1; k++) if (Math.abs((t.dir === 1 ? x.H[k] : x.L[k]) - lvl) <= 0.25 * 1.4 * x.a1[j]) n++; return n >= 3; } },
    { name: "a fresh push: price pulled back 1 ATR in the last hour", why: "a breakout after a reset has new buyers; one in a grinding trend is the last of them", keep: (x, j, t) => { let ext = t.dir === 1 ? -Infinity : Infinity, pb = 0; for (let k = j - 60; k < j; k++) { if (t.dir === 1) { ext = Math.max(ext, x.H[k]); pb = Math.max(pb, ext - x.L[k]); } else { ext = Math.min(ext, x.L[k]); pb = Math.max(pb, x.H[k] - ext); } } return pb >= 1.4 * x.a1[j]; } },
    { name: "breakout volume twice the last hour's average", why: "a level broken on heavy volume is absorbed supply; on light volume it is a few stops", keep: (x, j) => { let s = 0; for (let k = j - 61; k < j - 1; k++) s += x.V[k]; return x.V[j] + x.V[j - 1] >= 2 * 2 * (s / 60); } },
    { name: "the hour's efficiency ratio 0.3 or more", why: "an orderly trend (net move over path) breaks out cleanly; chop breaks out and back", keep: (x, j) => { let p = 0; for (let k = j - 59; k <= j; k++) p += Math.abs(x.C[k] - x.C[k - 1]); return p > 0 && Math.abs(x.C[j] - x.C[j - 60]) / p >= 0.3; } },
    { name: "not extended: under 1 ADR from the session's opposite extreme", why: "a breakout already a full day's range from the day's low (high) is late", keep: (x, j, t) => Number.isFinite(x.adr[j]) && (t.dir === 1 ? x.C[j] - x.dLo[j] : x.dHi[j] - x.C[j]) < x.adr[j] },
    { name: "no losing trade in the last 30 minutes", why: "a fresh failure says the market is rotating right now; the next break meets the same flow", keep: (x, j, t) => !t.before.some((z) => z.pnl < 0 && z.exit > x.TS[j] - 30 * MIN) },
    { name: "the 15-minute trend agrees (its EMA 20)", why: "a slower trend the breakout's way is the bigger flow behind it", keep: (x, j, t) => Number.isFinite(x.e15[j]) && t.dir * (x.C[j] - x.e15[j]) > 0 },
  ],
  8: [
    { name: "with the opening drive (the first 15 minutes' direction)", why: "the opening drive is the overnight imbalance being worked; it sets the day's side", keep: (x, j, t) => x.drive[j] === t.dir },
    { name: "after a narrow first hour (IB under half an ADR)", why: "a narrow initial balance leaves the day's range to come: a range-expansion day", keep: (x, j) => Number.isFinite(x.ibH[j]) && x.ibH[j] - x.ibL[j] < 0.5 * x.adr[j] },
    { name: "the first hour not broken the other way first", why: "a day that has already failed a break the other way is rotating, not trending", keep: (x, j, t) => { if (!Number.isFinite(x.ibH[j])) return true; for (let k = j - 1; k > j - 400 && x.TD[k] === x.TD[j] && x.CT[k] >= 570; k--) if (t.dir === 1 ? x.L[k] < x.ibL[j] : x.H[k] > x.ibH[j]) return false; return true; } },
    { name: "on the trade's side of yesterday's final VWAP", why: "yesterday's average price is where yesterday's holders break even; above it they are long and comfortable", keep: (x, j, t) => Number.isFinite(x.pdVW[j]) && t.dir * (x.C[j] - x.pdVW[j]) > 0 },
    { name: "on the trade's side of yesterday's midpoint", why: "the prior day's balance point; a breakout above it has yesterday's range below as support", keep: (x, j, t) => Number.isFinite(x.pdH[j]) && t.dir * (x.C[j] - (x.pdH[j] + x.pdL[j]) / 2) > 0 },
    { name: "a narrow overnight (under 0.4 ADR)", why: "a quiet night leaves orders unfilled; the cash session expands the range and breakouts run", keep: (x, j) => Number.isFinite(x.onH[j]) && x.onH[j] - x.onL[j] < 0.4 * x.adr[j] },
    { name: "with a 3-session close streak", why: "three closes the same way are a multi-day order being worked; intraday breakouts with it have it behind them", keep: (x, j, t) => x.streak[j] === t.dir },
    { name: "fewer than 2 losing trades earlier today", why: "two failed breakouts mark a range day; the third meets the same edges", keep: (x, j, t) => t.before.filter((z) => z.pnl < 0).length < 2 },
  ],
  9: [
    { name: "a strong signal bar: body 60% of its range or more", why: "a full-bodied bar is one side in control from open to close; a small body is indecision", keep: (x, j) => { const o = x.O[j - 1], h = Math.max(x.H[j], x.H[j - 1]), l = Math.min(x.L[j], x.L[j - 1]), r = h - l; return r > 0 && Math.abs(x.C[j] - o) >= 0.6 * r; } },
    { name: "the last 3 one-minute closes each its way", why: "consecutive closes are steady aggression, not one print through a level", keep: (x, j, t) => t.dir * (x.C[j] - x.C[j - 1]) > 0 && t.dir * (x.C[j - 1] - x.C[j - 2]) > 0 && t.dir * (x.C[j - 2] - x.C[j - 3]) > 0 },
    { name: "volume rising into the break (last 3 minutes over the 3 before)", why: "participation building as the level breaks is new money arriving", keep: (x, j) => x.V[j] + x.V[j - 1] + x.V[j - 2] > x.V[j - 3] + x.V[j - 4] + x.V[j - 5] },
    { name: "no rejection wick (the far wick under a quarter of the bar)", why: "a long wick at the breakout's end is the level's sellers (buyers) already answering", keep: (x, j, t) => { const h = Math.max(x.H[j], x.H[j - 1]), l = Math.min(x.L[j], x.L[j - 1]), r = h - l; return r > 0 && (t.dir === 1 ? h - x.C[j] : x.C[j] - l) < 0.25 * r; } },
    { name: "within 1 two-minute ATR of the 1m EMA 21", why: "a breakout far above its short average is stretched; the first pullback comes before the target", keep: (x, j) => Math.abs(x.C[j] - x.ema21[j]) < 1.4 * x.a1[j] },
    { name: "the 1m MACD histogram growing its way", why: "accelerating momentum: the push is gaining force at the break, not fading", keep: (x, j, t) => t.dir * (x.hist[j] - x.hist[j - 1]) > 0 && t.dir * x.hist[j] > 0 },
    { name: "the signal bar closes beyond the bar before's extreme", why: "follow-through: the break held to the close beyond the last bar, not a wick through it", keep: (x, j, t) => (t.dir === 1 ? x.C[j] > Math.max(x.H[j - 2], x.H[j - 3]) : x.C[j] < Math.min(x.L[j - 2], x.L[j - 3])) },
    { name: "the last closed 5-minute bar closed its way", why: "the slower bar agreeing shows the move is more than a 2-minute burst", keep: (x, j, t) => { const k5 = Math.floor((x.TS[j] + MIN) / (5 * MIN)) * 5 * MIN; let o = NaN, c = NaN; for (let k = j; k > j - 12; k--) { if (x.TS[k] < k5 - 5 * MIN) break; if (x.TS[k] < k5) { c = Number.isFinite(c) ? c : x.C[k]; o = x.O[k]; } } return Number.isFinite(o) && t.dir * (c - o) > 0; } },
  ],
  10: [
    { name: "room: the next round 100 ahead is 1 two-minute ATR away or more", why: "round numbers are magnets and resistance; a target past one fights it", keep: (x, j, t) => { const c = x.C[j], next = t.dir === 1 ? Math.ceil(c / 100) * 100 : Math.floor(c / 100) * 100; return Math.abs(next - c) >= 1.4 * x.a1[j]; } },
    { name: "on the trade's side of the overnight midpoint", why: "the night's balance point; a breakout away from it has the overnight inventory behind it", keep: (x, j, t) => Number.isFinite(x.onH[j]) && t.dir * (x.C[j] - (x.onH[j] + x.onL[j]) / 2) > 0 },
    { name: "on the trade's side of the week's open", why: "the week's open is the weekly traders' reference; above it they are net long", keep: (x, j, t) => Number.isFinite(x.wOpen[j]) && t.dir * (x.C[j] - x.wOpen[j]) > 0 },
    { name: "on the trade's side of the month's open", why: "the month's open is where monthly flows are measured; the month's winners add", keep: (x, j, t) => Number.isFinite(x.mOpen[j]) && t.dir * (x.C[j] - x.mOpen[j]) > 0 },
    { name: "inside the VWAP 1-sigma bands", why: "beyond a band the move is already extended against the day's distribution", keep: (x, j) => Number.isFinite(x.vwUp[j]) && x.C[j] <= x.vwUp[j] && x.C[j] >= x.vwDn[j] },
    { name: "beyond the VWAP 1-sigma band its way", why: "a break outside the day's normal range is the distribution shifting: a trend day", keep: (x, j, t) => Number.isFinite(x.vwUp[j]) && (t.dir === 1 ? x.C[j] > x.vwUp[j] : x.C[j] < x.vwDn[j]) },
    { name: "room to the 20-session high (long) / low (short): 1 ADR or more", why: "the month's extreme is resistance; a breakout well below it has room", keep: (x, j, t) => Number.isFinite(x.h20[j]) && (t.dir === 1 ? x.h20[j] - x.C[j] : x.C[j] - x.l20[j]) >= x.adr[j] },
    { name: "a new 20-session high (long) / low (short)", why: "a break to a new monthly extreme has no overhead supply and draws momentum funds", keep: (x, j, t) => Number.isFinite(x.h20[j]) && (t.dir === 1 ? x.C[j] > x.h20[j] : x.C[j] < x.l20[j]) },
  ],
};

function tradesOn(b, cfg) {
  const r = runStrategy(b, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies: cfg.studies });
  const out = r.trades.map((t) => ({ dir: t.dir, R: t.pnl / (t.contracts * 2 * t.atr), pnl: t.pnl, j: r.tf.srcLast[t.sigIdx], entry: t.entryTime, exit: t.exitTime, tday: t.tday, contracts: t.contracts }));
  // what each trade could know of the day's earlier trades: those closed before its signal bar closed
  const byDay = new Map();
  for (const t of out) { const a = byDay.get(t.tday) || []; t.before = a.filter((z) => z.exit <= b.ts[t.j] + MIN); a.push(t); byDay.set(t.tday, a); }
  return out;
}
function measure(b, cfg, ideas) {
  const x = context(b);
  // VXN's 60-session median, dated before the session
  x.vxnHi = new Int8Array(x.N); x.vxnNow = new Float64Array(x.N).fill(NaN); { let td = -1, v = NaN, hist = [], med = NaN; for (let i = 0; i < x.N; i++) { if (x.TD[i] !== td) { td = x.TD[i]; v = vxnBefore(x.TS[i]); if (Number.isFinite(v)) { const z = [...hist].sort((p, q) => p - q); med = z.length >= 60 ? z[z.length >> 1] : NaN; hist.push(v); if (hist.length > 60) hist.shift(); } } x.vxnHi[i] = Number.isFinite(med) && v > med ? 1 : 0; x.vxnNow[i] = v; } }
  const tr = tradesOn(b, cfg), P = PERIODS.length;
  return ideas.map((idea) => {
    const k = new Float64Array(P * 3), r = new Float64Array(P * 3);   // n, sum R, sum $
    for (const t of tr) {
      const p = PERIODS.findIndex((q) => t.entry >= q.a && t.entry < q.b);
      if (p < 0) continue;
      let ok = false; try { ok = !!idea.keep(x, t.j, t); } catch { ok = false; }
      const a = ok ? k : r; a[p * 3]++; a[p * 3 + 1] += t.R; a[p * 3 + 2] += t.pnl;
    }
    return { k: Array.from(k), r: Array.from(r) };
  });
}
const liftOf = (m, ps) => { let kn = 0, ks = 0, rn = 0, rs = 0; for (const p of ps) { kn += m.k[p * 3]; ks += m.k[p * 3 + 1]; rn += m.r[p * 3]; rs += m.r[p * 3 + 1]; } return { lift: kn && rn ? ks / kn - rs / rn : NaN, kept: kn / (kn + rn), kn }; };

const IDEAS = BATCHES[BATCH];
if (!IDEAS) throw new Error(`no batch ${BATCH}`);
const { bars } = loadBars("data/mnq_1m_beta.bin");
const cfg = await configOf("donchian_1250", {}, "1250");
const real = measure(bars, cfg, IDEAS);
process.stderr.write(`  batch ${BATCH}: real market ${secs()}s\n`);
const pl = [];
for (let p = 0; p < PLACEBOS; p++) { pl.push(measure(placeboBars(bars, 9100 + p), cfg, IDEAS)); if ((p + 1) % 10 === 0) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`); }

const pt = (v) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(3) : "—"), pc = (v) => (100 * v).toFixed(0) + "%";
const beats = (v, vals) => vals.filter((z) => Number.isFinite(z) && z < v).length;
console.log(`donchian_1250 idea loop, batch ${BATCH}; ${PLACEBOS} placebo markets; ${secs()}s`);
console.log(`lift = mean ATR-result of kept trades less refused ones; (n) = placebo markets beaten; kept = share of trades kept`);
console.log(`${"idea".padEnd(54)}${"2025+26".padStart(13)}${"2025".padStart(8)}${"2026".padStart(8)}${"kept".padStart(6)} |${"2019-24".padStart(13)}${"forward".padStart(13)}  verdict`);
const out = IDEAS.map((idea, q) => {
  const S = liftOf(real[q], SCREEN), A = liftOf(real[q], Y25), B = liftOf(real[q], Y26), C = liftOf(real[q], [CONF]), F = liftOf(real[q], [FWD]);
  const bS = beats(S.lift, pl.map((m) => liftOf(m[q], SCREEN).lift)), bC = beats(C.lift, pl.map((m) => liftOf(m[q], [CONF]).lift)), bF = beats(F.lift, pl.map((m) => liftOf(m[q], [FWD]).lift));
  const screen = bS >= 0.9 * PLACEBOS && A.lift > 0 && B.lift > 0 && S.kept >= 0.3;
  const conf = BATCH >= 9 ? screen && bF >= 0.9 * PLACEBOS && F.kn >= 20 && bC >= 0.1 * PLACEBOS : screen && bC >= 0.9 * PLACEBOS && F.lift > 0;
  const v = conf ? "CONFIRMED" : screen ? "screen pass, not confirmed" : "fails the screen";
  console.log(`${idea.name.padEnd(54)}${`${pt(S.lift)} (${bS})`.padStart(13)}${pt(A.lift).padStart(8)}${pt(B.lift).padStart(8)}${pc(S.kept).padStart(6)} |${`${pt(C.lift)} (${bC})`.padStart(13)}${`${pt(F.lift)} (${bF})`.padStart(13)}  ${v}`);
  return { name: idea.name, why: idea.why, screen: S, y2025: A, y2026: B, conf: C, fwd: F, beats: { screen: bS, conf: bC, fwd: bF }, verdict: v };
});
fs.writeFileSync(`research/donchian_lab_b${BATCH}_results.json`, JSON.stringify({ run: new Date().toISOString(), batch: BATCH, placebos: PLACEBOS, ideas: out, real, placebo: pl }));
console.log(`\n(${secs()}s) wrote research/donchian_lab_b${BATCH}_results.json`);
