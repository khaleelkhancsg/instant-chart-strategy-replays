// Lot size and "confidence" sizing for the best 2026 configs, then a stress
// test of their 2026 pass rates. 2026 ONLY, honest limit fills.
//
//   A  fade 1-min MACD crosses (RTH), target 1x the stop, 0.15 ATR stop-entry
//   B  the user's anticipation on 1-min (RTH, no ADR gate), target 1x the stop
//   C  fade 1-min EMA 20/50 crosses (RTH), the 1.75 ATR target, near-market entry
//   D  the 2026 Donchian config: 7 lots (4 late in an extended day), 40-min exit
//
// 1  fixed lot sizes
// 2  CONFIDENCE: a dozen readings known at the signal bar, each cut into terciles
//    over the config's 2026 trades. A reading counts only if its best and worst
//    terciles differ the same way in Jan-Mar AND Apr-Jul.
// 3  CONFIDENCE SIZING: more lots on the good tercile, the bad one kept, halved
//    or skipped (the gate). Chosen on one half of 2026, read on the other, and
//    against random up/down-sizing of the same share of trades.
// 4  STRESS: costs, a one-bar entry delay, neighbouring settings, contiguous
//    real 21-day windows, bootstrap block size and seed, best days removed,
//    month by month.
//
// RESULT (2026 only, honest limit fills, realistic costs):
//   LOTS: every config peaks at 6-8 lots and falls hard at 10+ (A 50.5% at 8,
//   27.7% at 10; B 50.0 / 42.9; C 53.1 at 7, 31.2 at 10; D 55.1 at 6, 31.2 at
//   10). More lots tighten the cap-bound stop and trip the profit block sooner.
//   CONFIDENCE: of 11 readings, few split trades the same way in both halves;
//   the one that recurs is a higher volatility regime (B, C, D). As SIZING it
//   does not survive: 2 of 258 rules beat fixed size out of half (one of them
//   only because its reading flipped direction between halves), and random
//   up/down-sizing of the same share LOWERS pass rates by 2.5-8pp. Skipping the
//   low-confidence third (the gate) never held either.
//   STRESS: the +$750 profit block is load-bearing (off: A 7.8%, B 23.9%, C
//   15.4%, D 35.4%). Entering one bar later costs the 1-min configs 9-31pp (C
//   collapses to 22%); D loses 6. Neighbouring targets cost A and B 7-15pp.
//   Real contiguous 21-day windows agree with the bootstrap (A 47.9, B 47.9,
//   C 57.1, D 52.9). Best 5 days removed: 41-45% for all. A and B are positive
//   in all 7 months of 2026; C rests on March and has two losing months.
//
//   node --max-old-space-size=8192 research/confidence_sizing_2026.mjs

import { ema, macd, rsi, sma, efficiencyRatio } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const T0 = Date.now();
const days = S.days;
const in2026 = (t) => S.yearOf.get(t.tday) === 2026;
const PV = 2;
const stopDist = (a, lots) => Math.min(5.15 * a, 1000 / (PV * lots));
const Y26 = M.Y26, Y26a = M.Y26a, Y26b = M.Y26b;
const at = (arr, ix) => S.passArr(ix.map((k) => arr[k]));
const month = new Map(); for (const k of Y26) month.set(days[k], null);

