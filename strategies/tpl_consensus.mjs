// TEMPLATE — Multi-speed consensus with abstention.
//
// Generalised from MACD-Angle v4, whose signal design is genuinely good even
// though its published edge turned out to be an execution artefact. Three ideas
// are worth keeping, and none of them are specific to MACD:
//
//  1. MULTI-SPEED. Run the same indicator at several speeds at once. One
//     oscillator crossing is a weak statement; four speeds of it pointing the
//     same way is a much stronger one.
//
//  2. ABSTAIN ON CONFLICT. This is the real innovation. Most ensembles AVERAGE
//     their members, which lets a strong fast signal outvote a disagreeing slow
//     one. This stands aside entirely when members disagree — treating
//     disagreement as information rather than noise to be smoothed away.
//
//  3. SLOPE GATE. Require not just the indicator's sign but its DIRECTION OF
//     TRAVEL, normalised by ATR so the threshold means the same thing whether
//     the 5-min range is 6 points or 28.
//
// Because those ideas are indicator-agnostic, this template applies them to five
// different families. `minAgree` also exposes something the original fixed: how
// many members must actually be firing, not merely not-conflicting.
//
// UNVALIDATED. A design worth searching, not a result.

import { ema, atr, adx, zscore, roc, rsi } from "../src/indicators.mjs";

export default {
  id: "tpl_consensus",
  name: "Template — Multi-Speed Consensus (abstains on conflict)",
  description: "Generalises the one genuinely good idea in MACD-Angle v4: run an indicator at several speeds, require them to agree, and stand aside when they don't. Works over MACD, z-score, ROC, EMA-slope or RSI.",

  timeframeMin: 2,
  warmupBars: 900,
  execDefaults: { contracts: 4, sizingMode: "fixed", slAtrMult: 1.5, tpMode: "rr", tpRR: 1.2, flipOnOpposite: false },

  params: [
    { key: "family", label: "Indicator family", type: "select", default: "macd",
      options: [["macd", "MACD histogram"], ["zscore", "Z-score"], ["roc", "Rate of change"], ["emaslope", "EMA slope"], ["rsi", "RSI vs 50"]], group: "Consensus" },
    { key: "nSpeeds", label: "Number of speeds", type: "int", min: 1, max: 6, step: 1, default: 4, group: "Consensus" },
    { key: "basePeriod", label: "Fastest period", type: "int", min: 2, max: 60, step: 1, default: 4, group: "Consensus" },
    { key: "growth", label: "Speed growth factor", type: "float", min: 1.1, max: 3, step: 0.05, default: 1.5, group: "Consensus",
      hint: "Each speed is this multiple of the one before. 1.5 reproduces the 4/6/9/13 ladder." },
    { key: "minAgree", label: "Members that must fire", type: "int", min: 1, max: 6, step: 1, default: 1, group: "Consensus",
      hint: "Above 1, a bar needs this many members actively agreeing — not just an absence of conflict." },
    { key: "direction", label: "Trade the consensus", type: "select", default: "follow",
      options: [["follow", "With it (momentum)"], ["fade", "Against it (reversion)"]], group: "Consensus" },
    { key: "slopeBars", label: "Slope lookback (bars)", type: "int", min: 1, max: 20, step: 1, default: 1, group: "Slope gate" },
    { key: "angleThr", label: "Slope threshold", type: "float", min: 0, max: 0.3, step: 0.005, default: 0, group: "Slope gate",
      hint: "0 = any movement in the indicator's own direction. Raise to demand acceleration." },
    { key: "adxMax", label: "ADX maximum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 0, group: "Filters" },
    { key: "adxMin", label: "ADX minimum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 0, group: "Filters" },
    { key: "startCt", label: "Signals from (CT)", type: "time", min: 0, max: 1439, step: 5, default: 8 * 60 + 30, group: "Session" },
    { key: "endCt", label: "Signals until (CT)", type: "time", min: 0, max: 1439, step: 5, default: 15 * 60, group: "Session" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "ATR" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, ctMin } = bars;
    const n = C.length;
    const a = atr(H, L, C, p.atrPeriod);
    const k = Math.max(1, Math.trunc(p.slopeBars));

    // Build the speed ladder, and note whether the family's values are in price
    // units (so the slope must be ATR-normalised) or already unitless.
    const periods = [];
    for (let j = 0; j < p.nSpeeds; j++) {
      periods.push(Math.max(2, Math.round(p.basePeriod * Math.pow(p.growth, j))));
    }

    let members, priceScaled;
    if (p.family === "macd") {
      priceScaled = true;
      members = periods.map((f) => {
        const slow = Math.max(f + 1, Math.round(f * 2.2));
        const sigP = Math.max(2, Math.round(f * 0.75));
        const ef = ema(C, f), es = ema(C, slow);
        const line = new Float64Array(n);
        for (let i = 0; i < n; i++) line[i] = ef[i] - es[i];
        const sl = ema(line, sigP);
        const hist = new Float64Array(n);
        for (let i = 0; i < n; i++) hist[i] = line[i] - sl[i];
        return hist;
      });
    } else if (p.family === "zscore") {
      priceScaled = false;
      members = periods.map((per) => zscore(C, Math.max(5, per * 5)));
    } else if (p.family === "roc") {
      priceScaled = false;
      members = periods.map((per) => roc(C, per));
    } else if (p.family === "rsi") {
      priceScaled = false;
      members = periods.map((per) => {
        const r = rsi(C, per);
        const out = new Float64Array(n);
        for (let i = 0; i < n; i++) out[i] = r[i] - 50;   // centre on zero
        return out;
      });
    } else {
      priceScaled = true;
      members = periods.map((per) => {
        const e = ema(C, per);
        const out = new Float64Array(n);
        for (let i = 1; i < n; i++) out[i] = e[i] - e[i - 1];
        return out;
      });
    }

    const useAdx = p.adxMin > 0 || p.adxMax > 0;
    const adxArr = useAdx ? adx(H, L, C, 14).adx : null;
    const fade = p.direction === "fade";

    const sig = new Int8Array(n);
    const consensus = new Float64Array(n).fill(NaN);

    for (let i = k; i < n; i++) {
      const ct = ctMin ? ctMin[i] : 0;
      if (ct < p.startCt || ct >= p.endCt) continue;
      const av = a[i];
      if (!(av > 0)) continue;
      if (adxArr) {
        if (p.adxMin > 0 && adxArr[i] < p.adxMin) continue;
        if (p.adxMax > 0 && adxArr[i] > p.adxMax) continue;
      }

      let dir = 0, agreeing = 0, conflict = false;
      for (const m of members) {
        const v = m[i];
        if (!Number.isFinite(v) || !Number.isFinite(m[i - k])) continue;
        const raw = (v - m[i - k]) / k;
        const slope = priceScaled ? raw / av : raw;
        let d = 0;
        if (v > 0 && slope >= p.angleThr) d = 1;
        else if (v < 0 && slope <= -p.angleThr) d = -1;
        if (!d) continue;
        agreeing++;
        if (!dir) dir = d;
        else if (dir !== d) { conflict = true; break; }
      }
      if (conflict || agreeing < p.minAgree) { consensus[i] = 0; continue; }
      sig[i] = fade ? -dir : dir;
      consensus[i] = dir * agreeing;
    }

    return {
      sig,
      atr: a,
      overlays: [
        { name: `${p.family} consensus (${p.nSpeeds} speeds)`, pane: "sub", color: "#c9a227",
          data: consensus, threshold: 0, range: [-p.nSpeeds - 0.5, p.nSpeeds + 0.5] },
      ],
    };
  },
};
