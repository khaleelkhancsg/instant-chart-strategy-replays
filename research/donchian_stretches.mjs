// Why the Donchian books' 30-day windows pass and fail in long stretches, and
// what the market was doing in each. 2026 only (the house rule): the lab's
// bars to 2026-07-14, and the TopstepX bars from 2026-09-10 as a later block.
//
//   node --max-old-space-size=8192 research/donchian_stretches.mjs [--json out.json]
//
// Four questions, each answered from the books' own trades through src/ (the
// chart's engine, window grid and rules), never a second implementation:
//   1. MECHANICS  how much of the clustering the windows' overlap explains: a
//                 run of starts shares the days that decide it. Against a null
//                 that shuffles the order of the trading days, the real
//                 sequence's runs are compared, along with whether the bad days
//                 themselves cluster.
//   2. DECISIVE DAYS  the days the windows actually resolve on, and what the
//                 book and the market did on them.
//   3. PHASES     each trading day is scored by the share of the windows alive
//                 on it that went on to fail; fail-regime days (>= 75%) are
//                 compared with pass-regime days (<= 25%) on the market's
//                 structure -- volatility, gaps, trend, chop -- on how the
//                 book's breakouts behaved, and on every raw 30-bar breakout,
//                 traded or not.
//   4. INDICATORS the chart's 23 studies read at each 2026 signal, oriented to
//                 the trade's side, by regime and by win / loss, in both halves
//                 of 2026.
//   5. FORESIGHT  whether a rule a person could follow live, built from what
//                 the fail stretches looked like, would have avoided them.
//
// RESULT (2026; calendar windows, the chart's sweep):
//   MECHANICS  donchian_1250 ($1,250) runs P x64, F x35, P x55, with a few stray
//     fails in March. All 35 (starts Mar 17 - Apr 20) breached on 4 days, 94% on
//     two: Apr 21 (20) and Mar 31 (13), each a single -$600 trade at the
//     platform's line. A window shares 29 of its 30 days with the next, so every
//     window still short of the target on such a day fails on it. Beyond that:
//     the same 137 days in random order give ~12 pass / not-pass runs, the real
//     order 6 (6% of shuffles), and 7 of the 17 cap losses fell in Mar 30 - Apr 23
//     (a bunch random order makes 10% of the time). The one extra trade the 15:06
//     flat allows (Feb 5, 15:04 CT) took that from 4 runs (1%) to 6 (6%), so treat
//     the bunching as weak evidence. donchian_shipped ($3,000):
//     its runs are what random order gives, and back-to-back cap losses are
//     RARER than chance (10 against 16).
//   WHAT DIFFERED  fail-regime days against pass-regime days:
//     - not the breakouts: raw 30-bar breakouts reached +1.75 ATR before -3 ATR
//       as often or more (71 vs 62%, 67 vs 59%);
//     - the cap: losses at the platform line 2-5x as often (7.5 vs 1.6 per 20
//       days; 9.7 vs 3.9), and most losers (67%, 55%) saw price go 1.75 ATR
//       their way later that day (27%, 18% in pass stretches): right, early;
//     - the first hour flips from the best trades (81-82% won) to the worst
//       (20%, 35%); breakouts against the 10-day move collapse (0 of 3, 36%
//       won; 69-74% in pass stretches);
//     - the market, where a 90% day-bootstrap interval excludes zero: the
//       $1,250 fail phase sat in a stronger 10-day trend (efficiency 0.57 vs
//       0.21; the $3,000 book's 0.31 vs 0.19 only reaches zero); the $3,000 book's are wider than their recent
//       average (range 1.06 vs 0.89 ADR, overnight 0.94 vs 0.70, first hour
//       0.64 vs 0.53) but the $1,250 phase's first hours were NARROWER (0.47 vs
//       0.62). ATR, gaps, intraday efficiency, 2-min autocorrelation and the
//       share of bars the gates pass: no difference. In June 2026 the $3,000
//       book met 2-min ATRs of 50-95 points, putting its $1,000 line (62.5
//       points at 8 lots) under one ATR away.
//   INDICATORS  barely differ by regime (largest: the $1,250 fail phase's trades
//     at lower ATR, 20.4 vs 27.1, ATR ratio 0.76 vs 1.09; the $3,000 fail
//     trades later in the day's range, ADR used 0.75 vs 0.56). None tells
//     winners from losers in both halves; the efficiency ratio leans right in
//     both, weakly (AUC 0.53-0.66).
//   FORESIGHT  skipping or halving first-hour entries after a wide night
//     (0.8-1.2 ADR) improves no book in both halves by both methods; skipping
//     every first-hour entry takes the $1,250 book from 74.5% to 40.6%. The
//     TopstepX block (Sep 10 - Oct 26, every window passed) was trending
//     (0.34) with wide nights (1.05 ADR) too. The fail stretches are visible
//     afterwards and not, by these measures, beforehand.

import fs from "node:fs";
import * as E from "./lib_eval1250.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";
import { resample, indexAtOrBefore } from "../src/resample.mjs";
import { atr, adx, efficiencyRatio, donchian } from "../src/indicators.mjs";
import { evalDays, mulberry32 } from "../src/dayeval.mjs";
import { STUDIES, resolveStudy, studyOnSignal, studyLabel } from "../src/studies.mjs";
import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";

