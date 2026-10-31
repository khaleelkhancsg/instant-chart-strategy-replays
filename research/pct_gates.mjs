// Can a percentage improve the two $1,250 books, as a gate?
//
//   node --max-old-space-size=8192 research/pct_gates.mjs
//
// RESULT ($1,250 eval): 215 gates on each book. None beats donchian_1250 in both halves by both
// methods. One beats macd_fade_1250: within 0.75 ADR of settlement, calendar 63.6% against
// 55.8%, but 7 of 40 random drops of the same size reach it, and it still loses forward
// (-$1,096 against -$2,560). One of 430 is about what chance gives. The nearest on the
// Donchian is taken apart in research/pct_nearmiss.mjs.
//
// Each gate is a study from src/studies.mjs, so it is exactly what the chart's Indicators tab
// applies: read from closed bars, refusing entries only. The bar is levels_gates.mjs's: beat
// the book in both halves by both methods. Then, for anything that does, the same number of
// entries dropped at random, the coin-flip twin, and the forward bars.
//
// Writes research/pct_gates_results.json.

import fs from "node:fs";
import * as E from "./lib_eval1250.mjs";
import * as P from "./lib_pct.mjs";
import { mulberry32 } from "../src/dayeval.mjs";
import { runStrategy } from "../src/run.mjs";
import { loadBars } from "../src/data.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";

const t0 = Date.now(), RANDOM_DROPS = 40, DAY = 86400000;
const st = (type, params, gate) => ({ type, tf: 1, params, gate });
const SCREEN = [];
const add = (type, params, gates) => { for (const g of gates) SCREEN.push([`${type} ${JSON.stringify(params).replace(/[{}"]/g, "")} ${g}`, [st(type, params, g)]]); };
const DIST = ["inside", "nochase", "outside", "beyond", "fade"];
for (const anchor of ["settle", "rth"]) {
  add("pctmove", { anchor, lo: -0.5, hi: 0.5 }, ["with", "against"]);
  for (const x of [0.25, 0.5, 0.75, 1, 1.5, 2]) add("pctmove", { anchor, lo: -x, hi: x }, DIST);
  for (const step of [0.25, 0.5, 0.75, 1, 1.25, 1.5]) add("pctladder", { anchor, unit: "adr", step, rungs: 1 }, DIST);
}
for (const [lo, hi] of [[5, 95], [10, 90], [20, 80], [30, 70]]) add("moverank", { lo, hi }, ["with", "against", ...DIST]);
for (const q of [0.5, 0.75, 0.9]) { add("movefan", { q }, DIST); add("reachband", { q }, DIST); }
for (const mult of [1, 1.5, 2]) add("noisearea", { mult }, ["with", ...DIST]);
for (const miss of [0.5, 0.25, 0.1]) add("conformal", { miss }, DIST);

const fwdBars = loadBars(P.FWD_FILE).bars, FROM = P.FWD_FROM, last = fwdBars.ts[fwdBars.count - 1], starts = [];
for (let s = fwdBars.ts[0] + Math.ceil((FROM - fwdBars.ts[0]) / DAY) * DAY; s + 30 * DAY <= last; s += DAY) starts.push(s);
function forward(cfg, studies) {
  const t = runStrategy(fwdBars, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies, fromMs: FROM }).trades;
  let net = 0; for (const x of t) net += x.pnl;
  return { trades: t.length, net: Math.round(net), cal: starts.length ? Math.round((1000 * starts.filter((s) => replayWindow(t, s, cfg.rules).outcome === OUTCOME.PASS).length) / starts.length) / 10 : 0 };
}
const resolved = async (cfg, studies) => (await E.lab.resolveConfig({ strategy: cfg.s.id, eval: "1250", studies })).studies;
async function screen(id) {
  const base = await E.evaluate(id), { cfg } = base, rows = [];
  console.log(`\n${id}, $1,250 eval, 2026. Base: ${E.fmt(base)}. Forward: ${JSON.stringify(forward(cfg, cfg.studies))}`);
  for (const [name, studies] of SCREEN) {
    const s2 = await resolved(cfg, studies), r = E.score(E.trades2026({ ...cfg, studies: s2 }), cfg.rules);
    rows.push({ name, studies: s2, ...r, survives: r.calA > base.calA && r.calB > base.calB && r.bootA > base.bootA && r.bootB > base.bootB });
  }
  rows.sort((a, b) => Math.min(b.calA, b.calB, b.bootA, b.bootB) - Math.min(a.calA, a.calB, a.bootA, a.bootB));
  const near = rows.slice(0, 8);
  console.log(`${rows.length} gates in ${((Date.now() - t0) / 1000).toFixed(0)} s. Beat the book in both halves by both methods: ${rows.filter((r) => r.survives).length}.`);
  for (const r of near) { r.fwd = forward(cfg, r.studies); console.log(`  ${r.survives ? "*" : " "} ${r.name.padEnd(48)} ${E.fmt(r)}  forward ${r.fwd.trades} tr $${r.fwd.net} ${r.fwd.cal}%`); }
  const full = E.trades2026(cfg), checked = [];
  for (const r of rows.filter((x) => x.survives)) {
    const keep = r.trades / full.length, cal = [];
    for (let s = 0; s < RANDOM_DROPS; s++) { const rnd = mulberry32(9000 + s); cal.push(E.score(full.filter(() => rnd() < keep), cfg.rules).cal); }
    const nulls = E.nullScore({ ...cfg, studies: r.studies }, r, 10);
    r.fwd = r.fwd || forward(cfg, r.studies);
    checked.push({ ...r, randomMean: P.mean(cal), randomAtLeast: cal.filter((x) => x >= r.cal).length, nulls });
    console.log(`  survivor ${r.name}: calendar ${r.cal}, random drops average ${P.mean(cal).toFixed(1)}, ${cal.filter((x) => x >= r.cal).length} of ${RANDOM_DROPS} reach it; forward ${r.fwd.trades} tr $${r.fwd.net} ${r.fwd.cal}%`);
  }
  return { base: { ...base, cfg: undefined }, baseFwd: forward(cfg, cfg.studies), tried: rows.length, rows: rows.map(({ studies, ...r }) => r), survivors: checked.map(({ studies, ...r }) => r) };
}
const res = { donchian: await screen("donchian_1250"), macd: await screen("macd_fade_1250") };
fs.writeFileSync(new URL("./pct_gates_results.json", import.meta.url), JSON.stringify(res));
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
