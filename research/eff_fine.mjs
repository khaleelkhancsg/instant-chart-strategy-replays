// The efficiency gate at 0.01 resolution from 0.25 to 0.75, under stop entry.
//
// The reasoning is sound and has already been right once: changing the tranche
// split moved the sizing optimum (8 vs 10 lots), so changing the entry structure
// may move the gate too. eff_min 0.5 was chosen when the signal WAS the
// commitment -- a market order for the full size. Now the signal only arms a
// stop, and price has to confirm before anything is bought, so the confirmation
// already rejects roughly 13% of signals. The gate may be doing that work twice.
//
// A 0.01 sweep over 36 settings is also the most overfittable thing in this
// project, so the reporting is built to expose that rather than hide it:
//
//   - the NOISE FLOOR is computed from adjacent settings. Two neighbours differ
//     only in a handful of trades, so any gap between them is noise by
//     construction; a claimed edge smaller than that is not resolvable here.
//   - both halves of history are shown separately, and the ranking is on the
//     WORSE of them, never the average.
//   - the shipped value's rank is printed. Finding that 0.5 ranks 1st would be a
//     stronger result than finding some 0.37 that beats it by a noise-width.
//
// Usage:  node research/eff_fine.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 15000, BLOCK = 5, WIN = 21, TOTAL = 8;
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

// STOP-ENTRY replay, exactly as shipped: the signal arms a stop for the full
// size at +0.15xATR, live from the NEXT bar, expiring after 10 bars.
function replay(sig) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const out = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0;
  let qty = 0, notional = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0;
  let curTday = -1e9, dayReal = 0, capHit = false, nSig = 0, nFill = 0;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (rawExit, i, exact) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    out.push({ tday: TD[i], entryTime: entTime, pnl: net });
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
        armDir = 0; nFill++;
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
      nSig++;
      armDir = s; armPx = O[i] + s * Math.max(a * TRIG, tick);
      armBar = i; armBy = i + ADD_WIN; armEp = O[i];
      armSl = Math.max(a * 5, tick); armTp = Math.max(a * 1.75, tick);
    }
  }
  return { trades: out, nSig, nFill };
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

const EFFS = [];
for (let e = 25; e <= 75; e++) EFFS.push(e / 100);
const books = EFFS.map(e =>
  replay(applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: e })));
const cols = SLICES.map(([, lo, hi]) => {
  const maps = books.map(b => dayMap(b.trades, lo, hi));
  const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  return pairedPass(maps, keys, 4242);
});

console.log("\nEFFICIENCY GATE at 0.01 resolution, under 0+8 stop entry\n");
console.log("  eff   signals  filled   early    late     12m    2026     ALL      pf      net");
console.log("  " + "-".repeat(76));
EFFS.forEach((e, i) => {
  const t = books[i].trades;
  let gw = 0, gl = 0, tot = 0;
  for (const x of t) { tot += x.pnl; if (x.pnl > 0) gw += x.pnl; else gl -= x.pnl; }
  const mark = Math.abs(e - 0.50) < 1e-9 ? " <-- ships" : "";
  console.log(`  ${e.toFixed(2)}  ${String(books[i].nSig).padStart(7)}  ${String(t.length).padStart(6)}  ` +
    SLICES.map((_, j) => cols[j][i].toFixed(1).padStart(6)).join("  ") +
    `  ${(gw / gl).toFixed(3)}  ${("$" + (tot / 1000).toFixed(0) + "k").padStart(6)}${mark}`);
});

// noise floor: neighbours differ by a handful of trades, so the gap between them
// is noise by construction.
let ssum = 0;
for (let i = 1; i < EFFS.length; i++) ssum += Math.abs(cols[4][i] - cols[4][i - 1]);
const floor = ssum / (EFFS.length - 1);
console.log(`\n  noise floor (mean |step| between adjacent 0.01 settings): ${floor.toFixed(2)}pp`);
console.log("  Anything inside that band is not distinguishable at this resolution.\n");

