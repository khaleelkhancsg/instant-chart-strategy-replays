// !! REJECTED — see research/early_walkforward.mjs and early_regime.mjs !!
//
// Early arming (k > 0) does NOT survive out-of-sample selection. Every positive
// result in this file evaluates a FIXED k chosen with full-sample knowledge, and
// no amount of significance testing on an already-selected parameter can detect
// that. Two tests that CAN, both fail it:
//
//   WALK-FORWARD  choosing k on the past only and scoring on the next six
//   months gives -$2.19/trade against k=0 when k is picked on training
//   expectancy, and +$6.76 when picked on training pass rate. The sign flips
//   with the selection rule, per-period deltas swing +-$55, and the procedure
//   picks k=0.80 -- not the 0.40 that was going to be recommended.
//
//   REGIME  the entire gain sits in ONE ATR quintile (11.7-16.3 pts) at every
//   value of k: 103% of the total at k=0.40, 91% at 0.60, 110% at 0.80. The
//   other four quintiles net to zero or negative, and quintile 4 is negative.
//   Confirmation has no reason to work only in that band.
//
// The MES "replication" does not rescue it: MES and MNQ are ~95% correlated
// index futures over the same calendar span, so a gain driven by a shared
// volatility regime replicates without being real.
//
// The bot as it was at the start of this session, against the bot as it stands.
//
// "The original bot" is ambiguous and the difference matters, so both readings
// are reported:
//
//   as DOCUMENTED   2 lots at the signal, 6 added one bar later on confirmation.
//                   This is what bot/README.md claimed and what every quoted
//                   number was based on.
//   as it would have TRADED   the same config, but the add order was rested the
//                   moment the first tranche filled, so it could trigger inside
//                   the ENTRY bar. A 2-minute bar's range is about one ATR, so a
//                   0.15xATR trigger is touched inside that bar for 81% of
//                   signals -- meaning the live bot would have added to almost
//                   everything, including the breakouts that spiked and died.
//
// The second is the honest baseline: it is what would actually have happened had
// the bot been armed before any of this session's work.
//
// Everything is measured with the full rule set -- $3,000 target, $2,000 trailing
// drawdown, 50% consistency, -$1,000 exact-mode cap, +$750 profit block, -$500
// circuit breaker -- with the daily blocks applied INSIDE the replay so they gate
// entries causally, 1 tick slippage per leg per tranche and $0.75/side.
//
// Usage:  node research/before_after.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules, sweepWindows } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const K_PAD_DEFAULT = 0;
const DRAWS = 20000, BLOCK = 5, WIN = 21, TOTAL = 8;
const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750, ADD_WIN = 10, TRIG = 0.15;
const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const S = (await loadStrategies()).get("donchian_eff_rth");
const X = resolveExec(S.execDefaults);
const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const n = tf.close.length;
const raw = new Int8Array(n);
for (let i = 30; i < n; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
function sigOf(k) {
  const r = new Int8Array(n);
  for (let i = 30; i < n; i++) {
    if (ax[i] < 25) continue;
    const pad = k * (A[i] > 0 ? A[i] : 0);
    if (tf.close[i] > dh[i] - pad) r[i] = 1;
    else if (tf.close[i] < dl[i] + pad) r[i] = -1;
  }
  return applyFilters(r, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
}
const sig = sigOf(0);

// first: lots at market on the signal (0 = stop entry, the whole size rests)
// sameBar: may the resting order trigger inside the bar it was created on?
function replay(first, sameBar, sig = sigOf(0)) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const out = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, entBar = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0;
  let curTday = -1e9, dayReal = 0, capHit = false, nEntries = 0;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (rawExit, i, exact) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    out.push({ tday: TD[i], entryTime: entTime, exitTime: TS[i], pnl: net, qty });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; pendQty = 0; addBy = -1; notional = 0;
  };
  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }

    if (pos === 0 && armDir !== 0) {
      if (flatNow || i > armBy || blocked()) armDir = 0;
      else if (armDir === 1 ? H[i] >= armPx : L[i] <= armPx) {
        pos = armDir; qty = TOTAL; pendQty = 0; addBy = -1;
        ep = armEp; slD = armSl; tpD = armTp; entBar = i; entTime = TS[i];
        notional = (pos === 1 ? armPx + slip : armPx - slip) * qty;
        armDir = 0; nEntries++;
      }
    }
    if (pos !== 0) {
      if (pendQty > 0 && i > entBar && i <= addBy &&
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
    if (pos === 0 && s !== 0 && !flatNow && !blocked()) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      const slD2 = Math.max(a * 5, tick), tpD2 = Math.max(a * 1.75, tick);
      const px = O[i] + s * Math.max(a * TRIG, tick);
      if (first === 0) {
        armDir = s; armPx = px; armBar = i; armBy = i + ADD_WIN;
        armEp = O[i]; armSl = slD2; armTp = tpD2;
      } else {
        ep = O[i]; entTime = TS[i]; pos = s; entBar = i; nEntries++;
        slD = slD2; tpD = tpD2;
        qty = first; pendQty = TOTAL - first;
        addPx = px; addBy = i + ADD_WIN;
        notional = (pos === 1 ? ep + slip : ep - slip) * qty;
        // The defect the audit found: the live bot rested this order the moment
        // the first tranche filled, so the REST of this bar could trigger it.
        if (sameBar && pendQty > 0 && (s === 1 ? H[i] >= addPx : L[i] <= addPx)) {
          notional += (s === 1 ? addPx + slip : addPx - slip) * pendQty;
          qty += pendQty; pendQty = 0;
        }
      }
    }
  }
  return { trades: out, nEntries };
}

