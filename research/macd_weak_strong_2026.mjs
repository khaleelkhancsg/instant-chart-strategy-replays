// Fade the weak MACD crosses AND follow the strong ones? 2026 ONLY, $1,250
// rules, honest fills, realistic costs, cancelOpposite, causal exit order.
//
// A histogram cross is WEAK when the MACD line sits on the other side of zero
// (a bounce against the short-term trend) and STRONG when it sits on the same
// side (the trend resuming). Fading a weak cross and following a strong one
// both mean trading the MACD line's direction -- so "fade weak + follow strong"
// is a short-term trend system that uses the crosses as timing. Two ways to
// run it: exit at every cross and re-enter (each trade one cross-to-cross
// segment, like the fade), or hold while the direction persists.
//
// RESULT (2026 only): follow the strong crosses? No -- keep them as a filter.
// Cross by cross, following a strong cross makes +0.7 pts a trade after costs
// [-1.2, +2.7] while fading it loses -3.4 [-5.3, -1.7]: the continuation is
// real (~2 pts gross) but about the size of the round-trip costs. In the full
// setup, following strong crosses alone passes 33.5% -- no better than random
// directions at the same crosses (median 31.8%, beaten 16 of 30). Added to the
// weak-cross fade: 63.0% (fade-weak only 64.5%); with the volatility gate on
// both, 68.4% vs 67.7% -- ahead under 2 ticks of slippage, a +$350 profit
// block and 3 lots, level otherwise -- but it trades Apr-Jul for Jan-Mar
// (66.3 vs 73.8; it fails the half-pick check) and one bar late it is 36.0%
// vs 45.0%. Holding through same-direction crosses instead is worse (55%).
//
//   node --max-old-space-size=8192 research/macd_weak_strong_2026.mjs

import { macd } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const T0 = Date.now();
const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const E1 = S.engineFor(1), t = E1.tf, A = E1.atr;
const { open: O, high: H, low: L, close: C, ctMin: CT, tday: TD } = t;
const n = C.length;
const { line: ML, hist: HS } = macd(C, 12, 26, 9);
const TICK = 0.25, COST = 1.25;
const isCross = (i) => i >= 1 && ((HS[i] > 0 && HS[i - 1] <= 0) || (HS[i] < 0 && HS[i - 1] >= 0));
const rthSig = (i) => CT[i] >= 510 && CT[i] < 900;
const crossDir = new Int8Array(n), cls = new Int8Array(n);          // cls: 1 weak, 2 strong
for (let i = 1; i < n; i++) {
  if (!isCross(i)) continue;
  crossDir[i] = HS[i] > 0 ? 1 : -1;
  const m = Math.sign(ML[i]);
  cls[i] = m === -crossDir[i] ? 1 : m === crossDir[i] ? 2 : 0;
}
// signals: the fade (as built) and the MACD line's direction at every RTH cross
const SIGA = new Int8Array(n), SIGT = new Int8Array(n);
for (let i = 1; i < n; i++) if (crossDir[i] && rthSig(i)) { SIGA[i] = -crossDir[i]; SIGT[i] = Math.sign(ML[i]) || 0; }
// volatility vs its 10-session RTH average (as macd_optimize_2026.mjs)
const volRel = new Float64Array(n).fill(NaN);
{
  const days = [], first = new Map(), last = new Map();
  for (let i = 0; i < n; i++) if (rthSig(i)) { if (!first.has(TD[i])) { first.set(TD[i], i); days.push(TD[i]); } last.set(TD[i], i); }
  const am = new Map();
  for (const d of days) { let s = 0, c = 0; for (let i = first.get(d); i <= last.get(d); i++) { s += A[i]; c++; } am.set(d, s / c); }
  days.forEach((d, q) => { if (q < 10) return; const avg = days.slice(q - 10, q).reduce((x, p) => x + am.get(p), 0) / 10;
    for (let i = first.get(d); i <= last.get(d); i++) volRel[i] = A[i] / avg; });
}
const f2 = (x, w = 7) => (Number.isFinite(x) ? x.toFixed(2) : "-").padStart(w);
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);

