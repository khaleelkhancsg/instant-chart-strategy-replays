// Can the bars say which way to lean? A regime bias -- long, short or none -- read from
// the bars up to each close on 5-minute to weekly bars, against the move that came next,
// in each calendar year on its own (2019 from May; 2026 to the end of the file).
//
//   node --max-old-space-size=8192 research/regime_bias.mjs [bars file] [--placebo N]
//
// The bars file defaults to data/mnq_1m_beta.bin; N, the placebo markets, to 100 (about eight
// minutes in all). The results go to research/regime_bias_results.json as well.
//
// The raw edge: how much more the next bar rose when the bias said long than when it said
// short, in basis points of the contract's real price. The drift cancels in it: always-long
// scores 0, though it made money in every year but 2022.
//
// But the raw edge leans negative on its own. A move against the bias tends to flip the
// bias for the bars after it, which shrinks that move's own group and so weighs it more,
// most of all for slow daily and weekly biases. A slide null keeps none of that. So each
// edge is judged against its own placebo edges: the same bias, timeframe and year on N
// placebo markets (research/lib_levels.mjs placeboBars: each 1-minute bar's move turned
// up-for-down at random, its size, volume and clock kept), where no bias can know
// anything. The edge shown is the real one less the placebos' mean, and z is that in
// placebo standard deviations.
//
// The counts at the end are read against the same thing done to each placebo market in
// turn, judged against the other N-1: the range no-knowledge gives.
//
// The biases: price against its EMAs, session and week VWAP; EMA crosses; recent moves;
// the Donchian middle; MACD's histogram, its line against zero and the histogram rising;
// ADX's stronger DI; Supertrend; RSI 14 over 50; RSI 14 and RSI 2
// at their extremes, long above (a negative edge says fade them).
//
// The level: how hard the market leans, not just which way. The distance from the 50 EMA
// and the 20-bar move, each in ATRs, cut into fifths by every earlier year's readings (so
// the first year has none). Its edge is the strongest fifth's next move less the weakest's.
//
// Follow: one MNQ held the bias's way on the real bars, in dollars, after a tick of
// slippage and $0.75 a side for each change. "1D -> next RTH" holds the daily bias through
// the next New York session only, 09:30 to 16:00.
//
// RESULT (run 2026-11-20, data/mnq_1m_beta.bin to Oct 30, 100 placebo markets; 20 biases and
// 2 levels on 7 timeframes): taken together, no bias calls the next move better than random
// markets.
//   - 47 of 1,090 year-cells sit outside 1.96 placebo standard deviations (10 with the bias, 37
//     against). Each placebo market judged against the others gives 14-114, median 60: 79% of
//     them have at least as many.
//   - 6 biases are above their placebos in all but at most one year (placebos 0-30, p 0.35), and
//     13 below (0-22, p 0.13).
//   - Of the 28 timeframe-by-timeframe p-values, luck alone puts about 1.4 under 0.05; one is.
//     The daily bias held through the next New York session was on the wrong side every year
//     for two biases (EMA 20 vs 50, the MACD line against zero), p 0.01: when the daily trend
//     is up, that session does worse. Next, at p 0.07: 15-minute price against the week's VWAP
//     right every year, 5-minute RSI 2 at 90 / 10 wrong every year, and daily biases against
//     the next session (13 cells).
//   - 15-minute price against the week's VWAP is above its placebos in all 8 years, but by
//     0.13-0.44 points a bar and never past 1.96 sd in a year. Followed with one MNQ after costs
//     it made money in all 8 years, from +$15 (2019) to +$7,838 (2021). It is a lead, found
//     after the fact.
//   - With 20 placebo markets, two 5-minute trend biases (EMA 50, EMA 9 vs 21) looked right
//     every year (p 0.10). With 100, each misses a year: a 20-market p is too coarse to lean on.
//   - Reversal at 5 minutes is steady, but about 0.3 points a bar. Faded with one MNQ, the last
//     bar's direction earned $6,500-21,000 a year before costs, against $60,000-91,000 of costs.
//   - How hard the market leans adds nothing on any timeframe.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { sessionsOf, rawOffsets } from "../src/levels.mjs";
import { ema, atr, adx, donchian, macd, supertrend, rsi, vwap } from "../src/indicators.mjs";
import { placeboBars } from "./lib_levels.mjs";

