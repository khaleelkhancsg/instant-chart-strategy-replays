// Do the support/resistance levels from the level study help the two
// $1,250 setups? 2026 ONLY, honest fills, realistic costs, cancelOpposite.
//
// Levels: research/levels_2026.json, exported by the level study
// (tradovate_levels/research/s11_export_levels_2026.py) with its own
// definitions, causally, at raw contract prices, plus each date's shift into
// this lab's back-adjusted prices. Families:
//   volume (session)  prior-day POC, 5- and 20-session POC and HVNs
//   volume (wk/mo)    prior-week / 4-week / prior-month / 3-month POC
//   break-prone       prior-day high/low, overnight high/low, round 100s
//
// Questions, with the direction the level study predicts:
//   Donchian   D1 a volume level between the signal and the target   -> worse (it holds)
//              D2 the breakout crossed a break-prone level (10 min)   -> better (stops ran)
//              D3 a break-prone level between signal and target       -> better (fuel)
//   MACD fade  A1 the push being faded broke a break-prone level      -> worse
//              A2 the push ran into a volume level                    -> better
// Each is shown as a split of the setup's 2026 trades, and as a filter run
// back through the engine. Two null controls, 40 runs each:
//   twins   the same filter on random "twin" levels (each level moved 1.5-6 R,
//           the study's twins; R = 5% of the average daily range)
//   random  the same NUMBER of 2026 signals dropped at random. Real volume
//           levels sit where price spends time, so a real filter can drop a
//           different number of signals than its twins do -- and the pass
//           rate moves with the number of trades alone. This null holds the
//           count fixed.
// A filter only counts if it beats both.
//
// RESULT (2026 only):
// Donchian: no level filter beats dropping as many signals at random. The
// breakouts that crossed a break-prone level in the 10 minutes before the
// signal are most of the book (115 of 144 trades) and the better part of it
// ($66 vs $32 a trade): dropping them costs more than dropping random signals
// (20.6% vs 33.8%, 2 of 40 nulls). A volume level between the signal and the
// target changes nothing measurable.
// MACD fade: the volume levels carry information. Keeping only the fades whose
// push ran into a session volume level (within R/2, last 10 bars) passes 61.4%
// (Jan-Mar 71.5, Apr-Jul 59.0) at $86 a trade, against 26-35% for the same
// filter on random levels or on as many random signals (40 of 40 each), and
// dropping the fades AT volume levels costs more than random (39.0 vs 49.5,
// 1 of 40). Fades of pushes that broke a break-prone level make $106 a trade
// less than the twin baseline. Stress test: levels_fade_probe_2026.mjs.
//
//   node --max-old-space-size=8192 research/levels_setups_2026.mjs

import fs from "node:fs";
import { macd } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const T0 = Date.now();
const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const FILL = { slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: 600, profitBlock: 250, cancelOpposite: true };
const LV = JSON.parse(fs.readFileSync(new URL("./levels_2026.json", import.meta.url), "utf8"));
const dateOf = (tday) => new Date(tday * 86400000).toISOString().slice(0, 10);
const NTWIN = 40;

// ---- levels for a session, in lab prices; twin = random shifted copies ------
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
    const R = 0.05 * e.U;
    const rnd = S.mul(tday * 7919 + twin * 104729);
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
// a round 100 (of the RAW contract price; twins move the grid) in (lo, hi]
const roundIn = (L, lo, hi) => { const a = lo - L.off - L.rShift, b = hi - L.off - L.rShift; return Math.floor(b / 100) * 100 > a; };
const brkIn = (L, lo, hi) => anyIn(L.brk, lo, hi) || roundIn(L, lo, hi);

