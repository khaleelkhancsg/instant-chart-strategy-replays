// Every databox entry with room: a grid of volatility-scaled exits, the same exit for every entry.
//
//   node --max-old-space-size=16384 research/databox_room.mjs [--placebos N] [--plant BP]
//
// RESULT (2026-11-23; 100 placebo markets, 1.28 billion trades each, 19 minutes): room adds no
// entry edge. Every pick read out of sample sits inside the placebo markets' picks.
//   all      the 10 best on 2019-2025 lost 2.82 points a trade in 2026, against 0.97 for every
//            minute with the same exits: t -1.7 by session, and 96 of 100 placebo picks scored as high.
//   room     -1.74 against -0.28: t -0.9, 72 of 100.
//   inside   Jan-Jun's 10 best, read on Jul-Oct: -1.55 against +0.49: t -0.4, 58 of 100.
//   persist  a strategy's t on 2019-2025 against its t on 2026: r 0.08 (placebo median -0.02,
//            29 of 100 as high). Jan-Jun against Jul-Oct: r -0.17 (89 of 100).
// - The reading finds an edge when there is one. +1 point a trade planted on "1m EMA Long" long
//   comes out on top of 2019-2025 (t 12) and holds in 2026 at t 3.4; +3 points gives t 9.4. With
//   room (a stop of 2 ATR+ held 40 minutes+) the noise doubles, so an edge needs about 2 points.
// - Room raises the win rate, not the edge. A 0.5-ATR target with a 3-ATR stop wins 84% of the
//   time from any 2026 minute and loses 0.3-1.3 points a trade. The box's best such pick from
//   2019-2025 won 82% in 2026 and lost 3.12 a trade.
// - From every 2026 minute, 16 of the 288 exit-and-direction pairs made money after costs, all of
//   them shorts toward 15:05 with a big target (best +1.62 points a trade). Any minute had that.
//
// The person's question (2026-11-23): momentum may need room, as the one momentum edge the lab
// found did (donchian_1250: a 5-ATR stop, a 1.75-ATR target, out after 40 minutes without
// progress). Don't stop at a 10-point or 37-point bracket. Try every combination again with room.
//
// - Entries: the 1,248 of research/databox_combos.mjs. These are the 624 state combinations of the
//   box's four rows, long and short, firing the minute they become true in the New York session
//   (closes 08:30-14:55 CT).
// - Exits, one grid for every entry, in ATRs of the 5-minute bars (ATR 14 at the last 5-minute
//   bar closed at the entry; about 28 points in 2026):
//     target   0.5, 1, 2, 3 or 5 ATR, or none
//     stop     0.5, 1, 2, 3 or 5 ATR, or none
//     time     out after 15, 40 or 120 minutes, or at 15:05 CT, the bots' flat
//   144 exits. A minute reaching the target and the stop counts as the stop.
// - 624 x 2 x 144 = 179,712 strategies, every firing a trade: about 1.3 billion trades a market.
//   One position at a time is not imposed: each firing is its own trade, so the entry's edge is
//   measured on all of them.
// - P&L in basis points of the contract's real price, after a round trip of 1.25 points. Each
//   strategy is set against every New York minute with the same exit, in the same direction and
//   year, and the excess is what the entry adds.
// - t counts each session as one draw. A session's trades share its path (a firing held to 15:05
//   overlaps every later firing that day), so per-trade t overstates the evidence: on the first
//   run, with one placebo market, that market's picks scored t 11 out of sample. A session's draw
//   is the strategy's summed net bp that day less its share of every minute's (the trades it took
//   over the trades every minute took, in that period), so the noise in the every-minute line
//   is counted too.
// - Named before the full run, each against the same reading on every placebo market:
//     all      the 10 strategies with the best t on 2019-2025 (2,000 trades there, 100 in 2026),
//              read on 2026 as one book, session by session;
//     room     the same among the roomy exits only: a stop of 2 ATR or more (or none), held 40
//              minutes or more;
//     inside   2026 alone: the 10 best on Jan-Jun (100 trades), read on Jul-Oct (50);
//     persist  across every strategy, the correlation of its t on 2019-2025 with its t on 2026
//              (and, inside, Jan-Jun with Jul-Oct). An entry that carries an edge keeps its sign.
// - --plant BP adds BP to every trade of "1m EMA Long" long on the real market: the check that the
//   reading finds an edge when there is one. It writes no files.
// - research/databox_room_exits.csv: every exit's net P&L and win rate from every minute, by year.
//   research/databox_room_top.csv: the 2,000 best on 2019-2025 and the 2,000 best on 2026, every
//   period. research/databox_room_results.json: the picks and every placebo market's readings.

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
// --ema-warning RULE: the EMA row's warning rule (the indicator's emaWarning: speed, the default;
// closer; slowing). Another rule's files carry its name: research/databox_room_slowing_*.
const EW = args.includes("--ema-warning") ? args[args.indexOf("--ema-warning") + 1] : "speed", SUF = EW === "speed" ? "" : `_${EW}`;
const MIN = 60000, COST = 1.25, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55;
const Y0 = 2019, NY = 8, NS = 10, H2 = Date.UTC(2026, 6, 1), PICK = 10;
const slotName = (s) => (s < NY ? String(Y0 + s) : s === 8 ? "2026 Jan-Jun" : "2026 Jul-Oct");
const LEVELS = [0.5, 1, 2, 3, 5], NL = LEVELS.length;                  // ATR multiples; index NL = none
const LIMITS = [15, 40, 120, Infinity], NLIM = LIMITS.length;           // minutes; Infinity = 15:05
const EXITS = [];
for (let ti = 0; ti <= NL; ti++) for (let si = 0; si <= NL; si++) for (let li = 0; li < NLIM; li++) EXITS.push({ ti, si, li });
const NE = EXITS.length;
const lvl = (k) => (k === NL ? "none" : `${LEVELS[k]} ATR`);
const exitName = (e) => `target ${lvl(EXITS[e].ti)}, stop ${lvl(EXITS[e].si)}, ${LIMITS[EXITS[e].li] === Infinity ? "to 15:05" : `${LIMITS[EXITS[e].li]} min`}`;
const ROOMY = (e) => (EXITS[e].si >= 2) && LIMITS[EXITS[e].li] >= 40;   // stop 2 ATR or more (or none), held 40 minutes or more
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