const args = process.argv.slice(2), pi = args.indexOf("--placebo");
const PLACEBOS = pi >= 0 ? Number(args[pi + 1]) || 100 : 100;
const FILE = args.find((a, k) => !a.startsWith("--") && (pi < 0 || k !== pi + 1)) || "data/mnq_1m_beta.bin";
const SIDE_USD = 0.5 + 0.75;

// ── the biases: +1 long, -1 short, 0 none or still warming up ──
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const sig = (n, warm, f) => { const s = new Int8Array(n); for (let i = warm; i < n; i++) { const v = f(i); s[i] = v === v ? sgn(v) : 0; } return s; };
const BIASES = [
  ["price vs EMA 20", (b) => { const e = ema(b.C, 20); return sig(b.n, 40, (i) => b.C[i] - e[i]); }],
  ["price vs EMA 50", (b) => { const e = ema(b.C, 50); return sig(b.n, 100, (i) => b.C[i] - e[i]); }],
  ["price vs EMA 200", (b) => { const e = ema(b.C, 200); return sig(b.n, 400, (i) => b.C[i] - e[i]); }],
  ["EMA 9 vs EMA 21", (b) => { const f = ema(b.C, 9), s = ema(b.C, 21); return sig(b.n, 42, (i) => f[i] - s[i]); }],
  ["EMA 20 vs EMA 50", (b) => { const f = ema(b.C, 20), s = ema(b.C, 50); return sig(b.n, 100, (i) => f[i] - s[i]); }],
  ["EMA 50 vs EMA 200", (b) => { const f = ema(b.C, 50), s = ema(b.C, 200); return sig(b.n, 400, (i) => f[i] - s[i]); }],
  ["the last bar's direction", (b) => sig(b.n, 1, (i) => b.C[i] - b.C[i - 1])],
  ["the 10-bar move", (b) => sig(b.n, 10, (i) => b.C[i] - b.C[i - 10])],
  ["the 50-bar move", (b) => sig(b.n, 50, (i) => b.C[i] - b.C[i - 50])],
  ["Donchian 20: above the middle", (b) => { const d = donchian(b.H, b.L, 20); return sig(b.n, 20, (i) => b.C[i] - (d.high[i] + d.low[i]) / 2); }],
  ["MACD 12/26/9 histogram", (b) => { const m = macd(b.C); return sig(b.n, 100, (i) => m.hist[i]); }],
  ["MACD 12/26/9 line above zero", (b) => { const m = macd(b.C); return sig(b.n, 100, (i) => m.line[i]); }],
  ["MACD 12/26/9 histogram rising", (b) => { const m = macd(b.C); return sig(b.n, 100, (i) => m.hist[i] - m.hist[i - 1]); }],
  ["ADX 14 over 20: the stronger DI", (b) => { const a = adx(b.H, b.L, b.C, 14); return sig(b.n, 60, (i) => (a.adx[i] > 20 ? a.pdi[i] - a.ndi[i] : 0)); }],
  ["Supertrend 10 x 3", (b) => { const t = supertrend(b.H, b.L, b.C, 10, 3).trend; return sig(b.n, 30, (i) => t[i]); }],
  // VWAP from the 1-minute bars, anchored at the CME session's or week's open, as it stood at the bar's close
  ["price vs session VWAP", (b) => sig(b.n, 1, (i) => b.C[i] - b.vS[i])],
  ["price vs week VWAP", (b) => sig(b.n, 1, (i) => b.C[i] - b.vW[i])],
  ["RSI 14 over 50", (b) => { const r = rsi(b.C, 14); return sig(b.n, 42, (i) => r[i] - 50); }],
  // an extreme as a long or short; a negative edge says fading it is the better reading
  ["RSI 14 beyond 70 / 30, long above", (b) => { const r = rsi(b.C, 14); return sig(b.n, 42, (i) => (r[i] > 70 ? 1 : r[i] < 30 ? -1 : 0)); }],
  ["RSI 2 beyond 90 / 10, long above", (b) => { const r = rsi(b.C, 2); return sig(b.n, 6, (i) => (r[i] > 90 ? 1 : r[i] < 10 ? -1 : 0)); }],
];
const LEVELS = [
  ["level: from the 50 EMA in ATRs, top fifth vs bottom", (b) => { const e = ema(b.C, 50), a = atr(b.H, b.L, b.C, 14); return (i) => (i >= 100 ? (b.C[i] - e[i]) / a[i] : NaN); }],
  ["level: the 20-bar move in ATRs, top fifth vs bottom", (b) => { const a = atr(b.H, b.L, b.C, 14); return (i) => (i >= 40 ? (b.C[i] - b.C[i - 20]) / a[i] : NaN); }],
];

