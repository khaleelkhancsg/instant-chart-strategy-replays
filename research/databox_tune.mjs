// The databox's settings, tuned: every entry x every exit of research/databox_room.mjs, under 16 box
// settings, picked as ONE search and judged against 100 placebo markets that run the same search.
//
//   node --max-old-space-size=16384 research/databox_tune.mjs [--placebos 100] [--shard K --shards S] [--settings a,b] [--plant BP]
//   node research/databox_tune.mjs --merge --shards S        (reads the shards' files, prints, writes the results)
//
// The person's question (2026-11-25): build on the billions-of-trades room study. Which entry and exit
// combinations work best, with the EMA and MACD lengths changed too, some rows made faster (noisier) and
// others slower; which combinations should be ignored, and which add edge?
//
// Written before the full run:
// - Settings (16). The box's EMA row (fast / slow) and MACD row (fast / slow / signal):
//     the same on 1m and 5m (12): EMA 5/13, 9/21, 12/26 (the default) or 20/50, crossed with MACD
//       6/13/5, 12/26/9 or 24/52/18;
//     the two timeframes set apart (4): fast on 1m with slow on 5m, slow on 1m with fast on 5m, fast on
//       1m with the default on 5m, the default on 1m with slow on 5m ("fast" = EMA 5/13 + MACD 6/13/5,
//       "slow" = EMA 20/50 + MACD 24/52/18).
//   The EMA row's warning stays the default ("speed").
// - Entries, exits, P&L, t by session: exactly research/databox_room.mjs (1,248 entries x 144 exits =
//   179,712 strategies a setting; 2.9 million over the 16).
// - Readings, each set against the same reading on every placebo market, the search over all 16
//   settings counting as one search:
//     all      the 10 best on 2019-2025 (2,000 trades there, 100 in 2026), read on 2026 as one book;
//     room     the same among roomy exits (a stop of 2 ATR or more, or none, held 40 minutes or more);
//     inside   2026 alone: the 10 best on Jan-Jun (100 trades), read on Jul-Oct (50);
//     reverse  the 10 best on 2026, each read on 2019-2025: their mean t there, and years positive;
//     avoid    NEW: the 10 WORST on 2019-2025, read on 2026: if some combinations reliably lose, these
//              keep losing (judged as low against the placebo markets' worst);
//     persist  every strategy's t on 2019-2025 against its t on 2026 (and Jan-Jun against Jul-Oct).
//   And per setting: each reading for that setting alone, against the same setting on the placebo
//   markets. With 16 settings x 5 readings about 8 sit beyond 90 of 100 by chance: a per-setting result
//   is a lead unless the pooled reading agrees.
// - A pass is the pooled "all", "room" or "inside" pick beating 95 of 100 placebo markets' picks (each
//   placebo market having searched the same 16 settings). Then it goes forward, never to a re-pick.
// - Check: with --settings 12/26 alone (the default) this reproduces databox_room.mjs's published
//   readings (all -1.70, room -0.86, inside -0.43, reverse 1.64 / 5.1 years, persist 0.075 / -0.172,
//   and its placebo markets' values, seeds 9600 + p).
//
// Sharding: --shard K --shards S measures placebo markets p with p % S === K, and shard 0 the real
// market too; each writes research/databox_tune_shard{K}.json. --merge reads them all.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { atr } from "../src/indicators.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const sopt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const PLACEBOS = opt("--placebos", 100), PLANT = opt("--plant", 0), SHARD = opt("--shard", 0), SHARDS = opt("--shards", 1), MERGE = args.includes("--merge");
const MIN = 60000, COST = 1.25, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55;
const Y0 = 2019, NY = 8, NS = 10, H2 = Date.UTC(2026, 6, 1), PICK = 10;
const slotName = (s) => (s < NY ? String(Y0 + s) : s === 8 ? "2026 Jan-Jun" : "2026 Jul-Oct");
const LEVELS = [0.5, 1, 2, 3, 5], NL = LEVELS.length;
const LIMITS = [15, 40, 120, Infinity], NLIM = LIMITS.length;
const EXITS = [];
for (let ti = 0; ti <= NL; ti++) for (let si = 0; si <= NL; si++) for (let li = 0; li < NLIM; li++) EXITS.push({ ti, si, li });
const NE = EXITS.length;
const lvl = (k) => (k === NL ? "none" : `${LEVELS[k]} ATR`);
const exitName = (e) => `target ${lvl(EXITS[e].ti)}, stop ${lvl(EXITS[e].si)}, ${LIMITS[EXITS[e].li] === Infinity ? "to 15:05" : `${LIMITS[EXITS[e].li]} min`}`;
const ROOMY = (e) => (EXITS[e].si >= 2) && LIMITS[EXITS[e].li] >= 40;
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

