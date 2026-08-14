// Re-open the sizing question with a 50-lot limit instead of 10.
//
// Every sizing result in this project assumed the firm capped size at 10 micros.
// At 50 the arithmetic changes qualitatively, not just quantitatively:
//
//   * The $1000 platform cap fixes the stop in DOLLARS, so the stop in POINTS
//     shrinks as size grows: 62.5 pts at 8 lots, 10 pts at 50. Against a
//     1.75xATR target that drives the ratio - and the win rate - straight down.
//   * One MNQ winner at 50 lots is ~$3,472, which EXCEEDS the entire $3,000
//     target. Passing in a single trade then trips the 50% consistency rule
//     (one day cannot be more than half the total profit), forcing more trading
//     to dilute it and re-exposing the account. The daily profit block has to be
//     swept alongside size, because $750 is meaningless when one trade pays 4x
//     that.
//
// So this sweeps size x profit block for both instruments, with the same
// early/late discipline used everywhere else.
//
// Usage:  node research/size_to_50.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 20000, BLOCK = 5, WIN = 21, CAP = 1000;
const S = (await loadStrategies()).get("donchian_eff_rth");

function load(bin, pv, label) {
  const { bars } = loadBars(bin);
  const tf = resample(bars, 2);
  const ctx = buildFilterContext(tf);
  const A = atr(tf.high, tf.low, tf.close, 14);
  const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
  const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
  const raw = new Int8Array(tf.close.length);
  for (let i = 30; i < raw.length; i++) {
    if (ax[i] < 25) continue;
    if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
  }
  const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
  const rec = bars.ts[bars.count - 1] - 365 * 86400000;
  const v = [];
  for (let i = 900; i < A.length; i++) {
    const c = tf.ctMin[i];
    if (c < 510 || c >= 900 || !(A[i] > 0) || tf.ts[i] < rec) continue;
    v.push(A[i]);
  }
  v.sort((a, b) => a - b);
  return { label, bars, tf, A, sig, pv, atr12: v[v.length >> 1], last: bars.ts[bars.count - 1] };
}
const MNQ = load("data/mnq_1m.bin", 2.0, "MNQ");
const MES = load("data/mes_1m.bin", 5.0, "MES");
const END = Math.min(MNQ.last, MES.last);
const REC = END - 365 * 86400000;

function ev(d, R) {
  let cum = 0, peak = 0, lk = false, md = -1e18;
  for (const v of d) {
    cum += v; if (v > md) md = v;
    const fl = lk ? 0 : peak - R.trailingDD;
    if (cum <= fl) return 0;
    if (cum > peak) peak = cum;
    if (R.lockAtBreakeven && !lk && peak >= R.trailingDD) lk = true;
    if (cum >= R.profitTarget && md <= 0.5 * cum) return 1;
  }
  return 0;
}
function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function pass(dd, R, seed) {
  const rnd = mul(seed), idx = new Array(WIN), n = dd.length;
  let w = 0;
  for (let k = 0; k < DRAWS; k++) {
    let m = 0;
    while (m < WIN) { const st = Math.floor(rnd() * Math.max(1, n - BLOCK));
      for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = dd[(st + j) % n]; }
    w += ev(idx, R);
  }
  return (100 * w) / DRAWS;
}
function run(M, lots, block, fromMs) {
  const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: block });
  const x = resolveExec({ ...S.execDefaults, contracts: lots, slAtrMult: 5, tpAtrMult: 1.75,
    pointValue: M.pv, slippageTicks: 1, dayLossStopUsd: CAP, dayLossStopMode: "exact" });
  const { trades } = runBrackets(M.tf, M.sig, M.A, x);
  const sel = trades.filter((t) => t.entryTime >= fromMs && t.entryTime <= END);
  const days = [];
  let day = null, p = 0;
  for (const t of sel) {
    if (t.tday !== day) { if (day !== null) days.push(p); day = t.tday; p = 0; }
    if (block > 0 && p >= block) continue;
    if (p <= -500) continue;
    p += t.pnl;
  }
  if (day !== null) days.push(p);
  if (days.length < 100) return null;
  const h = Math.floor(days.length / 2);
  return { e: pass(days.slice(0, h), R, 11), l: pass(days.slice(h), R, 22), st: tradeStats(sel) };
}

for (const M of [MNQ, MES]) {
  const cap12 = CAP / (M.pv);
  console.log(`\n  ${M.label}  —  12-month ATR ${M.atr12.toFixed(2)} pts, $${M.pv}/point`);
  console.log(`   lots  stop pts  xATR   1 win $   PASS at block $750 / $1500 / $3000 / off   (early|LATE)`);
  for (const lots of [8, 14, 20, 30, 40, 50]) {
    const stopPts = Math.min(5 * M.atr12, CAP / (M.pv * lots));
    const winUsd = 1.75 * M.atr12 * M.pv * lots;
    const cells = [];
    for (const block of [750, 1500, 3000, 0]) {
      const r = run(M, lots, block, REC);
      cells.push(r ? `${r.e.toFixed(0)}|${r.l.toFixed(0)}`.padStart(8) : "     n/a");
    }
    console.log(`   ${String(lots).padStart(4)}  ${stopPts.toFixed(1).padStart(8)}  ${(stopPts / M.atr12).toFixed(2).padStart(4)}  ` +
      `${("$" + Math.round(winUsd)).padStart(7)}   ${cells.join(" ")}`);
  }
}

// full detail on the best few, ranked on LATE
console.log(`\n\n  RANKED ON LATE (last 12 months of the common span), both instruments\n`);
console.log("   inst  lots  block   early   LATE    pf     $/trade   trades");
const all = [];
for (const M of [MNQ, MES])
  for (const lots of [8, 10, 14, 20, 30, 40, 50])
    for (const block of [750, 1500, 3000, 0]) {
      const r = run(M, lots, block, REC);
      if (r && r.st.n > 150) all.push({ M, lots, block, r });
    }
all.sort((a, b) => b.r.l - a.r.l);
for (const a of all.slice(0, 14))
  console.log(`   ${a.M.label}  ${String(a.lots).padStart(4)}  ${(a.block ? "$" + a.block : "off").padStart(5)}  ` +
    `${a.r.e.toFixed(1).padStart(6)}% ${a.r.l.toFixed(1).padStart(6)}%  ${a.r.st.profitFactor.toFixed(3)}  ` +
    `${("$" + a.r.st.expectancy.toFixed(2)).padStart(8)}  ${String(a.r.st.n).padStart(6)}`);
