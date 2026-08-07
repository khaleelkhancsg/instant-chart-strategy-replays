// Can the new positive edge be expressed more often?
//
// The filter search produced the project's first genuinely positive per-trade
// edge under the real rules — momentum_roc + efficiency>0.5, profit factor 1.148
// at +$66/trade — but it fires only 0.74x/day, roughly 22 trades per 30-day
// window. That is thin for an edge to resolve, and it is why PF 1.148 still only
// converts to 38.9% pass.
//
// So the binding constraint has moved from EDGE to FREQUENCY, which is a
// different and more tractable problem. Two ways to attack it:
//
//   A. Does the same GATE lift other signals? If efficiency>0.5 is picking out a
//      genuinely tradeable regime rather than flattering one book, it should
//      improve several strategies, and their trades can be pooled.
//   B. Does POOLING those books raise frequency without diluting edge? Stage C
//      found portfolios unhelpful, but that paired books with no edge to start
//      with. Pooling positive-edge books is a different experiment.
//
// Sizes must sum to the 10-lot cap: it is one account, not several.

import fs from "node:fs";
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
const RULES = resolveRules({});
const EXEC_BASE = { intradayOnly: true, sameBarReentry: false, noEntryMinsBeforeFlat: 10 };
const SPLIT = Date.UTC(2023, 5, 1);
const all = windowStarts(bars, RULES.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const worst = (r) => Math.min(r.is, r.oos);
const spanDays = (bars.ts[bars.count - 1] - bars.ts[0]) / 86400000;

// The gate and geometry that produced the edge, plus nearby variants.
const GATES = [
  { label: "eff>0.5, RTH", startCt: 510, endCt: 900, effMin: 0.5 },
  { label: "eff>0.5, 08:30-11", startCt: 510, endCt: 660, effMin: 0.5 },
  { label: "eff>0.4, RTH", startCt: 510, endCt: 900, effMin: 0.4 },
  { label: "eff>0.6, RTH", startCt: 510, endCt: 900, effMin: 0.6 },
  { label: "adx>35, RTH", startCt: 510, endCt: 900, adxMin: 35 },
];
const GEOS = [[5, 1.5], [5, 1.25], [4, 1.5], [3, 1], [5, 2]];
const TFS = [2, 5];

console.log("PART A — does the gate lift OTHER signals, or just the one it was found on?\n");
console.log("  strategy             tf  gate                geom     trades  /day     PF   exp$/tr    IS%   OOS%");

const books = [];
let sims = 0, configs = 0;
for (const tf of TFS) {
  const tfBars = resample(bars, tf);
  const ctx = buildFilterContext(tfBars);
  for (const [id, strat] of strategies) {
    const params = resolveParams(strat, { timeframeMin: tf });
    let out;
    try { out = strat.compute(tfBars, params); } catch { continue; }

    let bestForBook = null;
    for (const g of GATES) {
      const masked = applyFilters(out.sig, ctx, { ...NO_FILTER, ...g });
      for (const [sl, tp] of GEOS) {
        const exec = resolveExec({ ...EXEC_BASE, contracts: 1, slAtrMult: sl, tpAtrMult: tp });
        const { trades } = runBrackets(tfBars, masked, out.atr, exec);
        if (trades.length < 250) continue;
        const st = tradeStats(trades);
        if (st.profitFactor <= 1.0) continue;          // keep only real edges
        const T = flatten(trades);
        for (const c of [4, 6, 8, 10]) {
          const is = fastSweep(T, IS, RULES, c);
          const oos = fastSweep(T, OOS, RULES, c);
          configs++; sims += IS.length + OOS.length;
          const cand = { id, tf, gate: g, gateLabel: g.label, sl, tp, c, trades,
                         n: trades.length, pf: st.profitFactor, exp: st.expectancy,
                         perDay: trades.length / spanDays, is: is.pass, oos: oos.pass };
          if (!bestForBook || worst(cand) > worst(bestForBook)) bestForBook = cand;
        }
      }
    }
    if (bestForBook) {
      const b = bestForBook;
      console.log(`  ${b.id.padEnd(20)} ${String(b.tf).padStart(2)}  ${b.gateLabel.padEnd(18)} ${String(b.sl).padStart(2)}/${String(b.tp).padEnd(4)} ${String(b.n).padStart(7)} ${b.perDay.toFixed(2).padStart(5)} ${b.pf.toFixed(3).padStart(6)} ${b.exp.toFixed(2).padStart(8)} ${b.is.toFixed(1).padStart(6)} ${b.oos.toFixed(1).padStart(6)}`);
      books.push(b);
    }
  }
}

if (!books.length) {
  console.log("\n  no book kept a profit factor above 1.0 under these gates");
  process.exit(0);
}

console.log(`\n  ${books.length} books retained a positive edge under a gate\n`);

// ── PART B: pool them ──
console.log("\nPART B — pooling positive-edge books into ONE account (sizes sum to <= 10)\n");

function pool(list, sizes) {
  const out = [];
  for (let k = 0; k < list.length; k++) {
    const m = sizes[k];
    if (m <= 0) continue;
    for (const t of list[k].trades) out.push({ ...t, pnl: t.pnl * m, mae: t.mae * m, mfe: t.mfe * m });
  }
  out.sort((a, b) => a.entryTime - b.entryTime);
  return out;
}

books.sort((a, b) => worst(b) - worst(a));
const top = books.slice(0, 6);
const combos = [];

// pairs
for (let i = 0; i < top.length; i++) {
  for (let j = i + 1; j < top.length; j++) {
    for (const [a, b] of [[5, 5], [6, 4], [4, 6], [7, 3], [3, 7], [8, 2], [2, 8]]) {
      const merged = pool([top[i], top[j]], [a, b]);
      const T = flatten(merged);
      const is = fastSweep(T, IS, RULES, 1);
      const oos = fastSweep(T, OOS, RULES, 1);
      configs++; sims += IS.length + OOS.length;
      combos.push({ label: `${top[i].id}(${a}) + ${top[j].id}(${b})`, n: merged.length,
                    perDay: merged.length / spanDays, is: is.pass, oos: oos.pass });
    }
  }
}
// triples, evenly sized
for (let i = 0; i < top.length; i++) {
  for (let j = i + 1; j < top.length; j++) {
    for (let k = j + 1; k < top.length; k++) {
      for (const sz of [[4, 3, 3], [3, 4, 3], [3, 3, 4], [2, 4, 4], [6, 2, 2]]) {
        const merged = pool([top[i], top[j], top[k]], sz);
        const T = flatten(merged);
        const is = fastSweep(T, IS, RULES, 1);
        const oos = fastSweep(T, OOS, RULES, 1);
        configs++; sims += IS.length + OOS.length;
        combos.push({ label: `${top[i].id}(${sz[0]}) + ${top[j].id}(${sz[1]}) + ${top[k].id}(${sz[2]})`,
                      n: merged.length, perDay: merged.length / spanDays, is: is.pass, oos: oos.pass });
      }
    }
  }
}

combos.sort((a, b) => worst(b) - worst(a));
console.log("  combination                                                    trades  /day     IS%    OOS%  worst");
for (const c of combos.slice(0, 20)) {
  console.log(`  ${c.label.padEnd(60)} ${String(c.n).padStart(6)} ${c.perDay.toFixed(2).padStart(5)} ${c.is.toFixed(1).padStart(6)} ${c.oos.toFixed(1).padStart(7)} ${worst(c).toFixed(1).padStart(6)}`);
}

const bestSingle = books[0];
const bestCombo = combos[0];
console.log(`\n  best single book : ${bestSingle.id} — ${bestSingle.perDay.toFixed(2)}/day, worst half ${worst(bestSingle).toFixed(1)}%`);
console.log(`  best pooled      : ${bestCombo.perDay.toFixed(2)}/day, worst half ${worst(bestCombo).toFixed(1)}%`);
console.log(`  pooling ${worst(bestCombo) > worst(bestSingle) ? "HELPS — frequency was the constraint" : "does NOT help"}`);

fs.writeFileSync("research/frequency_results.json", JSON.stringify({
  meta: { configs, sims },
  books: books.map(({ trades, ...b }) => b),
  combos: combos.slice(0, 100),
}, null, 1));
console.log(`\n  ${sims.toLocaleString()} window simulations across ${configs.toLocaleString()} configurations`);
