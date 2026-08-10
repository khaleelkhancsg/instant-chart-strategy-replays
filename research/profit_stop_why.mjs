// WHY does a $750 daily profit stop beat $1500?
//
// The claim made earlier — that $750 "keeps a day under 50% of the $3000 target"
// — does not survive contact with arithmetic: $1500 IS exactly 50% of $3000, so
// a $1500 day satisfies the consistency rule at the moment the target is reached.
// The explanation was wrong. This finds the real mechanism.
//
// Candidate explanations, each of which makes a different testable prediction:
//
//   A. CONSISTENCY. If this is it, turning the consistency gate OFF should
//      collapse the advantage of $750 over $1500.
//   B. GIVE-BACK. Stopping while ahead avoids later losses that day. This book
//      wins 75.8% of the time but loses $1494 on average when it loses, so one
//      late loss erases three wins. If this is it, the advantage should persist
//      with consistency off, and days that hit the cap should show that
//      continuing would have hurt.
//   C. FLOOR RATCHET. Under EOD trailing the floor follows the best daily CLOSE.
//      A bigger up-day raises the floor for every day after it. If this is it,
//      the effect should appear in how often accounts breach rather than in
//      how often they pass the consistency test.

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules, replayWindow, OUTCOME } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();
const strat = strategies.get("donchian_eff_rth");
const TF = 2;
const tfBars = resample(bars, TF);
const ctx = buildFilterContext(tfBars);
const out = strat.compute(tfBars, resolveParams(strat, { timeframeMin: TF }));
const masked = applyFilters(out.sig, ctx, { ...NO_FILTER, ...strat.filterDefaults });
const { trades } = runBrackets(tfBars, masked, out.atr, resolveExec({ ...strat.execDefaults, contracts: 1 }));
const T = flatten(trades);

