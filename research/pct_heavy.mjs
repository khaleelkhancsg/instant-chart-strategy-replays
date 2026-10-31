// The strongest cell in research/pct_absorb.mjs: a heavy touch of a session extreme breaks
// more often than its twins, -12.7 at R 5%, q 0.05, both halves, forward -3.4. It came from a
// pool chosen after the first look and a split of that pool, so it has to earn belief.
//
//   node --max-old-space-size=8192 research/pct_heavy.mjs
//
// RESULT: a lead for new bars, not a rule. In 2026 it holds at small reactions and across kinds
// of level: -10.9 at R 3%, -12.0 at R 5%, -6.5 at R 8%, with the opening range, the initial
// balance and the day's extremes all leaning the same way at R 3-5%. It is gone by R 12% (+0.1).
// Traded with the break it earned 2.71 points a touch after costs at R 5%, twins -2.06. Forward
// the edge keeps its sign at R 3-5% (-8.5, -3.4, intervals through zero) but the trade lost
// 0.71 a touch, and at R 8-12% the sign flips. Not run as a book.
//
// A real effect should hold at neighbouring reaction sizes and in more than one kind of level,
// and should pay when traded with the break, after costs, on the forward bars as well.
//
// Writes research/pct_heavy_results.json.

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import * as P from "./lib_pct.mjs";
import { buildCatalog } from "./levels_catalog.mjs";

const NBOOT = 1000, RS = [0.03, 0.05, 0.08, 0.12, 0.2], t0 = Date.now();
const real = P.loadReal(), fwd = P.loadForward(), D = real.days.length, FD = fwd.days.length, boot = Lab.bootDays(D, NBOOT), fboot = Lab.bootDays(FD, NBOOT);
const POOLS = { "All session extremes": ["Overnight high", "Overnight low", "OR15 high", "OR15 low", "IB high", "IB low", "day high so far", "day low so far"], "Overnight high/low": ["Overnight high", "Overnight low"], "Opening range 15m": ["OR15 high", "OR15 low"], "Initial balance": ["IB high", "IB low"], "Day's high/low so far": ["day high so far", "day low so far"] };
const sess = (s) => s.sessions.filter((x) => x.rthA >= 0);
const catR = buildCatalog(real), catF = buildCatalog(fwd), idxR = new Map(catR.map((c, i) => [c.tag, i])), idxF = new Map(catF.map((c, i) => [c.tag, i]));
function run(sample, cat, idx, rFrac) {
  const ev = Lab.runLevels(sample, cat, { rFrac, thru: 1, twins: 8 }), ids = Lab.byTag(ev, cat.length), { b } = sample, lv = P.excessOf(b, sess(sample), (i) => b.volume[i]), vol = new Float32Array(ev.n);
  for (let i = 0; i < ev.n; i++) vol[i] = lv[ev.bar[i]];
  return { ev, vol, pick: (tags) => Int32Array.from(tags.flatMap((k) => [...ids[idx.get(k)]])) };
}
const rows = [], f = P.f1;
console.log(`Heavy touches: the top third of each pool's touches by volume, thirds set on 2026. Edge in points of bounce rate; "with the break" is net points a touch after 1 point of cost, real then twin.`);
for (const rFrac of RS) {
  const r = run(real, catR, idxR, rFrac), fr = run(fwd, catF, idxF, rFrac);
  for (const [name, tags] of Object.entries(POOLS)) {
    const ids = r.pick(tags), fids = fr.pick(tags), v = Array.from(ids, (i) => r.vol[i]).filter((x) => x === x).sort((a, b) => a - b), cut = v[Math.floor((2 * v.length) / 3)];
    const keep = (x) => (i) => x.vol[i] > cut, m = Lab.matchedEdgeOf(r.ev, ids, D, boot, NBOOT, keep(r)), pl = Lab.edgeOf(r.ev, ids, D, boot, 200, keep(r)), fm = Lab.matchedEdgeOf(fr.ev, fids, FD, fboot, 400, keep(fr)), fp = Lab.edgeOf(fr.ev, fids, FD, fboot, 200, keep(fr));
    const half = (h) => Lab.matchedEdgeOf(r.ev, ids, D, boot, 0, (i) => r.vol[i] > cut && real.days[r.ev.day[i]].half === h), a = half(0), z = half(1);
    rows.push({ rFrac, name, n: m.n, edge: m.edge, lo: m.lo, hi: m.hi, h1: a && a.edge, h2: z && z.edge, real: pl.real, twin: pl.twin, boReal: pl.boReal, boTwin: pl.boTwin, fwd: fm && fm.edge, fwdLo: fm && fm.lo, fwdHi: fm && fm.hi, fwdN: fm ? fm.n : 0, fwdBoReal: fp && fp.boReal, fwdBoTwin: fp && fp.boTwin });
    console.log(`R${String(Math.round(rFrac * 100)).padEnd(3)} ${name.padEnd(24)} ${f(m.edge).padStart(6)} [${f(m.lo).padStart(6)}, ${f(m.hi).padStart(6)}] n${String(m.n).padEnd(4)} halves ${f(a && a.edge).padStart(6)} ${f(z && z.edge).padStart(6)}  with the break ${f(pl.boReal, 2).padStart(6)} vs ${f(pl.boTwin, 2).padStart(6)}  | forward ${f(fm && fm.edge).padStart(6)} [${f(fm && fm.lo)}, ${f(fm && fm.hi)}] n${fm ? fm.n : 0}, with the break ${f(fp && fp.boReal, 2)} vs ${f(fp && fp.boTwin, 2)}`);
  }
}
fs.writeFileSync(new URL("./pct_heavy_results.json", import.meta.url), JSON.stringify({ sessions: D, forward: FD, rows }));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
