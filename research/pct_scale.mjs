// Why real days are tighter than noise: at what time scale does NQ revert?
//
//   node --max-old-space-size=8192 research/pct_scale.mjs [paths]
//
// RESULT (2026): no time scale carries anything. Variance ratios sit between 0.92 and 1.02 up
// to 2 hours, with no z past 1.5, and the mean RTH range stays 1.51-1.57% however long the
// flipped blocks are, against 1.53% real. The first version of this file reported real days
// 25% tighter than noise. That was a bug: a path has no drift, sat below 2026's rally, and
// read the same points as a bigger percentage. The block flip caught it, since flipping whole
// days cannot change a day's range, and placeboBars now carries each bar's real price.
// A placebo market (lib_levels.mjs placeboBars) keeps every 1-minute bar and flips each at
// random, so its daily range is what those bars add up to if nothing connects them. Real
// days are narrower. Two measures say where the difference comes from:
//
//   VARIANCE RATIO  The variance of H-minute returns over H times the 1-minute variance.
//                   1 is a random walk, under 1 is reversion, over 1 is momentum.
//   BLOCK PLACEBOS  The same flip by whole blocks of L minutes: everything inside a block
//                   is kept, everything between blocks is destroyed. As L grows the
//                   placebo range falls towards the real one, and the L where it arrives
//                   is the scale the reversion lives at. This is the dependence spectrum.
//
// Writes research/pct_scale_results.json.

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import * as P from "./lib_pct.mjs";
import { rawOffsets, anchorOf } from "../src/levels.mjs";

const PATHS = Number(process.argv[2]) || 300, t0 = Date.now();
const real = P.loadReal(), fwd = P.loadForward();

// Returns of RTH minutes, per session: this path's move over the market's real price then.
function vr(sample, H) {
  const { b, days } = sample, off = rawOffsets(b), C = b.close, ret = (i, j) => (C[j] - C[i]) / (C[i] - off[i]);
  let m1 = 0, n1 = 0, mH = 0, nH = 0, s = 0, c = 0;
  for (const d of days) for (let i = d.a + 1; i < d.z; i++) { s += ret(i - 1, i); c++; }
  const mu = s / c;
  for (const d of days) {
    for (let i = d.a + 1; i < d.z; i++) { const r = ret(i - 1, i) - mu; m1 += r * r; n1++; }
    for (let i = d.a; i + H < d.z; i += H) { const r = ret(i, i + H) - mu * H; mH += r * r; nH++; }
  }
  return mH / nH / (H * (m1 / n1));
}

// The real day's size, for the block flip below.
function sizes(sample) {
  const { b, days } = sample, S = anchorOf(b, "settle"), off = rawOffsets(b), { high: H, low: L, close: C } = b;
  let range = 0, chg = 0, n = 0;
  for (const d of days) {
    const s = S[d.a], raw = s - off[d.a];
    if (!(s === s)) continue;
    let hi = -Infinity, lo = Infinity;
    for (let i = d.a; i < d.z; i++) { if (H[i] > hi) hi = H[i]; if (L[i] < lo) lo = L[i]; }
    range += (100 * (hi - lo)) / raw; chg += (100 * Math.abs(C[d.z - 1] - s)) / raw; n++;
  }
  return { range: range / n, chg: chg / n };
}

const HS = [2, 3, 5, 10, 15, 30, 60, 120, 240, 389], BLOCKS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 240, 1440];
console.log(`VARIANCE RATIOS, RTH, 2026 (${real.days.length} sessions). 1 is a random walk.`);
const vrRows = [];
for (const H of HS) {
  const x = vr(real, H), a = vr({ ...real, days: real.days.filter((d) => d.half === 0) }, H), c = vr({ ...real, days: real.days.filter((d) => d.half === 1) }, H), f = vr(fwd, H);
  const d = [];
  for (let p = 0; p < PATHS; p++) d.push(vr({ ...real, b: Lab.placeboBars(real.b, 9000 + p) }, H));
  const m = P.mean(d), sd = P.sdOf(d), z = (x - m) / sd;
  vrRows.push({ H, vr: x, h1: a, h2: c, fwd: f, noise: m, sd, z, p: Lab.zToP(z) });
  console.log(`  ${String(H).padStart(3)} min   VR ${x.toFixed(3)}   Jan-Mar ${a.toFixed(3)}  Apr-Jul ${c.toFixed(3)}  forward ${f.toFixed(3)}   noise ${m.toFixed(3)} sd ${sd.toFixed(3)}  z ${P.f1(z)}`);
}

console.log(`\nBLOCK PLACEBOS: the mean RTH range and |close from settlement| as more of the day is kept.`);
const r0 = sizes(real), f0 = sizes(fwd);
console.log(`  real 2026  range ${r0.range.toFixed(2)}%   |close| ${r0.chg.toFixed(2)}%     forward ${f0.range.toFixed(2)}%  ${f0.chg.toFixed(2)}%`);
const blockRows = [];
for (const L of BLOCKS) {
  const a = [], c = [], fa = [];
  for (let p = 0; p < Math.min(PATHS, 150); p++) {
    const s = sizes({ ...real, b: Lab.placeboBars(real.b, 20000 + p, L) });
    a.push(s.range); c.push(s.chg);
    fa.push(sizes({ ...fwd, b: Lab.placeboBars(fwd.b, 30000 + p, L) }).range);
  }
  const m = P.mean(a), sd = P.sdOf(a), z = (r0.range - m) / sd;
  blockRows.push({ L, range: m, sd, z, chg: P.mean(c), fwdRange: P.mean(fa) });
  console.log(`  flip every ${String(L).padStart(4)} min  range ${m.toFixed(2)}% (sd ${sd.toFixed(2)})  real vs this z ${P.f1(z)}   |close| ${P.mean(c).toFixed(2)}%   forward range ${P.mean(fa).toFixed(2)}%`);
}
fs.writeFileSync(new URL("./pct_scale_results.json", import.meta.url), JSON.stringify({ sessions: real.days.length, real: r0, forward: f0, vr: vrRows, blocks: blockRows }));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
