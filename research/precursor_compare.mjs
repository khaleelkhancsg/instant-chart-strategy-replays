// Which precursor actually predicts the crossover?
//
// The anticipation book currently requires BOTH a run of shrinking bars and
// proximity to zero. This separates them, and adds two formulations based on
// the histogram's SLOPE — the scale-free version of "the angle it is coming in
// at". Degrees on a chart depend on the zoom, so the meaningful quantity is
// points per bar, normalised by the histogram's own typical size so it means
// the same thing across regimes.
//
//   A  run      N consecutive bars shrinking toward zero, nothing else
//   B  prox     |hist| below a fraction of its trailing average, nothing else
//   C  both     what the strategy does today
//   D  eta      |hist| / |slope| -- bars until zero at the current rate. This is
//               the natural statement of "a cross is imminent": it combines how
//               close the histogram is with how fast it is closing, instead of
//               testing the two separately.
//   E  angle    the approach is at least as steep as the slope the LAST real
//               crossover came in at, so the bar is measured against what a
//               decisive cross looks like for this instrument right now.
//
//   node research/precursor_compare.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { ema } from "../src/indicators.mjs";

const { bars } = loadBars();
const tf = resample(bars, 5);
const C = tf.close, n = C.length;
const ef = ema(C, 12), es = ema(C, 26);
const line = new Float64Array(n);
for (let i = 0; i < n; i++) line[i] = ef[i] - es[i];
const sg = ema(line, 9);
const hist = new Float64Array(n);
for (let i = 0; i < n; i++) hist[i] = line[i] - sg[i];

const side = (v) => (v >= 0 ? 1 : -1);
const cross = new Uint8Array(n);
for (let i = 1; i < n; i++) if (side(hist[i]) !== side(hist[i - 1])) cross[i] = 1;

const W = 200;
const scale = new Float64Array(n).fill(NaN);
{ let s = 0;
  for (let i = 0; i < n; i++) {
    s += Math.abs(hist[i]);
    if (i >= W) s -= Math.abs(hist[i - W]);
    if (i >= W - 1) scale[i] = s / W;
  } }

const run = new Int16Array(n);
for (let i = 1; i < n; i++) run[i] = Math.abs(hist[i]) < Math.abs(hist[i - 1]) ? run[i - 1] + 1 : 0;

// Slope toward zero, positive when closing. Averaged over 3 bars so one flat
// bar does not erase it.
const slope = new Float64Array(n).fill(NaN);
for (let i = 3; i < n; i++) slope[i] = (Math.abs(hist[i - 3]) - Math.abs(hist[i])) / 3;

// Slope the last actual crossover arrived with, carried forward.
const lastCrossSlope = new Float64Array(n).fill(NaN);
{ let cur = NaN;
  for (let i = 1; i < n; i++) {
    if (cross[i]) cur = Math.abs(hist[i] - hist[i - 1]);
    lastCrossSlope[i] = cur;
  } }

const within = (i, K) => {
  for (let k = i + 1; k <= Math.min(n - 1, i + K); k++) if (cross[k]) return true;
  return false;
};

let baseHits = 0, baseTot = 0, b3 = 0;
for (let i = W; i < n - 8; i++) { baseTot++; if (within(i, 2)) baseHits++; if (within(i, 3)) b3++; }
const base2 = 100 * baseHits / baseTot, base3 = 100 * b3 / baseTot;
console.log("\n" + "=".repeat(92));
console.log("PRECURSOR COMPARISON — 5-minute bars, base rate " + base2.toFixed(1) +
            "% (within 2) / " + base3.toFixed(1) + "% (within 3)");
console.log("=".repeat(92));

function test(label, pred) {
  let tot = 0, h2 = 0, h3 = 0;
  for (let i = W; i < n - 8; i++) {
    if (!pred(i)) continue;
    tot++; if (within(i, 2)) h2++; if (within(i, 3)) h3++;
  }
  if (tot < 500) return;
  const p2 = 100 * h2 / tot, p3 = 100 * h3 / tot;
  console.log("  " + label.padEnd(34) + tot.toLocaleString().padStart(9) +
    (p2.toFixed(1) + "%").padStart(9) + ("(" + (p2 / base2).toFixed(2) + "x)").padStart(8) +
    (p3.toFixed(1) + "%").padStart(9) + ("(" + (p3 / base3).toFixed(2) + "x)").padStart(8));
}

console.log("\n  predictor                          samples  within2         within3");
console.log("\n  A — successive shrinking bars ONLY");
for (const N of [2, 3, 4, 5, 6, 8]) test("    " + N + " bars", (i) => run[i] >= N);

console.log("\n  B — proximity to zero ONLY");
for (const px of [0.5, 0.25, 0.1, 0.05]) test("    |hist| < " + px + "x avg",
  (i) => Math.abs(hist[i]) < px * scale[i]);

console.log("\n  C — both, as the strategy does now");
for (const [N, px] of [[3, 0.25], [3, 0.1], [4, 0.1], [3, 0.075]])
  test("    " + N + " bars + " + px + "x", (i) => run[i] >= N && Math.abs(hist[i]) < px * scale[i]);

console.log("\n  D — projected bars to zero at the current rate");
for (const T of [1, 2, 3, 5]) test("    eta <= " + T + " bars",
  (i) => slope[i] > 0 && Math.abs(hist[i]) / slope[i] <= T);

console.log("\n  E — approach at least as steep as the last real cross");
for (const k of [0.5, 1.0, 1.5]) test("    slope >= " + k + "x last cross",
  (i) => slope[i] > 0 && Number.isFinite(lastCrossSlope[i]) && slope[i] >= k * lastCrossSlope[i]);

console.log("\n  D+A — projection with a run of shrinking bars behind it");
for (const [N, T] of [[2, 2], [3, 2], [3, 3], [4, 3]])
  test("    " + N + " bars + eta <= " + T, (i) => run[i] >= N && slope[i] > 0 &&
    Math.abs(hist[i]) / slope[i] <= T);
