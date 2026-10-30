// Calibrates the level test against markets with nothing in them.
//
//   node --max-old-space-size=8192 research/levels_placebo.mjs [paths]
//
// A shifted twin is a fair null for a fixed level, but not always for a line that
// depends on the path: a twin below "the low so far" can hardly ever be reached, and a
// Supertrend's flip once scored its twins as breaks, which made it look like the best
// level in the study. So every level also runs on placebo paths (lib_levels.mjs
// placeboBars), each rebuilt from scratch on that path. The edge it shows there is
// what the method gives that level on noise: the real edge is measured against this.
//
// Writes research/levels_placebo_results.json: each level's and pool's mean and spread.

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import { buildCatalog, POOLS } from "./levels_catalog.mjs";

const PATHS = Number(process.argv[2]) || 40, RS = [0.05, 0.12], t0 = Date.now();
const real = Lab.loadSample({ to: Date.UTC(2026, 6, 15) });
const dist = new Map(), note = (k, e) => { if (!e) return; if (!dist.has(k)) dist.set(k, []); dist.get(k).push(e.edge); };
let tests = 0, tw = 0, twN = 0;
for (let path = 0; path < PATHS; path++) {
  const sample = { ...real, b: Lab.placeboBars(real.b, 1000 + path) }, cat = buildCatalog(sample), idx = new Map(cat.map((c, i) => [c.tag, i]));
  for (const rFrac of RS) {
    const ev = Lab.runLevels(sample, cat, { rFrac, thru: 1, twins: 8 }), ids = Lab.byTag(ev, cat.length);
    for (let i = 0; i < ev.n; i++) if (!ev.real[i] && ev.oc[i]) { twN++; if (ev.oc[i] === 1) tw++; }
    cat.forEach((lv, t) => { note(`${lv.tag}|${rFrac}`, Lab.quickEdge(ev, ids[t])); tests++; });
    for (const [name, tags] of Object.entries(POOLS)) note(`pool:${name}|${rFrac}`, Lab.quickEdge(ev, Int32Array.from(tags.flatMap((k) => [...ids[idx.get(k)]]))));
  }
  if ((path + 1) % 5 === 0) console.log(`${path + 1} of ${PATHS} paths, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
const res = {};
for (const [k, a] of dist) {
  const mean = a.reduce((x, y) => x + y, 0) / a.length, sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, a.length - 1));
  res[k] = { mean, sd, paths: a.length, values: a.map((x) => +x.toFixed(2)) };
}
fs.writeFileSync(new URL("./levels_placebo_results.json", import.meta.url), JSON.stringify({ paths: PATHS, twinBounce: (100 * tw) / twN, res }));
const rows = Object.entries(res).filter(([k]) => !k.startsWith("pool:")), big = rows.slice().sort((a, b) => Math.abs(b[1].mean) - Math.abs(a[1].mean)).slice(0, 10);
console.log(`\n${PATHS} placebo paths. Twin bounce rate ${((100 * tw) / twN).toFixed(1)}%.`);
console.log(`Mean edge across all levels ${(rows.reduce((a, [, r]) => a + r.mean, 0) / rows.length).toFixed(2)} points.`);
console.log(`Largest structural bias, by level:`);
for (const [k, r] of big) console.log(`  ${k.padEnd(40)} ${r.mean >= 0 ? "+" : ""}${r.mean.toFixed(1)}  sd ${r.sd.toFixed(1)}  (${r.paths} paths)`);
for (const k of ["Supertrend (5m)|0.05", "Supertrend (5m)|0.12"]) console.log(`  ${k.padEnd(40)} ${res[k].mean >= 0 ? "+" : ""}${res[k].mean.toFixed(1)}  sd ${res[k].sd.toFixed(1)}`);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