// ---- 1-minute bars and the three MACD/EMA signals, built as macd_ema_2026.mjs ----
const E1 = S.engineFor(1);
const t1 = E1.tf, n1 = t1.close.length;
const { open: O1, high: H1, low: L1, close: C1, ctMin: CT1, tday: TD1, volume: V1 } = t1;
const rth1 = (i) => CT1[i] >= 510 && CT1[i] < 900;
const hist1 = macd(C1, 12, 26, 9).hist;
const scale1 = new Float64Array(n1).fill(NaN);
{ let s = 0; for (let i = 0; i < n1; i++) { s += Math.abs(hist1[i]) || 0; if (i >= 200) s -= Math.abs(hist1[i - 200]) || 0; if (i >= 199) scale1[i] = s / 200; } }
const mk1 = (f) => { const s = new Int8Array(n1); for (let i = 1; i < n1; i++) s[i] = rth1(i) ? f(i) || 0 : 0; return s; };
const macdCross1 = mk1((i) => (hist1[i] > 0 && hist1[i - 1] <= 0 ? 1 : hist1[i] < 0 && hist1[i - 1] >= 0 ? -1 : 0));
const shrink1 = new Int16Array(n1);
for (let i = 1; i < n1; i++) shrink1[i] = Math.abs(hist1[i]) < Math.abs(hist1[i - 1]) ? shrink1[i - 1] + 1 : 0;
const antic1 = mk1((i) => (shrink1[i] >= 3 && Math.abs(hist1[i]) < 0.075 * scale1[i] ? (hist1[i] >= 0 ? -1 : 1) : 0));
const e20 = ema(C1, 20), e50 = ema(C1, 50);
const emaX1 = mk1((i) => (e20[i] > e50[i] && e20[i - 1] <= e50[i - 1] ? 1 : e20[i] < e50[i] && e20[i - 1] >= e50[i - 1] ? -1 : 0));
const neg = (s) => Int8Array.from(s, (v) => -v);

// ---- readings for "confidence", per bar size --------------------------------------
function readings(tf, hist, scale, E) {
  const { high: H, low: L, close: C, volume: V, ctMin: CT, tday: TD } = tf;
  const n = C.length, A = E.atr;
  const VW = new Float64Array(n).fill(NaN);
  { let pv = 0, vv = 0, d = -1, on = false;
    for (let i = 0; i < n; i++) { if (TD[i] !== d) { d = TD[i]; on = false; }
      if (CT[i] >= 510 && CT[i] < 960) { if (!on) { pv = 0; vv = 0; on = true; } const tp = (H[i] + L[i] + C[i]) / 3; pv += tp * V[i]; vv += V[i]; VW[i] = vv > 0 ? pv / vv : tp; } } }
  const rHi = new Float64Array(n).fill(NaN), rLo = new Float64Array(n).fill(NaN), dRange = new Map();
  { let d = -1, h = -Infinity, l = Infinity;
    for (let i = 0; i < n; i++) { if (TD[i] !== d) { if (d !== -1 && h > l) dRange.set(d, h - l); d = TD[i]; h = -Infinity; l = Infinity; }
      if (CT[i] >= 510 && CT[i] < 900) { if (H[i] > h) h = H[i]; if (L[i] < l) l = L[i]; rHi[i] = h; rLo[i] = l; } } }
  const dk = [...new Set(TD)], adr = new Map();
  for (let j = 1; j < dk.length; j++) { const r = dk.slice(Math.max(0, j - 10), j).map((d) => dRange.get(d)).filter((x) => x > 0); if (r.length) adr.set(dk[j], r.reduce((a, b) => a + b, 0) / r.length); }
  const aSm = sma(A, 780), RS = rsi(C, 14), ER = efficiencyRatio(C, 20);
  const tfMin = tf.tfMin || Math.round((tf.ts[1] - tf.ts[0]) / 60000) || 1;
  const t2 = S.engineFor(2).tf, e125 = ema(t2.close, 125), e500 = ema(t2.close, 500);
  const t5 = S.engineFor(5).tf, h5 = macd(t5.close, 12, 26, 9).hist;
  const last = (big) => { const out = new Int32Array(n).fill(-1); let j = 0, cur = -1;
    for (let i = 0; i < n; i++) { while (j < big.close.length && big.srcLast[j] <= tf.srcLast[i]) { cur = j; j++; } out[i] = cur; } return out; };
  const k2 = last(t2), k5 = last(t5);
  const crosses = new Int16Array(n);
  { const q = []; for (let i = 1; i < n; i++) { if (Math.sign(hist[i]) !== Math.sign(hist[i - 1])) q.push(i); while (q.length && q[0] <= i - 30) q.shift(); crosses[i] = q.length; } }
  // each reading: (k = signal bar, d = TRADE direction) -> number. "against" = price
  // stretched opposite to the trade (what a fade wants to see)
  return {
    "push size (|hist| before the signal / its 200-bar avg)": (k) => Math.abs(hist[k - 1]) / (scale[k] || 1),
    "stretch from VWAP against the trade (ATR)": (k, d) => (Number.isFinite(VW[k]) ? (VW[k] - C[k]) * d / A[k] : 0),
    "day's range used (x 10-day avg)": (k) => { const a = adr.get(TD[k]); return a ? (rHi[k] - rLo[k]) / a : 0; },
    "volatility regime (ATR / 2-day avg)": (k) => (aSm[k] > 0 ? A[k] / aSm[k] : 1),
    "time of day (CT minute)": (k) => CT[k],
    "5-min MACD with the trade": (k, d) => (k5[k] >= 0 ? Math.sign(h5[k5[k]]) * d : 0),
    "slow trend with the trade (2-min EMA 125/500)": (k, d) => (k2[k] >= 0 ? Math.sign(e125[k2[k]] - e500[k2[k]]) * d : 0),
    "efficiency (20 bars)": (k) => ER[k],
    "RSI stretch against the trade": (k, d) => (d === 1 ? 50 - RS[k] : RS[k] - 50),
    "signal bar range (ATR)": (k) => (H[k] - L[k]) / A[k],
    "MACD crosses in the last 30 bars": (k) => crosses[k],
  };
}
const R1 = readings(t1, hist1, scale1, E1);
const t2b = S.engineFor(2).tf, hist2 = macd(t2b.close, 12, 26, 9).hist;
const scale2 = new Float64Array(t2b.close.length).fill(NaN);
{ let s = 0; for (let i = 0; i < hist2.length; i++) { s += Math.abs(hist2[i]) || 0; if (i >= 200) s -= Math.abs(hist2[i - 200]) || 0; if (i >= 199) scale2[i] = s / 200; } }
const R2 = readings(t2b, hist2, scale2, S.engineFor(2));