const all = windowStarts(bars, 30, 1);
const SPLIT = Date.UTC(2023, 5, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const worst = (a, b) => Math.min(a, b);
const LOTS = 10;

// ── Test A: is it the consistency rule? ──
console.log("TEST A — turn the consistency gate off. If it was the mechanism,");
console.log("         the advantage of $750 over $1500 should disappear.\n");
console.log("  profit stop   consistency ON        consistency OFF");
console.log("                IS     OOS   worst    IS     OOS   worst");
const rows = [];
for (const ps of [0, 500, 750, 1000, 1250, 1500, 2000, 3000]) {
  const on = resolveRules({ circuitBreaker: 150, dailyProfitStop: ps, consistencyGatesPass: true });
  const off = resolveRules({ circuitBreaker: 150, dailyProfitStop: ps, consistencyGatesPass: false });
  const a1 = fastSweep(T, IS, on, LOTS), a2 = fastSweep(T, OOS, on, LOTS);
  const b1 = fastSweep(T, IS, off, LOTS), b2 = fastSweep(T, OOS, off, LOTS);
  rows.push({ ps, onW: worst(a1.pass, a2.pass), offW: worst(b1.pass, b2.pass) });
  const lbl = ps === 0 ? "off" : `$${ps}`;
  console.log(`  ${lbl.padStart(11)}  ${a1.pass.toFixed(1).padStart(4)}  ${a2.pass.toFixed(1).padStart(6)}  ${worst(a1.pass, a2.pass).toFixed(1).padStart(5)}   ${b1.pass.toFixed(1).padStart(4)}  ${b2.pass.toFixed(1).padStart(6)}  ${worst(b1.pass, b2.pass).toFixed(1).padStart(5)}`);
}
const on750 = rows.find((r) => r.ps === 750), on1500 = rows.find((r) => r.ps === 1500);
console.log(`\n  advantage of $750 over $1500 with consistency ON : ${(on750.onW - on1500.onW).toFixed(1)}pp`);
console.log(`  advantage of $750 over $1500 with consistency OFF: ${(on750.offW - on1500.offW).toFixed(1)}pp`);
console.log(`  => consistency ${Math.abs((on750.onW - on1500.onW) - (on750.offW - on1500.offW)) < 0.5 ? "is NOT the mechanism" : "explains part of it"}\n`);

// ── How often does consistency actually block anything? ──
console.log("\nTEST A2 — how often does the consistency rule actually bind?\n");
for (const ps of [750, 1500]) {
  const R = resolveRules({ circuitBreaker: 150, dailyProfitStop: ps });
  let reached = 0, blocked = 0, maxDayOver = 0;
  const scaled = trades.map((t) => ({ ...t, pnl: t.pnl * LOTS, mae: t.mae * LOTS, mfe: t.mfe * LOTS }));
  for (const s of IS) {
    const r = replayWindow(scaled, s, R);
    if (r.targetHitMs !== null) {
      reached++;
      if (r.passMs === null || r.passMs !== r.targetHitMs) blocked++;
    }
    if (r.stats.maxDayPnl > 1500) maxDayOver++;
  }
  console.log(`  profit stop $${ps}: ${reached} windows reached the target, ${blocked} were delayed past it (${((100 * blocked) / Math.max(1, reached)).toFixed(1)}%)`);
  console.log(`                   ${maxDayOver} windows had a day over $1500 (${((100 * maxDayOver) / IS.length).toFixed(1)}%)`);
}

// ── Test B: give-back. What happens on days that hit the cap? ──
console.log("\n\nTEST B — give-back. On days that reach the cap, what did the rest");
console.log("         of the day do, and what would continuing have cost?\n");
for (const ps of [750, 1500]) {
  // Walk the raw trade stream day by day at 10 lots and measure what happens
  // after the day first crosses the cap.
  let daysHit = 0, afterPnl = 0, afterTrades = 0, afterWorse = 0;
  let curDay = -2147483648, dayPnl = 0, crossed = false, after = 0, nAfter = 0;
  const flush = () => {
    if (crossed) {
      daysHit++; afterPnl += after; afterTrades += nAfter;
      if (after < 0) afterWorse++;
    }
  };
  for (let i = 0; i < T.n; i++) {
    if (T.tday[i] !== curDay) { flush(); curDay = T.tday[i]; dayPnl = 0; crossed = false; after = 0; nAfter = 0; }
    const p = T.pnl[i] * LOTS;
    if (crossed) { after += p; nAfter++; }
    dayPnl += p;
    if (!crossed && dayPnl >= ps) crossed = true;
  }
  flush();
  console.log(`  cap $${ps}: ${daysHit} days reached it`);
  console.log(`            ${afterTrades} trades would have followed, totalling $${afterPnl.toFixed(0)}`);
  console.log(`            ${afterWorse} of those days (${((100 * afterWorse) / Math.max(1, daysHit)).toFixed(1)}%) would have ended WORSE by continuing`);
  console.log(`            average give-back avoided per capped day: $${(-afterPnl / Math.max(1, daysHit)).toFixed(0)}\n`);
}

// ── Test C: floor ratchet. Does the cap change how often accounts breach? ──
console.log("\nTEST C — breach rate and peak behaviour under each cap\n");
console.log("  profit stop   pass%   breach%   unresolved%   median best-day $");
for (const ps of [0, 750, 1500]) {
  const R = resolveRules({ circuitBreaker: 150, dailyProfitStop: ps });
  const scaled = trades.map((t) => ({ ...t, pnl: t.pnl * LOTS, mae: t.mae * LOTS, mfe: t.mfe * LOTS }));
  let p = 0, f = 0, o = 0;
  const bestDays = [];
  for (const s of IS) {
    const r = replayWindow(scaled, s, R);
    if (r.outcome === OUTCOME.PASS) p++; else if (r.outcome === OUTCOME.FAIL) f++; else o++;
    bestDays.push(r.stats.maxDayPnl);
  }
  bestDays.sort((a, b) => a - b);
  const med = bestDays[Math.floor(bestDays.length / 2)];
  const lbl = ps === 0 ? "off" : `$${ps}`;
  console.log(`  ${lbl.padStart(11)} ${((100 * p) / IS.length).toFixed(1).padStart(7)} ${((100 * f) / IS.length).toFixed(1).padStart(9)} ${((100 * o) / IS.length).toFixed(1).padStart(13)} ${med.toFixed(0).padStart(18)}`);
}
