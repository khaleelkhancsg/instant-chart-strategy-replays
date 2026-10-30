// What traders say levels do, tested: each saying as a rule, on 2026 and on the forward
// bars, against how often the same rule comes true on placebo markets.
//
//   node --max-old-space-size=8192 research/levels_theories.mjs [paths]
//
// RESULT (2026, 500 placebo markets): none of the 33 sayings beats noise; the lowest q is
// 0.86. Most are geometry: a gap under 10% of the ADR fills 95% of the time and 94% on
// noise, a +-2 sigma touch returns to VWAP 67% and 69%, the side of the developing POC at
// 10:30 calls the afternoon 49% and 50%. Stop runs at the prior day's extremes reach the
// far side less often than noise does (33% and 41%).
// The placebo is the point. A saying can come true often for geometric reasons alone:
// a narrow value area is easy to cross, a small gap is easy to fill. On a placebo path
// (lib_levels.mjs placeboBars) the bars keep their sizes and volatility but carry no
// memory, so what comes true there is what the geometry gives for free. Only the
// excess says anything about the market.
//
// Each rule returns, per setup, whether it came true. Levels are rebuilt on each path.
// Writes research/levels_theories_results.json.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as Lab from "./lib_levels.mjs";
import { priorProfile, developingProfile, initialBalance, nakedPocs, firstRange, weekOf } from "../src/levels.mjs";

const PATHS = Number(process.argv[2]) || 100, t0 = Date.now();

