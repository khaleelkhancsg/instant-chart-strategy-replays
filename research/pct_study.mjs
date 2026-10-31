// Do percentage levels act as levels? Each against its shifted twins and against placebo
// markets, on 2026, then the closest on the forward bars.
//
//   node --max-old-space-size=8192 research/pct_study.mjs [paths]
//
// RESULT (2026, 132 sessions, 100 placebo markets): 162 levels and 20 pools at 2 sizes, 355
// tests. 16 reach p < 0.05, where chance gives 18. None passes, and the lowest q is 0.18.
// Round percentages do no better than percentages nobody would pick: from settlement, half
// percents +0.4 and -3.6, whole percents -4.0 and -5.0, the off-grid control +4.3 and +3.2.
// The strongest, whole percents from last week at R 5%, -13.3, went to +19.7 forward.
// The same test and the same bar as research/levels_study.mjs, with the placebo run here,
// so a percentage on a path is the same number of points it was on the day. The bar, set
// before looking: q under 0.10 across all tests, 40 or more touches, the same sign in
// Jan-Mar and Apr-Jul, then the forward bars.
//
// Writes research/pct_study_results.json.

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import * as P from "./lib_pct.mjs";
import { buildPctCatalog, PCT_POOLS } from "./pct_catalog.mjs";

const PATHS = Number(process.argv[2]) || 100, RS = [0.05, 0.12], NBOOT = 1000, t0 = Date.now();
const real = P.loadReal(), { days } = real, D = days.length, boot = Lab.bootDays(D, NBOOT);
const cat = buildPctCatalog(real), idx = new Map(cat.map((c, i) => [c.tag, i]));
for (const [k, tags] of Object.entries(PCT_POOLS)) for (const t of tags) if (!idx.has(t)) throw new Error(`pool ${k}: no level "${t}"`);
console.log(`${cat.length} levels, ${Object.keys(PCT_POOLS).length} pools, ${D} sessions, built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const dist = new Map(), note = (k, e) => { if (!e) return; if (!dist.has(k)) dist.set(k, []); dist.get(k).push(e.edge); };
for (let p = 0; p < PATHS; p++) {
  const sample = { ...real, b: Lab.placeboBars(real.b, 40000 + p) }, c2 = buildPctCatalog(sample);
  for (const rFrac of RS) {
    const ev = Lab.runLevels(sample, c2, { rFrac, thru: 1, twins: 8 }), ids = Lab.byTag(ev, c2.length);
    c2.forEach((lv, t) => note(`${lv.tag}|${rFrac}`, Lab.quickEdge(ev, ids[t])));
    for (const [name, tags] of Object.entries(PCT_POOLS)) note(`pool:${name}|${rFrac}`, Lab.quickEdge(ev, Int32Array.from(tags.flatMap((k) => [...ids[idx.get(k)]]))));
  }
  if ((p + 1) % 10 === 0) console.log(`  ${p + 1} of ${PATHS} placebo paths, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
const PL = {};
for (const [k, a] of dist) PL[k] = { mean: P.mean(a), sd: P.sdOf(a), paths: a.length };

const fwd = P.loadForward(), fcat = buildPctCatalog(fwd), FD = fwd.days.length, fboot = Lab.bootDays(FD, NBOOT);
const rows = [], pools = [];
const half = (ev, h) => (i) => days[ev.day[i]].half === h;
for (const rFrac of RS) {
  const ev = Lab.runLevels(real, cat, { rFrac, thru: 1, twins: 8 }), ids = Lab.byTag(ev, cat.length);
  const fev = Lab.runLevels(fwd, fcat, { rFrac, thru: 1, twins: 8 }), fids = Lab.byTag(fev, fcat.length);
  const one = (list, flist, name, key, family) => {
    const m = Lab.matchedEdgeOf(ev, list, D, boot, NBOOT);
    if (!m) return null;
    const c = Lab.calibrate(m.edge, PL[key]);
    if (!c) return null;
    const a = Lab.matchedEdgeOf(ev, list, D, boot, 200, half(ev, 0)), z = Lab.matchedEdgeOf(ev, list, D, boot, 200, half(ev, 1)), f = Lab.matchedEdgeOf(fev, flist, FD, fboot, 400), pl = Lab.edgeOf(ev, list, D, boot, 200);
    return { family, tag: name, r: rFrac, n: m.n, edge: m.edge, adj: c.adj, bias: c.bias, z: c.z, p: Math.max(m.p, c.pPlacebo), lo: m.lo, hi: m.hi, h1: a ? a.edge : null, h2: z ? z.edge : null,
             sameSign: !!a && !!z && Math.sign(a.edge) === Math.sign(c.adj) && Math.sign(z.edge) === Math.sign(c.adj), fwd: f ? f.edge : null, fwdLo: f ? f.lo : null, fwdHi: f ? f.hi : null, fwdN: f ? f.n : 0, real: pl ? pl.real : null, twin: pl ? pl.twin : null, evReal: pl ? pl.evReal : null, evTwin: pl ? pl.evTwin : null };
  };
  cat.forEach((lv, t) => { const r = one(ids[t], fids[t], lv.tag, `${lv.tag}|${rFrac}`, lv.family); if (r) rows.push(r); });
  for (const [name, tags] of Object.entries(PCT_POOLS)) {
    const r = one(Int32Array.from(tags.flatMap((k) => [...ids[idx.get(k)]])), Int32Array.from(tags.flatMap((k) => [...fids[idx.get(k)]])), name, `pool:${name}|${rFrac}`, "pool");
    if (r) pools.push(r);
  }
}
const q = Lab.bh(rows.concat(pools).map((r) => r.p));
rows.concat(pools).forEach((r, i) => { r.q = q[i]; });
fs.writeFileSync(new URL("./pct_study_results.json", import.meta.url), JSON.stringify({ sessions: D, forward: FD, paths: PATHS, levels: cat.length, tests: rows.length + pools.length, rows, pools }));

const f = P.f1, show = (r) => `${r.tag.padEnd(34)} R${String(Math.round(r.r * 100)).padEnd(3)} edge ${f(r.adj).padStart(6)} [${f(r.lo).padStart(6)}, ${f(r.hi).padStart(6)}] z${f(r.z).padStart(5)} n${String(r.n).padEnd(5)} q${r.q.toFixed(2)} halves ${f(r.h1).padStart(6)} ${f(r.h2).padStart(6)}  forward ${f(r.fwd).padStart(6)} [${f(r.fwdLo)}, ${f(r.fwdHi)}] n${r.fwdN}`;
const all = rows.concat(pools);
console.log(`\n${all.length} tests. p < 0.05 by chance about ${Math.round(all.length * 0.05)}; got ${all.filter((r) => r.p < 0.05).length}. Lowest q ${Math.min(...all.map((r) => r.q)).toFixed(3)}.`);
console.log(`\nPASS THE 2026 BAR (q < 0.10, 40+ touches, same sign in both halves):`);
const pass = all.filter((r) => r.q < 0.1 && r.sameSign && r.n >= 40);
for (const r of pass) console.log(show(r));
if (!pass.length) console.log("  none");
console.log(`\nPOOLS`);
for (const r of pools) console.log(show(r));
console.log(`\nStrongest 20 single levels with 40+ touches:`);
for (const r of rows.filter((r) => r.n >= 40).sort((a, b) => a.p - b.p || Math.abs(b.adj) - Math.abs(a.adj)).slice(0, 20)) console.log(show(r));
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
