// Are the two context filters real, or is any filter of that size worth this?
//
// context_gate.mjs found two candidates:
//   skip 12:00-13:00 CT   +1.5pp all, POSITIVE in all five slices, rejects 285
//   relVol >= 1.0x        +2.7pp all, but the sweep is a SPIKE: -0.3 / +0.5 /
//                         +2.7 / +0.8 / -3.1 across adjacent thresholds, and
//                         the mean step between neighbours is 2.2pp
//
// A lone peak surrounded by nothing is the classic overfit shape, and +2.7pp
// against a 2.2pp step is not a comfortable margin. The matched ATR controls
// came out flat, so it is not a volatility proxy — but that only rules out ONE
// alternative explanation. The one that matters more is blunter: this book has
// positive expectancy, so does simply taking FEWER trades help by itself?
//
// The control is a filter that rejects the same SHARE of entries uniformly at
// random, run many times. If the real filter sits inside that distribution it
// carries no information about which trades to skip, only about how many.
//
// Usage:  node research/context_control.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 8000, BLOCK = 5, WIN = 21, TOTAL = 8, Q1 = 2;
const ADD_TRIG = 0.15, ADD_WIN = 10, CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750;
const TRIALS = 150;

const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const S = (await loadStrategies()).get("donchian_eff_rth");
const X = resolveExec(S.execDefaults);
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(tf.close.length);
for (let i = 30; i < raw.length; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });

const n = tf.close.length, V = tf.volume;
// Lookback is a free parameter, so it gets swept rather than chosen. If the
// effect only exists at one window it is fitted; if it survives 10 through 60
// bars it is a property of the market.
function buildRelVol(W) {
  const out = new Float64Array(n).fill(1);
  const buf = new Float64Array(W);
  for (let i = W; i < n; i++) {
    for (let k = 0; k < W; k++) buf[k] = V[i - W + k];
    const srt = Array.from(buf).sort((a, b) => a - b);
    const med = srt[W >> 1];
    out[i] = med > 0 ? V[i] / med : 1;
  }
  return out;
}
let relVol = buildRelVol(20);
function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function replay(gate) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const fills = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, entBar = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  let curTday = -1e9, dayReal = 0, capHit = false, seen = 0, taken = 0;
  const avgFill = () => notional / qty;
  const close_ = (rawExit, i, exact) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    fills.push({ tday: TD[i], entryTime: entTime, pnl: net });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; pendQty = 0; addBy = -1; notional = 0;
  };
  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    if (pos !== 0) {
      if (pendQty > 0 && i - entBar >= 1 && i <= addBy &&
          (pos === 1 ? H[i] >= addPx : L[i] <= addPx)) {
        notional += (pos === 1 ? addPx + slip : addPx - slip) * pendQty;
        qty += pendQty; pendQty = 0;
      }
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
      if (X.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], i);
      if (pos !== 0) continue;
    }
    if (pos === 0 && s !== 0 && !flatNow &&
        !(capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK)) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      seen++;
      if (gate && !gate({ ct: CT[i], relVol: relVol[i - 1] })) continue;
      taken++;
      ep = O[i]; entTime = TS[i]; pos = s; entBar = i;
      slD = Math.max(a * 5, tick); tpD = Math.max(a * 1.75, tick);
      qty = Q1; pendQty = TOTAL - Q1;
      addPx = ep + pos * Math.max(a * ADD_TRIG, tick);
      addBy = i + ADD_WIN;
      notional = (pos === 1 ? ep + slip : ep - slip) * qty;
    }
  }
  return { fills, seen, taken };
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
function passOf(map, keys, seed) {
  const rnd = mul(seed), N = keys.length, idx = new Array(WIN);
  const arr = keys.map(k => map.get(k) ?? 0), buf = new Array(WIN);
  let w = 0;
  for (let d = 0; d < DRAWS; d++) {
    let m = 0;
    while (m < WIN) { const st = Math.floor(rnd() * Math.max(1, N - BLOCK));
      for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = (st + j) % N; }
    for (let k = 0; k < WIN; k++) buf[k] = arr[idx[k]];
    w += ev(buf);
  }
  return (100 * w) / DRAWS;
}

