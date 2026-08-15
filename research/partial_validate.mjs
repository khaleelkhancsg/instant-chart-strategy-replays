// Does taking part of the position off before the target actually survive?
//
// giveback_test.mjs found that every rule which MOVES THE STOP (breakeven,
// trailing, give-back-fraction) loses money, but that a PARTIAL exit raises net
// P&L 15% and profit factor 1.286 -> 1.351. Before that becomes a recommendation
// it has to clear the bar the rest of this project uses:
//
//   1. both time halves, not the average — the trap that killed 3.5/2.5
//   2. the recent slice (12m, 2026) separately
//   3. a PAIRED bootstrap, so base and variant see the identical resampled days
//      and the comparison is not swamped by draw-to-draw noise
//   4. a noise floor from adjacent parameter settings
//   5. a mechanism test: if the gain comes from the cap relaxing as size falls,
//      it must SHRINK when the cap is switched off. A gain that survives the
//      cap being removed is a different (and more suspicious) claim.
//
// Usage:  node research/partial_validate.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 20000, BLOCK = 5, WIN = 21, TOTAL = 8;
const Q1 = 2, ADD_TRIG = 0.15, ADD_WIN = 10;

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

// Returns fills tagged with the calendar day, so books can be compared on the
// SAME days rather than on independently drawn ones.
function replay(trig, frac, CAP) {
  const { open: O, high: H, low: L, close: C, ctMin: CT, tday: TD, ts: TS } = tf;
  const n = O.length, pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const fills = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  let curTday = -1e9, dayReal = 0, hit = false, tookPartial = false;

  const avgFill = () => notional / qty;
  const bank = (rawExit, i, exact, q) => {
    const fees = perSide * 2 * q;
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact : (xp - avgFill()) * pos * pv * q - fees;
    fills.push({ tday: TD[i], entryTime: entTime, net });
    dayReal += net;
    if (CAP > 0 && dayReal <= -CAP) hit = true;
    return net;
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
      const lossPx = CAP > 0 ? avgFill() - dir * ((CAP + dayReal) / (pv * qty)) : 0;
      const rawSl = ep - dir * slD;
      const sl = CAP > 0 ? (dir === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx)) : rawSl;
      const isCap = CAP > 0 && (dir === 1 ? (sl === lossPx && lossPx > rawSl)
                                          : (sl === lossPx && lossPx < rawSl));
      const tp = ep + dir * tpD;
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
            notional -= af * qOut; qty -= qOut; tookPartial = true;
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
      ep = O[i]; entTime = TS[i]; pos = s;
      slD = Math.max(a * 5, tick); tpD = Math.max(a * 1.75, tick);
      qty = Q1; pendQty = TOTAL - Q1;
      addPx = ep + pos * Math.max(a * ADD_TRIG, tick);
      addBy = i + ADD_WIN;
      notional = (pos === 1 ? ep + slip : ep - slip) * qty;
      tookPartial = false;
    }
  }
  return fills;
}

