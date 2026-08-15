// Should early arming be switched ON only inside the ATR band where it worked?
//
// The gain from k>0 sat almost entirely in ATR quintile 3 (11.7-16.3 pts) at
// every k. The natural response is to arm early only in that band. The natural
// objection is that conditioning on the bucket where an effect was FOUND is
// fitting the noise directly, and adds a fitted parameter (the band) on top of
// an already-fitted one (k), which makes selection bias worse, not better.
//
// That objection is a prediction, not a proof, so it gets tested. Two things
// decide it, and neither is a full-sample significance test:
//
//  1 BAND STABILITY. Split history into independent periods and ask which ATR
//    bucket wins in EACH. If it is quintile 3 every time, there is a regime
//    mechanism worth switching on. If the winning bucket wanders, quintile 3 is
//    simply where the noise landed when the whole sample was pooled -- and a
//    switch tuned to it will point at the wrong band next year.
//
//  2 WALK-FORWARD WITH THE SWITCH. Choose BOTH the band and k on training data
//    only, apply out of sample. This is the honest version of the proposal, and
//    it is strictly harder than the plain k walk-forward that already failed.
//
// Scored on PASS RATE, since that is the objective, with expectancy alongside.
//
// Usage:  node research/atr_switch.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 12000, BLOCK = 5, WIN = 21, TOTAL = 8;
const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750, ADD_WIN = 10, TRIG = 0.15;
const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const S = (await loadStrategies()).get("donchian_eff_rth");
const X = resolveExec(S.execDefaults);
const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const n = tf.close.length;

// kOf(atr) -> the arming pad to use for a signal at this ATR. A constant
// function reproduces the plain variants; a banded one is the proposed switch.
function replay(kOf) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const out = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, qty = 0, notional = 0, eATR = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0, armA = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (rawExit, i, exact) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    out.push({ tday: TD[i], entryTime: entTime, pnl: net, atr: eATR });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; notional = 0;
  };
  for (let i = 1; i < n; i++) {
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    if (pos === 0 && armDir !== 0) {
      if (flatNow || i > armBy || blocked()) armDir = 0;
      else if (i > armBar && (armDir === 1 ? H[i] >= armPx : L[i] <= armPx)) {
        pos = armDir; qty = TOTAL;
        ep = armEp; slD = armSl; tpD = armTp; entTime = TS[i]; eATR = armA;
        notional = (pos === 1 ? armPx + slip : armPx - slip) * qty;
        armDir = 0;
      }
    }
    if (pos !== 0) {
      if (flatNow) { close_(O[i], i); continue; }
      const dir = pos;
      const lossPx = avgFill() - dir * ((CAP + dayReal) / (pv * qty));
      const rawSl = ep - dir * slD;
      const sl = dir === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
      const isCap = dir === 1 ? (sl === lossPx && lossPx > rawSl) : (sl === lossPx && lossPx < rawSl);
      const tp = ep + dir * tpD;
      const cut = isCap ? -CAP - dayReal : undefined;
      let exited = false;
      if (dir === 1) {
        if (O[i] <= sl) { close_(O[i], i, cut); exited = true; }
        else if (L[i] <= sl) { close_(sl, i, cut); exited = true; }
        else if (H[i] >= tp) { close_(tp, i); exited = true; }
      } else {
        if (O[i] >= sl) { close_(O[i], i, cut); exited = true; }
        else if (H[i] >= sl) { close_(sl, i, cut); exited = true; }
        else if (L[i] <= tp) { close_(tp, i); exited = true; }
      }
      if (exited) continue;
      if (pos !== 0) continue;
    }
    if (pos === 0 && !flatNow && !blocked()) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0) || ax[i - 1] < 25) continue;
      // the arming test itself, with the pad chosen by ATR
      const k = kOf(a);
      const pad = k * a;
      let s = 0;
      if (tf.close[i - 1] > dh[i - 1] - pad) s = 1;
      else if (tf.close[i - 1] < dl[i - 1] + pad) s = -1;
      if (!s) continue;
      if (!EFFOK[i - 1]) continue;
      armDir = s; armBar = i; armBy = i + ADD_WIN; armEp = O[i]; armA = a;
      armPx = O[i] + s * Math.max(a * TRIG, tick);
      armSl = Math.max(a * 5, tick); armTp = Math.max(a * 1.75, tick);
    }
  }
  return out;
}
// precompute which bars pass the session + efficiency gate, independent of k
const EFFOK = (() => {
  const probe = new Int8Array(n).fill(1);
  const g = applyFilters(probe, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) ok[i] = g[i] !== 0 ? 1 : 0;
  return ok;
})();

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
  return { n: t.length, win: 100 * w / t.length, pf: gl ? gw / gl : Infinity,
           exp: t.length ? tot / t.length : 0, net: tot };
};

const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
const base = replay(() => 0);
const QB = (() => {
  const a = base.map(t => t.atr).sort((x, y) => x - y);
  return [0.2, 0.4, 0.6, 0.8].map(p => a[Math.floor(p * a.length)]);
})();
const qi = (v) => v < QB[0] ? 0 : v < QB[1] ? 1 : v < QB[2] ? 2 : v < QB[3] ? 3 : 4;

