// Can the new levels and indicators improve the two $1,250 books, as gates?
//
//   node --max-old-space-size=8192 research/levels_gates.mjs [donchian|macd|both]
//
// RESULT (2026): 247 gates on each book. None beats either book in both halves by both
// methods. The nearest are followed up in levels_nearmiss.mjs and levels_followup.mjs.
// Each gate is a study from src/studies.mjs, so it is exactly what the chart's
// Indicators tab applies: read from closed bars, refusing entries only. $1,250 rules,
// costs included, 2026 only, by both pass-rate methods.
//
// A gate SURVIVES only if it beats the book in both halves by both methods, as in
// research/combos_1250.mjs. With hundreds tried, some will do that by luck, and a
// filter can look good just by trading less, so each survivor must then beat the same
// number of entries dropped at random (RANDOM_DROPS seeds), keep its edge against the
// coin-flip twin, and finally hold on the forward bars.
//
// Writes research/levels_gates_results.json.

import fs from "node:fs";
import * as E from "./lib_eval1250.mjs";
import { mulberry32 } from "../src/dayeval.mjs";

const which = process.argv[2] || "both", RANDOM_DROPS = 40, t0 = Date.now();
const st = (type, tf, params, gate) => ({ type, tf, params, gate });
const G = (type, tf, params, gates) => gates.map((g) => [`${type} ${JSON.stringify(params).replace(/[{}"]/g, "")} ${tf ? `${tf}m` : "sig"} ${g}`, [st(type, tf, params, g)]]);

const SCREEN = [];
const add = (...a) => SCREEN.push(...G(...a));
// the volume profile, each anchor, developing and prior
for (const anchor of ["rth", "session", "week", "month"]) {
  for (const mode of ["developing", "prior"]) add("vprofile", 1, { anchor, mode }, ["with", "against", "nochase", "fade", "inside", "outside"]);
}
add("vprofile", 1, { anchor: "rth", weight: "time" }, ["with", "against", "nochase", "inside", "outside"]);
for (const sessions of [5, 20]) add("vcomposite", 1, { sessions, nodes: 0 }, ["with", "against", "nochase", "inside", "outside"]);
// fixed levels
for (const style of ["floor", "camarilla", "fib"]) add("pivots", 1, { style, period: "day" }, ["with", "against", "nochase", "inside", "outside"]);
add("pivots", 1, { style: "floor", period: "week" }, ["with", "against", "nochase"]);
for (const period of ["week", "month"]) add("periodlevels", 1, { period }, ["with", "against", "nochase", "inside", "outside"]);
add("firstrange", 1, { period: "week", sessions: 1 }, ["with", "against", "nochase", "inside", "outside"]);
add("firstrange", 1, { period: "week", sessions: 2 }, ["with", "against", "inside", "outside"]);
add("daylevels", 1, {}, ["with", "against", "nochase", "inside", "outside"]);
for (const minutes of [15, 30, 60]) add("openrange", 1, { minutes }, ["with", "against", "nochase", "outside"]);
add("initialbalance", 1, { minutes: 60 }, ["with", "against", "nochase", "inside", "outside"]);
for (const span of ["overnight", "asia", "london", "premarket"]) add("clockrange", 1, { span }, ["with", "against", "nochase", "inside", "outside"]);
for (const line of ["rth", "session", "midnight", "week", "month"]) add("opens", 1, { line }, ["with", "against"]);
add("adrproj", 1, { days: 10, mult: 1 }, ["with", "against", "nochase", "inside"]);
// developing lines
for (const period of ["day", "week", "month"]) add("rangelevels", 1, { period }, ["with", "against", "nochase", "fade"]);
for (const anchor of ["rth", "session", "week", "month"]) add("vwap", 1, { anchor, bands: 0 }, ["with", "against"]);
for (const [tf, left, right] of [[5, 3, 3], [15, 3, 3], [60, 3, 3]]) add("swings", tf, { left, right }, ["with", "against", "nochase", "outside"]);
for (const [tf, left, right] of [[5, 10, 10], [15, 5, 5]]) add("swingvwap", tf, { left, right }, ["with", "against", "inside", "outside"]);
add("nakedpoc", 1, { maxAge: 20 }, ["with", "against", "nochase"]);
add("volshelf", 5, { length: 48, mult: 3 }, ["with", "against"]);
// the added indicators
for (const tf of [5, 15]) {
  add("hma", tf, { length: 20 }, ["with"]); add("kama", tf, { length: 10 }, ["with"]); add("vwma", tf, { length: 20 }, ["with"]);
  add("ichimoku", tf, {}, ["with", "against"]); add("psar", tf, {}, ["with"]); add("chandelier", tf, {}, ["with"]); add("heikin", tf, {}, ["with"]);
  add("linreg", tf, { length: 50, mult: 2 }, ["with", "nochase", "inside"]);
  add("mfi", tf, { length: 14 }, ["with", "nochase"]); add("willr", tf, { length: 14 }, ["with", "nochase"]); add("aroon", tf, { length: 25 }, ["with"]);
  add("cmf", tf, { length: 20 }, ["with"]); add("obv", tf, { length: 50 }, ["with"]); add("cvd", tf, { length: 30 }, ["with"]);
  add("vortex", tf, { length: 14 }, ["with"]); add("squeeze", tf, { length: 20 }, ["with", "above", "below"]);
}