// Day P&L keyed by trading day, with the daily entry blocks applied.
function dayMap(fills, lo, hi) {
  const m = new Map();
  let day = null, acc = 0;
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

// PAIRED bootstrap: one set of day INDICES per draw, applied to every book.
function pairedPass(books, keys, seed) {
  const rnd = mul(seed), n = keys.length;
  const idx = new Array(WIN);
  const wins = books.map(() => 0);
  const arrs = books.map(m => keys.map(k => m.get(k) ?? 0));
  const buf = new Array(WIN);
  for (let d = 0; d < DRAWS; d++) {
    let m = 0;
    while (m < WIN) {
      const st = Math.floor(rnd() * Math.max(1, n - BLOCK));
      for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = (st + j) % n;
    }
    for (let b = 0; b < books.length; b++) {
      for (let k = 0; k < WIN; k++) buf[k] = arrs[b][idx[k]];
      wins[b] += ev(buf);
    }
  }
  return wins.map(w => (100 * w) / DRAWS);
}
// Paired CI on the DIFFERENCE between two books.
function pairedDelta(a, b, keys, seed) {
  const rnd = mul(seed), n = keys.length, idx = new Array(WIN);
  const A2 = keys.map(k => a.get(k) ?? 0), B2 = keys.map(k => b.get(k) ?? 0);
  const bufA = new Array(WIN), bufB = new Array(WIN);
  const deltas = [];
  const CH = 40, per = Math.floor(DRAWS / CH);
  for (let c = 0; c < CH; c++) {
    let wa = 0, wb = 0;
    for (let d = 0; d < per; d++) {
      let m = 0;
      while (m < WIN) {
        const st = Math.floor(rnd() * Math.max(1, n - BLOCK));
        for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = (st + j) % n;
      }
      for (let k = 0; k < WIN; k++) { bufA[k] = A2[idx[k]]; bufB[k] = B2[idx[k]]; }
      wa += ev(bufA); wb += ev(bufB);
    }
    deltas.push((100 * (wa - wb)) / per);
  }
  deltas.sort((x, y) => x - y);
  const mean = deltas.reduce((s, v) => s + v, 0) / deltas.length;
  return { mean, lo: deltas[1], hi: deltas[deltas.length - 2],
           pWin: deltas.filter(v => v > 0).length / deltas.length };
}

const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
const MID = T0 + (T1 - T0) / 2;
const Y12 = T1 - 365 * 86400000;
const Y26 = Date.UTC(2026, 0, 1);
const SLICES = [["early half", T0, MID], ["late half", MID, T1],
                ["last 12m", Y12, T1], ["2026 only", Y26, T1], ["ALL", T0, T1]];

const CANDS = [[0, 0], [0.5, 0.25], [0.6, 0.5], [0.7, 0.5], [0.8, 0.5], [0.8, 0.25], [0.9, 0.5]];
const raw1000 = CANDS.map(([t, f]) => replay(t, f, 1000));

console.log("\n1. PASS RATE by slice, paired draws within each slice (-$1000 cap)\n");
let hdr = "   config          ";
for (const [nm] of SLICES) hdr += nm.padStart(12);
console.log(hdr);
for (const [nm, lo, hi] of SLICES) { /* keys built per slice below */ }
const table = CANDS.map(() => []);
for (const [nm, lo, hi] of SLICES) {
  const maps = raw1000.map(f => dayMap(f, lo, hi));
  const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  const ps = pairedPass(maps, keys, 4242);
  ps.forEach((v, i) => table[i].push(v));
}
CANDS.forEach(([t, f], i) => {
  const lbl = f === 0 ? "off (ship)" : `${(f * 100).toFixed(0)}% @ ${t.toFixed(2)}xTP`;
  let row = "   " + lbl.padEnd(17);
  table[i].forEach((v, j) => {
    const d = v - table[0][j];
    row += (v.toFixed(1) + (i === 0 ? "" : (d >= 0 ? "+" : "") + d.toFixed(1))).padStart(12);
  });
  console.log(row);
});
console.log("   (second number is pp vs 'off' on the SAME resampled days)");

console.log("\n2. PAIRED bootstrap CI on the difference vs 'off', all history\n");
console.log("   config              mean delta      95% band      P(better)");
{
  const maps = raw1000.map(f => dayMap(f, T0, T1));
  const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  for (let i = 1; i < CANDS.length; i++) {
    const [t, f] = CANDS[i];
    const d = pairedDelta(maps[i], maps[0], keys, 909 + i);
    console.log(`   ${(`${(f * 100).toFixed(0)}% @ ${t.toFixed(2)}xTP`).padEnd(18)}` +
      `${((d.mean >= 0 ? "+" : "") + d.mean.toFixed(2) + "pp").padStart(11)}   ` +
      `${(d.lo.toFixed(1) + " .. " + d.hi.toFixed(1)).padStart(14)}   ` +
      `${(100 * d.pWin).toFixed(0).padStart(6)}%`);
  }
}

console.log("\n3. P&L metrics — the column with statistical power\n");
console.log("   config             trades    win%     pf     $/trade      net");
for (let i = 0; i < CANDS.length; i++) {
  const [t, f] = CANDS[i];
  const sel = raw1000[i];
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const x of sel) { tot += x.net; if (x.net > 0) { w++; gw += x.net; } else gl -= x.net; }
  const lbl = f === 0 ? "off (ship)" : `${(f * 100).toFixed(0)}% @ ${t.toFixed(2)}xTP`;
  console.log(`   ${lbl.padEnd(18)}${String(sel.length).padStart(6)}  ` +
    `${((100 * w) / sel.length).toFixed(1).padStart(5)}  ${(gw / gl).toFixed(3)}  ` +
    `${("$" + (tot / sel.length).toFixed(2)).padStart(9)}  ${("$" + (tot / 1000).toFixed(0) + "k").padStart(8)}`);
}

console.log("\n4. MECHANISM — is it the cap relaxing as size falls?\n");
console.log("   If the gain comes from the dollar cap sitting further away once");
console.log("   half the position is gone, removing the cap must remove the gain.\n");
console.log("   config              cap -$1000        cap OFF");
{
  const noCap = CANDS.map(([t, f]) => replay(t, f, 0));
  const m1 = raw1000.map(f => dayMap(f, T0, T1));
  const m0 = noCap.map(f => dayMap(f, T0, T1));
  const k1 = [...new Set(m1.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  const k0 = [...new Set(m0.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  const p1 = pairedPass(m1, k1, 77), p0 = pairedPass(m0, k0, 77);
  CANDS.forEach(([t, f], i) => {
    const lbl = f === 0 ? "off (ship)" : `${(f * 100).toFixed(0)}% @ ${t.toFixed(2)}xTP`;
    const d1 = p1[i] - p1[0], d0 = p0[i] - p0[0];
    console.log(`   ${lbl.padEnd(18)}${(p1[i].toFixed(1) + "%").padStart(8)} ` +
      `${(i ? (d1 >= 0 ? "+" : "") + d1.toFixed(1) : "    -").padStart(7)}   ` +
      `${(p0[i].toFixed(1) + "%").padStart(8)} ${(i ? (d0 >= 0 ? "+" : "") + d0.toFixed(1) : "    -").padStart(7)}`);
  });
}

console.log("\n5. NOISE FLOOR — mean absolute step between adjacent settings\n");
{
  const grid = [];
  for (const t of [0.5, 0.6, 0.7, 0.8, 0.9]) grid.push([t, 0.5]);
  const maps = grid.map(([t, f]) => dayMap(replay(t, f, 1000), T0, T1));
  const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  const ps = pairedPass(maps, keys, 31337);
  let s = 0;
  for (let i = 1; i < ps.length; i++) s += Math.abs(ps[i] - ps[i - 1]);
  console.log("   trigger sweep at 50% off: " + ps.map(v => v.toFixed(1)).join("  "));
  console.log(`   mean |step| between neighbours: ${(s / (ps.length - 1)).toFixed(2)}pp`);
  console.log("   Any claimed edge smaller than this is not distinguishable here.");
}
