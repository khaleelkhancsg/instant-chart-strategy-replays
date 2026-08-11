// Size the book for the CURRENT regime rather than the 8-year average.
//
// Every sizing conclusion in this project so far was measured across all 2,598
// windows, which spans 2019 at a median 2-min ATR of 4.8 and 2026 at 23.7. That
// average is not a market anyone trades. It also hides the one effect the Monte
// Carlo predicted: a stop-out costs slAtrMult * ATR * $2 * lots, so whether it
// fits inside the $2,000 trailing drawdown -- and inside a hard -$1000 cap --
// depends entirely on volatility. At ATR 13.56 a 10-lot 5xATR stop is $1,356 and
// fits; at 23.7 it is $2,370 and does not.
//
// TWO WAYS TO SELECT THE REGIME, because the obvious one is nearly useless on its
// own. 2026 holds ~165 rolling 30-day windows but only about SIX non-overlapping
// ones, so a 2026-only pass rate carries enormous uncertainty however many
// windows are printed. Conditioning on measured volatility instead selects the
// same market from the whole history and gives a usable sample.
//
// Usage:  node research/regime_sizing.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts, DAY } from "./lib_search.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const CAP = 1000;          // the non-negotiable hard unrealised stop
const TICKS = 1;

const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const S = (await loadStrategies()).get("donchian_eff_rth");

