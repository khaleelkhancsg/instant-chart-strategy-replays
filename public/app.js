// App orchestration.
//
// The responsiveness trick: the strategy module and the rules engine are the
// SAME ES modules the server runs, imported straight into the page. A parameter
// change therefore re-runs the real backtest over the visible window locally —
// no request, no round trip, no server-side state. The only thing that goes over
// the network is the one-off window blob and the (debounced) 5-year sweep.

import { ChartView, Navigator, fmtUsd } from "/chart.js";
import { runStrategy } from "/src/run.mjs";
import { replayWindow, DEFAULT_RULES } from "/src/challenge.mjs";
import { DEFAULT_EXEC } from "/src/engine.mjs";
import { NO_FILTER } from "/src/filters.mjs";
import { indexAtOrAfter, resample } from "/src/resample.mjs";
import { windowSpan, DEFAULT_TAIL_MIN } from "/src/window.mjs";
import { EVALS, EVAL_IDS, DEFAULT_EVAL, evalBase, evalKeys } from "/src/evals.mjs";
import { STUDIES, STUDY_TFS, resolveStudy, studyLabel, isGating, gateLabel, computeStudy } from "/src/studies.mjs";
import { describeEntry, describeExit, eventText, explainLines, num as fmtNum, px as fmtPx } from "/src/explain.mjs";
import { loadIndicator, defaultProps, plotters, audit } from "/tradovate/mock/runtime.mjs";

// The 1-minute x-position a resampled bar should be drawn at: the middle of the
// minutes it covers. srcLast+1 is the exclusive end, so the centre of bar k is
// halfway between srcFirst[k] and srcLast[k]+1. At 1-minute that is i + 0.5,
// which is exactly where that candle's centre falls.
function barCentre(tf, idx, fallback) {
  if (!tf || !tf.srcFirst || idx == null || idx < 0 || idx >= tf.srcFirst.length) {
    return (fallback || 0) + 0.5;
  }
  return (tf.srcFirst[idx] + tf.srcLast[idx] + 1) / 2;
}

const _centreCache = new WeakMap();
function centresOf(tf) {
  const hit = _centreCache.get(tf);
  if (hit) return hit;
  const n = tf.srcFirst ? tf.srcFirst.length : 0;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[k] = (tf.srcFirst[k] + tf.srcLast[k] + 1) / 2;
  _centreCache.set(tf, out);
  return out;
}

const $ = (id) => document.getElementById(id);
const DAY = 86400000;

// ─────────────────────── parameter descriptors ───────────────────────
// A `bool` descriptor is an on/off select over a boolean config value.
const onOff = (on = "On", off = "Off") => [["on", on], ["off", off]];
const EXEC_PARAMS = [
  { key: "contracts", label: "Contracts", type: "int", min: 1, max: 20, step: 1, default: 8,
    hint: "Up to 20 MNQ. Capped by 'Max contracts' below." },
  { key: "maxContracts", label: "Max contracts (firm cap)", type: "int", min: 1, max: 20, step: 1, default: 20,
    hint: "The account's per-position limit. Bounds both fixed and risk sizing." },
  { key: "slAtrMult", label: "Stop (× ATR)", type: "float", min: 0.25, max: 1000, step: 0.25, default: 2,
    hint: "Strategies that exit on their own signals ship with 1000 (no stop)." },
  { key: "tpMode", label: "Target set by", type: "select", default: "atr",
    options: [["atr", "ATR multiple"], ["rr", "Reward : risk (× the stop)"]] },
  { key: "tpAtrMult", label: "Target (× ATR)", type: "float", min: 0.25, max: 1000, step: 0.25, default: 12,
    hint: "1000 = no target, so the strategy's own exit decides." },
  { key: "tpRR", label: "Target (× stop, R:R mode)", type: "float", min: 0.1, max: 30, step: 0.1, default: 1.2 },
  { key: "tpMaxUsd", label: "Target at most $ on the position (0 = off)", type: "int", min: 0, max: 10000, step: 25, default: 0,
    hint: "Caps the target's distance at this many dollars for the size traded. The $1,250 MACD fade uses $600: 75 points at 4 lots." },
  { key: "maxBarsInTrade", label: "Time stop (bars)", type: "int", min: 0, max: 2000, step: 1, default: 0, hint: "0 = off" },
  { key: "staleBars", label: "Stale exit after (bars, 0 = off)", type: "int", min: 0, max: 500, step: 1, default: 0,
    hint: "Leave at the next open once a trade has run this many signal bars without ever being the distance below in its favour. The $1,250 bot's 40-minute exit is 20 two-minute bars at 1 ATR." },
  { key: "staleMfeAtr", label: "Stale exit unless (× ATR in favour)", type: "float", min: 0.05, max: 10, step: 0.05, default: 1 },
  { key: "flipOnOpposite", label: "Close on opposite signal", type: "select", bool: true, default: "on", options: onOff("Yes — and reverse", "No — hold"),
    hint: "Off for signals that are a persistent state rather than an event, which would otherwise thrash." },
  { key: "cooldownAfterStopMins", label: "After a stop, wait (mins)", type: "int", min: 0, max: 600, step: 5, default: 0,
    hint: "No re-entry in the same direction for this long after a stop-out. 0 = off." },
  { key: "sameBarReentry", label: "Re-enter on the exit bar", type: "select", bool: true, default: "off", options: onOff(),
    hint: "NOT tradeable — the re-entry fills at the bar's open, before the exit. Only to reproduce other tooling." },
  { key: "commissionModel", label: "Commission model", type: "select", default: "per-contract",
    options: [["per-contract", "Per contract (realistic)"], ["flat", "Flat per trade (legacy)"]],
    hint: "Legacy lite_backtester runs used flat $5/trade, which understates cost ~2-3× at 8-10 lots." },
  { key: "commissionPerSide", label: "Commission $/side/contract", type: "float", min: 0, max: 3, step: 0.05, default: 0.75 },
  { key: "commissionFlat", label: "Flat commission $/trade", type: "float", min: 0, max: 30, step: 0.5, default: 5 },
  { key: "slippageTicks", label: "Slippage (ticks/side)", type: "float", min: 0, max: 4, step: 0.25, default: 0 },
  { key: "sizingMode", label: "Position sizing", type: "select", default: "fixed",
    options: [["fixed", "Fixed contracts"], ["risk", "Constant $ risk per trade"]],
    hint: "MNQ's ATR ran ~6 pts in 2019 and ~28 in 2026. Fixed size means one stop cost 11% of the drawdown then and 52% now." },
  { key: "riskDollars", label: "Risk per trade $ (risk mode)", type: "int", min: 50, max: 1500, step: 25, default: 400 },
  // The engine's platform-side caps. Unlike the rules' daily stops, which only
  // block NEW entries, these close the open trade on realised + open P&L.
  { key: "dayProfitStopUsd", label: "Hard daily profit cap $ (0 = off)", type: "int", min: 0, max: 10000, step: 50, default: 0,
    hint: "Closes the open trade the moment the day is up this much, as a platform profit stop does. At half the target ($1,500 on $3,000) no day can break the consistency cap, so a window passes at the target instead of having to dilute one big day." },
  { key: "dayLossStopUsd", label: "Hard daily loss cap $ (0 = off)", type: "int", min: 0, max: 10000, step: 50, default: 0,
    hint: "Closes the open trade the moment the day is down this much -- a daily loss limit enforced on live P&L, as platforms do. The rules' 'Firm daily loss limit' only stops new entries." },
  { key: "dayLossStopMode", label: "Hard loss cap fills", type: "select", default: "price",
    options: [["price", "At the stop price (a gap fills worse)"], ["exact", "Exactly at the cap (platform liquidation)"]] },
  // Scale-in: a fraction at the signal, the rest once price moves the right way.
  { key: "scaleInFrac", label: "Scale-in: share at entry (0 = off)", type: "float", min: 0, max: 0.9, step: 0.05, default: 0,
    hint: "e.g. 0.5 = half at the signal, half once price has moved the trigger distance in the trade's favour." },
  { key: "scaleInTrigger", label: "Scale-in: add after (× ATR in favour)", type: "float", min: 0, max: 5, step: 0.05, default: 0.25 },
  { key: "scaleInWindowBars", label: "Scale-in: give up after (bars)", type: "int", min: 1, max: 500, step: 1, default: 10 },
  { key: "scaleInOrder", label: "Scale-in vs bracket, same bar", type: "select", default: "before",
    options: [["before", "Add first"], ["after", "Bracket first (pessimistic)"]] },
  { key: "scaleInSlipTicks", label: "Scale-in: extra slippage (ticks)", type: "float", min: 0, max: 8, step: 0.25, default: 0 },
  // The instrument. The data is MNQ; NQ is the same index at 10x the point value.
  { key: "pointValue", label: "Point value $ (MNQ 2, NQ 20)", type: "float", min: 0.5, max: 50, step: 0.5, default: 2 },
  { key: "tickSize", label: "Tick size (points)", type: "float", min: 0.25, max: 1, step: 0.25, default: 0.25 },
];

// How a signal becomes a position, and what a 1-minute bar cannot say -- the
// engine's order model and intrabar options (src/engine.mjs DEFAULT_EXEC). The
// "(old)" choices reproduce the engine before these were made explicit.
const ORDER_PARAMS = [
  { key: "entryType", label: "Entry order", type: "select", default: "market",
    options: [["market", "Market, at the next open"], ["stop", "Stop beyond the next open (the bot's)"], ["limit", "Limit back into the move"]],
    hint: "Stop: rests 'trigger' x ATR beyond the open of the bar after the signal, working from the bar after that, so only breakouts that follow through fill. donchian_shipped runs the bot's stop." },
  { key: "entryTriggerAtr", label: "Stop entry: trigger (× ATR)", type: "float", min: 0, max: 3, step: 0.05, default: 0.15 },
  { key: "entryLimitAtr", label: "Limit entry: offset (× ATR)", type: "float", min: 0, max: 5, step: 0.05, default: 0.25 },
  { key: "entryWindowBars", label: "Entry order works for (bars)", type: "int", min: 1, max: 200, step: 1, default: 10 },
  { key: "entryRefused", label: "A stop the open already passed", type: "select", default: "limit",
    options: [["limit", "Rests as a limit at the same price (the bot)"], ["optimistic", "Fills anyway (not achievable)"]],
    hint: "A platform refuses a stop on the wrong side of the market -- 40.8% of the Donchian bot's arms." },
  { key: "cancelOpposite", label: "Opposite signal cancels the order", type: "select", bool: true, default: "on", options: onOff() },
  { key: "tpFromFill", label: "Stop/limit entry: target from", type: "select", bool: true, default: "off",
    options: [["off", "The order's reference open"], ["on", "The fill price"]] },
  { key: "exitFirst", label: "Exits decided at a close fill", type: "select", bool: true, default: "on",
    options: [["on", "At the next open, first"], ["off", "After that bar's stop / target (old)"]],
    hint: "A flip, exit signal or time stop is decided on the closed bar and fills at the next open -- before that bar can touch the stop or target." },
  { key: "entryBarExits", label: "Entry bar can stop / target it", type: "select", bool: true, default: "on",
    options: [["on", "Yes -- the whole bar follows an open fill"], ["off", "No (old)"]] },
  { key: "sameBarTie", label: "Stop and target in one bar", type: "select", default: "stop",
    options: [["stop", "Stop first (pessimistic)"], ["target", "Target first"]] },
  { key: "tpGapFill", label: "Open gaps through the target", type: "select", default: "open",
    options: [["open", "Fills at the open"], ["level", "Fills at the target (old)"]] },
  { key: "entryGapFill", label: "Open gaps through an entry order", type: "select", default: "open",
    options: [["open", "Fills at the open"], ["level", "Fills at its price (old)"]] },
  { key: "fillBarStop", label: "Resting fill bar: stop counts if", type: "select", default: "touch",
    options: [["touch", "Touched (pessimistic)"], ["close", "Closed beyond"]] },
  { key: "limitFillTp", label: "Limit fill bar: target counts if", type: "select", default: "high",
    options: [["high", "Touched"], ["close", "Closed beyond"]] },
  { key: "sessionEndFlat", label: "A session that closes early", type: "select", default: "close",
    options: [["close", "Flattens at its last bar"], ["none", "Carries over (old)"]] },
  { key: "capEndsDay", label: "A fired platform cap ends the day", type: "select", bool: true, default: "on", options: onOff("Yes", "No (old)") },
  { key: "dayBreakerUsd", label: "Engine day breaker $ (0 = off)", type: "int", min: 0, max: 5000, step: 50, default: 0,
    hint: "No new orders, and working ones cancelled, once the day's realised P&L is this far down -- where the bot applies it. The rules' 'Your daily breaker' is the post-hoc version." },
  { key: "dayProfitBlockUsd", label: "Engine profit block $ (0 = off)", type: "int", min: 0, max: 10000, step: 50, default: 0 },
  { key: "scaleOutFrac", label: "Scale-out: share banked (0 = off)", type: "float", min: 0, max: 0.9, step: 0.05, default: 0,
    hint: "Banks this share once price is the distance below in favour; the rest runs to the target with the stop unchanged." },
  { key: "scaleOutAtr", label: "Scale-out at (× ATR in favour)", type: "float", min: 0.1, max: 20, step: 0.1, default: 1 },
  { key: "flipOnAnySignal", label: "A same-way signal re-enters", type: "select", bool: true, default: "off", options: onOff(),
    hint: "Closes and re-enters on every new signal, for books whose trade is one signal-to-signal segment." },
];

// Funded stage. No consistency requirement here — a payout is unlocked by
// accumulating winning days worth more than a threshold.
const FUNDED_PARAMS = [
  { key: "winDayThreshold", label: "Winning day needs $", type: "int", min: 0, max: 2000, step: 25, default: 150 },
  { key: "winDaysRequired", label: "Winning days per payout", type: "int", min: 1, max: 30, step: 1, default: 5 },
  { key: "horizonDays", label: "Follow account for (days)", type: "int", min: 30, max: 730, step: 30, default: 180 },
  { key: "profitSplit", label: "Profit split %", type: "int", min: 10, max: 100, step: 5, default: 100,
    hint: "Assumed — set to your firm's actual split." },
  { key: "maxPayout", label: "Payout cap $ (0 = none)", type: "int", min: 0, max: 20000, step: 250, default: 0,
    hint: "Assumed — many firms cap early withdrawals." },
  { key: "minBuffer", label: "Profit that must stay in $", type: "int", min: 0, max: 5000, step: 100, default: 0,
    hint: "Assumed — some firms require a buffer above the starting balance." },
  { key: "resetWinDaysAfterPayout", label: "Winning days reset after a payout", type: "select", bool: true, default: "on", options: onOff("Yes", "No") },
];

