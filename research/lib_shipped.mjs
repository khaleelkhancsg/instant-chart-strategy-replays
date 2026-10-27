// The shipped bot's order model, as research has always run it -- now a thin
// adapter over the ONE engine, src/engine.mjs. The engine carries the order
// model itself (the stop-entry off the arm bar's open, the refused-stop limit,
// the exact day cap, the breaker and profit block as entry blocks, the
// management hooks); this file binds the shipped signal and numbers to it and
// keeps the API every research script imports. Options default to the
// conventions the recorded results were measured under, and
// test/legacy_parity.mjs holds run(), engineFor() and episode() to the code
// this replaced (test/oracles/lib_shipped_v1.mjs) trade for trade. The pass-rate
// helpers are src/dayeval.mjs.
//
// Clock-aligned 2-minute bars, Donchian(30) + ADX 25 + efficiency 0.5,
// stop-entry at 0.15xATR deferred one bar, 5xATR stop / 1.75xATR target,
// exact-mode day cap, circuit breaker and profit block as entry-only blocks.
//
// Instrument switch:  ORB_BIN=data/mes_1m.bin ORB_PV=5 node research/<x>.mjs

import { loadBars } from "../src/data.mjs";
import { resample, sliceBars } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER, filterPeriods } from "../src/filters.mjs";
import { atr } from "../src/indicators.mjs";
import { runBrackets, EXIT } from "../src/engine.mjs";
import { resolveParams } from "../src/run.mjs";
import book from "../strategies/donchian_eff_rth.mjs";
import { evalDays, mulberry32, dayVector, bootstrapPass } from "../src/dayeval.mjs";

export const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750;
export const PV = Number(process.env.ORB_PV || 2);
const TRIG = 0.15, ADD_WIN = 10, TICK = 0.25, PERSIDE = 0.75;
const FLAT = 905, NOENTRY = 895, RTH_OPEN = 510, REOPEN = 1020;

const { bars } = loadBars(process.env.ORB_BIN || undefined);
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const nB = tf.close.length;
// The signal is the strategy file's own -- breakout, ADX floor, efficiency gate
// and RTH window -- so the bot, the chart and this research cannot drift apart.
const bookFilter = { ...NO_FILTER, ...book.filterDefaults };
const sig = applyFilters(book.compute(tf, resolveParams(book, {})).sig, buildFilterContext(tf, filterPeriods(bookFilter)), bookFilter);
const { tday: TD, ts: TS } = tf;

export const days = [...new Set(TD)].sort((a, b) => a - b);
export const yearOf = new Map();
{
  const seen = new Set();
  for (let i = 0; i < nB; i++) if (!seen.has(TD[i])) { seen.add(TD[i]); yearOf.set(TD[i], new Date(TS[i]).getUTCFullYear()); }
}
export const H1 = days.slice(0, days.length >> 1), H2 = days.slice(days.length >> 1);
export const RECENT = days.slice(-500);

// The engine conventions every recorded result here was measured under: the
// order fills at its own price, the fill bar's open counts, an early close
// carries over, the exact cap does not absorb commission, an open position at
// the end of the data is left out. RTH only unless `overnight`: flat 15:05,
// entries until 14:55.
const SHIPPED_EXEC = {
  entryGapFill: "level", tpGapFill: "level", fillBarOpen: true, sessionEndFlat: "none",
  exactLossIncludesFees: false, capEndsDay: false, closeAtEnd: false, dayLossStopMode: "exact",
  intradayOnly: true, flattenCt: FLAT, noEntryMinsBeforeFlat: FLAT - NOENTRY,
  maxContracts: 1e9, tickSize: TICK, pointValue: PV, commissionModel: "per-contract",
  tpMode: "atr", dayProfitStopUsd: 0, scaleInFrac: 0, cooldownAfterStopMins: 0, maxBarsInTrade: 0,
};
// The engine's exit reasons in this file's vocabulary.
const WHY = { [EXIT.SL]: "SL", [EXIT.DAYLOSS]: "SLcap", [EXIT.TRAIL]: "TS", [EXIT.TP]: "TP",
              [EXIT.FLIP]: "FLIP", [EXIT.SIGNAL]: "XSIG", [EXIT.FLAT]: "FLAT" };

