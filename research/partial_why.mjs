// !! REFUTED — see research/partial_order_check.mjs !!
//
// Every partial-exit result below is INVALID. The replay resolved the full
// target BEFORE the partial and then `continue`d, so on any bar that reached
// the target all 8 lots exited there and the partial never fired. That makes
// the simulated rule "sell 6 lots at 1.575xATR, but only when this bar will not
// reach 1.75xATR" — lookahead inside the bar, and not tradeable.
//
// A resting limit fills whenever price passes through it. With that correction
// the fire rate goes 22% -> 67%, because most trades that touch the partial
// level do so on a bar that also touches the target, and ALL 18 grid settings
// lose: best -3.4pp, worst -20.2pp, none inside the +-1.0pp noise floor.
//
// Kept for the record and because the diagnosis of the give-back pool, and the
// finding that every stop-MOVING rule loses, both still stand.

// Two open questions from partial_validate.mjs, both of which decide whether the
// partial-exit finding is usable.
//
// A. It gains +3.4pp on BOTH halves of history but is negative on 12m (-0.3)
//    and 2026 (-4.7). Is that a regime failure or just a tiny sample? The
//    deciding evidence is P&L, not pass rate: if profit factor and expectancy
//    are ALSO down in 2026 the idea is fitted to the old data; if they hold up
//    while only the pass rate falls, it is a variance/rules story instead.
//
// B. The mechanism is not the cap (proved: removing the cap made the gain
//    BIGGER). The remaining structural candidate is the 50% CONSISTENCY rule —
//    halving the position makes winning days smaller and more numerous, which is
//    exactly what that rule rewards. Toggle it and see.
//
// Usage:  node research/partial_why.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 20000, BLOCK = 5, WIN = 21, TOTAL = 8, Q1 = 2, ADD_TRIG = 0.15, ADD_WIN = 10;
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

