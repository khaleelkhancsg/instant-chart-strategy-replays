// Bracket execution engine. ISOMORPHIC — this exact file runs on the server for
// full-history sweeps and in the browser for live parameter previews.
//
// Causality: a signal is confirmed at the CLOSE of bar i-1 and filled at the
// OPEN of bar i. There is no path by which bar i's high/low/close can influence
// the decision to be in the trade — that lookahead bug is the single most common
// way a backtest lies, so the ordering here is deliberate and load-bearing.
//
// Within-bar fill priority: stop before target. When both levels sit inside one
// bar's range we cannot know which printed first, so we assume the loss. A gap
// straight through the stop fills at the open, not the stop price.
//
// Flip semantics (matches the validated lite_backtester engine — do not "tidy"):
// an opposite signal while in a position closes at this bar's open AND may
// re-enter on the same bar. A stop/target exit, by contrast, ends the bar.

export const EXIT = { SL: "SL", TP: "TP", FLIP: "FLIP", EOD: "EOD", TIME: "TIME", FLAT: "FLAT", DAYCAP: "DAYCAP", DAYLOSS: "DAYLOSS" };

// Intraday-only session rules, in America/Chicago minutes-of-day.
//
// Many prop firms forbid holding overnight: you must be flat by a stated time
// and may not re-enter until the session reopens. This is not a cosmetic filter —
// it truncates exactly the long-running winners that a wide reward:risk target
// depends on, so a book tuned without it will not survive being held to it.
export const SESSION = {
  flattenCt: 15 * 60 + 5,   // 3:05 PM CT — all positions closed
  reopenCt: 17 * 60,        // 5:00 PM CT — trading may resume
};

// True while positions must be flat: from the flatten time until the reopen.
// The two bounds sit inside the same calendar day here (15:05 -> 17:00), so a
// plain range test is correct; a rule that wrapped past midnight would not be.
function inFlatWindow(ctMin, flattenCt, reopenCt) {
  return reopenCt > flattenCt
    ? ctMin >= flattenCt && ctMin < reopenCt
    : ctMin >= flattenCt || ctMin < reopenCt;
}

export const DEFAULT_EXEC = {
  contracts: 8,
  // Sizing mode. 'fixed' trades a constant contract count, so the DOLLAR risk of
  // a trade rises and falls with volatility. 'risk' instead holds dollar risk
  // constant by sizing against the stop distance — which matters a great deal
  // against a fixed drawdown limit, since MNQ's 5-min ATR ranges from ~6 points
  // (2019) to ~28 (2026) and a fixed size that survives one era is either
  // suicidal or inert in the other.
  sizingMode: "fixed",      // 'fixed' | 'risk'
  riskDollars: 400,         // target loss per stop-out when sizingMode = 'risk'
  maxContracts: 10,         // firm cap; also bounds 'risk' sizing
  tickSize: 0.25,
  pointValue: 2.0,          // MNQ: $2 per index point per contract
  // Commission: 'per-contract' is what a broker actually charges. The legacy
  // lite_backtester runs used a FLAT $5/trade, which understates cost by ~2-3x
  // at 8-10 lots — if you are comparing numbers to those runs, switch to 'flat'.
  commissionModel: "per-contract",
  commissionPerSide: 0.75,  // $/contract/side -> $1.50 round trip per contract
  commissionFlat: 5.0,      // $/trade round trip, used when model === 'flat'
  slippageTicks: 0,         // adverse ticks applied to BOTH entry and exit fills
  slAtrMult: 2.0,
  tpAtrMult: 12.0,
  // Target sizing. 'atr' sets it from ATR directly; 'rr' sets it as a multiple
  // of the STOP distance, so the reward:risk ratio stays fixed as volatility
  // moves. Books tuned on R:R geometry cannot be reproduced with 'atr'.
  tpMode: "atr",            // 'atr' | 'rr'
  tpRR: 1.2,
  // Force-flip on an opposite signal. The default matches the original engine,
  // but a strategy whose signal is a PERSISTENT STATE rather than a cross event
  // will thrash if every disagreement closes the trade — those need this off.
  flipOnOpposite: true,
  // Allow a new position on the same bar a previous one exited. See the comment
  // at the exit block: the re-entry price precedes the exit, so this is not
  // physically tradeable. Off by default; on only to reproduce other tooling.
  sameBarReentry: false,
  // Block re-entry in the SAME direction for this many minutes after a stop-out.
  // Cannot live in the signal, because it depends on how the trade ended.
  cooldownAfterStopMins: 0,
  atrPeriod: 14,
  maxBarsInTrade: 0,        // 0 = no time stop
  // Intraday-only mode: flat by `flattenCt`, no re-entry until `reopenCt`.
  intradayOnly: true,
  flattenCt: SESSION.flattenCt,
  reopenCt: SESSION.reopenCt,
  // Optional: stop opening new trades this many minutes before the flatten time.
  // Entering at 3:04 PM only to be flattened at 3:05 pays commission for nothing.
  noEntryMinsBeforeFlat: 0,
  // HARD daily profit stop on UNREALISED P&L, in dollars. 0 = off.
  //
  // This is what trading platforms actually enforce, and it is a different thing
  // from the rules-layer `dailyProfitStop`, which only blocks new ENTRIES once
  // REALISED P&L crosses a line. A platform-level unrealised stop closes the open
  // position the instant realised+open P&L touches the threshold, so the day is
  // capped AT the number rather than overshooting past it.
  //
  // The distinction matters: with entry-blocking alone, a $1500 stop still left
  // 50.3% of windows with a day above $1500. A hard unrealised stop leaves none.
  //
  // Note this breaks the "contracts are just a P&L multiplier" shortcut — the
  // threshold is an absolute dollar amount, so the size actually traded decides
  // when it triggers. Searches over contract count must re-run the engine.
  dayProfitStopUsd: 0,
  // HARD daily LOSS stop on UNREALISED P&L, in dollars. 0 = off. The exact mirror
  // of the above, and again a different thing from the rules-layer
  // `circuitBreaker` / `dailyLossLimit`, which only block new ENTRIES once
  // REALISED P&L crosses a line and can never touch a trade already running.
  //
  // Because it closes on unrealised P&L it effectively CAPS THE STOP DISTANCE in
  // dollars, which changes the bracket geometry the strategy was measured on.
  // At 10 lots a $1000 cap is 50 points, i.e. 3.7xATR at the median ATR of 13.56
  // rather than the configured 5xATR — a different strategy, not a safety net.
  dayLossStopUsd: 0,
};

