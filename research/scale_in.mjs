// Scale INTO positions rather than entering all at once.
//
// THE PROPOSAL. Price rarely travels one way continuously, so enter part of the
// size at the signal and add the rest if it chops back, getting a better average.
//
// THE OBJECTION WORTH TESTING. This is a BREAKOUT book. A breakout that runs
// immediately is the one that worked; a breakout that retraces is the one that
// failed. Waiting for a pullback therefore adds size to the failures and leaves
// you light on the winners — adverse selection by construction. The mirror
// version, adding on FOLLOW-THROUGH, is the momentum-consistent one and is
// tested alongside so the comparison is not rigged toward the objection.
//
// It also interacts with the platform cap: adding to a position that is already
// down accelerates the day toward -$1000, and the second tranche arrives with
// less room left than the first had.
//
// Modes:
//   base     all size at the signal bar's open (what ships)
//   dip      tranche 2 added after an ADVERSE move of `trig` x ATR
//   pyramid  tranche 2 added after a FAVOURABLE move of `trig` x ATR
// If the trigger never fires within `window` bars, the position simply stays at
// tranche 1 — a real cost that has to be counted, not waved away.
//
// Usage:  node research/scale_in.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 15000, BLOCK = 5, WIN = 21, CAP = 1000, TOTAL = 8;
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

function replay(mode, q1, trig, windowBars, fromMs) {
  const { open: O, high: H, low: L, close: C, ctMin: CT, tday: TD, ts: TS } = tf;
  const n = O.length, pv = 2, tick = 0.25, slip = 0.25;
  const perSide = 0.75;
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const fills = [];
  let pos = 0, qty = 0, avg = 0, entBar = 0, entTime = 0, added = false, aATR = 0;
  let curTday = -1e9, dayReal = 0, hit = false;
  let nAdds = 0, nTrades = 0;

  const close_ = (px, i, exact) => {
    const xp = pos === 1 ? px - slip : px + slip;
    const fees = perSide * 2 * qty;
    const net = exact !== undefined ? exact : (xp - avg) * pos * pv * qty - fees;
    fills.push({ tday: TD[i], entryTime: entTime, net });
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
      const dir = pos;
      // add the second tranche BEFORE resolving the bracket, since price reaches
      // the trigger on the way to either barrier
      if (!added && i - entBar <= windowBars && mode !== "base") {
        const d = trig * aATR;
        const addPx = mode === "dip" ? avg - dir * d : avg + dir * d;
        const reached = mode === "dip"
          ? (dir === 1 ? L[i] <= addPx : H[i] >= addPx)
          : (dir === 1 ? H[i] >= addPx : L[i] <= addPx);
        if (reached) {
          const q2 = TOTAL - q1;
          avg = (avg * qty + addPx * q2) / (qty + q2);
          qty += q2; added = true; nAdds++;
        }
      }
      const tpD = Math.max(aATR * 1.75, tick), slD = Math.max(aATR * 5, tick);
      const capPx = avg - dir * ((CAP + dayReal) / (pv * qty));
      const rawSl = avg - dir * slD;
      const sl = dir === 1 ? Math.max(rawSl, capPx) : Math.min(rawSl, capPx);
      const isCap = dir === 1 ? sl === capPx && capPx > rawSl : sl === capPx && capPx < rawSl;
      const tp = avg + dir * tpD;
      const hitSl = dir === 1 ? (O[i] <= sl || L[i] <= sl) : (O[i] >= sl || H[i] >= sl);
      const hitTp = dir === 1 ? H[i] >= tp : L[i] <= tp;
      if (hitSl) {
        const px = (dir === 1 ? O[i] <= sl : O[i] >= sl) ? O[i] : sl;
        close_(px, i, isCap ? -CAP - dayReal : undefined);
        continue;
      }
      if (hitTp) { close_(tp, i); continue; }
      if (X.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], i);
      if (pos !== 0) continue;
    }

    if (pos === 0 && s !== 0 && !flatNow && !hit) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      pos = s; avg = O[i]; qty = mode === "base" ? TOTAL : q1;
      aATR = a; entBar = i; entTime = TS[i]; added = false; nTrades++;
    }
  }

  const days = [];
  let day = null, p = 0;
  for (const f of fills) {
    if (f.entryTime < fromMs) continue;
    if (f.tday !== day) { if (day !== null) days.push(p); day = f.tday; p = 0; }
    if (p >= R.dailyProfitStop || p <= -R.circuitBreaker) continue;
    p += f.net;
  }
  if (day !== null) days.push(p);
  const sel = fills.filter((f) => f.entryTime >= fromMs);
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const f of sel) { tot += f.net; if (f.net > 0) { w++; gw += f.net; } else gl -= f.net; }
  return { days, n: sel.length, win: (100 * w) / sel.length, pf: gl ? gw / gl : Infinity,
           exp: tot / sel.length, addRate: (100 * nAdds) / Math.max(1, nTrades) };
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

const FROM = bars.ts[bars.count - 1] - 365 * 86400000;
for (const [lbl, from] of [["LAST 12 MONTHS", FROM], ["ALL HISTORY", 0]]) {
  console.log(`\n  ${lbl}  —  8 lots total, exact -$${CAP} cap, 1 tick\n`);
  console.log("   mode      split  trigger  window   added%   win%    pf     $/trade    PASS%");
  const b = replay("base", TOTAL, 0, 0, from);
  console.log(`   base       8+0        -       -        -   ${b.win.toFixed(1).padStart(4)}  ${b.pf.toFixed(3)}  ` +
    `${("$" + b.exp.toFixed(2)).padStart(8)}  ${pass(b.days, 33).toFixed(1).padStart(6)}%`);
  for (const mode of ["dip", "pyramid"]) {
    for (const q1 of [4, 6]) {
      for (const trig of [0.25, 0.5, 1.0]) {
        const r = replay(mode, q1, trig, 10, from);
        console.log(`   ${mode.padEnd(9)}  ${q1}+${TOTAL - q1}    ${trig.toFixed(2)}xATR    10   ` +
          `${r.addRate.toFixed(0).padStart(5)}%  ${r.win.toFixed(1).padStart(4)}  ${r.pf.toFixed(3)}  ` +
          `${("$" + r.exp.toFixed(2)).padStart(8)}  ${pass(r.days, 33).toFixed(1).padStart(6)}%`);
      }
    }
    console.log();
  }
}
