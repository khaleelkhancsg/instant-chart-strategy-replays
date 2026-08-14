// Would MES pass more often than MNQ?
//
// The instruments differ in two ways that pull against each other:
//   MNQ  $2 per index point, and a large ATR in points
//   MES  $5 per index point, and a much smaller ATR in points
// Whether MES is better is therefore not obvious from either fact alone — what
// matters is the DOLLAR size of a trade against a fixed $3,000 target and a
// $2,000 drawdown, and how that interacts with the platform's dollar cap.
//
// FAIRNESS. The MES cache ends 2026-03-23 and the MNQ cache runs to 2026-07-14,
// so every comparison here is truncated to the common span. Contract count is
// swept for both rather than assumed, because the right size is a function of the
// instrument's dollar volatility and MES will not want MNQ's number.
//
// Both books use the identical strategy, gates, rules and exact-liquidation cap.
// Ranking is on the worse of two time halves, as everywhere else in this project.
//
// Usage:  node research/mes_vs_mnq.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 40000, BLOCK = 5, WIN = 21;
const CAP = 1000, TICKS = 1;
const S = (await loadStrategies()).get("donchian_eff_rth");
const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });

function build(binPath, pointValue, label) {
  const { bars } = loadBars(binPath);
  const tf = resample(bars, 2);
  const ctx = buildFilterContext(tf);
  const A = atr(tf.high, tf.low, tf.close, 14);
  const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
  const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
  const raw = new Int8Array(tf.close.length);
  for (let i = 30; i < raw.length; i++) {
    if (ax[i] < 25) continue;
    if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
  }
  const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
  // RTH ATR medians, all-history and recent, for the mechanism
  const v = [], vr = [];
  const recentFrom = bars.ts[bars.count - 1] - 365 * 86400000;
  for (let i = 900; i < A.length; i++) {
    const c = tf.ctMin[i];
    if (c < 510 || c >= 900 || !(A[i] > 0)) continue;
    v.push(A[i]);
    if (tf.ts[i] >= recentFrom) vr.push(A[i]);
  }
  const med = (z) => { z.sort((a, b) => a - b); return z[z.length >> 1]; };
  return { label, bars, tf, A, sig, pointValue, atrMed: med(v), atrRecent: med(vr),
           lastMs: bars.ts[bars.count - 1], firstMs: bars.ts[0] };
}

const MNQ = build("data/mnq_1m.bin", 2.0, "MNQ");
const MES = build("data/mes_1m.bin", 5.0, "MES");
const COMMON_END = Math.min(MNQ.lastMs, MES.lastMs);
const COMMON_START = Math.max(MNQ.firstMs, MES.firstMs);
const RECENT = COMMON_END - 365 * 86400000;

console.log(`\n  common span ${new Date(COMMON_START).toISOString().slice(0, 10)} -> ${new Date(COMMON_END).toISOString().slice(0, 10)}`);
for (const M of [MNQ, MES]) {
  const dpp = M.pointValue;
  console.log(`  ${M.label}: $${dpp}/point.  2-min RTH ATR median ${M.atrMed.toFixed(2)} pts (last 12m ${M.atrRecent.toFixed(2)})`);
  console.log(`        one 5xATR stop at 8 lots = $${(5 * M.atrRecent * dpp * 8).toFixed(0)}   ` +
              `cap allows ${(CAP / (dpp * 8)).toFixed(1)} pts = ${(CAP / (dpp * 8) / M.atrRecent).toFixed(2)}xATR`);
}

function series(M, lots, fromMs, toMs) {
  const x = resolveExec({ ...S.execDefaults, contracts: lots, slAtrMult: 5, tpAtrMult: 1.75,
    pointValue: M.pointValue, slippageTicks: TICKS, dayLossStopUsd: CAP, dayLossStopMode: "exact" });
  const { trades } = runBrackets(M.tf, M.sig, M.A, x);
  const sel = trades.filter((t) => t.entryTime >= fromMs && t.entryTime <= toMs);
  const days = [];
  let day = null, p = 0;
  for (const t of sel) {
    if (t.tday !== day) { if (day !== null) days.push(p); day = t.tday; p = 0; }
    if (R.dailyProfitStop > 0 && p >= R.dailyProfitStop) continue;
    if (R.circuitBreaker > 0 && p <= -R.circuitBreaker) continue;
    p += t.pnl;
  }
  if (day !== null) days.push(p);
  return { days, st: tradeStats(sel) };
}
function ev(d) {
  let cum = 0, peak = 0, lk = false, md = -1e18;
  for (const v of d) {
    cum += v; if (v > md) md = v;
    const fl = lk ? 0 : peak - R.trailingDD;
    if (cum <= fl) return 0;
    if (cum > peak) peak = cum;
    if (R.lockAtBreakeven && !lk && peak >= R.trailingDD) lk = true;
    if (cum >= R.profitTarget && md <= 0.5 * cum) return 1;
  }
  return 0;
}
function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function passOf(days, seed) {
  const rnd = mul(seed), idx = new Array(WIN);
  const n = days.length;
  let w = 0;
  for (let k = 0; k < DRAWS; k++) {
    let m = 0;
    while (m < WIN) { const st = Math.floor(rnd() * Math.max(1, n - BLOCK));
      for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = days[(st + j) % n]; }
    w += ev(idx);
  }
  return (100 * w) / DRAWS;
}

for (const [lbl, from] of [["COMMON SPAN (2019-2026-03)", COMMON_START], ["LAST 12 MONTHS OF IT", RECENT]]) {
  console.log(`\n  ${lbl}  —  exact -$${CAP} cap, ${TICKS} tick, breaker -$500 / block $750`);
  console.log("   inst  lots   sessions  trades  win%   $/trade    pf     early   late   WORSE");
  for (const M of [MNQ, MES]) {
    for (const c of [4, 6, 8, 10, 14, 20]) {
      const { days, st } = series(M, c, from, COMMON_END);
      if (days.length < 60 || st.n < 200) continue;
      const half = Math.floor(days.length / 2);
      const e = passOf(days.slice(0, half), 11), l = passOf(days.slice(half), 22);
      console.log(`   ${M.label}  ${String(c).padStart(4)}   ${String(days.length).padStart(8)}  ${String(st.n).padStart(6)}  ` +
        `${st.winRate.toFixed(1).padStart(4)}  ${("$" + st.expectancy.toFixed(2)).padStart(8)}  ${st.profitFactor.toFixed(3)}  ` +
        `${e.toFixed(1).padStart(5)}% ${l.toFixed(1).padStart(5)}% ${Math.min(e, l).toFixed(1).padStart(6)}%`);
    }
    console.log();
  }
}
