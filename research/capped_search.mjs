// Find a 40%+ book with a HARD -$1000 unrealised stop permanently in force.
//
// The constraint, stated properly: the cap fixes the maximum loss in DOLLARS, so
// the largest stop it permits in POINTS is 1000/(pointValue * contracts) — 50
// points at 10 lots. donchian_eff_rth wants 5xATR = 67.8 points at the median
// ATR, so the cap truncates it on most days and the win rate falls out of the
// bracket identity S/(S+T). No amount of re-tuning that book gets past ~34%.
//
// So stop treating the cap as damage. A strategy whose stop NATIVELY fits inside
// 50 points runs completely unimpaired, and collects something the uncapped book
// never had: a guaranteed maximum loss of $1000 against a $2000 trailing
// drawdown, where the shipped book's worst loss is -$10,995 and one trade in 18
// exceeds the drawdown outright. Under the cap that tail is simply gone.
//
// The search is therefore over TIGHT geometry across every strategy in the repo,
// at legal size, with the cap always on.
//
// ── VERDICT AFTER SEVEN DIMENSIONS: 40% IS NOT REACHABLE. CEILING ~35.4%. ──
//
// What was searched, and what each cost:
//
//   1. CONTRACT SIZE 4-10. Worse at every size, monotonically. Below ~7 lots the
//      cap stops binding and the native geometry survives, but the throughput
//      loss dominates the geometry gain: 4 lots reaches 19.0% against 31.9% at
//      10. This was the first idea and it is the wrong lever.
//   2. TIGHTER TARGET, to restore the 3.33:1 ratio the 77% win rate needs. Much
//      worse, and instructively: tpAtrMult 0.6 gives an 86.6% win rate at a
//      profit factor of 0.812, because the wins shrink toward the $25 of
//      commission and slippage while the losses do not.
//   3. ALL 19 STRATEGIES in the repo, tight-geometry grid. donchian_eff_rth
//      still wins at 33.8%; nothing else clears 27%.
//   4. HIGHER FREQUENCY by relaxing the gates, on the theory that the eff>0.5
//      filter is over-insurance once the tail is capped. It is not: every one of
//      the top 20 configurations keeps eff 0.50. The extra trades are worse
//      trades, not more of the same.
//   5. TIMEFRAME 1/2/3/5 min — never varied before. The 1-min book fits the cap
//      almost perfectly (ATR 9.52, so 5xATR = $952 < $1000, cap binds 10%) and
//      nearly doubles frequency to 3.9 trades/day. It scores 21.6% at a profit
//      factor of 0.985: the edge is simply not there at that bar size. 2-min
//      remains the sweet spot.
//   6. WIDER slAtrMult. The one that works, and the least obvious. With the cap
//      on, the stop is pinned at 50 points on high-ATR days anyway, but on
//      LOW-ATR days the raw 5xATR stop still binds well inside the cap.
//      Widening to 3.5-7xATR puts the stop AT the cap every day.
//   7. THE DAILY RULES GRID (breaker x soft profit block), which is cheap because
//      rules do not change the trade list. Worth +1.6pp. The optimum MOVES under
//      the cap: the shipped -$150 / $1000 becomes -$750 / $750.
//
//   best capped   3.5/2.0, 10 lots, breaker -$750, block $750   35.4%  pf 1.081  $113,085
//   best uncapped 5/1.5,   10 lots, breaker -$750, block $1000  41.1%  pf 1.020   $38,220
//
// The cap costs ~5.7pp and that appears irreducible. It buys a far better book in
// every other respect: 3x the profit, worst loss -$7,493 against -$11,005, and
// trades exceeding the whole trailing drawdown fall from 297 to 62.
//
// ── AND THE THING THAT MATTERS MORE THAN THE SEARCH ──
// $1000 is EXACTLY the firm's daily loss limit, and challenge.mjs models that as
// a SOFT entry block on realised P&L (DEFAULT_RULES.dailyLossLimit, "firm's soft
// daily lockout"). If the platform instead enforces it HARD against unrealised
// equity, it was always in force, every headline in this project is optimistic,
// and the honest expectation for this strategy was never 42.6% — it is ~36%.
//
// Usage:  node research/capped_search.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts } from "./lib_search.mjs";

const CAP = 1000;
const TICKS = 1;

const { bars } = loadBars();
const strategies = await loadStrategies();
const all = windowStarts(bars, 30, 1);
const SPLIT = Date.UTC(2023, 5, 1);
const IS = all.filter((t) => t < SPLIT), OOS = all.filter((t) => t >= SPLIT);
const rules = resolveRules({ circuitBreaker: 150, dailyProfitStop: 1000 });