// ── the settings ──
const P = (ef, es, mf, ms, sg) => ({ emaFast: ef, emaSlow: es, macdFast: mf, macdSlow: ms, macdSignal: sg });
const EMAS = [[5, 13], [9, 21], [12, 26], [20, 50]], MACDS = [[6, 13, 5], [12, 26, 9], [24, 52, 18]];
const FAST = P(5, 13, 6, 13, 5), SLOW = P(20, 50, 24, 52, 18), DEF = P(12, 26, 12, 26, 9);
const ALL_SETTINGS = [];
for (const [ef, es] of EMAS) for (const [mf, ms, sg] of MACDS) { const p = P(ef, es, mf, ms, sg); ALL_SETTINGS.push({ id: `${ef}/${es}+${mf}/${ms}/${sg}`, name: `EMA ${ef}/${es}, MACD ${mf}/${ms}/${sg} (1m and 5m)`, p1: p, p5: p }); }
ALL_SETTINGS.push({ id: "fast1m-slow5m", name: "1m fast (EMA 5/13, MACD 6/13/5), 5m slow (EMA 20/50, MACD 24/52/18)", p1: FAST, p5: SLOW });
ALL_SETTINGS.push({ id: "slow1m-fast5m", name: "1m slow, 5m fast", p1: SLOW, p5: FAST });
ALL_SETTINGS.push({ id: "fast1m-def5m", name: "1m fast, 5m default", p1: FAST, p5: DEF });
ALL_SETTINGS.push({ id: "def1m-slow5m", name: "1m default, 5m slow", p1: DEF, p5: SLOW });
const ONLY = sopt("--settings", "");
const SETTINGS = ONLY ? ALL_SETTINGS.filter((s) => ONLY.split(",").some((q) => s.id === q || (q === "12/26" && s.id === "12/26+12/26/9"))) : ALL_SETTINGS;
if (!SETTINGS.length) throw new Error(`no setting matches ${ONLY}; ids: ${ALL_SETTINGS.map((s) => s.id).join(", ")}`);
const NSET = SETTINGS.length;

