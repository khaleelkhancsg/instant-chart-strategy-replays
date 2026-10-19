// Can the level findings improve the two $1,250 setups? With vs without,
// 2026 ONLY, honest fills, realistic costs, cancelOpposite.
//
// levels_setups_2026.mjs FILTERED signals, which also removed each signal's
// other job: closing or flipping the open trade (most MACD-fade trades end at
// the next cross). Here only the ENTRY is gated -- through the sizer, so every
// signal still closes or flips the open position, and a gated one just places
// no new order (or a smaller one).
//
// Improvements, fixed in advance from the level findings:
//   Donchian  D-a  enter only breakouts that crossed a break-prone level
//                  (prior-day/overnight high/low, round 100) in the last 10 min
//             D-b  half size on breakouts that did not
//   MACD fade A-a  no entry when the push being faded broke a break-prone level
//                  in the last 10 min
//             A-b  enter only when the push ran into a session volume level
//                  (prior-day, 5-, 20-session POC/HVN) within R/2, last 10 bars
//             A-c  both: at a volume level and not through a break-prone one
//             A-d  half size unless the push ran into a volume level
// Nulls (20 runs each): the same gate on random twin levels, and the same
// share of entries gated at random.
//
// RESULT (2026 only): no level rule improves either setup once the exits are
// left alone.
// MACD fade: every entry gate hurts -- A-a 44.8%, A-b 39.8%, A-c 32.9%, A-d
// 37.8%, against 58.5% without -- and gating the same share of entries at
// random hurts even more (median 22-40%). The fade makes its money at the
// open (08:30-09:00 CT entries +$98 a trade in 2026, later ones about -$6);
// skipping entries moves its trading later into the day. The 61.4% "only at
// volume levels" of levels_setups_2026.mjs came from also deleting the other
// signals, so its trades were held to the bracket instead of closed at the
// next cross -- not from where they were entered.
// Donchian: D-a 61.9% and D-b 62.4% against 61.3% without, inside the range of
// random gating (median 57.7 / 60.0, max 70.7 / 70.9), best only at the
// 10-minute look-back, and both worse in April-July (59.4 / 58.2 vs 63.0).
// What this did turn up -- the time of day -- is in timing_improve_2026.mjs.
//
//   node --max-old-space-size=8192 research/levels_improve_2026.mjs

import fs from "node:fs";
import { macd } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const T0 = Date.now();
const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const FILL = { slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: 600, profitBlock: 250, cancelOpposite: true };
const LV = JSON.parse(fs.readFileSync(new URL("./levels_2026.json", import.meta.url), "utf8"));
const dateOf = (tday) => new Date(tday * 86400000).toISOString().slice(0, 10);
const NNULL = 20;

// ---- levels (as levels_setups_2026.mjs) ------------------------------------
const isVpS = (t) => /^(pd_poc|vp5_poc|vp20_poc|vp5_hvn|vp20_hvn)$/.test(t);
const isVpW = (t) => /^(week|month)_(prior_poc|poc_n)$/.test(t);
const isBrk = (t) => /^(prior_day_high|prior_day_low|overnight_high|overnight_low)$/.test(t);
const cache = new Map();
function levelsFor(tday, twin) {
  const key = tday + "|" + twin;
  if (cache.has(key)) return cache.get(key);
  const e = LV[dateOf(tday)];
  let out = null;
  if (e && e.off != null) {
    const R = 0.05 * e.U, rnd = S.mul(tday * 7919 + twin * 104729);
    const sh = () => (twin ? (rnd() < 0.5 ? -1 : 1) * (1.5 + 4.5 * rnd()) * R : 0);
    out = { vpS: [], vpW: [], brk: [], off: e.off, R, rShift: twin ? (1.5 + 4.5 * rnd()) * R : 0 };
    for (const [, t, p] of e.levels) {
      const x = p + e.off + sh();
      if (isVpS(t)) out.vpS.push(x); else if (isVpW(t)) out.vpW.push(x); else if (isBrk(t)) out.brk.push(x);
    }
  }
  cache.set(key, out);
  return out;
}
const anyIn = (arr, lo, hi) => arr.some((p) => p > lo && p <= hi);
const roundIn = (L, lo, hi) => { const a = lo - L.off - L.rShift, b = hi - L.off - L.rShift; return Math.floor(b / 100) * 100 > a; };
const brkIn = (L, lo, hi) => anyIn(L.brk, lo, hi) || roundIn(L, lo, hi);

