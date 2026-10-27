// Stage 1: can EMA, MACD, RSI, ADR or ADX improve the two $1,250 books?
//
//   node --max-old-space-size=8192 research/combos_1250.mjs [donchian|macd]
//
// One factor at a time around each book as it ships (strategies/donchian_1250.mjs,
// strategies/macd_fade_1250.mjs), on the $1,250 rules, 2026 only. Each variant is
// scored by both pass-rate methods -- calendar windows (the chart's sweep) and the
// day-sequence bootstrap (the research's) -- for all of 2026 and for each half,
// Jan-Mar and Apr-Jul. Indicator conditions go in as studies (src/studies.mjs),
// so a gate is exactly what the chart's Indicators panel would apply: read from
// closed bars, refusing entries only.
//
// A variant SURVIVES only if it beats the base in both halves by both methods.
// With ~30 variants a book, a couple will beat the base in all four by luck, so
// survivors are then stacked, picked on one half and read on the other, and
// checked against the coin-flip twin (research/lib_eval1250.mjs).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "./lib_eval1250.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const which = process.argv[2] || "both";
const st = (type, tf, params, gate) => ({ type, tf, params, gate });

const DONCHIAN = [
  ["base", {}],
  ["ADX >= 20", { params: { adxMin: 20 } }],
  ["ADX >= 30", { params: { adxMin: 30 } }],
  ["+DI/-DI agree (2m)", { studies: [st("adx", 0, { period: 14 }, "with")] }],
  ["RSI 14 no chase 80/20", { studies: [st("rsi", 0, { length: 14, lo: 20, hi: 80 }, "nochase")] }],
  ["RSI 14 no chase 85/15", { studies: [st("rsi", 0, { length: 14, lo: 15, hi: 85 }, "nochase")] }],
  ["RSI 14 with (>50 long)", { studies: [st("rsi", 0, { length: 14 }, "with")] }],
  ["MACD hist agrees (2m)", { studies: [st("macd", 0, {}, "with")] }],
  ["MACD hist agrees (5m)", { studies: [st("macd", 5, {}, "with")] }],
  ["EMA 9/21 30m agrees too", { studies: [st("emacross", 30, { fast: 9, slow: 21 }, "with")] }],
  ["EMA 20/50 10m (not 9/21)", { params: { htfFast: 20, htfSlow: 50 } }],
  ["EMA 9/21 on 5m", { params: { htfMin: 5 } }],
  ["EMA 9/21 on 15m", { params: { htfMin: 15 } }],
  ["late size from 0.7 ADR", { params: { lateRangeUsed: 0.7 } }],
  ["late size from 1.1 ADR", { params: { lateRangeUsed: 1.1 } }],
  ["skip late (0 lots)", { params: { lateFrac: 0 } }],
  ["ADR used <= 1.5 only", { studies: [st("adrused", 0, { days: 10, hi: 1.5 }, "below")] }],
  ["busy days only (ATR ratio >= 0.8)", { studies: [st("volrel", 0, { lo: 0.8 }, "above")] }],
  ["busy days only (ATR ratio >= 1)", { studies: [st("volrel", 0, { lo: 1 }, "above")] }],
  ["stale exit 15 bars", { exec: { staleBars: 15 } }],
  ["stale exit 30 bars", { exec: { staleBars: 30 } }],
  ["stale exit needs 0.5 ATR", { exec: { staleMfeAtr: 0.5 } }],
  ["stale exit needs 1.5 ATR", { exec: { staleMfeAtr: 1.5 } }],
  ["target 1.5 ATR", { exec: { tpAtrMult: 1.5 } }],
  ["target 2 ATR", { exec: { tpAtrMult: 2 } }],
  ["entries until 13:00", { filter: { endCt: 780 } }],
  ["entries from 09:00", { filter: { startCt: 540 } }],
  ["5 lots", { exec: { contracts: 5 } }],
  ["3 lots", { exec: { contracts: 3 } }],
  ["breaker -$200", { exec: { dayBreakerUsd: 200 } }],
  ["profit block +$350", { exec: { dayProfitBlockUsd: 350 } }],
];

