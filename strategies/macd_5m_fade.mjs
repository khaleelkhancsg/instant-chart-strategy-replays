// The fading-histogram exit on 5-minute bars. Nothing else differs.
//
// See macd_1m_fade.mjs for the exit rule and, in particular, for why "lighter
// shade" needs a choice made below zero — a falling histogram there is a
// strengthening short, not a fading one, so the default reads the rule by
// MEANING rather than by literal comparison.
//
// Paired with the 1-minute version for the same reason macd_5m_flip is paired
// with macd_1m_flip: the crossover book's result is dominated by how often it
// trades and therefore by commission, and the only way to see past that is to
// hold the rule fixed and move the bar size.

import base from "./macd_1m_fade.mjs";

export default {
  ...base,

  id: "macd_5m_fade",
  name: "MACD 5-min cross in, fading histogram out",
  description: "The same crossover entry and fading-histogram exit as macd_1m_fade, on 5-minute bars.",

  timeframeMin: 5,
};