// ── the box and the combinations, as research/databox_room.mjs has them ──
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
function boxStates(T, minutes, props) {
  const run = new Run(BOX, { minutes, props: { emaWarning: "speed", vwapSlope: "off", ...props }, check: false }), map = run.calc.map.bind(run.calc);
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

const CAP26 = 260;
const S26A = MERGE ? null : new Float64Array(CAP26 * NK * NE), S26M = MERGE ? null : new Float64Array(CAP26 * NK), S26B = MERGE ? null : new Float64Array(CAP26 * 2 * NE);
const S26N = new Float64Array(CAP26), S26H = new Int8Array(CAP26);

// ── one market under one setting: databox_room.mjs's measure(), the box read at `setting` ──
const SA = NC * NS * 2, SB = NS * 2;
function measure(b, setting, plant = 0) {
  const N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const s1 = boxStates(b, 1, setting.p1), b5 = resample(b, 5), s5 = boxStates(b5, 5, setting.p5), a5 = atr(b5.high, b5.low, b5.close, 14);
  const cell = new Int16Array(N), A5 = new Float64Array(N);
  let k5 = -1;
  for (let i = 0; i < N; i++) {
    while (k5 + 1 < b5.ts.length && b5.ts[k5 + 1] + 5 * MIN <= TS[i] + MIN) k5++;
    cell[i] = s1.ema[i] + 5 * s1.macd[i] + 25 * (k5 >= 0 ? s5.ema[k5] : 0) + 125 * (k5 >= 0 ? s5.macd[k5] : 0);
    A5[i] = k5 >= 0 ? a5[k5] : NaN;
  }
  const An = new Float64Array(SA), Asum = new Float64Array(SA * NE), Aa2 = new Float64Array(SA * NE), Aab = new Float64Array(SA * NE), Aw = new Float64Array(SA * NE);
  const Bn = new Float64Array(SB), Bsum = new Float64Array(SB * NE), Bb2 = new Float64Array(SB * NE), Bw = new Float64Array(SB * NE), G = new Float64Array(NS);
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
    const Px = C[i], raw = C[i] - off[i], unit = A5[i], cost = (COST / raw) * 1e4, toBp = 1e4 / raw;
    tUp.fill(0); tDn.fill(0);
    let upMax = -Infinity, dnMax = -Infinity, m = 0, lastJ = i;
    for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
      m++; lastJ = j;
      const up = H[j] - Px, dn = Px - L[j];
      if (up > upMax) { upMax = up; for (let k = 0; k < NL; k++) if (!tUp[k] && up >= LEVELS[k] * unit) tUp[k] = m; }
      if (dn > dnMax) { dnMax = dn; for (let k = 0; k < NL; k++) if (!tDn[k] && dn >= LEVELS[k] * unit) tDn[k] = m; }
      for (let q = 0; q < NLIM - 1; q++) if (m === LIMITS[q]) { limC[q] = C[j]; limT[q] = m; }
    }
    if (!m) continue;
    for (let q = 0; q < NLIM; q++) if (q === NLIM - 1 || m < LIMITS[q]) { limC[q] = C[lastJ]; limT[q] = m; }
    for (let e = 0; e < NE; e++) {
      const { ti, si, li } = EXITS[e], tl2 = limT[li];
      for (let d = 0; d < 2; d++) {
        const tT = ti === NL ? 0 : d === 0 ? tUp[ti] : tDn[ti], tS = si === NL ? 0 : d === 0 ? tDn[si] : tUp[si];
        const hitT = tT > 0 && tT <= tl2, hitS = tS > 0 && tS <= tl2;
        let pts;
        if (hitS && (!hitT || tS <= tT)) pts = -LEVELS[si] * unit;
        else if (hitT) pts = LEVELS[ti] * unit;
        else pts = (d === 0 ? 1 : -1) * (limC[li] - Px);
        v[d * NE + e] = pts * toBp - cost;
      }
    }
    sn++;
    for (let q = 0; q < 2 * NE; q++) { const w = v[q]; sb[q] += w; if (w > 0) sbw[q]++; }
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

// ── reading one market under one setting (databox_room.mjs's, unchanged) ──
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
const tradesIn = (M, k, d, slots) => slots.reduce((s, sl) => s + M.An[(k * NS + sl) * 2 + d], 0);
// A candidate's 2026 sessions, saved before the next measure() refills the store, so picks from
// different settings can be read together as one book.
function slicesOf(M, k, d, e) {
  const kd = k * 2 + d, a = new Float64Array(M.n26), m = new Float64Array(M.n26), bb = new Float64Array(M.n26);
  for (let s = 0; s < M.n26; s++) { a[s] = S26A[(s * NK + kd) * NE + e]; m[s] = S26M[s * NK + kd]; bb[s] = S26B[s * 2 * NE + d * NE + e]; }
  return { a, m, bb };
}
// databox_room.mjs's combined(), on saved slices: a set of picks as one book over 2026's sessions
function combinedSaved(picks, n26, half) {
  const idx = [];
  for (let s = 0; s < n26; s++) if (half == null || S26H[s] === half) idx.push(s);
  const G = idx.length;
  let N = 0;
  for (const s of idx) N += S26N[s];
  const w = picks.map((p) => { let m = 0; for (const s of idx) m += p.sl.m[s]; return m / N; });
  let SY = 0, SY2 = 0, n = 0, sum = 0, base = 0;
  for (const s of idx) {
    let Y = 0;
    picks.forEach((p, j) => { const a = p.sl.a[s], bb = p.sl.bb[s]; Y += a - w[j] * bb; n += p.sl.m[s]; sum += a; base += w[j] * bb; });
    SY += Y; SY2 += Y * Y;
  }
  const v = G > 1 ? (G / (G - 1)) * Math.max(0, SY2 - (SY * SY) / G) : NaN;
  return { t: v > 0 ? SY / Math.sqrt(v) : NaN, net: n ? sum / n : NaN, base: n ? base / n : NaN, n, se: n && v > 0 ? Math.sqrt(v) / n : NaN };
}
// The PICK best (sign 1) or worst (sign -1) on `early`, with their `late` reading and their slices
function candidates(M, early, late, minE, minL, onlyRoomy, sign, setting) {
  const top = [];
  for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) {
    if (tradesIn(M, k, d, early) < minE || tradesIn(M, k, d, late) < minL) continue;
    for (let e = 0; e < NE; e++) {
      if (onlyRoomy && !ROOMY(e)) continue;
      const p = pooled(M, k, d, e, early), sc = sign * p.t;
      if (!(sc > (top.length < PICK ? -Infinity : top[top.length - 1].sc))) continue;
      top.push({ k, d, e, t: p.t, sc, set: setting });
      top.sort((a, b) => b.sc - a.sc);
      if (top.length > PICK) top.pop();
    }
  }
  for (const p of top) { p.l = pooled(M, p.k, p.d, p.e, late); p.sl = slicesOf(M, p.k, p.d, p.e); }
  return top;
}
function persistSums(M, early, late, minE, minL, acc) {
  for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) {
    if (tradesIn(M, k, d, early) < minE || tradesIn(M, k, d, late) < minL) continue;
    for (let e = 0; e < NE; e++) {
      const a = pooled(M, k, d, e, early).t, b = pooled(M, k, d, e, late).t;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      acc.n++; acc.sx += a; acc.sy += b; acc.sxx += a * a; acc.syy += b * b; acc.sxy += a * b;
    }
  }
  return acc;
}
const corr = (A) => (A.sxy - (A.sx * A.sy) / A.n) / Math.sqrt((A.sxx - (A.sx * A.sx) / A.n) * (A.syy - (A.sy * A.sy) / A.n));
const newAcc = () => ({ n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 });
const INS = [0, 1, 2, 3, 4, 5, 6];
function reverseCands(M, setting) {
  const top = [];
  for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) {
    if (tradesIn(M, k, d, [7]) < 100 || tradesIn(M, k, d, INS) < 2000) continue;
    for (let e = 0; e < NE; e++) {
      const p = pooled(M, k, d, e, [7]);
      if (!(p.t > (top.length < PICK ? -Infinity : top[top.length - 1].t))) continue;
      top.push({ k, d, e, t: p.t, set: setting });
      top.sort((a, b) => b.t - a.t);
      if (top.length > PICK) top.pop();
    }
  }
  for (const p of top) { p.l = pooled(M, p.k, p.d, p.e, INS); p.years = INS.filter((s) => pooled(M, p.k, p.d, p.e, [s]).ex > 0).length; }
  return top;
}
const best = (list, n = PICK) => list.slice().sort((a, b) => b.sc - a.sc).slice(0, n);
const revStat = (picks) => ({ t: picks.reduce((s, p) => s + p.l.t, 0) / picks.length, years: picks.reduce((s, p) => s + p.years, 0) / picks.length });

