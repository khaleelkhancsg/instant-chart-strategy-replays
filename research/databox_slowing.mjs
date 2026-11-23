// Momentum slowing: the EMA row's new warning against its other two and the MACD row's.
//
//   node --max-old-space-size=16384 research/databox_slowing.mjs [--placebos N]
//
// RESULT (2026-11-23; 100 placebo markets, 14 minutes): momentum slowing points to the turn no
// more than its own arithmetic does on random markets.
// - Timing, 2026, 37-point swing line: the 1m slowing warning fires before the turn 64-65% of the
//   time, as on placebo markets (64%; any minute 50%; the speed rule 40-44%). When it does, price
//   still goes 31-33 points the other way first (placebo 32; any minute 34). The 5m: 38-43% before
//   (placebo 41%). It fires early because Potentially long only exists on the short side, which
//   is mostly in falls.
// - Cross: 8% of slowing warnings are followed by a cross, as on placebo markets (8%). The other
//   92% clear back to the plain side within 2 minutes (1m) or 5-10 (5m).
// - Trades the way it points, excess a trade over every minute, averaged over the 144 exits:
//   2019-2025 -0.50 to -1.37 points (90-99 of 100 placebo markets as high: worse than random);
//   2026 -0.13 to +0.44 (41-57 of 100). The 1-ATR bracket in 2026: t -0.2 to 1.1 (14-54 of 100).
// - Not named, among the sixteen: the MACD row's own warning on 1m leans the right way in both
//   periods: +0.26/+0.40 points in 2019-2025 (9-15 of 100 as high), +0.69/+0.83 in 2026 (14-15),
//   Pot. short at the 1-ATR bracket +1.06 (t 2.0, 6 of 100). It is the fast MACD turn of
//   filter_frontier.mjs again. Every minute loses 1.17-1.45 points a trade averaged over the exits
//   in 2026, so it still loses.
// - Every combination with the slowing rule in the EMA rows (databox_room.mjs --ema-warning slowing,
//   100 placebo markets): 2019-2025's 10 best lost 1.78 points a trade in 2026 against 1.10 for every
//   minute (65 of 100 placebo picks as high); roomy exits 73 of 100; Jan-Jun read on Jul-Oct t 1.3
//   (11 of 100); persistence r 0.03 (41 of 100).
//
// The person's idea (2026-11-23): the rate of the EMA gap slowing shows momentum fading, which can
// point to a reversal before the lines converge. The box's EMA row warned only once the gap closed
// faster than the bar before ("speed"); "slowing" warns as soon as the gap moves its side's way by
// less than the bar before, still widening or already closing. The indicator has it as its third
// choice (emaWarning "slowing"), and this test reads the indicator's own arithmetic.
//
// - Warnings: each row on 1m and 5m (the 5m rows at the last closed 5-minute bar), New York
//   minutes closing 08:30-14:55 CT, 2019-2026. The EMA row under its three rules (speed, closer:
//   any closing gap, slowing) and the MACD row (histogram smaller than the bar before). An event is
//   the minute a row turns Potentially long (still Short) or Potentially short (still Long): 16.
// - Read three ways, each against every New York minute and against placebo markets (real bars,
//   each minute's direction flipped at random, the box run on them):
//     timing   on the swing line (research/databox_swings.mjs: zig-zag pivots 0.1275% and 0.064%
//              of the price, 37 and 18 points in 2026), 2026: the share that fire before the turn
//              they point to, the points price still goes the other way first (median), and for
//              those after the turn the share of the swing already done;
//     cross    what the row does next: crosses (the lines swap sides) or clears (back to its plain
//              side, no cross), and the minutes to it; the share that cross, 2026;
//     trades   in at the minute's close the way the warning points (Potentially long a long), the
//              144 exits of research/databox_room.mjs: the excess a trade over every minute with the
//              same exits, direction and year, averaged over the 144 exits, 2019-2025 and 2026; and
//              at one bracket (1 ATR target, 1 ATR stop, to 15:05) with t by session.
// - Named before the run: the slowing rule's four events, each statistic against placebo markets.
//   The other twelve events are there to compare with, already tested in databox_swings.mjs and
//   databox_combos.mjs.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { atr, zigzagPivots } from "../src/indicators.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const PLACEBOS = opt("--placebos", 100);
const MIN = 60000, COST = 1.25, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, UNIT = 10 / 7844, SIZES = [1, 0.5];
const Y0 = 2019, NY = 8, NS = 10, H2 = Date.UTC(2026, 6, 1);
const LEVELS = [0.5, 1, 2, 3, 5], NL = LEVELS.length, LIMITS = [15, 40, 120, Infinity], NLIM = LIMITS.length;
const EXITS = [];
for (let ti = 0; ti <= NL; ti++) for (let si = 0; si <= NL; si++) for (let li = 0; li < NLIM; li++) EXITS.push({ ti, si, li });
const NE = EXITS.length, BRACKET = EXITS.findIndex((x) => x.ti === 1 && x.si === 1 && x.li === NLIM - 1);
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