// ---- setups ------------------------------------------------------------------
const E2 = S.engineFor(2), E1 = S.engineFor(1);
const t2 = E2.tf, t1 = E1.tf, n1 = t1.close.length;
const hist = macd(t1.close, 12, 26, 9).hist;
const SIGA = new Int8Array(n1);
for (let i = 1; i < n1; i++) {
  if (!(t1.ctMin[i] >= 510 && t1.ctMin[i] < 900)) continue;
  SIGA[i] = -(hist[i] > 0 && hist[i - 1] <= 0 ? 1 : hist[i] < 0 && hist[i - 1] >= 0 ? -1 : 0);
}
const exit20 = (k, d, st) => k - st.entBar >= 20 && (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) < st.atr;
const SET = {
  D: { name: "Donchian", E: E2, t: t2, sig: M.RESC, lots: (k) => (M.adrUsed(k) >= 0.9 ? 2 : 4), opts: { exitFn: exit20, breaker: 300 } },
  A: { name: "MACD fade", E: E1, t: t1, sig: SIGA, lots: () => 4,
       opts: { breaker: 200, trig: 0.15, tpFromFill: true, tpFn: (a, q) => Math.min(5.15 * a, 600 / (2 * q)) } },
};
const in26 = (t, k) => S.yearOf.get(t.tday[k]) === 2026;

// features at signal bar k, direction s; null on a day without levels
function crossedBrk(k, s, L, W = 5) {                  // Donchian, 2-min bars
  const c = t2.close[k]; let lo = Infinity, hi = -Infinity;
  for (let j = Math.max(0, k - W + 1); j <= k; j++) { lo = Math.min(lo, t2.low[j]); hi = Math.max(hi, t2.high[j]); }
  return s === 1 ? brkIn(L, lo, c) : brkIn(L, c - 1e-9, hi - 1e-9);
}
function pushBrokeBrk(k, s, L, W = 10) {               // fade, 1-min bars; s = -1 fades an UP push
  const c = t1.close[k]; let lo = Infinity, hi = -Infinity;
  for (let j = Math.max(0, k - W + 1); j <= k; j++) { lo = Math.min(lo, t1.low[j]); hi = Math.max(hi, t1.high[j]); }
  return s === -1 ? brkIn(L, lo, c) : brkIn(L, c - 1e-9, hi - 1e-9);
}
function pushAtVol(k, s, L, near = 0.5, W = 10, set = "s") {
  let x = s === -1 ? -Infinity : Infinity;
  for (let j = Math.max(0, k - W + 1); j <= k; j++) x = s === -1 ? Math.max(x, t1.high[j]) : Math.min(x, t1.low[j]);
  const lv = set === "s" ? L.vpS : set === "w" ? L.vpW : L.vpS.concat(L.vpW);
  return lv.some((p) => Math.abs(p - x) <= near * L.R);
}

