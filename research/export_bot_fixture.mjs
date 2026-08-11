// Export a golden fixture so the Python live bot can be PROVEN identical to the
// engine that produced the 42.6% headline, rather than assumed to be.
//
// The bot reimplements, in another language, every step of the pipeline:
// clock-aligned 2-minute aggregation, EMA-based ATR/ADX, Kaufman efficiency,
// Donchian excluding the current bar, the session gate, and the bracket
// executor. Any one of those drifting silently turns the live book into a
// different strategy that merely looks like this one. So this dumps the RAW
// 1-minute input alongside every intermediate the bot must reproduce.
//
// Usage:  node research/export_bot_fixture.mjs [days]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveParams } from "../src/run.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { adx, atr, donchian, efficiencyRatio } from "../src/indicators.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "bot", "fixture_donchian.json");

const DAYS = Number(process.argv[2]) || 25;

const { bars } = loadBars();
const strategies = await loadStrategies();
const strat = strategies.get("donchian_eff_rth");
const params = resolveParams(strat, {});
const exec = resolveExec(strat.execDefaults);
const filter = { ...NO_FILTER, ...strat.filterDefaults };

// Take the tail of history: the most recent data is the most representative of
// what the bot will actually meet, and it is the part the operator can eyeball
// against their own platform.
const endMs = bars.ts[bars.count - 1];
const startMs = endMs - DAYS * 86400000;
let lo = 0;
while (lo < bars.count && bars.ts[lo] < startMs) lo++;

// The slice is fed to the bot as if it were an API response, so it must carry
// its own warm-up. Everything before `evalFromMs` exists only to converge the
// EMAs; assertions are made after it.
const slice1m = {
  ts: bars.ts.subarray(lo, bars.count),
  open: bars.open.subarray(lo, bars.count),
  high: bars.high.subarray(lo, bars.count),
  low: bars.low.subarray(lo, bars.count),
  close: bars.close.subarray(lo, bars.count),
  volume: bars.volume.subarray(lo, bars.count),
  tday: bars.tday.subarray(lo, bars.count),
  ctMin: bars.ctMin.subarray(lo, bars.count),
  count: bars.count - lo,
};

const tf = resample(slice1m, strat.timeframeMin);
const out = strat.compute(tf, params);
const ctx = buildFilterContext(tf);
const masked = applyFilters(out.sig, ctx, filter);
const { trades } = runBrackets(tf, masked, out.atr, exec);

// Recompute the raw indicators separately: the bot is checked stage by stage,
// so a mismatch points at ONE stage instead of "the trades differ".
const { adx: adxArr } = adx(tf.high, tf.low, tf.close, params.adxPeriod);
const { high: dh, low: dl } = donchian(tf.high, tf.low, params.period);
const atrArr = atr(tf.high, tf.low, tf.close, params.atrPeriod);
const effArr = efficiencyRatio(tf.close, 20);

const r6 = (v) => (Number.isFinite(v) ? Number(v.toFixed(6)) : null);

const fixture = {
  generated: new Date().toISOString(),
  note: "Golden output of mnq_chart_lab's engine for strategy donchian_eff_rth. " +
        "bot/test_donchian_parity.py asserts the Python bot reproduces every field.",
  strategy: strat.id,
  params,
  exec,
  filter,
  rules: { ...strat.rulesDefaults },
  timeframeMin: strat.timeframeMin,

  // RAW INPUT — 1-minute bars, exactly the shape the ProjectX history endpoint
  // returns once parsed. The bot must do its own 2-minute aggregation from these.
  bars1m: Array.from({ length: slice1m.count }, (_, i) => [
    slice1m.ts[i],
    r6(slice1m.open[i]), r6(slice1m.high[i]), r6(slice1m.low[i]), r6(slice1m.close[i]),
  ]),

  // EXPECTED 2-minute aggregation + every indicator the signal depends on.
  bars2m: Array.from({ length: tf.close.length }, (_, i) => [
    tf.ts[i],
    r6(tf.open[i]), r6(tf.high[i]), r6(tf.low[i]), r6(tf.close[i]),
    tf.ctMin[i], tf.tday[i],
  ]),
  indicators: {
    atr: Array.from(atrArr, r6),
    adx: Array.from(adxArr, r6),
    eff: Array.from(effArr, r6),
    donHigh: Array.from(dh, r6),
    donLow: Array.from(dl, r6),
  },
  sigRaw: Array.from(out.sig),
  sigMasked: Array.from(masked),

  trades: trades.map((t) => ({
    entryTime: t.entryTime, exitTime: t.exitTime,
    dir: t.dir, contracts: t.contracts,
    entryPrice: r6(t.entryPrice), exitPrice: r6(t.exitPrice),
    stop: r6(t.stop), target: r6(t.target),
    pnl: r6(t.pnl), gross: r6(t.gross), fees: r6(t.fees),
    tday: t.tday, reason: t.reason,
  })),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture));

const nSig = fixture.sigMasked.filter((s) => s !== 0).length;
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
console.log(`  ${fixture.bars1m.length.toLocaleString()} 1-min bars -> ${fixture.bars2m.length.toLocaleString()} 2-min bars`);
console.log(`  ${new Date(slice1m.ts[0]).toISOString()} -> ${new Date(endMs).toISOString()}`);
console.log(`  ${fixture.sigRaw.filter((s) => s !== 0).length} raw signals, ${nSig} surviving the gate`);
console.log(`  ${fixture.trades.length} trades, net $${fixture.trades.reduce((a, t) => a + t.pnl, 0).toFixed(2)}`);
console.log(`  ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB`);
