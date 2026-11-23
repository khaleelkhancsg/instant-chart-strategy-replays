// Do dojis, levels, volume nodes, settlement, VWAP or pivots help call the turn, alone or
// beside the databox's warnings?
//
//   node --max-old-space-size=16384 research/turn_context.mjs [--placebos N]
//
// RESULT (2026-11-23; 100 placebo markets each year): only one thing held up on fresh data.
// - Found on 2026 (19 events x 2 races x 3 periods, about 114 readings; edge = win rate less a plain fade's):
//     doji alone          nothing: 1m +0.2 (45 of 100 placebo markets as high), 5m -0.7
//     doji at a level     18-pt race +2.9 (1 of 100; Jan-Jun 0, Jul-Oct 18)       a lead
//     1m EMA Pot. + doji  37-pt race +2.8 (2 of 100; halves 16 / 6)               a lead
//     VWAP touch          18-pt race -1.9 (99 of 100 as high: bounce calls lose, price breaks through)
//     volume nodes        18-pt race -2.0 (100 of 100), same lean
//     prior-day / overnight high-low, settlement, pivots, Camarilla, round numbers: no lean held in both halves
//     the box's own warnings at a level or with a doji: nothing
// - Confirmed on 2025 (--year 2025), the same events, no change:
//     doji at a level     18-pt +0.8 (13 of 100): FAILS (37-pt +2.1, 7 of 100, was not the named race)
//     1m EMA Pot. + doji  37-pt -2.9 (93 of 100 as high): FAILS, the other way
//     VWAP touch          18-pt -1.5 (99 of 100; halves 96, 94): HOLDS. At RTH or session VWAP, a bounce call
//                         wins about 1.5-2 points of win rate less than a plain fade, beyond placebo, in both
//                         years: price goes through VWAP more often than chance gives
//     volume nodes        18-pt +0.4 (3 of 100): flips sign, does not hold
//
// The person's question (2026-11-23): do dojis help predict the turnovers the box warns of?
// What about volume nodes, levels, settlement / VWAP, pivot points?
//
// - Data: 2026 New York minutes (closes 08:30-14:55 CT), the latest bars (to Oct 30), halves
//   Jan-Jun and Jul-Oct. Every event is read as a call that the move is turning.
// - The race: from the event minute's close, does price go R the called way before R the other
//   way (by 15:05; a minute reaching both counts against)? R = 0.064% and 0.1275% of the real
//   price, about 18 and 37 points in 2026 (the swing sizes of databox_swings.mjs).
// - The baseline: every New York minute, calling a turn against the last 5 minutes' move
//   (a fade). An event's edge is its win rate less that fade's in the same half.
// - Events, each with the way it calls the turn:
//     doji 1m / 5m      body at most a tenth of the bar's range (5m: read at the 5-minute close);
//                       calls against the last 5 minutes (5m: the last 15)
//     level touch       the minute's range reaches a level as it stood the minute before;
//                       from above calls up (a bounce), from below calls down. Pools of the
//                       level catalog (research/levels_catalog.mjs): volume nodes, prior-day
//                       high/low, overnight high/low, settlement (prior-day close), VWAP,
//                       floor pivots, Camarilla, round 100/50
//     box warning       the minute a row turns Potentially long (calls up) or short (down):
//                       1m MACD, 1m EMA, 5m MACD (the indicator's own code)
//     together          a box warning in a minute with a doji, or with a level touch in it or
//                       the 2 minutes before; a doji at a level touch
// - Against 100 placebo markets (real bars, each minute's direction flipped at random: a doji
//   stays a doji; levels and the box rebuilt on the path). The question is whether an event's
//   edge beats the edge the same event gets on markets with nothing in them.

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import { buildCatalog } from "./levels_catalog.mjs";
import { rawOffsets, sessionsOf } from "../src/levels.mjs";
import { resample } from "../src/resample.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), pi = args.indexOf("--placebos"), yi = args.indexOf("--year");
const PLACEBOS = pi >= 0 ? Number(args[pi + 1]) : 100, YEAR = yi >= 0 ? Number(args[yi + 1]) : 2026;
const MIN = 60000, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, RS = [0.00064, 0.001275];
// --year Y reads another year (its halves Jan-Jun and Jul-Dec): 2025 checks what 2026 turned up
const FROM = Date.UTC(YEAR, 0, 1), TO = YEAR === 2026 ? Date.UTC(2026, 9, 31) : Date.UTC(YEAR + 1, 0, 1), H2 = Date.UTC(YEAR, 6, 1);
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

