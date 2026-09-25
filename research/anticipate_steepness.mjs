// Is there an ideal STEEPNESS for the anticipation, and does it cut false positives?
//
// Every gate tried so far was external to the signal -- volume, ADX, ADR,
// efficiency, regime -- and none of them moved the arrival rate off 48%. This
// one is intrinsic: how fast the histogram is closing on zero when the entry
// fires. The hypothesis has a shape that a one-sided threshold cannot express,
// which is why it is worth its own test:
//
//   too slow   the histogram is drifting, stalls before it reaches zero
//   too fast   a violent push that overshoots and snaps back
//   between    a controlled approach that actually completes
//
// So this sweeps BANDS, not cutoffs, and checks whether the best one sits in
// the interior. An interior peak found by search is also exactly what overfits,
// so every band is scored against a matched null of the same trade count, read
// on both halves, repeated on a second trigger setting, and given a 2026 column
// that was not used to choose anything.
//
// Note the eta trigger already mixes steepness with level -- it is level
// DIVIDED BY rate, bars-until-zero -- and it trades worse than proximity
// (research/precursor_compare.mjs). A band on steepness alone is a different
// object: it says nothing about how far there is to go.
//
// STEEPNESS IS NORMALISED. Points per bar is not comparable across seven years
// of price levels, so the closing rate is divided by the trailing mean |hist|,
// the same scale the strategy uses for proximity. One unit = closes a typical
// histogram's worth of distance in one bar. Under a 45-degree convention for
// that unit the degree equivalent is atan(rate) -- printed alongside, since the
// original question was posed in angles.
//
//   node research/anticipate_steepness.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { resolveParams } from "../src/run.mjs";
import ant from "../strategies/macd_5m_anticipate.mjs";

const { bars } = loadBars();
const tf = resample(bars, 5);
const O = tf.open, H = tf.high, L = tf.low, C = tf.close;
const tday = tf.tday, ctMin = tf.ctMin, ts = tf.ts;
const n = O.length;
const MIDI = Math.floor(n / 2);

const P0 = resolveParams(ant);
const hist = ant.compute(tf, P0).overlays.find((o) => o.kind === "hist").data;
const side = (v) => (v >= 0 ? 1 : -1);

const nextBear = new Int32Array(n).fill(-1);
const nextBull = new Int32Array(n).fill(-1);
for (let i = n - 2; i >= 1; i--) {
  const crossed = side(hist[i + 1]) !== side(hist[i]);
  nextBear[i] = crossed && side(hist[i + 1]) === -1 ? i + 1 : nextBear[i + 1];
  nextBull[i] = crossed && side(hist[i + 1]) === 1 ? i + 1 : nextBull[i + 1];
}

const year = new Int16Array(n);
for (let i = 0; i < n; i++) year[i] = new Date(ts[i]).getUTCFullYear();

// The same trailing |hist| scale the strategy's proximity test uses, so
// steepness and proximity are measured against one another in the same units.
const SCALE_BARS = 200;
const scale = new Float64Array(n).fill(NaN);
{
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(hist[i]);
    if (Number.isFinite(a)) sum += a;
    if (i >= SCALE_BARS) sum -= Math.abs(hist[i - SCALE_BARS]) || 0;
    if (i >= SCALE_BARS - 1) scale[i] = sum / SCALE_BARS;
  }
}

// Closing rate over the last SB bars, normalised. Positive by construction at a
// signal bar, since the trigger already required consecutive shrinking bars.
const SB = 3;
const steep = new Float64Array(n).fill(NaN);
const accel = new Float64Array(n).fill(NaN);
for (let i = 2 * SB; i < n; i++) {
  const s = scale[i];
  if (!Number.isFinite(s) || s <= 0) continue;
  const a0 = Math.abs(hist[i]), a1 = Math.abs(hist[i - SB]), a2 = Math.abs(hist[i - 2 * SB]);
  if (!Number.isFinite(a0) || !Number.isFinite(a1) || !Number.isFinite(a2)) continue;
  const r1 = (a1 - a0) / SB;            // rate over the most recent SB bars
  const r0 = (a2 - a1) / SB;            // rate over the SB bars before those
  steep[i] = r1 / s;
  accel[i] = (r1 - r0) / s;             // + = closing faster, - = stalling
}
const deg = (r) => (Math.atan(r) * 180) / Math.PI;

const ADR_DAYS = 14;
const adrUsed = new Float64Array(n).fill(NaN);
{
  const ranges = [];
  let dHi = -Infinity, dLo = Infinity, adr = NaN;
  for (let i = 0; i < n; i++) {
    if (i === 0 || tday[i] !== tday[i - 1]) {
      if (i > 0) {
        ranges.push(dHi - dLo);
        if (ranges.length > ADR_DAYS) ranges.shift();
        adr = ranges.length === ADR_DAYS
          ? ranges.reduce((a, b) => a + b, 0) / ADR_DAYS : NaN;
      }
      dHi = -Infinity; dLo = Infinity;
    }
    if (H[i] > dHi) dHi = H[i];
    if (L[i] < dLo) dLo = L[i];
    if (Number.isFinite(adr) && adr > 0) adrUsed[i] = (dHi - dLo) / adr;
  }
}
const quiet = (i) => (ctMin[i] < 510 || ctMin[i] >= 900) &&
  Number.isFinite(adrUsed[i]) && adrUsed[i] < 0.5;