// sizer(atrAtSignal, ctMinAtArm, seq, armBar) -> lots, below 1 skips the signal.
// breaker/profitBlock are overridable because they were calibrated FOR THE
// COMBINE -- a race to +$3,000 under a consistency rule. A funded account has
// no target and no consistency rule, so neither setting can be assumed to
// carry over.
// entryModel decides what happens when the placement bar OPENS past the trigger,
// which is 40.8% of arms (research/arm_reject.mjs):
//   "optimistic" fills at the trigger anyway -- a price the market has already
//                left. This is what every number before a7a7bd0 assumed and it
//                is not achievable; kept only to reproduce old results.
//   "limit"      what the bot now does: the stop is refused, the same price goes
//                back as a LIMIT, and it fills if price returns.
// The other options, all optional, map one to one onto the engine's:
//   exitFn(sigBar, pos, state) / stopFn(bar, state) / tpFn(atr, lots) / onTrade(trade)
//                 the engine's hooks; state = { dir, fill, ep, atr, slD, tpD,
//                 entBar, qty, mx, mn, sigBar, tsl }
//   slMult, tpMult, trig, addWin   bracket and arm, in ATRs at the signal (5, 1.75,
//                 0.15, 10 bars)
//   signals       an alternative gated signal array on these bars
//   overnight     also trade the Globex session (flat only 15:05-17:00 CT; the
//                 signals passed must be gated to match)
//   costMult / slipMult / feeMult   slippage (x one tick a side) and commission
//                 (x $0.75 a side), each defaulting to costMult
//   tpFromFill    measure the target from the fill instead of the arm's open
//   limitFillTp   "high" | "close" -- the engine's limitFillTp
//   dayCap        the platform's daily loss limit ($1,000)
//   cancelOpposite, exitFirst, fillBarStop, sameBarTie   as in the engine (all
//                 default to the old behaviour: false, false, "touch", "stop")
//   entryLimitAtr a limit this many ATRs INTO the move instead of the stop-entry
//   noFlip        an opposite signal does not close the position
//   flipAll       ANY new signal closes it, and its order is then placed as usual
//   detail        also record entBar, xBar, dir and avg (average fill)
// makeRun binds the engine to one set of bars, so the same code can run on
// another bar size (engineFor below). The exported run is the 2-minute one.
function makeRun(t, a, sigDefault, minutesPerBar) {
  return function run(sizer, { costMult = 1, breaker = BREAKER, profitBlock = PROFIT_BLOCK,
                               entryModel = "limit", exitFn = null, stopFn = null,
                               slMult = 5, tpMult = 1.75, trig = TRIG, addWin = ADD_WIN,
                               signals = null, overnight = false, onTrade = null,
                               slipMult = null, feeMult = null, tpFn = null, tpFromFill = false,
                               limitFillTp = "high", dayCap = CAP, cancelOpposite = false,
                               exitFirst = false, entryLimitAtr = null, noFlip = false, flipAll = false,
                               detail = false, fillBarStop = "touch", sameBarTie = "stop" } = {}) {
    const trades = [];
    runBrackets(t, signals || sigDefault, a, {
      ...SHIPPED_EXEC,
      reopenCt: overnight ? REOPEN : RTH_OPEN,
      entryType: entryLimitAtr != null ? "limit" : "stop",
      entryTriggerAtr: trig, entryLimitAtr: entryLimitAtr ?? 0, entryWindowBars: addWin,
      entryRefused: entryModel === "optimistic" ? "optimistic" : "limit",
      cancelOpposite, tpFromFill, exitFirst, limitFillTp, fillBarStop, sameBarTie,
      flipOnOpposite: !noFlip, flipOnAnySignal: flipAll,
      slAtrMult: slMult, tpAtrMult: tpMult, tpFn,
      slippageTicks: slipMult ?? costMult, commissionPerSide: PERSIDE * (feeMult ?? costMult),
      dayLossStopUsd: dayCap, dayBreakerUsd: breaker, dayProfitBlockUsd: profitBlock,
      sizer, exitFn, stopFn,
      onTrade: (e) => {
        const r = { tday: e.tday, pnl: e.pnl, why: WHY[e.reason], entCt: e.entryCt, lots: e.contracts, atr: e.atr,
                    held: (e.exitIdx - e.entryIdx) * minutesPerBar, sigBar: e.sigIdx };
        if (detail) { r.entBar = e.entryIdx; r.xBar = e.exitIdx; r.dir = e.dir; r.avg = e.entryPrice; }
        trades.push(r);
        if (onTrade) onTrade(r);
      },
    });
    return trades;
  };
}
export const run = makeRun(tf, A, sig, 2);

// The same engine on another bar size: its bars, ATR and filter context, and a
// run() bound to them. It has no default signal -- pass `signals` built on
// these bars (Donchian, ADX and efficiency all depend on the bar size).
export function engineFor(tfMin) {
  if (tfMin === 2) return { tf, atr: A, ctx, run };
  const t = resample(bars, tfMin);
  const a = atr(t.high, t.low, t.close, 14);
  return { tf: t, atr: a, ctx: buildFilterContext(t), run: makeRun(t, a, new Int8Array(t.close.length), tfMin) };
}

// The combine, parameterised so the result can be checked against metric
// choices it was never tuned on. (src/dayeval.mjs)
export const evWith = (d, opts) => evalDays(d, opts);
export const mul = mulberry32;
export const dayArr = (trades, keys) => dayVector(trades, keys);
export const passArr = (arr, opts = {}) => bootstrapPass(arr, opts);
export const passOf = (trades, keys, opt) => passArr(dayArr(trades, keys), opt);