// ── the box and the combinations, as research/databox_combos.mjs has them ──
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
function boxStates(T, minutes) {
  const run = new Run(BOX, { minutes, props: { emaWarning: EW }, check: false }), map = run.calc.map.bind(run.calc);
  const n = T.close.length, ema = new Int8Array(n), macd = new Int8Array(n);
  run.calc.map = (d, i) => { const out = map(d, i), S = run.calc.st[i]; ema[i] = code(S.ema, S.emaReady); macd[i] = code(S.macd, S.macdReady); return out; };
  run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
  return { ema, macd };
}
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
const labelOf = (k) => COMBOS[k].map(([r, s]) => `${ROWS[r]} ${STATES[s]}`).join(" + ");

// 2026 session by session, for reading a set of picks as one book. One store, refilled by each
// market's measure(); read a market before measuring the next.
const CAP26 = 260;
const S26A = new Float64Array(CAP26 * NK * NE), S26M = new Float64Array(CAP26 * NK), S26B = new Float64Array(CAP26 * 2 * NE);
const S26N = new Float64Array(CAP26), S26H = new Int8Array(CAP26);

// ── one market ──
// Per (combination, period, direction): trades (An). Per (..., exit): summed net bp (Asum), the
// sum over sessions of the session's summed bp squared (Aa2) and times every minute's that
// session (Aab), and wins (Aw). The same for every New York minute (Bn, Bsum, Bb2, Bw), and the
// sessions in each period (G).
const SA = NC * NS * 2, SB = NS * 2;
function measure(b, plant = 0) {
  const N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const s1 = boxStates(b, 1), b5 = resample(b, 5), s5 = boxStates(b5, 5), a5 = atr(b5.high, b5.low, b5.close, 14);
  const cell = new Int16Array(N), A5 = new Float64Array(N);
  let k5 = -1;
  for (let i = 0; i < N; i++) {
    while (k5 + 1 < b5.ts.length && b5.ts[k5 + 1] + 5 * MIN <= TS[i] + MIN) k5++;
    cell[i] = s1.ema[i] + 5 * s1.macd[i] + 25 * (k5 >= 0 ? s5.ema[k5] : 0) + 125 * (k5 >= 0 ? s5.macd[k5] : 0);
    A5[i] = k5 >= 0 ? a5[k5] : NaN;
  }
  const An = new Float64Array(SA), Asum = new Float64Array(SA * NE), Aa2 = new Float64Array(SA * NE), Aab = new Float64Array(SA * NE), Aw = new Float64Array(SA * NE);
  const Bn = new Float64Array(SB), Bsum = new Float64Array(SB * NE), Bb2 = new Float64Array(SB * NE), Bw = new Float64Array(SB * NE), G = new Float64Array(NS);
  // the session being read
  const sa = new Float64Array(NK * NE), sw = new Float64Array(NK * NE), sm = new Float64Array(NK), sb = new Float64Array(2 * NE), sbw = new Float64Array(2 * NE), touched = new Uint8Array(NK);
  let tl = [], sn = 0, sTd = -1, sSlots = [], s26 = -1, n26 = 0;
  const flush = () => {
    if (!sn) return;
    for (const s of sSlots) {
      G[s]++;
      for (let d = 0; d < 2; d++) {
        const x = s * 2 + d, o = x * NE, so = d * NE;
        Bn[x] += sn;
        for (let e = 0; e < NE; e++) { const w = sb[so + e]; Bsum[o + e] += w; Bb2[o + e] += w * w; Bw[o + e] += sbw[so + e]; }
      }
      for (const kd of tl) {
        const k = kd >> 1, d = kd & 1, x = (k * NS + s) * 2 + d, o = x * NE, so = kd * NE, bo = d * NE;
        An[x] += sm[kd];
        for (let e = 0; e < NE; e++) { const a = sa[so + e]; Asum[o + e] += a; Aa2[o + e] += a * a; Aab[o + e] += a * sb[bo + e]; Aw[o + e] += sw[so + e]; }
      }
    }
    if (s26 >= 0) {
      if (n26 >= CAP26) throw new Error("more 2026 sessions than the store holds");
      S26A.set(sa, n26 * NK * NE); S26M.set(sm, n26 * NK); S26B.set(sb, n26 * 2 * NE); S26N[n26] = sn; S26H[n26] = s26; n26++;
    }
    for (const kd of tl) { sa.fill(0, kd * NE, (kd + 1) * NE); sw.fill(0, kd * NE, (kd + 1) * NE); sm[kd] = 0; touched[kd] = 0; }
    tl = []; sb.fill(0); sbw.fill(0); sn = 0;
  };
  const tUp = new Int16Array(NL), tDn = new Int16Array(NL), limC = new Float64Array(NLIM), limT = new Int16Array(NLIM), v = new Float64Array(2 * NE);
  const cache = new Map();
  for (let i = 1; i + 1 < N; i++) {
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i] || !(A5[i] > 0)) continue;
    const y = new Date(TS[i]).getUTCFullYear() - Y0;
    if (y < 0 || y >= NY) continue;
    if (TD[i] !== sTd) { flush(); sTd = TD[i]; const h = TS[i] < H2 ? 8 : 9; sSlots = y === NY - 1 ? [y, h] : [y]; s26 = y === NY - 1 ? h : -1; }
    const P = C[i], raw = C[i] - off[i], unit = A5[i], cost = (COST / raw) * 1e4, toBp = 1e4 / raw;
    // first passage: the minute (1 = the next) each level is first reached up and down; and the
    // close at each time limit, or at the last bar before 15:05
    tUp.fill(0); tDn.fill(0);
    let upMax = -Infinity, dnMax = -Infinity, m = 0, lastJ = i;
    for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
      m++; lastJ = j;
      const up = H[j] - P, dn = P - L[j];
      if (up > upMax) { upMax = up; for (let k = 0; k < NL; k++) if (!tUp[k] && up >= LEVELS[k] * unit) tUp[k] = m; }
      if (dn > dnMax) { dnMax = dn; for (let k = 0; k < NL; k++) if (!tDn[k] && dn >= LEVELS[k] * unit) tDn[k] = m; }
      for (let q = 0; q < NLIM - 1; q++) if (m === LIMITS[q]) { limC[q] = C[j]; limT[q] = m; }
    }
    if (!m) continue;
    for (let q = 0; q < NLIM; q++) if (q === NLIM - 1 || m < LIMITS[q]) { limC[q] = C[lastJ]; limT[q] = m; }   // the session ends first: out at its last bar
    // every exit's net bp, long (v[e]) and short (v[NE + e])
    for (let e = 0; e < NE; e++) {
      const { ti, si, li } = EXITS[e], tl2 = limT[li];
      for (let d = 0; d < 2; d++) {
        const tT = ti === NL ? 0 : d === 0 ? tUp[ti] : tDn[ti], tS = si === NL ? 0 : d === 0 ? tDn[si] : tUp[si];
        const hitT = tT > 0 && tT <= tl2, hitS = tS > 0 && tS <= tl2;
        let pts;
        if (hitS && (!hitT || tS <= tT)) pts = -LEVELS[si] * unit;
        else if (hitT) pts = LEVELS[ti] * unit;
        else pts = (d === 0 ? 1 : -1) * (limC[li] - P);
        v[d * NE + e] = pts * toBp - cost;
      }
    }
    sn++;
    for (let q = 0; q < 2 * NE; q++) { const w = v[q]; sb[q] += w; if (w > 0) sbw[q]++; }
    // the combinations that become true at this minute
    const c0 = cell[i - 1], c1 = cell[i];
    if (c0 === c1) continue;
    const key = c0 * NCELL + c1;
    let on = cache.get(key);
    if (!on) { on = []; for (let k = 0; k < NC; k++) if (MATCH[k * NCELL + c1] && !MATCH[k * NCELL + c0]) on.push(k); cache.set(key, on); }
    for (const k of on) for (let d = 0; d < 2; d++) {
      const kd = k * 2 + d, o = kd * NE, vo = d * NE, add = plant && kd === 0 ? plant : 0;
      if (!touched[kd]) { touched[kd] = 1; tl.push(kd); }
      sm[kd]++;
      for (let e = 0; e < NE; e++) { const w = v[vo + e] + add; sa[o + e] += w; if (w > 0) sw[o + e]++; }
    }
  }
  flush();
  return { An, Asum, Aa2, Aab, Aw, Bn, Bsum, Bb2, Bw, G, n26 };
}

