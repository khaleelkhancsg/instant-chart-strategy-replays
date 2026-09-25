// The gated anticipation entry, run against the fading-histogram exit.
//
// Entry is the one thing that replicated: anticipate the cross, but only
// overnight and only while the day has spent under half its average range.
// Exit is the lighter-shade rule -- leave after N consecutive bars closer to
// zero in the direction the trade is in.
//
// ── WHY N=3 MIGHT NOT TRANSFER ──────────────────────────────────────────
// fadeBars=3 was the win-rate peak measured on a CROSSOVER entry, which is in
// the market from the moment the histogram changes sign. An anticipation entry
// is in before that, on the far side of zero, so its hold profile is different
// and the number is re-swept here rather than assumed.
//
// ── HOW THE TWO RULES FIT TOGETHER ──────────────────────────────────────
// A long anticipating a bullish cross is entered while the histogram is still
// NEGATIVE and closing on zero. The fade exit for a long needs the histogram
// positive and shrinking, so it cannot fire until the anticipated cross has
// actually happened -- the trade waits for its cross, rides the positive
// histogram, then leaves when that fades. Nothing self-exits on the entry bar.
//
// When the anticipated cross never comes the fade can never fire, so the next
// OPPOSITE crossover stays as the backstop and the trade exits at whichever
// comes first. That keeps the false anticipations paying their full cost, the
// same as every measurement in this series.
//
//   node research/gated_fade_exit.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { resolveParams } from "../src/run.mjs";
import ant from "../strategies/macd_5m_anticipate.mjs";

const POINT = 2, LOTS = 8, COMM = 12;

const { bars } = loadBars();
const tf = resample(bars, 5);
const O = tf.open, H = tf.high, L = tf.low;
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
const quiet = (i) => (ctMin[i] < 510 || ctMin[i] >= 900) &&
  Number.isFinite(adrUsed[i]) && adrUsed[i] < 0.5;

// The fade-exit masks, byte-for-byte the rule in strategies/macd_5m_fade.mjs,
// then turned into next-occurrence tables so each lookup is O(1).
function fadeTables(need) {
  const up = new Uint8Array(n), dn = new Uint8Array(n);
  let upRun = 0, dnRun = 0;
  for (let i = 1; i < n; i++) {
    const v = hist[i], u = hist[i - 1];
    if (!Number.isFinite(v) || !Number.isFinite(u)) { upRun = dnRun = 0; continue; }
    const shrinking = Math.abs(v) < Math.abs(u);
    if (v >= 0) { upRun = shrinking ? upRun + 1 : 0; dnRun = 0; }
    else { dnRun = shrinking ? dnRun + 1 : 0; upRun = 0; }
    if (upRun >= need) up[i] = 1;
    if (dnRun >= need) dn[i] = 1;
  }
  const nextUp = new Int32Array(n).fill(-1), nextDn = new Int32Array(n).fill(-1);
  for (let i = n - 1; i >= 0; i--) {
    nextUp[i] = up[i] ? i : (i + 1 < n ? nextUp[i + 1] : -1);
    nextDn[i] = dn[i] ? i : (i + 1 < n ? nextDn[i + 1] : -1);
  }
  return { nextUp, nextDn };
}

function signals(over, keep) {
  const p = { ...resolveParams(ant), ...over };
  const sig = ant.compute(tf, p).sig;
  const out = [];
  let last = 0;
  for (let i = 1; i < n - 2; i++) {
    const s = sig[i];
    if (s === 0) { last = 0; continue; }
    if (s === last) continue;
    last = s;
    if (keep && !keep(i)) continue;
    out.push({ i: i + 1, dir: s });
  }
  return out;
}