// ---- the two setups --------------------------------------------------------
const E2 = S.engineFor(2), E1 = S.engineFor(1);
const t2 = E2.tf, A2 = E2.atr, t1 = E1.tf, n1 = t1.close.length;
const hist = macd(t1.close, 12, 26, 9).hist;
const SIGA = new Int8Array(n1);
for (let i = 1; i < n1; i++) {
  if (!(t1.ctMin[i] >= 510 && t1.ctMin[i] < 900)) continue;
  SIGA[i] = -(hist[i] > 0 && hist[i - 1] <= 0 ? 1 : hist[i] < 0 && hist[i - 1] >= 0 ? -1 : 0);
}
const exit20 = (k, d, st) => k - st.entBar >= 20 && (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) < st.atr;
const SETUP = {
  D: { name: "Donchian (2-min, 4/2 lots, -$300 / +$250)", E: E2, t: t2, sig: M.RESC,
       sizer: (a, c, s, arm) => (M.adrUsed(arm - 1) >= 0.9 ? 2 : 4), opts: { exitFn: exit20, breaker: 300 } },
  A: { name: "MACD fade (1-min, 4 lots, -$200 / +$250)", E: E1, t: t1, sig: SIGA,
       sizer: () => 4, opts: { breaker: 200, trig: 0.15, tpFromFill: true, tpFn: (a, q) => Math.min(5.15 * a, 600 / (2 * q)) } },
};
const in26 = (k, t) => S.yearOf.get(t.tday[k]) === 2026;

// Features of a signal at bar k, direction s (the trade's direction).
// Each returns true / false, or null when the day has no levels.
const FEAT = {
  D1s: { id: "D", lbl: "D1 a session volume level (POC/HVN) between signal and target", f(k, s, L) {
    const c = t2.close[k], a = A2[k] * 1.75; return s === 1 ? anyIn(L.vpS, c, c + a) : anyIn(L.vpS, c - a - 1e-9, c - 1e-9); } },
  D1w: { id: "D", lbl: "D1 a week/month POC between signal and target", f(k, s, L) {
    const c = t2.close[k], a = A2[k] * 1.75; return s === 1 ? anyIn(L.vpW, c, c + a) : anyIn(L.vpW, c - a - 1e-9, c - 1e-9); } },
  D2: { id: "D", lbl: "D2 the breakout crossed a break-prone level in the last 10 min", f(k, s, L) {
    const c = t2.close[k]; let lo = Infinity, hi = -Infinity;
    for (let j = Math.max(0, k - 4); j <= k; j++) { lo = Math.min(lo, t2.low[j]); hi = Math.max(hi, t2.high[j]); }
    return s === 1 ? brkIn(L, lo, c) : brkIn(L, c - 1e-9, hi - 1e-9); } },
  D3: { id: "D", lbl: "D3 a break-prone level between signal and target", f(k, s, L) {
    const c = t2.close[k], a = A2[k] * 1.75; return s === 1 ? brkIn(L, c, c + a) : brkIn(L, c - a - 1e-9, c - 1e-9); } },
  A1: { id: "A", lbl: "A1 the push being faded broke a break-prone level (last 10 min)", f(k, s, L) {
    const c = t1.close[k]; let lo = Infinity, hi = -Infinity;
    for (let j = Math.max(0, k - 9); j <= k; j++) { lo = Math.min(lo, t1.low[j]); hi = Math.max(hi, t1.high[j]); }
    return s === -1 ? brkIn(L, lo, c) : brkIn(L, c - 1e-9, hi - 1e-9); } },          // s = -1 fades an UP push
  A2s: { id: "A", lbl: "A2 the push ran into a session volume level (within R/2)", f(k, s, L) {
    let x = s === -1 ? -Infinity : Infinity;
    for (let j = Math.max(0, k - 9); j <= k; j++) x = s === -1 ? Math.max(x, t1.high[j]) : Math.min(x, t1.low[j]);
    return L.vpS.some((p) => Math.abs(p - x) <= L.R / 2); } },
  A2w: { id: "A", lbl: "A2 the push ran into a week/month POC (within R/2)", f(k, s, L) {
    let x = s === -1 ? -Infinity : Infinity;
    for (let j = Math.max(0, k - 9); j <= k; j++) x = s === -1 ? Math.max(x, t1.high[j]) : Math.min(x, t1.low[j]);
    return L.vpW.some((p) => Math.abs(p - x) <= L.R / 2); } },
};
const featAt = (fk, k, s, twin) => {
  const t = SETUP[FEAT[fk].id].t, L = levelsFor(t.tday[k], twin);
  return L ? FEAT[fk].f(k, s, L) : null;
};

