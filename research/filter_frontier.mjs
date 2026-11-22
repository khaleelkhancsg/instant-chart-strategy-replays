// Can a better filter be quicker to the turn and still keep the noise out?
//
//   node --max-old-space-size=12288 research/filter_frontier.mjs [--placebos N]
//
// The person's question (2026-11-22): MACD sees a turn sooner than the EMAs because its
// histogram is how fast the MACD line is changing, and that earliness brings noise. With the right
// filters, couldn't a signal be more sensitive, with less lag, and still filter the noise?
//
// Every turn detector below is a smoother of the 1-minute closes and a rule for when it has
// turned. Its state flips up or down, and each flip in the New York session (closes 08:30-14:55 CT)
// is a signal that way.
//   smoothers   EMA, Hull MA, zero-lag EMA (an EMA of 2 x price less price (n-1)/2 bars back),
//               Ehlers' Super Smoother (a 2-pole Butterworth), and an alpha-beta (Kalman-type)
//               trend filter read as its one-bar forecast. Each at 5, 10, 20 and 40 bars.
//   noise       hysteresis: the line must come back h x ATR(14) from its extreme before a turn
//               counts, h 0 (any tick back), 0.1, 0.25, 0.5. That is the usual way to keep
//               sensitivity and drop the wiggles.
//   MACD        the histogram crossing zero (the box's MACD row) with a dead band of h x ATR, h 0,
//               0.05, 0.1 or 0.2, and the histogram itself turning (the "Potentially" warning)
//               with the same hysteresis. Each at 6/13/5, 12/26/9 and 24/52/18.
// 104 detectors. Each signal is placed on the swing line (src/indicators.mjs zigzagPivots, 0.1275%
// of the price, about 37 points in 2026):
//   after the turn   the share of the swing already done (the lag);
//   before it        a signal against the swing still running: early, or false.
// It is also read for what it is worth: does price then go T its way before T against, for T of
// 0.064% and 0.1275% (18 and 37 points in 2026)? That is set against every New York minute in the
// same direction and year: the edge, in points of win rate.
// Against chance:
//   - the same 104 on placebo markets (each minute's direction flipped at random), to show how
//     much of each detector's lag and noise is its own arithmetic;
//   - named before the first run: the detector with the best edge z over 2019-2025 (each T),
//     read on 2026, against the same pick on each placebo market.
//
// RESULT (run 2026-11-22, 30 placebo markets): filters move a signal along the lag-noise line but
// cannot leave it, and no point on it is worth trading.
//   - Hysteresis does filter the noise, at the cost of lag. EMA 10 turns 11.4 times an hour, 66%
//     of them after the real turn, with 51% of the swing done. Coming back 0.25 ATR first: 3.8 an
//     hour, 85% after the turn, 62% done. Every family runs the same way.
//   - No smoother beats the EMA with hysteresis. About 56% of the swing done, the share after the
//     turn:
//       - EMA 5 h 0.25: 80%;
//       - Hull 10 h 0.25: 74%;
//       - zero-lag 10 h 0.5: 79%;
//       - Super Smoother 10 h 0.1: 75%;
//       - alpha-beta 10 h 0.25: 79%;
//       - MACD 6/13/5 crossing, band 0.05: 76%.
//   - It is arithmetic. Placebo markets give every detector the same share after the turn and the
//     same lag, within 1-2 points.
//   - What it is worth on 2026: edges of -1.8 to +0.7 points of win rate. 7 of 104 detectors are
//     beyond 1.96 sd for T 18 and 2 for T 37, about chance, mostly below zero.
//   - The pick, T 18: the fastest, unfiltered detector, the MACD 6/13/5 histogram turning (h 0).
//     It has z 6.9 on 2019-2025, and on 2026 an edge of +0.6 points, z 2.0. Placebo markets' picks
//     give -1.9 to 1.5 and none of 30 is as high, so it held. But it is a sliver: +0.6 points of
//     win rate on an 18-point bracket is about +0.2 points a trade, against 1.25 of costs. It fires
//     22 times an hour, and any filtering removes it (h 0.05 +0.5, h 0.1 -0.2, h 0.2 -0.8). What
//     little is there lives in the next minute or two's wiggles, which is what a noise filter
//     takes out.
//   - The pick, T 37: the same detector, z 1.3 on 2019-2025 and 0.1 on 2026. 11 of 30 placebo
//     picks do as well.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { ema, atr, hma, macd, zigzagPivots } from "../src/indicators.mjs";
import { placeboBars } from "./lib_levels.mjs";

