// The odds ladder: from any rung, which way does price go next?
//
//   node --max-old-space-size=8192 research/pct_ladder.mjs [paths]
//
// RESULT (2026, 300 placebo markets): a coin flip from every rung. Of 210 cells with 40+
// trials, 3 reach p < 0.05, where chance gives 11, and the lowest q is 0.91. From settlement,
// on all arrivals: 0.1% rungs 51.6% carry on (noise 52.2), 0.2% 48.5 (50.2), 0.25% 48.8 (50.0),
// 0.5% 49.7 (49.8). Arriving at the anchor itself goes through 47-51% of the time.
// Lay rungs every g percent around an anchor and walk the RTH session rung by rung. Each
// arrival at a rung is one trial: does price reach the next rung on, or the one back, first?
// Under a random walk that is a coin flip wherever you stand (the gambler's ruin), so this
// needs no R, no twins and no model. It asks of every percentage at once what a level
// test asks of one, with a bracket the size of the rung, where costs barely matter.
//
// Each arrival is split by where it is and how it came:
//   away     moving away from the anchor: does the move carry on?
//   toward   moving back to the anchor: does the return carry on?
//   at       arriving at the anchor itself: does it go through, or turn?
//
// A bar that reaches both neighbours says nothing about which came first, and is dropped
// on real and placebo bars alike. Trials are resampled by day. Costs: 1 point a trade.
//
// Writes research/pct_ladder_results.json.

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import * as P from "./lib_pct.mjs";
import { anchorOf, rawOffsets } from "../src/levels.mjs";

const PATHS = Number(process.argv[2]) || 300, NBOOT = 2000, t0 = Date.now();
const real = P.loadReal(), fwd = P.loadForward();
const ANCHORS = [["settle", "settlement"], ["rth", "RTH open"], ["week", "week open"]];
const GRID = [0.1, 0.15, 0.2, 0.25, 0.35, 0.5, 0.75, 1];

// Walks a day's RTH. A trial is { far, how, cont, g }: how many rungs out, away / toward / at.
function walk(sample, anchorName, g, onTrial) {
  const { b, days } = sample, A = anchorOf(b, anchorName), off = rawOffsets(b), { open: O, high: H, low: L } = b;
  days.forEach((d, k) => {
    const a0 = A[d.a];
    if (!(a0 === a0)) return;
    const step = ((a0 - off[d.a]) * g) / 100, at = (r) => a0 + r * step;
    let cur = Math.round((O[d.a] - a0) / step), came = 0;
    for (let i = d.a; i < d.z; i++) {
      const up = H[i] >= at(cur + 1), dn = L[i] <= at(cur - 1);
      if (up && dn) { cur = Math.round((b.close[i] - a0) / step); came = 0; continue; }
      if (!up && !dn) continue;
      const s = up ? 1 : -1;
      // through every rung this bar crossed, each a trial in the same direction
      while (s > 0 ? H[i] >= at(cur + 1) : L[i] <= at(cur - 1)) {
        if (came) onTrial(k, Math.abs(cur), cur === 0 ? "at" : Math.sign(cur) === came ? "away" : "toward", s === came ? 1 : 0, step);
        cur += s; came = s;
      }
    }
  });
}

function cells(sample) {
  const out = {};
  for (const [anchor, name] of ANCHORS) for (const g of GRID) {
    const put = (key, k, v) => (out[`${name} | ${g}% | ${key}`] ||= []).push([k, v]);
    walk(sample, anchor, g, (k, far, how, cont) => {
      put("every arrival", k, cont);
      put(how, k, cont);
      if (how !== "at") put(`${how}, rung ${far > 3 ? "4+" : far}`, k, cont);
    });
  }
  return out;
}

const rows = P.testRates(cells, real, fwd, { paths: PATHS, seed: 50000 });
// the day-resampled interval on the rate itself
const R = cells(real), D = real.days.length, boot = Lab.bootDays(D, NBOOT);
for (const r of rows) {
  const a = R[r.name], wins = new Float64Array(D), n = new Float64Array(D);
  for (const [k, v] of a) { n[k]++; wins[k] += v; }
  const s = new Float64Array(NBOOT);
  for (let q = 0; q < NBOOT; q++) { let w = 0, c = 0; const o = q * D; for (let j = 0; j < D; j++) { const d = boot[o + j]; w += wins[d]; c += n[d]; } s[q] = c ? (100 * w) / c : NaN; }
  s.sort(); r.lo = s[Math.floor(0.025 * NBOOT)]; r.hi = s[Math.floor(0.975 * NBOOT)];
}
fs.writeFileSync(new URL("./pct_ladder_results.json", import.meta.url), JSON.stringify({ paths: PATHS, sessions: D, rows }));

const show = (r) => `${r.name.padEnd(42)} ${r.rate.toFixed(1).padStart(5)}% [${r.lo.toFixed(1)}, ${r.hi.toFixed(1)}]  noise ${r.placebo.toFixed(1).padStart(5)}%  ${P.f1(r.excess).padStart(5)}  z${P.f1(r.z).padStart(5)}  q${r.q.toFixed(2)}  n${String(r.n).padEnd(5)} ${r.h1.toFixed(1).padStart(5)} ${r.h2.toFixed(1).padStart(5)}  fwd ${Number.isNaN(r.fwd) ? "   -" : r.fwd.toFixed(1).padStart(5)}% (${r.fwdN})`;
console.log(`${rows.length} cells, ${PATHS} placebo markets, ${D} sessions. % is how often the move carries on to the next rung.`);
console.log(`\nEVERY ARRIVAL: is NQ trending or reverting at this scale?`);
for (const r of rows.filter((r) => r.name.endsWith("every arrival"))) console.log(show(r));
console.log(`\nAT THE ANCHOR ITSELF: does price go through?`);
for (const r of rows.filter((r) => r.name.endsWith("| at"))) console.log(show(r));
console.log(`\nSTRONGEST 25 with 40+ trials, by z:`);
const big = rows.filter((r) => r.n >= 40);
for (const r of big.slice().sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 25)) console.log(show(r));
console.log(`\n${big.length} cells with 40+ trials. p < 0.05 by chance about ${Math.round(big.length * 0.05)}; got ${big.filter((r) => r.p < 0.05).length}. Lowest q ${Math.min(...big.map((r) => r.q)).toFixed(3)}.`);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