// ---- the four configs ------------------------------------------------------------
const exit20 = (k, d, st) => k - st.entBar >= 20 && (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) < st.atr;
const CFG = {
  A: { name: "A  fade 1-min MACD crosses, target 1x stop", E: E1, sig: neg(macdCross1), R: R1, opts: { trig: 0.15, tpFromFill: true, tpFn: (a, q) => stopDist(a, q) }, base: 8 },
  B: { name: "B  anticipation 1-min (RTH), target 1x stop", E: E1, sig: antic1, R: R1, opts: { trig: 0.15, tpFromFill: true, tpFn: (a, q) => stopDist(a, q) }, base: 8 },
  C: { name: "C  fade 1-min EMA 20/50 crosses, 1.75 ATR target", E: E1, sig: neg(emaX1), R: R1, opts: { trig: 0 }, base: 8 },
  D: { name: "D  Donchian 2026 config (7/4 lots + 40-min exit)", E: S.engineFor(2), sig: M.RESC, R: R2, opts: { exitFn: exit20 }, base: 7,
       late: (k) => M.adrUsed(k) >= 0.9 },
};
const FILL = { slipMult: 1, feeMult: 1, limitFillTp: "close" };
function run(c, lotsAt, extra = {}) {
  const tr = c.E.run((a, ct, seq, arm) => lotsAt(arm - 1), { signals: c.sig, ...FILL, ...c.opts, ...extra }).filter(in2026);
  const arr = S.dayArr(tr, days);
  const w = tr.filter((t) => t.pnl > 0).length;
  return { tr, arr, n: tr.length, win: (100 * w) / Math.max(1, tr.length), exp: tr.reduce((s, t) => s + t.pnl, 0) / Math.max(1, tr.length),
           lots: tr.reduce((s, t) => s + t.lots, 0) / Math.max(1, tr.length),
           y26: at(arr, Y26), a26: at(arr, Y26a), b26: at(arr, Y26b) };
}
// D's own sizing: base lots, and the late-day size at the same 4:7 ratio
const baseLots = (c, L) => (c.late ? (k) => (c.late(k) ? Math.max(1, Math.round(L * 4 / 7)) : L) : () => L);
const f1 = (x, w = 6) => x.toFixed(1).padStart(w);
const row = (label, r) => "    " + label.padEnd(44) + String(r.n).padStart(6) + f1(r.lots, 6) + f1(r.win, 7) + f1(r.exp, 8) + f1(r.y26, 7) + f1(r.a26, 7) + f1(r.b26, 7);
const HD = "    " + "".padEnd(44) + "trades".padStart(6) + "lots".padStart(6) + "win%".padStart(7) + "$/tr".padStart(8) + "2026".padStart(7) + "JanMar".padStart(7) + "AprJul".padStart(7);
function bar(t) { console.log("\n" + "=".repeat(118) + "\n" + t + "\n" + "=".repeat(118)); }