const args = process.argv.slice(2), pi = args.indexOf("--placebos");
const PLACEBOS = pi >= 0 ? Number(args[pi + 1]) : 10;
const UNIT = 10 / 7844, TS_ = [0.5, 1], FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, Y0 = 2019, NY = 8, BINS = 100;
const t0 = Date.now();

// ── the smoothers ──
function zlema(C, n) { const lag = Math.floor((n - 1) / 2), x = Float64Array.from(C, (c, i) => (i >= lag ? 2 * c - C[i - lag] : c)); return ema(x, n); }
function superSmoother(C, n) {
  const a1 = Math.exp((-1.414 * Math.PI) / n), b1 = 2 * a1 * Math.cos((1.414 * Math.PI) / n), c2 = b1, c3 = -a1 * a1, c1 = 1 - c2 - c3, out = new Float64Array(C.length);
  out[0] = C[0]; out[1] = C[1];
  for (let i = 2; i < C.length; i++) out[i] = (c1 * (C[i] + C[i - 1])) / 2 + c2 * out[i - 1] + c3 * out[i - 2];
  return out;
}
function alphaBeta(C, n) {   // critically damped alpha-beta filter, read as its one-bar forecast
  const th = 1 - 2 / (n + 1), al = 1 - th * th, be = (1 - th) * (1 - th), out = new Float64Array(C.length);
  let lev = C[0], vel = 0;
  for (let i = 0; i < C.length; i++) { const pred = lev + vel, r = C[i] - pred; lev = pred + al * r; vel += be * r; out[i] = lev + vel; }
  return out;
}
// a line's up/down state with hysteresis: it turns once it comes back h x ATR from its extreme
function lineStates(line, A, h) {
  const n = line.length, st = new Int8Array(n);
  let dir = 1, ext = line[0];
  for (let i = 1; i < n; i++) {
    const x = line[i];
    if (Number.isFinite(x) && Number.isFinite(ext)) {
      if (dir === 1) { if (x > ext) ext = x; else if (ext - x > h * A[i]) { dir = -1; ext = x; } }
      else { if (x < ext) ext = x; else if (x - ext > h * A[i]) { dir = 1; ext = x; } }
    } else if (Number.isFinite(x)) ext = x;
    st[i] = dir;
  }
  return st;
}
// the histogram crossing zero, with a dead band of h x ATR
function bandStates(v, A, h) {
  const n = v.length, st = new Int8Array(n);
  let dir = 1;
  for (let i = 0; i < n; i++) { if (dir === 1 && v[i] < -h * A[i]) dir = -1; else if (dir === -1 && v[i] > h * A[i]) dir = 1; st[i] = dir; }
  return st;
}
const DETECTORS = [];
for (const [fam, make] of [["EMA", ema], ["Hull", hma], ["Zero-lag EMA", zlema], ["Super Smoother", superSmoother], ["Alpha-beta", alphaBeta]])
  for (const n of [5, 10, 20, 40]) for (const h of [0, 0.1, 0.25, 0.5]) DETECTORS.push({ fam, name: `${fam} ${n}, h ${h}`, n, h, states: (C, A) => lineStates(make(C, n), A, h) });
for (const [f, s, g] of [[6, 13, 5], [12, 26, 9], [24, 52, 18]]) for (const h of [0, 0.05, 0.1, 0.2]) {
  DETECTORS.push({ fam: "MACD cross", name: `MACD ${f}/${s}/${g} crosses, band ${h}`, n: s, h, states: (C, A) => bandStates(macd(C, f, s, g).hist, A, h) });
  DETECTORS.push({ fam: "MACD turn", name: `MACD ${f}/${s}/${g} histogram turns, h ${h}`, n: s, h, states: (C, A) => lineStates(macd(C, f, s, g).hist, A, h) });
}
const ND = DETECTORS.length;

