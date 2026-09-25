// Does the HEIGHT of the histogram peak being faded predict anything?
//
// A new axis. Everything tested so far reads the histogram near zero -- its
// LEVEL at entry (prox), its closing RATE (steepness), whether that rate is
// speeding up (acceleration). Peak height is the amplitude of the push the trade
// is fading, measured from the last crossover to the current bar, and it is
// independent of all three: a histogram can close quickly from a small peak or
// crawl back from a huge one.
//
// Two readings, opposite signs, which is why it is worth measuring:
//
//   big peak is GOOD   a large excursion is stretched and has more to give back
//   big peak is BAD    a large excursion is a strong trend, and fading a strong
//                      trend is how the anticipation book loses its money
//
// ── THE TRAP THIS IS BUILT TO AVOID ─────────────────────────────────────
// Steepness looked like a finding and was not. It was scored with the median of
// the SELECTED subset as its threshold -- a number unavailable before selecting
// -- and when redone with a fixed absolute cut the two trigger configurations
// disagreed about the SIGN. So here: thresholds are absolute from the start,
// every cut is run on BOTH prox 0.075 and prox 0.25, and a result only counts if
// the two agree.
//
// Peak is normalised by the trailing mean |hist|, like every other histogram
// quantity in this project, because MNQ ran from 7,000 to 29,000 over the
// dataset and a raw peak is not comparable across it. Causal by construction:
// the running maximum only ever looks back to the last sign change.
//
//   node research/peak_height.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resample } from "../src/resample.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { sweepWindows } from "../src/challenge.mjs";
import ant from "../strategies/macd_5m_anticipate.mjs";

const POINT = 2, LOTS = 8, COMM = 12;

const { bars } = loadBars();
const strategies = await loadStrategies({ force: true });
const S = strategies.get("macd_5m_quiet_anticipate");
const EXEC = S.execDefaults || {}, RULES = S.rulesDefaults || {};
const T0 = bars.ts[0], T1 = bars.ts[bars.ts.length - 1];

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

// Trailing mean |hist|, the shared normaliser.
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

// PEAK: the running maximum |hist| since the last sign change, normalised.
// Resets on every crossover, so at any bar it describes the excursion currently
// in progress -- the one an anticipation entry is betting against.
function peakOf(h) {
  const out = new Float64Array(n).fill(NaN);
  let run = 0, sgn = 0;
  for (let i = 0; i < n; i++) {
    const v = h[i];
    if (!Number.isFinite(v)) { run = 0; continue; }
    const s = side(v);
    if (s !== sgn) { sgn = s; run = 0; }
    const a = Math.abs(v);
    if (a > run) run = a;
    if (Number.isFinite(scale[i]) && scale[i] > 0) out[i] = run / scale[i];
  }
  return out;
}
const peak = peakOf(hist);