// A gate turns a 2026 signal bar into a size multiplier: 1 base, 0.5 half, 0 skip.
function mask(c, rule, twin = 0) {
  const m = new Float32Array(c.sig.length).fill(1);
  let gated = 0, elig = 0;
  for (let k = 0; k < c.sig.length; k++) {
    if (!c.sig[k] || !in26(c.t, k)) continue;
    const L = levelsFor(c.t.tday[k], twin);
    if (!L) continue;
    elig++;
    m[k] = rule(k, c.sig[k], L);
    if (m[k] !== 1) gated++;
  }
  m.share = gated / Math.max(1, elig);
  m.value = [...new Set(Array.from(m))].find((v) => v !== 1) ?? 0;
  return m;
}
function randomMask(c, share, value, seed) {
  const rnd = S.mul(seed), m = new Float32Array(c.sig.length).fill(1);
  for (let k = 0; k < c.sig.length; k++) {
    if (!c.sig[k] || !in26(c.t, k) || !levelsFor(c.t.tday[k], 0)) continue;
    if (rnd() < share) m[k] = value;
  }
  return m;
}
const shift1 = (a, Ctor) => { const o = new Ctor(a.length); if (Ctor === Float32Array) o.fill(1); for (let i = 1; i < a.length; i++) o[i] = a[i - 1]; return o; };

