// Can an EMA take over part of the efficiency gate's job?
//
// The efficiency gate (ratio >= 0.5 over 20 bars) is the strategy: it keeps
// about 9.5% of the raw Donchian breakouts, the clean directional ones. On
// THOSE signals a 1- or 5-minute EMA is redundant -- research/
// donchian_ma_filters.mjs found price on the trade's side of the 1m EMA 21 on
// 100% of them. But a looser efficiency gate lets in choppier breakouts, and
// that is where an EMA could actually tell good from bad. If it can, the book
// trades more often at similar quality, and more trades is the one thing that
// has ever moved pass rate in this project.
//
// Two ways to combine them, both applied as part of the SIGNAL (as the bot
// gates), so a rejected breakout neither arms nor flips an open position:
//
//   AND      efficiency >= X and the EMA agrees with the breakout
//   RESCUE   every efficiency >= 0.5 signal as shipped, PLUS the ones with
//            X <= efficiency < 0.5 where the EMA agrees -- it can only add
//
// On the bot's real entry model (research/lib_shipped.mjs). Shipped: 34.53%
// pass, 72.6% win. With this many combinations the best in-sample row will
// flatter itself, so the winner is also picked on the first half of the
// history and read on the second, and the rescues are scored against a matched
// null: adding the same number of borderline signals at random.
//
//   node research/donchian_eff_ema.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { ema, adx, donchian } from "../src/indicators.mjs";
import { run, passOf, days, H1, H2, RECENT, mul } from "./lib_shipped.mjs";

const { bars } = loadBars();
const tf = resample(bars, 2);
const tf5 = resample(bars, 5);
const n1 = bars.close.length, n2 = tf.close.length, n5 = tf5.close.length;

// Raw breakouts exactly as lib_shipped builds them, then the session and
// efficiency gate at any threshold.
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(n2);
for (let i = 30; i < n2; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const ctx = buildFilterContext(tf);
const gated = (x) => applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: x });

// EMA readings at the signal bar, causal: 1m at its last minute, 5m from the
// last 5-minute bar that had CLOSED.
const known5 = new Int32Array(n1).fill(-1);
{
  let k = 0, cur = -1;
  for (let i = 0; i < n1; i++) {
    while (k < n5 && tf5.srcLast[k] <= i) { cur = k; k++; }
    known5[i] = cur;
  }
}
const E1 = { 9: ema(bars.close, 9), 21: ema(bars.close, 21), 50: ema(bars.close, 50) };
const E5 = { 9: ema(tf5.close, 9), 21: ema(tf5.close, 21), 50: ema(tf5.close, 50), 200: ema(tf5.close, 200) };
const sgn = (x) => (Number.isFinite(x) ? Math.sign(x) : NaN);
const at1 = (k) => tf.srcLast[k], at5 = (k) => known5[tf.srcLast[k]];
const EMAS = [
  ["1m EMA 9>21", (k) => sgn(E1[9][at1(k)] - E1[21][at1(k)])],
  ["1m EMA 21>50", (k) => sgn(E1[21][at1(k)] - E1[50][at1(k)])],
  ["1m price>EMA50", (k) => sgn(tf.close[k] - E1[50][at1(k)])],
  ["5m EMA 9>21", (k) => { const j = at5(k); return j < 0 ? NaN : sgn(E5[9][j] - E5[21][j]); }],
  ["5m EMA 21>50", (k) => { const j = at5(k); return j < 0 ? NaN : sgn(E5[21][j] - E5[50][j]); }],
  ["5m EMA 50>200", (k) => { const j = at5(k); return j < 0 ? NaN : sgn(E5[50][j] - E5[200][j]); }],
  ["5m price>EMA21", (k) => { const j = at5(k); return j < 0 ? NaN : sgn(tf.close[k] - E5[21][j]); }],
  ["5m price>EMA50", (k) => { const j = at5(k); return j < 0 ? NaN : sgn(tf.close[k] - E5[50][j]); }],
];
const agrees = (fn, k) => { const v = fn(k); return Number.isFinite(v) && v === raw[k]; };

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = avg(a); return Math.sqrt(avg(a.map((x) => (x - m) ** 2))); };
function score(sig) {
  const tr = run(() => 8, { signals: sig });
  const p = tr.map((t) => t.pnl);
  return { tr, n: tr.length, win: (100 * p.filter((x) => x > 0).length) / p.length, avg: avg(p),
           pass: passOf(tr, days), h1: passOf(tr, H1), h2: passOf(tr, H2), rec: passOf(tr, RECENT) };
}
const count = (s) => { let c = 0; for (const v of s) if (v) c++; return c; };

