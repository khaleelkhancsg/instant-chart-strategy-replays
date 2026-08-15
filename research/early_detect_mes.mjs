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
// Is early detection an edge, or is it the bull market?
//
// early_detect.mjs found that arming k x ATR before the Donchian break beats the
// shipped k=0 on every slice, and that the effect keeps improving out to k=0.60
// and never properly turns over -- at k=3.00 the channel condition is inert and
// the book is STILL better. That shape is what an artifact looks like.
//
// The confound is directional. Widening the pad skews the book long, 1.16:1 at
// k=0 rising to 1.37:1 at k=0.60, and MNQ rose 168% across this dataset. A long
// tilt alone would show up as an edge. So the question is not whether the book
// improved but WHERE: a real confirmation effect has to appear in the SHORTS as
// well, whereas beta lives entirely in the longs.
//
// Usage:  node research/early_detect3.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 20000, BLOCK = 5, WIN = 21, TOTAL = 8;
const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750, ADD_WIN = 10, TRIG = 0.15;
const { bars } = loadBars("data/mes_1m.bin");
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const S = (await loadStrategies()).get("donchian_eff_rth");
const X = resolveExec(S.execDefaults);
const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const n = tf.close.length;

function buildSig(kLong, kShort = kLong) {
  const raw = new Int8Array(n);
  for (let i = 30; i < n; i++) {
    if (ax[i] < 25) continue;
    const av = A[i] > 0 ? A[i] : 0;
    if (tf.close[i] > dh[i] - kLong * av) raw[i] = 1;
    else if (tf.close[i] < dl[i] + kShort * av) raw[i] = -1;
  }
  return applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
}

function replay(sig) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const pv = 5, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const out = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, qty = 0, notional = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (rawExit, i, exact) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    out.push({ tday: TD[i], entryTime: entTime, pnl: net, dir: pos });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; notional = 0;
  };
  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    if (pos === 0 && armDir !== 0) {
      if (flatNow || i > armBy || blocked()) armDir = 0;
      else if (i > armBar && (armDir === 1 ? H[i] >= armPx : L[i] <= armPx)) {
        pos = armDir; qty = TOTAL;
        ep = armEp; slD = armSl; tpD = armTp; entTime = TS[i];
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
      if (X.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], i);
      if (pos !== 0) continue;
    }
    if (pos === 0 && s !== 0 && !flatNow && !blocked()) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      armDir = s; armBar = i; armBy = i + ADD_WIN; armEp = O[i];
      armPx = O[i] + s * Math.max(a * TRIG, tick);
      armSl = Math.max(a * 5, tick); armTp = Math.max(a * 1.75, tick);
    }
  }
  return out;
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
function pairedDelta(a, b, keys, seed) {
  const rnd = mul(seed), N = keys.length, idx = new Array(WIN);
  const A2 = keys.map(k => a.get(k) ?? 0), B2 = keys.map(k => b.get(k) ?? 0);
  const bA = new Array(WIN), bB = new Array(WIN), ds = [];
  const CH = 40, per = Math.floor(DRAWS / CH);
  for (let c = 0; c < CH; c++) {
    let wa = 0, wb = 0;
    for (let x = 0; x < per; x++) {
      let m = 0;
      while (m < WIN) { const st = Math.floor(rnd() * Math.max(1, N - BLOCK));
        for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = (st + j) % N; }
      for (let k = 0; k < WIN; k++) { bA[k] = A2[idx[k]]; bB[k] = B2[idx[k]]; }
      wa += ev(bA); wb += ev(bB);
    }
    ds.push((100 * (wa - wb)) / per);
  }
  ds.sort((x, y) => x - y);
  return { mean: ds.reduce((s, v) => s + v, 0) / ds.length,
           lo: ds[1], hi: ds[ds.length - 2], pWin: ds.filter(v => v > 0).length / ds.length };
}

const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
const MID = T0 + (T1 - T0) / 2, Y12 = T1 - 365 * 86400000, Y26 = Date.UTC(2026, 0, 1);
const SLICES = [["early", T0, MID], ["late", MID, T1], ["12m", Y12, T1],
                ["2026", Y26, T1], ["ALL", T0, T1]];
