// Extend the one mechanism that works, rather than tune it further.
//
// confirm_surface.mjs mapped delay x trigger over 24 cells and the shipped
// setting (1 bar, 0.15xATR) came first on the worse-half criterion, on a smooth
// monotone surface. So the mechanism is at its optimum in the two dimensions it
// has. It has never been asked to work in two others:
//
//   1. HOW SMALL the first commitment is. 2 of 8 was picked early, alongside the
//      trigger, before the one-bar deferral was understood — so it was chosen
//      under a different model of what the add does.
//   2. WHETHER CONFIRMATION CAN COMPOUND. Right now confirmation is asked once
//      and answers a 4x size decision. If a single bar of follow-through is worth
//      15pp, a second, further round of follow-through might justify committing
//      the last tranche later still — a real pyramid rather than two tranches.
//
// The second is the interesting one, and it is the user's original suggestion
// taken to its conclusion. It also has an obvious failure mode worth stating in
// advance: each extra tranche buys its confirmation with a WORSE average entry,
// and the platform cap tightens as size grows, so the last tranche is added at
// the worst price with the least room. If it fails, that is why.
//
// Ranked on the worse of the two halves, with the recent slices reported and a
// noise floor from neighbouring cells, as usual.
//
// Usage:  node research/pyramid2.mjs

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

// tranches: [{lots, trig, delay}] where trig/delay are relative to ENTRY.
// A tranche with lots but no trig is taken at market on the signal.
function replay(tranches) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const n = tf.close.length, pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const fills = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, entBar = 0, aATR = 0;
  let qty = 0, notional = 0, pend = [];
  let curTday = -1e9, dayReal = 0, capHit = false;
  const filled = new Array(tranches.length).fill(0);
  let nTr = 0;
  const avgFill = () => notional / qty;
  const close_ = (rawExit, i, exact) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    fills.push({ tday: TD[i], entryTime: entTime, pnl: net, qty });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; notional = 0; pend = [];
  };
  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i], dayReal = 0, capHit = false; }
    if (pos !== 0) {
      // resting tranches, each with its own trigger and its own live-from bar
      for (const p of pend) {
        if (p.done) continue;
        if (i - entBar < p.delay || i > entBar + ADD_WIN) continue;
        if (!(pos === 1 ? H[i] >= p.px : L[i] <= p.px)) continue;
        notional += (pos === 1 ? p.px + slip : p.px - slip) * p.lots;
        qty += p.lots; p.done = true; filled[p.idx]++;
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
      ep = O[i]; entTime = TS[i]; pos = s; entBar = i; aATR = a; nTr++;
      slD = Math.max(a * 5, tick); tpD = Math.max(a * 1.75, tick);
      qty = tranches[0].lots;
      notional = (pos === 1 ? ep + slip : ep - slip) * qty;
      pend = tranches.slice(1).map((t, k) => ({
        idx: k + 1, lots: t.lots, delay: t.delay,
        px: ep + pos * Math.max(a * t.trig, tick), done: false,
      }));
    }
  }
  return { fills, nTr, filled };
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

const T = (lots, trig, delay) => ({ lots, trig, delay });
const CFG = [
  ["2+6 @0.15 (ships)", [T(2), T(6, 0.15, 1)]],
  // --- 1. how small should the first commitment be? ---
  ["1+7 @0.15", [T(1), T(7, 0.15, 1)]],
  ["3+5 @0.15", [T(3), T(5, 0.15, 1)]],
  ["4+4 @0.15", [T(4), T(4, 0.15, 1)]],
  ["6+2 @0.15", [T(6), T(2, 0.15, 1)]],
  // --- 2. can confirmation compound? two adds, each needing its own ---
  ["2+3+3 @0.15/0.35", [T(2), T(3, 0.15, 1), T(3, 0.35, 2)]],
  ["2+3+3 @0.15/0.50", [T(2), T(3, 0.15, 1), T(3, 0.50, 2)]],
  ["2+3+3 @0.10/0.30", [T(2), T(3, 0.10, 1), T(3, 0.30, 2)]],
  ["2+2+4 @0.15/0.35", [T(2), T(2, 0.15, 1), T(4, 0.35, 2)]],
  ["2+4+2 @0.15/0.35", [T(2), T(4, 0.15, 1), T(2, 0.35, 2)]],
  ["1+3+4 @0.15/0.35", [T(1), T(3, 0.15, 1), T(4, 0.35, 2)]],
  // same trigger twice, only the WAIT differs — isolates time from distance
  ["2+3+3 @0.15/0.15 d1/d3", [T(2), T(3, 0.15, 1), T(3, 0.15, 3)]],
  // three adds
  ["2+2+2+2 ladder", [T(2), T(2, 0.10, 1), T(2, 0.25, 2), T(2, 0.45, 3)]],
];
const books = CFG.map(([, tr]) => replay(tr));
const cols = SLICES.map(([, lo, hi]) => {
  const maps = books.map(b => dayMap(b.fills, lo, hi));
  const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  return pairedPass(maps, keys, 4242);
});

