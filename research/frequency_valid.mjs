// Can frequency be raised without diluting quality? — asked properly this time.
//
// The best book has a real edge (pf 1.148) but fires 0.74x/day, about 22 trades
// per window, which is too few for the edge to resolve reliably. Loosening its
// gate has diluted quality every time it has been tried.
//
// The alternative is more INDEPENDENT sources of the same quality: several
// signal families under the same regime gate. That requires overlapping
// positions, which replayWindow cannot score — hence src/portfolio.mjs, whose
// tests prove splitting a book into copies is a no-op and that the contract cap
// binds the account rather than each book.
//
// Measured first, so the comparison is not fooled again:
//   - each candidate's own edge and frequency under the shared gate
//   - how much each PAIR actually overlaps in entry time (near-duplicates give
//     fake diversification, as tpl_channel/trend_neutev did at 100%)

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { sweepPortfolio } from "../src/portfolio.mjs";
import { windowStarts, DAY } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();
// The overlays retuned by the last search.
const RULES = resolveRules({ circuitBreaker: 150, dailyProfitStop: 750 });
const SPLIT = Date.UTC(2023, 5, 1);
const all = windowStarts(bars, RULES.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const worst = (r) => Math.min(r.is, r.oos);
const spanDays = (bars.ts[bars.count - 1] - bars.ts[0]) / DAY;

const GATE = { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 };   // RTH, trending only
const EXEC = { intradayOnly: true, sameBarReentry: false, noEntryMinsBeforeFlat: 10, contracts: 1 };

// Build every candidate book under the SAME gate, each at its own best geometry.
const CANDIDATES = [
  ["momentum_roc", 2, 5, 1.5], ["momentum_roc", 5, 5, 2],
  ["orb", 2, 5, 2], ["orb", 5, 4, 1.5],
  ["tpl_channel", 2, 5, 1.5], ["tpl_channel", 5, 5, 1.5],
  ["supertrend", 5, 5, 2], ["prior_day_break", 5, 4, 1.5],
  ["macd_angle_v4", 2, 5, 1.25], ["triple_ema", 2, 5, 2],
  ["session_range_fade", 2, 5, 1.5], ["gap_fade", 5, 4, 1.5],
  ["vwap_fade", 5, 4, 2], ["tpl_oscillator", 5, 5, 1.5],
];

console.log("CANDIDATE BOOKS under a shared gate (RTH 08:30-15:00, efficiency>0.5)\n");
console.log("  book                     tf   sl   tp   trades   /day      pf   exp$/lot");
const books = [];
const cache = new Map();
for (const [id, tf, sl, tp] of CANDIDATES) {
  if (!strategies.has(id)) continue;
  let ctxTf = cache.get(tf);
  if (!ctxTf) { const b = resample(bars, tf); ctxTf = { b, ctx: buildFilterContext(b) }; cache.set(tf, ctxTf); }
  const strat = strategies.get(id);
  const out = strat.compute(ctxTf.b, resolveParams(strat, { timeframeMin: tf }));
  const masked = applyFilters(out.sig, ctxTf.ctx, GATE);
  const { trades } = runBrackets(ctxTf.b, masked, out.atr, resolveExec({ ...EXEC, slAtrMult: sl, tpAtrMult: tp }));
  if (trades.length < 200) continue;
  const st = tradeStats(trades);
  console.log(`  ${id.padEnd(22)} ${String(tf).padStart(3)} ${String(sl).padStart(4)} ${String(tp).padStart(4)} ${String(trades.length).padStart(8)} ${(trades.length / spanDays).toFixed(2).padStart(6)} ${st.profitFactor.toFixed(3).padStart(7)} ${st.expectancy.toFixed(2).padStart(9)}`);
  if (st.profitFactor > 1.02) books.push({ key: `${id}/${tf}`, id, tf, trades, pf: st.profitFactor, perDay: trades.length / spanDays });
}
console.log(`\n  ${books.length} books cleared profit factor 1.02\n`);

// ── overlap: are these genuinely different books? ──
console.log("ENTRY-TIME OVERLAP (a near-duplicate gives fake diversification)\n");
const keys = books.map((b) => b.key);
const sets = books.map((b) => new Set(b.trades.map((t) => Math.floor(t.entryTime / 60000))));
console.log("        " + keys.map((k) => k.slice(0, 7).padStart(8)).join(""));
for (let i = 0; i < books.length; i++) {
  const row = [];
  for (let j = 0; j < books.length; j++) {
    if (i === j) { row.push("     -  "); continue; }
    let shared = 0;
    for (const t of sets[i]) if (sets[j].has(t)) shared++;
    row.push(`${((100 * shared) / sets[i].size).toFixed(0)}%`.padStart(8));
  }
  console.log(`  ${keys[i].slice(0, 6).padEnd(6)}` + row.join(""));
}

// ── pooling, scored correctly ──
console.log("\n\nPOOLED PORTFOLIOS (event-driven, account-wide 10-lot cap)\n");
const results = [];
function evalPool(sel, sizes) {
  const bs = sel.map((b, i) => ({ trades: b.trades, contracts: sizes[i] }));
  const is = sweepPortfolio(bs, IS, RULES, { maxContracts: 10 });
  const oos = sweepPortfolio(bs, OOS, RULES, { maxContracts: 10 });
  const n = sel.reduce((a, b, i) => a + (sizes[i] > 0 ? b.trades.length : 0), 0);
  return { label: sel.map((b, i) => `${b.key}(${sizes[i]})`).join(" + "), n, perDay: n / spanDays, is: is.pass, oos: oos.pass };
}

// singles first, as the baseline each pool must beat
console.log("  singles");
for (const b of books) {
  let best = null;
  for (const c of [6, 8, 10]) {
    const r = evalPool([b], [c]);
    if (!best || worst(r) > worst(best)) best = r;
  }
  results.push(best);
  console.log(`    ${best.label.padEnd(34)} ${best.perDay.toFixed(2).padStart(5)}/day  IS ${best.is.toFixed(1).padStart(5)}  OOS ${best.oos.toFixed(1).padStart(5)}  worst ${worst(best).toFixed(1).padStart(5)}`);
}
const bestSingle = results.slice().sort((a, b) => worst(b) - worst(a))[0];

// pairs and triples, sizes summing to the cap
const pools = [];
for (let i = 0; i < books.length; i++) {
  for (let j = i + 1; j < books.length; j++) {
    for (const s of [[5, 5], [6, 4], [4, 6], [7, 3], [3, 7]]) pools.push([[books[i], books[j]], s]);
  }
}
for (let i = 0; i < books.length; i++) {
  for (let j = i + 1; j < books.length; j++) {
    for (let k = j + 1; k < books.length; k++) {
      for (const s of [[4, 3, 3], [3, 4, 3], [3, 3, 4]]) pools.push([[books[i], books[j], books[k]], s]);
    }
  }
}
console.log(`\n  evaluating ${pools.length.toLocaleString()} pooled combinations ...`);
const pooled = [];
for (const [sel, sizes] of pools) pooled.push(evalPool(sel, sizes));
pooled.sort((a, b) => worst(b) - worst(a));

console.log("\n  TOP 20 POOLS\n");
console.log("  combination                                                    /day  IS%   OOS%  worst");
for (const r of pooled.slice(0, 20)) {
  console.log(`  ${r.label.padEnd(58)} ${r.perDay.toFixed(2).padStart(5)} ${r.is.toFixed(1).padStart(5)} ${r.oos.toFixed(1).padStart(6)} ${worst(r).toFixed(1).padStart(6)}`);
}

const bestPool = pooled[0];
console.log(`\n  best single : ${bestSingle.label} — ${bestSingle.perDay.toFixed(2)}/day, worst ${worst(bestSingle).toFixed(1)}%`);
console.log(`  best pool   : ${bestPool.label}`);
console.log(`                ${bestPool.perDay.toFixed(2)}/day, worst ${worst(bestPool).toFixed(1)}%`);
console.log(`\n  raising frequency this way is worth ${(worst(bestPool) - worst(bestSingle)).toFixed(1)}pp`);

fs.writeFileSync("research/frequency_valid_results.json", JSON.stringify({
  books: books.map(({ trades, ...b }) => b), singles: results, pools: pooled.slice(0, 100),
}, null, 1));