// One market, every setting: each setting's own readings, and the pooled ones over all settings
function marketReadings(bars, plant, keepDetail) {
  const pool = { all: [], room: [], inside: [], avoid: [], reverse: [] }, per = [], P1 = newAcc(), P2 = newAcc();
  let n26 = 0;
  for (const st of SETTINGS) {
    const M = measure(bars, st, plant);
    n26 = M.n26;
    const c = {
      all: candidates(M, INS, [7], 2000, 100, false, 1, st.id),
      room: candidates(M, INS, [7], 2000, 100, true, 1, st.id),
      inside: candidates(M, [8], [9], 100, 50, false, 1, st.id),
      avoid: candidates(M, INS, [7], 2000, 100, false, -1, st.id),
      reverse: reverseCands(M, st.id),
    };
    const p1 = persistSums(M, INS, [7], 2000, 100, newAcc()), p2 = persistSums(M, [8], [9], 100, 50, newAcc());
    for (const key of ["n", "sx", "sy", "sxx", "syy", "sxy"]) { P1[key] += p1[key]; P2[key] += p2[key]; }
    per.push({ id: st.id, all: combinedSaved(c.all, n26, null).t, room: combinedSaved(c.room, n26, null).t, inside: combinedSaved(c.inside, n26, 9).t,
      avoid: combinedSaved(c.avoid, n26, null).t, reverse: revStat(c.reverse).t, persist: corr(p1) });
    for (const key of Object.keys(pool)) pool[key].push(...c[key]);
    if (keepDetail) per[per.length - 1].detail = { all: c.all, avoid: c.avoid };
    // the real market's best list for the CSV, while this setting's accumulators are at hand
    if (keepDetail) per[per.length - 1].ranked = rankedFor(M, st.id);
  }
  const pk = { all: best(pool.all), room: best(pool.room), inside: best(pool.inside), avoid: best(pool.avoid) };
  const revPicks = pool.reverse.slice().sort((a, b) => b.t - a.t).slice(0, PICK);
  const R = {
    all: { ...combinedSaved(pk.all, n26, null), picks: pk.all }, room: { ...combinedSaved(pk.room, n26, null), picks: pk.room },
    inside: { ...combinedSaved(pk.inside, n26, 9), picks: pk.inside }, avoid: { ...combinedSaved(pk.avoid, n26, null), picks: pk.avoid },
    reverse: { ...revStat(revPicks), picks: revPicks }, persist: { r: corr(P1), n: P1.n }, persistInside: { r: corr(P2), n: P2.n }, per,
  };
  return R;
}
// the 300 best and 300 worst on 2019-2025 under a setting, every period, for the CSV
function rankedFor(M, id) {
  const all = [];
  for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) {
    if (tradesIn(M, k, d, INS) < 2000 || tradesIn(M, k, d, [7]) < 100) continue;
    for (let e = 0; e < NE; e++) { const p = pooled(M, k, d, e, INS); if (Number.isFinite(p.t)) all.push({ k, d, e, t: p.t }); }
  }
  all.sort((a, b) => b.t - a.t);
  const rows = [...all.slice(0, 300), ...all.slice(-300)];
  return rows.map((r) => ({ set: id, k: r.k, d: r.d, e: r.e, t: r.t,
    periods: Array.from({ length: NS }, (_, s) => { const p = pooled(M, r.k, r.d, r.e, [s]); return p.n ? [p.n, p.net, p.ex / p.n, p.t] : null; }) }));
}
const strip = (R) => ({ all: R.all.t, room: R.room.t, inside: R.inside.t, avoid: R.avoid.t, reverse: R.reverse.t, reverseYears: R.reverse.years, persist: R.persist.r, persistInside: R.persistInside.r,
  per: R.per.map(({ id, all, room, inside, avoid, reverse, persist }) => ({ id, all, room, inside, avoid, reverse, persist })) });

