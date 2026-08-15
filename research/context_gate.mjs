// Gate the SIZE on context, not the entry on it.
//
// context_edge.mjs found three consistent signals, all pointing the same way —
// low-participation breakouts are the fake ones:
//     12:00-13:00 CT   -$2/trade, the only negative and only inconsistent bucket
//     volume < 1.0x    $31/trade, against $95 at 2.5-4x
//     3rd signal today $19/trade, against $80 for the first
//
// The obvious move is to filter those trades out. That is probably wrong: the
// low-volume bucket is still POSITIVE ($31 x 334 trades = $10k), so filtering
// throws profit away, and this book is already throughput-constrained against a
// $3,000 target on a deadline — the efficiency gate showed that once already.
//
// The better move is the one that worked before. Scale-in wins by committing 2
// lots immediately and the other 6 only on confirmation, and the whole of its
// edge turned out to be WHICH confirmation it waits for (one bar, not zero). So
// extend the confirmation from pure price to price AND context: on a weak
// breakout, take the trade but never grow it past the first tranche.
//
// That keeps every trade — no throughput lost — while putting 4x the size only
// behind the breakouts that look real. Filters are tested alongside so the
// comparison is not rigged toward the idea being proposed.
//
// Usage:  node research/context_gate.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 20000, BLOCK = 5, WIN = 21, TOTAL = 8, Q1 = 2;
const ADD_TRIG = 0.15, ADD_WIN = 10, CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750;
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

// ATR percentile within a trailing window, so a volatility filter can be built
// with the SAME rejection rate as the volume filter. Volume and volatility are
// correlated, so without this control "volume works" may just be "volatility
// works", which is already known and already priced into the sizing.

// relative volume of the signal bar vs the median of the previous 20 bars.
// atrPct: rank of the current ATR within the trailing 500 bars.
const n = tf.close.length, V = tf.volume;
const relVol = new Float64Array(n).fill(1);
const volTrend = new Float64Array(n).fill(1);
const atrPct = new Float64Array(n).fill(0.5);
{
  const W = 20, buf = new Float64Array(W);
  for (let i = W; i < n; i++) {
    for (let k = 0; k < W; k++) buf[k] = V[i - W + k];
    const srt = Array.from(buf).sort((a, b) => a - b);
    const med = srt[W >> 1];
    relVol[i] = med > 0 ? V[i] / med : 1;
    let a5 = 0, a15 = 0;
    for (let k = 0; k < 5; k++) a5 += V[i - k];
    for (let k = 5; k < 20; k++) a15 += V[i - k];
    volTrend[i] = a15 > 0 ? (a5 / 5) / (a15 / 15) : 1;
  }
  const LB = 500;
  for (let i = LB; i < n; i++) {
    if (!(A[i] > 0)) continue;
    let below = 0;
    for (let k = i - LB; k < i; k++) if (A[k] < A[i]) below++;
    atrPct[i] = below / LB;
  }
}

// entryGate(f)  -> false = do not take the trade at all
// addGate(f)    -> false = take it, but never grow past the first tranche
function replay(entryGate, addGate) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const fills = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, entBar = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  let curTday = -1e9, dayReal = 0, capHit = false, nth = 0;
  let nTrades = 0, nAdds = 0, nGated = 0;
  const avgFill = () => notional / qty;
  const close_ = (rawExit, i, exact) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    fills.push({ tday: TD[i], entryTime: entTime, pnl: net, qty });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; pendQty = 0; addBy = -1; notional = 0;
  };
  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; nth = 0; }
    if (pos !== 0) {
      // one-bar deferral, exactly as shipped
      if (pendQty > 0 && i - entBar >= 1 && i <= addBy &&
          (pos === 1 ? H[i] >= addPx : L[i] <= addPx)) {
        notional += (pos === 1 ? addPx + slip : addPx - slip) * pendQty;
        qty += pendQty; pendQty = 0; nAdds++;
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
      const b = i - 1;
      const f = { ct: CT[i], relVol: relVol[b], volTrend: volTrend[b], nth: nth + 1,
                  atr: a, atrPct: atrPct[b] };
      if (entryGate && !entryGate(f)) continue;      // never entered
      nth++;
      ep = O[i]; entTime = TS[i]; pos = s; entBar = i; nTrades++;
      slD = Math.max(a * 5, tick); tpD = Math.max(a * 1.75, tick);
      const allowAdd = addGate ? addGate(f) : true;
      if (!allowAdd) nGated++;
      qty = Q1; pendQty = allowAdd ? TOTAL - Q1 : 0;
      addPx = ep + pos * Math.max(a * ADD_TRIG, tick);
      addBy = allowAdd ? i + ADD_WIN : -1;
      notional = (pos === 1 ? ep + slip : ep - slip) * qty;
    }
  }
  return { fills, nTrades, nAdds, nGated };
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
const SLICES = [["early half", T0, MID], ["late half", MID, T1],
                ["last 12m", Y12, T1], ["2026", Y26, T1], ["ALL", T0, T1]];

