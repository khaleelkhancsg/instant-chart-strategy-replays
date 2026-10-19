// Stress test of the one level result that beat both nulls in
// research/levels_setups_2026.mjs: the 1-min MACD fade taken ONLY when the
// push being faded ran into a session volume level (prior-day POC, 5- and
// 20-session POC/HVN). 2026 only, honest fills, realistic costs, cancelOpposite.
//
// RESULT (2026 only): the level information is real; the rule is not yet.
// Against as many signals kept at random, 16 of 24 volume-level variants win
// at least 19 of 20 times, and every one with a 5- or 10-bar look-back wins
// at least 18 (+9 to +34 pass points, +$30 to +$117 a trade). The effect fades, and at the
// tight distance reverses, with a 20-bar look-back (the touch can then be 20
// minutes old). Fading into break-prone levels instead is worse than random.
// As a replacement for the unfiltered fade (58.5%) it is fragile: 3 or 5 lots
// drop it to ~45%, a 20-bar look-back to 22%, every real 21-day window passes
// 47.9%, and the gain is January-March only (71.5 vs 52.4; Apr-Jul 59.0 vs
// 68.5). It survives costs (61.7% at 2 ticks) and one bar of delay (58.3%).
//
//   node --max-old-space-size=8192 research/levels_fade_probe_2026.mjs

import fs from "node:fs";
import { macd } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const T0 = Date.now();
const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const FILL = { slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: 600, profitBlock: 250, cancelOpposite: true };
const LV = JSON.parse(fs.readFileSync(new URL("./levels_2026.json", import.meta.url), "utf8"));
const dateOf = (tday) => new Date(tday * 86400000).toISOString().slice(0, 10);
const NNULL = 30;

const E1 = S.engineFor(1), t1 = E1.tf, n1 = t1.close.length;
const hist = macd(t1.close, 12, 26, 9).hist;
const SIGA = new Int8Array(n1);
for (let i = 1; i < n1; i++) {
  if (!(t1.ctMin[i] >= 510 && t1.ctMin[i] < 900)) continue;
  SIGA[i] = -(hist[i] > 0 && hist[i - 1] <= 0 ? 1 : hist[i] < 0 && hist[i - 1] >= 0 ? -1 : 0);
}
const in26 = (k) => S.yearOf.get(t1.tday[k]) === 2026;
const BASE = { breaker: 200, trig: 0.15, tpFromFill: true, tpFn: (a, q) => Math.min(5.15 * a, 600 / (2 * q)) };

// levels of a session in lab prices, filtered by tag; twin > 0 moves each 1.5-6 R
const cache = new Map();
function lv(tday, re, twin) {
  const key = tday + "|" + re + "|" + twin;
  if (cache.has(key)) return cache.get(key);
  const e = LV[dateOf(tday)];
  let out = null;
  if (e && e.off != null) {
    const R = 0.05 * e.U, rnd = S.mul(tday * 7919 + twin * 104729);
    out = { R, p: [] };
    for (const [, t, p] of e.levels) {
      const sh = twin ? (rnd() < 0.5 ? -1 : 1) * (1.5 + 4.5 * rnd()) * R : 0;
      if (re.test(t)) out.p.push(p + e.off + sh);
    }
  }
  cache.set(key, out);
  return out;
}
const VPS = /^(pd_poc|vp5_poc|vp20_poc|vp5_hvn|vp20_hvn)$/;
// keep a 2026 fade only if the push's extreme over the last `win` bars came within
// `near` R of a level matching `re`
function filt({ re = VPS, near = 0.5, win = 10, twin = 0, dir = 0 } = {}) {
  const o = Int8Array.from(SIGA);
  let kept = 0;
  for (let k = 0; k < n1; k++) {
    if (!o[k] || !in26(k)) continue;
    const s = o[k], L = lv(t1.tday[k], re, twin);
    if (!L) continue;                                   // no levels that day: unchanged
    let x = s === -1 ? -Infinity : Infinity;
    for (let j = Math.max(0, k - win + 1); j <= k; j++) x = s === -1 ? Math.max(x, t1.high[j]) : Math.min(x, t1.low[j]);
    const hit = L.p.some((p) => Math.abs(p - x) <= near * L.R) && (dir === 0 || dir === s);
    if (hit) kept++; else o[k] = 0;
  }
  o.kept = kept;
  return o;
}
function randomKeep(nKeep, seed) {
  const elig = [];
  for (let k = 0; k < n1; k++) if (SIGA[k] && in26(k) && lv(t1.tday[k], VPS, 0)) elig.push(k);
  const rnd = S.mul(seed), o = Int8Array.from(SIGA);
  for (let j = elig.length - 1; j > 0; j--) { const q = Math.floor(rnd() * (j + 1)); [elig[j], elig[q]] = [elig[q], elig[j]]; }
  for (let j = nKeep; j < elig.length; j++) o[elig[j]] = 0;
  return o;
}
const pass = (arr, ix) => S.passArr(ix.map((k) => arr[k]), RULES);
function run(sig, lots = 4, extra = {}) {
  const tr = E1.run(() => lots, { signals: sig, ...FILL, ...BASE, ...extra }).filter((t) => S.yearOf.get(t.tday) === 2026);
  const arr = S.dayArr(tr, S.days);
  return { tr, arr, n: tr.length, exp: tr.reduce((s, t) => s + t.pnl, 0) / Math.max(1, tr.length),
           win: (100 * tr.filter((t) => t.pnl > 0).length) / Math.max(1, tr.length),
           y: pass(arr, M.Y26), a: pass(arr, M.Y26a), b: pass(arr, M.Y26b) };
}
const f1 = (x, w = 6) => x.toFixed(1).padStart(w);
const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const row = (lbl, r, extra = "") => console.log("  " + lbl.padEnd(58) + f1(r.y) + f1(r.a, 7) + f1(r.b, 7) + String(r.n).padStart(6) +
  f1(r.win) + f1(r.exp, 7) + extra);