// ── reading one market ──
// A strategy over periods: trades, net bp a trade, every minute's with the same exits, wins, the
// excess over every minute's, and its t by session.
function pooled(M, k, d, e, slots) {
  let n = 0, sum = 0, ex = 0, v = 0, base = 0, win = 0;
  for (const s of slots) {
    const x = (k * NS + s) * 2 + d, m = M.An[x], g = M.G[s];
    if (!m || g < 2) continue;
    const o = x * NE + e, bo = (s * 2 + d) * NE + e, w = m / M.Bn[s * 2 + d], A = M.Asum[o], B = M.Bsum[bo];
    const Y = A - w * B, Y2 = M.Aa2[o] - 2 * w * M.Aab[o] + w * w * M.Bb2[bo];
    n += m; sum += A; win += M.Aw[o]; ex += Y; base += w * B; v += (g / (g - 1)) * Math.max(0, Y2 - (Y * Y) / g);
  }
  return { n, net: n ? sum / n : NaN, base: n ? base / n : NaN, win: n ? win / n : NaN, ex, t: v > 0 ? ex / Math.sqrt(v) : NaN, se: n && v > 0 ? Math.sqrt(v) / n : NaN };
}
// A set of picks read as one book over 2026's sessions (half: null for all of 2026, 9 for Jul-Oct).
// Only for the market measured last.
function combined(M, picks, half) {
  const idx = [];
  for (let s = 0; s < M.n26; s++) if (half == null || S26H[s] === half) idx.push(s);
  const G = idx.length;
  let N = 0;
  for (const s of idx) N += S26N[s];
  const w = picks.map((p) => { let m = 0; for (const s of idx) m += S26M[s * NK + p.k * 2 + p.d]; return m / N; });
  let SY = 0, SY2 = 0, n = 0, sum = 0, base = 0;
  for (const s of idx) {
    let Y = 0;
    picks.forEach((p, j) => {
      const kd = p.k * 2 + p.d, a = S26A[(s * NK + kd) * NE + p.e], bb = S26B[s * 2 * NE + p.d * NE + p.e];
      Y += a - w[j] * bb; n += S26M[s * NK + kd]; sum += a; base += w[j] * bb;
    });
    SY += Y; SY2 += Y * Y;
  }
  const v = G > 1 ? (G / (G - 1)) * Math.max(0, SY2 - (SY * SY) / G) : NaN;
  return { t: v > 0 ? SY / Math.sqrt(v) : NaN, net: n ? sum / n : NaN, base: n ? base / n : NaN, n, se: n && v > 0 ? Math.sqrt(v) / n : NaN };
}
const tradesIn = (M, k, d, slots) => slots.reduce((s, sl) => s + M.An[(k * NS + sl) * 2 + d], 0);
function pick(M, early, late, minE, minL, onlyRoomy, half) {
  const top = [];
  for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) {
    if (tradesIn(M, k, d, early) < minE || tradesIn(M, k, d, late) < minL) continue;
    for (let e = 0; e < NE; e++) {
      if (onlyRoomy && !ROOMY(e)) continue;
      const p = pooled(M, k, d, e, early);
      if (!(p.t > (top.length < PICK ? -Infinity : top[top.length - 1].t))) continue;
      top.push({ k, d, e, t: p.t });
      top.sort((a, b) => b.t - a.t);
      if (top.length > PICK) top.pop();
    }
  }
  for (const p of top) p.l = pooled(M, p.k, p.d, p.e, late);
  return { picks: top, ...combined(M, top, half) };
}
function persist(M, early, late, minE, minL) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) {
    if (tradesIn(M, k, d, early) < minE || tradesIn(M, k, d, late) < minL) continue;
    for (let e = 0; e < NE; e++) {
      const a = pooled(M, k, d, e, early).t, b = pooled(M, k, d, e, late).t;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      n++; sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b;
    }
  }
  return { r: (sxy - (sx * sy) / n) / Math.sqrt((sxx - (sx * sx) / n) * (syy - (sy * sy) / n)), n };
}
const INS = [0, 1, 2, 3, 4, 5, 6];
const read = (M) => ({
  all: pick(M, INS, [7], 2000, 100, false, null),
  room: pick(M, INS, [7], 2000, 100, true, null),
  inside: pick(M, [8], [9], 100, 50, false, 9),
  persist: persist(M, INS, [7], 2000, 100),
  persistInside: persist(M, [8], [9], 100, 50),
});