// need = Infinity means no fade exit at all: hold to the opposite cross.
function run(sigs, need) {
  const T = Number.isFinite(need) ? fadeTables(need) : null;
  const es = [];
  for (const e of sigs) {
    const cross = e.dir === 1 ? nextBear[e.i] : nextBull[e.i];
    let fade = -1;
    if (T) {
      const t = e.dir === 1 ? T.nextUp : T.nextDn;
      fade = t[e.i];
    }
    // Whichever comes first; the cross is the backstop when the fade never fires.
    let j = cross, byFade = false;
    if (fade >= 0 && (cross < 0 || fade < cross)) { j = fade; byFade = true; }
    if (j < 0 || j + 1 >= n) continue;
    es.push({
      i: e.i, pts: (O[j + 1] - O[e.i]) * e.dir, hold: j + 1 - e.i, byFade,
    });
  }
  return es;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function stats(es) {
  const pts = es.map((e) => e.pts);
  const srt = pts.slice().sort((a, b) => a - b);
  const y26 = es.filter((e) => year[e.i] >= 2026).map((e) => e.pts);
  const wins = pts.filter((x) => x > 0), losses = pts.filter((x) => x <= 0);
  return {
    n: es.length, pts: avg(pts), med: srt[srt.length >> 1],
    win: (100 * wins.length) / pts.length,
    aw: avg(wins), al: avg(losses),
    hold: avg(es.map((e) => e.hold)),
    byFade: (100 * es.filter((e) => e.byFade).length) / es.length,
    h1: avg(es.filter((e) => e.i < MIDI).map((e) => e.pts)),
    h2: avg(es.filter((e) => e.i >= MIDI).map((e) => e.pts)),
    n26: y26.length, y26: avg(y26),
  };
}

const HEAD = "  exit rule            trades  avg pts    net $  median  win%   avg W / avg L  hold  by fade     1st / 2nd half     2026";
const SEP = "  " + "-".repeat(122);
function row(lab, s, mark) {
  const net = s.pts * POINT * LOTS - COMM;
  return "  " + (mark || " ") + lab.padEnd(19) + s.n.toLocaleString().padStart(7) +
    s.pts.toFixed(2).padStart(9) + (net >= 0 ? "+" : "") + net.toFixed(2).padStart(8) +
    s.med.toFixed(2).padStart(8) + s.win.toFixed(1).padStart(6) +
    (s.aw.toFixed(1) + " / " + s.al.toFixed(1)).padStart(16) +
    s.hold.toFixed(0).padStart(6) + s.byFade.toFixed(0).padStart(7) + "%" +
    (s.h1.toFixed(2) + " / " + s.h2.toFixed(2)).padStart(19) +
    (s.n26 > 200 ? s.y26.toFixed(2).padStart(9) : "       --");
}

console.log("");
console.log("=".repeat(126));
console.log("GATED ANTICIPATION ENTRY x FADING-HISTOGRAM EXIT   MNQ 5-min, " +
  LOTS + " lots, $" + COMM + " round trip");
console.log("=".repeat(126));

for (const [name, over] of [["prox 0.075", { trigger: "prox", shrinkBars: 3, prox: 0.075 }],
                            ["prox 0.25", { trigger: "prox", shrinkBars: 3, prox: 0.25 }]]) {
  const gated = signals(over, quiet);
  const plain = signals(over, null);

  console.log("");
  console.log("ENTRY: anticipate " + name + " + overnight + ADR used < 0.5   (" +
    gated.length.toLocaleString() + " signals)");
  console.log("");
  console.log(HEAD);
  console.log(SEP);
  console.log(row("opposite cross", stats(run(gated, Infinity))));
  for (const need of [1, 2, 3, 4, 5, 6]) {
    const s = stats(run(gated, need));
    console.log(row("fade " + need + " bar" + (need > 1 ? "s" : ""), s, need === 3 ? ">" : " "));
  }
  console.log("");
  console.log("  for contrast, the SAME exits on the ungated entry (" +
    plain.length.toLocaleString() + " signals)");
  console.log(SEP);
  console.log(row("opposite cross", stats(run(plain, Infinity))));
  for (const need of [2, 3, 4]) console.log(row("fade " + need + " bars", stats(run(plain, need))));
}

console.log("");
console.log("  net $ is per signal after the round trip.  by fade = share exited by the fade");
console.log("  rather than by the backstop crossover.  avg W / avg L are in points.");
console.log("  Overlapping independent signals, not a sequence an account could trade.");
console.log("");