const POOLS = {
  "volume nodes": ["PD POC (RTH)", "PD POC (full session)", "VP5 POC", "VP20 POC", "VP5 HVN", "VP20 HVN"],
  "prior-day high/low": ["PD high", "PD low"],
  "overnight high/low": ["Overnight high", "Overnight low"],
  "settlement": ["PD close"],
  "VWAP": ["VWAP (RTH)", "VWAP (session)"],
  "floor pivots": ["Floor P", "Floor R1", "Floor S1", "Floor R2", "Floor S2"],
  "Camarilla": ["Camarilla H3", "Camarilla L3", "Camarilla H4", "Camarilla L4"],
  "round 100/50": ["Round 100", "Round 50"],
};
const POOL_NAMES = Object.keys(POOLS);

// ── the box ──
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
function boxStates(T, minutes) {
  const run = new Run(BOX, { minutes, check: false }), map = run.calc.map.bind(run.calc);
  const n = T.close.length, ema = new Int8Array(n), macd = new Int8Array(n);
  run.calc.map = (d, i) => { const out = map(d, i), S = run.calc.st[i]; ema[i] = code(S.ema, S.emaReady); macd[i] = code(S.macd, S.macdReady); return out; };
  run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
  return { ema, macd };
}

// ── events ──
const EVENTS = ["doji 1m", "doji 5m", ...POOL_NAMES.map((p) => `touch: ${p}`), "touch: any of these",
  "box: 1m MACD Pot.", "box: 1m EMA Pot.", "box: 5m MACD Pot.",
  "1m MACD Pot. + doji 1m", "1m MACD Pot. + level touch", "1m EMA Pot. + doji 1m", "1m EMA Pot. + level touch", "doji 1m at a level touch"];
const NEV = EVENTS.length, EV = Object.fromEntries(EVENTS.map((e, k) => [e, k]));