// ── measure ──
const SHARD_FILE = (k) => `research/databox_tune${ONLY ? "_" + ONLY.replace(/[^\w]+/g, "-") : ""}_shard${k}.json`;
if (!MERGE) {
  const { bars } = loadBars("data/mnq_1m_beta.bin");
  const out = { shard: SHARD, shards: SHARDS, settings: SETTINGS.map((s) => s.id), placebo: {} };
  if (SHARD === 0) {
    const R = marketReadings(bars, PLANT, true);
    process.stderr.write(`  real market, ${NSET} settings: ${secs()}s\n`);
    const pickOut = (p) => ({ set: p.set, entry: labelOf(p.k), dir: p.d ? "short" : "long", exit: exitName(p.e), tPicked: p.t, netRead: p.l.net, baseRead: p.l.base, winRead: p.l.win, tRead: p.l.t, nRead: p.l.n, years: p.years });
    out.real = { ...strip(R), n26: null,
      detail: { all: { t: R.all.t, net: R.all.net, base: R.all.base, se: R.all.se, n: R.all.n, picks: R.all.picks.map(pickOut) },
        room: { t: R.room.t, net: R.room.net, base: R.room.base, se: R.room.se, n: R.room.n, picks: R.room.picks.map(pickOut) },
        inside: { t: R.inside.t, net: R.inside.net, base: R.inside.base, se: R.inside.se, n: R.inside.n, picks: R.inside.picks.map(pickOut) },
        avoid: { t: R.avoid.t, net: R.avoid.net, base: R.avoid.base, se: R.avoid.se, n: R.avoid.n, picks: R.avoid.picks.map(pickOut) },
        reverse: { t: R.reverse.t, years: R.reverse.years, picks: R.reverse.picks.map(pickOut) },
        persist: R.persist, persistInside: R.persistInside },
      ranked: R.per.flatMap((p) => p.ranked.map((r) => ({ set: r.set, entry: labelOf(r.k), dir: r.d ? "short" : "long", exit: exitName(r.e), t: r.t, periods: r.periods }))) };
    if (PLANT) { console.log(JSON.stringify(strip(R), null, 1)); process.exit(0); }
  }
  for (let p = SHARD; p < PLACEBOS; p += SHARDS) {
    out.placebo[p] = strip(marketReadings(placeboBars(bars, 9600 + p), 0, false));
    process.stderr.write(`  placebo ${p} done (shard ${SHARD}), ${secs()}s\n`);
    fs.writeFileSync(SHARD_FILE(SHARD), JSON.stringify(out));
  }
  fs.writeFileSync(SHARD_FILE(SHARD), JSON.stringify(out));
  process.stderr.write(`  shard ${SHARD} written: ${SHARD_FILE(SHARD)}, ${secs()}s\n`);
  if (SHARDS > 1) process.exit(0);
}

