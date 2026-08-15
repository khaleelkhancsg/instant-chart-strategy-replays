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
// Is early detection real? Six ways to break it.
//
// The finding: arming when close crosses DH - k x ATR instead of DH scores
// +3.7pp (MNQ, k=0.40) and +6.8pp (MES), positive on every slice of both.
// Before that ships, the ways it could still be fake:
//
//  1 THROUGHPUT. Early arming produces ~18% more signals, and this book is
//    throughput-constrained against $3,000 in 21 days -- every filter tested has
//    lost for that reason. So does ANY route to the same number of trades work
//    equally well? Matched here by loosening the efficiency gate until it emits
//    the same signal count, which is the fair comparison and the one that
//    decides whether the SHAPE of the signal matters or only its frequency.
//  2 IS IT JUST REMOVING THE DONCHIAN? The k sweep never turns over, so perhaps
//    the channel is simply a bad filter and any loosening helps. If k=0.40 is
//    indistinguishable from k=3 (channel inert), the honest framing is "delete
//    the breakout condition", not "detect earlier".
//  3 YEAR BY YEAR. A gain concentrated in one or two years is a regime artifact.
//  4 CAUSALITY. The pad uses ATR[i] and DH[i] on the signal bar; corrupt every
//    bar after a cut and pre-cut trades must be identical.
//  5 PARAMETER ROBUSTNESS. The Donchian period and the ATR period used for the
//    pad are both free. If the effect only exists at 30/14 it is fitted.
//  6 COST SENSITIVITY. More trades means more commission and slippage. Does it
//    survive being charged double?
//
// Usage:  node research/early_verify.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 15000, BLOCK = 5, WIN = 21, TOTAL = 8;
const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750, ADD_WIN = 10, TRIG = 0.15;

function build(binPath) {
  const { bars } = loadBars(binPath);
  const tf = resample(bars, 2);
  return { bars, tf, ctx: buildFilterContext(tf) };
}
const M = build("data/mnq_1m.bin");
const S = (await loadStrategies()).get("donchian_eff_rth");
const X = resolveExec(S.execDefaults);
const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });

const cacheA = new Map(), cacheX = new Map(), cacheD = new Map();
function ind(env, key, fn) {
  const c = key.startsWith("a") ? cacheA : key.startsWith("x") ? cacheX : cacheD;
  const k = key + "|" + (env === M ? "M" : "E");
  if (!c.has(k)) c.set(k, fn());
  return c.get(k);
}
function sigOf(env, { k = 0, eff = 0.5, period = 30, atrPeriod = 14, adxPeriod = 14 } = {}) {
  const tf = env.tf, n = tf.close.length;
  const A = ind(env, "a" + atrPeriod, () => atr(tf.high, tf.low, tf.close, atrPeriod));
  const ax = ind(env, "x" + adxPeriod, () => adx(tf.high, tf.low, tf.close, adxPeriod).adx);
  const D = ind(env, "d" + period, () => donchian(tf.high, tf.low, period));
  const raw = new Int8Array(n);
  for (let i = period; i < n; i++) {
    if (ax[i] < 25) continue;
    const pad = k * (A[i] > 0 ? A[i] : 0);
    if (tf.close[i] > D.high[i] - pad) raw[i] = 1;
    else if (tf.close[i] < D.low[i] + pad) raw[i] = -1;
  }
  return applyFilters(raw, env.ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: eff });
}
function countSig(sig) { let c = 0; for (let i = 0; i < sig.length; i++) if (sig[i]) c++; return c; }

function replay(env, sig, { pv = 2, costMult = 1, atrPeriod = 14 } = {}) {
  const tf = env.tf;
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const n = tf.close.length, tick = 0.25;
  const slip = 0.25 * costMult, perSide = 0.75 * costMult;
  const A = ind(env, "a" + atrPeriod, () => atr(tf.high, tf.low, tf.close, atrPeriod));
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
function passOf(map, keys, seed) {
  const rnd = mul(seed), N = keys.length, idx = new Array(WIN);
  const arr = keys.map(k => map.get(k) ?? 0), buf = new Array(WIN);
  let w = 0;
  for (let d = 0; d < DRAWS; d++) {
    let m = 0;
    while (m < WIN) { const st = Math.floor(rnd() * Math.max(1, N - BLOCK));
      for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = (st + j) % N; }
    for (let k = 0; k < WIN; k++) buf[k] = arr[idx[k]];
    w += ev(buf);
  }
  return (100 * w) / DRAWS;
}
const T0 = M.bars.ts[0], T1 = M.bars.ts[M.bars.count - 1];
const passAll = (fills) => {
  const m = dayMap(fills, T0, T1);
  const keys = [...m.keys()].sort((a, b) => a - b);
  return passOf(m, keys, 4242);
};
const stat = (t) => {
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const x of t) { tot += x.pnl; if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; }
  return { n: t.length, win: 100 * w / t.length, pf: gw / gl, net: tot };
};

