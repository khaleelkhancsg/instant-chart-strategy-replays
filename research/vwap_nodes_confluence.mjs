// Do VWAP and volume nodes add confidence to the databox's signals? Each signal split by its VWAP and
// volume-node context, with and without, against placebo markets.
//
//   node --max-old-space-size=16384 research/vwap_nodes_confluence.mjs [--year 2026|2025] [--placebos N]
//
// RESULT: (written after the runs)
//
// The person's question (2026-11-23): volume nodes and VWAP showed little alone, but they may raise
// confidence in a trade, or add confluence to the box's Potentially readings.
//
// - Signals (each a call with a direction), New York minutes 08:30-14:55 CT:
//     1m MACD Pot., 1m EMA Pot., 5m MACD Pot., 5m EMA Pot.   the minute a row turns Potentially long
//                                                           (calls up) or short (calls down)
//     1m box both Long / Short                               both 1m rows turn one way (calls that way)
//     lead short                                             1m EMA turns Pot. short while the 5m EMA reads
//                                                           Pot. long (databox_room.mjs's reverse lead)
// - Context, each yes or no for the signal's direction (VWAP = RTH VWAP; nodes = prior-day POC (RTH
//   and full session), 5- and 20-session POC and HVN; A = 5-minute ATR 14):
//     toward VWAP        the call points toward VWAP
//     stretched          price more than 1 A from VWAP, the call toward it
//     VWAP slope agrees  VWAP rose (or fell) over the last 15 minutes the call's way
//     session VWAP side  as "toward VWAP", with the 17:00 session's VWAP
//     at a node          a node within 0.25 A of the price
//     node in the way    a node between the price and 0.064% of the price the call's way (the 18-pt target)
//     broke through      price crossed a node or VWAP the call's way in the last 5 minutes
//     back into value    price outside the prior day's RTH value area, the call back toward it
// - The race (turn_context.mjs): R = 0.064% / 0.1275% of the real price (18 / 37 points in 2026) the
//   called way before the other way, by 15:05.
// - Each split's reading: win rate with the context less win rate without, for that signal. Against
//   100 placebo markets (real bars, directions flipped, every line rebuilt): a context that helps
//   beats the placebo markets' same split. Both halves of the year.
// - Named before the run: all 8 contexts x 6 signals x 2 races on 2026; whatever beats 95 of 100
//   placebo markets in both halves is then read on 2025 with no change.

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import { buildCatalog } from "./levels_catalog.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { resample } from "../src/resample.mjs";
import { atr } from "../src/indicators.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const PLACEBOS = arg("--placebos", 100), YEAR = arg("--year", 2026);
const MIN = 60000, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, RS = [0.00064, 0.001275];
const FROM = Date.UTC(YEAR, 0, 1), TO = YEAR === 2026 ? Date.UTC(2026, 9, 31) : Date.UTC(YEAR + 1, 0, 1), H2 = Date.UTC(YEAR, 6, 1);
const NODES = ["PD POC (RTH)", "PD POC (full session)", "VP5 POC", "VP20 POC", "VP5 HVN", "VP20 HVN"];
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
function boxStates(T, minutes) {
  const run = new Run(BOX, { minutes, check: false }), map = run.calc.map.bind(run.calc);
  const n = T.close.length, ema = new Int8Array(n), macd = new Int8Array(n);
  run.calc.map = (d, i) => { const out = map(d, i), S = run.calc.st[i]; ema[i] = code(S.ema, S.emaReady); macd[i] = code(S.macd, S.macdReady); return out; };
  run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
  return { ema, macd };
}

const SIGNALS = ["1m MACD Pot.", "1m EMA Pot.", "5m MACD Pot.", "5m EMA Pot.", "1m box both", "lead short"];
const CONTEXTS = ["toward VWAP", "stretched", "VWAP slope agrees", "session VWAP side", "at a node", "node in the way", "broke through", "back into value"];
const NSG = SIGNALS.length, NCX = CONTEXTS.length;

