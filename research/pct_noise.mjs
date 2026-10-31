// The noise-area breakout lost the eval but made money on every forward setting. Why?
//
//   node --max-old-space-size=8192 research/pct_noise.mjs
//
// RESULT (2 lots, 1x, every 30 minutes, costs in): not an eval book, but the one thing here
// with a forward signal. 2026: +$1,467, PF 1.07, -$4,614 without its 3 best days, months from
// -$4,063 to +$4,387, and 63 of 200 coin flips reach it. Forward, Sep 11 - Oct 30: +$5,114, PF
// 3.09, and 2 of 200 coin flips reach it. Its losing runs reached $4,455 in 2026 against
// a $1,000 eval drawdown, which is why it passes 30.9% ($1,250, calendar, ci 8-69). Worth
// re-reading on the Jul 15 - Aug 27 bars, which nothing has seen.
//
// A book that passes 30% of windows and then makes money on all 36 settings forward needs
// taking apart before it means anything. The 36 settings are the same few trades, so they
// are one result, not 36. So: month by month, the handful of days that carry it, what a
// coin flip does with the same timing, and why profit did not turn into passes.
//
// Writes research/pct_noise_results.json.

import fs from "node:fs";
import * as E from "./lib_eval1250.mjs";
import * as P from "./lib_pct.mjs";
import { runStrategy } from "../src/run.mjs";
import { loadBars } from "../src/data.mjs";
import { sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";

const DAY = 86400000, L = E.lab, cfg = await E.configOf("noise_area", { exec: { contracts: 2 } }, "1250"), R = cfg.rules;
const all = L.bars(), slice = sliceBars(all, indexAtOrAfter(all.ts, E.Y26 - 60 * DAY), all.count), fwdBars = loadBars(P.FWD_FILE).bars, FROM = P.FWD_FROM;
const run = (bars, fromMs, c = cfg) => runStrategy(bars, c.s, c.params, c.exec, { filter: c.filter, studies: c.studies, fromMs }).trades;
const t26 = run(slice, E.Y26), tF = run(fwdBars, FROM);
const net = (a) => a.reduce((s, t) => s + t.pnl, 0);
const pf = (a) => { let g = 0, l = 0; for (const t of a) { if (t.pnl > 0) g += t.pnl; else l -= t.pnl; } return l ? g / l : null; };

console.log(`noise_area, 2 lots, 1x, every 30 minutes, costs in.`);
const months = {};
for (const t of t26.concat(tF)) { const k = new Date(t.entryTime).toISOString().slice(0, 7); (months[k] ||= []).push(t); }
console.log(`\nMONTH BY MONTH`);
const mrows = [];
for (const [k, a] of Object.entries(months).sort()) { mrows.push({ month: k, trades: a.length, net: Math.round(net(a)), pf: pf(a) }); console.log(`  ${k}  ${String(a.length).padStart(3)} tr  $${String(Math.round(net(a))).padStart(6)}  PF ${pf(a)?.toFixed(2)}  won ${Math.round((100 * a.filter((t) => t.pnl > 0).length) / a.length)}%`); }

const byDay = (a) => { const d = {}; for (const t of a) { const k = new Date(t.entryTime).toISOString().slice(0, 10); d[k] = (d[k] || 0) + t.pnl; } return Object.entries(d).sort((x, y) => y[1] - x[1]); };
for (const [name, a] of [["2026", t26], ["forward", tF]]) {
  const d = byDay(a), top = d.slice(0, 3), total = net(a);
  console.log(`\n${name}: $${Math.round(total)} over ${d.length} trading days, ${a.length} trades, PF ${pf(a)?.toFixed(2)}. Best days: ${top.map(([k, v]) => `${k} $${Math.round(v)}`).join(", ")}. Without the best 3: $${Math.round(total - top.reduce((s, x) => s + x[1], 0))}.`);
}

// the same timing with a coin for the direction
const coin = (bars, fromMs, n) => { const v = []; for (let k = 1; k <= n; k++) v.push(net(run(bars, fromMs, E.nullCfg(cfg, k)))); return v.sort((a, b) => a - b); };
const c26 = coin(slice, E.Y26, 200), cF = coin(fwdBars, FROM, 200), rank = (v, x) => v.filter((y) => y >= x).length;
console.log(`\nCOIN-FLIP TWIN, 200 seeds. 2026: real $${Math.round(net(t26))}, coin mean $${Math.round(P.mean(c26))}, ${rank(c26, net(t26))} of 200 reach it. Forward: real $${Math.round(net(tF))}, coin mean $${Math.round(P.mean(cF))}, ${rank(cF, net(tF))} of 200 reach it.`);

// why profit did not become passes
const last = fwdBars.ts[fwdBars.count - 1], starts = [];
for (let s = fwdBars.ts[0] + Math.ceil((FROM - fwdBars.ts[0]) / DAY) * DAY; s + 30 * DAY <= last; s += DAY) starts.push(s);
const tally = {};
for (const s of starts) { const r = replayWindow(tF, s, R); const k = r.outcome === OUTCOME.PASS ? "pass" : r.outcome === OUTCOME.FAIL ? `fail: ${r.reason || "rule"}` : "open"; tally[k] = (tally[k] || 0) + 1; }
console.log(`\nFORWARD WINDOWS: ${JSON.stringify(tally)} of ${starts.length}.`);
const dd = (a) => { let eq = 0, hi = 0, worst = 0; for (const t of a) { eq += t.pnl; if (eq > hi) hi = eq; if (hi - eq > worst) worst = hi - eq; } return worst; };
console.log(`Largest run of losses, trade by trade: 2026 $${Math.round(dd(t26))}, forward $${Math.round(dd(tF))}. The eval's drawdown is $${R.trailingDD}.`);
fs.writeFileSync(new URL("./pct_noise_results.json", import.meta.url), JSON.stringify({ months: mrows, net26: net(t26), netFwd: net(tF), pf26: pf(t26), pfFwd: pf(tF), coin26: P.mean(c26), coinFwd: P.mean(cF), coinAt26: rank(c26, net(t26)), coinAtFwd: rank(cF, net(tF)), tally, dd26: dd(t26), ddFwd: dd(tF), best26: byDay(t26).slice(0, 3), bestFwd: byDay(tF).slice(0, 3) }));
