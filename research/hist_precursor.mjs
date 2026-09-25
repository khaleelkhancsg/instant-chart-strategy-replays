// Can a crossover be seen coming from the histogram alone?
//
// It is not a hindsight question, which is what makes it worth asking. The
// histogram IS macd - signal, so a crossover happens exactly when it reaches
// zero. A histogram shrinking toward zero is literally the approach to one, and
// everything needed to see it is available at the bar it is read on.
//
// The real question is the FALSE POSITIVE rate: a histogram routinely shrinks
// most of the way to zero and then re-expands without ever crossing. So this
// measures the conditional probability directly, against the base rate, before
// anything is built on top of it.
//
//   node research/hist_precursor.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { ema } from "../src/indicators.mjs";

const { bars } = loadBars();
const tf = resample(bars, 5);
const C = tf.close, n = C.length;
const ef = ema(C, 12), es = ema(C, 26);
const line = new Float64Array(n);
for (let i = 0; i < n; i++) line[i] = ef[i] - es[i];
const sigL = ema(line, 9);
const hist = new Float64Array(n);
for (let i = 0; i < n; i++) hist[i] = line[i] - sigL[i];

const side = (v) => (v >= 0 ? 1 : -1);
const crossAt = new Uint8Array(n);
for (let i = 1; i < n; i++) if (side(hist[i]) !== side(hist[i - 1])) crossAt[i] = 1;

// A rolling scale for "close to zero", so the threshold means the same thing in
// 2019 and 2026. Mean |hist| over the trailing 200 bars.
const scale = new Float64Array(n);
{
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += Math.abs(hist[i]);
    if (i >= 200) sum -= Math.abs(hist[i - 200]);
    scale[i] = i >= 200 ? sum / 200 : NaN;
  }
}

// Consecutive bars shrinking toward zero, ending at i.
const run = new Int16Array(n);
for (let i = 1; i < n; i++) {
  run[i] = Math.abs(hist[i]) < Math.abs(hist[i - 1]) ? run[i - 1] + 1 : 0;
}

const crossWithin = (i, K) => {
  for (let k = i + 1; k <= Math.min(n - 1, i + K); k++) if (crossAt[k]) return true;
  return false;
};

console.log("\n" + "=".repeat(92));
console.log("DOES A SHRINKING HISTOGRAM PREDICT THE CROSS? — 5-minute bars, " +
            n.toLocaleString() + " of them");
console.log("=".repeat(92));

// Base rate first: with no condition at all, how often is a cross within K bars?
console.log("\n  base rate, no condition");
const base = {};
for (const K of [1, 2, 3, 5, 8]) {
  let hit = 0, tot = 0;
  for (let i = 200; i < n - 8; i++) { tot++; if (crossWithin(i, K)) hit++; }
  base[K] = 100 * hit / tot;
  console.log("    cross within " + String(K).padStart(2) + " bars: " + base[K].toFixed(1) + "%");
}

console.log("\n  given N consecutive shrinking bars (and how much that lifts the base rate)");
console.log("  N   samples    within 1    within 2    within 3    within 5");
for (const N of [1, 2, 3, 4, 5, 6]) {
  let tot = 0; const hits = { 1: 0, 2: 0, 3: 0, 5: 0 };
  for (let i = 200; i < n - 8; i++) {
    if (run[i] < N) continue;
    tot++;
    for (const K of [1, 2, 3, 5]) if (crossWithin(i, K)) hits[K]++;
  }
  if (!tot) continue;
  const cell = (K) => {
    const p = 100 * hits[K] / tot;
    return (p.toFixed(1) + "% (" + (p / base[K]).toFixed(2) + "x)").padStart(12);
  };
  console.log("  " + String(N).padStart(2) + tot.toLocaleString().padStart(9) +
    cell(1) + cell(2) + cell(3) + cell(5));
}

console.log("\n  adding PROXIMITY: |hist| below a fraction of its own recent average");
console.log("  N  prox   samples    within 2    within 3    within 5");
for (const N of [2, 3]) {
  for (const prox of [1.0, 0.5, 0.25, 0.1]) {
    let tot = 0; const hits = { 2: 0, 3: 0, 5: 0 };
    for (let i = 200; i < n - 8; i++) {
      if (run[i] < N) continue;
      if (!(Math.abs(hist[i]) < prox * scale[i])) continue;
      tot++;
      for (const K of [2, 3, 5]) if (crossWithin(i, K)) hits[K]++;
    }
    if (!tot) continue;
    const cell = (K) => {
      const p = 100 * hits[K] / tot;
      return (p.toFixed(1) + "% (" + (p / base[K]).toFixed(2) + "x)").padStart(12);
    };
    console.log("  " + String(N).padStart(2) + String(prox).padStart(6) +
      tot.toLocaleString().padStart(10) + cell(2) + cell(3) + cell(5));
  }
}

// How much of the cross's own move would an early entry actually capture?
console.log("\n" + "=".repeat(92));
console.log("WHAT AN EARLY ENTRY WOULD BE WORTH — price at the anticipation vs at the cross");
console.log("=".repeat(92));
console.log("\n  N  prox   fires   crossed   avg lead (bars)   avg better entry (pts)");
for (const N of [2, 3]) {
  for (const prox of [0.5, 0.25, 0.1]) {
    let fires = 0, crossed = 0, lead = 0, edge = 0;
    for (let i = 200; i < n - 10; i++) {
      if (run[i] < N || !(Math.abs(hist[i]) < prox * scale[i])) continue;
      fires++;
      // Anticipated direction is the side the histogram is heading TOWARD.
      const dir = -side(hist[i]);
      let j = -1;
      for (let k = i + 1; k <= Math.min(n - 1, i + 5); k++) if (crossAt[k]) { j = k; break; }
      if (j < 0) continue;
      crossed++;
      lead += j - i;
      // Entering at i+1's open versus the cross entry at j+1's open.
      const early = tf.open[i + 1], late = tf.open[Math.min(n - 1, j + 1)];
      edge += (late - early) * dir;         // positive = the early fill was better
    }
    if (!fires) continue;
    console.log("  " + String(N).padStart(2) + String(prox).padStart(6) +
      fires.toLocaleString().padStart(8) +
      (crossed + " (" + (100 * crossed / fires).toFixed(0) + "%)").padStart(14) +
      (lead / crossed).toFixed(2).padStart(15) +
      (edge / crossed).toFixed(2).padStart(24));
  }
}