function measure(sample) {
  const b = sample.b, N = b.close.length, TS = b.ts, O = b.open, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const cat = buildCatalog(sample), byTag = new Map(cat.map((c) => [c.tag, c]));
  // per minute: which pools were touched, and from which side (+1 calls up)
  const touch = POOL_NAMES.map(() => new Int8Array(N));
  POOL_NAMES.forEach((pool, q) => {
    for (const tag of POOLS[pool]) {
      const c = byTag.get(tag);
      if (!c) throw new Error(`no level "${tag}" in the catalog`);
      const series = c.series || [];
      for (const s of series) for (let i = 1; i < N; i++) {
        const lv = s[i - 1];
        if (!Number.isFinite(lv) || !(L[i] <= lv && lv <= H[i])) continue;
        const from = C[i - 1] > lv ? 1 : C[i - 1] < lv ? -1 : 0;
        if (from) touch[q][i] = from;
      }
      if (c.list) {   // round numbers: a list of prices per session day
        for (const d of sample.days) {
          const prices = c.list(d);
          for (let i = d.a; i <= d.z; i++) for (const lv of prices) if (L[i] <= lv && lv <= H[i]) { const from = C[i - 1] > lv ? 1 : C[i - 1] < lv ? -1 : 0; if (from) touch[q][i] = from; }
        }
      }
    }
  });
  // the box, 1m and 5m (5m at the last closed 5-minute bar)
  const s1 = boxStates(b, 1), b5 = resample(b, 5), s5 = boxStates(b5, 5), m5 = new Int8Array(N), close5 = new Uint8Array(N), d5 = new Int8Array(N);
  let k5 = -1;
  for (let i = 0; i < N; i++) {
    while (k5 + 1 < b5.ts.length && b5.ts[k5 + 1] + 5 * MIN <= TS[i] + MIN) k5++;
    m5[i] = k5 >= 0 ? s5.macd[k5] : 0;
    if (k5 >= 0 && b5.ts[k5] + 5 * MIN === TS[i] + MIN) {
      close5[i] = 1;
      const rg = b5.high[k5] - b5.low[k5];
      if (rg > 0 && Math.abs(b5.close[k5] - b5.open[k5]) <= 0.1 * rg && k5 >= 3) { const mv = b5.close[k5] - b5.close[k5 - 3]; d5[i] = mv > 0 ? -1 : mv < 0 ? 1 : 0; }
    }
  }
  const potCall = (a, z) => (z === 4 && a !== 4 ? 1 : z === 2 && a !== 2 ? -1 : 0);
  // tallies: [half][event][R] wins and n; baseline per [half][R]
  const W = new Float64Array(2 * NEV * 2), Nn = new Float64Array(2 * NEV * 2), BW = new Float64Array(4), BN = new Float64Array(4);
  const race = new Int8Array(2 * 2);   // per R, per called way (0 up, 1 down): 1 win, -1 lose, 0 neither by 15:05
  for (let i = 5; i + 1 < N; i++) {
    const ms = TS[i];
    if (ms < FROM || ms >= TO) continue;
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i]) continue;
    const h = ms < H2 ? 0 : 1, raw = C[i] - off[i], P = C[i];
    for (let r = 0; r < 2; r++) {
      const R = RS[r] * raw;
      let res = [0, 0];
      for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
        const up = H[j] - P >= R, dn = P - L[j] >= R;
        if (!res[0] && (up || dn)) res[0] = dn ? -1 : 1;     // called up: down first (or both) loses
        if (!res[1] && (up || dn)) res[1] = up ? -1 : 1;     // called down
        if (res[0] && res[1]) break;
      }
      race[r * 2] = res[0]; race[r * 2 + 1] = res[1];
    }
    const won = (call, r) => race[r * 2 + (call === 1 ? 0 : 1)] === 1;
    const mv5 = C[i] - C[i - 5], fade = mv5 > 0 ? -1 : mv5 < 0 ? 1 : 0;
    if (fade) for (let r = 0; r < 2; r++) { BN[h * 2 + r]++; if (won(fade, r)) BW[h * 2 + r]++; }
    const add = (e, call) => { if (!call) return; for (let r = 0; r < 2; r++) { const x = (h * NEV + e) * 2 + r; Nn[x]++; if (won(call, r)) W[x]++; } };
    const rg = H[i] - L[i], doji1 = rg > 0 && Math.abs(C[i] - O[i]) <= 0.1 * rg ? fade : 0;
    add(EV["doji 1m"], doji1);
    add(EV["doji 5m"], d5[i]);
    let anyTouch = 0, recentTouch = 0;
    POOL_NAMES.forEach((pool, q) => { const t = touch[q][i]; add(EV[`touch: ${pool}`], t); if (t && !anyTouch) anyTouch = t; });
    add(EV["touch: any of these"], anyTouch);
    for (let k = i; k >= i - 2 && !recentTouch; k--) for (let q = 0; q < POOL_NAMES.length && !recentTouch; q++) recentTouch = touch[q][k];
    const pm = potCall(s1.macd[i - 1], s1.macd[i]), pe = potCall(s1.ema[i - 1], s1.ema[i]), p5 = potCall(m5[i - 1], m5[i]);
    add(EV["box: 1m MACD Pot."], pm); add(EV["box: 1m EMA Pot."], pe); add(EV["box: 5m MACD Pot."], p5);
    add(EV["1m MACD Pot. + doji 1m"], pm && doji1 ? pm : 0);
    add(EV["1m MACD Pot. + level touch"], pm && recentTouch === pm ? pm : 0);
    add(EV["1m EMA Pot. + doji 1m"], pe && doji1 ? pe : 0);
    add(EV["1m EMA Pot. + level touch"], pe && recentTouch === pe ? pe : 0);
    add(EV["doji 1m at a level touch"], doji1 && anyTouch === doji1 ? doji1 : 0);
  }
  // edge per event, R, half and both halves: win rate less the fade's
  const out = [];
  for (let e = 0; e < NEV; e++) {
    const row = {};
    for (let r = 0; r < 2; r++) {
      let w = 0, n = 0, bw = 0, bn = 0;
      for (let h = 0; h < 2; h++) {
        const x = (h * NEV + e) * 2 + r, n1 = Nn[x], w1 = W[x], base = BW[h * 2 + r] / BN[h * 2 + r];
        row[`n${r}h${h}`] = n1; row[`win${r}h${h}`] = n1 ? w1 / n1 : NaN; row[`edge${r}h${h}`] = n1 ? w1 / n1 - base : NaN;
        w += w1; n += n1; bw += base * n1; bn += n1;
      }
      row[`n${r}`] = n; row[`win${r}`] = n ? w / n : NaN; row[`edge${r}`] = n ? (w - bw) / n : NaN;
    }
    out.push(row);
  }
  const base = [0, 1].map((r) => (BW[r] + BW[2 + r]) / (BN[r] + BN[2 + r]));
  return { out, base };
}

