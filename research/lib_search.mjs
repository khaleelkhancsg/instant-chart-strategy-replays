// Fast search primitives.
//
// Three optimisations make a six-figure search tractable, none of which change
// the answer:
//
//  1. SIGNALS ONCE PER (strategy, timeframe, params). Indicator maths does not
//     depend on stop/target, so it is computed once and reused across the whole
//     bracket grid.
//  2. CONTRACTS ARE A MULTIPLIER. Position size affects P&L and commission but
//     not which trades happen or when they exit, so one bracket run covers every
//     contract count — P&L is simply scaled at replay time. (Only true because
//     commission is per-contract; a flat fee would break this.)
//  3. FLAT TYPED ARRAYS. The rules replay runs millions of times, so trades are
//     flattened into numeric arrays and the inner loop touches no objects.
//
// `assertParity` checks the fast replay against the real replayWindow, because a
// fast path that quietly disagrees with the shipped engine is worse than no
// search at all.

import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec } from "../src/engine.mjs";
import { replayWindow, resolveRules, OUTCOME } from "../src/challenge.mjs";

export const DAY = 86400000;

// Flatten a trade list into parallel numeric arrays.
export function flatten(trades) {
  const n = trades.length;
  const T = {
    n,
    entry: new Float64Array(n),
    exit: new Float64Array(n),
    pnl: new Float64Array(n),
    mae: new Float64Array(n),
    tday: new Int32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const t = trades[i];
    T.entry[i] = t.entryTime;
    T.exit[i] = t.exitTime;
    T.pnl[i] = t.pnl;
    T.mae[i] = t.mae;
    T.tday[i] = t.tday;
  }
  return T;
}

function lowerBound(arr, n, v) {
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * One window, replayed numerically. Mirrors replayWindow's rules exactly.
 * `mult` scales P&L to a contract count without rebuilding the trade list.
 * Returns 1 = pass, -1 = fail, 0 = unresolved.
 */
export function fastWindow(T, startMs, R, mult) {
  const endMs = startMs + R.windowDays * DAY;
  const capPct = R.consistencyPct / 100;
  const eodTrail = R.trailingMode === "eod";
  // Intraday breach evaluation needs per-trade MFE ordering, which this flat path
  // deliberately does not carry. Callers must use realised evaluation.
  if (R.evaluateOn === "intraday") throw new Error("fastWindow supports evaluateOn:'realized' only");

  let cum = 0, peak = 0, eodPeak = 0, locked = false;
  let curDay = -2147483648, dayPnl = 0, maxDayPnl = 0;
  let tradingDays = 0, dayHadTrade = false;

  for (let k = lowerBound(T.entry, T.n, startMs); k < T.n; k++) {
    if (T.entry[k] >= endMs) break;
    const d = T.tday[k];
    if (d !== curDay) {
      if (curDay !== -2147483648 && eodTrail) {
        if (cum > eodPeak) eodPeak = cum;
        if (R.lockAtBreakeven && !locked && eodPeak >= R.trailingDD) locked = true;
      }
      curDay = d; dayPnl = 0; dayHadTrade = false;
    }

    if (R.dailyProfitStop > 0 && dayPnl >= R.dailyProfitStop) continue;
    if (R.circuitBreaker > 0 && dayPnl <= -R.circuitBreaker) continue;
    if (R.dailyLossLimit > 0 && dayPnl <= -R.dailyLossLimit) continue;

    if (!dayHadTrade) { dayHadTrade = true; tradingDays++; }

    const p = T.pnl[k] * mult;
    cum += p; dayPnl += p;
    if (dayPnl > maxDayPnl) maxDayPnl = dayPnl;

    if (!eodTrail) {
      if (cum > peak) peak = cum;
      if (R.lockAtBreakeven && !locked && peak >= R.trailingDD) locked = true;
    }
    const floor = locked ? 0 : (eodTrail ? eodPeak : peak) - R.trailingDD;
    if (cum <= floor) return -1;

    const consistencyOk = !R.consistencyGatesPass || maxDayPnl <= capPct * cum;
    if (cum >= R.profitTarget && consistencyOk && tradingDays >= R.minTradingDays) return 1;
  }
  return 0;
}

export function fastSweep(T, starts, R, mult) {
  let pass = 0, fail = 0;
  for (let i = 0; i < starts.length; i++) {
    const o = fastWindow(T, starts[i], R, mult);
    if (o === 1) pass++; else if (o === -1) fail++;
  }
  const n = starts.length || 1;
  return { pass: (pass / n) * 100, fail: (fail / n) * 100, n: starts.length };
}

// The fast path must agree with the shipped engine, or the whole search is noise.
//
// This checks BOTH claims the search depends on: that the flat replay reproduces
// replayWindow, and that applying `mult` is equivalent to having actually traded
// that many contracts. The second is the load-bearing assumption — it is what
// lets one bracket run cover every position size — so it is verified against a
// genuinely rescaled trade list rather than assumed.
export function assertParity(trades, starts, rules, mult = 1) {
  const R = resolveRules(rules);
  const T = flatten(trades);
  const scaled = mult === 1 ? trades : trades.map((t) => ({
    ...t, pnl: t.pnl * mult, mae: t.mae * mult, mfe: t.mfe * mult, contracts: t.contracts * mult,
  }));

  let checked = 0, bad = 0;
  const step = Math.max(1, Math.floor(starts.length / 60));
  for (let i = 0; i < starts.length; i += step) {
    const fastOut = fastWindow(T, starts[i], R, mult);
    const realOut = replayWindow(scaled, starts[i], R).outcome;
    const realCode = realOut === OUTCOME.PASS ? 1 : realOut === OUTCOME.FAIL ? -1 : 0;
    checked++;
    if (fastOut !== realCode) {
      bad++;
      if (bad <= 3) console.log(`  parity mismatch at ${new Date(starts[i]).toISOString().slice(0, 10)}: fast=${fastOut} real=${realCode} (mult ${mult})`);
    }
  }
  if (bad) throw new Error(`fast replay disagrees with replayWindow on ${bad}/${checked} windows at mult=${mult}`);
  return checked;
}

/**
 * Build signals once, then run the whole stop/target grid against them.
 * Yields { sl, tp, trades } for each bracket combination.
 */
export function bracketGrid(bars, strategy, params, slList, tpList, baseExec = {}) {
  const tf = resample(bars, params.timeframeMin ?? strategy.timeframeMin ?? 1);
  const out = strategy.compute(tf, params);
  const results = [];
  for (const sl of slList) {
    for (const tp of tpList) {
      const exec = resolveExec({ ...baseExec, contracts: 1, slAtrMult: sl, tpAtrMult: tp });
      const { trades } = runBrackets(tf, out.sig, out.atr, exec);
      results.push({ sl, tp, trades, bars: tf.close.length });
    }
  }
  return results;
}

export function windowStarts(bars, windowDays = 30, stepDays = 1) {
  const s = [];
  for (let t = bars.ts[0]; t <= bars.ts[bars.count - 1] - windowDays * DAY; t += stepDays * DAY) s.push(t);
  return s;
}