const lunch = f => f.ct >= 720 && f.ct < 780;
const CFG = [
  ["ship (no context)", null, null],
  // fine sweep: is 1.0x a peak or a plateau edge?
  ["vol >= 0.7x", f => f.relVol >= 0.7, null],
  ["vol >= 0.85x", f => f.relVol >= 0.85, null],
  ["vol >= 1.0x", f => f.relVol >= 1.0, null],
  ["vol >= 1.15x", f => f.relVol >= 1.15, null],
  ["vol >= 1.3x", f => f.relVol >= 1.3, null],
  // the two survivors, combined
  ["skip lunch", f => !lunch(f), null],
  ["vol>=1.0 + skip lunch", f => f.relVol >= 1.0 && !lunch(f), null],
  ["vol>=0.85 + skip lunch", f => f.relVol >= 0.85 && !lunch(f), null],
  // MATCHED CONTROLS. Volume tracks volatility, and high volatility is already
  // known to score better. These reject a similar share of trades using ATR
  // rank alone: if they do as well, the volume filter carries no extra
  // information and the finding is a restatement of something already known.
  ["ctrl: atrPct >= 0.10", f => f.atrPct >= 0.10, null],
  ["ctrl: atrPct >= 0.20", f => f.atrPct >= 0.20, null],
  ["ctrl: atrPct >= 0.30", f => f.atrPct >= 0.30, null],
  // and the reverse: volume filter applied ONLY inside a fixed volatility band,
  // so the volatility channel is closed off entirely.
  ["vol>=1.0 within atr 0.2-0.8", f => f.atrPct < 0.2 || f.atrPct > 0.8 || f.relVol >= 1.0, null],
];
const books = CFG.map(([, e, a]) => replay(e, a));
const cols = SLICES.map(([, lo, hi]) => {
  const maps = books.map(b => dayMap(b.fills, lo, hi));
  const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  return pairedPass(maps, keys, 4242);
});

console.log("\nCONTEXT GATES — filter the trade, or just refuse to grow it\n");
let hdr = "  config                trades  gated";
for (const [nm] of SLICES) hdr += nm.padStart(13);
console.log(hdr);
CFG.forEach(([lbl], i) => {
  const b = books[i];
  if (i === 1 || i === 6 || i === 9) console.log("  " + "-".repeat(hdr.length - 2));
  let row = "  " + lbl.padEnd(22) + String(b.nTrades).padStart(6) +
            (b.nGated ? String(b.nGated) : "-").padStart(7);
  cols.forEach(c => {
    const v = c[i], d = v - c[0];
    row += (v.toFixed(1) + "%" + (i === 0 ? "" : ` ${d >= 0 ? "+" : ""}${d.toFixed(1)}`)).padStart(13);
  });
  console.log(row);
});
console.log("");
CFG.forEach(([lbl], i) => {
  const f = books[i].fills;
  let gw = 0, gl = 0, tot = 0;
  for (const x of f) { tot += x.pnl; if (x.pnl > 0) gw += x.pnl; else gl -= x.pnl; }
  const avgQ = f.reduce((s, x) => s + x.qty, 0) / f.length;
  console.log(`    ${lbl.padEnd(24)}pf ${(gw / gl).toFixed(3)}   avg lots ${avgQ.toFixed(2)}   ` +
    `$/trade ${("$" + (tot / f.length).toFixed(2)).padStart(8)}   net ${("$" + (tot / 1000).toFixed(0) + "k").padStart(7)}`);
});