export function stat(t) {
  if (!t.length) return { n: 0, win: 0, pf: 0, exp: 0, net: 0, lots: 0 };
  let gw = 0, gl = 0, tot = 0, w = 0, lo = 0;
  for (const x of t) { tot += x.pnl; lo += x.lots; if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; }
  return { n: t.length, win: 100 * w / t.length, pf: gl > 0 ? gw / gl : Infinity,
           exp: tot / t.length, net: tot, lots: lo / t.length };
}
export const inSet = (t, s) => { const q = new Set(s); return t.filter(x => q.has(x.tday)); };

// ---- episode runner: the same engine, bounded to a day range, with the ACCOUNT
// visible to the sizer.
//
// run() above generates one continuous stream with a sizer that can only see the
// bar. That cannot express "trade smaller when close to the drawdown floor",
// because position size then depends on account equity and account equity
// depends on position size. This closes that loop through the engine's onTrade
// and haltFn hooks.
//
// The floor is the firm's: peak-2000 until peak reaches 2000, then 0 forever.
// `room` is equity minus floor -- how much can be lost before the account dies.
// sizer(atr, ctMin, state) where state = { acct, peak, locked, room, day }.
export const dayFirstBar = new Map();
for (let i = 0; i < nB; i++) if (!dayFirstBar.has(TD[i])) dayFirstBar.set(TD[i], i);
const dayIndex = new Map(days.map((d, k) => [d, k]));

export function episode(startDayIdx, nDays, sizer,
                        { breaker = BREAKER, profitBlock = PROFIT_BLOCK,
                          dd = 2000, costMult = 1,
                          // How the trailing drawdown behaves. This is the single
                          // most load-bearing assumption in any funded-account
                          // number, so it is switchable rather than baked in.
                          //   "lock"   floor = peak-dd until peak reaches dd, then
                          //            $0 forever (Topstep style: stops trailing)
                          //   "eod"    same, but the peak only ratchets on END OF
                          //            DAY balance, so intraday spikes do not
                          //            raise the floor
                          //   "always" floor = peak-dd forever, never stops
                          //            trailing however much profit is made
                          ddMode = "lock" } = {}) {
  const d0 = days[startDayIdx % days.length];
  const i0 = dayFirstBar.get(d0);
  const lastIdx = Math.min(startDayIdx + nDays, days.length) - 1;
  const dEnd = days[lastIdx % days.length];
  let stop = dayFirstBar.get(dEnd);
  while (stop < nB && TD[stop] === dEnd) stop++;

  let acct = 0, peak = 0, locked = false, trades = 0, dead = false, lastDay = null, deadAt = -1;
  const floorOf = () => (ddMode !== "always" && locked ? 0 : peak - dd);
  const ratchet = (v) => {
    if (v > peak) peak = v;
    if (ddMode !== "always" && !locked && peak >= dd) locked = true;
  };
  // Under "eod" the peak only moves at a day boundary, on the closing balance.
  // Nothing reads it between events, so it is applied at a day's first event.
  const dayTurn = (td) => { if (ddMode === "eod" && lastDay !== null && td !== lastDay) ratchet(acct); lastDay = td; };
  const dayNo = (td) => dayIndex.get(td) - dayIndex.get(d0) + 1;

  const s0 = Math.max(0, i0 - 1);        // the engine reads the signal of the bar before
  if (stop > i0) {
    runBrackets(sliceBars(tf, s0, stop), sig.subarray(s0, stop), A.subarray(s0, stop), {
      ...SHIPPED_EXEC, reopenCt: RTH_OPEN,
      entryType: "stop", entryTriggerAtr: TRIG, entryWindowBars: ADD_WIN, entryRefused: "optimistic",
      cancelOpposite: false, exitFirst: false, slAtrMult: 5, tpAtrMult: 1.75,
      slippageTicks: costMult, commissionPerSide: PERSIDE * costMult,
      dayLossStopUsd: CAP, dayBreakerUsd: breaker, dayProfitBlockUsd: profitBlock,
      sizer: (a, ct, seq, bar) => {
        const td = TD[s0 + bar];
        dayTurn(td);
        return sizer(a, ct, { acct, peak, locked, room: acct - floorOf(), day: dayNo(td) });
      },
      onTrade: (e) => {
        dayTurn(e.tday);
        acct += e.pnl; trades++;
        if (ddMode !== "eod") ratchet(acct);      // intraday ratchet
        // The floor is always checked live: the firm liquidates when equity touches
        // it, whatever the peak convention.
        if (acct <= floorOf()) { dead = true; deadAt = s0 + e.exitIdx; }
      },
      haltFn: () => dead,
    });
  }
  const dayCount = stop <= i0 ? 0 : dead ? dayNo(TD[deadAt]) : dayNo(dEnd);
  return { acct, dead, trades, days: dayCount };
}
