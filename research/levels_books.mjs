// Can a level be traded on its own? Rules at levels, through the real engine.
//
//   node --max-old-space-size=8192 research/levels_books.mjs
//
// RESULT (2026, $1,250 eval, costs in): 2,978 rules with 20 or more trades, 958 of them net
// positive. None beats donchian_1250 in both halves (calendar 74.5%, ci 35-94). Picking on
// one half and reading the other: 86.7% then 14.7%, and 88% then 0%. Best by the worse half,
// Pre-market low fade R 12% 1.5/1.5: calendar 68.5% (ci 30-92; 66.7 / 70.7), bootstrap 56.0%
// (43.9 / 59.8), 70 trades, but its neighbours' median worse half is 23%, and its coin-flip
// twin reaches 55% on one seed of 12. Forward: 13 trades, +$684.
// Three ways to trade a level, on 1-minute bars in RTH, after price has been at least R
// from it (R as a share of the recent daily range, as in the level study):
//   fade    a bar trades through it and closes back on the side it came from. Enter at
//           the next open, the way it came.
//   break   a bar closes more than R/4 beyond it. Enter at the next open, the way it broke.
//   retest  after a break, price comes back to it and closes away on the broken side.
//           Enter at the next open: the broken level now holds from the other side.
// Stop and target are multiples of R from the fill. Every level type gets every rule, R
// and bracket, on the $1,250 book's account: 4 contracts, a tick of slippage a side,
// $0.75 a side, the $600 day line, -$300 breaker, +$250 block, flat by 15:06 CT.
//
// That is thousands of configurations, so the project's protocol applies:
//   1. calendar windows, pick on one half of 2026, read the other, both ways round;
//   2. rank what is left by the worse half, and take the best few;
//   3. both pass-rate methods, the neighbours, the coin-flip twin;
//   4. the forward bars, which played no part in any of it.
//
// Writes research/levels_books_results.json.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as E from "./lib_eval1250.mjs";
import * as Lab from "./lib_levels.mjs";
import { loadBars } from "../src/data.mjs";
import { sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { runStrategy } from "../src/run.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";
import { computeStudy, closedIndexMap, resolveStudy } from "../src/studies.mjs";
import { sessionsOf, adrOf } from "../src/levels.mjs";

const t0 = Date.now(), DAY = 86400000, L = E.lab;

// Levels to trade, as studies: enough to cover each idea without repeating one.
const LEVELS = [
  ["PD high", "daylevels", 1, {}, "PDH"], ["PD low", "daylevels", 1, {}, "PDL"], ["PD close", "daylevels", 1, {}, "PDC"],
  ["PD POC", "vprofile", 1, { anchor: "rth", mode: "prior" }, "POC"], ["PD VAH", "vprofile", 1, { anchor: "rth", mode: "prior" }, "VAH"], ["PD VAL", "vprofile", 1, { anchor: "rth", mode: "prior" }, "VAL"],
  ["Overnight high", "clockrange", 1, { span: "overnight" }, "high"], ["Overnight low", "clockrange", 1, { span: "overnight" }, "low"],
  ["London high", "clockrange", 1, { span: "london" }, "high"], ["London low", "clockrange", 1, { span: "london" }, "low"],
  ["Pre-market high", "clockrange", 1, { span: "premarket" }, "high"], ["Pre-market low", "clockrange", 1, { span: "premarket" }, "low"],
  ["PW high", "periodlevels", 1, { period: "week" }, "prior high"], ["PW low", "periodlevels", 1, { period: "week" }, "prior low"],
  ["PW POC", "vprofile", 1, { anchor: "week", mode: "prior" }, "POC"], ["Week open", "opens", 1, {}, "week"], ["RTH open", "opens", 1, {}, "RTH"], ["Midnight open", "opens", 1, {}, "midnight"],
  ["Monday high", "firstrange", 1, { period: "week", sessions: 1 }, "high"], ["Monday low", "firstrange", 1, { period: "week", sessions: 1 }, "low"],
  ["OR5 high", "openrange", 1, { minutes: 5 }, "OR high"], ["OR5 low", "openrange", 1, { minutes: 5 }, "OR low"], ["OR15 high", "openrange", 1, { minutes: 15 }, "OR high"], ["OR15 low", "openrange", 1, { minutes: 15 }, "OR low"],
  ["IB high", "initialbalance", 1, { minutes: 60 }, "IB high"], ["IB low", "initialbalance", 1, { minutes: 60 }, "IB low"], ["IB +1", "initialbalance", 1, { minutes: 60 }, "+1"], ["IB -1", "initialbalance", 1, { minutes: 60 }, "−1"],
  ["Floor R1", "pivots", 1, {}, "R1"], ["Floor S1", "pivots", 1, {}, "S1"], ["Camarilla H3", "pivots", 1, { style: "camarilla" }, "H3"], ["Camarilla L3", "pivots", 1, { style: "camarilla" }, "L3"],
  ["Dev POC (RTH)", "vprofile", 1, { anchor: "rth" }, "POC"], ["Dev VAH (RTH)", "vprofile", 1, { anchor: "rth" }, "VAH"], ["Dev VAL (RTH)", "vprofile", 1, { anchor: "rth" }, "VAL"],
  ["Dev POC (week)", "vprofile", 1, { anchor: "week" }, "POC"], ["Dev VAH (week)", "vprofile", 1, { anchor: "week" }, "VAH"], ["Dev VAL (week)", "vprofile", 1, { anchor: "week" }, "VAL"],
  ["VWAP (RTH)", "vwap", 1, { anchor: "rth", bands: 2 }, "VWAP"], ["VWAP +2σ", "vwap", 1, { anchor: "rth", bands: 2 }, "+2σ"], ["VWAP -2σ", "vwap", 1, { anchor: "rth", bands: 2 }, "−2σ"],
  ["VWAP (week)", "vwap", 1, { anchor: "week", bands: 2 }, "VWAP"], ["Week VWAP +2σ", "vwap", 1, { anchor: "week", bands: 2 }, "+2σ"], ["Week VWAP -2σ", "vwap", 1, { anchor: "week", bands: 2 }, "−2σ"],
  ["Day high so far", "rangelevels", 1, { period: "day" }, "high"], ["Day low so far", "rangelevels", 1, { period: "day" }, "low"], ["Day range 50%", "rangelevels", 1, { period: "day" }, "50%"],
  ["Open + ADR", "adrproj", 1, {}, "+ADR"], ["Open - ADR", "adrproj", 1, {}, "−ADR"], ["Day low + ADR", "adrproj", 1, {}, "low+ADR"], ["Day high - ADR", "adrproj", 1, {}, "high−ADR"],
  ["EMA 50 (2m)", "ema", 2, { length: 50 }, "EMA 50"], ["EMA 21 (10m)", "ema", 10, { length: 21 }, "EMA 21"], ["EMA 50 (60m)", "ema", 60, { length: 50 }, "EMA 50"],
  ["Swing high 5m", "swings", 5, { left: 3, right: 3 }, "swing high"], ["Swing low 5m", "swings", 5, { left: 3, right: 3 }, "swing low"],
  ["Swing high 15m", "swings", 15, { left: 3, right: 3 }, "swing high"], ["Swing low 15m", "swings", 15, { left: 3, right: 3 }, "swing low"],
];
const MODES = ["fade", "break", "retest"], RS = [0.05, 0.08, 0.12], BRACKETS = [[1, 1], [1, 1.5], [1, 2], [0.75, 1.5], [1.5, 1.5], [1.5, 3]];

// A level on these bars, read as of the bar before.
const seriesCache = new WeakMap();
function seriesOf(b, spec) {
  let m = seriesCache.get(b);
  if (!m) seriesCache.set(b, (m = new Map()));
  const key = spec[0];
  if (m.has(key)) return m.get(key);
  const [, type, tf, params, line] = spec, st = resolveStudy({ type, tf, params }), { bars: sb, out } = computeStudy(b, st, 1, b);
  const src = out.lines.find((x) => x.name === line);
  if (!src) throw new Error(`${key}: no line "${line}" in ${out.lines.map((x) => x.name)}`);
  const n = b.close.length, a = new Float64Array(n).fill(NaN), map = sb === b ? null : closedIndexMap(b, sb);
  for (let i = 0; i < n; i++) { const j = map ? map[i] : i; if (j >= 0) a[i] = src.data[j]; }
  m.set(key, a);
  return a;
}

// The R of each RTH bar, and the first bar it can trade.
const unitCache = new WeakMap();
function unitsOf(b) {
  if (unitCache.has(b)) return unitCache.get(b);
  const S = sessionsOf(b), adr = adrOf(S), n = b.close.length, u = new Float64Array(n).fill(NaN);
  S.forEach((s, k) => { if (s.rthA >= 0 && Number.isFinite(adr[k])) u.fill(adr[k], s.rthA, s.rthZ); });
  unitCache.set(b, u);
  return u;
}

// The rule, as a strategy for the real engine. `atr` carries R, so the exec's multiples
// are multiples of R.
function bookOf(spec, mode, rFrac) {
  return {
    id: `level_${mode}`, name: `${spec[0]} ${mode}`, timeframeMin: 1, warmupBars: 300, warmupSessions: 70, params: [],
    compute(b) {
      const S = seriesOf(b, spec), U = unitsOf(b), { high: H, low: Lo, close: C, tday: TD, ctMin: CT } = b, n = C.length;
      const sig = new Int8Array(n), atr = new Float64Array(n).fill(NaN);
      let day = null, side = 0, broke = 0;
      for (let i = 1; i < n; i++) {
        const R = rFrac * U[i], p = S[i - 1];
        if (R > 0) atr[i] = R;
        if (TD[i] !== day) { day = TD[i]; side = 0; broke = 0; }
        if (!(R > 0) || !(p === p) || CT[i] < 515 || CT[i] >= 880) continue;
        if (!side && !broke) { if (C[i] - p >= R) side = 1; else if (p - C[i] >= R) side = -1; continue; }
        if (mode === "fade") {
          if (side === 1 ? Lo[i] <= p - 0.25 && C[i] > p : H[i] >= p + 0.25 && C[i] < p) { sig[i] = side; side = 0; }
          else if (side === 1 ? C[i] < p : C[i] > p) side = 0;
        } else if (mode === "break") {
          if (side === 1 ? C[i] <= p - R / 4 : C[i] >= p + R / 4) { sig[i] = -side; side = 0; }
        } else if (broke) {
          // broken one way: back to it, and away again on the broken side
          if (broke === 1 ? Lo[i] <= p + 0.25 && C[i] > p : H[i] >= p - 0.25 && C[i] < p) { sig[i] = broke; broke = 0; }
          else if (broke === 1 ? C[i] < p - R / 4 : C[i] > p + R / 4) broke = 0;
        } else if (side === 1 ? C[i] <= p - R / 4 : C[i] >= p + R / 4) { broke = -side; side = 0; }
      }
      return { sig, atr };
    },
  };
}

// ── the account: the $1,250 book's, and its slice of the bars ──
const base = await E.configOf("donchian_1250");
const account = (sl, tp) => ({ ...base.exec, entryType: "market", slAtrMult: sl, tpMode: "atr", tpAtrMult: tp, staleBars: 0, flipOnOpposite: false, flipOnAnySignal: false, tpFromFill: true, atrPeriod: 14 });
const noFilter = { ...base.filter, startCt: 0, endCt: 1440 };
const all = L.bars(), from = indexAtOrAfter(all.ts, E.Y26 - 120 * DAY), slice = sliceBars(all, from, all.count), rules = base.rules;
const runIt = (s, sl, tp, bars = slice, fromMs = E.Y26) => runStrategy(bars, s, { timeframeMin: 1 }, account(sl, tp), { filter: noFilter, fromMs }).trades;
const calOf = (tr, lo, hi) => L.calendar(tr, rules, L.windowStarts(rules, lo, hi)).pass;

// ── the grid ──
console.log(`${LEVELS.length} levels × ${MODES.length} rules × ${RS.length} sizes × ${BRACKETS.length} brackets = ${LEVELS.length * MODES.length * RS.length * BRACKETS.length} configurations`);
const rows = [];
for (const spec of LEVELS) {
  for (const mode of MODES) for (const rFrac of RS) {
    const s = bookOf(spec, mode, rFrac);
    for (const [sl, tp] of BRACKETS) {
      const tr = runIt(s, sl, tp);
      if (tr.length < 20) continue;
      let net = 0; for (const t of tr) net += t.pnl;
      rows.push({ level: spec[0], mode, rFrac, sl, tp, trades: tr.length, net: Math.round(net), calA: calOf(tr, E.Y26, E.APR), calB: calOf(tr, E.APR, Infinity) });
    }
  }
  if (rows.length % 500 < 54) console.log(`  ${rows.length} done, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
const worse = (r) => Math.min(r.calA, r.calB);
console.log(`${rows.length} configurations with at least 20 trades, in ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
const netPos = rows.filter((r) => r.net > 0).length;
console.log(`Net positive after costs: ${netPos} (${((100 * netPos) / rows.length).toFixed(0)}%).`);

// pick on one half, read the other, both ways round
const pickA = rows.slice().sort((a, b) => b.calA - a.calA)[0], pickB = rows.slice().sort((a, b) => b.calB - a.calB)[0];
const name = (r) => `${r.level} ${r.mode} R${r.rFrac * 100}% ${r.sl}/${r.tp}`;
console.log(`\nBest on Jan-Mar: ${name(pickA)}: ${pickA.calA}% then Apr-Jul ${pickA.calB}%`);
console.log(`Best on Apr-Jul: ${name(pickB)}: ${pickB.calB}% then Jan-Mar ${pickB.calA}%`);

// the top by the worse half, in full
const top = rows.slice().sort((a, b) => worse(b) - worse(a) || b.net - a.net).slice(0, 12);
const fwdBars = loadBars(fileURLToPath(new URL("../data/topstepx_1m.bin", import.meta.url))).bars, FROM = Date.UTC(2026, 8, 11);
console.log(`\nTop 12 by the worse half. Book to beat: donchian_1250, calendar 74.5% (75.6 / 73.3).`);
const final = [];
for (const r of top) {
  const spec = LEVELS.find((x) => x[0] === r.level), s = bookOf(spec, r.mode, r.rFrac), tr = runIt(s, r.sl, r.tp), sc = E.score(tr, rules);
  // neighbours: the same level and rule with each other size and bracket
  const near = rows.filter((x) => x.level === r.level && x.mode === r.mode && x !== r), medianNear = near.length ? near.map(worse).sort((a, b) => a - b)[near.length >> 1] : null;
  // the coin-flip twin: same times, random direction
  const cfgLike = { ...base, s, params: { timeframeMin: 1 }, exec: account(r.sl, r.tp), filter: noFilter };
  const coins = [];
  for (let k = 1; k <= 12; k++) coins.push(calOf(runStrategy(slice, E.nullCfg(cfgLike, k).s, { timeframeMin: 1 }, account(r.sl, r.tp), { filter: noFilter, fromMs: E.Y26 }).trades, E.Y26, Infinity));
  const coin = coins.reduce((a, x) => a + x, 0) / coins.length;
  const ftr = runStrategy(fwdBars, s, { timeframeMin: 1 }, account(r.sl, r.tp), { filter: noFilter, fromMs: FROM }).trades;
  let fnet = 0, wins = 0; for (const t of ftr) { fnet += t.pnl; if (t.pnl > 0) wins++; }
  final.push({ ...r, ...sc, medianNear, coin, coinTop: Math.max(...coins), fwdTrades: ftr.length, fwdNet: Math.round(fnet), fwdWin: ftr.length ? Math.round((100 * wins) / ftr.length) : 0 });
  console.log(`${name(r).padEnd(36)} ${E.fmt(sc)}\n${"".padEnd(36)} neighbours' median worse half ${medianNear}  coin-flip ${coin.toFixed(1)}% (best ${Math.max(...coins).toFixed(1)})  forward ${ftr.length} trades, $${Math.round(fnet)}, ${ftr.length ? Math.round((100 * wins) / ftr.length) : 0}% won`);
}
fs.writeFileSync(new URL("./levels_books_results.json", import.meta.url), JSON.stringify({ configurations: rows.length, netPositive: netPos, pickA, pickB, final, rows }));
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
