// Stage 2: search COMBINATIONS, and measure how much of the best one is luck.
//
// Stage 1 (donchian_exit_search.mjs) moved one lever at a time and nothing
// survived. Levers can interact -- a wider target might only pay with a trail
// behind it, an indicator exit might only pay with a different bracket -- so
// this draws random configurations from the JOINT space:
//
//   exit signal    none, or one of the 27 readings x 4 conditions x grace
//   stop move      none, breakeven, chandelier, n-bar structure, time-tightened
//   time exit      none, still under water after N, never reached y ATR by N,
//                  out after N regardless
//   bracket        stop 3-8 ATR, target 1.25-3 ATR, stop-entry 0.1-0.3 ATR
//   account        6-10 lots, breaker, profit block
//
// Judged on the CURRENT regime, as asked: a config is an improvement if it
// beats the live book in 2025 AND in 2026, whatever it did in 2019-24 (those
// are printed for context only). With thousands of draws the best score in any
// one year is guaranteed to look good, so the two years check each other: pick
// on 2025 and read 2026, pick on 2026 and read 2025. A null of random-coin
// exits shows how often "better in both years" happens by chance.
//
// RESULT (30,000 configs, 2.16B windows, 18 min): nothing transfers between
// years. Picked on 2025, the best is -11.9pp against the live book in 2026;
// picked on 2026, -15.3pp in 2025 (selection bias 23-33pp). 2 of 30,000 beat
// the live book in both years -- fewer than random-coin exits manage (2.2%) --
// and both are 7 lots with a 4 ATR stop (+6.5/+7.1 in 2026, 2025 flat). Inside
// 2026 it is lopsided: picked on Jan-Mar, the top 10 average +7.7pp on
// Apr-Jul; picked on Apr-Jul, -18.3pp on Jan-Mar. The leaders by 2026 all use
// 6-7 lots and a 20-bar "not working" exit (see donchian_2026_final.mjs).
//
//   node --max-old-space-size=6144 research/donchian_joint_search.mjs [N=20000]

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { ema, sma, adx, rsi, donchian, efficiencyRatio, macd, rollingMinMax, supertrend } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";

const N = Number(process.argv[2] || 20000);
const T0 = Date.now();
const { bars } = loadBars();
const tf = resample(bars, 2);
const { open: O, high: H, low: L, close: C, volume: V, ctMin: CT, tday: TD } = tf;
const n2 = C.length;

const { adx: ax, pdi, ndi } = adx(H, L, C, 14);
const { high: dh, low: dl } = donchian(H, L, 30);
const raw = new Int8Array(n2);
for (let i = 30; i < n2; i++) {
  if (ax[i] < 25) continue;
  if (C[i] > dh[i]) raw[i] = 1; else if (C[i] < dl[i]) raw[i] = -1;
}
const fctx = buildFilterContext(tf);
const gated = (x) => applyFilters(raw, fctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: x });
const G05 = gated(0.5), G045 = gated(0.45);
const t125 = ema(C, 125), t500 = ema(C, 500);
const RESC = Int8Array.from(G05);
for (let k = 0; k < n2; k++)
  if (G045[k] && !G05[k] && Math.sign(t125[k] - t500[k]) === raw[k]) RESC[k] = G045[k];

const E = {}; for (const p of [9, 20, 21, 50]) E[p] = ema(C, p);
const DC = {}; for (const n of [5, 10, 15, 20]) DC[n] = donchian(H, L, n);
const RM = {}; for (const n of [3, 5, 10, 20]) RM[n] = rollingMinMax(H, L, n);
const ER10 = efficiencyRatio(C, 10);
const ST2 = supertrend(H, L, C, 10, 2).trend, ST3 = supertrend(H, L, C, 10, 3).trend;
const RSI = rsi(C, 14);
const MH = macd(C, 12, 26, 9).hist;
const VA = sma(V, 20);
const VW = new Float64Array(n2).fill(NaN);
{
  let pv = 0, vv = 0, day = -1, on = false;
  for (let i = 0; i < n2; i++) {
    if (TD[i] !== day) { day = TD[i]; on = false; }
    if (CT[i] >= 510 && CT[i] < 960) {
      if (!on) { pv = 0; vv = 0; on = true; }
      const tp = (H[i] + L[i] + C[i]) / 3;
      pv += tp * V[i]; vv += V[i];
      VW[i] = vv > 0 ? pv / vv : tp;
    }
  }
}

