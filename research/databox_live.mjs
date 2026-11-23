// The databox read live, from the forming bar, against the box read at bar close.
//
//   node --max-old-space-size=16384 research/databox_live.mjs [--placebos N] [--plant BP]
//
// RESULT (2026-11-23; 100 placebo markets, 115 minutes): reading the box live adds nothing.
// - Live flips are mostly noise: 60% of 2026's were no longer true when their minute closed.
//   Read live, the box took 4.16 billion trades a market, against 1.28 billion at the close.
// - Live against close, strategy by strategy (gain, 2026, points a trade, placebo median):
//   5m live +0.0003 (+0.0011); worst -0.111 (-0.112); middle +0.0007 (+0.0008); best +0.104
//   (+0.106). Each is what the method gives on random markets.
// - The picks, 2019-2025 read on 2026 (t by session, placebo markets as high):
//     close -1.7 (96/100); 5m live -0.7 (75); worst -0.1 (56); middle 0.1 (53); best 7.6 (4).
//   Roomy exits only: 72, 64, 52, 51, 4 of 100. Jan-Jun read on Jul-Oct: 58, 56, 79, 78, 59.
// - Only "best" stands out, at the 96th percentile, and its own assumption makes most of it: on
//   random markets its picks score a median t of 5.9 (95th percentile 7.5, highest 8.3). Its picks
//   fade a live 1m MACD flip, credited with the whole minute's wick after the entry. The middle
//   reading, which takes the likelier order, finds nothing (53 of 100). Settling the order inside
//   the minute needs second-by-second bars.
//
// The person's question (2026-11-23), once the Tradovate box updated with each tick:
// research/databox_room.mjs read the box at bar close; check the forming bar as well.
//
// The same 1,248 entries (the 624 state combinations of the box's four rows, long and short) and
// the same 144 exits as databox_room.mjs, read five ways:
//   close       as databox_room.mjs: the 1m rows at each 1-minute close, the 5m rows from the last
//               closed 5-minute bar. In at the 1-minute close.
//   5m live     the 5m rows from the forming 5-minute bar, read at each 1-minute close: the box on
//               a 5-minute chart, now live, looked at once a minute. In at the 1-minute close.
//               Exact on 1-minute bars.
//   live worst  every row from its forming bar, at every price inside each 1-minute bar: the box
//   live middle on 1- and 5-minute charts, read tick by tick. In where the combination turns true.
//   live best
// Inside a minute only its open, high, low and close are known, and that is enough to find the
// entry. A row's histogram is a straight line in the forming bar's price (every EMA in it is), so
// the prices at which a row changes state are exact, and a combination is true over one range of
// prices. Price passes every price between the minute's low and high, so whether a combination
// turned true in the minute, and at what price, is known: at the open, or where price first
// reached the range (on the tick grid). What came after the entry in the same minute is half known.
// Entered on the way up, the minute's high came after the entry, but its low may have come before.
// "worst" takes the unknown extreme as coming after the entry when it hurts the trade and before
// when it would help; "best" the reverse. The truth is between. "middle" takes it as coming before
// the entry: entered on the way up, the minute's low came first, then the rise through the entry.
// In all three, a minute reaching the target and the stop counts as the stop. (Added after a first
// run with two placebo markets, whose "best" picks scored t 7 out of sample: an assumption that
// credits a fade with the whole minute's wick makes its own edge.) A
// combination still true from the minute before is not counted again if it flickers off and on
// inside the minute, since the order is unknown.
// - Units, costs, the every-minute line (in at each minute's close), t by session and the readings
//   (all, room, inside, persist) as databox_room.mjs, for each reading. Named before the run:
//     gain     each strategy's 2026 excess a trade read live, less read at close, averaged over
//              every strategy with 100 trades in 2026 both ways, against placebo markets. On a
//              placebo market an earlier entry gains nothing, so its gain is the method's own lean;
//              the real market's gain beyond that is what reading live adds.
// - Checked as it runs: the straight lines give the indicator's own state at every 1-minute close,
//   and the forming 5-minute rows their closed state at every 5-minute close; first passages by
//   binary search equal databox_room.mjs's scan; 5m live equals close on every combination
//   without a 5m row; the session store equals the accumulators.
// - --plant BP adds BP to every trade of "1m EMA Long" long, in every reading, on the real market: the
//   check that each reading finds an edge when there is one. It writes no file.
// - research/databox_live_results.json: every reading, the picks, and every placebo market's.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { atr } from "../src/indicators.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const PLACEBOS = opt("--placebos", 100), PLANT = opt("--plant", 0);
const MIN = 60000, TICK = 0.25, COST = 1.25, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55;
const Y0 = 2019, NY = 8, NS = 10, H2 = Date.UTC(2026, 6, 1), PICK = 10;
const LEVELS = [0.5, 1, 2, 3, 5], NL = LEVELS.length;                  // ATR multiples; index NL = none
const LIMITS = [15, 40, 120, Infinity], NLIM = LIMITS.length;           // minutes; Infinity = 15:05
const EXITS = [];
for (let ti = 0; ti <= NL; ti++) for (let si = 0; si <= NL; si++) for (let li = 0; li < NLIM; li++) EXITS.push({ ti, si, li });
const NE = EXITS.length;
const lvl = (k) => (k === NL ? "none" : `${LEVELS[k]} ATR`);
const exitName = (e) => `target ${lvl(EXITS[e].ti)}, stop ${lvl(EXITS[e].si)}, ${LIMITS[EXITS[e].li] === Infinity ? "to 15:05" : `${LIMITS[EXITS[e].li]} min`}`;
const ROOMY = (e) => (EXITS[e].si >= 2) && LIMITS[EXITS[e].li] >= 40;
const V = ["close", "5m live", "live worst", "live middle", "live best"], NV = V.length;
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

