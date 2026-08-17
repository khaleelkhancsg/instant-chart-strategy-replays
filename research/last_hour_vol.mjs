// "Volatility rises into the close -- blanket 12 lots would over-lever the last hour."
//
// The danger is not high ATR. High ATR is self-correcting: the bracket is
// ATR-scaled, so a volatile entry automatically gets a wider stop and, past the
// cap, fewer effective points of risk. The danger is ATR being WRONG -- it is a
// 28-minute trailing average on 2-minute bars, so if realised volatility in the
// last hour outruns what ATR just measured, every ATR-scaled decision is sized
// off a stale number and the position is bigger than it looks.
//
// So this measures forecast QUALITY, not level:
//   (1) ATR at entry by half hour -- the level
//   (2) realised range over the next 30 minutes DIVIDED BY ATR at entry -- if
//       that ratio is flat across the day, ATR is an honest forecast; if it
//       climbs into the close, ATR under-forecasts and sizing on it is unsafe
//   (3) actual adverse excursion of real trades, in ATR units, including tails
//   (4) liquidation rate and worst outcome at 8 vs 12 lots, by half hour
//   (5) sizing variants that carve the last hour back out
//   (6) paired bootstrap on the best carve-out
//
// Usage:  node research/last_hour_vol.mjs

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
const nB = tf.close.length;
const raw = new Int8Array(nB);
for (let i = 30; i < nB; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const { open: O, high: H, low: L, ctMin: CT, tday: TD } = tf;

function run(sizer) {
  const trades = [];
  let pos = 0, ep = 0, slD = 0, tpD = 0, qty = 0, notional = 0, entCt = 0, entAtr = 0, entBar = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0, armQty = 0, armAtr = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (px, i, exact, why) => {
    const xp = pos === 1 ? px - SLIP : px + SLIP;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * PV * qty - PERSIDE * 2 * qty;
    // worst adverse excursion actually seen while in the trade, in ATR units
    let mae = 0;
    for (let j = entBar; j <= i; j++) {
      const ad = pos === 1 ? avgFill() - L[j] : H[j] - avgFill();
      if (ad > mae) mae = ad;
    }
    trades.push({ tday: TD[i], pnl: net, why, entCt, lots: qty, atr: entAtr,
                  maeAtr: mae / entAtr, maeUsd: mae * PV * qty });
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
          notional = (pos === 1 ? armPx + SLIP : armPx - SLIP) * qty;
          entCt = CT[i]; entAtr = armAtr; entBar = i; armDir = 0;
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
const pctl = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const et = (ct) => String(Math.floor((ct + 60) / 60)).padStart(2, "0") + ":" +
                   String((ct + 60) % 60).padStart(2, "0");
const bucket = (ct) => Math.floor((ct - 510) / 30);
const label = (b) => et(510 + b * 30) + "-" + et(510 + b * 30 + 30);

console.log("\n" + "=".repeat(116));
console.log("DOES VOLATILITY RISE INTO THE CLOSE, AND WOULD 12 LOTS OVER-LEVER IT?");
console.log("=".repeat(116));

// ---- (1)+(2) level, and forecast quality --------------------------------
console.log("\n-- (1) volatility level vs ATR FORECAST QUALITY, over all signal bars --");
console.log("   realised = high-low range over the NEXT 30 minutes. ratio = realised / ATR at that bar.");
console.log("   A flat ratio means ATR is an honest forecast. A rising ratio means ATR under-forecasts");
console.log("   and every ATR-scaled decision made there is sized off a stale number.\n");
console.log("  window          bars   ATR now   realised 30m   ratio   90th pct ratio   99th pct");
const SB = new Map();
for (let i = 30; i < nB - 15; i++) {
  if (CT[i] < 510 || CT[i] >= NOENTRY) continue;
  if (sig[i] === 0) continue;
  let hi = -Infinity, lo = Infinity, ok = true;
  for (let j = i; j <= i + 15; j++) {
    if (j >= nB || TD[j] !== TD[i] || CT[j] >= FLAT) { ok = false; break; }
    if (H[j] > hi) hi = H[j]; if (L[j] < lo) lo = L[j];
  }
  if (!ok || !(A[i] > 0)) continue;
  const b = bucket(CT[i]);
  if (!SB.has(b)) SB.set(b, []);
  SB.get(b).push({ atr: A[i], real: hi - lo, ratio: (hi - lo) / A[i] });
}
for (const b of [...SB.keys()].sort((x, y) => x - y)) {
  const g = SB.get(b);
  const r = g.map(v => v.ratio);
  console.log("  " + label(b).padEnd(14) + String(g.length).padStart(6) +
    mean(g.map(v => v.atr)).toFixed(1).padStart(10) + mean(g.map(v => v.real)).toFixed(1).padStart(15) +
    mean(r).toFixed(2).padStart(8) + pctl(r, 0.9).toFixed(2).padStart(17) + pctl(r, 0.99).toFixed(2).padStart(11));
}

// ---- (3)+(4) what actually happened to real trades ----------------------
console.log("\n-- (2) actual trades: adverse excursion in ATR units, and what it costs at 8 vs 12 lots --");
console.log("  window          n   mean MAE   90th   99th   worst   liq% @8   liq% @12   worst $ @12");
const t8 = run(() => 8), t12 = run(() => 12);
const by = (t) => { const m = new Map(); for (const x of t) { const b = bucket(x.entCt);
  if (!m.has(b)) m.set(b, []); m.get(b).push(x); } return m; };
const m8 = by(t8), m12 = by(t12);
for (const b of [...m8.keys()].sort((x, y) => x - y)) {
  const g8 = m8.get(b), g12 = m12.get(b) || [];
  if (g8.length < 20) continue;
  const mae = g8.map(x => x.maeAtr);
  const liq8 = 100 * g8.filter(x => x.why === "SLcap").length / g8.length;
  const liq12 = g12.length ? 100 * g12.filter(x => x.why === "SLcap").length / g12.length : NaN;
  const worst12 = g12.length ? Math.min(...g12.map(x => x.pnl)) : NaN;
  console.log("  " + label(b).padEnd(14) + String(g8.length).padStart(5) +
    mean(mae).toFixed(2).padStart(11) + pctl(mae, 0.9).toFixed(2).padStart(7) +
    pctl(mae, 0.99).toFixed(2).padStart(7) + Math.max(...mae).toFixed(2).padStart(8) +
    liq8.toFixed(1).padStart(10) + "%" + liq12.toFixed(1).padStart(10) + "%" +
    ("$" + Math.round(worst12)).padStart(14));
}

// ---- (5) sizing variants that carve the last hour back out --------------
const HDR = "  sizing rule                        n   lots   win%     pf   $/trade     net    pass   1stH   2ndH  recent";
function row(lbl, trades) {
  const st = stat(trades);
  const p1 = passOf(inSet(trades, H1), H1), p2 = passOf(inSet(trades, H2), H2);
  console.log("  " + lbl.padEnd(32) + String(st.n).padStart(6) +
    mean(trades.map(t => t.lots)).toFixed(1).padStart(7) + st.win.toFixed(1).padStart(7) +
    st.pf.toFixed(3).padStart(7) + ("$" + st.exp.toFixed(2)).padStart(10) +
    ("$" + Math.round(st.net / 1000) + "k").padStart(8) +
    passOf(trades, days).toFixed(1).padStart(8) + "%" + p1.toFixed(1).padStart(6) + "%" +
    p2.toFixed(1).padStart(6) + "%" + passOf(inSet(trades, RECENT), RECENT).toFixed(1).padStart(7) + "%");
  return { worse: Math.min(p1, p2), all: passOf(trades, days) };
}
console.log("\n-- (3) does carving the last hour back out help? (mid = 11:30 to the cut, then late) --");
console.log(HDR);
row("flat 8 (ships)", t8);
row("blanket 12 after 11:30", run((a, ct) => ct < 630 ? 8 : 12));
for (const lateFrom of [810, 840, 870])          // 14:00, 14:30, 15:00 ET
  for (const lateLots of [4, 6, 8, 10])
    row("8 / 12 / " + lateLots + " from " + et(lateFrom),
        run((a, ct) => ct < 630 ? 8 : (ct >= lateFrom ? lateLots : 12)));

console.log("\n-- (4) and the same idea driven by ATR rather than by the clock --");
console.log(HDR);
row("blanket 12 after 11:30", run((a, ct) => ct < 630 ? 8 : 12));
for (const cutAtr of [12, 14, 16])
  row("12 after 11:30 unless ATR>" + cutAtr,
      run((a, ct) => ct < 630 ? 8 : (a > cutAtr ? 8 : 12)));
