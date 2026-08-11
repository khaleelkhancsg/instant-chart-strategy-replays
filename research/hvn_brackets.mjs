// Do HVN-snapped brackets beat plain ATR brackets? (research only, changes nothing)
//
// The idea: price stalls and reverses at high-volume nodes, so a target sitting
// just BEYOND one gets missed by a whisker and the trade turns into a loser,
// while a target pulled back TO the node would have filled. Same logic in reverse
// for the stop.
//
// WHY A CONTROL IS MANDATORY HERE. Win rate follows the bracket identity
// P(win) = S/(S+T) on a driftless walk. Pulling the target 10 points closer
// RAISES the win rate whatever it is snapped to — a high-volume node, a round
// number, or nothing at all. So "win rate went up" is not evidence of anything.
// The only question that means something is whether snapping to a node beats
// moving the bracket the SAME DISTANCE to an arbitrary level. That is the
// control run here, matched displacement for displacement.
//
// CAUSALITY. The profile for a given trading day is built from the previous
// PROFILE_DAYS sessions only, never including the day being traded. Volume is
// spread uniformly across each bar's range, which is the standard bar-based
// approximation — without tick or footprint data the node locations are
// approximate, and that is a real limitation of this test, not a detail.
//
// Prior: a volume-profile pipeline built for this instrument earlier found its
// apparent edge came from rollover contamination, and nothing survived on clean
// data after costs. That was VP as an ENTRY signal; this is exit placement.
//
// Usage:  node research/hvn_brackets.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules, sweepWindows } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { windowStarts, DAY } from "./lib_search.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const BUCKET = 5;          // points per profile bucket
const PROFILE_DAYS = 20;   // sessions of history behind each day's profile
let HVN_RADIUS = 3;        // a bucket is a node if it tops every bucket within +/-N
let MAX_SNAP_FRAC = 0.25;  // never move a bracket more than this fraction of its distance
let HVN_PCTILE = 0;        // keep only nodes above this percentile of bucket volume

const CFG = { contracts: 8, slAtrMult: 5.0, tpAtrMult: 1.75, dayLossStopUsd: 1000, slippageTicks: 1 };
const RULES = { circuitBreaker: 500, dailyProfitStop: 750 };

const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const S = (await loadStrategies()).get("donchian_eff_rth");
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(tf.close.length);
for (let i = 30; i < raw.length; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1;
  else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const X = resolveExec({ ...S.execDefaults, ...CFG });

// ── volume profile, per trading day, causal ──────────────────────────
console.log("building volume profiles ...");
const dayVol = new Map();                      // tday -> Map(bucket -> volume)
for (let i = 0; i < bars.count; i++) {
  const d = bars.tday[i];
  let m = dayVol.get(d);
  if (!m) { m = new Map(); dayVol.set(d, m); }
  const lo = Math.floor(bars.low[i] / BUCKET), hi = Math.floor(bars.high[i] / BUCKET);
  const span = hi - lo + 1;
  const per = bars.volume[i] / span;           // uniform across the bar's range
  for (let b = lo; b <= hi; b++) m.set(b, (m.get(b) || 0) + per);
}
const days = [...dayVol.keys()].sort((a, b) => a - b);

// Rolling sum of the last PROFILE_DAYS, then local maxima.
let hvnByDay = new Map();
const running = new Map();
function buildProfiles() {
hvnByDay = new Map();
running.clear();
const addDay = (d, s) => { for (const [b, v] of dayVol.get(d)) running.set(b, (running.get(b) || 0) + v * s); };
for (let k = 0; k < days.length; k++) {
  if (k > 0) addDay(days[k - 1], +1);
  if (k > PROFILE_DAYS) addDay(days[k - 1 - PROFILE_DAYS], -1);
  if (k < PROFILE_DAYS) { hvnByDay.set(days[k], []); continue; }
  const nodes = [];
  let thresh = 0;
  if (HVN_PCTILE > 0) {
    const vals = [...running.values()].filter((v) => v > 0).sort((a, b) => a - b);
    thresh = vals[Math.floor(vals.length * HVN_PCTILE)] || 0;
  }
  for (const [b, v] of running) {
    if (v <= 0 || v < thresh) continue;
    let top = true;
    for (let j = -HVN_RADIUS; j <= HVN_RADIUS && top; j++) {
      if (j === 0) continue;
      if ((running.get(b + j) || 0) > v) top = false;
    }
    if (top) nodes.push((b + 0.5) * BUCKET);
  }
  nodes.sort((a, b) => a - b);
  hvnByDay.set(days[k], nodes);
}
}
buildProfiles();
console.log(`  ${days.length} sessions, median ${
  (() => { const c = days.map((d) => hvnByDay.get(d).length).sort((a, b) => a - b); return c[c.length >> 1]; })()
} nodes per profile\n`);

function nearestNode(nodes, px, maxDist) {
  if (!nodes.length) return null;
  let lo = 0, hi = nodes.length - 1, best = null, bestD = Infinity;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const d = Math.abs(nodes[m] - px);
    if (d < bestD) { bestD = d; best = nodes[m]; }
    if (nodes[m] < px) lo = m + 1; else hi = m - 1;
  }
  for (const j of [lo - 1, lo, hi, hi + 1]) {
    if (j >= 0 && j < nodes.length) {
      const d = Math.abs(nodes[j] - px);
      if (d < bestD) { bestD = d; best = nodes[j]; }
    }
  }
  return bestD <= maxDist ? best : null;
}