// ── the box, its states, and each bar's rows as straight lines in the forming bar's price ──
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
const emaRule = (v) => (v === false || v === "off" ? "off" : v === "closer" ? "shrink" : "speed");     // as the indicator reads its settings
const macdRule = (v) => (v === false || v === "off" ? "off" : "shrink");
// An EMA after one more value x, as a + b x, from its state on the bar before (the indicator's emaStep).
const emaLin = (prev, n) => (!prev ? [0, 1] : prev.count < n ? [prev.total / (prev.count + 1), 1 / (prev.count + 1)] : [prev.v * (1 - 2 / (n + 1)), 2 / (n + 1)]);
// A row whose histogram on this bar is a + b p (p the forming bar's price, b > 0): where it crosses
// zero, and where it starts to warn (the indicator's rowStep): on the long side below wl, on the
// short side above ws.
function rowLines(a, b, pr, rule, thr, o) {
  let wl = -Infinity, ws = Infinity;
  if (pr && rule === "shrink") wl = ws = (pr.diff - a) / b;
  else if (pr && rule === "speed" && Number.isFinite(pr.move)) { wl = (pr.diff + Math.min(0, pr.move) - a) / b; ws = (pr.diff + Math.max(0, pr.move) - a) / b; }
  thr[o] = -a / b; thr[o + 1] = wl; thr[o + 2] = ws;
}
function boxRun(T, minutes) {
  const run = new Run(BOX, { minutes, check: false }), map = run.calc.map.bind(run.calc), P = run.calc.props;
  const n = T.close.length, codes = new Int8Array(n * 2), thr = new Float64Array(n * 6), rdy = new Uint8Array(n * 2);
  const er = emaRule(P.emaWarning), mr = macdRule(P.macdWarning);
  run.calc.map = (d, i) => {
    const out = map(d, i), st = run.calc.st, S = st[i], pv = i > 0 ? st[i - 1] : null;
    codes[i * 2] = code(S.ema, S.emaReady); codes[i * 2 + 1] = code(S.macd, S.macdReady);
    const [af, bf] = emaLin(pv && pv.ef, P.emaFast), [as, bs] = emaLin(pv && pv.es, P.emaSlow);
    rowLines(af - as, bf - bs, pv && pv.ema, er, thr, i * 6);
    rdy[i * 2] = S.emaReady && bf - bs > 0 ? 1 : 0;
    if (S.sg) {
      const [am, bm] = emaLin(pv && pv.mf, P.macdFast), [an, bn] = emaLin(pv && pv.ms, P.macdSlow), [ag, bg] = emaLin(pv && pv.sg, P.macdSignal);
      const b = (1 - bg) * (bm - bn);                                    // histogram = line - signal = (1 - bg) line - ag
      rowLines((1 - bg) * (am - an) - ag, b, pv && pv.macd, mr, thr, i * 6 + 3);
      rdy[i * 2 + 1] = S.macdReady && b > 0 ? 1 : 0;
    }
    return out;
  };
  run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
  return { codes, thr, rdy };
}
// A row's state at price p, from its lines (-1 exactly on the zero line, where it keeps its side).
function stateAt(thr, o, ready, p) {
  if (!ready) return 0;
  const p0 = thr[o];
  if (p > p0) return p < thr[o + 1] ? 2 : 1;
  if (p < p0) return p > thr[o + 2] ? 4 : 3;
  return -1;
}
// The prices at which a row reads state s, into out[q], out[q + 1] (lo > hi: none).
function band(thr, o, s, out, q) {
  const p0 = thr[o], wl = thr[o + 1], ws = thr[o + 2];
  if (s === 1) { out[q] = Math.max(p0, wl); out[q + 1] = Infinity; }
  else if (s === 2) { out[q] = wl > p0 ? p0 : Infinity; out[q + 1] = wl; }
  else if (s === 3) { out[q] = -Infinity; out[q + 1] = Math.min(p0, ws); }
  else { out[q] = ws; out[q + 1] = ws < p0 ? p0 : -Infinity; }
}

