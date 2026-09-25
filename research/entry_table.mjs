// Every entry rule tested in this line of work, one table, ONE EXIT.
//
// The exit is identical for all of them: a long is closed at the next BEARISH
// crossover, a short at the next BULLISH one. Nothing else varies, so every
// difference in the table is attributable to entry timing and entry selection
// alone. An anticipated entry runs through the cross it predicted and on to the
// following opposite one; an anticipation that never develops is held until the
// histogram finally crosses and comes back, so it pays its cost in full.
//
// Gates are read at the SIGNAL bar and filled at the next open. The steepness
// threshold is an absolute 0.20 -- roughly the pooled median, stated as a fixed
// number rather than a percentile of the selected set, so it is a rule that
// could actually be run rather than one that needs its own answer to compute.
//
// These are overlapping, independently measured signals, not a tradeable
// sequence: no account could hold all of them at once, and the net dollar
// column is per-signal, not per-day.
//
//   node research/entry_table.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { resolveParams } from "../src/run.mjs";
import flip from "../strategies/macd_5m_flip.mjs";
import fade from "../strategies/macd_5m_fade.mjs";
import ant from "../strategies/macd_5m_anticipate.mjs";
import { adx, efficiencyRatio } from "../src/indicators.mjs";

const POINT = 2, LOTS = 8, COMM = 12;          // $/pt/contract, contracts, $ round trip

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

const SCALE_BARS = 200, SB = 3;
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
const steep = new Float64Array(n).fill(NaN);
for (let i = SB; i < n; i++) {
  const s = scale[i];
  if (!Number.isFinite(s) || s <= 0) continue;
  const a0 = Math.abs(hist[i]), a1 = Math.abs(hist[i - SB]);
  if (Number.isFinite(a0) && Number.isFinite(a1)) steep[i] = (a1 - a0) / SB / s;
}

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
const ADX = adx(H, L, C, 14).adx;
const EFF = efficiencyRatio(C, 20);

const STEEP_HI = 0.20;
const night = (i) => ctMin[i] < 510 || ctMin[i] >= 900;
const lowAdr = (i) => Number.isFinite(adrUsed[i]) && adrUsed[i] < 0.5;
const quiet = (i) => night(i) && lowAdr(i);