const upnl = (k, st) => (C[k] - st.fill) * st.dir;
const mfe = (st) => (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn);
const CONDS = [
  ["always", () => true],
  ["under water", (k, st) => upnl(k, st) < 0],
  ["1 ATR down", (k, st) => upnl(k, st) <= -st.atr],
  ["never green", (k, st) => mfe(st) < 0.5 * st.atr],
];
const SIGS = [
  ["back inside channel", (k, d, st) => (d === 1 ? C[k] < dh[st.sigBar] : C[k] > dl[st.sigBar])],
  ["back inside by 0.5 ATR", (k, d, st) => (d === 1 ? C[k] < dh[st.sigBar] - 0.5 * st.atr : C[k] > dl[st.sigBar] + 0.5 * st.atr)],
  ["30-bar midline", (k, d) => (C[k] - (dh[k] + dl[k]) / 2) * d < 0],
  ["Turtle 5", (k, d) => (d === 1 ? C[k] < DC[5].low[k] : C[k] > DC[5].high[k])],
  ["Turtle 10", (k, d) => (d === 1 ? C[k] < DC[10].low[k] : C[k] > DC[10].high[k])],
  ["Turtle 20", (k, d) => (d === 1 ? C[k] < DC[20].low[k] : C[k] > DC[20].high[k])],
  ["EMA 9", (k, d) => (C[k] - E[9][k]) * d < 0],
  ["EMA 20", (k, d) => (C[k] - E[20][k]) * d < 0],
  ["EMA 50", (k, d) => (C[k] - E[50][k]) * d < 0],
  ["EMA 9/21 cross", (k, d) => (E[9][k] - E[21][k]) * d < 0],
  ["DI cross", (k, d) => (d === 1 ? ndi[k] > pdi[k] : pdi[k] > ndi[k])],
  ["ADX < 20", (k) => ax[k] < 20],
  ["efficiency collapse", (k, d) => ER10[k] < 0.2 && (C[k] - C[k - 10]) * d < 0],
  ["Supertrend 2", (k, d) => ST2[k] === -d],
  ["Supertrend 3", (k, d) => ST3[k] === -d],
  ["VWAP", (k, d) => (C[k] - VW[k]) * d < 0],
  ["RSI 50", (k, d) => (RSI[k] - 50) * d < 0],
  ["RSI 40/60", (k, d) => (d === 1 ? RSI[k] < 40 : RSI[k] > 60)],
  ["MACD hist", (k, d) => MH[k] * d < 0],
  ["ROC 10", (k, d) => (C[k] - C[k - 10]) * d < 0],
  ["volume rejection", (k, d, st) => V[k] >= 2 * VA[k] && (C[k] - O[k]) * d <= -0.5 * st.atr],
];

// ---- one random configuration --------------------------------------------------
const rnd = S.mul(20260928);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const U = (lo, hi, step) => Math.round((lo + rnd() * (hi - lo)) / step) * step;
function draw() {
  const c = {};
  if (rnd() < 0.55) c.ex = [Math.floor(rnd() * SIGS.length), Math.floor(rnd() * CONDS.length), rnd() < 0.5 ? 0 : 3];
  const sr = rnd();
  if (sr < 0.15) c.st = ["be", U(0.5, 2, 0.25), U(-0.5, 0.5, 0.25)];
  else if (sr < 0.3) c.st = ["ch", U(0, 1.5, 0.5), U(1.5, 5, 0.5)];
  else if (sr < 0.4) c.st = ["sb", pick([3, 5, 10, 20]), pick([0, 0.5, 1])];
  else if (sr < 0.5) c.st = ["tt", pick([5, 10, 15, 20, 30, 40]), U(1, 4, 0.5)];
  const tr = rnd();
  if (tr < 0.12) c.tx = ["uw", pick([10, 20, 30, 45, 60])];
  else if (tr < 0.24) c.tx = ["nr", pick([10, 20, 30]), pick([0.5, 1])];
  else if (tr < 0.36) c.tx = ["mx", pick([30, 45, 60, 90, 120])];
  c.sl = pick([3, 4, 5, 5, 6, 8]);
  c.tp = pick([1.25, 1.5, 1.75, 1.75, 2, 2.25, 2.5, 3]);
  c.trig = pick([0.1, 0.15, 0.15, 0.2, 0.3]);
  c.lots = pick([6, 7, 8, 8, 9, 10]);
  c.br = pick([300, 400, 500, 500, 650, 800, 0]);
  c.pb = pick([500, 750, 750, 1000, 1500, 0]);
  return c;
}
function name(c) {
  const p = [];
  if (c.ex) p.push("exit " + SIGS[c.ex[0]][0] + " (" + CONDS[c.ex[1]][0] + (c.ex[2] ? ", 3-bar grace" : "") + ")");
  if (c.st) p.push({ be: `BE +${c.st[1]}->${c.st[2]}`, ch: `trail ${c.st[2]} ATR${c.st[1] ? " once +" + c.st[1] : ""}`,
                     sb: `${c.st[1]}-bar low${c.st[2] ? " once +" + c.st[2] : ""}`, tt: `after ${c.st[1]} bars stop ${c.st[2]} ATR` }[c.st[0]]);
  if (c.tx) p.push({ uw: `out if under water at ${c.tx[1]} bars`, nr: `out if not +${c.tx[2]} ATR by ${c.tx[1]} bars`,
                     mx: `max hold ${c.tx[1]} bars` }[c.tx[0]]);
  p.push(`${c.sl}/${c.tp} ATR, trig ${c.trig}, ${c.lots} lots, br ${c.br || "off"}, pb ${c.pb || "off"}`);
  return p.join("; ");
}
function build(c) {
  const o = { slMult: c.sl, tpMult: c.tp, trig: c.trig, breaker: c.br, profitBlock: c.pb };
  let ex = null, tx = null;
  if (c.ex) { const [si, ci, g] = c.ex, sf = SIGS[si][1], cf = CONDS[ci][1];
    ex = (k, d, st) => k >= st.entBar + g && cf(k, st) && sf(k, d, st); }
  if (c.tx) {
    const [t, a, b] = c.tx;
    tx = t === "uw" ? (k, d, st) => k - st.entBar >= a && upnl(k, st) <= 0
       : t === "nr" ? (k, d, st) => k - st.entBar >= a && mfe(st) < b * st.atr
       : (k, d, st) => k - st.entBar >= a;
  }
  if (ex || tx) o.exitFn = (k, d, st) => (ex !== null && ex(k, d, st)) || (tx !== null && tx(k, d, st));
  if (c.st) {
    const [t, a, b] = c.st;
    o.stopFn = t === "be" ? (k, st) => (mfe(st) >= a * st.atr ? st.fill + st.dir * b * st.atr : null)
             : t === "ch" ? (k, st) => (mfe(st) >= a * st.atr ? (st.dir === 1 ? st.mx - b * st.atr : st.mn + b * st.atr) : null)
             : t === "sb" ? (k, st) => (mfe(st) >= b * st.atr ? (st.dir === 1 ? RM[a].low[k] : RM[a].high[k]) : null)
             : (k, st) => (k - st.entBar >= a ? st.fill - st.dir * b * st.atr : null);
  }
  return o;
}