const HD = "  " + "".padEnd(58) + "  2026 JanMar AprJul trades  win%   $/tr";

const base = run(SIGA);
console.log("\nMACD fade, 2026: unfiltered " + base.y.toFixed(1) + "% (Jan-Mar " + base.a.toFixed(1) + ", Apr-Jul " + base.b.toFixed(1) + ")\n");
console.log("1. the filter and its two nulls (" + NNULL + " runs each)\n" + HD + "   | twins: median  max | random: median  max");
const main = filt();
const rm = run(main);
const nullTw = [], nullRn = [];
for (let w = 1; w <= NNULL; w++) { nullTw.push(run(filt({ twin: w })).y); nullRn.push(run(randomKeep(main.kept, 5000 + w)).y); }
row("only fades whose push ran into a session volume level", rm,
    "   |" + f1(med(nullTw), 11) + f1(Math.max(...nullTw)) + " |" + f1(med(nullRn), 12) + f1(Math.max(...nullRn)));
console.log("     (" + main.kept + " of the 2026 signals kept)");

console.log("\n2. how close, and over how many bars (R = 5% of the average daily range, ~15-23 pts in 2026)\n" + HD);
for (const near of [0.25, 0.5, 1, 1.5]) for (const win of [5, 10, 20]) row(`within ${near} R of the push extreme, last ${win} bars`, run(filt({ near, win })));

console.log("\n3. which levels\n" + HD);
for (const [lbl, re] of [["POCs only (prior-day, 5-, 20-session)", /^(pd_poc|vp5_poc|vp20_poc)$/], ["HVNs only (5-, 20-session)", /^(vp5_hvn|vp20_hvn)$/],
                         ["prior-day POC only", /^pd_poc$/], ["5-session POC + HVNs", /^(vp5_poc|vp5_hvn)$/], ["20-session POC + HVNs", /^(vp20_poc|vp20_hvn)$/],
                         ["week/month POCs", /^(week|month)_(prior_poc|poc_n)$/], ["week/month HVNs", /^(week|month)_hvn$/],
                         ["session + week/month volume levels", /^(pd_poc|vp5_poc|vp20_poc|vp5_hvn|vp20_hvn|(week|month)_(prior_poc|poc_n))$/],
                         ["break-prone levels instead (PDH/PDL/ONH/ONL)", /^(prior_day_high|prior_day_low|overnight_high|overnight_low)$/],
                         ["prior-day close", /^prior_day_close$/]]) row(lbl, run(filt({ re })));