const { bars } = loadBars("data/mnq_1m_beta.bin");
const real = measure(bars, PLANT);
process.stderr.write(`  real market measured: ${secs()}s\n`);
const R = read(real);
// the session store and the accumulators must give one pick the same t
for (const [P, slot, half] of [[R.all.picks[0], 7, null], [R.inside.picks[0], 9, 9]]) {
  const a = pooled(real, P.k, P.d, P.e, [slot]).t, b = combined(real, [P], half).t;
  if (!(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(a)))) throw new Error(`t by session differs: ${a} from the accumulators, ${b} from the store`);
}
process.stderr.write(`  read: ${secs()}s\n`);
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  const r = read(measure(placeboBars(bars, 9600 + p)));
  pl.push({ all: r.all.t, room: r.room.t, inside: r.inside.t, persist: r.persist.r, persistInside: r.persistInside.r });
  if ((p + 1) % 5 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
}

// ── print ──
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—"), f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const PX26 = 29000 / 1e4, pts = (bp) => f2(bp * PX26), pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(0) + "%" : "—");
const trades = real.An.reduce((s, x, i) => s + (((i >> 1) % NS) < NY ? x : 0), 0) * NE;
const rank = (key, val) => {
  const zs = pl.map((p) => p[key]).filter(Number.isFinite).sort((a, b) => a - b);
  return { lo: zs[0], hi: zs[zs.length - 1], med: zs[zs.length >> 1], high: zs.filter((z) => z >= val).length, n: zs.length };
};
if (PLANT) console.log(`PLANTED: +${PLANT} bp (${(PLANT * PX26).toFixed(1)} points) on every trade of "1m EMA Long" long, real market only`);
console.log(`EMA row warning rule: ${EW}${EW === "speed" ? " (the default)" : ""}`);
console.log(`${NC} combinations x long and short x ${NE} exits = ${(NC * 2 * NE).toLocaleString()} strategies; ${(trades / 1e9).toFixed(2)} billion trades on the real market, as many on each of ${PLACEBOS} placebo markets; ${secs()}s`);
{
  const rows = [];
  for (let e = 0; e < NE; e++) for (let d = 0; d < 2; d++) { const x = 7 * 2 + d; rows.push({ e, d, net: real.Bsum[x * NE + e] / real.Bn[x], win: real.Bw[x * NE + e] / real.Bn[x] }); }
  rows.sort((a, b) => b.net - a.net);
  const show = (r) => `${r.d ? "short" : "long"} ${exitName(r.e)}: ${pts(r.net)} (wins ${pc(r.win)})`;
  console.log(`\nEvery New York minute in 2026, all 288 exit-and-direction pairs: ${rows.filter((r) => r.net > 0).length} make money after costs; median ${pts(rows[rows.length >> 1].net)} points a trade.`);
  console.log(`  best:  ${rows.slice(0, 3).map(show).join("; ")}`);
  console.log(`  worst: ${rows.slice(-3).map(show).join("; ")}`);
}
const showPick = (title, P, key, lateName) => {
  const r = rank(key, P.t);
  console.log(`\n${title}\n  as one book: ${pts(P.net)} net points a trade against ${pts(P.base)} from every minute with the same exits; t ${f1(P.t)} by session (standard error ${pts(P.se)} points a trade).` +
              `\n  placebo markets' picks: t ${f1(r.lo)} to ${f1(r.hi)}, median ${f1(r.med)}; ${r.high} of ${r.n} as high`);
  for (const p of P.picks) console.log(`  ${(p.d ? "short " : "long  ") + labelOf(p.k).slice(0, 58).padEnd(59)} ${exitName(p.e).padEnd(39)} t ${f1(p.t).padStart(4)} | ${lateName}: ${pts(p.l.net).padStart(6)} (every minute ${pts(p.l.base)}), wins ${pc(p.l.win)}, t ${f1(p.l.t)}, ${p.l.n} trades`);
};
showPick("ALL: the 10 best on 2019-2025, read on 2026", R.all, "all", "2026");
showPick("ROOM: the 10 best on 2019-2025 among stops of 2 ATR or more held 40 minutes or more, read on 2026", R.room, "room", "2026");
showPick("INSIDE 2026: the 10 best on Jan-Jun, read on Jul-Oct", R.inside, "inside", "Jul-Oct");
for (const [key, title] of [["persist", "PERSIST: every strategy's t on 2019-2025 against its t on 2026"], ["persistInside", "PERSIST INSIDE 2026: Jan-Jun against Jul-Oct"]]) {
  const r = rank(key, R[key].r);
  console.log(`\n${title}: correlation ${f2(R[key].r)} over ${R[key].n.toLocaleString()} strategies; placebo markets ${f2(r.lo)} to ${f2(r.hi)}, median ${f2(r.med)}; ${r.high} of ${r.n} as high`);
}
console.log(`\n(Points at 2026's price, about 29,000: 1 bp is 2.9 points. ${secs()}s)`);

