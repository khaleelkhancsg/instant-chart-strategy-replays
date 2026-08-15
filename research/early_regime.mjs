// The test that actually matters: would k > 0 have been CHOSEN, prospectively,
// and would it then have delivered?
//
// Everything so far used the whole history to pick k=0.40 and the whole history
// to score it. That is the same data twice, and twelve values of k were tried.
// Even with matched-throughput controls, an MES replication and a cost sweep,
// none of that answers the only question that decides whether to trade it: on
// the day, knowing only the past, would this have been selected -- and did it
// then work on data nobody had seen?
//
// WALK-FORWARD. Expanding window. At each step, pick the k that scored best on
// everything up to that date, then score THAT k on the following six months and
// never look at those months again until the next step. The k=0 book is scored
// on the identical test windows. If early arming is a real property of this
// market, the walk-forward equity should beat the k=0 equity out of sample; if
// it is an artifact of seeing all the data at once, it should not.
//
// Three further decompositions, because "it works" is not the same as knowing
// WHY, and a mechanism that cannot be located is a mechanism that can vanish:
//
//   MECHANISM   early arming changes two things at once -- WHICH bars arm, and
//               WHERE the entry stop ends up. Pushing the trigger out by the
//               same k restores roughly the original fill price while keeping
//               the new arming set, separating the two channels.
//   REGIME      by ATR quintile. An effect that only exists in one volatility
//               regime is a bet on that regime persisting.
//   ESTIMATOR   a trade-level bootstrap instead of the day-block one, in case
//               the result is an artifact of how days are resampled.
//
// Usage:  node research/early_walkforward.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 12000, BLOCK = 5, WIN = 21, TOTAL = 8;
const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750, ADD_WIN = 10;
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
function replay(sig, trig = 0.15) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const out = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, qty = 0, notional = 0, eATR = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0, armA = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (rawExit, i, exact) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    out.push({ tday: TD[i], entryTime: entTime, pnl: net, dir: pos, atr: eATR });
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
        ep = armEp; slD = armSl; tpD = armTp; entTime = TS[i]; eATR = armA;
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
      armDir = s; armBar = i; armBy = i + ADD_WIN; armEp = O[i]; armA = a;
      armPx = O[i] + s * Math.max(a * trig, tick);
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
function passOf(fills, lo, hi, seed = 4242) {
  const m = dayMap(fills, lo, hi);
  const keys = [...m.keys()].sort((a, b) => a - b);
  if (keys.length < 30) return NaN;
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
  return { n: t.length, win: 100 * w / t.length, pf: gl ? gw / gl : Infinity,
           exp: tot / t.length, net: tot };
};

const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
const KGRID = [0, 0.10, 0.20, 0.30, 0.40, 0.60, 0.80];
const BOOKS = new Map(KGRID.map(k => [k, replay(sigOf(k))]));

// ── REGIME CONCENTRATION ────────────────────────────────────────────
// The single most selection-independent test available: split by ATR quintile
// at entry and ask WHERE the gain lives. A mechanism that works because
// confirmation is informative should show up across volatility regimes. A gain
// that sits in one bucket is that bucket's noise, and no amount of full-sample
// significance testing can rescue it.
console.log("\nWHERE DOES THE GAIN ACTUALLY LIVE?\n");
const base = BOOKS.get(0);
const all = base.map(t => t.atr).sort((a, b) => a - b);
const q = [0.2, 0.4, 0.6, 0.8].map(p => all[Math.floor(p * all.length)]);
const band = (t, i) => (i === 0 ? t.atr < q[0]
  : i === 4 ? t.atr >= q[3] : t.atr >= q[i - 1] && t.atr < q[i]);
for (const k of [0.40, 0.60, 0.80]) {
  const bk = BOOKS.get(k);
  console.log(`  k=${k.toFixed(2)}`);
  console.log("    quintile  ATR range      k=0 $/trade   this $/trade    delta      n    gain $");
  let tot = 0; const gains = [];
  for (let i = 0; i < 5; i++) {
    const a = stat(base.filter(t => band(t, i)));
    const b = stat(bk.filter(t => band(t, i)));
    const g = (b.exp - a.exp) * b.n;
    gains.push(g); tot += g;
    const rng = i === 0 ? `< ${q[0].toFixed(1)}` : i === 4 ? `>= ${q[3].toFixed(1)}`
      : `${q[i - 1].toFixed(1)}-${q[i].toFixed(1)}`;
    console.log(`    ${String(i + 1).padStart(7)}   ${rng.padEnd(12)}${("$" + a.exp.toFixed(2)).padStart(11)}  ` +
      `${("$" + b.exp.toFixed(2)).padStart(12)}  ${((b.exp - a.exp >= 0 ? "+" : "") + "$" + (b.exp - a.exp).toFixed(2)).padStart(8)}  ` +
      `${String(b.n).padStart(5)}  ${("$" + (g / 1000).toFixed(1) + "k").padStart(7)}`);
  }
  const best = Math.max(...gains);
  console.log(`    total gain $${(tot / 1000).toFixed(1)}k, of which the single best quintile is ` +
    `$${(best / 1000).toFixed(1)}k = ${(100 * best / tot).toFixed(0)}%
`);
}
