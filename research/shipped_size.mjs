// What does the SHIPPED bot do with the real allocation?
//
// The live config runs 8 lots. The allocation is up to 50. Every pass-rate
// number quoted in this project -- 49.8%, 52.0% -- was measured at 8, so the
// most actionable question raised by the ORB work is not about the ORB at all.
//
// Size does not scale linearly, because the $1,000 platform cap is a DOLLAR
// limit. The bot's stop is 5xATR, already wider than the cap on ~56% of entries
// at 8 lots; at 50 lots the cap binds on essentially everything, so the platform
// liquidation becomes the real stop and the strategy quietly turns into
// something else. There is an optimum and it needs measuring, not assuming.
//
// Engine is the shipped one, lifted from research/fill_mechanism.mjs -- clock
// aligned 2-minute bars, Donchian(30) + ADX 25 + efficiency 0.5, stop-entry at
// 0.15xATR deferred one bar, 5xATR stop / 1.75xATR target, exact-mode day cap.
//
// Usage:  node research/shipped_size.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750;
const TRIG = 0.15, ADD_WIN = 10, PV = 2, TICK = 0.25, SLIP = 0.25, PERSIDE = 0.75;
const FLAT = 905, NOENTRY = 895;
const { bars } = loadBars();
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
const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;

function run(TOTAL, costMult = 1) {
  const slip = SLIP * costMult, perSide = PERSIDE * costMult;
  const trades = [];
  let pos = 0, ep = 0, slD = 0, tpD = 0, qty = 0, notional = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  let capStops = 0, nTr = 0;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (px, i, exact, why) => {
    const xp = pos === 1 ? px - slip : px + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * PV * qty - perSide * 2 * qty;
    trades.push({ tday: TD[i], pnl: net, why });
    nTr++; if (why === "SLcap") capStops++;
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; notional = 0;
  };
  for (let i = 1; i < n; i++) {
    const s2 = sig[i - 1];
    const flatNow = CT[i] >= FLAT || CT[i] < 510;
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    if (pos === 0 && armDir !== 0) {
      if (flatNow || i > armBy || blocked()) armDir = 0;
      else if (i > armBar) {
        const touched = armDir === 1 ? H[i] >= armPx : L[i] <= armPx;
        if (touched) {
          pos = armDir; qty = TOTAL; ep = armEp; slD = armSl; tpD = armTp;
          notional = (pos === 1 ? armPx + slip : armPx - slip) * qty;
          armDir = 0;
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
      armDir = s2; armBar = i; armBy = i + ADD_WIN; armEp = O[i];
      armPx = O[i] + s2 * Math.max(a * TRIG, TICK);
      armSl = Math.max(a * 5, TICK); armTp = Math.max(a * 1.75, TICK);
    }
  }
  return { trades, capPct: 100 * capStops / Math.max(1, nTr) };
}

const days = [...new Set(tf.tday)].sort((a, b) => a - b);
const H1 = days.slice(0, days.length >> 1), H2 = days.slice(days.length >> 1);
const RECENT = days.slice(-500);
function ev(d) {
  let c = 0, pk = 0, lk = false, md = -1e18;
  for (const v of d) {
    c += v; if (v > md) md = v;
    if (c <= (lk ? 0 : pk - 2000)) return 0;
    if (c > pk) pk = c;
    if (!lk && pk >= 2000) lk = true;
    if (c >= 3000 && md <= 0.5 * c) return 1;
  }
  return 0;
}
function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function passOf(trades, keys) {
  const m = new Map(); for (const d of keys) m.set(d, 0);
  for (const t of trades) if (m.has(t.tday)) m.set(t.tday, m.get(t.tday) + t.pnl);
  const arr = keys.map(k => m.get(k));
  const rnd = mul(4242), idx = new Array(21), buf = new Array(21);
  let w = 0;
  for (let d = 0; d < 12000; d++) {
    let mm = 0;
    while (mm < 21) { const st = Math.floor(rnd() * Math.max(1, arr.length - 5));
      for (let j = 0; j < 5 && mm < 21; j++) idx[mm++] = (st + j) % arr.length; }
    for (let k = 0; k < 21; k++) buf[k] = arr[idx[k]];
    w += ev(buf);
  }
  return 100 * w / 12000;
}
const stat = (t) => {
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const x of t) { tot += x.pnl; if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; }
  return { n: t.length, win: 100 * w / t.length, pf: gw / gl, exp: tot / t.length, net: tot };
};
const inSet = (t, s) => { const q = new Set(s); return t.filter(x => q.has(x.tday)); };

console.log("\n" + "=".repeat(112));
console.log("THE SHIPPED BOT vs POSITION SIZE  |  allocation is up to 50 MNQ lots; it currently runs 8");
console.log("=".repeat(112));
console.log("\n  lots   win%     pf   $/trade        net   cap-stopped    pass    1stH    2ndH  recent");
const rows = [];
for (const lots of [4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 32, 40, 50]) {
  const { trades, capPct } = run(lots);
  const st = stat(trades);
  const p = passOf(trades, days), p1 = passOf(inSet(trades, H1), H1);
  const p2 = passOf(inSet(trades, H2), H2), pr = passOf(inSet(trades, RECENT), RECENT);
  rows.push({ lots, p, p1, p2, pr, st, capPct });
  console.log("  " + String(lots).padStart(4) + st.win.toFixed(1).padStart(7) + st.pf.toFixed(3).padStart(7) +
    ("$" + st.exp.toFixed(2)).padStart(10) + ("$" + Math.round(st.net / 1000) + "k").padStart(11) +
    capPct.toFixed(1).padStart(12) + "%" + p.toFixed(1).padStart(8) + "%" +
    p1.toFixed(1).padStart(7) + "%" + p2.toFixed(1).padStart(7) + "%" + pr.toFixed(1).padStart(7) + "%" +
    (lots === 8 ? "   <- ships today" : ""));
}
const best = rows.slice().sort((a, b) => Math.min(b.p1, b.p2) - Math.min(a.p1, a.p2))[0];
console.log("\n  best on the worse half: " + best.lots + " lots (" + Math.min(best.p1, best.p2).toFixed(1) +
            "%), against " + Math.min(rows.find(r => r.lots === 8).p1, rows.find(r => r.lots === 8).p2).toFixed(1) +
            "% at the 8 that ship today");

console.log("\n-- cost sensitivity at the interesting sizes (thin books punish size) --");
console.log("  lots  costs   win%     pf   $/trade    pass    1stH    2ndH");
for (const lots of [8, 16, 24, 32, 40])
for (const cm of [1, 2]) {
  const { trades } = run(lots, cm);
  const st = stat(trades);
  console.log("  " + String(lots).padStart(4) + ("x" + cm).padStart(7) + st.win.toFixed(1).padStart(7) +
    st.pf.toFixed(3).padStart(7) + ("$" + st.exp.toFixed(2)).padStart(10) +
    passOf(trades, days).toFixed(1).padStart(8) + "%" +
    passOf(inSet(trades, H1), H1).toFixed(1).padStart(7) + "%" +
    passOf(inSet(trades, H2), H2).toFixed(1).padStart(7) + "%");
}
