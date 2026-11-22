// Are the databox's entries late? The swings drawn as a line, and every box event placed on it.
//
//   node --max-old-space-size=12288 research/databox_swings.mjs [--placebos N]
//
// The person's question (2026-11-22): the box is a momentum read, so a Long should catch a small
// move up. Is it too late: has the bounce already happened when it fires? Do the "Potentially"
// warnings catch the turn? And the same for the drops.
//
// - The line: a zig-zag through the real swing highs and lows of the 1-minute bars (all hours, as
//   the chart shows them). A swing ends when price comes back a set share of the real price from
//   its extreme. Two sizes are used: 0.064% and 0.1275% of the price, about 18 and 37 points in
//   2026 (0.1275% is 10 points at 2019's price, the price-scaled target). It is drawn with
//   hindsight, as any zig-zag is: a low is only known to be the low once price has risen enough
//   off it. That is the point here: the box is set against where the turns really were.
// - The events, in the New York session (closes 08:30-14:55 CT), at the minute they happen:
//     flips      each row turning to its long side or its short side (1m EMA, 1m MACD, 5m EMA,
//                5m MACD), and each chart's box turning both rows long or both short;
//     warnings   a row turning Potentially long (still on its short side, momentum easing) or
//                Potentially short.
//   A long event (Long, Pot. long) faces up, a short one down.
// - Where each lands on the line:
//     with the swing     a long event in an up-leg: the share of the leg already done when it
//                        fired, the points done and left, and the minutes since the turn;
//     against the swing  a long event in a down-leg: the turn is still ahead, so how much further
//                        price went before it, and how many minutes.
// - Against what: every New York minute, both ways; and placebo markets (each minute's direction
//   flipped at random, the box run on them). They show how much of the lateness is the indicators'
//   own arithmetic, which lags on any price series.
// - The line is src/indicators.mjs zigzagPivots, which the chart draws as the "Swing line" study.
//
// RESULT (run 2026-11-22, 20 placebo markets): yes, the flips come late, but no later than the
// indicators' arithmetic makes them on any price series. What is left of the swing after them is
// what random markets leave.
//   - 1m box turns both Long, 2026, on the 37-point line:
//       - 88% fire in an up-swing, with 68% of it done (placebo 66%);
//       - that is 54.5 points done and 26.5 left (placebo 27.8), 8 minutes after the low;
//       - the 12% that fire in a down-swing see a further 50.8 points of fall (placebo 46.0).
//     The 5m box: 76% in an up-swing, 68% done (placebo 70%), 69.5 points done, 32 left, 15
//     minutes after the low. On the 18-point line the 1m box is 85% in an up-swing, 72% done
//     (placebo 71%), 15 points left (placebo 15.8). Every year the flips land 62-75% of the way
//     through, and the placebo markets the same within 4 points.
//   - The warnings do not call the turn:
//       - 1m EMA Pot. long: 60% fire after the low, with 48% of the up-swing done. The 40% before
//         it see price fall a further 39.3 points (placebo 38.3, any minute 33.8).
//       - 1m MACD Pot. long: 46% fire after the low, a coin flip. 35.3 points still to fall
//         (placebo 34.3).
//       - The 5m warnings fire later still: 73-76% after the low, with 59-61% of the swing done.
//       - Pot. short mirrors them at the highs.
//   - Drops mirror rises: 1m box Short fires 87% in a down-swing, 63% done, 28.8 points left.
//   - So a flip is a crossover, and a crossover is confirmed only after the turn: about two-thirds
//     of a swing has gone when the box agrees. What remains (27 points on a 37-point line) is what
//     random markets leave. The next turn of 37 points or more comes after it: the heat of the
//     earlier studies.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { zigzagPivots } from "../src/indicators.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), pi = args.indexOf("--placebos");
const PLACEBOS = pi >= 0 ? Number(args[pi + 1]) : 20;
const MIN = 60000, UNIT = 10 / 7844, SIZES = [0.5, 1], FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, Y0 = 2019, NY = 8;
const t0 = Date.now();

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
// each minute's four row codes: 1m EMA, 1m MACD, 5m EMA, 5m MACD (the 5m rows at the last closed 5-minute bar)
function rowsOf(b) {
  const N = b.close.length, s1 = boxStates(b, 1), b5 = resample(b, 5), s5 = boxStates(b5, 5), R = new Int8Array(N * 4);
  let k5 = -1;
  for (let i = 0; i < N; i++) {
    while (k5 + 1 < b5.ts.length && b5.ts[k5 + 1] + 5 * MIN <= b.ts[i] + MIN) k5++;
    R[i * 4] = s1.ema[i]; R[i * 4 + 1] = s1.macd[i]; R[i * 4 + 2] = k5 >= 0 ? s5.ema[k5] : 0; R[i * 4 + 3] = k5 >= 0 ? s5.macd[k5] : 0;
  }
  return R;
}
const side = (c) => (c === 1 || c === 2 ? 1 : c === 3 || c === 4 ? -1 : 0);