function theories(sample) {
  const { b, days } = sample, { open: O, high: H, low: L, close: C, ctMin: CT } = b, S = (t, tf, p) => Lab.studyLines(sample, t, tf, p);
  const out = {}, put = (name, d, hit) => (out[name] ||= []).push([d, hit ? 1 : 0]);
  const pv = priorProfile(b, { anchor: "rth" }), dv = developingProfile(b, { anchor: "rth" }), dl = S("daylevels", 1), on = S("clockrange", 1, { span: "overnight" }), ib = initialBalance(b, { minutes: 60 });
  const or15 = S("openrange", 1, { minutes: 15 }), v2 = S("vwap", 1, { anchor: "rth", bands: 2 }), nk = nakedPocs(b, { maxAge: 20 }), mon = firstRange(b, { period: "week", sessions: 1 });
  const reached = (from, z, price) => { for (let i = from; i < z; i++) if (L[i] <= price && H[i] >= price) return true; return false; };
  const barAt = (d, ct) => { for (let i = d.a; i < d.z; i++) if (CT[i] >= ct) return i; return -1; };

  days.forEach((d, k) => {
    const { a, z, U } = d, o = O[a], last = z - 1, VAH = pv.vah[a - 1], VAL = pv.val[a - 1], PDH = dl.PDH[a - 1], PDL = dl.PDL[a - 1], PDC = dl.PDC[a - 1];
    const closeRth = C[last];
    // ── the 80% rule: open outside value, two half-hour closes back inside, cross it
    if (Number.isFinite(VAH) && (o > VAH || o < VAL)) {
      let run = 0;
      for (let i = a + 29; i < z; i += 30) {
        const inside = C[i] <= VAH && C[i] >= VAL;
        run = inside ? run + 1 : 0;
        if (run === 2) { put("80% rule: back in value, crosses it by the close", k, reached(i + 1, z, o > VAH ? VAL : VAH)); break; }
      }
      put("Open outside value: closes outside on that side", k, o > VAH ? closeRth > VAH : closeRth < VAL);
    }
    if (Number.isFinite(VAH) && o <= VAH && o >= VAL) put("Open inside value: closes inside value", k, closeRth <= VAH && closeRth >= VAL);
    // ── gaps
    if (Number.isFinite(PDC)) {
      const gap = Math.abs(o - PDC) / U;
      const name = gap < 0.1 ? "Gap under 10% of ADR fills by the close" : gap < 0.25 ? "Gap 10-25% of ADR fills by the close" : gap < 0.5 ? "Gap 25-50% of ADR fills by the close" : "Gap over 50% of ADR fills by the close";
      put(name, k, reached(a, z, PDC));
      if (gap >= 0.1) put("Gap over 10% fills in the first hour", k, reached(a, Math.min(z, a + 60), PDC));
    }
    // ── the initial balance
    const ih = ib.hi[a + 60], il = ib.lo[a + 60];
    if (Number.isFinite(ih)) {
      let first = 0, both = false, at = -1;
      for (let i = a + 60; i < z; i++) {
        if (!first) { if (H[i] > ih) { first = 1; at = i; } else if (L[i] < il) { first = -1; at = i; } }
        if (first === 1 && L[i] < il) both = true;
        if (first === -1 && H[i] > ih) both = true;
      }
      put("IB is broken on at least one side", k, first !== 0);
      if (first) {
        put("Day breaks the IB, and never the other side", k, !both);
        put("First IB break: close beyond that side", k, first === 1 ? closeRth > ih : closeRth < il);
        const w = ih - il;
        put("First IB break reaches 1× the IB beyond it", k, reached(at, z, first === 1 ? ih + w : il - w));
      }
      if (ih - il < 0.25 * U) put("Narrow IB (under 25% of ADR) is broken", k, first !== 0);
    }
    // ── the overnight range
    const onh = on.high[a], onl = on.low[a];
    if (Number.isFinite(onh) && o <= onh && o >= onl) {
      const up = reached(a, z, onh + 0.25), dn = reached(a, z, onl - 0.25);
      put("Open inside overnight range: one side is taken", k, up || dn);
      put("Open inside overnight range: both sides are taken", k, up && dn);
    }
    // ── stop runs: through a level by a tick, back inside within 15 minutes
    for (const [name, lvl, dir, target] of [["PD high", PDH, 1, (PDH + PDL) / 2], ["PD low", PDL, -1, (PDH + PDL) / 2], ["Overnight high", onh, 1, onl], ["Overnight low", onl, -1, onh]]) {
      if (!Number.isFinite(lvl) || !(dir === 1 ? o < lvl : o > lvl)) continue;
      for (let i = a; i < z; i++) {
        if (!(dir === 1 ? H[i] > lvl : L[i] < lvl)) continue;
        let back = -1;
        for (let j = i; j < Math.min(z, i + 15); j++) if (dir === 1 ? C[j] < lvl : C[j] > lvl) { back = j; break; }
        if (back >= 0) put(`Stop run at ${name}: reaches the far side (mid, or the other extreme)`, k, reached(back + 1, z, target));
        else put(`Clean break of ${name}: still beyond it at the close`, k, dir === 1 ? closeRth > lvl : closeRth < lvl);
        break;
      }
    }
    // ── the prior day's range
    if (Number.isFinite(PDH) && o < PDH && o > PDL) put("Open inside the prior day's range: reaches one end", k, reached(a, z, PDH) || reached(a, z, PDL));
    // ── VWAP stretch
    for (let i = a + 30; i < z; i++) {
      const up = v2["+2σ"][i - 1], dn = v2["−2σ"][i - 1];
      if (CT[i] >= 780 || !Number.isFinite(up)) continue;
      if (H[i] >= up || L[i] <= dn) { put("Touch of ±2σ before 13:00: back to VWAP by the close", k, reached(i + 1, z, v2.VWAP[i])); break; }
    }
    // ── the opening range
    const orH = or15["OR high"][a + 15], orL = or15["OR low"][a + 15];
    if (Number.isFinite(orH)) {
      for (let i = a + 15; i < z; i++) {
        if (C[i] > orH || C[i] < orL) { const dir = C[i] > orH ? 1 : -1; put("First close beyond OR15: the close stays beyond it", k, dir === 1 ? closeRth > orH : closeRth < orL); break; }
      }
    }
    // ── above or below the developing POC, as a forecast of the afternoon
    const t = barAt(d, 630);
    if (t > 0 && Number.isFinite(dv.poc[t]) && C[t] !== dv.poc[t]) {
      const side = C[t] > dv.poc[t] ? 1 : -1;
      if (closeRth !== C[t]) put("At 10:30 above or below the developing POC: the rest of the day follows", k, side * (closeRth - C[t]) > 0);
    }
    // ── naked POCs as magnets
    if (Number.isFinite(nk.above[a - 1]) && (nk.above[a - 1] - o) / U < 0.5) put("Naked POC within half an ADR above: reached", k, reached(a, z, nk.above[a - 1]));
    if (Number.isFinite(nk.below[a - 1]) && (o - nk.below[a - 1]) / U < 0.5) put("Naked POC within half an ADR below: reached", k, reached(a, z, nk.below[a - 1]));
    // ── ADR exhaustion
    let hi = -Infinity, lo = Infinity, done = false;
    for (let i = a; i < z && !done; i++) {
      hi = Math.max(hi, H[i]); lo = Math.min(lo, L[i]);
      if (hi - lo >= U && CT[i] < 720) { done = true; let h2 = hi, l2 = lo; for (let j = i + 1; j < z; j++) { h2 = Math.max(h2, H[j]); l2 = Math.min(l2, L[j]); } put("Full ADR before noon: the range grows 25% more", k, h2 - l2 >= 1.25 * U); }
    }
  });
  // ── the week
  const weeks = new Map();
  days.forEach((d, k) => { const w = weekOf(d.td); if (!weeks.has(w)) weeks.set(w, []); weeks.get(w).push({ d, k }); });
  for (const list of weeks.values()) {
    if (list.length < 4) continue;
    const lastD = list[list.length - 1], end = C[lastD.d.z - 1], from = list[1].d;
    const hi = mon.hi[from.a + 5], lo = mon.lo[from.a + 5];
    if (Number.isFinite(hi)) {
      let dir = 0;
      for (const { d } of list.slice(1)) { for (let i = d.a; i < d.z && !dir; i++) { if (C[i] > hi) dir = 1; else if (C[i] < lo) dir = -1; } if (dir) break; }
      if (dir) put("First close beyond Monday's range: the week closes beyond it", lastD.k, dir === 1 ? end > hi : end < lo);
      put("The week closes inside Monday's range", lastD.k, end <= hi && end >= lo);
    }
    const open = O[list[0].d.sa], mid = list[2].d.a;
    if (C[mid] !== open) put("Wednesday's open above or below the week's: the week closes that side", lastD.k, Math.sign(C[mid] - open) === Math.sign(end - open));
  }
  return out;
}

