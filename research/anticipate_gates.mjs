// Can the false anticipations be filtered out? Volume, ADX, ADR, efficiency, regime.
//
// The anticipation entry reads the histogram closing on zero and enters before
// the cross. It improves the typical trade (win 37% -> 44%, median -5.25 ->
// -2.00) and leaves the mean alone, because the anticipations whose cross does
// not arrive promptly are held through the adverse move instead of never being
// taken. The question is whether those are separable in advance.
//
// PART 1 asks whether they are even the problem. "36% never cross" was loose --
// the histogram always crosses eventually -- so what matters is the ARRIVAL LAG
// and whether P&L actually decays with it. If a late arrival costs nothing,
// there is nothing for a gate to buy.
//
// PART 2 gates on each candidate, in both directions, against a MATCHED NULL:
// random subsets of the same size, so a gate has to beat what cutting the trade
// count does by luck alone. Everything is read at the signal bar and filled at
// the next open, so no gate sees its own outcome.
//
//   node research/anticipate_gates.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { resolveParams } from "../src/run.mjs";
import { adx, atr, efficiencyRatio, sma, choppiness } from "../src/indicators.mjs";
import ant from "../strategies/macd_5m_anticipate.mjs";

const { bars } = loadBars();
const tf = resample(bars, 5);
const O = tf.open, H = tf.high, L = tf.low, C = tf.close, V = tf.volume;
const tday = tf.tday, ctMin = tf.ctMin;
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

// ── the gates, all causal at bar i ──────────────────────────────────────
const relVol = (() => {
  const m = sma(V, 200), out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) if (m[i] > 0) out[i] = V[i] / m[i];
  return out;
})();
const ADX = adx(H, L, C, 14).adx;
const EFF = efficiencyRatio(C, 20);
const CHOP = choppiness(H, L, C, 14);
const ATR = atr(H, L, C, 14);
const atrPct = new Float64Array(n).fill(NaN);
for (let i = 0; i < n; i++) if (C[i] > 0) atrPct[i] = (100 * ATR[i]) / C[i];

// ADR: mean true daily range over the previous 14 COMPLETED days, plus how much
// of it the current day has already spent. A day that has covered its whole
// average range has less extension left in it, which is the reason to expect a
// cross rather than a continuation.
const ADR_DAYS = 14;
const adrPct = new Float64Array(n).fill(NaN);
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
    if (Number.isFinite(adr) && adr > 0) {
      adrPct[i] = (100 * adr) / C[i];
      adrUsed[i] = (dHi - dLo) / adr;
    }
  }
}

// ── the anticipation entry set, measured once ───────────────────────────
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
    // Arrival of the cross this entry is betting on, and the controlled exit.
    const arrive = s === 1 ? nextBull[i] : nextBear[i];
    const j = s === 1 ? nextBear[i + 1] : nextBull[i + 1];
    if (arrive < 0 || j < 0 || j + 1 >= n) continue;
    out.push({
      sig: i, i: i + 1, dir: s,
      lag: arrive - i,
      pts: (O[j + 1] - O[i + 1]) * s,
      hold: j + 1 - (i + 1),
    });
  }
  return out;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function stats(es) {
  const pts = es.map((e) => e.pts);
  const srt = pts.slice().sort((a, b) => a - b);
  return {
    n: es.length,
    pts: avg(pts),
    med: srt.length ? srt[srt.length >> 1] : NaN,
    win: (100 * pts.filter((x) => x > 0).length) / pts.length,
    hold: avg(es.map((e) => e.hold)),
    lag: avg(es.map((e) => e.lag)),
    fast: (100 * es.filter((e) => e.lag <= 2).length) / es.length,
    h1: avg(es.filter((e) => e.i < MIDI).map((e) => e.pts)),
    h2: avg(es.filter((e) => e.i >= MIDI).map((e) => e.pts)),
  };
}

// Matched null: a gate that keeps k of N trades moves the average by chance
// alone. Draw random subsets of the same size and score the gate in units of
// that spread.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function nullSpread(all, k, draws = 400, seed = 12345) {
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
  const sd = Math.sqrt(avg(means.map((x) => (x - m) * (x - m))));
  return sd;
}