const L = E.lab, DAY = 86400000, Y26 = E.Y26, APR = E.APR;
const FWD_FILE = "data/topstepx_1m.bin", FWD_FROM = Date.UTC(2026, 8, 10);
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
const BOOKS = [
  { id: "donchian_1250", ev: "1250", label: "donchian_1250, $1,250 eval" },
  { id: "donchian_shipped", ev: "3000", label: "donchian_shipped, $3,000 eval" },
];
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null), r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dayOf = (td) => L.isoDay(td * DAY);
const hr = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// ── the market, one RTH session at a time, on the books' 2-minute bars ──
// Every measure is of the session itself (08:30-15:00 CT) or of what led into it.
function marketDays(bars1m, fromMs) {
  const b = resample(bars1m, 2), n = b.close.length, { open: O, high: H, low: Lo, close: C, ctMin: CT, tday: TD, ts: TS } = b;
  const a = atr(H, Lo, C, 14), ax = adx(H, Lo, C, 14).adx, er = efficiencyRatio(C, 20), dc = donchian(H, Lo, 30);
  const i0 = Math.max(0, indexAtOrBefore(TS, fromMs - 40 * DAY));
  const days = new Map(), order = [];
  for (let i = i0; i < n; i++) {
    let d = days.get(TD[i]);
    if (!d) { d = { td: TD[i], on: [Infinity, -Infinity], rth: null, bars: [] }; days.set(TD[i], d); order.push(d); }
    if (CT[i] >= 510 && CT[i] < 900) d.bars.push(i);
    else if (!d.bars.length) { d.on[0] = Math.min(d.on[0], Lo[i]); d.on[1] = Math.max(d.on[1], H[i]); }   // the night before the open
  }
  const out = [];
  for (const d of order) {
    if (d.bars.length < 30) continue;
    const ix = d.bars, f = ix[0], l = ix[ix.length - 1];
    let hi = -Infinity, lo = Infinity, path = 0, atrS = 0, adxOn = 0, erOn = 0, r = [];
    for (const i of ix) { hi = Math.max(hi, H[i]); lo = Math.min(lo, Lo[i]); atrS += a[i]; if (ax[i] >= 25) adxOn++; if (er[i] >= 0.5) erOn++; }
    for (let j = 1; j < ix.length; j++) { const x = C[ix[j]] - C[ix[j - 1]]; path += Math.abs(x); r.push(x); }
    let num = 0, den = 0;
    for (let j = 1; j < r.length; j++) { num += r[j] * r[j - 1]; den += r[j] * r[j]; }
    // the first hour, 08:30-09:30
    let fhH = -Infinity, fhL = Infinity;
    for (const i of ix) if (CT[i] < 570) { fhH = Math.max(fhH, H[i]); fhL = Math.min(fhL, Lo[i]); }
    // every raw 30-bar breakout of the session (the first bar of each), and what
    // followed from the next open with the book's bracket: +1.75 ATR before
    // -3 ATR (the $600 line at 4 lots and the 2026 ATR), else marked at 15:04
    const bo = [];
    for (let j = 0; j < ix.length - 1; j++) {
      const k = ix[j], side = C[k] > dc.high[k] ? 1 : C[k] < dc.low[k] ? -1 : 0;
      if (!side || (k > f && (side === 1 ? C[k - 1] > dc.high[k - 1] : C[k - 1] < dc.low[k - 1]))) continue;
      const ref = O[k + 1], A = a[k];
      let res = null;
      for (let q = k + 1; q <= l + 2 && q < n && TD[q] === d.td; q++) {
        const fav = side === 1 ? H[q] - ref : ref - Lo[q], adv = side === 1 ? ref - Lo[q] : H[q] - ref;
        if (adv >= 3 * A) { res = -3; break; }
        if (fav >= 1.75 * A) { res = 1.75; break; }
        if (CT[q] >= 904) { res = (side * (C[q] - ref)) / A; break; }
      }
      if (res != null) bo.push({ side, res, gated: ax[k] >= 25 && er[k] >= 0.5, early: CT[k] < 570 });
    }
    out.push({ td: d.td, ts: TS[f], o: O[f], h: hi, l: lo, c: C[l], range: hi - lo, atr: atrS / ix.length, fhRange: fhH - fhL,
               eff: path ? Math.abs(C[l] - O[f]) / path : 0, clv: hi > lo ? (C[l] - lo) / (hi - lo) : 0.5,
               ac1: den ? num / den : 0, adxOn: adxOn / ix.length, erOn: erOn / ix.length,
               onRange: Number.isFinite(d.on[0]) ? d.on[1] - d.on[0] : NaN, bo });
  }
  out.forEach((d, j) => {
    const prev = out.slice(Math.max(0, j - 10), j);
    d.adr = prev.length ? mean(prev.map((x) => x.range)) : NaN;
    d.rx = d.range / d.adr;
    d.swing = d.range / d.atr;          // the session's travel against the 2-minute bars' noise
    d.fhX = d.fhRange / d.adr;
    d.gap = j ? d.o - out[j - 1].c : NaN;
    d.gapX = Math.abs(d.gap) / d.adr;
    d.onX = d.onRange / d.adr;
    d.move = (d.c - d.o) / d.adr;
    // the day's direction against the day before's: does a move carry on?
    d.cont = j ? Math.sign(d.c - d.o) * Math.sign(out[j - 1].c - out[j - 1].o) : 0;
    // the trend coming into the session: yesterday's close against the close ten sessions before it
    d.trend10 = j >= 11 ? Math.sign(out[j - 1].c - out[j - 11].c) : 0;
    const p10 = out.slice(Math.max(0, j - 10), j + 1);
    const net = p10.length > 1 ? Math.abs(p10[p10.length - 1].c - p10[0].c) : 0, tot = p10.slice(1).reduce((s, x, q) => s + Math.abs(x.c - p10[q].c), 0);
    d.eff10 = tot ? net / tot : 0;
  });
  return out.filter((d) => d.ts >= fromMs);
}

