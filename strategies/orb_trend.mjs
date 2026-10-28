// ORB WITH THE TREND — the opening-range break, filtered by EMA, ADR and ADX.
//
// The project's ORB lost money as traded (project notes: a minute crossing both
// levels was a fill and a stop, not a skip), and nothing tried beat switching it
// off. This book asks whether the indicators fix the SELECTION rather than the
// order: break only
//   - in the direction of the higher-timeframe EMA trend (default the 10-minute
//     9 / 21), read from its last closed bar;
//   - when the opening range has not already used up the day: its width at most
//     `maxOrAdr` of the average RTH range of the previous sessions (ADR), and at
//     least `minOrAdr` of it (each 0 = off);
//   - with ADX on the signal bars at least `adxMin` (0 = off).
//
// A break is a bar CLOSING beyond the range after it is complete, before
// `entryEndCt`; one a day, or one each way. Entry is at the next open (or the
// engine's stop entry). The bracket's unit is the ATR, or -- `unit: range` -- the
// opening range's width, so a 1-unit stop sits about the far side of the range.
//
// ── WHAT THE SEARCH FOUND (research/combos_1250_new.mjs, $1,250 rules) ──
// 1,152 configurations on the lab's 2026 (Jan 2 - Jul 14). The defaults have
// the best worst half:
//   - the 5-minute opening range, breaks until 12:00 CT;
//   - taken only with the 30-minute EMA 9 / 21 and ADX >= 20, one each way;
//   - a 5 ATR stop and a 1.75 ATR target, on 1-minute bars.
// Results:
//   2026     calendar 63.6% (Jan-Mar 62.2, Apr-Jul 65.3), bootstrap 48.5%
//            (59.6 / 41.9); 101 trades, 65% won, +$63 a trade, PF 1.31.
//   filter   the trend filter does the work: without it the same breaks pass
//            43.0% (calendar).
//   null     the coin-flip twin passes 39.4%, and 2 of 20 seeds matched the book.
//   halves   picked on Jan-Mar, the grid's best scored 9.9 on Apr-Jul.
//   forward  Sep 10 - Oct 26 2026 on TopstepX bars (research/forward_1250.mjs):
//            20 trades, -$234, PF 0.95. Calendar 58.8% against its twin's 34.4%,
//            but 11 of 20 twins netted as much.
// No edge shown yet: re-run the forward check as data accrues.

import { atr, adx, rthRangeUsed } from "../src/indicators.mjs";
import { htfEmaTrend } from "../src/studies.mjs";
import { chk, trig, verdict, mark, num, px, dayStart, clock, htfTrend, adxAtLeast, COLOR } from "../src/explain.mjs";

const RTH_OPEN = 510;

