// Make the target proportional to the CAPPED stop, not to ATR.
//
// THE PROBLEM. At 8 lots the platform's -$1000 stop allows 62.5 points, and
// 5xATR at 2026 volatility is 119. So the stop is pinned at 62.5 on essentially
// every trade while the target keeps scaling with ATR at 1.75x = 41.5 points.
// The ratio the book was designed around, 5/1.75 = 3.33:1, becomes 1.51:1, and
// the win rate follows S/(S+T) down from ~77% to ~60%. The strategy being run is
// no longer the strategy that was measured.
//
// THE IDEA. Set the target from the stop that will ACTUALLY be used:
//     stop   = min(slAtrMult * ATR, capPoints)
//     target = stop / ratio
// On quiet days nothing changes, because the cap does not bind and this reduces
// to the normal geometry. On volatile days the target tightens in step with the
// truncated stop, holding the ratio — and therefore the win rate — constant.
//
// engine.mjs cannot express this: tpMode 'rr' computes the target from the RAW
// slDist, before the cap is applied as a dynamic nearer stop. So this file has
// its own replay, mirroring the engine otherwise.
//
// DISCIPLINE. 2026 holds ~6 independent 30-day windows, so tuning on it would
// overfit immediately. Everything is tuned on PRE-2026 high-volatility windows
// and 2026 is reported as a holdout it never saw.
//
// Usage:  node research/cap_adaptive_target.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules, replayWindow, OUTCOME } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { windowStarts, DAY } from "./lib_search.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const CAP = 1000, TICKS = 1;
const Y26 = Date.UTC(2026, 0, 1);
const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const S = (await loadStrategies()).get("donchian_eff_rth");
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(tf.close.length);
for (let i = 30; i < raw.length; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });

// ── window sets: tune on pre-2026 high vol, hold out 2026 ────────────
const starts = windowStarts(bars, 30, 1);
const dayAtr = new Map();
for (let i = 900; i < A.length; i++) {
  const c = tf.ctMin[i];
  if (c < 510 || c >= 900 || !(A[i] > 0)) continue;
  const d = Math.floor(tf.ts[i] / DAY);
  if (!dayAtr.has(d)) dayAtr.set(d, []);
  dayAtr.get(d).push(A[i]);
}
const med = (v) => { v.sort((a, b) => a - b); return v[v.length >> 1]; };
const perDay = new Map([...dayAtr].map(([d, v]) => [d, med(v)]));
const wa = new Map();
for (const s of starts) {
  const d0 = Math.floor(s / DAY), v = [];
  for (let d = d0; d < d0 + 30; d++) if (perDay.has(d)) v.push(perDay.get(d));
  if (v.length >= 15) wa.set(s, med(v));
}
const TUNE = starts.filter((s) => s < Y26 && wa.has(s) && wa.get(s) > 20);
const HOLD = starts.filter((s) => s >= Y26);
console.log(`\n  tune on ${TUNE.length} pre-2026 windows with ATR>20 (~${Math.round(TUNE.length / 30)} independent)`);
console.log(`  hold out ${HOLD.length} windows in 2026 (~${Math.round(HOLD.length / 30)} independent)\n`);

const rules = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });

