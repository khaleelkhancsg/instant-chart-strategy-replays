// The 1-minute MACD control, on 5-minute bars. Nothing else differs.
//
// Same signal, same geometry, same absence of rules: long on a bullish MACD
// cross, short on a bearish one, and the only thing that closes a position is
// the opposite cross. See macd_1m_flip.mjs for why "no rules" takes three
// deliberate execution settings rather than one.
//
// ── WHY IT IS A PAIR AND NOT A PARAMETER ────────────────────────────────
// The signal timeframe is already a slider, so this could have been "set it to
// 5". Having both side by side in the dropdown is the point: the interesting
// question about a crossover book is how much of its result is the signal and
// how much is the bar size, and that is a comparison you want to be able to
// flip between rather than reconstruct.
//
// It matters most for cost. A 1-minute crossover fires roughly five times as
// often and pays commission every time -- the 1-minute book loses $12.60 a
// trade of which $12.00 is commission, so what it really measures is the fee
// schedule. Slowing the bars down is the cheapest possible way to find out
// whether anything survives underneath.
//
// Everything is imported rather than copied, so the two cannot drift: change
// the crossover rule in macd_1m_flip.mjs and this moves with it.

import base from "./macd_1m_flip.mjs";

export default {
  ...base,

  id: "macd_5m_flip",
  name: "MACD 5-min crossover ONLY (bare control)",
  description: "The same bare MACD crossover as macd_1m_flip, on 5-minute bars. Long on a bullish cross, short on a bearish one, flipping at every cross. No stop, no target, no session window, no filters.",

  timeframeMin: 5,
  // Same number of bars, five times the calendar span — a slower MACD needs
  // the same count of its OWN bars to settle, not the same number of minutes.
  warmupBars: base.warmupBars,
};
