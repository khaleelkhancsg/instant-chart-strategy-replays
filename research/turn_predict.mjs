// Can the indicators find the turn, not at the exact low but early enough to catch most of the move?
//
//   node --max-old-space-size=12288 research/turn_predict.mjs [--placebos N]
//
// The person's question (2026-11-22): tune for where the move's low or high is, using what the
// chart shows: price above or below the EMA, the EMA's slope and curve, the MACD histogram and
// whether it is rising, RSI and its direction, volume. A call need not be at the extreme. It
// should catch most of the move.
//
// - At every New York minute's close (08:30-14:55 CT), from bars up to it only:
//     price     price against EMA 9 and 21 (in ATRs); EMA 21's slope and curve; the MACD (12/26/9)
//               histogram, its 1- and 3-bar change; RSI 14 and its 3-bar change; the last 1, 5, 15
//               and 30 minutes' moves; the 5m EMA 21, MACD histogram and its change, and RSI; where
//               price sits in the day's range so far; the time of day.
//     volume    volume against its 20-bar average, the last 5 bars' against it, and the bar's
//               volume signed by its direction.
//     box       the databox's four rows, each Long / Pot. short / Short / Pot. long.
//   EMA, MACD and RSI are all made from the closes alone; volume is the only new information.
// - What it predicts: from the next minute to 15:05, does price go T its way before T against?
//   T is 0.064% or 0.1275% of the real price, about 18 or 37 points in 2026. Long when the
//   chance of up-first is high, short when it is low.
// - The model: logistic regression (Newton steps, a light ridge) on four feature sets: box, price,
//   price + volume, and all three. Fitted on 2019-2025 (every sixth minute), read on 2026, all of
//   it. A call is a minute whose chance rises into the top 5% (long) or falls into the bottom 5%
//   (short), with the cuts taken from 2019-2025.
// - Measured on 2026:
//     AUC      how well the chance ranks up-first above down-first (0.5 is a coin);
//     calls    win rate against every minute's in the same direction, and net points a trade with
//              a T / T bracket after 1.25 points of costs;
//     timing   where the long calls land on the swing line (src/indicators.mjs zigzagPivots, size
//              T): the share of the up-swing done, against the box's flips at 68% (research/
//              databox_swings.mjs).
// - Against chance: the same on placebo markets (each minute's direction flipped at random). They
//   have nothing to predict, so their AUC and calls show what fitting finds in noise.
// - Named before the first run: the "all" model's 2026 AUC and its calls' net points a trade, for
//   each T, against the placebo markets'.
//
// RESULT (run 2026-11-22, 20 placebo markets): no. Tuned on everything the chart shows, the
// indicators do not find the low or the high, or catch most of the move, any better than on
// random markets.
//   - AUC on 2026, every feature set and both T: 0.494-0.502. Placebo markets give 0.480-0.514,
//     median 0.50.
//   - On the years it was fitted on there is a sliver: 0.509-0.519 against placebo markets'
//     0.504-0.517, median about 0.51. It does not carry into 2026.
//   - Volume adds nothing: price 0.502 / 0.496, price + volume 0.502 / 0.495.
//   - The calls win at the every-minute rate and lose the costs:
//       - T 18 points: long 47.5-47.9% against 48.1%, short 49.7-50.3% against 50.2%, net -1.1 to
//         -2.0 points a trade (placebo medians -1.4 to -1.9);
//       - T 37 points: long 45.3-48.5% against 46.8%, short 48.1-50.9% against 49.2%, net -3.3 to
//         +0.3.
//   - Their timing is the box's: early or late, never at the turn.
//       - At 18 points, 71-79% of the long calls come during the fall, and price falls another
//         16-17 points (placebo 18).
//       - At 37 points, about half come after the low, with 59-69% of the up-swing done; those
//         before it see 36-39 more points of fall (placebo 33-36).
//   - The largest weights are small (0.03-0.14 a standard deviation): RSI up, price above EMA 21
//     down, the last minute's move up. A trace of the short-term reversal and drift, not a turn
//     finder.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { ema, sma, atr, rsi, macd, zigzagPivots } from "../src/indicators.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), pi = args.indexOf("--placebos");
const PLACEBOS = pi >= 0 ? Number(args[pi + 1]) : 20;
const MIN = 60000, UNIT = 10 / 7844, SIZES = [0.5, 1], FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55;
const Y26 = Date.UTC(2026, 0, 1), Y19 = Date.UTC(2019, 0, 1), COST = 1.25, Q = 0.05, EVERY = 6;
const t0 = Date.now();