const XS = [0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0];
const G = new Map(XS.map((x) => [x, gated(x)]));
const G05 = G.get(0.5);

// ── sanity: the rebuilt eff>=0.5 signal must reproduce the shipped baseline ─
const BASE = run(() => 8), SHIP = score(G05);
if (SHIP.n !== BASE.length || Math.abs(SHIP.pass - passOf(BASE, days)) > 1e-9) {
  console.error("rebuilt signal does not reproduce lib_shipped -- stopping"); process.exit(1);
}

console.log("");
console.log("=".repeat(116));
console.log("EFFICIENCY GATE x EMA CONFIRMATION   (the bot's real entry model, research/lib_shipped.mjs)");
console.log("=".repeat(116));
console.log("");
console.log("  shipped (efficiency >= 0.5, no EMA): " + SHIP.n.toLocaleString() + " trades, win " + SHIP.win.toFixed(1) +
            "%, $" + SHIP.avg.toFixed(2) + ", pass " + SHIP.pass.toFixed(2) + "%   (H1 " + SHIP.h1.toFixed(2) +
            " / H2 " + SHIP.h2.toFixed(2) + " / recent " + SHIP.rec.toFixed(2) + ")");

// ── A. the efficiency gate on its own ────────────────────────────────────
console.log("");
console.log("A. the efficiency threshold on its own -- what loosening it does");
console.log("");
console.log("  efficiency >=   signals   trades    win%     avg $     pass      H1      H2  recent");
console.log("  " + "-".repeat(86));
const PLAIN = new Map();
for (const x of XS) {
  const s = score(G.get(x));
  PLAIN.set(x, s);
  console.log("  " + (x === 0 ? "off" : x.toFixed(2)).padStart(14) + count(G.get(x)).toLocaleString().padStart(10) +
    String(s.n).padStart(9) + s.win.toFixed(1).padStart(8) + ("$" + s.avg.toFixed(2)).padStart(10) +
    s.pass.toFixed(2).padStart(9) + s.h1.toFixed(2).padStart(8) + s.h2.toFixed(2).padStart(8) + s.rec.toFixed(2).padStart(8));
}

// ── B. on the signals the looser gate lets in, does the EMA tell them apart? ─
console.log("");
console.log("B. the trades the looser gate ADDS (0.25 <= efficiency < 0.5), split by each EMA");
console.log("");
console.log("  EMA                   agrees   ---- agrees ----        ---- disagrees ----       difference");
console.log("                           %       n   win%    avg $       n   win%    avg $       $/trade      t");
console.log("  " + "-".repeat(100));
{
  const eff = ctx.eff;
  const band = PLAIN.get(0.25).tr.filter((t) => eff[t.sigBar] >= 0.25 && eff[t.sigBar] < 0.5);
  const w = (a) => (100 * a.filter((x) => x > 0).length) / a.length;
  for (const [name, fn] of EMAS) {
    const ag = [], dg = [];
    for (const t of band) (agrees(fn, t.sigBar) ? ag : dg).push(t.pnl);
    const tt = (avg(ag) - avg(dg)) / Math.sqrt(sd(ag) ** 2 / ag.length + sd(dg) ** 2 / dg.length);
    console.log("  " + name.padEnd(20) + (100 * ag.length / band.length).toFixed(1).padStart(8) +
      String(ag.length).padStart(8) + w(ag).toFixed(1).padStart(7) + ("$" + avg(ag).toFixed(2)).padStart(9) +
      String(dg.length).padStart(8) + w(dg).toFixed(1).padStart(7) + ("$" + avg(dg).toFixed(2)).padStart(9) +
      ((avg(ag) - avg(dg) >= 0 ? "+$" : "-$") + Math.abs(avg(ag) - avg(dg)).toFixed(2)).padStart(14) +
      tt.toFixed(2).padStart(7));
  }
  console.log("");
  console.log("  " + band.length.toLocaleString() + " added trades. Compare the whole band: win " + w(band.map((t) => t.pnl)).toFixed(1) +
              "%, $" + avg(band.map((t) => t.pnl)).toFixed(2) + " a trade, against the shipped book's " + SHIP.win.toFixed(1) +
              "% and $" + SHIP.avg.toFixed(2) + ".");
}