// ── one market ──
function measure(b) {
  const N = b.close.length, H = b.high, L = b.low, C = b.close, TS = b.ts, CT = b.ctMin, TD = b.tday, off = rawOffsets(b), A = atr(H, L, C, 14);
  // each New York minute: its year, the race for each T (bit 1 long wins, bit 2 short wins), its place on the swing line
  const ny = new Int8Array(N).fill(-1), race = TS_.map(() => new Uint8Array(N)), legDir = new Int8Array(N), share = new Float32Array(N);
  for (let i = 0; i + 1 < N; i++) {
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i]) continue;
    const y = new Date(TS[i]).getUTCFullYear() - Y0;
    if (y < 0 || y >= NY) continue;
    ny[i] = y;
    TS_.forEach((sz, t) => {
      const T = sz * UNIT * (C[i] - off[i]), P = C[i];
      for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
        const up = H[j] - P >= T, dn = P - L[j] >= T;
        if (up && dn) break;
        if (up) { race[t][i] = 1; break; }
        if (dn) { race[t][i] = 2; break; }
      }
    });
  }
  const z = zigzagPivots(H, L, C, UNIT, off);
  for (let k = 0, i = 0; i < N; i++) {
    while (k + 1 < z.I.length && z.I[k + 1] < i) k++;
    if (k + 1 >= z.I.length || z.I[k] >= i) continue;
    legDir[i] = z.K[k] === -1 ? 1 : -1;
    const span = Math.abs(z.P[k + 1] - z.P[k]);
    share[i] = span > 0 ? Math.abs(C[i] - z.P[k]) / span : 0;
  }
  // every minute's win rate by year, direction and T: the baseline
  const base = new Float64Array(NY * 2 * TS_.length), baseN = new Float64Array(NY);
  for (let i = 0; i < N; i++) if (ny[i] >= 0) { baseN[ny[i]]++; TS_.forEach((_, t) => { if (race[t][i] === 1) base[(ny[i] * 2) * TS_.length + t]++; if (race[t][i] === 2) base[(ny[i] * 2 + 1) * TS_.length + t]++; }); }
  for (let y = 0; y < NY; y++) for (let d = 0; d < 2; d++) for (let t = 0; t < TS_.length; t++) base[(y * 2 + d) * TS_.length + t] /= baseN[y] || 1;
  // each detector: signals by year, wins against expected, after-the-turn count and the share done
  const out = DETECTORS.map(() => Array.from({ length: NY }, () => ({ n: 0, withN: 0, hist: new Float64Array(BINS), wins: TS_.map(() => 0), exp: TS_.map(() => 0), v: TS_.map(() => 0) })));
  DETECTORS.forEach((D, g) => {
    const st = D.states(C, A);
    for (let i = 1; i < N; i++) {
      if (ny[i] < 0 || st[i] === st[i - 1]) continue;
      const d = st[i], s = out[g][ny[i]];
      s.n++;
      if (legDir[i] === d) { s.withN++; s.hist[Math.min(BINS - 1, Math.floor(share[i] * BINS))]++; }
      TS_.forEach((_, t) => {
        const p = base[(ny[i] * 2 + (d > 0 ? 0 : 1)) * TS_.length + t];
        s.wins[t] += race[t][i] === (d > 0 ? 1 : 2) ? 1 : 0; s.exp[t] += p; s.v[t] += p * (1 - p);
      });
    }
  });
  return { out, baseN };
}
const median = (hist) => { const tot = hist.reduce((a, x) => a + x, 0); let c = 0; for (let k = 0; k < hist.length; k++) { c += hist[k]; if (c >= tot / 2) return (k + 0.5) / hist.length; } return NaN; };
function pooled(M, g, ys) {
  const r = { n: 0, withN: 0, hist: new Float64Array(BINS), wins: TS_.map(() => 0), exp: TS_.map(() => 0), v: TS_.map(() => 0), hours: 0 };
  for (const y of ys) { const s = M.out[g][y]; r.n += s.n; r.withN += s.withN; s.hist.forEach((x, k) => { r.hist[k] += x; }); TS_.forEach((_, t) => { r.wins[t] += s.wins[t]; r.exp[t] += s.exp[t]; r.v[t] += s.v[t]; }); r.hours += M.baseN[y] / 60; }
  return { n: r.n, perHour: r.n / r.hours, withPct: r.n ? r.withN / r.n : NaN, done: median(r.hist),
           edge: TS_.map((_, t) => (r.n ? (r.wins[t] - r.exp[t]) / r.n : NaN)), z: TS_.map((_, t) => (r.v[t] > 0 ? (r.wins[t] - r.exp[t]) / Math.sqrt(r.v[t]) : NaN)) };
}
function pick(M) {
  return TS_.map((_, t) => {
    let best = -1, bz = -Infinity;
    for (let g = 0; g < ND; g++) { const e = pooled(M, g, [0, 1, 2, 3, 4, 5, 6]); if (e.n >= 2000 && e.z[t] > bz) { bz = e.z[t]; best = g; } }
    const l = pooled(M, best, [7]);
    return { g: best, zIn: bz, z26: l.z[t], edge26: l.edge[t] };
  });
}