console.log("\n4. stress\n" + HD);
const shift1 = (s) => { const o = new Int8Array(s.length); for (let i = 1; i < s.length; i++) o[i] = s[i - 1]; return o; };
row("enter one bar later", run(shift1(main)));
row("sim fills (no slippage)", run(main, 4, { slipMult: 0 }));
row("2 ticks slippage each way", run(main, 4, { slipMult: 2 }));
row("commission $1.25/side", run(main, 4, { feeMult: 1.25 / 0.75 }));
for (const L of [3, 5, 6]) row(L + " lots", run(main, L));
for (const [br, pb] of [[300, 250], [200, 350], [0, 250], [200, 0]]) row("breaker " + (br ? "-$" + br : "off") + ", profit block " + (pb ? "+$" + pb : "off"), run(main, 4, { breaker: br, profitBlock: pb }));
row("longs only (fading pushes down into a level)", run(filt({ dir: 1 })));
row("shorts only (fading pushes up into a level)", run(filt({ dir: -1 })));

console.log("\n5. where the money came from");
const mo = new Map();
for (const t of rm.tr) { const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"][new Date(M.tf.ts[S.dayFirstBar.get(t.tday)] + 43200e3).getUTCMonth()]; mo.set(m, (mo.get(m) || 0) + t.pnl); }
console.log("  dollars by month: " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"].map((m) => m + " " + ((mo.get(m) || 0) >= 0 ? "+" : "") + Math.round(mo.get(m) || 0)).join("  "));
const d26 = M.Y26.map((k) => rm.arr[k]);
const jack = (K) => { const best = M.Y26.map((k) => [k, rm.arr[k]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, K);
  const a = Float64Array.from(rm.arr); for (const [k] of best) a[k] = 0; return pass(a, M.Y26); };
let cp = 0, cn = 0;
for (let s = 0; s + 21 <= d26.length; s++) { cp += S.evWith(d26.slice(s, s + 21), RULES); cn++; }
console.log("  best 1 / 3 / 5 days removed: " + [1, 3, 5].map((K) => jack(K).toFixed(1)).join(" / ") + "%;  every real 21-day window: " + (100 * cp / cn).toFixed(1) + "%");
const by = {};
for (const t of rm.tr) by[t.why] = (by[t.why] || 0) + 1;
console.log("  exits: " + Object.entries(by).map(([w, n]) => w + " " + n).join(", ") + ";  days traded " + d26.filter((v) => v !== 0).length + " of " + d26.length);
// 6. every variant against its own same-count random null: is the LEVEL
// information real even where the pass rate is noisy?
console.log("\n6. each variant vs dropping the same number of signals at random (20 runs): pass rate and $/trade, real minus null median");
console.log("  " + "".padEnd(46) + "  real  null  diff  beats |  real$  null$   diff");
let wins = 0, cells = 0;
for (const [lname, re] of [["session volume levels", VPS], ["HVNs only", /^(vp5_hvn|vp20_hvn)$/],
                           ["session + week/month volume", /^(pd_poc|vp5_poc|vp20_poc|vp5_hvn|vp20_hvn|(week|month)_(prior_poc|poc_n))$/],
                           ["break-prone (PDH/PDL/ONH/ONL)", /^(prior_day_high|prior_day_low|overnight_high|overnight_low)$/]]) {
  for (const near of [0.5, 1]) for (const win of [5, 10, 15, 20]) {
    const f = filt({ re, near, win }), r = run(f);
    const nl = [];
    for (let w = 1; w <= 20; w++) nl.push(run(randomKeep(f.kept, 7000 + w)));
    const ny = med(nl.map((x) => x.y)), ne = med(nl.map((x) => x.exp));
    const beats = nl.filter((x) => r.y > x.y).length;
    if (lname !== "break-prone (PDH/PDL/ONH/ONL)") { cells++; if (beats >= 19) wins++; }
    console.log("  " + `${lname}, ${near} R, ${win} bars`.padEnd(46) + f1(r.y) + f1(ny) + f1(r.y - ny) + String(beats).padStart(5) + "/20 |" +
                f1(r.exp, 7) + f1(ne, 7) + f1(r.exp - ne, 7));
  }
}
console.log("  volume-level variants beating at least 19 of 20 random nulls: " + wins + " of " + cells);
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