// Weighted to the current regime, as asked: the question is whether a config
// beats the live book in 2025 AND in 2026. Each year is the other's
// out-of-sample check; the full history is printed for context only.
const days = S.days, NH = days.length >> 1;
const yIdx = (f) => days.map((d, k) => (f(S.yearOf.get(d)) ? k : -1)).filter((k) => k >= 0);
const Y25 = yIdx((y) => y === 2025), Y26 = yIdx((y) => y === 2026), Y2526 = yIdx((y) => y >= 2025);
// 2026 in two parts, so selection can be checked INSIDE 2026 as well
const monthOf = new Map();
for (let i = 0; i < n2; i++) if (!monthOf.has(TD[i])) monthOf.set(TD[i], new Date(tf.ts[i] + 43200e3).getUTCMonth());
const Y26a = Y26.filter((k) => monthOf.get(days[k]) < 3), Y26b = Y26.filter((k) => monthOf.get(days[k]) >= 3);
function scoreOpts(opts, lots) {
  const tr = S.run(() => lots, { signals: RESC, ...opts });
  const arr = S.dayArr(tr, days);
  const at = (ix) => S.passArr(ix.map((k) => arr[k]));
  return { n: tr.length, all: S.passArr(arr), h1: S.passArr(arr.slice(0, NH)), h2: S.passArr(arr.slice(NH)),
           y25: at(Y25), y26: at(Y26), r2: at(Y2526), a26: at(Y26a), b26: at(Y26b),
           exp: tr.reduce((a, t) => a + t.pnl, 0) / tr.length };
}
const score = (c) => scoreOpts(build(c), c.lots);
const LIVE = { sl: 5, tp: 1.75, trig: 0.15, lots: 8, br: 500, pb: 750 };
const base = score(LIVE);
const res = [];
for (let t = 0; t < N; t++) {
  const c = draw();
  res.push({ c, ...score(c) });
  if ((t + 1) % 2000 === 0) process.stderr.write(`  ${t + 1}/${N}  ${((Date.now() - T0) / 1000).toFixed(0)}s\n`);
}

const f1 = (x) => x.toFixed(1).padStart(6);
const sg = (x) => ((x >= 0 ? "+" : "") + x.toFixed(1)).padStart(6);
const edge = (r) => Math.min(r.y25 - base.y25, r.y26 - base.y26);
const line = (r) => [r.y25, r.y26, r.r2].map(f1).join("") + sg(r.y25 - base.y25) + sg(r.y26 - base.y26) + "  " +
  [r.all, r.h1, r.h2].map(f1).join("") + ("$" + r.exp.toFixed(0)).padStart(6) + String(r.n).padStart(6);