// ── 1. MATCHED THROUGHPUT ───────────────────────────────────────────
console.log("\n1. THROUGHPUT CONTROL — is it the shape of the signal, or just more of them?\n");
console.log("   For each k, the efficiency gate is loosened until it emits the SAME");
console.log("   number of signals. Same count, same rules, different reason.\n");
console.log("   variant                    signals   fills    pass     pf      net");
{
  const base = sigOf(M, { k: 0, eff: 0.5 });
  const nBase = countSig(base);
  const bs = replay(M, base), st0 = stat(bs);
  console.log(`   k=0.00 eff=0.50 (ships)   ${String(nBase).padStart(7)}  ${String(st0.n).padStart(6)}  ` +
    `${passAll(bs).toFixed(1).padStart(6)}  ${st0.pf.toFixed(3)}  ${("$" + (st0.net / 1000).toFixed(0) + "k").padStart(6)}`);
  for (const k of [0.25, 0.40, 0.60]) {
    const sk = sigOf(M, { k, eff: 0.5 });
    const target = countSig(sk);
    const bk = replay(M, sk), stk = stat(bk);
    console.log(`   k=${k.toFixed(2)} eff=0.50           ${String(target).padStart(7)}  ${String(stk.n).padStart(6)}  ` +
      `${passAll(bk).toFixed(1).padStart(6)}  ${stk.pf.toFixed(3)}  ${("$" + (stk.net / 1000).toFixed(0) + "k").padStart(6)}`);
    // bisect eff to match the signal count
    let lo = 0.20, hi = 0.50, bestE = 0.5, bestD = Infinity;
    for (let it = 0; it < 22; it++) {
      const mid = (lo + hi) / 2;
      const c = countSig(sigOf(M, { k: 0, eff: mid }));
      if (Math.abs(c - target) < bestD) { bestD = Math.abs(c - target); bestE = mid; }
      if (c > target) lo = mid; else hi = mid;
    }
    const sm = sigOf(M, { k: 0, eff: bestE });
    const bm = replay(M, sm), stm = stat(bm);
    console.log(`     CONTROL eff=${bestE.toFixed(3)}       ${String(countSig(sm)).padStart(7)}  ${String(stm.n).padStart(6)}  ` +
      `${passAll(bm).toFixed(1).padStart(6)}  ${stm.pf.toFixed(3)}  ${("$" + (stm.net / 1000).toFixed(0) + "k").padStart(6)}` +
      `   <- same count, gate loosened instead`);
  }
}

// ── 2. IS IT JUST DELETING THE DONCHIAN? ────────────────────────────
console.log("\n2. IS THE CHANNEL DOING ANYTHING? k=3 makes the condition inert.\n");
console.log("   k        signals   fills    pass     pf      net");
for (const k of [0, 0.40, 0.60, 1.0, 2.0, 3.0]) {
  const sg = sigOf(M, { k });
  const b = replay(M, sg), s = stat(b);
  console.log(`   ${k.toFixed(2)}    ${String(countSig(sg)).padStart(7)}  ${String(s.n).padStart(6)}  ` +
    `${passAll(b).toFixed(1).padStart(6)}  ${s.pf.toFixed(3)}  ${("$" + (s.net / 1000).toFixed(0) + "k").padStart(6)}`);
}