// ---- 1. cross by cross: fade vs follow, weak vs strong ----------------------------
// The setup's entry in direction s (stop 0.15 ATR beyond the next open, live 10
// bars, cancelled by the next cross, refused stop -> limit) and its exit (the
// next cross at the following open -- before that bar's stop/target -- or the
// bracket: stop 5 ATR / $600 line at 4 lots, target min(5.15 ATR, 75) from the
// trigger), in points after costs.
function trade(k, s) {
  const d = TD[k], arm = k + 1;
  if (TD[arm] !== d || CT[arm] >= 895) return null;
  const a = A[k], px = O[arm] + s * Math.max(0.15 * a, TICK);
  let f = -1, lim = false;
  for (let i = arm + 1; i <= arm + 10 && i < n && TD[i] === d && CT[i] < 905; i++) {
    if (isCross(i - 1) && rthSig(i - 1)) break;
    if (i === arm + 1 && (s === 1 ? O[i] >= px : O[i] <= px)) { lim = true; if (s === 1 ? L[i] <= px : H[i] >= px) { f = i; break; } continue; }
    if (lim ? (s === 1 ? L[i] <= px : H[i] >= px) : (s === 1 ? H[i] >= px : L[i] <= px)) { f = i; break; }
  }
  if (f < 0) return null;
  const avg = px + s * TICK, ref = O[arm];
  const sl = s === 1 ? Math.max(ref - 5 * a, avg - 75) : Math.min(ref + 5 * a, avg + 75);
  const tp = px + s * Math.max(Math.min(5.15 * a, 75), TICK);
  const out = (x) => s * (x - avg) - TICK - 0.75;
  for (let i = f; i < n; i++) {
    if (i > f) {
      if (TD[i] !== d || CT[i] >= 905) return out(TD[i] === d ? O[i] : C[i - 1]);
      if (s === 1 ? O[i] <= sl : O[i] >= sl) return out(O[i]);
      if (isCross(i - 1) && rthSig(i - 1)) return out(O[i]);
    }
    if (s === 1) { if (L[i] <= sl) return out(sl); if (H[i] >= tp && !(lim && i === f && C[i] < tp)) return out(tp); }
    else { if (H[i] >= sl) return out(sl); if (L[i] <= tp && !(lim && i === f && C[i] > tp)) return out(tp); }
  }
  return null;
}
const ev = [];
for (let k = 1; k < n - 2; k++) {
  if (!crossDir[k] || !rthSig(k) || S.yearOf.get(TD[k]) !== 2026 || !cls[k]) continue;
  ev.push({ k, d: TD[k], m: new Date(t.ts[k]).getUTCMonth(), early: CT[k] < 540, vol: volRel[k] >= 1, cls: cls[k],
            fade: trade(k, -crossDir[k]), follow: trade(k, crossDir[k]) });
}
{
  const byDay = new Map();
  for (const e of ev) { const a = byDay.get(e.d) || []; a.push(e); byDay.set(e.d, a); }
  for (const a of byDay.values()) a.forEach((e, q) => { e.nth = q + 1; });
}
const rnd = S.mul(42);
function stat(xs, key) {
  const by = new Map();
  for (const e of xs) if (e[key] !== null) { const a = by.get(e.d) || []; a.push(e[key]); by.set(e.d, a); }
  const ks = [...by.keys()];
  let s = 0, c = 0;
  for (const a of by.values()) for (const x of a) { s += x; c++; }
  const bs = [];
  for (let b = 0; b < 400; b++) { let s2 = 0, c2 = 0; for (let j = 0; j < ks.length; j++) for (const x of by.get(ks[Math.floor(rnd() * ks.length)])) { s2 += x; c2++; } bs.push(s2 / Math.max(1, c2)); }
  bs.sort((x, y) => x - y);
  return { n: c, m: s / Math.max(1, c), lo: bs[10], hi: bs[389] };
}
console.log(`1. CROSS BY CROSS (2026: ${ev.length} RTH crosses; mean points a trade after ${COST} pts of costs, 95% day-clustered CI)`);
console.log("  " + "".padEnd(34) + "         FADE it                         FOLLOW it");
for (const [lbl, test] of [["weak crosses (bounces)", (e) => e.cls === 1], ["strong crosses (resumptions)", (e) => e.cls === 2],
                           ["weak, first 30 min", (e) => e.cls === 1 && e.early], ["strong, first 30 min", (e) => e.cls === 2 && e.early],
                           ["weak, after 09:00", (e) => e.cls === 1 && !e.early], ["strong, after 09:00", (e) => e.cls === 2 && !e.early],
                           ["weak, ATR >= 10-day average", (e) => e.cls === 1 && e.vol], ["strong, ATR >= 10-day average", (e) => e.cls === 2 && e.vol],
                           ["strong, ATR < 10-day average", (e) => e.cls === 2 && !e.vol],
                           ["weak, 1st-2nd cross of the day", (e) => e.cls === 1 && e.nth <= 2], ["strong, 1st-2nd cross of the day", (e) => e.cls === 2 && e.nth <= 2]]) {
  const xs = ev.filter(test);
  const cell = (key) => { const r = stat(xs, key); return f2(r.m) + " [" + f2(r.lo, 6) + "," + f2(r.hi, 6) + "]" + String(r.n).padStart(6); };
  const half = (key) => f2(stat(xs.filter((e) => e.m < 3), key).m, 6) + "/" + f2(stat(xs.filter((e) => e.m >= 3), key).m, 6).trim();
  console.log("  " + lbl.padEnd(34) + cell("fade") + " " + half("fade").padStart(13) + "  " + cell("follow") + " " + half("follow").padStart(13));
}
console.log("  (each cell: mean [CI] n, then Jan-Mar/Apr-Jul)");

