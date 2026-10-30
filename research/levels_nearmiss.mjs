// The gates that came closest in research/levels_gates.mjs. None beat its book in both
// halves by both methods, so none survives. These looked good enough on one measure
// that they deserve the rest of the protocol before being dropped: the coin-flip twin,
// entries dropped at random, and the forward bars.
//
//   node --max-old-space-size=8192 research/levels_nearmiss.mjs
//
// RESULT, $1,250 eval, forward Sep 11 - Oct 26, 16 windows:
//   donchian_1250        +$2,532, 100% of windows
//     squeeze 15m        2026 77.0% / 76.2%, forward +$2,389, 81%: no gain forward
//     chandelier 15m     2026 75.8% / 73.8%, forward +$1,914, 81%: no gain forward
//   macd_fade_1250       -$2,742, 19% of windows
//     inside dev value   2026 77.6% / 66.0%, forward -$1,873, 63%: still loses
//     inside prior day   2026 66.1% / 64.9%, forward -$435, 13%
//     Ichimoku 15m       2026 69.7% / 63.6%, forward +$3,055, 100%: alone among its
//                        neighbours, so selection (levels_followup.mjs)

import { fileURLToPath } from "node:url";
import * as E from "./lib_eval1250.mjs";
import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";
import { mulberry32 } from "../src/dayeval.mjs";

const FROM = Date.UTC(2026, 8, 11), DAY = 86400000, { bars } = loadBars(fileURLToPath(new URL("../data/topstepx_1m.bin", import.meta.url)));
const last = bars.ts[bars.count - 1], starts = [];
for (let s = bars.ts[0] + Math.ceil((FROM - bars.ts[0]) / DAY) * DAY; s + 30 * DAY <= last; s += DAY) starts.push(s);

function forward(cfg) {
  const t = runStrategy(bars, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies: cfg.studies, fromMs: FROM }).trades;
  let net = 0, wins = 0;
  for (const x of t) { net += x.pnl; if (x.pnl > 0) wins++; }
  const pass = starts.filter((s) => replayWindow(t, s, cfg.rules).outcome === OUTCOME.PASS).length;
  return { trades: t.length, net: Math.round(net), won: t.length ? Math.round((100 * wins) / t.length) : 0, cal: starts.length ? Math.round((1000 * pass) / starts.length) / 10 : 0 };
}
const fmtF = (f) => `${f.trades} trades, $${f.net}, ${f.won}% won, ${f.cal}% of ${starts.length} windows`;

const CASES = [
  ["donchian_1250", "squeeze 15m above (ratio over 0.8)", [{ type: "squeeze", tf: 15, params: { length: 20 }, gate: "above" }]],
  ["donchian_1250", "chandelier 15m with", [{ type: "chandelier", tf: 15, params: {}, gate: "with" }]],
  ["macd_fade_1250", "inside the developing RTH value area", [{ type: "vprofile", tf: 1, params: { anchor: "rth", mode: "developing" }, gate: "inside" }]],
  ["macd_fade_1250", "inside the prior day's range", [{ type: "daylevels", tf: 1, params: {}, gate: "inside" }]],
  ["macd_fade_1250", "ichimoku 15m with", [{ type: "ichimoku", tf: 15, params: {}, gate: "with" }]],
];
for (const id of ["donchian_1250", "macd_fade_1250"]) {
  const base = await E.evaluate(id), bf = forward(base.cfg);
  console.log(`\n${id}, $1,250 eval\n  book    ${E.fmt(base)}\n          forward ${fmtF(bf)}`);
  const full = E.trades2026(base.cfg);
  for (const [book, name, studies] of CASES) {
    if (book !== id) continue;
    const r = await E.evaluate(id, { studies });
    const keep = Math.min(1, r.trades / full.length), cal = [];
    for (let s = 0; s < 40; s++) { const rnd = mulberry32(9000 + s); cal.push(E.score(full.filter(() => rnd() < keep), r.cfg.rules).cal); }
    const n = E.nullScore(r.cfg, r, 12), f = forward(r.cfg);
    console.log(`  ${name}\n    2026    ${E.fmt(r)}\n    random drops of that size average ${(cal.reduce((a, x) => a + x, 0) / cal.length).toFixed(1)}%, ${cal.filter((x) => x >= r.cal).length} of 40 reach it\n    coin-flip twin ${n.cal}%, best of ${n.seeds} seeds ${n.best}\n    forward ${fmtF(f)}`);
  }
}
