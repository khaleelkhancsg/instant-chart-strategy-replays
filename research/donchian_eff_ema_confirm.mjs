// Confirming (or killing) the one candidate from research/donchian_eff_ema.mjs.
//
// The candidate: keep every efficiency >= 0.5 Donchian signal as shipped, and
// RESCUE signals with 0.45 <= efficiency < 0.5 when the 5-minute EMA 50 is on
// the breakout's side of the 5-minute EMA 200 -- a borderline breakout that
// goes WITH the higher-timeframe trend. It scored 37.92% pass against the
// shipped 34.53% and beat rescuing the same number of signals at random
// (z +2.6). But it was the best of ~120 combinations, and picking on the first
// half and reading the second chose a different one that gained only +0.7pp.
//
// Hypothesis, fixed before running this: the slow trend carries information the
// 60-minute breakout does not. If that is TRUE:
//
//   1. the neighbourhood works -- nearby EMA lengths and thresholds, not only
//      exactly 50/200 at exactly 0.45
//   2. the same TIME HORIZON works on other bars -- 1-minute EMA 250/1000 and
//      2-minute EMA 125/500 span the same hours as 5-minute 50/200
//   3. it helps the combined bot, Donchian plus ORB, which is what is live
//   4. it is not one good year
//
// If it is a lucky pick, (1) and (2) show a lone spike and (3) does nothing.
//
//   node research/donchian_eff_ema_confirm.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { ema, adx, donchian } from "../src/indicators.mjs";
import { run, passOf, days, H1, H2, RECENT, yearOf } from "./lib_shipped.mjs";
import * as J from "./joint_account.mjs";

const { bars } = loadBars();
const tf = resample(bars, 2), tf5 = resample(bars, 5);
const n1 = bars.close.length, n2 = tf.close.length, n5 = tf5.close.length;

const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(n2);
for (let i = 30; i < n2; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const ctx = buildFilterContext(tf);
const gated = (x) => applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: x });
const G05 = gated(0.5);

const known5 = new Int32Array(n1).fill(-1);
{
  let k = 0, cur = -1;
  for (let i = 0; i < n1; i++) {
    while (k < n5 && tf5.srcLast[k] <= i) { cur = k; k++; }
    known5[i] = cur;
  }
}
// A slow-trend reader: EMA fast vs slow on a given bar size, read causally at
// the 2-minute signal bar k.
const cache = new Map();
function trend(barMin, fast, slow) {
  const key = barMin + ":" + fast + ":" + slow;
  if (cache.has(key)) return cache.get(key);
  const C = barMin === 1 ? bars.close : barMin === 2 ? tf.close : tf5.close;
  const ef = ema(C, fast), es = ema(C, slow);
  const at = barMin === 1 ? (k) => tf.srcLast[k] : barMin === 2 ? (k) => k : (k) => known5[tf.srcLast[k]];
  const fn = (k) => { const j = at(k); if (j < 0) return NaN; const d = ef[j] - es[j]; return Number.isFinite(d) ? Math.sign(d) : NaN; };
  cache.set(key, fn);
  return fn;
}
function rescue(x, fn) {
  const g = gated(x);
  const sig = Int8Array.from(G05);
  for (let k = 0; k < n2; k++) if (g[k] && !G05[k] && fn(k) === raw[k]) sig[k] = g[k];
  return sig;
}
function score(sig) {
  const tr = run(() => 8, { signals: sig });
  return { tr, n: tr.length, pass: passOf(tr, days), h1: passOf(tr, H1), h2: passOf(tr, H2), rec: passOf(tr, RECENT),
           win: (100 * tr.filter((t) => t.pnl > 0).length) / tr.length };
}
const SHIP = score(G05);
const worst = (s) => Math.min(s.h1, s.h2);

console.log("");
console.log("=".repeat(104));
console.log("CONFIRMING THE SLOW-TREND RESCUE   shipped: pass " + SHIP.pass.toFixed(2) + "%  (H1 " + SHIP.h1.toFixed(2) +
            " / H2 " + SHIP.h2.toFixed(2) + ", worse half " + worst(SHIP).toFixed(2) + ")");
console.log("=".repeat(104));

// ── 1. the neighbourhood ─────────────────────────────────────────────────
const XS = [0.475, 0.45, 0.425, 0.4, 0.35];
const PAIRS = [[30, 120], [40, 160], [50, 200], [60, 240], [75, 300], [100, 400]];
for (const [title, pick] of [["pass rate, whole history", (s) => s.pass], ["pass rate in the WORSE half", worst]]) {
  console.log("");
  console.log("1. 5-minute EMA fast>slow rescue -- " + title + "   (shipped " + pick(SHIP).toFixed(2) + ")");
  console.log("");
  console.log("  5m EMA      " + XS.map((x) => ("eff>=" + x).padStart(11)).join(""));
  console.log("  " + "-".repeat(12 + 11 * XS.length));
  for (const [f, s] of PAIRS) {
    const fn = trend(5, f, s);
    console.log("  " + (f + "/" + s).padEnd(10) + XS.map((x) => pick(score(rescue(x, fn))).toFixed(2).padStart(11)).join(""));
  }
}

