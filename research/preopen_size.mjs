// Does starting before the RTH open help by getting positioned INTO it?
//
// The hypothesis: extended NY (07:00-15:00) scores level with RTH not because
// the 07:00-08:30 trades are good in themselves, but because a trade opened
// before 08:30 is already positioned when volatility expands at the open.
//
// There is a real tension inside that idea, and it is the point of this file.
// The bot holds ONE position. A pre-open trade that is still running at 08:30
// occupies the slot during the single highest-edge hour of the day -- 09:00 CT
// pays $102/trade against $15 for Asia. So being early can only pay if what it
// gains from the expansion beats what it costs in blocked opens.
//
// Measured four ways:
//   1 start-time sweep, re-run since the earlier one predated the zero-day fix
//   2 pre-open trades split by whether they SURVIVED to the open, which is the
//     only way the hypothesis can operate
//   3 how many RTH signals the extended book cannot take because it is already
//     holding, and what those forgone signals were worth in the RTH book
//   4 a decisive variant: allow pre-open ENTRIES but force a flat at 08:29, so
//     the slot is always free at the open. If the hypothesis is right this
//     should be WORSE than plain extended NY; if being early is really a cost,
//     it should be better.
//
// Usage:  node research/preopen.mjs

import { loadBars } from "../src/data.mjs";
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
const ALLDAYS = (() => {
  const m = new Map();
  for (let i = 0; i < n; i++) if (!m.has(tf.tday[i])) m.set(tf.tday[i], tf.ts[i]);
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
})();
const inWin = (ct, a, b) => (b >= a ? ct >= a && ct < b : ct >= a || ct < b);
const OPEN = 510;   // 08:30 CT

// forceFlatAt: an extra hard flatten inside the window (used for variant 4)
function replay(startCt, endCt, { costMult = 1, forceFlatAt = -1, preLots = TOTAL, capNorm = 0 } = {}) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const pv = 2, tick = 0.25;
  const slip = 0.25 * costMult, perSide = 0.75 * costMult;
  const width = (endCt - startCt + 1440) % 1440 || 1440;
  const flatFrom = (endCt + 5) % 1440, flatTo = startCt;
  const noEntryMins = Math.min(10, Math.floor(width / 3));
  const noEntryFrom = (endCt - noEntryMins + 1440) % 1440;
  const out = [];
  let pos = 0, ep = 0, entTime = 0, entCt = 0, slD = 0, tpD = 0, qty = 0, notional = 0;
  let heldOpen = false;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0, armCt = 0, armQty = TOTAL;
  let curTday = -1e9, dayReal = 0, capHit = false;
  let blockedRth = 0;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (rawExit, i, exact) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    out.push({ tday: TD[i], entryTime: entTime, entCt, pnl: net, heldOpen, qty });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; notional = 0; heldOpen = false;
  };
  for (let i = 1; i < n; i++) {
    const s = sigAll[i - 1];
    const flatNow = inWin(CT[i], flatFrom, flatTo);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    // mark a position that is alive at the RTH open
    if (pos !== 0 && CT[i] >= OPEN && entCt < OPEN) heldOpen = true;
    if (pos === 0 && armDir !== 0) {
      if (flatNow || i > armBy || blocked()) armDir = 0;
      else if (i > armBar && (armDir === 1 ? H[i] >= armPx : L[i] <= armPx)) {
        pos = armDir; qty = armQty;
        ep = armEp; slD = armSl; tpD = armTp; entTime = TS[i]; entCt = armCt;
        notional = (pos === 1 ? armPx + slip : armPx - slip) * qty;
        armDir = 0; heldOpen = false;
      }
    }
    if (pos !== 0) {
      if (flatNow) { close_(O[i], i); continue; }
      if (forceFlatAt >= 0 && CT[i] >= forceFlatAt && entCt < forceFlatAt) {
        close_(O[i], i); continue;
      }
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
      if (pos !== 0) {
        // an RTH signal arriving while the slot is occupied is forgone
        if (s !== 0 && CT[i] >= OPEN && inWin(CT[i], startCt, endCt)) blockedRth++;
        continue;
      }
    }
    if (pos === 0 && s !== 0 && !flatNow && !blocked()) {
      if (inWin(CT[i], noEntryFrom, flatTo)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      armDir = s; armBar = i; armBy = i + ADD_WIN; armEp = O[i]; armCt = CT[i];
      // size the PRE-OPEN tranche larger: at ATR 7.9 a 5xATR stop is ~40 points,
      // well inside the 62.5 the $1000 cap allows at 8 lots, so the risk budget
      // is only ~$632 and the rest is idle. capNorm spends all of it.
      if (CT[i] < OPEN) {
        armQty = capNorm > 0
          ? Math.max(1, Math.min(capNorm, Math.round(CAP / (Math.max(a * 5, tick) * pv))))
          : preLots;
      } else armQty = TOTAL;
      armPx = O[i] + s * Math.max(a * TRIG, tick);
      armSl = Math.max(a * 5, tick); armTp = Math.max(a * 1.75, tick);
    }
  }
  return { trades: out, blockedRth };
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
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
const MID = T0 + (T1 - T0) / 2, Y26 = Date.UTC(2026, 0, 1);
const f6 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "-").padStart(7);