// Signal gates, applied to any strategy. Defaults are off; the hints carry what
// the 198M-simulation filter search actually measured for each dimension.
const FILTER_PARAMS = [
  { key: "startCt", label: "Trade from (CT)", type: "time", min: 0, max: 1439, step: 5, default: 0, group: "Filters",
    hint: "Measured best-worst-half by window: RTH 08:30-15:00 36.2%, morning 35.4%, unrestricted 32.0%, afternoon 29.4%, late 12:30-15:00 only 20.9%." },
  { key: "endCt", label: "Trade until (CT)", type: "time", min: 0, max: 1440, step: 5, default: 1440, group: "Filters" },
  { key: "adxMin", label: "ADX minimum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 0, group: "Filters",
    hint: "adx>35 measured 35.4%, versus 34.2% with no regime gate at all." },
  { key: "adxMax", label: "ADX maximum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 0, group: "Filters" },
  { key: "effMin", label: "Efficiency ratio min", type: "float", min: 0, max: 1, step: 0.05, default: 0, group: "Filters",
    hint: "Kaufman ratio: net move / total path. 1 = a straight line, 0 = pure chop. The best single gate found — eff>0.5 scored 36.2%." },
  { key: "effMax", label: "Efficiency ratio max", type: "float", min: 0, max: 1, step: 0.05, default: 0, group: "Filters" },
  { key: "volMin", label: "ATR / its average, min", type: "float", min: 0, max: 3, step: 0.1, default: 0, group: "Filters" },
  { key: "volMax", label: "ATR / its average, max", type: "float", min: 0, max: 3, step: 0.1, default: 0, group: "Filters",
    hint: "Capping volatility HURT badly (25.1%) — it removes the dollar throughput needed to reach the target." },
  { key: "chopMin", label: "Choppiness min", type: "int", min: 0, max: 100, step: 1, default: 0, group: "Filters" },
  { key: "chopMax", label: "Choppiness max", type: "int", min: 0, max: 100, step: 1, default: 0, group: "Filters" },
  { key: "bwMin", label: "Bollinger bandwidth min", type: "float", min: 0, max: 0.1, step: 0.0005, default: 0, group: "Filters",
    hint: "(upper - lower) / middle of 2-sigma bands. A minimum skips squeezes; a maximum trades only them." },
  { key: "bwMax", label: "Bollinger bandwidth max", type: "float", min: 0, max: 0.1, step: 0.0005, default: 0, group: "Filters" },
  // The gate indicators' own periods, on the signal timeframe's bars.
  { key: "adxPeriod", label: "Filter ADX period", type: "int", min: 2, max: 100, step: 1, default: 14, group: "Filters" },
  { key: "atrPeriod", label: "Filter ATR period", type: "int", min: 2, max: 100, step: 1, default: 14, group: "Filters" },
  { key: "volMaPeriod", label: "ATR average length", type: "int", min: 2, max: 500, step: 1, default: 60, group: "Filters" },
  { key: "effPeriod", label: "Efficiency ratio period", type: "int", min: 2, max: 200, step: 1, default: 20, group: "Filters" },
  { key: "chopPeriod", label: "Choppiness period", type: "int", min: 2, max: 100, step: 1, default: 14, group: "Filters" },
  { key: "bwPeriod", label: "Bollinger period", type: "int", min: 2, max: 200, step: 1, default: 20, group: "Filters" },
];

const SESSION_PARAMS = [
  { key: "intradayOnly", label: "No overnight positions", type: "select", bool: true, default: "on",
    options: [["on", "Enforced — flat by deadline"], ["off", "Allow overnight holds"]],
    hint: "Most funded accounts require this. It truncates long-running winners, so it changes results a lot." },
  { key: "flattenCt", label: "Flatten by (CT)", type: "time", min: 0, max: 1439, step: 5, default: 15 * 60 + 5 },
  { key: "reopenCt", label: "Resume from (CT)", type: "time", min: 0, max: 1439, step: 5, default: 17 * 60 },
  { key: "noEntryMinsBeforeFlat", label: "No new entries (mins before flat)", type: "int", min: 0, max: 240, step: 5, default: 0,
    hint: "Entering minutes before the deadline pays commission for a trade that cannot develop." },
];

const RULES_PARAMS = [
  { key: "profitTarget", label: "Profit target $", type: "int", min: 500, max: 20000, step: 100, default: 3000 },
  { key: "trailingDD", label: "Trailing drawdown $", type: "int", min: 250, max: 10000, step: 50, default: 2000 },
  { key: "trailingMode", label: "Drawdown trails on", type: "select", default: "eod",
    options: [["eod", "Daily closes (lenient)"], ["intraday", "Intraday peak (strict)"]],
    hint: "EOD trailing means an intraday spike you give back before the close does not tighten your floor." },
  { key: "lockAtBreakeven", label: "Floor locks at breakeven", type: "select", bool: true, default: "on", options: onOff("Yes — once the peak reaches the drawdown", "No — trails for ever"),
    hint: "Most firms stop trailing once the floor reaches the starting balance." },
  { key: "evaluateOn", label: "Breach measured on", type: "select", default: "realized",
    options: [["realized", "Realised P&L only"], ["intraday", "Open equity (per-trade MAE)"]],
    hint: "Real firms breach on live equity. 'Open equity' checks each trade's worst excursion, pessimistically ordered." },
  { key: "dailyLossLimit", label: "Firm daily loss limit $", type: "int", min: 0, max: 5000, step: 50, default: 1000,
    hint: "Soft lockout — stop for the session, resume next day. Never fails the account." },
  { key: "dailyProfitStop", label: "Daily profit stop $", type: "int", min: 0, max: 5000, step: 50, default: 1500,
    hint: "Stops NEW entries once the day's realised P&L reaches this. A trade already running is not closed, so one trade can make far more -- and the consistency rule then raises what the window needs. To cap the day itself, use 'Hard daily profit cap' under Execution." },
  { key: "circuitBreaker", label: "Your daily breaker $", type: "int", min: 0, max: 2000, step: 25, default: 150,
    hint: "Your own tighter stop. The single biggest pass-rate lever in this project's testing. 0 = off." },
  { key: "consistencyPct", label: "Consistency cap % (0 = off)", type: "int", min: 0, max: 100, step: 5, default: 50,
    hint: "No single day may exceed this share of total profit. A day counts at its net P&L, so the window must reach max(target, best day / cap): a $12,000 day at 50% means $24,000 before it can pass." },
  { key: "consistencyGatesPass", label: "Consistency blocks the pass", type: "select", bool: true, default: "on",
    options: [["on", "Yes — must dilute first"], ["off", "No — pass on target"]],
    hint: "The evaluation enforces this: reaching the target on one oversized day does not pass, the window must keep trading until the best day is under the cap. The equity panel draws what that raises the target to. Payouts have no consistency rule — they gate on winning days instead." },
  { key: "minTradingDays", label: "Min trading days", type: "int", min: 0, max: 30, step: 1, default: 0 },
  { key: "windowDays", label: "Window length (days)", type: "int", min: 5, max: 90, step: 1, default: 30 },
];

// ─────────────────────────────── state ───────────────────────────────
const S = {
  meta: null,
  strategyList: [],
  strategyDesc: null,
  strategyMod: null,
  params: {},
  exec: { ...DEFAULT_EXEC },
  rules: { ...DEFAULT_RULES },
  funded: {},
  filter: { ...NO_FILTER },
  eval: DEFAULT_EVAL,  // which evaluation's rules (src/evals.mjs)
  studies: [],         // indicators added to the chart (src/studies.mjs), some gating entries
  tv: [],              // Tradovate indicators on the chart (tradovate/mock/)
  tvLib: null,         // what can be added, and the tools they run on
  tvFocus: true,       // the chart given over to them: no trades, equity or daily panes
  showSignals: false,  // mark every signal bar, entered or not (a view preference)
  why: null,           // the entry explained: { ts: its signal bar's open time }
  whyFolded: false,    // its card folded to the summary
  windowStart: null,
  blob: null,        // parsed window bars
  winStartLocal: 0,  // index of the window start inside the blob
  winEndLocal: 0,    // index of the first bar at or after the window end
  tailMin: DEFAULT_TAIL_MIN,   // bars loaded past the window end, so its last trade can finish
  chart: null,
  nav: null,
  sweep: null,       // last full-history sweep result
  sweepStale: false, // params changed since that sweep ran
  sweeping: false,
  sweepTimer: 0,
  lastSweepKey: "",
};

// ───────────────────────── binary window parsing ─────────────────────────
function parseWindowBlob(ab) {
  const dv = new DataView(ab);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "MNQW") throw new Error("bad window blob");
  const n = dv.getUint32(8, true);
  const startIdx = dv.getUint32(12, true);
  let off = 16;
  const f64 = (c) => { const a = new Float64Array(ab, off, c); off += c * 8; return a; };
  const f32 = (c) => { const a = new Float32Array(ab, off, c); off += c * 4; return a; };
  const i32 = (c) => { const a = new Int32Array(ab, off, c); off += c * 4; return a; };
  const i16 = (c) => { const a = new Int16Array(ab, off, c); off += c * 2; return a; };
  return {
    ts: f64(n), open: f32(n), high: f32(n), low: f32(n),
    close: f32(n), volume: f32(n), tday: i32(n), ctMin: i16(n),
    count: n, startIdx,
  };
}

// ─────────────────────────── sidebar rendering ───────────────────────────
function buildParamControl(d, value, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "param";

  const head = document.createElement("div");
  head.className = "param-head";
  const lab = document.createElement("label");
  lab.textContent = d.label;
  head.appendChild(lab);

  if (d.type === "select") {
    wrap.appendChild(head);
    const sel = document.createElement("select");
    for (const [v, t] of d.options) {
      const o = document.createElement("option");
      o.value = v; o.textContent = t;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => onChange(sel.value));
    wrap.appendChild(sel);
  } else if (d.type === "time") {
    // Minutes-of-day, shown as HH:MM so the control reads like the rule it encodes.
    const hhmm = (v) => `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
    const val = document.createElement("span");
    val.className = "param-val";
    val.style.width = "62px";
    val.textContent = hhmm(value);
    head.appendChild(val);
    wrap.appendChild(head);

    const rng = document.createElement("input");
    rng.type = "range";
    rng.min = d.min; rng.max = d.max; rng.step = d.step; rng.value = value;
    wrap.appendChild(rng);
    rng.addEventListener("input", () => {
      const v = Number(rng.value);
      val.textContent = hhmm(v);
      onChange(v);
    });
  } else if (d.type === "text") {
    wrap.appendChild(head);
    const box = document.createElement("input");
    box.type = "text";
    box.value = value ?? "";
    box.addEventListener("change", () => onChange(box.value));
    wrap.appendChild(box);
  } else {
    const num = document.createElement("input");
    num.type = "number";
    num.className = "param-val";
    num.value = value;
    num.min = d.min; num.max = d.max; num.step = d.step;
    head.appendChild(num);
    wrap.appendChild(head);

    const rng = document.createElement("input");
    rng.type = "range";
    rng.min = d.min; rng.max = d.max; rng.step = d.step; rng.value = value;
    wrap.appendChild(rng);

    const emit = (raw) => {
      let v = Number(raw);
      if (!Number.isFinite(v)) return;
      v = Math.min(d.max, Math.max(d.min, v));
      if (d.type === "int") v = Math.round(v);
      rng.value = v; num.value = v;
      onChange(v);
    };
    rng.addEventListener("input", () => emit(rng.value));
    num.addEventListener("change", () => emit(num.value));
  }

  if (d.hint) {
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = d.hint;
    wrap.appendChild(h);
  }
  return wrap;
}

// Which groups are folded is a preference, kept across strategies and visits.
const FOLDED = (() => { try { return JSON.parse(localStorage.getItem("mnq.folded") || "{}"); } catch { return {}; } })();
function buildGroup(title, collapsed = false) {
  const g = document.createElement("div");
  g.className = "group" + ((title in FOLDED ? FOLDED[title] : collapsed) ? " collapsed" : "");
  const head = document.createElement("div");
  head.className = "group-head";
  head.innerHTML = `<span class="group-title">${title}</span><span class="group-caret">▼</span>`;
  head.addEventListener("click", () => {
    FOLDED[title] = g.classList.toggle("collapsed");
    try { localStorage.setItem("mnq.folded", JSON.stringify(FOLDED)); } catch { /* private mode */ }
  });
  const body = document.createElement("div");
  body.className = "group-body";
  g.appendChild(head); g.appendChild(body);
  g.body = body;
  return g;
}

function renderSidebar() {
  const host = $("paramGroups");
  host.innerHTML = "";

  host.appendChild(buildTvGroup());

  // Live results first — it is what you watch while dragging a slider.
  const gStats = buildGroup("This window");
  gStats.body.innerHTML = `<div class="statgrid" id="statGrid"></div>`;
  host.appendChild(gStats);

  // Every signal in the window, taken or blocked by a rule: click one to zoom to it.
  const gTrades = buildGroup("Trades in this window", true);
  gTrades.querySelector(".group-title").insertAdjacentHTML("beforeend", `<span id="tradeCount"></span>`);
  gTrades.body.innerHTML = `<div id="tradeTable"></div>`;
  host.appendChild(gTrades);

  // …and the same view across every window in the dataset. One window is an
  // anecdote; this panel is the distribution the anecdote was drawn from.
  const gSweep = buildGroup("All windows");
  gSweep.body.innerHTML = `<div id="sweepPanel"></div>`;
  host.appendChild(gSweep);

  const gBreak = buildGroup("P&L by hour and weekday", true);
  gBreak.body.innerHTML = `<div id="breakPanel"></div>`;
  host.appendChild(gBreak);

  // How the book's trades did in each state of every indicator added below.
  const gEdge = buildGroup("Indicator edge");
  gEdge.body.innerHTML = `<div id="edgePanel"></div>`;
  host.appendChild(gEdge);

  // Passing the evaluation is a gate, not the goal — this is what the same book
  // would actually pay out once funded.
  const gFund = buildGroup("Funded stage — payouts");
  gFund.body.innerHTML = `<div id="fundedPanel"></div>`;
  host.appendChild(gFund);

  // Signal params, declared by the strategy itself.
  const sig = buildGroup("Signal");
  const tfDesc = {
    key: "timeframeMin", label: "Signal timeframe (min)", type: "int",
    min: 1, max: 60, step: 1, default: S.strategyDesc.timeframeMin,
    hint: "THIS is the one that changes results. Bars are rebuilt clock-aligned from the 1-minute source, and the indicators, the signals and the trades are all recomputed on them — donchian_shipped goes from 4,188 trades at 2m to 2,005 at 5m. The 'Candles' picker in the top bar only changes how the price is drawn.",
  };
  for (const d of [tfDesc, ...(S.strategyDesc.params || [])]) {
    sig.body.appendChild(buildParamControl(d, S.params[d.key], (v) => {
      S.params[d.key] = v;
      // A longer lookback can need more history than the window loaded.
      onParamsChanged(d.key === "timeframeMin" || warmupGrew());
    }));
  }
  host.appendChild(sig);

  host.appendChild(buildStudiesGroup());

  // One control per descriptor, bound to a config object. A `bool` descriptor
  // shows on/off but stores a boolean; a key the object lacks shows its default.
  const bind = (group, descs, obj, after = () => onParamsChanged()) => {
    for (const d of descs) {
      const raw = obj[d.key] ?? (d.bool ? d.default === "on" : d.default);
      group.body.appendChild(buildParamControl(d, d.bool ? (raw ? "on" : "off") : raw, (v) => {
        obj[d.key] = d.bool ? v === "on" : v;
        after(d);
      }));
    }
    host.appendChild(group);
  };
  bind(buildGroup("Execution & costs"), EXEC_PARAMS, S.exec);
  bind(buildGroup("Order model & intrabar"), ORDER_PARAMS, S.exec, () => onParamsChanged(warmupGrew()));
  // An active filter, or a longer filter period, can need more warm-up.
  bind(buildGroup("Signal filters", true), FILTER_PARAMS, S.filter, () => onParamsChanged(warmupGrew()));
  // Allowing overnight holds needs a longer warm-up (src/window.mjs).
  bind(buildGroup("Session rules"), SESSION_PARAMS, S.exec, () => onParamsChanged(warmupGrew()));
  bind(buildGroup("Combine rules"), RULES_PARAMS, S.rules,
       (d) => (d.key === "windowDays" ? loadWindow(S.windowStart) : onParamsChanged()));
  bind(buildGroup("Funded stage rules", true), FUNDED_PARAMS, S.funded);

  paintSweepStats();
  paintFundedStats();
  paintBreakdown();
  paintEdge();
  if (lastResult) paintTrades(lastResult.replay);
}

// ─────────────────────────── indicator studies ───────────────────────────
// Indicators the person adds to the chart, beside the strategy's own: each on its
// own timeframe, drawn on the price pane or in a pane of its own, and optionally
// gating the strategy's entries (src/studies.mjs).
const STUDY_COLORS = ["#f0b429", "#c678dd", "#56b6c2", "#ff9e64", "#9ece6a", "#7aa2f7", "#e0af68", "#f7768e", "#2ac3de", "#bb9af7"];
const OPEN_STUDIES = new Set();      // cards shown expanded, this visit
let studySeq = 0;
const nextStudyId = () => { const used = new Set(S.studies.map((s) => s.id)); let id; do id = `s${++studySeq}`; while (used.has(id)); return id; };
const nextColor = () => STUDY_COLORS.find((c) => !S.studies.some((s) => s.color === c)) || STUDY_COLORS[S.studies.length % STUDY_COLORS.length];
// Ids and colours for studies arriving from a URL, a saved layout or the chart
// link: kept when given (and unique), otherwise the next free ones.
function adoptStudies(list) {
  const out = [];
  for (const st of list) {
    const usedC = new Set(out.map((s) => s.color)), usedI = new Set(out.map((s) => s.id));
    const color = st.color || STUDY_COLORS.find((c) => !usedC.has(c)) || STUDY_COLORS[out.length % STUDY_COLORS.length];
    let id = st.id && !usedI.has(st.id) ? st.id : null;
    while (!id || usedI.has(id)) id = `s${++studySeq}`;
    out.push({ ...st, id, color });
  }
  return out;
}

function saveStudies() {
  try { localStorage.setItem("mnq.studies", JSON.stringify(S.studies)); } catch { /* private mode */ }
}
function studiesChanged() {
  saveStudies();
  const n = S.studies.length, g = S.studies.filter(isGating).length;
  const badge = $("studyCount");
  if (badge) badge.textContent = n ? ` · ${n}${g ? ` (${g} gating)` : ""}` : "";
  onParamsChanged(warmupGrew());
}

function addStudy(type) {
  const st = { ...resolveStudy({ type, tf: 0 }), id: nextStudyId(), color: nextColor() };
  S.studies.push(st);
  OPEN_STUDIES.add(st.id);
  renderSidebar();
  studiesChanged();
}

function buildStudiesGroup() {
  const g = buildGroup("Indicators");
  g.querySelector(".group-title").insertAdjacentHTML("beforeend", `<span id="studyCount"></span>`);
  const pick = document.createElement("select");
  pick.className = "st-pick";
  const groups = new Map();
  for (const [type, d] of Object.entries(STUDIES)) {
    if (!groups.has(d.group)) groups.set(d.group, []);
    groups.get(d.group).push(`<option value="${type}">${d.name}</option>`);
  }
  pick.innerHTML = `<option value="">＋ Add an indicator…</option>` +
    [...groups].map(([name, opts]) => `<optgroup label="${name}">${opts.join("")}</optgroup>`).join("");
  pick.onchange = () => { const v = pick.value; pick.value = ""; if (v) addStudy(v); };
  g.body.appendChild(pick);
  for (const st of S.studies) g.body.appendChild(buildStudyCard(st));
  const h = document.createElement("div");
  h.className = "hint";
  h.textContent = S.studies.length
    ? "A gate refuses entries only: a refused signal still closes an opposite position, so a gate never changes how a trade exits. A study on a longer timeframe is read from its last CLOSED bar, drawn as steps where each value became known."
    : "Add indicators to see them beside the strategy's, and in “Indicator edge” how its trades did in each of their states. Set a gate to trade only the states you pick.";
  g.body.appendChild(h);
  const n = S.studies.length, gn = S.studies.filter(isGating).length;
  g.querySelector("#studyCount").textContent = n ? ` · ${n}${gn ? ` (${gn} gating)` : ""}` : "";
  return g;
}

function buildStudyCard(st) {
  const D = STUDIES[st.type];
  const card = document.createElement("div");
  card.className = "st-card" + (OPEN_STUDIES.has(st.id) ? " open" : "") + (st.hidden ? " hidden-st" : "");
  const head = document.createElement("div");
  head.className = "st-head";
  head.innerHTML =
    `<input type="color" class="st-color" value="${st.color}" title="Colour">` +
    `<span class="st-name"></span><span class="st-gate" title="This indicator gates the strategy's entries">GATE</span>` +
    `<button class="st-btn st-eye" title="Hide or show it on the chart">${st.hidden ? "◌" : "●"}</button>` +
    `<button class="st-btn st-x" title="Remove">✕</button>`;
  const name = head.querySelector(".st-name"), gateBadge = head.querySelector(".st-gate");
  name.dataset.id = st.id;
  const refreshHead = () => {
    name.textContent = studyLabel(st) + (st.tf ? "" : ` · ${S.params.timeframeMin}m`);
    name.title = `${D.name} — click to ${card.classList.contains("open") ? "close" : "edit"}`;
    gateBadge.style.display = isGating(st) ? "" : "none";
  };
  refreshHead();
  name.onclick = () => {
    card.classList.toggle("open");
    if (card.classList.contains("open")) OPEN_STUDIES.add(st.id); else OPEN_STUDIES.delete(st.id);
    refreshHead();
  };
  head.querySelector(".st-color").oninput = (e) => { st.color = e.target.value; saveStudies(); repaint(); };
  head.querySelector(".st-eye").onclick = (e) => {
    st.hidden = !st.hidden;
    e.target.textContent = st.hidden ? "◌" : "●";
    card.classList.toggle("hidden-st", !!st.hidden);
    saveStudies(); repaint();
  };
  head.querySelector(".st-x").onclick = () => {
    S.studies = S.studies.filter((x) => x !== st);
    OPEN_STUDIES.delete(st.id);
    renderSidebar();
    studiesChanged();
  };
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "st-body";
  const sigTf = S.params.timeframeMin;
  const tfDesc = { key: "tf", label: "Timeframe", type: "select", default: "0",
                   options: [["0", `The signal's (${sigTf} min)`], ...STUDY_TFS.map((m) => [String(m), m < 60 ? `${m} min` : `${m / 60} hour${m > 60 ? "s" : ""}`])],
                   hint: "Its own bars, rebuilt clock-aligned from the 1-minute data." };
  body.appendChild(buildParamControl(tfDesc, String(st.tf || 0), (v) => { st.tf = Number(v); refreshHead(); studiesChanged(); }));
  // A gate's wording quotes the study's levels, so it is rebuilt when they move.
  const gateSlot = document.createElement("div");
  const buildGate = () => {
    gateSlot.innerHTML = "";
    const desc = { key: "gate", label: "Gate the strategy's entries", type: "select", default: "off",
                   options: [["off", "Off — draw only"], ...D.gates.map((m) => [m, gateLabel(st.type, m, st.params)])] };
    gateSlot.appendChild(buildParamControl(desc, st.gate, (v) => { st.gate = v; refreshHead(); studiesChanged(); }));
  };
  for (const d of D.params) {
    body.appendChild(buildParamControl(d, st.params[d.key], (v) => {
      st.params[d.key] = v;
      refreshHead();
      if (d.key === "lo" || d.key === "hi") buildGate();
      studiesChanged();
    }));
  }
  buildGate();
  body.appendChild(gateSlot);
  if (D.hint) { const h = document.createElement("div"); h.className = "hint"; h.textContent = D.hint; body.appendChild(h); }
  card.appendChild(body);
  return card;
}

