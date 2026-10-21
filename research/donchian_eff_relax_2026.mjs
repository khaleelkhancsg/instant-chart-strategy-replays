// With the 10-min EMA 9/21 filter in place, can the Donchian's efficiency gate
// be relaxed -- and what do both do to the number of trades a day? 2026 ONLY,
// the $1,250 Donchian (4 lots, 2 late; -$300 / +$250; $600 limit; 40-min
// exit), honest fills, realistic costs.
//
// The signal today: a 2-min close outside the previous 30 bars' range, ADX(14)
// >= 25, Kaufman efficiency(20) >= 0.5 -- or 0.45-0.5 when the 2-min EMA
// 125/500 agrees (the rescue). Relaxed: one efficiency floor from 0.45 down
// to off (below 0.45 the rescue band is inside the floor anyway). Each with and
// without the EMA filter (only breakouts the 10-min EMA 9/21 points the same
// way; entries only, every signal still exits).
//
// RESULT (2026 only): the 10-min EMA filter cuts the trades from 148 to 128
// (1.06 -> 0.92 a session; days with no trade 19 -> 31) and lifts the pass
// rate 61.3% -> 71.1%. The efficiency gate should NOT be relaxed alongside it:
// with the filter, every lower floor (0.45 down to off) passes 28-56%, every
// wider rescue band (0.40 down to 0.20, slow-EMA test kept) 44-61%, the
// half-picks choose the current gate both ways, and the 0.40 versions lose
// under most stresses. The rescue itself is worth 14-18 points: breakouts at
// efficiency 0.45-0.5 only work when the slow 2-min EMA 125/500 agrees.
// Efficiency (how straight the last 40 minutes moved) and the 10-min EMA (the
// direction of the last few hours) measure different things.
//
//   node --max-old-space-size=8192 research/donchian_eff_relax_2026.mjs

import { ema, adx as adxOf, donchian } from "../src/indicators.mjs";
import { resample } from "../src/resample.mjs";
import { loadBars } from "../src/data.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const T0 = Date.now();
const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const { bars } = loadBars();
const tf2 = M.tf, { close: C, tday: TD, ts: TS } = tf2, n2 = C.length;
const in26 = (k) => S.yearOf.get(TD[k]) === 2026;

// ---- signals at each efficiency floor --------------------------------------------
const ctx = buildFilterContext(tf2);
const { adx: AX } = adxOf(tf2.high, tf2.low, C, 14);
const { high: DH, low: DL } = donchian(tf2.high, tf2.low, 30);
const raw = new Int8Array(n2);
for (let i = 30; i < n2; i++) { if (AX[i] < 25) continue; if (C[i] > DH[i]) raw[i] = 1; else if (C[i] < DL[i]) raw[i] = -1; }
const gated = (x) => applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: x });

// ---- the EMA filter: 10-min EMA 9/21 read at the 2-min signal bar's close ----------------
function emaState(tfMin, fast, slow) {
  const T = resample(bars, tfMin), ef = ema(T.close, fast), es = ema(T.close, slow);
  const dir = new Int8Array(T.close.length);
  for (let j = 0; j < dir.length; j++) dir[j] = Math.sign(ef[j] - es[j]) || 0;
  return { tfMin, ts: T.ts, dir };
}
const E10 = emaState(10, 9, 21);
function emaDir(k) {
  const lim = TS[k] + 120000 - E10.tfMin * 60000;
  let lo = 0, hi = E10.ts.length - 1, j = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (E10.ts[m] <= lim) { j = m; lo = m + 1; } else hi = m - 1; }
  return j < 0 ? 0 : E10.dir[j];
}

// ---- the strategy ----------------------------------------------------------------------
const exit20 = (k, d, st) => k - st.entBar >= 20 && (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) < st.atr;
const FILL = { slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: 600, cancelOpposite: true, breaker: 300, profitBlock: 250 };
const pass = (arr, ix) => S.passArr(ix.map((k) => arr[k]), RULES);
function run(sig, emaFilter, { extra = {}, lots = null, shifted = false } = {}) {
  const sizer = (a, c, s, arm) => {
    const k = arm - 1;
    if (emaFilter && in26(k) && emaDir(shifted ? k - 1 : k) !== sig[k]) return 0;
    return lots ? lots(k) : M.adrUsed(k) >= 0.9 ? 2 : 4;
  };
  const tr = S.run(sizer, { signals: sig, ...FILL, exitFn: exit20, ...extra }).filter((t) => S.yearOf.get(t.tday) === 2026);
  const arr = S.dayArr(tr, S.days), d = M.Y26.map((k) => arr[k]);
  let cp = 0, cn = 0;
  for (let q = 0; q + 21 <= d.length; q++) { cp += S.evWith(d.slice(q, q + 21), RULES); cn++; }
  const per = new Map();
  for (const t of tr) per.set(t.tday, (per.get(t.tday) || 0) + 1);
  const cnt = M.Y26.map((k) => per.get(S.days[k]) || 0);
  return { n: tr.length, exp: tr.reduce((s, t) => s + t.pnl, 0) / Math.max(1, tr.length), win: (100 * tr.filter((t) => t.pnl > 0).length) / Math.max(1, tr.length),
           y: pass(arr, M.Y26), a: pass(arr, M.Y26a), b: pass(arr, M.Y26b), real: (100 * cp) / cn,
           perDay: tr.length / M.Y26.length, d0: cnt.filter((c) => c === 0).length, d1: cnt.filter((c) => c === 1).length,
           d2: cnt.filter((c) => c === 2).length, d3: cnt.filter((c) => c >= 3).length, mx: Math.max(...cnt) };
}
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const f2 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(2) : "-").padStart(w);

