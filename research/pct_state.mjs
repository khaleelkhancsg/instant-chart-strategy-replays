// Is a big move so far a reason for the rest of the day to follow it, or to reverse it?
//
//   node --max-old-space-size=8192 research/pct_state.mjs [paths]
//
// RESULT (2026, 300 placebo markets): nothing. Of 72 cells with 15+ days none reaches p < 0.05,
// where chance gives about 4, and the lowest q is 1.00. Late-day momentum is absent: from
// 14:30, with the day's move, -0.004%, noise 0.000%, forward -0.055%.
// Three ways of asking, each against placebo markets:
//
//   THE RANK     Where today's move from settlement ranks among the last 60 days at this
//                same minute (src/levels.mjs moveFan), so 95 means a move only 1 day in 20
//                has made by now. The percentage is relative to the clock, which a fixed
//                percentage is not: +0.8% means little at 14:30 and a lot at 08:45.
//   THE NOISE    The same question for the noise area, the band the paper trades breaks of.
//   LATE DAY     Leveraged ETFs must buy into the close on up days and sell on down days, in
//                proportion to the day's percentage move, and short-gamma dealers hedge the
//                same way (Baltussen et al. 2021). So the last half hour should carry on
//                in the day's direction, more on big days. That is a percentage rule with
//                a mechanism behind it, and needs no level at all.
//
// Each is measured in points of the day's direction, from the check to 15:00 CT.
//
// Writes research/pct_state_results.json.

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import * as P from "./lib_pct.mjs";
import { moveFan, noiseArea, anchorOf, rawOffsets } from "../src/levels.mjs";

const PATHS = Number(process.argv[2]) || 300, t0 = Date.now();
const real = P.loadReal(), fwd = P.loadForward();
const CHECKS = [[570, "09:30"], [600, "10:00"], [660, "11:00"], [720, "12:00"], [780, "13:00"], [840, "14:00"], [870, "14:30"]];
const BANDS = [[0, 5], [5, 15], [15, 35], [35, 65], [65, 85], [85, 95], [95, 101]];

function cells(sample) {
  const { b, days } = sample, { close: C, ctMin: CT } = b, out = {}, put = (name, k, v) => (out[name] ||= []).push([k, v]);
  const fan = moveFan(b, {}), noise = noiseArea(b, {}), S = anchorOf(b, "settle"), off = rawOffsets(b);
  days.forEach((d, k) => {
    const end = C[d.z - 1], s = S[d.a];
    if (!(s === s)) return;
    const raw = s - off[d.a];
    for (const [ct, name] of CHECKS) {
      let t = -1;
      for (let i = d.a; i < d.z; i++) if (CT[i] >= ct) { t = i; break; }
      if (t < 0 || t + 1 >= d.z) continue;
      const rest = (100 * (end - C[t])) / raw;                     // % to the close, up positive
      const q = BANDS.findIndex(([a, z]) => fan.rank[t] >= a && fan.rank[t] < z);
      if (q >= 0) put(`rank ${BANDS[q][0]}-${Math.min(100, BANDS[q][1])} | ${name}`, k, rest);
      // pooled by how extreme, in the direction of the move
      const dir = C[t] > s ? 1 : C[t] < s ? -1 : 0, ext = Math.abs(fan.rank[t] - 50);
      if (dir && Number.isFinite(ext)) put(`${ext >= 45 ? "1 in 10 day" : ext >= 35 ? "1 in 3 day" : "ordinary day"}, with the move | ${name}`, k, dir * rest);
      const up = noise.up[t], dn = noise.dn[t];
      if (Number.isFinite(up)) { if (C[t] > up) put(`above the noise area, long | ${name}`, k, rest); else if (C[t] < dn) put(`below the noise area, short | ${name}`, k, -rest); else put(`inside the noise area, with the move | ${name}`, k, dir * rest); }
      if (ct >= 840) {
        const size = (100 * Math.abs(C[t] - s)) / raw, g = size < 0.5 ? "under 0.5%" : size < 1 ? "0.5-1%" : size < 2 ? "1-2%" : "2%+";
        if (dir) { put(`late day: day ${g} so far, with the move | ${name}`, k, dir * rest); put(`late day: every day, with the move | ${name}`, k, dir * rest); }
      }
    }
  });
  return out;
}
const rows = P.testRates(cells, real, fwd, { paths: PATHS, scale: 1, seed: 70000 });
fs.writeFileSync(new URL("./pct_state_results.json", import.meta.url), JSON.stringify({ paths: PATHS, sessions: real.days.length, rows }));
const show = (r) => `${r.name.padEnd(52)} ${P.f1(r.rate, 3).padStart(7)}%  noise ${P.f1(r.placebo, 3).padStart(7)}  ${P.f1(r.excess, 3).padStart(7)}  z${P.f1(r.z).padStart(5)}  q${r.q.toFixed(2)}  n${String(r.n).padEnd(4)} ${P.f1(r.h1, 3).padStart(7)} ${P.f1(r.h2, 3).padStart(7)}  fwd ${Number.isNaN(r.fwd) ? "     -" : P.f1(r.fwd, 3).padStart(7)} (${r.fwdN})`;
console.log(`% to the close, against noise; Jan-Mar, Apr-Jul, forward.`);
console.log(`\nLATE DAY`);
for (const r of rows.filter((r) => r.name.startsWith("late day"))) console.log(show(r));
console.log(`\nTHE NOISE AREA`);
for (const r of rows.filter((r) => r.name.includes("noise area"))) console.log(show(r));
console.log(`\nBY HOW EXTREME, with the move`);
for (const r of rows.filter((r) => /day, with the move/.test(r.name) && !r.name.startsWith("late"))) console.log(show(r));
console.log(`\nSTRONGEST 20 of all, 15+ days`);
for (const r of rows.filter((r) => r.n >= 15).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 20)) console.log(show(r));
const big = rows.filter((r) => r.n >= 15);
console.log(`\n${big.length} cells. p < 0.05 by chance about ${Math.round(big.length * 0.05)}; got ${big.filter((r) => r.p < 0.05).length}. Lowest q ${Math.min(...big.map((r) => r.q)).toFixed(3)}.`);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
