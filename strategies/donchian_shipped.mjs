// MNQ Donchian — AS SHIPPED. The configuration the live bot actually runs.
//
// `donchian_eff_rth` is the RESEARCH book: the configuration that won a ~2.2
// billion window search, preserved exactly as it was measured so that every
// finding recorded against it stays comparable. This file is the DEPLOYED book.
// Same signal, same file for the signal code — the differences are all in
// sizing, geometry, cost and the account rules, and every one of them was a
// deliberate change made after the research book was frozen.
//
// Keep both. Changing the research book re-bases the numbers in its own header
// and in every research/ script that cites them; changing this one is just
// telling the truth about what is running.
//
// ── WHAT DIFFERS FROM THE RESEARCH BOOK, AND WHY ─────────────────────────
//
//   field                research   shipped   why
//   contracts                   10         8   drawdown headroom at the real
//                                              trailing $2,000, not the legal max
//   tpAtrMult                  1.5      1.75   later re-fit
//   slippageTicks                0         1   0 is not a forecast, it is an
//                                              omission; the live fills pay it
//   circuitBreaker            $150      $500   $150 locks the account out after a
//                                              single ordinary loser at 8 lots
//   dailyProfitStop          $1,000      $750   tighter soft block
//   dayLossStopUsd          0 (off)   $1,000   THE PLATFORM'S OWN LIQUIDATION
//   efficiency gate         >= 0.5    >= 0.5   plus the slow-trend rescue, below
//
// ── THE SLOW-TREND RESCUE ────────────────────────────────────────────────
// A breakout with efficiency 0.45-0.5 also counts when the 2-min EMA 125 is on
// its side of the 2-min EMA 500 (~4h vs ~17h trend). The engine's filter can
// only AND conditions and this is an OR, so the efficiency gate lives in
// compute() now rather than in filterDefaults; the session window is still a
// filter. Evidence: research/donchian_eff_ema_confirm.mjs. The bot, this file's
// logic and the Tradovate indicator are held to one another by
// bot/test_donchian_parity.py and tradovate/verify.mjs.
//
// It only pays on the bot's entry model. The rescued breakouts are the weaker
// ones, and the 0.15xATR stop-entry fills only those that follow through. With
// that order (this file's execDefaults) the rescue is worth 33.1% -> 35.5% pass
// and +$34k net over the full history; taken at market instead, the same rescue
// COSTS 33.5% -> 30.8%. The bot applies it only in stop-entry mode for exactly
// this reason. Set "Rescue floor" to 0 to see the book without it.
//
// ── THE DAY-LOSS STOP IS THE ONE THAT CHANGES THE PICTURE ────────────────
// The research book never sets `dayLossStopUsd`, so it defaults to 0 and the
// $1,000 platform liquidation is simply absent from the simulation. That is not
// a modelling nicety. Over the full 1,667-day history
// (`research/shipped_strategy_check.mjs`):
//
//                                          trades<-1k   days<-1k   worst day       net
//   donchian_eff_rth, as frozen            823 (15.4%)        368    -$13,918   $91,640
//     the same book, ONLY the cap added    386  (9.1%)          7     -$1,014  $114,739
//   donchian_shipped (this file)           315  (7.5%)          8     -$1,013  $109,154
//     the same book, ONLY the cap removed  702 (14.0%)        328    -$11,589   $57,989
//
// The cap is not a safety feature that costs money. It is worth +$23,099 to the
// research book and +$51,165 to this one, because the days it truncates are the
// ones that were running to five figures against the position. With the cap on —
// the only setting that corresponds to a real account — the other five changes
// together cost $5,585 across seven years, about 5%.
//
// The eight remaining days at -$1,013 are not breaches: the liquidating fill
// still pays commission, 8 lots x $0.75 x 2 sides = $12, so the day lands $13
// past a $1,000 cap. The research book's -$1,014 is the same $15 at 10 lots.
//
// A single TRADE below -$1,000 is legitimate — the cap is a DAY rule, so a day
// already up $5,889 can lose $6,889 on one trade and still be inside it. 368
// days below -$1,000 is not legitimate: on the real platform those accounts were
// liquidated at -$1,000 and stopped trading. `dayLossStopMode: 'exact'` models
// that liquidation the way the platform performs it — continuous tracking of
// unrealised P&L, closed AT the threshold, no queueing behind a gap — rather
// than as a resting stop order that a gap can blow through.
//
// ── THE BOT'S ORDER, NOT A MARKET FILL ───────────────────────────────────
// The live bot does not enter at the signal bar's close. It arms a STOP 0.15xATR
// beyond the next bar's open, works it for 10 bars, and falls back to a LIMIT at
// the same price when the platform refuses the stop (whenever price is already
// through the trigger — 40.8% of arms). Since the engine consolidation (one
// engine, src/engine.mjs) this file runs exactly that order, with the breaker and
// profit block applied inside the engine where the bot applies them, so the
// chart and its sweep ARE the bot's model. Full history, calendar windows:
//
//                                   pass   breached   still open   median days
//   this file (stop entries)       35.5%      55.8%         8.7%           13
//   the same book at market        30.8%      60.9%         8.4%           11
//
// 2026: 32.1% (Jan-Mar 31.1%, Apr-Jul 33.3%). research/lib_shipped.mjs, the same
// engine with its older fill conventions and judged by the day-sequence
// bootstrap, quotes 37.9%; this book scored that way is 36.6%. The rise in
// unresolved windows is the day-loss cap doing its job: it ends days early,
// which is what stops the breaches, and slows the target down in exchange.