// ── 2. the same horizon on other bars ────────────────────────────────────
console.log("");
console.log("2. the same TIME HORIZON on other bar sizes, rescue at eff >= 0.45 and 0.40");
console.log("");
console.log("  trend                              hours       eff>=0.45: pass  worse half     eff>=0.40: pass  worse half");
console.log("  " + "-".repeat(104));
for (const [label, bm, f, s] of [["5-minute EMA 50/200", 5, 50, 200], ["2-minute EMA 125/500", 2, 125, 500],
                                 ["1-minute EMA 250/1000", 1, 250, 1000], ["1-minute EMA 50/200  (5x shorter)", 1, 50, 200],
                                 ["5-minute EMA 10/40    (5x shorter)", 5, 10, 40]]) {
  const fn = trend(bm, f, s);
  const a = score(rescue(0.45, fn)), b = score(rescue(0.40, fn));
  console.log("  " + label.padEnd(35) + ((f * bm / 60).toFixed(1) + "/" + (s * bm / 60).toFixed(1)).padStart(9) +
    a.pass.toFixed(2).padStart(18) + worst(a).toFixed(2).padStart(12) + b.pass.toFixed(2).padStart(19) + worst(b).toFixed(2).padStart(12));
}

// ── 3. the combined bot ──────────────────────────────────────────────────
console.log("");
console.log("3. the COMBINED bot, Donchian + ORB, as live (research/joint_account.mjs)");
console.log("");
const H = J.days.length >> 1;
function joint(sig) {
  const r = J.simulate("both", { exclusive: true, orbCfg: J.ORB_CFG, donLots: 8, donSig: sig });
  return { pass: J.pass21(r.arr), h1: J.pass21(r.arr.slice(0, H)), h2: J.pass21(r.arr.slice(H)),
           net: r.arr.reduce((a, b) => a + b, 0) };
}
console.log("  Donchian signal                           pass      H1      H2    worse half       net");
console.log("  " + "-".repeat(90));
const JS = joint(null);
console.log("  " + "shipped (eff >= 0.5)".padEnd(40) + JS.pass.toFixed(2).padStart(7) + JS.h1.toFixed(2).padStart(8) +
  JS.h2.toFixed(2).padStart(8) + Math.min(JS.h1, JS.h2).toFixed(2).padStart(13) + ("$" + Math.round(JS.net).toLocaleString()).padStart(11));
for (const [label, x, f, s] of [["rescue 5m 50/200, eff >= 0.45", 0.45, 50, 200], ["rescue 5m 50/200, eff >= 0.40", 0.40, 50, 200],
                                ["rescue 5m 40/160, eff >= 0.45", 0.45, 40, 160], ["rescue 5m 60/240, eff >= 0.45", 0.45, 60, 240],
                                ["loosen to eff >= 0.45, no EMA", 0.45, 0, 0]]) {
  const sig = f ? rescue(x, trend(5, f, s)) : gated(x);
  const r = joint(sig);
  console.log("  " + label.padEnd(40) + r.pass.toFixed(2).padStart(7) + r.h1.toFixed(2).padStart(8) + r.h2.toFixed(2).padStart(8) +
    Math.min(r.h1, r.h2).toFixed(2).padStart(13) + ("$" + Math.round(r.net).toLocaleString()).padStart(11));
}

// ── 4. year by year ──────────────────────────────────────────────────────
console.log("");
console.log("4. year by year, Donchian alone: shipped vs rescue 5m 50/200 at eff >= 0.45");
console.log("");
const CAND = score(rescue(0.45, trend(5, 50, 200)));
const years = [...new Set([...yearOf.values()])].sort();
console.log("  year     days   shipped   rescue   change");
console.log("  " + "-".repeat(44));
let up = 0;
for (const y of years) {
  const ds = days.filter((d) => yearOf.get(d) === y);
  if (ds.length < 60) continue;
  const a = passOf(SHIP.tr, ds), b = passOf(CAND.tr, ds);
  if (b > a) up++;
  console.log("  " + String(y).padEnd(6) + String(ds.length).padStart(6) + a.toFixed(2).padStart(10) + b.toFixed(2).padStart(9) +
    ((b - a >= 0 ? "+" : "") + (b - a).toFixed(2)).padStart(9));
}
console.log("");
console.log("  candidate overall: pass " + CAND.pass.toFixed(2) + "% (H1 " + CAND.h1.toFixed(2) + " / H2 " + CAND.h2.toFixed(2) +
            " / recent " + CAND.rec.toFixed(2) + "), win " + CAND.win.toFixed(1) + "%, " + CAND.n + " trades; better in " + up + " of " +
            years.filter((y) => days.filter((d) => yearOf.get(d) === y).length >= 60).length + " years");
console.log("");
