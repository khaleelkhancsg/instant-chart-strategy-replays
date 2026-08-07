// Stage B + C: signal-parameter search on the survivors, then portfolios.
//
// Stage A searched execution only (stop, target, size) with every strategy at
// its default signal parameters. This takes whatever survived — ranked on the
// WORSE of in-sample and out-of-sample, so nothing gets in on one lucky half —
// and searches the signal itself, then tries combining books.
//
// PORTFOLIO MODEL. Running two books in one account means both can hold a
// position at the same time, so their sizes must add up to the firm's 10-lot cap.
// Trades are merged and replayed as a single account: same drawdown, same daily
// rules, same target. That is the honest model — it is one account, not two, so
// there is no free diversification on the daily limits.
//
// Run:  node --max-old-space-size=8192 research/mega_stage2.mjs

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { bracketGrid, flatten, fastSweep, windowStarts, DAY } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();
const RULES = resolveRules({});
const EXEC_BASE = { intradayOnly: true };

const prior = JSON.parse(fs.readFileSync("research/mega_results.json", "utf8"));
const SPLIT = prior.meta.splitMs;
const all = windowStarts(bars, RULES.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const worst = (r) => Math.min(r.isPass, r.oosPass);

// Best config per strategy, judged on the weaker half.
const bestPer = new Map();
for (const r of prior.results) {
  const cur = bestPer.get(r.id);
  if (!cur || worst(r) > worst(cur)) bestPer.set(r.id, r);
}
const ranked = [...bestPer.values()].sort((a, b) => worst(b) - worst(a));
console.log("Carried forward from stage A (ranked on the weaker half):\n");
for (const r of ranked) {
  console.log(`  ${r.id.padEnd(20)} tf${String(r.tf).padStart(2)} sl${String(r.sl).padStart(4)} tp${String(r.tp).padStart(5)} ${String(r.c).padStart(2)}lot   IS ${r.isPass.toFixed(1).padStart(5)}%  OOS ${r.oosPass.toFixed(1).padStart(5)}%  worst ${worst(r).toFixed(1)}%`);
}

// ───────────────────── stage B: signal parameters ─────────────────────
// Per-strategy sweeps of the parameters most likely to matter, kept small
// because each one multiplies against the bracket grid.
const SIGNAL_SWEEPS = {
  orb: { orStartCt: [7 * 60 + 30, 8 * 60 + 30], orEndCt: [8 * 60 + 45, 9 * 60, 9 * 60 + 30, 10 * 60], entryEndCt: [11 * 60, 13 * 60, 14 * 60], minRangePts: [0, 10, 25], direction: ["break", "fade"] },
  prior_day_break: { direction: ["break", "reject"], bufferAtrMult: [0, 0.15, 0.4], startCt: [7 * 60, 8 * 60 + 30], endCt: [11 * 60, 13 * 60 + 30], onePerSide: ["one", "many"] },
  gap_fade: { direction: ["fade", "drive"], minGapAtr: [0.5, 1, 2], maxGapAtr: [0, 4], entryCt: [7 * 60, 8 * 60 + 30], windowMins: [30, 60, 120] },
  tpl_channel: { period: [10, 20, 30, 50, 80], adxMin: [0, 15, 25, 35], direction: ["breakout", "fade"], channel: ["donchian", "keltner"] },
  tpl_oscillator: { period: [7, 14, 28], upper: [65, 70, 80], lower: [35, 30, 20], direction: ["fade", "follow"], trigger: ["level", "crossback"], osc: ["rsi", "stoch"] },
  tpl_ma_cross: { fast: [5, 9, 20], slow: [21, 50, 100], mode: ["cross", "state"], adxMin: [0, 25] },
  momentum_roc: { lookback: [6, 12, 24, 48], threshold: [0.1, 0.25, 0.5], direction: ["follow", "fade"] },
  vwap_fade: { devMin: [0.5, 1, 1.5, 2], adxMax: [0, 20, 30], direction: ["fade", "follow"] },
  session_range_fade: { buildUntilCt: [9 * 60, 10 * 60], pokeAtrMult: [0.1, 0.25, 0.5], requireReject: ["on", "off"], minRangeAtr: [0, 3, 6] },
  macd_cross: { fast: [8, 12, 20], slow: [21, 26, 50], mode: ["cross", "zero"], requireSlope: ["off", "on"] },
  triple_ema: { fast: [3, 5, 9], mid: [13, 21], slow: [50, 100], mode: ["enter", "state"] },
  supertrend: { period: [7, 10, 20], mult: [2, 3, 4], flipOnly: ["flip", "state"] },
  adx_di_trend: { period: [7, 14, 28], adxMin: [15, 25, 35], diCrossOnly: ["cross", "state"] },
  zscore_fade: { zLookback: [20, 50, 100], zEntry: [1.5, 2, 2.5], adxMax: [20, 25, 35] },
  trend_neutev: { donchian: [15, 30, 50], adxMin: [15, 20, 25, 32] },
  trend_vol_adaptive: { donchian: [30, 50, 80], adxMin: [15, 20, 25] },
};

function combos(spec) {
  const keys = Object.keys(spec);
  let out = [{}];
  for (const k of keys) {
    const next = [];
    for (const base of out) for (const v of spec[k]) next.push({ ...base, [k]: v });
    out = next;
  }
  return out;
}

const SLS = [0.5, 0.75, 1, 1.5, 2, 3];
const TPS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 9];
const CONTRACTS = [2, 3, 4, 5, 6, 7, 8, 9, 10];

let sims = 0, configs = 0;
const stageB = [];
const t0 = Date.now();