const pass = (arr, ix) => S.passArr(ix.map((k) => arr[k]), RULES);
function run(c, m = null, { sig = c.sig, extra = {} } = {}) {
  const sizer = (a, ct, s, arm) => { const b = c.lots(arm - 1), x = m ? m[arm - 1] : 1; return x === 1 ? b : x === 0 ? 0 : Math.max(1, Math.round(b * x)); };
  const tr = c.E.run(sizer, { signals: sig, ...FILL, ...c.opts, ...extra }).filter((t) => S.yearOf.get(t.tday) === 2026);
  const arr = S.dayArr(tr, S.days);
  const d = M.Y26.map((k) => arr[k]);
  let cp = 0, cn = 0;
  for (let s = 0; s + 21 <= d.length; s++) { cp += S.evWith(d.slice(s, s + 21), RULES); cn++; }
  const jack = (K) => { const best = M.Y26.map((k) => [k, arr[k]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, K);
    const a = Float64Array.from(arr); for (const [k] of best) a[k] = 0; return pass(a, M.Y26); };
  return { tr, n: tr.length, exp: tr.reduce((s, t) => s + t.pnl, 0) / Math.max(1, tr.length),
           win: (100 * tr.filter((t) => t.pnl > 0).length) / Math.max(1, tr.length),
           y: pass(arr, M.Y26), a: pass(arr, M.Y26a), b: pass(arr, M.Y26b), real: (100 * cp) / cn, j3: jack(3) };
}
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const HD = "  " + "".padEnd(60) + "  2026 JanMar AprJul  real -3best trades  win%   $/tr";
const line = (lbl, r) => "  " + lbl.padEnd(60) + f1(r.y) + f1(r.a, 7) + f1(r.b, 7) + f1(r.real) + f1(r.j3, 6) + String(r.n).padStart(7) + f1(r.win) + f1(r.exp, 7);

const RULESET = {
  D: [
    ["D-a  only breakouts that crossed a break-prone level (10 min)", (k, s, L) => (crossedBrk(k, s, L) ? 1 : 0)],
    ["D-b  half size on breakouts that did not", (k, s, L) => (crossedBrk(k, s, L) ? 1 : 0.5)],
  ],
  A: [
    ["A-a  no entry if the push broke a break-prone level", (k, s, L) => (pushBrokeBrk(k, s, L) ? 0 : 1)],
    ["A-b  enter only if the push ran into a volume level", (k, s, L) => (pushAtVol(k, s, L) ? 1 : 0)],
    ["A-c  at a volume level and not through a break-prone one", (k, s, L) => (pushAtVol(k, s, L) && !pushBrokeBrk(k, s, L) ? 1 : 0)],
    ["A-d  half size unless the push ran into a volume level", (k, s, L) => (pushAtVol(k, s, L) ? 1 : 0.5)],
  ],
};

for (const [id, c] of Object.entries(SET)) {
  console.log("\n" + "=".repeat(124) + "\n" + c.name + " -- with vs without each improvement (entries gated; every signal still exits)\n" + "=".repeat(124));
  console.log(HD + "  | twins: med  max | random: med  max");
  const base = run(c);
  console.log(line("WITHOUT (the setup as built)", base));
  const best = [];
  for (const [lbl, rule] of RULESET[id]) {
    const m = mask(c, rule);
    const r = run(c, m);
    const tw = [], rn = [];
    for (let w = 1; w <= NNULL; w++) tw.push(run(c, mask(c, rule, w)).y);
    for (let w = 1; w <= NNULL; w++) rn.push(run(c, randomMask(c, m.share, m.value, 3000 + w)).y);
    console.log(line(lbl, r) + "  |" + f1(med(tw), 10) + f1(Math.max(...tw), 5) + " |" + f1(med(rn), 11) + f1(Math.max(...rn), 5) +
                "   (" + (100 * m.share).toFixed(0) + "% of entries " + (m.value === 0 ? "skipped" : "halved") + ")");
    best.push({ lbl, rule, m, r });
  }

  // stress: each improvement and the base under the same changes
  console.log("\n  stress (each line: WITHOUT -> WITH)");
  const sig1 = shift1(c.sig, Int8Array);
  const stresses = [
    ["enter one bar later", (m) => ({ m: m && shift1(m, Float32Array), o: { sig: sig1 } })],
    ["2 ticks slippage each way", (m) => ({ m, o: { extra: { slipMult: 2 } } })],
    ["breaker one step looser (+$100)", (m) => ({ m, o: { extra: { breaker: c.opts.breaker + 100 } } })],
    ["profit block +$350", (m) => ({ m, o: { extra: { profitBlock: 350 } } })],
  ];
  for (const { lbl, m } of best) {
    console.log("  " + lbl);
    for (const [sl, f] of stresses) {
      const b0 = f(null), b1 = f(m);
      const r0 = run(c, b0.m, b0.o), r1 = run(c, b1.m, b1.o);
      console.log("    " + sl.padEnd(34) + f1(r0.y) + " ->" + f1(r1.y) + "   (Jan-Mar" + f1(r0.a) + " ->" + f1(r1.a) + ",  Apr-Jul" + f1(r0.b) + " ->" + f1(r1.b) + ")");
    }
  }

  // does it hold if the look-back or distance moves?
  console.log("\n  neighbours (look-back / distance)");
  const NB = id === "D" ? [
    ...[3, 5, 8, 10].map((W) => [`D-a, crossed within ${W} bars (${2 * W} min)`, (k, s, L) => (crossedBrk(k, s, L, W) ? 1 : 0)]),
    ...[3, 5, 8, 10].map((W) => [`D-b, crossed within ${W} bars (${2 * W} min)`, (k, s, L) => (crossedBrk(k, s, L, W) ? 1 : 0.5)]),
  ] : [
    ...[5, 10, 15].map((W) => [`A-a, push window ${W} bars`, (k, s, L) => (pushBrokeBrk(k, s, L, W) ? 0 : 1)]),
    ...[[0.5, 5], [1, 5], [0.5, 10], [1, 10], [0.5, 15], [1, 15]].map(([nr, W]) => [`A-b, within ${nr} R, last ${W} bars`, (k, s, L) => (pushAtVol(k, s, L, nr, W) ? 1 : 0)]),
    ...[[0.5, 10, "sw"], [1, 10, "sw"]].map(([nr, W, st]) => [`A-b, + week/month POCs, ${nr} R, ${W} bars`, (k, s, L) => (pushAtVol(k, s, L, nr, W, st) ? 1 : 0)]),
    ...[[0.5, 5], [1, 5], [0.5, 10], [1, 10], [0.5, 15], [1, 15]].map(([nr, W]) => [`A-d, within ${nr} R, last ${W} bars`, (k, s, L) => (pushAtVol(k, s, L, nr, W) ? 1 : 0.5)]),
  ];
  console.log(HD);
  for (const [lbl, rule] of NB) console.log(line(lbl, run(c, mask(c, rule))));
  process.stderr.write(`  ${id} done ${((Date.now() - T0) / 1000).toFixed(0)}s\n`);
}
console.log("\n  real = every real 21-day window in 2026;  -3best = pass rate with the 3 best days removed");
console.log("  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