const real = Lab.loadSample({ file: "data/mnq_1m_beta.bin", from: FROM, to: TO });
const R = measure(real);
process.stderr.write(`  real market: ${secs()}s\n`);
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  pl.push(measure({ ...real, b: Lab.placeboBars(real.b, 4400 + p) }).out);
  if ((p + 1) % 5 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
}

const pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1) : "—"), sg = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (100 * x).toFixed(1) : "—");
const rank = (e, key) => { const v = R.out[e][key], zs = pl.map((o) => o[e][key]).filter(Number.isFinite); return zs.length ? zs.filter((z) => z >= v).length : NaN; };
const plMed = (e, key) => { const zs = pl.map((o) => o[e][key]).filter(Number.isFinite).sort((a, b) => a - b); return zs.length ? zs[zs.length >> 1] : NaN; };
console.log(`${YEAR} New York minutes, ${YEAR === 2026 ? "Jan 1 - Oct 30" : "the whole year"}; ${PLACEBOS} placebo markets; ${secs()}s`);
console.log(`Fade baseline (any minute, against the last 5 minutes): wins the 18-point race ${pc(R.base[0])}%, the 37-point ${pc(R.base[1])}%`);
for (let r = 0; r < 2; r++) {
  console.log(`\n${r ? "37" : "18"}-point race: win rate, edge over the fade (points of win rate), placebo markets' median edge, placebo markets as high (of ${PLACEBOS}); by half`);
  console.log(`${"event".padEnd(30)}${"n".padStart(7)}${"win".padStart(7)}${"edge".padStart(7)}${"placebo".padStart(9)}${"as high".padStart(9)}${"Jan-Jun edge".padStart(14)}${"as high".padStart(9)}${"Jul-Oct edge".padStart(14)}${"as high".padStart(9)}`);
  EVENTS.forEach((name, e) => {
    const o = R.out[e];
    console.log(`${name.padEnd(30)}${String(o[`n${r}`]).padStart(7)}${pc(o[`win${r}`]).padStart(7)}${sg(o[`edge${r}`]).padStart(7)}${sg(plMed(e, `edge${r}`)).padStart(9)}${String(rank(e, `edge${r}`)).padStart(9)}${sg(o[`edge${r}h0`]).padStart(14)}${String(rank(e, `edge${r}h0`)).padStart(9)}${sg(o[`edge${r}h1`]).padStart(14)}${String(rank(e, `edge${r}h1`)).padStart(9)}`);
  });
}
console.log(`\n(${secs()}s)`);
fs.writeFileSync(`research/turn_context${YEAR === 2026 ? "" : "_" + YEAR}_results.json`, JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS, events: EVENTS, pools: POOLS, real: R, placebo: pl }, null, 1));
console.log("wrote research/turn_context_results.json");