// ── the box ──
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
function boxStates(T, minutes) {
  const run = new Run(BOX, { minutes, check: false }), map = run.calc.map.bind(run.calc);
  const n = T.close.length, e = new Int8Array(n), m = new Int8Array(n);
  run.calc.map = (d, i) => { const out = map(d, i), S = run.calc.st[i]; e[i] = code(S.ema, S.emaReady); m[i] = code(S.macd, S.macdReady); return out; };
  run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
  return { e, m };
}

// ── the features and outcomes of one market ──
const PRICE = ["vs EMA 9", "vs EMA 21", "EMA 21 slope", "EMA 21 curve", "MACD hist", "hist 1-bar change", "hist 3-bar change", "RSI", "RSI 3-bar change",
  "1-min move", "5-min move", "15-min move", "30-min move", "vs 5m EMA 21", "5m MACD hist", "5m hist change", "5m RSI", "place in day's range", "time of day", "time of day squared"];
const VOLUME = ["volume vs average", "5-bar volume vs average", "signed volume"];
const BOXF = ["1m EMA", "1m MACD", "5m EMA", "5m MACD"].flatMap((r) => ["Long", "Pot. short", "Short", "Pot. long"].map((s) => `${r} ${s}`));
const SETS = { box: [...BOXF], price: [...PRICE], "price + volume": [...PRICE, ...VOLUME], all: [...PRICE, ...VOLUME, ...BOXF] };
const ALLF = [...PRICE, ...VOLUME, ...BOXF], NF = ALLF.length, col = Object.fromEntries(ALLF.map((f, k) => [f, k]));

function prepare(b) {
  const N = b.close.length, O = b.open, H = b.high, L = b.low, C = b.close, V = b.volume, TS = b.ts, CT = b.ctMin, TD = b.tday, off = rawOffsets(b);
  const a = atr(H, L, C, 14), e9 = ema(C, 9), e21 = ema(C, 21), h = macd(C).hist, r = rsi(C, 14), v20 = sma(V, 20), v5 = sma(V, 5);
  const b5 = resample(b, 5), a5 = atr(b5.high, b5.low, b5.close, 14), e21_5 = ema(b5.close, 21), h5 = macd(b5.close).hist, r5 = rsi(b5.close, 14);
  const s1 = boxStates(b, 1), s5 = boxStates(b5, 5);
  const rows = [];   // NY minutes: index, year flag, features, outcomes
  let k5 = -1, day = -1, dHi = -Infinity, dLo = Infinity;
  for (let i = 0; i + 1 < N; i++) {
    while (k5 + 1 < b5.ts.length && b5.ts[k5 + 1] + 5 * MIN <= TS[i] + MIN) k5++;
    if (TD[i] !== day) { day = TD[i]; dHi = -Infinity; dLo = Infinity; }
    if (CT[i] >= 510 && CT[i] < 900) { if (H[i] > dHi) dHi = H[i]; if (L[i] < dLo) dLo = L[i]; }
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i] || i < 40 || k5 < 30 || !(a[i] > 0) || !(a5[k5] > 0) || TS[i] < Y19) continue;
    const f = new Float64Array(NF), A = a[i], A5 = a5[k5];
    const set = (name, x) => { f[col[name]] = Number.isFinite(x) ? x : 0; };
    set("vs EMA 9", (C[i] - e9[i]) / A); set("vs EMA 21", (C[i] - e21[i]) / A);
    set("EMA 21 slope", (e21[i] - e21[i - 5]) / A); set("EMA 21 curve", (e21[i] - 2 * e21[i - 5] + e21[i - 10]) / A);
    set("MACD hist", h[i] / A); set("hist 1-bar change", (h[i] - h[i - 1]) / A); set("hist 3-bar change", (h[i] - h[i - 3]) / A);
    set("RSI", (r[i] - 50) / 50); set("RSI 3-bar change", (r[i] - r[i - 3]) / 50);
    set("1-min move", (C[i] - C[i - 1]) / A); set("5-min move", (C[i] - C[i - 5]) / A); set("15-min move", (C[i] - C[i - 15]) / A); set("30-min move", (C[i] - C[i - 30]) / A);
    set("vs 5m EMA 21", (C[i] - e21_5[k5]) / A5); set("5m MACD hist", h5[k5] / A5); set("5m hist change", (h5[k5] - h5[k5 - 1]) / A5); set("5m RSI", (r5[k5] - 50) / 50);
    set("place in day's range", dHi > dLo ? (C[i] - dLo) / (dHi - dLo) - 0.5 : 0);
    const tod = (closeCt - FIRST) / 390; set("time of day", tod); set("time of day squared", tod * tod);
    set("volume vs average", Math.log((V[i] + 1) / (v20[i] + 1))); set("5-bar volume vs average", Math.log((v5[i] + 1) / (v20[i] + 1)));
    set("signed volume", Math.log((V[i] + 1) / (v20[i] + 1)) * Math.sign(C[i] - O[i]));
    [s1.e[i], s1.m[i], s5.e[k5], s5.m[k5]].forEach((c, rr) => { if (c >= 1 && c <= 4) f[col[BOXF[rr * 4 + c - 1]]] = 1; });
    // outcomes: for each size, +1 up first, -1 down first, 0 neither by 15:05; a minute touching both is -2 (a loss either way)
    const out = SIZES.map((sz) => {
      const T = sz * UNIT * (C[i] - off[i]), P = C[i];
      for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
        const up = H[j] - P >= T, dn = P - L[j] >= T;
        if (up && dn) return -2;
        if (up) return 1;
        if (dn) return -1;
      }
      return 0;
    });
    rows.push({ i, test: TS[i] >= Y26, f, out, raw: C[i] - off[i] });
  }
  return { rows, pivots: SIZES.map((sz) => zigzagPivots(H, L, C, sz * UNIT, off)), N };
}