// A study on "the signal's" timeframe names it, so its card follows that slider.
function refreshStudyNames() {
  for (const el of document.querySelectorAll(".st-name[data-id]")) {
    const st = S.studies.find((x) => x.id === el.dataset.id);
    if (st && !st.tf) el.textContent = `${studyLabel(st)} · ${S.params.timeframeMin}m`;
  }
}

// The studies drawn on the chart: each computed on its own bars and placed on
// the 1-minute axis -- at bar centres, or as steps from each bar's close for a
// timeframe longer than the signal's.
function studyOverlays(res) {
  refreshStudyNames();
  const sigTf = S.params.timeframeMin || 1, out = [];
  for (const st of S.studies) {
    const D = STUDIES[st.type];
    const { bars: sb, out: o, tf } = computeStudy(S.blob, st, sigTf, res.tf);
    const step = tf > sigTf;
    const map = step
      ? { localIdx: Float64Array.from(sb.srcLast, (v) => v + 1), stride: tf, step: true }
      : { localIdx: centresOf(sb), stride: tf };
    const lv = D.levels ? D.levels(st.params) : null;
    const guides = D.pane === "sub" && lv ? [...new Set([lv.lo, lv.mid, lv.hi].filter((v) => v != null && Number.isFinite(v)))] : [];
    out.push({
      key: `st:${st.id}`, name: studyLabel(st) + (st.tf ? "" : ` · ${sigTf}m`), color: st.color, pane: D.pane, hidden: !!st.hidden,
      gateText: isGating(st) ? gateLabel(st.type, st.gate, st.params) : "",
      lines: o.lines, map, range: D.range || null, auto: D.auto || null, guides,
    });
  }
  return out;
}

// ──────────────────────────── Tradovate indicators ─────────────────────────────
// An indicator written for Tradovate, run by the mock of its runtime (tradovate/
// mock/) on this chart's own bars, so it can be looked at and its settings tried
// before it goes to the platform. Nothing leaves this machine: the code is the file
// on disk, the bars are the window's, and it runs here in the page.
const TV_WARMUP_MIN = 21 * 1440;     // three weeks: a 10-session average, and a slow EMA settled
const TV_MINUTES = [1, 2, 3, 5, 10, 15, 30, 60];
const OPEN_TV = new Set();           // cards shown expanded, this visit
const tvWarmupMin = () => (S.tv.length ? TV_WARMUP_MIN : 0);
const tvFocused = () => S.tv.length > 0 && S.tvFocus;

// An indicator from its file, with `props` over its defaults. Read fresh each time.
async function tvMake({ name, minutes, props = {}, hidden = false }) {
  const r = await fetch(`/api/tradovate/source?name=${encodeURIComponent(name)}`), src = await r.json();
  if (!r.ok) throw new Error(src.error);
  const mod = loadIndicator(src.source, S.tvLib.tools), d0 = defaultProps(mod), set = {};
  for (const [k, v] of Object.entries(props)) {
    if (!(k in d0)) throw new Error(`${name} has no setting "${k}"`);
    set[k] = typeof v === "string" ? coerceLike(d0[k], v) : v;
  }
  return { name, source: src.source, mod, minutes: Number(minutes) || src.minutes, props: { ...d0, ...set }, hidden, plot: plotters(mod), key: "" };
}

// Its bars, built clock-aligned from the window's 1-minute bars once per size.
const tvBarCache = new WeakMap();
function tvBars(minutes) {
  let byMin = tvBarCache.get(S.blob);
  if (!byMin) tvBarCache.set(S.blob, byMin = new Map());
  if (!byMin.has(minutes)) {
    const tf = resample(S.blob, minutes), n = tf.close.length, rows = new Array(n);
    for (let i = 0; i < n; i++) rows[i] = { ts: tf.ts[i], o: tf.open[i], h: tf.high[i], l: tf.low[i], c: tf.close[i], v: tf.volume[i], td: tf.tday[i], ct: tf.ctMin[i] };
    byMin.set(minutes, { tf, rows });
  }
  return byMin.get(minutes);
}

// Run it, and check it, when its bars or settings have changed.
function tvRun(ind) {
  const key = `${S.blob.ts[0]}:${S.blob.count}:${ind.minutes}:${JSON.stringify(ind.props)}`;
  if (ind.key === key) return;
  const { tf, rows } = tvBars(ind.minutes);
  const a = audit(ind.mod, ind.source, rows, { props: ind.props, minutes: ind.minutes, formingFrom: Math.max(0, rows.length - 4000) });
  ind.run = a.run; ind.problems = a.problems; ind.tf = tf; ind.key = key;
  const titles = ind.mod.plots || { value: { title: ind.name } };
  ind.lines = Object.entries(titles).filter(([, d]) => !d.displayOnly)
    .map(([f, d]) => ({ name: d.title, data: Float64Array.from(a.run.rows, (r) => (typeof r[f] === "number" ? r[f] : NaN)) }));
  tvPaintChecks(ind);
}

// On the chart each one is a study, so panes, the crosshair and the price scale
// take it as they take any other; `tv` tells the chart to draw it through the mock.
function tvOverlays() {
  return S.tv.map((ind) => {
    tvRun(ind);
    return { key: `tv:${ind.name}`, name: `${ind.name} · ${ind.minutes}m`, color: "#9fb3c8", pane: ind.mod.areaChoice === "new" ? "sub" : "price",
             hidden: ind.hidden, lines: ind.lines, map: { localIdx: centresOf(ind.tf), stride: ind.minutes }, tv: ind };
  });
}

// The window's first day, 08:15-15:15 CT: what an indicator is looked at on.
function tvDayView() {
  const b = S.blob, td = b.tday[Math.min(S.winStartLocal, b.count - 1)];
  const inDay = (i) => i < b.count && b.tday[i] === td && b.ctMin[i] >= 495 && b.ctMin[i] <= 915;
  let a = S.winStartLocal;
  while (a < b.count && !inDay(a)) a++;
  if (a >= b.count) return null;
  let e = a;
  while (inDay(e + 1)) e++;
  return [a, e + 1];
}
function tvShowDay() {
  const v = tvFocused() ? tvDayView() : null;
  if (v) S.chart.zoomTo(v[0], v[1]);
}

function saveTv() {
  try { localStorage.setItem("mnq.tv", JSON.stringify({ focus: S.tvFocus, list: tvConfig() })); } catch { /* private mode */ }
}
// What identifies each one: its name, its bars, and the settings changed.
function tvConfig() {
  return S.tv.map((ind) => {
    const d0 = defaultProps(ind.mod), props = {};
    for (const [k, v] of Object.entries(ind.props)) if (v !== d0[k]) props[k] = v;
    return { name: ind.name, minutes: ind.minutes, props, ...(ind.hidden ? { hidden: true } : {}) };
  });
}
async function tvChanged({ day = false } = {}) {
  saveTv();
  renderSidebar();
  if (warmupGrew()) await loadWindow(S.windowStart);
  else recompute();
  if (day) tvShowDay();
}
async function addTv(name) {
  if (S.tv.some((x) => x.name === name)) return;
  try {
    S.tv.push(await tvMake({ name }));
  } catch (e) { toast(`${name}: ${e.message}`, true); return; }
  OPEN_TV.add(name);
  await tvChanged({ day: true });
}

// Numbers get a slider's range from the indicator's own restrictions.
function tvParamDesc(key, spec) {
  const s = spec && typeof spec === "object" ? spec : { def: spec };
  if (s.type === "boolean") return { key, label: key, type: "select", options: onOff(), bool: true };
  if (s.type === "enum") return { key, label: key, type: "select", options: Object.entries(s.enumSet || {}) };
  if (s.type !== "number") return { key, label: key, type: "text" };
  const r = s.restrictions || {}, step = r.step || 1;
  return { key, label: key, type: Number.isInteger(step) ? "int" : "float", step, min: r.min ?? 0, max: r.max ?? Math.max(10, Math.abs(s.def) * 4) };
}

function tvPaintChecks(ind) {
  const box = document.querySelector(`.tv-checks[data-name="${ind.name}"]`);
  if (!box) return;
  box.innerHTML = "";
  if (!ind.problems || !ind.problems.length) {
    box.innerHTML = `<div class="tv-check pass"><i>pass</i><span>Well formed, and a forming bar changes nothing.</span></div>`;
    return;
  }
  for (const p of ind.problems) {
    const b = document.createElement("button");
    b.className = `tv-check ${p.level}`;
    b.title = "Show the first bar it happened on";
    b.innerHTML = `<i>${p.level}</i><span></span>`;
    b.lastChild.textContent = p.text + (p.count > 1 ? ` (${p.count} times)` : "");
    b.onclick = () => { const c = ind.tf.srcFirst[p.bar]; S.chart.zoomTo(c - 60 * ind.minutes, c + 60 * ind.minutes); };
    box.appendChild(b);
  }
}

// How it fits at this zoom, from what the chart just drew.
function tvPaintFit(ind, f) {
  const el = document.querySelector(`.tv-fit[data-name="${ind.name}"]`);
  if (el) el.textContent = `${f.barW.toFixed(1)} px a bar · ${f.labels} labels` + (f.clash ? ` · ${f.clash.length} overlapping` : "");
}