// ── the quiet gate, matching the shipped strategy ───────────────────────
const ADR_DAYS = 14;
const adrUsed = new Float64Array(n).fill(NaN);
{
  const ranges = [];
  let dHi = -Infinity, dLo = Infinity, adr = NaN, cur = tday[0];
  for (let i = 0; i < n; i++) {
    if (tday[i] !== cur) {
      cur = tday[i];
      if (Number.isFinite(dHi - dLo)) {
        ranges.push(dHi - dLo);
        if (ranges.length > ADR_DAYS) ranges.shift();
        adr = ranges.length === ADR_DAYS ? ranges.reduce((a, b) => a + b, 0) / ADR_DAYS : NaN;
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

// ── signal study: controlled exit, so the statistics are clean ──────────
function signals(prox) {
  const p = { ...resolveParams(ant), trigger: "prox", shrinkBars: 3, prox };
  const sig = ant.compute(tf, p).sig;
  const out = [];
  let last = 0;
  for (let i = 1; i < n - 2; i++) {
    const s = sig[i];
    if (s === 0) { last = 0; continue; }
    if (s === last) continue;
    last = s;
    if (!quiet(i) || !Number.isFinite(peak[i])) continue;
    const j = s === 1 ? nextBear[i + 1] : nextBull[i + 1];
    if (j < 0 || j + 1 >= n) continue;
    out.push({ i: i + 1, pk: peak[i], pts: (O[j + 1] - O[i + 1]) * s });
  }
  return out;
}
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function st(es) {
  const pts = es.map((e) => e.pts);
  const y26 = es.filter((e) => year[e.i] >= 2026).map((e) => e.pts);
  return {
    n: es.length, pts: avg(pts),
    win: (100 * pts.filter((x) => x > 0).length) / pts.length,
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
function nullSd(all, k, draws = 400, seed = 555) {
  const rnd = mulberry32(seed), N = all.length;
  const idx = Int32Array.from(all.keys());
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

console.log("");
console.log("=".repeat(102));
console.log("HISTOGRAM PEAK HEIGHT -- amplitude of the push being faded, on the quiet-gated entry");
console.log("=".repeat(102));

const SETS = { "prox 0.075": signals(0.075), "prox 0.25": signals(0.25) };

console.log("");
console.log("PART 1 -- deciles of peak height, exit held at the next opposite cross");
for (const [name, E] of Object.entries(SETS)) {
  const B = st(E);
  const srt = E.map((e) => e.pk).sort((a, b) => a - b);
  const q = (p) => srt[Math.min(srt.length - 1, Math.floor((p / 100) * srt.length))];
  console.log("");
  console.log("  " + name + "   (" + E.length.toLocaleString() + " signals, ungated " +
    B.pts.toFixed(2) + " pts)");
  console.log("    peak band        trades   avg pts   win%      1st / 2nd half      2026");
  console.log("    " + "-".repeat(74));
  for (let d = 0; d < 10; d++) {
    const lo = q(d * 10), hi = d === 9 ? Infinity : q((d + 1) * 10);
    const g = E.filter((e) => e.pk >= lo && e.pk < hi);
    if (g.length < 150) continue;
    const s = st(g);
    console.log("    d" + String(d + 1).padEnd(3) + (lo.toFixed(2) + "-" +
      (hi === Infinity ? "max" : hi.toFixed(2))).padEnd(13) + s.n.toLocaleString().padStart(7) +
      s.pts.toFixed(2).padStart(10) + s.win.toFixed(1).padStart(7) +
      (s.h1.toFixed(2) + " / " + s.h2.toFixed(2)).padStart(20) +
      (s.n26 > 150 ? s.y26.toFixed(2).padStart(10) : "         -"));
  }
}

console.log("");
console.log("PART 2 -- ABSOLUTE thresholds, both configs, with a matched null");
console.log("");
console.log("  cut                prox 0.075                        prox 0.25              agree?");
console.log("                trades  avg pts    z   halves      trades  avg pts    z   halves");
console.log("  " + "-".repeat(96));
const CUTS = [];
for (const t of [1.0, 1.5, 2.0, 2.5, 3.0, 4.0]) CUTS.push(["peak > " + t.toFixed(1), (p) => p > t]);
for (const t of [1.0, 1.5, 2.0, 2.5]) CUTS.push(["peak < " + t.toFixed(1), (p) => p < t]);
CUTS.push(["peak 1.5-3.0", (p) => p >= 1.5 && p < 3.0]);
CUTS.push(["peak 2.0-4.0", (p) => p >= 2.0 && p < 4.0]);
const survivors = [];
for (const [lab, fn] of CUTS) {
  const cells = [];
  let signs = [];
  for (const [, E] of Object.entries(SETS)) {
    const B = st(E);
    const g = E.filter((e) => fn(e.pk));
    if (g.length < 300) { cells.push("     too few                    "); signs.push(0); continue; }
    const s = st(g);
    const z = (s.pts - B.pts) / nullSd(E, g.length);
    signs.push(Math.sign(s.pts - B.pts));
    cells.push(s.n.toLocaleString().padStart(7) + s.pts.toFixed(2).padStart(9) +
      ((z >= 0 ? "+" : "") + z.toFixed(1)).padStart(6) +
      (s.h1.toFixed(1) + "/" + s.h2.toFixed(1)).padStart(12));
  }
  const ok = signs[0] !== 0 && signs[0] === signs[1];
  if (ok && signs[0] > 0) survivors.push(lab);
  console.log("  " + lab.padEnd(15) + cells.join("  ") + (ok ? (signs[0] > 0 ? "   yes +" : "   yes -") : "   NO"));
}
console.log("");
console.log("  agree = both configurations move the same way. Steepness failed exactly here.");

// ── PART 3: through the engine, with pass rate ──────────────────────────
function variant(fn) {
  return {
    ...S,
    compute(b, p) {
      const out = S.compute(b, p);
      const h = out.overlays.find((o) => o.kind === "hist").data;
      const N = h.length;
      const sc = new Float64Array(N).fill(NaN);
      let sum = 0;
      for (let i = 0; i < N; i++) {
        const a = Math.abs(h[i]);
        if (Number.isFinite(a)) sum += a;
        if (i >= SCALE_BARS) sum -= Math.abs(h[i - SCALE_BARS]) || 0;
        if (i >= SCALE_BARS - 1) sc[i] = sum / SCALE_BARS;
      }
      const sig = Int8Array.from(out.sig);
      let run = 0, sgn = 0;
      for (let i = 0; i < N; i++) {
        const v = h[i];
        if (!Number.isFinite(v)) { run = 0; continue; }
        const s2 = v >= 0 ? 1 : -1;
        if (s2 !== sgn) { sgn = s2; run = 0; }
        const a = Math.abs(v);
        if (a > run) run = a;
        if (!fn) continue;                       // no peak filter: leave sig alone
        const pk = sc[i] > 0 ? run / sc[i] : NaN;
        if (sig[i] && !(Number.isFinite(pk) && fn(pk))) sig[i] = 0;
      }
      return { ...out, sig };
    },
  };
}
function engine(fn) {
  const p = resolveParams(S, {});
  const tr = runStrategy(bars, fn ? variant(fn) : S, p, EXEC).trades || [];
  if (!tr.length) return null;
  const pnl = tr.map((t) => t.pnl);
  let eq = 0, pk2 = 0, dd = 0;
  for (const v of pnl) { eq += v; if (eq > pk2) pk2 = eq; if (pk2 - eq > dd) dd = pk2 - eq; }
  const sw = sweepWindows(tr, T0, T1, RULES, 1);
  const pass = sw.passRate != null ? sw.passRate
    : (100 * sw.windows.filter((w) => w.outcome === "PASS").length) / sw.windows.length;
  const t0 = tr[0].entryTime, mid = t0 + (tr[tr.length - 1].entryTime - t0) / 2;
  return {
    n: tr.length, total: pnl.reduce((a, b) => a + b, 0), avg: avg(pnl),
    win: (100 * pnl.filter((x) => x > 0).length) / tr.length, dd, pass,
    h1: avg(tr.filter((t) => t.entryTime < mid).map((t) => t.pnl)),
    h2: avg(tr.filter((t) => t.entryTime >= mid).map((t) => t.pnl)),
  };
}
console.log("");
console.log("PART 3 -- through the real engine at the shipped defaults, with pass rate");
console.log("");
console.log("  cut                 trades     total $     avg $   win%     max DD   pass%    1st / 2nd half");
console.log("  " + "-".repeat(100));
const ENG = [["no peak filter", null]];
for (const t of [1.0, 1.5, 2.0, 2.5, 3.0]) ENG.push(["peak > " + t.toFixed(1), (p) => p > t]);
for (const t of [1.5, 2.0]) ENG.push(["peak < " + t.toFixed(1), (p) => p < t]);
ENG.push(["peak 1.5-3.0", (p) => p >= 1.5 && p < 3.0]);
for (const [lab, fn] of ENG) {
  const m = engine(fn);
  if (!m) { console.log("  " + lab.padEnd(20) + "  (no trades)"); continue; }
  console.log("  " + lab.padEnd(20) + String(m.n).padStart(7) +
    ("$" + Math.round(m.total).toLocaleString()).padStart(12) +
    ("$" + m.avg.toFixed(2)).padStart(10) + m.win.toFixed(1).padStart(7) +
    ("$" + Math.round(m.dd).toLocaleString()).padStart(11) +
    m.pass.toFixed(1).padStart(6) +
    ("$" + m.h1.toFixed(2) + " / $" + m.h2.toFixed(2)).padStart(20));
}
console.log("");
console.log("  Survived the sign-agreement test: " + (survivors.length ? survivors.join(", ") : "nothing"));

// ── PART 4: does the peak filter stack with the European band? ──────────
// Both were selected on this same data, so stacking them compounds the
// selection risk rather than confirming anything. It is run because the answer
// turns out to be instructive in the other direction.
function variant2(peakFn, hourFn) {
  const v = variant(peakFn);
  return {
    ...v,
    compute(b, p) {
      const out = v.compute(b, p);
      if (!hourFn || !b.ctMin) return out;
      const sig = Int8Array.from(out.sig);
      for (let i = 0; i < sig.length; i++) if (sig[i] && !hourFn(b.ctMin[i])) sig[i] = 0;
      return { ...out, sig };
    },
  };
}
function engine2(peakFn, hourFn) {
  const p = resolveParams(S, { sessionGate: hourFn ? "any" : "overnight" });
  const tr = runStrategy(bars, variant2(peakFn, hourFn), p, EXEC).trades || [];
  if (!tr.length) return null;
  const pnl = tr.map((t) => t.pnl);
  let eq = 0, pk2 = 0, dd = 0;
  for (const v of pnl) { eq += v; if (eq > pk2) pk2 = eq; if (pk2 - eq > dd) dd = pk2 - eq; }
  const sw = sweepWindows(tr, T0, T1, RULES, 1);
  const pass = sw.passRate != null ? sw.passRate
    : (100 * sw.windows.filter((w) => w.outcome === "PASS").length) / sw.windows.length;
  const t0 = tr[0].entryTime, mid = t0 + (tr[tr.length - 1].entryTime - t0) / 2;
  return {
    n: tr.length, total: pnl.reduce((a, b) => a + b, 0), avg: avg(pnl),
    win: (100 * pnl.filter((x) => x > 0).length) / tr.length, dd, pass,
    h1: avg(tr.filter((t) => t.entryTime < mid).map((t) => t.pnl)),
    h2: avg(tr.filter((t) => t.entryTime >= mid).map((t) => t.pnl)),
  };
}
const EU = (c) => c >= 0 && c < 480;
console.log("");
console.log("PART 4 -- stacked with the European band, where per-trade quality and pass rate split");
console.log("");
console.log("  stack                 trades     total $     avg $   win%     max DD   pass%    1st / 2nd half");
console.log("  " + "-".repeat(100));
for (const [lab, pf, hf] of [["shipped default", null, null],
                             ["peak < 1.5", (p) => p < 1.5, null],
                             ["Europe 00:00-08:00", null, EU],
                             ["peak < 1.5 + Europe", (p) => p < 1.5, EU],
                             ["peak < 2.0 + Europe", (p) => p < 2.0, EU]]) {
  const m = engine2(pf, hf);
  if (!m) { console.log("  " + lab.padEnd(22) + "  (no trades)"); continue; }
  console.log("  " + lab.padEnd(22) + String(m.n).padStart(7) +
    ("$" + Math.round(m.total).toLocaleString()).padStart(12) +
    ("$" + m.avg.toFixed(2)).padStart(10) + m.win.toFixed(1).padStart(7) +
    ("$" + Math.round(m.dd).toLocaleString()).padStart(11) +
    m.pass.toFixed(1).padStart(6) +
    ("$" + m.h1.toFixed(2) + " / $" + m.h2.toFixed(2)).padStart(20));
}
console.log("");
console.log("  Every per-trade measure improves down that list and the pass rate does not,");
console.log("  because a 30-day window still has to reach $3,000 and the trade count is falling.");
console.log("");