// ---- 2. the full setup -------------------------------------------------------------
const pass = (arr, ix) => S.passArr(ix.map((k) => arr[k]), RULES);
const OPT = { slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: 600, cancelOpposite: true, exitFirst: true, trig: 0.15, addWin: 10,
              tpFromFill: true, tpFn: (a, q) => Math.min(5.15 * a, 600 / (2 * q)), breaker: 200, profitBlock: 250 };
// enter(k) -> whether the signal at bar k may place an order (every signal still exits)
function run({ sig, enter = null, flipAll = false, lots = 4, extra = {} }) {
  const sizer = (a, ct, sq, arm) => (enter && S.yearOf.get(TD[arm]) === 2026 && !enter(arm - 1) ? 0 : lots);
  const tr = E1.run(sizer, { signals: sig, ...OPT, flipAll, ...extra }).filter((x) => S.yearOf.get(x.tday) === 2026);
  const arr = S.dayArr(tr, S.days), d = M.Y26.map((k) => arr[k]);
  let cp = 0, cn = 0;
  for (let s = 0; s + 21 <= d.length; s++) { cp += S.evWith(d.slice(s, s + 21), RULES); cn++; }
  const part = (c) => { const x = tr.filter((q) => cls[q.sigBar] === c); return { n: x.length, exp: x.reduce((s, q) => s + q.pnl, 0) / Math.max(1, x.length) }; };
  return { tr, n: tr.length, exp: tr.reduce((s, x) => s + x.pnl, 0) / Math.max(1, tr.length), win: (100 * tr.filter((x) => x.pnl > 0).length) / Math.max(1, tr.length),
           y: pass(arr, M.Y26), a: pass(arr, M.Y26a), b: pass(arr, M.Y26b), real: (100 * cp) / cn, weak: part(1), strong: part(2) };
}
const HD = "  " + "".padEnd(58) + "  2026 JanMar AprJul  real trades   $/tr | weak: n  $/tr | strong: n  $/tr";
const line = (lbl, r) => "  " + lbl.padEnd(58) + f1(r.y) + f1(r.a, 7) + f1(r.b, 7) + f1(r.real) + String(r.n).padStart(7) + f1(r.exp, 7) +
  " |" + String(r.weak.n).padStart(8) + f1(r.weak.exp, 6) + " |" + String(r.strong.n).padStart(10) + f1(r.strong.exp, 6);