function buildTvCard(ind) {
  const card = document.createElement("div");
  card.className = "st-card" + (OPEN_TV.has(ind.name) ? " open" : "") + (ind.hidden ? " hidden-st" : "");
  const head = document.createElement("div");
  head.className = "st-head";
  head.innerHTML = `<span class="st-name"></span>` +
    `<button class="st-btn st-re" title="Read the file again, keeping these settings">↻</button>` +
    `<button class="st-btn st-eye" title="Hide or show it on the chart">${ind.hidden ? "◌" : "●"}</button>` +
    `<button class="st-btn st-x" title="Remove">✕</button>`;
  const name = head.querySelector(".st-name");
  name.textContent = `${ind.name} · ${ind.minutes}m`;
  name.title = ind.mod.description || ind.name;
  name.onclick = () => {
    if (card.classList.toggle("open")) OPEN_TV.add(ind.name); else OPEN_TV.delete(ind.name);
  };
  head.querySelector(".st-re").onclick = async () => {
    try {
      const fresh = await tvMake({ ...tvConfig().find((c) => c.name === ind.name) });
      S.tv[S.tv.indexOf(ind)] = fresh;
      await tvChanged();
      toast(`${ind.name} read again`);
    } catch (e) { toast(`${ind.name}: ${e.message}`, true); }
  };
  head.querySelector(".st-eye").onclick = () => { ind.hidden = !ind.hidden; tvChanged(); };
  head.querySelector(".st-x").onclick = () => { S.tv = S.tv.filter((x) => x !== ind); OPEN_TV.delete(ind.name); tvChanged(); };
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "st-body";
  body.insertAdjacentHTML("beforeend", `<div class="tv-checks" data-name="${ind.name}"></div><div class="tv-fit" data-name="${ind.name}"></div>`);
  const tfDesc = { key: "minutes", label: "Chart bars", type: "select", options: TV_MINUTES.map((m) => [String(m), `${m} min`]) };
  body.appendChild(buildParamControl(tfDesc, String(ind.minutes), (v) => { ind.minutes = Number(v); tvChanged(); }));
  for (const [k, spec] of Object.entries(ind.mod.params || {})) {
    const d = tvParamDesc(k, spec), v = ind.props[k];
    body.appendChild(buildParamControl(d, d.bool ? (v ? "on" : "off") : v, (x) => { ind.props[k] = d.bool ? x === "on" : x; saveTv(); recompute(); }));
  }
  card.appendChild(body);
  tvPaintChecks(ind);
  return card;
}

function buildTvGroup() {
  const g = buildGroup("Tradovate indicators");
  const pick = document.createElement("select");
  pick.className = "st-pick";
  const opts = (list) => list.map((x) => `<option value="${x.name}">${x.name.replace("builtin:", "")}</option>`).join("");
  pick.innerHTML = `<option value="">＋ Add a Tradovate indicator…</option>` +
    `<optgroup label="Yours">${opts(S.tvLib.mine)}</optgroup><optgroup label="Tradovate's own">${opts(S.tvLib.builtin)}</optgroup>`;
  pick.onchange = () => { const v = pick.value; pick.value = ""; if (v) addTv(v); };
  g.body.appendChild(pick);
  if (S.tv.length) {
    const d = { key: "focus", label: "Chart shows", type: "select", options: [["on", "The indicator only"], ["off", "The indicator and the strategy"]] };
    g.body.appendChild(buildParamControl(d, S.tvFocus ? "on" : "off", (v) => { S.tvFocus = v === "on"; tvChanged({ day: true }); }));
  }
  for (const ind of S.tv) { tvRunSafe(ind); g.body.appendChild(buildTvCard(ind)); }
  const h = document.createElement("div");
  h.className = "hint";
  h.textContent = S.tv.length
    ? "Runs the file on this window's bars, here in the page. Edit the file, then ↻ reads it again. Day arrows walk the chart a day at a time."
    : "Try an indicator on the backtest's bars before it goes to Tradovate: how it looks, its settings, and what would go wrong there.";
  g.body.appendChild(h);
  return g;
}
const tvRunSafe = (ind) => { if (S.blob) tvRun(ind); };

// ───────────────────── indicator edge (from the sweep) ─────────────────────
function paintEdge() {
  const host = $("edgePanel");
  if (!host) return;
  if (!S.studies.length) {
    host.innerHTML = `<div class="sweep-empty">Add an indicator under <b>Indicators</b> to split this book's trades by its state at each signal.</div>`;
    return;
  }
  const sw = S.sweep;
  if (!sw || !sw.edge) {
    host.innerHTML = `<div class="sweep-empty">${S.sweeping ? "Sweeping…" : "Run the sweep to see how the trades did in each indicator state."}</div>`;
    return;
  }
  const cell = (r, m) => {
    if (!r || !r.trades) return `<span class="bk-bar"></span><span class="bk-v">—</span>`;
    const w = (Math.abs(r.net) / m) * 50;
    return `<span class="bk-bar" title="${r.trades} trades · ${r.winRate}% won · PF ${r.profitFactor ?? "∞"} · ${fmtUsd(r.net)}">` +
           `<i class="${r.net >= 0 ? "pos" : "neg"}" style="width:${w.toFixed(1)}%"></i></span><span class="bk-v ${r.net >= 0 ? "pos" : "neg"}">${fmtK(r.net)}</span>`;
  };
  host.innerHTML = `<div class="${S.sweepStale ? "stale" : ""}">` + sw.edge.map((e) => {
    const st = S.studies.find((x) => x.id === e.id);
    const tables = e.tables.map((t) => {
      const mA = Math.max(1, ...t.rows.map((r) => Math.abs(r.all.net))), m26 = Math.max(1, ...t.rows.map((r) => Math.abs(r.y2026.net)));
      return `<div class="ek-title">${t.title}</div>` +
        `<div class="ek head"><span class="bk-h">All history</span><span class="bk-h">2026</span></div>` +
        t.rows.map((r) => `<div class="ek"><span class="ek-k" title="${r.label}">${r.label}<i>${r.all.trades} trades · ${r.all.winRate ?? "—"}% won${r.y2026.trades ? ` · 2026: ${r.y2026.trades}` : ""}</i></span>` +
                          `${cell(r.all, mA)}${cell(r.y2026, m26)}</div>`).join("");
    }).join("");
    return `<div class="ek-study"><div class="ek-name" style="color:${st ? st.color : "var(--text)"}">${e.label}${e.gate && e.gate !== "off" ? ` <span class="st-gate">GATE</span>` : ""}</div>${tables || `<div class="sweep-empty">Not enough readings.</div>`}</div>`;
  }).join("") +
  `<div class="sweep-foot">Every trade of the full run, by the indicator's state at its signal bar -- read as a gate would read it. Net P&amp;L; hover a bar for trades, win rate and profit factor. A gate also changes which trades follow, so confirm one with the pass rate.</div></div>`;
}