// deterministic PRNG so the control run is reproducible
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── replay, mirroring engine.mjs, with pluggable bracket placement ───
function replay(mode, seed = 7) {
  const rnd = mulberry32(seed);
  const { open: O, high: H, low: L, close: C, ts: TS, ctMin: CT, tday: TD } = tf;
  const n = O.length;
  const q = X.contracts, pv = X.pointValue, tick = X.tickSize;
  const slip = X.slippageTicks * tick;
  const fees = X.commissionPerSide * 2 * q;
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const trades = [];
  let pos = 0, ep = 0, ei = 0, slD = 0, tpD = 0;
  let curTday = -1e9, dayReal = 0, dayLossHit = false;
  const moved = [];

  const close_ = (rawExit, reason, i) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const en = pos === 1 ? ep + slip : ep - slip;
    const gross = (xp - en) * pos * pv * q;
    trades.push({ entryTime: TS[ei], exitTime: TS[i], tday: TD[i], dir: pos,
                  pnl: gross - fees, gross, fees, reason });
    dayReal += gross - fees;
    if (dayReal <= -CFG.dayLossStopUsd) dayLossHit = true;
    pos = 0;
  };

  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; dayLossHit = false; }

    if (pos !== 0) {
      if (flatNow) { close_(O[i], "FLAT", i); continue; }
      // platform hard loss cap, as a dynamic nearer stop
      const capPx = ep - pos * ((CFG.dayLossStopUsd + dayReal) / (pv * q));
      let exited = false;
      if (pos === 1) {
        const sl = Math.max(ep - slD, capPx), tp = ep + tpD;
        if (O[i] <= sl) { close_(O[i], "SL", i); exited = true; }
        else if (L[i] <= sl) { close_(sl, "SL", i); exited = true; }
        else if (H[i] >= tp) { close_(tp, "TP", i); exited = true; }
      } else {
        const sl = Math.min(ep + slD, capPx), tp = ep - tpD;
        if (O[i] >= sl) { close_(O[i], "SL", i); exited = true; }
        else if (H[i] >= sl) { close_(sl, "SL", i); exited = true; }
        else if (L[i] <= tp) { close_(tp, "TP", i); exited = true; }
      }
      if (exited) continue;
      if (X.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], "FLIP", i);
      if (pos !== 0) continue;
    }

    if (pos === 0 && s !== 0 && !flatNow && !dayLossHit) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      ep = O[i]; ei = i; pos = s;
      slD = Math.max(a * X.slAtrMult, tick);
      tpD = Math.max(a * X.tpAtrMult, tick);

      if (mode !== "base") {
        const nodes = hvnByDay.get(TD[i]) || [];
        const rawTp = ep + pos * tpD, rawSl = ep - pos * slD;
        const maxTp = tpD * MAX_SNAP_FRAC, maxSl = slD * MAX_SNAP_FRAC;
        let tpTo = null, slTo = null;
        if (mode === "hvn") {
          tpTo = nearestNode(nodes, rawTp, maxTp);
          slTo = nearestNode(nodes, rawSl, maxSl);
        } else {
          // CONTROL: displace by the same magnitude the HVN snap would have
          // used, but to an arbitrary level. Matches the mechanical S/(S+T)
          // effect so only genuine node structure can show up as a difference.
          const hTp = nearestNode(nodes, rawTp, maxTp);
          const hSl = nearestNode(nodes, rawSl, maxSl);
          if (hTp !== null) tpTo = rawTp + (rnd() < 0.5 ? -1 : 1) * Math.abs(hTp - rawTp);
          if (hSl !== null) slTo = rawSl + (rnd() < 0.5 ? -1 : 1) * Math.abs(hSl - rawSl);
        }
        if (tpTo !== null) { moved.push(Math.abs(tpTo - rawTp)); tpD = Math.max(tick, pos * (tpTo - ep)); }
        if (slTo !== null) { slD = Math.max(tick, pos * (ep - slTo)); }
      }
    }
  }
  if (pos !== 0) close_(C[n - 1], "EOD", n - 1);

  let wins = 0, gw = 0, gl = 0, pnl = 0;
  for (const t of trades) { pnl += t.pnl; if (t.pnl > 0) { wins++; gw += t.pnl; } else gl -= t.pnl; }
  return {
    trades, n: trades.length,
    win: (100 * wins) / trades.length,
    pf: gl === 0 ? Infinity : gw / gl,
    exp: pnl / trades.length, pnl,
    movedMean: moved.length ? moved.reduce((a, b) => a + b, 0) / moved.length : 0,
    movedPct: (100 * moved.length) / trades.length,
  };
}

