// The $1,250 books FORWARD: TopstepX bars after the lab's data ends.
//
//   node --max-old-space-size=8192 research/forward_1250.mjs [data/topstepx_1m.bin]
//
// data/topstepx_1m.bin holds the bars the bot trades, as saved on Oct 27 (a copy is in
// data/raw/topstepx, and new bars go through the store),
// from 2026-08-23. Everything before 2026-09-10 is warm-up (13 sessions, so the
// 10-session ADR and ATR averages are whole); trades and windows start there. No
// configuration here was chosen on these days: research/combos_1250_new.mjs chose
// them on the lab's 2026 data, which ends 2026-07-14.
//
// The sample is small -- about 33 trading days, so a dozen 21-day windows that
// overlap almost entirely -- and can only catch a gross failure: a book losing
// steadily, or doing no better than its coin-flip twin. Per-trade figures carry
// more information here than the pass rates.
//
// RESULT, everything after the lab's data (FORWARD_FROM=2026-07-15, data/mnq_1m_beta.bin; 77
// trading days, 77 calendar windows, about 2.6 independent; run 2026-11-02):
//   donchian_1250   70 tr  +$2,584  PF 1.24  cal 44.2%  boot 40.4% | twin cal 44.9%, 8/20 twins net as much
//                   Jul 15 - Sep 9 -$15 (43 tr; Aug -$1,163), Sep 10 on +$2,599 (27 tr)
//   macd_fade_1250 113 tr  -$1,377  PF 0.94  cal 41.6%  boot 33.8% | twin cal 30.3%, 4/20
//   trend_pullback  99 tr  -$2,376  PF 0.88  cal 31.2%             | twin 29.8%, 15/20
//   orb_trend       49 tr  -$1,588  PF 0.87  cal 32.5%             | twin 35.7%, 17/20
//   macd_momentum   55 tr  +$1,178  PF 1.08  cal 62.3%             | twin 34.2%, 7/20
// The Donchian's Sep - Oct run was its best stretch; over the whole forward it passes as often as
// a coin flip with its timing. From Sep 10 the beta file gives it 27 trades and +$2,599, against
// the published 23 and +$2,532 here: four more days of bars, and the one build's roll date.

import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import * as L from "../mcp/lab.mjs";
import { nullCfg, forwardScorer } from "./lib_eval1250.mjs";

const FILE = process.argv[2] || "data/topstepx_1m.bin";
// FORWARD_FROM=2026-07-15 with data/mnq_1m_beta.bin scores everything after the lab's data ends:
// Databento to Sep 11, TopstepX after, no gap since the Jul 15 - Aug 27 file arrived.
const FROM = process.env.FORWARD_FROM ? Date.parse(`${process.env.FORWARD_FROM}T00:00:00Z`) : Date.UTC(2026, 8, 10);
const { bars } = loadBars(FILE);
const last = bars.ts[bars.count - 1];
console.log(`${FILE}: ${new Date(bars.ts[0]).toISOString().slice(0, 10)} to ${new Date(last).toISOString().slice(0, 10)}; scored from ${new Date(FROM).toISOString().slice(0, 10)}`);

const F = forwardScorer(bars, FROM), { days, starts } = F;
const score = (cfg) => F.score(runStrategy(bars, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies: cfg.studies, fromMs: FROM }).trades, cfg.rules);
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