// =============================================================================
bar("1. FIXED LOT SIZES (2026 only, realistic fills, honest limit fills)");
// =============================================================================
const best = {};
for (const [id, c] of Object.entries(CFG)) {
  console.log("\n  " + c.name + "\n" + HD);
  let top = null;
  for (const L of [2, 4, 6, 7, 8, 10, 12, 16]) {
    const r = run(c, baseLots(c, L));
    console.log(row(L + " lots" + (c.late ? " (" + Math.max(1, Math.round(L * 4 / 7)) + " late)" : ""), r));
    if (!top || r.y26 > top.r.y26) top = { L, r };
  }
  best[id] = top;
}

// =============================================================================
bar("2. WHAT PREDICTS A GOOD TRADE? 2026 $/trade by tercile of each reading, in each half");
// =============================================================================
const goodReadings = {};
for (const [id, c] of Object.entries(CFG)) {
  const ref = run(c, baseLots(c, c.base));
  const tr = ref.tr.map((t) => ({ ...t, dir: Math.sign(c.sig[t.sigBar]) || 1, half: Y26a.includes(days.indexOf(t.tday)) ? "a" : "b" }));
  const halfOf = new Map(); for (const k of Y26a) halfOf.set(days[k], "a"); for (const k of Y26b) halfOf.set(days[k], "b");
  for (const t of tr) t.half = halfOf.get(t.tday);
  console.log("\n  " + c.name + "   (" + tr.length + " trades at " + c.base + " lots)");
  console.log("    " + "reading".padEnd(54) + "  Jan-Mar: low   mid   high" + "   Apr-Jul: low   mid   high" + "   same way?");
  goodReadings[id] = [];
  for (const [rn, fn] of Object.entries(c.R)) {
    const v = tr.map((t) => fn(t.sigBar, t.dir));
    const sorted = v.filter(Number.isFinite).slice().sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length / 3)], q2 = sorted[Math.floor((2 * sorted.length) / 3)];
    if (!(q2 > q1)) continue;                                  // binary or flat: no terciles
    const cell = (h, b) => { const xs = tr.filter((t, j) => t.half === h && (b === 0 ? v[j] < q1 : b === 1 ? v[j] >= q1 && v[j] < q2 : v[j] >= q2));
      return xs.length ? xs.reduce((s, t) => s + t.pnl, 0) / xs.length : NaN; };
    const a = [0, 1, 2].map((b) => cell("a", b)), b = [0, 1, 2].map((x) => cell("b", x));
    const sa = Math.sign(a[2] - a[0]), sb = Math.sign(b[2] - b[0]);
    const same = sa === sb && sa !== 0;
    const fmt = (x) => (Number.isFinite(x) ? x.toFixed(0) : "-").padStart(6);
    console.log("    " + rn.slice(0, 54).padEnd(54) + "  " + " ".repeat(8) + a.map(fmt).join("") + "  " + " ".repeat(8) + b.map(fmt).join("") +
      (same ? "   yes, " + (sa > 0 ? "high" : "low") + " is better" : "   no"));
    if (same) goodReadings[id].push({ rn, fn, q1, q2, goodHigh: sa > 0, spread: Math.min(Math.abs(a[2] - a[0]), Math.abs(b[2] - b[0])) });
  }
}