const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
const MID = T0 + (T1 - T0) / 2, Y12 = T1 - 365 * 86400000, Y26 = Date.UTC(2026, 0, 1);
const SLICES = [["early", T0, MID], ["late", MID, T1],
                ["12m", Y12, T1], ["2026", Y26, T1], ["ALL", T0, T1]];

function passSlices(fills) {
  return SLICES.map(([, lo, hi]) => {
    const m = dayMap(fills, lo, hi);
    const keys = [...m.keys()].sort((a, b) => a - b);
    return keys.length > 40 ? passOf(m, keys, 4242) : NaN;
  });
}
const baseP = passSlices(replay(null).fills);
console.log("\nROBUSTNESS: does the volume effect depend on the lookback window?\n");
console.log("  A free parameter chosen once is a fitted parameter. Swept instead.\n");
let hdr = "  lookback  threshold";
for (const [nm] of SLICES) hdr += nm.padStart(11);
console.log(hdr);
const lunch = f => f.ct >= 720 && f.ct < 780;
for (const W of [10, 20, 30, 45, 60]) {
  relVol = buildRelVol(W);
  for (const th of [0.9, 1.0, 1.1]) {
    const r = replay(f => f.relVol >= th);
    const ps = passSlices(r.fills);
    let row = `  ${String(W).padStart(8)}  ${th.toFixed(2).padStart(9)}`;
    ps.forEach((v, j) => {
      const d = v - baseP[j];
      row += ((d >= 0 ? "+" : "") + d.toFixed(1)).padStart(11);
    });
    console.log(row);
  }
}
console.log("\n  (deltas in pp vs ship. baseline: " +
            baseP.map(v => v.toFixed(1) + "%").join("  ") + ")\n");

console.log("  and with the lunch skip added, at the natural 1.0x threshold:\n");
for (const W of [10, 20, 30, 45, 60]) {
  relVol = buildRelVol(W);
  const r = replay(f => f.relVol >= 1.0 && !lunch(f));
  const ps = passSlices(r.fills);
  let row = `  ${String(W).padStart(8)}  ${"1.0 + lunch".padStart(9)}`;
  ps.forEach((v, j) => {
    const d = v - baseP[j];
    row += ((d >= 0 ? "+" : "") + d.toFixed(1)).padStart(11);
  });
  console.log(row);
}

// ── the same robustness question, asked of the LUNCH skip ────────────
// The volume filter failed because its free parameter mattered. The lunch skip
// has no fitted parameter — the hour is a clock fact — but the WINDOW is still a
// choice, so sweep it. If only one narrow definition of "lunch" works, it is the
// same failure in a different costume.
console.log("\n  LUNCH WINDOW SENSITIVITY — no volume filter, window swept\n");
console.log("  window          rejects      early       late        12m       2026        ALL");
const WINDOWS = [
  ["11:30-13:00", 690, 780], ["12:00-13:00", 720, 780], ["12:00-13:30", 720, 810],
  ["11:00-13:00", 660, 780], ["12:30-13:30", 750, 810], ["11:00-14:00", 660, 840],
  ["12:00-12:30", 720, 750],
];
for (const [lbl, a, b] of WINDOWS) {
  const r = replay(f => !(f.ct >= a && f.ct < b));
  const ps = passSlices(r.fills);
  let row = `  ${lbl.padEnd(14)}${((100 * (1 - r.taken / r.seen)).toFixed(1) + "%").padStart(7)}`;
  ps.forEach((v, j) => {
    const d = v - baseP[j];
    row += ((d >= 0 ? "+" : "") + d.toFixed(1)).padStart(11);
  });
  console.log(row);
}
console.log("\n  A real dead hour should show up under every reasonable window that");
console.log("  contains it, weakening smoothly as the window widens past it.");