const HD = "  " + ["2025", "2026", "25-26"].map((x) => x.padStart(6)).join("") + " d2025 d2026  " +
  ["all", "1stH", "2ndH"].map((x) => x.padStart(6)).join("") + "  $/tr trades";
console.log("\n" + "=".repeat(120));
console.log("STAGE 2 -- " + N.toLocaleString() + " random combinations, " +
  ((N + 1) * 6 * 12000 / 1e6).toFixed(0) + "M evaluation windows, " + ((Date.now() - T0) / 60000).toFixed(1) + " min");
console.log("=".repeat(120));
console.log("\n" + HD);
console.log("  " + line(base) + "   live book");

// ---- cross-validation across the two recent years, and INSIDE 2026 ---------------
for (const [fit, test, fl, tl] of [["y25", "y26", "2025", "2026"], ["y26", "y25", "2026", "2025"],
                                   ["a26", "b26", "Jan-Mar 2026", "Apr-Jul 2026"], ["b26", "a26", "Apr-Jul 2026", "Jan-Mar 2026"]]) {
  const sorted = res.slice().sort((a, b) => b[fit] - a[fit]);
  console.log("\n  PICKED ON " + fl + ", READ ON " + tl + " (live " + tl + ": " + base[test].toFixed(1) + "%)");
  for (const K of [1, 10, 100]) {
    const top = sorted.slice(0, K);
    const m = (f) => top.reduce((a, r) => a + r[f], 0) / top.length;
    console.log("    best " + String(K).padStart(3) + ": " + m(fit).toFixed(1) + "% in " + fl + ", " + m(test).toFixed(1) +
      "% in " + tl + "  (selection bias " + (m(fit) - m(test) - (base[fit] - base[test])).toFixed(1) + "pp; vs live in " + tl + " " +
      sg(m(test) - base[test]).trim() + "pp)");
  }
  console.log("    the single best: " + name(sorted[0].c));
}

// ---- null calibration --------------------------------------------------------------
// What does "beats the live book in both years" look like by CHANCE? The live
// config plus an exit that fires at random -- a coin at a random rate, under a
// random condition -- carries no information by construction.
const NULLS = Math.max(200, Math.round(N / 15));
const nullEdge = [];
for (let t = 0; t < NULLS; t++) {
  const h = 0.002 + rnd() * 0.05, ci = Math.floor(rnd() * CONDS.length), seed = t + 1, cf = CONDS[ci][1];
  const coin = (k) => { let x = (k * 2654435761 + seed * 97531) >>> 0; x ^= x >>> 16; x = Math.imul(x, 2246822507) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };
  const r = scoreOpts({ slMult: 5, tpMult: 1.75, trig: 0.15, breaker: 500, profitBlock: 750,
                        exitFn: (k, d, st) => k >= st.entBar && cf(k, st) && coin(k) < h }, 8);
  nullEdge.push(edge(r));
}
nullEdge.sort((a, b) => a - b);
const q = (p) => nullEdge[Math.min(nullEdge.length - 1, Math.floor(p * nullEdge.length))];
const realEdge = res.map(edge).sort((a, b) => a - b);
const frac = (arr, x) => arr.filter((v) => v > x).length / arr.length;
console.log("\n  NULL: " + NULLS + " configs that are the live book plus a random-coin exit. Their worse-year change vs live:");
console.log("    median " + sg(q(0.5)).trim() + "pp, 90th pct " + sg(q(0.9)).trim() + ", 99th " + sg(q(0.99)).trim() +
  ", max " + sg(nullEdge[nullEdge.length - 1]).trim());
for (const x of [0, 1, 2, 3, 5])
  console.log("    beat live by more than " + x + "pp in BOTH years:  searched " + (100 * frac(realEdge, x)).toFixed(2) +
    "% of configs (" + realEdge.filter((v) => v > x).length + ")   random coins " + (100 * frac(nullEdge, x)).toFixed(2) + "%");

// ---- the candidates --------------------------------------------------------------
const good = res.filter((r) => edge(r) > 0).sort((a, b) => edge(b) - edge(a));
console.log("\n  TOP 25 BY THE WORSE OF THE TWO YEARS (both years better than live)\n" + HD);
console.log("  " + line(base) + "   live book");
for (const r of good.slice(0, 25)) console.log("  " + line(r) + "   " + name(r.c));
fs.writeFileSync(new URL("./donchian_joint_search_results.json", import.meta.url),
  JSON.stringify({ base, nullEdge, res: res.map((r) => ({ ...r, name: name(r.c) })) }));