function replay(trig, frac, CAP, tpMult = 1.75) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const n = O.length, pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const fills = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  let curTday = -1e9, dayReal = 0, hit = false, tookPartial = false;
  const avgFill = () => notional / qty;
  const bank = (rawExit, i, exact, q) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * q - perSide * 2 * q;
    fills.push({ tday: TD[i], entryTime: entTime, net });
    dayReal += net;
    if (CAP > 0 && dayReal <= -CAP) hit = true;
  };
  const close_ = (rawExit, i, exact) => {
    bank(rawExit, i, exact, qty);
    pos = 0; pendQty = 0; addBy = -1; notional = 0; tookPartial = false;
  };
  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; hit = false; }
    if (pos !== 0) {
      if (pendQty > 0 && i <= addBy && (pos === 1 ? H[i] >= addPx : L[i] <= addPx)) {
        notional += (pos === 1 ? addPx + slip : addPx - slip) * pendQty;
        qty += pendQty; pendQty = 0;
      }
      if (flatNow) { close_(O[i], i); continue; }
      const dir = pos;
      const lossPx = CAP > 0 ? avgFill() - dir * ((CAP + dayReal) / (pv * qty)) : 0;
      const rawSl = ep - dir * slD;
      const sl = CAP > 0 ? (dir === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx)) : rawSl;
      const isCap = CAP > 0 && (dir === 1 ? (sl === lossPx && lossPx > rawSl)
                                          : (sl === lossPx && lossPx < rawSl));
      const tp = ep + dir * tpD;
      let exited = false;
      if (dir === 1) {
        if (O[i] <= sl) { close_(O[i], i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (L[i] <= sl) { close_(sl, i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (H[i] >= tp) { close_(tp, i); exited = true; }
      } else {
        if (O[i] >= sl) { close_(O[i], i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (H[i] >= sl) { close_(sl, i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (L[i] <= tp) { close_(tp, i); exited = true; }
      }
      if (exited) continue;
      if (frac > 0 && !tookPartial) {
        const tgPx = ep + dir * trig * tpD;
        if (dir === 1 ? H[i] >= tgPx : L[i] <= tgPx) {
          const qOut = Math.max(1, Math.round(qty * frac));
          if (qOut < qty) { const af = avgFill(); bank(tgPx, i, undefined, qOut);
            notional -= af * qOut; qty -= qOut; tookPartial = true; }
        }
      }
      if (X.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], i);
      if (pos !== 0) continue;
    }
    if (pos === 0 && s !== 0 && !flatNow && !hit) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      ep = O[i]; entTime = TS[i]; pos = s;
      slD = Math.max(a * 5, tick); tpD = Math.max(a * tpMult, tick);
      qty = Q1; pendQty = TOTAL - Q1;
      addPx = ep + pos * Math.max(a * ADD_TRIG, tick);
      addBy = i + ADD_WIN;
      notional = (pos === 1 ? ep + slip : ep - slip) * qty;
      tookPartial = false;
    }
  }
  return fills;
}
function dayMap(fills, lo, hi) {
  const m = new Map(); let day = null, acc = 0;
  for (const f of fills) {
    if (f.entryTime < lo || f.entryTime >= hi) continue;
    if (f.tday !== day) { if (day !== null) m.set(day, acc); day = f.tday; acc = 0; }
    if (acc >= R.dailyProfitStop || acc <= -R.circuitBreaker) continue;
    acc += f.net;
  }
  if (day !== null) m.set(day, acc);
  return m;
}
function evF(consistency) {
  return (d) => {
    let c = 0, pk = 0, lk = false, md = -1e18;
    for (const v of d) {
      c += v; if (v > md) md = v;
      if (c <= (lk ? 0 : pk - R.trailingDD)) return 0;
      if (c > pk) pk = c;
      if (R.lockAtBreakeven && !lk && pk >= R.trailingDD) lk = true;
      if (c >= R.profitTarget && (!consistency || md <= 0.5 * c)) return 1;
    }
    return 0;
  };
}
function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function pairedPass(books, keys, seed, ev) {
  const rnd = mul(seed), n = keys.length, idx = new Array(WIN);
  const wins = books.map(() => 0);
  const arrs = books.map(m => keys.map(k => m.get(k) ?? 0));
  const buf = new Array(WIN);
  for (let d = 0; d < DRAWS; d++) {
    let m = 0;
    while (m < WIN) { const st = Math.floor(rnd() * Math.max(1, n - BLOCK));
      for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = (st + j) % n; }
    for (let b = 0; b < books.length; b++) {
      for (let k = 0; k < WIN; k++) buf[k] = arrs[b][idx[k]];
      wins[b] += ev(buf);
    }
  }
  return wins.map(w => (100 * w) / DRAWS);
}
function stats(fills, lo, hi) {
  const sel = fills.filter(f => f.entryTime >= lo && f.entryTime < hi);
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const f of sel) { tot += f.net; if (f.net > 0) { w++; gw += f.net; } else gl -= f.net; }
  return { n: sel.length, win: (100 * w) / sel.length, pf: gl ? gw / gl : Infinity,
           exp: tot / sel.length, net: tot };
}

const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
const MID = T0 + (T1 - T0) / 2;
const Y12 = T1 - 365 * 86400000, Y26 = Date.UTC(2026, 0, 1);

// THE DECISIVE CONTROL. The partial takes half at 0.8 x 1.75 = 1.40xATR and
// leaves half at 1.75xATR. If the whole effect is just "less exposure past
// 1.4xATR", then simply SETTING the target to 1.40 should do as well or better
// — and it is a one-line change instead of a second order to manage. Splitting
// is only worth its complexity if it beats both single targets.
const CANDS = [
  ["off, TP 1.75 (ship)",   0,    0,   1.75],
  ["off, TP 1.40",          0,    0,   1.40],
  ["off, TP 1.55",          0,    0,   1.55],
  ["off, TP 1.60",          0,    0,   1.60],
  ["half @1.40, half 1.75", 0.8,  0.5, 1.75],
  ["half @1.23, half 1.75", 0.7,  0.5, 1.75],
  ["half @1.40, half 2.00", 0.7,  0.5, 2.00],
];
const books = CANDS.map(([, t, f, m]) => replay(t, f, 1000, m));

console.log("\nDECISIVE CONTROL: is splitting better than just shortening the target?\n");
const SL = [["early half", T0, MID], ["late half", MID, T1],
            ["last 12m", Y12, T1], ["2026 only", Y26, T1], ["ALL", T0, T1]];
let hdr = "   config                ";
for (const [nm] of SL) hdr += nm.padStart(12);
console.log(hdr);
const rows = CANDS.map(() => []);
for (const [, lo, hi] of SL) {
  const maps = books.map(f => dayMap(f, lo, hi));
  const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  const ps = pairedPass(maps, keys, 4242, evF(true));
  ps.forEach((v, i) => rows[i].push(v));
}
CANDS.forEach(([lbl], i) => {
  let row = "   " + lbl.padEnd(23);
  rows[i].forEach((v, j) => {
    const d = v - rows[0][j];
    row += (v.toFixed(1) + (i === 0 ? "" : (d >= 0 ? "+" : "") + d.toFixed(1))).padStart(12);
  });
  console.log(row);
});

console.log("\nDaily P&L shape (all history) — what both combine rules actually see\n");
console.log("   config                  days   mean$   sd$   mean/sd   <-$500");
CANDS.forEach(([lbl], i) => {
  const v = [...dayMap(books[i], T0, T1).values()];
  const mean = v.reduce((s, a) => s + a, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, a) => s + (a - mean) ** 2, 0) / v.length);
  console.log(`   ${lbl.padEnd(23)}${String(v.length).padStart(6)}  ${("$" + mean.toFixed(0)).padStart(6)}  ` +
    `${("$" + sd.toFixed(0)).padStart(5)}   ${(mean / sd).toFixed(4).padStart(7)}  ` +
    `${String(v.filter(a => a < -500).length).padStart(6)}`);
});
