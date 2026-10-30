// Stage 1 of the level study: every level in the catalog on 2026, against its twins.
//
//   node --max-old-space-size=8192 research/levels_study.mjs
//
// RESULT (2026, 132 sessions): 215 level types at 2 sizes, 430 tests. Chance alone would
// put about 22 under p = 0.05; 19 were. None passes the bar, and the lowest q is 0.17.
// Two sizes of reaction, R = 5% and 12% of the recent daily range, as the original
// study. The headline figure is the matched edge (lib_levels.mjs matchedEdgeOf) with
// the level's own bias on placebo markets taken out (levels_placebo.mjs: run that
// first). A test's p is the higher of the two nulls', with a false discovery rate
// across all levels and both sizes. The bar, set before looking: q < 0.10 at either
// size, at least 40 touches, and the same sign in Jan-Mar and in Apr-Jul.
//
// Writes research/levels_study_results.json.

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import { buildCatalog } from "./levels_catalog.mjs";

const NBOOT = 2000, t0 = Date.now();
const PL = JSON.parse(fs.readFileSync(new URL("./levels_placebo_results.json", import.meta.url), "utf8"));
const sample = Lab.loadSample({ to: Date.UTC(2026, 6, 15) });
const { days } = sample, D = days.length, half = (i, ev) => days[ev.day[i]].half;
console.log(`${D} sessions in 2026`);
const cat = buildCatalog(sample);
console.log(`${cat.length} level types, built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const boot = Lab.bootDays(D, NBOOT);

const rows = [];
for (const rFrac of [0.05, 0.12]) {
  const t1 = Date.now(), ev = Lab.runLevels(sample, cat, { rFrac, thru: 1, twins: 8 }), ids = Lab.byTag(ev, cat.length);
  console.log(`R ${rFrac * 100}%: ${ev.n.toLocaleString()} touches, ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  cat.forEach((lv, t) => {
    const plain = Lab.edgeOf(ev, ids[t], D, boot, NBOOT), m = Lab.matchedEdgeOf(ev, ids[t], D, boot, NBOOT);
    if (!plain || !m) return;
    const a = Lab.matchedEdgeOf(ev, ids[t], D, boot, 200, (i) => half(i, ev) === 0), z = Lab.matchedEdgeOf(ev, ids[t], D, boot, 200, (i) => half(i, ev) === 1);
    const up = Lab.matchedEdgeOf(ev, ids[t], D, boot, 200, (i) => ev.side[i] === 1), dn = Lab.matchedEdgeOf(ev, ids[t], D, boot, 200, (i) => ev.side[i] === -1);
    const c = Lab.calibrate(m.edge, PL.res[`${lv.tag}|${rFrac}`]);
    if (!c) return;
    rows.push({ family: lv.family, tag: lv.tag, r: rFrac, n: m.n, plain: plain.edge, edge: m.edge, adj: c.adj, bias: c.bias, z: c.z, pBoot: m.p, pPlacebo: c.pPlacebo, p: Math.max(m.p, c.pPlacebo),
                lo: m.lo, hi: m.hi, real: plain.real, twin: plain.twin,
                evReal: plain.evReal, evTwin: plain.evTwin, boReal: plain.boReal, boTwin: plain.boTwin,
                h1: a ? a.edge : null, h1n: a ? a.n : 0, h2: z ? z.edge : null, h2n: z ? z.n : 0, sup: up ? up.edge : null, supN: up ? up.n : 0, res: dn ? dn.edge : null, resN: dn ? dn.n : 0 });
  });
}
const q = Lab.bh(rows.map((r) => r.p));
rows.forEach((r, i) => { r.q = q[i]; r.sameSign = r.h1 != null && r.h2 != null && Math.sign(r.h1) === Math.sign(r.adj) && Math.sign(r.h2) === Math.sign(r.adj); });
fs.writeFileSync(new URL("./levels_study_results.json", import.meta.url), JSON.stringify({ sessions: D, types: cat.length, tests: rows.length, rows }, null, 0));

const f = (x, d = 1) => (x == null ? "  -" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}`);
const show = (r) => `${r.family.padEnd(11)} ${r.tag.padEnd(28)} R${String(r.r * 100).padEnd(3)} ${f(r.edge).padStart(6)} [${f(r.lo).padStart(6)}, ${f(r.hi).padStart(6)}] bias ${f(r.bias).padStart(6)} left ${f(r.adj).padStart(6)} z${f(r.z).padStart(5)} n${String(r.n).padEnd(5)} q${r.q.toFixed(3)}  halves ${f(r.h1).padStart(6)} ${f(r.h2).padStart(6)}  sup ${f(r.sup).padStart(6)} res ${f(r.res).padStart(6)}`;
const big = (r) => r.n >= 40;
console.log(`\n${rows.length} tests. p < 0.05 by chance alone would be about ${Math.round(rows.length * 0.05)}; got ${rows.filter((r) => r.p < 0.05).length}.`);
console.log(`\nPASS THE BAR (q < 0.10, at least 40 touches, same sign in both halves):`);
const pass = rows.filter((r) => r.q < 0.1 && r.sameSign && big(r)).sort((a, b) => a.q - b.q);
for (const r of pass) console.log(show(r));
if (!pass.length) console.log("  none");
console.log(`\nq < 0.10 but a half disagrees:`);
for (const r of rows.filter((r) => r.q < 0.1 && !r.sameSign && big(r)).sort((a, b) => a.q - b.q)) console.log(show(r));
console.log(`\nStrongest 25 with at least 40 touches, by p, whatever the q:`);
for (const r of rows.filter(big).sort((a, b) => a.p - b.p || Math.abs(b.adj) - Math.abs(a.adj)).slice(0, 25)) console.log(show(r));
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