function signal(period, adxMin) {
  const { high: dh, low: dl } = donchian(tf.high, tf.low, period);
  const s = new Int8Array(tf.close.length);
  for (let i = period; i < s.length; i++) {
    if (ax[i] < adxMin) continue;
    if (tf.close[i] > dh[i]) s[i] = 1;
    else if (tf.close[i] < dl[i]) s[i] = -1;
  }
  return applyFilters(s, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
}

// ── classify each window by the volatility actually inside it ────────
const allStarts = windowStarts(bars, 30, 1);
const winAtr = new Map();
{
  // Median RTH ATR per trading day, then per window.
  const dayAtr = new Map();
  for (let i = 900; i < A.length; i++) {
    const c = tf.ctMin[i];
    if (c < 510 || c >= 900 || !(A[i] > 0)) continue;
    const d = Math.floor(tf.ts[i] / DAY);
    if (!dayAtr.has(d)) dayAtr.set(d, []);
    dayAtr.get(d).push(A[i]);
  }
  const med = (v) => { v.sort((a, b) => a - b); return v[v.length >> 1]; };
  const perDay = new Map([...dayAtr].map(([d, v]) => [d, med(v)]));
  for (const s of allStarts) {
    const d0 = Math.floor(s / DAY), d1 = d0 + 30;
    const v = [];
    for (let d = d0; d < d1; d++) if (perDay.has(d)) v.push(perDay.get(d));
    if (v.length >= 15) winAtr.set(s, med(v));
  }
}
const withAtr = allStarts.filter((s) => winAtr.has(s));
const sortedAtr = withAtr.map((s) => winAtr.get(s)).sort((a, b) => a - b);
const qAtr = (p) => sortedAtr[Math.floor(sortedAtr.length * p)];
const HI_CUT = qAtr(0.70);

const SETS = {
  all: withAtr,
  "2026 only": withAtr.filter((s) => new Date(s).getUTCFullYear() === 2026),
  [`high vol (ATR>${HI_CUT.toFixed(1)})`]: withAtr.filter((s) => winAtr.get(s) > HI_CUT),
};

console.log(`\n  Window volatility (median 2-min RTH ATR inside each 30-day window)`);
console.log(`    p10 ${qAtr(0.1).toFixed(1)}   median ${qAtr(0.5).toFixed(1)}   p70 ${HI_CUT.toFixed(1)}   p90 ${qAtr(0.9).toFixed(1)}`);
for (const [k, v] of Object.entries(SETS)) {
  const a = v.map((s) => winAtr.get(s));
  const mid = a.slice().sort((x, y) => x - y)[a.length >> 1];
  console.log(`    ${k.padEnd(22)} ${String(v.length).padStart(5)} windows, median ATR ${mid.toFixed(1)}, ~${Math.max(1, Math.round(v.length / 30))} independent`);
}

const rules = resolveRules({ circuitBreaker: 750, dailyProfitStop: 750 });

function run(contracts, sl, tp, sig) {
  const x = resolveExec({
    ...S.execDefaults, contracts, slAtrMult: sl, tpAtrMult: tp, tpMode: "atr",
    slippageTicks: TICKS, dayLossStopUsd: CAP,
  });
  const { trades } = runBrackets(tf, sig, A, x);
  const T = flatten(trades);
  const st = tradeStats(trades);
  const out = { st, capPct: (100 * trades.filter((t) => t.reason === "DAYLOSS").length) / st.n };
  for (const [k, v] of Object.entries(SETS)) out[k] = fastSweep(T, v, rules, 1).pass;
  return out;
}

// ── size sweep, per regime ───────────────────────────────────────────
const sig30 = signal(30, 25);
console.log(`\n\n  SIZE, with the hard -$${CAP} cap on. Geometry 3.5xATR / 2.0xATR.\n`);
console.log("  lots  cap allows   1 stop @ATR23.7      all    2026   highvol    pf      net$");
for (const c of [2, 3, 4, 5, 6, 8, 10]) {
  const r = run(c, 3.5, 2.0, sig30);
  const allow = CAP / (2 * c);
  const stop237 = 3.5 * 23.7 * 2 * c;
  console.log(
    `  ${String(c).padStart(4)}  ${(allow.toFixed(0) + " pts").padStart(10)}   ${("$" + Math.round(stop237)).padStart(8)}` +
    `${stop237 > CAP ? " capped" : "  fits "}   ${r.all.toFixed(1).padStart(5)}%  ${r["2026 only"].toFixed(1).padStart(5)}%  ` +
    `${r[`high vol (ATR>${HI_CUT.toFixed(1)})`].toFixed(1).padStart(5)}%  ${r.st.profitFactor.toFixed(3)}  ${("$" + Math.round(r.st.pnl).toLocaleString()).padStart(9)}`
  );
}

// At smaller size the cap stops binding, so the SHIPPED wide geometry becomes
// available again — the whole reason 10 lots needed a tightened bracket.
console.log(`\n  Same sweep at the SHIPPED 5xATR / 1.5xATR geometry, which only fits at small size:\n`);
console.log("  lots  cap allows   1 stop @ATR23.7      all    2026   highvol    pf      net$   cap%");
for (const c of [2, 3, 4, 5, 6, 8, 10]) {
  const r = run(c, 5, 1.5, sig30);
  const allow = CAP / (2 * c);
  const stop237 = 5 * 23.7 * 2 * c;
  console.log(
    `  ${String(c).padStart(4)}  ${(allow.toFixed(0) + " pts").padStart(10)}   ${("$" + Math.round(stop237)).padStart(8)}` +
    `${stop237 > CAP ? " capped" : "  fits "}   ${r.all.toFixed(1).padStart(5)}%  ${r["2026 only"].toFixed(1).padStart(5)}%  ` +
    `${r[`high vol (ATR>${HI_CUT.toFixed(1)})`].toFixed(1).padStart(5)}%  ${r.st.profitFactor.toFixed(3)}  ${("$" + Math.round(r.st.pnl).toLocaleString()).padStart(9)}  ${r.capPct.toFixed(0).padStart(3)}%`
  );
}

// ── best geometry x size for the high-vol regime ─────────────────────
console.log(`\n\n  GEOMETRY x SIZE ranked on the HIGH-VOLATILITY regime (the bigger, usable sample)\n`);
const grid = [];
for (const c of [3, 4, 5, 6, 8, 10]) {
  for (const sl of [3.5, 5, 7]) {
    for (const tp of [1.0, 1.5, 2.0, 2.5]) {
      const r = run(c, sl, tp, sig30);
      grid.push({ c, sl, tp, r });
    }
  }
}
const hiKey = `high vol (ATR>${HI_CUT.toFixed(1)})`;
grid.sort((a, b) => b.r[hiKey] - a.r[hiKey]);
console.log("  lots  sl/tp      highvol    2026     all      pf      net$");
for (const g of grid.slice(0, 12)) {
  console.log(
    `  ${String(g.c).padStart(4)}  ${g.sl}/${g.tp.toFixed(1)}   ${g.r[hiKey].toFixed(1).padStart(6)}%  ${g.r["2026 only"].toFixed(1).padStart(5)}%  ` +
    `${g.r.all.toFixed(1).padStart(5)}%  ${g.r.st.profitFactor.toFixed(3)}  ${("$" + Math.round(g.r.st.pnl).toLocaleString()).padStart(9)}`
  );
}
const b = grid[0];
console.log(`\n  BEST FOR THE CURRENT REGIME: ${b.c} lots, ${b.sl}xATR / ${b.tp}xATR`);
console.log(`    high-vol ${b.r[hiKey].toFixed(1)}%   2026 ${b.r["2026 only"].toFixed(1)}%   all-history ${b.r.all.toFixed(1)}%`);
console.log(`    pf ${b.r.st.profitFactor.toFixed(3)}  net $${Math.round(b.r.st.pnl).toLocaleString()}  worst loss $${Math.round(b.r.st.maxLoss).toLocaleString()}`);
