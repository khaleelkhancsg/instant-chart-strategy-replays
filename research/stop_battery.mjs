// The stop multiple, put through the battery that killed early arming.
//
// The flag: walk-forward selection picks 3xATR over the shipped 5xATR in seven
// consecutive periods and delivers 57.7% against 54.1%. Unlike early arming the
// picks CONVERGE rather than wander, which is the first thing that makes this
// worth taking seriously rather than the last.
//
// The proposed mechanism is specific and therefore falsifiable: with 8 lots a
// $1,000 day cap binds 62.5 points from the average fill, so a 5xATR stop is
// only ever the binding one below ATR 12.5, while a 3xATR stop binds up to ATR
// 20.8. In the regime being traded the shipped stop is mostly INERT -- the cap
// is doing the work -- and tightening it is the first change that actually
// alters where the trade dies. Test 2 checks that claim directly, because a
// mechanism that can be stated can be measured, and if the binding rates do not
// move as predicted the story is wrong whatever the pass rates say.
//
// The rest is the standard battery: plateau or spike, where the gain lives by
// regime, stability period by period, an untouched instrument, and costs.
//
// Usage:  node research/stop_battery.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 12000, BLOCK = 5, WIN = 21, TOTAL = 8;
const CAPD = 1000, BREAKER = 500, PROFIT_BLOCK = 750, ADD_WIN = 10, TRIG = 0.15;
const S = (await loadStrategies()).get("donchian_eff_rth");
const X = resolveExec(S.execDefaults);
const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });

function env(binPath) {
  const { bars } = loadBars(binPath);
  const tf = resample(bars, 2);
  const ctx = buildFilterContext(tf);
  const A = atr(tf.high, tf.low, tf.close, 14);
  const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
  const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
  const n = tf.close.length;
  const raw = new Int8Array(n);
  for (let i = 30; i < n; i++) {
    if (ax[i] < 25) continue;
    if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
  }
  const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
  return { bars, tf, A, sig, n };
}
const M = env("data/mnq_1m.bin");

function replay(E, { sl = 5, tp = 1.75, contracts = TOTAL, pv = 2, costMult = 1, cap = CAPD } = {}) {
  const { tf, A, sig, n } = E;
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const tick = 0.25, slip = 0.25 * costMult, perSide = 0.75 * costMult;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const out = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, qty = 0, notional = 0, eATR = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0, armA = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  let nCapBind = 0, nTr = 0;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (rawExit, i, exact, capBound) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    out.push({ tday: TD[i], entryTime: entTime, pnl: net, atr: eATR, capBound: !!capBound });
    dayReal += net;
    if (cap > 0 && dayReal <= -cap) capHit = true;
    pos = 0; notional = 0;
  };
  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    if (pos === 0 && armDir !== 0) {
      if (flatNow || i > armBy || blocked()) armDir = 0;
      else if (i > armBar && (armDir === 1 ? H[i] >= armPx : L[i] <= armPx)) {
        pos = armDir; qty = contracts;
        ep = armEp; slD = armSl; tpD = armTp; entTime = TS[i]; eATR = armA;
        notional = (pos === 1 ? armPx + slip : armPx - slip) * qty;
        armDir = 0;
      }
    }
    if (pos !== 0) {
      if (flatNow) { close_(O[i], i); continue; }
      const dir = pos;
      const lossPx = cap > 0 ? avgFill() - dir * ((cap + dayReal) / (pv * qty)) : 0;
      const rawSl = ep - dir * slD;
      const useCap = cap > 0 && (dir === 1 ? lossPx > rawSl : lossPx < rawSl);
      const slPx = useCap ? lossPx : rawSl;
      if (i - 1 >= 0 && qty === contracts && !out.length) { /* noop */ }
      const tpPx = ep + dir * tpD;
      const cut = useCap ? -cap - dayReal : undefined;
      let exited = false;
      if (dir === 1) {
        if (O[i] <= slPx) { close_(O[i], i, cut, useCap); exited = true; }
        else if (L[i] <= slPx) { close_(slPx, i, cut, useCap); exited = true; }
        else if (H[i] >= tpPx) { close_(tpPx, i, undefined, false); exited = true; }
      } else {
        if (O[i] >= slPx) { close_(O[i], i, cut, useCap); exited = true; }
        else if (H[i] >= slPx) { close_(slPx, i, cut, useCap); exited = true; }
        else if (L[i] <= tpPx) { close_(tpPx, i, undefined, false); exited = true; }
      }
      if (exited) continue;
      if (X.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], i);
      if (pos !== 0) continue;
    }
    if (pos === 0 && s !== 0 && !flatNow && !blocked()) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      nTr++;
      // does the DESIGNED stop or the CAP sit nearer, at entry?
      if (cap > 0 && (cap / (pv * contracts)) < a * sl) nCapBind++;
      armDir = s; armBar = i; armBy = i + ADD_WIN; armEp = O[i]; armA = a;
      armPx = O[i] + s * Math.max(a * TRIG, tick);
      armSl = Math.max(a * sl, tick); armTp = Math.max(a * tp, tick);
    }
  }
  return { trades: out, capBindRate: nTr ? 100 * nCapBind / nTr : 0 };
}
function dayMap(fills, lo, hi) {
  const m = new Map(); let day = null, acc = 0;
  for (const f of fills) {
    if (f.entryTime < lo || f.entryTime >= hi) continue;
    if (f.tday !== day) { if (day !== null) m.set(day, acc); day = f.tday; acc = 0; }
    acc += f.pnl;
  }
  if (day !== null) m.set(day, acc);
  return m;
}
function ev(d) {
  let c = 0, pk = 0, lk = false, md = -1e18;
  for (const v of d) {
    c += v; if (v > md) md = v;
    if (c <= (lk ? 0 : pk - R.trailingDD)) return 0;
    if (c > pk) pk = c;
    if (R.lockAtBreakeven && !lk && pk >= R.trailingDD) lk = true;
    if (c >= R.profitTarget && md <= 0.5 * c) return 1;
  }
  return 0;
}
function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function passOf(fills, lo, hi, seed = 4242) {
  const m = dayMap(fills, lo, hi);
  const keys = [...m.keys()].sort((a, b) => a - b);
  if (keys.length < 30) return NaN;
  const rnd = mul(seed), N = keys.length, idx = new Array(WIN);
  const arr = keys.map(k => m.get(k) ?? 0), buf = new Array(WIN);
  let w = 0;
  for (let d = 0; d < DRAWS; d++) {
    let mm = 0;
    while (mm < WIN) { const st = Math.floor(rnd() * Math.max(1, N - BLOCK));
      for (let j = 0; j < BLOCK && mm < WIN; j++) idx[mm++] = (st + j) % N; }
    for (let k = 0; k < WIN; k++) buf[k] = arr[idx[k]];
    w += ev(buf);
  }
  return (100 * w) / DRAWS;
}
const stat = (t) => {
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const x of t) { tot += x.pnl; if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; }
  return { n: t.length, win: t.length ? 100 * w / t.length : 0, pf: gl ? gw / gl : Infinity,
           exp: t.length ? tot / t.length : 0, net: tot };
};
const T0 = M.bars.ts[0], T1 = M.bars.ts[M.bars.count - 1];
const MID = T0 + (T1 - T0) / 2, Y12 = T1 - 365 * 86400000, Y26 = Date.UTC(2026, 0, 1);
const SLICES = [["early", T0, MID], ["late", MID, T1], ["12m", Y12, T1],
                ["2026", Y26, T1], ["ALL", T0, T1]];