console.log("\n1. START-TIME SWEEP, end 15:00, zero-days counted\n");
console.log("   window        trades    pf   $/trade      1x     2x   early    late    2026");
for (const a of [360, 420, 450, 480, 495, 510, 540]) {
  const t1 = replay(a, 900).trades, t2 = replay(a, 900, { costMult: 2 }).trades;
  const s = stat(t1);
  console.log(`   ${hm(a)}-15:00  ${String(s.n).padStart(6)}  ${s.pf.toFixed(3)}  ` +
    `${("$" + s.exp.toFixed(2)).padStart(8)}${f6(passOf(t1, T0, T1))}${f6(passOf(t2, T0, T1))}` +
    `${f6(passOf(t1, T0, MID))}${f6(passOf(t1, MID, T1))}${f6(passOf(t1, Y26, T1))}` +
    (a === 510 ? "  <- ships" : a === 420 ? "  <- extended" : ""));
}

console.log("\n2. INSIDE extended NY — where do its trades come from, and does");
console.log("   surviving to the open actually pay?\n");
{
  const ext = replay(420, 900).trades;
  console.log("   entry bucket        trades   win%     pf   $/trade");
  for (const [lbl, a, b] of [["07:00-07:30", 420, 450], ["07:30-08:00", 450, 480],
                             ["08:00-08:30", 480, 510], ["08:30+ (RTH)", 510, 900]]) {
    const g = ext.filter(t => t.entCt >= a && t.entCt < b);
    if (!g.length) continue;
    const s = stat(g);
    console.log(`   ${lbl.padEnd(18)}${String(s.n).padStart(6)}  ${s.win.toFixed(1).padStart(5)}  ` +
      `${s.pf.toFixed(3)}  ${("$" + s.exp.toFixed(2)).padStart(8)}`);
  }
  const pre = ext.filter(t => t.entCt < OPEN);
  const held = pre.filter(t => t.heldOpen), died = pre.filter(t => !t.heldOpen);
  console.log(`\n   of ${pre.length} pre-open entries, ${held.length} were still open at 08:30 ` +
    `(${(100 * held.length / pre.length).toFixed(0)}%)`);
  const sh = stat(held), sd = stat(died);
  console.log(`     survived to the open : ${sh.n} trades  pf ${sh.pf.toFixed(3)}  ` +
    `$/trade ${("$" + sh.exp.toFixed(2)).padStart(8)}   <- the hypothesis rides on this row`);
  console.log(`     closed before it     : ${sd.n} trades  pf ${sd.pf.toFixed(3)}  ` +
    `$/trade ${("$" + sd.exp.toFixed(2)).padStart(8)}`);
  const rth = stat(ext.filter(t => t.entCt >= OPEN));
  console.log(`     for comparison, RTH  : ${rth.n} trades  pf ${rth.pf.toFixed(3)}  ` +
    `$/trade ${("$" + rth.exp.toFixed(2)).padStart(8)}`);
}

