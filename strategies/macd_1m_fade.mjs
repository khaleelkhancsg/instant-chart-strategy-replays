// MACD crossover in, fading histogram out. 1-minute bars.
//
// Entry is exactly macd_1m_flip's: long on a bullish MACD cross, short on a
// bearish one. What changes is the exit. Instead of holding until the opposite
// cross, the position leaves the moment the histogram prints the LIGHTER shade
// of its own colour — the bar that says momentum has stopped building.
//
// So a trade ends one of two ways: it fades out, or the opposite cross flips it.
// There is still no stop, no target and no session window.
//
// ── WHICH BAR IS "LIGHTER" ───────────────────────────────────────────────
// "Lower than the previous bar" means CLOSER TO THE BASELINE, not smaller as a
// signed number. Above zero those are the same thing. Below zero they are
// opposites: a histogram going from -3 to -5 is a BIGGER bar, a strengthening
// push, and only -5 to -3 is the fade.
//
// So the rule is symmetric in meaning, and it is one rule rather than two:
//
//   long   leaves when the histogram shrinks toward zero from above
//   short  leaves when the histogram shrinks toward zero from below
//
// which is exactly the lighter shade of its own colour on the chart.

import { atr } from "../src/indicators.mjs";
import base from "./macd_1m_flip.mjs";

// The histogram is rebuilt here from the shared helper rather than recomputed,
// so the crossover this exits from is the same one macd_1m_flip enters on.
const baseParams = base.params;

export default {
  ...base,

  id: "macd_1m_fade",
  name: "MACD 1-min cross in, fading histogram out",
  description: "Enter on a MACD crossover, exit when the histogram prints the lighter shade of its own colour — momentum no longer building. No stop, no target, no session window. 1-minute bars.",

  timeframeMin: 1,

  params: baseParams,

  compute(bars, p) {
    // Reuse the parent's signal and overlays wholesale — same crossover, same
    // histogram, same chart — and only add the exit array on top.
    const out = base.compute(bars, p);
    const hist = out.overlays.find((o) => o.kind === "hist").data;
    const n = hist.length;

    // Bitmask per bar: 1 = a long should leave, 2 = a short should leave.
    const exitSig = new Int8Array(n);
    for (let i = 1; i < n; i++) {
      const v = hist[i], u = hist[i - 1];
      if (!Number.isFinite(v) || !Number.isFinite(u)) continue;
      // Shrinking toward the baseline, whichever side of it we are on.
      if (!(Math.abs(v) < Math.abs(u))) continue;
      // A long only reads the green side and a short only the red side. On the
      // bar the histogram changes sign the crossover fires anyway and the flip
      // takes precedence, so there is nothing to disentangle.
      exitSig[i] = v >= 0 ? 1 : 2;
    }

    return { ...out, exitSig, atr: out.atr || atr(bars.high, bars.low, bars.close, p.atrPeriod) };
  },
};