// ── 1. PLATEAU OR SPIKE ─────────────────────────────────────────────
console.log("\n1. FINE SWEEP — plateau or spike, and what the recent slices say\n");
const SLS = [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0, 7.0, 8.0];
const BK = new Map(SLS.map(s => [s, replay(M, { sl: s })]));
console.log("   sl    cap binds   trades   win%     pf   $/trade" +
            SLICES.map(([n]) => n.padStart(8)).join(""));
for (const s of SLS) {
  const b = BK.get(s), st = stat(b.trades);
  console.log(`   ${s.toFixed(1)}   ${(b.capBindRate.toFixed(0) + "%").padStart(8)}  ${String(st.n).padStart(7)}  ` +
    `${(st.win.toFixed(1) + "%").padStart(5)}  ${st.pf.toFixed(3)}  ${("$" + st.exp.toFixed(2)).padStart(8)}` +
    SLICES.map(([, lo, hi]) => passOf(b.trades, lo, hi).toFixed(1).padStart(8)).join("") +
    (s === 5 ? "  <- ships" : ""));
}
{
  let ss = 0;
  for (let i = 1; i < SLS.length; i++)
    ss += Math.abs(passOf(BK.get(SLS[i]).trades, T0, T1) - passOf(BK.get(SLS[i - 1]).trades, T0, T1));
  console.log(`\n   noise floor between adjacent settings: +-${(ss / (SLS.length - 1)).toFixed(2)}pp`);
}

// ── 2. MECHANISM ────────────────────────────────────────────────────
console.log("\n2. MECHANISM — the claim is that 5xATR is mostly INERT under the cap.");
console.log("   If true, exits attributed to the cap must fall sharply as the stop");
console.log("   tightens, and the two rules must converge when the cap is removed.\n");
console.log("   sl    % exits where the CAP was the binding stop");
for (const s of [3, 4, 5, 6, 8]) {
  const t = BK.get(s).trades;
  const cb = t.filter(x => x.capBound).length;
  console.log(`   ${s.toFixed(1)}   ${(100 * cb / t.length).toFixed(1).padStart(5)}%`);
}
console.log("\n   with the cap REMOVED entirely (the mechanism's own prediction:");
console.log("   the advantage should shrink, because the cap is what made 5 inert)\n");
console.log("   sl     cap on    cap off");
for (const s of [3, 4, 5, 6]) {
  const on = passOf(BK.get(s).trades, T0, T1);
  const off = passOf(replay(M, { sl: s, cap: 0 }).trades, T0, T1);
  console.log(`   ${s.toFixed(1)}   ${on.toFixed(1).padStart(6)}   ${off.toFixed(1).padStart(7)}`);
}