const BASE = buildEntries({ trigger: "prox", shrinkBars: 3, prox: 0.25 });
const B = stats(BASE);

console.log("");
console.log("=".repeat(104));
console.log("CAN THE FALSE ANTICIPATIONS BE FILTERED OUT?   base = prox 0.25, 3 shrinking bars, 5-min bars");
console.log("=".repeat(104));

// ── PART 1 ─────────────────────────────────────────────────────────────
console.log("");
console.log("PART 1 -- is a late arrival actually what costs money?");
console.log("");
console.log("  the anticipated cross arrives after this many bars:");
for (const k of [1, 2, 3, 5, 10, 20, 50]) {
  const p = (100 * BASE.filter((e) => e.lag <= k).length) / BASE.length;
  console.log("    within " + String(k).padStart(2) + " bars   " + p.toFixed(1).padStart(5) + "%");
}
console.log("    median lag " + BASE.map((e) => e.lag).sort((a, b) => a - b)[BASE.length >> 1] + " bars");
console.log("");
console.log("  P&L split by that lag, exit held constant:");
console.log("    arrival lag        trades   avg pts   median   win%   hold    1st / 2nd half");
for (const [lo, hi] of [[1, 1], [2, 2], [3, 3], [4, 5], [6, 10], [11, 20], [21, 1e9]]) {
  const g = BASE.filter((e) => e.lag >= lo && e.lag <= hi);
  if (g.length < 100) continue;
  const s = stats(g);
  const lab = hi >= 1e9 ? lo + "+ bars" : lo === hi ? lo + " bar" + (lo > 1 ? "s" : "") : lo + "-" + hi + " bars";
  console.log("    " + lab.padEnd(17) + s.n.toLocaleString().padStart(8) +
    s.pts.toFixed(2).padStart(10) + s.med.toFixed(2).padStart(9) +
    s.win.toFixed(1).padStart(7) + s.hold.toFixed(0).padStart(7) +
    (s.h1.toFixed(2) + " / " + s.h2.toFixed(2)).padStart(18));
}

// ── PART 2 ─────────────────────────────────────────────────────────────
const GATES = [];
const g = (label, vals, cmp, thr) =>
  GATES.push({ label, keep: (e) => cmp(vals[e.sig], thr) });
const gt = (a, b) => Number.isFinite(a) && a > b;
const lt = (a, b) => Number.isFinite(a) && a < b;

for (const t of [0.8, 1.0, 1.25, 1.5]) g("volume  rel > " + t.toFixed(2), relVol, gt, t);
for (const t of [0.8, 1.0, 1.25]) g("volume  rel < " + t.toFixed(2), relVol, lt, t);
for (const t of [15, 20, 25, 30]) g("ADX     < " + t, ADX, lt, t);
for (const t of [20, 25, 30]) g("ADX     > " + t, ADX, gt, t);
for (const t of [0.7, 0.9, 1.1]) g("ADR     used > " + t.toFixed(2), adrUsed, gt, t);
for (const t of [0.5, 0.7, 0.9]) g("ADR     used < " + t.toFixed(2), adrUsed, lt, t);
for (const t of [0.6, 0.8, 1.0]) g("ADR     pct > " + t.toFixed(2), adrPct, gt, t);
for (const t of [0.15, 0.25, 0.35]) g("effcy   < " + t.toFixed(2), EFF, lt, t);
for (const t of [0.25, 0.35, 0.45]) g("effcy   > " + t.toFixed(2), EFF, gt, t);
for (const t of [55, 60, 65]) g("chop    > " + t, CHOP, gt, t);
for (const t of [45, 50]) g("chop    < " + t, CHOP, lt, t);
for (const t of [0.08, 0.12, 0.18]) g("regime  atr% > " + t.toFixed(2), atrPct, gt, t);
for (const t of [0.08, 0.12]) g("regime  atr% < " + t.toFixed(2), atrPct, lt, t);
GATES.push({ label: "regime  RTH 08:30-15:00", keep: (e) => ctMin[e.sig] >= 510 && ctMin[e.sig] < 900 });
GATES.push({ label: "regime  first 2h of RTH", keep: (e) => ctMin[e.sig] >= 510 && ctMin[e.sig] < 630 });
GATES.push({ label: "regime  overnight only", keep: (e) => ctMin[e.sig] < 510 || ctMin[e.sig] >= 900 });

