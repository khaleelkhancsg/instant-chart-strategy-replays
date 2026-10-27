// Bracket execution engine. ISOMORPHIC — this exact file runs on the server for
// full-history sweeps and in the browser for live parameter previews. It is the
// project's ONE execution engine: research/lib_shipped.mjs (the live bot's order
// model), lib_orb.mjs and lib_forward.mjs are thin adapters over it, and
// test/legacy_parity.mjs holds each of them to the code it replaced.
//
// Causality: a signal is confirmed at the CLOSE of bar i-1 and acted on from the
// OPEN of bar i. There is no path by which bar i's high/low/close can influence
// the decision to be in the trade — that lookahead bug is the single most common
// way a backtest lies, so the ordering here is deliberate and load-bearing.
//
// What a 1-minute bar cannot say is decided by an option, never by accident of
// code order (INTRABAR ORDER in DEFAULT_EXEC). The defaults are the physically
// consistent reading:
//   - exits decided on the closed bar (flip, exit signal, time stop) fill at the
//     OPEN, before the bar's range can touch the stop or target;
//   - a market fill at the open is followed by the whole bar, so that bar can
//     already stop the trade out or reach its target;
//   - when one bar reaches both the stop and the target, the stop is assumed;
//   - a bar that opens through a resting order fills it at the open.
//
// Flip semantics (matches the validated lite_backtester engine — do not "tidy"):
// an opposite signal while in a position closes at this bar's open AND may
// re-enter on the same bar. A stop/target exit, by contrast, ends the bar.

