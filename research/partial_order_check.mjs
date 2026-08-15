// Pass rates for the partial exit against the shipped algo, as a single table.
//
// Everything is measured with the FULL rule set: $3,000 target, $2,000 trailing
// drawdown, 50% consistency, -$1,000 hard cap, 8 lots entered 2+6 scale-in,
// 1 tick slippage per leg per tranche, $0.75/side commission.
//
// The bootstrap is PAIRED: within a slice, every configuration is scored on the
// identical resampled day sequences, so the deltas are not swamped by draw noise.
// Each slice also reports its own noise floor — the mean absolute step between
// adjacent trigger settings — because a 125-day slice cannot resolve what a
// 1,667-day slice can, and reading -4.7pp on 2026 without that context is a
// mistake.
//
// Usage:  node research/partial_table.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 20000, BLOCK = 5, WIN = 21, TOTAL = 8, Q1 = 2, ADD_TRIG = 0.15, ADD_WIN = 10;
const CAP = 1000, TP_MULT = 1.75;

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

function replay(trig, frac, pessimistic) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const n = O.length, pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const fills = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  let curTday = -1e9, dayReal = 0, hit = false, tookPartial = false;
  let nPart = 0, nTrades = 0;
  const avgFill = () => notional / qty;
  const bank = (rawExit, i, exact, q) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * q - perSide * 2 * q;
    fills.push({ tday: TD[i], entryTime: entTime, net });
    dayReal += net;
    if (dayReal <= -CAP) hit = true;
  };
  const close_ = (rawExit, i, exact) => {
    bank(rawExit, i, exact, qty);
    pos = 0; pendQty = 0; addBy = -1; notional = 0; tookPartial = false;
  };
  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; hit = false; }
    if (pos !== 0) {
      if (pendQty > 0 && i <= addBy && (pos === 1 ? H[i] >= addPx : L[i] <= addPx)) {
        notional += (pos === 1 ? addPx + slip : addPx - slip) * pendQty;
        qty += pendQty; pendQty = 0;
      }
      if (flatNow) { close_(O[i], i); continue; }
      const dir = pos;
      const lossPx = avgFill() - dir * ((CAP + dayReal) / (pv * qty));
      const rawSl = ep - dir * slD;
      const sl = dir === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
      const isCap = dir === 1 ? (sl === lossPx && lossPx > rawSl)
                              : (sl === lossPx && lossPx < rawSl);
      const tp = ep + dir * tpD;
      // If a single bar spans BOTH the partial level and the full target, the
      // resting partial limit fills on the way through -- it does not get
      // upgraded to the better price. Closing everything at the full target
      // (the optimistic reading) overstates those bars, so `pessimistic` fills
      // the partial at its own level first and only the remainder at target.
      if (pessimistic && frac > 0 && !tookPartial) {
        const tg = ep + dir * trig * tpD;
        const spans = dir === 1 ? (H[i] >= tp && L[i] > sl && O[i] > sl)
                                : (L[i] <= tp && H[i] < sl && O[i] < sl);
        if (spans && (dir === 1 ? H[i] >= tg : L[i] <= tg)) {
          const qOut = Math.max(1, Math.round(qty * frac));
          if (qOut < qty) {
            const af = avgFill();
            bank(tg, i, undefined, qOut);
            notional -= af * qOut; qty -= qOut; tookPartial = true; nPart++;
          }
        }
      }
      let exited = false;
      if (dir === 1) {
        if (O[i] <= sl) { close_(O[i], i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (L[i] <= sl) { close_(sl, i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (H[i] >= tp) { close_(tp, i); exited = true; }
      } else {
        if (O[i] >= sl) { close_(O[i], i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (H[i] >= sl) { close_(sl, i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (L[i] <= tp) { close_(tp, i); exited = true; }
      }
      if (exited) continue;
      if (frac > 0 && !tookPartial) {
        const tgPx = ep + dir * trig * tpD;
        if (dir === 1 ? H[i] >= tgPx : L[i] <= tgPx) {
          const qOut = Math.max(1, Math.round(qty * frac));
          if (qOut < qty) {
            const af = avgFill();
            bank(tgPx, i, undefined, qOut);
            notional -= af * qOut; qty -= qOut; tookPartial = true; nPart++;
          }
        }
      }
      if (X.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], i);
      if (pos !== 0) continue;
    }
    if (pos === 0 && s !== 0 && !flatNow && !hit) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      ep = O[i]; entTime = TS[i]; pos = s; nTrades++;
      slD = Math.max(a * 5, tick); tpD = Math.max(a * TP_MULT, tick);
      qty = Q1; pendQty = TOTAL - Q1;
      addPx = ep + pos * Math.max(a * ADD_TRIG, tick);
      addBy = i + ADD_WIN;
      notional = (pos === 1 ? ep + slip : ep - slip) * qty;
      tookPartial = false;
    }
  }
  return { fills, fireRate: (100 * nPart) / Math.max(1, nTrades) };
}
function dayMap(fills, lo, hi) {
  const m = new Map(); let day = null, acc = 0;
  for (const f of fills) {
    if (f.entryTime < lo || f.entryTime >= hi) continue;
    if (f.tday !== day) { if (day !== null) m.set(day, acc); day = f.tday; acc = 0; }
    if (acc >= R.dailyProfitStop || acc <= -R.circuitBreaker) continue;
    acc += f.net;
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
  const rnd = mul(seed), n = keys.length, idx = new Array(WIN);
  const wins = maps.map(() => 0);
  const arrs = maps.map(m => keys.map(k => m.get(k) ?? 0));
  const buf = new Array(WIN);
  for (let d = 0; d < DRAWS; d++) {
    let m = 0;
    while (m < WIN) { const st = Math.floor(rnd() * Math.max(1, n - BLOCK));
      for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = (st + j) % n; }
    for (let b = 0; b < maps.length; b++) {
      for (let k = 0; k < WIN; k++) buf[k] = arrs[b][idx[k]];
      wins[b] += ev(buf);
    }
  }
  return wins.map(w => (100 * w) / DRAWS);
}
function pairedDelta(a, b, keys, seed) {
  const rnd = mul(seed), n = keys.length, idx = new Array(WIN);
  const A2 = keys.map(k => a.get(k) ?? 0), B2 = keys.map(k => b.get(k) ?? 0);
  const bA = new Array(WIN), bB = new Array(WIN), ds = [];
  const CH = 40, per = Math.floor(DRAWS / CH);
  for (let c = 0; c < CH; c++) {
    let wa = 0, wb = 0;
    for (let d = 0; d < per; d++) {
      let m = 0;
      while (m < WIN) { const st = Math.floor(rnd() * Math.max(1, n - BLOCK));
        for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = (st + j) % n; }
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

const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
const MID = T0 + (T1 - T0) / 2, Y12 = T1 - 365 * 86400000, Y26 = Date.UTC(2026, 0, 1);
const SLICES = [["early half", T0, MID], ["late half", MID, T1],
                ["last 12m", Y12, T1], ["2026", Y26, T1], ["ALL", T0, T1]];

// The full grid again, this time with the realistic fill, so the conclusion is
// about the IDEA and not about one setting of it.
const LOTS = [[2, 0.25], [4, 0.5], [6, 0.75]];
const TRIGS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const CFG = [["ship (no partial)", 0, 0, true]];
for (const [lot, frac] of LOTS)
  for (const t of TRIGS)
    CFG.push([`${lot} of 8 @ ${(t * 1.75).toFixed(2)}xATR`, t, frac, true]);
const books = CFG.map(([, t, f, pess]) => replay(t, f, pess));

console.log("\nWITHIN-BAR ORDERING: does the finding survive the pessimistic fill?\n");
console.log("On a bar that trades through BOTH levels, the optimistic run closes");
console.log("everything at the full target; the realistic one fills the partial at");
console.log("its own price first. If the edge lives on that assumption, it is not real.\n");
let hdr = "  config                  fires";
for (const [nm] of SLICES) hdr += nm.padStart(14);
console.log(hdr);
const cols = [];
for (const [, lo, hi] of SLICES) {
  const maps = books.map(b => dayMap(b.fills, lo, hi));
  const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  cols.push({ ps: pairedPass(maps, keys, 4242), maps, keys });
}
CFG.forEach(([lbl, , f], i) => {
  if (i && (i - 1) % TRIGS.length === 0) console.log("");
  let row = "  " + lbl.padEnd(23) + (f ? books[i].fireRate.toFixed(0) + "%" : "  -").padStart(5);
  cols.forEach(c => {
    const v = c.ps[i], d = v - c.ps[0];
    row += (v.toFixed(1) + "%" + (i === 0 ? "" : ` ${d >= 0 ? "+" : ""}${d.toFixed(1)}`)).padStart(14);
  });
  console.log(row);
});
console.log("\n  config                 trades    pf     $/day   sd/day    net");
[0, 6, 12, 18].forEach((i) => {
  const lbl = CFG[i][0];
  const v = [...cols[4].maps[i].values()];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  let gw = 0, gl = 0, tot = 0;
  for (const f of books[i].fills) { tot += f.net; if (f.net > 0) gw += f.net; else gl -= f.net; }
  console.log(`  ${lbl.padEnd(22)}${String(books[i].fills.length).padStart(6)}  ${(gw / gl).toFixed(3)}  ` +
    `${("$" + mean.toFixed(0)).padStart(6)}  ${("$" + sd.toFixed(0)).padStart(6)}  ${("$" + (tot / 1000).toFixed(0) + "k").padStart(6)}`);
});