const weak = (k) => cls[k] === 1, strong = (k) => cls[k] === 2, vol = (k) => !(volRel[k] < 1);
const V = [
  ["fade every cross (the setup, causal exits)", { sig: SIGA }],
  ["fade weak only (the pullback filter)", { sig: SIGA, enter: weak }],
  ["fade weak only + volatility gate (the best so far)", { sig: SIGA, enter: (k) => weak(k) && vol(k) }],
  ["follow strong only, out at every cross", { sig: SIGT, enter: strong, flipAll: true }],
  ["follow strong only, held until the direction flips", { sig: SIGT, enter: strong }],
  ["fade weak + follow strong, out at every cross", { sig: SIGT, flipAll: true }],
  ["fade weak + follow strong, held until the direction flips", { sig: SIGT }],
  ["fade weak + follow strong, out at every cross, vol gate", { sig: SIGT, flipAll: true, enter: vol }],
  ["... vol gate on the fades only", { sig: SIGT, flipAll: true, enter: (k) => strong(k) || vol(k) }],
  ["held until it flips, vol gate", { sig: SIGT, enter: vol }],
];
console.log("\n2. THE FULL SETUP ($1,250 rules, 4 lots, -$200 / +$250; the weak/strong columns split the trades by the cross they came from)\n" + HD);
const res = V.map(([lbl, o]) => { const r = run(o); console.log(line(lbl, r)); return { lbl, o, r }; });
for (const [fit, test, fl, tl] of [["a", "b", "Jan-Mar", "Apr-Jul"], ["b", "a", "Apr-Jul", "Jan-Mar"]]) {
  const top = res.slice().sort((x, y) => y.r[fit] - x.r[fit])[0];
  console.log(`    picked on ${fl}: ${top.lbl} -> ${top.r[test].toFixed(1)}% on ${tl} (the setup: ${res[0].r[test].toFixed(1)}%)`);
}

// ---- 3. is "follow" any better than a coin flip at the strong crosses? ------------------
console.log("\n3. NULLS: the same crosses traded in a random direction (30 runs)");
for (const [lbl, base, mask] of [["strong crosses only, out at every cross", { enter: strong, flipAll: true }, strong],
                                 ["every cross, out at every cross", { flipAll: true }, null],
                                 ["weak crosses only (the fade's filter)", { enter: weak }, weak]]) {
  const ys = [], es = [];
  for (let w = 1; w <= 30; w++) {
    const r2 = S.mul(3100 + w), sg = new Int8Array(n);
    for (let i = 0; i < n; i++) if (SIGT[i] || SIGA[i]) sg[i] = r2() < 0.5 ? 1 : -1;
    const r = run({ sig: sg, ...base });
    ys.push(r.y); es.push(r.exp);
  }
  ys.sort((a, b) => a - b); es.sort((a, b) => a - b);
  const real = run({ sig: mask === weak ? SIGA : SIGT, ...base });
  console.log(`  ${lbl.padEnd(42)} random direction: median ${ys[15].toFixed(1)}% ($${es[15].toFixed(0)}/trade), max ${ys[29].toFixed(1)}%   real: ${real.y.toFixed(1)}% ($${real.exp.toFixed(0)}/trade), beats ${ys.filter((v) => real.y > v).length}/30`);
}

// ---- 4. stress the combined systems against the best fade --------------------------------
const shift1 = (a) => { const o = new Int8Array(a.length); for (let i = 1; i < a.length; i++) o[i] = a[i - 1]; return o; };
console.log("\n4. STRESS (2026 / Jan-Mar / Apr-Jul)");
const CAND = [["fade weak + vol gate", { sig: SIGA, enter: (k) => weak(k) && vol(k) }], ["weak+strong + vol gate", { sig: SIGT, flipAll: true, enter: vol }],
              ["weak+strong, out every cross", { sig: SIGT, flipAll: true }],
              ["weak+strong, held", { sig: SIGT }], ["follow strong only", { sig: SIGT, enter: strong, flipAll: true }]];
console.log("  " + "".padEnd(24) + CAND.map(([l]) => l.padStart(26)).join(""));
for (const [sl, so] of [["as tested", {}], ["one bar later", { late: true }], ["2 ticks slippage", { extra: { slipMult: 2 } }],
                        ["breaker -$300", { extra: { breaker: 300 } }], ["profit block +$350", { extra: { profitBlock: 350 } }],
                        ["3 lots", { lots: 3 }], ["5 lots", { lots: 5 }]]) {
  const cells = CAND.map(([, co]) => {
    const o = { ...co, ...so };
    if (so.late) { o.sig = shift1(co.sig); if (co.enter) { const g = co.enter; o.enter = (k) => g(k - 1); } delete o.late; }
    const r = run(o);
    return (f1(r.y, 5) + " " + f1(r.a, 4) + "/" + f1(r.b, 4).trim()).padStart(26);
  });
  console.log("  " + sl.padEnd(24) + cells.join(""));
}
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
