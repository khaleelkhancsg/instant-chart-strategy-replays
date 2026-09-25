// The anticipation tail: the gates that survived, the confound between them,
// and the lever that does not need a predictor at all.
//
// research/anticipate_gates.mjs established the shape of the problem. With the
// exit held at the next opposite crossover:
//
//   cross arrives <= 10 bars   22,319 trades   +7.32 pts
//   cross arrives >= 11 bars    8,198 trades  -19.25 pts
//                                             --------- nets to +0.18
//
// So the whole edge exists and the late-arrival tail eats all of it. None of
// volume / ADX / ADR / efficiency / regime predicts arrival: the spread on the
// arrival rate across every gate tested is 45%-53% against 48% ungated, and the
// gates that raise it MOST lose the most money, because a clean trend delivers
// the anticipated cross and then resumes against the fade.
//
// Two questions left, and they are the ones that decide whether any of this is
// usable:
//
//   1. "ADR used < 0.50" and "overnight only" both survived the matched null.
//      Overnight is precisely when the day has not spent its range yet, so
//      these may be one fact counted twice. Measured here directly.
//
//   2. A late arrival does not have to be PREDICTED. By bar 11 the position
//      already knows the cross has not come, and that is causal information.
//      Abandoning the trade beats forecasting it, if the tail is really where
//      the money goes.
//
//   node research/anticipate_tail.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { resolveParams } from "../src/run.mjs";
import { atr } from "../src/indicators.mjs";
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

const isNight = (i) => ctMin[i] < 510 || ctMin[i] >= 900;
const lowAdr = (i) => Number.isFinite(adrUsed[i]) && adrUsed[i] < 0.5;

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
    out.push({ sig: i, i: i + 1, dir: s, lag: arrive - i, exit: j + 1 });
  }
  return out;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// bail: abandon the trade if the anticipated cross has not arrived by this many
// bars after the signal. Fully causal -- at bar sig+bail the position knows.
function score(es, bail = Infinity) {
  const pts = [], h1 = [], h2 = [], y26 = [];
  let bailed = 0;
  for (const e of es) {
    let x = e.exit;
    if (e.lag > bail) {
      const k = e.sig + bail + 1;          // exit at the open after the deadline
      if (k >= n) continue;
      x = k; bailed++;
    }
    const g = (O[x] - O[e.i]) * e.dir;
    pts.push(g);
    (e.i < MIDI ? h1 : h2).push(g);
    if (year[e.i] >= 2026) y26.push(g);
  }
  const srt = pts.slice().sort((a, b) => a - b);
  return {
    n: pts.length, pts: avg(pts), med: srt[srt.length >> 1],
    win: (100 * pts.filter((x) => x > 0).length) / pts.length,
    bailed: (100 * bailed) / pts.length,
    h1: avg(h1), h2: avg(h2),
    n26: y26.length, y26: avg(y26),
  };
}

const row = (lab, s) => "  " + lab.padEnd(26) + s.n.toLocaleString().padStart(8) +
  s.pts.toFixed(2).padStart(9) + s.med.toFixed(2).padStart(9) +
  s.win.toFixed(1).padStart(7) +
  (s.h1.toFixed(2) + " / " + s.h2.toFixed(2)).padStart(17) +
  (s.n26 > 200 ? s.y26.toFixed(2).padStart(9) : "       --");

const HEAD = "  rule                        trades  avg pts   median   win%    1st / 2nd half     2026";

for (const [name, over] of [["prox 0.25", { trigger: "prox", shrinkBars: 3, prox: 0.25 }],
                            ["prox 0.075", { trigger: "prox", shrinkBars: 3, prox: 0.075 }]]) {
  const E = buildEntries(over);
  console.log("");
  console.log("=".repeat(96));
  console.log("ANTICIPATION " + name + " -- 5-min bars, exit at the next opposite cross unless bailed");
  console.log("=".repeat(96));

  // ── 1. are the two survivors the same fact? ──────────────────────────
  const both = E.filter((e) => isNight(e.sig) && lowAdr(e.sig)).length;
  const nite = E.filter((e) => isNight(e.sig)).length;
  const ladr = E.filter((e) => lowAdr(e.sig)).length;
  console.log("");
  console.log("  overlap:  overnight " + nite.toLocaleString() +
    "   ADR-used<0.5 " + ladr.toLocaleString() +
    "   both " + both.toLocaleString());
  console.log("            " + (100 * both / ladr).toFixed(0) +
    "% of the low-ADR trades are overnight, " +
    (100 * both / nite).toFixed(0) + "% of the overnight trades are low-ADR");

  console.log("");
  console.log(HEAD);
  console.log("  " + "-".repeat(84));
  console.log(row("ungated", score(E)));
  console.log(row("overnight only", score(E.filter((e) => isNight(e.sig)))));
  console.log(row("ADR used < 0.5", score(E.filter((e) => lowAdr(e.sig)))));
  console.log(row("both", score(E.filter((e) => isNight(e.sig) && lowAdr(e.sig)))));
  console.log(row("low ADR, RTH only", score(E.filter((e) => lowAdr(e.sig) && !isNight(e.sig)))));
  console.log(row("overnight, ADR >= 0.5",
    score(E.filter((e) => isNight(e.sig) && Number.isFinite(adrUsed[e.sig]) && adrUsed[e.sig] >= 0.5))));

  // ── 2. the bail-out, which needs no predictor ────────────────────────
  console.log("");
  console.log("  abandon the trade if the cross has not arrived within N bars:");
  console.log(HEAD + "   bailed");
  console.log("  " + "-".repeat(94));
  for (const b of [3, 5, 8, 10, 12, 15, 20, Infinity]) {
    const s = score(E, b);
    const lab = b === Infinity ? "no bail (hold it out)" : "bail after " + b + " bars";
    console.log(row(lab, s) + s.bailed.toFixed(0).padStart(8) + "%");
  }

  console.log("");
  console.log("  bail-out combined with the gate that survived:");
  console.log(HEAD + "   bailed");
  console.log("  " + "-".repeat(94));
  const G = E.filter((e) => lowAdr(e.sig));
  for (const b of [8, 10, 12, 15, Infinity]) {
    const s = score(G, b);
    const lab = b === Infinity ? "ADR<0.5, no bail" : "ADR<0.5, bail " + b;
    console.log(row(lab, s) + s.bailed.toFixed(0).padStart(8) + "%");
  }
}

console.log("");
console.log("  Net of commission at 8 lots, subtract 0.75 pts from every gross figure.");
console.log("");
