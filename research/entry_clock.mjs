// When does the average WINNER enter, versus the average LOSER?
//
// Clock time of ENTRY (not exit), on the shipped bot at its shipped size.
// Reported in New York time, because that is how the session is thought about;
// the engine works in Chicago minutes, so ET = ctMin + 60.
//
// A gap here is only interesting if it survives a noise check -- with ~2,800
// trades spread over a 6.5 hour session, a few minutes of difference between
// two group means is what randomness looks like. So the difference is
// bootstrapped rather than eyeballed.
//
// Usage:  node research/entry_clock.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750, TOTAL = 8;
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

const trades = [];
let pos = 0, ep = 0, slD = 0, tpD = 0, qty = 0, notional = 0, entCt = 0, entBar = 0;
let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0;
let curTday = -1e9, dayReal = 0, capHit = false;
const avgFill = () => notional / qty;
const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
const close_ = (px, i, exact, why) => {
  const xp = pos === 1 ? px - SLIP : px + SLIP;
  const net = exact !== undefined ? exact
            : (xp - avgFill()) * pos * PV * qty - PERSIDE * 2 * qty;
  trades.push({ tday: TD[i], pnl: net, why, entCt, held: (i - entBar) * 2, dir: pos });
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
        notional = (pos === 1 ? armPx + SLIP : armPx - SLIP) * qty;
        entCt = CT[i]; entBar = i;                      // <- the number this is about
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
    armDir = s2; armBar = i; armBy = i + ADD_WIN; armEp = O[i];
    armPx = O[i] + s2 * Math.max(a * TRIG, TICK);
    armSl = Math.max(a * 5, TICK); armTp = Math.max(a * 1.75, TICK);
  }
}

const et = (ct) => {                                    // Chicago minutes -> NY clock
  const m = ct + 60;
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };

const W = trades.filter(t => t.pnl > 0), L_ = trades.filter(t => t.pnl <= 0);
const wc = W.map(t => t.entCt), lc = L_.map(t => t.entCt);

console.log("\n" + "=".repeat(96));
console.log("ENTRY CLOCK TIME: WINNERS vs LOSERS  |  shipped bot, 8 lots, " + trades.length + " trades");
console.log("=".repeat(96));
console.log("\n                    n      mean entry     median      earliest quartile   latest quartile");
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length * p)]; };
for (const [lbl, a] of [["WINNERS", wc], ["LOSERS ", lc]])
  console.log("  " + lbl + String(a.length).padStart(10) + et(Math.round(mean(a))).padStart(14) +
    et(med(a)).padStart(12) + et(q(a, 0.25)).padStart(19) + et(q(a, 0.75)).padStart(18));
const diff = mean(wc) - mean(lc);
console.log("\n  difference: winners enter " + Math.abs(diff).toFixed(1) + " min " +
            (diff < 0 ? "EARLIER" : "LATER") + " than losers, on average");

// Is that gap anything? Shuffle the win/loss labels and see how big a gap
// appears by chance alone.
let rnd = 12345;
const rand = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd / 4294967296; };
const all = trades.map(t => t.entCt), nW = wc.length;
let bigger = 0; const nulls = [];
for (let it = 0; it < 20000; it++) {
  const s = all.slice();
  for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = s[i]; s[i] = s[j]; s[j] = t; }
  const d = mean(s.slice(0, nW)) - mean(s.slice(nW));
  nulls.push(d);
  if (Math.abs(d) >= Math.abs(diff)) bigger++;
}
nulls.sort((a, b) => a - b);
console.log("  label-shuffle null: a gap this big or bigger appears by chance " +
            (100 * bigger / 20000).toFixed(1) + "% of the time");
console.log("  (95% of random gaps fall inside " + nulls[500].toFixed(1) + " to " +
            nulls[19500].toFixed(1) + " min)");

console.log("\n-- the whole distribution, by half hour of entry --");
console.log("  entry window (ET)     n   share   win%    $/trade        net   avg hold");
const buckets = new Map();
for (const t of trades) {
  const b = Math.floor((t.entCt - 510) / 30);
  if (!buckets.has(b)) buckets.set(b, []);
  buckets.get(b).push(t);
}
for (const b of [...buckets.keys()].sort((a, b2) => a - b2)) {
  const g = buckets.get(b);
  const w = g.filter(t => t.pnl > 0).length;
  const net = g.reduce((a, t) => a + t.pnl, 0);
  console.log("  " + (et(510 + b * 30) + "-" + et(510 + b * 30 + 30)).padEnd(16) +
    String(g.length).padStart(6) + (100 * g.length / trades.length).toFixed(1).padStart(7) + "%" +
    (100 * w / g.length).toFixed(1).padStart(7) + ("$" + (net / g.length).toFixed(2)).padStart(11) +
    ("$" + Math.round(net / 1000) + "k").padStart(11) + (mean(g.map(t => t.held)).toFixed(0) + "m").padStart(10));
}

console.log("\n-- same split, by outcome type --");
console.log("  exit reason      n   mean entry    median     avg hold    $/trade");
const byWhy = new Map();
for (const t of trades) { if (!byWhy.has(t.why)) byWhy.set(t.why, []); byWhy.get(t.why).push(t); }
for (const [why, g] of [...byWhy.entries()].sort((a, b) => b[1].length - a[1].length))
  console.log("  " + why.padEnd(10) + String(g.length).padStart(7) +
    et(Math.round(mean(g.map(t => t.entCt)))).padStart(13) + et(med(g.map(t => t.entCt))).padStart(11) +
    (mean(g.map(t => t.held)).toFixed(0) + "m").padStart(12) +
    ("$" + (g.reduce((a, t) => a + t.pnl, 0) / g.length).toFixed(2)).padStart(11));

console.log("\n-- biggest winners vs biggest losers (top/bottom decile by P&L) --");
const bySize = trades.slice().sort((a, b) => a.pnl - b.pnl);
const k = Math.floor(trades.length / 10);
const worst = bySize.slice(0, k), best = bySize.slice(-k);
for (const [lbl, g] of [["top 10% by P&L   ", best], ["bottom 10% by P&L", worst]])
  console.log("  " + lbl + "  n=" + g.length + "  mean entry " + et(Math.round(mean(g.map(t => t.entCt)))) +
    "  median " + et(med(g.map(t => t.entCt))) + "  avg hold " + mean(g.map(t => t.held)).toFixed(0) +
    "m  $/trade $" + (g.reduce((a, t) => a + t.pnl, 0) / g.length).toFixed(2));
console.log("\n  entry spread: winners sd " + sd(wc).toFixed(0) + " min, losers sd " + sd(lc).toFixed(0) + " min");
