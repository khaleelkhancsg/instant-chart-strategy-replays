// MNQ Donchian — the $1,250 bot (bot/mnq_donchian1250_bot.py), whole.
//
// donchian_shipped is the $3,000 bot. This is the book the $1,250 bot trades,
// with everything the research added for those rules
// (research/export_bot1250_fixture.mjs is the reference run):
//
//   signal     donchian_shipped's: a Donchian-30 breakout on 2-minute bars, ADX
//              14 >= 25, efficiency >= 0.5 (or >= 0.45 with the 2-minute EMA
//              125 / 500 trend agreeing), 08:30-15:00 CT
//   trend      the 10-minute EMA 9 / 21 must point the breakout's way, read from
//              the last CLOSED 10-minute bar -- the agree-only filter that took the
//              research book from 61.3% to 71.1% (research/donchian_ema_age_2026.mjs)
//   late size  half size (4 -> 2 lots) once the day's RTH range reaches 0.9 of
//              its 10-session average ("ADR used")
//   exit       the 40-minute exit: out at the next open once a trade has run 20
//              bars without ever being 1 ATR in profit; else 5 ATR stop / 1.75
//              ATR target, the $600 day line, flat 15:04 CT
//   day        4 lots, -$300 breaker, +$250 profit block, the $600 limit
//
// The trend filter and the late size refuse or shrink the ENTRY only: a refused
// breakout still flips the open trade, as the bot's sizer did.
//
// Research (lib_shipped, bootstrap, 2026): 71.1% (Jan-Mar 74.3, Apr-Jul 75.1),
// every real 21-day window 74.8%. The lab runs the physically consistent fills
// (src/engine.mjs DEFAULT_EXEC), which differ slightly from the research
// engine's older conventions. Its figures on the $1,250 rules
// (research/combos_1250.mjs, forward_1250.mjs):
//   2026      calendar 72.1% (Jan-Mar 71.1, Apr-Jul 73.3), bootstrap 70.8%
//             (71.1 / 75.9); 127 trades, 66% won, +$78 a trade.
//   null      its coin-flip twin passes 33.3%; none of 20 seeds reached 72.1%.
//   forward   TopstepX bars, Sep 10 - Oct 26 2026, after the lab's data ends:
//             23 trades, +$2,532, PF 1.93, and all 17 calendar windows passed.
//             Its twin netted +$985.
// EMA, MACD, RSI, ADR and ADX variations found nothing that beats it in both
// halves of 2026 by both methods: 31 tried one at a time, then every combination
// of the near misses. Its settings stay as the bot trades them.
//
// On the $3,000 eval it trades the research's settings for those rules (7 lots,
// late 4, -$500 / +$400; research/don_mac_robust_2026.mjs).

import shipped from "./donchian_shipped.mjs";
import { rthRangeUsed } from "../src/indicators.mjs";
import { htfEmaTrend } from "../src/studies.mjs";
import { sized, htfTrend, adrSpark, num } from "../src/explain.mjs";

