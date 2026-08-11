// Directional S/R bracket placement — the rule hvn_brackets.mjs did NOT test.
//
// That script snapped each bracket to the NEAREST node, which is symmetric: it
// extends the target as often as it cuts it short, so the two effects cancel and
// the win rate barely moves. That answers "do node locations carry information"
// but it does not test how a trader would actually use support and resistance.
//
// The directional rule is different and asymmetric:
//   LONG   target sits JUST BEFORE resistance   (get filled before price rejects)
//          stop   sits JUST BEYOND support      (a wick into support must not stop you)
//   SHORT  mirrored.
// It also matters whether a node EXTENDS the bracket or CUTS it, so those are
// separated here rather than averaged together.
//
// Modes tested:
//   exact     snap to the node itself (what the earlier script did)
//   sr        target one tick in FRONT of the node, stop one tick BEYOND it
//   extend    only snap when it moves the bracket FURTHER from entry
//   cut       only snap when it moves the bracket CLOSER to entry
//   tp-only   leave the stop alone
//   sl-only   leave the target alone
//
// Every mode is paired with a matched-displacement random control, because
// moving a bracket at all changes the win rate through S/(S+T) whatever it is
// moved to.
//
// Usage:  node research/hvn_directional.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules, sweepWindows } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { windowStarts } from "./lib_search.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const BUCKET = 5, PROFILE_DAYS = 20, HVN_RADIUS = 10, HVN_PCTILE = 0.80;
const MAX_SNAP_FRAC = 0.30;
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
const TICK = X.tickSize;

// ── causal volume profile ────────────────────────────────────────────
const dayVol = new Map();
for (let i = 0; i < bars.count; i++) {
  const d = bars.tday[i];
  let m = dayVol.get(d);
  if (!m) { m = new Map(); dayVol.set(d, m); }
  const lo = Math.floor(bars.low[i] / BUCKET), hi = Math.floor(bars.high[i] / BUCKET);
  const per = bars.volume[i] / (hi - lo + 1);
  for (let b = lo; b <= hi; b++) m.set(b, (m.get(b) || 0) + per);
}
const days = [...dayVol.keys()].sort((a, b) => a - b);
const hvnByDay = new Map();
{
  const run = new Map();
  const add = (d, s) => { for (const [b, v] of dayVol.get(d)) run.set(b, (run.get(b) || 0) + v * s); };
  for (let k = 0; k < days.length; k++) {
    if (k > 0) add(days[k - 1], +1);
    if (k > PROFILE_DAYS) add(days[k - 1 - PROFILE_DAYS], -1);
    if (k < PROFILE_DAYS) { hvnByDay.set(days[k], []); continue; }
    const vals = [...run.values()].filter((v) => v > 0).sort((a, b) => a - b);
    const thresh = vals[Math.floor(vals.length * HVN_PCTILE)] || 0;
    const nodes = [];
    for (const [b, v] of run) {
      if (v < thresh) continue;
      let top = true;
      for (let j = -HVN_RADIUS; j <= HVN_RADIUS && top; j++) {
        if (j !== 0 && (run.get(b + j) || 0) > v) top = false;
      }
      if (top) nodes.push((b + 0.5) * BUCKET);
    }
    nodes.sort((a, b) => a - b);
    hvnByDay.set(days[k], nodes);
  }
}
const cnt = days.map((d) => hvnByDay.get(d).length).sort((a, b) => a - b);
console.log(`\n  profile: ${PROFILE_DAYS} sessions, ${BUCKET}pt buckets, radius ${HVN_RADIUS}, ` +
            `p${(100 * HVN_PCTILE).toFixed(0)} volume floor -> median ${cnt[cnt.length >> 1]} nodes\n`);