// ── the line: zig-zag pivots on the 1-minute highs and lows ──
// A swing ends when price comes back `size` x UNIT of the real price from its extreme: src/indicators
// .mjs zigzagPivots, the swing line the chart draws (the "Swing line" study).
function zigzag(b, size) {
  return zigzagPivots(b.high, b.low, b.close, size * UNIT, rawOffsets(b));
}

// ── the events ──
const ROWS = ["1m EMA", "1m MACD", "5m EMA", "5m MACD"];
const EVENTS = [];   // [name, dir, test(rowsBefore, rowsNow)]
ROWS.forEach((r, k) => {
  EVENTS.push([`${r} turns Long`, 1, (a, z) => side(a[k]) === -1 && side(z[k]) === 1]);
  EVENTS.push([`${r} turns Short`, -1, (a, z) => side(a[k]) === 1 && side(z[k]) === -1]);
});
for (const [tf, x, y] of [["1m", 0, 1], ["5m", 2, 3]]) {
  const both = (s, d) => side(s[x]) === d && side(s[y]) === d;
  EVENTS.push([`${tf} box turns both Long`, 1, (a, z) => both(z, 1) && !both(a, 1)]);
  EVENTS.push([`${tf} box turns both Short`, -1, (a, z) => both(z, -1) && !both(a, -1)]);
}
ROWS.forEach((r, k) => {
  EVENTS.push([`${r} Pot. long`, 1, (a, z) => z[k] === 4 && a[k] !== 4]);
  EVENTS.push([`${r} Pot. short`, -1, (a, z) => z[k] === 2 && a[k] !== 2]);
});
const NE = EVENTS.length, RANDOM = NE;   // the last slot: every minute, both ways

// ── one market ──
// For each size, event (and random), year: with the swing: n, share done, points done, points left,
// minutes since the turn; against it: n, points still to the turn, minutes to it.
function measure(b) {
  const N = b.close.length, C = b.close, TS = b.ts, CT = b.ctMin, TD = b.tday, R = rowsOf(b);
  const out = [];
  for (const size of SIZES) {
    const z = zigzag(b, size), NP = z.I.length;
    const acc = Array.from({ length: (NE + 1) * NY }, () => ({ withN: 0, done: [], ptsDone: [], ptsLeft: [], since: [], againstN: 0, toTurn: [], minToTurn: [] }));
    let k = 0;   // the leg: pivot k < i <= pivot k + 1
    const a = new Int8Array(4), zz = new Int8Array(4);
    for (let i = 1; i < N; i++) {
      while (k + 1 < NP && z.I[k + 1] < i) k++;
      if (k + 1 >= NP || z.I[k] >= i) continue;
      const closeCt = (CT[i] + 1) % 1440;
      if (closeCt < FIRST || closeCt > LAST) continue;
      const y = new Date(TS[i]).getUTCFullYear() - Y0;
      if (y < 0 || y >= NY) continue;
      const legDir = z.K[k] === -1 ? 1 : -1, pA = z.P[k], pB = z.P[k + 1], P = C[i];
      const place = (slot, d) => {
        const s = acc[slot * NY + y];
        if (d === legDir) {
          const span = Math.abs(pB - pA);
          s.withN++; s.done.push(span > 0 ? (d * (P - pA)) / span : 0); s.ptsDone.push(d * (P - pA)); s.ptsLeft.push(d * (pB - P)); s.since.push(i - z.I[k]);
        } else { s.againstN++; s.toTurn.push(d * (P - pB)); s.minToTurn.push(z.I[k + 1] - i); }
      };
      place(RANDOM, 1); place(RANDOM, -1);
      for (let r = 0; r < 4; r++) { a[r] = R[(i - 1) * 4 + r]; zz[r] = R[i * 4 + r]; }
      for (let e = 0; e < NE; e++) if (EVENTS[e][2](a, zz)) place(e, EVENTS[e][1]);
    }
    out.push(acc);
  }
  return out;
}
const med = (xs) => { if (!xs.length) return NaN; const s = Float64Array.from(xs).sort(); return s[s.length >> 1]; };
// one market's summary per size x slot x year
function summary(M) {
  return M.map((acc) => acc.map((s) => ({ n: s.withN + s.againstN, withPct: (100 * s.withN) / Math.max(1, s.withN + s.againstN), done: med(s.done), ptsDone: med(s.ptsDone),
    ptsLeft: med(s.ptsLeft), since: med(s.since), toTurn: med(s.toTurn), minToTurn: med(s.minToTurn) })));
}

