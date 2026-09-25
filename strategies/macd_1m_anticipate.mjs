// The anticipation book on 1-minute bars. Nothing else differs.
//
// See macd_5m_anticipate.mjs for the idea and its measured caveats: the
// histogram's approach to zero genuinely predicts the crossover (3.35x lift on
// five-minute bars) and genuinely fills better when the cross arrives, but the
// strategy built on it inflates about 4x in sample and leans heavily on 2020.
//
// Worth having on 1-minute for the same reason the other pairs exist. Every
// comparison in this family so far has said the 1-minute signal carries nothing
// to filter for -- the bare crossover is worth -$0.60 a trade there against
// +$4.22 at five minutes, and the entry delay that helped most at 5m made 1m
// monotonically worse. If the precursor has real content rather than being a
// slow-trend proxy, it should survive the change of bar size. If it does not,
// that is the more useful answer.

import base from "./macd_5m_anticipate.mjs";

export default {
  ...base,

  id: "macd_1m_anticipate",
  name: "MACD 1-min — anticipate the cross from the histogram",
  description: "The same pre-crossover entry as macd_5m_anticipate, on 1-minute bars: enter when the histogram has been shrinking toward zero and is close enough that a cross is likely.",

  timeframeMin: 1,
};