export const EXIT = { SL: "SL", TP: "TP", FLIP: "FLIP", EOD: "EOD", TIME: "TIME", FLAT: "FLAT", DAYCAP: "DAYCAP", DAYLOSS: "DAYLOSS", SIGNAL: "SIGNAL", TRAIL: "TRAIL" };

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
// A reopen earlier in the day than the flatten time wraps past midnight, which
// is how an RTH-only book (flat 15:05 -> 08:30) is expressed.
function inFlatWindow(ctMin, flattenCt, reopenCt) {
  // Equal times are an empty window, not the whole day -- read as a wrapped
  // range they made every minute "flat", so nothing could ever trade.
  if (reopenCt === flattenCt) return false;
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
  // The firm's cap on contracts per position. Bounds BOTH sizing modes: a fixed
  // size above it trades the cap. Research pinned to the old 10-lot rule sets
  // maxContracts: 10 explicitly.
  maxContracts: 20,
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
  // Also close on a signal in the SAME direction and re-enter on it, for systems
  // whose trade is one signal-to-signal segment. Needs flipOnOpposite.
  flipOnAnySignal: false,
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
  // How the platform's day-loss stop behaves when price moves through it.
  //
  //   'price' — it is a resting stop ORDER at the implied price. A bar that
  //             opens beyond it fills at the open, so the day can lose MORE than
  //             the cap. This is how a bar-based backtest naturally models it.
  //   'exact' — the platform tracks unrealised P&L continuously and liquidates
  //             at the threshold, so the day's loss is EXACTLY the cap and
  //             trading stops. Correct for a fast platform-side auto-liquidation,
  //             which is not a resting order and does not queue behind a gap.
  //
  // The distinction is not cosmetic. Under 'price' the worst day is -$2,116 at
  // every cap from $1000 to $2000, because gap-throughs dominate the tail and
  // the cap never binds it — which makes a tight cap look like all cost and no
  // protection. Under 'exact' the cap actually bounds the day.
  dayLossStopMode: "price",   // 'price' | 'exact'
  // Both caps measure an open position from its FILL. A position carried over
  // the session boundary (intradayOnly false) therefore brings its whole P&L
  // since the fill into the new day's cap, where a platform marks it at the
  // session open -- use the caps with intraday-only books.
  // The 'exact' cap books the day at exactly the cap NET of commission. false
  // (old research) let fees take the day a few dollars past it.
  exactLossIncludesFees: true,
  // A platform cap that fires ends the day. Its price is set on GROSS P&L, so the
  // realised day lands a commission short of the cap (or a rounding hair either
  // side of it); false (old) kept trading on that remainder, a run of near-zero
  // trades against a cap that had already done its job (fuzz-found).
  capEndsDay: true,
  // DAY BLOCKS INSIDE THE ENGINE: no new orders once the day's REALISED P&L is at
  // or below -dayBreakerUsd, or at or above dayProfitBlockUsd, and any working
  // entry order is cancelled -- where the bot applies them. The rules layer has
  // post-hoc versions for the window replay. 0 = off.
  dayBreakerUsd: 0,
  dayProfitBlockUsd: 0,
  // SCALE-IN (pyramiding). 0 = off; otherwise the FRACTION of `contracts` taken
  // at the signal, with the remainder added only once price has moved
  // `scaleInTrigger` x ATR in the trade's FAVOUR, within `scaleInWindowBars`.
  //
  // Measured, this behaves as a SOFT STOP rather than as better averaging: about
  // 15% of trades never move a quarter-ATR the right way, they average heavily
  // negative, and starting at half size means only half the position is exposed
  // to them. Adding on ADVERSE moves — the intuitive "buy the dip" version — does
  // the opposite and tests clearly worse, because a breakout that retraces is the
  // one that failed.
  //
  // Both tranches pay entry slippage, so the average fill is computed from the
  // slipped price of each, not from a mid-point. That matters: an uncosted
  // version of this overstates the benefit.
  scaleInFrac: 0,             // e.g. 0.5 = half now, half on follow-through
  scaleInTrigger: 0.25,       // xATR of favourable movement required to add
  scaleInWindowBars: 10,      // give up on adding after this many bars
  // Resolve the add BEFORE or AFTER the bracket within the same bar. 'after' is
  // the pessimistic reading — if a bar both triggers the add and hits the stop,
  // assume the stop printed first and no add happened.
  scaleInOrder: "before",     // 'before' | 'after'
  // EXTRA adverse ticks on the ADD tranche only, on top of slippageTicks.
  //
  // The add is a BUY above the market (or a sell below), so it can only be a STOP
  // order, which fills at market once triggered and therefore slips. A stop-LIMIT
  // caps the price but misses exactly when price runs fastest through the level —
  // which are the adds most worth having. This parameter prices that risk without
  // taking a view on order type: sweep it to find how much the edge can absorb.
  scaleInSlipTicks: 0,
  // SCALE-OUT: bank `scaleOutFrac` of the position once price is `scaleOutAtr` x
  // ATR in favour; the rest runs to the target with the stop where it was. 0 = off.
  scaleOutFrac: 0,
  scaleOutAtr: 1,

  // ── ORDER MODEL ── how a signal becomes a position.
  //   'market' fills at the open of the bar after the signal.
  //   'stop'   rests a stop `entryTriggerAtr` x ATR beyond that bar's open, working
  //            from the bar after it for `entryWindowBars` bars -- the live
  //            Donchian bot's order, which only fills breakouts that follow through.
  //   'limit'  rests a limit `entryLimitAtr` x ATR back INTO the move instead.
  // The stop and target are measured from that reference open. A new signal while
  // an order is working re-prices it, as the bot re-arms every bar.
  entryType: "market",        // 'market' | 'stop' | 'limit'
  entryTriggerAtr: 0.15,
  entryLimitAtr: 0.25,
  entryWindowBars: 10,
  // The stop's first working bar can already OPEN through the trigger, and a
  // platform refuses a stop on the wrong side of the market. 'limit' re-places
  // the same price as a limit, as the bot does; 'optimistic' fills at the
  // trigger anyway -- a price the market had already left, kept only to
  // reproduce old research.
  entryRefused: "limit",      // 'limit' | 'optimistic'
  // An opposite signal cancels a working entry order before it can fill. Off,
  // the order keeps its bar, and a fill there was flipped at a price from before
  // the fill (research/lib_shipped.mjs measured the artefact).
  cancelOpposite: true,
  // Stop/limit entries: measure the target from the fill rather than the
  // reference open, so a target nearer than the trigger still lies beyond it.
  tpFromFill: false,

  // ── INTRABAR ORDER ── what the bars cannot say, decided explicitly. Each
  // default is the physically consistent reading; each 'old' value reproduces
  // the engine (or research library) from before this was made explicit.
  //
  // Exits decided on the closed bar -- an opposite-signal flip, an exit signal,
  // the time stop -- fill at this bar's OPEN, before its range can touch the
  // bracket. false (old) tested the bracket first, so a trade the flip had
  // already closed could still be credited a target hit later in the bar.
  exitFirst: true,
  // A market fill at the open is followed by the WHOLE bar, so the bar's own
  // range can stop the trade out or reach its target. false (old) tested only
  // from the next bar, missing every stop-out inside the entry bar.
  entryBarExits: true,
  // On a stop/limit fill bar the open, and part of the range, came BEFORE the
  // fill. fillBarStop 'touch' books the stop whenever the bar reached it
  // (pessimistic), 'close' only when the bar also CLOSED beyond it. limitFillTp
  // does the same for the target on a LIMIT fill bar, where price came back to
  // the entry so the bar's favourable extreme may predate it. fillBarOpen true
  // (old research) let that earlier open gap-stop the trade or flip it.
  fillBarStop: "touch",       // 'touch' | 'close'
  limitFillTp: "high",        // 'high' | 'close'
  fillBarOpen: false,
  // One bar reaching both the stop and the target: 'stop' (pessimistic) or 'target'.
  sameBarTie: "stop",
  // A bar that OPENS through a resting order fills it at the open -- a target or
  // a limit entry at the better price it really gets, a stop entry at the worse.
  // 'level' (old) filled at the order's own price, which the market had left.
  tpGapFill: "open",          // 'open' | 'level'
  entryGapFill: "open",       // 'open' | 'level'
  // Intraday-only: a session that ends before the flatten time (an early close)
  // flattens at its last bar's close and drops any working order. 'none' (old)
  // carried both into the next session.
  sessionEndFlat: "close",    // 'close' | 'none'
  // Close a position still open on the last bar (reason EOD). false leaves it
  // out, as research that counted only completed trades did.
  closeAtEnd: true,
};

