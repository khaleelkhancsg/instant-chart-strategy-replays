// A different evaluation: $1,250 target, $1,000 trailing maximum loss limit,
// $600 daily loss limit, 50% consistency. Which config, size and day rules
// pass it most often? 2026 ONLY, honest limit fills, realistic costs.
//
// The rules move the optimum in predictable directions: the $600 daily limit IS
// the stop for any real size (37.5 pts at 8 lots, 75 at 4), and the consistency
// rule means a pass at $1,250 needs no day above $625 -- so the profit block
// that protects it has to come down from $750.
//
//   L  the live Donchian book            D  the 2026 Donchian config (7/4 lots, 40-min exit)
//   A  fade 1-min MACD crosses           B  the user's 1-min anticipation (RTH)
//   C  fade 1-min EMA 20/50 crosses
//
// Each over lots 2-8, circuit breaker off/$200-500, profit block $250-625/off.
// The pass rate is the 21-day window rate over 2026 days, with Jan-Mar and
// Apr-Jul, every real contiguous window, and a pick-on-one-half check. The
// winner is then stress-tested.
//
// RESULT (2026 only): the old settings fail these rules (8 lots, -$500/+$750:
// 12-35%), because a $750 profit block lets days run past the $625 the
// consistency rule allows and 8 lots makes the $600 limit a 37.5-pt stop.
// Best: D, the 2026 Donchian config, at 4 lots (2 late), breaker -$300 (or
// -$200), profit block +$250 (or +$350): 61.3% (Jan-Mar 63.3, Apr-Jul 63.0),
// 59.7% over every real window, a 3-5 lot plateau (57 / 61 / 53), and the
// pick-on-one-half check holds both ways (62.1 / 60.2). Costs, slippage and
// day-rule neighbours move it 1-2pp; the best 5 days removed leave 51.9%.
// C (fade 1-min EMA 20/50, 2 lots) scores higher, 65.1%, but is fragile: one
// bar of entry delay -> 20.1%, 3 lots -> 49.5%, and its Jan-Mar pick reads
// 40.1% on Apr-Jul.
//
//   node --max-old-space-size=8192 research/rules_1250_2026.mjs

import { ema, macd } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const T0 = Date.now();
const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const DAY_CAP = 600, PV = 2;
const days = S.days, Y26 = M.Y26, Y26a = M.Y26a, Y26b = M.Y26b;
const pass = (arr, ix) => S.passArr(ix.map((k) => arr[k]), RULES);
const contiguous = (arr) => { const d = Y26.map((k) => arr[k]); let p = 0, n = 0;
  for (let s = 0; s + 21 <= d.length; s++) { p += S.evWith(d.slice(s, s + 21), RULES); n++; } return (100 * p) / n; };
const in2026 = (t) => S.yearOf.get(t.tday) === 2026;
const stopDist = (a, lots) => Math.min(5.15 * a, DAY_CAP / (PV * lots));