// ── replay with a cap-adaptive target ────────────────────────────────
// mode "atr"      target = tpAtrMult * ATR              (what ships today)
// mode "adaptive" target = effective stop / ratio       (the thing being tested)
function replay(contracts, slAtrMult, mode, k) {
  const { open: O, high: H, low: L, close: C, ts: TS, ctMin: CT, tday: TD } = tf;
  const n = O.length, pv = 2, tick = 0.25;
  const slip = TICKS * tick, fees = 0.75 * 2 * contracts;
  const capPts = CAP / (pv * contracts);
  const X = resolveExec(S.execDefaults);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const trades = [];
  let pos = 0, ep = 0, ei = 0, slD = 0, tpD = 0;
  let curTday = -1e9, dayReal = 0, dayLossHit = false, nCapped = 0;

  const close_ = (rx, reason, i) => {
    const xp = pos === 1 ? rx - slip : rx + slip, en = pos === 1 ? ep + slip : ep - slip;
    const gross = (xp - en) * pos * pv * contracts;
    trades.push({ entryTime: TS[ei], exitTime: TS[i], tday: TD[i], dir: pos,
                  pnl: gross - fees, gross, fees, reason, mae: 0, mfe: 0 });
    dayReal += gross - fees;
    if (dayReal <= -CAP) dayLossHit = true;
    pos = 0;
  };

  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; dayLossHit = false; }
    if (pos !== 0) {
      if (flatNow) { close_(O[i], "FLAT", i); continue; }
      const capPx = ep - pos * ((CAP + dayReal) / (pv * contracts));
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
      const rawSl = Math.max(a * slAtrMult, tick);
      const effSl = Math.min(rawSl, capPts);          // what the stop will really be
      if (rawSl > capPts) nCapped++;
      slD = rawSl;                                     // bracket as placed
      tpD = mode === "adaptive" ? Math.max(effSl / k, tick) : Math.max(a * k, tick);
    }
  }
  if (pos !== 0) close_(C[n - 1], "EOD", n - 1);
  const st = tradeStats(trades);
  const pr = (set) => { let p = 0; for (const s2 of set) if (replayWindow(trades, s2, rules).outcome === OUTCOME.PASS) p++;
                        return (100 * p) / set.length; };
  return { st, tune: pr(TUNE), hold: pr(HOLD), capPct: (100 * nCapped) / Math.max(1, st.n) };
}

console.log("  SELECTED ON PRE-2026, REPORTED ON 2026\n");
console.log("  variant                          tune%   2026%   pf     $/trade   %capped  trades");
console.log("  " + "-".repeat(92));
const rows = [];
// incumbent
for (const c of [7, 8]) {
  const r = replay(c, 5, "atr", 1.75);
  rows.push({ name: `shipped ${c}L 5xATR / 1.75xATR`, r, tune: r.tune });
}
// adaptive: target = effective stop / ratio
for (const c of [6, 7, 8, 9, 10]) {
  for (const k of [2.0, 2.5, 3.0, 3.33, 4.0]) {
    const r = replay(c, 5, "adaptive", k);
    rows.push({ name: `adaptive ${c}L stop/${k}`, r, tune: r.tune });
  }
}
for (const r of rows) {
  console.log(`  ${r.name.padEnd(32)} ${r.r.tune.toFixed(1).padStart(5)}%  ${r.r.hold.toFixed(1).padStart(5)}%  ` +
    `${r.r.st.profitFactor.toFixed(3)}  ${("$" + r.r.st.expectancy.toFixed(2)).padStart(7)}  ` +
    `${r.r.capPct.toFixed(0).padStart(6)}%  ${String(r.r.st.n).padStart(6)}`);
}
const inc = rows.find((x) => x.name.startsWith("shipped 8"));
const bestTune = rows.filter((x) => x.name.startsWith("adaptive")).sort((a, b) => b.tune - a.tune)[0];
console.log(`\n  incumbent            : tune ${inc.r.tune.toFixed(1)}%  2026 ${inc.r.hold.toFixed(1)}%  pf ${inc.r.st.profitFactor.toFixed(3)}`);
console.log(`  best adaptive on TUNE: ${bestTune.name}`);
console.log(`                       : tune ${bestTune.r.tune.toFixed(1)}%  2026 ${bestTune.r.hold.toFixed(1)}%  pf ${bestTune.r.st.profitFactor.toFixed(3)}`);
console.log(`\n  2026 delta ${(bestTune.r.hold - inc.r.hold).toFixed(1)}pp, pf delta ${(bestTune.r.st.profitFactor - inc.r.st.profitFactor).toFixed(3)}`);
console.log(`  se on the 2026 column is ~21pp; the pf column is the one with power.`);