// ── the combinations ──
const ROWS = ["1m EMA", "1m MACD", "5m EMA", "5m MACD"], STATES = ["", "Long", "Pot. short", "Short", "Pot. long"];
const COMBOS = [];
for (let mask = 1; mask < 16; mask++) {
  const rows = [0, 1, 2, 3].filter((r) => (mask >> r) & 1);
  const assign = (k, acc) => { if (k === rows.length) { COMBOS.push(acc.slice()); return; } for (let s = 1; s <= 4; s++) { acc.push([rows[k], s]); assign(k + 1, acc); acc.pop(); } };
  assign(0, []);
}
const NC = COMBOS.length, NCELL = 625, NK = NC * 2;
const digit = (cell, r) => Math.floor(cell / 5 ** r) % 5;
const MATCH = new Uint8Array(NC * NCELL);
COMBOS.forEach((c, k) => { for (let cell = 0; cell < NCELL; cell++) MATCH[k * NCELL + cell] = c.every(([r, s]) => digit(cell, r) === s) ? 1 : 0; });
const PAIRS = COMBOS.map((c) => c.map(([r, s]) => r * 4 + s - 1)), REQ = PAIRS.map((ps) => ps.reduce((m, q) => m | (1 << q), 0));
const ONLY1M = COMBOS.map((c) => c.every(([r]) => r < 2));
const labelOf = (k) => COMBOS[k].map(([r, s]) => `${ROWS[r]} ${STATES[s]}`).join(" + ");

// 2026 session by session for each reading, for reading a set of picks as one book. Refilled by
// each market's measure(); read a market before measuring the next.
const CAP26 = 230;
const S26A = Array.from({ length: NV }, () => new Float32Array(CAP26 * NK * NE)), S26M = Array.from({ length: NV }, () => new Float32Array(CAP26 * NK));
const S26B = new Float64Array(CAP26 * 2 * NE), S26N = new Float64Array(CAP26), S26H = new Int8Array(CAP26);

// ── one market ──
const SA = NC * NS * 2, SB = NS * 2;
const RM = new Float64Array(512), RN = new Float64Array(512), CL = new Float64Array(512);   // forward: running high, running low, close
const LIMC = new Float64Array(NLIM), LIMT = new Int32Array(NLIM), UP = new Int32Array(NL), DN = new Int32Array(NL);
let FM = 0;
const firstUp = (E, x) => { if (!(RM[FM] - E >= x)) return 0; let a = 1, b = FM; while (a < b) { const m = (a + b) >> 1; if (RM[m] - E >= x) b = m; else a = m + 1; } return a; };
const firstDn = (E, x) => { if (!(E - RN[FM] >= x)) return 0; let a = 1, b = FM; while (a < b) { const m = (a + b) >> 1; if (E - RN[m] >= x) b = m; else a = m + 1; } return a; };
// Every exit's net bp for a trade in at E, long (out[e]) and short (out[NE + e]): worst into outW,
// middle into outM, best into outB. mode 0: in at the minute's close; 1: at its open, all of the
// minute after; 2: on the way up (its high came after the entry, its low maybe before); 3: on the
// way down (its low after, its high maybe before).
function outcomes(E, mode, Hb, Lb, Cb, unit, raw, outW, outM, outB) {
  const toBp = 1e4 / raw, cost = COST * toBp;
  for (let k = 0; k < NL; k++) { const x = LEVELS[k] * unit; UP[k] = firstUp(E, x); DN[k] = firstDn(E, x); }
  for (let d = 0; d < 2; d++) {
    let favW = -Infinity, advW = -Infinity, favM = -Infinity, advM = -Infinity, favB = -Infinity, advB = -Infinity;
    if (mode) {
      let hiW = Hb, hiB = Hb, loW = Lb, loB = Lb, hiM = Hb, loM = Lb;
      if (mode === 2) { const lo2 = Math.min(E, Cb); loM = lo2; if (d === 0) loB = lo2; else loW = lo2; }
      else if (mode === 3) { const hi2 = Math.max(E, Cb); hiM = hi2; if (d === 0) hiW = hi2; else hiB = hi2; }
      if (d === 0) { favW = hiW - E; advW = E - loW; favM = hiM - E; advM = E - loM; favB = hiB - E; advB = E - loB; }
      else { favW = E - loW; advW = hiW - E; favM = E - loM; advM = hiM - E; favB = E - loB; advB = hiB - E; }
    }
    const sg = d === 0 ? 1 : -1;
    for (let e = 0; e < NE; e++) {
      const { ti, si, li } = EXITS[e], T = ti === NL ? 0 : LEVELS[ti] * unit, S = si === NL ? 0 : LEVELS[si] * unit, tl = LIMT[li];
      const tT = ti === NL ? 0 : d === 0 ? UP[ti] : DN[ti], tS = si === NL ? 0 : d === 0 ? DN[si] : UP[si];
      const hitT = tT > 0 && tT <= tl, hitS = tS > 0 && tS <= tl;
      const fwd = hitS && (!hitT || tS <= tT) ? -S : hitT ? T : sg * (LIMC[li] - E);
      const w = S && advW >= S ? -S : T && favW >= T ? T : fwd, b = S && advB >= S ? -S : T && favB >= T ? T : fwd;
      const mid = S && advM >= S ? -S : T && favM >= T ? T : fwd;
      outW[d * NE + e] = w * toBp - cost; outM[d * NE + e] = mid * toBp - cost; outB[d * NE + e] = b * toBp - cost;
    }
  }
}
// databox_room.mjs's scan, for the check
function oldScan(b, i, unit, raw, out) {
  const { high: H, low: L, close: C, tday: TD, ctMin: CT } = b, N = C.length, P = C[i], toBp = 1e4 / raw, cost = COST * toBp;
  const tUp = new Int16Array(NL), tDn = new Int16Array(NL), limC = new Float64Array(NLIM), limT = new Int16Array(NLIM);
  let upMax = -Infinity, dnMax = -Infinity, m = 0, lastJ = i;
  for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
    m++; lastJ = j;
    const up = H[j] - P, dn = P - L[j];
    if (up > upMax) { upMax = up; for (let k = 0; k < NL; k++) if (!tUp[k] && up >= LEVELS[k] * unit) tUp[k] = m; }
    if (dn > dnMax) { dnMax = dn; for (let k = 0; k < NL; k++) if (!tDn[k] && dn >= LEVELS[k] * unit) tDn[k] = m; }
    for (let q = 0; q < NLIM - 1; q++) if (m === LIMITS[q]) { limC[q] = C[j]; limT[q] = m; }
  }
  for (let q = 0; q < NLIM; q++) if (q === NLIM - 1 || m < LIMITS[q]) { limC[q] = C[lastJ]; limT[q] = m; }
  for (let e = 0; e < NE; e++) {
    const { ti, si, li } = EXITS[e], tl = limT[li];
    for (let d = 0; d < 2; d++) {
      const tT = ti === NL ? 0 : d === 0 ? tUp[ti] : tDn[ti], tS = si === NL ? 0 : d === 0 ? tDn[si] : tUp[si];
      const hitT = tT > 0 && tT <= tl, hitS = tS > 0 && tS <= tl;
      const pts = hitS && (!hitT || tS <= tT) ? -LEVELS[si] * unit : hitT ? LEVELS[ti] * unit : (d === 0 ? 1 : -1) * (limC[li] - P);
      out[d * NE + e] = pts * toBp - cost;
    }
  }
}