// The gain is entirely short-side, so the natural implementation is ASYMMETRIC:
// arm the shorts early and leave the longs at the shipped breakout. Testing it is
// also the sharpest check on the story -- if "downside moves faster, so waiting
// for the full break means chasing" is right, the short-only variant should keep
// most of the gain while touching half as much of the book.
// MES: $5/point instead of MNQ's $2, so the same dollar cap binds at a different
// point distance and 8 lots is not the right size -- but NONE of that matters
// here. The only question is whether k > 0 beats k = 0 on an instrument the
// search never touched. Sizing is left at 8 deliberately: retuning it would
// re-introduce the fitting this test exists to escape.
const KS = [
  ["k=0.00 (ships)", 0.00, 0.00],
  ["both 0.40", 0.40, 0.40],
  ["both 0.60", 0.60, 0.60],
  ["SHORT only 0.40", 0.00, 0.40],
  ["SHORT only 0.60", 0.00, 0.60],
  ["SHORT only 0.80", 0.00, 0.80],
  ["LONG only 0.60", 0.60, 0.00],
];
const books = KS.map(([, kl, ks]) => replay(buildSig(kl, ks)));

const side = (t, d) => t.filter(x => x.dir === d);
const stat = (t) => {
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const x of t) { tot += x.pnl; if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; }
  return { n: t.length, win: 100 * w / t.length, pf: gw / gl, exp: tot / t.length, net: tot };
};

console.log("\nIS IT AN EDGE, OR IS IT THE BULL MARKET?\n");
console.log("  config              side      n    win%      pf    $/trade      net");
KS.forEach(([lbl], i) => {
  for (const [nm, d] of [["long", 1], ["short", -1]]) {
    const s = stat(side(books[i], d));
    console.log(`  ${(nm === "long" ? lbl : "").padEnd(20)}${nm.padEnd(7)}${String(s.n).padStart(5)}  ` +
      `${(s.win.toFixed(1) + "%").padStart(6)}  ${s.pf.toFixed(3)}  ` +
      `${("$" + s.exp.toFixed(2)).padStart(9)}  ${("$" + (s.net / 1000).toFixed(0) + "k").padStart(7)}`);
  }
});

console.log("\n  change vs k=0.00, split by side — a real effect must show in BOTH\n");
console.log("  config      side     d win%     d pf   d $/trade");
[1, 2, 3, 4, 5, 6].forEach(i => {
  for (const [nm, d] of [["long", 1], ["short", -1]]) {
    const a = stat(side(books[i], d)), b = stat(side(books[0], d));
    console.log(`  ${(nm === "long" ? KS[i][0] : "").padEnd(12)}${nm.padEnd(7)}` +
      `${((a.win - b.win >= 0 ? "+" : "") + (a.win - b.win).toFixed(1)).padStart(7)}  ` +
      `${((a.pf - b.pf >= 0 ? "+" : "") + (a.pf - b.pf).toFixed(3)).padStart(8)}  ` +
      `${((a.exp - b.exp >= 0 ? "+" : "") + "$" + (a.exp - b.exp).toFixed(2)).padStart(10)}`);
  }
});

console.log("\n\n  FULL PAIRED CI vs k=0.00\n");
console.log("   config      slice   mean delta      95% band   P(better)");
for (const i of [1, 2]) {
  SLICES.forEach(([nm, lo, hi], j) => {
    const ma = dayMap(books[i], lo, hi), mb = dayMap(books[0], lo, hi);
    const keys = [...new Set([...ma.keys(), ...mb.keys()])].sort((a, b) => a - b);
    const d = pairedDelta(ma, mb, keys, 9100 + j);
    console.log(`   ${(j === 0 ? KS[i][0] : "").padEnd(11)}${nm.padEnd(7)}` +
      `${((d.mean >= 0 ? "+" : "") + d.mean.toFixed(2) + "pp").padStart(11)}   ` +
      `${(d.lo.toFixed(1) + " .. " + d.hi.toFixed(1)).padStart(14)}  ${(100 * d.pWin).toFixed(0).padStart(6)}%`);
  });
  console.log("");
}