// ── the box, once a timeframe; the EMA row's codes under each rule from its gap ──
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
const bars4 = (T) => Array.from({ length: T.close.length }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] }));
function capture(T, minutes) {
  const run = new Run(BOX, { minutes, check: false }), map = run.calc.map.bind(run.calc), n = T.close.length;
  const side = new Int8Array(n), diff = new Float64Array(n), ready = new Uint8Array(n), macd = new Int8Array(n);
  run.calc.map = (d, i) => { const out = map(d, i), S = run.calc.st[i]; side[i] = S.ema.side; diff[i] = S.ema.diff; ready[i] = S.emaReady ? 1 : 0; macd[i] = code(S.macd, S.macdReady); return out; };
  run.compute(bars4(T));
  return { side, diff, ready, macd };
}
// the indicator's rowStep, rule by rule, from the gap
const RULES = ["speed", "closer", "slowing"];
function emaCodes(c, rule) {
  const n = c.side.length, out = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const s = c.side[i];
    if (!c.ready[i] || !s) continue;
    let warn = false;
    if (rule === "closer") warn = i >= 1 && (s === 1 ? c.diff[i] < c.diff[i - 1] : c.diff[i] > c.diff[i - 1]);
    else if (i >= 2) {
      const m = c.diff[i] - c.diff[i - 1], pm = c.diff[i - 1] - c.diff[i - 2];
      warn = rule === "speed" ? (s === 1 ? m < 0 && m < pm : m > 0 && m > pm) : s === 1 ? m < pm : m > pm;
    }
    out[i] = s === 1 ? (warn ? 2 : 1) : warn ? 4 : 3;
  }
  return out;
}
// the indicator itself, run under a rule: for the check that emaCodes is its arithmetic
function emaOwn(T, minutes, rule) {
  const run = new Run(BOX, { minutes, props: { emaWarning: rule }, check: false }), map = run.calc.map.bind(run.calc), out = new Int8Array(T.close.length);
  run.calc.map = (d, i) => { const o = map(d, i), S = run.calc.st[i]; out[i] = code(S.ema, S.emaReady); return o; };
  run.compute(bars4(T));
  return out;
}

// ── the events ──
const EVENTS = [];
for (const [tf, t] of [["1m", 0], ["5m", 1]]) {
  for (const rule of RULES) for (const [st, dir, nm] of [[4, 1, "Pot. long"], [2, -1, "Pot. short"]]) EVENTS.push({ name: `${tf} EMA ${nm} (${rule})`, t, row: `${tf} EMA ${rule}`, st, dir, rule });
  for (const [st, dir, nm] of [[4, 1, "Pot. long"], [2, -1, "Pot. short"]]) EVENTS.push({ name: `${tf} MACD ${nm}`, t, row: `${tf} MACD`, st, dir, rule: "macd" });
}
const NEV = EVENTS.length, NAMED = EVENTS.map((e, k) => (e.rule === "slowing" ? k : -1)).filter((k) => k >= 0);

