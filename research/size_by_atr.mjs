// "Afternoon ATR is lower, so can afternoon trades carry more lots?"
//
// The intuition is right in shape: a $2/point bracket sized on ATR 13 risks
// fewer dollars than one sized on ATR 21, so the quiet part of the day looks
// like it is under-using the risk budget.
//
// But the budget is not a POINT limit, it is the $1,000 daily dollar cap. At 8
// lots that cap is 62.5 points away, and the intended stop is 5xATR. So the
// question is not "is ATR lower" but "does 5xATR still fit inside 62.5 points",
// and the answer decides whether there is any headroom to spend.
//
// Measured at the ENTRIES rather than over all bars (entries are selected by
// the efficiency gate, so their ATR is not the bar-level average):
//
//   window        mean ATR   % with room under the cap   effective stop
//   09:30-10:00       17.7                        29%         3.73xATR
//   14:30-15:00       10.4                        75%         4.59xATR
//
// So the premise holds -- three quarters of late entries leave dollar budget
// unspent, against under a third at the open. The same fact read the other way
// is that the afternoon is the part of the day already running closest to its
// designed 5xATR stop, while the open is squeezed to about 3.7xATR.
//
// Whether spending that budget helps is a separate question, and section (6)
// answers it with a paired bootstrap rather than a leaderboard.
//
// Usage:  node research/size_by_atr.mjs

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
const { open: O, high: H, low: L, ctMin: CT, tday: TD } = tf;

// sizer(atrAtSignal, ctMinAtSignal) -> lots.  ATR is from the signal bar, which
// closed before the arm was placed, so sizing is causal.
function run(sizer) {
  const trades = [];
  let pos = 0, ep = 0, slD = 0, tpD = 0, qty = 0, notional = 0, entCt = 0, entAtr = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0, armQty = 0, armAtr = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (px, i, exact, why) => {
    const xp = pos === 1 ? px - SLIP : px + SLIP;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * PV * qty - PERSIDE * 2 * qty;
    trades.push({ tday: TD[i], pnl: net, why, entCt, lots: qty, atr: entAtr });
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
          pos = armDir; qty = armQty; ep = armEp; slD = armSl; tpD = armTp;
          notional = (pos === 1 ? armPx + SLIP : armPx - SLIP) * qty;
          entCt = CT[i]; entAtr = armAtr; armDir = 0;
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
      const q = sizer(a, CT[i]);
      if (q < 1) continue;
      armDir = s2; armBar = i; armBy = i + ADD_WIN; armEp = O[i]; armQty = q; armAtr = a;
      armPx = O[i] + s2 * Math.max(a * TRIG, TICK);
      armSl = Math.max(a * 5, TICK); armTp = Math.max(a * 1.75, TICK);
    }
  }
  return trades;
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
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const et = (ct) => String(Math.floor((ct + 60) / 60)).padStart(2, "0") + ":" +
                   String((ct + 60) % 60).padStart(2, "0");

console.log("\n" + "=".repeat(112));
console.log("CAN LATER TRADES CARRY MORE LOTS?");
console.log("=".repeat(112));

// ---- 1. is there actually headroom? -------------------------------------
console.log("\n-- (1) the headroom question: does the intended 5xATR stop fit inside the $1,000 cap at 8 lots? --");
console.log("   cap distance at 8 lots = 62.5 points, so the stop fits only when ATR < 12.5");
console.log("\n  window        entries   mean ATR   5xATR $   % with room to spare   effective stop");
const flat8 = run(() => 8);
const B = new Map();
for (const t of flat8) { const b = Math.floor((t.entCt - 510) / 30); if (!B.has(b)) B.set(b, []); B.get(b).push(t); }
for (const b of [...B.keys()].sort((x, y) => x - y)) {
  const g = B.get(b);
  const room = g.filter(t => 5 * t.atr * PV * 8 < CAP).length;
  const eff = mean(g.map(t => Math.min(5 * t.atr, 62.5) / t.atr));
  console.log("  " + (et(510 + b * 30) + "-" + et(510 + b * 30 + 30)).padEnd(14) +
    String(g.length).padStart(7) + mean(g.map(t => t.atr)).toFixed(1).padStart(11) +
    ("$" + Math.round(mean(g.map(t => 5 * t.atr * PV * 8)))).padStart(10) +
    (100 * room / g.length).toFixed(0).padStart(21) + "%" + (eff.toFixed(2) + "xATR").padStart(17));
}
console.log("\n  Read the last two columns. The afternoon is NOT sitting on unused budget -- it is the");
console.log("  part of the day whose stop is closest to the 5xATR it was designed to be. The OPEN is");
console.log("  where the cap bites, squeezing 5xATR down to about 3xATR.");