export function resolveExec(cfg = {}) {
  return { ...DEFAULT_EXEC, ...cfg };
}

function roundTripCost(x, contracts) {
  return x.commissionModel === "flat"
    ? x.commissionFlat
    : x.commissionPerSide * 2 * contracts;
}

/**
 * Run an ATR-bracketed simulation over `bars` given a per-bar signal array.
 *
 * @param bars  {ts,open,high,low,close,volume,tday,srcFirst?,srcLast?}
 * @param sig   Int8Array: 1 = long, -1 = short, 0 = flat. Read at i-1.
 * @param atrArr Float64Array of ATR aligned to `bars` (bracket width source).
 * @param cfg   execution config (see DEFAULT_EXEC)
 * @returns {trades: Trade[]}
 */
export function runBrackets(bars, sig, atrArr, cfg = {}) {
  const x = resolveExec(cfg);
  const { open: O, high: H, low: L, close: C, ts: TS } = bars;
  const n = O.length;
  const q = Math.max(1, Math.trunc(x.contracts));
  const pv = x.pointValue;
  const slip = x.slippageTicks * x.tickSize;
  const maxBars = Math.trunc(x.maxBarsInTrade) || 0;

  const trades = [];
  let pos = 0, ep = 0, ei = 0, slDist = 0, tpDist = 0;
  let hiSeen = -Infinity, loSeen = Infinity;
  let qCur = q;   // contracts for the OPEN trade (varies under 'risk' sizing)
  let lastStopMs = -Infinity, lastStopDir = 0;   // for cooldownAfterStopMins
  // Day state for the hard unrealised profit stop. Realised P&L is tracked from
  // this engine's own closed trades, at the size actually traded.
  const dayCap = x.dayProfitStopUsd || 0;
  const dayLoss = x.dayLossStopUsd || 0;
  const dayTracked = dayCap > 0 || dayLoss > 0;
  let curTday = -2147483648, dayRealised = 0, dayCapHit = false, dayLossHit = false;

  function close_(rawExit, reason, i) {
    // Slippage always works against the position on both legs.
    const exitPrice = pos === 1 ? rawExit - slip : rawExit + slip;
    const entryFill = pos === 1 ? ep + slip : ep - slip;
    const gross = (exitPrice - entryFill) * pos * pv * qCur;
    const fees = roundTripCost(x, qCur);
    const mfe = (pos === 1 ? hiSeen - entryFill : entryFill - loSeen) * pv * qCur;
    const mae = (pos === 1 ? loSeen - entryFill : entryFill - hiSeen) * pv * qCur;
    trades.push({
      entryIdx: ei, exitIdx: i,
      entryTime: TS[ei], exitTime: TS[i],
      entrySrc: bars.srcFirst ? bars.srcFirst[ei] : ei,
      exitSrc: bars.srcLast ? bars.srcLast[i] : i,
      // CME session the trade CLOSED in (17:00 ET boundary). The daily rules in
      // challenge.mjs bucket on this, so it has to ride along with the trade.
      tday: bars.tday[i],
      dir: pos,
      entryPrice: entryFill, exitPrice,
      // The bracket that was live for this trade, so the chart can draw it.
      stop: pos === 1 ? ep - slDist : ep + slDist,
      target: pos === 1 ? ep + tpDist : ep - tpDist,
      contracts: qCur,
      pnl: gross - fees,
      gross, fees,
      mae: Math.min(0, mae), mfe: Math.max(0, mfe),
      bars: i - ei,
      reason,
    });
    if (reason === EXIT.SL) { lastStopMs = TS[i]; lastStopDir = pos; }
    if (dayTracked) {
      dayRealised += gross - fees;
      if (dayCap > 0 && dayRealised >= dayCap) dayCapHit = true;    // done for the day
      if (dayLoss > 0 && dayRealised <= -dayLoss) dayLossHit = true;
    }
    pos = 0;
  }

  const CT = bars.ctMin;
  const intraday = !!x.intradayOnly && !!CT;

  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = intraday && inFlatWindow(CT[i], x.flattenCt, x.reopenCt);
    if (dayTracked && bars.tday[i] !== curTday) {
      curTday = bars.tday[i]; dayRealised = 0; dayCapHit = false; dayLossHit = false;
    }

    if (pos !== 0) {
      if (H[i] > hiSeen) hiSeen = H[i];
      if (L[i] < loSeen) loSeen = L[i];

      // The flatten deadline outranks the bracket: the position is closed at
      // this bar's open regardless of where stop and target sit. Checking it
      // first is what makes the run honest about overnight holds being banned.
      if (flatNow) { close_(O[i], EXIT.FLAT, i); continue; }

      // `sameBarReentry` lets a new position open on the very bar the last one
      // exited. It is OFF by default because the re-entry fills at that bar's
      // OPEN — a price that occurred BEFORE the mid-bar stop-out — which is not
      // a sequence that could actually be traded. lib_faithful_eval in the other
      // repo does allow it, so the flag exists to reproduce those numbers.
      // A hard unrealised day-profit stop behaves exactly like a second, closer
      // take-profit: the price at which realised+open P&L reaches the threshold.
      // Whichever profit level is nearer gets hit first as price advances.
      let capPx = 0;
      if (dayCap > 0 && !dayCapHit) {
        capPx = ep + pos * ((dayCap - dayRealised) / (pv * qCur));
      }
      // A platform loss stop is the exact mirror: the price at which
      // realised + open P&L reaches -dayLoss. Whichever stop is NEARER gets hit
      // first as price falls, so it can only ever TIGHTEN the bracket.
      let lossPx = 0;
      if (dayLoss > 0 && !dayLossHit) {
        lossPx = ep - pos * ((dayLoss + dayRealised) / (pv * qCur));
      }

      let exited = false;
      if (pos === 1) {
        const rawSl = ep - slDist;
        const sl = lossPx > 0 ? Math.max(rawSl, lossPx) : rawSl;
        const isLossCap = lossPx > 0 && sl === lossPx && lossPx > rawSl;
        const tp = capPx > 0 ? Math.min(ep + tpDist, capPx) : ep + tpDist;
        const isCap = capPx > 0 && tp === capPx && capPx < ep + tpDist;
        if (O[i] <= sl) { close_(O[i], isLossCap ? EXIT.DAYLOSS : EXIT.SL, i); exited = true; }
        else if (L[i] <= sl) { close_(sl, isLossCap ? EXIT.DAYLOSS : EXIT.SL, i); exited = true; }
        else if (H[i] >= tp) { close_(tp, isCap ? EXIT.DAYCAP : EXIT.TP, i); exited = true; }
      } else {
        const rawSl = ep + slDist;
        const sl = lossPx > 0 ? Math.min(rawSl, lossPx) : rawSl;
        const isLossCap = lossPx > 0 && sl === lossPx && lossPx < rawSl;
        const tp = capPx > 0 ? Math.max(ep - tpDist, capPx) : ep - tpDist;
        const isCap = capPx > 0 && tp === capPx && capPx > ep - tpDist;
        if (O[i] >= sl) { close_(O[i], isLossCap ? EXIT.DAYLOSS : EXIT.SL, i); exited = true; }
        else if (H[i] >= sl) { close_(sl, isLossCap ? EXIT.DAYLOSS : EXIT.SL, i); exited = true; }
        else if (L[i] <= tp) { close_(tp, isCap ? EXIT.DAYCAP : EXIT.TP, i); exited = true; }
      }
      if (exited && !x.sameBarReentry) continue;
      if (maxBars > 0 && i - ei >= maxBars) { close_(O[i], EXIT.TIME, i); continue; }
      if (x.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], EXIT.FLIP, i); // may re-enter below
      if (pos !== 0) continue;   // still holding: no entry logic this bar
    }

    if (pos === 0 && s !== 0 && !flatNow && !dayCapHit && !dayLossHit) {
      // Optionally stand aside in the run-up to the deadline too, since a trade
      // opened minutes before it can only be flattened for the cost of the fill.
      const cutoff = x.flattenCt - (x.noEntryMinsBeforeFlat || 0);
      const tooLate = intraday && x.noEntryMinsBeforeFlat > 0 &&
                      inFlatWindow(CT[i], cutoff, x.reopenCt);
      if (tooLate) { continue; }
      // A stop-out in this direction may still be cooling off.
      if (x.cooldownAfterStopMins > 0 && s === lastStopDir &&
          TS[i] - lastStopMs < x.cooldownAfterStopMins * 60000) continue;

      const a = atrArr[i - 1];
      if (Number.isFinite(a) && a > 0) {
        ep = O[i]; ei = i; pos = s;
        slDist = Math.max(a * x.slAtrMult, x.tickSize);
        tpDist = x.tpMode === "rr"
          ? Math.max(slDist * x.tpRR, x.tickSize)
          : Math.max(a * x.tpAtrMult, x.tickSize);
        // Size from the stop distance known at entry — never from anything later.
        qCur = x.sizingMode === "risk"
          ? Math.max(1, Math.min(Math.trunc(x.maxContracts), Math.round(x.riskDollars / (slDist * pv))))
          : q;
        hiSeen = H[i]; loSeen = L[i];
      }
    }
  }
  if (pos !== 0) close_(C[n - 1], EXIT.EOD, n - 1);

  return { trades };
}