// ---- check the price shift: the lab's own prior-day RTH high = exported + shift
{
  const rthHi = new Map();
  for (let i = 0; i < n1; i++) if (t1.ctMin[i] >= 510 && t1.ctMin[i] < 900) {
    const d = t1.tday[i]; rthHi.set(d, Math.max(rthHi.get(d) ?? -Infinity, t1.high[i]));
  }
  const tdays = [...rthHi.keys()].sort((a, b) => a - b);
  let ok = 0, bad = 0;
  for (let q = 1; q < tdays.length; q++) {
    const e = LV[dateOf(tdays[q])];
    if (!e || e.off == null) continue;
    const pdh = e.levels.find((x) => x[1] === "prior_day_high");
    if (!pdh) continue;
    if (Math.abs(pdh[2] + e.off - rthHi.get(tdays[q - 1])) < 1e-6) ok++; else bad++;
  }
  console.log(`price shift check: prior-day RTH high from the export = the lab's own on ${ok} of ${ok + bad} sessions`);
}

// ---- runs ------------------------------------------------------------------
const pass = (arr, ix) => S.passArr(ix.map((k) => arr[k]), RULES);
function run(c, sig) {
  const tr = c.E.run(c.sizer, { signals: sig, ...FILL, ...c.opts }).filter((t) => S.yearOf.get(t.tday) === 2026);
  const arr = S.dayArr(tr, S.days);
  return { tr, n: tr.length, exp: tr.reduce((s, t) => s + t.pnl, 0) / Math.max(1, tr.length),
           y: pass(arr, M.Y26), a: pass(arr, M.Y26a), b: pass(arr, M.Y26b) };
}
// keep(k, s) -> false drops the signal; only 2026 signals are touched
function filtered(c, keep) {
  const o = Int8Array.from(c.sig);
  let dropped = 0;
  for (let k = 0; k < o.length; k++) if (o[k] && in26(k, c.t) && !keep(k, o[k])) { o[k] = 0; dropped++; }
  o.dropped = dropped;
  return o;
}
// the same number of signals dropped at random, from the 2026 signals on days with levels
function randomDrop(c, nDrop, seed) {
  const elig = [];
  for (let k = 0; k < c.sig.length; k++) if (c.sig[k] && in26(k, c.t) && levelsFor(c.t.tday[k], 0)) elig.push(k);
  const rnd = S.mul(seed), o = Int8Array.from(c.sig);
  for (let j = elig.length - 1; j > 0; j--) { const q = Math.floor(rnd() * (j + 1)); [elig[j], elig[q]] = [elig[q], elig[j]]; }
  for (let j = 0; j < nDrop; j++) o[elig[j]] = 0;
  return o;
}
const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const f1 = (x, w = 6) => x.toFixed(1).padStart(w);
const month = (t, k) => new Date(t.ts[k] + 43200e3).getUTCMonth();

