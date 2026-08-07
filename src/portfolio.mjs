// Event-driven replay for MULTIPLE books sharing one account. ISOMORPHIC.
//
// WHY THIS EXISTS. replayWindow assumes trades are sequential: it credits P&L in
// entry order and treats a soft-stopped trade as never happening. Both are right
// when only one position is ever open. Neither survives overlap — feeding it a
// merged trade list lets the daily rules truncate what is really one position,
// which measurably turned 32% into 81% on identical trades. That was an artefact
// and this module exists so the question can be asked properly.
//
// The fix is to stop treating a trade as an atomic point and model it as two
// events at different times:
//
//   ENTRY  decided against the day's REALISED P&L so far (open trades have not
//          settled, so they cannot count toward a daily stop) and against the
//          contracts currently open (the firm's cap applies to the ACCOUNT, so
//          two books cannot each hold 8 lots).
//   EXIT   realises P&L, moves the equity, and only then can breach or pass.
//
// Processing both in strict time order is what makes a pooled book honest.

import { resolveRules, OUTCOME } from "./challenge.mjs";

const DAY = 86400000;

/**
 * @param books  [{ trades, contracts }] — each trade at 1 lot, scaled by contracts
 * @param startMs window start
 * @param rules   see DEFAULT_RULES
 * @param opts.maxContracts  account-wide cap on simultaneously open contracts
 * @param opts.onCapBreach   'skip' (default) or 'shrink' to take a smaller size
 */
export function replayPortfolio(books, startMs, rules = {}, opts = {}) {
  const R = resolveRules(rules);
  const cap = opts.maxContracts ?? R.maxContracts ?? 10;
  const shrink = opts.onCapBreach === "shrink";
  const endMs = startMs + R.windowDays * DAY;
  const capPct = R.consistencyPct / 100;
  const eodTrail = R.trailingMode === "eod";

  // One ENTRY event per candidate trade; the matching EXIT is only scheduled if
  // the entry is actually taken.
  const entries = [];
  for (let b = 0; b < books.length; b++) {
    for (const t of books[b].trades) {
      if (t.entryTime < startMs || t.entryTime >= endMs) continue;
      entries.push({ b, t, size: books[b].contracts });
    }
  }
  entries.sort((x, y) => x.entryTime - y.entryTime || 0);
  entries.sort((x, y) => x.t.entryTime - y.t.entryTime);

  const openTrades = [];       // { exitTime, pnl, size, tday }
  let cum = 0, peak = 0, eodPeak = 0, locked = false;
  let curDay = null, dayPnl = 0, maxDayPnl = 0, tradingDays = 0, dayHadTrade = false;
  let openContracts = 0;
  let taken = 0, skippedRules = 0, skippedCap = 0;

  const closeDay = () => {
    if (curDay === null || !eodTrail) return;
    if (cum > eodPeak) eodPeak = cum;
    if (R.lockAtBreakeven && !locked && eodPeak >= R.trailingDD) locked = true;
  };
  const floorNow = () => (locked ? 0 : (eodTrail ? eodPeak : peak) - R.trailingDD);

  // Settle every position that closed at or before `ts`, in exit order.
  // Returns an outcome code if the account resolved while settling.
  function settleUntil(ts) {
    openTrades.sort((a, b) => a.exitTime - b.exitTime);
    while (openTrades.length && openTrades[0].exitTime <= ts) {
      // Positions closing at the SAME instant are one equity event. Settling
      // them one at a time would let the account breach on a fraction of a loss
      // it actually took in full — the very artefact this module exists to avoid.
      const at = openTrades[0].exitTime;
      let batchPnl = 0, batchDay = openTrades[0].tday;
      while (openTrades.length && openTrades[0].exitTime === at) {
        const p = openTrades.shift();
        openContracts -= p.size;
        batchPnl += p.pnl * p.size;
        batchDay = p.tday;
      }
      if (batchDay !== curDay) { closeDay(); curDay = batchDay; dayPnl = 0; dayHadTrade = false; }
      cum += batchPnl; dayPnl += batchPnl;
      if (dayPnl > maxDayPnl) maxDayPnl = dayPnl;
      if (!eodTrail) {
        if (cum > peak) peak = cum;
        if (R.lockAtBreakeven && !locked && peak >= R.trailingDD) locked = true;
      }
      if (cum <= floorNow()) return { code: -1, at };
      if (cum >= R.profitTarget && (!R.consistencyGatesPass || maxDayPnl <= capPct * cum) && tradingDays >= R.minTradingDays) {
        return { code: 1, at };
      }
    }
    return null;
  }

  for (const e of entries) {
    // Everything that closed before this entry must settle first, so the daily
    // state the entry is judged against is the state that actually existed.
    const res = settleUntil(e.t.entryTime);
    if (res) return finish(res.code, res.at);

    if (e.t.tday !== curDay && openTrades.length === 0) {
      closeDay(); curDay = e.t.tday; dayPnl = 0; dayHadTrade = false;
    }

    // Daily soft stops, judged on REALISED P&L only.
    if ((R.dailyProfitStop > 0 && dayPnl >= R.dailyProfitStop) ||
        (R.circuitBreaker > 0 && dayPnl <= -R.circuitBreaker) ||
        (R.dailyLossLimit > 0 && dayPnl <= -R.dailyLossLimit)) {
      skippedRules++;
      continue;
    }

    // Account-wide contract cap across every open position.
    let size = e.size;
    if (openContracts + size > cap) {
      if (!shrink) { skippedCap++; continue; }
      size = cap - openContracts;
      if (size <= 0) { skippedCap++; continue; }
    }

    if (!dayHadTrade) { dayHadTrade = true; tradingDays++; }
    taken++;
    openContracts += size;
    openTrades.push({ exitTime: e.t.exitTime, pnl: e.t.pnl, size, tday: e.t.tday });
  }

  const res = settleUntil(Infinity);
  if (res) return finish(res.code, res.at);
  return finish(0, null);

  function finish(code, at) {
    return {
      outcome: code === 1 ? OUTCOME.PASS : code === -1 ? OUTCOME.FAIL : OUTCOME.OPEN,
      resolvedMs: at, netPnl: cum, taken, skippedRules, skippedCap,
      tradingDays, maxDayPnl,
    };
  }
}

export function sweepPortfolio(books, starts, rules = {}, opts = {}) {
  let pass = 0, fail = 0;
  for (const s of starts) {
    const o = replayPortfolio(books, s, rules, opts).outcome;
    if (o === OUTCOME.PASS) pass++; else if (o === OUTCOME.FAIL) fail++;
  }
  const n = starts.length || 1;
  return { pass: (pass / n) * 100, fail: (fail / n) * 100 };
}