import base from "./donchian_eff_rth.mjs";
import { ema, efficiencyRatio } from "../src/indicators.mjs";
import { chk, verdict, spark, mark, num, px, COLOR } from "../src/explain.mjs";

// trend_min_bars_2m: the bot refuses the rescue with less history than this,
// and so does this file, bar by bar. The default; `trendMinBars` overrides it.
const TREND_MIN_BARS = 1500;

export default {
  id: "donchian_shipped",
  name: "MNQ Donchian — SHIPPED live config (8 lots, $1k day stop)",
  description: "The exact configuration bot/mnq_donchian_bot.py runs: 8 contracts, 5xATR stop / 1.75xATR target, one tick of slippage, $500 breaker, $750 soft profit block, and the platform's $1,000 unrealised daily loss liquidation modelled in 'exact' mode. Same signal as donchian_eff_rth, and the bot's own order: a stop 0.15xATR beyond the next open, worked for 10 bars, re-placed as a limit when refused.",

  timeframeMin: base.timeframeMin,
  // More than the research book's 900: the trend EMA needs the rescue's history
  // requirement behind the first bar of a chart window, even after a long
  // weekend, and about three of its own periods to forget its seed. 1600 at the
  // shipped 500 / 1500.
  warmupBars: (p) => Math.max(1600, (Math.trunc(p.trendMinBars ?? TREND_MIN_BARS) || 0) + 100,
                              Math.ceil(3.2 * (Math.trunc(p.trendSlow) || 500))),

  // Mirrors CONFIG in bot/mnq_donchian_bot.py. If you change one, change both.
  execDefaults: {
    contracts: 8, sizingMode: "fixed",          // CONFIG contracts
    slAtrMult: 5, tpMode: "atr", tpAtrMult: 1.75, // sl_atr_mult / tp_atr_mult
    flipOnOpposite: true, sameBarReentry: false,  // flip_on_opposite
    intradayOnly: true,
    flattenCt: 15 * 60 + 4,                     // flatten_ct 15:04
    reopenCt: 17 * 60,                          // reopen_ct
    noEntryMinsBeforeFlat: 9,                   // no_entry_ct 14:55 = 15:04 - 9
    commissionModel: "per-contract", commissionPerSide: 0.75,
    slippageTicks: 1,
    // The bot leaves the platform's unrealised PROFIT stop off (see
    // `platform_hard_profit_stop_disabled`), so this stays 0.
    dayProfitStopUsd: 0,
    // platform_hard_loss_stop. 'exact' because the firm liquidates on a
    // continuously tracked unrealised number, not with a resting order.
    dayLossStopUsd: 1000,
    dayLossStopMode: "exact",
    // The bot's order (scale_in_first 0, "STOP-ENTRY MODE"): nothing at market.
    // The signal arms a stop 0.15 x ATR beyond the open of the bar after it,
    // working from the bar after that for 10 bars; when that bar already opens
    // through the trigger the platform refuses the stop and the same price rests
    // as a limit. A new signal cancels the working order and parks its own.
    entryType: "stop", entryTriggerAtr: 0.15, entryWindowBars: 10,   // scale_in_trigger_atr / _window_bars
    entryRefused: "limit", cancelOpposite: true,
    // On a limit fill the target counts only if the bar also closed past it:
    // the bar's high may have printed before price came back to the entry.
    limitFillTp: "close",
    // circuit_breaker / daily_profit_block, where the bot applies them: no new
    // orders, and any working one cancelled, once the day's realised P&L is at
    // -$500 or +$750.
    dayBreakerUsd: 500,
    dayProfitBlockUsd: 750,
  },
  // signal_start_ct / signal_end_ct. eff_min is applied inside compute() with
  // the rescue -- setting effMin here as well would strip every rescued signal.
  filterDefaults: { startCt: 8 * 60 + 30, endCt: 15 * 60 },
  // The breaker and profit block live in the engine (above), so the rules
  // layer's post-hoc copies are off rather than applied twice.
  rulesDefaults: { circuitBreaker: 0, dailyProfitStop: 0 },
  // On the $1,250 evaluation (src/evals.mjs; the $600 day cap follows the eval):
  // the size and day blocks research/rules_1250_2026.mjs found for these rules.
  // 8 lots makes the $600 limit a 37.5-point stop, and a +$750 block lets a day
  // run past the $625 the consistency rule allows. Calendar windows: 2026 17.0%
  // at the $3,000 settings, 44.2% at these (Jan-Mar 45.6, Apr-Jul 42.7). The
  // live $1,250 bot also gates on the 10-minute EMA 9/21 -- add it as an "EMA
  // cross" study on 10m with the gate "with": 59.4% (47.8 / 73.3) -- and has a
  // 40-minute exit and half size late in the day: strategies/donchian_1250.mjs
  // is that bot whole (72.1%).
  evals: { "1250": { exec: { contracts: 4, dayBreakerUsd: 300, dayProfitBlockUsd: 250 } } },

  // Signal code is SHARED, not copied, so the two books cannot drift apart.
  // period 30, adx_min 25, adx_period 14, atr_period 14, cooldown_bars 1 —
  // identical to CONFIG.
  //
  // The visual params below are appended AFTER base.params so the signal keys
  // keep their positions, and every one of them is prefixed `viz` so it cannot
  // collide with a key base.compute reads (period, adxMin, adxPeriod,
  // cooldownBars, atrPeriod). A collision here would silently retune the live
  // book from a chart control, which is the one thing this file must never do.
  params: [
    ...base.params,
    // The live gate (eff_min / eff_rescue_min / trend_ema_fast / trend_ema_slow).
    // Here rather than in the filter panel because the rescue is an OR.
    { key: "effMin", label: "Efficiency floor", type: "float", min: 0, max: 1, step: 0.05, default: 0.5, group: "Gate",
      hint: "Kaufman efficiency ratio the breakout must reach. 0 switches the gate off." },
    { key: "effPeriod", label: "Efficiency ratio period", type: "int", min: 2, max: 200, step: 1, default: 20, group: "Gate" },
    { key: "trendMinBars", label: "Rescue needs history (bars)", type: "int", min: 0, max: 5000, step: 50, default: TREND_MIN_BARS, group: "Gate",
      hint: "The bot refuses the slow-trend rescue until it has this many bars behind it." },
    { key: "rescueMin", label: "Rescue floor (0 = off)", type: "float", min: 0, max: 1, step: 0.05, default: 0.45, group: "Gate",
      hint: "Below the efficiency floor but at or above this, a breakout still counts when the slow trend agrees. Donchian alone 34.5% -> 37.9%, with the ORB 50.0% -> 51.7% on the bot's real entry model." },
    { key: "trendFast", label: "Trend EMA fast (2-min)", type: "int", min: 2, max: 1000, step: 5, default: 125, group: "Gate" },
    { key: "trendSlow", label: "Trend EMA slow (2-min)", type: "int", min: 3, max: 2000, step: 25, default: 500, group: "Gate",
      hint: "125/500 two-minute bars is ~4h vs ~17h. The whole 30/120-100/400 neighbourhood (in 5-min terms) scores about the same." },
    { key: "vizShowEma", label: "Show EMAs", type: "select", default: "on", group: "Visual only",
      options: [["on", "Show"], ["off", "Hide"]],
      hint: "Drawn on the price pane. Display only — the Donchian book does not read an EMA and these do not enter its rules." },
    { key: "vizEmaFast", label: "EMA fast", type: "int", min: 2, max: 200, step: 1, default: 9, group: "Visual only" },
    { key: "vizEmaSlow", label: "EMA slow", type: "int", min: 3, max: 400, step: 1, default: 21, group: "Visual only" },
    { key: "vizEmaTrend", label: "EMA trend (0 hides)", type: "int", min: 0, max: 400, step: 1, default: 50, group: "Visual only" },
    { key: "vizSubPane", label: "Sub-pane shows", type: "select", default: "macd", group: "Visual only",
      options: [["macd", "MACD"], ["adx", "ADX (as before)"], ["both", "Both together"]],
      hint: "There is only one sub-pane. Each overlay maps through its own scale so both CAN share it, but a full-height MACD histogram buries a 0-60 ADX line, so they read far better one at a time. Swapping them changes nothing the engine sees -- ADX still gates the entries either way." },
    { key: "vizMacdFast", label: "MACD fast", type: "int", min: 2, max: 100, step: 1, default: 12, group: "Visual only" },
    { key: "vizMacdSlow", label: "MACD slow", type: "int", min: 3, max: 200, step: 1, default: 26, group: "Visual only" },
    { key: "vizMacdSignal", label: "MACD signal", type: "int", min: 2, max: 50, step: 1, default: 9, group: "Visual only" },
  ],

  // VISUAL ONLY. base.compute runs untouched and its result is spread through
  // first, so `sig`, `atr` and everything else the engine reads are the same
  // objects it would have returned on its own. The only change is extra entries
  // appended to `overlays`, which nothing in src/engine.mjs ever looks at.
  //
  // Note these are computed on the strategy's own 2-MINUTE bars, because that is
  // what compute() is handed. A 12/26/9 MACD here spans 24/52/18 minutes, not
  // the 12/26/9 minutes the same numbers mean on a 1-minute chart.
  compute(bars, p) {
    const out = base.compute(bars, p);            // raw breakouts + ADX floor, as before

    // The live gate: efficiency >= effMin, or the slow-trend rescue. The
    // session window is left to filterDefaults, as it always was.
    const C = bars.close, n = C.length;
    const eff = efficiencyRatio(C, Math.max(2, Math.trunc(p.effPeriod) || 20));
    const tFast = ema(C, Math.max(2, Math.trunc(p.trendFast) || 125));
    const tSlow = ema(C, Math.max(3, Math.trunc(p.trendSlow) || 500));
    const minBars = Math.max(0, Math.trunc(p.trendMinBars ?? TREND_MIN_BARS) || 0);
    const sig = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      const r = out.sig[i];
      if (!r) continue;
      const e = eff[i];
      if (!(p.effMin > 0) || (Number.isFinite(e) && e >= p.effMin)) { sig[i] = r; continue; }
      if (p.rescueMin > 0 && i + 1 >= minBars && Number.isFinite(e) && e >= p.rescueMin &&
          (Math.sign(tFast[i] - tSlow[i]) || 0) === r) sig[i] = r;
    }
    const extra = [];

    if (p.vizShowEma !== "off") {
      const C = bars.close;
      const mk = (span, color, dash) => ({
        name: `EMA ${span}`, pane: "price", color, data: ema(C, span),
        ...(dash ? { dash } : {}),
      });
      const f = Math.max(2, Math.trunc(p.vizEmaFast) || 9);
      const s = Math.max(f + 1, Math.trunc(p.vizEmaSlow) || 21);
      extra.push(mk(f, "#4aa3ff"), mk(s, "#e0894a"));
      const t = Math.trunc(p.vizEmaTrend) || 0;
      if (t > 0) extra.push(mk(t, "#8f7fd4", [5, 4]));
    }

    const sub = p.vizSubPane || "macd";
    if (sub !== "adx") {
      const C = bars.close;
      const fast = Math.max(2, Math.trunc(p.vizMacdFast) || 12);
      const slow = Math.max(fast + 1, Math.trunc(p.vizMacdSlow) || 26);
      const sigLen = Math.max(2, Math.trunc(p.vizMacdSignal) || 9);
      const ef = ema(C, fast), es = ema(C, slow);
      const line = new Float64Array(C.length);
      for (let i = 0; i < C.length; i++) line[i] = ef[i] - es[i];
      const signal = ema(line, sigLen);
      const hist = new Float64Array(C.length);
      for (let i = 0; i < C.length; i++) hist[i] = line[i] - signal[i];
      // autoRange, not a fixed span: MACD scales with price and MNQ ran from
      // ~7,000 to ~29,000 over this dataset, so a range taken across the whole
      // history is set by the last two years and flattens everything earlier.
      extra.push(
        { name: "MACD hist", pane: "sub", kind: "hist", data: hist,
          colorUp: "#26a65b", colorUpFade: "#7fd4a0",
          colorDown: "#d1566e", colorDownFade: "#eda2b0",
          autoRange: true },
        { name: "MACD", pane: "sub", color: "#4aa3ff", data: line, autoRange: true },
        { name: "Signal", pane: "sub", color: "#e0894a", data: signal, autoRange: true },
      );
    }

    // Dropping ADX from the sub-pane when MACD is chosen is still visual-only:
    // overlays are never read by src/engine.mjs, and the ADX >= 25 entry gate in
    // base.compute is unaffected by whether its line is drawn.
    let kept = out.overlays || [];
    if (sub === "macd") kept = kept.filter((o) => !(o.pane === "sub" && o.name === "ADX"));

    // Bar k: the research book's breakout, then the live gate -- efficiency at
    // its floor, or the slow-trend rescue -- read as the loop above reads it.
    const effLen = Math.max(2, Math.trunc(p.effPeriod) || 20);
    const explain = (k) => {
      const e = out.explain(k), r = out.sig[k], checks = [...e.checks], marks = [...e.marks];
      if (r) {
        const v = eff[k], trend = Math.sign(tFast[k] - tSlow[k]) || 0;
        const floorOk = !(p.effMin > 0) || (Number.isFinite(v) && v >= p.effMin);
        const rescue = !floorOk && p.rescueMin > 0 && k + 1 >= minBars && Number.isFinite(v) && v >= p.rescueMin && trend === r;
        const fast = Math.max(2, Math.trunc(p.trendFast) || 125), slow = Math.max(3, Math.trunc(p.trendSlow) || 500);
        const why = !(p.effMin > 0) ? "the gate is off"
          : floorOk ? "price is travelling, not chopping"
          : rescue ? `below ${num(p.effMin)}, rescued: at least ${num(p.rescueMin)} with the ${bars.tfMin || 2}-min EMA ${fast} ${r === 1 ? "above" : "below"} EMA ${slow} (${px(tFast[k])} vs ${px(tSlow[k])})`
          : p.rescueMin > 0 && Number.isFinite(v) && v >= p.rescueMin
            ? (k + 1 < minBars ? `below ${num(p.effMin)}; the rescue needs ${minBars} bars of history` : `below ${num(p.effMin)}, and the slow trend points the other way`)
            : `below ${num(p.effMin)}${p.rescueMin > 0 ? ` and the rescue's ${num(p.rescueMin)}` : ""}`;
        checks.push(chk(`Efficiency ratio(${effLen}) at least ${num(p.effMin)}${p.rescueMin > 0 ? `, or ${num(p.rescueMin)} with the slow trend` : ""}`,
                        floorOk || rescue, { text: num(v), note: why,
                                             spark: spark(k, [[eff, COLOR.osc, "efficiency"]], { refs: [p.effMin, p.rescueMin > 0 ? p.rescueMin : NaN] }) }));
        if (rescue || (!floorOk && p.rescueMin > 0)) {
          marks.push(mark.line(tFast, k - 150, k, `EMA ${fast}`, { color: "#56b6c2" }), mark.line(tSlow, k - 150, k, `EMA ${slow}`, { color: "#bb9af7", dash: [5, 3] }));
        }
      }
      const notes = [];
      const shown = [p.vizShowEma !== "off" ? "the EMA lines" : "", sub !== "adx" ? "the MACD" : ""].filter(Boolean);
      if (shown.length) {
        notes.push(`Display only: ${shown.join(" and ")} on this chart ${shown.length > 1 ? "are" : "is"} not part of the rules (the "Visual only" settings). The entry reads the channel, ADX and the efficiency ratio above.`);
      }
      return { ...e, dir: verdict(e.dir, checks), checks, marks, notes };
    };

    const res = { ...out, sig, explain };
    return extra.length || kept !== out.overlays ? { ...res, overlays: [...kept, ...extra] } : res;
  },
};