// Parity guard: 2+6 next-bar must reproduce the engine, with the daily blocks
// applied the same way, or none of the comparison below means anything.
{
  const eng = runBrackets(tf, sig, A, resolveExec({ ...S.execDefaults,
    contracts: TOTAL, slAtrMult: 5, tpAtrMult: 1.75, dayLossStopUsd: CAP,
    dayLossStopMode: "exact", slippageTicks: 1, scaleInFrac: 2 / TOTAL,
    scaleInTrigger: TRIG, scaleInWindowBars: ADD_WIN })).trades;
  let acc = 0, day = null; const kept = [];
  for (const t of eng) {
    if (t.tday !== day) { day = t.tday; acc = 0; }
    if (acc >= PROFIT_BLOCK || acc <= -BREAKER) continue;
    acc += t.pnl; kept.push(t);
  }
  const mine = replay(2, false).trades;
  const a = kept.reduce((s, t) => s + t.pnl, 0), b = mine.reduce((s, t) => s + t.pnl, 0);
  const d = 100 * Math.abs(a - b) / Math.abs(a);
  console.log(`\nparity vs engine (2+6 next-bar): ${kept.length} vs ${mine.length} trades, ` +
              `$${a.toFixed(0)} vs $${b.toFixed(0)} — ${d.toFixed(2)}% apart` +
              (d < 1.5 ? "  OK\n" : "  !! DO NOT TRUST THE TABLE BELOW\n"));
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
function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function pairedPass(maps, keys, seed) {
  const rnd = mul(seed), N = keys.length, idx = new Array(WIN);
  const wins = maps.map(() => 0);
  const arrs = maps.map(m => keys.map(k => m.get(k) ?? 0));
  const buf = new Array(WIN);
  for (let d = 0; d < DRAWS; d++) {
    let m = 0;
    while (m < WIN) { const st = Math.floor(rnd() * Math.max(1, N - BLOCK));
      for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = (st + j) % N; }
    for (let b = 0; b < maps.length; b++) {
      for (let k = 0; k < WIN; k++) buf[k] = arrs[b][idx[k]];
      wins[b] += ev(buf);
    }
  }
  return wins.map(w => (100 * w) / DRAWS);
}
const noRules = resolveRules({ circuitBreaker: 0, dailyProfitStop: 0, dailyLossLimit: 0 });

const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
const MID = T0 + (T1 - T0) / 2, Y12 = T1 - 365 * 86400000, Y26 = Date.UTC(2026, 0, 1);
const SLICES = [["early half", T0, MID], ["late half", MID, T1],
                ["last 12m", Y12, T1], ["2026", Y26, T1], ["ALL", T0, T1]];

const CFG = [
  ["1. ORIGINAL, as it would have traded", 2, true, 0],
  ["2. ORIGINAL, as it was documented", 2, false, 0],
  ["3. SHIPPED NOW: 0+8 stop entry", 0, false, 0],
  ["4. + early detect k=0.40", 0, false, 0.40],
  ["5. + early detect k=0.60", 0, false, 0.60],
  ["reference: 8 at market, no confirm", TOTAL, false, 0],
];
const books = CFG.map(([, f, sb, k]) => replay(f, sb, sigOf(k)));
const cols = SLICES.map(([, lo, hi]) => {
  const maps = books.map(b => dayMap(b.trades, lo, hi));
  const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  return pairedPass(maps, keys, 4242);
});

console.log("PASS RATE — block bootstrap, paired draws (same resampled days per column)\n");
let hdr = "  configuration                         trades";
for (const [nm] of SLICES) hdr += nm.padStart(13);
console.log(hdr);
console.log("  " + "-".repeat(hdr.length + 2));
CFG.forEach(([lbl], i) => {
  let row = "  " + lbl.padEnd(37) + String(books[i].trades.length).padStart(6);
  cols.forEach(c => row += (c[i].toFixed(1) + "%").padStart(13));
  console.log(row);
});
console.log("\n  vs ORIGINAL as it would have traded (row 1):\n");
CFG.forEach(([lbl], i) => {
  if (i === 0) return;
  let row = "  " + lbl.padEnd(37) + "      ";
  cols.forEach(c => {
    const d = c[i] - c[0];
    row += ((d >= 0 ? "+" : "") + d.toFixed(1)).padStart(13);
  });
  console.log(row);
});

console.log("\n\nP&L — all history\n");
console.log("  configuration                         trades   win%     pf    $/trade      net");
CFG.forEach(([lbl], i) => {
  const t = books[i].trades;
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const x of t) { tot += x.pnl; if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; }
  console.log(`  ${lbl.padEnd(37)}${String(t.length).padStart(6)}  ` +
    `${((100 * w / t.length).toFixed(1) + "%").padStart(5)}  ${(gw / gl).toFixed(3)}  ` +
    `${("$" + (tot / t.length).toFixed(2)).padStart(9)}  ${("$" + (tot / 1000).toFixed(0) + "k").padStart(7)}`);
});

// Second, independent estimator: every real calendar window, 1-day step.
console.log("\n\nCALENDAR SWEEP — every real 30-day window, independent of the bootstrap\n");
console.log("  configuration                      pass rate   windows");
CFG.forEach(([lbl], i) => {
  const sw = sweepWindows(books[i].trades, T0, T1, noRules, 1);
  console.log(`  ${lbl.padEnd(37)}${(sw.summary.passRate.toFixed(2) + "%").padStart(10)}   ` +
    `${sw.summary.n}`);
});