// ── 1. BAND STABILITY ───────────────────────────────────────────────
console.log("\n1. BAND STABILITY — which ATR bucket wins, period by period?\n");
console.log("   Quintile boundaries fixed on the full sample so the buckets mean the");
console.log("   same ATR range everywhere. Entry is $/trade of k=0.40 minus k=0.\n");
const k40 = replay(() => 0.40);
const PERIODS = [];
{
  const span = (T1 - T0) / 4;
  for (let i = 0; i < 4; i++) PERIODS.push([T0 + i * span, T0 + (i + 1) * span]);
}
let hdr = "   period                 ";
for (let i = 0; i < 5; i++) hdr += ("Q" + (i + 1)).padStart(11);
console.log(hdr + "     winner");
const winners = [];
for (const [lo, hi] of PERIODS) {
  const row = [];
  for (let i = 0; i < 5; i++) {
    const a = stat(base.filter(t => t.entryTime >= lo && t.entryTime < hi && qi(t.atr) === i));
    const b = stat(k40.filter(t => t.entryTime >= lo && t.entryTime < hi && qi(t.atr) === i));
    row.push(a.n > 20 && b.n > 20 ? b.exp - a.exp : NaN);
  }
  const best = row.indexOf(Math.max(...row.filter(Number.isFinite)));
  winners.push(best);
  console.log(`   ${new Date(lo).toISOString().slice(0, 7)}..${new Date(hi).toISOString().slice(0, 7)}  ` +
    row.map(v => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + "$" + v.toFixed(0) : "-").padStart(11)).join("") +
    `      Q${best + 1}`);
}
console.log(`\n   winning bucket by period: ${winners.map(w => "Q" + (w + 1)).join(", ")}` +
  (new Set(winners).size === 1 ? "   -> STABLE" : "   -> IT MOVES"));

// ── 2. THE SWITCH, IN SAMPLE ────────────────────────────────────────
console.log("\n2. THE SWITCH, scored in sample (this is the flattering view)\n");
console.log("   variant                             fills    pass     pf   $/trade");
const IN_BAND = (a) => a >= QB[1] && a < QB[2];
for (const [lbl, kOf] of [
  ["k=0 everywhere (ships)", () => 0],
  ["k=0.40 everywhere", () => 0.40],
  ["k=0.40 only in Q3 band", (a) => (IN_BAND(a) ? 0.40 : 0)],
  ["k=0.60 only in Q3 band", (a) => (IN_BAND(a) ? 0.60 : 0)],
  ["k=0.40 only OUTSIDE Q3", (a) => (IN_BAND(a) ? 0 : 0.40)],
]) {
  const b = replay(kOf), s = stat(b);
  console.log(`   ${lbl.padEnd(34)}${String(s.n).padStart(6)}  ${passOf(b, T0, T1).toFixed(1).padStart(6)}  ` +
    `${s.pf.toFixed(3)}  ${("$" + s.exp.toFixed(2)).padStart(8)}`);
}

// ── 3. WALK-FORWARD WITH THE SWITCH ─────────────────────────────────
console.log("\n3. WALK-FORWARD — band AND k chosen on the past only\n");
console.log("   At each cut, every (band, k) pair is scored on training data and the");
console.log("   best is applied to the next six months, unseen.\n");
console.log("   test period            chosen band   k     k=0 $/t   switch $/t    delta");
const KS = [0, 0.20, 0.40, 0.60, 0.80];
const BANDS = [[-1, 1e9], [0, QB[0]], [QB[0], QB[1]], [QB[1], QB[2]], [QB[2], QB[3]], [QB[3], 1e9]];
const BANDNAME = ["all", "Q1", "Q2", "Q3", "Q4", "Q5"];
const CACHE = new Map();
const bookFor = (bi, k) => {
  const key = bi + "|" + k;
  if (!CACHE.has(key)) {
    const [lo, hi] = BANDS[bi];
    CACHE.set(key, replay((a) => (a >= lo && a < hi ? k : 0)));
  }
  return CACHE.get(key);
};
const HALF = 182 * 86400000;
const wfT = [], baseT = [];
for (let cut = T0 + 730 * 86400000; cut + HALF <= T1; cut += HALF) {
  let bb = 0, bk = 0, best = -Infinity;
  for (let bi = 0; bi < BANDS.length; bi++) for (const k of KS) {
    if (k === 0 && bi > 0) continue;
    const tr = bookFor(bi, k).filter(t => t.entryTime < cut);
    if (tr.length < 200) continue;
    const sc = stat(tr).exp;
    if (sc > best) { best = sc; bb = bi; bk = k; }
  }
  const teLo = cut, teHi = Math.min(cut + HALF, T1);
  const te = bookFor(bb, bk).filter(t => t.entryTime >= teLo && t.entryTime < teHi);
  const te0 = base.filter(t => t.entryTime >= teLo && t.entryTime < teHi);
  if (te.length < 30 || te0.length < 30) continue;
  const s = stat(te), s0 = stat(te0);
  wfT.push(...te); baseT.push(...te0);
  console.log(`   ${new Date(teLo).toISOString().slice(0, 10)}..${new Date(teHi).toISOString().slice(0, 10)}` +
    `${BANDNAME[bb].padStart(11)}  ${bk.toFixed(2)}  ${("$" + s0.exp.toFixed(2)).padStart(9)}  ` +
    `${("$" + s.exp.toFixed(2)).padStart(11)}  ${((s.exp - s0.exp >= 0 ? "+" : "") + "$" + (s.exp - s0.exp).toFixed(2)).padStart(9)}`);
}
{
  const w = stat(wfT), b = stat(baseT);
  const lo2 = T0 + 730 * 86400000;
  console.log(`\n   switch, out of sample   ${w.n} trades  pf ${w.pf.toFixed(3)}  ` +
    `$/trade $${w.exp.toFixed(2)}  PASS ${passOf(wfT, lo2, T1).toFixed(1)}%`);
  console.log(`   always k=0              ${b.n} trades  pf ${b.pf.toFixed(3)}  ` +
    `$/trade $${b.exp.toFixed(2)}  PASS ${passOf(baseT, lo2, T1).toFixed(1)}%`);
}