// ── 3. YEAR BY YEAR ─────────────────────────────────────────────────
console.log("\n3. YEAR BY YEAR — a gain living in one or two years is a regime artifact\n");
{
  const b0 = replay(M, sigOf(M, { k: 0 }));
  const b4 = replay(M, sigOf(M, { k: 0.40 }));
  console.log("   year    k=0 $/trade   k=0.40 $/trade    delta    k=0 pf   k=0.40 pf");
  for (let y = 2019; y <= 2026; y++) {
    const lo = Date.UTC(y, 0, 1), hi = Date.UTC(y + 1, 0, 1);
    const f0 = b0.filter(t => t.entryTime >= lo && t.entryTime < hi);
    const f4 = b4.filter(t => t.entryTime >= lo && t.entryTime < hi);
    if (f0.length < 40 || f4.length < 40) continue;
    const s0 = stat(f0), s4 = stat(f4);
    const e0 = s0.net / s0.n, e4 = s4.net / s4.n;
    console.log(`   ${y}   ${("$" + e0.toFixed(2)).padStart(11)}   ${("$" + e4.toFixed(2)).padStart(13)}  ` +
      `${((e4 - e0 >= 0 ? "+" : "") + "$" + (e4 - e0).toFixed(2)).padStart(8)}    ` +
      `${s0.pf.toFixed(3)}     ${s4.pf.toFixed(3)}`);
  }
}

// ── 4. CAUSALITY ────────────────────────────────────────────────────
console.log("\n4. CAUSALITY — corrupt every bar after a cut; pre-cut trades must match\n");
{
  const n = M.bars.count, cut = Math.floor(n * 0.6);
  const c = { ...M.bars, ts: M.bars.ts, volume: M.bars.volume,
    open: Float64Array.from(M.bars.open), high: Float64Array.from(M.bars.high),
    low: Float64Array.from(M.bars.low), close: Float64Array.from(M.bars.close) };
  let seed = 4711;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = cut; i < n; i++) {
    const p = 30000 + rnd() * 5000;
    c.open[i] = p; c.close[i] = p + (rnd() - 0.5) * 200;
    c.high[i] = Math.max(c.open[i], c.close[i]) + rnd() * 100;
    c.low[i] = Math.min(c.open[i], c.close[i]) - rnd() * 100;
  }
  const tfC = resample(c, 2);
  const envC = { bars: c, tf: tfC, ctx: buildFilterContext(tfC) };
  const a = replay(M, sigOf(M, { k: 0.40 }));
  const b = replay(envC, sigOf(envC, { k: 0.40 }));
  const cutTs = M.bars.ts[cut];
  const A2 = a.filter(t => t.entryTime < cutTs), B2 = b.filter(t => t.entryTime < cutTs);
  let diff = 0;
  for (let i = 0; i < Math.min(A2.length, B2.length); i++)
    if (A2[i].entryTime !== B2[i].entryTime || Math.abs(A2[i].pnl - B2[i].pnl) > 1e-6) diff++;
  console.log(`   pre-cut trades: ${A2.length} vs ${B2.length}, ${diff} differ  ` +
    `-> ${A2.length === B2.length && diff === 0 ? "CAUSAL" : "!! LOOKAHEAD !!"}`);
}

// ── 5. PARAMETER ROBUSTNESS ─────────────────────────────────────────
console.log("\n5. ROBUSTNESS — the channel period and the ATR the pad is measured in\n");
console.log("   period  atrP     k=0    k=0.40    delta");
for (const period of [20, 30, 45, 60]) {
  for (const atrPeriod of [10, 14, 21]) {
    const p0 = passAll(replay(M, sigOf(M, { k: 0, period, atrPeriod }), { atrPeriod }));
    const p4 = passAll(replay(M, sigOf(M, { k: 0.40, period, atrPeriod }), { atrPeriod }));
    console.log(`   ${String(period).padStart(6)}  ${String(atrPeriod).padStart(4)}  ` +
      `${p0.toFixed(1).padStart(6)}  ${p4.toFixed(1).padStart(7)}  ` +
      `${((p4 - p0 >= 0 ? "+" : "") + (p4 - p0).toFixed(1)).padStart(7)}`);
  }
}

// ── 6. COSTS ────────────────────────────────────────────────────────
console.log("\n6. COSTS — more trades means more of them. Charged double:\n");
console.log("   costs      k=0     k=0.40    delta");
for (const cm of [1, 1.5, 2, 3]) {
  const p0 = passAll(replay(M, sigOf(M, { k: 0 }), { costMult: cm }));
  const p4 = passAll(replay(M, sigOf(M, { k: 0.40 }), { costMult: cm }));
  console.log(`   ${(cm + "x").padStart(5)}   ${p0.toFixed(1).padStart(6)}  ${p4.toFixed(1).padStart(7)}  ` +
    `${((p4 - p0 >= 0 ? "+" : "") + (p4 - p0).toFixed(1)).padStart(7)}`);
}
