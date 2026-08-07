// The frequency/quality frontier, measured rather than assumed.
//
// The working assumption all along has been that loosening a gate raises
// frequency but dilutes edge, so tight gates win. The pooling run just cast
// doubt on that: the book with the LOWEST profit factor of the qualifying set
// (tpl_channel/2, pf 1.047) had the HIGHEST pass rate, because it trades
// 2.03x/day against 0.72 for the highest-pf book.
//
// So the question is not "does loosening dilute edge" — it does — but "at what
// point does the dilution stop paying for the extra trades". That is an
// empirical frontier and this maps it: sweep the gate from wide open to very
// tight, and plot frequency, profit factor and pass rate together.
//
// Why frequency should matter at all: a 30-day window is a fixed deadline. An
// edge cannot express itself in 20 trades the way it can in 60. Pass rate is a
// first-passage probability, and first passage needs samples.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts, DAY } from "./lib_search.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies();
const RULES = resolveRules({ circuitBreaker: 150, dailyProfitStop: 750 });
const SPLIT = Date.UTC(2023, 5, 1);
const all = windowStarts(bars, RULES.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const worst = (a, b) => Math.min(a, b);
const spanDays = (bars.ts[bars.count - 1] - bars.ts[0]) / DAY;

const SESSIONS = [[0, 1440, "24h"], [510, 900, "RTH"], [510, 660, "08:30-11"]];
const EFFS = [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
const BOOKS = [["tpl_channel", 2, 5, 1.5], ["tpl_channel", 5, 5, 1.5], ["momentum_roc", 2, 5, 1.5], ["macd_angle_v4", 2, 5, 1.25]];

const cache = new Map();
const rows = [];

console.log("THE FRONTIER — loosen the gate, watch frequency rise and edge fall\n");
for (const [id, tf, sl, tp] of BOOKS) {
  if (!strategies.has(id)) continue;
  let c = cache.get(tf);
  if (!c) { const b = resample(bars, tf); c = { b, ctx: buildFilterContext(b) }; cache.set(tf, c); }
  const strat = strategies.get(id);
  const out = strat.compute(c.b, resolveParams(strat, { timeframeMin: tf }));

  console.log(`\n${id} tf${tf}, sl${sl}/tp${tp}\n`);
  console.log("  session    eff    trades   /day      pf   exp$/lot   lots    IS%    OOS%  worst");
  for (const [s0, s1, sLabel] of SESSIONS) {
    for (const eff of EFFS) {
      const masked = applyFilters(out.sig, c.ctx, { ...NO_FILTER, startCt: s0, endCt: s1, effMin: eff });
      const { trades } = runBrackets(c.b, masked, out.atr, resolveExec({
        intradayOnly: true, sameBarReentry: false, noEntryMinsBeforeFlat: 10,
        contracts: 1, slAtrMult: sl, tpAtrMult: tp,
      }));
      if (trades.length < 150) continue;
      const st = tradeStats(trades);
      const T = flatten(trades);
      let best = null;
      for (const lots of [6, 8, 10]) {
        const is = fastSweep(T, IS, RULES, lots), oos = fastSweep(T, OOS, RULES, lots);
        const r = { lots, is: is.pass, oos: oos.pass, w: worst(is.pass, oos.pass) };
        if (!best || r.w > best.w) best = r;
      }
      const row = { id, tf, session: sLabel, eff, n: trades.length, perDay: trades.length / spanDays,
                    pf: st.profitFactor, exp: st.expectancy, ...best };
      rows.push(row);
      console.log(
        `  ${sLabel.padEnd(9)} ${String(eff).padEnd(5)} ${String(trades.length).padStart(7)} ${row.perDay.toFixed(2).padStart(6)} ` +
        `${st.profitFactor.toFixed(3).padStart(7)} ${st.expectancy.toFixed(2).padStart(9)} ${String(best.lots).padStart(6)} ` +
        `${best.is.toFixed(1).padStart(6)} ${best.oos.toFixed(1).padStart(7)} ${best.w.toFixed(1).padStart(6)}`
      );
    }
  }
}

// ── what actually predicts pass rate? ──
console.log("\n\nWHAT PREDICTS PASS RATE — profit factor, or trades per day?\n");
const ok = rows.filter((r) => r.pf > 0.9);
function corr(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, v) => a + v, 0) / n, my = ys.reduce((a, v) => a + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}
const w = ok.map((r) => r.w);
console.log(`  correlation of worst-half pass rate with profit factor : ${corr(ok.map((r) => r.pf), w).toFixed(3)}`);
console.log(`  correlation with trades per day                        : ${corr(ok.map((r) => r.perDay), w).toFixed(3)}`);
console.log(`  correlation with expectancy per lot                    : ${corr(ok.map((r) => r.exp), w).toFixed(3)}`);
console.log(`  correlation with (expectancy x trades/day) i.e. $/day   : ${corr(ok.map((r) => r.exp * r.perDay), w).toFixed(3)}`);
console.log(`\n  (${ok.length} configurations)`);

rows.sort((a, b) => b.w - a.w);
console.log("\n\nBEST OVERALL\n");
console.log("  book                 tf  session    eff   /day      pf   lots    IS%    OOS%  worst");
for (const r of rows.slice(0, 12)) {
  console.log(`  ${r.id.padEnd(20)} ${String(r.tf).padStart(2)}  ${r.session.padEnd(9)} ${String(r.eff).padEnd(4)} ${r.perDay.toFixed(2).padStart(6)} ${r.pf.toFixed(3).padStart(7)} ${String(r.lots).padStart(6)} ${r.is.toFixed(1).padStart(6)} ${r.oos.toFixed(1).padStart(7)} ${r.w.toFixed(1).padStart(6)}`);
}

fs.writeFileSync("research/frontier_results.json", JSON.stringify(rows.slice(0, 200), null, 1));