// ── logistic regression by Newton steps with a light ridge ──
function fit(X, y, p, n) {
  const w = new Float64Array(p + 1), lam = 1e-3 * n;
  for (let it = 0; it < 8; it++) {
    const g = new Float64Array(p + 1), Hm = new Float64Array((p + 1) * (p + 1));
    for (let r = 0; r < n; r++) {
      let z = w[p];
      const o = r * p;
      for (let k = 0; k < p; k++) z += w[k] * X[o + k];
      const pr = 1 / (1 + Math.exp(-z)), d = y[r] - pr, wt = pr * (1 - pr);
      for (let k = 0; k < p; k++) {
        const xk = X[o + k];
        g[k] += d * xk;
        const hk = wt * xk, row = k * (p + 1);
        for (let m = k; m < p; m++) Hm[row + m] += hk * X[o + m];
        Hm[row + p] += hk;
      }
      g[p] += d; Hm[p * (p + 1) + p] += wt;
    }
    for (let k = 0; k <= p; k++) { for (let m = 0; m < k; m++) Hm[k * (p + 1) + m] = Hm[m * (p + 1) + k]; if (k < p) { Hm[k * (p + 1) + k] += lam; g[k] -= lam * w[k]; } }
    // solve Hm * step = g (Gaussian elimination with partial pivoting)
    const m = p + 1, A = Float64Array.from(Hm), bvec = Float64Array.from(g);
    for (let c = 0; c < m; c++) {
      let piv = c;
      for (let r = c + 1; r < m; r++) if (Math.abs(A[r * m + c]) > Math.abs(A[piv * m + c])) piv = r;
      if (piv !== c) { for (let k = 0; k < m; k++) { const t = A[c * m + k]; A[c * m + k] = A[piv * m + k]; A[piv * m + k] = t; } const t = bvec[c]; bvec[c] = bvec[piv]; bvec[piv] = t; }
      for (let r = c + 1; r < m; r++) { const fct = A[r * m + c] / A[c * m + c]; if (!fct) continue; for (let k = c; k < m; k++) A[r * m + k] -= fct * A[c * m + k]; bvec[r] -= fct * bvec[c]; }
    }
    const step = new Float64Array(m);
    for (let r = m - 1; r >= 0; r--) { let s = bvec[r]; for (let k = r + 1; k < m; k++) s -= A[r * m + k] * step[k]; step[r] = s / A[r * m + r]; }
    let big = 0;
    for (let k = 0; k < m; k++) { w[k] += step[k]; big = Math.max(big, Math.abs(step[k])); }
    if (big < 1e-6) break;
  }
  return w;
}
function auc(scores, labels) {
  const idx = Array.from(scores.keys()).sort((a, b) => scores[a] - scores[b]);
  let rank = 0, pos = 0, sumR = 0;
  for (let k = 0; k < idx.length; ) {
    let e = k;
    while (e + 1 < idx.length && scores[idx[e + 1]] === scores[idx[k]]) e++;
    const avgR = (k + e) / 2 + 1;
    for (let q = k; q <= e; q++) if (labels[idx[q]]) { pos++; sumR += avgR; }
    rank = e + 1; k = e + 1;
  }
  const neg = idx.length - pos;
  return pos && neg ? (sumR - (pos * (pos + 1)) / 2) / (pos * neg) : NaN;
}