// =============================================================================
bar("3. CONFIDENCE SIZING -- picked on one half of 2026, read on the other, against random sizing");
// =============================================================================
// A rule: tercile cut-offs and the good side come from the PICKING half's trades;
// good tercile gets base x hi lots, bad tercile base x lo (0 = skip, the gate).
const SCHEMES = [];
for (const hi of [1.5, 2]) for (const lo of [1, 0.5, 0]) SCHEMES.push({ hi, lo });
function ruleSizer(c, base, rd, cuts, sch) {
  return (k) => {
    const d = Math.sign(c.sig[k]) || 1, v = rd.fn(k, d);
    const good = cuts.goodHigh ? v >= cuts.q2 : v < cuts.q1, badT = cuts.goodHigh ? v < cuts.q1 : v >= cuts.q2;
    let L = c.late && c.late(k) ? Math.max(1, Math.round(base * 4 / 7)) : base;
    if (good) L = Math.round(L * sch.hi); else if (badT) L = Math.round(L * sch.lo);
    return L;
  };
}
function cutsFrom(c, base, rd, halfIx) {
  const ref = run(c, baseLots(c, base));
  const set = new Set(halfIx.map((k) => days[k]));
  const tr = ref.tr.filter((t) => set.has(t.tday));
  const v = tr.map((t) => rd.fn(t.sigBar, Math.sign(c.sig[t.sigBar]) || 1)).filter(Number.isFinite).sort((a, b) => a - b);
  const q1 = v[Math.floor(v.length / 3)], q2 = v[Math.floor((2 * v.length) / 3)];
  // which side is better, on the picking half only
  const lo = tr.filter((t) => rd.fn(t.sigBar, Math.sign(c.sig[t.sigBar]) || 1) < q1), hi = tr.filter((t) => rd.fn(t.sigBar, Math.sign(c.sig[t.sigBar]) || 1) >= q2);
  const m = (xs) => xs.reduce((s, t) => s + t.pnl, 0) / Math.max(1, xs.length);
  return { q1, q2, goodHigh: m(hi) > m(lo) };
}
const hash = (k, s) => { let x = (k * 2654435761 + s * 97531) >>> 0; x ^= x >>> 16; x = Math.imul(x, 2246822507) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };
const finalists = {};
for (const [id, c] of Object.entries(CFG)) {
  const base = best[id].L;
  console.log("\n  " + c.name + "   (base " + base + " lots, its best fixed size)\n" + HD);
  console.log(row("fixed " + base + " lots", best[id].r));
  const cands = [];
  for (const rd of Object.values(c.R).map((fn, j) => ({ fn, rn: Object.keys(c.R)[j] }))) {
    // the honest cross-half versions: cut-offs and good side from one half only
    const cA = cutsFrom(c, base, rd, Y26a), cB = cutsFrom(c, base, rd, Y26b);
    if (!(cA.q2 > cA.q1) || !(cB.q2 > cB.q1)) continue;
    for (const sch of SCHEMES) {
      const rA = run(c, ruleSizer(c, base, rd, cA, sch)), rB = run(c, ruleSizer(c, base, rd, cB, sch));
      cands.push({ rd, sch, cA, cB, aToB: rA.b26, bToA: rB.a26, rA, rB, label: rd.rn.slice(0, 30) + " x" + sch.hi + "/" + (sch.lo === 0 ? "skip" : "x" + sch.lo) });
    }
  }
  // rank by the WORSE of the two out-of-half reads, which is the honest score
  cands.sort((p, q) => Math.min(q.aToB - best[id].r.b26, q.bToA - best[id].r.a26) - Math.min(p.aToB - best[id].r.b26, p.bToA - best[id].r.a26));
  console.log("    top 6 rules by the worse out-of-half change (picked on Jan-Mar -> read Apr-Jul, and the reverse):");
  for (const x of cands.slice(0, 6))
    console.log("      " + x.label.padEnd(46) + "  Jan-Mar pick -> Apr-Jul " + f1(x.aToB) + " (fixed " + f1(best[id].r.b26).trim() + ")" +
      "   Apr-Jul pick -> Jan-Mar " + f1(x.bToA) + " (fixed " + f1(best[id].r.a26).trim() + ")");
  const beat = cands.filter((x) => x.aToB > best[id].r.b26 && x.bToA > best[id].r.a26).length;
  console.log("    " + beat + " of " + cands.length + " rules beat fixed size on BOTH out-of-half reads");
  // the null: up/down-size the same SHARE of trades at random, same scheme
  const topRule = cands[0];
  if (topRule) {
    const nul = [];
    for (let s = 1; s <= 20; s++) {
      const sz = (k) => { const u = hash(k, s); let L = c.late && c.late(k) ? Math.max(1, Math.round(base * 4 / 7)) : base;
        if (u < 1 / 3) L = Math.round(L * topRule.sch.hi); else if (u > 2 / 3) L = Math.round(L * topRule.sch.lo); return L; };
      nul.push(run(c, sz));
    }
    const m = (k) => nul.reduce((a, r) => a + r[k], 0) / nul.length;
    console.log("    random sizing, same scheme (20 seeds): 2026 mean " + f1(m("y26")).trim() + "%, Jan-Mar " + f1(m("a26")).trim() + ", Apr-Jul " + f1(m("b26")).trim() +
      ";  best seed " + f1(Math.max(...nul.map((r) => r.y26))).trim() + "%");
    // full-2026 version of the top rule, cut on all of 2026, for the stress test
    const cAll = cutsFrom(c, base, topRule.rd, Y26);
    const rAll = run(c, ruleSizer(c, base, topRule.rd, cAll, topRule.sch));
    console.log(row("top rule, cut on all of 2026", rAll));
    finalists[id] = { c, base, fixed: best[id], rule: { rd: topRule.rd, sch: topRule.sch, cuts: cAll, r: rAll, label: topRule.label },
                      ruleHolds: topRule.aToB > best[id].r.b26 && topRule.bToA > best[id].r.a26 };
  }
}

