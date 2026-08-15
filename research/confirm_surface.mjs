// Push on the ONE mechanism that works, instead of hunting for another.
//
// The tally so far is lopsided. Dead: every exit rule (breakeven on excursion,
// on dollars, on time; trailing; give-back; partial; time stop; per-trade stop;
// runner), every entry filter (volume, lunch, entry cutoff, cooldown), every
// sizing scheme (risk-based, MES, 50 lots, context size-gates), and flip mode.
// Alive: exactly one thing — commit 2 lots at the signal and the other 6 only
// after price confirms, ONE BAR LATER. That is worth 15pp, which is larger than
// everything else found put together.
//
// And it has only ever been sampled along one axis at a time. The trigger
// distance (0.15xATR) was chosen while the delay was fixed at whatever the
// engine happened to impose, and the delay was swept afterwards with the trigger
// fixed at 0.15. Those two interact directly: a longer wait and a shorter
// distance are different ways of asking for the same confirmation, and the pair
// that was shipped is the intersection of two separate one-dimensional searches,
// which is not the same as a maximum.
//
// So map the surface. What matters is not the best cell — with 24 cells one will
// look good by luck — but whether the good cells form a connected REGION. A lone
// peak is the shape that killed the volume filter.
//
// Usage:  node research/confirm_surface.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 20000, BLOCK = 5, WIN = 21, TOTAL = 8;
const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750, ADD_WIN = 10;
const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const S = (await loadStrategies()).get("donchian_eff_rth");
const X = resolveExec(S.execDefaults);
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(tf.close.length);
for (let i = 30; i < raw.length; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });

function replay(first, trig, delay, win = ADD_WIN) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const n = tf.close.length, pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const fills = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, entBar = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  let curTday = -1e9, dayReal = 0, capHit = false, nAdd = 0, nTr = 0;
  const avgFill = () => notional / qty;
  const close_ = (rawExit, i, exact) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    fills.push({ tday: TD[i], entryTime: entTime, pnl: net, qty });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; pendQty = 0; addBy = -1; notional = 0;
  };
  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    if (pos !== 0) {
      // the resting add: not live until `delay` bars after entry
      if (pendQty > 0 && i - entBar >= delay && i <= addBy &&
          (pos === 1 ? H[i] >= addPx : L[i] <= addPx)) {
        notional += (pos === 1 ? addPx + slip : addPx - slip) * pendQty;
        qty += pendQty; pendQty = 0; nAdd++;
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
    if (pos === 0 && s !== 0 && !flatNow &&
        !(capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK)) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      ep = O[i]; entTime = TS[i]; pos = s; entBar = i; nTr++;
      slD = Math.max(a * 5, tick); tpD = Math.max(a * 1.75, tick);
      qty = first; pendQty = TOTAL - first;
      addPx = ep + pos * Math.max(a * trig, tick);
      addBy = i + win;
      notional = (pos === 1 ? ep + slip : ep - slip) * qty;
    }
  }
  return { fills, addRate: (100 * nAdd) / Math.max(1, nTr) };
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

const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
const MID = T0 + (T1 - T0) / 2, Y12 = T1 - 365 * 86400000, Y26 = Date.UTC(2026, 0, 1);
const SLICES = [["early", T0, MID], ["late", MID, T1], ["12m", Y12, T1],
                ["2026", Y26, T1], ["ALL", T0, T1]];

const TRIGS = [0.05, 0.10, 0.15, 0.25, 0.40, 0.60];
const DELAYS = [1, 2, 3, 5];
const cells = [];
for (const d of DELAYS) for (const t of TRIGS) cells.push([d, t]);
const books = cells.map(([d, t]) => replay(2, t, d));
const cols = SLICES.map(([, lo, hi]) => {
  const maps = books.map(b => dayMap(b.fills, lo, hi));
  const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  return pairedPass(maps, keys, 4242);
});

console.log("\nCONFIRMATION SURFACE — delay (bars) x trigger (xATR), first tranche 2 of 8");
console.log("ALL-HISTORY pass rate. The shipped cell is delay 1, trigger 0.15.\n");
let head = "  delay |";
for (const t of TRIGS) head += ("  " + t.toFixed(2)).padStart(9);
console.log(head);
console.log("  " + "-".repeat(head.length - 2));
DELAYS.forEach((d, di) => {
  let row = `  ${String(d).padStart(5)} |`;
  TRIGS.forEach((t, ti) => {
    const k = di * TRIGS.length + ti;
    const v = cols[4][k];
    const mark = (d === 1 && Math.abs(t - 0.15) < 1e-9) ? "*" : " ";
    row += (v.toFixed(1) + mark).padStart(9);
  });
  console.log(row);
});
console.log("\n  add rate (% of trades that reach the trigger in time):");
DELAYS.forEach((d, di) => {
  let row = `  ${String(d).padStart(5)} |`;
  TRIGS.forEach((t, ti) => {
    row += (books[di * TRIGS.length + ti].addRate.toFixed(0) + "%").padStart(9);
  });
  console.log(row);
});

// Rank on the WORSE half, then report every slice for the leaders.
const scored = cells.map(([d, t], k) => ({
  d, t, k, worse: Math.min(cols[0][k], cols[1][k]),
  early: cols[0][k], late: cols[1][k], m12: cols[2][k], y26: cols[3][k], all: cols[4][k],
})).sort((a, b) => b.worse - a.worse);
const ship = scored.find(s => s.d === 1 && Math.abs(s.t - 0.15) < 1e-9);
console.log("\n  ranked on the WORSE of the two halves (the discipline that killed 3.5/2.5):\n");
console.log("   delay  trig    worse   early    late     12m    2026     ALL   vs shipped");
for (const s of scored.slice(0, 8)) {
  const tag = (s.d === 1 && Math.abs(s.t - 0.15) < 1e-9) ? "  <- SHIPPED" : "";
  console.log(`   ${String(s.d).padStart(5)}  ${s.t.toFixed(2)}  ${s.worse.toFixed(1).padStart(6)}  ` +
    `${s.early.toFixed(1).padStart(6)}  ${s.late.toFixed(1).padStart(6)}  ${s.m12.toFixed(1).padStart(6)}  ` +
    `${s.y26.toFixed(1).padStart(6)}  ${s.all.toFixed(1).padStart(6)}  ` +
    `${((s.all - ship.all >= 0 ? "+" : "") + (s.all - ship.all).toFixed(1)).padStart(6)}${tag}`);
}
console.log(`\n   shipped cell rank: ${scored.findIndex(s => s === ship) + 1} of ${scored.length}`);

// Noise floor from adjacent cells along both axes.
let steps = 0, ssum = 0;
DELAYS.forEach((d, di) => TRIGS.forEach((t, ti) => {
  const k = di * TRIGS.length + ti;
  if (ti + 1 < TRIGS.length) { ssum += Math.abs(cols[4][k] - cols[4][k + 1]); steps++; }
  if (di + 1 < DELAYS.length) { ssum += Math.abs(cols[4][k] - cols[4][k + TRIGS.length]); steps++; }
}));
console.log(`   noise floor (mean |step| between neighbouring cells): ${(ssum / steps).toFixed(2)}pp`);