// ── a book: its 2026 trades, days and windows ──
async function book({ id, ev }) {
  const cfg = await E.configOf(id, {}, ev), R = cfg.rules;
  const trades = L.fullRun(cfg).trades.filter((t) => t.entryTime >= Y26);   // sigIdx indexes L.signalBars(cfg)
  const win = L.windowStarts(R, Y26, Infinity).map((s) => {
    const r = replayWindow(trades, s, R), at = r.passMs ?? r.failMs ?? null;
    return { s, o: r.outcome === OUTCOME.PASS ? "P" : r.outcome === OUTCOME.FAIL ? "F" : "O", at,
             atTd: at != null ? L.bars().tday[indexAtOrBefore(L.bars().ts, at)] : null, net: r.stats.netPnl, days: r.stats.daysUsed };
  });
  const cap = cfg.exec.dayLossStopUsd || 0;
  return { id, ev, cfg, R, trades, win, cap };
}

// The book, with its first-hour (08:30-09:30 CT) entries refused -- or halved --
// on sessions whose overnight range (17:00 to 08:30) reached x times the
// average RTH range of the 10 sessions before. A refused signal still flips an
// open trade, as the books' own filters do. x = 0 refuses every first-hour entry.
function firstHourRule(cfg, x, mode = "skip") {
  const s = cfg.s;
  return { ...cfg, s: { ...s, compute(b, p) {
    const o = s.compute(b, p), n = b.close.length, CT = b.ctMin, TD = b.tday;
    const sm = o.sizeMult ? Float64Array.from(o.sizeMult) : new Float64Array(n).fill(1);
    const hist = [];
    let day = null, onH = -Infinity, onL = Infinity, rH = -Infinity, rL = Infinity;
    for (let k = 0; k < n; k++) {
      if (TD[k] !== day) {
        if (day !== null && rH > rL) { hist.push(rH - rL); if (hist.length > 10) hist.shift(); }
        day = TD[k]; onH = -Infinity; onL = Infinity; rH = -Infinity; rL = Infinity;
      }
      const ct = CT[k], rth = ct >= 510 && ct < 900;
      if (rth) { rH = Math.max(rH, b.high[k]); rL = Math.min(rL, b.low[k]); }
      else if (ct >= 1020 || ct < 510) { onH = Math.max(onH, b.high[k]); onL = Math.min(onL, b.low[k]); }
      if (!o.sig[k] || !(ct >= 510 && ct < 570)) continue;
      const adr = hist.length === 10 ? mean(hist) : NaN;
      if (x === 0 || (adr > 0 && (onH - onL) / adr >= x)) sm[k] = mode === "skip" ? 0 : sm[k] * 0.5;
    }
    return { ...o, sizeMult: sm };
  } } };
}