// ───────────────────── trades in this window ─────────────────────
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SKIP_WHY = { profitStop: "daily profit stop", breaker: "your daily breaker", dailyLoss: "firm daily limit", outside: "outside window" };
const ctClock = (m) => (m == null ? "" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
// The trading day a time falls in (its session opens at 17:00 CT the evening before).
const tradingDayOf = (ms) => S.blob.tday[Math.min(S.blob.count - 1, indexAtOrAfter(S.blob.ts, ms))];

function paintTrades(replay) {
  const host = $("tradeTable");
  if (!host || !S.blob) return;
  const ev = replay.events;
  $("tradeCount").textContent = ev.length ? ` · ${ev.length}` : "";
  if (!ev.length) { host.innerHTML = `<div class="sweep-empty">No signals in this window.</div>`; return; }
  const rows = ev.map((e, k) => {
    const t = e.t, d = new Date(tradingDayOf(t.entryTime) * DAY);
    const tip = `${t.dir === 1 ? "Long" : "Short"} ${t.contracts} @ ${t.entryPrice.toFixed(2)} → ${t.exitPrice.toFixed(2)}` +
                (e.taken ? ` · equity after ${fmtUsd(e.cum)}` : ` · blocked by ${SKIP_WHY[e.skip] || e.skip}`);
    return `<tr data-k="${k}" class="${!e.taken ? "skip" : t.pnl > 0 ? "pos" : "neg"}" title="${tip}">` +
      `<td>${WEEKDAY[d.getUTCDay()]} ${d.toISOString().slice(5, 10)} ${ctClock(t.entryCt)}</td>` +
      `<td>${t.dir === 1 ? "L" : "S"}${t.contracts}</td><td>${t.reason}</td>` +
      `<td class="num">${e.taken ? fmtUsd(t.pnl) : "skipped"}</td></tr>`;
  });
  host.innerHTML =
    `<table class="ttable"><thead><tr><th>Entry (CT)</th><th>Side</th><th>Exit</th><th class="num">P&amp;L</th></tr></thead>` +
    `<tbody>${rows.join("")}</tbody></table>` +
    `<div class="tt-foot"><span>Click a trade to see what triggered it</span><button class="mini" id="tradesCsv" title="Download this window's trades">CSV</button></div>`;
  host.querySelector("tbody").onclick = (me) => {
    const tr = me.target.closest("tr");
    if (!tr) return;
    const t = ev[+tr.dataset.k].t, pad = Math.max(45, (t.exitSrc - t.entrySrc) * 0.75);
    S.chart.zoomTo(Math.min(t.entrySrc, signalSrc(t)) - pad, t.exitSrc + pad);
    selectWhy(t);
  };
  $("tradesCsv").onclick = () => downloadCsv(`${S.strategyDesc.id}_${$("startDate").value}_trades.csv`, [
    ["entry_utc", "trading_day", "entry_ct", "side", "contracts", "entry_price", "exit_utc", "exit_price", "reason", "pnl", "fees",
     "taken", "skipped_by", "equity_after", "floor", "mae", "mfe", "bars"],
    ...ev.map((e) => {
      const t = e.t;
      return [isoMin(t.entryTime), new Date(tradingDayOf(t.entryTime) * DAY).toISOString().slice(0, 10), ctClock(t.entryCt),
              t.dir === 1 ? "long" : "short", t.contracts, t.entryPrice.toFixed(2), isoMin(t.exitTime), t.exitPrice.toFixed(2), t.reason,
              t.pnl.toFixed(2), (t.fees || 0).toFixed(2), e.taken, e.skip || "", e.taken ? e.cum.toFixed(2) : "", e.floor == null ? "" : e.floor.toFixed(2),
              t.mae == null ? "" : t.mae.toFixed(2), t.mfe == null ? "" : t.mfe.toFixed(2), t.bars];
    }),
  ]);
}

// ───────────────────── why: what triggered an entry ─────────────────────
// Click a trade (on the chart or in the list) or a signal marker: the chart
// marks what the rule read -- the level broken, the bars it came from, the
// order and its fill, the signal bar through the indicator panes -- and the
// card lists every condition with its reading, a mini-chart of the indicator,
// the order, the bracket and the exit. All of it is the strategy's own
// explain() (src/explain.mjs), whose verdict test.mjs holds to the signal.
// Kept by the signal bar's time, so it follows a re-run when a setting moves.
const centreOf = (tf, k) => (tf.srcFirst[k] + tf.srcLast[k] + 1) / 2;
const signalSrc = (t) => (lastResult && t.sigIdx >= 0 ? lastResult.res.tf.srcFirst[t.sigIdx] : t.entrySrc);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function selectWhy(t) {
  const tf = lastResult && lastResult.res.tf;
  const k = t && (t.sigIdx ?? t.k);
  S.why = tf && k != null && k >= 0 && k < tf.ts.length ? { ts: tf.ts[k] } : null;
  repaint();
  if (S.why) revealWhy(tf, k, t.exitSrc);
  queuePostState();
}

// Bring the signal bar and its trade into the part of the chart the card
// leaves free, zooming out only as far as that needs. A view that already
// shows them there is left alone.
function revealWhy(tf, k, exitSrc) {
  const c = S.chart, card = $("whyCard"), W = c.data && c.data.why;
  let a = tf.srcFirst[k];
  const b = Math.max(a + 1, exitSrc ?? tf.srcLast[Math.min(tf.ts.length - 1, k + 10)] + 1);
  // and what the marks show -- the lookback, the opening range -- up to three hours back
  if (W) for (const m of W.marks) { const x0 = m.x0 ?? m.x ?? (m.xs && m.xs[0]); if (Number.isFinite(x0) && x0 < a && a - x0 <= 180) a = x0; }
  const freeR = card && !card.classList.contains("hidden") ? Math.min(c.plotR, card.offsetLeft - 12) : c.plotR;
  const freeW = Math.max(120, freeR - c.plotL);
  const shown = (i) => i >= c.i0 && c.x(i) <= c.plotL + freeW;
  if (shown(a - 5) && shown(b)) return;
  const pad = Math.max(20, (b - a) * 0.15), need = b - a + 2 * pad;
  c.zoomTo(a - pad, a - pad + need * (c.plotW / freeW));
}

// A strategy mark (its bar indexes) on the 1-minute axis the chart draws in.
function markToLocal(m, tf) {
  const n = tf.ts.length, ok = (k) => k >= 0 && k < n;
  switch (m.type) {
    case "level": case "zone": return ok(m.k0) && ok(m.k1) ? { ...m, x0: tf.srcFirst[m.k0], x1: tf.srcLast[m.k1] + 1 } : null;
    case "dot": case "sub": return ok(m.k) ? { ...m, x: centreOf(tf, m.k) } : null;
    case "line": return ok(m.k0) && ok(m.k0 + m.v.length - 1) ? { ...m, xs: m.v.map((_, j) => centreOf(tf, m.k0 + j)) } : null;
    case "move": return ok(m.k0) && ok(m.k1) ? { ...m, x0: centreOf(tf, m.k0), x1: centreOf(tf, m.k1) } : null;
    case "span": return { ...m, x0: indexAtOrAfter(S.blob.ts, m.t0), x1: indexAtOrAfter(S.blob.ts, m.t1) };
    default: return null;
  }
}

// The selected signal's explanation, as the chart's `why` layer (and the card).
function whyLayer(res, trades) {
  const card = $("whyCard");
  const hide = () => { if (card) card.classList.add("hidden"); return null; };
  if (!S.why || !res.explain) return hide();
  const tf = res.tf, k = indexAtOrAfter(tf.ts, S.why.ts);
  if (k >= tf.ts.length || tf.ts[k] !== S.why.ts) { S.why = null; return hide(); }
  const e = res.explain(k);
  const t = trades.find((x) => x.sigIdx === k) || null;
  const marks = e.marks.map((m) => markToLocal(m, tf)).filter(Boolean);
  // the order, from the engine's account: placed at the next open, to its fill or end
  let order = null;
  const evs = e.events || [];
  const armed = evs.find((v) => v.what === "armed"), entered = evs.find((v) => v.what === "entered");
  if (armed) {
    const end = evs.find((v) => ["filled", "replaced", "cancelled", "expired"].includes(v.what));
    const last = Math.min(tf.ts.length - 1, end ? end.bar : armed.bar + armed.window);
    order = { x0: tf.srcFirst[armed.bar], x1: end && end.what === "filled" ? centreOf(tf, last) : tf.srcFirst[last], price: armed.px,
              label: `${armed.dir === 1 ? "buy" : "sell"} ${armed.limit ? "limit" : "stop"} ${fmtPx(armed.px)}` +
                     (end ? (end.what === "filled" ? (end.limit && !armed.limit ? ", refused, filled as a limit" : ", filled") : `, ${end.what}`) : "") };
  } else if (entered && entered.bar < tf.ts.length) {
    marks.push({ type: "dot", x: tf.srcFirst[entered.bar] + 0.5, price: entered.px, label: `next open ${fmtPx(entered.px)}`, color: "#e8eef5", small: true });
  }
  paintWhyCard(e, t, res, trades);
  return { entryTime: t ? t.entryTime : null, bar: [tf.srcFirst[k], tf.srcLast[k] + 1], marks, order };
}

// Every signal bar the engine saw, by what became of it, for the signals layer.
function signalMarks(res) {
  const tf = res.tf, sig = res.sig, out = [];
  if (!sig || !res.signals) return out;
  for (let k = 0; k < sig.length; k++) {
    if (!sig[k]) continue;
    const evs = res.signals.get(k) || [], has = (w) => evs.some((v) => v.what === w);
    const cls = has("entered") || has("filled") ? "entry" : has("armed") ? "order" : has("refused") || has("dropped") ? "refused" : "held";
    out.push({ k, x: centreOf(tf, k), price: sig[k] === 1 ? tf.low[k] : tf.high[k], dir: sig[k], cls });
  }
  return out;
}

// A condition's mini-chart: its series over the bars up to the signal (the
// last point), with its threshold dashed.
function sparkSvg(sp) {
  if (!sp || !sp.lines || !sp.lines.length) return "";
  const W = 92, H = 24, n = sp.k - sp.k0 + 1;
  let lo = Infinity, hi = -Infinity;
  for (const ln of sp.lines) for (const v of ln.v) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (const r of sp.refs) { if (r < lo) lo = r; if (r > hi) hi = r; }
  if (!Number.isFinite(lo)) return "";
  if (sp.lines.some((ln) => ln.kind === "hist")) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (!(hi > lo)) { hi += 1; lo -= 1; }
  const X = (j) => 2 + (n <= 1 ? W - 4 : (j / (n - 1)) * (W - 6)), Y = (v) => H - 2 - ((v - lo) / (hi - lo)) * (H - 4);
  let s = `<svg class="wc-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">`;
  for (const r of sp.refs) s += `<line x1="0" x2="${W}" y1="${Y(r).toFixed(1)}" y2="${Y(r).toFixed(1)}" class="ref"/>`;
  for (const ln of sp.lines) {
    if (ln.kind === "hist") {
      const z = Y(0);
      ln.v.forEach((v, j) => { if (v != null) s += `<rect x="${(X(j) - 0.7).toFixed(1)}" y="${Math.min(z, Y(v)).toFixed(1)}" width="1.4" height="${Math.max(0.6, Math.abs(Y(v) - z)).toFixed(1)}" fill="${v >= 0 ? "#26a69a" : "#ef5350"}" opacity="0.7"/>`; });
      continue;
    }
    let seg = [];
    const flush = () => { if (seg.length > 1) s += `<polyline points="${seg.join(" ")}" fill="none" stroke="${ln.color}" stroke-width="1.2"/>`; seg = []; };
    ln.v.forEach((v, j) => { if (v == null) flush(); else seg.push(`${X(j).toFixed(1)},${Y(v).toFixed(1)}`); });
    flush();
  }
  for (const ln of sp.lines) { const v = ln.v[ln.v.length - 1]; if (v != null && ln.kind !== "hist") s += `<circle cx="${X(n - 1).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2.2" fill="${ln.color}"/>`; }
  s += `<line x1="${X(n - 1).toFixed(1)}" x2="${X(n - 1).toFixed(1)}" y1="0" y2="${H}" class="now"/>`;
  return s + "</svg>";
}

// One condition. A size condition that did not pass only shrinks the entry
// when the size left is above zero.
function checkRow(c, size = 1) {
  const shrunk = c.role === "size" && c.pass === false && size > 0;
  const st = c.pass === true ? "pass" : c.pass === false ? (shrunk ? "size" : "fail") : "info";
  const icon = c.pass === true ? "✓" : c.pass === false ? (shrunk ? "½" : "✗") : "·";
  return `<div class="wc-row ${st}"><i>${icon}</i><div class="wc-body"><div class="wc-l">${esc(c.label)}</div>` +
         `<div class="wc-v">${esc(c.text || "")}${c.note ? ` <span class="wc-n">— ${esc(c.note)}</span>` : ""}</div></div>${sparkSvg(c.spark)}</div>`;
}

function paintWhyCard(e, t, res, trades) {
  const card = $("whyCard");
  if (!card) return;
  const tf = res.tf, x = S.exec;
  const side = (d) => (d === 1 ? "long" : d === -1 ? "short" : "");
  const signal = e.checks.filter((c) => c.role === "trigger" || c.role === "gate" || (c.role === "info" && c.group !== "study"));
  const entry = e.checks.filter((c) => c.role === "size" || c.role === "entry" || (c.role === "info" && c.group === "study"));
  const evs = e.events || [];
  const head = t
    ? `<span class="wc-side ${side(t.dir)}">${t.dir === 1 ? "LONG" : "SHORT"} ${t.contracts}</span> @ ${fmtPx(t.entryPrice)} · ${ctClock(t.entryCt)} CT` +
      (t.taken ? ` · <b class="${t.pnl >= 0 ? "pos" : "neg"}">${fmtUsd(t.pnl)}</b>` : ` · <span class="dim">skipped: ${esc(SKIP_WHY[t.skip] || t.skip)}</span>`)
    : `<span class="wc-side ${side(e.dir)}">${e.dir === 1 ? "LONG" : e.dir === -1 ? "SHORT" : "NO"} SIGNAL</span> · ${esc(e.bar)} CT · no trade`;
  // the trades either side, for stepping through them
  const list = trades.filter((q) => q.sigIdx >= 0).sort((a, b) => a.entryTime - b.entryTime);
  let prev, next;
  if (t) { const i = list.indexOf(t); prev = i - 1; next = i + 1; }
  else { let j = list.findIndex((q) => q.sigIdx > e.k); if (j < 0) j = list.length; prev = j - 1; next = j; }
  let html = `<div class="wc-head"><div class="wc-h">${head}</div>` +
    `<button class="mini" data-go="${prev}" ${prev < 0 ? "disabled" : ""} title="Previous trade">◀</button>` +
    `<button class="mini" data-go="${next}" ${next >= list.length ? "disabled" : ""} title="Next trade">▶</button>` +
    `<button class="mini" data-fold title="${S.whyFolded ? "Show the details" : "Fold to the summary, to see the chart"}">${S.whyFolded ? "▾" : "▴"}</button>` +
    `<button class="mini" data-close title="Close (Esc)">✕</button></div>`;
  if (e.title) html += `<div class="wc-title">${esc(e.title)}</div>`;
  html += `<div class="wc-sec">Signal · the ${e.tfMin === 1 ? "1-min" : `${e.tfMin}-min`} bar ${esc(e.bar)} CT, read at its close</div>` + signal.map((c) => checkRow(c)).join("");
  if (entry.length) html += `<div class="wc-sec">${e.dir && !e.entryOk ? "Entry — refused" : "Entry"}${e.dir && e.size !== 1 && e.size > 0 ? ` · size × ${fmtNum(e.size)}` : ""}</div>` + entry.map((c) => checkRow(c, e.size)).join("");
  if (t) {
    html += `<div class="wc-sec">Order</div>` + evs.filter((v) => v.what === "flipped").map((v) => `<div class="wc-line">${esc(eventText(v, tf, x))}</div>`).join("") +
            describeEntry(t, tf, x, evs).map((l) => `<div class="wc-line">${esc(l)}</div>`).join("");
    html += `<div class="wc-sec">Exit</div><div class="wc-line">${esc(describeExit(t, tf, x, res.exitRule))}</div>`;
  } else if (evs.length) {
    html += `<div class="wc-sec">What the engine did</div>` + evs.map((v) => `<div class="wc-line">${esc(eventText(v, tf, x))}</div>`).join("");
  } else if (e.dir) {
    html += `<div class="wc-sec">What the engine did</div><div class="wc-line">Nothing recorded: the signal's bar is the last one loaded.</div>`;
  }
  for (const n of e.notes) html += `<div class="wc-note">${esc(n)}</div>`;
  card.innerHTML = html;
  card.classList.remove("hidden");
  card.classList.toggle("folded", !!S.whyFolded);
  card.onclick = (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-close")) { selectWhy(null); return; }
    if (b.hasAttribute("data-fold")) { S.whyFolded = !S.whyFolded; repaint(); return; }
    const q = list[+b.dataset.go];
    if (q) selectWhy(q);    // revealWhy brings it into view
  };
}

function downloadCsv(name, rows) {
  const cell = (v) => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"], { type: "text/csv" }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// An approximate 95% interval for a pass rate (Wilson), in percent. Neighbouring
// windows share all but a day of their days, so the honest sample is about one
// window per windowDays -- which is why these are wide, and should be.
function wilson(p, nEff) {
  if (!(nEff > 0)) return null;
  const z2 = 1.96 * 1.96, d = 1 + z2 / nEff;
  const c = (p + z2 / (2 * nEff)) / d, h = (1.96 * Math.sqrt((p * (1 - p)) / nEff + z2 / (4 * nEff * nEff))) / d;
  return [Math.max(0, c - h) * 100, Math.min(1, c + h) * 100];
}
const ciText = (ci) => (ci ? `${ci[0].toFixed(0)}–${ci[1].toFixed(0)}%` : "—");

// ───────────────────── P&L by hour and weekday ─────────────────────
const fmtK = (v) => { const a = Math.abs(v), s = v < 0 ? "-" : ""; return a >= 1000 ? `${s}$${(a / 1000).toFixed(a >= 1e5 ? 0 : 1)}k` : `${s}$${Math.round(a)}`; };
function paintBreakdown() {
  const host = $("breakPanel");
  if (!host) return;
  const sw = S.sweep;
  if (!sw || !sw.byHourCt) {
    host.innerHTML = `<div class="sweep-empty">${S.sweeping ? "Sweeping…" : "Run the sweep to see where the P&L comes from."}</div>`;
    return;
  }
  // Diverging bars: profit to the right of the centre line, loss to the left,
  // each column scaled to its own largest bucket.
  const table = (b, label, name, order) => {
    const keys = [...new Set([...b.all, ...b.y2026].map((r) => r.key))].sort((p, q) => order(p) - order(q));
    const get = (rows, k) => rows.find((r) => r.key === k);
    const top = (rows) => Math.max(1, ...rows.map((r) => Math.abs(r.net)));
    const mA = top(b.all), m26 = top(b.y2026);
    const cell = (r, m) => {
      if (!r) return `<span class="bk-bar"></span><span class="bk-v">—</span>`;
      const w = (Math.abs(r.net) / m) * 50;
      return `<span class="bk-bar" title="${r.trades} trades · ${((r.wins / r.trades) * 100).toFixed(0)}% won · ${fmtUsd(r.net)}">` +
             `<i class="${r.net >= 0 ? "pos" : "neg"}" style="width:${w.toFixed(1)}%"></i></span><span class="bk-v ${r.net >= 0 ? "pos" : "neg"}">${fmtK(r.net)}</span>`;
    };
    return `<div class="bk head"><span class="bk-k">${label}</span><span class="bk-h">All history</span><span class="bk-h">2026</span></div>` +
      keys.map((k) => `<div class="bk"><span class="bk-k">${name(k)}</span>${cell(get(b.all, k), mA)}${cell(get(b.y2026, k), m26)}</div>`).join("");
  };
  host.innerHTML = `<div class="${S.sweepStale ? "stale" : ""}">` +
    `<div class="sweep-label" style="margin-top:2px">Net P&amp;L by entry hour (CT)</div>` +
    table(sw.byHourCt, "Hour", (h) => String(h).padStart(2, "0"), (h) => (h + 7) % 24) +
    `<div class="sweep-label">Net P&amp;L by weekday</div>` +
    table(sw.byWeekday, "Day", (d) => WEEKDAY[d], (d) => (d + 6) % 7) +
    `<div class="sweep-foot">Hover a bar for its trades and win rate. The hour is the fill's; the weekday is the trading day the trade closed in. Thin buckets are noise.</div></div>`;
}

// ───────────────────── funded-stage payout panel ─────────────────────
function paintFundedStats() {
  const host = $("fundedPanel");
  if (!host) return;
  const f = S.sweep && S.sweep.funded;
  if (!f) {
    host.innerHTML = `<div class="sweep-empty">${
      S.sweeping ? "Simulating funded accounts…" : "Run the sweep to model payouts."
    }</div>`;
    return;
  }

  const F = S.funded;
  const perMonth = f.meanTotalPaid / (f.horizonDays / 30.44);
  const sign = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
  const stillGoing = Math.max(0, 100 - f.reachedPayout - f.blownBeforeAnyPayout);

  host.innerHTML = `
    <div class="sweep-head ${S.sweepStale ? "stale" : ""}">
      <div class="sweep-rate" style="color:${f.reachedPayout >= 50 ? "var(--bull)" : "var(--warn)"}">
        ${f.reachedPayout.toFixed(0)}<span>%</span>
      </div>
      <div class="sweep-sub">
        reach a payout<br>
        <span class="k">${f.n} funded runs · ${f.horizonDays}d each</span>
      </div>
    </div>

    <div class="stackbar" title="got paid / blown before any payout / neither yet">
      <i class="sb-pass" style="width:${f.reachedPayout}%"></i>
      <i class="sb-fail" style="width:${f.blownBeforeAnyPayout}%"></i>
      <i class="sb-open" style="width:${stillGoing}%"></i>
    </div>
    <div class="stackkey">
      <span><b class="sb-pass"></b>${f.reachedPayout.toFixed(1)}% got paid</span>
      <span><b class="sb-fail"></b>${f.blownBeforeAnyPayout.toFixed(1)}% blown first</span>
    </div>

    <div class="statgrid" style="margin-top:9px">
      ${statCell("Median days to 1st payout", f.medianDaysToFirstPayout ?? "—")}
      ${statCell("Median 1st payout", f.medianFirstPayout == null ? "—" : fmtUsd(f.medianFirstPayout), "pos")}
      ${statCell("Median payouts / run", f.medianPayoutCount ?? 0)}
      ${statCell("Account survived", f.survived.toFixed(0) + "%")}
      ${statCell("Median total paid", fmtUsd(f.medianTotalPaid), sign(f.medianTotalPaid))}
      ${statCell("Mean total paid", fmtUsd(f.meanTotalPaid), sign(f.meanTotalPaid))}
      ${statCell("Implied $ / month", fmtUsd(perMonth), sign(perMonth))}
      ${statCell("Best run", fmtUsd(f.bestRun), "pos")}
    </div>

    <div class="sweep-foot">
      ${F.winDaysRequired} winning days over ${fmtUsd(F.winDayThreshold)} unlock a payout ·
      ${F.profitSplit}% split${F.maxPayout ? ` · capped ${fmtUsd(F.maxPayout)}` : ""}
      <br><span class="warn">Split, cap and buffer are assumptions — set them to your firm's terms.</span>
    </div>
  `;
}

// ───────────────────── all-windows (sweep) panel ─────────────────────
function median(arr) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function paintSweepStats() {
  const host = $("sweepPanel");
  if (!host) return;

  if (!S.sweep) {
    host.innerHTML = `<div class="sweep-empty">${
      S.sweeping ? "Sweeping every 30-day window…" : "Not run yet — press <b>Run full sweep</b>."
    }</div>`;
    return;
  }

  const { windows, summary: s, stats: g } = S.sweep;
  const stale = S.sweepStale;

  const nets = windows.map((w) => w.netPnl);
  const passed = windows.filter((w) => w.outcome === "PASS");
  // What passing actually took. Above the target whenever the consistency rule
  // made a window dilute one big day first.
  const passNets = passed.map((w) => w.netPnl);
  const failed = windows.filter((w) => w.outcome === "FAIL");
  const sign = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");

  // Pass rate by calendar year. The spec puts realistic outcomes anywhere from
  // ~63% (choppy) to ~85% (trending), so the spread across years is the honest
  // picture of what a single attempt is actually exposed to.
  const byYear = new Map();
  for (const w of windows) {
    const y = new Date(w.startMs).getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, { n: 0, pass: 0 });
    const b = byYear.get(y);
    b.n++;
    if (w.outcome === "PASS") b.pass++;
  }
  const maxYearN = Math.max(...[...byYear.values()].map((b) => b.n));
  const yearRows = [...byYear.entries()].map(([y, b]) => {
    const pct = (b.pass / b.n) * 100;
    // A part-year (the dataset starts mid-2021 and ends mid-2026) rests on far
    // fewer windows, so mark it rather than let it read as an equal peer.
    const partial = b.n < maxYearN * 0.8;
    return `<div class="yr${partial ? " partial" : ""}" title="${b.n} windows${partial ? " (partial year)" : ""}">
      <span class="yr-k">${y}${partial ? "*" : ""}</span>
      <span class="yr-bar"><i style="width:${pct.toFixed(1)}%"></i></span>
      <span class="yr-v">${pct.toFixed(0)}%</span>
    </div>`;
  }).join("") + `<div class="yr-note">* partial year — fewer windows behind the number</div>`;

  // The house check: results are judged on 2026, and 2026 is split in two so a
  // result has to hold in both halves.
  const W = S.rules.windowDays;
  const part = (lo, hi) => {
    const ws = windows.filter((w) => w.startMs >= lo && w.startMs < hi);
    const p = ws.filter((w) => w.outcome === "PASS").length / (ws.length || 1);
    return ws.length ? { n: ws.length, rate: p * 100, ci: wilson(p, ws.length / W) } : null;
  };
  const y26 = Date.UTC(2026, 0, 1), apr26 = Date.UTC(2026, 3, 1);
  const h26 = part(y26, Infinity), q1 = part(y26, apr26), q2 = part(apr26, Infinity);
  const house = h26 ? `
    <div class="sweep-label">2026 — judged here, checked in halves</div>
    <div class="statgrid">
      ${statCell("2026 pass rate", `${h26.rate.toFixed(1)}% <span class="ci">${ciText(h26.ci)}</span>`)}
      ${statCell("Jan–Mar · Apr–Jul", q1 && q2 ? `${q1.rate.toFixed(1)}% · ${q2.rate.toFixed(1)}%` : "—")}
    </div>
    <div class="yr-note">${h26.n} windows, but only ≈${(h26.n / W).toFixed(1)} independent ${W}-day periods — hence the wide interval</div>` : "";

  host.innerHTML = `
    <div class="sweep-head ${stale ? "stale" : ""}">
      <div class="sweep-rate">${s.passRate.toFixed(1)}<span>%</span></div>
      <div class="sweep-sub">
        pass rate · <span title="Approximate 95% interval, counting one independent sample per ${W} days of start dates (neighbouring windows share most of their days)">95% CI ${ciText(wilson(s.passRate / 100, s.n / W))}</span><br>
        <span class="k">${EVALS[S.sweep.eval || S.eval].label} · ${s.n.toLocaleString()} windows${
          S.studies.some(isGating) ? ` · ${S.studies.filter(isGating).length} indicator gate${S.studies.filter(isGating).length > 1 ? "s" : ""}` : ""}</span>
      </div>
    </div>

    <div class="stackbar" title="pass / fail / unresolved">
      <i class="sb-pass" style="width:${s.passRate}%"></i>
      <i class="sb-fail" style="width:${s.failRate}%"></i>
      <i class="sb-open" style="width:${s.openRate}%"></i>
    </div>
    <div class="stackkey">
      <span><b class="sb-pass"></b>${s.passRate.toFixed(1)}% pass</span>
      <span><b class="sb-fail"></b>${s.failRate.toFixed(1)}% breached</span>
      <span><b class="sb-open"></b>${s.openRate.toFixed(1)}% ran out of time</span>
    </div>

    <div class="statgrid" style="margin-top:9px">
      ${statCell("Median days to pass", s.medianDaysToPass ?? "—")}
      ${statCell("Profit at pass (median / max)", passNets.length ? `${fmtUsd(median(passNets))} / ${fmtUsd(Math.max(...passNets))}` : "—")}
      ${statCell("Median net / window", fmtUsd(median(nets) ?? 0), sign(median(nets) ?? 0))}
      ${statCell("Best window", fmtUsd(Math.max(...nets)), "pos")}
      ${statCell("Worst window", fmtUsd(Math.min(...nets)), "neg")}
      ${statCell("Median trades / window", median(windows.map((w) => w.trades)) ?? 0)}
      ${statCell("Median breach margin", fmtUsd(median(failed.map((w) => w.minCushion).filter((v) => v != null)) ?? 0), "neg")}
    </div>

    ${house}

    <div class="sweep-label">Pass rate by year</div>
    <div class="yrs">${yearRows}</div>

    <div class="sweep-label">Full history (all ${g.n.toLocaleString()} trades)</div>
    <div class="statgrid">
      ${statCell("Net P&L", fmtUsd(g.pnl), sign(g.pnl))}
      ${statCell("Profit factor", Number.isFinite(g.profitFactor) ? g.profitFactor.toFixed(3) : "∞")}
      ${statCell("Expectancy", fmtUsd(g.expectancy, 2), sign(g.expectancy))}
      ${statCell("Trades / day", g.tradesPerDay.toFixed(2))}
      ${statCell("Win rate", g.winRate.toFixed(1) + "%")}
      ${statCell("Avg win / loss", `${fmtUsd(g.avgWin)} / ${fmtUsd(g.avgLoss)}`)}
    </div>

    <div class="sweep-foot tt-foot">${
      stale ? `<span class="warn">Parameters changed — re-sweeping…</span>`
            : `<span>${S.sweep.backtestMs}ms backtest + ${S.sweep.sweepMs}ms sweep · ${passed.length} pass / ${failed.length} breach</span>`
    }<button class="mini" id="sweepCsv" title="Download every window's result">CSV</button></div>
  `;
  $("sweepCsv").onclick = () => {
    const cols = Object.keys(windows[0] || {});
    downloadCsv(`${S.strategyDesc.id}_sweep.csv`, [
      cols.map((c) => (c === "startMs" ? "start_utc" : c)),
      ...windows.map((w) => cols.map((c) => (c === "startMs" ? isoMin(w[c]) : w[c]))),
    ]);
  };
}

// ───────────────────────────── recompute ─────────────────────────────
let rafPending = 0;
let lastResult = null;

function onParamsChanged(needsWarmupCheck = false) {
  if (needsWarmupCheck) { loadWindow(S.windowStart); return; }
  if (rafPending) return;
  rafPending = requestAnimationFrame(() => { rafPending = 0; recompute(); });
  scheduleSweep();
}

function recompute() {
  if (!S.blob || !S.strategyMod) return;
  const t0 = performance.now();

  // explain + trace: why each signal fired, and what the engine did with it,
  // for the entry card and the signals layer (worked out only when asked).
  const run = runStrategy(S.blob, S.strategyMod, S.params, S.exec, { fromMs: S.windowStart, filter: S.filter, studies: S.studies, explain: true, trace: true });
  // The blob runs past the window end so a trade opened inside it can finish;
  // trades opened in that tail belong to the next window, not this one.
  const endMs = S.windowStart + S.rules.windowDays * DAY;
  const cut = run.trades.findIndex((t) => t.entryTime >= endMs);
  const res = cut < 0 ? run : { ...run, trades: run.trades.slice(0, cut) };
  // A window trade closed only because the loaded bars ran out would be cut short
  // of the exit the sweep gives it. Load a 10x longer tail and run again, until
  // the trade closes or the bars reach the end of the data (an overnight hold
  // with no exit signal can run for months).
  const lastT = res.trades[res.trades.length - 1];
  if (lastT && lastT.reason === "EOD" && S.blob.ts[S.blob.ts.length - 1] < S.meta.endMs) {
    S.tailMin *= 10;
    return loadWindow(S.windowStart, { keepTail: true });
  }
  const replay = replayWindow(res.trades, S.windowStart, S.rules);
  const ms = performance.now() - t0;

  lastResult = { res, replay };
  paintChart(res, replay);
  paintStats(res, replay);
  paintTrades(replay);
  queueHash();

  $("perf").innerHTML =
    `<b>${ms.toFixed(1)} ms</b> local re-run<br>${res.tf.close.length.toLocaleString()} × ${S.params.timeframeMin}m bars` +
    (res.signalsGated ? `<br><span style="color:var(--warn)">${res.signalsGated} signals gated</span>` : "") +
    (res.studyGated ? `<br><span style="color:var(--warn)" title="Signal bars whose entry an indicator gate refuses">${res.studyGated} entries refused by indicators</span>` : "");
  queuePostState();
}

function paintChart(res, replay) {
  const blob = S.blob;

  // Rules decide which signals actually became trades, so annotate the strategy's
  // trades with the replay's verdict rather than drawing two separate sets.
  const byKey = new Map();
  for (const e of replay.events) byKey.set(e.k, e);

  // Declared here rather than below because the trade mapping needs it to place
  // each fill at the centre of its own bar.
  const tf = res.tf;

  const trades = res.trades.map((t, k) => {
    const e = byKey.get(k);
    return {
      ...t,
      // Centre of the bar the fill belongs to, not its first minute. Candles
      // are drawn centred on their span, so an endpoint pinned to the span's
      // EDGE sits half a candle off the candle it refers to -- which is what
      // made entries look like they happened a bar after the signal.
      xStart: barCentre(tf, t.entryIdx, t.entrySrc),
      xEnd: barCentre(tf, t.exitIdx, t.exitSrc),
      taken: e ? e.taken : false,
      skip: e ? e.skip : "outside",
      cum: e ? e.cum : null,
    };
  });

  const equityPts = replay.events.filter((e) => e.taken).map((e) => ({
    x: e.t.exitSrc, cum: e.cum, floor: e.floor, pnl: e.t.pnl, need: e.need,
  }));

  const dayBars = replay.days.map((d) => ({
    ...d,
    xStart: indexAtOrAfter(blob.ts, d.firstMs),
    xEnd: indexAtOrAfter(blob.ts, d.lastMs),
  }));

  const priceOverlays = (res.overlays || []).filter((o) => o.pane !== "sub");
  const subOverlays = (res.overlays || []).filter((o) => o.pane === "sub");
  const why = whyLayer(res, trades);

  // Given over to Tradovate indicators, the chart is theirs, with candles of their size.
  const focus = tvFocused();
  S.chart.setTimeframe(focus ? S.tv[0].minutes : Number($("chartTf").value) || 1);
  $("chartTf").disabled = focus;

  S.chart.setData({
    token: `${S.windowStart}:${blob.count}`,
    bars: blob,
    trades: focus ? [] : trades,
    replay: focus ? null : replay,
    equityPts,
    dayBars,
    priceOverlays: focus ? [] : priceOverlays,
    subOverlays: focus ? [] : subOverlays,
    studyOverlays: [...studyOverlays(res), ...tvOverlays()],
    focus,
    why: focus ? null : why,
    signalMarks: !focus && S.showSignals ? signalMarks(res) : null,
    // Overlays are indexed in signal-timeframe space; stride lets the renderer
    // convert a 1-minute pixel budget into a sane sampling step.
    // Overlay points land at the CENTRE of the bar that produced them, for the
    // same reason. srcLast put a 5-minute MACD value on the right-hand edge of
    // its own candle, so the indicator read half a candle ahead of the price it
    // was computed from.
    tfToLocal: { localIdx: centresOf(tf), stride: S.params.timeframeMin || 1 },
    lockX: replay.lockMs ? indexAtOrAfter(blob.ts, replay.lockMs) : null,
    // Where the evaluation actually ended — pass or breach, whichever came first.
    resolveX: !focus && (replay.passMs ?? replay.failMs) != null
      ? indexAtOrAfter(blob.ts, replay.passMs ?? replay.failMs) : null,
    title: focus ? `MNQ · ${S.tv.map((x) => x.name).join(" + ")}` : `MNQ · ${S.strategyDesc.name}`,
    initialView: (focus && tvDayView()) || [S.winStartLocal, Math.min(blob.count, S.winEndLocal + 1)],
  });
}

// Redraw without re-running anything: a study's colour or visibility changed.
function repaint() { if (lastResult) paintChart(lastResult.res, lastResult.replay); }

function statCell(k, v, cls = "") {
  return `<div class="stat"><div class="stat-k">${k}</div><div class="stat-v ${cls}">${v}</div></div>`;
}

function paintStats(res, replay) {
  const st = replay.stats;
  const R = replay.rules;

  const badge = $("verdict").firstElementChild;
  badge.className = "badge " + (replay.outcome === "PASS" ? "pass" : replay.outcome === "FAIL" ? "fail" : "open");
  badge.textContent = replay.outcome === "IN_PROGRESS" ? "UNRESOLVED" : replay.outcome;

  // The consistency rule can raise what this window must reach above the target.
  const needed = Math.max(R.profitTarget, st.profitNeeded || 0);
  const raised = needed > R.profitTarget + 0.5;
  const pct = Math.max(0, Math.min(100, (st.netPnl / needed) * 100));
  const sign = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");

  $("statGrid").innerHTML =
    `<div class="stat wide">
       <div class="stat-k">Net P&amp;L · target ${fmtUsd(R.profitTarget)}${raised
         ? ` <span class="warn">→ ${fmtUsd(needed)}: best day ${fmtUsd(st.bestDay)} is over ${R.consistencyPct}%</span>` : ""}</div>
       <div class="stat-v ${sign(st.netPnl)}">${fmtUsd(st.netPnl)}</div>
       <div class="progress"><div style="width:${pct}%"></div></div>
     </div>` +
    statCell("Trades taken", st.trades) +
    statCell("Skipped by rules", st.skipped, st.skipped ? "neg" : "") +
    statCell("Win rate", st.winRate.toFixed(1) + "%") +
    statCell("Profit factor", Number.isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : "∞") +
    statCell("Expectancy", fmtUsd(st.expectancy, 2), sign(st.expectancy)) +
    statCell("Trading days", st.tradingDays) +
    statCell("Best day", fmtUsd(st.bestDay), sign(st.bestDay)) +
    statCell("Consistency", st.netPnl > 0 ? st.consistencyRatio.toFixed(0) + "%" + (st.consistencyBreached ? " ⚠" : "") : "—",
             st.netPnl > 0 && st.consistencyRatio > R.consistencyPct ? "neg" : "") +
    statCell("Closest to breach", st.minCushion == null ? "—" : fmtUsd(st.minCushion),
             st.minCushion != null && st.minCushion < 500 ? "neg" : "") +
    statCell("Floor now", fmtUsd(st.finalFloor) + (st.locked ? " 🔒" : "")) +
    statCell("Days used", `${st.daysUsed} / ${R.windowDays}`) +
    // Fees for trades that were ACTUALLY taken before the window resolved — not
    // the whole 30 days, which would count trades that never happened.
    statCell("Commission", fmtUsd(replay.events.reduce((a, e) => a + (e.taken ? e.t.fees : 0), 0)), "neg");

  $("topStats").innerHTML =
    `<div class="tstat"><div class="tstat-k">Net P&amp;L</div><div class="tstat-v ${sign(st.netPnl)}">${fmtUsd(st.netPnl)}</div></div>` +
    `<div class="tstat"><div class="tstat-k">Trades</div><div class="tstat-v">${st.trades}${st.skipped ? ` <span style="color:var(--dim)">+${st.skipped} skipped</span>` : ""}</div></div>` +
    `<div class="tstat"><div class="tstat-k">Win rate</div><div class="tstat-v">${st.winRate.toFixed(1)}%</div></div>` +
    `<div class="tstat"><div class="tstat-k">Profit factor</div><div class="tstat-v">${Number.isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : "∞"}</div></div>` +
    `<div class="tstat"><div class="tstat-k">Closest to breach</div><div class="tstat-v ${st.minCushion != null && st.minCushion < 500 ? "neg" : ""}">${st.minCushion == null ? "—" : fmtUsd(st.minCushion)}</div></div>`;
}

// ─────────────────────────── window loading ───────────────────────────
// Windows start where the sweep's do -- the data's first bar plus whole days --
// so the window on screen is always one the sweep scored.
function snapToSweep(ms) {
  const last = Math.floor((S.meta.endMs - S.rules.windowDays * DAY - S.meta.startMs) / DAY);
  return S.meta.startMs + Math.max(0, Math.min(last, Math.round((ms - S.meta.startMs) / DAY))) * DAY;
}

async function loadWindow(startMs, { keepTail = false } = {}) {
  startMs = snapToSweep(startMs);
  S.windowStart = startMs;
  if (!keepTail) S.tailMin = DEFAULT_TAIL_MIN;
  // Warm-up and tail as src/window.mjs sets them: enough history before the
  // window for the strategy's indicators to match the full-history run, and
  // enough after it for the window's last trade to finish. test.mjs checks the
  // result against the sweep for every strategy.
  const span = windowSpan(S.strategyMod, S.params, { tailMin: S.tailMin, filter: S.filter, exec: S.exec, studies: S.studies });
  const warmupMin = Math.max(span.warmupMin, tvWarmupMin()), tailMin = span.tailMin;
  S.loadedWarmupMin = warmupMin;

  const url = `/api/window?start=${startMs}&days=${S.rules.windowDays}&warmupMin=${warmupMin}&tailMin=${tailMin}`;
  const ab = await fetch(url).then((r) => r.arrayBuffer());
  S.blob = parseWindowBlob(ab);
  S.winStartLocal = indexAtOrAfter(S.blob.ts, startMs);
  S.winEndLocal = indexAtOrAfter(S.blob.ts, startMs + S.rules.windowDays * DAY);

  // The box shows the trading day the window opens on (its session starts the
  // evening before), so a typed date comes back as the same date.
  const first = S.blob.tday[Math.min(S.winStartLocal, S.blob.tday.length - 1)];
  $("startDate").value = new Date(first * DAY).toISOString().slice(0, 10);
  const end = new Date(startMs + S.rules.windowDays * DAY);
  $("winRange").textContent = `→ ${end.toISOString().slice(0, 10)} · ${(S.winEndLocal - S.winStartLocal).toLocaleString()} 1-min bars`;
  if (S.nav) { S.nav.cursorMs = startMs; S.nav.draw(); }

  const settled = recompute();   // a promise while a longer tail is still loading
  scheduleSweep();
  return settled;
}

// The current settings need more history before the window than is loaded.
function warmupGrew() {
  const need = windowSpan(S.strategyMod, S.params, { filter: S.filter, exec: S.exec, studies: S.studies }).warmupMin;
  return Math.max(need, tvWarmupMin()) > (S.loadedWarmupMin || 0);
}

function stepWindow(days) {
  const lo = S.meta.startMs;
  const hi = S.meta.endMs - S.rules.windowDays * DAY;
  loadWindow(Math.max(lo, Math.min(hi, S.windowStart + days * DAY)));
}

// ──────────────────────── full-history sweep ────────────────────────
// Colour and visibility are only how a study is drawn.
const studyConfig = () => S.studies.map(({ id, type, tf, params, gate }) => ({ id, type, tf, params, gate }));
function sweepKey() {
  return JSON.stringify([S.strategyDesc.id, S.eval, S.params, S.exec, S.rules, S.funded, S.filter, studyConfig()]);
}

function scheduleSweep() {
  clearTimeout(S.sweepTimer);
  // The window panel updates instantly, but the sweep needs the server and all
  // 1.77M bars — so flag the numbers as stale the moment they stop being true.
  if (S.sweep && sweepKey() !== S.lastSweepKey && !S.sweepStale) {
    S.sweepStale = true;
    paintSweepStats();
  }
  S.sweepTimer = setTimeout(runSweep, 700);
}

async function runSweep() {
  const key = sweepKey();
  if (S.sweeping || key === S.lastSweepKey) return;
  S.sweeping = true;
  $("runSweep").disabled = true;
  if (!S.sweep) paintSweepStats();
  $("navSummary").innerHTML = `<span class="k">sweeping all 30-day windows…</span>`;

  try {
    const r = await fetch("/api/sweep", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        strategyId: S.strategyDesc.id, eval: S.eval,
        params: S.params, exec: S.exec, rules: S.rules, funded: S.funded, filter: S.filter,
        studies: studyConfig(),
        stepDays: 1,
      }),
    }).then((x) => x.json());

    if (r.error) throw new Error(r.error);
    S.lastSweepKey = key;
    S.sweep = r;
    S.sweepStale = false;

    S.nav.set(r.windows, [S.meta.startMs, S.meta.endMs], S.windowStart);
    paintSweepStats();
    paintFundedStats();
    paintBreakdown();
    paintEdge();
    const s = r.summary;
    $("navSummary").innerHTML =
      `<span class="k">${EVALS[S.eval].label} · ${s.n.toLocaleString()} × ${S.rules.windowDays}-day windows</span> · ` +
      `<span class="pass">${s.passRate.toFixed(1)}% pass</span> · ` +
      `<span class="fail">${s.failRate.toFixed(1)}% breached</span> · ` +
      `${s.openRate.toFixed(1)}% unresolved` +
      (s.medianDaysToPass ? ` · median ${s.medianDaysToPass}d to pass` : "") +
      ` <span class="k">— see “All windows” in the sidebar</span>`;
  } catch (e) {
    toast(e.message, true);
    S.sweepStale = false;
    $("navSummary").innerHTML = `<span class="k">sweep failed</span>`;
  } finally {
    S.sweeping = false;
    $("runSweep").disabled = false;
    queuePostState();
  }
}

