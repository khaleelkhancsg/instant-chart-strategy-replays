// NOTE ON METHOD (a bug this file originally had):
// dayMap once keyed only days that PRODUCED A TRADE, and the bootstrap then drew
// 21 of those. A window trading on 84% of days therefore got a ~25 calendar-day
// evaluation while one trading on 42% of days got ~50 -- twice the real horizon,
// which flattered every sparse window enormously. 08:30-09:30 read 62.7% under
// that bug and reads 28.9% once days with no trade are counted as ZERO days.
// dayMap now enumerates every trading day in the range first. Any session result
// predating that fix is wrong in the direction of favouring short windows.
// Which trading window does this book actually work in?
//
// The bot trades 08:30-15:00 CT and nothing else, and that window was inherited
// rather than chosen. The dataset is full 24-hour Globex (every hour carries
// ~4.4% of bars except the 16:00 CT break), so the question is answerable.
//
// METHOD. Each window is a SELF-CONTAINED BOOK: entries only inside it, and the
// flatten moved to its end so the bot is flat outside. Without moving the
// flatten, an Asia trade would be carried to 15:04 CT the next afternoon, which
// is a different strategy rather than a different session.
//
// Three things a first pass at this got wrong, fixed here:
//
//   HOURLY EDGE cannot be read off a 24-hour book by bucketing entries by hour.
//   The bot can only enter when FLAT, so entry times reflect when the previous
//   trade happened to finish, not where the edge is -- it over-samples whichever
//   hour follows a session gap. Each hour is therefore run as its own
//   self-contained book, one hour wide, so every hour gets the same chance.
//
//   TRADES PER DAY must divide by CALENDAR trading days, not by days that
//   happened to produce a trade, or a sparse session looks as busy as a dense one.
//
//   VOLATILITY CONTEXT matters more than anything else here. Pass rate tracks ATR
//   almost monotonically in this book (2019 at ATR 4.8 scores 10%, 2024-26 at
//   17.3 scores 52%). A session that is simply quieter will score worse for that
//   reason alone, so median session ATR is reported alongside and no session is
//   judged without it.
//
// COSTS are the honest difficulty. One tick of slippage is fair for RTH MNQ and
// optimistic overnight, where the book is thinner and the spread is often two
// ticks. Every window is reported at 1x and 2x; a window that only works at 1x
// has not worked.
//
// Usage:  node research/sessions.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 12000, BLOCK = 5, WIN = 21, TOTAL = 8;
const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750, ADD_WIN = 10, TRIG = 0.15;
const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const n = tf.close.length;
const raw = new Int8Array(n);
for (let i = 30; i < n; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sigAll = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 0, endCt: 1440, effMin: 0.5 });
const CAL_DAYS = new Set(Array.from({ length: n }, (_, i) => tf.tday[i])).size;
// Every trading day in the dataset, so a window that only trades on 40% of days
// does not get a 50-calendar-day evaluation while the shipped window gets 25.
// Days with no trade must count as a ZERO day, not be skipped.
const ALLDAYS = (() => {
  const m = new Map();
  for (let i = 0; i < n; i++) if (!m.has(tf.tday[i])) m.set(tf.tday[i], tf.ts[i]);
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
})();
const inWin = (ct, a, b) => (b >= a ? ct >= a && ct < b : ct >= a || ct < b);

