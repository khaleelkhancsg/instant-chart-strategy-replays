// How far NQ goes from settlement, in percent, and how often it comes back.
//
//   node --max-old-space-size=8192 research/pct_map.mjs [paths]
//
// RESULT (2026, 132 sessions, 300 placebo markets): the ranges are real numbers and worth
// knowing, but they are what volatility alone gives. RTH's median range is 1.42%, and it
// trades back to settlement on 55% of days, 54% on noise. A day reaches 1% either side on 73%,
// 73% on noise; 2% on 24%, 25% on noise. Opening 0.5-1% away it comes back 46%, 43% on noise;
// 1% or more away, 15%, 17% on noise. The high or low prints in the first hour on 85%, 81% on
// noise: mostly Levy's arcsine law. Of 134 cells of time and distance with 15+ days, 5 reach
// p < 0.05, where chance gives 7, and the lowest q is 1.00.
// Everything is a percentage of the contract's real price. Each rate is set beside what
// the same rule does on placebo markets (lib_levels.mjs placeboBars): same bars, same
// volatility, no memory. A rate that matches the placebo is geometry, not behaviour.
//
// Writes research/pct_map_results.json.

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import * as P from "./lib_pct.mjs";
import { anchorOf, rawOffsets } from "../src/levels.mjs";

const PATHS = Number(process.argv[2]) || 200, t0 = Date.now();
const real = P.loadReal(), fwd = P.loadForward();
console.log(`${real.days.length} sessions in 2026, ${fwd.days.length} forward`);

const CHECKS = [[540, "09:00"], [570, "09:30"], [600, "10:00"], [630, "10:30"], [660, "11:00"], [720, "12:00"], [780, "13:00"], [840, "14:00"]];
const DIST = [[0.1, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1], [1, 1.5], [1.5, 2], [2, 99]];
const REACH = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
const bucket = (x) => DIST.findIndex(([a, b]) => x >= a && x < b);
const distName = (k) => (DIST[k][1] > 9 ? `${DIST[k][0]}%+` : `${DIST[k][0]}-${DIST[k][1]}%`);

function map(sample) {
  const { b, days } = sample, { open: O, high: H, low: L, close: C, ctMin: CT } = b;
  const S = anchorOf(b, "settle"), off = rawOffsets(b), rthO = anchorOf(b, "rth");
  const out = {}, put = (name, k, v) => (out[name] ||= []).push([k, v]);
  const reachedFrom = (from, z, p, above) => { for (let i = from; i < z; i++) if (above ? L[i] <= p : H[i] >= p) return true; return false; };
  days.forEach((d, k) => {
    const { a, z } = d, s = S[a], raw = s - off[a], pc = (x) => (100 * x) / raw, last = z - 1;
    if (!(s === s)) return;
    let hi = -Infinity, lo = Infinity, hiAt = a, loAt = a;
    for (let i = a; i < z; i++) { if (H[i] > hi) { hi = H[i]; hiAt = i; } if (L[i] < lo) { lo = L[i]; loAt = i; } }
    let onHi = -Infinity, onLo = Infinity;
    for (let i = d.sa; i < a; i++) { if (H[i] > onHi) onHi = H[i]; if (L[i] < onLo) onLo = L[i]; }
    const gap = pc(O[a] - s), up = pc(hi - s), dn = pc(s - lo), range = pc(hi - lo), chg = pc(C[last] - s);
    // ── the size of a day
    put("size: RTH range %", k, range); put("size: RTH high above settlement %", k, up); put("size: RTH low below settlement %", k, dn);
    put("size: abs gap at the open %", k, Math.abs(gap)); put("size: abs close from settlement %", k, Math.abs(chg));
    put("size: overnight + RTH range %", k, pc(Math.max(hi, onHi) - Math.min(lo, onLo)));
    // ── back to settlement
    const above = O[a] > s, touched = above ? lo <= s : hi >= s;
    put("settlement: RTH trades back to it", k, touched ? 1 : 0);
    const size = Math.abs(gap), g = size < 0.1 ? "under 0.1%" : size < 0.25 ? "0.1-0.25%" : size < 0.5 ? "0.25-0.5%" : size < 1 ? "0.5-1%" : "1%+";
    put(`settlement: opens ${above ? "above" : "below"} by ${g}, trades back`, k, touched ? 1 : 0);
    put(`settlement: opens ${g} away, trades back`, k, touched ? 1 : 0);
    if (touched) { let t = a; for (; t < z; t++) if (above ? L[t] <= s : H[t] >= s) break; put("settlement: of those, in the first 30 minutes", k, t - a < 30 ? 1 : 0); put("settlement: of those, in the first hour", k, t - a < 60 ? 1 : 0); }
    put("settlement: RTH closes on the side it opened", k, (C[last] > s) === above ? 1 : 0);
    put("settlement: a day trades both sides of it", k, hi > s && lo < s ? 1 : 0);
    // ── the map: at this time, this far away, is settlement reached by 15:00?
    for (const [ct, name] of CHECKS) {
      let t = -1;
      for (let i = a; i < z; i++) if (CT[i] >= ct) { t = i; break; }
      if (t < 0 || t + 1 >= z) continue;
      for (const [anchorName, A] of [["settlement", s], ["RTH open", O[a]]]) {
        const x = pc(Math.abs(C[t] - A)), q = bucket(x);
        if (q < 0) continue;
        const ab = C[t] > A;
        put(`map ${anchorName} | ${name} | ${distName(q)}`, k, reachedFrom(t + 1, z, A, ab) ? 1 : 0);
        put(`beyond ${anchorName} | ${name} | ${distName(q)}`, k, (ab ? C[last] > C[t] : C[last] < C[t]) ? 1 : 0);
      }
    }
    // ── how far a day reaches
    for (const x of REACH) {
      put(`reach: +${x}% above settlement`, k, up >= x ? 1 : 0);
      put(`reach: -${x}% below settlement`, k, dn >= x ? 1 : 0);
      put(`reach: either side ${x}%`, k, up >= x || dn >= x ? 1 : 0);
      put(`reach: RTH range ${x}%`, k, range >= x ? 1 : 0);
      if (up >= x || dn >= x) put(`reach: having hit ${x}%, closes beyond it`, k, (up >= x && chg >= x) || (dn >= x && chg <= -x) ? 1 : 0);
    }
    // ── when the day's extremes print: Levy's arcsine law says early and late
    const hiT = hiAt - a, loT = loAt - a, len = z - a;
    put("extreme: the high in the first 30 minutes", k, hiT < 30 ? 1 : 0); put("extreme: the low in the first 30 minutes", k, loT < 30 ? 1 : 0);
    put("extreme: the high or the low in the first 30 minutes", k, hiT < 30 || loT < 30 ? 1 : 0); put("extreme: the high or the low in the first hour", k, hiT < 60 || loT < 60 ? 1 : 0);
    put("extreme: the high or the low in the last hour", k, len - hiT <= 60 || len - loT <= 60 ? 1 : 0); put("extreme: both between 10:30 and 13:30", k, hiT >= 120 && hiT < 300 && loT >= 120 && loT < 300 ? 1 : 0);
  });
  return out;
}