const rules = resolveRules(RULES);
const allStarts = windowStarts(bars, 30, 1);
const passOf = (r) => sweepWindows(r.trades, bars.ts[0], bars.ts[bars.count - 1], rules, 1).summary.passRate;

console.log("HVN-SNAPPED BRACKETS vs PLAIN ATR vs A MATCHED RANDOM CONTROL\n");
console.log(`  profile ${PROFILE_DAYS} sessions, ${BUCKET}pt buckets, node = local max over +/-${HVN_RADIUS} buckets`);
console.log(`  snap limited to ${(100 * MAX_SNAP_FRAC).toFixed(0)}% of the bracket distance\n`);
console.log("  variant            trades   win%     pf     exp$    net$        pass%   snapped  avg move");
const rows = [];
for (const [label, mode] of [["plain ATR (shipped)", "base"], ["HVN-snapped", "hvn"], ["random control", "ctrl"]]) {
  const r = replay(mode);
  const p = passOf(r);
  rows.push({ label, r, p });
  console.log(
    `  ${label.padEnd(18)} ${String(r.n).padStart(6)}  ${r.win.toFixed(1).padStart(5)}  ${r.pf.toFixed(3)}  ` +
    `${r.exp.toFixed(2).padStart(6)}  ${("$" + Math.round(r.pnl).toLocaleString()).padStart(9)}   ${p.toFixed(1).padStart(5)}%   ` +
    `${r.movedPct.toFixed(0).padStart(6)}%  ${r.movedMean.toFixed(1).padStart(6)} pts`
  );
}