const scored = EFFS.map((e, i) => ({
  e, worse: Math.min(cols[0][i], cols[1][i]),
  early: cols[0][i], late: cols[1][i], m12: cols[2][i], y26: cols[3][i], all: cols[4][i],
})).sort((a, b) => b.worse - a.worse);
const ship = scored.find(s => Math.abs(s.e - 0.50) < 1e-9);
console.log("  ranked on the WORSE half:\n");
console.log("   rank   eff   worse   early    late     12m    2026     ALL   vs 0.50");
scored.slice(0, 10).forEach((s, r) => {
  console.log(`   ${String(r + 1).padStart(4)}  ${s.e.toFixed(2)}  ${s.worse.toFixed(1).padStart(6)}  ` +
    `${s.early.toFixed(1).padStart(6)}  ${s.late.toFixed(1).padStart(6)}  ${s.m12.toFixed(1).padStart(6)}  ` +
    `${s.y26.toFixed(1).padStart(6)}  ${s.all.toFixed(1).padStart(6)}  ` +
    `${((s.all - ship.all >= 0 ? "+" : "") + (s.all - ship.all).toFixed(1)).padStart(6)}` +
    (Math.abs(s.e - 0.50) < 1e-9 ? "  <-- ships" : ""));
});
console.log(`\n   0.50 ranks ${scored.findIndex(s => s === ship) + 1} of ${EFFS.length} on the worse half`);
const best = scored[0];
console.log(`   best worse-half is ${best.e.toFixed(2)}, ` +
  `${(best.worse - ship.worse).toFixed(2)}pp above 0.50 — ` +
  `${Math.abs(best.worse - ship.worse) < floor ? "INSIDE the noise floor" : "outside the floor"}`);

// ── per-slice noise floors ──────────────────────────────────────────
// The ALL column has a 1.34pp floor, but 2026 has ~125 trading days against
// 1,667, so its floor is much wider and a 4pp swing there may be nothing at all.
// Without this the two columns get read as if they carried equal weight.
console.log("\n\n  NOISE FLOOR BY SLICE (mean |step| between adjacent 0.01 settings)\n");
const floors = SLICES.map(([nm], j) => {
  let s = 0;
  for (let i = 1; i < EFFS.length; i++) s += Math.abs(cols[j][i] - cols[j][i - 1]);
  return { nm, f: s / (EFFS.length - 1) };
});
floors.forEach(({ nm, f }) => console.log(`    ${nm.padEnd(8)} +-${f.toFixed(2)}pp`));

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
const iOf = (e) => EFFS.findIndex(x => Math.abs(x - e) < 1e-9);
// Candidates chosen FROM the sweep rather than hardcoded: the best on the worse
// half, the best on 12m, and the best on 2026. If those three disagree, that
// disagreement is the finding.
const bestBy = (j) => EFFS[cols[j].indexOf(Math.max(...cols[j]))];
const bestWorse = scored[0].e;
const cands = [...new Set([bestWorse, bestBy(2), bestBy(3)])].filter(e => Math.abs(e - 0.50) > 1e-9);
console.log(`
  best on worse half: ${bestWorse.toFixed(2)}   ` +
            `best on 12m: ${bestBy(2).toFixed(2)}   best on 2026: ${bestBy(3).toFixed(2)}`);
for (const cand of cands) {
  console.log(`\n  PAIRED CI: eff ${cand.toFixed(2)} minus eff 0.50\n`);
  console.log("   slice     mean delta      95% band     P(better)   vs slice floor");
  SLICES.forEach(([nm, lo, hi], j) => {
    const ma = dayMap(books[iOf(cand)].trades, lo, hi);
    const mb = dayMap(books[iOf(0.50)].trades, lo, hi);
    const keys = [...new Set([...ma.keys(), ...mb.keys()])].sort((a, b) => a - b);
    const d = pairedDelta(ma, mb, keys, 8800 + j);
    const beyond = Math.abs(d.mean) > floors[j].f ? "outside" : "INSIDE (noise)";
    console.log(`   ${nm.padEnd(9)}${((d.mean >= 0 ? "+" : "") + d.mean.toFixed(2) + "pp").padStart(11)}   ` +
      `${(d.lo.toFixed(1) + " .. " + d.hi.toFixed(1)).padStart(14)}   ${(100 * d.pWin).toFixed(0).padStart(7)}%   ${beyond}`);
  });
}