// ---- signals (as macd_ema_2026.mjs / confidence_sizing_2026.mjs build them) ----
const E1 = S.engineFor(1), t1 = E1.tf, n1 = t1.close.length, CT1 = t1.ctMin, C1 = t1.close;
const rth1 = (i) => CT1[i] >= 510 && CT1[i] < 900;
const hist1 = macd(C1, 12, 26, 9).hist;
const scale1 = new Float64Array(n1).fill(NaN);
{ let s = 0; for (let i = 0; i < n1; i++) { s += Math.abs(hist1[i]) || 0; if (i >= 200) s -= Math.abs(hist1[i - 200]) || 0; if (i >= 199) scale1[i] = s / 200; } }
const mk1 = (f) => { const s = new Int8Array(n1); for (let i = 1; i < n1; i++) s[i] = rth1(i) ? f(i) || 0 : 0; return s; };
const shrink1 = new Int16Array(n1);
for (let i = 1; i < n1; i++) shrink1[i] = Math.abs(hist1[i]) < Math.abs(hist1[i - 1]) ? shrink1[i - 1] + 1 : 0;
const e20 = ema(C1, 20), e50 = ema(C1, 50);
const neg = (s) => Int8Array.from(s, (v) => -v);
const SIG = {
  A: neg(mk1((i) => (hist1[i] > 0 && hist1[i - 1] <= 0 ? 1 : hist1[i] < 0 && hist1[i - 1] >= 0 ? -1 : 0))),
  B: mk1((i) => (shrink1[i] >= 3 && Math.abs(hist1[i]) < 0.075 * scale1[i] ? (hist1[i] >= 0 ? -1 : 1) : 0)),
  C: neg(mk1((i) => (e20[i] > e50[i] && e20[i - 1] <= e50[i - 1] ? 1 : e20[i] < e50[i] && e20[i - 1] >= e50[i - 1] ? -1 : 0))),
};
const exit20 = (k, d, st) => k - st.entBar >= 20 && (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) < st.atr;
const E2 = S.engineFor(2);
const CFG = {
  L: { name: "L  live Donchian book", E: E2, sig: M.RESC, opts: {} },
  D: { name: "D  Donchian 2026 config (late-day 4/7 size, 40-min exit)", E: E2, sig: M.RESC, opts: { exitFn: exit20 }, late: (k) => M.adrUsed(k) >= 0.9 },
  A: { name: "A  fade 1-min MACD crosses, target 1x stop", E: E1, sig: SIG.A, opts: { trig: 0.15, tpFromFill: true, tpFn: (a, q) => stopDist(a, q) } },
  B: { name: "B  1-min anticipation (RTH), target 1x stop", E: E1, sig: SIG.B, opts: { trig: 0.15, tpFromFill: true, tpFn: (a, q) => stopDist(a, q) } },
  C: { name: "C  fade 1-min EMA 20/50 crosses, 1.75 ATR target", E: E1, sig: SIG.C, opts: { trig: 0 } },
};
const FILL = { slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: DAY_CAP };
function run(c, L, br, pb, extra = {}, sig = c.sig) {
  const sizer = c.late ? (a, ct, s, arm) => (c.late(arm - 1) ? Math.max(1, Math.round(L * 4 / 7)) : L) : () => L;
  const tr = c.E.run(sizer, { signals: sig, ...FILL, ...c.opts, breaker: br, profitBlock: pb, ...extra }).filter(in2026);
  const arr = S.dayArr(tr, days);
  const w = tr.filter((t) => t.pnl > 0).length;
  const d26 = Y26.map((k) => arr[k]);
  return { tr, arr, n: tr.length, win: (100 * w) / Math.max(1, tr.length), exp: tr.reduce((s, t) => s + t.pnl, 0) / Math.max(1, tr.length),
           best: Math.max(...d26), worst: Math.min(...d26),
           y26: pass(arr, Y26), a26: pass(arr, Y26a), b26: pass(arr, Y26b) };
}
const f1 = (x, w = 6) => x.toFixed(1).padStart(w);
const set = (L, br, pb) => (L + " lots, breaker " + (br ? "-$" + br : "off") + ", profit block " + (pb ? "+$" + pb : "off"));
const HD = "    " + "".padEnd(46) + "trades".padStart(6) + "win%".padStart(6) + "$/tr".padStart(7) + "bestday".padStart(8) + "  2026" + " JanMar AprJul";
const row = (lbl, r) => "    " + lbl.padEnd(46) + String(r.n).padStart(6) + f1(r.win) + f1(r.exp, 7) + ("$" + Math.round(r.best)).padStart(8) + f1(r.y26) + f1(r.a26, 7) + f1(r.b26, 7);
function bar(t) { console.log("\n" + "=".repeat(116) + "\n" + t + "\n" + "=".repeat(116)); }