for (const [id, c] of Object.entries(SETUP)) {
  const base = run(c, c.sig);
  console.log("\n" + "=".repeat(112) + "\n" + c.name + ":  2026 " + base.y.toFixed(1) + "% (Jan-Mar " + base.a.toFixed(1) +
              ", Apr-Jul " + base.b.toFixed(1) + "), " + base.n + " trades, $" + base.exp.toFixed(1) + " a trade\n" + "=".repeat(112));

  // 1. split the 2026 trades by each feature, real levels vs twins
  console.log("\n  the setup's 2026 trades split by each feature (real levels; twins = the same split on random levels)");
  console.log("  " + "".padEnd(66) + "  with: n   $/tr  Jan-Mar Apr-Jul | without: n   $/tr | diff  twins: mean diff [5%,95%]");
  for (const [fk, F] of Object.entries(FEAT)) {
    if (F.id !== id) continue;
    const split = (twin) => {
      const g = { y: [], n: [] };
      for (const t of base.tr) {
        const v = featAt(fk, t.sigBar, t.dir ?? Math.sign(c.sig[t.sigBar]), twin);
        if (v === null) continue;
        (v ? g.y : g.n).push(t);
      }
      const m = (a) => a.reduce((s, t) => s + t.pnl, 0) / Math.max(1, a.length);
      return { g, d: m(g.y) - m(g.n), m };
    };
    const r = split(0);
    const tw = [];
    for (let w = 1; w <= NTWIN; w++) { const s = split(w); if (s.g.y.length >= 5 && s.g.n.length >= 5) tw.push(s.d); }
    tw.sort((a, b) => a - b);
    const mm = (a) => a.reduce((s, t) => s + t.pnl, 0) / Math.max(1, a.length);
    const yA = r.g.y.filter((t) => month(c.t, t.sigBar) < 3), yB = r.g.y.filter((t) => month(c.t, t.sigBar) >= 3);
    const twMean = tw.reduce((s, v) => s + v, 0) / Math.max(1, tw.length);
    console.log("  " + F.lbl.padEnd(66) + String(r.g.y.length).padStart(9) + f1(mm(r.g.y), 7) + f1(mm(yA), 8) + f1(mm(yB), 8) +
                " |" + String(r.g.n.length).padStart(10) + f1(mm(r.g.n), 7) + " |" + f1(r.d, 6) +
                "  " + f1(twMean, 7) + " [" + f1(tw[Math.floor(0.05 * (tw.length - 1))] ?? NaN, 0).trim() + "," + f1(tw[Math.floor(0.95 * (tw.length - 1))] ?? NaN, 0).trim() + "]");
  }

  // 2. filters through the engine, real vs twins
  console.log("\n  filters run through the engine (pass rate 2026, trades, $/trade) vs twins and vs dropping as many signals at random");
  console.log("  " + "".padEnd(56) + "  drop   2026 JanMar AprJul  tr  $/tr | twins: 2026  tr  $/tr beats | random: 2026  [5%, 95%]  tr  $/tr beats");
  const GATES = id === "D" ? [
    ["skip: a session volume level ahead", (k, s, w) => featAt("D1s", k, s, w) !== true],
    ["skip: a week/month POC ahead", (k, s, w) => featAt("D1w", k, s, w) !== true],
    ["skip: any volume level ahead", (k, s, w) => featAt("D1s", k, s, w) !== true && featAt("D1w", k, s, w) !== true],
    ["only: crossed a break-prone level in the last 10 min", (k, s, w) => featAt("D2", k, s, w) !== false],
    ["skip: crossed a break-prone level in the last 10 min", (k, s, w) => featAt("D2", k, s, w) !== true],
    ["only: a break-prone level ahead", (k, s, w) => featAt("D3", k, s, w) !== false],
  ] : [
    ["skip: the push broke a break-prone level", (k, s, w) => featAt("A1", k, s, w) !== true],
    ["only: the push broke a break-prone level", (k, s, w) => featAt("A1", k, s, w) !== false],
    ["only: the push ran into a session volume level", (k, s, w) => featAt("A2s", k, s, w) !== false],
    ["only: the push ran into a week/month POC", (k, s, w) => featAt("A2w", k, s, w) !== false],
    ["skip: the push ran into any volume level", (k, s, w) => featAt("A2s", k, s, w) !== true && featAt("A2w", k, s, w) !== true],
  ];
  for (const [lbl, keep] of GATES) {
    const sig = filtered(c, (k, s) => keep(k, s, 0));
    const r = run(c, sig);
    const tw = [], rn = [];
    for (let w = 1; w <= NTWIN; w++) tw.push(run(c, filtered(c, (k, s) => keep(k, s, w))));
    for (let w = 1; w <= NTWIN; w++) rn.push(run(c, randomDrop(c, sig.dropped, 9000 + w)));
    const ty = tw.map((x) => x.y), ry = rn.map((x) => x.y).sort((a, b) => a - b);
    console.log("  " + lbl.padEnd(56) + String(sig.dropped).padStart(6) + f1(r.y, 7) + f1(r.a) + f1(r.b) + String(r.n).padStart(4) + f1(r.exp) +
                " |" + f1(med(ty), 11) + String(med(tw.map((x) => x.n))).padStart(4) + f1(med(tw.map((x) => x.exp))) +
                String(ty.filter((v) => r.y > v).length).padStart(4) + "/" + ty.length +
                " |" + f1(med(ry), 12) + "  [" + f1(ry[2], 4) + "," + f1(ry[ry.length - 3], 5) + "]" + String(med(rn.map((x) => x.n))).padStart(4) +
                f1(med(rn.map((x) => x.exp))) + String(ry.filter((v) => r.y > v).length).padStart(4) + "/" + ry.length);
  }
  process.stderr.write(`  ${id} done ${((Date.now() - T0) / 1000).toFixed(0)}s\n`);
}
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
