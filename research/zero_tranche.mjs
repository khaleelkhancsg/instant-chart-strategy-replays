// The tranche sweep was monotone 1 > 2 > 3 > 4 > 6. It never tested ZERO.
//
// If the edge is in not committing size before confirmation, the limit case is
// committing nothing: no market order at all, just a resting stop at
// ep + trig x ATR that becomes the whole position when it fills, and no trade at
// all when it does not. The signal stops being an order and becomes an ARMING
// condition.
//
// What that buys: the ~13% of signals that never confirm cost exactly zero
// instead of one lot, and the fill is a stop rather than a market order.
// What it costs: throughput. This book is measured against $3,000 in 21 days and
// has already shown twice that removing trades hurts more than the trades were
// worth. 13% fewer entries is a real price.
//
// Also swept here, because both interact with the same thing: the ENTRY GATE.
// adx_min 25, eff_min 0.5 and the Donchian period were all chosen years before
// scale-in existed, when the signal WAS the commitment. Now confirmation does
// part of the filtering, so the gate may be doing work twice — and the sizing
// re-check already showed that changing the tranche split moves other optima.
//
// Usage:  node research/zero_tranche.mjs

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
const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });
const n = tf.close.length;

// signals are rebuilt per gate setting, since the gate is being swept
const adxCache = new Map(), donCache = new Map();
function buildSig(adxMin, effMin, period, adxPeriod = 14) {
  if (!adxCache.has(adxPeriod)) adxCache.set(adxPeriod, adx(tf.high, tf.low, tf.close, adxPeriod).adx);
  const ax = adxCache.get(adxPeriod);
  if (!donCache.has(period)) donCache.set(period, donchian(tf.high, tf.low, period));
  const { high: dh, low: dl } = donCache.get(period);
  const raw = new Int8Array(n);
  for (let i = period; i < n; i++) {
    if (ax[i] < adxMin) continue;
    if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
  }
  return applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin });
}
function rawOf(adxMin, period, adxPeriod = 14) {
  if (!adxCache.has(adxPeriod)) adxCache.set(adxPeriod, adx(tf.high, tf.low, tf.close, adxPeriod).adx);
  const ax = adxCache.get(adxPeriod);
  if (!donCache.has(period)) donCache.set(period, donchian(tf.high, tf.low, period));
  const { high: dh, low: dl } = donCache.get(period);
  const raw = new Int8Array(n);
  for (let i = period; i < n; i++) {
    if (ax[i] < adxMin) continue;
    if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
  }
  return raw;
}
const BASE_SIG = buildSig(25, 0.5, 30);

// first = lots taken at market on the signal. ZERO means the position does not
// exist until the stop fills, and the signal is only an arming condition.
function replay(sig, first, trig = 0.15, delay = 1, win = ADD_WIN, sameBarArm = false) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const fills = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, entBar = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  // armed-but-unfilled state, used only when first === 0
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  let nSignals = 0, nEntries = 0, nAdds = 0;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
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

    // ── an armed stop entry, waiting to become a position ──
    if (pos === 0 && armDir !== 0) {
      if (flatNow || i > armBy || blocked()) { armDir = 0; }
      else if (i - armBar >= delay &&
               (armDir === 1 ? H[i] >= armPx : L[i] <= armPx)) {
        pos = armDir; qty = TOTAL; pendQty = 0; addBy = -1;
        ep = armEp; slD = armSl; tpD = armTp; entBar = i; entTime = TS[i];
        notional = (pos === 1 ? armPx + slip : armPx - slip) * qty;
        armDir = 0; nEntries++; nAdds++;
      }
    }

    if (pos !== 0) {
      if (pendQty > 0 && i - entBar >= delay && i <= addBy &&
          (pos === 1 ? H[i] >= addPx : L[i] <= addPx)) {
        notional += (pos === 1 ? addPx + slip : addPx - slip) * pendQty;
        qty += pendQty; pendQty = 0; nAdds++;
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
      nSignals++;
      const slD2 = Math.max(a * 5, tick), tpD2 = Math.max(a * 1.75, tick);
      const px = O[i] + s * Math.max(a * trig, tick);
      if (first === 0) {
        // arm only; the signal buys nothing until price confirms
        armDir = s; armPx = px; armBar = i; armBy = i + win;
        armEp = O[i]; armSl = slD2; armTp = tpD2;
      } else {
        ep = O[i]; entTime = TS[i]; pos = s; entBar = i; nEntries++;
        slD = slD2; tpD = tpD2;
        qty = first; pendQty = TOTAL - first;
        addPx = px; addBy = i + win;
        notional = (pos === 1 ? ep + slip : ep - slip) * qty;
      }
      // SAME-BAR option for the armed entry. Live, a stop placed the moment the
      // signal is read rests for the whole of THIS bar and can fill inside it.
      // Deferring it one bar is a deliberate choice, exactly as it is for the
      // add — and filling early is what destroyed the add, so both are measured.
      if (first === 0 && sameBarArm && armDir !== 0 && i <= armBy &&
          (armDir === 1 ? H[i] >= armPx : L[i] <= armPx)) {
        pos = armDir; qty = TOTAL; pendQty = 0; addBy = -1;
        ep = armEp; slD = armSl; tpD = armTp; entBar = i; entTime = TS[i];
        notional = (pos === 1 ? armPx + slip : armPx - slip) * qty;
        armDir = 0; nEntries++; nAdds++;
      }
    }
  }
  return { fills, nSignals, nEntries, nAdds };
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

