// The $1,250 books FORWARD: TopstepX bars after the lab's data ends.
//
//   node --max-old-space-size=8192 research/forward_1250.mjs [data/topstepx_1m.bin]
//
// data/topstepx_1m.bin (bot/export_topstepx_bin.py) holds the bars the bot trades,
// from 2026-08-23. Everything before 2026-09-10 is warm-up (13 sessions, so the
// 10-session ADR and ATR averages are whole); trades and windows start there. No
// configuration here was chosen on these days: research/combos_1250_new.mjs chose
// them on the lab's 2026 data, which ends 2026-07-14.
//
// The sample is small -- about 33 trading days, so a dozen 21-day windows that
// overlap almost entirely -- and can only catch a gross failure: a book losing
// steadily, or doing no better than its coin-flip twin. Per-trade figures carry
// more information here than the pass rates.

import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";
import { dayVector, bootstrapPass, consecutiveSampler, passRate } from "../src/dayeval.mjs";
import * as L from "../mcp/lab.mjs";
import { nullCfg } from "./lib_eval1250.mjs";

const FILE = process.argv[2] || "data/topstepx_1m.bin";
const FROM = Date.UTC(2026, 8, 10), DAY = 86400000;
const { bars } = loadBars(FILE);
const last = bars.ts[bars.count - 1];
console.log(`${FILE}: ${new Date(bars.ts[0]).toISOString().slice(0, 10)} to ${new Date(last).toISOString().slice(0, 10)}; scored from ${new Date(FROM).toISOString().slice(0, 10)}`);

const days = [];
for (let i = 0; i < bars.count; i++) if ((i === 0 || bars.tday[i] !== bars.tday[i - 1]) && bars.ts[i] >= FROM) days.push(bars.tday[i]);
const starts = [];
for (let s = bars.ts[0] + Math.ceil((FROM - bars.ts[0]) / DAY) * DAY; s + 30 * DAY <= last; s += DAY) starts.push(s);

function score(cfg) {
  const trades = runStrategy(bars, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies: cfg.studies, fromMs: FROM }).trades;
  const R = cfg.rules, rules = { target: R.profitTarget, dd: R.trailingDD, consistency: R.consistencyGatesPass ? R.consistencyPct / 100 : 0 };
  const vec = dayVector(trades, days), sub = Int32Array.from(vec, (_, k) => k);
  let net = 0, wins = 0, gw = 0, gl = 0;
  for (const t of trades) { net += t.pnl; if (t.pnl > 0) { wins++; gw += t.pnl; } else gl -= t.pnl; }
  const cal = starts.filter((s) => replayWindow(trades, s, R).outcome === OUTCOME.PASS).length;
  return {
    trades: trades.length, net: Math.round(net), winRate: trades.length ? Math.round((1000 * wins) / trades.length) / 10 : 0,
    pf: gl > 0 ? Math.round((gw / gl) * 100) / 100 : null, perTrade: trades.length ? Math.round(net / trades.length) : 0,
    cal: Math.round((1000 * cal) / starts.length) / 10, real: Math.round(passRate(vec, sub, consecutiveSampler(days.length, 21), rules) * 10) / 10,
    boot: Math.round(bootstrapPass(vec, { window: 21, ...rules }) * 10) / 10,
    downDays: vec.filter((v) => v <= -590).length,
  };
}
const fmt = (r) => `${String(r.trades).padStart(3)} tr  net ${String(r.net).padStart(6)}  ${r.winRate}% won  PF ${r.pf}  $${r.perTrade}/tr  | cal ${r.cal}%  real ${r.real}%  boot ${r.boot}%  | days at the -$600 line ${r.downDays}`;

const BOOKS = [
  ["donchian_1250 (shipped)", "donchian_1250", {}],
  ["macd_fade_1250 (shipped)", "macd_fade_1250", {}],
  ["trend_pullback (chosen)", "trend_pullback", { params: { trigger: "rsiDip", trendTf: 5, trendFast: 9, trendSlow: 21, adxMin: 20, maxAdrUsed: 0.9, minVolRatio: 1, exitOn: "macdCross", timeframeMin: 1 },
                                                  exec: { slAtrMult: 5, tpMode: "atr", tpAtrMult: 5.15, tpMaxUsd: 600, entryType: "market" } }],
  ["  neighbour: no ADR cap", "trend_pullback", { params: { trigger: "rsiDip", trendTf: 5, adxMin: 20, maxAdrUsed: 0, minVolRatio: 1, exitOn: "macdCross", timeframeMin: 1 },
                                                  exec: { slAtrMult: 5, tpAtrMult: 5.15, tpMaxUsd: 600, entryType: "market" } }],
  ["  neighbour: 30m trend", "trend_pullback", { params: { trigger: "rsiDip", trendTf: 30, adxMin: 20, maxAdrUsed: 0.9, minVolRatio: 1, exitOn: "macdCross", timeframeMin: 1 },
                                                 exec: { slAtrMult: 5, tpAtrMult: 5.15, tpMaxUsd: 600, entryType: "market" } }],
  ["orb_trend (chosen)", "orb_trend", { params: { unit: "atr", orMinutes: 5, entryEndCt: 720, trendMode: "with", trendTf: 30, maxOrAdr: 0, adxMin: 20, once: "perSide", timeframeMin: 1 },
                                        exec: { slAtrMult: 5, tpMode: "atr", tpAtrMult: 1.75 } }],
  ["macd_momentum (chosen)", "macd_momentum", { params: { timeframeMin: 5, buildBars: 2, fadeBars: 0, trendTf: 30, adxMin: 0, maxAdrUsed: 0.9 },
                                                exec: { slAtrMult: 3, tpMode: "atr", tpAtrMult: 2, entryType: "market" } }],
];

console.log(`${days.length} trading days, ${starts.length} calendar windows, ${Math.max(0, days.length - 20)} consecutive 21-day windows\n`);
for (const [label, id, o] of BOOKS) {
  const cfg = await L.resolveConfig({ strategy: id, eval: "1250", ...o });
  const real = score(cfg);
  const nulls = Array.from({ length: 20 }, (_, k) => score(nullCfg(cfg, k + 1)));
  const m = (f) => Math.round((nulls.reduce((s, r) => s + f(r), 0) / nulls.length) * 10) / 10;
  console.log(`${label.padEnd(26)} ${fmt(real)}`);
  console.log(`${"".padEnd(26)} coin-flip twin, 20 seeds: net ${m((r) => r.net)}  cal ${m((r) => r.cal)}%  real ${m((r) => r.real)}%  boot ${m((r) => r.boot)}%` +
              `  | seeds netting at least the book: ${nulls.filter((r) => r.net >= real.net).length}/20`);
}