// ---- 2. does sizing on it help? -----------------------------------------
const HDR = "  sizing rule                    n   avg lots   win%     pf   $/trade      net    pass   1stH   2ndH  recent";
function row(lbl, trades) {
  const st = stat(trades);
  const p1 = passOf(inSet(trades, H1), H1), p2 = passOf(inSet(trades, H2), H2);
  console.log("  " + lbl.padEnd(28) + String(st.n).padStart(6) +
    mean(trades.map(t => t.lots)).toFixed(1).padStart(11) + st.win.toFixed(1).padStart(7) +
    st.pf.toFixed(3).padStart(7) + ("$" + st.exp.toFixed(2)).padStart(10) +
    ("$" + Math.round(st.net / 1000) + "k").padStart(9) +
    passOf(trades, days).toFixed(1).padStart(8) + "%" + p1.toFixed(1).padStart(6) + "%" +
    p2.toFixed(1).padStart(6) + "%" + passOf(inSet(trades, RECENT), RECENT).toFixed(1).padStart(7) + "%");
  return Math.min(p1, p2);
}
console.log("\n-- (2) constant-dollar-risk sizing: lots chosen so 5xATR always costs the same --");
console.log(HDR);
row("flat 8 (ships today)", flat8);
for (const budget of [600, 800, 1000, 1200, 1500])
  row("risk $" + budget + "/trade", run(a => Math.max(1, Math.min(50, Math.floor(budget / (5 * a * PV))))));

console.log("\n-- (3) straight time split: 8 lots early, more later --");
console.log(HDR);
for (const cut of [570, 630, 690])
  for (const late of [10, 12, 16, 20])
    row("8 before " + et(cut) + ", " + late + " after", run((a, ct) => ct < cut ? 8 : late));

console.log("\n-- (4) the reverse, since the open is where the cap actually bites --");
console.log(HDR);
for (const cut of [570, 630])
  for (const early of [5, 6, 7])
    row(early + " before " + et(cut) + ", 8 after", run((a, ct) => ct < cut ? early : 8));

console.log("\n-- (5) cap the dollar risk instead of the lot count --");
console.log(HDR);
for (const budget of [800, 1000])
  for (const maxL of [12, 16, 20])
    row("risk $" + budget + ", max " + maxL,
        run(a => Math.max(1, Math.min(maxL, Math.floor(budget / (5 * a * PV))))));

// ---- 6. paired bootstrap on the one config that beat flat 8 -------------
// Section (3) searched 12 combinations and one of them cleared the shipped
// setting by 0.7pp on the worse half, with interior peaks on BOTH the cut time
// and the lot count. That is the exact shape a search on noise produces, so it
// gets a paired test: same resampled days for both configs, difference measured
// inside each draw.
console.log("\n-- (6) is '8 before 11:30, 12 after' actually better than flat 8? paired bootstrap --");
const best = run((a, ct) => ct < 630 ? 8 : 12);
function dayMap(trades) {
  const m = new Map(); for (const d of days) m.set(d, 0);
  for (const t of trades) if (m.has(t.tday)) m.set(t.tday, m.get(t.tday) + t.pnl);
  return days.map(k => m.get(k));
}
const aArr = dayMap(flat8), bArr = dayMap(best);
const rnd2 = mul(777);
const diffs = [];
for (let rep = 0; rep < 400; rep++) {
  let wa = 0, wb = 0;
  const idx = new Array(21), ba = new Array(21), bb = new Array(21);
  for (let d = 0; d < 300; d++) {
    let mm = 0;
    while (mm < 21) { const st = Math.floor(rnd2() * Math.max(1, days.length - 5));
      for (let j = 0; j < 5 && mm < 21; j++) idx[mm++] = (st + j) % days.length; }
    for (let k = 0; k < 21; k++) { ba[k] = aArr[idx[k]]; bb[k] = bArr[idx[k]]; }
    wa += ev(ba); wb += ev(bb);
  }
  diffs.push(100 * (wb - wa) / 300);
}
diffs.sort((x, y) => x - y);
const mDiff = diffs.reduce((x, y) => x + y, 0) / diffs.length;
console.log("  paired difference (12-after minus flat 8): " + mDiff.toFixed(2) + "pp");
console.log("  95% CI: " + diffs[10].toFixed(2) + "pp to " + diffs[389].toFixed(2) + "pp");
console.log("  draws where the 12-after version wins: " +
  (100 * diffs.filter(d => d > 0).length / diffs.length).toFixed(0) + "%");
