// Shared by the percentage-level studies (research/pct_*.mjs).
//
// The samples are the level study's: 2026 to the end of the lab's data, and the forward
// bars, which nothing here is chosen on. The forward file is every TopstepX bar saved so
// far, built by prepare.mjs, so its rolls are found the same way as the main file's:
//
//   node prepare.mjs --in data/raw/topstepx/mnq_ohlcv-1m.csv --out data/topstepx_raw_1m.bin
//
// testRates() is the placebo harness of levels_theories.mjs for any rule: what comes true
// on placebo markets is what the geometry gives for free, and only the excess says
// anything about the market.

import { fileURLToPath } from "node:url";
import * as Lab from "./lib_levels.mjs";

export const FWD_FILE = fileURLToPath(new URL("../data/topstepx_raw_1m.bin", import.meta.url));
export const FWD_FROM = Date.UTC(2026, 8, 11);
export const loadReal = () => Lab.loadSample({ to: Date.UTC(2026, 6, 15) });
export const loadForward = () => Lab.loadSample({ file: FWD_FILE, from: FWD_FROM, warmDays: 12 });

export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
export const sdOf = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
export const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN);
export const f1 = (x, d = 1) => (x == null || Number.isNaN(x) ? "-" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}`);

// log(this bar / the median of its clock minute over the last 20 sessions), RTH only.
export function excessOf(b, sessions, val) {
  const n = b.close.length, out = new Float32Array(n).fill(NaN), hist = new Map();
  for (const s of sessions) {
    for (let i = s.rthA; i < s.rthZ; i++) {
      const h = hist.get(b.ctMin[i]);
      if (h && h.length >= 10) { const v = h.slice().sort((x, y) => x - y), m = v[v.length >> 1]; if (m > 0 && val(i) > 0) out[i] = Math.log(val(i) / m); }
    }
    for (let i = s.rthA; i < s.rthZ; i++) { let h = hist.get(b.ctMin[i]); if (!h) hist.set(b.ctMin[i], (h = [])); h.push(val(i)); if (h.length > 20) h.shift(); }
  }
  return out;
}

// fn(sample) returns { name: [[dayIndex, value], ...] }. Every name gets its mean on the
// real bars, on each half, on the forward bars, and against `paths` placebo markets.
const avg = (a) => (a && a.length ? mean(a.map((x) => x[1])) : NaN);
export function testRates(fn, real, fwd, { paths = 200, scale = 100, seed = 7000, log = true } = {}) {
  const t0 = Date.now(), R = fn(real), dist = {};
  for (let p = 0; p < paths; p++) {
    const res = fn({ ...real, b: Lab.placeboBars(real.b, seed + p) });
    for (const [k, a] of Object.entries(res)) (dist[k] ||= []).push(avg(a) * scale);
    if (log && (p + 1) % 50 === 0) console.log(`  ${p + 1} of ${paths} placebo paths, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  const F = fwd ? fn(fwd) : {}, half = (a, h) => a.filter(([k]) => real.days[k].half === h);
  const rows = Object.entries(R).map(([name, a]) => {
    const d = dist[name] || [], placebo = mean(d), sd = sdOf(d), rate = avg(a) * scale, z = sd > 0 ? (rate - placebo) / sd : 0;
    return { name, n: a.length, rate, placebo, sd, excess: rate - placebo, z, p: Lab.zToP(z), h1: avg(half(a, 0)) * scale, h2: avg(half(a, 1)) * scale, fwd: avg(F[name]) * scale, fwdN: (F[name] || []).length };
  });
  const q = Lab.bh(rows.map((r) => r.p));
  rows.forEach((r, i) => { r.q = q[i]; });
  return rows;
}