// ── one market ──
const SA = NEV * NS, SB = NS * 2;
function measure(b, verify = false) {
  const N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const b5 = resample(b, 5), n5 = b5.close.length, a5 = atr(b5.high, b5.low, b5.close, 14);
  const c1 = capture(b, 1), c5 = capture(b5, 5);
  const rows1 = Object.fromEntries([...RULES.map((r) => [`1m EMA ${r}`, emaCodes(c1, r)]), ["1m MACD", c1.macd]]);
  const rows5 = Object.fromEntries([...RULES.map((r) => [`5m EMA ${r}`, emaCodes(c5, r)]), ["5m MACD", c5.macd]]);
  if (verify) for (const r of RULES) for (const [T, m, own] of [[b, 1, rows1[`1m EMA ${r}`]], [b5, 5, rows5[`5m EMA ${r}`]]]) {
    const ind = emaOwn(T, m, r);
    for (let i = 0; i < ind.length; i++) if (ind[i] !== own[i]) throw new Error(`${m}m EMA ${r}: the rule's codes differ from the indicator's at bar ${i}: ${own[i]} against ${ind[i]}`);
  }
  // every row a minute: the 5m rows at the last 5-minute bar closed by the minute's close
  const R = {}, A5 = new Float64Array(N);
  for (const k of Object.keys(rows1)) R[k] = rows1[k];
  for (const k of Object.keys(rows5)) R[k] = new Int8Array(N);
  let k5 = -1;
  for (let i = 0; i < N; i++) {
    while (k5 + 1 < n5 && b5.ts[k5 + 1] + 5 * MIN <= TS[i] + MIN) k5++;
    for (const k of Object.keys(rows5)) R[k][i] = k5 >= 0 ? rows5[k][k5] : 0;
    A5[i] = k5 >= 0 ? a5[k5] : NaN;
  }
  const EV = EVENTS.map((e) => R[e.row]);
  // the swing lines
  const Z = SIZES.map((s) => zigzagPivots(b.high, b.low, b.close, s * UNIT, off));

  const An = new Float64Array(SA), Asum = new Float64Array(SA * NE), Aa2 = new Float64Array(SA * NE), Aab = new Float64Array(SA * NE), Aw = new Float64Array(SA * NE);
  const Bn = new Float64Array(SB), Bsum = new Float64Array(SB * NE), Bb2 = new Float64Array(SB * NE), Bw = new Float64Array(SB * NE), G = new Float64Array(NS);
  const sa = new Float64Array(NEV * NE), sw = new Float64Array(NEV * NE), sm = new Float64Array(NEV), sb = new Float64Array(2 * NE), sbw = new Float64Array(2 * NE);
  let sn = 0, sTd = -1, sSlots = [];
  const flush = () => {
    if (!sn) return;
    for (const s of sSlots) {
      G[s]++;
      for (let d = 0; d < 2; d++) { const x = s * 2 + d, o = x * NE, so = d * NE; Bn[x] += sn; for (let e = 0; e < NE; e++) { const w = sb[so + e]; Bsum[o + e] += w; Bb2[o + e] += w * w; Bw[o + e] += sbw[so + e]; } }
      for (let k = 0; k < NEV; k++) {
        if (!sm[k]) continue;
        const x = k * NS + s, o = x * NE, so = k * NE, bo = (EVENTS[k].dir === 1 ? 0 : 1) * NE;
        An[x] += sm[k];
        for (let e = 0; e < NE; e++) { const a = sa[so + e]; Asum[o + e] += a; Aa2[o + e] += a * a; Aab[o + e] += a * sb[bo + e]; Aw[o + e] += sw[so + e]; }
      }
    }
    sa.fill(0); sw.fill(0); sm.fill(0); sb.fill(0); sbw.fill(0); sn = 0;
  };
  // timing and cross, 2026: per size x (event | any minute) lists
  const TIM = SIZES.map(() => Array.from({ length: NEV + 1 }, () => ({ withN: 0, againstN: 0, done: [], toTurn: [] })));
  const CROSS = Array.from({ length: NEV }, () => ({ n: 0, crossed: 0, cleared: 0, minCross: [], minClear: [] }));
  const leg = SIZES.map(() => 0);
  const tUp = new Int16Array(NL), tDn = new Int16Array(NL), limC = new Float64Array(NLIM), limT = new Int16Array(NLIM), v = new Float64Array(2 * NE);
  for (let i = 1; i + 1 < N; i++) {
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i] || !(A5[i] > 0)) continue;
    const y = new Date(TS[i]).getUTCFullYear() - Y0;
    if (y < 0 || y >= NY) continue;
    if (TD[i] !== sTd) { flush(); sTd = TD[i]; sSlots = y === NY - 1 ? [y, TS[i] < H2 ? 8 : 9] : [y]; }
    const P = C[i], raw = C[i] - off[i], unit = A5[i], cost = (COST / raw) * 1e4, toBp = 1e4 / raw;
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
    for (let q = 0; q < NLIM; q++) if (q === NLIM - 1 || m < LIMITS[q]) { limC[q] = C[lastJ]; limT[q] = m; }
    for (let e = 0; e < NE; e++) {
      const { ti, si, li } = EXITS[e], tl = limT[li];
      for (let d = 0; d < 2; d++) {
        const tT = ti === NL ? 0 : d === 0 ? tUp[ti] : tDn[ti], tS = si === NL ? 0 : d === 0 ? tDn[si] : tUp[si];
        const hitT = tT > 0 && tT <= tl, hitS = tS > 0 && tS <= tl;
        const pts = hitS && (!hitT || tS <= tT) ? -LEVELS[si] * unit : hitT ? LEVELS[ti] * unit : (d === 0 ? 1 : -1) * (limC[li] - P);
        v[d * NE + e] = pts * toBp - cost;
      }
    }
    sn++;
    for (let q = 0; q < 2 * NE; q++) { const w = v[q]; sb[q] += w; if (w > 0) sbw[q]++; }
    // the swing legs at this minute, 2026
    const legs = SIZES.map((_, z) => {
      const Zz = Z[z], NP = Zz.I.length;
      while (leg[z] + 1 < NP && Zz.I[leg[z] + 1] < i) leg[z]++;
      const k = leg[z];
      return k + 1 < NP && Zz.I[k] < i ? { dir: Zz.K[k] === -1 ? 1 : -1, pA: Zz.P[k], pB: Zz.P[k + 1] } : null;
    });
    const place = (slot, d) => {
      for (let z = 0; z < SIZES.length; z++) {
        const g = legs[z];
        if (!g) continue;
        const s = TIM[z][slot];
        if (d === g.dir) { const span = Math.abs(g.pB - g.pA); s.withN++; s.done.push(span > 0 ? (d * (P - g.pA)) / span : 0); }
        else { s.againstN++; s.toTurn.push(d * (P - g.pB)); }
      }
    };
    if (y === NY - 1) { place(NEV, 1); place(NEV, -1); }
    for (let k = 0; k < NEV; k++) {
      const ev = EVENTS[k], c = EV[k];
      if (c[i] !== ev.st || c[i - 1] === ev.st) continue;
      sm[k]++;
      const so = k * NE, vo = (ev.dir === 1 ? 0 : 1) * NE;
      for (let e = 0; e < NE; e++) { const w = v[vo + e]; sa[so + e] += w; if (w > 0) sw[so + e]++; }
      if (y === NY - 1) {
        place(k, ev.dir);
        // what the row does next, in the session
        const X = CROSS[k], plain = ev.st === 4 ? 3 : 1, other = ev.st === 4 ? [1, 2] : [3, 4];
        X.n++;
        for (let j = i + 1; j < N && TD[j] === TD[i]; j++) {
          if (other.includes(c[j])) { X.crossed++; X.minCross.push(j - i); break; }
          if (c[j] === plain) { X.cleared++; X.minClear.push(j - i); break; }
        }
      }
    }
  }
  flush();
  return { An, Asum, Aa2, Aab, Aw, Bn, Bsum, Bb2, Bw, G, TIM, CROSS };
}