// ── one market, one size, one feature set: fit on 2019-2025, read on 2026 ──
function evaluate(M, sz, names) {
  const cols = names.map((nm) => col[nm]), p = cols.length;
  const train = M.rows.filter((r, k) => !r.test && k % EVERY === 0 && (r.out[sz] === 1 || r.out[sz] === -1));
  // standardise on the training rows
  const mu = new Float64Array(p), sd = new Float64Array(p);
  for (const r of train) cols.forEach((c, k) => { mu[k] += r.f[c]; });
  mu.forEach((_, k) => { mu[k] /= train.length; });
  for (const r of train) cols.forEach((c, k) => { sd[k] += (r.f[c] - mu[k]) ** 2; });
  sd.forEach((_, k) => { sd[k] = Math.sqrt(sd[k] / train.length) || 1; });
  const std = (r, k) => Math.max(-6, Math.min(6, (r.f[cols[k]] - mu[k]) / sd[k]));
  const n = train.length, X = new Float64Array(n * p), y = new Float64Array(n);
  train.forEach((r, q) => { for (let k = 0; k < p; k++) X[q * p + k] = std(r, k); y[q] = r.out[sz] === 1 ? 1 : 0; });
  const w = fit(X, y, p, n);
  const score = (r) => { let z = w[p]; for (let k = 0; k < p; k++) z += w[k] * std(r, k); return z; };
  const inAuc = auc(train.map(score), train.map((r) => r.out[sz] === 1));
  // the cuts for calls, from the training scores
  const trainS = Float64Array.from(M.rows.filter((r, k) => !r.test && k % EVERY === 0), score).sort();
  const hiCut = trainS[Math.floor((1 - Q) * trainS.length)], loCut = trainS[Math.floor(Q * trainS.length)];
  // 2026
  const test = M.rows.filter((r) => r.test), S = test.map(score);
  const decided = test.map((r, k) => k).filter((k) => test[k].out[sz] === 1 || test[k].out[sz] === -1);
  const A = auc(decided.map((k) => S[k]), decided.map((k) => test[k].out[sz] === 1));
  const baseL = test.filter((r) => r.out[sz] === 1).length / test.length, baseS = test.filter((r) => r.out[sz] === -1).length / test.length;
  // calls: the minute the score crosses into the top (bottom) 5%, within a session
  const calls = { L: { n: 0, w: 0, net: 0 }, S: { n: 0, w: 0, net: 0 } }, longIdx = [];
  for (let k = 1; k < test.length; k++) {
    const sameDay = test[k].i === test[k - 1].i + 1;
    for (const [side, d, inNow, inBefore] of [["L", 1, S[k] >= hiCut, sameDay && S[k - 1] >= hiCut], ["S", -1, S[k] <= loCut, sameDay && S[k - 1] <= loCut]]) {
      if (!inNow || inBefore) continue;
      const o = test[k].out[sz], T = SIZES[sz] * UNIT * test[k].raw, c = calls[side];
      const win = o === d;
      c.n++; if (win) c.w++;
      c.net += (win ? T : o === 0 ? 0 : -T) - COST;   // neither by 15:05: about flat, less costs
      if (side === "L") longIdx.push(test[k].i);
    }
  }
  // where the long calls land on the swing line of the same size
  const z = M.pivots[sz];
  let kp = 0, withN = 0, done = [], toFall = [];
  for (const i of longIdx) {
    while (kp + 1 < z.I.length && z.I[kp + 1] < i) kp++;
    if (kp + 1 >= z.I.length || z.I[kp] >= i) continue;
    if (z.K[kp] === -1) { withN++; const span = z.P[kp + 1] - z.P[kp]; done.push(span > 0 ? (M.close[i] - z.P[kp]) / span : 0); }
    else toFall.push(M.close[i] - z.P[kp + 1]);   // a down-swing: how much further it falls first
  }
  done.sort((a, b) => a - b); toFall.sort((a, b) => a - b);
  return { auc: A, inAuc, toFall: toFall.length ? toFall[toFall.length >> 1] : NaN, baseL, baseS, callsL: calls.L, callsS: calls.S, longAfterLow: longIdx.length ? withN / longIdx.length : NaN, longDone: done.length ? done[done.length >> 1] : NaN,
           coef: names.map((nm, k) => ({ name: nm, w: w[k] })) };
}
function run(b) {
  const M = prepare(b);
  M.close = b.close;
  const out = {};
  SIZES.forEach((_, sz) => { out[sz] = {}; for (const [set, names] of Object.entries(SETS)) out[sz][set] = evaluate(M, sz, names); });
  return out;
}

