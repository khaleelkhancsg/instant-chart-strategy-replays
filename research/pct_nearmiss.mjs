// The one percentage gate that came close on donchian_1250: no entries within +-x% of
// settlement. It tied Jan-Mar and won the rest, so it fails the bar, and it is one of 215
// tried. Before believing or dropping it: its neighbours, the same number of entries
// dropped at random, the trades it removes, and the forward bars.
//
//   node --max-old-space-size=8192 research/pct_nearmiss.mjs
//
// RESULT: a cliff, not an effect. Calendar 2026, $1,250 eval: 80.6% at +-0.05%, 78.8% at
// 0.1-0.2%, 77.0% at 0.22-0.24%, 84.8-85.5% at 0.25-0.28%, then 70.9% at 0.30%, 66.7% at 0.35%,
// 64.8% at 0.50% and 37.6% at 0.75%. The base is 74.5%. Up to 0.26-0.28% it changes one trade
// forward, so the forward bars cannot speak for it, and wider ones lose forward money (0.50%:
// +$357, 0.75%: -$295, base +$2,599). A few trades are flipping windows. Rejected.
//
// Writes research/pct_nearmiss_results.json.

import fs from "node:fs";
import * as E from "./lib_eval1250.mjs";
import * as P from "./lib_pct.mjs";
import { mulberry32 } from "../src/dayeval.mjs";
import { runStrategy } from "../src/run.mjs";
import { loadBars } from "../src/data.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";

const DAY = 86400000, base = await E.evaluate("donchian_1250"), { cfg } = base, R = cfg.rules;
const fwdBars = loadBars(P.FWD_FILE).bars, FROM = P.FWD_FROM, last = fwdBars.ts[fwdBars.count - 1], starts = [];
for (let s = fwdBars.ts[0] + Math.ceil((FROM - fwdBars.ts[0]) / DAY) * DAY; s + 30 * DAY <= last; s += DAY) starts.push(s);
const full = E.trades2026(cfg), resolved = async (studies) => (await E.lab.resolveConfig({ strategy: cfg.s.id, eval: "1250", studies })).studies;
const forward = (studies) => {
  const t = runStrategy(fwdBars, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies, fromMs: FROM }).trades;
  let net = 0; for (const x of t) net += x.pnl;
  return { trades: t.length, net: Math.round(net), cal: Math.round((1000 * starts.filter((s) => replayWindow(t, s, R).outcome === OUTCOME.PASS).length) / starts.length) / 10 };
};
const rows = [];
console.log(`donchian_1250, $1,250 eval. Base ${E.fmt(base)}`);
console.log(`\nNEIGHBOURS: no entries within +-x% of settlement`);
for (const x of [0.05, 0.1, 0.15, 0.2, 0.22, 0.24, 0.25, 0.26, 0.28, 0.3, 0.35, 0.4, 0.5, 0.75]) {
  const studies = await resolved([{ type: "pctmove", tf: 1, params: { anchor: "settle", lo: -x, hi: x }, gate: "outside" }]), r = E.score(E.trades2026({ ...cfg, studies }), R), f = forward(studies);
  const keep = r.trades / full.length, cal = [];
  for (let s = 0; s < 200; s++) { const rnd = mulberry32(9000 + s); cal.push(E.score(full.filter(() => rnd() < keep), R).cal); }
  const at = cal.filter((c) => c >= r.cal).length;
  rows.push({ x, ...r, randomMean: P.mean(cal), randomAtLeast: at, fwd: f });
  console.log(`  ${x.toFixed(2).padStart(5)}%  ${E.fmt(r)}  random drops ${P.mean(cal).toFixed(1)}, ${at} of 200 reach it  forward ${f.trades} tr $${f.net} ${f.cal}%`);
}
// which trades the 0.25% gate removes, and why the calendar moved
const s25 = await resolved([{ type: "pctmove", tf: 1, params: { anchor: "settle", lo: -0.25, hi: 0.25 }, gate: "outside" }]), kept = E.trades2026({ ...cfg, studies: s25 }), keys = new Set(kept.map((t) => t.entryTime));
const gone = full.filter((t) => !keys.has(t.entryTime)), added = kept.filter((t) => !new Set(full.map((x) => x.entryTime)).has(t.entryTime));
const sum = (a) => a.reduce((s, t) => s + t.pnl, 0);
console.log(`\nThe 0.25% gate removes ${gone.length} trades worth $${Math.round(sum(gone))} and adds ${added.length} worth $${Math.round(sum(added))}.`);
for (const t of gone) console.log(`  out ${new Date(t.entryTime).toISOString().slice(0, 16)}  ${t.dir === 1 ? "long " : "short"}  $${Math.round(t.pnl)}`);
for (const t of added) console.log(`  in  ${new Date(t.entryTime).toISOString().slice(0, 16)}  ${t.dir === 1 ? "long " : "short"}  $${Math.round(t.pnl)}`);
fs.writeFileSync(new URL("./pct_nearmiss_results.json", import.meta.url), JSON.stringify({ base: { ...base, cfg: undefined }, rows, gone: gone.map((t) => [t.entryTime, t.pnl]), added: added.map((t) => [t.entryTime, t.pnl]) }));