// mean next move when long less when short, over moves [lo, hi)
function edge(r, s, lo, hi) {
  let sl = 0, nl = 0, ss = 0, ns = 0;
  for (let i = lo; i < hi; i++) {
    const v = s[i], x = r[i];
    if (!(x === x) || v === 0) continue;
    if (v > 0) { sl += x; nl++; } else { ss += x; ns++; }
  }
  return nl > 5 && ns > 5 ? sl / nl - ss / ns : NaN;
}
// one MNQ the bias's way, after costs
function follow(pts, s, lo, hi, rth) {
  let usd = 0, prev = 0;
  for (let i = lo; i < hi; i++) {
    const v = s[i], x = pts[i];
    if (!(x === x)) continue;
    usd += v * x * 2 - SIDE_USD * (rth ? 2 * Math.abs(v) : Math.abs(v - prev));
    prev = v;
  }
  return usd;
}

// The whole study on one set of 1-minute bars: every timeframe, bias and year's raw edge.
function study(B, withFollow) {
  const off = rawOffsets(B);
  const wk = Int32Array.from(B.tday, (td) => Math.floor((td + 3) / 7));
  const vS1 = vwap(B.high, B.low, B.close, B.volume, B.tday), vW1 = vwap(B.high, B.low, B.close, B.volume, wk);
  const withVwap = (tf) => ({ ...tf, vS: Float64Array.from(tf.last, (j) => vS1[j]), vW: Float64Array.from(tf.last, (j) => vW1[j]) });
  const minuteTf = (m) => {
    const b = resample(B, m), n = b.close.length, end = new Float64Array(n);
    for (let i = 0; i < n; i++) end[i] = B.ts[b.srcLast[i]];
    return withVwap({ C: b.close, H: b.high, L: b.low, end, last: b.srcLast, n });
  };
  // CME sessions grouped by `keyOf(td)`: one a day, or one a week
  const sessionTf = (keyOf) => {
    const C = [], H = [], L = [], end = [], last = [], rthO = [], rthC = [], rthOff = [];
    let key = null;
    for (const s of sessionsOf(B)) {
      let hi = -Infinity, lo = Infinity;
      for (let i = s.a; i < s.z; i++) { if (B.high[i] > hi) hi = B.high[i]; if (B.low[i] < lo) lo = B.low[i]; }
      const k = keyOf(s.td), j = k === key ? C.length - 1 : C.length;
      if (k !== key) { key = k; C.push(0); H.push(hi); L.push(lo); end.push(0); last.push(0); rthO.push(NaN); rthC.push(NaN); rthOff.push(0); }
      C[j] = B.close[s.z - 1]; H[j] = Math.max(H[j], hi); L[j] = Math.min(L[j], lo); end[j] = B.ts[s.z - 1]; last[j] = s.z - 1;
      if (s.rthA >= 0) { rthO[j] = B.open[s.rthA]; rthC[j] = B.close[s.rthZ - 1]; rthOff[j] = off[s.rthA]; }
    }
    const F = (a) => Float64Array.from(a);
    return withVwap({ C: F(C), H: F(H), L: F(L), end: F(end), last: Int32Array.from(last), rthO: F(rthO), rthC: F(rthC), rthOff: F(rthOff), n: C.length });
  };
  // bar t's bias against the move from t's close to t+1's, or through t+1's RTH
  const moves = (tf, rth) => {
    const m = tf.n - 1, r = new Float64Array(m).fill(NaN), pts = new Float64Array(m).fill(NaN), yr = new Int16Array(m);
    for (let t = 0; t < m; t++) {
      yr[t] = new Date(tf.end[t + 1]).getUTCFullYear();
      if (rth) {
        if (!(tf.rthO[t + 1] === tf.rthO[t + 1])) continue;
        pts[t] = tf.rthC[t + 1] - tf.rthO[t + 1];
        r[t] = (1e4 * pts[t]) / (tf.rthO[t + 1] - tf.rthOff[t + 1]);
      } else {
        pts[t] = tf.C[t + 1] - tf.C[t];
        r[t] = (1e4 * pts[t]) / (tf.C[t] - off[tf.last[t]]);
      }
    }
    const runs = [];
    for (let i = 0; i < m; i++) { if (!runs.length || runs[runs.length - 1][0] !== yr[i]) runs.push([yr[i], i, i + 1]); else runs[runs.length - 1][2] = i + 1; }
    return { r, pts, m, runs };
  };
  const daily = sessionTf((td) => td);
  const TFS = [
    [minuteTf(5), false, "5-minute bars, the next 5 minutes"],
    [minuteTf(15), false, "15-minute bars, the next 15 minutes"],
    [minuteTf(60), false, "1-hour bars, the next hour"],
    [minuteTf(240), false, "4-hour bars, the next 4 hours"],
    [daily, false, "daily bars (CME sessions), the next session"],
    [daily, true, "daily bars, the next New York session only (09:30-16:00)"],
    [sessionTf((td) => Math.floor((td + 3) / 7)), false, "weekly bars, the next week"],
  ];
  const out = { market: null, tfs: [] };
  if (withFollow) {
    const mv = moves(daily, false);
    out.market = mv.runs.map(([y, lo, hi]) => {
      let pts = 0, up = 0, bp = 0, px = 0;
      for (let i = lo; i < hi; i++) { pts += mv.pts[i]; bp += mv.r[i]; if (mv.pts[i] > 0) up++; px += daily.C[i + 1] - off[daily.last[i + 1]]; }
      return { y, pts, pct: bp / 100, up: (100 * up) / (hi - lo), price: px / (hi - lo) };
    });
  }
  for (const [tf, rth, label] of TFS) {
    const mv = moves(tf, rth), rows = [];
    const add = (name, s, from = 0) => rows.push({
      name, e: mv.runs.map(([, lo, hi], k) => (k < from ? NaN : edge(mv.r, s, lo, hi))),
      follow: withFollow ? mv.runs.map(([, lo, hi]) => follow(mv.pts, s, lo, hi, rth)) : null,
    });
    for (const [name, f] of BIASES) add(name, f(tf));
    for (const [name, f] of LEVELS) {
      // fifths cut by every earlier year's readings; the first year only sets them
      const x = f(tf), s = new Int8Array(tf.n), seen = [];
      for (const [, lo, hi] of mv.runs) {
        if (seen.length > 50) {
          const q = seen.slice().sort((a, b) => a - b), lo5 = q[Math.floor(q.length * 0.2)], hi5 = q[Math.floor(q.length * 0.8)];
          for (let i = lo; i < hi; i++) { const v = x(i); s[i] = v === v ? (v >= hi5 ? 1 : v <= lo5 ? -1 : 0) : 0; }
        }
        for (let i = lo; i < hi; i++) { const v = x(i); if (v === v && Number.isFinite(v)) seen.push(v); }
      }
      add(name, s, 1);
    }
    out.tfs.push({ label, years: mv.runs.map(([y]) => y), rows });
  }
  return out;
}