// ── C. every combination ─────────────────────────────────────────────────
const ALL = [];
function grid(structure) {
  console.log("");
  console.log("C" + (structure === "AND" ? "1" : "2") + ". " + (structure === "AND"
    ? "AND -- efficiency >= X and the EMA agrees.   Each cell: pass% / win%"
    : "RESCUE -- all efficiency >= 0.5 signals, plus X <= efficiency < 0.5 where the EMA agrees.   pass% / win%"));
  console.log("");
  const xs = structure === "AND" ? XS : XS.slice(1);
  console.log("  " + "EMA".padEnd(18) + xs.map((x) => ("eff>=" + (x === 0 ? "off" : x.toFixed(2))).padStart(13)).join(""));
  console.log("  " + "-".repeat(18 + 13 * xs.length));
  console.log("  " + "(no EMA)".padEnd(18) + xs.map((x) => { const s = PLAIN.get(x); return (s.pass.toFixed(1) + "/" + s.win.toFixed(1)).padStart(13); }).join(""));
  for (const [name, fn] of EMAS) {
    const cells = [];
    for (const x of xs) {
      const g = G.get(x);
      const sig = new Int8Array(n2);
      for (let k = 0; k < n2; k++) {
        if (!g[k]) continue;
        if (structure === "AND") { if (agrees(fn, k)) sig[k] = g[k]; }
        else if (G05[k] || agrees(fn, k)) sig[k] = g[k];
      }
      const s = score(sig);
      ALL.push({ label: structure + "  " + name + "  eff>=" + (x === 0 ? "off" : x.toFixed(2)), structure, name, fn, x, sig, s });
      cells.push((s.pass.toFixed(1) + "/" + s.win.toFixed(1)).padStart(13));
    }
    console.log("  " + name.padEnd(18) + cells.join(""));
  }
}
grid("AND");
grid("RESCUE");

// ── D. honest selection: pick on the first half, read on the second ──────
console.log("");
console.log("D. picked on the FIRST half, read on the SECOND   (shipped: H1 " + SHIP.h1.toFixed(2) + ", H2 " + SHIP.h2.toFixed(2) + ")");
console.log("");
console.log("  rank  combination                                  H1 (picked)   H2 (unseen)   all     win%   trades");
console.log("  " + "-".repeat(100));
const byH1 = ALL.slice().sort((a, b) => b.s.h1 - a.s.h1).slice(0, 5);
byH1.forEach((r, k) => console.log("  " + String(k + 1).padStart(4) + "  " + r.label.padEnd(44) + r.s.h1.toFixed(2).padStart(11) +
  r.s.h2.toFixed(2).padStart(14) + r.s.pass.toFixed(2).padStart(8) + r.s.win.toFixed(1).padStart(8) + String(r.s.n).padStart(9)));

// ── E. do the rescues beat adding the same number of signals at random? ───
console.log("");
console.log("E. the best RESCUES against a matched null: add the same share of the borderline band, at random");
console.log("");
console.log("  combination                                   added   pass    null (random add)      z      win%");
console.log("  " + "-".repeat(100));
const topR = ALL.filter((r) => r.structure === "RESCUE").sort((a, b) => b.s.pass - a.s.pass).slice(0, 5);
for (const r of topR) {
  const g = G.get(r.x);
  const band = [];
  for (let k = 0; k < n2; k++) if (g[k] && !G05[k]) band.push(k);
  const added = band.filter((k) => r.sig[k]).length;
  const f = added / band.length;
  const ps = [];
  for (let d = 0; d < 60; d++) {
    const rnd = mul(77 + d * 104729);
    const sig = Int8Array.from(G05);
    for (const k of band) if (rnd() < f) sig[k] = g[k];
    ps.push(score(sig).pass);
  }
  const z = (r.s.pass - avg(ps)) / sd(ps);
  console.log("  " + r.label.padEnd(44) + String(added).padStart(7) + r.s.pass.toFixed(2).padStart(8) +
    (avg(ps).toFixed(2) + " +/- " + sd(ps).toFixed(2)).padStart(22) + ((z >= 0 ? "+" : "") + z.toFixed(1)).padStart(7) +
    r.s.win.toFixed(1).padStart(9));
}
console.log("");
console.log("  Donchian ALONE. The live bot also runs the ORB; anything that survives here is a separate test there.");
console.log("");
