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

import { EXIT } from "../src/engine.mjs";

/**
 * Simulate a single trade forward from the open of bar `i`.
 *
 * @param plan {sl, tp, t1, t1Frac} — sl/tp as ATR multiples. If `t1` is set, that
 *        fraction of the position is banked at the nearer target and the rest
 *        runs to `tp`, with the stop left where it was.
 * @returns { exitIdx, pnl (per lot, gross of fees), reason }
 */
export function simulateEntry(bars, i, dir, atrVal, plan, session, pv = 2) {
  const { open: O, high: H, low: L, close: C, ctMin } = bars;
  const n = C.length;
  const ep = O[i];
  const slDist = Math.max(atrVal * plan.sl, 0.25);
  const tpDist = Math.max(atrVal * plan.tp, 0.25);
  const t1Dist = plan.t1 > 0 ? Math.max(atrVal * plan.t1, 0.25) : 0;

  const sl = dir === 1 ? ep - slDist : ep + slDist;
  const tp = dir === 1 ? ep + tpDist : ep - tpDist;
  const t1 = t1Dist > 0 ? (dir === 1 ? ep + t1Dist : ep - t1Dist) : 0;

  let banked = 0;          // points already realised from the scaled-out portion
  let remaining = 1;       // fraction of the position still open
  const frac = plan.t1Frac || 0;

  for (let k = i + 1; k < n; k++) {
    // Session flatten outranks the bracket.
    if (session && ctMin) {
      const ct = ctMin[k];
      const flat = session.reopenCt > session.flattenCt
        ? ct >= session.flattenCt && ct < session.reopenCt
        : ct >= session.flattenCt || ct < session.reopenCt;
      if (flat) {
        const px = O[k];
        return { exitIdx: k, pnl: (banked + (px - ep) * dir * remaining) * pv, reason: EXIT.FLAT };
      }
    }
    // Stop before target, and a gap through the stop fills at the open.
    if (dir === 1) {
      if (O[k] <= sl) return { exitIdx: k, pnl: (banked + (O[k] - ep) * remaining) * pv, reason: EXIT.SL };
      if (L[k] <= sl) return { exitIdx: k, pnl: (banked + (sl - ep) * remaining) * pv, reason: EXIT.SL };
      if (t1 && remaining === 1 && H[k] >= t1) {
        banked += (t1 - ep) * frac;
        remaining = 1 - frac;
      }
      if (H[k] >= tp) return { exitIdx: k, pnl: (banked + (tp - ep) * remaining) * pv, reason: EXIT.TP };
    } else {
      if (O[k] >= sl) return { exitIdx: k, pnl: (banked + (ep - O[k]) * remaining) * pv, reason: EXIT.SL };
      if (H[k] >= sl) return { exitIdx: k, pnl: (banked + (ep - sl) * remaining) * pv, reason: EXIT.SL };
      if (t1 && remaining === 1 && L[k] <= t1) {
        banked += (ep - t1) * frac;
        remaining = 1 - frac;
      }
      if (L[k] <= tp) return { exitIdx: k, pnl: (banked + (ep - tp) * remaining) * pv, reason: EXIT.TP };
    }
  }
  const px = C[n - 1];
  return { exitIdx: n - 1, pnl: (banked + (px - ep) * dir * remaining) * pv, reason: EXIT.EOD };
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