const MACD = [
  ["base", {}],
  ["RSI 14 against (long < 50)", { studies: [st("rsi", 0, { length: 14 }, "against")] }],
  ["RSI 14 with (long > 50)", { studies: [st("rsi", 0, { length: 14 }, "with")] }],
  ["RSI 7 fade 35/65", { studies: [st("rsi", 0, { length: 7, lo: 35, hi: 65 }, "fade")] }],
  ["RSI 14 no chase 70/30", { studies: [st("rsi", 0, { length: 14, lo: 30, hi: 70 }, "nochase")] }],
  ["ADX 1m >= 20", { studies: [st("adx", 0, { period: 14, lo: 20 }, "above")] }],
  ["ADX 1m <= 30", { studies: [st("adx", 0, { period: 14, hi: 30 }, "below")] }],
  ["ADX 5m >= 20", { studies: [st("adx", 5, { period: 14, lo: 20 }, "above")] }],
  ["+DI/-DI agree (5m)", { studies: [st("adx", 5, { period: 14 }, "with")] }],
  ["EMA 9/21 10m agrees", { studies: [st("emacross", 10, { fast: 9, slow: 21 }, "with")] }],
  ["EMA 9/21 10m against", { studies: [st("emacross", 10, { fast: 9, slow: 21 }, "against")] }],
  ["EMA 9/21 5m agrees", { studies: [st("emacross", 5, { fast: 9, slow: 21 }, "with")] }],
  ["EMA 50 1m agrees", { studies: [st("ema", 0, { length: 50 }, "with")] }],
  ["ADR used <= 0.5", { studies: [st("adrused", 0, { days: 10, hi: 0.5 }, "below")] }],
  ["ADR used <= 0.9", { studies: [st("adrused", 0, { days: 10, hi: 0.9 }, "below")] }],
  ["signals until 10:00", { params: { endCt: 600 } }],
  ["signals until 09:30", { params: { endCt: 570 } }],
  ["ATR ratio >= 0.8", { params: { minVolRatio: 0.8 } }],
  ["ATR ratio >= 1.2", { params: { minVolRatio: 1.2 } }],
  ["MACD 8/21/5", { params: { fast: 8, slow: 21, signal: 5 } }],
  ["MACD 5/35/5", { params: { fast: 5, slow: 35, signal: 5 } }],
  ["market entry", { exec: { entryType: "market" } }],
  ["stale exit 20 bars / 1 ATR", { exec: { staleBars: 20, staleMfeAtr: 1 } }],
  ["target 3 ATR", { exec: { tpAtrMult: 3 } }],
  ["target cap $400", { exec: { tpMaxUsd: 400 } }],
  ["stop 3 ATR", { exec: { slAtrMult: 3 } }],
  ["5 lots", { exec: { contracts: 5 } }],
  ["3 lots", { exec: { contracts: 3 } }],
  ["breaker -$300", { exec: { dayBreakerUsd: 300 } }],
  ["profit block +$350", { exec: { dayProfitBlockUsd: 350 } }],
];

async function screen(id, variants) {
  console.log(`\n${id} on the $1,250 eval, 2026 -- calendar (Jan-Mar / Apr-Jul) and bootstrap (Jan-Mar / Apr-Jul)`);
  const rows = [];
  let base = null;
  for (const [name, o] of variants) {
    const r = await E.evaluate(id, o);
    delete r.cfg;
    if (!base) base = r;
    const beats = name !== "base" && r.calA > base.calA && r.calB > base.calB && r.bootA > base.bootA && r.bootB > base.bootB;
    rows.push({ name, o, ...r, survives: beats });
    console.log(`  ${beats ? "*" : " "} ${name.padEnd(34)} ${E.fmt(r)}`);
  }
  return rows;
}

const out = {};
if (which !== "macd") out.donchian = await screen("donchian_1250", DONCHIAN);
if (which !== "donchian") out.macd = await screen("macd_fade_1250", MACD);
fs.writeFileSync(path.join(HERE, `combos_1250_stage1_${which}.json`), JSON.stringify(out, null, 1));
console.log("\n* beats the base in both halves by both methods");
