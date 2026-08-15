// What is in this dataset that the strategy has never looked at?
//
// Everything tried so far has been EXIT-side (breakeven, trailing, partial, time
// stops — all dead) or a parameter sweep (all plateaus). The one thing that
// worked was ENTRY-side: waiting one bar before committing the remaining six
// lots is worth 15pp, because a 0.15xATR move inside the entry bar is noise and
// the same move one bar later is confirmation. That says the edge in this book
// lives in deciding WHEN and WHETHER to commit, not in how to get out.
//
// So this asks the obvious follow-up: what else is available at signal time that
// separates a real breakout from a fake one? The strategy currently uses ADX,
// Kaufman efficiency and a Donchian channel — all price. The dataset also
// carries VOLUME, which is resampled and passed through every layer and then
// never read by anything. Time of day is used only as a blunt 08:30-15:00 gate.
//
// Every feature here is computed from data available at the CLOSE of the signal
// bar, and the trade fills at the next bar's open, so nothing peeks. Features are
// reported as conditional expectancy, split across both halves of history, so a
// dimension that only works in one era is visible immediately rather than after
// it has been turned into a filter.
//
// This is a DIAGNOSTIC. Nothing here is a proposal; the point is to find which
// dimensions carry information before designing anything.
//
// Usage:  node research/context_edge.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const TOTAL = 8, Q1 = 2, ADD_TRIG = 0.15, ADD_WIN = 10, CAP = 1000;
const BREAKER = 500, PROFIT_BLOCK = 750;
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

// ── features, all causal (computed from bar s = i-1 and earlier) ─────
const n = tf.close.length;
const V = tf.volume;
const relVol = new Float64Array(n);      // signal bar volume vs its recent median
const volTrend = new Float64Array(n);    // last 5 bars' volume vs the 20 before
const dayPos = new Float64Array(n);      // where in today's range so far
const fromOpen = new Float64Array(n);    // ATRs travelled from today's open
const barsIntoDay = new Int32Array(n);
const dowArr = new Int32Array(n);
const rangeExp = new Float64Array(n);    // today's range so far / typical range
{
  const W = 20;
  const buf = new Float64Array(W);
  let dayHi = -Infinity, dayLo = Infinity, dayOpen = 0, curDay = -1, since = 0;
  const dayRanges = [];
  for (let i = 0; i < n; i++) {
    if (tf.tday[i] !== curDay) {
      if (curDay !== -1 && dayHi > dayLo) dayRanges.push(dayHi - dayLo);
      curDay = tf.tday[i]; dayHi = -Infinity; dayLo = Infinity;
      dayOpen = tf.open[i]; since = 0;
    }
    if (tf.high[i] > dayHi) dayHi = tf.high[i];
    if (tf.low[i] < dayLo) dayLo = tf.low[i];
    barsIntoDay[i] = since++;
    dowArr[i] = new Date(tf.ts[i]).getUTCDay();
    // relative volume against the median of the previous W bars
    if (i >= W) {
      for (let k = 0; k < W; k++) buf[k] = V[i - W + k];
      const srt = Array.from(buf).sort((a, b) => a - b);
      const med = srt[W >> 1];
      relVol[i] = med > 0 ? V[i] / med : 1;
      let a5 = 0, a20 = 0;
      for (let k = 0; k < 5; k++) a5 += V[i - k];
      for (let k = 5; k < 20; k++) a20 += V[i - k];
      volTrend[i] = a20 > 0 ? (a5 / 5) / (a20 / 15) : 1;
    } else { relVol[i] = 1; volTrend[i] = 1; }
    const rng = dayHi - dayLo;
    dayPos[i] = rng > 0 ? (tf.close[i] - dayLo) / rng : 0.5;
    fromOpen[i] = A[i] > 0 ? (tf.close[i] - dayOpen) / A[i] : 0;
    // today's range so far measured against the median FULL day range to date,
    // which is known only from PAST days
    const past = dayRanges.length > 30
      ? dayRanges.slice(-60).sort((a, b) => a - b)[Math.floor(Math.min(60, dayRanges.length) / 2)]
      : 0;
    rangeExp[i] = past > 0 ? rng / past : 1;
  }
}

// ── replay, recording features at signal time ────────────────────────
function replay() {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const out = [];
  let pos = 0, ep = 0, slD = 0, tpD = 0, feat = null;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0, entBar = 0;
  let curTday = -1e9, dayReal = 0, capHit = false, sigIdxToday = 0;
  const avgFill = () => notional / qty;
  const close_ = (rawExit, i, exact) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    out.push({ ...feat, pnl: net, ts: TS[i] });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; pendQty = 0; addBy = -1; notional = 0;
  };
  for (let i = 1; i < tf.close.length; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; sigIdxToday = 0; }
    if (pos !== 0) {
      if (pendQty > 0 && i - entBar >= 1 && i <= addBy &&
          (pos === 1 ? H[i] >= addPx : L[i] <= addPx)) {
        notional += (pos === 1 ? addPx + slip : addPx - slip) * pendQty;
        qty += pendQty; pendQty = 0;
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
      const b = i - 1;                              // the SIGNAL bar
      feat = {
        ct: CT[i], relVol: relVol[b], volTrend: volTrend[b],
        dayPos: s === 1 ? dayPos[b] : 1 - dayPos[b],
        fromOpen: s * fromOpen[b], barsIn: barsIntoDay[b], dow: dowArr[b],
        rangeExp: rangeExp[b], atr: a, dir: s, nth: ++sigIdxToday,
      };
      ep = O[i]; pos = s; entBar = i;
      slD = Math.max(a * 5, tick); tpD = Math.max(a * 1.75, tick);
      qty = Q1; pendQty = TOTAL - Q1;
      addPx = ep + pos * Math.max(a * ADD_TRIG, tick);
      addBy = i + ADD_WIN;
      notional = (pos === 1 ? ep + slip : ep - slip) * qty;
    }
  }
  return out;
}
const T = replay();
const MID = tf.ts[0] + (tf.ts[tf.close.length - 1] - tf.ts[0]) / 2;
const sum = a => a.reduce((s, t) => s + t.pnl, 0);
const exp_ = a => a.length ? sum(a) / a.length : 0;