// ── reading one market ──
function pooled(M, k, e, slots) {
  const d = EVENTS[k].dir === 1 ? 0 : 1;
  let n = 0, ex = 0, v = 0;
  for (const s of slots) {
    const x = k * NS + s, m = M.An[x], g = M.G[s];
    if (!m || g < 2) continue;
    const o = x * NE + e, bo = (s * 2 + d) * NE + e, w = m / M.Bn[s * 2 + d], A = M.Asum[o], B = M.Bsum[bo];
    const Y = A - w * B, Y2 = M.Aa2[o] - 2 * w * M.Aab[o] + w * w * M.Bb2[bo];
    n += m; ex += Y; v += (g / (g - 1)) * Math.max(0, Y2 - (Y * Y) / g);
  }
  return { n, ex: n ? ex / n : NaN, t: v > 0 ? ex / Math.sqrt(v) : NaN };
}
const med = (xs) => { if (!xs.length) return NaN; const s = Float64Array.from(xs).sort(); return s[s.length >> 1]; };
const INS = [0, 1, 2, 3, 4, 5, 6];
function read(M) {
  return EVENTS.map((_, k) => {
    let a = 0, b = 0, c = 0, d = 0;
    for (let e = 0; e < NE; e++) { a += pooled(M, k, e, INS).ex; b += pooled(M, k, e, [7]).ex; c += pooled(M, k, e, [8]).ex; d += pooled(M, k, e, [9]).ex; }
    const br = pooled(M, k, BRACKET, [7]), X = M.CROSS[k];
    const tim = M.TIM.map((T) => { const s = T[k], n = s.withN + s.againstN; return { before: n ? s.againstN / n : NaN, toTurn: med(s.toTurn), done: med(s.done), n }; });
    return { n26: M.An[k * NS + 7], n19: INS.reduce((s, sl) => s + M.An[k * NS + sl], 0), ex19: a / NE, ex26: b / NE, exH1: c / NE, exH2: d / NE, br26: br.ex, brT26: br.t,
             before37: tim[0].before, toTurn37: tim[0].toTurn, done37: tim[0].done, before18: tim[1].before, toTurn18: tim[1].toTurn,
             crossed: X.n ? X.crossed / X.n : NaN, minCross: med(X.minCross), cleared: X.n ? X.cleared / X.n : NaN, minClear: med(X.minClear) };
  });
}
const anyMinute = (M) => M.TIM.map((T) => { const s = T[NEV], n = s.withN + s.againstN; return { before: s.againstN / n, toTurn: med(s.toTurn), done: med(s.done) }; });