console.log("\n3. THE COST — RTH signals the extended book cannot take\n");
{
  const a = replay(510, 900), b = replay(420, 900);
  const rthA = a.trades.filter(t => t.entCt >= OPEN);
  const rthB = b.trades.filter(t => t.entCt >= OPEN);
  console.log(`   RTH-only book takes ${rthA.length} post-open trades`);
  console.log(`   extended book takes ${rthB.length} post-open trades ` +
    `(${rthA.length - rthB.length} fewer, ${(100 * (rthA.length - rthB.length) / rthA.length).toFixed(0)}% of them)`);
  console.log(`   post-open $/trade: RTH-only ${("$" + stat(rthA).exp.toFixed(2))}, ` +
    `extended ${("$" + stat(rthB).exp.toFixed(2))}`);
}

console.log("\n4. DECISIVE — pre-open entries allowed, but forced flat at 08:29 so the");
console.log("   slot is always free at the open. If being positioned INTO the open is");
console.log("   the mechanism, this must be WORSE than plain extended NY.\n");
console.log("   variant                              trades    pf   $/trade      1x     2x");
for (const [lbl, a, b, ff] of [
  ["RTH only 08:30-15:00", 510, 900, -1],
  ["extended 07:00-15:00", 420, 900, -1],
  ["extended, flat at 08:29", 420, 900, 509],
]) {
  const t1 = replay(a, b, { forceFlatAt: ff }).trades;
  const t2 = replay(a, b, { costMult: 2, forceFlatAt: ff }).trades;
  const s = stat(t1);
  console.log(`   ${lbl.padEnd(34)}${String(s.n).padStart(6)}  ${s.pf.toFixed(3)}  ` +
    `${("$" + s.exp.toFixed(2)).padStart(8)}${f6(passOf(t1, T0, T1))}${f6(passOf(t2, T0, T1))}`);
}const f6b=(v)=>(Number.isFinite(v)?v.toFixed(1):"-").padStart(7);
console.log("\nPRE-OPEN SIZING - extended 07:00-15:00, flat 08:15, RTH always 8 lots\n");
console.log("   pre-open lots   trades  preAvgQty  win%     pf   $/trade      1x     2x   early    late    2026");
const VAR=[["8 (flat)",8,0],["10",10,0],["12",12,0],["14",14,0],["16",16,0],["20",20,0],
  ["cap-normalised <=20",0,20],["cap-normalised <=40",0,40]];
for(const [lbl,pl,cn] of VAR){
  const t1=replay(420,900,{forceFlatAt:495,preLots:pl||TOTAL,capNorm:cn}).trades;
  const t2=replay(420,900,{costMult:2,forceFlatAt:495,preLots:pl||TOTAL,capNorm:cn}).trades;
  const st1=stat(t1);
  const pre=t1.filter(t=>t.entCt<OPEN);
  const aq=pre.length?pre.reduce((a,b)=>a+b.qty,0)/pre.length:0;
  console.log("   "+lbl.padEnd(15)+String(st1.n).padStart(6)+aq.toFixed(1).padStart(11)+
    st1.win.toFixed(1).padStart(6)+"  "+st1.pf.toFixed(3)+"  "+("$"+st1.exp.toFixed(2)).padStart(8)+
    f6b(passOf(t1,T0,T1))+f6b(passOf(t2,T0,T1))+f6b(passOf(t1,T0,MID))+f6b(passOf(t1,MID,T1))+
    f6b(passOf(t1,Y26,T1)));
}
console.log("\n   PRE-OPEN TRADES ONLY, by size - is the extra size actually earning?\n");
console.log("   pre-open lots   n     win%     pf   $/trade      net");
for(const [lbl,pl,cn] of VAR){
  const t1=replay(420,900,{forceFlatAt:495,preLots:pl||TOTAL,capNorm:cn}).trades.filter(t=>t.entCt<OPEN);
  const st1=stat(t1);
  console.log("   "+lbl.padEnd(15)+String(st1.n).padStart(5)+st1.win.toFixed(1).padStart(8)+"  "+
    st1.pf.toFixed(3)+"  "+("$"+st1.exp.toFixed(2)).padStart(8)+("$"+(st1.net/1000).toFixed(0)+"k").padStart(9));
}