// ─────────────────────────────── the chart link ───────────────────────────────
// The page tells the server what it shows -- strategy, every setting, the window
// on screen, the visible range, the trade under the cursor, the window's result
// and the sweep's -- whenever that changes, and applies changes the server pushes
// to it. The MCP server's chart_state / chart_apply tools are the other end, so a
// prompt beside the chart can read it and drive it.
const isoMin = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : null);
// The entry the card explains, in words: its conditions, what the engine did,
// the order and the exit.
function whySnapshot(tr) {
  const res = lastResult && lastResult.res;
  if (!S.why || !res || !res.explain) return null;
  const tf = res.tf, k = indexAtOrAfter(tf.ts, S.why.ts);
  if (k >= tf.ts.length || tf.ts[k] !== S.why.ts) return null;
  const e = res.explain(k), t = res.trades.find((x) => x.sigIdx === k) || null;
  return {
    signalBar: isoMin(tf.ts[k]), barCt: e.bar, dir: e.dir === 1 ? "long" : e.dir === -1 ? "short" : "none", entryAllowed: e.entryOk,
    why: explainLines(e), engine: (e.events || []).map((v) => eventText(v, tf, S.exec)),
    ...(t ? { trade: tr(t), order: describeEntry(t, tf, S.exec, e.events || []), exit: describeExit(t, tf, S.exec, res.exitRule) } : {}),
  };
}