// ---- 1. trades a day, with and without the EMA filter ---------------------------------------
console.log(`1. TRADES A DAY -- 2026 has ${M.Y26.length} sessions`);
console.log("   " + "".padEnd(40) + "trades  a day   days with 0 / 1 / 2 / 3+ trades   most in a day    pass  JanMar AprJul  real   $/tr");
for (const [lbl, f] of [["as built", false], ["+ 10-min EMA 9/21 filter", true]]) {
  const r = run(M.RESC, f);
  console.log("   " + lbl.padEnd(40) + String(r.n).padStart(6) + f2(r.perDay, 7) + "        " + [r.d0, r.d1, r.d2, r.d3].map((x) => String(x).padStart(4)).join(" /") +
              String(r.mx).padStart(14) + "   " + f1(r.y) + f1(r.a, 7) + f1(r.b, 7) + f1(r.real) + f1(r.exp, 7));
}

// ---- 2. relaxing the efficiency floor ----------------------------------------------------------
const FLOORS = [["0.50 + rescue (as built)", M.RESC], ["0.50, no rescue", gated(0.5)], ["0.45", gated(0.45)], ["0.40", gated(0.4)], ["0.35", gated(0.35)],
                ["0.30", gated(0.3)], ["0.25", gated(0.25)], ["0.20", gated(0.2)], ["off", gated(0)]];
const nSig = (sig) => { let c = 0; for (let k = 0; k < n2; k++) if (sig[k] && in26(k)) c++; return c; };
console.log("\n2. THE EFFICIENCY FLOOR, without and with the EMA filter");
console.log("   floor                        2026 signals |  WITHOUT EMA: pass JanMar AprJul  real trades a day  $/tr |  WITH EMA: pass JanMar AprJul  real trades a day  $/tr");
const res = [];
for (const [lbl, sig] of FLOORS) {
  const r0 = run(sig, false), r1 = run(sig, true);
  res.push({ lbl, sig, r0, r1 });
  console.log("   " + lbl.padEnd(28) + String(nSig(sig)).padStart(13) + " |" + f1(r0.y, 18) + f1(r0.a, 7) + f1(r0.b, 7) + f1(r0.real) + String(r0.n).padStart(7) + f2(r0.perDay, 6) + f1(r0.exp, 6) +
              " |" + f1(r1.y, 15) + f1(r1.a, 7) + f1(r1.b, 7) + f1(r1.real) + String(r1.n).padStart(7) + f2(r1.perDay, 6) + f1(r1.exp, 6));
}
for (const [fit, test, fl, tl] of [["a", "b", "Jan-Mar", "Apr-Jul"], ["b", "a", "Apr-Jul", "Jan-Mar"]]) {
  const top = res.slice().sort((x, y) => y.r1[fit] - x.r1[fit])[0];
  console.log(`   with the EMA filter, floor picked on ${fl}: ${top.lbl} -> ${top.r1[test].toFixed(1)}% on ${tl} (0.50 + rescue with the filter: ${res[0].r1[test].toFixed(1)}%)`);
}

// ---- 3. stress: the as-built floor vs the best relaxed one, both with the EMA filter --------------
const best = res.slice(2).sort((x, y) => y.r1.y - x.r1.y)[0];
const shift1 = (a) => { const o = new Int8Array(a.length); for (let i = 1; i < a.length; i++) o[i] = a[i - 1]; return o; };
console.log(`\n3. STRESS, all with the EMA filter: 0.50 + rescue  vs  ${best.lbl}   (2026, Jan-Mar / Apr-Jul)`);
for (const [lbl, o] of [["as tested", {}], ["one bar later", { shifted: true }], ["2 ticks slippage", { extra: { slipMult: 2 } }],
                        ["breaker -$200", { extra: { breaker: 200 } }], ["breaker -$400", { extra: { breaker: 400 } }],
                        ["profit block +$150", { extra: { profitBlock: 150 } }], ["profit block +$350", { extra: { profitBlock: 350 } }],
                        ["3 lots (2 late)", { lots: (k) => (M.adrUsed(k) >= 0.9 ? 2 : 3) }], ["5 lots (3 late)", { lots: (k) => (M.adrUsed(k) >= 0.9 ? 3 : 5) }]]) {
  const r0 = run(o.shifted ? shift1(M.RESC) : M.RESC, true, o), r1 = run(o.shifted ? shift1(best.sig) : best.sig, true, o);
  console.log("   " + lbl.padEnd(22) + f1(r0.y) + " (" + f1(r0.a, 5).trim() + " / " + f1(r0.b, 5).trim() + ")   " + f1(r1.y) + " (" + f1(r1.a, 5).trim() + " / " + f1(r1.b, 5).trim() + ")");
}

