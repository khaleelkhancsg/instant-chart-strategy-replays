// Session range fade — built specifically for the no-overnight constraint.
//
// Every other book in this folder was designed assuming positions could be held
// through the close, and the 3:05 PM CT flatten costs them ~43% of gross profit
// because it truncates their long-running winners. This one is designed the other
// way round: fade the edges of the day's developing range, with a target measured
// to be reachable within hours rather than days.
//
// The idea: each session builds a high/low. Price poking outside it and failing
// to hold is a rejection, and the natural target is back toward the middle of the
// range — a move that resolves in the same session by construction.
//
// Two deliberate design choices for the deadline:
//   - The target is a FRACTION OF THE RANGE, not a wide ATR multiple. Its size is
//     bounded by what the day has already proved it can travel.
//   - `noNewAfterCt` stops entries with time left for the trade to work, rather
//     than opening something that can only be flattened.
//
// Untested and unvalidated — it is a structurally-motivated starting point, not
// a result. Tune it against the year-by-year panel before believing anything.

import { atr } from "../src/indicators.mjs";
import { chk, trig, verdict, cooldown, mark, num, px, dayStart, clock, COLOR } from "../src/explain.mjs";

export default {
  id: "session_range_fade",
  name: "Session Range Fade (intraday-native)",
  description: "Fades rejections at the edge of the day's developing range, targeting the middle. Designed to resolve inside one session, so the 3:05 PM CT flatten costs it little. Unvalidated starting point.",

  timeframeMin: 5,
  warmupBars: 200,
  execDefaults: { slAtrMult: 1.5, tpAtrMult: 2.5, contracts: 8, sizingMode: "fixed" },

  params: [
    { key: "buildUntilCt", label: "Build range until (CT)", type: "time", min: 0, max: 1439, step: 5, default: 9 * 60 + 30, group: "Signal",
      hint: "Range must establish before it can be faded." },
    { key: "noNewAfterCt", label: "No new entries after (CT)", type: "time", min: 0, max: 1439, step: 5, default: 13 * 60 + 30, group: "Signal",
      hint: "Leave time for the trade to work before the 3:05 PM flatten." },
    { key: "pokeAtrMult", label: "Poke beyond edge (× ATR)", type: "float", min: 0, max: 3, step: 0.05, default: 0.25, group: "Signal",
      hint: "How far outside the range counts as a genuine probe." },
    { key: "requireReject", label: "Require rejection close", type: "select", default: "on",
      options: [["on", "Yes — close back inside"], ["off", "No — fade the poke itself"]], group: "Signal" },
    { key: "minRangeAtr", label: "Minimum range (× ATR)", type: "float", min: 0, max: 20, step: 0.5, default: 3, group: "Signal",
      hint: "Skip days too compressed for a fade to have room." },
    { key: "cooldownBars", label: "Cooldown bars", type: "int", min: 1, max: 60, step: 1, default: 6, group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, ctMin, tday } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const sig = new Int8Array(n);
    const hiLine = new Float64Array(n).fill(NaN);
    const loLine = new Float64Array(n).fill(NaN);

    let curDay = -1, dayHi = -Infinity, dayLo = Infinity;
    let last = -Infinity;

    for (let i = 1; i < n; i++) {
      const ct = ctMin ? ctMin[i] : 0;
      if (tday[i] !== curDay) { curDay = tday[i]; dayHi = -Infinity; dayLo = Infinity; last = -Infinity; }

      // The range keeps developing all session; it is simply not fadeable yet.
      if (H[i] > dayHi) dayHi = H[i];
      if (L[i] < dayLo) dayLo = L[i];
      if (ct < p.buildUntilCt) continue;

      hiLine[i] = dayHi; loLine[i] = dayLo;
      if (ct >= p.noNewAfterCt) continue;
      if (i - last < p.cooldownBars) continue;
      if (!Number.isFinite(a[i]) || a[i] <= 0) continue;
      if (dayHi - dayLo < p.minRangeAtr * a[i]) continue;

      const poke = p.pokeAtrMult * a[i];
      const strict = p.requireReject === "on";

      // Probed above the range high, then closed back inside -> fade short.
      if (H[i] >= dayHi - 1e-9 && H[i] - Math.max(C[i], C[i - 1]) >= poke) {
        if (!strict || C[i] < dayHi - poke) { sig[i] = -1; last = i; continue; }
      }
      if (L[i] <= dayLo + 1e-9 && Math.min(C[i], C[i - 1]) - L[i] >= poke) {
        if (!strict || C[i] > dayLo + poke) { sig[i] = 1; last = i; }
      }
    }

    // Bar k as the loop reads it: the session's range so far (bar k included;
    // from bar 1 on, as the loop starts), the build and entry times, the
    // cooldown, the range's size, then a probe beyond an edge that closed back.
    const explain = (k) => {
      const none = (label, text) => ({ dir: 0, checks: [trig(label, false, { text })], marks: [] });
      if (k < 1) return none("A session range", "the first bar");
      const s0 = Math.max(1, dayStart(tday, k));
      let hi = -Infinity, lo = Infinity;
      for (let j = s0; j <= k; j++) { if (H[j] > hi) hi = H[j]; if (L[j] < lo) lo = L[j]; }
      const ct = ctMin ? ctMin[k] : 0;
      const checks = [chk(`Range built (from ${clock(p.buildUntilCt)} CT)`, !(ct < p.buildUntilCt), { text: `bar opens ${clock(ct)}` }),
                      chk(`No new entries from ${clock(p.noNewAfterCt)} CT`, !(ct >= p.noNewAfterCt), { text: clock(ct) }),
                      cooldown(sig, tday, k, p.cooldownBars)].filter(Boolean);
      const ok = Number.isFinite(a[k]) && a[k] > 0;
      if (!ok) return { dir: 0, checks: [...checks, chk("ATR ready", false, { text: "not yet" })], marks: [] };
      checks.push(chk(`Range at least ${num(p.minRangeAtr)} × ATR`, !(hi - lo < p.minRangeAtr * a[k]), { text: `${num((hi - lo) / a[k])} × ATR (${num(hi - lo)} pts)` }));
      const poke = p.pokeAtrMult * a[k], strict = p.requireReject === "on";
      const probeHi = H[k] >= hi - 1e-9 && H[k] - Math.max(C[k], C[k - 1]) >= poke, rejHi = !strict || C[k] < hi - poke;
      const probeLo = L[k] <= lo + 1e-9 && Math.min(C[k], C[k - 1]) - L[k] >= poke, rejLo = !strict || C[k] > lo + poke;
      const side = probeHi && rejHi ? -1 : probeLo && rejLo ? 1 : 0;
      const at = side === -1 ? hi : lo;
      checks.push(trig(side ? `Probed the session ${side === -1 ? "high" : "low"} by ${num(p.pokeAtrMult)} × ATR${strict ? " and closed back inside" : ""}` : "A rejected probe of an edge", !!side,
                       { text: side ? `${side === -1 ? "high" : "low"} ${px(side === -1 ? H[k] : L[k])}, close ${px(C[k])}` : `high ${px(H[k])} / low ${px(L[k])} vs range ${px(lo)} – ${px(hi)}` }));
      const marks = side ? [mark.level(hi, s0, k, `session high ${px(hi)}`, { color: COLOR.up }), mark.level(lo, s0, k, `session low ${px(lo)}`, { color: COLOR.down }),
                            mark.dot(k, at, "the probe", { color: COLOR.level }), mark.dot(k, C[k], `close ${px(C[k])}`, { color: COLOR.close })] : [];
      return { dir: verdict(side, checks), checks, marks,
               title: side ? `Rejected at the session ${side === -1 ? "high: fade short" : "low: fade long"}` : "No rejection at an edge" };
    };

    return {
      sig,
      atr: a,
      overlays: [
        { name: "Session high", pane: "price", color: "#3d7a5a", data: hiLine, dash: [5, 3] },
        { name: "Session low", pane: "price", color: "#7a3d3d", data: loLine, dash: [5, 3] },
      ],
      explain,
    };
  },
};