function chartSnapshot(appliedId, applyError) {
  const rp = lastResult && lastResult.replay, st = rp && rp.stats;
  const c = S.chart, cb = c && c.data && c.data.bars;
  const tr = (t) => ({ entry: isoMin(t.entryTime), exit: isoMin(t.exitTime), dir: t.dir === 1 ? "long" : "short", contracts: t.contracts,
                       entryPrice: +t.entryPrice.toFixed(2), exitPrice: +t.exitPrice.toFixed(2), reason: t.reason, pnl: +t.pnl.toFixed(2) });
  return {
    appliedId, applyError,
    strategy: S.strategyDesc && S.strategyDesc.id, strategyName: S.strategyDesc && S.strategyDesc.name,
    eval: S.eval,
    params: S.params, exec: S.exec, rules: S.rules, filter: S.filter, funded: S.funded,
    studies: S.studies.map((st) => ({ id: st.id, type: st.type, tf: st.tf, params: st.params, gate: st.gate, label: studyLabel(st),
                                      ...(isGating(st) ? { gateText: gateLabel(st.type, st.gate, st.params) } : {}), ...(st.hidden ? { hidden: true } : {}) })),
    tradovate: { chartOnly: S.tvFocus, indicators: S.tv.map((ind, k) => ({ ...tvConfig()[k], problems: ind.problems || [] })) },
    window: { start: isoMin(S.windowStart), tradingDay: $("startDate").value, end: isoMin(S.windowStart + S.rules.windowDays * DAY) },
    view: cb && cb.count ? { from: isoMin(cb.ts[Math.max(0, Math.floor(c.i0))]), to: isoMin(cb.ts[Math.min(cb.count - 1, Math.ceil(c.i1) - 1)]), candleMin: c.tfMin } : null,
    result: rp ? { outcome: rp.outcome, net: Math.round(st.netPnl), trades: st.trades, skipped: st.skipped, winRate: +st.winRate.toFixed(1),
                   bestDay: Math.round(st.bestDay), profitNeeded: Math.round(st.profitNeeded),
                   closestToBreach: st.minCushion == null ? null : Math.round(st.minCushion), resolvedAt: isoMin(rp.passMs ?? rp.failMs) } : null,
    trades: rp ? rp.events.slice(0, 300).map((e) => ({ ...tr(e.t), taken: e.taken, ...(e.skip ? { skipped: e.skip } : {}) })) : [],
    hoveredTrade: window._hoverTrade ? { ...tr(window._hoverTrade), taken: window._hoverTrade.taken } : null,
    explained: whySnapshot(tr),
    sweep: S.sweep ? { ...S.sweep.summary, eval: S.sweep.eval, stale: !!S.sweepStale, funded: S.sweep.funded || null,
                       ...(S.sweep.edge && S.sweep.edge.length ? { indicatorEdge: S.sweep.edge } : {}) } : null,
  };
}
function postState(appliedId, applyError) {
  fetch("/api/chart/state", { method: "POST", headers: { "content-type": "application/json" },
                              body: JSON.stringify(chartSnapshot(appliedId, applyError)) }).catch(() => {});
}
let postTimer = 0;
function queuePostState() { clearTimeout(postTimer); postTimer = setTimeout(() => postState(), 250); }

// Settings from outside -- the chart link, or a URL -- applied through the same
// paths the sidebar uses. Values read from a URL are strings, and take the type
// of the setting they replace.
async function applySettings(m) {
  if (m.strategy && !S.strategyList.some((s) => s.id === m.strategy)) throw new Error(`unknown strategy "${m.strategy}"`);
  const startMs = m.date ? Date.parse(m.date + "T00:00:00Z") : S.windowStart;
  if (!Number.isFinite(startMs)) throw new Error(`"${m.date}" is not a date (use YYYY-MM-DD)`);
  if (m.eval != null && !EVALS[String(m.eval)]) throw new Error(`unknown eval "${m.eval}"; one of ${EVAL_IDS.join(", ")}`);
  // checked before anything changes, so a bad study leaves the page as it was
  const studies = m.studies == null ? null : adoptStudies(m.studies.map((st) => resolveStudy(st, { strict: !m.fromUrl })));
  const tv = m.tradovate == null ? null : await Promise.all(m.tradovate.map(tvMake));
  const keysOf = (o) => new Set(Object.keys(o));
  const check = (what, obj, valid) => {
    const bad = Object.keys(obj || {}).filter((k) => !valid.has(k));
    if (bad.length) throw new Error(`unknown ${what} key${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}`);
  };
  if (m.strategy && m.strategy !== S.strategyDesc.id) await selectStrategy(m.strategy);
  if (m.eval != null) setEval(String(m.eval));
  if (m.reset) Object.assign(S, baseConfig());
  if (studies) { S.studies = studies; saveStudies(); }
  if (tv) S.tv = tv;
  const focus = m.tvFocus ?? m.chartOnly;
  if (focus != null) S.tvFocus = !!focus;
  if (tv || focus != null) saveTv();
  check("params", m.params, new Set([...(S.strategyMod.params || []).map((d) => d.key), "timeframeMin"]));
  check("exec", m.exec, keysOf(S.meta.defaults.exec));
  check("rules", m.rules, keysOf(S.meta.defaults.rules));
  check("filter", m.filter, new Set([...Object.keys(NO_FILTER), ...FILTER_PARAMS.map((d) => d.key)]));
  check("funded", m.funded, keysOf(S.meta.defaults.funded));
  for (const name of ["params", "exec", "rules", "filter", "funded"]) {
    const o = { ...(m[name] || {}) };
    if (m.fromUrl) for (const k of Object.keys(o)) o[k] = coerceLike(S[name][k], o[k]);
    Object.assign(S[name], o);
  }
  renderEvalTabs();
  renderSidebar();
  await loadWindow(startMs);
  if (tv) tvShowDay();
  if (m.sweep) {
    // an automatic sweep may already be running, for settings just replaced
    while (S.sweeping) await new Promise((r) => setTimeout(r, 100));
    S.lastSweepKey = "";
    await runSweep();
  }
}
// A change pushed by the chart link, confirmed with the state that results.
async function applyChange(m) {
  try {
    await applySettings(m);
    clearTimeout(postTimer);
    postState(m.id);
  } catch (e) {
    postState(m.id, e.message);
  }
}
function connectChartLink() {
  const es = new EventSource("/api/chart/events");
  es.addEventListener("apply", (ev) => { try { applyChange(JSON.parse(ev.data)); } catch { /* malformed: ignore */ } });
}

// ─────────────────────────────── the evaluation tabs ───────────────────────────────
// The $3,000 and $1,250 evaluations (src/evals.mjs). Switching resets what an eval
// decides -- the firm's numbers, and the strategy's own settings for that eval --
// and keeps every other change made since the strategy was picked.
function setEval(id) {
  if (id === S.eval) return;
  const owned = evalKeys(S.strategyMod), before = baseConfig(), keep = {};
  for (const g of ["params", "exec", "rules", "filter"]) {
    keep[g] = {};
    for (const [k, v] of Object.entries(S[g]))
      if (!owned.has(`${g}.${k}`) && JSON.stringify(v) !== JSON.stringify(before[g][k])) keep[g][k] = v;
  }
  S.eval = id;
  const after = baseConfig();
  for (const g of ["params", "exec", "rules", "filter"]) S[g] = { ...after[g], ...keep[g] };
  try { localStorage.setItem("mnq.eval", id); } catch { /* private mode */ }
}
async function switchEval(id) {
  if (id === S.eval || !EVALS[id]) return;
  setEval(id);
  renderEvalTabs();
  renderSidebar();
  await loadWindow(S.windowStart);
  toast(`${EVALS[id].label}: ${EVALS[id].blurb}`);
}
function renderEvalTabs() {
  const host = $("evalTabs");
  host.innerHTML = EVAL_IDS.map((id) =>
    `<button role="tab" data-eval="${id}" aria-selected="${id === S.eval}" class="${id === S.eval ? "on" : ""}" title="${EVALS[id].blurb} (E switches)">${EVALS[id].label}</button>`).join("");
  const own = S.strategyMod && S.strategyMod.evals && S.strategyMod.evals[S.eval];
  const list = own ? ["params", "exec", "filter", "rules"].flatMap((g) => Object.entries(own[g] || {}).map(([k, v]) =>
    `${(SETTING_LABEL.get(k) || k).toLowerCase()} ${/Usd$/.test(k) ? fmtUsd(v) : v}`)) : [];
  $("evalDesc").textContent = EVALS[S.eval].blurb + (list.length ? ` · this strategy's own for it: ${list.join(", ")}` : "");
}
// A setting's sidebar label, without its units and "(0 = off)" notes.
const SETTING_LABEL = new Map([...EXEC_PARAMS, ...ORDER_PARAMS, ...SESSION_PARAMS, ...RULES_PARAMS, ...FILTER_PARAMS]
  .map((d) => [d.key, d.label.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*\$$/, "")]));