// ── files ──
if (!PLANT) {
  const ex = ["exit,direction,period,trades,net_bp_per_trade,net_pts_at_2026_price,wins"];
  for (let e = 0; e < NE; e++) for (let d = 0; d < 2; d++) for (let s = 0; s < NS; s++) {
    const x = s * 2 + d, n = real.Bn[x];
    if (n) ex.push([`"${exitName(e)}"`, d ? "short" : "long", slotName(s), n, (real.Bsum[x * NE + e] / n).toFixed(3), ((real.Bsum[x * NE + e] / n) * PX26).toFixed(2), (real.Bw[x * NE + e] / n).toFixed(4)].join(","));
  }
  if (!SUF) fs.writeFileSync("research/databox_room_exits.csv", ex.join("\n"));   // every minute: the same under any rule
  const top = ["ranked_on,rank,entry,direction,exit,t_by_session," + Array.from({ length: NS }, (_, s) => `${slotName(s)} trades,${slotName(s)} net bp,${slotName(s)} excess bp,${slotName(s)} t`).join(",")];
  for (const [name, slots, minN] of [["2019-2025", INS, 2000], ["2026", [7], 100]]) {
    const all = [];
    for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) {
      if (tradesIn(real, k, d, slots) < minN) continue;
      for (let e = 0; e < NE; e++) { const p = pooled(real, k, d, e, slots); if (Number.isFinite(p.t)) all.push({ k, d, e, t: p.t }); }
    }
    all.sort((a, b) => b.t - a.t);
    all.slice(0, 2000).forEach((r, i) => {
      const cells = Array.from({ length: NS }, (_, s) => { const p = pooled(real, r.k, r.d, r.e, [s]); return p.n ? `${p.n},${p.net.toFixed(3)},${(p.ex / p.n).toFixed(3)},${f2(p.t)}` : "0,,,"; });
      top.push([name, i + 1, `"${labelOf(r.k)}"`, r.d ? "short" : "long", `"${exitName(r.e)}"`, r.t.toFixed(2), ...cells].join(","));
    });
  }
  fs.writeFileSync(`research/databox_room${SUF}_top.csv`, top.join("\n"));
  const pk = (P) => ({ t: P.t, netPts: P.net * PX26, everyMinutePts: P.base * PX26, sePts: P.se * PX26, trades: P.n,
    picks: P.picks.map((p) => ({ entry: labelOf(p.k), dir: p.d ? "short" : "long", exit: exitName(p.e), tPicked: p.t, netPtsRead: p.l.net * PX26, everyMinutePtsRead: p.l.base * PX26, winsRead: p.l.win, tRead: p.l.t, nRead: p.l.n })) });
  fs.writeFileSync(`research/databox_room${SUF}_results.json`, JSON.stringify({ run: new Date().toISOString(), emaWarning: EW, placebos: PLACEBOS, strategies: NC * 2 * NE, tradesReal: trades,
    all: pk(R.all), room: pk(R.room), inside: pk(R.inside), persist: R.persist, persistInside: R.persistInside, placebo: pl }, null, 1));
  console.log(`wrote ${SUF ? "" : "research/databox_room_exits.csv, "}research/databox_room${SUF}_top.csv, research/databox_room${SUF}_results.json`);
}
