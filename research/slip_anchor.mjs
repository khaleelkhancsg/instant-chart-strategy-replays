// After adverse entry slippage, where should the bracket sit?
//
// Two answers, and the backtest and the live bot currently disagree.
//
//   "intended"  barriers at the price the signal implied. Adverse slippage then
//               brings the TARGET nearer and pushes the STOP further, because the
//               levels did not move but the fill did. This is what engine.mjs
//               does: it computes ep +/- dist from the bar open and applies
//               slippage only to the P&L.
//   "fill"      barriers measured from the ACTUAL fill, so the designed distances
//               are preserved and the whole bracket shifts with the slippage.
//               This is what the live bot does — ProjectX brackets are signed
//               tick offsets from the fill.
//   "tp-only"   the literal question asked: pull the TARGET back by the slippage
//               but leave the stop at its designed distance from the fill.
//
// On a driftless walk all three are EV-neutral, since any barrier pair has
// E[X_tau] = 0. They differ in win rate and in how much of a real edge gets
// captured, so this has to be measured rather than reasoned.
//
// Usage:  node research/slip_anchor.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 15000, BLOCK = 5, WIN = 21, CAP = 1000, LOTS = 8;
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
const FROM = bars.ts[bars.count - 1] - 365 * 86400000;

// mode: 'intended' | 'fill' | 'tp-only'   slipTicks: adverse entry slippage
function replay(mode, slipTicks, fromMs) {
  const { open: O, high: H, low: L, close: C, ctMin: CT, tday: TD } = tf;
  const n = O.length, pv = 2, tick = 0.25;
  const slip = slipTicks * tick;
  const exitSlip = 1 * tick;                 // exit slippage held at 1 tick throughout
  const fees = 0.75 * 2 * LOTS;
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const out = [];
  let pos = 0, fill = 0, tpPx = 0, slPx = 0, entTime = 0;
  let curTday = -1e9, dayReal = 0, hit = false;

  const close_ = (px, i, exact) => {
    const xp = pos === 1 ? px - exitSlip : px + exitSlip;
    let net = exact !== undefined ? exact : (xp - fill) * pos * pv * LOTS - fees;
    out.push({ tday: TD[i], entryTime: entTime, net });
    dayReal += net;
    if (dayReal <= -CAP) hit = true;
    pos = 0;
  };

  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; hit = false; }
    if (pos !== 0) {
      if (flatNow) { close_(O[i], i); continue; }
      // exact-liquidation cap, always measured from the real fill
      const capPx = fill - pos * ((CAP + dayReal) / (pv * LOTS));
      const sl = pos === 1 ? Math.max(slPx, capPx) : Math.min(slPx, capPx);
      const isCap = pos === 1 ? sl === capPx && capPx > slPx : sl === capPx && capPx < slPx;
      const hitSl = pos === 1 ? (O[i] <= sl || L[i] <= sl) : (O[i] >= sl || H[i] >= sl);
      const hitTp = pos === 1 ? H[i] >= tpPx : L[i] <= tpPx;
      if (hitSl) {
        const px = (pos === 1 ? O[i] <= sl : O[i] >= sl) ? O[i] : sl;
        close_(px, i, isCap ? -CAP - dayReal : undefined);
        continue;
      }
      if (hitTp) { close_(tpPx, i); continue; }
      if (X.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], i);
      if (pos !== 0) continue;
    }
    if (pos === 0 && s !== 0 && !flatNow && !hit) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      const intended = O[i];
      pos = s;
      fill = intended + s * slip;                       // adverse fill
      entTime = tf.ts[i];
      const tpD = Math.max(a * 1.75, tick), slD = Math.max(a * 5, tick);
      if (mode === "intended") {                         // levels stay where the signal put them
        tpPx = intended + s * tpD;
        slPx = intended - s * slD;
      } else if (mode === "fill") {                      // designed distances from the fill
        tpPx = fill + s * tpD;
        slPx = fill - s * slD;
      } else {                                           // tp pulled back, stop from the fill
        tpPx = intended + s * tpD;
        slPx = fill - s * slD;
      }
    }
  }
  const days = [];
  let day = null, p = 0;
  for (const f of out) {
    if (f.entryTime < fromMs) continue;
    if (f.tday !== day) { if (day !== null) days.push(p); day = f.tday; p = 0; }
    if (p >= R.dailyProfitStop || p <= -R.circuitBreaker) continue;
    p += f.net;
  }
  if (day !== null) days.push(p);
  const sel = out.filter((f) => f.entryTime >= fromMs);
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const f of sel) { tot += f.net; if (f.net > 0) { w++; gw += f.net; } else gl -= f.net; }
  return { days, n: sel.length, win: (100 * w) / sel.length, pf: gl ? gw / gl : Infinity,
           exp: tot / sel.length, tot };
}
function ev(d) {
  let c = 0, pk = 0, lk = false, md = -1e18;
  for (const v of d) {
    c += v; if (v > md) md = v;
    const fl = lk ? 0 : pk - R.trailingDD;
    if (c <= fl) return 0;
    if (c > pk) pk = c;
    if (R.lockAtBreakeven && !lk && pk >= R.trailingDD) lk = true;
    if (c >= R.profitTarget && md <= 0.5 * c) return 1;
  }
  return 0;
}
function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function pass(dd, seed) {
  const rnd = mul(seed), idx = new Array(WIN), n = dd.length;
  let w = 0;
  for (let k = 0; k < DRAWS; k++) {
    let m = 0;
    while (m < WIN) { const st = Math.floor(rnd() * Math.max(1, n - BLOCK));
      for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = dd[(st + j) % n]; }
    w += ev(idx);
  }
  return (100 * w) / DRAWS;
}

console.log(`\n  Entry-slippage anchoring, last 12 months, 8 lots, exact -$${CAP} cap`);
console.log(`  ATR ~19.8 pts, so a 1.75xATR target is ~35 pts. 5 points = 20 ticks.\n`);
console.log("   slip      mode        win%    pf     $/trade     PASS%");
for (const ticks of [0, 1, 2, 4, 8, 20]) {
  for (const mode of ["intended", "fill", "tp-only"]) {
    const r = replay(mode, ticks, FROM);
    const p = pass(r.days, 33);
    const lbl = ticks === 0 ? "  none" : `${(ticks * 0.25).toFixed(2)}pt`;
    console.log(`   ${lbl.padStart(6)}   ${mode.padEnd(10)}  ${r.win.toFixed(1).padStart(5)}  ${r.pf.toFixed(3)}  ` +
      `${("$" + r.exp.toFixed(2)).padStart(8)}  ${p.toFixed(1).padStart(7)}%` +
      (ticks === 0 ? "   (all three identical at zero slippage)" : ""));
  }
  console.log();
}
