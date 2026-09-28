// Does the LIVE bot's slow trend match the one the backtest used?
//
// The backtest computes the 2-minute EMA 125/500 over seven years, so it is
// fully settled everywhere. The live bot computes it over whatever one fetch
// returns: about 2,500 two-minute bars, and never fewer than trend_min_bars_2m
// (1,500) or the rescue stands down. An EMA seeded that recently still carries
// a trace of its starting price, so on a few bars the trend DIRECTION could
// come out differently. This counts how often that happens on the only bars
// where it matters -- the rescue candidates -- over the whole history, and what
// it does to the pass rate.
//
//   node research/trend_rescue_live_fidelity.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { ema, adx, donchian } from "../src/indicators.mjs";
import { run, passOf, days, H1, H2 } from "./lib_shipped.mjs";

const FAST = 125, SLOW = 500, RESCUE = 0.45;
const { bars } = loadBars();
const tf = resample(bars, 2);
const n = tf.close.length, C = tf.close;

const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(n);
for (let i = 30; i < n; i++) {
  if (ax[i] < 25) continue;
  if (C[i] > dh[i]) raw[i] = 1; else if (C[i] < dl[i]) raw[i] = -1;
}
const ctx = buildFilterContext(tf);
const G05 = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const G045 = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: RESCUE });
const cands = [];
for (let k = 0; k < n; k++) if (G045[k] && !G05[k]) cands.push(k);

// Full-history trend, as the backtest has it.
const fF = ema(C, FAST), fS = ema(C, SLOW);
const full = (k) => Math.sign(fF[k] - fS[k]) || 0;

// The live bot's trend at bar k: both EMAs seeded W bars back, exactly like
// trend_series over one fetch (first-value seeded, alpha = 2/(span+1)).
function live(k, W) {
  const s = Math.max(0, k - W + 1);
  const a1 = 2 / (FAST + 1), a2 = 2 / (SLOW + 1);
  let e1 = C[s], e2 = C[s];
  for (let j = s + 1; j <= k; j++) { e1 = a1 * C[j] + (1 - a1) * e1; e2 = a2 * C[j] + (1 - a2) * e2; }
  return Math.sign(e1 - e2) || 0;
}

function rescueWith(trendAt) {
  const sig = Int8Array.from(G05);
  for (const k of cands) if (trendAt(k) === raw[k]) sig[k] = G045[k];
  return sig;
}
function score(sig) {
  const tr = run(() => 8, { signals: sig });
  return { n: tr.length, pass: passOf(tr, days), h1: passOf(tr, H1), h2: passOf(tr, H2) };
}

console.log("");
console.log("=".repeat(92));
console.log("THE LIVE BOT'S SLOW TREND vs THE BACKTEST'S   2-min EMA " + FAST + "/" + SLOW + ", rescue at eff >= " + RESCUE);
console.log("=".repeat(92));
console.log("");
console.log("  " + cands.length.toLocaleString() + " rescue candidates over the history (borderline efficiency, in session)");
console.log("");
console.log("  history the bot has     trend differs from backtest     rescued signals      pass     H1     H2");
console.log("  " + "-".repeat(90));
const base = score(rescueWith(full));
console.log("  " + "full (the backtest)".padEnd(24) + "-".padStart(18) + "".padStart(14) +
  String(rescueWith(full).filter((v, k) => v && !G05[k]).length).padStart(9) +
  base.pass.toFixed(2).padStart(13) + base.h1.toFixed(2).padStart(7) + base.h2.toFixed(2).padStart(7));
for (const W of [2500, 2000, 1500, 600]) {
  let differ = 0;
  for (const k of cands) if (live(k, W) !== full(k)) differ++;
  const sig = rescueWith((k) => live(k, W));
  const s = score(sig);
  const nRes = sig.filter((v, k) => v && !G05[k]).length;
  console.log("  " + (W.toLocaleString() + " bars" + (W === 2500 ? " (typical fetch)" : W === 1500 ? " (the floor)" : W === 600 ? " (old window)" : "")).padEnd(24) +
    (differ + " of " + cands.length.toLocaleString()).padStart(18) + ("(" + (100 * differ / cands.length).toFixed(2) + "%)").padStart(10) +
    String(nRes).padStart(13) + s.pass.toFixed(2).padStart(13) + s.h1.toFixed(2).padStart(7) + s.h2.toFixed(2).padStart(7));
}
console.log("");
console.log("  600 bars is what the other indicators use, and why the trend does not: shown for contrast.");
console.log("");