// A study's edges judged against a set of placebo studies: per cell, the edge less the
// placebos' mean, and that in their standard deviations.
function calibrate(res, pool) {
  return res.tfs.map((t, a) => ({
    ...t,
    rows: t.rows.map((r, b) => {
      const cells = r.e.map((e, y) => {
        const xs = pool.map((p) => p.tfs[a].rows[b].e[y]).filter((x) => x === x);
        if (!(e === e) || xs.length < 5) return { c: NaN, z: NaN, sd: NaN };
        const m = xs.reduce((s, x) => s + x, 0) / xs.length, sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
        return { c: e - m, z: sd > 0 ? (e - m) / sd : 0, sd };
      });
      const got = cells.filter((x) => x.c === x.c);
      return { ...r, cells, up: got.filter((x) => x.c > 0).length, of: got.length, mean: got.length ? got.reduce((s, x) => s + x.c, 0) / got.length : NaN };
    }),
  }));
}
// what a calibrated study comes to: cells at |z| >= 1.96 with and against the bias, and
// the biases on the same side of their placebos in all but at most one year of six or more
function tally(cal) {
  const rows = cal.flatMap((t) => t.rows.map((r) => ({ ...r, tf: t.label, years: t.years })));
  const cells = rows.flatMap((r) => r.cells.filter((x) => x.z === x.z));
  const long = rows.filter((r) => r.of >= 6);
  return { rows, cells: cells.length, with: cells.filter((x) => x.z >= 1.96).length, against: cells.filter((x) => x.z <= -1.96).length,
           right: long.filter((r) => r.up >= r.of - 1), wrong: long.filter((r) => r.up <= 1) };
}