const { bars } = loadBars("data/mnq_1m_beta.bin");
const realM = measure(bars, true);
const real = read(realM), realAny = anyMinute(realM);
process.stderr.write(`  real market (each rule checked against the indicator's own codes): ${secs()}s\n`);
const pl = [], plAny = [];
for (let p = 0; p < PLACEBOS; p++) {
  const M = measure(placeboBars(bars, 9800 + p));
  pl.push(read(M)); plAny.push(anyMinute(M));
  if ((p + 1) % 5 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
}

// ── print ──
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : "—"), f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—"), f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const PX26 = 29000 / 1e4, pts = (bp) => f2(bp * PX26), pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(0) + "%" : "—");
const plMed = (k, key) => med(pl.map((r) => r[k][key]).filter(Number.isFinite));
const asHigh = (k, key) => { const zs = pl.map((r) => r[k][key]).filter(Number.isFinite); return zs.length ? `${zs.filter((z) => z >= real[k][key]).length}/${zs.length}` : "—"; };
const anyMed = (z, key) => med(plAny.map((a) => a[z][key]).filter(Number.isFinite));
console.log(`${NEV} warning events (the slowing rule's four named), ${PLACEBOS} placebo markets; ${secs()}s`);
console.log(`\nTIMING, 2026, on the 37-point swing line: the share that fire before the turn they point to, and the points price still goes the other way first (median)`);
console.log(`  any minute (both ways): ${pc(realAny[0].before)} before, ${f1(realAny[0].toTurn)} points to go (placebo markets ${pc(anyMed(0, "before"))}, ${f1(anyMed(0, "toTurn"))})`);
console.log(`${"event".padEnd(30)}${"n 2026".padStart(7)}${"before".padStart(8)}${"(placebo)".padStart(10)}${"pts to go".padStart(10)}${"(placebo)".padStart(10)}${"done if after".padStart(14)}${"(placebo)".padStart(10)}  | 18-pt line: before, pts to go`);
EVENTS.forEach((ev, k) => {
  const r = real[k];
  console.log(`${(NAMED.includes(k) ? "* " : "  ") + ev.name.padEnd(28)}${f0(r.n26).padStart(7)}${pc(r.before37).padStart(8)}${pc(plMed(k, "before37")).padStart(10)}${f1(r.toTurn37).padStart(10)}${f1(plMed(k, "toTurn37")).padStart(10)}${pc(r.done37).padStart(14)}${pc(plMed(k, "done37")).padStart(10)}  | ${pc(r.before18)}, ${f1(r.toTurn18)}`);
});
console.log(`\nCROSS, 2026: what the row does next in the session`);
console.log(`${"event".padEnd(30)}${"crosses".padStart(9)}${"(placebo)".padStart(10)}${"min to it".padStart(10)}${"clears".padStart(8)}${"min to it".padStart(10)}`);
EVENTS.forEach((ev, k) => {
  const r = real[k];
  console.log(`${(NAMED.includes(k) ? "* " : "  ") + ev.name.padEnd(28)}${pc(r.crossed).padStart(9)}${pc(plMed(k, "crossed")).padStart(10)}${f0(r.minCross).padStart(10)}${pc(r.cleared).padStart(8)}${f0(r.minClear).padStart(10)}`);
});
console.log(`\nTRADES, in at the close the way the warning points: excess a trade over every minute with the same exits, in points at 2026's price`);
console.log(`${"event".padEnd(30)}${"mean of 144 exits:".padStart(20)}${"2019-25".padStart(9)}${"as high".padStart(9)}${"2026".padStart(8)}${"as high".padStart(9)}${"Jan-Jun".padStart(9)}${"Jul-Oct".padStart(9)}  | 1-ATR bracket 2026: excess, t, as high`);
EVENTS.forEach((ev, k) => {
  const r = real[k];
  console.log(`${(NAMED.includes(k) ? "* " : "  ") + ev.name.padEnd(28)}${"".padStart(20)}${pts(r.ex19).padStart(9)}${asHigh(k, "ex19").padStart(9)}${pts(r.ex26).padStart(8)}${asHigh(k, "ex26").padStart(9)}${pts(r.exH1).padStart(9)}${pts(r.exH2).padStart(9)}  | ${pts(r.br26)}, t ${f1(r.brT26)}, ${asHigh(k, "brT26")}`);
});
console.log(`\n(* named before the run. "as high": placebo markets whose same event scored as high. ${secs()}s)`);
fs.writeFileSync("research/databox_slowing_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS, events: EVENTS.map((e) => e.name), named: NAMED.map((k) => EVENTS[k].name),
  real, realAny, placeboMedian: EVENTS.map((_, k) => Object.fromEntries(Object.keys(real[k]).map((key) => [key, plMed(k, key)]))), placebo: pl }, null, 1));
console.log("wrote research/databox_slowing_results.json");