console.log("\nPYRAMID — does confirmation compound?\n");
let hdr = "  config                  avg lots";
for (const [nm] of SLICES) hdr += nm.padStart(12);
console.log(hdr + "     pf      net");
CFG.forEach(([lbl], i) => {
  const f = books[i].fills;
  let gw = 0, gl = 0, tot = 0;
  for (const x of f) { tot += x.pnl; if (x.pnl > 0) gw += x.pnl; else gl -= x.pnl; }
  const avgQ = f.reduce((s, x) => s + x.qty, 0) / f.length;
  if (i === 1 || i === 5) console.log("  " + "-".repeat(hdr.length + 14));
  let row = "  " + lbl.padEnd(24) + avgQ.toFixed(2).padStart(6);
  cols.forEach(c => {
    const v = c[i], d = v - c[0];
    row += (v.toFixed(1) + (i === 0 ? "" : ` ${d >= 0 ? "+" : ""}${d.toFixed(1)}`)).padStart(12);
  });
  console.log(row + `  ${(gw / gl).toFixed(3)}  ${("$" + (tot / 1000).toFixed(0) + "k").padStart(6)}`);
});

const scored = CFG.map(([lbl], k) => ({
  lbl, worse: Math.min(cols[0][k], cols[1][k]), all: cols[4][k],
  m12: cols[2][k], y26: cols[3][k],
})).sort((a, b) => b.worse - a.worse);
console.log("\n  ranked on the WORSE of the two halves:\n");
scored.slice(0, 6).forEach((s, r) => {
  console.log(`   ${(r + 1 + ".").padEnd(3)} ${s.lbl.padEnd(26)}worse ${s.worse.toFixed(1)}   ` +
    `12m ${s.m12.toFixed(1)}   2026 ${s.y26.toFixed(1)}   ALL ${s.all.toFixed(1)}`);
});
console.log(`\n   shipped rank: ${scored.findIndex(s => s.lbl.includes("ships")) + 1} of ${CFG.length}`);

// ── does 1+7 survive being moved off its cell? ───────────────────────
// The first-tranche sweep is monotone (1 > 2 > 3 > 4 > 6), which is a gradient
// rather than a spike, and 1 is the boundary — there is no smaller tranche, so
// nothing was fitted. But it was measured at ONE trigger and ONE delay. If the
// gain is a property of the mechanism it should hold across that surface too;
// if it only exists at 0.15/1 it is the volume filter all over again.
console.log("\n\nROBUSTNESS: 1+7 minus 2+6, across the confirmation surface");
console.log("(positive = the smaller first tranche is better in that cell)\n");
const TRIGS = [0.05, 0.10, 0.15, 0.25, 0.40];
const DELAYS = [1, 2, 3];
const pairs = [];
for (const d of DELAYS) for (const t of TRIGS) {
  pairs.push([T(1), T(7, t, d)]);
  pairs.push([T(2), T(6, t, d)]);
}
const pb = pairs.map(tr => replay(tr));
const pcols = SLICES.map(([, lo, hi]) => {
  const maps = pb.map(b => dayMap(b.fills, lo, hi));
  const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  return pairedPass(maps, keys, 4242);
});
let h2 = "  delay |";
for (const t of TRIGS) h2 += ("  " + t.toFixed(2)).padStart(9);
console.log(h2 + "     (ALL slice)");
let wins = 0, tot = 0, sumd = 0;
DELAYS.forEach((d, di) => {
  let row = `  ${String(d).padStart(5)} |`;
  TRIGS.forEach((t, ti) => {
    const k = (di * TRIGS.length + ti) * 2;
    const dd = pcols[4][k] - pcols[4][k + 1];
    sumd += dd; tot++; if (dd > 0) wins++;
    row += ((dd >= 0 ? "+" : "") + dd.toFixed(1)).padStart(9);
  });
  console.log(row);
});
console.log(`\n  1+7 wins ${wins} of ${tot} cells, mean advantage ` +
            `${(sumd / tot >= 0 ? "+" : "") + (sumd / tot).toFixed(2)}pp`);

// paired CI on the shipped cell specifically
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
console.log("\n  PAIRED CI on 1+7 vs 2+6 at the shipped 0.15/1 cell:\n");
console.log("   slice        mean delta      95% band     P(better)");
SLICES.forEach(([nm, lo, hi], j) => {
  const m1 = dayMap(books[1].fills, lo, hi), m0 = dayMap(books[0].fills, lo, hi);
  const keys = [...new Set([...m1.keys(), ...m0.keys()])].sort((a, b) => a - b);
  const d = pairedDelta(m1, m0, keys, 6100 + j);
  console.log(`   ${nm.padEnd(11)}${((d.mean >= 0 ? "+" : "") + d.mean.toFixed(2) + "pp").padStart(11)}   ` +
    `${(d.lo.toFixed(1) + " .. " + d.hi.toFixed(1)).padStart(14)}   ${(100 * d.pWin).toFixed(0).padStart(7)}%`);
});
