// Rate-of-change momentum — the simplest possible "is it moving?" signal.
//
// Inspired by mnq_gap_roc.mjs in the lite backtester. No smoothing, no bands:
// just the percentage move over the last N bars, traded once it exceeds a
// threshold. Its value here is as a BASELINE. Every other book in this folder is
// more elaborate; if one of them cannot beat a bare rate-of-change filter, the
// elaboration is not earning anything.
//
// The `direction` switch makes it a two-sided experiment: `follow` is momentum
// continuation, `fade` is exhaustion. On index futures those two are close to a
// coin-flip in aggregate, and which one wins is regime-dependent — which is
// exactly what the year-by-year panel is for.

import { atr, adx, roc } from "../src/indicators.mjs";
import { trig, verdict, cooldown, spark, mark, num, px, adxAtLeast, adxAtMost, COLOR } from "../src/explain.mjs";

export default {
  id: "momentum_roc",
  name: "Rate-of-Change Momentum (baseline)",
  description: "Deliberately simple: percentage move over N bars, followed or faded. Use it as the baseline any more elaborate book has to beat.",

  timeframeMin: 5,
  warmupBars: 300,
  execDefaults: { slAtrMult: 2, tpAtrMult: 4, contracts: 8, sizingMode: "fixed" },

  params: [
    { key: "lookback", label: "Lookback bars", type: "int", min: 1, max: 200, step: 1, default: 12, group: "Signal" },
    { key: "threshold", label: "Move threshold %", type: "float", min: 0.01, max: 3, step: 0.01, default: 0.25, group: "Signal" },
    { key: "direction", label: "On a strong move", type: "select", default: "follow",
      options: [["follow", "Follow it (momentum)"], ["fade", "Fade it (exhaustion)"]], group: "Signal" },
    { key: "adxMin", label: "ADX minimum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 0, group: "Signal" },
    { key: "adxMax", label: "ADX maximum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 0, group: "Signal" },
    { key: "cooldownBars", label: "Cooldown bars", type: "int", min: 1, max: 60, step: 1, default: 3, group: "Signal" },
    { key: "adxPeriod", label: "ADX period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, tday } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const r = roc(C, p.lookback);
    const adxArr = (p.adxMin > 0 || p.adxMax > 0) ? adx(H, L, C, Math.max(2, Math.trunc(p.adxPeriod) || 14)).adx : null;
    const follow = p.direction === "follow";

    const sig = new Int8Array(n);
    let last = -Infinity, day = -1;
    for (let i = 1; i < n; i++) {
      // The cooldown restarts each session, so signal spacing never reaches back before today.
      if (tday[i] !== day) { day = tday[i]; last = -Infinity; }
      if (i - last < p.cooldownBars) continue;
      if (!Number.isFinite(r[i])) continue;
      if (adxArr) {
        if (p.adxMin > 0 && adxArr[i] < p.adxMin) continue;
        if (p.adxMax > 0 && adxArr[i] > p.adxMax) continue;
      }
      if (Math.abs(r[i]) < p.threshold) continue;
      const up = r[i] > 0;
      sig[i] = follow ? (up ? 1 : -1) : (up ? -1 : 1);
      last = i;
    }

    // Bar k as the loop reads it: the cooldown, the ADX band, then the move over
    // the lookback against the threshold.
    const adxP = Math.max(2, Math.trunc(p.adxPeriod) || 14);
    const explain = (k) => {
      const v = r[k], big = Number.isFinite(v) && !(Math.abs(v) < p.threshold);
      const checks = [trig(`Move over ${p.lookback} bars at least ${num(p.threshold)}%`, k >= 1 && big,
                           { text: Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${num(v)}%` : "not formed yet",
                             spark: spark(k, [[r, COLOR.line, "ROC"]], { refs: [p.threshold, -p.threshold] }) })];
      if (adxArr && p.adxMin > 0) checks.push(adxAtLeast(adxArr, k, p.adxMin, adxP));
      if (adxArr && p.adxMax > 0) checks.push(adxAtMost(adxArr, k, p.adxMax, adxP));
      checks.push(cooldown(sig, tday, k, p.cooldownBars));
      const up = v > 0, cand = big ? (follow ? (up ? 1 : -1) : (up ? -1 : 1)) : 0, k0 = k - p.lookback;
      const marks = big && k0 >= 0 ? [mark.zone(k0, k, `${p.lookback} bars`), mark.move(k0, C[k0], k, C[k], `${v >= 0 ? "+" : ""}${num(v)}%`, { color: up ? COLOR.up : COLOR.down }),
                                      mark.dot(k, C[k], `close ${px(C[k])}`, { color: COLOR.close })] : [];
      return { dir: verdict(cand, checks.filter(Boolean)), checks: checks.filter(Boolean), marks,
               title: big ? `${follow ? "Follow" : "Fade"} a ${num(Math.abs(v))}% move ${up ? "up" : "down"}` : "No strong move" };
    };

    return {
      sig,
      atr: a,
      overlays: [
        { name: `ROC ${p.lookback}`, pane: "sub", color: "#4aa3ff", data: r, threshold: p.threshold, range: [-1.5, 1.5] },
      ],
      explain,
    };
  },
};