// ─────────────────────────────── the address bar ───────────────────────────────
// The URL carries the strategy, the window, the evaluation, the indicators and
// every setting that differs from the strategy's own defaults under that eval
// (#s=<id>&d=<trading day>&e=1250&x.slippageTicks=1 ...), so a view can be
// bookmarked, shared or reloaded and come back exactly.
const URL_GROUPS = { p: "params", x: "exec", r: "rules", f: "filter", u: "funded" };
function baseConfig() {
  return { ...evalBase(S.strategyMod, S.eval), funded: { ...S.meta.defaults.funded } };
}
// Studies in the address bar: type:tf:key=value,...:gate:colour, joined by "~",
// with only the params that differ from the study's defaults.
function studiesToUrl(list) {
  return list.map((st) => {
    const d0 = resolveStudy({ type: st.type }).params;
    const ps = Object.entries(st.params).filter(([k, v]) => v !== d0[k]).map(([k, v]) => `${k}=${v}`).join(",");
    return [st.type, st.tf || 0, ps, st.gate === "off" ? "" : st.gate, (st.color || "").replace("#", ""), st.hidden ? "h" : ""].join(":").replace(/:+$/, "");
  }).join("~");
}
function studiesFromUrl(s) {
  if (!s) return [];
  return s.split("~").filter(Boolean).map((part) => {
    const [type, tf, ps, gate, color, hidden] = part.split(":");
    const params = {};
    for (const kv of (ps || "").split(",").filter(Boolean)) { const i = kv.indexOf("="); if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1); }
    for (const [k, v] of Object.entries(params)) { const n = Number(v); if (v.trim() !== "" && !Number.isNaN(n)) params[k] = n; }
    return { type, tf: Number(tf) || 0, params, gate: gate || "off", ...(color ? { color: "#" + color } : {}), ...(hidden === "h" ? { hidden: true } : {}) };
  });
}
// Tradovate indicators: name!minutes!key=value,... joined by "~".
const tvToUrl = (list) => list.map((c) => [c.name, c.minutes, Object.entries(c.props).map(([k, v]) => `${k}=${v}`).join(","), c.hidden ? "h" : ""].join("!").replace(/!+$/, "")).join("~");
function tvFromUrl(s) {
  if (!s) return [];
  return s.split("~").filter(Boolean).map((part) => {
    const [name, minutes, ps, hidden] = part.split("!"), props = {};
    for (const kv of (ps || "").split(",").filter(Boolean)) { const i = kv.indexOf("="); if (i > 0) props[kv.slice(0, i)] = kv.slice(i + 1); }
    return { name, minutes: Number(minutes) || 0, props, hidden: hidden === "h" };
  });
}
function coerceLike(current, raw) {
  if (raw === "null") return null;
  if (typeof current === "boolean") return raw === "true";
  if (typeof current === "number" || current == null) {
    const n = Number(raw);
    if (raw.trim() !== "" && !Number.isNaN(n)) return n;
    return current == null ? (raw === "true" ? true : raw === "false" ? false : raw) : current;
  }
  return raw;
}
function urlHash() {
  const q = new URLSearchParams(), base = baseConfig();
  q.set("s", S.strategyDesc.id);
  q.set("d", $("startDate").value);
  if (S.eval !== DEFAULT_EVAL) q.set("e", S.eval);
  if (S.studies.length) q.set("st", studiesToUrl(S.studies));
  if (S.tv.length) q.set("tv", tvToUrl(tvConfig()));
  if (S.tv.length && !S.tvFocus) q.set("tvf", "0");
  for (const [g, name] of Object.entries(URL_GROUPS))
    for (const [k, v] of Object.entries(S[name]))
      if (typeof v !== "function" && !Object.is(v, base[name][k]) && JSON.stringify(v) !== JSON.stringify(base[name][k])) q.set(`${g}.${k}`, String(v));
  return "#" + q.toString();
}
let hashTimer = 0;
function queueHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => { const h = urlHash(); if (h !== location.hash) history.replaceState(null, "", h); }, 300);
}
function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  if (!q.get("s")) return null;
  // A link names its eval and indicators whenever they are not the defaults.
  const m = { strategy: q.get("s"), date: q.get("d") || null, reset: true, fromUrl: true,
              eval: q.get("e") || DEFAULT_EVAL, studies: studiesFromUrl(q.get("st")),
              tradovate: tvFromUrl(q.get("tv")), tvFocus: q.get("tvf") !== "0" };
  for (const name of Object.values(URL_GROUPS)) m[name] = {};
  for (const [k, v] of q) {
    const i = k.indexOf("."), name = i > 0 ? URL_GROUPS[k.slice(0, i)] : null;
    if (name) m[name][k.slice(i + 1)] = v;
  }
  return m;
}

// ─────────────────────────────── misc UI ───────────────────────────────
let toastTimer = 0;
function toast(msg, isErr = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

function tradeTooltip(t, ev) {
  const el = $("tooltip");
  const sg = !t && S.chart && S.chart.hoverSignal;
  if (!t && !sg) { el.classList.add("hidden"); return; }
  const row = (k, v, cls = "") => `<div class="row"><span>${k}</span><span class="${cls}">${v}</span></div>`;
  const res = lastResult && lastResult.res;
  const e = res && res.explain ? res.explain(t ? t.sigIdx : sg.k) : null;
  if (sg) {
    // a signal marker: what fired, and what the engine did with it
    const evs = (e && e.events) || [];
    // what refused the entry, when the strategy or a study did
    const no = e && e.dir && !e.entryOk ? e.checks.filter((c) => (c.role === "size" || c.role === "entry") && c.pass === false) : [];
    el.innerHTML = `<div class="t-head" style="color:${sg.dir === 1 ? "var(--bull)" : "var(--bear)"}">${sg.dir === 1 ? "LONG" : "SHORT"} SIGNAL · ${esc(e ? e.bar : "")} CT</div>` +
      (e && e.title ? `<div class="t-why">${esc(e.title)}</div>` : "") +
      evs.map((v) => `<div class="t-ev">${esc(eventText(v, res.tf, S.exec))}</div>`).join("") +
      no.map((c) => `<div class="t-ev" style="color:#ffb4b2">✗ ${esc(c.label)}${c.text ? `: ${esc(c.text)}` : ""}</div>`).join("") +
      `<div class="t-hint">Click for what triggered it</div>`;
    el.classList.remove("hidden");
    el.style.left = Math.min(window.innerWidth - el.offsetWidth - 8, ev.clientX + 14) + "px";
    el.style.top = Math.min(window.innerHeight - el.offsetHeight - 8, ev.clientY + 14) + "px";
    return;
  }
  const dir = t.dir === 1 ? "LONG" : "SHORT";
  const color = !t.taken ? "var(--dim)" : t.pnl > 0 ? "var(--bull)" : "var(--bear)";
  el.innerHTML =
    `<div class="t-head" style="color:${color}">${dir} ${t.contracts} @ ${t.entryPrice.toFixed(2)}${t.taken ? "" : " · SKIPPED"}</div>` +
    (e && e.title ? `<div class="t-why">${esc(e.title)}</div>` : "") +
    (t.taken
      ? row("P&L", fmtUsd(t.pnl, 2), t.pnl > 0 ? "" : "") + row("Exit", `${t.exitPrice.toFixed(2)} (${t.reason})`)
      : row("Blocked by", { profitStop: "daily profit stop", breaker: "your daily breaker", dailyLoss: "firm daily limit", outside: "outside window" }[t.skip] || t.skip)) +
    row("Stop / target", `${t.stop.toFixed(2)} / ${t.target.toFixed(2)}`) +
    row("MAE / MFE", `${fmtUsd(t.mae)} / ${fmtUsd(t.mfe)}`) +
    row("Bars held", t.bars) +
    row("Entered", new Date(t.entryTime).toISOString().slice(0, 16).replace("T", " ")) +
    (t.taken && t.cum != null ? row("Equity after", fmtUsd(t.cum)) : "") +
    `<div class="t-hint">Click for what triggered it</div>`;
  el.classList.remove("hidden");
  const pad = 14;
  el.style.left = Math.min(window.innerWidth - el.offsetWidth - 8, ev.clientX + pad) + "px";
  el.style.top = Math.min(window.innerHeight - el.offsetHeight - 8, ev.clientY + pad) + "px";
}

// ─────────────────────────────── boot ───────────────────────────────
async function selectStrategy(id) {
  S.strategyDesc = S.strategyList.find((s) => s.id === id) || S.strategyList[0];
  $("strategy").value = S.strategyDesc.id;   // also when the switch came from the chart link or a URL
  $("strategyDesc").textContent = S.strategyDesc.description || "";
  const mod = await import(`/strategies/${S.strategyDesc.file}?t=${Date.now()}`);
  S.strategyMod = mod.default;
  // Adopt the strategy's own risk envelope if it ships one, since stop width and
  // sizing are part of the result, not incidental settings around it. Same for
  // its regime gate and daily overlays — a config does not reproduce without them
  // -- and for its settings on the evaluation in force (src/evals.mjs).
  const b = evalBase(S.strategyMod, S.eval);
  S.params = b.params; S.exec = b.exec; S.filter = b.filter; S.rules = b.rules;
  renderEvalTabs();
  // Old sweep belongs to a different strategy — drop it rather than show numbers
  // that no longer describe anything on screen.
  S.sweep = null;
  S.sweepStale = false;
  S.lastSweepKey = "";
  renderSidebar();
  await loadWindow(S.windowStart);
}

async function boot() {
  S.meta = await fetch("/api/meta").then((r) => r.json());
  S.exec = { ...S.meta.defaults.exec };
  S.rules = { ...S.meta.defaults.rules };
  S.funded = { ...S.meta.defaults.funded };
  S.filter = { ...NO_FILTER };

  $("datasetInfo").textContent =
    `${S.meta.bars.toLocaleString()} 1-min bars · ${new Date(S.meta.startMs).toISOString().slice(0, 10)} → ${new Date(S.meta.endMs).toISOString().slice(0, 10)}`;

  S.strategyList = await fetch("/api/strategies").then((r) => r.json());
  if (!S.strategyList.length) { toast("No strategies found in strategies/", true); return; }
  S.tvLib = await fetch("/api/tradovate").then((r) => r.json());

  const sel = $("strategy");
  sel.innerHTML = "";
  for (const s of S.strategyList) {
    const o = document.createElement("option");
    o.value = s.id; o.textContent = s.name;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => selectStrategy(sel.value));

  S.chart = new ChartView($("chartWrap"));
  S.chart.onHoverTrade = (t) => { window._hoverTrade = t; if (!t) tradeTooltip(null); queuePostState(); };
  S.chart.onHoverSignal = (sg) => { if (!sg && !window._hoverTrade) tradeTooltip(null); };
  // A trade or a signal marker clicked: what triggered it (the card has its own close).
  S.chart.onClick = (hit) => { if (hit) selectWhy(hit.trade || hit.signal); };
  S.chart.onTradovateDrawn = tvPaintFit;
  // Every signal bar on the chart, entered or not: a view preference, kept.
  try { S.showSignals = localStorage.getItem("mnq.signals") === "1"; } catch { /* private mode */ }
  const sigBtn = $("sigToggle");
  const paintSigBtn = () => { sigBtn.classList.toggle("on", S.showSignals); sigBtn.setAttribute("aria-pressed", String(S.showSignals)); };
  paintSigBtn();
  sigBtn.onclick = () => {
    S.showSignals = !S.showSignals;
    try { localStorage.setItem("mnq.signals", S.showSignals ? "1" : "0"); } catch { /* private mode */ }
    paintSigBtn();
    repaint();
  };

  // Candle size is a VIEW setting, so it is deliberately not part of the
  // strategy config and never triggers a re-run — the trades on screen are the
  // same trades whatever size the candles are drawn at. Remembered between
  // visits because it is a preference, not part of a result.
  const tfSel = $("chartTf");
  const savedTf = Number(localStorage.getItem("mnq.chartTf")) || 1;
  tfSel.value = String(savedTf);
  S.chart.setTimeframe(savedTf);
  tfSel.addEventListener("change", () => {
    const v = Number(tfSel.value) || 1;
    try { localStorage.setItem("mnq.chartTf", String(v)); } catch { /* private mode */ }
    S.chart.setTimeframe(v);
  });
  $("chartWrap").addEventListener("mousemove", (e) => {
    if (e.target.closest("#whyCard")) { $("tooltip").classList.add("hidden"); return; }   // the card is not the chart
    tradeTooltip(window._hoverTrade, e);
  });
  $("chartWrap").addEventListener("mouseleave", () => tradeTooltip(null));

  S.nav = new Navigator($("nav"), (ms) => {
    const hi = S.meta.endMs - S.rules.windowDays * DAY;
    loadWindow(Math.max(S.meta.startMs, Math.min(hi, ms)));
  });

  // Start 30 days in so the warm-up prefix has real history behind it -- or
  // where the URL says, with the settings it carries.
  S.windowStart = S.meta.startMs + 30 * DAY;
  const fromUrl = readHash();
  const urlStart = fromUrl && fromUrl.date ? Date.parse(fromUrl.date + "T00:00:00Z") : NaN;
  if (Number.isFinite(urlStart)) S.windowStart = urlStart;
  // Without a link, the evaluation and indicators of the last visit.
  if (!fromUrl) {
    try {
      const e = localStorage.getItem("mnq.eval");
      if (e && EVALS[e]) S.eval = e;
      const saved = JSON.parse(localStorage.getItem("mnq.studies") || "[]");
      S.studies = adoptStudies(saved.flatMap((st) => { try { return [{ ...resolveStudy(st), id: st.id, color: st.color, hidden: st.hidden }]; } catch { return []; } }));
      const tv = JSON.parse(localStorage.getItem("mnq.tv") || "null");
      if (tv) {
        S.tvFocus = tv.focus !== false;
        for (const c of tv.list || []) { try { S.tv.push(await tvMake(c)); } catch { /* the file has gone */ } }
      }
    } catch { /* private mode, or a layout from an older version */ }
  }
  $("evalTabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-eval]"); if (b) switchEval(b.dataset.eval); });
  await selectStrategy(fromUrl && S.strategyList.some((s) => s.id === fromUrl.strategy) ? fromUrl.strategy : S.strategyList[0].id);
  if (fromUrl) await applySettings(fromUrl).catch((e) => toast(`The link's settings: ${e.message}`, true));
  connectChartLink();
  // A link pasted into this tab, or the back button through edited links.
  window.addEventListener("hashchange", () => {
    const m = readHash();
    if (m && location.hash !== urlHash()) applySettings(m).catch((e) => toast(`The link's settings: ${e.message}`, true));
  });

  $("prevWin").onclick = () => stepWindow(-1);
  $("nextWin").onclick = () => stepWindow(1);
  $("startDate").onchange = (e) => {
    const ms = Date.parse(e.target.value + "T00:00:00Z");
    if (Number.isFinite(ms)) loadWindow(ms);
  };
  $("runSweep").onclick = () => { S.lastSweepKey = ""; runSweep(); };
  $("reloadStrategies").onclick = async () => {
    S.strategyList = await fetch("/api/strategies/reload").then((r) => r.json());
    sel.innerHTML = "";
    for (const s of S.strategyList) {
      const o = document.createElement("option");
      o.value = s.id; o.textContent = s.name;
      sel.appendChild(o);
    }
    toast(`Loaded ${S.strategyList.length} strategies`);
    await selectStrategy(S.strategyList.some((s) => s.id === S.strategyDesc.id) ? S.strategyDesc.id : S.strategyList[0].id);
  };
  // Back to the strategy as it ships -- its own risk envelope, gate and daily
  // overlays, as selectStrategy() sets them -- not the generic defaults, which
  // would quietly swap its stop, target and size for 2 / 12 ATR at 8 lots.
  $("resetParams").onclick = () => {
    Object.assign(S, baseConfig());
    renderSidebar();
    loadWindow(S.windowStart);
  };

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "Escape" && S.why) { selectWhy(null); return; }
    if (e.key === "ArrowLeft") { stepWindow(e.shiftKey ? -7 : -1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { stepWindow(e.shiftKey ? 7 : 1); e.preventDefault(); }
    else if (e.key === "r") S.chart.resetView();
    else if (e.key === "e" && !e.ctrlKey && !e.metaKey && !e.altKey) switchEval(EVAL_IDS[(EVAL_IDS.indexOf(S.eval) + 1) % EVAL_IDS.length]);
  });
}

// Debug handle: lets the console (and the verification scripts) inspect exactly
// what the chart was handed, rather than re-deriving it and testing a copy.
window.lab = { S, get chart() { return S.chart; }, get last() { return lastResult; }, recompute };

boot().catch((e) => { console.error(e); toast(e.message, true); });
