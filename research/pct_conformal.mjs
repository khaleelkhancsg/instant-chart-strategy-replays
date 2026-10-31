// Self-correcting bands: can a level be calibrated, whatever the market does?
//
//   node --max-old-space-size=8192 research/pct_conformal.mjs
//
// RESULT: units matter more than the method. The mean miss from the aim, over 2026's halves and
// forward: fixed percentage 9.2 points, trailing percentage 4.4, ADR multiple 4.0, conformal
// 4.4. Aimed at 20% of sides broken, a fixed 1.00% is broken 34.8% of the time, a fixed ADR
// multiple 24.6%, conformal 21.2% (22.4% forward). In the tails conformal is no better: aimed
// at 5% it is broken 9.5%, and an ADR multiple 5.7%. So a level should be stated in ADRs, not
// in percent, and the self-correcting band adds little to a plain multiple.
//
// "NQ usually moves about 1%" is a claim about a distribution, and a fixed number goes stale
// as volatility changes. Online quantile tracking (conformal prediction's update, built in
// src/levels.mjs conformalLevels) needs no model: it widens after a miss and narrows after
// a hit, so a band aimed at 20% of days broken should be broken on 20% of days, even when
// the market changes under it. That is a promise about coverage, not about direction, so
// it is tested as one. Four ways of setting a band, each aimed at the same rate:
//
//   fixed %        the percentage that was right over the year before 2026
//   trailing %     the quantile of the last 60 days' reach, in percent
//   ADR multiple   the fixed multiple of the ADR that was right the year before 2026
//   conformal      the self-correcting multiple of the ADR
//
// Better is closer to the aim, in both halves and forward, and narrower for the same
// coverage. A band that keeps its promise on the forward bars is usable for sizing or
// targets even if nothing bounces off it.
//
// Writes research/pct_conformal_results.json.

import fs from "node:fs";
import * as P from "./lib_pct.mjs";
import { sessionReach, conformalLevels, reachLevels } from "../src/levels.mjs";

const real = P.loadReal(), fwd = P.loadForward(), Y26 = Date.UTC(2026, 0, 1);
const MISSES = [0.5, 0.25, 0.2, 0.1, 0.05];
const q = (a, p) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };

// The year before 2026 sets the fixed numbers, so nothing below is fitted on what it is scored on.
const prior = sessionReach(real.b).filter((s) => s.td * 86400000 < Y26 && Number.isFinite(s.upAdr));
console.log(`${prior.length} sessions before 2026 set the fixed numbers (warm-up only).`);

function score(sample, days, miss) {
  const { b } = sample, R = sessionReach(b), keep = new Set(days.map((d) => d.td)), rows = R.filter((s) => keep.has(s.td) && Number.isFinite(s.up));
  const fixedPctUp = q(prior.map((s) => s.up), 1 - miss), fixedPctDn = q(prior.map((s) => s.dn), 1 - miss), fixedAdrUp = q(prior.map((s) => s.upAdr), 1 - miss), fixedAdrDn = q(prior.map((s) => s.dnAdr), 1 - miss);
  const cf = conformalLevels(b, { miss, gamma: 0.1 }), tr = reachLevels(b, { sessions: 60, q: 1 - miss });
  const out = { "fixed %": [0, 0, 0], "trailing %": [0, 0, 0], "ADR multiple": [0, 0, 0], conformal: [0, 0, 0] };
  const add = (name, up, dn, s) => {
    const o = out[name], width = (up + dn) / 2;
    if (!Number.isFinite(width)) return;
    o[0] += (s.up > up ? 1 : 0) + (s.dn > dn ? 1 : 0); o[1] += 2; o[2] += width * 2;
  };
  for (const s of rows) {
    const a = s.rthA, pc = (x) => (100 * x) / s.raw;
    add("fixed %", fixedPctUp, fixedPctDn, s);
    add("ADR multiple", pc(fixedAdrUp * s.adr), pc(fixedAdrDn * s.adr), s);
    add("trailing %", pc(tr.up[a] - s.base), pc(s.base - tr.dn[a]), s);
    add("conformal", pc(cf.up[a] - s.base), pc(s.base - cf.dn[a]), s);
  }
  return Object.fromEntries(Object.entries(out).map(([k, [m, n, w]]) => [k, { miss: (100 * m) / n, width: w / n, n }]));
}
const rows = [];
for (const miss of MISSES) {
  console.log(`\nAIM: ${miss * 100}% of sides broken. Broken %, and the mean distance of the band in %.`);
  const A = score(real, real.days, miss), H1 = score(real, real.days.filter((d) => d.half === 0), miss), H2 = score(real, real.days.filter((d) => d.half === 1), miss), F = score(fwd, fwd.days, miss);
  for (const k of Object.keys(A)) {
    rows.push({ aim: miss * 100, way: k, y: A[k], h1: H1[k], h2: H2[k], fwd: F[k] });
    console.log(`  ${k.padEnd(14)} 2026 ${A[k].miss.toFixed(1).padStart(5)}% at ${A[k].width.toFixed(2)}%   Jan-Mar ${H1[k].miss.toFixed(1).padStart(5)}%  Apr-Jul ${H2[k].miss.toFixed(1).padStart(5)}%   forward ${F[k].miss.toFixed(1).padStart(5)}% at ${F[k].width.toFixed(2)}%`);
  }
}
// the mean absolute error from the aim, over the four periods
console.log(`\nMEAN MISS FROM THE AIM, points, over 2026's halves and forward:`);
const sum = {};
for (const r of rows) { (sum[r.way] ||= []).push(Math.abs(r.h1.miss - r.aim), Math.abs(r.h2.miss - r.aim), Math.abs(r.fwd.miss - r.aim)); }
for (const [k, a] of Object.entries(sum)) console.log(`  ${k.padEnd(14)} ${P.mean(a).toFixed(1)}`);
fs.writeFileSync(new URL("./pct_conformal_results.json", import.meta.url), JSON.stringify({ rows, summary: Object.fromEntries(Object.entries(sum).map(([k, a]) => [k, P.mean(a)])) }));
