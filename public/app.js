// App orchestration.
//
// The responsiveness trick: the strategy module and the rules engine are the
// SAME ES modules the server runs, imported straight into the page. A parameter
// change therefore re-runs the real backtest over the visible window locally —
// no request, no round trip, no server-side state. The only thing that goes over
// the network is the one-off window blob and the (debounced) 5-year sweep.

import { ChartView, Navigator, fmtUsd } from "/chart.js";
import { runStrategy, resolveParams } from "/src/run.mjs";
import { replayWindow, DEFAULT_RULES } from "/src/challenge.mjs";
import { DEFAULT_EXEC } from "/src/engine.mjs";
import { NO_FILTER } from "/src/filters.mjs";
import { indexAtOrAfter } from "/src/resample.mjs";
import { windowSpan, DEFAULT_TAIL_MIN } from "/src/window.mjs";

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
  { key: "maxBarsInTrade", label: "Time stop (bars)", type: "int", min: 0, max: 2000, step: 1, default: 0, hint: "0 = off" },
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
  if (lastResult) paintTrades(lastResult.replay);
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
    `<div class="tt-foot"><span>Click a trade to zoom to it</span><button class="mini" id="tradesCsv" title="Download this window's trades">CSV</button></div>`;
  host.querySelector("tbody").onclick = (me) => {
    const tr = me.target.closest("tr");
    if (!tr) return;
    const t = ev[+tr.dataset.k].t, pad = Math.max(45, (t.exitSrc - t.entrySrc) * 0.75);
    S.chart.zoomTo(t.entrySrc - pad, t.exitSrc + pad);
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
        <span class="k">${s.n.toLocaleString()} windows · every start date</span>
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

  const run = runStrategy(S.blob, S.strategyMod, S.params, S.exec, { fromMs: S.windowStart, filter: S.filter });
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
    (res.signalsGated ? `<br><span style="color:var(--warn)">${res.signalsGated} signals gated</span>` : "");
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

  S.chart.setData({
    token: `${S.windowStart}:${blob.count}`,
    bars: blob,
    trades,
    replay,
    equityPts,
    dayBars,
    priceOverlays,
    subOverlays,
    // Overlays are indexed in signal-timeframe space; stride lets the renderer
    // convert a 1-minute pixel budget into a sane sampling step.
    // Overlay points land at the CENTRE of the bar that produced them, for the
    // same reason. srcLast put a 5-minute MACD value on the right-hand edge of
    // its own candle, so the indicator read half a candle ahead of the price it
    // was computed from.
    tfToLocal: { localIdx: centresOf(tf), stride: S.params.timeframeMin || 1 },
    lockX: replay.lockMs ? indexAtOrAfter(blob.ts, replay.lockMs) : null,
    // Where the evaluation actually ended — pass or breach, whichever came first.
    resolveX: (replay.passMs ?? replay.failMs) != null
      ? indexAtOrAfter(blob.ts, replay.passMs ?? replay.failMs) : null,
    title: `MNQ · ${S.strategyDesc.name}`,
    initialView: [S.winStartLocal, Math.min(blob.count, S.winEndLocal + 1)],
  });
}

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
  const { warmupMin, tailMin } = windowSpan(S.strategyMod, S.params, { tailMin: S.tailMin, filter: S.filter, exec: S.exec });
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
  return windowSpan(S.strategyMod, S.params, { filter: S.filter, exec: S.exec }).warmupMin > (S.loadedWarmupMin || 0);
}

function stepWindow(days) {
  const lo = S.meta.startMs;
  const hi = S.meta.endMs - S.rules.windowDays * DAY;
  loadWindow(Math.max(lo, Math.min(hi, S.windowStart + days * DAY)));
}