const fmt = (x) => (x.c === x.c ? `${x.c >= 0 ? "+" : ""}${x.c.toFixed(Math.abs(x.c) >= 10 ? 0 : Math.abs(x.c) >= 1 ? 1 : 2)}${Math.abs(x.z) >= 2.58 ? "**" : Math.abs(x.z) >= 1.96 ? "*" : ""}` : "--");
const pad = (x, w) => String(x).padStart(w);

const { bars } = loadBars(FILE);
console.log(`${FILE}: ${new Date(bars.ts[0]).toISOString().slice(0, 10)} to ${new Date(bars.ts[bars.count - 1]).toISOString().slice(0, 10)}; ` +
            `each calendar year alone, judged against ${PLACEBOS} placebo markets\n`);
const real = study(bars, true), pl = [];
for (let k = 1; k <= PLACEBOS; k++) pl.push(study(placeboBars(bars, k), false));
const cal = calibrate(real, pl);

console.log(`The market: ${real.market.map((m) => `${m.y} ${m.pts >= 0 ? "+" : ""}${Math.round(m.pts)} pts (${m.pct >= 0 ? "+" : ""}${m.pct.toFixed(0)}%), ${Math.round(m.up)}% of sessions up`).join(" | ")}\n`);
for (const t of cal) {
  console.log(`== ${t.label}: edge over placebo, bp a bar (* |z| >= 1.96, ** |z| >= 2.58)`);
  console.log(`${"".padEnd(52)}${t.years.map((y) => pad(y, 8)).join("")} | years up |   mean`);
  for (const r of t.rows) console.log(`${r.name.padEnd(52)}${r.cells.map((x) => pad(fmt(x), 8)).join("")} | ${pad(r.up, 2)} of ${r.of} | ${pad(fmt({ c: r.mean, z: 0 }), 6)}`);
  console.log("");
}

