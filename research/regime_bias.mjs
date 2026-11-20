// Can the bars say which way to lean? A regime bias -- long, short or none -- read from
// the bars up to each close on 5-minute to weekly bars, against the move that came next,
// in each calendar year on its own (2019 from May; 2026 to the end of the file).
//
//   node --max-old-space-size=8192 research/regime_bias.mjs [bars file] [--placebo N]
//
// The bars file defaults to data/mnq_1m_beta.bin; N, the placebo markets, to 20 (about two
// minutes in all).
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
// The level: how hard the market leans, not just which way. The distance from the 50 EMA
// and the 20-bar move, each in ATRs, cut into fifths by every earlier year's readings (so
// the first year has none). Its edge is the strongest fifth's next move less the weakest's.
//
// Follow: one MNQ held the bias's way on the real bars, in dollars, after a tick of
// slippage and $0.75 a side for each change. "1D -> next RTH" holds the daily bias through
// the next New York session only, 09:30 to 16:00.
//
// RESULT (run 2026-11-20, data/mnq_1m_beta.bin to Oct 30, 20 placebo markets): no bias calls
// the next move better than random markets, on any timeframe, in any year taken alone.
//   - 42 of 736 year-cells sit outside 1.96 placebo standard deviations (15 with the bias, 27
//     against). Each placebo market judged against the others gives 19-100, median 53.
//   - 6 biases are above their placebos in all but at most one year, and 6 below. Placebo
//     markets give 0-27 and 0-15, medians 3.
//   - By timeframe: 15-minute biases lean with the trend (9 cells, placebos 0-13) and daily ones
//     against it (8, placebos 0-17). Both are inside what random markets give.
//   - The steady effect is 5-minute reversal: after an up bar, the next leans down, below its
//     placebos in 7 of 8 years and outside 1.96 sd in 5. It is about 0.12 bp, 0.3 points a
//     bar. Faded with one MNQ it earned $6,500-21,000 a year before costs in 7 of 8 years,
//     against $60,000-91,000 of costs, for it changes side on nearly every bar.
//   - How hard the market leans adds nothing: the strongest fifth against the weakest stays
//     inside its placebos on every timeframe.
//   - Followed with one MNQ after costs, no bias made money in every year. The 4-hour MACD
//     histogram, above its placebos in 7 of 8 years, made +$9,261 in 2024 and lost $4,588 in 2020.

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { sessionsOf, rawOffsets } from "../src/levels.mjs";
import { ema, atr, adx, donchian, macd, supertrend } from "../src/indicators.mjs";
import { placeboBars } from "./lib_levels.mjs";

const args = process.argv.slice(2), pi = args.indexOf("--placebo");
const PLACEBOS = pi >= 0 ? Number(args[pi + 1]) || 20 : 20;
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
  ["ADX 14 over 20: the stronger DI", (b) => { const a = adx(b.H, b.L, b.C, 14); return sig(b.n, 60, (i) => (a.adx[i] > 20 ? a.pdi[i] - a.ndi[i] : 0)); }],
  ["Supertrend 10 x 3", (b) => { const t = supertrend(b.H, b.L, b.C, 10, 3).trend; return sig(b.n, 30, (i) => t[i]); }],
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
  const minuteTf = (m) => {
    const b = resample(B, m), n = b.close.length, end = new Float64Array(n);
    for (let i = 0; i < n; i++) end[i] = B.ts[b.srcLast[i]];
    return { C: b.close, H: b.high, L: b.low, end, last: b.srcLast, n };
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
    return { C: F(C), H: F(H), L: F(L), end: F(end), last: Int32Array.from(last), rthO: F(rthO), rthC: F(rthC), rthOff: F(rthOff), n: C.length };
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
      let pts = 0, up = 0, bp = 0;
      for (let i = lo; i < hi; i++) { pts += mv.pts[i]; bp += mv.r[i]; if (mv.pts[i] > 0) up++; }
      return { y, pts, pct: bp / 100, up: (100 * up) / (hi - lo) };
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
        if (!(e === e) || xs.length < 5) return { c: NaN, z: NaN };
        const m = xs.reduce((s, x) => s + x, 0) / xs.length, sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
        return { c: e - m, z: sd > 0 ? (e - m) / sd : 0 };
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
// the same counts timeframe by timeframe: does one lean with its biases, or against them?
console.log("\nTimeframe by timeframe, cells at |z| >= 1.96 (real; each placebo market against the others):");
for (const t of cal) {
  const at = (rows) => { const c = rows.filter((r) => r.tf === t.label).flatMap((r) => r.cells.filter((x) => x.z === x.z)); return { w: c.filter((x) => x.z >= 1.96).length, a: c.filter((x) => x.z <= -1.96).length, n: c.length }; };
  const r = at(T.rows), ps = nulls.map((n) => at(n.rows));
  const rg = (f) => { const v = ps.map(f).sort((a, b) => a - b); return `${v[0]}-${v[v.length - 1]} (median ${v[Math.floor(v.length / 2)]})`; };
  console.log(`  ${t.label.padEnd(58)} of ${String(r.n).padStart(3)}: with ${String(r.w).padStart(2)}, placebos ${rg((x) => x.w)}; against ${String(r.a).padStart(2)}, placebos ${rg((x) => x.a)}`);
}
for (const [label, list] of [["above", T.right], ["below", T.wrong]]) {
  if (!list.length) continue;
  console.log(`\n${label} their placebos in all but at most one year:`);
  for (const r of list) {
    console.log(`  ${r.tf}: ${r.name}, ${r.up} of ${r.of} years up, mean ${fmt({ c: r.mean, z: 0 })} bp`);
    console.log(`    follow, 1 MNQ after costs: ${r.years.map((y, k) => `${y} ${r.follow[k] >= 0 ? "+" : "-"}$${Math.abs(Math.round(r.follow[k]))}`).join(", ")}`);
  }
}