function measure(b, plant = 0) {
  const N = b.close.length, TS = b.ts, Op = b.open, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const b5 = resample(b, 5), n5 = b5.close.length, a5 = atr(b5.high, b5.low, b5.close, 14);
  const X1 = boxRun(b, 1), X5 = boxRun(b5, 5);
  const W = new Int32Array(N).fill(-1);
  for (let w = 0; w < n5; w++) for (let i = b5.srcFirst[w]; i <= b5.srcLast[w]; i++) W[i] = w;
  // close: the 5m rows from the last 5-minute bar closed by the minute's close (databox_room.mjs's
  // rule); 5m live: from the forming one, at the minute's close
  const cell0 = new Int16Array(N), cell1 = new Int16Array(N), A5 = new Float64Array(N), A5o = new Float64Array(N);
  let k5 = -1, k5o = -1, bad1 = 0, bad5 = 0, checked1 = 0, checked5 = 0;
  for (let i = 0; i < N; i++) {
    while (k5 + 1 < n5 && b5.ts[k5 + 1] + 5 * MIN <= TS[i] + MIN) k5++;
    while (k5o + 1 < n5 && b5.ts[k5o + 1] + 5 * MIN <= TS[i]) k5o++;
    const c1 = X1.codes[i * 2] + 5 * X1.codes[i * 2 + 1], w = W[i];
    cell0[i] = c1 + (k5 >= 0 ? 25 * X5.codes[k5 * 2] + 125 * X5.codes[k5 * 2 + 1] : 0);
    const fe = stateAt(X5.thr, w * 6, X5.rdy[w * 2], C[i]), fm = stateAt(X5.thr, w * 6 + 3, X5.rdy[w * 2 + 1], C[i]);
    cell1[i] = c1 + 25 * Math.max(0, fe) + 125 * Math.max(0, fm);
    A5[i] = k5 >= 0 ? a5[k5] : NaN; A5o[i] = k5o >= 0 ? a5[k5o] : NaN;
    // the lines give the indicator's own states at the close
    const e1 = stateAt(X1.thr, i * 6, X1.rdy[i * 2], C[i]), m1 = stateAt(X1.thr, i * 6 + 3, X1.rdy[i * 2 + 1], C[i]);
    if (e1 >= 0 && m1 >= 0) { checked1++; if (e1 !== X1.codes[i * 2] || m1 !== X1.codes[i * 2 + 1]) bad1++; }
    if (i === b5.srcLast[w] && fe >= 0 && fm >= 0) { checked5++; if (fe !== X5.codes[w * 2] || fm !== X5.codes[w * 2 + 1] || C[i] !== b5.close[w]) bad5++; }
  }
  if (bad1 || bad5 || checked1 < 0.9 * N) throw new Error(`the lines miss the indicator's states: ${bad1} of ${checked1} 1-minute closes, ${bad5} of ${checked5} 5-minute closes`);

  const mk = () => ({ An: new Float64Array(SA), Asum: new Float64Array(SA * NE), Aa2: new Float64Array(SA * NE), Aab: new Float64Array(SA * NE), Aw: new Float64Array(SA * NE) });
  const Vs = Array.from({ length: NV }, mk);
  const Bn = new Float64Array(SB), Bsum = new Float64Array(SB * NE), Bb2 = new Float64Array(SB * NE), Bw = new Float64Array(SB * NE), G = new Float64Array(NS);
  // the session being read
  const sess = Array.from({ length: NV }, () => ({ a: new Float64Array(NK * NE), w: new Float64Array(NK * NE), m: new Float64Array(NK), on: new Uint8Array(NK), tl: [] }));
  const sb = new Float64Array(2 * NE), sbw = new Float64Array(2 * NE);
  let sn = 0, sTd = -1, sSlots = [], s26 = -1, n26 = 0;
  const flush = () => {
    if (!sn) return;
    for (const s of sSlots) {
      G[s]++;
      for (let d = 0; d < 2; d++) {
        const x = s * 2 + d, o = x * NE, so = d * NE;
        Bn[x] += sn;
        for (let e = 0; e < NE; e++) { const w = sb[so + e]; Bsum[o + e] += w; Bb2[o + e] += w * w; Bw[o + e] += sbw[so + e]; }
      }
      for (let v = 0; v < NV; v++) {
        const A = Vs[v], S = sess[v];
        for (const kd of S.tl) {
          const k = kd >> 1, d = kd & 1, x = (k * NS + s) * 2 + d, o = x * NE, so = kd * NE, bo = d * NE;
          A.An[x] += S.m[kd];
          for (let e = 0; e < NE; e++) { const a = S.a[so + e]; A.Asum[o + e] += a; A.Aa2[o + e] += a * a; A.Aab[o + e] += a * sb[bo + e]; A.Aw[o + e] += S.w[so + e]; }
        }
      }
    }
    if (s26 >= 0) {
      if (n26 >= CAP26) throw new Error("more 2026 sessions than the store holds");
      for (let v = 0; v < NV; v++) { S26A[v].set(sess[v].a, n26 * NK * NE); S26M[v].set(sess[v].m, n26 * NK); }
      S26B.set(sb, n26 * 2 * NE); S26N[n26] = sn; S26H[n26] = s26; n26++;
    }
    for (const S of sess) {
      for (const kd of S.tl) { S.a.fill(0, kd * NE, (kd + 1) * NE); S.w.fill(0, kd * NE, (kd + 1) * NE); S.m[kd] = 0; S.on[kd] = 0; }
      S.tl = [];
    }
    sb.fill(0); sbw.fill(0); sn = 0;
  };
  const add = (v, kd, vals, vo) => {
    const S = sess[v], o = kd * NE, extra = plant && kd === 0 ? plant : 0;
    if (!S.on[kd]) { S.on[kd] = 1; S.tl.push(kd); }
    S.m[kd]++;
    for (let e = 0; e < NE; e++) { const w = vals[vo + e] + extra; S.a[o + e] += w; if (w > 0) S.w[o + e]++; }
  };
  const vC = new Float64Array(2 * NE), vX = new Float64Array(2 * NE), vOld = new Float64Array(2 * NE);
  const EP = new Float64Array(16), EMd = new Int8Array(16), mk16 = () => Array.from({ length: 16 }, () => new Float64Array(2 * NE));
  const vW = mk16(), vM = mk16(), vB = mk16();
  const BND = new Float64Array(32);
  const cache = new Map();
  let liveN = 0, liveFlick = 0, liveMode = [0, 0, 0, 0], scanChecks = 0, counted = 0;
  for (let i = 1; i + 1 < N; i++) {
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i] || !(A5[i] > 0)) continue;
    const y = new Date(TS[i]).getUTCFullYear() - Y0;
    if (y < 0 || y >= NY) continue;
    if (TD[i] !== sTd) { flush(); sTd = TD[i]; const h = TS[i] < H2 ? 8 : 9; sSlots = y === NY - 1 ? [y, h] : [y]; s26 = y === NY - 1 ? h : -1; }
    // forward from this minute to 15:05
    FM = 0;
    let mx = -Infinity, mn = Infinity;
    for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) { FM++; if (H[j] > mx) mx = H[j]; if (L[j] < mn) mn = L[j]; RM[FM] = mx; RN[FM] = mn; CL[FM] = C[j]; }
    if (!FM) continue;
    for (let q = 0; q < NLIM; q++) { const t = q === NLIM - 1 || FM < LIMITS[q] ? FM : LIMITS[q]; LIMT[q] = t; LIMC[q] = CL[t]; }
    counted++;
    // every minute, and the close and 5m live entries: in at this minute's close
    outcomes(C[i], 0, H[i], L[i], C[i], A5[i], C[i] - off[i], vC, vX, vX);
    if (counted % 97 === 0) {
      oldScan(b, i, A5[i], C[i] - off[i], vOld);
      for (let q = 0; q < 2 * NE; q++) if (vOld[q] !== vC[q]) throw new Error(`first passage differs from databox_room.mjs's at bar ${i}, value ${q}: ${vOld[q]} against ${vC[q]}`);
      scanChecks++;
    }
    sn++;
    for (let q = 0; q < 2 * NE; q++) { const w = vC[q]; sb[q] += w; if (w > 0) sbw[q]++; }
    for (const [v, cell] of [[0, cell0], [1, cell1]]) {
      const c0 = cell[i - 1], c1 = cell[i];
      if (c0 === c1) continue;
      const key = c0 * NCELL + c1;
      let on = cache.get(key);
      if (!on) { on = []; for (let k = 0; k < NC; k++) if (MATCH[k * NCELL + c1] && !MATCH[k * NCELL + c0]) on.push(k); cache.set(key, on); }
      for (const k of on) for (let d = 0; d < 2; d++) add(v, k * 2 + d, vC, d * NE);
    }
    // live: every row from its forming bar, inside this minute
    if (!(A5o[i] > 0)) continue;
    const w = W[i], Ob = Op[i], Hb = H[i], Lb = L[i], Cb = C[i];
    for (let r = 0; r < 4; r++) {
      const thr = r < 2 ? X1.thr : X5.thr, o = (r < 2 ? i : w) * 6 + (r % 2) * 3, ready = r < 2 ? X1.rdy[i * 2 + r] : X5.rdy[w * 2 + r - 2];
      for (let s = 1; s <= 4; s++) { const q = (r * 4 + s - 1) * 2; if (ready) band(thr, o, s, BND, q); else { BND[q] = Infinity; BND[q + 1] = -Infinity; } }
    }
    let reach = 0;
    for (let q = 0; q < 16; q++) if (BND[2 * q] <= BND[2 * q + 1] && BND[2 * q] <= Hb && BND[2 * q + 1] >= Lb) reach |= 1 << q;
    let nE = 0;
    const prevCell = cell1[i - 1], nowCell = cell1[i];
    for (let k = 0; k < NC; k++) {
      const req = REQ[k];
      if ((reach & req) !== req) continue;
      let lo = -Infinity, hi = Infinity;
      for (const q of PAIRS[k]) { if (BND[2 * q] > lo) lo = BND[2 * q]; if (BND[2 * q + 1] < hi) hi = BND[2 * q + 1]; }
      if (!(lo <= hi)) continue;
      let E, mode;
      if (lo <= Ob && Ob <= hi) { if (MATCH[k * NCELL + prevCell]) continue; E = Ob; mode = 1; }
      else if (lo > Ob) { E = Math.ceil(lo / TICK - 1e-9) * TICK; if (E > hi || E > Hb) continue; mode = 2; }
      else { E = Math.floor(hi / TICK + 1e-9) * TICK; if (E < lo || E < Lb) continue; mode = 3; }
      let x = 0;
      while (x < nE && !(EP[x] === E && EMd[x] === mode)) x++;
      if (x === nE) {
        if (nE === 16) throw new Error("more than 16 live entry prices in a minute");
        EP[x] = E; EMd[x] = mode; outcomes(E, mode, Hb, Lb, Cb, A5o[i], E - off[i], vW[x], vM[x], vB[x]); nE++;
      }
      for (let d = 0; d < 2; d++) { add(2, k * 2 + d, vW[x], d * NE); add(3, k * 2 + d, vM[x], d * NE); add(4, k * 2 + d, vB[x], d * NE); }
      if (y === NY - 1) { liveN++; liveMode[mode]++; if (!MATCH[k * NCELL + nowCell]) liveFlick++; }
    }
  }
  flush();
  return { Vs, Bn, Bsum, Bb2, Bw, G, n26, checks: { bad1, checked1, bad5, checked5, scanChecks }, live2026: { n: liveN, flicker: liveFlick, open: liveMode[1], up: liveMode[2], down: liveMode[3] } };
}

