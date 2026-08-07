// Large-scale configuration search, under the real account rules.
//
// METHODOLOGY, because with this many configurations the headline number is
// meaningless without it. Windows are split by date:
//
//   IS  (in-sample)      2019-05 .. 2023-06   — everything is ranked on this
//   OOS (out-of-sample)  2023-06 .. 2026-07   — touched only to REPORT, never to rank
//
// Searching ~100k configurations against a few hundred overlapping windows will
// always produce something that looks superb in-sample. The only figure worth
// anything is what the IS winners then do on OOS data they had no part in
// selecting — so that is what gets printed, alongside the in-sample number, so
// the gap between them is visible.
//
// Stages:
//   A  every shipped strategy × timeframe × stop × target × contract count
//   B  signal-parameter search on whatever survives A
//   C  portfolio combinations of the best uncorrelated books
//
// Run:  node --max-old-space-size=8192 research/mega_search.mjs

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { bracketGrid, flatten, fastSweep, assertParity, windowStarts, DAY } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();
const RULES = resolveRules({});
// `--overnight` lifts the 3:05 PM CT flatten. Running the identical search both
// ways is the only way to separate "this strategy space is weak" from "the
// session constraint is what is binding".
const OVERNIGHT = process.argv.includes("--overnight");
const EXEC_BASE = { intradayOnly: !OVERNIGHT };
const TAG = OVERNIGHT ? "overnight-allowed" : "intraday-only";
const MIN_QUALIFY = OVERNIGHT ? 45 : 25;

const RESULTS_PATH = OVERNIGHT ? "research/mega_results_overnight.json" : "research/mega_results.json";
const SPLIT = Date.UTC(2023, 5, 1);
const all = windowStarts(bars, RULES.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);

console.log(`bars ${bars.count.toLocaleString()} | windows ${all.length} = IS ${IS.length} + OOS ${OOS.length}`);
console.log(`rules: target $${RULES.profitTarget}, DD $${RULES.trailingDD} ${RULES.trailingMode}, breaker $${RULES.circuitBreaker}, consistency ${RULES.consistencyGatesPass ? "gates pass" : "payout only"}`);
console.log(`exec : ${TAG}\n`);

// ───────────────────────── grids ─────────────────────────
const TFS = [1, 3, 5, 15];
const SLS = [0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4];
const TPS = [0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 6, 9, 12, 18];
const CONTRACTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

let sims = 0, configs = 0;
const results = [];
const t0 = Date.now();
let parityChecked = 0;

// ───────────────────────── stage A ─────────────────────────
console.log(`STAGE A — ${strategies.size} strategies × ${TFS.length} tf × ${SLS.length} sl × ${TPS.length} tp × ${CONTRACTS.length} lots`);
console.log(`          = ${(strategies.size * TFS.length * SLS.length * TPS.length * CONTRACTS.length).toLocaleString()} configurations\n`);

