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
// ── WHAT THIS FILE STILL CANNOT REPRODUCE ────────────────────────────────
// The live bot does not enter at the signal bar's close. It arms a STOP 0.15xATR
// beyond it, waits up to 10 bars, and falls back to a LIMIT at the same price
// when the platform refuses the stop (which it does whenever price is already
// through the trigger — 40.8% of arms). `src/engine.mjs` has no deferred-entry
// model, so this strategy takes the fill at the signal bar's close plus one tick.
//
// That gap is large and it is measured: `research/lib_shipped.mjs` scores the
// same book at 49.8% pass assuming every arm fills at its trigger, and 34.5%
// once refusals are modelled honestly.
//
// So the sweep this file produces is NOT the bot's pass rate:
//
//                        pass   breached   still open   median days to pass
//   donchian_eff_rth    42.6%      54.9%         2.5%                     8
//   donchian_shipped    30.6%      60.4%         9.0%                    12
//
// 30.6% is this book alone, entered at the signal bar's close. The bot's own
// figure is 34.5% with the real entry model, and 50.0% once the ORB book runs
// alongside it — and the chart simulates neither. The rise in unresolved windows
// from 2.5% to 9.0% is the day-loss cap doing its job: it ends days early, which
// is what stops the breaches, and slows the target down in exchange.
//
// Read the chart for WHERE the bot trades, what the brackets look like, and how
// the day rules bind. The pass rate lives in research/, where the entry model
// is real.

import base from "./donchian_eff_rth.mjs";

export default {
  id: "donchian_shipped",
  name: "MNQ Donchian — SHIPPED live config (8 lots, $1k day stop)",
  description: "The exact configuration bot/mnq_donchian_bot.py runs: 8 contracts, 5xATR stop / 1.75xATR target, one tick of slippage, $500 breaker, $750 soft profit block, and the platform's $1,000 unrealised daily loss liquidation modelled in 'exact' mode. Same signal as donchian_eff_rth; entry model is NOT the bot's deferred stop entry.",

  timeframeMin: base.timeframeMin,
  warmupBars: base.warmupBars,

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
  },
  // signal_start_ct / signal_end_ct / eff_min
  filterDefaults: { startCt: 8 * 60 + 30, endCt: 15 * 60, effMin: 0.5 },
  // circuit_breaker / daily_profit_block
  rulesDefaults: { circuitBreaker: 500, dailyProfitStop: 750 },

  // Signal code is SHARED, not copied, so the two books cannot drift apart.
  // period 30, adx_min 25, adx_period 14, atr_period 14, cooldown_bars 1 —
  // identical to CONFIG.
  params: base.params,
  compute: base.compute,
};
