// The scale-in add can fill on the ENTRY BAR live, but never in the backtest.
//
// runBrackets calls tryAdd(i) at the top of bar i's processing, and the entry is
// written at the BOTTOM of the entry bar, so the earliest the add can fill is the
// bar AFTER entry. The live bot rests the stop order the moment the first tranche
// fills, so it can fill within the entry bar. The audit found the add trigger is
// already reached on the entry bar for 80.8% of signals, so this is not a corner
// case — it is the normal case.
//
// Direction of the bias matters. Scale-in earns its keep by NOT adding to the
// ~15% of trades that never move a quarter-ATR the right way. If the live bot
// adds more readily than the backtest, it adds to more of those, and the measured
// +7pp shrinks. This quantifies how much.
//
// Three books:
//   next-bar   what the engine and every quoted number model
//   same-bar   the add may also fill on the entry bar, at the same trigger price
//   pessimist  same-bar, and the add is charged an extra tick for the rush
//
// Usage:  node research/samebar_add.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules, sweepWindows } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec } from "../src/engine.mjs";
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

// sameBar: may the add fill on the entry bar?  extraTicks: extra slippage on it.
// noScale: single-tranche control, so the two effects can be separated.
function replay({ sameBar = false, extraTicks = 0, noScale = false, delayBars = 0 } = {}) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const n = O.length, pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const out = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  let nAdd = 0, nTrades = 0, nSameBarAdd = 0, entBar = 0;
  const avgFill = () => notional / qty;
  const close_ = (rawExit, i, exact, reason) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    out.push({ tday: TD[i], entryTime: entTime, exitTime: TS[i], pnl: net, reason, qty });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; pendQty = 0; addBy = -1; notional = 0;
  };
  const tryAdd = (i, isEntryBar) => {
    if (pendQty <= 0 || i > addBy) return;
    if (i - entBar < delayBars) return;   // order not resting yet
    if (!(pos === 1 ? H[i] >= addPx : L[i] <= addPx)) return;
    const sl2 = slip + extraTicks * tick;
    notional += (pos === 1 ? addPx + sl2 : addPx - sl2) * pendQty;
    qty += pendQty; pendQty = 0; nAdd++;
    if (isEntryBar) nSameBarAdd++;
  };

  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    if (pos !== 0) {
      tryAdd(i, false);
      if (flatNow) { close_(O[i], i, undefined, "FLAT"); continue; }
      const dir = pos;
      const lossPx = avgFill() - dir * ((CAP + dayReal) / (pv * qty));
      const rawSl = ep - dir * slD;
      const sl = dir === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
      const isCap = dir === 1 ? (sl === lossPx && lossPx > rawSl)
                              : (sl === lossPx && lossPx < rawSl);
      const tp = ep + dir * tpD;
      const cut = isCap ? -CAP - dayReal : undefined;
      const rn = isCap ? "DAYLOSS" : "SL";
      let exited = false;
      if (dir === 1) {
        if (O[i] <= sl) { close_(O[i], i, cut, rn); exited = true; }
        else if (L[i] <= sl) { close_(sl, i, cut, rn); exited = true; }
        else if (H[i] >= tp) { close_(tp, i, undefined, "TP"); exited = true; }
      } else {
        if (O[i] >= sl) { close_(O[i], i, cut, rn); exited = true; }
        else if (H[i] >= sl) { close_(sl, i, cut, rn); exited = true; }
        else if (L[i] <= tp) { close_(tp, i, undefined, "TP"); exited = true; }
      }
      if (exited) continue;
      if (X.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], i, undefined, "FLIP");
      if (pos !== 0) continue;
    }
    if (pos === 0 && s !== 0 && !flatNow &&
        !(capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK)) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      ep = O[i]; entTime = TS[i]; pos = s; nTrades++; entBar = i;
      slD = Math.max(a * 5, tick); tpD = Math.max(a * 1.75, tick);
      qty = noScale ? TOTAL : Q1;
      pendQty = noScale ? 0 : TOTAL - Q1;
      addPx = ep + pos * Math.max(a * ADD_TRIG, tick);
      addBy = i + ADD_WIN;
      notional = (pos === 1 ? ep + slip : ep - slip) * qty;
      // THE POINT OF THIS SCRIPT: live, the stop order rests the moment the
      // first tranche fills, so the rest of THIS bar can trigger it. The engine
      // cannot see that because the entry is written after the bar is resolved.
      if (sameBar) tryAdd(i, true);
    }
  }
  return { trades: out, nAdd, nTrades, nSameBarAdd };
}