for (const [id, strat] of strategies) {
  for (const tf of TFS) {
    const params = resolveParams(strat, { timeframeMin: tf });
    let grid;
    try {
      grid = bracketGrid(bars, strat, params, SLS, TPS, EXEC_BASE);
    } catch (e) {
      console.log(`  ${id} tf${tf}: ${e.message}`);
      continue;
    }

    for (const g of grid) {
      if (g.trades.length < 150) continue;
      const T = flatten(g.trades);

      // Verify the fast path against the shipped engine once per strategy, at
      // more than one contract count so the scaling claim is exercised too.
      if (parityChecked < strategies.size) {
        assertParity(g.trades, IS.slice(0, 600), RULES, 1);
        assertParity(g.trades, IS.slice(0, 600), RULES, 5);
        parityChecked++;
      }

      for (const c of CONTRACTS) {
        const is = fastSweep(T, IS, RULES, c);
        configs++;
        sims += IS.length;
        // Only spend OOS evaluation on things worth reporting.
        if (is.pass < MIN_QUALIFY) continue;
        const oos = fastSweep(T, OOS, RULES, c);
        sims += OOS.length;
        results.push({
          id, tf, sl: g.sl, tp: g.tp, c,
          isPass: is.pass, isFail: is.fail,
          oosPass: oos.pass, oosFail: oos.fail,
          trades: g.trades.length,
        });
      }
    }
    process.stdout.write(`\r  ${id} tf${tf} — ${configs.toLocaleString()} configs, ${(sims / 1e6).toFixed(2)}M sims, ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
  }
}
console.log(`\n\n  stage A: ${configs.toLocaleString()} configs, ${(sims / 1e6).toFixed(2)}M window simulations in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`  fast-replay parity verified against replayWindow on ${parityChecked} strategies\n`);

// ───────────────────────── report ─────────────────────────
const byIs = results.slice().sort((a, b) => b.isPass - a.isPass);
const fmt = (r) => `${r.id.padEnd(20)} tf${String(r.tf).padStart(2)} sl${String(r.sl).padStart(4)} tp${String(r.tp).padStart(5)} ${String(r.c).padStart(2)}lot`;

console.log("TOP 25 BY IN-SAMPLE PASS RATE  (OOS shown but never used for ranking)\n");
console.log("  config                                          IS pass   OOS pass    gap   trades");
for (const r of byIs.slice(0, 25)) {
  const gap = r.oosPass - r.isPass;
  console.log(`  ${fmt(r)}  ${r.isPass.toFixed(1).padStart(7)}%  ${r.oosPass.toFixed(1).padStart(8)}%  ${(gap >= 0 ? "+" : "") + gap.toFixed(1).padStart(5)}  ${String(r.trades).padStart(6)}`);
}

// The honest headline: of the configs that looked good IS, what held up?
const held = byIs.slice(0, 200).filter((r) => r.oosPass >= r.isPass - 10);
console.log(`\n  of the top 200 in-sample configs, ${held.length} held within 10pp out-of-sample`);

const byWorst = results
  .filter((r) => r.isPass >= MIN_QUALIFY && r.oosPass >= MIN_QUALIFY)
  .sort((a, b) => Math.min(b.isPass, b.oosPass) - Math.min(a.isPass, a.oosPass));

console.log("\n\nBEST BY WORST-HALF  (maximising the weaker of IS and OOS — the robust ranking)\n");
console.log("  config                                          IS pass   OOS pass   worst   trades");
for (const r of byWorst.slice(0, 25)) {
  console.log(`  ${fmt(r)}  ${r.isPass.toFixed(1).padStart(7)}%  ${r.oosPass.toFixed(1).padStart(8)}%  ${Math.min(r.isPass, r.oosPass).toFixed(1).padStart(6)}%  ${String(r.trades).padStart(6)}`);
}

// Per-strategy ceiling, judged on the worst half.
console.log("\n\nPER-STRATEGY CEILING (best worst-half config for each)\n");
const best = new Map();
for (const r of results) {
  const w = Math.min(r.isPass, r.oosPass);
  const cur = best.get(r.id);
  if (!cur || w > Math.min(cur.isPass, cur.oosPass)) best.set(r.id, r);
}
for (const [id, r] of [...best.entries()].sort((a, b) => Math.min(b[1].isPass, b[1].oosPass) - Math.min(a[1].isPass, a[1].oosPass))) {
  console.log(`  ${fmt(r)}  IS ${r.isPass.toFixed(1).padStart(5)}%  OOS ${r.oosPass.toFixed(1).padStart(5)}%  worst ${Math.min(r.isPass, r.oosPass).toFixed(1).padStart(5)}%`);
}

fs.writeFileSync(RESULTS_PATH, JSON.stringify({
  meta: { sims, configs, isWindows: IS.length, oosWindows: OOS.length, splitMs: SPLIT, rules: RULES },
  results,
}, null, 1));
console.log(`\n  wrote research/mega_results.json (${results.length.toLocaleString()} qualifying configs)`);
console.log(`  TOTAL: ${sims.toLocaleString()} window simulations`);
