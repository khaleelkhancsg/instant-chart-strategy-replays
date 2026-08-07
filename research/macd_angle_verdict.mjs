// MACD-Angle v4: what is it worth with causal execution?
//
// Established already:
//   - The signal port is EXACT: 885,130 overlapping 2-min bars, 224,952 non-zero
//     signals on each side, zero disagreements.
//   - The original's reported pf 1.373 reproduces here ONLY with same-bar
//     re-entry enabled, i.e. opening a new position at a bar's OPEN after having
//     been stopped out later inside that same bar.
//
// So the question is not "is the port right" but "how much of the edge survives
// requiring the re-entry to happen at a price that comes AFTER the exit".

import { loadBars } from "../src/data.mjs";
import strat from "../strategies/macd_angle_v4.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { resolveExec, tradeStats } from "../src/engine.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { flatten, fastSweep, assertParity, windowStarts } from "./lib_search.mjs";

const { bars } = loadBars();
const RULES = resolveRules({});
const SPLIT = Date.UTC(2023, 5, 1);
const all = windowStarts(bars, RULES.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const params = resolveParams(strat, {});

const BASE = {
  contracts: 1, sizingMode: "fixed", slAtrMult: 1.5, tpMode: "rr", tpRR: 1.2,
  flipOnOpposite: false, cooldownAfterStopMins: 0, intradayOnly: true,
  noEntryMinsBeforeFlat: 10, commissionModel: "per-contract", commissionPerSide: 0.75,
};

for (const [label, reentry] of [["CAUSAL (re-entry must follow the exit)", false],
                                ["NON-CAUSAL (same-bar re-entry, as the original)", true]]) {
  const exec = resolveExec({ ...BASE, sameBarReentry: reentry });
  const run = runStrategy(bars, strat, params, exec);
  const st = tradeStats(run.trades);
  console.log(`\n${label}`);
  console.log(`  ${st.n.toLocaleString()} trades, ${st.tradesPerDay.toFixed(1)}/day, pf ${st.profitFactor.toFixed(3)}, exp $${st.expectancy.toFixed(2)}, win ${st.winRate.toFixed(1)}%`);
  assertParity(run.trades, IS.slice(0, 300), RULES, 3);
  const T = flatten(run.trades);
  console.log(`  lots    IS pass   OOS pass    worst`);
  let best = null;
  for (let c = 1; c <= 10; c++) {
    const is = fastSweep(T, IS, RULES, c);
    const oos = fastSweep(T, OOS, RULES, c);
    const w = Math.min(is.pass, oos.pass);
    if (!best || w > best.w) best = { c, is: is.pass, oos: oos.pass, w };
    console.log(`  ${String(c).padStart(4)} ${is.pass.toFixed(1).padStart(9)}% ${oos.pass.toFixed(1).padStart(9)}% ${w.toFixed(1).padStart(8)}%`);
  }
  console.log(`  BEST: ${best.c} lots -> IS ${best.is.toFixed(1)}% / OOS ${best.oos.toFixed(1)}% (worst ${best.w.toFixed(1)}%)`);
}
