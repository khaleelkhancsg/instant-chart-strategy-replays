// The last checks on what came closest.
//
//   node --max-old-space-size=8192 research/levels_followup.mjs
//
// RESULT, 2026 then forward:
//   Round 25 at R 12%        +3.4 then +4.4, about $6 a touch a contract; only 2 of 45
//                            definitions clear zero, so not a tradeable effect
//   Opening range edges      -6.0 then +2.9
//   Round 100 at R 5%        -5.2 then -3.7, CI through zero
//   Monday's range at R 12%  +9.5 then -19.3
//   MACD fade + Ichimoku 15m made +$3,055 forward, but at 10m it is -$1,090, at 30m -$533,
//   at 6/18/36 -$1,489, and its cousins sit around zero. One setting alone: selection.
// 1. The pools nearest the bar (q under 0.2 after the placebo calibration) on the forward
//    bars, with what a touch earns: the fade, and the same touch traded with the break.
// 2. The one gate that looked different forward: the MACD fade with the 15-minute
//    Ichimoku. It failed the 2026 bar and was only looked at because it nearly passed, so
//    it is suspect. If a trend filter is really doing the work, its neighbours and its
//    cousins will show the same thing. If one setting stands alone, it is selection.

import { fileURLToPath } from "node:url";
import * as E from "./lib_eval1250.mjs";
import * as Lab from "./lib_levels.mjs";
import { buildCatalog, POOLS } from "./levels_catalog.mjs";
import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";

const FILE = fileURLToPath(new URL("../data/topstepx_1m.bin", import.meta.url));
const real = Lab.loadSample({ to: Date.UTC(2026, 6, 15) }), fwd = Lab.loadSample({ file: FILE, from: Date.UTC(2026, 8, 11), warmDays: 20 });
const D = real.days.length, FD = fwd.days.length, boot = Lab.bootDays(D, 1000), fboot = Lab.bootDays(FD, 1000);
const cat = buildCatalog(real), fcat = buildCatalog(fwd), idx = new Map(cat.map((c, i) => [c.tag, i])), fidx = new Map(fcat.map((c, i) => [c.tag, i]));
const f = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;

console.log(`POOLS NEAREST THE BAR. Net points a touch, after 1 point of cost, bracket of R either way.`);
for (const [name, rFrac] of [["Round 25", 0.12], ["Opening range edges", 0.05], ["Round 100", 0.05], ["BREAK claim: round 100/500", 0.05], ["Monday's range", 0.12]]) {
  const tags = POOLS[name] || [name];
  const evA = Lab.runLevels(real, cat, { rFrac, twins: 8 }), idsA = Lab.byTag(evA, cat.length), a = Int32Array.from(tags.flatMap((k) => [...idsA[idx.get(k)]]));
  const evB = Lab.runLevels(fwd, fcat, { rFrac, twins: 8 }), idsB = Lab.byTag(evB, fcat.length), b = Int32Array.from(tags.flatMap((k) => [...idsB[fidx.get(k)]]));
  const ma = Lab.matchedEdgeOf(evA, a, D, boot, 1000), mb = Lab.matchedEdgeOf(evB, b, FD, fboot, 1000), pa = Lab.edgeOf(evA, a, D, boot, 300), pb = Lab.edgeOf(evB, b, FD, fboot, 300);
  console.log(`\n${name}, R ${rFrac * 100}%`);
  console.log(`  2026     edge ${f(ma.edge)} [${f(ma.lo)}, ${f(ma.hi)}] n${ma.n}   fade ${f(pa.evReal)} vs twins ${f(pa.evTwin)}   break ${f(pa.boReal)} vs twins ${f(pa.boTwin)}`);
  console.log(`  forward  edge ${f(mb.edge)} [${f(mb.lo)}, ${f(mb.hi)}] n${mb.n}   fade ${f(pb.evReal)} vs twins ${f(pb.evTwin)}   break ${f(pb.boReal)} vs twins ${f(pb.boTwin)}`);
}

// ── the forward bars, for a book ──
const FROM = Date.UTC(2026, 8, 11), DAY = 86400000, { bars } = loadBars(FILE), last = bars.ts[bars.count - 1], starts = [];
for (let s = bars.ts[0] + Math.ceil((FROM - bars.ts[0]) / DAY) * DAY; s + 30 * DAY <= last; s += DAY) starts.push(s);
function forward(cfg) {
  const t = runStrategy(bars, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies: cfg.studies, fromMs: FROM }).trades;
  let net = 0; for (const x of t) net += x.pnl;
  return { trades: t.length, net: Math.round(net), cal: Math.round((1000 * starts.filter((s) => replayWindow(t, s, cfg.rules).outcome === OUTCOME.PASS).length) / starts.length) / 10 };
}
const st = (type, tf, params = {}, gate = "with") => [{ type, tf, params, gate }];
const CASES = [
  ["the book, no filter", []],
  ["Ichimoku 15m (the find)", st("ichimoku", 15)],
  ["Ichimoku 10m", st("ichimoku", 10)], ["Ichimoku 5m", st("ichimoku", 5)], ["Ichimoku 30m", st("ichimoku", 30)], ["Ichimoku 60m", st("ichimoku", 60)],
  ["Ichimoku 15m, 7/22/44", st("ichimoku", 15, { conv: 7, base: 22, span: 44 })], ["Ichimoku 15m, 12/30/60", st("ichimoku", 15, { conv: 12, base: 30, span: 60 })], ["Ichimoku 15m, 6/18/36", st("ichimoku", 15, { conv: 6, base: 18, span: 36 })],
  ["EMA 9/21 15m", st("emacross", 15, { fast: 9, slow: 21 })], ["EMA 20/50 15m", st("emacross", 15, { fast: 20, slow: 50 })], ["EMA 9/21 30m", st("emacross", 30, { fast: 9, slow: 21 })],
  ["EMA 50 15m", st("ema", 15, { length: 50 })], ["EMA 100 15m", st("ema", 15, { length: 100 })], ["SMA 50 15m", st("sma", 15, { length: 50 })],
  ["Supertrend 15m", st("supertrend", 15)], ["KAMA 15m", st("kama", 15, { length: 10 })], ["Hull 15m", st("hma", 15, { length: 20 })], ["Chandelier 15m", st("chandelier", 15)], ["Donchian mid 15m", st("donchian", 15, { length: 52 })],
];
console.log(`\n\nMACD FADE WITH A TREND FILTER, $1,250 eval, 2026 then forward (Sep 11 - Oct 26, ${starts.length} calendar windows).`);
console.log(`${"filter".padEnd(26)} 2026                                                        forward`);
for (const [name, studies] of CASES) {
  const r = await E.evaluate("macd_fade_1250", { studies }), w = forward(r.cfg);
  console.log(`${name.padEnd(26)} cal ${String(r.cal).padStart(5)} (${String(r.calA).padStart(5)} /${String(r.calB).padStart(5)})  boot ${String(r.boot).padStart(5)} (${String(r.bootA).padStart(5)} /${String(r.bootB).padStart(5)})  ${String(r.trades).padStart(3)} tr  $${String(r.perTrade).padStart(4)}   ${String(w.trades).padStart(3)} tr  $${String(w.net).padStart(6)}  ${w.cal}%`);
}