// ── merge and print ──
const shards = Array.from({ length: SHARDS }, (_, k) => JSON.parse(fs.readFileSync(SHARD_FILE(k), "utf8")));
const real = shards[0].real, pl = shards.flatMap((s) => Object.values(s.placebo));
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—"), f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const PX26 = 29000 / 1e4, pts = (bp) => f2(bp * PX26), pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(0) + "%" : "—");
const rank = (vals, val) => { const zs = vals.filter(Number.isFinite).sort((a, b) => a - b); return { lo: zs[0], hi: zs[zs.length - 1], med: zs[zs.length >> 1], high: zs.filter((z) => z >= val).length, low: zs.filter((z) => z <= val).length, n: zs.length }; };
console.log(`databox_tune: ${shards[0].settings.length} settings x ${NC * 2 * NE} strategies, picked as one search; ${pl.length} placebo markets`);
const D = real.detail;
const show = (title, key, lateName, low) => {
  const P2 = D[key], r = rank(pl.map((p) => p[key]), P2.t);
  console.log(`\n${title}\n  as one book: ${pts(P2.net)} net points a trade against ${pts(P2.base)} from every minute with the same exits; t ${f1(P2.t)} by session.` +
              `\n  placebo markets' picks: t ${f1(r.lo)} to ${f1(r.hi)}, median ${f1(r.med)}; ${low ? r.low + " of " + r.n + " as low" : r.high + " of " + r.n + " as high"}`);
  for (const p of P2.picks) console.log(`  [${p.set}] ${(p.dir + " ").padEnd(6)}${p.entry.slice(0, 54).padEnd(55)} ${p.exit.padEnd(39)} t ${f1(p.tPicked).padStart(5)} | ${lateName}: ${pts(p.netRead).padStart(6)} (every minute ${pts(p.baseRead)}), wins ${pc(p.winRead)}, t ${f1(p.tRead)}, ${p.nRead} trades`);
};
show("ALL: the 10 best on 2019-2025 over every setting, read on 2026", "all", "2026");
show("ROOM: the same among stops of 2 ATR or more held 40 minutes or more", "room", "2026");
show("INSIDE 2026: the 10 best on Jan-Jun over every setting, read on Jul-Oct", "inside", "Jul-Oct");
show("AVOID: the 10 WORST on 2019-2025 over every setting, read on 2026 (do they keep losing?)", "avoid", "2026", true);
{
  const r = rank(pl.map((p) => p.reverse), D.reverse.t), ry = rank(pl.map((p) => p.reverseYears), D.reverse.years);
  console.log(`\nREVERSE: the 10 best on 2026, each read on 2019-2025: mean t ${f2(D.reverse.t)} (placebo ${f2(r.lo)} to ${f2(r.hi)}, median ${f2(r.med)}; ${r.high} of ${r.n} as high); years positive ${f2(D.reverse.years)} of 7 (placebo median ${f2(ry.med)}; ${ry.high} of ${ry.n} as high)`);
  for (const p of D.reverse.picks) console.log(`  [${p.set}] ${(p.dir + " ").padEnd(6)}${p.entry.slice(0, 54).padEnd(55)} ${p.exit.padEnd(39)} 2026 t ${f1(p.tPicked).padStart(5)} | 2019-2025 t ${f1(p.tRead)}, ${p.years}/7 years positive`);
}
for (const [key, title] of [["persist", "PERSIST: t on 2019-2025 against t on 2026, every strategy of every setting"], ["persistInside", "PERSIST INSIDE 2026: Jan-Jun against Jul-Oct"]]) {
  const r = rank(pl.map((p) => p[key]), D[key].r);
  console.log(`\n${title}: r ${f2(D[key].r)} over ${D[key].n.toLocaleString()}; placebo ${f2(r.lo)} to ${f2(r.hi)}, median ${f2(r.med)}; ${r.high} of ${r.n} as high`);
}
console.log(`\nPER SETTING (each against the same setting on the placebo markets; "hi" = placebo markets as high, "lo" = as low):`);
console.log(`${"setting".padEnd(18)}${"all t".padStart(7)}${"hi".padStart(4)}${"room t".padStart(8)}${"hi".padStart(4)}${"inside".padStart(8)}${"hi".padStart(4)}${"avoid".padStart(7)}${"lo".padStart(4)}${"rev t".padStart(7)}${"hi".padStart(4)}${"persist".padStart(9)}${"hi".padStart(4)}`);
let beyond = 0;
real.per.forEach((s, j) => {
  const col = (key, low) => { const r = rank(pl.map((p) => p.per[j][key]), s[key]); const c = low ? r.low : r.high; if (c <= 10) beyond++; return f2(s[key]).padStart(key === "persist" ? 9 : 7) + String(c).padStart(4); };
  console.log(`${s.id.padEnd(18)}${col("all")} ${col("room")} ${col("inside")}${col("avoid", true)}${col("reverse")}${col("persist")}`);
});
console.log(`  ${beyond} of ${real.per.length * 6} cells beat 90 of 100 placebo markets; about ${(real.per.length * 6 * 0.1).toFixed(0)} would by chance.`);
console.log(`\n(Points at 2026's price, about 29,000: 1 bp is 2.9 points.)`);
const tag = ONLY ? "_" + ONLY.replace(/[^\w]+/g, "-") : "";
fs.writeFileSync(`research/databox_tune${tag}_results.json`, JSON.stringify({ run: new Date().toISOString(), settings: shards[0].settings, placebos: pl.length, real: { ...real, ranked: undefined }, placebo: pl }, null, 1));
const csv = ["setting,entry,direction,exit,t_2019_2025," + Array.from({ length: NS }, (_, s) => `${slotName(s)} trades,${slotName(s)} net bp,${slotName(s)} excess bp,${slotName(s)} t`).join(",")];
for (const r of real.ranked) csv.push([r.set, `"${r.entry}"`, r.dir, `"${r.exit}"`, r.t.toFixed(2), ...r.periods.map((p) => (p ? `${p[0]},${p[1].toFixed(3)},${p[2].toFixed(3)},${f2(p[3])}` : "0,,,"))].join(","));
fs.writeFileSync(`research/databox_tune${tag}_ranked.csv`, csv.join("\n"));
console.log(`wrote research/databox_tune${tag}_results.json, research/databox_tune${tag}_ranked.csv (each setting's 300 best and 300 worst on 2019-2025, every period)`);
