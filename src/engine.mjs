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

export const EXIT = { SL: "SL", TP: "TP", FLIP: "FLIP", EOD: "EOD", TIME: "TIME" };

export const DEFAULT_EXEC = {
  contracts: 8,
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
  atrPeriod: 14,
  maxBarsInTrade: 0,        // 0 = no time stop
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

  function close_(rawExit, reason, i) {
    // Slippage always works against the position on both legs.
    const exitPrice = pos === 1 ? rawExit - slip : rawExit + slip;
    const entryFill = pos === 1 ? ep + slip : ep - slip;
    const gross = (exitPrice - entryFill) * pos * pv * q;
    const fees = roundTripCost(x, q);
    const mfe = (pos === 1 ? hiSeen - entryFill : entryFill - loSeen) * pv * q;
    const mae = (pos === 1 ? loSeen - entryFill : entryFill - hiSeen) * pv * q;
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
      contracts: q,
      pnl: gross - fees,
      gross, fees,
      mae: Math.min(0, mae), mfe: Math.max(0, mfe),
      bars: i - ei,
      reason,
    });
    pos = 0;
  }

  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];

    if (pos !== 0) {
      if (H[i] > hiSeen) hiSeen = H[i];
      if (L[i] < loSeen) loSeen = L[i];

      if (pos === 1) {
        const sl = ep - slDist, tp = ep + tpDist;
        if (O[i] <= sl) { close_(O[i], EXIT.SL, i); continue; }
        if (L[i] <= sl) { close_(sl, EXIT.SL, i); continue; }
        if (H[i] >= tp) { close_(tp, EXIT.TP, i); continue; }
      } else {
        const sl = ep + slDist, tp = ep - tpDist;
        if (O[i] >= sl) { close_(O[i], EXIT.SL, i); continue; }
        if (H[i] >= sl) { close_(sl, EXIT.SL, i); continue; }
        if (L[i] <= tp) { close_(tp, EXIT.TP, i); continue; }
      }
      if (maxBars > 0 && i - ei >= maxBars) { close_(O[i], EXIT.TIME, i); continue; }
      if (s !== 0 && s !== pos) close_(O[i], EXIT.FLIP, i); // may re-enter below
    }

    if (pos === 0 && s !== 0) {
      const a = atrArr[i - 1];
      if (Number.isFinite(a) && a > 0) {
        ep = O[i]; ei = i; pos = s;
        slDist = Math.max(a * x.slAtrMult, x.tickSize);
        tpDist = Math.max(a * x.tpAtrMult, x.tickSize);
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
