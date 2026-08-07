// Is the pooling result real, or an artefact of double-counting one book?
//
// The frequency search reported 77.4% from combining tpl_channel + trend_neutev
// + trend_vol_adaptive. But tpl_channel at default parameters reproduces
// trend_neutev EXACTLY, so that "portfolio" may be one signal counted twice at
// different sizes rather than two independent books.
//
// Three checks, in order of severity:
//   1. Are the trade lists actually identical?
//   2. Does the single book at the COMBINED size do just as well? If so the
//      portfolio adds nothing and the gain is really a sizing effect.
//   3. Does splitting one book into two half-sized copies change the outcome?
//      It should not — and if it does, the pooling model is manufacturing an
//      advantage out of how events are ordered rather than out of diversification.

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
const EXEC = { intradayOnly: true, sameBarReentry: false, noEntryMinsBeforeFlat: 10, contracts: 1, slAtrMult: 5, tpAtrMult: 1.5 };
const GATE = { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 };
const SPLIT = Date.UTC(2023, 5, 1);
const all = windowStarts(bars, RULES.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);

const tfBars = resample(bars, 2);
const ctx = buildFilterContext(tfBars);

function book(id) {
  const strat = strategies.get(id);
  const out = strat.compute(tfBars, resolveParams(strat, { timeframeMin: 2 }));
  const masked = applyFilters(out.sig, ctx, GATE);
  return runBrackets(tfBars, masked, out.atr, resolveExec(EXEC)).trades;
}

const A = book("trend_neutev");
const B = book("tpl_channel");
const C = book("trend_vol_adaptive");

// ── 1. identical? ──
console.log("CHECK 1 — are trend_neutev and tpl_channel the same book?\n");
let diff = 0;
for (let i = 0; i < Math.min(A.length, B.length); i++) {
  if (A[i].entryTime !== B[i].entryTime || Math.abs(A[i].pnl - B[i].pnl) > 1e-9) diff++;
}
console.log(`  trend_neutev ${A.length} trades | tpl_channel ${B.length} trades | differing: ${diff}`);
console.log(`  -> ${diff === 0 && A.length === B.length ? "IDENTICAL. Pooling them is double-counting ONE book." : "genuinely different books"}\n`);

// Overlap between the two genuinely distinct books.
const aKeys = new Set(A.map((t) => t.entryTime));
let shared = 0;
for (const t of C) if (aKeys.has(t.entryTime)) shared++;
console.log(`  trend_vol_adaptive shares ${shared} of its ${C.length} entry times with trend_neutev (${((100 * shared) / C.length).toFixed(1)}%)\n`);

function rate(trades, mult) {
  const T = flatten(trades);
  const is = fastSweep(T, IS, RULES, mult), oos = fastSweep(T, OOS, RULES, mult);
  return { is: is.pass, oos: oos.pass, w: Math.min(is.pass, oos.pass) };
}
function pool(list) {
  const out = [];
  for (const [trades, m] of list) for (const t of trades) out.push({ ...t, pnl: t.pnl * m, mae: t.mae * m, mfe: t.mfe * m });
  out.sort((a, b) => a.entryTime - b.entryTime);
  return out;
}

// ── 2. does the single book at the combined size match? ──
console.log("CHECK 2 — single book at each size (the honest comparison)\n");
console.log("  lots    IS%    OOS%  worst");
for (const c of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  const r = rate(A, c);
  console.log(`  ${String(c).padStart(4)} ${r.is.toFixed(1).padStart(6)} ${r.oos.toFixed(1).padStart(7)} ${r.w.toFixed(1).padStart(6)}`);
}

// ── 3. does splitting ONE book into copies change anything? ──
console.log("\nCHECK 3 — split one book into copies totalling the same size\n");
const s7 = rate(A, 7);
const p34 = rate(pool([[A, 3], [B, 4]]), 1);
const p1x7 = rate(pool([[A, 1], [A, 1], [A, 1], [A, 1], [A, 1], [A, 1], [A, 1]]), 1);
console.log(`  one book at 7 lots                    IS ${s7.is.toFixed(1)}%  OOS ${s7.oos.toFixed(1)}%  worst ${s7.w.toFixed(1)}%`);
console.log(`  same book split 3+4 (identical lists)  IS ${p34.is.toFixed(1)}%  OOS ${p34.oos.toFixed(1)}%  worst ${p34.w.toFixed(1)}%`);
console.log(`  same book split into 7 x 1 lot         IS ${p1x7.is.toFixed(1)}%  OOS ${p1x7.oos.toFixed(1)}%  worst ${p1x7.w.toFixed(1)}%`);
console.log(`\n  If these differ, the pooling model is inventing an advantage from event`);
console.log(`  ORDERING rather than from diversification, and the 77% is not real.\n`);

// ── 4. the honest portfolio: only genuinely distinct books ──
console.log("CHECK 4 — pooling only genuinely DISTINCT books\n");
console.log("  combination                          trades     IS%    OOS%  worst");
for (const [la, ma, lb, mb] of [["A", 5, "C", 5], ["A", 6, "C", 4], ["A", 4, "C", 6], ["A", 7, "C", 3], ["A", 3, "C", 7]]) {
  const merged = pool([[A, ma], [C, mb]]);
  const r = rate(merged, 1);
  console.log(`  trend_neutev(${ma}) + trend_vol_adaptive(${mb})   ${String(merged.length).padStart(6)} ${r.is.toFixed(1).padStart(7)} ${r.oos.toFixed(1).padStart(7)} ${r.w.toFixed(1).padStart(6)}`);
}