// ──────────────────────── full-history sweep ────────────────────────
function sweepKey() {
  return JSON.stringify([S.strategyDesc.id, S.params, S.exec, S.rules, S.funded, S.filter]);
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
        strategyId: S.strategyDesc.id,
        params: S.params, exec: S.exec, rules: S.rules, funded: S.funded, filter: S.filter,
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
    const s = r.summary;
    $("navSummary").innerHTML =
      `<span class="k">${s.n.toLocaleString()} × ${S.rules.windowDays}-day windows</span> · ` +
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
function chartSnapshot(appliedId, applyError) {
  const rp = lastResult && lastResult.replay, st = rp && rp.stats;
  const c = S.chart, cb = c && c.data && c.data.bars;
  const tr = (t) => ({ entry: isoMin(t.entryTime), exit: isoMin(t.exitTime), dir: t.dir === 1 ? "long" : "short", contracts: t.contracts,
                       entryPrice: +t.entryPrice.toFixed(2), exitPrice: +t.exitPrice.toFixed(2), reason: t.reason, pnl: +t.pnl.toFixed(2) });
  return {
    appliedId, applyError,
    strategy: S.strategyDesc && S.strategyDesc.id, strategyName: S.strategyDesc && S.strategyDesc.name,
    params: S.params, exec: S.exec, rules: S.rules, filter: S.filter, funded: S.funded,
    window: { start: isoMin(S.windowStart), tradingDay: $("startDate").value, end: isoMin(S.windowStart + S.rules.windowDays * DAY) },
    view: cb && cb.count ? { from: isoMin(cb.ts[Math.max(0, Math.floor(c.i0))]), to: isoMin(cb.ts[Math.min(cb.count - 1, Math.ceil(c.i1) - 1)]), candleMin: c.tfMin } : null,
    result: rp ? { outcome: rp.outcome, net: Math.round(st.netPnl), trades: st.trades, skipped: st.skipped, winRate: +st.winRate.toFixed(1),
                   bestDay: Math.round(st.bestDay), profitNeeded: Math.round(st.profitNeeded),
                   closestToBreach: st.minCushion == null ? null : Math.round(st.minCushion), resolvedAt: isoMin(rp.passMs ?? rp.failMs) } : null,
    trades: rp ? rp.events.slice(0, 300).map((e) => ({ ...tr(e.t), taken: e.taken, ...(e.skip ? { skipped: e.skip } : {}) })) : [],
    hoveredTrade: window._hoverTrade ? { ...tr(window._hoverTrade), taken: window._hoverTrade.taken } : null,
    sweep: S.sweep ? { ...S.sweep.summary, stale: !!S.sweepStale, funded: S.sweep.funded || null } : null,
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
  const keysOf = (o) => new Set(Object.keys(o));
  const check = (what, obj, valid) => {
    const bad = Object.keys(obj || {}).filter((k) => !valid.has(k));
    if (bad.length) throw new Error(`unknown ${what} key${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}`);
  };
  if (m.strategy && m.strategy !== S.strategyDesc.id) await selectStrategy(m.strategy);
  if (m.reset) Object.assign(S, baseConfig());
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
  renderSidebar();
  await loadWindow(startMs);
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

// ─────────────────────────────── the address bar ───────────────────────────────
// The URL carries the strategy, the window and every setting that differs from
// the strategy's own defaults (#s=<id>&d=<trading day>&x.slippageTicks=1 ...), so
// a view can be bookmarked, shared or reloaded and come back exactly.
const URL_GROUPS = { p: "params", x: "exec", r: "rules", f: "filter", u: "funded" };
function baseConfig() {
  return {
    params: resolveParams(S.strategyMod, {}),
    exec: { ...S.meta.defaults.exec, ...(S.strategyDesc.execDefaults || {}) },
    rules: { ...S.meta.defaults.rules, ...(S.strategyDesc.rulesDefaults || {}) },
    filter: { ...NO_FILTER, ...(S.strategyDesc.filterDefaults || {}) },
    funded: { ...S.meta.defaults.funded },
  };
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
  const m = { strategy: q.get("s"), date: q.get("d") || null, reset: true, fromUrl: true };
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
  if (!t) { el.classList.add("hidden"); return; }
  const row = (k, v, cls = "") => `<div class="row"><span>${k}</span><span class="${cls}">${v}</span></div>`;
  const dir = t.dir === 1 ? "LONG" : "SHORT";
  const color = !t.taken ? "var(--dim)" : t.pnl > 0 ? "var(--bull)" : "var(--bear)";
  el.innerHTML =
    `<div class="t-head" style="color:${color}">${dir} ${t.contracts} @ ${t.entryPrice.toFixed(2)}${t.taken ? "" : " · SKIPPED"}</div>` +
    (t.taken
      ? row("P&L", fmtUsd(t.pnl, 2), t.pnl > 0 ? "" : "") + row("Exit", `${t.exitPrice.toFixed(2)} (${t.reason})`)
      : row("Blocked by", { profitStop: "daily profit stop", breaker: "your daily breaker", dailyLoss: "firm daily limit", outside: "outside window" }[t.skip] || t.skip)) +
    row("Stop / target", `${t.stop.toFixed(2)} / ${t.target.toFixed(2)}`) +
    row("MAE / MFE", `${fmtUsd(t.mae)} / ${fmtUsd(t.mfe)}`) +
    row("Bars held", t.bars) +
    row("Entered", new Date(t.entryTime).toISOString().slice(0, 16).replace("T", " ")) +
    (t.taken && t.cum != null ? row("Equity after", fmtUsd(t.cum)) : "");
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
  S.params = resolveParams(S.strategyMod, {});
  // Adopt the strategy's own risk envelope if it ships one, since stop width and
  // sizing are part of the result, not incidental settings around it. Same for
  // its regime gate and daily overlays — a config does not reproduce without them.
  S.exec = { ...S.meta.defaults.exec, ...(S.strategyDesc.execDefaults || {}) };
  S.filter = { ...NO_FILTER, ...(S.strategyDesc.filterDefaults || {}) };
  S.rules = { ...S.meta.defaults.rules, ...(S.strategyDesc.rulesDefaults || {}) };
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

  const sel = $("strategy");
  sel.innerHTML = "";
  for (const s of S.strategyList) {
    const o = document.createElement("option");
    o.value = s.id; o.textContent = s.name;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => selectStrategy(sel.value));

  S.chart = new ChartView($("chartWrap"));
  S.chart.onHoverTrade = (t) => { window._hoverTrade = t; queuePostState(); };

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
  $("chartWrap").addEventListener("mousemove", (e) => tradeTooltip(window._hoverTrade, e));
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
    if (e.key === "ArrowLeft") { stepWindow(e.shiftKey ? -7 : -1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { stepWindow(e.shiftKey ? 7 : 1); e.preventDefault(); }
    else if (e.key === "r") S.chart.resetView();
  });
}

// Debug handle: lets the console (and the verification scripts) inspect exactly
// what the chart was handed, rather than re-deriving it and testing a copy.
window.lab = { S, get chart() { return S.chart; }, get last() { return lastResult; }, recompute };

boot().catch((e) => { console.error(e); toast(e.message, true); });