function replay(startCt, endCt, costMult = 1) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const pv = 2, tick = 0.25;
  const slip = 0.25 * costMult, perSide = 0.75 * costMult;
  const width = (endCt - startCt + 1440) % 1440 || 1440;
  const flatFrom = (endCt + 5) % 1440, flatTo = startCt;
  // stand aside near the close, but never more than a third of a short window
  const noEntryMins = Math.min(10, Math.floor(width / 3));
  const noEntryFrom = (endCt - noEntryMins + 1440) % 1440;
  const out = [];
  let pos = 0, ep = 0, entTime = 0, entCt = 0, slD = 0, tpD = 0, qty = 0, notional = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0, armCt = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (rawExit, i, exact) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    out.push({ tday: TD[i], entryTime: entTime, entCt, pnl: net });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; notional = 0;
  };
  for (let i = 1; i < n; i++) {
    const s = sigAll[i - 1];
    const flatNow = inWin(CT[i], flatFrom, flatTo);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    if (pos === 0 && armDir !== 0) {
      if (flatNow || i > armBy || blocked()) armDir = 0;
      else if (i > armBar && (armDir === 1 ? H[i] >= armPx : L[i] <= armPx)) {
        pos = armDir; qty = TOTAL;
        ep = armEp; slD = armSl; tpD = armTp; entTime = TS[i]; entCt = armCt;
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
      if (s !== 0 && s !== pos) close_(O[i], i);
      if (pos !== 0) continue;
    }
    if (pos === 0 && s !== 0 && !flatNow && !blocked()) {
      if (inWin(CT[i], noEntryFrom, flatTo)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      armDir = s; armBar = i; armBy = i + ADD_WIN; armEp = O[i]; armCt = CT[i];
      armPx = O[i] + s * Math.max(a * TRIG, tick);
      armSl = Math.max(a * 5, tick); armTp = Math.max(a * 1.75, tick);
    }
  }
  return out;
}
function dayMap(fills, lo, hi) {
  const m = new Map();
  for (const [td, ts0] of ALLDAYS) if (ts0 >= lo && ts0 < hi) m.set(td, 0);
  for (const f of fills) {
    if (f.entryTime < lo || f.entryTime >= hi) continue;
    m.set(f.tday, (m.get(f.tday) ?? 0) + f.pnl);
  }
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
  if (keys.length < 40) return NaN;
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
// median ATR inside a window, so a quiet session is not mistaken for a bad one
function medATR(a, b) {
  const v = [];
  for (let i = 0; i < n; i++) if (inWin(tf.ctMin[i], a, b) && A[i] > 0) v.push(A[i]);
  v.sort((x, y) => x - y);
  return v.length ? v[v.length >> 1] : NaN;
}
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
const MID = T0 + (T1 - T0) / 2, Y26 = Date.UTC(2026, 0, 1);

const T0b = T0, T1b = T1;
// MID, Y26 already declared above
const HALF = 182 * 86400000;

// The session table says NY-first-90-minutes beats the shipped full RTH. That is
// a full-sample pick from a menu of windows -- exactly the shape that has been
// wrong every previous time. Two tests decide it: is the surface a plateau or a
// knife-edge, and does the choice survive being made on the past only.
console.log("\n1. END-TIME SWEEP, start fixed at 08:30 - plateau or knife-edge?\n");
console.log("   window        trades  tr/day    pf   $/trade      1x     2x   early    late    2026");
const ENDS = [570, 600, 630, 660, 690, 720, 780, 840, 900];
const EB = new Map();
for (const e of ENDS) {
  const t1 = replay(510, e, 1), t2 = replay(510, e, 2);
  EB.set(e, t1);
  const s2 = stat(t1);
  const f = (v) => (Number.isFinite(v) ? v.toFixed(1) : "-").padStart(7);
  console.log("   08:30-" + hm(e) + "  " + String(s2.n).padStart(6) + "  " +
    (s2.n / CAL_DAYS).toFixed(2).padStart(6) + "  " + s2.pf.toFixed(3) + "  " +
    ("$" + s2.exp.toFixed(2)).padStart(8) + f(passOf(t1, T0b, T1b)) + f(passOf(t2, T0b, T1b)) +
    f(passOf(t1, T0b, MID)) + f(passOf(t1, MID, T1b)) + f(passOf(t1, Y26, T1b)) +
    (e === 900 ? "  <- ships" : ""));
}
{
  let ss = 0;
  for (let i = 1; i < ENDS.length; i++)
    ss += Math.abs(passOf(EB.get(ENDS[i]), T0b, T1b) - passOf(EB.get(ENDS[i - 1]), T0b, T1b));
  console.log("\n   mean |step| between adjacent end times: +-" + (ss / (ENDS.length - 1)).toFixed(2) + "pp");
}

console.log("\n2. START-TIME SWEEP, end fixed at 15:00\n");
console.log("   window        trades    pf   $/trade      1x     2x   early    late    2026");
for (const a of [420, 450, 480, 510, 540, 570, 600]) {
  const t1 = replay(a, 900, 1), t2 = replay(a, 900, 2);
  const s2 = stat(t1);
  const f = (v) => (Number.isFinite(v) ? v.toFixed(1) : "-").padStart(7);
  console.log("   " + hm(a) + "-15:00  " + String(s2.n).padStart(6) + "  " + s2.pf.toFixed(3) + "  " +
    ("$" + s2.exp.toFixed(2)).padStart(8) + f(passOf(t1, T0b, T1b)) + f(passOf(t2, T0b, T1b)) +
    f(passOf(t1, T0b, MID)) + f(passOf(t1, MID, T1b)) + f(passOf(t1, Y26, T1b)) +
    (a === 510 ? "  <- ships" : ""));
}

console.log("\n3. WALK-FORWARD on the WINDOW - chosen on the past only, by pass rate\n");
console.log("   test period              chosen     ships $/t   chosen $/t     delta");
const GRID = [[510, 600], [510, 660], [510, 720], [510, 780], [510, 900], [480, 660], [420, 900]];
const GB = GRID.map(([a, b]) => replay(a, b, 1));
const SHIP = 4;
const wfT = [], shT = [], picks = [];
for (let cut = T0b + 730 * 86400000; cut + HALF <= T1b; cut += HALF) {
  let bi = SHIP, best = -Infinity;
  GB.forEach((bk, i) => {
    const tr = bk.filter(t => t.entryTime < cut);
    if (tr.length < 150) return;
    const sc = passOf(bk, T0b, cut, 777);
    if (Number.isFinite(sc) && sc > best) { best = sc; bi = i; }
  });
  const lo = cut, hi = Math.min(cut + HALF, T1b);
  const te = GB[bi].filter(t => t.entryTime >= lo && t.entryTime < hi);
  const t0 = GB[SHIP].filter(t => t.entryTime >= lo && t.entryTime < hi);
  if (te.length < 20 || t0.length < 20) continue;
  const nm = hm(GRID[bi][0]) + "-" + hm(GRID[bi][1]);
  picks.push(nm); wfT.push(...te); shT.push(...t0);
  const a2 = stat(te), b2 = stat(t0);
  console.log("   " + new Date(lo).toISOString().slice(0, 10) + ".." +
    new Date(hi).toISOString().slice(0, 10) + nm.padStart(13) + "  " +
    ("$" + b2.exp.toFixed(2)).padStart(11) + "  " + ("$" + a2.exp.toFixed(2)).padStart(11) + "  " +
    ((a2.exp - b2.exp >= 0 ? "+" : "") + "$" + (a2.exp - b2.exp).toFixed(2)).padStart(10));
}
{
  const w = stat(wfT), sp = stat(shT), lo2 = T0b + 730 * 86400000;
  const nShip = picks.filter(p => p === "08:30-15:00").length;
  console.log("\n   shipped window chosen " + nShip + "/" + picks.length);
  console.log("   walk-forward   " + w.n + " trades  pf " + w.pf.toFixed(3) +
    "  $/t $" + w.exp.toFixed(2) + "  PASS " + passOf(wfT, lo2, T1b).toFixed(1) + "%");
  console.log("   always shipped " + sp.n + " trades  pf " + sp.pf.toFixed(3) +
    "  $/t $" + sp.exp.toFixed(2) + "  PASS " + passOf(shT, lo2, T1b).toFixed(1) + "%");
}
// The walk-forward pooled trades from DIFFERENT windows across periods, which is
// not any single tradeable strategy. The cleaner question: on the same
// out-of-sample span, how does each FIXED window do?
const OOS = T0b + 730 * 86400000;
console.log("\nFIXED WINDOWS on the walk-forward OOS span only (2021-05 onward)\n");
console.log("   window        trades  tr/day    pf   $/trade     pass    2x");
for (const [a,b] of [[510,570],[510,600],[510,660],[510,720],[510,780],[510,900],[420,900]]) {
  const t1 = replay(a,b,1).filter(t=>t.entryTime>=OOS);
  const t2 = replay(a,b,2).filter(t=>t.entryTime>=OOS);
  const st = stat(t1);
  const days = new Set(t1.map(x=>x.tday)).size;
  console.log("   "+hm(a)+"-"+hm(b)+"  "+String(st.n).padStart(6)+"  "+
    (st.n/days).toFixed(2).padStart(6)+"  "+st.pf.toFixed(3)+"  "+
    ("$"+st.exp.toFixed(2)).padStart(8)+"  "+passOf(t1,OOS,T1b).toFixed(1).padStart(7)+
    "  "+passOf(t2,OOS,T1b).toFixed(1).padStart(5)+((a===510&&b===900)?"  <- ships":""));
}
