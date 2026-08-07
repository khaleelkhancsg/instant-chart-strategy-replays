// What are the DAILY rules costing?
//
// The first-passage DP put this edge's ceiling at 53.4% while the best achieved
// policy manages 40.1%. The DP omits exactly one thing: the daily rules. So the
// ~13pp gap is what they cost — and it also explains why the DP's own policy
// underperformed. It plans for ~22 trades in a window, but the $150 circuit
// breaker ends a day after roughly one loss, so far fewer trades actually
// arrive, and a policy that is patient early never gets its later chances.
//
// The important detail: the $150 breaker is NOT a firm rule. It is a
// self-imposed overlay from the other repo, where it was the single biggest
// pass-rate lever FOR A BOOK WITH NO EDGE. Protecting a cushion is worth a lot
// when trading is break-even; it may be actively wrong once trades have positive
// expectancy, because it truncates the winning days too.
//
// The firm's actual daily loss limit is $1000, and it is a soft lockout.

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();
const SPLIT = Date.UTC(2023, 5, 1);
const base = resolveRules({});
const all = windowStarts(bars, base.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const worst = (a, b) => Math.min(a, b);

const TF = 2;
const tfBars = resample(bars, TF);
const ctx = buildFilterContext(tfBars);
const strat = strategies.get("momentum_roc");
const out = strat.compute(tfBars, resolveParams(strat, { timeframeMin: TF }));
const masked = applyFilters(out.sig, ctx, { ...NO_FILTER, startCt: 510, endCt: 660, effMin: 0.5 });
const exec = resolveExec({ intradayOnly: true, sameBarReentry: false, noEntryMinsBeforeFlat: 10, contracts: 1, slAtrMult: 5, tpAtrMult: 1.5 });
const { trades } = runBrackets(tfBars, masked, out.atr, exec);
const T = flatten(trades);
const st = tradeStats(trades);
console.log(`book: ${trades.length.toLocaleString()} trades, pf ${st.profitFactor.toFixed(3)}, $${st.expectancy.toFixed(2)}/lot`);
console.log(`DP ceiling for this edge, ignoring daily rules: 53.4%\n`);

console.log("CIRCUIT BREAKER (self-imposed, not a firm rule)\n");
console.log("  breaker   lots     IS%    OOS%  worst");
let best = null;
for (const cb of [0, 100, 150, 250, 400, 600, 1000]) {
  const rules = resolveRules({ circuitBreaker: cb });
  let bestForCb = null;
  for (const c of [6, 7, 8, 9, 10]) {
    const is = fastSweep(T, IS, rules, c), oos = fastSweep(T, OOS, rules, c);
    const r = { cb, c, is: is.pass, oos: oos.pass, w: worst(is.pass, oos.pass) };
    if (!bestForCb || r.w > bestForCb.w) bestForCb = r;
    if (!best || r.w > best.w) best = r;
  }
  const b = bestForCb;
  const label = cb === 0 ? "off" : `$${cb}`;
  console.log(`  ${label.padStart(7)} ${String(b.c).padStart(6)} ${b.is.toFixed(1).padStart(7)} ${b.oos.toFixed(1).padStart(7)} ${b.w.toFixed(1).padStart(6)}`);
}
console.log(`\n  best: breaker ${best.cb === 0 ? "OFF" : "$" + best.cb} at ${best.c} lots -> worst half ${best.w.toFixed(1)}%\n`);

console.log("\nDAILY PROFIT STOP (also self-imposed)\n");
console.log("  profit stop   lots     IS%    OOS%  worst");
let best2 = null;
for (const ps of [0, 750, 1500, 3000]) {
  const rules = resolveRules({ circuitBreaker: best.cb, dailyProfitStop: ps });
  let bp = null;
  for (const c of [6, 7, 8, 9, 10]) {
    const is = fastSweep(T, IS, rules, c), oos = fastSweep(T, OOS, rules, c);
    const r = { ps, c, is: is.pass, oos: oos.pass, w: worst(is.pass, oos.pass) };
    if (!bp || r.w > bp.w) bp = r;
    if (!best2 || r.w > best2.w) best2 = r;
  }
  console.log(`  ${(ps === 0 ? "off" : "$" + ps).padStart(11)} ${String(bp.c).padStart(6)} ${bp.is.toFixed(1).padStart(7)} ${bp.oos.toFixed(1).padStart(7)} ${bp.w.toFixed(1).padStart(6)}`);
}

console.log("\n\nJOINT SEARCH — both overlays plus size\n");
let bestJoint = null;
for (const cb of [0, 150, 300, 500, 800, 1000]) {
  for (const ps of [0, 750, 1500, 3000]) {
    const rules = resolveRules({ circuitBreaker: cb, dailyProfitStop: ps });
    for (const c of [5, 6, 7, 8, 9, 10]) {
      const is = fastSweep(T, IS, rules, c), oos = fastSweep(T, OOS, rules, c);
      const w = worst(is.pass, oos.pass);
      if (!bestJoint || w > bestJoint.w) bestJoint = { cb, ps, c, is: is.pass, oos: oos.pass, w };
    }
  }
}
console.log(`  best: breaker ${bestJoint.cb === 0 ? "OFF" : "$" + bestJoint.cb}, profit stop ${bestJoint.ps === 0 ? "OFF" : "$" + bestJoint.ps}, ${bestJoint.c} lots`);
console.log(`        IS ${bestJoint.is.toFixed(1)}% / OOS ${bestJoint.oos.toFixed(1)}%  (worst ${bestJoint.w.toFixed(1)}%)`);
console.log(`\n  previous best (breaker $150, profit stop $1500, flat 10): 38.6%`);
console.log(`  searched dynamic sizing on top of that                  : 40.1%`);
console.log(`  DP ceiling ignoring daily rules                          : 53.4%`);

// How many trades do the overlays actually remove?
for (const [label, rules] of [
  ["with breaker $150 + stop $1500", resolveRules({})],
  ["with both overlays off", resolveRules({ circuitBreaker: 0, dailyProfitStop: 0 })],
]) {
  let taken = 0, skipped = 0;
  const capPct = rules.consistencyPct / 100;
  for (const startMs of IS.slice(0, 400)) {
    const endMs = startMs + rules.windowDays * 86400000;
    let curDay = -2147483648, dayPnl = 0;
    let k = 0;
    while (k < T.n && T.entry[k] < startMs) k++;
    for (; k < T.n && T.entry[k] < endMs; k++) {
      if (T.tday[k] !== curDay) { curDay = T.tday[k]; dayPnl = 0; }
      if (rules.dailyProfitStop > 0 && dayPnl >= rules.dailyProfitStop) { skipped++; continue; }
      if (rules.circuitBreaker > 0 && dayPnl <= -rules.circuitBreaker) { skipped++; continue; }
      taken++;
      dayPnl += T.pnl[k] * 10;
    }
  }
  console.log(`\n  ${label}: ${taken.toLocaleString()} taken, ${skipped.toLocaleString()} skipped (${((100 * skipped) / (taken + skipped)).toFixed(1)}%)`);
}