// Parity: next-bar must reproduce the engine exactly.
const engCfg = { contracts: TOTAL, slAtrMult: 5, tpAtrMult: 1.75, dayLossStopUsd: CAP,
  dayLossStopMode: "exact", slippageTicks: 1, scaleInFrac: Q1 / TOTAL,
  scaleInTrigger: ADD_TRIG, scaleInWindowBars: ADD_WIN };
const eng = runBrackets(tf, sig, A, resolveExec({ ...S.execDefaults, ...engCfg })).trades;
const nb = replay({});
{
  let acc = 0, day = null; const kept = [];
  for (const t of eng) {
    if (t.tday !== day) { day = t.tday; acc = 0; }
    if (acc >= PROFIT_BLOCK || acc <= -BREAKER) continue;
    acc += t.pnl; kept.push(t);
  }
  const a = kept.reduce((s, t) => s + t.pnl, 0), b = nb.trades.reduce((s, t) => s + t.pnl, 0);
  console.log(`\nparity: engine(blocked) ${kept.length} trades $${a.toFixed(0)}  ` +
              `vs replay ${nb.trades.length} $${b.toFixed(0)}  ` +
              `(${(100 * Math.abs(a - b) / Math.abs(a)).toFixed(2)}% apart)\n`);
}

const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
const MID = T0 + (T1 - T0) / 2, Y12 = T1 - 365 * 86400000, Y26 = Date.UTC(2026, 0, 1);
const SLICES = [["early half", T0, MID], ["late half", MID, T1],
                ["last 12m", Y12, T1], ["2026", Y26, T1], ["ALL", T0, T1]];
const noRules = resolveRules({ circuitBreaker: 0, dailyProfitStop: 0, dailyLossLimit: 0 });

// Is the one-bar delay a smooth "wait for confirmation" effect, or a cliff that
// only exists at exactly the delay the engine happens to impose? A real effect
// should keep improving as the add waits longer; an artifact should spike at
// delay=1 and mean nothing either side.
const CFG = [
  ["no scale-in (8 at once)", { noScale: true }],
  ["add from entry bar", { sameBar: true, delayBars: 0 }],
  ["add from +1 bar (modelled)", { sameBar: true, delayBars: 1 }],
  ["add from +2 bars", { sameBar: true, delayBars: 2 }],
  ["add from +3 bars", { sameBar: true, delayBars: 3 }],
  ["add from +5 bars", { sameBar: true, delayBars: 5 }],
  ["+1 bar, +1 tick slip", { sameBar: true, delayBars: 1, extraTicks: 1 }],
  ["+1 bar, +2 ticks slip", { sameBar: true, delayBars: 1, extraTicks: 2 }],
];
const books = CFG.map(([, o]) => replay(o));

let hdr = "  book                      add%  same-bar";
for (const [nm] of SLICES) hdr += nm.padStart(13);
console.log(hdr);
const rows = CFG.map(() => []);
for (const [, lo, hi] of SLICES) {
  books.forEach((b, i) => {
    const sub = b.trades.filter(t => t.entryTime >= lo && t.entryTime < hi);
    rows[i].push(sweepWindows(sub, lo, hi, noRules, 1).summary.passRate);
  });
}
CFG.forEach(([lbl], i) => {
  const b = books[i];
  let row = "  " + lbl.padEnd(24) +
    ((100 * b.nAdd / Math.max(1, b.nTrades)).toFixed(0) + "%").padStart(5) +
    (b.nSameBarAdd ? String(b.nSameBarAdd) : "-").padStart(10);
  rows[i].forEach((v, j) => {
    const d = v - rows[2][j];                 // vs the MODELLED book
    row += (v.toFixed(1) + "%" + (i === 2 ? "" : ` ${d >= 0 ? "+" : ""}${d.toFixed(1)}`)).padStart(13);
  });
  console.log(row);
});

console.log("\n  (deltas are against 'next-bar add', the book every quoted number uses)\n");
CFG.forEach(([lbl], i) => {
  const t = books[i].trades;
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const x of t) { tot += x.pnl; if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; }
  const avgQ = t.reduce((s, x) => s + x.qty, 0) / t.length;
  console.log(`    ${lbl.padEnd(26)}win ${((100 * w / t.length).toFixed(1) + "%").padStart(6)}   ` +
    `pf ${(gw / gl).toFixed(3)}   avg lots ${avgQ.toFixed(2)}   ` +
    `net ${("$" + (tot / 1000).toFixed(0) + "k").padStart(7)}`);
});
