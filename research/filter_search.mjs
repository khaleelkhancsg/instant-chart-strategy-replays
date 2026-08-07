// Regime and time-of-day filter search, across every strategy.
//
// Earlier stages tuned signals and brackets. This sweeps the FILTER layer —
// session windows and regime gates — orthogonally to both, because the other
// repo's history says this is where the largest single gain came from (a
// session-hour filter took one book from 21.5% to 36.9% there).
//
// Two phases, so the expensive step is only paid where it can matter:
//   1. BROAD  — every strategy x every filter, at a small set of bracket
//               geometries already known to work under the flatten rule.
//   2. REFINE — full stop/target/size grid on whatever phase 1 surfaced.
//
// Ranking is on IS only; OOS is computed for reporting. Fills are causal
// throughout (sameBarReentry off).
//
// Run: node --max-old-space-size=8192 research/filter_search.mjs

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, countSurviving, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, assertParity, windowStarts } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();
const RULES = resolveRules({});
const EXEC_BASE = { intradayOnly: true, sameBarReentry: false, noEntryMinsBeforeFlat: 10 };

const SPLIT = Date.UTC(2023, 5, 1);
const all = windowStarts(bars, RULES.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const worst = (r) => Math.min(r.is, r.oos);

// ───────────────────────── filter grid ─────────────────────────
// Session windows worth testing: the cash open, the morning, midday, the
// afternoon, the overnight/Globex session, and no restriction.
const SESSIONS = [
  [0, 1440, "any"],
  [8 * 60 + 30, 15 * 60, "RTH 08:30-15:00"],
  [8 * 60 + 30, 11 * 60, "morning 08:30-11:00"],
  [8 * 60 + 30, 10 * 60, "open 08:30-10:00"],
  [11 * 60, 15 * 60, "afternoon 11:00-15:00"],
  [12 * 60 + 30, 15 * 60, "late 12:30-15:00"],
  [2 * 60, 8 * 60 + 30, "pre-cash 02:00-08:30"],
  [17 * 60, 24 * 60, "evening 17:00-24:00"],
  [7 * 60, 12 * 60, "07:00-12:00"],
  [9 * 60, 14 * 60, "09:00-14:00"],
];

const REGIMES = [
  { label: "none" },
  { label: "adx>20", adxMin: 20 }, { label: "adx>28", adxMin: 28 }, { label: "adx>35", adxMin: 35 },
  { label: "adx<20", adxMax: 20 }, { label: "adx<28", adxMax: 28 },
  { label: "vol<1.0", volMax: 1.0 }, { label: "vol<1.3", volMax: 1.3 }, { label: "vol>1.0", volMin: 1.0 },
  { label: "vol 0.7-1.3", volMin: 0.7, volMax: 1.3 },
  { label: "eff>0.3", effMin: 0.3 }, { label: "eff>0.5", effMin: 0.5 }, { label: "eff<0.3", effMax: 0.3 },
  { label: "chop<50", chopMax: 50 }, { label: "chop>55", chopMin: 55 },
  { label: "bw<0.004", bwMax: 0.004 }, { label: "bw>0.004", bwMin: 0.004 },
  { label: "adx>28 & vol<1.3", adxMin: 28, volMax: 1.3 },
  { label: "eff>0.3 & vol<1.3", effMin: 0.3, volMax: 1.3 },
  { label: "adx<20 & chop>55", adxMax: 20, chopMin: 55 },
];

// Geometries that survived the flatten rule in the earlier searches.
const PHASE1_BRACKETS = [[3, 1], [3, 1.5], [4, 1.5], [2, 1], [1.5, 2]];
const PHASE1_LOTS = [6, 8, 10];

const TFS = [2, 5, 15];

let configs = 0, sims = 0, parity = 0;
const found = [];
const t0 = Date.now();

console.log(`windows: IS ${IS.length} / OOS ${OOS.length}`);
console.log(`grid: ${strategies.size} strategies x ${TFS.length} tf x ${SESSIONS.length} sessions x ${REGIMES.length} regimes x ${PHASE1_BRACKETS.length} brackets x ${PHASE1_LOTS.length} lots`);
console.log(`    = ${(strategies.size * TFS.length * SESSIONS.length * REGIMES.length * PHASE1_BRACKETS.length * PHASE1_LOTS.length).toLocaleString()} phase-1 configurations\n`);

for (const tf of TFS) {
  const tfBars = resample(bars, tf);
  const ctx = buildFilterContext(tfBars);          // computed once per timeframe

  for (const [id, strat] of strategies) {
    const params = resolveParams(strat, { timeframeMin: tf });
    let out;
    try { out = strat.compute(tfBars, params); } catch { continue; }
    const rawCount = out.sig.reduce((a, v) => a + (v ? 1 : 0), 0);
    if (rawCount < 500) continue;

    for (const [startCt, endCt, sLabel] of SESSIONS) {
      for (const reg of REGIMES) {
        const filter = { ...NO_FILTER, startCt, endCt, ...reg };
        const surviving = countSurviving(out.sig, ctx, filter);
        if (surviving < 300) continue;             // gated away too much to matter
        const masked = applyFilters(out.sig, ctx, filter);

        for (const [sl, tp] of PHASE1_BRACKETS) {
          const exec = resolveExec({ ...EXEC_BASE, contracts: 1, slAtrMult: sl, tpAtrMult: tp });
          const { trades } = runBrackets(tfBars, masked, out.atr, exec);
          if (trades.length < 200) continue;
          const T = flatten(trades);
          if (parity < 4) { assertParity(trades, IS.slice(0, 250), RULES, 6); parity++; }

          for (const c of PHASE1_LOTS) {
            const is = fastSweep(T, IS, RULES, c);
            configs++; sims += IS.length;
            if (is.pass < 30) continue;
            const oos = fastSweep(T, OOS, RULES, c);
            sims += OOS.length;
            found.push({ id, tf, session: sLabel, regime: reg.label, sl, tp, c,
                         is: is.pass, oos: oos.pass, trades: trades.length, filter });
          }
        }
      }
    }
    process.stdout.write(`\r  tf${tf} ${id.padEnd(20)} ${configs.toLocaleString()} configs, ${(sims / 1e6).toFixed(1)}M sims, ${((Date.now() - t0) / 1000).toFixed(0)}s     `);
  }
}

console.log(`\n\nPHASE 1: ${configs.toLocaleString()} configs, ${(sims / 1e6).toFixed(1)}M window sims in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`  parity verified on ${parity} sample configs`);
console.log(`  ${found.length.toLocaleString()} passed the 30% in-sample floor\n`);

found.sort((a, b) => worst(b) - worst(a));
console.log("TOP 30 AFTER PHASE 1 (worst half)\n");
console.log("  strategy             tf  session               regime             sl   tp lot     IS%    OOS%  worst");
for (const r of found.slice(0, 30)) {
  console.log(`  ${r.id.padEnd(20)} ${String(r.tf).padStart(2)}  ${r.session.padEnd(20)} ${r.regime.padEnd(18)} ${String(r.sl).padStart(3)} ${String(r.tp).padStart(4)} ${String(r.c).padStart(3)} ${r.is.toFixed(1).padStart(6)} ${r.oos.toFixed(1).padStart(7)} ${worst(r).toFixed(1).padStart(6)}`);
}

// ── which filter dimensions actually help? ──
function bestBy(key) {
  const m = new Map();
  for (const r of found) {
    const k = r[key];
    const w = worst(r);
    if (!m.has(k) || w > m.get(k)) m.set(k, w);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
console.log("\n\nBEST WORST-HALF BY SESSION WINDOW\n");
for (const [k, v] of bestBy("session")) console.log(`  ${k.padEnd(22)} ${v.toFixed(1).padStart(5)}%`);
console.log("\nBEST WORST-HALF BY REGIME GATE\n");
for (const [k, v] of bestBy("regime")) console.log(`  ${k.padEnd(22)} ${v.toFixed(1).padStart(5)}%`);
console.log("\nBEST WORST-HALF BY STRATEGY\n");
for (const [k, v] of bestBy("id").slice(0, 12)) console.log(`  ${k.padEnd(22)} ${v.toFixed(1).padStart(5)}%`);

// ───────────────────────── phase 2: refine ─────────────────────────
console.log("\n\nPHASE 2 — full bracket grid on the leaders\n");
const SLS = [0.75, 1, 1.5, 2, 2.5, 3, 4, 5];
const TPS = [0.4, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 6];
const LOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// Take the best distinct (strategy, tf, session, regime) combinations.
const seen = new Set(), leaders = [];
for (const r of found) {
  const key = `${r.id}|${r.tf}|${r.session}|${r.regime}`;
  if (seen.has(key)) continue;
  seen.add(key);
  leaders.push(r);
  if (leaders.length >= 25) break;
}

const refined = [];
for (const lead of leaders) {
  const tfBars = resample(bars, lead.tf);
  const ctx = buildFilterContext(tfBars);
  const strat = strategies.get(lead.id);
  const params = resolveParams(strat, { timeframeMin: lead.tf });
  const out = strat.compute(tfBars, params);
  const masked = applyFilters(out.sig, ctx, lead.filter);

  for (const sl of SLS) {
    for (const tp of TPS) {
      const exec = resolveExec({ ...EXEC_BASE, contracts: 1, slAtrMult: sl, tpAtrMult: tp });
      const { trades } = runBrackets(tfBars, masked, out.atr, exec);
      if (trades.length < 200) continue;
      const T = flatten(trades);
      for (const c of LOTS) {
        const is = fastSweep(T, IS, RULES, c);
        configs++; sims += IS.length;
        if (is.pass < 32) continue;
        const oos = fastSweep(T, OOS, RULES, c);
        sims += OOS.length;
        refined.push({ ...lead, sl, tp, c, is: is.pass, oos: oos.pass, trades: trades.length });
      }
    }
  }
  process.stdout.write(`\r  refining ${lead.id} ... ${configs.toLocaleString()} configs, ${(sims / 1e6).toFixed(1)}M sims    `);
}

refined.sort((a, b) => worst(b) - worst(a));
console.log(`\n\nTOP 30 AFTER PHASE 2\n`);
console.log("  strategy             tf  session               regime             sl   tp lot     IS%    OOS%  worst   trades");
for (const r of refined.slice(0, 30)) {
  console.log(`  ${r.id.padEnd(20)} ${String(r.tf).padStart(2)}  ${r.session.padEnd(20)} ${r.regime.padEnd(18)} ${String(r.sl).padStart(3)} ${String(r.tp).padStart(4)} ${String(r.c).padStart(3)} ${r.is.toFixed(1).padStart(6)} ${r.oos.toFixed(1).padStart(7)} ${worst(r).toFixed(1).padStart(6)} ${String(r.trades).padStart(8)}`);
}

const best = refined[0];
if (best) {
  console.log(`\n  BEST OVERALL: ${best.id} tf${best.tf}, ${best.session}, regime ${best.regime}, sl ${best.sl}xATR, tp ${best.tp}xATR, ${best.c} lots`);
  console.log(`                IS ${best.is.toFixed(1)}% / OOS ${best.oos.toFixed(1)}%  (worst ${worst(best).toFixed(1)}%)`);
  console.log(`\n  previous ceiling without filters was 37.2%`);
}

fs.writeFileSync("research/filter_results.json", JSON.stringify({
  meta: { configs, sims, isWindows: IS.length, oosWindows: OOS.length },
  phase1: found.slice(0, 500), phase2: refined.slice(0, 500),
}, null, 1));
console.log(`\n  TOTAL: ${sims.toLocaleString()} window simulations across ${configs.toLocaleString()} configurations`);