console.log("");
console.log("PART 2 -- each gate against a matched null of the same trade count");
console.log("");
console.log("  gate                     trades   kept   cross<=2b   avg pts    z     1st / 2nd half");
console.log("  " + "-".repeat(94));
console.log("  " + "(ungated)".padEnd(23) + B.n.toLocaleString().padStart(8) +
  "  100%" + B.fast.toFixed(1).padStart(11) + "%" +
  B.pts.toFixed(2).padStart(10) + "     -" +
  (B.h1.toFixed(2) + " / " + B.h2.toFixed(2)).padStart(18));

const results = [];
for (const gate of GATES) {
  const kept = BASE.filter(gate.keep);
  if (kept.length < 400) continue;
  const s = stats(kept);
  const sd = nullSpread(BASE, kept.length);
  const z = (s.pts - B.pts) / sd;
  results.push({ label: gate.label, s, z });
  console.log("  " + gate.label.padEnd(23) + s.n.toLocaleString().padStart(8) +
    ((100 * s.n) / B.n).toFixed(0).padStart(5) + "%" +
    s.fast.toFixed(1).padStart(11) + "%" +
    s.pts.toFixed(2).padStart(10) +
    (z >= 0 ? "+" : "") + z.toFixed(1).padStart(5) +
    (s.h1.toFixed(2) + " / " + s.h2.toFixed(2)).padStart(18));
}

console.log("");
console.log("  best by arrival rate (does the gate predict the cross at all?)");
for (const r of results.slice().sort((a, b) => b.s.fast - a.s.fast).slice(0, 5))
  console.log("    " + r.s.fast.toFixed(1).padStart(5) + "% vs " + B.fast.toFixed(1) +
    "% ungated   " + r.label);
console.log("");
console.log("  best by expectancy, with the null-adjusted z");
for (const r of results.slice().sort((a, b) => b.s.pts - a.s.pts).slice(0, 5))
  console.log("    " + r.s.pts.toFixed(2).padStart(5) + " pts  z=" +
    (r.z >= 0 ? "+" : "") + r.z.toFixed(1).padStart(4) + "   " +
    ("$" + ((r.s.pts - B.pts) * 2 * 8).toFixed(2) + " vs ungated").padStart(22) + "   " + r.label);
console.log("");
console.log("  |z| > 2 would be a gate doing something a random cut of the same size does not.");
console.log("  commission at 8 lots is 0.75 pts.");

// ── robustness: does anything that survived repeat on a tighter trigger? ──
const ALT = buildEntries({ trigger: "prox", shrinkBars: 3, prox: 0.075 });
const AB = stats(ALT);
const keepers = results.filter((r) => Math.abs(r.z) >= 1.5)
  .sort((a, b) => b.s.pts - a.s.pts).slice(0, 6);
if (keepers.length) {
  console.log("");
  console.log("  the same gates on prox 0.075 (ungated " + AB.pts.toFixed(2) +
    " pts, " + AB.n.toLocaleString() + " trades, " + AB.fast.toFixed(1) + "% fast)");
  for (const r of keepers) {
    const gate = GATES.find((x) => x.label === r.label);
    const kept = ALT.filter(gate.keep);
    if (kept.length < 200) { console.log("    (too few)  " + r.label); continue; }
    const s = stats(kept);
    const z = (s.pts - AB.pts) / nullSpread(ALT, kept.length);
    console.log("    " + r.label.padEnd(23) + s.n.toLocaleString().padStart(7) +
      s.fast.toFixed(1).padStart(9) + "%" + s.pts.toFixed(2).padStart(9) +
      "  z=" + (z >= 0 ? "+" : "") + z.toFixed(1).padStart(4) +
      (s.h1.toFixed(2) + " / " + s.h2.toFixed(2)).padStart(18));
  }
}
console.log("");