function measure(sample) {
  const b = sample.b, N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const cat = new Map(buildCatalog(sample).map((c) => [c.tag, c]));
  const tr = (tag) => { const c = cat.get(tag); if (!c || !c.series) throw new Error(`no level ${tag}`); return c.series[0]; };
  const vw = tr("VWAP (RTH)"), vws = tr("VWAP (session)"), vah = tr("PD VAH (RTH)"), val = tr("PD VAL (RTH)");
  const nodes = NODES.map((t) => cat.get(t)).flatMap((c) => c.series);
  const s1 = boxStates(b, 1), b5 = resample(b, 5), s5 = boxStates(b5, 5), a5 = atr(b5.high, b5.low, b5.close, 14);
  const e5 = new Int8Array(N), m5 = new Int8Array(N), A = new Float64Array(N);
  let k5 = -1;
  for (let i = 0; i < N; i++) {
    while (k5 + 1 < b5.ts.length && b5.ts[k5 + 1] + 5 * MIN <= TS[i] + MIN) k5++;
    e5[i] = k5 >= 0 ? s5.ema[k5] : 0; m5[i] = k5 >= 0 ? s5.macd[k5] : 0; A[i] = k5 >= 0 ? a5[k5] : NaN;
  }
  const side = (c) => (c === 1 || c === 2 ? 1 : c === 3 || c === 4 ? -1 : 0);
  const pot = (a, z) => (z === 4 && a !== 4 ? 1 : z === 2 && a !== 2 ? -1 : 0);
  // tallies [half][signal][context][with 1/0][race]: n and wins
  const T = new Float64Array(2 * NSG * NCX * 2 * 2 * 2);
  const at = (h, s, c, w, r, k) => ((((h * NSG + s) * NCX + c) * 2 + w) * 2 + r) * 2 + k;
  const race = [0, 0, 0, 0];
  for (let i = 15; i + 1 < N; i++) {
    const ms = TS[i];
    if (ms < FROM || ms >= TO) continue;
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i] || !(A[i] > 0)) continue;
    const calls = [
      pot(s1.macd[i - 1], s1.macd[i]), pot(s1.ema[i - 1], s1.ema[i]), pot(m5[i - 1], m5[i]), pot(e5[i - 1], e5[i]),
      (() => { const both = (k, d) => side(s1.ema[k]) === d && side(s1.macd[k]) === d; return both(i, 1) && !both(i - 1, 1) ? 1 : both(i, -1) && !both(i - 1, -1) ? -1 : 0; })(),
      s1.ema[i] === 2 && s1.ema[i - 1] !== 2 && e5[i] === 4 ? -1 : 0,
    ];
    if (!calls.some((x) => x)) continue;
    const P = C[i], raw = P - off[i], h = ms < H2 ? 0 : 1, a = A[i];
    for (let r = 0; r < 2; r++) {
      const R = RS[r] * raw, res = [0, 0];
      for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
        const up = H[j] - P >= R, dn = P - L[j] >= R;
        if (!res[0] && (up || dn)) res[0] = dn ? -1 : 1;
        if (!res[1] && (up || dn)) res[1] = up ? -1 : 1;
        if (res[0] && res[1]) break;
      }
      race[r * 2] = res[0]; race[r * 2 + 1] = res[1];
    }
    const R18 = RS[0] * raw;
    for (let s = 0; s < NSG; s++) {
      const d = calls[s];
      if (!d) continue;
      const v = vw[i], vs = vws[i];
      const near = nodes.some((t) => Number.isFinite(t[i]) && Math.abs(t[i] - P) <= 0.25 * a);
      const inWay = nodes.some((t) => Number.isFinite(t[i]) && d * (t[i] - P) > 0.25 * a && d * (t[i] - P) < R18);
      let broke = false;
      for (const t of [...nodes, vw]) {
        const lv = t[i - 5];
        if (Number.isFinite(lv) && d * (C[i - 5] - lv) < 0 && d * (P - lv) > 0) { broke = true; break; }
      }
      const cx = [
        Number.isFinite(v) && d * (v - P) > 0,
        Number.isFinite(v) && d * (v - P) > a,
        Number.isFinite(v) && Number.isFinite(vw[i - 15]) && d * (v - vw[i - 15]) > 0,
        Number.isFinite(vs) && d * (vs - P) > 0,
        near, inWay, broke,
        Number.isFinite(vah[i]) && Number.isFinite(val[i]) && ((P > vah[i] && d === -1) || (P < val[i] && d === 1)),
      ];
      for (let c = 0; c < NCX; c++) for (let r = 0; r < 2; r++) {
        const w = cx[c] ? 1 : 0, won = race[r * 2 + (d === 1 ? 0 : 1)] === 1;
        T[at(h, s, c, w, r, 0)]++; if (won) T[at(h, s, c, w, r, 1)]++;
      }
    }
  }
  // per signal, context, race: lift (win with - win without), overall and by half; and n with
  const out = [];
  for (let s = 0; s < NSG; s++) for (let c = 0; c < NCX; c++) {
    const row = { s, c };
    for (let r = 0; r < 2; r++) {
      const rate = (hs, w) => { let n = 0, k = 0; for (const h of hs) { n += T[at(h, s, c, w, r, 0)]; k += T[at(h, s, c, w, r, 1)]; } return { n, p: n ? k / n : NaN }; };
      const y = rate([0, 1], 1), x = rate([0, 1], 0);
      row[`n${r}`] = y.n; row[`win${r}`] = y.p; row[`lift${r}`] = y.p - x.p;
      for (const h of [0, 1]) row[`lift${r}h${h}`] = rate([h], 1).p - rate([h], 0).p;
    }
    out.push(row);
  }
  return out;
}