function buildEntries(over) {
  const p = { ...resolveParams(ant), ...over };
  const sig = ant.compute(tf, p).sig;
  const out = [];
  let last = 0;
  for (let i = 1; i < n - 2; i++) {
    const s = sig[i];
    if (s === 0) { last = 0; continue; }
    if (s === last) continue;
    last = s;
    const arrive = s === 1 ? nextBull[i] : nextBear[i];
    const j = s === 1 ? nextBear[i + 1] : nextBull[i + 1];
    if (arrive < 0 || j < 0 || j + 1 >= n) continue;
    if (!Number.isFinite(steep[i])) continue;
    out.push({
      sig: i, i: i + 1, dir: s, lag: arrive - i,
      st: steep[i], ac: accel[i],
      pts: (O[j + 1] - O[i + 1]) * s,
    });
  }
  return out;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function stats(es) {
  const pts = es.map((e) => e.pts);
  const srt = pts.slice().sort((a, b) => a - b);
  const y26 = es.filter((e) => year[e.i] >= 2026).map((e) => e.pts);
  return {
    n: es.length, pts: avg(pts), med: srt[srt.length >> 1],
    win: (100 * pts.filter((x) => x > 0).length) / pts.length,
    fast: (100 * es.filter((e) => e.lag <= 2).length) / es.length,
    tail: (100 * es.filter((e) => e.lag > 10).length) / es.length,
    h1: avg(es.filter((e) => e.i < MIDI).map((e) => e.pts)),
    h2: avg(es.filter((e) => e.i >= MIDI).map((e) => e.pts)),
    n26: y26.length, y26: avg(y26),
  };
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function nullSpread(all, k, draws = 400, seed = 987) {
  const rnd = mulberry32(seed), N = all.length;
  const idx = new Int32Array(N);
  for (let i = 0; i < N; i++) idx[i] = i;
  const means = [];
  for (let d = 0; d < draws; d++) {
    for (let i = N - 1; i > N - 1 - k; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    let s = 0;
    for (let i = N - k; i < N; i++) s += all[idx[i]].pts;
    means.push(s / k);
  }
  const m = avg(means);
  return Math.sqrt(avg(means.map((x) => (x - m) * (x - m))));
}

const qOf = (sorted, p) => sorted[Math.min(sorted.length - 1,
  Math.max(0, Math.floor((p / 100) * sorted.length)))];

const ROW = (lab, s, extra = "") => "  " + lab.padEnd(22) + s.n.toLocaleString().padStart(7) +
  s.fast.toFixed(1).padStart(9) + "%" + s.tail.toFixed(1).padStart(8) + "%" +
  s.pts.toFixed(2).padStart(9) + s.win.toFixed(1).padStart(7) +
  (s.h1.toFixed(2) + " / " + s.h2.toFixed(2)).padStart(17) +
  (s.n26 > 200 ? s.y26.toFixed(2).padStart(8) : "      --") + extra;
const HEAD = "  band                  trades  arrive<=2  tail>10   avg pts   win%    1st / 2nd half    2026";

for (const [name, over] of [["prox 0.25", { trigger: "prox", shrinkBars: 3, prox: 0.25 }],
                            ["prox 0.075", { trigger: "prox", shrinkBars: 3, prox: 0.075 }]]) {
  const E = buildEntries(over);
  const B = stats(E);
  const sorted = E.map((e) => e.st).sort((a, b) => a - b);

  console.log("");
  console.log("=".repeat(104));
  console.log("HISTOGRAM STEEPNESS AT THE ANTICIPATION -- " + name + ", 5-min bars, exit at the next opposite cross");
  console.log("=".repeat(104));
  console.log("");
  console.log("  steepness = (normalised) fraction of a typical |hist| closed per bar, over " + SB + " bars");
  console.log("  distribution:  p10 " + qOf(sorted, 10).toFixed(3) +
    "   p50 " + qOf(sorted, 50).toFixed(3) +
    "   p90 " + qOf(sorted, 90).toFixed(3) +
    "      (" + deg(qOf(sorted, 10)).toFixed(0) + " / " +
    deg(qOf(sorted, 50)).toFixed(0) + " / " + deg(qOf(sorted, 90)).toFixed(0) + " degrees)");

  // ── PART 1: deciles ───────────────────────────────────────────────────
  console.log("");
  console.log("PART 1 -- by steepness decile");
  console.log("");
  console.log(HEAD);
  console.log("  " + "-".repeat(94));
  console.log(ROW("(all)", B));
  for (let d = 0; d < 10; d++) {
    const lo = qOf(sorted, d * 10), hi = d === 9 ? Infinity : qOf(sorted, (d + 1) * 10);
    const g = E.filter((e) => e.st >= lo && e.st < hi);
    if (g.length < 200) continue;
    console.log(ROW("d" + (d + 1) + "  " + lo.toFixed(2) + "-" +
      (hi === Infinity ? "max" : hi.toFixed(2)), stats(g)));
  }

  // ── PART 2: bands against the matched null ───────────────────────────
  console.log("");
  console.log("PART 2 -- bands, scored against a matched null of the same trade count");
  console.log("");
  console.log(HEAD + "     z");
  console.log("  " + "-".repeat(102));
  const BANDS = [[0, 20], [0, 40], [10, 40], [20, 50], [20, 60], [30, 60], [30, 70],
                 [40, 70], [40, 80], [50, 80], [60, 90], [60, 100], [80, 100],
                 [10, 90], [20, 80], [30, 90]];
  const out = [];
  for (const [a, b] of BANDS) {
    const lo = a === 0 ? -Infinity : qOf(sorted, a);
    const hi = b === 100 ? Infinity : qOf(sorted, b);
    const g = E.filter((e) => e.st >= lo && e.st < hi);
    if (g.length < 400) continue;
    const s = stats(g);
    const z = (s.pts - B.pts) / nullSpread(E, g.length);
    out.push({ a, b, s, z });
    console.log(ROW("p" + a + "-p" + b, s, ((z >= 0 ? "+" : "") + z.toFixed(1)).padStart(7)));
  }

  const best = out.slice().sort((x, y) => y.s.pts - x.s.pts)[0];
  const interior = best && best.a > 0 && best.b < 100;
  console.log("");
  console.log("  best band is p" + best.a + "-p" + best.b + " at " + best.s.pts.toFixed(2) +
    " pts (z=" + (best.z >= 0 ? "+" : "") + best.z.toFixed(1) + ") -- " +
    (interior ? "INTERIOR, which is what the hypothesis predicts"
              : "at an EDGE of the range, so it is a threshold, not a band"));
  console.log("  arrival across every band: " +
    Math.min(...out.map((o) => o.s.fast)).toFixed(1) + "% to " +
    Math.max(...out.map((o) => o.s.fast)).toFixed(1) + "%   (ungated " + B.fast.toFixed(1) + "%)");
  console.log("  damaging tail across every band: " +
    Math.min(...out.map((o) => o.s.tail)).toFixed(1) + "% to " +
    Math.max(...out.map((o) => o.s.tail)).toFixed(1) + "%   (ungated " + B.tail.toFixed(1) + "%)");

  // ── PART 3: acceleration ─────────────────────────────────────────────
  const asort = E.map((e) => e.ac).sort((a, b) => a - b);
  console.log("");
  console.log("PART 3 -- acceleration: is the close speeding up or stalling?");
  console.log("");
  console.log(HEAD);
  console.log("  " + "-".repeat(94));
  for (const [a, b] of [[0, 25], [25, 50], [50, 75], [75, 100]]) {
    const lo = a === 0 ? -Infinity : qOf(asort, a);
    const hi = b === 100 ? Infinity : qOf(asort, b);
    const g = E.filter((e) => e.ac >= lo && e.ac < hi);
    if (g.length < 200) continue;
    console.log(ROW((a === 0 ? "stalling  " : b === 100 ? "speeding  " : "middle    ") +
      "q" + (a / 25 + 1), stats(g)));
  }

  // ── PART 4: does it add anything to the gate that already survived? ──
  console.log("");
  console.log("PART 4 -- stacked on the quiet/low-ADR gate that survived earlier");
  console.log("");
  console.log(HEAD);
  console.log("  " + "-".repeat(94));
  const Q = E.filter((e) => quiet(e.sig));
  const QB = stats(Q);
  console.log(ROW("quiet + lowADR", QB, "      -"));
  const qsort = Q.map((e) => e.st).sort((a, b) => a - b);
  for (const [a, b] of [[0, 50], [25, 75], [50, 100], [best.a, best.b]]) {
    const lo = a === 0 ? -Infinity : qOf(qsort, a);
    const hi = b === 100 ? Infinity : qOf(qsort, b);
    const g = Q.filter((e) => e.st >= lo && e.st < hi);
    if (g.length < 300) continue;
    const s = stats(g);
    // Scored inside the quiet set, so this asks whether steepness adds anything
    // to a gate that already works -- not whether the pair beats nothing.
    const z = (s.pts - QB.pts) / nullSpread(Q, g.length);
    console.log(ROW("  + steep p" + a + "-p" + b, s,
      ((z >= 0 ? "+" : "") + z.toFixed(1)).padStart(7)));
  }
}

console.log("");
console.log("  Net of commission at 8 lots, subtract 0.75 pts from every gross figure.");
console.log("");