console.log(`\n${T.length} trades. Conditional expectancy, split by era so a`);
console.log(`dimension that only worked once is visible immediately.\n`);

function table(name, buckets) {
  console.log(`  ${name}`);
  console.log("    bucket              n      $/trade    early     late    consistent?");
  for (const [lbl, pred] of buckets) {
    const g = T.filter(pred);
    if (g.length < 60) continue;
    const e = g.filter(t => t.ts < MID), l = g.filter(t => t.ts >= MID);
    const ee = exp_(e), le = exp_(l);
    const both = (ee > 0 && le > 0) ? "yes" : (ee < 0 && le < 0) ? "both neg" : "NO";
    console.log(`    ${lbl.padEnd(18)}${String(g.length).padStart(5)}  ` +
      `${("$" + exp_(g).toFixed(0)).padStart(9)}  ${("$" + ee.toFixed(0)).padStart(8)}  ` +
      `${("$" + le.toFixed(0)).padStart(7)}    ${both}`);
  }
  console.log("");
}

table("TIME OF DAY (entry, CT) — used only as a blunt 08:30-15:00 gate", [
  ["08:30-09:00", t => t.ct >= 510 && t.ct < 540],
  ["09:00-10:00", t => t.ct >= 540 && t.ct < 600],
  ["10:00-11:00", t => t.ct >= 600 && t.ct < 660],
  ["11:00-12:00", t => t.ct >= 660 && t.ct < 720],
  ["12:00-13:00", t => t.ct >= 720 && t.ct < 780],
  ["13:00-14:00", t => t.ct >= 780 && t.ct < 840],
  ["14:00-15:00", t => t.ct >= 840 && t.ct < 900],
]);

table("RELATIVE VOLUME on the signal bar — never used by anything", [
  ["< 0.7x median", t => t.relVol < 0.7],
  ["0.7 - 1.0x", t => t.relVol >= 0.7 && t.relVol < 1.0],
  ["1.0 - 1.5x", t => t.relVol >= 1.0 && t.relVol < 1.5],
  ["1.5 - 2.5x", t => t.relVol >= 1.5 && t.relVol < 2.5],
  ["2.5 - 4x", t => t.relVol >= 2.5 && t.relVol < 4],
  ["> 4x", t => t.relVol >= 4],
]);

table("VOLUME TREND (last 5 bars vs prior 15)", [
  ["falling < 0.8x", t => t.volTrend < 0.8],
  ["flat 0.8-1.2x", t => t.volTrend >= 0.8 && t.volTrend < 1.2],
  ["rising 1.2-2x", t => t.volTrend >= 1.2 && t.volTrend < 2],
  ["surging > 2x", t => t.volTrend >= 2],
]);

table("POSITION IN TODAY'S RANGE (1.0 = breaking to a new extreme)", [
  ["< 0.5 (mid/back)", t => t.dayPos < 0.5],
  ["0.5 - 0.8", t => t.dayPos >= 0.5 && t.dayPos < 0.8],
  ["0.8 - 0.95", t => t.dayPos >= 0.8 && t.dayPos < 0.95],
  ["0.95 - 1.0 (edge)", t => t.dayPos >= 0.95],
]);

table("HOW FAR TODAY HAS ALREADY TRAVELLED (range vs typical day)", [
  ["< 0.4 typical", t => t.rangeExp < 0.4],
  ["0.4 - 0.7", t => t.rangeExp >= 0.4 && t.rangeExp < 0.7],
  ["0.7 - 1.0", t => t.rangeExp >= 0.7 && t.rangeExp < 1.0],
  ["1.0 - 1.5", t => t.rangeExp >= 1.0 && t.rangeExp < 1.5],
  ["> 1.5 (exhausted)", t => t.rangeExp >= 1.5],
]);

table("DISTANCE FROM TODAY'S OPEN, in ATRs, signed with the trade", [
  ["< -2 (countertrend)", t => t.fromOpen < -2],
  ["-2 to 0", t => t.fromOpen >= -2 && t.fromOpen < 0],
  ["0 to 2", t => t.fromOpen >= 0 && t.fromOpen < 2],
  ["2 to 5", t => t.fromOpen >= 2 && t.fromOpen < 5],
  ["> 5 (extended)", t => t.fromOpen >= 5],
]);

table("NTH SIGNAL OF THE DAY", [
  ["1st", t => t.nth === 1], ["2nd", t => t.nth === 2],
  ["3rd", t => t.nth === 3], ["4th+", t => t.nth >= 4],
]);

table("DAY OF WEEK", [
  ["Monday", t => t.dow === 1], ["Tuesday", t => t.dow === 2],
  ["Wednesday", t => t.dow === 3], ["Thursday", t => t.dow === 4],
  ["Friday", t => t.dow === 5],
]);

table("DIRECTION", [["long", t => t.dir === 1], ["short", t => t.dir === -1]]);