const rows = P.testRates(map, real, fwd, { paths: PATHS });
const quant = {};
for (const [name, s] of [["2026", real], ["Jan-Mar", { ...real, days: real.days.filter((d) => d.half === 0) }], ["Apr-Jul", { ...real, days: real.days.filter((d) => d.half === 1) }], ["forward", fwd]]) {
  const m = map(s);
  quant[name] = {};
  for (const [k, a] of Object.entries(m)) if (k.startsWith("size:")) { const v = a.map((x) => x[1]).sort((x, y) => x - y); quant[name][k] = { n: v.length, q10: P.quantile(v, 0.1), q25: P.quantile(v, 0.25), q50: P.quantile(v, 0.5), q75: P.quantile(v, 0.75), q90: P.quantile(v, 0.9), q95: P.quantile(v, 0.95), max: v[v.length - 1] }; }
}
fs.writeFileSync(new URL("./pct_map_results.json", import.meta.url), JSON.stringify({ paths: PATHS, sessions: real.days.length, forward: fwd.days.length, quant, rows }));

const size = (r) => `${r.name.padEnd(46)} ${r.rate.toFixed(2).padStart(6)}  noise ${r.placebo.toFixed(2).padStart(6)}`;
const show = (r) => `${r.name.padEnd(56)} ${r.rate.toFixed(0).padStart(4)}%  noise ${r.placebo.toFixed(0).padStart(3)}%  ${P.f1(r.excess).padStart(6)}  z${P.f1(r.z).padStart(5)}  q${r.q.toFixed(2)}  n${String(r.n).padEnd(4)} ${r.h1.toFixed(0).padStart(3)} ${r.h2.toFixed(0).padStart(3)}  fwd ${Number.isNaN(r.fwd) ? "  -" : r.fwd.toFixed(0).padStart(3)}% (${r.fwdN})`;
console.log(`\nTHE SIZE OF A DAY, % of price: quantiles, 2026`);
for (const [k, v] of Object.entries(quant["2026"])) console.log(`${k.padEnd(40)} p10 ${v.q10.toFixed(2)}  p25 ${v.q25.toFixed(2)}  p50 ${v.q50.toFixed(2)}  p75 ${v.q75.toFixed(2)}  p90 ${v.q90.toFixed(2)}  p95 ${v.q95.toFixed(2)}  max ${v.max.toFixed(2)}`);
console.log(`\nMean size, real against noise (scale 100 is a display artefact: divide by 100):`);
for (const r of rows.filter((r) => r.name.startsWith("size:"))) console.log(size({ ...r, rate: r.rate / 100, placebo: r.placebo / 100 }));
for (const [title, pre] of [["BACK TO SETTLEMENT", "settlement:"], ["HOW FAR A DAY REACHES", "reach:"], ["WHEN THE EXTREMES PRINT", "extreme:"]]) {
  console.log(`\n${title}`);
  for (const r of rows.filter((r) => r.name.startsWith(pre))) console.log(show(r));
}
console.log(`\nTHE MAP, strongest 25 by z (at this time, this far away)`);
for (const r of rows.filter((r) => /^(map|beyond) /.test(r.name) && r.n >= 15).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 25)) console.log(show(r));
const m = rows.filter((r) => /^(map|beyond) /.test(r.name) && r.n >= 15);
console.log(`\n${m.length} map cells with 15+ days. p < 0.05 by chance about ${Math.round(m.length * 0.05)}; got ${m.filter((r) => r.p < 0.05).length}. Lowest q ${Math.min(...m.map((r) => r.q)).toFixed(2)}.`);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