// ── reading one market (as databox_room.mjs, for reading v) ──
function pooled(M, v, k, d, e, slots) {
  const A = M.Vs[v];
  let n = 0, sum = 0, ex = 0, vr = 0, base = 0, win = 0;
  for (const s of slots) {
    const x = (k * NS + s) * 2 + d, m = A.An[x], g = M.G[s];
    if (!m || g < 2) continue;
    const o = x * NE + e, bo = (s * 2 + d) * NE + e, w = m / M.Bn[s * 2 + d], As = A.Asum[o], B = M.Bsum[bo];
    const Y = As - w * B, Y2 = A.Aa2[o] - 2 * w * A.Aab[o] + w * w * M.Bb2[bo];
    n += m; sum += As; win += A.Aw[o]; ex += Y; base += w * B; vr += (g / (g - 1)) * Math.max(0, Y2 - (Y * Y) / g);
  }
  return { n, net: n ? sum / n : NaN, base: n ? base / n : NaN, win: n ? win / n : NaN, ex, t: vr > 0 ? ex / Math.sqrt(vr) : NaN, se: n && vr > 0 ? Math.sqrt(vr) / n : NaN };
}
function combined(M, v, picks, half) {
  const idx = [];
  for (let s = 0; s < M.n26; s++) if (half == null || S26H[s] === half) idx.push(s);
  const G = idx.length, SA_ = S26A[v], SM = S26M[v];
  let N = 0;
  for (const s of idx) N += S26N[s];
  const w = picks.map((p) => { let m = 0; for (const s of idx) m += SM[s * NK + p.k * 2 + p.d]; return m / N; });
  let SY = 0, SY2 = 0, n = 0, sum = 0, base = 0;
  for (const s of idx) {
    let Y = 0;
    picks.forEach((p, j) => {
      const kd = p.k * 2 + p.d, a = SA_[(s * NK + kd) * NE + p.e], bb = S26B[s * 2 * NE + p.d * NE + p.e];
      Y += a - w[j] * bb; n += SM[s * NK + kd]; sum += a; base += w[j] * bb;
    });
    SY += Y; SY2 += Y * Y;
  }
  const vr = G > 1 ? (G / (G - 1)) * Math.max(0, SY2 - (SY * SY) / G) : NaN;
  return { t: vr > 0 ? SY / Math.sqrt(vr) : NaN, net: n ? sum / n : NaN, base: n ? base / n : NaN, n, se: n && vr > 0 ? Math.sqrt(vr) / n : NaN };
}
const tradesIn = (M, v, k, d, slots) => slots.reduce((s, sl) => s + M.Vs[v].An[(k * NS + sl) * 2 + d], 0);
function pick(M, v, early, late, minE, minL, onlyRoomy, half) {
  const top = [];
  for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) {
    if (tradesIn(M, v, k, d, early) < minE || tradesIn(M, v, k, d, late) < minL) continue;
    for (let e = 0; e < NE; e++) {
      if (onlyRoomy && !ROOMY(e)) continue;
      const p = pooled(M, v, k, d, e, early);
      if (!(p.t > (top.length < PICK ? -Infinity : top[top.length - 1].t))) continue;
      top.push({ k, d, e, t: p.t });
      top.sort((a, b) => b.t - a.t);
      if (top.length > PICK) top.pop();
    }
  }
  for (const p of top) p.l = pooled(M, v, p.k, p.d, p.e, late);
  return { picks: top, ...combined(M, v, top, half) };
}
function persist(M, v, early, late, minE, minL) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) {
    if (tradesIn(M, v, k, d, early) < minE || tradesIn(M, v, k, d, late) < minL) continue;
    for (let e = 0; e < NE; e++) {
      const a = pooled(M, v, k, d, e, early).t, b = pooled(M, v, k, d, e, late).t;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      n++; sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b;
    }
  }
  return { r: (sxy - (sx * sy) / n) / Math.sqrt((sxx - (sx * sx) / n) * (syy - (sy * sy) / n)), n };
}
// each strategy's 2026 excess a trade read v, less read at close, averaged over the strategies
function gain(M, v) {
  let n = 0, s = 0;
  for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) {
    if (tradesIn(M, v, k, d, [7]) < 100 || tradesIn(M, 0, k, d, [7]) < 100) continue;
    for (let e = 0; e < NE; e++) { const a = pooled(M, v, k, d, e, [7]), b = pooled(M, 0, k, d, e, [7]); n++; s += a.ex / a.n - b.ex / b.n; }
  }
  return { bp: s / n, n };
}
const INS = [0, 1, 2, 3, 4, 5, 6];
const read = (M) => Array.from({ length: NV }, (_, v) => ({
  all: pick(M, v, INS, [7], 2000, 100, false, null),
  room: pick(M, v, INS, [7], 2000, 100, true, null),
  inside: pick(M, v, [8], [9], 100, 50, false, 9),
  persist: persist(M, v, INS, [7], 2000, 100),
  persistInside: persist(M, v, [8], [9], 100, 50),
  gain: v ? gain(M, v) : null,
}));

