// How should "price reached entry + 0.15xATR" become a position?
//
// The shipped bot rests a STOP order for the full size -- ProjectX order type 4
// with an attached bracket. That is the least standard call in the whole API
// surface, it has never been sent, and it is the piece whose tick convention I
// flagged as the largest untested assumption.
//
// The alternative is to treat the level as a SIGNAL rather than an order: watch
// price, and when it reaches the trigger, send an ordinary MARKET order with an
// ordinary bracket -- type 2, the same call the bot used for market entries
// before any of this. That removes the exotic order type, removes the resting
// order entirely, and restores the safety invariant that a flat bot never has a
// working order.
//
// What it costs is fill quality, and how much depends entirely on how often
// price is checked:
//   stop      resting order, fills AT the trigger the moment it trades there
//   poll      sub-bar polling (the flatten loop already runs every 10s), then a
//             market order -- fills near the trigger plus reaction slippage
//   barclose  notice at the 2-minute bar close, market order at the next open --
//             up to two minutes late, at whatever price the market reached
//
// Usage:  node research/fill_mechanism.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const TOTAL = 8, CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750;
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

function run(fillMode, extraTicks) {
  const trades = [];
  let arms = 0, fills = 0, missed = 0;
  const slipPts = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, qty = 0, notional = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (px, i, exact, why) => {
    const xp = pos === 1 ? px - SLIP : px + SLIP;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * PV * qty - PERSIDE * 2 * qty;
    trades.push({ tday: TD[i], entryTime: entTime, pnl: net, why });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; notional = 0;
  };
  const enter = (i, fillPx) => {
    pos = armDir; qty = TOTAL; ep = armEp; slD = armSl; tpD = armTp;
    entTime = TS[i];
    slipPts.push((fillPx - armPx) * armDir);
    notional = (pos === 1 ? fillPx + SLIP : fillPx - SLIP) * qty;
    fills++; armDir = 0;
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
          if (fillMode === "stop") enter(i, armPx);
          else if (fillMode === "poll") enter(i, armPx + armDir * extraTicks * TICK);
          else {
            const j = i + 1;
            if (j < n && CT[j] < FLAT && TD[j] === TD[i]) enter(j, O[j]);
            else { armDir = 0; missed++; }
          }
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
      let done = false;
      if (dir === 1) {
        if (O[i] <= sl) { close_(O[i], i, cut, "SL"); done = true; }
        else if (L[i] <= sl) { close_(sl, i, cut, "SL"); done = true; }
        else if (H[i] >= tp) { close_(tp, i, undefined, "TP"); done = true; }
      } else {
        if (O[i] >= sl) { close_(O[i], i, cut, "SL"); done = true; }
        else if (H[i] >= sl) { close_(sl, i, cut, "SL"); done = true; }
        else if (L[i] <= tp) { close_(tp, i, undefined, "TP"); done = true; }
      }
      if (done) continue;
      if (s2 !== 0 && s2 !== pos) close_(O[i], i, undefined, "FLIP");
      if (pos !== 0) continue;
    }
    if (pos === 0 && s2 !== 0 && !flatNow && !blocked() && CT[i] < NOENTRY) {
      const a = A[i - 1];
      if (!(a > 0)) continue;
      arms++;
      armDir = s2; armBar = i; armBy = i + ADD_WIN; armEp = O[i];
      armPx = O[i] + s2 * Math.max(a * TRIG, TICK);
      armSl = Math.max(a * 5, TICK); armTp = Math.max(a * 1.75, TICK);
    }
  }
  return { trades, arms, fills, slipPts };
}
const daysAll = new Set(); for (let i = 0; i < n; i++) daysAll.add(tf.tday[i]);
function ev2(d) {
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
function mul2(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function passOf2(trades) {
  const m = new Map(); for (const d of daysAll) m.set(d, 0);
  for (const t of trades) m.set(t.tday, (m.get(t.tday) ?? 0) + t.pnl);
  const keys = [...m.keys()].sort((a, b) => a - b), arr = keys.map(k => m.get(k));
  const rnd = mul2(4242), idx = new Array(21), buf = new Array(21);
  let w = 0;
  for (let d = 0; d < 12000; d++) {
    let mm = 0;
    while (mm < 21) { const st = Math.floor(rnd() * Math.max(1, keys.length - 5));
      for (let j = 0; j < 5 && mm < 21; j++) idx[mm++] = (st + j) % keys.length; }
    for (let k = 0; k < 21; k++) buf[k] = arr[idx[k]];
    w += ev2(buf);
  }
  return 100 * w / 12000;
}
const stat2 = (t) => {
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const x of t) { tot += x.pnl; if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; }
  return { n: t.length, win: 100 * w / t.length, pf: gw / gl, exp: tot / t.length, net: tot };
};

console.log("\nHOW THE 0.15xATR TRIGGER BECOMES A POSITION\n");
console.log("  mechanism                  order type          fills   win%     pf   $/trade    pass");
for (const [lbl, mode, ex, ot] of [
  ["resting STOP (ships)", "stop", 0, "type 4 + bracket"],
  ["poll -> MARKET, +0 ticks", "poll", 0, "type 2 standard"],
  ["poll -> MARKET, +1 tick", "poll", 1, "type 2 standard"],
  ["poll -> MARKET, +2 ticks", "poll", 2, "type 2 standard"],
  ["poll -> MARKET, +4 ticks", "poll", 4, "type 2 standard"],
  ["bar-close -> MARKET", "barclose", 0, "type 2 standard"],
]) {
  const r = run(mode, ex);
  const st = stat2(r.trades);
  const avgSlip = r.slipPts.reduce((a, b) => a + b, 0) / r.slipPts.length;
  console.log("  " + lbl.padEnd(27) + ot.padEnd(19) + String(r.fills).padStart(5) +
    st.win.toFixed(1).padStart(7) + "  " + st.pf.toFixed(3) +
    ("$" + st.exp.toFixed(2)).padStart(10) + passOf2(r.trades).toFixed(1).padStart(8) + "%" +
    (mode === "barclose" ? "   avg fill " + avgSlip.toFixed(1) + " pts past the trigger" : ""));
}