export default {
  ...shipped,
  id: "donchian_1250",
  name: "MNQ Donchian — $1,250 bot (10m EMA filter, late half size, 40-min exit)",
  description: "The $1,250 Donchian bot whole: donchian_shipped's breakout, only with the 10-min EMA 9/21 trend, half size once the day has used 0.9 of its average range, out after 20 bars without 1 ATR of profit. 4 lots, -$300 / +$250 day blocks, the $600 line.",

  warmupSessions: (p) => (Math.trunc(p.adrDays) || 10) + 3,

  execDefaults: {
    ...shipped.execDefaults,
    contracts: 4,
    dayLossStopUsd: 600,
    dayBreakerUsd: 300, dayProfitBlockUsd: 250,
    staleBars: 20, staleMfeAtr: 1,
  },
  evals: { "3000": { exec: { contracts: 7, dayBreakerUsd: 500, dayProfitBlockUsd: 400 } } },

  params: [
    ...shipped.params.map((d) => (d.key === "vizShowEma" ? { ...d, default: "off" } : d)),
    { key: "htfGate", label: "Trade only with the higher-timeframe EMA", type: "select", default: "on", group: "Trend filter",
      options: [["on", "Yes"], ["off", "No"]],
      hint: "The bot's agree-only filter: 61.3% -> 71.1% in the research. A refused breakout still flips the open trade." },
    { key: "htfMin", label: "Its timeframe (min)", type: "int", min: 2, max: 60, step: 1, default: 10, group: "Trend filter" },
    { key: "htfFast", label: "EMA fast", type: "int", min: 2, max: 200, step: 1, default: 9, group: "Trend filter" },
    { key: "htfSlow", label: "EMA slow", type: "int", min: 3, max: 400, step: 1, default: 21, group: "Trend filter" },
    { key: "lateRangeUsed", label: "Late size once the day has used (x ADR, 0 = off)", type: "float", min: 0, max: 3, step: 0.05, default: 0.9, group: "Late size",
      hint: "The day's RTH range so far against the average of the previous sessions'. A late breakout has less room to run." },
    { key: "lateFrac", label: "Late size (x the size)", type: "float", min: 0, max: 1, step: 0.05, default: 0.5, group: "Late size",
      hint: "0.5 is the bot's 4 -> 2 lots. 0 skips late breakouts." },
    { key: "adrDays", label: "ADR over (sessions)", type: "int", min: 2, max: 40, step: 1, default: 10, group: "Late size" },
  ],

  compute(bars, p) {
    const out = shipped.compute(bars, p);
    const n = bars.close.length, sig = out.sig, sizeMult = new Float64Array(n).fill(1);
    const overlays = [...out.overlays];
    let tr = null, used = null;
    if (p.htfGate !== "off") {
      // Built from these bars, read from the last higher bar that had closed.
      tr = htfEmaTrend(bars, p.htfMin, p.htfFast, p.htfSlow);
      for (let k = 0; k < n; k++) if (sig[k] && tr.dir[k] !== sig[k]) sizeMult[k] = 0;
      overlays.push({ name: `${tr.tf}m EMA ${p.htfFast}`, pane: "price", data: tr.fast, color: "#f0b429" },
                    { name: `${tr.tf}m EMA ${p.htfSlow}`, pane: "price", data: tr.slow, color: "#c678dd", dash: [5, 3] });
    }
    if (p.lateRangeUsed > 0) {
      used = rthRangeUsed(bars, Math.max(2, Math.trunc(p.adrDays) || 10));
      for (let k = 0; k < n; k++) if (sig[k] && sizeMult[k] > 0 && used[k] >= p.lateRangeUsed) sizeMult[k] = p.lateFrac;
    }
    // Bar k: donchian_shipped's signal, then what decides the entry -- the
    // higher-timeframe trend, then the late size -- as the loops above apply them.
    const explain = (k) => {
      const e = out.explain(k), checks = [...e.checks], marks = [...e.marks];
      let size = 1;
      if (sig[k]) {
        if (tr) {
          const h = htfTrend(bars, k, tr, p.htfFast, p.htfSlow, sig[k], "must point the breakout's way");
          checks.push({ ...h.check, role: "size" });
          marks.push(...h.marks);
          if (!h.check.pass) size = 0;
        }
        if (used && size > 0) {
          const late = used[k] >= p.lateRangeUsed;
          checks.push(sized(`Day's range used, of its ${Math.max(2, Math.trunc(p.adrDays) || 10)}-session average`, !late,
                            { text: `${num(used[k])} × ADR`, note: late ? `${num(p.lateRangeUsed)} or more: × ${num(p.lateFrac)} size` : `under ${num(p.lateRangeUsed)}: full size`,
                              spark: adrSpark(k, used, p.lateRangeUsed) }));
          if (late) size = p.lateFrac;
        }
      }
      return { ...e, checks, marks, size };
    };
    return { ...out, sizeMult, overlays, explain };
  },
};
