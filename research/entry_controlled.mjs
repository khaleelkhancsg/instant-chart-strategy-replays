// Entry quality with the exit held EXACTLY constant.
//
// Measuring what the next few bars do is noise-dominated, which is why every
// rule came out a coin flip three bars in. The right control is to give every
// entry the SAME exit and let the difference be attributable to entry timing
// alone: a long is closed at the next BEARISH crossover, a short at the next
// BULLISH one, whatever rule got it in.
//
// Note what that means for an anticipated entry. Going long before a bullish
// cross means the trade runs through that cross and on to the following bearish
// one, so it is strictly the same exit EVENT as the bare crossover book takes,
// reached from an earlier entry. And when the anticipation is wrong and the
// bullish cross never arrives, the position sits there until the histogram
// eventually goes positive and comes back down -- so the cost of a false
// anticipation is paid in full rather than quietly dropped.
//
// These are overlapping, independently measured trades, not a tradeable
// sequence. It is a signal study; no account could hold all of them at once.
//
//   node research/entry_controlled.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { resolveParams } from "../src/run.mjs";
import flip from "../strategies/macd_5m_flip.mjs";
import fade from "../strategies/macd_5m_fade.mjs";
import ant from "../strategies/macd_5m_anticipate.mjs";

const { bars } = loadBars();
const tf = resample(bars, 5);
const O = tf.open, n = O.length;
const MIDI = Math.floor(n / 2);

// The histogram, rebuilt once with the shared defaults so every rule is scored
// against the same crossover events.
const P0 = resolveParams(ant);
const hist = ant.compute(tf, P0).overlays.find((o) => o.kind === "hist").data;
const side = (v) => (v >= 0 ? 1 : -1);

// nextOpp[d][i] = first bar after i where a crossover INTO direction -d occurs.
// Precomputed backwards so each lookup is O(1).
const nextBear = new Int32Array(n).fill(-1);   // + -> -  (closes a long)
const nextBull = new Int32Array(n).fill(-1);   // - -> +  (closes a short)
for (let i = n - 2; i >= 1; i--) {
  const crossed = side(hist[i + 1]) !== side(hist[i]);
  const bear = crossed && side(hist[i + 1]) === -1;
  const bull = crossed && side(hist[i + 1]) === 1;
  nextBear[i] = bear ? i + 1 : nextBear[i + 1];
  nextBull[i] = bull ? i + 1 : nextBull[i + 1];
}

function entries(strategy, over) {
  const p = { ...resolveParams(strategy), ...over };
  const sig = strategy.compute(tf, p).sig;
  const out = [];
  let last = 0;
  for (let i = 1; i < n - 2; i++) {
    const s = sig[i];
    if (s === 0) { last = 0; continue; }
    if (s === last) continue;
    last = s;
    out.push({ i: i + 1, dir: s });        // filled at the next bar's open
  }
  return out;
}

function measure(es) {
  if (es.length < 300) return null;
  const pts = [], held = [];
  let firstHalf = [], secondHalf = [];
  for (const e of es) {
    const j = e.dir === 1 ? nextBear[e.i] : nextBull[e.i];
    if (j < 0 || j + 1 >= n) continue;
    const g = (O[j + 1] - O[e.i]) * e.dir;
    pts.push(g); held.push(j + 1 - e.i);
    (e.i < MIDI ? firstHalf : secondHalf).push(g);
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const srt = pts.slice().sort((a, b) => a - b);
  return {
    n: pts.length, pts: avg(pts), med: srt[srt.length >> 1],
    win: 100 * pts.filter((x) => x > 0).length / pts.length,
    hold: avg(held),
    h1: firstHalf.length ? avg(firstHalf) : NaN,
    h2: secondHalf.length ? avg(secondHalf) : NaN,
  };
}

const rows = [];
const add = (label, s, over) => {
  const m = measure(entries(s, over));
  if (m) rows.push({ label, ...m });
};

add("cross (the baseline)", flip, {});
for (const b of [1, 2, 3, 4, 6]) add("cross + " + b + " growing", fade, { buildBars: b });
for (const px of [0.5, 0.25, 0.1, 0.075, 0.05])
  add("anticipate prox " + px, ant, { trigger: "prox", shrinkBars: 3, prox: px });
for (const N of [1, 2, 4]) add("anticipate prox 0.1, N=" + N, ant,
  { trigger: "prox", shrinkBars: N, prox: 0.1 });
for (const e of [0.5, 1, 2]) add("anticipate eta <=" + e, ant,
  { trigger: "eta", shrinkBars: 3, etaBars: e });

console.log("\n" + "=".repeat(100));
console.log("ENTRY COMPARISON — identical exit for every rule: the next opposite crossover");
console.log("=".repeat(100));
console.log("\n  entry rule                  trades   avg pts   median   win%   hold    1st / 2nd half");
for (const r of rows) {
  console.log("  " + r.label.padEnd(26) + r.n.toLocaleString().padStart(8) +
    r.pts.toFixed(2).padStart(10) + r.med.toFixed(2).padStart(9) +
    r.win.toFixed(1).padStart(7) + r.hold.toFixed(0).padStart(7) +
    (r.h1.toFixed(2) + " / " + r.h2.toFixed(2)).padStart(18));
}

const base = rows[0];
console.log("\n  gain over entering at the cross, in points and in dollars at 8 lots");
for (const r of rows.slice(1).sort((a, b) => b.pts - a.pts).slice(0, 6)) {
  const d = r.pts - base.pts;
  console.log("    " + ((d >= 0 ? "+" : "") + d.toFixed(2) + " pts").padStart(10) +
    ("  $" + (d * 2 * 8).toFixed(2)).padStart(11) + "   " + r.label);
}
console.log("\n  commission at 8 lots is $12 a round trip = 0.75 pts");
