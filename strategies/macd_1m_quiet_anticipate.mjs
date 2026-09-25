// The quiet-gated anticipation book on 1-minute bars. Nothing else differs.
//
// See macd_5m_quiet_anticipate.mjs for the rule, the evidence behind the gate,
// and the list of things that were tested and did not work.
//
// ── READ THIS BEFORE TRUSTING THE 1-MINUTE NUMBERS ───────────────────────
// Everything that validated the gate was measured on FIVE-minute bars. This
// twin exists so the change of bar size is available as a test rather than an
// assumption, and every previous pairing in this family has said the 1-minute
// signal carries less:
//
//   bare crossover            -$0.60 a trade at 1m against +$4.22 at 5m
//   delayed entry             the build-bars delay that helped most at 5m made
//                             1m monotonically worse
//   anticipation              1m never reproduced the 5m precursor lift
//
// A 1-minute bar also changes what the gate MEANS without changing its numbers.
// The ADR test is unaffected, being a daily quantity, but the histogram's
// approach to zero is five times noisier per bar, so shrinkBars = 3 is a much
// weaker piece of evidence here than it is at 5m, and the fade exit fires on
// runs that are mostly noise. If the edge is real it should survive; if it is a
// slow-trend artefact of the five-minute bar, this is where that shows up.
//
// Commission is the other half of it. The 5m book holds about 19 bars, which is
// 95 minutes; the same rule on 1m bars holds roughly the same wall-clock time
// only if the fade count is scaled up, and left at 3 it will trade far more
// often for the same $12 round trip.
//
// ── IT DID NOT SURVIVE, WHICH IS THE POINT OF HAVING IT ──────────────────
// Measured: -$12.07 a trade and 12.5% pass rate against the 5-minute book's
// +$8.85 and 22.0%, negative on every fade setting tried. Average points come
// out at 0.00 -- 29,294 trades times a $12 round trip is $351k against a $353k
// loss, so the signal has NO gross edge here at all and loses precisely the
// commission. Commission is not eating a real edge; there is nothing under it.
//
// That is the useful answer. The gate is a five-minute phenomenon, and this file
// stays as the control that says so rather than being deleted.

import base from "./macd_5m_quiet_anticipate.mjs";

export default {
  ...base,

  id: "macd_1m_quiet_anticipate",
  name: "MACD 1-min — quiet-gated anticipation, fade exit",
  description: "The same quiet-gated anticipation and fading-histogram exit as macd_5m_quiet_anticipate, on 1-minute bars. The gate was validated at 5 minutes; this is the bar-size control.",

  timeframeMin: 1,
  // The MACD slow EMA needs a long run-up, and the |hist| scale window is 200
  // bars on top of that. 600 one-minute bars clears both comfortably.
  warmupBars: 600,
};