async function screen(id) {
  const base = await E.evaluate(id), { cfg } = base;
  console.log(`\n${id}, $1,250 eval, 2026. Base: ${E.fmt(base)}`);
  const rows = [];
  for (const [name, studies] of SCREEN) {
    let r;
    try { r = E.score(E.trades2026({ ...cfg, studies: await resolved(cfg, studies) }), cfg.rules); }
    catch (e) { console.log(`  skipped ${name}: ${e.message}`); continue; }
    const survives = r.calA > base.calA && r.calB > base.calB && r.bootA > base.bootA && r.bootB > base.bootB;
    rows.push({ name, studies, ...r, survives });
  }
  rows.sort((a, b) => Math.min(b.calA, b.calB, b.bootA, b.bootB) - Math.min(a.calA, a.calB, a.bootA, a.bootB));
  console.log(`${rows.length} gates tried in ${((Date.now() - t0) / 1000).toFixed(0)} s. Beat the book in both halves by both methods: ${rows.filter((r) => r.survives).length}.`);
  console.log(`Ten best by their worst half:`);
  for (const r of rows.slice(0, 10)) console.log(`  ${r.survives ? "*" : " "} ${r.name.padEnd(62)} ${E.fmt(r)}`);
  // the same number of entries dropped at random, for each survivor
  const full = E.trades2026(cfg), out = [];
  for (const r of rows.filter((x) => x.survives)) {
    const keep = r.trades / full.length, cal = [];
    for (let s = 0; s < RANDOM_DROPS; s++) {
      const rnd = mulberry32(9000 + s), kept = full.filter(() => rnd() < keep);
      cal.push(E.score(kept, cfg.rules).cal);
    }
    const beat = cal.filter((x) => x >= r.cal).length;
    const nulls = E.nullScore({ ...cfg, studies: await resolved(cfg, r.studies) }, r, 10);
    out.push({ ...r, randomMean: cal.reduce((a, x) => a + x, 0) / cal.length, randomAtLeast: beat, nulls });
    console.log(`  survivor ${r.name}: calendar ${r.cal}, random drops of the same size average ${(cal.reduce((a, x) => a + x, 0) / cal.length).toFixed(1)}, ${beat} of ${RANDOM_DROPS} reach it`);
  }
  return { base: { ...base, cfg: undefined }, tried: rows.length, rows: rows.map(({ studies, ...r }) => ({ ...r })), survivors: out };
}
const resolved = async (cfg, studies) => (await E.lab.resolveConfig({ strategy: cfg.s.id, eval: "1250", studies })).studies;

const res = {};
if (which !== "macd") res.donchian = await screen("donchian_1250");
if (which !== "donchian") res.macd = await screen("macd_fade_1250");
fs.writeFileSync(new URL(`./levels_gates_results_${which}.json`, import.meta.url), JSON.stringify(res));
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
