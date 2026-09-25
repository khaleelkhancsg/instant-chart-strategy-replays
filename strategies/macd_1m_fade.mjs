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

  params: [
    ...baseParams,
    { key: "buildBars", label: "Growing bars before entry", type: "int",
      min: 0, max: 10, step: 1, default: 0, group: "Entry",
      hint: "0 enters on the crossover bar itself. Higher values wait for the histogram to build first, skipping crosses that never develop — so unlike the exit setting this one CHANGES the trade count. Swept in research/build_bars_sweep.mjs: at 5m, 1 is the best thing found in this family. Gross goes $3.82 to $6.25 a trade, win rate 37.1% to 40.0%, and the second half stops collapsing ($0.24 to $4.29). Win rate itself peaks at 2 (40.6%). At 1m it only makes things worse." },
    { key: "fadeBars", label: "Shrinking bars before exit", type: "int",
      min: 1, max: 10, step: 1, default: 3, group: "Exit",
      hint: "Swept in research/fade_bars_sweep.mjs. WIN RATE peaks at 3 on both timeframes (1m 31.2%->34.5%, 5m 34.7%->37.1%) and holds in both halves. PASS RATE disagrees: it rises monotonically toward never exiting at all, so the fade exit never beats holding to the opposite cross." },
  ],

  compute(bars, p) {
    // Reuse the parent's signal and overlays wholesale — same crossover, same
    // histogram, same chart — and only add the exit array on top.
    const out = base.compute(bars, p);
    const hist = out.overlays.find((o) => o.kind === "hist").data;
    const n = hist.length;

    // ── delayed ENTRY ──────────────────────────────────────────────────
    // The mirror of the exit. A crossover only says the two lines have swapped;
    // it says nothing about whether anything follows. Requiring the histogram to
    // GROW for a few bars first is the same evidence the exit waits for, read in
    // the other direction.
    //
    // Unlike the exit count this changes how many trades exist: a cross whose
    // histogram never builds is abandoned at the next cross and never traded.
    const build = Math.max(0, Math.trunc(p.buildBars) || 0);
    if (build > 0) {
      const sig2 = new Int8Array(n);
      let armed = 0, grow = 0;
      for (let i = 1; i < n; i++) {
        const v = hist[i], u = hist[i - 1];
        if (!Number.isFinite(v) || !Number.isFinite(u)) { armed = 0; grow = 0; continue; }
        const side = v >= 0 ? 1 : -1, prevSide = u >= 0 ? 1 : -1;
        if (side !== prevSide) {
          // The crossover bar itself. Arm the direction; the run starts after,
          // because |hist| across a sign change is not a growth comparison.
          armed = side; grow = 0;
          continue;
        }
        if (armed === 0 || side !== armed) continue;
        // A pause resets the run but leaves the setup armed — momentum can
        // stall and resume, and only the opposite cross cancels it outright.
        grow = Math.abs(v) > Math.abs(u) ? grow + 1 : 0;
        if (grow === build) { sig2[i] = armed; armed = 0; }
      }
      out.sig = sig2;
    }

    // Bitmask per bar: 1 = a long should leave, 2 = a short should leave.
    //
    // A RUN of shrinking bars, not a single one. One flat or slightly smaller
    // bar happens constantly inside a move that is still working, so requiring
    // N in a row is the difference between "momentum paused" and "momentum
    // over". The run is counted per side and resets the moment a bar grows
    // again or the histogram changes sign.
    const need = Math.max(1, Math.trunc(p.fadeBars) || 1);
    const exitSig = new Int8Array(n);
    let upRun = 0, dnRun = 0;
    for (let i = 1; i < n; i++) {
      const v = hist[i], u = hist[i - 1];
      if (!Number.isFinite(v) || !Number.isFinite(u)) { upRun = dnRun = 0; continue; }
      const shrinking = Math.abs(v) < Math.abs(u);
      if (v >= 0) { upRun = shrinking ? upRun + 1 : 0; dnRun = 0; }
      else { dnRun = shrinking ? dnRun + 1 : 0; upRun = 0; }
      let m = 0;
      if (upRun >= need) m |= 1;
      if (dnRun >= need) m |= 2;
      exitSig[i] = m;
    }

    return { ...out, exitSig, atr: out.atr || atr(bars.high, bars.low, bars.close, p.atrPeriod) };
  },
};
