// Does a $1000 or a $2000 platform stop pass MORE? Answered with enough power to
// actually tell.
//
// THE MEASUREMENT PROBLEM. Rolling 30-day windows over this data give ~87
// independent samples at best, ~13 on a regime slice and ~6 on 2026. The standard
// error on a pass rate is then 14-21 points, which is far larger than any
// difference the cap setting produces. Reading that column and concluding "no
// difference, keep $1000" is not a finding, it is the instrument being too blunt.
//
// THE FIX. Block-bootstrap the REAL daily P&L series. Each cap setting produces
// its own real sequence of daily results with the daily rules already applied;
// resampling that in blocks builds as many independent 30-day windows as wanted,
// and the account rules (target, trailing drawdown with the EOD ratchet and the
// breakeven lock, consistency) apply cleanly to daily numbers.
//
// Blocks of 5 sessions preserve short-run serial structure. This is still
// optimistic in ABSOLUTE terms versus contiguous windows, because resampling
// destroys longer-range structure — but both settings are biased the same way, so
// the COMPARISON is sound even where the level is not.
//
// Usage:  node research/cap_bootstrap.mjs [draws]

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { DAY } from "./lib_search.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = Number(process.argv[2]) || 20000;
const BLOCK = 5, WIN_DAYS = 21;      // 21 trading days ~ a 30-calendar-day window
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

// Daily P&L with the DAILY rules applied, exactly as challenge.mjs applies them.
function dailySeries(contracts, cap, fromMs = 0) {
  const x = resolveExec({ ...S.execDefaults, contracts, slAtrMult: 5, tpAtrMult: 1.75,
                          slippageTicks: 1, dayLossStopUsd: cap });
  const { trades } = runBrackets(tf, sig, A, x);
  const out = [];
  let day = null, dayPnl = 0;
  for (const t of trades) {
    if (t.entryTime < fromMs) continue;
    if (t.tday !== day) { if (day !== null) out.push(dayPnl); day = t.tday; dayPnl = 0; }
    if (R.dailyProfitStop > 0 && dayPnl >= R.dailyProfitStop) continue;   // soft block
    if (R.circuitBreaker > 0 && dayPnl <= -R.circuitBreaker) continue;    // breaker
    dayPnl += t.pnl;
  }
  if (day !== null) out.push(dayPnl);
  return { days: out, st: tradeStats(trades) };
}

// One synthetic evaluation from a sequence of daily results.
function evaluate(days) {
  let cum = 0, eodPeak = 0, locked = false, maxDay = -Infinity;
  for (const d of days) {
    cum += d;
    if (d > maxDay) maxDay = d;
    const floor = locked ? 0 : eodPeak - R.trailingDD;
    if (cum <= floor) return "FAIL";
    if (cum > eodPeak) eodPeak = cum;
    if (R.lockAtBreakeven && !locked && eodPeak >= R.trailingDD) locked = true;
    if (cum >= R.profitTarget && (!R.consistencyGatesPass || maxDay <= 0.5 * cum)) return "PASS";
  }
  return "OPEN";
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrap(days, draws, seed) {
  const rnd = mulberry32(seed);
  let pass = 0, fail = 0;
  const buf = new Array(WIN_DAYS);
  for (let k = 0; k < draws; k++) {
    let n = 0;
    while (n < WIN_DAYS) {
      const start = Math.floor(rnd() * Math.max(1, days.length - BLOCK));
      for (let j = 0; j < BLOCK && n < WIN_DAYS; j++) buf[n++] = days[(start + j) % days.length];
    }
    const o = evaluate(buf);
    if (o === "PASS") pass++; else if (o === "FAIL") fail++;
  }
  const p = (100 * pass) / draws;
  return { pass: p, fail: (100 * fail) / draws, se: 100 * Math.sqrt((p / 100) * (1 - p / 100) / draws) };
}

const Y26 = Date.UTC(2026, 0, 1);
const RECENT = bars.ts[bars.count - 1] - 365 * 86400000;

for (const [label, fromMs] of [["ALL HISTORY", 0], ["LAST 12 MONTHS", RECENT], ["2026 ONLY", Y26]]) {
  console.log(`\n  ${label}  —  ${DRAWS.toLocaleString()} bootstrapped evaluations per setting`);
  console.log("   lots  hard stop   sessions   $/day     PASS%  +/-2se     FAIL%    pf");
  for (const c of [7, 8]) {
    for (const cap of [1000, 1250, 1500, 1750, 2000, 0]) {
      const { days, st } = dailySeries(c, cap, fromMs);
      if (days.length < 60) continue;
      const b = bootstrap(days, DRAWS, 4242 + cap + c);
      const perDay = days.reduce((a, v) => a + v, 0) / days.length;
      console.log(`   ${String(c).padStart(4)}  ${(cap ? "$" + cap : "OFF").padStart(9)}   ${String(days.length).padStart(8)}  ` +
        `${((perDay >= 0 ? "+" : "") + "$" + perDay.toFixed(0)).padStart(7)}   ${b.pass.toFixed(1).padStart(5)}%  ` +
        `+/-${(2 * b.se).toFixed(2)}   ${b.fail.toFixed(1).padStart(5)}%  ${st.profitFactor.toFixed(3)}`);
    }
    console.log();
  }
}
console.log("  +/-2se is the 95% interval on the bootstrap itself. It does NOT cover the");
console.log("  uncertainty in the underlying daily distribution, which is the bigger unknown");
console.log("  on the 2026 slice (~138 sessions). Treat ordering as informative, levels less so.");