function entries(strategy, over, keep) {
  const p = { ...resolveParams(strategy), ...over };
  const sig = strategy.compute(tf, p).sig;
  const out = [];
  let last = 0;
  for (let i = 1; i < n - 2; i++) {
    const s = sig[i];
    if (s === 0) { last = 0; continue; }
    if (s === last) continue;
    last = s;
    if (keep && !keep(i)) continue;
    const j = s === 1 ? nextBear[i + 1] : nextBull[i + 1];
    if (j < 0 || j + 1 >= n) continue;
    out.push({ i: i + 1, dir: s, pts: (O[j + 1] - O[i + 1]) * s, hold: j + 1 - (i + 1) });
  }
  return out;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function stats(es) {
  if (es.length < 300) return null;
  const pts = es.map((e) => e.pts);
  const srt = pts.slice().sort((a, b) => a - b);
  const y26 = es.filter((e) => year[e.i] >= 2026).map((e) => e.pts);
  return {
    n: es.length, pts: avg(pts), med: srt[srt.length >> 1],
    win: (100 * pts.filter((x) => x > 0).length) / pts.length,
    hold: avg(es.map((e) => e.hold)),
    h1: avg(es.filter((e) => e.i < MIDI).map((e) => e.pts)),
    h2: avg(es.filter((e) => e.i >= MIDI).map((e) => e.pts)),
    n26: y26.length, y26: avg(y26),
  };
}

const HEAD =
  "  entry rule                     trades   avg pts    net $   median   win%  hold    1st / 2nd half     2026";
const SEP = "  " + "-".repeat(104);

function row(label, s, mark) {
  const net = s.pts * POINT * LOTS - COMM;
  return "  " + (mark || " ") + label.padEnd(30) + s.n.toLocaleString().padStart(7) +
    s.pts.toFixed(2).padStart(10) +
    (net >= 0 ? "+" : "") + net.toFixed(2).padStart(8) +
    s.med.toFixed(2).padStart(9) + s.win.toFixed(1).padStart(7) +
    s.hold.toFixed(0).padStart(6) +
    (s.h1.toFixed(2) + " / " + s.h2.toFixed(2)).padStart(18) +
    (s.n26 > 200 ? s.y26.toFixed(2).padStart(9) : "       --");
}

const OUT = [];
const add = (label, strategy, over, keep, mark) => {
  const s = stats(entries(strategy, over, keep));
  if (s) OUT.push(row(label, s, mark));
};
const section = (t) => OUT.push("", "  " + t, SEP);

const A25 = { trigger: "prox", shrinkBars: 3, prox: 0.25 };
const A075 = { trigger: "prox", shrinkBars: 3, prox: 0.075 };

console.log("");
console.log("=".repeat(108));
console.log("EVERY ENTRY RULE, ONE EXIT: the next opposite MACD crossover.  MNQ 5-min, " +
  LOTS + " lots, $" + COMM + " round trip");
console.log("=".repeat(108));
console.log("");
console.log(HEAD);

section("ENTER AT THE CROSS, OR WAIT FOR THE HISTOGRAM TO BUILD");
add("cross (the baseline)", flip, {}, null);
for (const b of [1, 2, 3, 4, 6]) add("cross + " + b + " growing bar" + (b > 1 ? "s" : ""), fade, { buildBars: b }, null);

section("ANTICIPATE THE CROSS, UNGATED");
for (const px of [0.5, 0.25, 0.1, 0.075, 0.05])
  add("anticipate prox " + px, ant, { trigger: "prox", shrinkBars: 3, prox: px }, null);
for (const N of [1, 2, 4]) add("anticipate prox 0.1, N=" + N, ant, { trigger: "prox", shrinkBars: N, prox: 0.1 }, null);
for (const e of [0.5, 1, 2]) add("anticipate eta <=" + e, ant, { trigger: "eta", shrinkBars: 3, etaBars: e }, null);

section("GATES THAT FAILED  (on anticipate prox 0.25)");
add("+ efficiency > 0.45", ant, A25, (i) => EFF[i] > 0.45);
add("+ ADX > 25", ant, A25, (i) => ADX[i] > 25);
add("+ RTH 08:30-15:00 only", ant, A25, (i) => !night(i));
add("+ ADR used >= 0.5", ant, A25, (i) => Number.isFinite(adrUsed[i]) && adrUsed[i] >= 0.5);
add("+ overnight, ADR used >= 0.5", ant, A25, (i) => night(i) && Number.isFinite(adrUsed[i]) && adrUsed[i] >= 0.5);
add("+ low ADR, RTH only", ant, A25, (i) => lowAdr(i) && !night(i));
add("+ steepness < 0.20", ant, A25, (i) => steep[i] < STEEP_HI);

section("GATES THAT SURVIVED  (on anticipate prox 0.25)");
add("+ ADX < 20", ant, A25, (i) => ADX[i] < 20);
add("+ overnight only", ant, A25, night);
add("+ ADR used < 0.5", ant, A25, lowAdr);
add("+ steepness > 0.20", ant, A25, (i) => steep[i] > STEEP_HI);
add("+ overnight AND ADR < 0.5", ant, A25, quiet);
add("+ that AND steepness > 0.20", ant, A25, (i) => quiet(i) && steep[i] > STEEP_HI, ">");

section("THE SAME STACK ON THE TIGHTER TRIGGER  (anticipate prox 0.075)");
add("anticipate prox 0.075", ant, A075, null);
add("+ overnight only", ant, A075, night);
add("+ ADR used < 0.5", ant, A075, lowAdr);
add("+ overnight AND ADR < 0.5", ant, A075, quiet);
add("+ that AND steepness > 0.20", ant, A075, (i) => quiet(i) && steep[i] > STEEP_HI, ">");

console.log(OUT.join("\n"));
console.log("");
console.log("  net $ is per signal at " + LOTS + " lots after the $" + COMM +
  " round trip.  > marks the two best stacks.");
console.log("  hold is in 5-min bars, so 20 is about a hundred minutes -- these are not scalps.");
console.log("  2026 is a partial year and was never used to select anything.");
console.log("  Overlapping independent signals, not a sequence an account could trade.");
console.log("");
