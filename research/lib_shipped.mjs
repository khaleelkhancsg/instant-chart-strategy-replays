// The shipped bot's engine, extracted once so sizing experiments stop being
// copy-pasted (this is its fourth appearance and copies drift).
//
// Clock-aligned 2-minute bars, Donchian(30) + ADX 25 + efficiency 0.5,
// stop-entry at 0.15xATR deferred one bar, 5xATR stop / 1.75xATR target,
// exact-mode day cap, circuit breaker and profit block as entry-only blocks.
//
// Instrument switch:  ORB_BIN=data/mes_1m.bin ORB_PV=5 node research/<x>.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

export const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750;
export const PV = Number(process.env.ORB_PV || 2);
const TRIG = 0.15, ADD_WIN = 10, TICK = 0.25, SLIP = 0.25, PERSIDE = 0.75;
const FLAT = 905, NOENTRY = 895;

const { bars } = loadBars(process.env.ORB_BIN || undefined);
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const nB = tf.close.length;
const raw = new Int8Array(nB);
for (let i = 30; i < nB; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;

export const days = [...new Set(TD)].sort((a, b) => a - b);
export const yearOf = new Map();
{
  const seen = new Set();
  for (let i = 0; i < nB; i++) if (!seen.has(TD[i])) { seen.add(TD[i]); yearOf.set(TD[i], new Date(TS[i]).getUTCFullYear()); }
}
export const H1 = days.slice(0, days.length >> 1), H2 = days.slice(days.length >> 1);
export const RECENT = days.slice(-500);

// sizer(atrAtSignal, ctMinAtSignal, signalIndex) -> lots
export function run(sizer, { costMult = 1 } = {}) {
  const slip = SLIP * costMult, perSide = PERSIDE * costMult;
  const trades = [];
  let pos = 0, ep = 0, slD = 0, tpD = 0, qty = 0, notional = 0, entCt = 0, entBar = 0, entAtr = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0, armQty = 0, armAtr = 0;
  let curTday = -1e9, dayReal = 0, capHit = false, sigSeq = 0;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (px, i, exact, why) => {
    const xp = pos === 1 ? px - slip : px + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * PV * qty - perSide * 2 * qty;
    trades.push({ tday: TD[i], pnl: net, why, entCt, lots: qty, atr: entAtr, held: (i - entBar) * 2 });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; notional = 0;
  };
  for (let i = 1; i < nB; i++) {
    const s2 = sig[i - 1];
    const flatNow = CT[i] >= FLAT || CT[i] < 510;
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    if (pos === 0 && armDir !== 0) {
      if (flatNow || i > armBy || blocked()) armDir = 0;
      else if (i > armBar) {
        const touched = armDir === 1 ? H[i] >= armPx : L[i] <= armPx;
        if (touched) {
          pos = armDir; qty = armQty; ep = armEp; slD = armSl; tpD = armTp;
          notional = (pos === 1 ? armPx + slip : armPx - slip) * qty;
          entCt = CT[i]; entBar = i; entAtr = armAtr; armDir = 0;
        }
      }
    }
    if (pos !== 0) {
      if (flatNow) { close_(O[i], i, undefined, "FLAT"); continue; }
      const dir = pos;
      const lossPx = avgFill() - dir * ((CAP + dayReal) / (PV * qty));
      const rawSl = ep - dir * slD;
      const sl = dir === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
      const isCap = dir === 1 ? (sl === lossPx && lossPx > rawSl) : (sl === lossPx && lossPx < rawSl);
      const tp = ep + dir * tpD;
      const cut = isCap ? -CAP - dayReal : undefined;
      const why = isCap ? "SLcap" : "SL";
      let done = false;
      if (dir === 1) {
        if (O[i] <= sl) { close_(O[i], i, cut, why); done = true; }
        else if (L[i] <= sl) { close_(sl, i, cut, why); done = true; }
        else if (H[i] >= tp) { close_(tp, i, undefined, "TP"); done = true; }
      } else {
        if (O[i] >= sl) { close_(O[i], i, cut, why); done = true; }
        else if (H[i] >= sl) { close_(sl, i, cut, why); done = true; }
        else if (L[i] <= tp) { close_(tp, i, undefined, "TP"); done = true; }
      }
      if (done) continue;
      if (s2 !== 0 && s2 !== pos) close_(O[i], i, undefined, "FLIP");
      if (pos !== 0) continue;
    }
    if (pos === 0 && s2 !== 0 && !flatNow && !blocked() && CT[i] < NOENTRY) {
      const a = A[i - 1];
      if (!(a > 0)) continue;
      const q = sizer(a, CT[i], sigSeq++);
      if (q < 1) continue;
      armDir = s2; armBar = i; armBy = i + ADD_WIN; armEp = O[i]; armQty = q; armAtr = a;
      armPx = O[i] + s2 * Math.max(a * TRIG, TICK);
      armSl = Math.max(a * 5, TICK); armTp = Math.max(a * 1.75, TICK);
    }
  }
  return trades;
}

// The combine, parameterised so the result can be checked against metric
// choices it was never tuned on.
export function evWith(d, { target = 3000, dd = 2000, consistency = 0.5 } = {}) {
  let c = 0, pk = 0, lk = false, md = -1e18;
  for (const v of d) {
    c += v; if (v > md) md = v;
    if (c <= (lk ? 0 : pk - dd)) return 0;
    if (c > pk) pk = c;
    if (!lk && pk >= dd) lk = true;
    if (c >= target && (consistency <= 0 || md <= consistency * c)) return 1;
  }
  return 0;
}
export function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function dayArr(trades, keys) {
  const m = new Map(); for (const d of keys) m.set(d, 0);
  for (const t of trades) if (m.has(t.tday)) m.set(t.tday, m.get(t.tday) + t.pnl);
  return keys.map(k => m.get(k));
}
export function passArr(arr, { draws = 12000, seed = 4242, window = 21, ...evOpt } = {}) {
  const rnd = mul(seed), idx = new Array(window), buf = new Array(window);
  let w = 0;
  for (let d = 0; d < draws; d++) {
    let mm = 0;
    while (mm < window) { const st = Math.floor(rnd() * Math.max(1, arr.length - 5));
      for (let j = 0; j < 5 && mm < window; j++) idx[mm++] = (st + j) % arr.length; }
    for (let k = 0; k < window; k++) buf[k] = arr[idx[k]];
    w += evWith(buf, evOpt);
  }
  return 100 * w / draws;
}
export const passOf = (trades, keys, opt) => passArr(dayArr(trades, keys), opt);

export function stat(t) {
  if (!t.length) return { n: 0, win: 0, pf: 0, exp: 0, net: 0, lots: 0 };
  let gw = 0, gl = 0, tot = 0, w = 0, lo = 0;
  for (const x of t) { tot += x.pnl; lo += x.lots; if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; }
  return { n: t.length, win: 100 * w / t.length, pf: gl > 0 ? gw / gl : Infinity,
           exp: tot / t.length, net: tot, lots: lo / t.length };
}
export const inSet = (t, s) => { const q = new Set(s); return t.filter(x => q.has(x.tday)); };