export function resolveExec(cfg = {}) {
  return { ...DEFAULT_EXEC, ...cfg };
}

// Every option above set to the engine's behaviour before the intrabar order was
// made explicit, so a pre-consolidation result can be reproduced exactly.
export const LEGACY_EXEC = {
  exitFirst: false, entryBarExits: false, tpGapFill: "level", entryGapFill: "level",
  sessionEndFlat: "none", cancelOpposite: false, capEndsDay: false,
};

// Where a resting stop actually fills: at its trigger, or at the open when the
// bar gapped through it. Strategies that work out their own fills (lib_orb's
// levels) use this so the rule exists once.
export function stopFillPrice(trigger, open, dir) {
  return dir === 1 ? Math.max(trigger, open) : Math.min(trigger, open);
}

function roundTripCost(x, contracts) {
  return x.commissionModel === "flat"
    ? x.commissionFlat
    : x.commissionPerSide * 2 * contracts;
}

const NO_DAY = -2147483648;

/**
 * Run an ATR-bracketed simulation over `bars` given a per-bar signal array.
 *
 * @param bars  {ts,open,high,low,close,volume,tday,ctMin?,srcFirst?,srcLast?}
 * @param sig   Int8Array: 1 = long, -1 = short, 0 = flat. Read at i-1.
 * @param atrArr Float64Array of ATR aligned to `bars` (bracket width source).
 * @param cfg   execution config (see DEFAULT_EXEC). Research may also pass, as
 *              JS only:
 *   exitSig   Int8Array mask per bar: 1 closes a long, 2 a short (from compute())
 *   sizer(atrAtSignal, ctMin, seq, bar) -> contracts; below 1 skips the signal
 *   tpFn(atrAtSignal, contracts)        -> target distance in points
 *   exitFn(closedBar, dir, state)       -> true closes at the next open
 *   stopFn(closedBar, state)            -> a stop price; it can only tighten
 *   onTrade(trade)                       called as each trade is booked
 *   haltFn()                             -> true ends the run (an account died)
 *   entries   [{bar, dir, price?, slPts, tpPts, lots?, t1Pts?, t1Frac?}] sorted
 *             by bar: fills worked out elsewhere (a resting order at a level, a
 *             per-entry study), managed by this engine's exits. No price = a
 *             market order at that bar's open. Signal entries are then off.
 *   untilFlat with entries: stop once the last entry has closed.
 *   state = {dir, fill, ep, atr, slD, tpD, entBar, qty, mx, mn, sigBar, tsl}:
 *   mx/mn are the best and worst price since the fill, from the fill bar's
 *   CLOSE on for a resting order (its range may predate the fill).
 * @returns {trades: Trade[]}
 */