function nearest(nodes, px, maxDist) {
  let best = null, bd = Infinity;
  let lo = 0, hi = nodes.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (nodes[m] < px) lo = m + 1; else hi = m - 1; }
  for (const j of [hi, lo]) {
    if (j >= 0 && j < nodes.length) {
      const d = Math.abs(nodes[j] - px);
      if (d < bd) { bd = d; best = nodes[j]; }
    }
  }
  return bd <= maxDist ? best : null;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function replay(mode, control, seed = 7) {
  const rnd = mulberry32(seed);
  const { open: O, high: H, low: L, close: C, ts: TS, ctMin: CT, tday: TD } = tf;
  const n = O.length, q = X.contracts, pv = X.pointValue;
  const slip = X.slippageTicks * TICK, fees = X.commissionPerSide * 2 * q;
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const trades = [];
  let pos = 0, ep = 0, ei = 0, slD = 0, tpD = 0;
  let curTday = -1e9, dayReal = 0, dayLossHit = false;
  let nExt = 0, nCut = 0;

  const close_ = (rx, reason, i) => {
    const xp = pos === 1 ? rx - slip : rx + slip, en = pos === 1 ? ep + slip : ep - slip;
    const gross = (xp - en) * pos * pv * q;
    trades.push({ entryTime: TS[ei], exitTime: TS[i], tday: TD[i], dir: pos, pnl: gross - fees, gross, fees, reason });
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
      const capPx = ep - pos * ((CFG.dayLossStopUsd + dayReal) / (pv * q));
      let out = false;
      if (pos === 1) {
        const sl = Math.max(ep - slD, capPx), tp = ep + tpD;
        if (O[i] <= sl) { close_(O[i], "SL", i); out = true; }
        else if (L[i] <= sl) { close_(sl, "SL", i); out = true; }
        else if (H[i] >= tp) { close_(tp, "TP", i); out = true; }
      } else {
        const sl = Math.min(ep + slD, capPx), tp = ep - tpD;
        if (O[i] >= sl) { close_(O[i], "SL", i); out = true; }
        else if (H[i] >= sl) { close_(sl, "SL", i); out = true; }
        else if (L[i] <= tp) { close_(tp, "TP", i); out = true; }
      }
      if (out) continue;
      if (X.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], "FLIP", i);
      if (pos !== 0) continue;
    }
    if (pos === 0 && s !== 0 && !flatNow && !dayLossHit) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      ep = O[i]; ei = i; pos = s;
      slD = Math.max(a * X.slAtrMult, TICK);
      tpD = Math.max(a * X.tpAtrMult, TICK);

      const nodes = hvnByDay.get(TD[i]) || [];
      const rawTp = ep + pos * tpD, rawSl = ep - pos * slD;
      const doTp = mode !== "sl-only", doSl = mode !== "tp-only";

      if (doTp) {
        const nd = nearest(nodes, rawTp, tpD * MAX_SNAP_FRAC);
        if (nd !== null) {
          // sr: sit one tick IN FRONT of resistance, so the fill happens before
          // price has to trade through the node.
          let target = mode === "sr" ? nd - pos * TICK : nd;
          const newD = pos * (target - ep);
          const extends_ = newD > tpD;
          const ok = mode === "extend" ? extends_ : mode === "cut" ? !extends_ : true;
          if (ok && newD > TICK) {
            if (control) {
              const mag = Math.abs(newD - tpD);
              tpD = Math.max(TICK, tpD + (rnd() < 0.5 ? -mag : mag));
            } else {
              if (extends_) nExt++; else nCut++;
              tpD = newD;
            }
          }
        }
      }
      if (doSl) {
        const nd = nearest(nodes, rawSl, slD * MAX_SNAP_FRAC);
        if (nd !== null) {
          // sr: sit one tick BEYOND support, so a wick that respects the node
          // does not take the trade out.
          let stop = mode === "sr" ? nd - pos * TICK : nd;
          const newD = pos * (ep - stop);
          const extends_ = newD > slD;
          const ok = mode === "extend" ? extends_ : mode === "cut" ? !extends_ : true;
          if (ok && newD > TICK) {
            if (control) {
              const mag = Math.abs(newD - slD);
              slD = Math.max(TICK, slD + (rnd() < 0.5 ? -mag : mag));
            } else slD = newD;
          }
        }
      }
    }
  }
  if (pos !== 0) close_(C[n - 1], "EOD", n - 1);
  let wins = 0, gw = 0, gl = 0, pnl = 0;
  for (const t of trades) { pnl += t.pnl; if (t.pnl > 0) { wins++; gw += t.pnl; } else gl -= t.pnl; }
  const exp = pnl / trades.length;
  let s2 = 0;
  for (const t of trades) s2 += (t.pnl - exp) ** 2;
  return { trades, n: trades.length, win: (100 * wins) / trades.length,
           pf: gl === 0 ? Infinity : gw / gl, exp, pnl, nExt, nCut,
           se: Math.sqrt(s2 / (trades.length - 1)) / Math.sqrt(trades.length) };
}

const rules = resolveRules(RULES);
const passOf = (r) => sweepWindows(r.trades, bars.ts[0], bars.ts[bars.count - 1], rules, 1).summary.passRate;

const base = replay("none", false);
console.log(`  baseline (plain ATR): ${base.n} trades, ${base.win.toFixed(1)}% win, pf ${base.pf.toFixed(3)}, ` +
            `$${base.exp.toFixed(2)}/trade, pass ${passOf(base).toFixed(1)}%\n`);

console.log("  mode      win%    pf      $/trade   pass%  | control $/tr   diff   sigmas");
console.log("  " + "-".repeat(76));
for (const mode of ["exact", "sr", "extend", "cut", "tp-only", "sl-only"]) {
  const h = replay(mode, false), c = replay(mode, true);
  const se = Math.sqrt(h.se ** 2 + c.se ** 2);
  console.log(
    `  ${mode.padEnd(9)} ${h.win.toFixed(1).padStart(5)}  ${h.pf.toFixed(3)}  ${h.exp.toFixed(2).padStart(7)}  ` +
    `${passOf(h).toFixed(1).padStart(6)}%  | ${c.exp.toFixed(2).padStart(9)}  ${(h.exp - c.exp).toFixed(2).padStart(6)}  ` +
    `${((h.exp - c.exp) / se).toFixed(2).padStart(6)}`
  );
}

const e = replay("exact", false);
console.log(`\n  Of the target snaps in "exact": ${e.nExt} EXTENDED the target, ${e.nCut} CUT it short ` +
            `(${(100 * e.nExt / Math.max(1, e.nExt + e.nCut)).toFixed(0)}% / ${(100 * e.nCut / Math.max(1, e.nExt + e.nCut)).toFixed(0)}%).`);
console.log(`  So nearest-node snapping is close to symmetric, which is why it barely moves the win rate.`);
console.log(`  "extend" and "cut" above isolate the two directions.`);