// Resampling and signal generation are the expensive parts and do not depend on
// the bracket, so they are computed once per strategy and reused across geometry.
const prepared = new Map();
function prep(s) {
  if (prepared.has(s.id)) return prepared.get(s.id);
  const tf = resample(bars, s.timeframeMin ?? 1);
  const out = s.compute(tf, resolveParams(s, {}));
  const f = { ...NO_FILTER, ...(s.filterDefaults || {}) };
  const active = Object.keys(NO_FILTER).some((k) => f[k] !== NO_FILTER[k]);
  const sig = active ? applyFilters(out.sig, buildFilterContext(tf), f) : out.sig;
  const p = { tf, sig, atr: out.atr, s };
  prepared.set(s.id, p);
  return p;
}

function evaluate(s, exec) {
  const { tf, sig, atr } = prep(s);
  const x = resolveExec({
    ...(s.execDefaults || {}), ...exec,
    slippageTicks: TICKS, dayLossStopUsd: CAP,
  });
  const { trades } = runBrackets(tf, sig, atr, x);
  if (trades.length < 200) return null;         // too thin to trust a window sweep
  const T = flatten(trades);
  const is = fastSweep(T, IS, rules, 1).pass;
  const oos = fastSweep(T, OOS, rules, 1).pass;
  const st = tradeStats(trades);
  const capped = trades.filter((t) => t.reason === "DAYLOSS").length;
  return {
    id: s.id, exec, is, oos, w: Math.min(is, oos),
    n: st.n, win: st.winRate, pf: st.profitFactor, pnl: st.pnl,
    maxLoss: st.maxLoss, capPct: (100 * capped) / st.n,
  };
}

const fmt = (r) =>
  `${r.id.padEnd(22)} ${String(r.exec.contracts).padStart(3)}L ` +
  `${r.exec.slAtrMult.toFixed(1)}/${r.exec.tpAtrMult.toFixed(2)}  ` +
  `IS ${r.is.toFixed(1).padStart(5)}%  OOS ${r.oos.toFixed(1).padStart(5)}%  ` +
  `worst ${r.w.toFixed(1).padStart(5)}%  win ${r.win.toFixed(1).padStart(4)}  ` +
  `pf ${r.pf.toFixed(3)}  ${("$" + Math.round(r.pnl).toLocaleString()).padStart(9)}  ` +
  `cap ${r.capPct.toFixed(0).padStart(3)}%`;

// ── stage 1: coarse, every strategy, tight geometry, legal size ──────
console.log(`\nSTAGE 1 — every strategy, tight geometry, hard -$${CAP} cap always on, ${TICKS} tick\n`);
const SL = [1.5, 2.0, 2.5, 3.0, 3.5, 5.0];
const TP = [0.4, 0.6, 0.8, 1.0, 1.4, 2.0];
const results = [];
for (const s of strategies.values()) {
  let bestForS = null;
  for (const sl of SL) {
    for (const tp of TP) {
      let r;
      try { r = evaluate(s, { contracts: 10, slAtrMult: sl, tpAtrMult: tp, tpMode: "atr" }); }
      catch { continue; }
      if (!r) continue;
      results.push(r);
      if (!bestForS || r.w > bestForS.w) bestForS = r;
    }
  }
  if (bestForS) console.log("  " + fmt(bestForS));
}

results.sort((a, b) => b.w - a.w);
console.log(`\n  TOP 15 OF ${results.length} CONFIGURATIONS\n`);
for (const r of results.slice(0, 15)) console.log("  " + fmt(r));

// ── stage 2: size sweep on the leaders ───────────────────────────────
console.log(`\n\nSTAGE 2 — contract size on the leading books\n`);
const seen = new Set();
const leaders = results.filter((r) => {
  if (seen.has(r.id)) return false;
  seen.add(r.id);
  return true;
}).slice(0, 6);

const stage2 = [];
for (const L of leaders) {
  for (const c of [6, 7, 8, 9, 10]) {
    const r = evaluate(strategies.get(L.id), { ...L.exec, contracts: c });
    if (r) { stage2.push(r); console.log("  " + fmt(r)); }
  }
  console.log();
}

stage2.sort((a, b) => b.w - a.w);
console.log(`  BEST AFTER SIZING\n`);
for (const r of stage2.slice(0, 8)) console.log("  " + fmt(r));