// Search every strategy that has a sweep defined, not just the leaders — a book
// that looked poor at default parameters may simply have had poor defaults.
for (const [id, strat] of strategies) {
  const spec = SIGNAL_SWEEPS[id];
  if (!spec) continue;
  const seed = bestPer.get(id);
  const tfList = seed ? [seed.tf] : [5];
  const paramSets = combos(spec);

  for (const tf of tfList) {
    for (const ps of paramSets) {
      const params = resolveParams(strat, { ...ps, timeframeMin: tf });
      let grid;
      try { grid = bracketGrid(bars, strat, params, SLS, TPS, EXEC_BASE); }
      catch { continue; }

      for (const g of grid) {
        if (g.trades.length < 150) continue;
        const T = flatten(g.trades);
        for (const c of CONTRACTS) {
          const is = fastSweep(T, IS, RULES, c);
          configs++; sims += IS.length;
          if (is.pass < 30) continue;
          const oos = fastSweep(T, OOS, RULES, c);
          sims += OOS.length;
          stageB.push({ id, tf, ps, sl: g.sl, tp: g.tp, c, isPass: is.pass, oosPass: oos.pass, trades: g.trades.length });
        }
      }
    }
    process.stdout.write(`\r  ${id} — ${configs.toLocaleString()} configs, ${(sims / 1e6).toFixed(2)}M sims, ${((Date.now() - t0) / 1000).toFixed(0)}s      `);
  }
}
console.log(`\n\nSTAGE B: ${configs.toLocaleString()} configs, ${(sims / 1e6).toFixed(2)}M window sims\n`);

const bTop = stageB.filter((r) => r.oosPass >= 30).sort((a, b) => worst(b) - worst(a));
console.log("TOP 30 BY WORST HALF\n");
console.log("  strategy             tf   sl    tp  lot    IS%    OOS%  worst  trades  params");
for (const r of bTop.slice(0, 30)) {
  console.log(`  ${r.id.padEnd(20)} ${String(r.tf).padStart(2)} ${String(r.sl).padStart(4)} ${String(r.tp).padStart(5)} ${String(r.c).padStart(4)} ${r.isPass.toFixed(1).padStart(6)} ${r.oosPass.toFixed(1).padStart(7)} ${worst(r).toFixed(1).padStart(6)} ${String(r.trades).padStart(7)}  ${JSON.stringify(r.ps)}`);
}

// ───────────────────── stage C: portfolios ─────────────────────
console.log("\n\nSTAGE C — pairs of books sharing one account (sizes must total <= 10 lots)\n");

// Rebuild trade lists for the top distinct strategies.
const finalists = [];
const seen = new Set();
for (const r of bTop) {
  if (seen.has(r.id)) continue;
  seen.add(r.id);
  finalists.push(r);
  if (finalists.length >= 6) break;
}

const books = [];
for (const r of finalists) {
  const strat = strategies.get(r.id);
  const params = resolveParams(strat, { ...r.ps, timeframeMin: r.tf });
  const g = bracketGrid(bars, strat, params, [r.sl], [r.tp], EXEC_BASE)[0];
  books.push({ ...r, trades: g.trades });
}

// Merge two trade lists into one account, entry-sorted, each scaled to its size.
function mergeBooks(a, ca, b, cb) {
  const out = [];
  for (const t of a.trades) out.push({ ...t, pnl: t.pnl * ca, mae: t.mae * ca, mfe: t.mfe * ca });
  for (const t of b.trades) out.push({ ...t, pnl: t.pnl * cb, mae: t.mae * cb, mfe: t.mfe * cb });
  out.sort((x, y) => x.entryTime - y.entryTime);
  return out;
}

const portfolios = [];
for (let i = 0; i < books.length; i++) {
  for (let j = i + 1; j < books.length; j++) {
    for (const ca of [2, 3, 4, 5, 6, 7, 8]) {
      for (const cb of [2, 3, 4, 5, 6, 7, 8]) {
        if (ca + cb > 10) continue;
        const merged = mergeBooks(books[i], ca, books[j], cb);
        const T = flatten(merged);
        const is = fastSweep(T, IS, RULES, 1);
        configs++; sims += IS.length;
        if (is.pass < 30) continue;
        const oos = fastSweep(T, OOS, RULES, 1);
        sims += OOS.length;
        portfolios.push({ a: books[i].id, ca, b: books[j].id, cb, isPass: is.pass, oosPass: oos.pass, trades: merged.length });
      }
    }
  }
}
portfolios.sort((x, y) => worst(y) - worst(x));
console.log("  book A                lots  book B                lots     IS%    OOS%  worst");
for (const p of portfolios.slice(0, 20)) {
  console.log(`  ${p.a.padEnd(20)} ${String(p.ca).padStart(4)}  ${p.b.padEnd(20)} ${String(p.cb).padStart(4)} ${p.isPass.toFixed(1).padStart(7)} ${p.oosPass.toFixed(1).padStart(7)} ${worst(p).toFixed(1).padStart(6)}`);
}

const bestSingle = bTop.length ? worst(bTop[0]) : 0;
const bestPort = portfolios.length ? worst(portfolios[0]) : 0;
console.log(`\n  best single book : ${bestSingle.toFixed(1)}% (worst half)`);
console.log(`  best portfolio   : ${bestPort.toFixed(1)}% (worst half)`);
console.log(`  combining ${bestPort > bestSingle ? "HELPS" : "does not help"}`);

fs.writeFileSync("research/stage2_results.json", JSON.stringify({
  meta: { sims, configs }, stageB: bTop.slice(0, 400), portfolios: portfolios.slice(0, 200),
}, null, 1));
console.log(`\n  TOTAL stage B+C: ${sims.toLocaleString()} window simulations across ${configs.toLocaleString()} configurations`);
