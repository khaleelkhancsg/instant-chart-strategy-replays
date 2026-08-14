// Bootstrapped pass rate for the shipped configuration — and an honest measure of
// how much the bootstrap flatters it.
//
// A block bootstrap resamples stretches of real trading days to build as many
// synthetic 30-day evaluations as wanted, which buys the statistical power that
// ~87 overlapping real windows cannot. The cost is that it destroys structure
// longer than the block: a real losing month arrives as one continuous run, while
// a bootstrap chops it into pieces and scatters them across draws, so a genuinely
// bad stretch rarely lands intact inside one synthetic window.
//
// That bias is measurable rather than assumed. As the block grows the bootstrap
// must converge on the true contiguous-window sweep, because at block = 21 a draw
// IS a contiguous window. Sweeping block size from 1 day to 21 therefore prices
// the optimism directly, and the real sweep is printed alongside as the anchor.
//
// Usage:  node research/bootstrap_headline.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules, replayWindow, OUTCOME } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { windowStarts } from "./lib_search.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 50000, WIN = 21;
const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const S = (await loadStrategies()).get("donchian_eff_rth");
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(tf.close.length);
for (let i = 30; i < raw.length; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });
const X = resolveExec({ ...S.execDefaults, contracts: 8, slAtrMult: 5, tpAtrMult: 1.75,
  slippageTicks: 1, dayLossStopUsd: 1000, dayLossStopMode: "exact" });
const { trades } = runBrackets(tf, sig, A, X);

const END = bars.ts[bars.count - 1];
const SETS = [
  ["ALL HISTORY", 0],
  ["LAST 12 MONTHS", END - 365 * 86400000],
  ["2026 ONLY", Date.UTC(2026, 0, 1)],
];

function dailySeries(fromMs) {
  const sel = trades.filter((t) => t.entryTime >= fromMs);
  const days = [];
  let day = null, p = 0;
  for (const t of sel) {
    if (t.tday !== day) { if (day !== null) days.push(p); day = t.tday; p = 0; }
    if (p >= R.dailyProfitStop || p <= -R.circuitBreaker) continue;
    p += t.pnl;
  }
  if (day !== null) days.push(p);
  return { days, st: tradeStats(sel) };
}
// returns 1 pass, -1 fail, 0 unresolved, plus days used
function evaluate(d) {
  let cum = 0, peak = 0, lk = false, md = -1e18;
  for (let i = 0; i < d.length; i++) {
    cum += d[i]; if (d[i] > md) md = d[i];
    const fl = lk ? 0 : peak - R.trailingDD;
    if (cum <= fl) return { o: -1, n: i + 1 };
    if (cum > peak) peak = cum;
    if (R.lockAtBreakeven && !lk && peak >= R.trailingDD) lk = true;
    if (cum >= R.profitTarget && md <= 0.5 * cum) return { o: 1, n: i + 1 };
  }
  return { o: 0, n: d.length };
}
function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function boot(days, block, seed) {
  const rnd = mul(seed), idx = new Array(WIN), n = days.length;
  let pass = 0, fail = 0, open = 0;
  const dtp = [];
  for (let k = 0; k < DRAWS; k++) {
    let m = 0;
    while (m < WIN) {
      const st = Math.floor(rnd() * Math.max(1, n - block));
      for (let j = 0; j < block && m < WIN; j++) idx[m++] = days[(st + j) % n];
    }
    const r = evaluate(idx);
    if (r.o === 1) { pass++; dtp.push(r.n); } else if (r.o === -1) fail++; else open++;
  }
  dtp.sort((a, b) => a - b);
  const p = (100 * pass) / DRAWS;
  return { pass: p, fail: (100 * fail) / DRAWS, open: (100 * open) / DRAWS,
           se: 100 * Math.sqrt((p / 100) * (1 - p / 100) / DRAWS),
           median: dtp.length ? dtp[dtp.length >> 1] : null };
}

// the anchor: real contiguous windows, no resampling
function realSweep(fromMs) {
  const starts = windowStarts(bars, 30, 1).filter((s) => s >= fromMs);
  let pass = 0, fail = 0;
  for (const s of starts) {
    const w = replayWindow(trades, s, R);
    if (w.outcome === OUTCOME.PASS) pass++; else if (w.outcome === OUTCOME.FAIL) fail++;
  }
  return { pass: (100 * pass) / starts.length, fail: (100 * fail) / starts.length,
           n: starts.length, indep: Math.round(starts.length / 30) };
}

console.log(`\n  SHIPPED CONFIG — MNQ, 8 lots, Donchian-30 / ADX 25 / efficiency 0.5, RTH,`);
console.log(`  5xATR stop / 1.75xATR target, hard -$1000 cap (exact), breaker -$500, block $750, 1 tick.\n`);

for (const [lbl, from] of SETS) {
  const { days, st } = dailySeries(from);
  const real = realSweep(from);
  console.log(`  ${lbl}  —  ${days.length} sessions, ${st.n} trades, pf ${st.profitFactor.toFixed(3)}, $${st.expectancy.toFixed(2)}/trade`);
  console.log(`   block   PASS%   +/-2se    FAIL%   unresolved   median days to pass`);
  for (const b of [1, 3, 5, 10, 21]) {
    const r = boot(days, b, 4242 + b);
    console.log(`   ${String(b).padStart(5)}   ${r.pass.toFixed(1).padStart(5)}%  +/-${(2 * r.se).toFixed(2)}   ` +
      `${r.fail.toFixed(1).padStart(5)}%   ${r.open.toFixed(1).padStart(9)}%   ${String(r.median ?? "-").padStart(18)}`);
  }
  console.log(`   REAL    ${real.pass.toFixed(1).padStart(5)}%   (contiguous, ${real.n} overlapping windows = ~${real.indep} independent)`);
  const b5 = boot(days, 5, 999);
  console.log(`   -> block-5 bootstrap reads ${(b5.pass - real.pass >= 0 ? "+" : "")}${(b5.pass - real.pass).toFixed(1)}pp against the real sweep\n`);
}

// what the headline number is worth over repeated attempts
const { days } = dailySeries(END - 365 * 86400000);
const r = boot(days, 21, 7);
console.log(`  MULTIPLE ATTEMPTS at the block-21 (least optimistic) 12-month rate of ${r.pass.toFixed(1)}%`);
const q = r.pass / 100;
for (const n of [1, 2, 3, 5]) {
  console.log(`    ${n} attempt${n > 1 ? "s" : " "}   ${(100 * (1 - (1 - q) ** n)).toFixed(1)}% chance of at least one pass`);
}