const { bars } = loadBars("data/mnq_1m_beta.bin");
const real = run(bars);
process.stderr.write(`  real market: ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  pl.push(run(placeboBars(bars, 9900 + p)));
  process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}

// ── print ──
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—"), f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "—"), pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1) + "%" : "—");
const dist = (xs, f = f3) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? `${f(v[0])} to ${f(v[v.length - 1])}, median ${f(v[v.length >> 1])}` : "—"; };
SIZES.forEach((size, sz) => {
  console.log(`\n== T = ${(size * UNIT * 100).toFixed(3)}% of the price (about ${(size * UNIT * 29000).toFixed(0)} points in 2026); fitted on 2019-2025, read on 2026 ==`);
  for (const set of Object.keys(SETS)) {
    const r = real[sz][set], net = (c) => (c.n ? c.net / c.n : NaN);
    console.log(`  ${set.padEnd(15)} AUC 2026 ${f3(r.auc)} (placebo ${dist(pl.map((m) => m[sz][set].auc))}); on the years it was fitted on ${f3(r.inAuc)} (placebo ${dist(pl.map((m) => m[sz][set].inAuc))})`);
    console.log(`  ${"".padEnd(15)} long calls ${r.callsL.n}: win ${pc(r.callsL.w / r.callsL.n)} against ${pc(r.baseL)}, net ${f2(net(r.callsL))} pts a trade (placebo ${dist(pl.map((m) => net(m[sz][set].callsL)), f2)})`);
    console.log(`  ${"".padEnd(15)} short calls ${r.callsS.n}: win ${pc(r.callsS.w / r.callsS.n)} against ${pc(r.baseS)}, net ${f2(net(r.callsS))} pts a trade (placebo ${dist(pl.map((m) => net(m[sz][set].callsS)), f2)})`);
    console.log(`  ${"".padEnd(15)} long calls after the low ${pc(r.longAfterLow)}, the up-swing ${pc(r.longDone)} done (placebo ${dist(pl.map((m) => m[sz][set].longDone), (x) => pc(x))}); before the low, ${f2(r.toFall)} pts still to fall (placebo ${dist(pl.map((m) => m[sz][set].toFall), f2)})`);
  }
  const top = [...real[sz].all.coef].sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 10);
  console.log(`  the "all" model's largest weights (per standard deviation; + favours up first): ${top.map((c) => `${c.name} ${c.w >= 0 ? "+" : ""}${c.w.toFixed(3)}`).join(", ")}`);
});
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s`);
fs.writeFileSync("research/turn_predict_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS, sizes: SIZES.map((s) => s * UNIT * 100), real,
  placebo: pl.map((m) => Object.fromEntries(SIZES.map((_, sz) => [sz, Object.fromEntries(Object.keys(SETS).map((set) => [set, { auc: m[sz][set].auc, inAuc: m[sz][set].inAuc, toFall: m[sz][set].toFall, longNet: m[sz][set].callsL.n ? m[sz][set].callsL.net / m[sz][set].callsL.n : null, shortNet: m[sz][set].callsS.n ? m[sz][set].callsS.net / m[sz][set].callsS.n : null, longDone: m[sz][set].longDone }]))]))) }, null, 1));
