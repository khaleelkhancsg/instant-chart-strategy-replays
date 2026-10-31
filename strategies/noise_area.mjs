// The noise-area breakout (Barbon, Aziz and Zarattini 2024; papers/barbon-2024-*).
//
// A band around the day's open, as wide as price has usually moved from the open by each
// minute: the mean absolute percentage move at that minute over the last 14 sessions,
// around the higher and lower of the open and the prior settlement. Inside it is noise.
// At each half-hour check, a close above it goes long and a close below it goes short.
// A long leaves at a check that closes under the higher of the band and the session VWAP,
// a short at a check over the lower of them. Flat by the book's close. The paper's stop is
// that trailing level; the bracket here is only there for what a half hour can do.
//
// The paper reports a Sharpe of 1.33 on SPY, 2007 to early 2024.
//
// On MNQ, $1,250 eval, 2 lots, costs in (research/pct_books.mjs, pct_noise.mjs):
//   2026      calendar 30.9% (51.1 / 6.7, ci 8-69), bootstrap 23.4%; 161 trades, +$1,467, PF
//             1.07, and -$4,614 without its 3 best days. 63 of 200 coin flips reach it.
//   forward   Sep 11 - Oct 30: 39 trades, +$5,114, PF 3.09, 26% of 19 windows passed. 2 of 200
//             coin flips reach it, the only forward result in that study that stands out.
// Its losing runs reached $4,455 at 2 lots against a $1,000 drawdown, so it does not pass evals.

import { atr } from "../src/indicators.mjs";
import { noiseArea } from "../src/levels.mjs";
import { chk, trig, verdict, inWindow, mark, px, num, COLOR } from "../src/explain.mjs";

const RTH_OPEN = 510, RTH_CLOSE = 900;

export default {
  id: "noise_area",
  name: "Noise-area breakout (Barbon et al. 2024)",
  description: "Follows a half-hourly close outside the band price usually stays inside by that minute of the day, and leaves on a close back through the band or VWAP. Percent-based, intraday only.",

  timeframeMin: 1,
  warmupBars: 300,
  warmupSessions: (p) => (Math.trunc(p.days) || 14) + 3,
  execDefaults: { slAtrMult: 12, tpAtrMult: 60, contracts: 2, sizingMode: "fixed", flipOnOpposite: true, entryType: "market" },

  params: [
    { key: "days", label: "Band over (sessions)", type: "int", min: 5, max: 60, step: 1, default: 14, group: "Signal" },
    { key: "mult", label: "Band multiple", type: "float", min: 0.25, max: 4, step: 0.25, default: 1, group: "Signal" },
    { key: "every", label: "Check every (min)", type: "int", min: 1, max: 60, step: 1, default: 30, group: "Signal" },
    { key: "startCt", label: "First check (CT)", type: "time", min: 0, max: 1439, step: 5, default: 9 * 60, group: "Signal" },
    { key: "endCt", label: "No entries after (CT)", type: "time", min: 0, max: 1439, step: 5, default: 14 * 60 + 30, group: "Signal" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Signal" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, volume: V, ctMin, tday } = bars, n = C.length;
    const a = atr(H, L, C, p.atrPeriod), band = noiseArea(bars, { days: Math.trunc(p.days), mult: p.mult });
    const every = Math.max(1, Math.trunc(p.every)), sig = new Int8Array(n), exitSig = new Int8Array(n), vwap = new Float64Array(n).fill(NaN);
    let day = null, pv = 0, vv = 0;
    for (let i = 0; i < n; i++) {
      const ct = ctMin[i];
      if (tday[i] !== day) { day = tday[i]; pv = 0; vv = 0; }
      if (ct < RTH_OPEN || ct >= RTH_CLOSE) continue;
      const tp = (H[i] + L[i] + C[i]) / 3, vol = V[i] > 0 ? V[i] : 0;
      pv += tp * vol; vv += vol;
      vwap[i] = vv > 0 ? pv / vv : tp;
      // the close of the bar before a check is what the check reads
      const check = (ct + 1) % every === 0 && ct + 1 >= p.startCt;
      if (!check || !Number.isFinite(band.up[i])) continue;
      const up = band.up[i], dn = band.dn[i];
      if (ct + 1 <= p.endCt) { if (C[i] > up) sig[i] = 1; else if (C[i] < dn) sig[i] = -1; }
      if (C[i] < Math.max(up, vwap[i])) exitSig[i] |= 1;
      if (C[i] > Math.min(dn, vwap[i])) exitSig[i] = exitSig[i] ? 0 : -1;
    }

    const explain = (k) => {
      const ct = ctMin[k], check = (ct + 1) % every === 0 && ct + 1 >= p.startCt, up = band.up[k], dn = band.dn[k], ok = Number.isFinite(up);
      const side = check && ok && ct >= RTH_OPEN && ct < RTH_CLOSE ? (C[k] > up ? 1 : C[k] < dn ? -1 : 0) : 0;
      const checks = [chk(`A ${every}-minute check`, check, { text: `bar closing ${String(Math.floor((ct + 1) / 60) % 24).padStart(2, "0")}:${String((ct + 1) % 60).padStart(2, "0")} CT` }),
                      inWindow(ct + 1, p.startCt, p.endCt + 1, "Entries"),
                      trig(side ? `Close ${side === 1 ? "above" : "below"} the noise area` : "A close outside the noise area", !!side, { text: ok ? `${px(C[k])} against ${px(dn)} – ${px(up)}` : "the band has no history yet" })];
      const marks = side ? [mark.level(side === 1 ? up : dn, k - 30, k, `noise area ${num(p.mult)}×`, { color: side === 1 ? COLOR.up : COLOR.down }), mark.dot(k, C[k], `close ${px(C[k])}`, { color: COLOR.close })] : [];
      return { dir: verdict(side, checks), checks, marks, title: side ? `Close ${side === 1 ? "above" : "below"} the noise area → ${side === 1 ? "long" : "short"}` : "Inside the noise area" };
    };

    return {
      sig, exitSig, atr: a,
      overlays: [{ name: "Noise top", pane: "price", color: "#3d7a5a", data: band.up }, { name: "Noise bottom", pane: "price", color: "#7a3d3d", data: band.dn }, { name: "VWAP", pane: "price", color: "#f0b429", data: vwap, dash: [4, 3] }],
      exitRule: "A check that closes back under the higher of the band and VWAP, for a long, or over the lower of them, for a short",
      explain,
    };
  },
};