const { bars } = loadBars("data/mnq_1m_beta.bin");
const real = summary(measure(bars));
process.stderr.write(`  real market: ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  pl.push(summary(measure(placeboBars(bars, 9700 + p))));
  if ((p + 1) % 5 === 0) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}

// ── print ──
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : "—"), f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—");
const plMed = (sz, slot, y, key) => med(pl.map((m) => m[sz][slot * NY + y][key]).filter(Number.isFinite));
const name = (e) => (e === RANDOM ? "any minute (both ways)" : EVENTS[e][0]);
SIZES.forEach((size, sz) => {
  const y = NY - 1;
  console.log(`\n== the line at ${(size * UNIT * 100).toFixed(3)}% of the price (about ${f0(size * UNIT * 29000)} points in 2026): 2026's New York events ==`);
  console.log(`${"event".padEnd(28)}${"n".padStart(6)}${"with %".padStart(8)}${"   | with the swing: done".padEnd(24)}${"(placebo)".padStart(9)}${"pts done".padStart(10)}${"pts left".padStart(10)}${"(placebo)".padStart(10)}${"min since".padStart(10)}   | against: pts to the turn${"(placebo)".padStart(10)}${"min".padStart(6)}`);
  for (let e = 0; e <= NE; e++) {
    const s = real[sz][e * NY + y];
    console.log(`${name(e).padEnd(28)}${String(s.n).padStart(6)}${f0(s.withPct).padStart(7)}%   | ${(f0(100 * s.done) + "%").padStart(21)}${(f0(100 * plMed(sz, e, y, "done")) + "%").padStart(9)}${f1(s.ptsDone).padStart(10)}${f1(s.ptsLeft).padStart(10)}${f1(plMed(sz, e, y, "ptsLeft")).padStart(10)}${f0(s.since).padStart(10)}   | ${f1(s.toTurn).padStart(22)}${f1(plMed(sz, e, y, "toTurn")).padStart(10)}${f0(s.minToTurn).padStart(6)}`);
  }
  console.log(`  share of the swing done when a flip fires, by year 2019..2026 (real / placebo):`);
  for (const e of [8, 9, 10, 11, 0, 1, 12, 14]) {
    console.log(`    ${name(e).padEnd(26)} ${Array.from({ length: NY }, (_, yy) => `${f0(100 * real[sz][e * NY + yy].done)}/${f0(100 * plMed(sz, e, yy, "done"))}`.padStart(8)).join("")}`);
  }
});
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s`);
fs.writeFileSync("research/databox_swings_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS, sizes: SIZES.map((s) => s * UNIT * 100), events: [...EVENTS.map((e) => e[0]), "any minute"],
  real, placeboMedian: SIZES.map((_, sz) => Array.from({ length: (NE + 1) * NY }, (_, j) => Object.fromEntries(["done", "ptsDone", "ptsLeft", "since", "toTurn", "minToTurn", "withPct"].map((key) => [key, plMed(sz, Math.floor(j / NY), j % NY, key)])))) }, null, 1));