// the real counts, and the range each placebo market gives judged against the others
const T = tally(cal);
const nulls = pl.map((p, k) => tally(calibrate(p, pl.filter((_, j) => j !== k))));
const range = (f) => { const v = nulls.map(f).sort((a, b) => a - b); return `${v[0]}-${v[v.length - 1]}, median ${v[Math.floor(v.length / 2)]}`; };
console.log(`Cells at |z| >= 1.96: ${T.with + T.against} of ${T.cells} (${T.with} with the bias, ${T.against} against).` +
            ` Each placebo market judged against the others: ${range((n) => n.with + n.against)} (with ${range((n) => n.with)}; against ${range((n) => n.against)})`);
console.log(`Biases above their placebos in all but at most one year: ${T.right.length} (placebos: ${range((n) => n.right.length)});` +
            ` below them in all but at most one year: ${T.wrong.length} (placebos: ${range((n) => n.wrong.length)})`);
// Timeframe by timeframe: the real counts, and p = the share of placebo markets (judged
// against the others) with at least as many -- how unusual the real market is there.
const tfCount = (rows, label) => {
  const rs = rows.filter((r) => r.tf === label), c = rs.flatMap((r) => r.cells.filter((x) => x.z === x.z)), full = rs.filter((r) => r.of >= 6);
  return { w: c.filter((x) => x.z >= 1.96).length, a: c.filter((x) => x.z <= -1.96).length, up: full.filter((r) => r.up === r.of).length, dn: full.filter((r) => r.up === 0).length };
};
const perTf = cal.map((t) => ({ label: t.label, real: tfCount(T.rows, t.label), nulls: nulls.map((n) => tfCount(n.rows, t.label)) }));
console.log("\nTimeframe by timeframe, real counts; p = share of placebo markets with at least as many:");
console.log(`  ${"".padEnd(58)} cells at |z| >= 1.96: with, against | one side of placebo every year: above, below`);
for (const t of perTf) {
  const pv = (k) => ((1 + t.nulls.filter((x) => x[k] >= t.real[k]).length) / (1 + t.nulls.length)).toFixed(2);
  console.log(`  ${t.label.padEnd(58)} ${String(t.real.w).padStart(2)} (p ${pv("w")}), ${String(t.real.a).padStart(2)} (p ${pv("a")})` +
              `            | ${String(t.real.up).padStart(2)} (p ${pv("up")}), ${String(t.real.dn).padStart(2)} (p ${pv("dn")})`);
}
for (const [label, list] of [["above", T.right], ["below", T.wrong]]) {
  if (!list.length) continue;
  console.log(`\n${label} their placebos in all but at most one year:`);
  for (const r of list) {
    console.log(`  ${r.tf}: ${r.name}, ${r.up} of ${r.of} years up, mean ${fmt({ c: r.mean, z: 0 })} bp`);
    console.log(`    follow, 1 MNQ after costs: ${r.years.map((y, k) => `${y} ${r.follow[k] >= 0 ? "+" : "-"}$${Math.abs(Math.round(r.follow[k]))}`).join(", ")}`);
  }
}

const r4 = (x) => (x === x ? Math.round(x * 1e4) / 1e4 : null);
fs.writeFileSync(new URL("./regime_bias_results.json", import.meta.url), JSON.stringify({
  file: FILE, from: new Date(bars.ts[0]).toISOString().slice(0, 10), to: new Date(bars.ts[bars.count - 1]).toISOString().slice(0, 10),
  run: new Date().toISOString().slice(0, 10), placebos: PLACEBOS, market: real.market,
  timeframes: cal.map((t) => ({ label: t.label, years: t.years, rows: t.rows.map((r) => ({
    name: r.name, up: r.up, of: r.of, mean: r4(r.mean), follow: r.follow.map((x) => Math.round(x)),
    cells: r.cells.map((x) => ({ c: r4(x.c), z: x.z === x.z ? Math.round(x.z * 100) / 100 : null, sd: r4(x.sd) })) })) })),
  summary: { cells: T.cells, with: T.with, against: T.against, right: T.right.length, wrong: T.wrong.length,
             nulls: nulls.map((n) => ({ with: n.with, against: n.against, right: n.right.length, wrong: n.wrong.length })) },
  perTf,
}));