bar("NEW RULES: $1,250 target, $1,000 trailing max loss, $600 daily limit, 50% consistency -- 2026 only");
const LOTS = [2, 3, 4, 5, 6, 7, 8], BRS = [0, 200, 300, 400, 500], PBS = [250, 350, 450, 550, 625, 0];
const results = {};
for (const [id, c] of Object.entries(CFG)) {
  const rs = [];
  for (const L of LOTS) for (const br of BRS) for (const pb of PBS) rs.push({ L, br, pb, ...run(c, L, br, pb) });
  results[id] = rs;
  const old = run(c, id === "D" ? 7 : 8, 500, 750);
  console.log("\n  " + c.name + "\n" + HD);
  console.log(row("at its old settings (" + (id === "D" ? 7 : 8) + " lots, -$500 / +$750)", old));
  for (const r of rs.slice().sort((a, b) => b.y26 - a.y26).slice(0, 6)) console.log(row(set(r.L, r.br, r.pb), r));
  // the best size at each lot count, so the shape of the curve is visible
  console.log("    best day rules at each size:   " + LOTS.map((L) => L + ":" + Math.max(...rs.filter((r) => r.L === L).map((r) => r.y26)).toFixed(0)).join("  "));
  for (const [fit, test, fl, tl] of [["a26", "b26", "Jan-Mar", "Apr-Jul"], ["b26", "a26", "Apr-Jul", "Jan-Mar"]]) {
    const top = rs.slice().sort((a, b) => b[fit] - a[fit])[0];
    console.log("    picked on " + fl + ": " + set(top.L, top.br, top.pb) + " -> " + top[test].toFixed(1) + "% on " + tl);
  }
  process.stderr.write(`  ${id} done ${((Date.now() - T0) / 1000).toFixed(0)}s\n`);
}

// ---- the winner, and the stress test ------------------------------------------------
bar("STRESS TEST of the best two settings overall");
const flat = Object.entries(results).flatMap(([id, rs]) => rs.map((r) => ({ id, ...r })));
const pick = [];
for (const r of flat.sort((a, b) => b.y26 - a.y26)) { if (!pick.some((p) => p.id === r.id)) pick.push(r); if (pick.length === 2) break; }
const shift1 = (s) => { const o = new Int8Array(s.length); for (let i = 1; i < s.length; i++) o[i] = s[i - 1]; return o; };
for (const p of pick) {
  const c = CFG[p.id];
  const base = run(c, p.L, p.br, p.pb);
  console.log("\n  " + c.name + "  --  " + set(p.L, p.br, p.pb) + ":  2026 " + base.y26.toFixed(1) + "% (Jan-Mar " + base.a26.toFixed(1) + ", Apr-Jul " + base.b26.toFixed(1) + ")");
  const add = (lbl, r) => console.log("      " + lbl.padEnd(38) + f1(r.y26) + "%  (Jan-Mar " + f1(r.a26).trim() + ", Apr-Jul " + f1(r.b26).trim() + ")  $" + r.exp.toFixed(0) + "/tr, best day $" + Math.round(r.best));
  add("sim fills (no slippage)", run(c, p.L, p.br, p.pb, { slipMult: 0 }));
  add("2 ticks slippage each way", run(c, p.L, p.br, p.pb, { slipMult: 2 }));
  add("commission $1.25/side", run(c, p.L, p.br, p.pb, { feeMult: 1.25 / 0.75 }));
  add("enter one bar later", run(c, p.L, p.br, p.pb, {}, shift1(c.sig)));
  for (const dL of [-1, 1]) if (LOTS.includes(p.L + dL)) add((p.L + dL) + " lots", run(c, p.L + dL, p.br, p.pb));
  for (const dP of [-100, 100]) { const pb2 = p.pb ? p.pb + dP : (dP > 0 ? 0 : 625); add("profit block " + (pb2 ? "+$" + pb2 : "off"), run(c, p.L, p.br, pb2)); }
  for (const dB of [-100, 100]) { const b2 = Math.max(0, (p.br || 600) + dB); if (b2 < 600) add("breaker " + (b2 ? "-$" + b2 : "off"), run(c, p.L, b2, p.pb)); }
  const zero = run(c, p.L, p.br, p.pb, { signals: new Int8Array(c.sig.length) });
  const jack = (K) => { const best = Y26.map((k) => [k, base.arr[k]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, K);
    const a = Float64Array.from(base.arr); for (const [k] of best) a[k] = 0; return pass(a, Y26); };
  console.log("      every real 21-day window in 2026: " + contiguous(base.arr).toFixed(1) + "%;  best 1/3/5 days removed: " + [1, 3, 5].map((K) => jack(K).toFixed(1)).join(" / ") + "%");
  const mo = new Map();
  for (const t of base.tr) { const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"][new Date(M.tf.ts[S.dayFirstBar.get(t.tday)] + 43200e3).getUTCMonth()]; mo.set(m, (mo.get(m) || 0) + t.pnl); }
  console.log("      dollars by month: " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"].map((m) => m + " " + ((mo.get(m) || 0) >= 0 ? "+" : "") + Math.round(mo.get(m) || 0)).join("  "));
}
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