const real = Lab.loadSample({ file: "data/mnq_1m_beta.bin", from: FROM, to: TO });
const R = measure(real);
process.stderr.write(`  real market: ${secs()}s\n`);
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  pl.push(measure({ ...real, b: Lab.placeboBars(real.b, 5500 + p) }));
  if ((p + 1) % 5 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
}
const pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1) : "—"), sg = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (100 * x).toFixed(1) : "—");
const high = (k, key) => { const v = R[k][key]; if (!Number.isFinite(v)) return "—"; const zs = pl.map((o) => o[k][key]).filter(Number.isFinite); return String(zs.filter((z) => z >= v).length); };
const low = (k, key) => { const v = R[k][key]; if (!Number.isFinite(v)) return "—"; const zs = pl.map((o) => o[k][key]).filter(Number.isFinite); return String(zs.filter((z) => z <= v).length); };
console.log(`${YEAR} New York minutes; ${PLACEBOS} placebo markets; ${secs()}s`);
console.log(`lift = win rate with the context less without (points of win rate); "as high": placebo markets whose same lift was as high; "as low": as low (a context that hurts)`);
const flagged = [];
for (let r = 0; r < 2; r++) {
  console.log(`\n${r ? "37" : "18"}-point race`);
  console.log(`${"signal".padEnd(14)}${"context".padEnd(20)}${"n with".padStart(7)}${"win".padStart(7)}${"lift".padStart(7)}${"as high".padStart(9)}${"as low".padStart(8)}${"H1 lift".padStart(9)}${"high".padStart(6)}${"H2 lift".padStart(9)}${"high".padStart(6)}`);
  R.forEach((o, k) => {
    const hi = high(k, `lift${r}`), h1 = high(k, `lift${r}h0`), h2 = high(k, `lift${r}h1`), lo = low(k, `lift${r}`), l1 = low(k, `lift${r}h0`), l2 = low(k, `lift${r}h1`);
    const mark = Number(h1) <= 5 && Number(h2) <= 5 ? " <- helps, both halves" : Number(l1) <= 5 && Number(l2) <= 5 ? " <- hurts, both halves" : "";
    if (mark) flagged.push(`${SIGNALS[o.s]} / ${CONTEXTS[o.c]} / ${r ? 37 : 18}-pt${mark}`);
    console.log(`${SIGNALS[o.s].padEnd(14)}${CONTEXTS[o.c].padEnd(20)}${String(o[`n${r}`]).padStart(7)}${pc(o[`win${r}`]).padStart(7)}${sg(o[`lift${r}`]).padStart(7)}${hi.padStart(9)}${lo.padStart(8)}${sg(o[`lift${r}h0`]).padStart(9)}${h1.padStart(6)}${sg(o[`lift${r}h1`]).padStart(9)}${h2.padStart(6)}${mark}`);
  });
}
console.log(`\nbeyond 95 of ${PLACEBOS} placebo markets in both halves: ${flagged.length ? "\n  " + flagged.join("\n  ") : "none"}`);
console.log(`(${secs()}s)`);
fs.writeFileSync(`research/vwap_nodes_confluence${YEAR === 2026 ? "" : "_" + YEAR}_results.json`, JSON.stringify({ run: new Date().toISOString(), year: YEAR, placebos: PLACEBOS, signals: SIGNALS, contexts: CONTEXTS, nodes: NODES, real: R, flagged, placebo: pl }, null, 1));