// ---- 4. the targeted relaxation: widen the RESCUE band, keeping its slow-trend test --------
// rescue(x): eff >= 0.5, or eff in [x, 0.5) when the 2-min EMA 125/500 points the breakout's way
const t125 = ema(C, 125), t500 = ema(C, 500), G50 = gated(0.5);
function rescue(x) {
  const lo = gated(x), o = Int8Array.from(G50);
  for (let k = 0; k < n2; k++) if (!G50[k] && lo[k] && Math.sign(t125[k] - t500[k]) === raw[k]) o[k] = lo[k];
  return o;
}
{
  let diff = 0; const r45 = rescue(0.45);
  for (let k = 0; k < n2; k++) if (r45[k] !== M.RESC[k]) diff++;
  console.log(`\n4. WIDER RESCUE BAND (the slow 2-min EMA 125/500 must still agree below 0.5)   [rebuilt 0.45 band = the strategy's signal on ${n2 - diff} of ${n2} bars]`);
}
console.log("   rescue band from             2026 signals |  WITHOUT EMA: pass JanMar AprJul  real trades a day  $/tr |  WITH EMA: pass JanMar AprJul  real trades a day  $/tr");
const res4 = [];
for (const x of [0.45, 0.4, 0.35, 0.3, 0.25, 0.2]) {
  const sig = rescue(x), r0 = run(sig, false), r1 = run(sig, true);
  res4.push({ lbl: x.toFixed(2) + (x === 0.45 ? " (as built)" : ""), sig, r0, r1 });
  console.log("   " + (x.toFixed(2) + (x === 0.45 ? " (as built)" : "")).padEnd(28) + String(nSig(sig)).padStart(13) + " |" + f1(r0.y, 18) + f1(r0.a, 7) + f1(r0.b, 7) + f1(r0.real) + String(r0.n).padStart(7) + f2(r0.perDay, 6) + f1(r0.exp, 6) +
              " |" + f1(r1.y, 15) + f1(r1.a, 7) + f1(r1.b, 7) + f1(r1.real) + String(r1.n).padStart(7) + f2(r1.perDay, 6) + f1(r1.exp, 6));
}
for (const [fit, test, fl, tl] of [["a", "b", "Jan-Mar", "Apr-Jul"], ["b", "a", "Apr-Jul", "Jan-Mar"]]) {
  const top = res4.slice().sort((x, y) => y.r1[fit] - x.r1[fit])[0];
  console.log(`   with the EMA filter, band picked on ${fl}: ${top.lbl} -> ${top.r1[test].toFixed(1)}% on ${tl} (as built with the filter: ${res4[0].r1[test].toFixed(1)}%)`);
}
const best4 = res4.slice(1).sort((x, y) => y.r1.y - x.r1.y)[0];
console.log(`\n   stress, all with the EMA filter: band from 0.45 (as built)  vs  from ${best4.lbl}`);
for (const [lbl, o] of [["as tested", {}], ["one bar later", { shifted: true }], ["2 ticks slippage", { extra: { slipMult: 2 } }],
                        ["breaker -$200", { extra: { breaker: 200 } }], ["breaker -$400", { extra: { breaker: 400 } }],
                        ["profit block +$150", { extra: { profitBlock: 150 } }], ["profit block +$350", { extra: { profitBlock: 350 } }],
                        ["3 lots (2 late)", { lots: (k) => (M.adrUsed(k) >= 0.9 ? 2 : 3) }], ["5 lots (3 late)", { lots: (k) => (M.adrUsed(k) >= 0.9 ? 3 : 5) }]]) {
  const r0 = run(o.shifted ? shift1(M.RESC) : M.RESC, true, o), r1 = run(o.shifted ? shift1(best4.sig) : best4.sig, true, o);
  console.log("   " + lbl.padEnd(22) + f1(r0.y) + " (" + f1(r0.a, 5).trim() + " / " + f1(r0.b, 5).trim() + ")   " + f1(r1.y) + " (" + f1(r1.a, 5).trim() + " / " + f1(r1.b, 5).trim() + ")");
}
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