const { bars } = loadBars("data/mnq_1m_beta.bin");
const real = measure(bars, PLANT);
process.stderr.write(`  real market measured: ${secs()}s\n`);
// 5m live equals close on every combination without a 5m row
for (let k = 0; k < NC; k++) if (ONLY1M[k]) for (let x = k * NS * 2; x < (k + 1) * NS * 2; x++) {
  if (real.Vs[0].An[x] !== real.Vs[1].An[x]) throw new Error(`5m live differs from close on ${labelOf(k)}`);
  for (let e = 0; e < NE; e++) if (real.Vs[0].Asum[x * NE + e] !== real.Vs[1].Asum[x * NE + e]) throw new Error(`5m live P&L differs from close on ${labelOf(k)}`);
}
const R = read(real);
for (let v = 0; v < NV; v++) for (const [P, slot, half] of [[R[v].all.picks[0], 7, null], [R[v].inside.picks[0], 9, 9]]) {
  const a = pooled(real, v, P.k, P.d, P.e, [slot]).t, b = combined(real, v, [P], half).t;
  if (!(Math.abs(a - b) < 1e-4 * Math.max(1, Math.abs(a)))) throw new Error(`${V[v]}: t by session differs, ${a} from the accumulators, ${b} from the store`);
}
process.stderr.write(`  read: ${secs()}s\n`);
const snap = (r) => r.map((x) => ({ all: x.all.t, room: x.room.t, inside: x.inside.t, persist: x.persist.r, persistInside: x.persistInside.r, gain: x.gain ? x.gain.bp : null }));
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  pl.push(snap(read(measure(placeboBars(bars, 9600 + p)))));
  if ((p + 1) % 5 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
}