function runsOf(seq) {
  const out = [];
  for (let a = 0, i = 1; i <= seq.length; i++) if (i === seq.length || seq[i] !== seq[a]) { out.push({ o: seq[a], a, b: i - 1, n: i - a }); a = i; }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
const T0 = Date.now();
const market = marketDays(L.bars(), Y26);
const mByTd = new Map(market.map((d) => [d.td, d]));
const result = { books: [], market: market.map(({ bo, ...d }) => ({ ...d, nBo: bo.length, boWin: bo.length ? bo.filter((x) => x.res > 0).length / bo.length : null })) };

for (const spec of BOOKS) {
  const B = await book(spec), { trades, win, R, cap } = B;
  hr(`${spec.label}: ${win.length} window starts in 2026, ${trades.length} trades`);
  const seq = win.map((w) => w.o).join("");
  for (let i = 0; i < seq.length; i += 60) console.log(`  ${L.isoDay(win[i].s)}  ${seq.slice(i, i + 60)}`);

  // ── 1. mechanics ──
  const runs = runsOf(seq);
  console.log(`\n  ${runs.length} runs; the long ones (10+ starts), with the days their windows resolved on:`);
  const long = runs.filter((r) => r.n >= 10);
  for (const r of long) {
    const ends = new Map();
    for (let i = r.a; i <= r.b; i++) { const k = win[i].atTd != null ? dayOf(win[i].atTd).slice(5) : "open"; ends.set(k, (ends.get(k) || 0) + 1); }
    const top = [...ends].sort((x, y) => y[1] - x[1]);
    const share = top.slice(0, 2).reduce((s, x) => s + x[1], 0) / r.n;
    console.log(`  ${r.o} x${String(r.n).padStart(3)}  starts ${L.isoDay(win[r.a].s)}..${L.isoDay(win[r.b].s)}  ${ends.size} resolution days, the top two ${Math.round(100 * share)}%: ${top.slice(0, 6).map(([d, c]) => `${d} (${c})`).join(", ")}`);
  }

  // the trading days, their P&L (the rules' sessions), and consecutive 21-day windows
  const days26 = market.filter((d) => d.ts < Date.UTC(2026, 6, 15)).map((d) => d.td);
  const pnl = new Map(days26.map((td) => [td, 0])), capHit = new Set();
  for (const t of trades) { if (!pnl.has(t.tday)) continue; pnl.set(t.tday, pnl.get(t.tday) + t.pnl); if (t.reason === "DAYLOSS") capHit.add(t.tday); }
  const vec = days26.map((td) => pnl.get(td)), nd = vec.length;
  const rules = { target: R.profitTarget, dd: R.trailingDD, consistency: R.consistencyGatesPass ? R.consistencyPct / 100 : 0 };
  const passSeq = (v) => { const o = []; for (let q = 0; q + 21 <= v.length; q++) o.push(evalDays(v.slice(q, q + 21), rules)); return o; };
  const stats = (o) => { const rr = runsOf(o.join("")); return { runs: rr.length, longestFail: Math.max(0, ...rr.filter((x) => x.o === "0").map((x) => x.n)), meanRun: mean(rr.map((x) => x.n)) }; };
  const real = stats(passSeq(vec));
  const capVec = days26.map((td) => (capHit.has(td) ? 1 : 0));
  const adjCaps = (c) => { let k = 0; for (let i = 1; i < c.length; i++) if (c[i] && c[i - 1]) k++; return k; };
  // the most cap losses inside any 20 consecutive trading days
  const maxIn20 = (c) => { let best = 0, s = 0; for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= 20) s -= c[i - 20]; best = Math.max(best, s); } return best; };
  const lag1 = (v) => { const m = mean(v); let a = 0, b = 0; for (let i = 0; i < v.length; i++) { b += (v[i] - m) ** 2; if (i) a += (v[i] - m) * (v[i - 1] - m); } return a / b; };
  const rnd = mulberry32(777), NS = 2000, shuffled = [], shufCaps = [], shufLag = [], shufMax = [];
  for (let s = 0; s < NS; s++) {
    const p = Int32Array.from({ length: nd }, (_, i) => i);
    for (let i = nd - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    const v = Array.from(p, (i) => vec[i]), cv = Array.from(p, (i) => capVec[i]);
    shuffled.push(stats(passSeq(v))); shufCaps.push(adjCaps(cv)); shufLag.push(lag1(v)); shufMax.push(maxIn20(cv));
  }
  const pctAtMost = (arr, x) => (100 * arr.filter((y) => y <= x).length) / arr.length, pctAtLeast = (arr, x) => (100 * arr.filter((y) => y >= x).length) / arr.length;
  const mech = {
    tradingDays: nd, windows21: nd - 20, realRuns: real.runs, shuffledRuns: r1(mean(shuffled.map((x) => x.runs))), pRuns: r1(pctAtMost(shuffled.map((x) => x.runs), real.runs)),
    realLongestFail: real.longestFail, shuffledLongestFail: r1(mean(shuffled.map((x) => x.longestFail))), pLongest: r1(pctAtLeast(shuffled.map((x) => x.longestFail), real.longestFail)),
    capDays: capVec.reduce((s, x) => s + x, 0), adjacentCapPairs: adjCaps(capVec), shuffledAdjacent: r2(mean(shufCaps)), pAdjacent: r1(pctAtLeast(shufCaps, adjCaps(capVec))),
    maxCapIn20: maxIn20(capVec), shuffledMaxIn20: r1(mean(shufMax)), pMaxIn20: r1(pctAtLeast(shufMax, maxIn20(capVec))),
    runsDist: shuffled.reduce((h, x) => { h[x.runs] = (h[x.runs] || 0) + 1; return h; }, {}),
    lag1: r2(lag1(vec)), pLag1: r1(pctAtLeast(shufLag, lag1(vec))),
  };
  console.log(`\n  Consecutive 21-trading-day windows over 2026's ${nd} days, real order against ${NS} shuffles of the same days:`);
  console.log(`    runs of pass / not-pass   real ${mech.realRuns}   shuffled ${mech.shuffledRuns}   (${mech.pRuns}% of shuffles have as few)`);
  console.log(`    longest not-pass run      real ${mech.realLongestFail}   shuffled ${mech.shuffledLongestFail}   (${mech.pLongest}% have one as long)`);
  console.log(`    day-cap losses ${mech.capDays}; back-to-back pairs real ${mech.adjacentCapPairs}, shuffled ${mech.shuffledAdjacent}   (${mech.pAdjacent}% have as many)`);
  console.log(`    the most cap losses in any 20 trading days   real ${mech.maxCapIn20}   shuffled ${mech.shuffledMaxIn20}   (${mech.pMaxIn20}% have as many)`);
  console.log(`    daily P&L lag-1 autocorrelation ${mech.lag1}   (${mech.pLag1}% of shuffles as high)`);

  // ── 2. decisive days ──
  const resolve = new Map();
  for (const w of win) if (w.atTd != null) { const e = resolve.get(w.atTd) || { P: 0, F: 0 }; e[w.o]++; resolve.set(w.atTd, e); }
  const byDay = new Map();
  for (const t of trades) (byDay.get(t.tday) || byDay.set(t.tday, []).get(t.tday)).push(t);
  const decisive = [...resolve].filter(([, e]) => e.F >= 3).sort((x, y) => x[0] - y[0]);
  console.log(`\n  The days that breached 3+ windows (F), with the book's trades and the market's session:`);
  console.log(`    day         F   P&L  trades                        | range xADR  gap xADR  move xADR  eff   breakouts won`);
  const decRows = [];
  for (const [td, e] of decisive) {
    const ts = byDay.get(td) || [], m = mByTd.get(td);
    const tt = ts.map((t) => `${t.dir === 1 ? "L" : "S"}@${String(Math.floor(t.entryCt / 60)).padStart(2, "0")}:${String(t.entryCt % 60).padStart(2, "0")} ${t.reason} ${Math.round(t.pnl)}`).join(", ");
    const dp = ts.reduce((s, t) => s + t.pnl, 0);
    console.log(`    ${dayOf(td)} ${String(e.F).padStart(3)} ${String(Math.round(dp)).padStart(5)}  ${tt.padEnd(30).slice(0, 30)} | ${m ? `${r2(m.rx)}`.padStart(5) : ""}  ${m ? `${m.gap >= 0 ? "+" : ""}${r2(m.gap / m.adr)}`.padStart(6) : ""}  ${m ? `${m.move >= 0 ? "+" : ""}${r2(m.move)}`.padStart(6) : ""}  ${m ? r2(m.eff) : ""}  ${m && m.bo.length ? `${m.bo.filter((x) => x.res > 0).length}/${m.bo.length}` : ""}`);
    decRows.push({ day: dayOf(td), F: e.F, P: e.P, pnl: Math.round(dp), trades: ts.map((t) => ({ dir: t.dir, ct: t.entryCt, reason: t.reason, pnl: Math.round(t.pnl) })) });
  }

  // ── 3. regimes: each day by the share of its live windows that failed ──
  const exposure = new Map();
  for (const td of days26) {
    let f = 0, all = 0;
    for (const w of win) {
      const startTd = L.bars().tday[Math.min(L.bars().count - 1, indexAtOrBefore(L.bars().ts, w.s) + 1)];
      if (startTd > td || (w.atTd != null && w.atTd < td) || w.o === "O") continue;
      all++; if (w.o === "F") f++;
    }
    if (all) exposure.set(td, f / all);
  }
  const reg = (x) => (x >= 0.75 ? "fail" : x <= 0.25 ? "pass" : "mixed");
  const groups = { pass: [], fail: [], mixed: [] };
  for (const td of days26) if (exposure.has(td)) groups[reg(exposure.get(td))].push(td);
  // phases: maximal stretches of consecutive days in one regime
  const phases = [];
  for (const td of days26) {
    if (!exposure.has(td)) continue;
    const g = reg(exposure.get(td)), last = phases[phases.length - 1];
    if (last && last.g === g) { last.b = td; last.n++; } else phases.push({ g, a: td, b: td, n: 1 });
  }
  console.log(`\n  Regimes by day (the share of the windows alive that day which failed): ${groups.pass.length} pass-regime days, ${groups.fail.length} fail-regime, ${groups.mixed.length} mixed`);
  console.log(`  phases: ${phases.filter((p) => p.n >= 5).map((p) => `${p.g} ${dayOf(p.a).slice(5)}..${dayOf(p.b).slice(5)} (${p.n})`).join(" | ")}`);

  // each trade: how far it went against (ATRs), and whether price then went its
  // way, 1.75 ATR from the fill, before the session's 15:04 -- right, but early
  const sb = L.signalBars(B.cfg), SH = sb.high, SL = sb.low, SCT = sb.ctMin, STD = sb.tday;
  const tx = new Map(trades.map((t) => {
    let later = false;
    for (let i = t.exitIdx; i < SH.length && STD[i] === STD[t.exitIdx] && SCT[i] <= 904; i++) {
      if ((t.dir === 1 ? SH[i] - t.entryPrice : t.entryPrice - SL[i]) >= 1.75 * t.atr) { later = true; break; }
    }
    return [t, { mae: -t.mae / (2 * t.contracts) / t.atr, later, capAtr: cap / (2 * t.contracts) / t.atr, early: t.entryCt < 570 }];
  }));
  const tradeStats = (tds) => {
    const set = new Set(tds), ts = trades.filter((t) => set.has(t.tday));
    const w = ts.filter((t) => t.pnl > 0), lo = ts.filter((t) => t.pnl <= 0);
    const dp = tds.map((td) => pnl.get(td) ?? 0);
    let streak = 0, worst = 0;
    for (const v of dp) { streak = v < 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
    const dirOk = ts.filter((t) => { const m = mByTd.get(t.tday); return m && Math.sign(m.c - m.o) === t.dir; }).length;
    const part = (f) => { const s = ts.filter(f); return { n: s.length, won: s.length ? r1((100 * s.filter((t) => t.pnl > 0).length) / s.length) : null, avg: s.length ? Math.round(mean(s.map((t) => t.pnl))) : null }; };
    return {
      days: tds.length, trades: ts.length, perDay: r2(ts.length / tds.length), winRate: r1((100 * w.length) / Math.max(1, ts.length)),
      avgWin: Math.round(mean(w.map((t) => t.pnl))), avgLoss: Math.round(mean(lo.map((t) => t.pnl))), pnlPerDay: Math.round(mean(dp)),
      capDaysPer20: r1((20 * tds.filter((td) => capHit.has(td)).length) / tds.length), worstLosingStreak: worst,
      withDay: r1((100 * dirOk) / Math.max(1, ts.length)), longs: r1((100 * ts.filter((t) => t.dir === 1).length) / Math.max(1, ts.length)),
      exits: Object.fromEntries(["TP", "SL", "DAYLOSS", "STALE", "FLAT", "FLIP"].map((x) => [x, ts.filter((t) => t.reason === x).length])),
      firstHour: part((t) => tx.get(t).early), later: part((t) => !tx.get(t).early),
      withTrend: part((t) => mByTd.get(t.tday)?.trend10 === t.dir), againstTrend: part((t) => mByTd.get(t.tday)?.trend10 === -t.dir),
      atrAtSignal: r1(median(ts.map((t) => t.atr))), capInAtr: r2(median(ts.map((t) => tx.get(t).capAtr))),
      loserMae: r2(median(lo.map((t) => tx.get(t).mae))), losersRightLater: r1((100 * lo.filter((t) => tx.get(t).later).length) / Math.max(1, lo.length)),
    };
  };
  const mStats = (tds) => {
    const ms = tds.map((td) => mByTd.get(td)).filter(Boolean), bo = ms.flatMap((d) => d.bo), bg = bo.filter((x) => x.gated);
    const f = (k) => r2(median(ms.map((d) => d[k]).filter(Number.isFinite)));
    const be = bo.filter((x) => x.early), bl = bo.filter((x) => !x.early);
    return {
      swing: r1(median(ms.map((d) => d.swing))), firstHourX: f("fhX"),
      earlyWin: r1((100 * be.filter((x) => x.res > 0).length) / Math.max(1, be.length)), lateWin: r1((100 * bl.filter((x) => x.res > 0).length) / Math.max(1, bl.length)),
      atr: f("atr"), range: Math.round(median(ms.map((d) => d.range))), rangeX: f("rx"), gapX: f("gapX"), overnightX: f("onX"), moveX: r2(median(ms.map((d) => Math.abs(d.move)))),
      eff: f("eff"), eff10: f("eff10"), clvExtreme: r1((100 * ms.filter((d) => d.clv > 0.8 || d.clv < 0.2).length) / ms.length), ac1: r2(mean(ms.map((d) => d.ac1))),
      continuation: r1((100 * ms.filter((d) => d.cont === 1).length) / ms.filter((d) => d.cont !== 0).length), adxOn: r1(100 * mean(ms.map((d) => d.adxOn))), erOn: r1(100 * mean(ms.map((d) => d.erOn))),
      breakoutsPerDay: r1(bo.length / ms.length), breakoutWin: r1((100 * bo.filter((x) => x.res > 0).length) / Math.max(1, bo.length)), breakoutR: r2(mean(bo.map((x) => x.res))),
      gatedWin: r1((100 * bg.filter((x) => x.res > 0).length) / Math.max(1, bg.length)), gatedR: r2(mean(bg.map((x) => x.res))),
    };
  };
  // a day-bootstrap 90% interval for a market measure's median difference, fail minus pass
  const boot = (k, f = (d) => d[k]) => {
    const A = groups.fail.map((td) => mByTd.get(td)).filter(Boolean).map(f).filter(Number.isFinite), P = groups.pass.map((td) => mByTd.get(td)).filter(Boolean).map(f).filter(Number.isFinite);
    const rr = mulberry32(99), dif = [];
    for (let s = 0; s < 2000; s++) dif.push(median(A.map(() => A[Math.floor(rr() * A.length)])) - median(P.map(() => P[Math.floor(rr() * P.length)])));
    dif.sort((x, y) => x - y);
    return [r2(dif[100]), r2(dif[1899])];
  };
  const reg3 = { pass: { trades: tradeStats(groups.pass), market: mStats(groups.pass) }, fail: { trades: tradeStats(groups.fail), market: mStats(groups.fail) } };
  const ci = Object.fromEntries(["atr", "rx", "gapX", "onX", "eff", "eff10", "ac1", "swing", "fhX"].map((k) => [k, boot(k)]));
  ci.absMove = boot("absMove", (d) => Math.abs(d.move));
  console.log(`\n                       pass-regime days   fail-regime days   (fail - pass, 90% day-bootstrap)`);
  const row = (lab, a, b, c = "") => console.log(`    ${lab.padEnd(30)} ${String(a).padStart(9)}   ${String(b).padStart(14)}   ${c}`);
  const T = reg3, Tp = T.pass.trades, Tf = T.fail.trades, Mp = T.pass.market, Mf = T.fail.market;
  row("days", Tp.days, Tf.days);
  row("trades per day", Tp.perDay, Tf.perDay);
  row("win rate %", Tp.winRate, Tf.winRate);
  row("avg win / avg loss $", `${Tp.avgWin} / ${Tp.avgLoss}`, `${Tf.avgWin} / ${Tf.avgLoss}`);
  row("P&L per day $", Tp.pnlPerDay, Tf.pnlPerDay);
  row(`day-cap losses per 20 days`, Tp.capDaysPer20, Tf.capDaysPer20);
  row("longest losing-day streak", Tp.worstLosingStreak, Tf.worstLosingStreak);
  row("trades with the day's direction %", Tp.withDay, Tf.withDay);
  row("longs %", Tp.longs, Tf.longs);
  row("exits TP/SL/cap/stale/flat", `${Tp.exits.TP}/${Tp.exits.SL}/${Tp.exits.DAYLOSS}/${Tp.exits.STALE}/${Tp.exits.FLAT}`, `${Tf.exits.TP}/${Tf.exits.SL}/${Tf.exits.DAYLOSS}/${Tf.exits.STALE}/${Tf.exits.FLAT}`);
  const hp = (x) => `${x.n} tr, ${x.won}% won, $${x.avg}`;
  row("entered 08:30-09:30", hp(Tp.firstHour), hp(Tf.firstHour));
  row("entered later", hp(Tp.later), hp(Tf.later));
  row("with the 10-day trend", hp(Tp.withTrend), hp(Tf.withTrend));
  row("against it", hp(Tp.againstTrend), hp(Tf.againstTrend));
  row("ATR at the signal / cap in ATRs", `${Tp.atrAtSignal} / ${Tp.capInAtr}`, `${Tf.atrAtSignal} / ${Tf.capInAtr}`);
  row("losers: against them, ATRs", Tp.loserMae, Tf.loserMae);
  row("losers price then went their way %", Tp.losersRightLater, Tf.losersRightLater);
  console.log("    -- the market (medians of the sessions) --");
  row("range / 2-min ATR (swing vs noise)", Mp.swing, Mf.swing, `${ci.swing}`);
  row("first-hour range / ADR", Mp.firstHourX, Mf.firstHourX, `${ci.fhX}`);
  row("raw breakouts won: first hour / later %", `${Mp.earlyWin} / ${Mp.lateWin}`, `${Mf.earlyWin} / ${Mf.lateWin}`);
  row("ATR(14), 2-min, points", Mp.atr, Mf.atr, `${ci.atr}`);
  row("RTH range, points", Mp.range, Mf.range);
  row("range / its 10-day average", Mp.rangeX, Mf.rangeX, `${ci.rx}`);
  row("|gap| / ADR", Mp.gapX, Mf.gapX, `${ci.gapX}`);
  row("overnight range / ADR", Mp.overnightX, Mf.overnightX, `${ci.onX}`);
  row("|open-to-close| / ADR", Mp.moveX, Mf.moveX, `${ci.absMove}`);
  row("intraday efficiency", Mp.eff, Mf.eff, `${ci.eff}`);
  row("10-day efficiency (trend)", Mp.eff10, Mf.eff10, `${ci.eff10}`);
  row("closes in the top/bottom 20% %", Mp.clvExtreme, Mf.clvExtreme);
  row("2-min return autocorrelation", Mp.ac1, Mf.ac1, `${ci.ac1}`);
  row("days carrying on yesterday's move %", Mp.continuation, Mf.continuation);
  row("RTH bars ADX >= 25 %", Mp.adxOn, Mf.adxOn);
  row("RTH bars efficiency >= 0.5 %", Mp.erOn, Mf.erOn);
  row("raw breakouts per day", Mp.breakoutsPerDay, Mf.breakoutsPerDay);
  row("breakouts reaching +1.75 ATR first %", Mp.breakoutWin, Mf.breakoutWin);
  row("  mean result, ATRs", Mp.breakoutR, Mf.breakoutR);
  row("  of those the gates pass %", Mp.gatedWin, Mf.gatedWin);
  row("  their mean result, ATRs", Mp.gatedR, Mf.gatedR);

  // ── 4. the chart's indicators at each signal ──
  const sigBars = L.signalBars(B.cfg), C = sigBars.close, A = atr(sigBars.high, sigBars.low, C, 14);
  const specs = Object.keys(STUDIES).map((type) => resolveStudy({ type }));
  specs.push(resolveStudy({ type: "emacross", tf: 10, params: { fast: 9, slow: 21 } }), resolveStudy({ type: "ema", tf: 30, params: { length: 50 } }),
             resolveStudy({ type: "rsi", tf: 10 }), resolveStudy({ type: "adx", tf: 10 }));
  const regOf = (t) => (exposure.has(t.tday) ? reg(exposure.get(t.tday)) : "mixed");
  // AUC: the chance a random member of `a` reads higher than one of `b` (0.5 = no difference)
  const auc = (a, b) => { if (a.length < 5 || b.length < 5) return null; let s = 0; for (const x of a) for (const y of b) s += x > y ? 1 : x === y ? 0.5 : 0; return r2(s / (a.length * b.length)); };
  const ind = [];
  for (const st of specs) {
    const r = studyOnSignal(L.bars(), sigBars, st), S = STUDIES[st.type], lv = S.levels ? S.levels(st.params) : {};
    // oriented to the trade's side: above the line / up the band / over the
    // oscillator's middle is "with" a long and "against" a short
    const val = (t) => {
      const k = t.sigIdx, v = r.v[k], d = t.dir;
      if (S.kind === "price") return Number.isFinite(v) && A[k] > 0 ? ((C[k] - v) / A[k]) * d : NaN;
      if (S.kind === "band") return Number.isFinite(v) ? (v - 0.5) * d : NaN;
      if (S.kind === "trend") return r.dir[k] ? r.dir[k] * d : NaN;
      if (S.kind === "osc") return Number.isFinite(v) ? (v - (lv.mid ?? 0)) * d : NaN;
      return v;   // a level: no side
    };
    const rows = trades.map((t) => ({ v: val(t), win: t.pnl > 0, g: regOf(t), h: t.entryTime < APR ? 0 : 1 })).filter((x) => Number.isFinite(x.v));
    const pick = (f) => rows.filter(f).map((x) => x.v);
    ind.push({
      study: studyLabel(st), kind: S.kind,
      failVsPass: auc(pick((x) => x.g === "fail"), pick((x) => x.g === "pass")),
      medianPass: r2(median(pick((x) => x.g === "pass"))), medianFail: r2(median(pick((x) => x.g === "fail"))),
      winVsLoss: auc(pick((x) => x.win), pick((x) => !x.win)),
      winVsLossH1: auc(pick((x) => x.win && x.h === 0), pick((x) => !x.win && x.h === 0)), winVsLossH2: auc(pick((x) => x.win && x.h === 1), pick((x) => !x.win && x.h === 1)),
      n: rows.length,
    });
  }
  ind.sort((x, y) => Math.abs(y.failVsPass - 0.5) - Math.abs(x.failVsPass - 0.5));
  console.log(`\n  The chart's indicators at the signal, oriented to the trade (AUC: 0.5 = no difference). Fail-regime trades ${trades.filter((t) => regOf(t) === "fail").length}, pass-regime ${trades.filter((t) => regOf(t) === "pass").length}:`);
  console.log(`    ${"study".padEnd(26)} fail vs pass   (median pass / fail)     win vs loss  (Jan-Mar / Apr-Jul)`);
  for (const x of ind) console.log(`    ${x.study.padEnd(26)} ${String(x.failVsPass).padStart(6)}       (${String(x.medianPass).padStart(7)} / ${String(x.medianFail).padEnd(7)})   ${String(x.winVsLoss).padStart(6)}       (${x.winVsLossH1} / ${x.winVsLossH2})`);

  // ── 5. could it have been seen coming? ──
  // The fail stretches lost their first-hour trades after wide nights. A rule a
  // person could follow live, reading only what is known at 08:30: refuse (or
  // halve) first-hour entries when the night before ranged at least x times the
  // 10-session ADR. The thresholds were suggested by these same days, so this is
  // the friendliest possible test: a rule that fails it is dead.
  const base = E.score(trades, R);
  const tests = [];
  for (const [x, mode] of [[0, "skip"], [0.8, "skip"], [1, "skip"], [1.2, "skip"], [1, "half"]]) {
    const sc = E.score(E.trades2026(firstHourRule(B.cfg, x, mode)), R);
    tests.push({ rule: x ? `${mode === "skip" ? "skip" : "halve"} first-hour entries after a night >= ${x} ADR` : "skip every first-hour entry", ...sc });
  }
  console.log(`\n  Could it be seen coming? Calendar (Jan-Mar / Apr-Jul) and bootstrap, 2026:`);
  console.log(`    ${"the book as it is".padEnd(52)} ${E.fmt(base)}`);
  for (const r of tests) console.log(`    ${r.rule.padEnd(52)} ${E.fmt(r)}`);

  result.books.push({
    base, tests,
    id: spec.id, ev: spec.ev, label: spec.label, rules: { target: R.profitTarget, dd: R.trailingDD, daily: R.dailyLossLimit, cap },
    windows: win.map((w) => ({ s: L.isoDay(w.s), o: w.o, at: w.atTd != null ? dayOf(w.atTd) : null })),
    runs: long.map((r) => ({ o: r.o, n: r.n, from: L.isoDay(win[r.a].s), to: L.isoDay(win[r.b].s) })),
    mechanics: mech, decisive: decRows, regimes: reg3, ci, phases: phases.filter((p) => p.n >= 5).map((p) => ({ g: p.g, from: dayOf(p.a), to: dayOf(p.b), days: p.n })),
    days: days26.map((td) => ({ day: dayOf(td), pnl: Math.round(pnl.get(td)), cap: capHit.has(td), exposure: exposure.has(td) ? r2(exposure.get(td)) : null })),
    indicators: ind,
  });
}

// ── the later block: TopstepX bars, Sep 10 - Oct 26 2026 ──
if (fs.existsSync(FWD_FILE)) {
  const fb = loadBars(FWD_FILE).bars, fm = marketDays(fb, FWD_FROM);
  const cfg = await E.configOf("donchian_1250", {}, "1250");
  const tr = runStrategy(fb, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies: cfg.studies, fromMs: FWD_FROM }).trades;
  const pn = new Map(fm.map((d) => [d.td, 0])), caps = new Set();
  for (const t of tr) { if (pn.has(t.tday)) pn.set(t.tday, pn.get(t.tday) + t.pnl); if (t.reason === "DAYLOSS") caps.add(t.tday); }
  const bo = fm.flatMap((d) => d.bo), bg = bo.filter((x) => x.gated);
  const f = (k) => r2(median(fm.map((d) => d[k]).filter(Number.isFinite)));
  const fwd = {
    days: fm.length, trades: tr.length, pnlPerDay: Math.round(mean([...pn.values()])), capDaysPer20: r1((20 * caps.size) / fm.length),
    winRate: r1((100 * tr.filter((t) => t.pnl > 0).length) / Math.max(1, tr.length)),
    atr: f("atr"), rangeX: f("rx"), gapX: f("gapX"), overnightX: f("onX"), moveX: r2(median(fm.map((d) => Math.abs(d.move)))), eff: f("eff"), eff10: f("eff10"),
    ac1: r2(mean(fm.map((d) => d.ac1))), continuation: r1((100 * fm.filter((d) => d.cont === 1).length) / fm.filter((d) => d.cont !== 0).length),
    breakoutWin: r1((100 * bo.filter((x) => x.res > 0).length) / Math.max(1, bo.length)), breakoutR: r2(mean(bo.map((x) => x.res))),
    gatedWin: r1((100 * bg.filter((x) => x.res > 0).length) / Math.max(1, bg.length)), gatedR: r2(mean(bg.map((x) => x.res))),
  };
  hr(`The later block (TopstepX, ${dayOf(fm[0].td)} to ${dayOf(fm[fm.length - 1].td)}): donchian_1250 passed every window`);
  console.log(`  ${JSON.stringify(fwd)}`);
  result.forward = fwd;
}

if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify(result)); console.log(`\nwrote ${jsonOut}`); }
console.log(`\n${((Date.now() - T0) / 1000).toFixed(1)} s`);