export default {
  id: "orb_trend",
  name: "ORB with the trend — EMA, ADR and ADX filters",
  description: "Opening-range breakout taken only with the higher-timeframe EMA trend, when the opening range has not used up the day's average range, with ADX strength. Close-confirmed breaks, one each way by default. Built for the $1,250 eval; no forward edge shown yet.",

  timeframeMin: 1,
  warmupBars: 400,
  warmupSessions: (p) => (Math.trunc(p.adrDays) || 10) + 3,

  execDefaults: {
    contracts: 4, sizingMode: "fixed",
    slAtrMult: 5, tpMode: "atr", tpAtrMult: 1.75, tpMaxUsd: 0,
    flipOnOpposite: true, sameBarReentry: false,
    entryType: "market",
    intradayOnly: true, flattenCt: 15 * 60 + 5, reopenCt: 17 * 60, noEntryMinsBeforeFlat: 10,
    commissionModel: "per-contract", commissionPerSide: 0.75, slippageTicks: 1,
    dayLossStopUsd: 600, dayLossStopMode: "exact",
    dayBreakerUsd: 200, dayProfitBlockUsd: 250,
  },
  rulesDefaults: { circuitBreaker: 0, dailyProfitStop: 0 },

  params: [
    { key: "orMinutes", label: "Opening range (minutes from 08:30 CT)", type: "int", min: 1, max: 120, step: 1, default: 5, group: "Range" },
    { key: "entryEndCt", label: "Breaks until (CT)", type: "time", min: 0, max: 1440, step: 5, default: 12 * 60, group: "Range" },
    { key: "once", label: "Breaks taken", type: "select", default: "perSide", group: "Range",
      options: [["first", "The first of the day"], ["perSide", "One each way"]] },
    { key: "unit", label: "Bracket unit", type: "select", default: "atr", group: "Range",
      options: [["range", "The opening range's width"], ["atr", "ATR"]],
      hint: "With 'range', Stop (x ATR) and Target mean multiples of the range's width." },
    { key: "trendMode", label: "Higher-timeframe EMA", type: "select", default: "with", group: "Filters",
      options: [["with", "Break only its way"], ["off", "Ignore it"]] },
    { key: "trendTf", label: "Trend timeframe (min)", type: "int", min: 1, max: 60, step: 1, default: 30, group: "Filters" },
    { key: "trendFast", label: "Trend EMA fast", type: "int", min: 2, max: 200, step: 1, default: 9, group: "Filters" },
    { key: "trendSlow", label: "Trend EMA slow", type: "int", min: 3, max: 400, step: 1, default: 21, group: "Filters" },
    { key: "maxOrAdr", label: "Range at most (x ADR, 0 = off)", type: "float", min: 0, max: 2, step: 0.05, default: 0, group: "Filters" },
    { key: "minOrAdr", label: "Range at least (x ADR, 0 = off)", type: "float", min: 0, max: 2, step: 0.05, default: 0, group: "Filters" },
    { key: "adrDays", label: "ADR over (sessions)", type: "int", min: 2, max: 40, step: 1, default: 10, group: "Filters" },
    { key: "adxMin", label: "ADX minimum (0 = off)", type: "int", min: 0, max: 60, step: 1, default: 20, group: "Filters" },
    { key: "adxPeriod", label: "ADX period", type: "int", min: 2, max: 60, step: 1, default: 14, group: "Filters" },
    { key: "atrPeriod", label: "ATR period", type: "int", min: 2, max: 100, step: 1, default: 14, group: "Filters" },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, ctMin: CT, tday: TD } = bars, n = C.length;
    const a = atr(H, L, C, Math.max(2, Math.trunc(p.atrPeriod) || 14));
    const tr = p.trendMode === "off" ? null : htfEmaTrend(bars, p.trendTf, p.trendFast, p.trendSlow);
    const ax = p.adxMin > 0 ? adx(H, L, C, Math.max(2, Math.trunc(p.adxPeriod) || 14)).adx : null;
    const used = p.maxOrAdr > 0 || p.minOrAdr > 0 ? rthRangeUsed(bars, Math.max(2, Math.trunc(p.adrDays) || 10)) : null;
    const orEnd = RTH_OPEN + Math.max(1, Math.trunc(p.orMinutes) || 15);
    const sig = new Int8Array(n), unit = p.unit === "atr" ? a : new Float64Array(n).fill(NaN);
    const hiLine = new Float64Array(n).fill(NaN), loLine = new Float64Array(n).fill(NaN);
    let day = null, hi = -Infinity, lo = Infinity, orUsed = NaN, ok = false, longDone = false, shortDone = false;
    for (let i = 0; i < n; i++) {
      const ct = CT ? CT[i] : 0;
      if (TD[i] !== day) { day = TD[i]; hi = -Infinity; lo = Infinity; orUsed = NaN; ok = false; longDone = shortDone = false; }
      if (ct >= RTH_OPEN && ct < orEnd) {
        if (H[i] > hi) hi = H[i];
        if (L[i] < lo) lo = L[i];
        if (used) orUsed = used[i];       // the range's share of ADR, as of its last bar
        ok = true;
        continue;
      }
      if (!ok || ct < orEnd || ct >= 900) continue;
      hiLine[i] = hi; loLine[i] = lo;
      if (p.unit !== "atr") unit[i] = hi - lo;
      if (ct >= p.entryEndCt || (longDone && shortDone)) continue;
      const d = C[i] > hi ? 1 : C[i] < lo ? -1 : 0;
      if (!d || (d === 1 ? longDone : shortDone)) continue;
      if (p.once !== "perSide") { longDone = shortDone = true; } else if (d === 1) longDone = true; else shortDone = true;
      if (tr && tr.dir[i] !== d) continue;
      if (ax && !(ax[i] >= p.adxMin)) continue;
      if (p.maxOrAdr > 0 && !(orUsed <= p.maxOrAdr)) continue;
      if (p.minOrAdr > 0 && !(orUsed >= p.minOrAdr)) continue;
      sig[i] = d;
    }
    // Bar k, replaying the session up to it as the loop does: the range, then
    // the first close beyond it each way -- a break takes its slot even when a
    // filter then refuses it -- then the trend, ADX and range-size filters.
    const explain = (k) => {
      const s0 = dayStart(TD, k), perSide = p.once === "perSide";
      let h = -Infinity, l = Infinity, oUsed = NaN, seen = false, o0 = -1, o1 = -1, upDone = false, dnDone = false;
      for (let j = s0; j < k; j++) {
        const cj = CT ? CT[j] : 0;
        if (cj >= RTH_OPEN && cj < orEnd) { if (H[j] > h) h = H[j]; if (L[j] < l) l = L[j]; if (used) oUsed = used[j]; seen = true; if (o0 < 0) o0 = j; o1 = j; continue; }
        if (!seen || cj < orEnd || cj >= 900 || cj >= p.entryEndCt || (upDone && dnDone)) continue;
        const dj = C[j] > h ? 1 : C[j] < l ? -1 : 0;
        if (!dj || (dj === 1 ? upDone : dnDone)) continue;
        if (!perSide) upDone = dnDone = true; else if (dj === 1) upDone = true; else dnDone = true;
      }
      const ct = CT ? CT[k] : 0;
      if (ct >= RTH_OPEN && ct < orEnd) return { dir: 0, checks: [trig("The opening range complete", false, { text: "still building it" })], marks: [] };
      if (!seen) return { dir: 0, checks: [trig("An opening range today", false, { text: `none yet (from ${clock(RTH_OPEN)} CT)` })], marks: [] };
      const checks = [chk(`Breaks from ${clock(orEnd)} until ${clock(Math.min(p.entryEndCt, 900))} CT`, !(ct < orEnd || ct >= 900 || ct >= p.entryEndCt), { text: `bar opens ${clock(ct)}` })];
      const d = C[k] > h ? 1 : C[k] < l ? -1 : 0, spent = d && (d === 1 ? upDone : dnDone) || (upDone && dnDone);
      checks.push(trig(d ? `Close ${d === 1 ? "above" : "below"} the ${p.orMinutes}-minute range` : `Close beyond the ${p.orMinutes}-minute range`, !!d,
                       { text: d === 1 ? `${px(C[k])} > ${px(h)}` : d === -1 ? `${px(C[k])} < ${px(l)}` : `${px(C[k])} inside ${px(l)} – ${px(h)}` }));
      if (d) checks.push(chk(perSide ? "The first break that way today" : "The first break of the day", !spent, { text: spent ? "a break already took that slot" : "yes" }));
      const marks = [mark.zone(o0, o1, `${p.orMinutes}-min range`), mark.level(h, o0, k, `OR high ${px(h)}`, { color: COLOR.up }), mark.level(l, o0, k, `OR low ${px(l)}`, { color: COLOR.down })];
      if (d) {
        marks.push(mark.dot(k, C[k], `close ${px(C[k])}`, { color: COLOR.close }));
        if (tr) { const t = htfTrend(bars, k, tr, p.trendFast, p.trendSlow, d, "must point the break's way"); checks.push(t.check); marks.push(...t.marks); }
        if (ax) checks.push(adxAtLeast(ax, k, p.adxMin, Math.max(2, Math.trunc(p.adxPeriod) || 14), { strict: true }));
        if (p.maxOrAdr > 0) checks.push(chk(`Range at most ${num(p.maxOrAdr)} × ADR`, oUsed <= p.maxOrAdr, { text: `${num(oUsed)} × ADR` }));
        if (p.minOrAdr > 0) checks.push(chk(`Range at least ${num(p.minOrAdr)} × ADR`, oUsed >= p.minOrAdr, { text: `${num(oUsed)} × ADR` }));
      }
      return { dir: verdict(d, checks), checks, marks,
               title: d ? `Opening-range break ${d === 1 ? "up" : "down"}` : "No opening-range break" };
    };

    return {
      sig, atr: unit,
      overlays: [
        { name: "OR high", pane: "price", color: "#3d7a5a", data: hiLine, dash: [6, 3] },
        { name: "OR low", pane: "price", color: "#8a3d3d", data: loLine, dash: [6, 3] },
        ...(tr ? [{ name: `${tr.tf}m EMA ${p.trendFast}`, pane: "price", data: tr.fast, color: "#f0b429" },
                  { name: `${tr.tf}m EMA ${p.trendSlow}`, pane: "price", data: tr.slow, color: "#c678dd", dash: [5, 3] }] : []),
      ],
      explain,
    };
  },
};
