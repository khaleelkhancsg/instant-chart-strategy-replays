// Which entry rule actually gets the best fills?
//
// Every comparison so far has been end-to-end P&L, which mixes the entry with
// the exit and with how long the book happens to hold. This removes the exit
// entirely: take each rule's signal, enter at the next bar's open, and measure
// only what price does afterwards.
//
//   fwd N      move in the signal's direction N bars later, in points
//   MAE 10     worst adverse excursion in the first 10 bars -- the heat you
//              have to sit through, which is what a badly timed entry costs
//   MFE 20     best favourable excursion in 20 bars -- the opportunity the
//              entry actually opened up
//   green 3    share of entries already in profit three bars in
//
// MFE/MAE is the summary: how much room the entry gave relative to the pain it
// cost. A "sniped" entry should show a high ratio and a low MAE even if the
// eventual move is the same, because being early is worth exactly the heat it
// avoids.
//
//   node research/entry_quality.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { resolveParams } from "../src/run.mjs";
import flip from "../strategies/macd_5m_flip.mjs";
import fade from "../strategies/macd_5m_fade.mjs";
import ant from "../strategies/macd_5m_anticipate.mjs";

const { bars } = loadBars();
const tf = resample(bars, 5);
const O = tf.open, H = tf.high, L = tf.low, n = O.length;

// Entries only, deduped: a condition that stays true for several bars would
// otherwise be counted once per bar, when a flat-then-enter book takes the
// first one and is then busy.
function entriesOf(strategy, over) {
  const p = { ...resolveParams(strategy), ...over };
  const sig = strategy.compute(tf, p).sig;
  const out = [];
  let last = 0;
  for (let i = 1; i < n - 45; i++) {
    const s = sig[i];
    if (s === 0) { last = 0; continue; }
    if (s === last) continue;          // same run, already taken
    last = s;
    out.push({ i: i + 1, dir: s });    // filled at the NEXT bar's open
  }
  return out;
}

function quality(es) {
  if (es.length < 300) return null;
  const q = { n: es.length, f5: 0, f10: 0, f20: 0, f40: 0, mae: 0, mfe: 0, green: 0 };
  for (const e of es) {
    const px = O[e.i], d = e.dir;
    q.f5 += (O[e.i + 5] - px) * d;
    q.f10 += (O[e.i + 10] - px) * d;
    q.f20 += (O[e.i + 20] - px) * d;
    q.f40 += (O[e.i + 40] - px) * d;
    if ((O[e.i + 3] - px) * d > 0) q.green++;
    let worst = 0, best = 0;
    for (let k = e.i; k < e.i + 10; k++) {
      const adv = d === 1 ? L[k] - px : px - H[k];
      if (adv < worst) worst = adv;
    }
    for (let k = e.i; k < e.i + 20; k++) {
      const fav = d === 1 ? H[k] - px : px - L[k];
      if (fav > best) best = fav;
    }
    q.mae += worst; q.mfe += best;
  }
  for (const k of ["f5", "f10", "f20", "f40", "mae", "mfe"]) q[k] /= es.length;
  q.green = 100 * q.green / es.length;
  q.ratio = q.mfe / Math.max(0.01, -q.mae);
  return q;
}

const rows = [];
const add = (label, s, over) => {
  const q = quality(entriesOf(s, over));
  if (q) rows.push({ label, ...q });
};

add("cross (bare flip)", flip, {});
for (const b of [1, 2, 3, 4]) add("cross + " + b + " growing bar(s)", fade, { buildBars: b });
for (const px of [0.25, 0.1, 0.075, 0.05])
  add("anticipate prox " + px, ant, { trigger: "prox", shrinkBars: 3, prox: px });
for (const e of [0.5, 1, 2]) add("anticipate eta <=" + e, ant, { trigger: "eta", shrinkBars: 3, etaBars: e });

console.log("\n" + "=".repeat(104));
console.log("ENTRY QUALITY — 5-minute bars, exit logic removed entirely");
console.log("=".repeat(104));
console.log("\n  entry rule                  count   fwd5   fwd10   fwd20   fwd40" +
            "    MAE10    MFE20   MFE/MAE  green3");
for (const r of rows) {
  console.log("  " + r.label.padEnd(26) + r.n.toLocaleString().padStart(7) +
    r.f5.toFixed(1).padStart(7) + r.f10.toFixed(1).padStart(8) +
    r.f20.toFixed(1).padStart(8) + r.f40.toFixed(1).padStart(8) +
    r.mae.toFixed(1).padStart(9) + r.mfe.toFixed(1).padStart(9) +
    r.ratio.toFixed(2).padStart(10) + (r.green.toFixed(1) + "%").padStart(8));
}

console.log("\n  ranked by MFE/MAE — room opened per unit of heat taken");
for (const r of rows.slice().sort((a, b) => b.ratio - a.ratio).slice(0, 5))
  console.log("    " + r.ratio.toFixed(2) + "   " + r.label);
console.log("\n  ranked by fwd20 — where price actually is, 20 bars on");
for (const r of rows.slice().sort((a, b) => b.f20 - a.f20).slice(0, 5))
  console.log("    " + r.f20.toFixed(1).padStart(6) + " pts   " + r.label);