const rate = (a) => (a && a.length ? (100 * a.reduce((s, x) => s + x[1], 0)) / a.length : NaN);
const real = Lab.loadSample({ to: Date.UTC(2026, 6, 15) });
const R = theories(real), halfOf = (a, h) => a.filter(([k]) => real.days[k].half === h);
const dist = {};
for (let p = 0; p < PATHS; p++) {
  const res = theories({ ...real, b: Lab.placeboBars(real.b, 5000 + p) });
  for (const [k, a] of Object.entries(res)) (dist[k] ||= []).push(rate(a));
  if ((p + 1) % 20 === 0) console.log(`${p + 1} of ${PATHS} placebo paths, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
const fwd = Lab.loadSample({ file: fileURLToPath(new URL("../data/topstepx_1m.bin", import.meta.url)), from: Date.UTC(2026, 8, 11), warmDays: 20 }), F = theories(fwd);

const rows = Object.entries(R).map(([name, a]) => {
  const d = dist[name] || [], mean = d.reduce((x, y) => x + y, 0) / (d.length || 1), sd = Math.sqrt(d.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, d.length - 1));
  const r = rate(a), z = sd > 0 ? (r - mean) / sd : 0;
  return { name, n: a.length, rate: r, placebo: mean, sd, excess: r - mean, z, p: Lab.zToP(z), h1: rate(halfOf(a, 0)), h2: rate(halfOf(a, 1)), fwd: rate(F[name]), fwdN: (F[name] || []).length };
});
const q = Lab.bh(rows.map((r) => r.p));
rows.forEach((r, i) => { r.q = q[i]; });
fs.writeFileSync(new URL("./levels_theories_results.json", import.meta.url), JSON.stringify({ paths: PATHS, rows }));
const f1 = (x) => (Number.isNaN(x) ? "  -" : x.toFixed(0).padStart(3));
console.log(`\n${"saying".padEnd(72)} 2026  noise  excess    z     q   n    Jan-Mar Apr-Jul  forward`);
for (const r of rows.slice().sort((a, b) => Math.abs(b.z) - Math.abs(a.z))) {
  console.log(`${r.name.padEnd(72)} ${f1(r.rate)}%  ${f1(r.placebo)}%  ${`${r.excess >= 0 ? "+" : ""}${r.excess.toFixed(1)}`.padStart(6)} ${`${r.z >= 0 ? "+" : ""}${r.z.toFixed(1)}`.padStart(5)} ${r.q.toFixed(2)} ${String(r.n).padStart(4)}    ${f1(r.h1)}%   ${f1(r.h2)}%    ${f1(r.fwd)}% (${r.fwdN})`);
}
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