const [base, hvn, ctrl] = rows;
console.log(`\n  win rate   HVN ${hvn.r.win.toFixed(1)}%  vs control ${ctrl.r.win.toFixed(1)}%  vs plain ${base.r.win.toFixed(1)}%`);
console.log(`  THE COMPARISON THAT MATTERS is HVN against the CONTROL, not against plain:`);
console.log(`    expectancy  ${hvn.r.exp.toFixed(2)} vs ${ctrl.r.exp.toFixed(2)}  (${(hvn.r.exp - ctrl.r.exp >= 0 ? "+" : "")}${(hvn.r.exp - ctrl.r.exp).toFixed(2)} $/trade)`);
console.log(`    profit factor ${hvn.r.pf.toFixed(3)} vs ${ctrl.r.pf.toFixed(3)}`);
console.log(`    pass rate   ${hvn.p.toFixed(1)}% vs ${ctrl.p.toFixed(1)}%`);
// A rough standard error on expectancy, so the difference can be read honestly.
const sd = (r) => {
  const m = r.exp;
  let s = 0;
  for (const t of r.trades) s += (t.pnl - m) ** 2;
  return Math.sqrt(s / (r.trades.length - 1)) / Math.sqrt(r.trades.length);
};
const se = Math.sqrt(sd(hvn.r) ** 2 + sd(ctrl.r) ** 2);
console.log(`    difference in expectancy is ${((hvn.r.exp - ctrl.r.exp) / se).toFixed(2)} standard errors (se $${se.toFixed(2)})`);

// ── strictness sweep ─────────────────────────────────────────────────
// 277 nodes per profile is a node every ~15 points, which makes "nearest node"
// almost meaningless and means the run above barely tested the idea. Tighten the
// definition until nodes are genuinely rare, and re-test against the control at
// each setting.
console.log("\n\nSTRICTER NODE DEFINITIONS — is there any setting where HVN beats its control?\n");
console.log("  radius  pctile  snap%   nodes   HVN exp$  ctrl exp$   diff    sigmas   HVN pass  ctrl pass");
for (const [rad, pct, snap] of [
  [3, 0, 0.25], [6, 0.50, 0.25], [10, 0.80, 0.25],
  [10, 0.90, 0.40], [20, 0.90, 0.40], [20, 0.95, 0.60], [40, 0.95, 0.60],
]) {
  HVN_RADIUS = rad; HVN_PCTILE = pct; MAX_SNAP_FRAC = snap;
  buildProfiles();
  const cnt = days.map((d) => hvnByDay.get(d).length).sort((a, b) => a - b);
  const medN = cnt[cnt.length >> 1];
  const h = replay("hvn"), c = replay("ctrl");
  const sdOf = (r) => { let s2 = 0; for (const t of r.trades) s2 += (t.pnl - r.exp) ** 2;
                        return Math.sqrt(s2 / (r.trades.length - 1)) / Math.sqrt(r.trades.length); };
  const se2 = Math.sqrt(sdOf(h) ** 2 + sdOf(c) ** 2);
  console.log(
    `  ${String(rad).padStart(6)}  ${pct.toFixed(2).padStart(6)}  ${(100 * snap).toFixed(0).padStart(4)}%  ` +
    `${String(medN).padStart(6)}   ${h.exp.toFixed(2).padStart(7)}   ${c.exp.toFixed(2).padStart(8)}  ` +
    `${(h.exp - c.exp).toFixed(2).padStart(6)}   ${((h.exp - c.exp) / se2).toFixed(2).padStart(6)}   ` +
    `${passOf(h).toFixed(1).padStart(7)}%  ${passOf(c).toFixed(1).padStart(8)}%`
  );
}
console.log("\n  sigmas = the HVN-minus-control expectancy gap in standard errors.");
console.log("  Anything under ~2 is indistinguishable from the mechanical effect of");
console.log("  simply moving the bracket, which the control already reproduces.");