// ── print ──
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—"), f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const PX26 = 29000 / 1e4, pts = (bp) => f2(bp * PX26), pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(0) + "%" : "—");
const high = (v, key, val) => { const zs = pl.map((p) => p[v][key]).filter(Number.isFinite); return zs.length ? `${zs.filter((z) => z >= val).length}/${zs.length}` : "—"; };
const trades = (v) => real.Vs[v].An.reduce((s, x, i) => s + (((i >> 1) % NS) < NY ? x : 0), 0) * NE;
const c = real.checks, lv = real.live2026;
if (PLANT) console.log(`PLANTED: +${PLANT} bp (${(PLANT * PX26).toFixed(1)} points) on every trade of "1m EMA Long" long, in every reading, real market only`);
console.log(`${NC} combinations x long and short x ${NE} exits = ${(NC * 2 * NE).toLocaleString()} strategies, read ${NV} ways; ${PLACEBOS} placebo markets; ${secs()}s`);
console.log(`checks: the lines gave the indicator's state at ${c.checked1.toLocaleString()} 1-minute closes and ${c.checked5.toLocaleString()} 5-minute closes, no misses; first passages equal databox_room.mjs's at ${c.scanChecks.toLocaleString()} minutes; 5m live equals close without a 5m row`);
console.log(`live entries in 2026: ${lv.n.toLocaleString()} (at the minute's open ${pc(lv.open / lv.n)}, on the way up ${pc(lv.up / lv.n)}, on the way down ${pc(lv.down / lv.n)}); ${pc(lv.flicker / lv.n)} were no longer true at the minute's close`);
const col = (s) => String(s).padStart(13);
const row = (label, f) => console.log(label.padEnd(44) + V.map((_, v) => col(f(v))).join(""));
console.log("\n" + "".padEnd(44) + V.map(col).join(""));
row("trades on the real market, 2019-2026", (v) => `${(trades(v) / 1e9).toFixed(2)}B`);
for (const [key, title] of [["all", "ALL: 10 best of 2019-25, in 2026"], ["room", "ROOM: the same, roomy exits only"], ["inside", "INSIDE: 10 best of Jan-Jun, in Jul-Oct"]]) {
  console.log(title);
  row("  net points a trade", (v) => pts(R[v][key].net));
  row("  every minute, same exits", (v) => pts(R[v][key].base));
  row("  t by session", (v) => f1(R[v][key].t));
  row("  placebo markets' picks as high", (v) => high(v, key, R[v][key].t));
}
row("PERSIST: t 2019-25 against t 2026, r", (v) => f2(R[v].persist.r));
row("  placebo markets as high", (v) => high(v, "persist", R[v].persist.r));
row("PERSIST INSIDE: Jan-Jun against Jul-Oct, r", (v) => f2(R[v].persistInside.r));
row("  placebo markets as high", (v) => high(v, "persistInside", R[v].persistInside.r));
row("GAIN over close: points a trade, 2026", (v) => (v ? pts(R[v].gain.bp) : "—"));
row("  placebo markets as high", (v) => (v ? high(v, "gain", R[v].gain.bp) : "—"));
row("  placebo markets' median", (v) => { if (!v) return "—"; const zs = pl.map((p) => p[v].gain).filter(Number.isFinite).sort((a, b) => a - b); return zs.length ? pts(zs[zs.length >> 1]) : "—"; });
for (let v = 1; v < NV; v++) {
  console.log(`\n${V[v]}: the picks`);
  for (const [key, name] of [["all", "2026"], ["room", "2026"], ["inside", "Jul-Oct"]]) for (const p of R[v][key].picks.slice(0, 3)) {
    console.log(`  ${key.padEnd(6)} ${(p.d ? "short " : "long  ") + labelOf(p.k).slice(0, 56).padEnd(57)} ${exitName(p.e).padEnd(39)} t ${f1(p.t).padStart(4)} | ${name}: ${pts(p.l.net).padStart(6)} (every minute ${pts(p.l.base)}), wins ${pc(p.l.win)}, ${p.l.n} trades`);
  }
}
console.log(`\n(Points at 2026's price, about 29,000: 1 bp is 2.9 points. ${secs()}s)`);

if (!PLANT) {
  const pk = (P) => ({ t: P.t, netPts: P.net * PX26, everyMinutePts: P.base * PX26, sePts: P.se * PX26, trades: P.n,
    picks: P.picks.map((p) => ({ entry: labelOf(p.k), dir: p.d ? "short" : "long", exit: exitName(p.e), tPicked: p.t, netPtsRead: p.l.net * PX26, everyMinutePtsRead: p.l.base * PX26, winsRead: p.l.win, tRead: p.l.t, nRead: p.l.n })) });
  fs.writeFileSync("research/databox_live_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS, readings: V, strategies: NC * 2 * NE,
    trades: V.map((_, v) => trades(v)), checks: real.checks, live2026: real.live2026,
    real: R.map((x) => ({ all: pk(x.all), room: pk(x.room), inside: pk(x.inside), persist: x.persist, persistInside: x.persistInside, gainPts: x.gain ? x.gain.bp * PX26 : null })),
    placebo: pl }, null, 1));
  console.log("wrote research/databox_live_results.json");
}