const { bars } = loadBars("data/mnq_1m_beta.bin");
const real = measure(bars), RP = pick(real);
process.stderr.write(`  real market: ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
const pls = [];
for (let p = 0; p < PLACEBOS; p++) {
  const M = measure(placeboBars(bars, 9800 + p));
  pls.push({ frontier: DETECTORS.map((_, g) => { const r = pooled(M, g, [7]); return { withPct: r.withPct, done: r.done, perHour: r.perHour }; }), pick: pick(M) });
  process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}

// ── print ──
const pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(0) + "%" : "—"), f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—"), f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const medOf = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; };
console.log(`2026, the New York session. A detector's signals: per hour; the share after the turn (with the swing); the share of the swing done when it fires after the turn; the edge (points of win rate over every minute) and z, for T of 18 and 37 points. Placebo markets' medians in brackets.`);
console.log(`${"detector".padEnd(44)}${"/hour".padStart(7)}${"after turn".padStart(13)}${"done".padStart(13)}${"edge 18 (z)".padStart(15)}${"edge 37 (z)".padStart(15)}`);
DETECTORS.forEach((D, g) => {
  const r = pooled(real, g, [7]), pw = medOf(pls.map((p) => p.frontier[g].withPct)), pd = medOf(pls.map((p) => p.frontier[g].done));
  console.log(`${D.name.padEnd(44)}${f1(r.perHour).padStart(7)}${`${pc(r.withPct)} (${pc(pw)})`.padStart(13)}${`${pc(r.done)} (${pc(pd)})`.padStart(13)}${`${f1(100 * r.edge[0])} (${f1(r.z[0])})`.padStart(15)}${`${f1(100 * r.edge[1])} (${f1(r.z[1])})`.padStart(15)}`);
});
// the frontier: for each family, the share after the turn against how late it is
console.log(`\nThe pick: the best edge z on 2019-2025, read on 2026:`);
TS_.forEach((sz, t) => {
  const P = RP[t], pz = pls.map((p) => p.pick[t].z26).filter(Number.isFinite).sort((a, b) => a - b);
  console.log(`  T ${(sz * UNIT * 29000).toFixed(0)} points: ${DETECTORS[P.g].name}, z ${f1(P.zIn)} on 2019-2025, on 2026 edge ${f1(100 * P.edge26)} points, z ${f1(P.z26)}. ` +
              `Placebo markets' picks z ${f1(pz[0])} to ${f1(pz[pz.length - 1])}, median ${f1(pz[pz.length >> 1])}; ${pls.filter((p) => p.pick[t].z26 >= P.z26).length} of ${PLACEBOS} as high`);
});
let beyond = [0, 0];
DETECTORS.forEach((_, g) => { const r = pooled(real, g, [7]); TS_.forEach((__, t) => { if (Math.abs(r.z[t]) >= 1.96) beyond[t]++; }); });
console.log(`Detectors beyond 1.96 sd on 2026: ${beyond[0]} (T 18) and ${beyond[1]} (T 37) of ${ND}`);
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s`);
fs.writeFileSync("research/filter_frontier_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS,
  detectors: DETECTORS.map((D, g) => ({ name: D.name, fam: D.fam, n: D.n, h: D.h, y2026: pooled(real, g, [7]), y1925: pooled(real, g, [0, 1, 2, 3, 4, 5, 6]),
    placebo2026: { withPct: medOf(pls.map((p) => p.frontier[g].withPct)), done: medOf(pls.map((p) => p.frontier[g].done)) } })),
  pick: RP.map((P, t) => ({ T: TS_[t], detector: DETECTORS[P.g].name, zIn: P.zIn, z2026: P.z26, edge2026: P.edge26, placebo: pls.map((p) => p.pick[t].z26) })) }, null, 1));