function report(title, cfgs, baseIdx = 0) {
  console.log(`\n${title}\n`);
  const books = cfgs.map(([, f]) => f());
  const cols = SLICES.map(([, lo, hi]) => {
    const maps = books.map(b => dayMap(b.fills, lo, hi));
    const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
    return pairedPass(maps, keys, 4242);
  });
  let hdr = "  config              entries";
  for (const [nm] of SLICES) hdr += nm.padStart(12);
  console.log(hdr + "     pf      net");
  cfgs.forEach(([lbl], i) => {
    const f = books[i].fills;
    let gw = 0, gl = 0, tot = 0;
    for (const x of f) { tot += x.pnl; if (x.pnl > 0) gw += x.pnl; else gl -= x.pnl; }
    let row = "  " + lbl.padEnd(20) + String(f.length).padStart(6);
    cols.forEach(c => {
      const v = c[i], d = v - c[baseIdx];
      row += (v.toFixed(1) + (i === baseIdx ? "" : ` ${d >= 0 ? "+" : ""}${d.toFixed(1)}`)).padStart(12);
    });
    console.log(row + `  ${(gw / gl).toFixed(3)}  ${("$" + (tot / 1000).toFixed(0) + "k").padStart(6)}`);
  });
  return { books, cols };
}

const { books, cols } = report(
  "TIMING: can the armed stop fill on its own bar, and does that break it?",
  [["1+7 (ships)", () => replay(BASE_SIG, 1)],
   ["0+8 deferred 1 bar", () => replay(BASE_SIG, 0, 0.15, 1, ADD_WIN, false)],
   ["0+8 SAME BAR (naive)", () => replay(BASE_SIG, 0, 0.15, 1, ADD_WIN, true)],
   ["0+8 deferred @0.10", () => replay(BASE_SIG, 0, 0.10, 1, ADD_WIN, false)],
   ["0+8 same-bar @0.10", () => replay(BASE_SIG, 0, 0.10, 1, ADD_WIN, true)],
   ["0+8 deferred win 6", () => replay(BASE_SIG, 0, 0.15, 1, 6, false)],
   ["0+8 deferred win 15", () => replay(BASE_SIG, 0, 0.15, 1, 15, false)],
   ["0+8 deferred win 20", () => replay(BASE_SIG, 0, 0.15, 1, 20, false)]]);

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
           lo: ds[1], hi: ds[ds.length - 2],
           pWin: ds.filter(v => v > 0).length / ds.length };
}
console.log("\n  PAIRED CI, 0+8 deferred vs 1+7:\n");
console.log("   slice        mean delta      95% band     P(better)");
SLICES.forEach(([nm, lo, hi], j) => {
  const m1 = dayMap(books[1].fills, lo, hi), m0 = dayMap(books[0].fills, lo, hi);
  const keys = [...new Set([...m1.keys(), ...m0.keys()])].sort((a, b) => a - b);
  const d = pairedDelta(m1, m0, keys, 7700 + j);
  console.log(`   ${nm.padEnd(11)}${((d.mean >= 0 ? "+" : "") + d.mean.toFixed(2) + "pp").padStart(11)}   ` +
    `${(d.lo.toFixed(1) + " .. " + d.hi.toFixed(1)).padStart(14)}   ${(100 * d.pWin).toFixed(0).padStart(7)}%`);
});

// ── the gate, re-checked under 0+8 (the structure changed again) ─────
report("GATE under 0+8 — confirmation now does part of the filtering",
  [["eff 0.50 (ships)", () => replay(BASE_SIG, 0, 0.15)],
   ["eff 0.35", () => replay(buildSig(25, 0.35, 30), 0, 0.15)],
   ["eff 0.40", () => replay(buildSig(25, 0.40, 30), 0, 0.15)],
   ["eff 0.45", () => replay(buildSig(25, 0.45, 30), 0, 0.15)],
   ["eff 0.55", () => replay(buildSig(25, 0.55, 30), 0, 0.15)],
   ["eff 0.60", () => replay(buildSig(25, 0.60, 30), 0, 0.15)]]);

report("SESSION START under 0+8 — 08:30 open was never swept either",
  [["08:30 (ships)", () => replay(BASE_SIG, 0, 0.15)],
   ["09:00 start", () => replay(applyFilters(rawOf(25, 30), ctx,
      { ...NO_FILTER, startCt: 540, endCt: 900, effMin: 0.5 }), 0, 0.15)],
   ["09:30 start", () => replay(applyFilters(rawOf(25, 30), ctx,
      { ...NO_FILTER, startCt: 570, endCt: 900, effMin: 0.5 }), 0, 0.15)],
   ["end 14:00", () => replay(applyFilters(rawOf(25, 30), ctx,
      { ...NO_FILTER, startCt: 510, endCt: 840, effMin: 0.5 }), 0, 0.15)],
   ["end 14:30", () => replay(applyFilters(rawOf(25, 30), ctx,
      { ...NO_FILTER, startCt: 510, endCt: 870, effMin: 0.5 }), 0, 0.15)]]);
