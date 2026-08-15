// Can the confirmation be kept while entering 0.15xATR cheaper?
//
// THE PROPOSAL. The signal fires at the Donchian break, and the stop entry sits
// 0.15xATR beyond it, so every fill pays that 0.15. If the move could be DETECTED
// 0.15xATR earlier, the same confirmation would deliver a fill at the level the
// original signal fired at -- the confirmation for free.
//
// WHAT IS ALREADY TRUE. The bracket is anchored to the SIGNAL price, not to the
// fill, in both the replay and the bot. So today:
//     fill at   ep + 0.15 ATR
//     TP  at    ep + 1.75 ATR   ->  1.60 ATR away from the fill
//     SL  at    ep - 5.00 ATR   ->  5.15 ATR away from the fill
// The target is ALREADY 0.15 nearer and the stop 0.15 further. On a driftless
// walk that is a win rate of 5.15/6.75 = 76.3%, and the book measures 77.1%.
// So the win-rate half of the proposal is already collected.
//
// WHAT IS NOT SETTLED, and what this measures. Detecting earlier would move the
// FILL down 0.15 ATR while leaving the bracket where it is, which is a genuinely
// better entry price on every trade. Optional stopping says a better entry and a
// worse stop:target ratio cancel exactly on a driftless walk, so this can only
// pay if the confirmation SURVIVES being asked for earlier. The confirmation
// surface already hinted it might: at a one-bar delay, triggers of 0.05, 0.10 and
// 0.15 were indistinguishable (48.5 / 47.5 / 47.8), which says the value is in
// the WAIT, not the distance.
//
// Implementation: arm when close crosses DH - k x ATR instead of DH, with
// everything else byte-identical. k = 0 is what ships. A pure-wait control (no
// price trigger at all, market at the next open) isolates the two channels.
//
// Usage:  node research/early_detect.mjs

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
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const n = tf.close.length;

// EARLY DETECTION: arm when price is within k x ATR of the channel instead of
// requiring it to have broken. k = 0 reproduces the shipped signal exactly.
function buildSig(k) {
  const raw = new Int8Array(n);
  for (let i = 30; i < n; i++) {
    if (ax[i] < 25) continue;
    const pad = k * (A[i] > 0 ? A[i] : 0);
    if (tf.close[i] > dh[i] - pad) raw[i] = 1;
    else if (tf.close[i] < dl[i] + pad) raw[i] = -1;
  }
  return applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
}

// trig < 0 means: no price condition at all, enter at market on the next bar's
// open. That is the pure-wait control.
function replay(sig, trig) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const out = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0;
  let qty = 0, notional = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0;
  let curTday = -1e9, dayReal = 0, capHit = false, nSig = 0, nFill = 0, edge = 0;
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
      else if (i > armBar) {
        const hit = trig < 0 ? true
                  : (armDir === 1 ? H[i] >= armPx : L[i] <= armPx);
        if (hit) {
          const fill = trig < 0 ? O[i] : armPx;
          pos = armDir; qty = TOTAL;
          ep = armEp; slD = armSl; tpD = armTp; entTime = TS[i];
          notional = (pos === 1 ? fill + slip : fill - slip) * qty;
          // how far past the signal reference the fill landed, in ATRs
          edge += (fill - armEp) * armDir / armTp * 1.75;
          armDir = 0; nFill++;
        }
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
      armDir = s; armBar = i; armBy = i + ADD_WIN; armEp = O[i];
      armPx = O[i] + s * Math.max(a * Math.max(trig, 0), tick);
      armSl = Math.max(a * 5, tick); armTp = Math.max(a * 1.75, tick);
    }
  }
  return { trades: out, nSig, nFill, avgEdge: nFill ? edge / nFill : 0 };
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

const CFG = [
  ["k=0.00 @0.15 (ships)", 0.00, 0.15],
  ["detect 0.05 early", 0.05, 0.15],
  ["detect 0.10 early", 0.10, 0.15],
  ["detect 0.15 early", 0.15, 0.15],
  ["detect 0.25 early", 0.25, 0.15],
  ["detect 0.40 early", 0.40, 0.15],
  ["CONTROL: pure wait, no trigger", 0.00, -1],
  ["CONTROL: trigger 1 tick only", 0.00, 0.00],
];
const books = CFG.map(([, k, t]) => replay(buildSig(k), t));
const cols = SLICES.map(([, lo, hi]) => {
  const maps = books.map(b => dayMap(b.trades, lo, hi));
  const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  return pairedPass(maps, keys, 4242);
});

console.log("\nDETECTING THE MOVE EARLIER — same confirmation, cheaper fill?\n");
let hdr = "  config                          sig   fills  fill%   win%";
for (const [nm] of SLICES) hdr += nm.padStart(9);
console.log(hdr + "     pf     net");
console.log("  " + "-".repeat(hdr.length + 14));
CFG.forEach(([lbl], i) => {
  const b = books[i], t = b.trades;
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const x of t) { tot += x.pnl; if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; }
  console.log("  " + lbl.padEnd(30) + String(b.nSig).padStart(6) + String(t.length).padStart(7) +
    ((100 * b.nFill / b.nSig).toFixed(0) + "%").padStart(6) +
    ((100 * w / t.length).toFixed(1) + "%").padStart(7) +
    SLICES.map((_, j) => cols[j][i].toFixed(1).padStart(9)).join("") +
    `  ${(gw / gl).toFixed(3)}  ${("$" + (tot / 1000).toFixed(0) + "k").padStart(6)}`);
});

console.log("\n  PAIRED CI vs the shipped k=0.00:\n");
console.log("   config                        slice   mean delta      95% band   P(better)");
for (const i of [3, 6]) {
  SLICES.forEach(([nm, lo, hi], j) => {
    const ma = dayMap(books[i].trades, lo, hi), mb = dayMap(books[0].trades, lo, hi);
    const keys = [...new Set([...ma.keys(), ...mb.keys()])].sort((a, b) => a - b);
    const d = pairedDelta(ma, mb, keys, 9100 + j);
    console.log(`   ${(j === 0 ? CFG[i][0] : "").padEnd(30)}${nm.padEnd(7)}` +
      `${((d.mean >= 0 ? "+" : "") + d.mean.toFixed(2) + "pp").padStart(11)}   ` +
      `${(d.lo.toFixed(1) + " .. " + d.hi.toFixed(1)).padStart(14)}  ${(100 * d.pWin).toFixed(0).padStart(6)}%`);
  });
  console.log("");
}
