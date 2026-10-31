// When people do act at a level, does the volume say which way it goes?
//
//   node --max-old-space-size=8192 research/pct_absorb.mjs [paths]
//
// RESULT (2026, 40 placebo markets): mostly no. 54 tests, 3 at p < 0.05 where chance gives 3.
// One cell stands out: a heavy touch of a session extreme at R 5% breaks more than its twins,
// -12.7 [-19.0, -6.9], q 0.05, both halves, forward -3.4 [-15.3, +8.6]. At R 12% the heavy
// third shows nothing (-0.1). research/pct_heavy.mjs takes it apart.
//
// The footprint test found more volume at the levels people watch. Order-flow traders read
// that volume: heavy trade at a level with no progress is absorption, and it should hold; a
// quiet touch has nobody defending it, and should go. A touch's volume is known at its close,
// so this could be traded. Each pool's touches are split into thirds by that volume, and each
// third's bounce rate is measured against its own twins, on placebo markets, and forward.
//
// Writes research/pct_absorb_results.json.

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import * as P from "./lib_pct.mjs";
import { buildCatalog } from "./levels_catalog.mjs";
import { buildPctCatalog, PCT_POOLS } from "./pct_catalog.mjs";

const PATHS = Number(process.argv[2]) || 40, NBOOT = 1000, RS = [0.05, 0.12], t0 = Date.now();
const real = P.loadReal(), fwd = P.loadForward(), D = real.days.length, FD = fwd.days.length, boot = Lab.bootDays(D, NBOOT), fboot = Lab.bootDays(FD, NBOOT);
const POOLS = {
  "All session extremes": ["Overnight high", "Overnight low", "OR15 high", "OR15 low", "IB high", "IB low", "day high so far", "day low so far"],
  "Prior day high/low": ["PD high", "PD low"], "Round 100": ["Round 100"], "Round 50 and 25": ["Round 50", "Round 25"],
  "Prior POCs": ["PD POC (RTH)", "VP5 POC", "VP20 POC"], "VWAPs": ["VWAP (RTH)", "VWAP (session)"],
  "RTH open: half-percent rungs": PCT_POOLS["RTH open: half-percent rungs"], "Settlement: half-percent rungs": PCT_POOLS["Settlement: half-percent rungs"], "Off-grid control": PCT_POOLS["Off-grid control"],
};
const sess = (s) => s.sessions.filter((x) => x.rthA >= 0);
function run(sample, sessions, rFrac) {
  const seen = new Set(), cat = [];
  for (const lv of buildCatalog(sample).concat(buildPctCatalog(sample))) if (!seen.has(lv.tag)) { seen.add(lv.tag); cat.push(lv); }
  const idx = new Map(cat.map((c, i) => [c.tag, i])), ev = Lab.runLevels(sample, cat, { rFrac, thru: 1, twins: 8 }), ids = Lab.byTag(ev, cat.length), { b } = sample;
  const lv = P.excessOf(b, sessions, (i) => b.volume[i]), vol = new Float32Array(ev.n);
  for (let i = 0; i < ev.n; i++) vol[i] = lv[ev.bar[i]];
  return { ev, vol, pick: (tags) => Int32Array.from(tags.flatMap((k) => [...ids[idx.get(k)]])) };
}
const terciles = (r, list) => { const v = Array.from(list, (i) => r.vol[i]).filter((x) => x === x).sort((a, b) => a - b); return [v[Math.floor(v.length / 3)], v[Math.floor((2 * v.length) / 3)]]; };
const bandOf = (r, cut, t) => (i) => { const x = r.vol[i]; return x === x && (t === 0 ? x <= cut[0] : t === 1 ? x > cut[0] && x <= cut[1] : x > cut[1]); };

const dist = {}, cuts = {}, base = {}, fbase = {};
for (const rFrac of RS) {
  base[rFrac] = run(real, sess(real), rFrac); fbase[rFrac] = run(fwd, sess(fwd), rFrac);
  for (const [name, tags] of Object.entries(POOLS)) cuts[`${name}|${rFrac}`] = terciles(base[rFrac], base[rFrac].pick(tags));
}
for (let p = 0; p < PATHS; p++) {
  const s = { ...real, b: Lab.placeboBars(real.b, 80000 + p) };
  for (const rFrac of RS) {
    const r = run(s, sess(real), rFrac);
    for (const [name, tags] of Object.entries(POOLS)) {
      const ids = r.pick(tags), cut = cuts[`${name}|${rFrac}`];
      for (const t of [0, 1, 2]) { const keep = bandOf(r, cut, t), e = Lab.quickEdge(r.ev, ids.filter(keep)); if (e) (dist[`${name}|${rFrac}|${t}`] ||= []).push(e.edge); }
    }
  }
  console.log(`  ${p + 1} of ${PATHS} placebo paths, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
const rows = [], T = ["quiet touch", "ordinary", "heavy touch"];
for (const rFrac of RS) for (const [name, tags] of Object.entries(POOLS)) {
  const r = base[rFrac], ids = r.pick(tags), cut = cuts[`${name}|${rFrac}`], fr = fbase[rFrac], fids = fr.pick(tags);
  for (const t of [0, 1, 2]) {
    const keep = bandOf(r, cut, t), e = Lab.matchedEdgeOf(r.ev, ids, D, boot, NBOOT, keep), d = dist[`${name}|${rFrac}|${t}`] || [], mean = P.mean(d), sd = P.sdOf(d), adj = e.edge - mean, z = sd > 0 ? adj / sd : 0;
    const half = (h) => Lab.matchedEdgeOf(r.ev, ids, D, boot, 0, (i) => keep(i) && real.days[r.ev.day[i]].half === h), a = half(0), c = half(1), f = Lab.matchedEdgeOf(fr.ev, fids, FD, fboot, 400, bandOf(fr, cut, t));
    rows.push({ name, r: rFrac, third: T[t], n: e.n, adj, lo: e.lo - mean, hi: e.hi - mean, z, p: Math.max(e.p, Lab.zToP(z)), h1: a ? a.edge - mean : null, h2: c ? c.edge - mean : null, fwd: f ? f.edge : null, fwdLo: f ? f.lo : null, fwdHi: f ? f.hi : null, fwdN: f ? f.n : 0 });
  }
}
const q = Lab.bh(rows.map((r) => r.p));
rows.forEach((r, i) => { r.q = q[i]; });
fs.writeFileSync(new URL("./pct_absorb_results.json", import.meta.url), JSON.stringify({ paths: PATHS, sessions: D, rows }));
const f = P.f1;
console.log(`\nBounce edge against twins, by the touch's volume. ${rows.length} tests, lowest q ${Math.min(...rows.map((r) => r.q)).toFixed(2)}; p < 0.05 ${rows.filter((r) => r.p < 0.05).length}, chance about ${Math.round(rows.length * 0.05)}.`);
for (const r of rows) console.log(`${r.name.padEnd(32)} R${String(Math.round(r.r * 100)).padEnd(3)} ${r.third.padEnd(12)} ${f(r.adj).padStart(6)} [${f(r.lo).padStart(6)}, ${f(r.hi).padStart(6)}] z${f(r.z).padStart(5)} q${r.q.toFixed(2)} n${String(r.n).padEnd(5)} halves ${f(r.h1).padStart(6)} ${f(r.h2).padStart(6)}  forward ${f(r.fwd).padStart(6)} [${f(r.fwdLo)}, ${f(r.fwdHi)}] n${r.fwdN}`);
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