// Aggregate per-trade statistics. Pure reporting — no rule logic here.
export function tradeStats(trades) {
  const n = trades.length;
  if (n === 0) {
    return { n: 0, pnl: 0, winRate: 0, profitFactor: 0, expectancy: 0,
             avgWin: 0, avgLoss: 0, grossWin: 0, grossLoss: 0, fees: 0,
             maxWin: 0, maxLoss: 0, longs: 0, shorts: 0, tradesPerDay: 0 };
  }
  let pnl = 0, gw = 0, gl = 0, wins = 0, fees = 0;
  let maxWin = -Infinity, maxLoss = Infinity, longs = 0;
  for (const t of trades) {
    pnl += t.pnl; fees += t.fees;
    if (t.pnl > 0) { wins++; gw += t.pnl; } else gl += -t.pnl;
    if (t.pnl > maxWin) maxWin = t.pnl;
    if (t.pnl < maxLoss) maxLoss = t.pnl;
    if (t.dir === 1) longs++;
  }
  const spanDays = Math.max(1, (trades[n - 1].exitTime - trades[0].entryTime) / 86400000);
  return {
    n,
    pnl,
    winRate: (wins / n) * 100,
    profitFactor: gl === 0 ? (gw > 0 ? Infinity : 0) : gw / gl,
    expectancy: pnl / n,
    avgWin: wins ? gw / wins : 0,
    avgLoss: n - wins ? -gl / (n - wins) : 0,
    grossWin: gw, grossLoss: gl, fees,
    maxWin, maxLoss,
    longs, shorts: n - longs,
    tradesPerDay: n / spanDays,
  };
}