// ── 3. REGIME ───────────────────────────────────────────────────────
console.log("\n3. REGIME — the test that exposed early arming\n");
{
  const base = BK.get(5).trades, cand = BK.get(3).trades;
  const all = base.map(t => t.atr).sort((a, b) => a - b);
  const q = [0.2, 0.4, 0.6, 0.8].map(p => all[Math.floor(p * all.length)]);
  const qi = (v) => v < q[0] ? 0 : v < q[1] ? 1 : v < q[2] ? 2 : v < q[3] ? 3 : 4;
  console.log("   quintile  ATR range       sl=5 $/t   sl=3 $/t    delta      n    gain");
  let tot = 0; const g = [];
  for (let i = 0; i < 5; i++) {
    const a = stat(base.filter(t => qi(t.atr) === i));
    const b = stat(cand.filter(t => qi(t.atr) === i));
    const gain = (b.exp - a.exp) * b.n; g.push(gain); tot += gain;
    const rng = i === 0 ? `< ${q[0].toFixed(1)}` : i === 4 ? `>= ${q[3].toFixed(1)}`
      : `${q[i - 1].toFixed(1)}-${q[i].toFixed(1)}`;
    console.log(`   ${String(i + 1).padStart(8)}  ${rng.padEnd(13)}${("$" + a.exp.toFixed(2)).padStart(9)}  ` +
      `${("$" + b.exp.toFixed(2)).padStart(9)}  ${((b.exp - a.exp >= 0 ? "+" : "") + "$" + (b.exp - a.exp).toFixed(2)).padStart(8)}  ` +
      `${String(b.n).padStart(5)}  ${("$" + (gain / 1000).toFixed(1) + "k").padStart(7)}`);
  }
  console.log(`   total $${(tot / 1000).toFixed(1)}k, single best quintile ` +
    `${(100 * Math.max(...g) / tot).toFixed(0)}% of it`);
}

// ── 4. PERIOD STABILITY ─────────────────────────────────────────────
console.log("\n4. PERIOD STABILITY — which stop wins in each quarter of history\n");
{
  const span = (T1 - T0) / 4;
  console.log("   period            " + SLS.filter(s => s <= 8).map(s => ("sl" + s).padStart(7)).join("") + "   best");
  for (let i = 0; i < 4; i++) {
    const lo = T0 + i * span, hi = T0 + (i + 1) * span;
    const row = SLS.map(s => passOf(BK.get(s).trades, lo, hi));
    const best = SLS[row.indexOf(Math.max(...row.filter(Number.isFinite)))];
    console.log(`   ${new Date(lo).toISOString().slice(0, 7)}..${new Date(hi).toISOString().slice(0, 7)}` +
      row.map(v => (Number.isFinite(v) ? v.toFixed(1) : "-").padStart(7)).join("") + `   ${best}`);
  }
}

// ── 5. MES ──────────────────────────────────────────────────────────
console.log("\n5. MES — an instrument the search never touched ($5/point)\n");
{
  const E = env("data/mes_1m.bin");
  const e0 = E.bars.ts[0], e1 = E.bars.ts[E.bars.count - 1];
  console.log("   sl     pass     pf   $/trade");
  for (const s of [3, 4, 5, 6]) {
    const b = replay(E, { sl: s, pv: 5 });
    const st = stat(b.trades);
    console.log(`   ${s.toFixed(1)}   ${passOf(b.trades, e0, e1).toFixed(1).padStart(6)}  ${st.pf.toFixed(3)}  ` +
      `${("$" + st.exp.toFixed(2)).padStart(8)}${s === 5 ? "  <- MNQ ships this" : ""}`);
  }
}

// ── 6. COSTS ────────────────────────────────────────────────────────
console.log("\n6. COSTS — a tighter stop trades more often, so it pays more of them\n");
console.log("   costs    sl=5    sl=3   delta");
for (const cm of [1, 1.5, 2, 3]) {
  const a = passOf(replay(M, { sl: 5, costMult: cm }).trades, T0, T1);
  const b = passOf(replay(M, { sl: 3, costMult: cm }).trades, T0, T1);
  console.log(`   ${(cm + "x").padStart(5)}  ${a.toFixed(1).padStart(6)}  ${b.toFixed(1).padStart(6)}  ` +
    `${((b - a >= 0 ? "+" : "") + (b - a).toFixed(1)).padStart(6)}`);
}