// =============================================================================
bar("4. STRESS TEST -- each config at its best fixed size, and with its top confidence rule");
// =============================================================================
function contiguous(arr) {               // every real 21-day window inside 2026
  const d = Y26.map((k) => arr[k]); let p = 0, n = 0;
  for (let s = 0; s + 21 <= d.length; s++) { p += S.evWith(d.slice(s, s + 21)); n++; }
  return (100 * p) / n;
}
function boot(arr, block, seed) {        // block bootstrap over 2026 days
  const d = Y26.map((k) => arr[k]), rnd = S.mul(seed); let w = 0;
  for (let t = 0; t < 12000; t++) { const buf = []; while (buf.length < 21) { const st = Math.floor(rnd() * Math.max(1, d.length - block)); for (let j = 0; j < block && buf.length < 21; j++) buf.push(d[(st + j) % d.length]); } w += S.evWith(buf); }
  return (100 * w) / 12000;
}
function jack(r, base, K) {
  const best3 = Y26.map((k) => [k, r.arr[k] - base.arr[k]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, K);
  const a = Float64Array.from(r.arr); for (const [k] of best3) a[k] = base.arr[k]; return at(a, Y26);
}
const shift1 = (s) => { const o = new Int8Array(s.length); for (let i = 1; i < s.length; i++) o[i] = s[i - 1]; return o; };
for (const [id, F] of Object.entries(finalists)) {
  const c = F.c;
  console.log("\n  " + c.name);
  for (const [vName, sizerFor] of [["fixed " + F.base + " lots", (cc) => baseLots(cc, F.base)],
                                   ["confidence: " + F.rule.label + (F.ruleHolds ? "" : "  (did NOT hold out of half)"), (cc) => ruleSizer(cc, F.base, F.rule.rd, F.rule.cuts, F.rule.sch)]]) {
    const sizerOf = () => sizerFor(c);
    const base = run(c, sizerOf());
    const zero = run(c, () => 0);
    const lines = [];
    const add = (lbl, r) => lines.push("      " + lbl.padEnd(40) + f1(r.y26) + "%  (Jan-Mar " + f1(r.a26).trim() + ", Apr-Jul " + f1(r.b26).trim() + ")  $" + r.exp.toFixed(0) + "/tr");
    console.log("    " + vName + ":  2026 " + base.y26.toFixed(1) + "%");
    add("sim fills (no slippage)", run(c, sizerOf(), { slipMult: 0 }));
    add("2 ticks slippage each way", run(c, sizerOf(), { slipMult: 2 }));
    add("3 ticks slippage each way", run(c, sizerOf(), { slipMult: 3 }));
    add("commission $1.25/side", run(c, sizerOf(), { feeMult: 1.25 / 0.75 }));
    { const cs = { ...c, sig: shift1(c.sig) }; add("enter one bar later", run(cs, sizerFor(cs))); }
    if (c.opts.tpFn) {
      add("target 0.75x stop", run(c, sizerOf(), { tpFn: (a, q) => 0.75 * stopDist(a, q) }));
      add("target 1.25x stop", run(c, sizerOf(), { tpFn: (a, q) => 1.25 * stopDist(a, q) }));
    } else if (id === "C") {
      add("target 1.5 ATR", run(c, sizerOf(), { tpMult: 1.5 }));
      add("target 2 ATR", run(c, sizerOf(), { tpMult: 2 }));
    }
    add("profit block off", run(c, sizerOf(), { profitBlock: 0 }));
    add("breaker -$300", run(c, sizerOf(), { breaker: 300 }));
    console.log(lines.join("\n"));
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => boot(base.arr, 5, 1000 + s));
    const mean = seeds.reduce((a, b) => a + b, 0) / seeds.length, sd = Math.sqrt(seeds.reduce((a, b) => a + (b - mean) ** 2, 0) / seeds.length);
    console.log("      contiguous real 21-day windows in 2026: " + contiguous(base.arr).toFixed(1) + "%   bootstrap blocks 1/5/10 days: " +
      [1, 5, 10].map((b) => boot(base.arr, b, 4242).toFixed(1)).join(" / ") + "%   seed spread " + mean.toFixed(1) + " +/- " + sd.toFixed(1));
    console.log("      best 1/3/5 days of 2026 removed (set to $0): " + [1, 3, 5].map((K) => jack(base, zero, K).toFixed(1)).join(" / ") + "%");
    const mo = new Map();
    for (const t of base.tr) { const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"][new Date(M.tf.ts[S.dayFirstBar.get(t.tday)] + 43200e3).getUTCMonth()]; mo.set(m, (mo.get(m) || 0) + t.pnl); }
    console.log("      dollars by month: " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"].map((m) => m + " " + ((mo.get(m) || 0) >= 0 ? "+" : "") + Math.round(mo.get(m) || 0)).join("  "));
  }
}
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
