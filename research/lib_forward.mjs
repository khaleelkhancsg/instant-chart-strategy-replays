// Per-entry forward simulation.
//
// State-dependent GEOMETRY cannot use the contracts-are-a-multiplier trick,
// because changing the stop or target changes when the trade exits, and that
// changes when the next one can start. So instead of one path through the bars,
// this precomputes, for every signal bar, what WOULD have happened under each
// candidate geometry — independent of any other trade.
//
// The replay can then choose a geometry per entry from live challenge state and
// jump to that trade's own exit bar. One position at a time is still enforced;
// what varies is which exit rule was in force.
//
// Each entry is resolved by the ONE engine (src/engine.mjs) as an exogenous
// market entry, with the conventions these tables were built under: checks from
// the bar after the entry, orders filled at their own price, no costs (P&L is
// per lot, gross). test/legacy_parity.mjs holds it to the code it replaced.

import { runBrackets } from "../src/engine.mjs";
import { sliceBars } from "../src/resample.mjs";

const FORWARD_EXEC = {
  entryBarExits: false, tpGapFill: "level", sessionEndFlat: "none", closeAtEnd: true, untilFlat: true,
  slippageTicks: 0, commissionModel: "per-contract", commissionPerSide: 0, flipOnOpposite: false,
  dayLossStopUsd: 0, dayProfitStopUsd: 0, maxBarsInTrade: 0,
};
const zeros = new Map();   // a flat signal per bar count, shared across calls

/**
 * Simulate a single trade forward from the open of bar `i`.
 *
 * @param plan {sl, tp, t1, t1Frac} — sl/tp as ATR multiples. If `t1` is set, that
 *        fraction of the position is banked at the nearer target and the rest
 *        runs to `tp`, with the stop left where it was.
 * @returns { exitIdx, pnl (per lot, gross of fees), reason }
 */
export function simulateEntry(bars, i, dir, atrVal, plan, session, pv = 2) {
  const n = bars.close.length;
  if (!zeros.has(n)) zeros.set(n, new Int8Array(n));
  const s0 = Math.max(0, i - 1);
  const t1Pts = plan.t1 > 0 ? Math.max(atrVal * plan.t1, 0.25) : 0;
  const { trades } = runBrackets(sliceBars(bars, s0, n), zeros.get(n), new Float64Array(0), {
    ...FORWARD_EXEC, pointValue: pv,
    // Session flatten outranks the bracket.
    intradayOnly: !!session, flattenCt: session ? session.flattenCt : 0, reopenCt: session ? session.reopenCt : 0,
    entries: [{ bar: i - s0, dir, slPts: Math.max(atrVal * plan.sl, 0.25), tpPts: Math.max(atrVal * plan.tp, 0.25),
                lots: 1, t1Pts, t1Frac: plan.t1Frac || 0 }],
  });
  const t = trades[0];
  return { exitIdx: s0 + t.exitIdx, pnl: t.gross, reason: t.reason };
}

/**
 * Build the outcome table: for every signal bar, the result under each plan.
 * Returns { bars: Int32Array of signal bar indices, dir, outcomes[planIdx] }.
 */
export function buildOutcomeTable(bars, sig, atrArr, plans, session, pv = 2) {
  const idx = [];
  for (let i = 1; i < sig.length - 1; i++) {
    if (sig[i] !== 0 && Number.isFinite(atrArr[i]) && atrArr[i] > 0) idx.push(i);
  }
  const entryBar = new Int32Array(idx.length);
  const dir = new Int8Array(idx.length);
  for (let k = 0; k < idx.length; k++) { entryBar[k] = idx[k] + 1; dir[k] = sig[idx[k]]; }

  const outcomes = plans.map(() => ({
    exitIdx: new Int32Array(idx.length),
    pnl: new Float64Array(idx.length),
  }));
  for (let p = 0; p < plans.length; p++) {
    for (let k = 0; k < idx.length; k++) {
      const r = simulateEntry(bars, entryBar[k], dir[k], atrArr[idx[k]], plans[p], session, pv);
      outcomes[p].exitIdx[k] = r.exitIdx;
      outcomes[p].pnl[k] = r.pnl;
    }
  }
  return { entryBar, dir, outcomes, count: idx.length };
}