export function runBrackets(bars, sig, atrArr, cfg = {}) {
  const x = resolveExec(cfg);
  const { open: O, high: H, low: L, close: C, ts: TS } = bars;
  const TD = bars.tday, CT = bars.ctMin;
  const n = O.length;
  const cap = Math.max(1, Math.trunc(x.maxContracts) || 1);
  const q = Math.max(1, Math.min(cap, Math.trunc(x.contracts)));
  const pv = x.pointValue, tick = x.tickSize;
  const slip = x.slippageTicks * tick;
  const maxBars = Math.trunc(x.maxBarsInTrade) || 0;
  // An optional SIGNAL exit, as a BITMASK per bar: 1 closes a long, 2 closes a
  // short, 3 closes either. A mask rather than a direction because the array is
  // built in compute(), which has no idea which way the book will be positioned
  // when the bar arrives -- it can only say "a long should leave here" and "a
  // short should leave here", and sometimes both are true.
  const exitSig = x.exitSig || null;
  const { sizer, tpFn, exitFn, stopFn, onTrade, haltFn } = x;
  const entries = x.entries || null;
  const nEntries = entries ? entries.length : 0;

  const trades = [];
  // The open position. `notional` accumulates price*qty using each tranche's
  // SLIPPED fill, so the average entry already carries its true cost.
  let pos = 0, qOpen = 0, qIn = 0, notional = 0;
  let ep = 0, slDist = 0, tpDist = 0, tpBase = 0, ei = 0;
  let sigIdx = -1, atrSig = NaN, kind = "market", limFill = false, ambiguous = false;
  let hiSeen = -Infinity, loSeen = Infinity;      // for MAE / MFE
  let mx = 0, mn = 0, tsl = null;                 // the management hooks' view
  let banked = 0, t1Px = 0, t1Frac = 0;           // scale-out
  const scaleFrac = x.scaleInFrac > 0 && x.scaleInFrac < 1 ? x.scaleInFrac : 0;
  let pendQty = 0, addPx = 0, addBy = -1;
  // A working entry order (stop / limit entries).
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0;
  let armQty = 0, armAtr = 0, armLimit = false;
  let lastStopMs = -Infinity, lastStopDir = 0;   // for cooldownAfterStopMins
  // Day state. Realised P&L is this engine's own closed trades, at the size
  // actually traded, for the platform caps and the entry blocks.
  const dayCap = x.dayProfitStopUsd || 0, dayLoss = x.dayLossStopUsd || 0;
  const breaker = x.dayBreakerUsd || 0, profitBlock = x.dayProfitBlockUsd || 0;
  const exactLoss = x.dayLossStopMode === "exact";
  let curTday = NO_DAY, dayRealised = 0, dayCapHit = false, dayLossHit = false;
  let seq = 0, ePtr = 0;

  const blocked = () => dayCapHit || dayLossHit ||
    (breaker > 0 && dayRealised <= -breaker) || (profitBlock > 0 && dayRealised >= profitBlock);
  const state = () => ({ dir: pos, fill: notional / qIn, ep, atr: atrSig, slD: slDist, tpD: tpDist,
                         entBar: ei, qty: qOpen, mx, mn, sigBar: sigIdx, tsl });

  function close_(rawExit, reason, i, exactNet) {
    // Slippage always works against the position on both legs. With scale-in,
    // the fill is the size-weighted average of the tranches, each already slipped.
    const fill = notional / qIn;
    const fees = roundTripCost(x, qIn);
    // `exactNet` pins the trade's NET P&L, used by the 'exact' day-loss mode
    // where a platform liquidation lands on the threshold rather than on a
    // price. The exit price is back-solved so the trade record stays coherent.
    let exitPrice, gross, pnl;
    if (exactNet !== undefined) {
      pnl = exactNet; gross = exactNet + fees;
      exitPrice = fill + (gross - banked) / (pos * pv * qOpen);
    } else {
      exitPrice = pos === 1 ? rawExit - slip : rawExit + slip;
      gross = banked + (exitPrice - fill) * pos * pv * qOpen;
      pnl = gross - fees;
      // 'exact' promises the day never loses more than the cap: the platform
      // liquidates the instant the day reaches it. The cap's stop price is set
      // on gross P&L, so a nearer strategy stop could still breach it NET of
      // commission (fuzz-found: -$302.93 on a -$300 cap with $12 of fees), and a
      // gap through both could breach it outright. Either way the platform
      // would have closed at the limit, so the exit is booked there.
      const floorNet = -dayLoss - dayRealised;
      if (x.exactLossIncludesFees && exactLoss && dayLoss > 0 && !dayLossHit && pnl < floorNet - 1e-9) {
        pnl = floorNet; gross = floorNet + fees;
        exitPrice = fill + (gross - banked) / (pos * pv * qOpen);
        reason = EXIT.DAYLOSS; exactNet = floorNet;
      }
    }
    const mfe = (pos === 1 ? hiSeen - fill : fill - loSeen) * pv * qIn;
    const mae = (pos === 1 ? loSeen - fill : fill - hiSeen) * pv * qIn;
    const t = {
      entryIdx: ei, exitIdx: i,
      entryTime: TS[ei], exitTime: TS[i],
      entrySrc: bars.srcFirst ? bars.srcFirst[ei] : ei,
      exitSrc: bars.srcLast ? bars.srcLast[i] : i,
      // CME session the trade CLOSED in (17:00 ET boundary). The daily rules in
      // challenge.mjs bucket on this, so it has to ride along with the trade.
      tday: TD[i],
      dir: pos,
      entryPrice: fill, exitPrice,
      // The bracket that was live for this trade, so the chart can draw it.
      stop: ep - pos * slDist,
      target: tpBase + pos * tpDist,
      contracts: qIn,
      pnl, gross, fees,
      mae: Math.min(0, mae), mfe: Math.max(0, mfe),
      bars: i - ei,
      reason,
      // How it got in -- the signal bar, the ATR there, the order type, and
      // whether a refused stop filled as a limit -- and whether its exit bar
      // reached both the stop and the target (the order there is assumed).
      sigIdx, atr: atrSig, entryType: kind, limitFill: limFill, ambiguous,
      entryCt: CT ? CT[ei] : null,
    };
    trades.push(t);
    if (reason === EXIT.SL) { lastStopMs = TS[i]; lastStopDir = pos; }
    pendQty = 0; addBy = -1; notional = 0; banked = 0; t1Frac = 0; tsl = null;
    dayRealised += pnl;
    if (dayCap > 0 && (dayRealised >= dayCap || (x.capEndsDay && reason === EXIT.DAYCAP))) dayCapHit = true;   // done for the day
    if (dayLoss > 0 && (dayRealised <= -dayLoss || (x.capEndsDay && reason === EXIT.DAYLOSS))) dayLossHit = true;
    pos = 0;
    if (onTrade) onTrade(t);
  }

  // Open at `px` (before slippage). `ref` is what the bracket is measured from.
  function open_(dir, i, px, ref, slD, tpD, full, sBar, a, how, lim, scaleOk) {
    pos = dir; ep = ref; slDist = slD; tpDist = tpD; ei = i;
    sigIdx = sBar; atrSig = a; kind = how; limFill = lim; ambiguous = false;
    tpBase = x.tpFromFill && how !== "market" ? px : ref;
    mx = mn = px; tsl = null; banked = 0; t1Frac = 0; armDir = 0;
    if (scaleOk && scaleFrac > 0 && full >= 2) {
      qIn = qOpen = Math.max(1, Math.round(full * scaleFrac));
      pendQty = full - qIn;
      addPx = ref + dir * Math.max(a * x.scaleInTrigger, tick);
      addBy = i + Math.max(1, Math.trunc(x.scaleInWindowBars));
    } else {
      qIn = qOpen = full; pendQty = 0; addBy = -1;
    }
    notional = (dir === 1 ? px + slip : px - slip) * qIn;
    // An open fill (a market order, or a resting one the open gapped through) is
    // followed by the whole bar. Otherwise only the extreme in the direction
    // price TRAVELLED to reach the order surely came after it -- the high for a
    // buy stop or a sell limit -- and the close.
    if (how === "market" || px === O[i]) { hiSeen = H[i]; loSeen = L[i]; }
    else if ((how === "stop") === (dir === 1)) { hiSeen = H[i]; loSeen = Math.min(px, C[i]); }
    else { hiSeen = Math.max(px, C[i]); loSeen = L[i]; }
  }

  // Add the pending tranche once price has moved far enough the right way.
  // The fill is the trigger price plus slippage, and it is folded into the
  // weighted average entry so every later calculation sees the true cost. Not on
  // a limit fill's own bar: price came BACK to the entry there, so the bar's
  // favourable extreme may predate the position.
  function tryAdd(bar) {
    if (pendQty <= 0 || bar > addBy || (limFill && bar === ei)) return;
    const reached = pos === 1 ? H[bar] >= addPx : L[bar] <= addPx;
    if (!reached) return;
    const addSlip = slip + (x.scaleInSlipTicks || 0) * tick;
    notional += (pos === 1 ? addPx + addSlip : addPx - addSlip) * pendQty;
    qIn += pendQty; qOpen += pendQty;
    pendQty = 0;
  }

  // The live stop and target. A platform day cap behaves like a second, nearer
  // stop (or target): the price at which realised + open P&L reaches it. Both
  // trigger on ACTUAL P&L, so they are measured from the real average fill.
  let lvSl = 0, lvSlWhy = EXIT.SL, lvCut, lvTp = 0, lvTpWhy = EXIT.TP;
  function levels() {
    const fill = notional / qIn;
    lvSl = ep - pos * slDist; lvSlWhy = EXIT.SL; lvCut = undefined;
    if (dayLoss > 0 && !dayLossHit) {
      const lossPx = fill - pos * ((dayLoss + dayRealised + banked) / (pv * qOpen));
      if (pos === 1 ? lossPx > lvSl : lossPx < lvSl) {
        lvSl = lossPx; lvSlWhy = EXIT.DAYLOSS;
        // In 'exact' mode a day-loss liquidation lands the DAY on exactly
        // -dayLoss, so this trade's net is whatever closes the gap.
        if (exactLoss) lvCut = -dayLoss - dayRealised;
      }
    }
    if (tsl !== null && (pos === 1 ? tsl > lvSl : tsl < lvSl)) { lvSl = tsl; lvSlWhy = EXIT.TRAIL; lvCut = undefined; }
    lvTp = tpBase + pos * tpDist; lvTpWhy = EXIT.TP;
    if (dayCap > 0 && !dayCapHit) {
      const capPx = fill + pos * ((dayCap - dayRealised - banked) / (pv * qOpen));
      if (pos === 1 ? capPx < lvTp : capPx > lvTp) { lvTp = capPx; lvTpWhy = EXIT.DAYCAP; }
    }
  }

  // The bracket over bar i's range. Returns true when the trade closed.
  function bracket(i, fillBar) {
    levels();
    const up = pos === 1;
    const sl = lvSl, tp = lvTp;
    const resting = fillBar && kind !== "market";       // the open predates this fill
    const fb = resting && x.fillBarStop === "close";
    const openOk = !fillBar || (resting && x.fillBarOpen && !fb);
    // A gap straight through the stop fills at the open, not the stop price;
    // a gap through the target fills there too.
    if (openOk && (up ? O[i] <= sl : O[i] >= sl)) { close_(O[i], lvSlWhy, i, lvCut); return true; }
    if (openOk && x.tpGapFill === "open" && (up ? O[i] >= tp : O[i] <= tp)) { close_(O[i], lvTpWhy, i); return true; }
    const slHit = (up ? L[i] <= sl : H[i] >= sl) && !(fb && (up ? C[i] > sl : C[i] < sl));
    const reaches = (px) => (up ? H[i] >= px : L[i] <= px) &&
                            !(x.limitFillTp === "close" && limFill && fillBar && (up ? C[i] < px : C[i] > px));
    let tpHit = reaches(tp);
    // Within one bar: stop before target unless told otherwise. Which printed
    // first is unknowable, so the loss is the default assumption.
    if (slHit && tpHit) ambiguous = true;
    if (slHit && !(x.sameBarTie === "target" && tpHit)) { close_(sl, lvSlWhy, i, lvCut); return true; }
    // A scale-out level NEARER than the target is reached first: bank there, and
    // re-price the target, whose dollar caps depend on what is still open. One
    // beyond the target never trades -- the whole position is out before it.
    if (t1Frac > 0 && (up ? t1Px < tp : t1Px > tp) && (up ? H[i] >= t1Px : L[i] <= t1Px)) {
      const px = openOk && x.tpGapFill === "open" && (up ? O[i] >= t1Px : O[i] <= t1Px) ? O[i] : t1Px;
      const fill = notional / qIn, part = qOpen * t1Frac;
      banked += ((up ? px - slip : px + slip) - fill) * pos * pv * part;
      qOpen -= part; t1Frac = 0;
      levels();
      tpHit = reaches(lvTp);
    }
    if (tpHit) { close_(lvTp, lvTpWhy, i); return true; }
    return false;
  }

  // Exits decided on the bar that just closed, filled at this bar's open.
  // Returns "end" (the bar is over), "flip" (an entry may follow) or null.
  function openExit(i) {
    const xs = exitSig ? exitSig[i - 1] : 0;
    if (xs && ((pos === 1 && (xs & 1)) || (pos === -1 && (xs & 2)))) { close_(O[i], EXIT.SIGNAL, i); return "end"; }
    if (exitFn && exitFn(i - 1, pos, state())) { close_(O[i], EXIT.SIGNAL, i); return "end"; }
    if (maxBars > 0 && i - ei >= maxBars) { close_(O[i], EXIT.TIME, i); return "end"; }
    const s = sig[i - 1];
    if (x.flipOnOpposite && s !== 0 && (s !== pos || x.flipOnAnySignal)) { close_(O[i], EXIT.FLIP, i); return "flip"; }
    return null;
  }

  const intraday = !!x.intradayOnly && !!CT;
  const sessionFlat = intraday && x.sessionEndFlat === "close";

  let halted = false;
  for (let i = 1; i < n; i++) {
    if (haltFn && haltFn()) { halted = true; break; }
    if (entries && x.untilFlat && pos === 0 && ePtr >= nEntries) break;
    const s = sig[i - 1];
    const flatNow = intraday && inFlatWindow(CT[i], x.flattenCt, x.reopenCt);
    if (TD[i] !== curTday) {
      // A session that ended before the flatten time (an early close) never had
      // a bar in the flat window: flatten at its last price, drop any order.
      if (sessionFlat && curTday !== NO_DAY) {
        if (pos !== 0) close_(C[i - 1], EXIT.FLAT, i - 1);
        armDir = 0;
      }
      curTday = TD[i]; dayRealised = 0; dayCapHit = false; dayLossHit = false;
    }

    // A working entry order: cancelled, or filled somewhere inside this bar.
    if (pos === 0 && armDir !== 0) {
      if (flatNow || i > armBy || blocked() || (x.cancelOpposite && s !== 0 && s !== armDir)) armDir = 0;
      else if (i > armBar) {
        const d = armDir;
        let px = NaN;
        if (!armLimit && i === armBar + 1 && x.entryRefused !== "optimistic" &&
            (d === 1 ? O[i] >= armPx : O[i] <= armPx)) {
          // A stop here would be refused: price is already through the trigger.
          // The same price becomes a LIMIT, so the fill now needs a retrace.
          armLimit = true;
          if (d === 1 ? L[i] <= armPx : H[i] >= armPx) px = armPx;
        } else if (armLimit ? (d === 1 ? L[i] <= armPx : H[i] >= armPx)
                            : (d === 1 ? H[i] >= armPx : L[i] <= armPx)) {
          px = x.entryGapFill !== "open" ? armPx
             : armLimit ? (d === 1 ? Math.min(armPx, O[i]) : Math.max(armPx, O[i]))
             : stopFillPrice(armPx, O[i], d);
        }
        if (px === px) {
          open_(d, i, px, armEp, armSl, armTp, armQty, armBar - 1, armAtr, armLimit ? "limit" : "stop", armLimit, true);
          // measured from where the target is measured from (tpFromFill)
          if (x.scaleOutFrac > 0) { t1Px = tpBase + d * Math.max(armAtr * x.scaleOutAtr, tick); t1Frac = x.scaleOutFrac; }
        }
      }
    }

    if (pos !== 0) {
      const fillBar = ei === i;
      if (!fillBar) {
        if (H[i] > hiSeen) hiSeen = H[i];
        if (L[i] < loSeen) loSeen = L[i];
      }
      if (x.scaleInOrder !== "after") tryAdd(i);

      // The flatten deadline outranks the bracket: the position is closed at
      // this bar's open regardless of where stop and target sit. Checking it
      // first is what makes the run honest about overnight holds being banned.
      if (flatNow) { close_(O[i], EXIT.FLAT, i); continue; }

      // The management hooks read the bar that just closed, from the fill on.
      const k = i - 1;
      if (k >= ei && (stopFn || exitFn)) {
        if (k === ei && kind !== "market") { if (C[k] > mx) mx = C[k]; if (C[k] < mn) mn = C[k]; }
        else { if (H[k] > mx) mx = H[k]; if (L[k] < mn) mn = L[k]; }
        if (stopFn) {
          const v = stopFn(k, state());
          if (v != null && Number.isFinite(v)) tsl = tsl === null ? v : (pos === 1 ? Math.max(tsl, v) : Math.min(tsl, v));
        }
      }

      // Exits decided at the close happen at the open -- unless the open has
      // already gapped through the stop, which then fills first at that open.
      // On a resting order's fill bar the open came before the fill, so it can
      // decide nothing about this trade.
      const openExitsOk = !fillBar || (kind !== "market" && x.fillBarOpen);
      let flipped = false, decided = false;
      if (x.exitFirst && openExitsOk) {
        levels();
        if (!(pos === 1 ? O[i] <= lvSl : O[i] >= lvSl)) {
          decided = true;
          const r = openExit(i);
          if (r === "end") continue;
          flipped = r === "flip";
        }
      }
      if (!flipped) {
        if (bracket(i, fillBar)) {
          // `sameBarReentry` lets a new position open on the very bar the last one
          // exited. It is OFF by default because the re-entry fills at that bar's
          // OPEN — a price that occurred BEFORE the mid-bar stop-out — which is not
          // a sequence that could actually be traded. lib_faithful_eval in the other
          // repo does allow it, so the flag exists to reproduce those numbers.
          if (!x.sameBarReentry) continue;
        } else {
          if (x.scaleInOrder === "after") tryAdd(i);
          // The old order: these come AFTER the bracket test, so a gap that
          // takes out the stop on the bar the signal says to leave is booked as
          // the stop -- and so is a stop or target touched later in the bar.
          // (With exitFirst they land here only when a gap through the stop
          // pre-empted them and the bracket still left the trade open.)
          if (!decided && openExitsOk) {
            const r = openExit(i);
            if (r === "end") continue;
          }
        }
      }
      if (pos !== 0) continue;   // still holding: no entry logic this bar
    }

    // Fills worked out elsewhere, managed here. They replace signal entries and
    // are taken as given: the session and day rules act on them once they exist.
    if (entries) {
      while (ePtr < nEntries && entries[ePtr].bar < i) ePtr++;   // passed while in a trade
      if (ePtr < nEntries && entries[ePtr].bar === i) {
        const e = entries[ePtr++];
        const px = e.price ?? O[i];
        const how = e.price == null ? "market" : "stop";
        // no stop or target given means none
        open_(e.dir, i, px, px, e.slPts ?? Infinity, e.tpPts ?? Infinity, e.lots ?? q, e.sigIdx ?? i - 1, e.atr ?? NaN, how, false, false);
        if (e.t1Frac > 0 && e.t1Pts > 0) { t1Px = px + e.dir * e.t1Pts; t1Frac = e.t1Frac; }
        if (how !== "market" || x.entryBarExits) bracket(i, true);
      }
      continue;
    }

    if (s === 0 || flatNow || blocked()) continue;
    // A session's signals end with it. The first bar of a new trading day must
    // not act on the last bar of the one before -- across an early close, the
    // daily halt or a weekend -- just as the flatten above drops its orders:
    // otherwise a stop armed before a holiday's noon close re-arms at the 17:00
    // reopen and an intraday book holds a position overnight.
    if (sessionFlat && TD[i - 1] !== TD[i]) continue;
    // Optionally stand aside in the run-up to the deadline too, since a trade
    // opened minutes before it can only be flattened for the cost of the fill.
    if (intraday && x.noEntryMinsBeforeFlat > 0 &&
        inFlatWindow(CT[i], (((x.flattenCt - x.noEntryMinsBeforeFlat) % 1440) + 1440) % 1440, x.reopenCt)) continue;
    // A stop-out in this direction may still be cooling off.
    if (x.cooldownAfterStopMins > 0 && s === lastStopDir &&
        TS[i] - lastStopMs < x.cooldownAfterStopMins * 60000) continue;
    const a = atrArr[i - 1];
    if (!(Number.isFinite(a) && a > 0)) continue;

    const slD = Math.max(a * x.slAtrMult, tick);
    // Size from what is known at the signal — never from anything later. Risk
    // sizing divides by the distance from where the fill is expected to the
    // stop: a stop entry fills a trigger beyond the reference the stop is
    // measured from, a limit entry that much inside it.
    let full;
    if (sizer) {
      full = sizer(a, CT ? CT[i] : 0, seq++, i);
      if (!(full >= 1)) continue;
      if (full > cap) full = cap;
    } else if (x.sizingMode === "risk") {
      const riskPts = x.entryType === "stop" ? slD + Math.max(a * x.entryTriggerAtr, tick)
                    : x.entryType === "limit" ? Math.max(slD - a * x.entryLimitAtr, tick) : slD;
      full = Math.max(1, Math.min(cap, Math.round(x.riskDollars / (riskPts * pv))));
    } else {
      full = q;
    }
    const tpD = tpFn ? Math.max(tpFn(a, full), tick)
              : x.tpMode === "rr" ? Math.max(slD * x.tpRR, tick)
              : Math.max(a * x.tpAtrMult, tick);

    if (x.entryType === "market") {
      open_(s, i, O[i], O[i], slD, tpD, full, i - 1, a, "market", false, true);
      if (x.scaleOutFrac > 0) { t1Px = O[i] + s * Math.max(a * x.scaleOutAtr, tick); t1Frac = x.scaleOutFrac; }
      if (x.entryBarExits) {
        if (x.scaleInOrder !== "after") tryAdd(i);
        if (bracket(i, true)) continue;
        if (x.scaleInOrder === "after") tryAdd(i);
      }
    } else {
      // Place (or re-price) the working order off this bar's open.
      armDir = s; armBar = i; armBy = i + Math.trunc(x.entryWindowBars);
      armEp = O[i]; armQty = full; armAtr = a; armSl = slD; armTp = tpD;
      armLimit = x.entryType === "limit";
      armPx = armLimit ? Math.round((O[i] - s * a * x.entryLimitAtr) / tick) * tick
                       : O[i] + s * Math.max(a * x.entryTriggerAtr, tick);
    }
  }
  // A halted run stops there: a position still open has no later price to close at.
  if (pos !== 0 && x.closeAtEnd && !halted) close_(C[n - 1], EXIT.EOD, n - 1);

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
