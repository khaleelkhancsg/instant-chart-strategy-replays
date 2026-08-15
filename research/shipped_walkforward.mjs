// Apply the test that killed early detection to the changes that SHIPPED.
//
// Early arming failed because it was chosen on the whole sample and then scored
// on the whole sample. Two of this session's shipped changes were chosen exactly
// the same way, so they are owed the same test:
//
//   FIRST TRANCHE   swept 6 > 4 > 3 > 2 > 1 > 0 on all history, monotone, and 0
//                   was shipped. Monotone-and-at-the-boundary is a better shape
//                   than a lone peak, but it is still full-sample selection.
//   ADD DELAY       swept 0/1/2/3/5 bars on all history, 1 shipped. The 0-vs-1
//                   comparison is not a fitted choice -- it is the difference
//                   between the bot doing what the backtest modelled and doing
//                   something the backtest never measured -- but 1-vs-2-vs-3 IS.
//
// Not tested here, because they contain no fitted parameter and cannot be
// overfit by construction:
//   the bracket-sizing fix   arithmetic: a stop on N lots reaches a dollar cap
//                            at a different price than a stop on 8. Correct or
//                            not; nothing to select.
//   the add-lifecycle fix    safety. Cancels an order that should not exist.
//   removing the paper book  no strategy content.
//
// The question: choosing the tranche size on the past only, would the walk-
// forward have picked 0, and would it have delivered?
//
// Usage:  node research/shipped_walkforward.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 12000, BLOCK = 5, WIN = 21, TOTAL = 8;
const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750, ADD_WIN = 10, TRIG = 0.15;
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
const raw = new Int8Array(n);
for (let i = 30; i < n; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });

// first = lots at market (0 = stop entry). delay = bars before the resting
// order goes live. sameBar = the pre-fix behaviour, order live immediately.
function replay(first, delay = 1, sameBar = false) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const out = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, entBar = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (rawExit, i, exact) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    out.push({ tday: TD[i], entryTime: entTime, pnl: net });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; pendQty = 0; addBy = -1; notional = 0;
  };
  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    if (pos === 0 && armDir !== 0) {
      if (flatNow || i > armBy || blocked()) armDir = 0;
      else if (i - armBar >= delay && (armDir === 1 ? H[i] >= armPx : L[i] <= armPx)) {
        pos = armDir; qty = TOTAL; pendQty = 0; addBy = -1;
        ep = armEp; slD = armSl; tpD = armTp; entBar = i; entTime = TS[i];
        notional = (pos === 1 ? armPx + slip : armPx - slip) * qty;
        armDir = 0;
      }
    }
    if (pos !== 0) {
      if (pendQty > 0 && i - entBar >= delay && i <= addBy &&
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
    if (pos === 0 && s !== 0 && !flatNow && !blocked()) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      const px = O[i] + s * Math.max(a * TRIG, tick);
      const sl2 = Math.max(a * 5, tick), tp2 = Math.max(a * 1.75, tick);
      if (first === 0) {
        armDir = s; armPx = px; armBar = i; armBy = i + ADD_WIN;
        armEp = O[i]; armSl = sl2; armTp = tp2;
        if (sameBar && (s === 1 ? H[i] >= px : L[i] <= px)) {
          pos = s; qty = TOTAL; ep = O[i]; slD = sl2; tpD = tp2;
          entBar = i; entTime = TS[i];
          notional = (s === 1 ? px + slip : px - slip) * qty;
          armDir = 0;
        }
      } else {
        ep = O[i]; entTime = TS[i]; pos = s; entBar = i;
        slD = sl2; tpD = tp2;
        qty = first; pendQty = TOTAL - first;
        addPx = px; addBy = i + ADD_WIN;
        notional = (s === 1 ? ep + slip : ep - slip) * qty;
        if (sameBar && pendQty > 0 && (s === 1 ? H[i] >= px : L[i] <= px)) {
          notional += (s === 1 ? px + slip : px - slip) * pendQty;
          qty += pendQty; pendQty = 0;
        }
      }
    }
  }
  return out;
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
function passOf(fills, lo, hi, seed = 4242) {
  const m = dayMap(fills, lo, hi);
  const keys = [...m.keys()].sort((a, b) => a - b);
  if (keys.length < 30) return NaN;
  const rnd = mul(seed), N = keys.length, idx = new Array(WIN);
  const arr = keys.map(k => m.get(k) ?? 0), buf = new Array(WIN);
  let w = 0;
  for (let d = 0; d < DRAWS; d++) {
    let mm = 0;
    while (mm < WIN) { const st = Math.floor(rnd() * Math.max(1, N - BLOCK));
      for (let j = 0; j < BLOCK && mm < WIN; j++) idx[mm++] = (st + j) % N; }
    for (let k = 0; k < WIN; k++) buf[k] = arr[idx[k]];
    w += ev(buf);
  }
  return (100 * w) / DRAWS;
}
const stat = (t) => {
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const x of t) { tot += x.pnl; if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; }
  return { n: t.length, win: 100 * w / t.length, pf: gl ? gw / gl : Infinity,
           exp: t.length ? tot / t.length : 0, net: tot };
};

const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
const HALF = 182 * 86400000;
const FIRSTS = [0, 1, 2, 4];
const BOOK = new Map(FIRSTS.map(f => [f, replay(f)]));

// ── 1. TRANCHE SIZE, chosen out of sample ───────────────────────────
for (const METRIC of ["expectancy", "pass rate"]) {
  console.log(`\nWALK-FORWARD on the FIRST TRANCHE, selected by training ${METRIC}\n`);
  console.log("   test period            chosen   ships(0) $/t   chosen $/t    delta");
  const wf = [], sh = [], picks = [];
  for (let cut = T0 + 730 * 86400000; cut + HALF <= T1; cut += HALF) {
    let bf = 0, best = -Infinity;
    for (const f of FIRSTS) {
      const tr = BOOK.get(f).filter(t => t.entryTime < cut);
      if (tr.length < 200) continue;
      const sc = METRIC === "expectancy" ? stat(tr).exp : passOf(BOOK.get(f), T0, cut, 777);
      if (Number.isFinite(sc) && sc > best) { best = sc; bf = f; }
    }
    const lo = cut, hi = Math.min(cut + HALF, T1);
    const te = BOOK.get(bf).filter(t => t.entryTime >= lo && t.entryTime < hi);
    const t0 = BOOK.get(0).filter(t => t.entryTime >= lo && t.entryTime < hi);
    if (te.length < 30 || t0.length < 30) continue;
    picks.push(bf); wf.push(...te); sh.push(...t0);
    const a = stat(te), b = stat(t0);
    console.log(`   ${new Date(lo).toISOString().slice(0, 10)}..${new Date(hi).toISOString().slice(0, 10)}` +
      `${String(bf).padStart(8)}   ${("$" + b.exp.toFixed(2)).padStart(12)}  ${("$" + a.exp.toFixed(2)).padStart(11)}  ` +
      `${((a.exp - b.exp >= 0 ? "+" : "") + "$" + (a.exp - b.exp).toFixed(2)).padStart(9)}`);
  }
  const w = stat(wf), s = stat(sh);
  const lo2 = T0 + 730 * 86400000;
  console.log(`\n   picks: ${picks.join(", ")}   (0 chosen ${picks.filter(p => p === 0).length}/${picks.length})`);
  console.log(`   walk-forward  ${w.n} trades  pf ${w.pf.toFixed(3)}  $/t $${w.exp.toFixed(2)}  PASS ${passOf(wf, lo2, T1).toFixed(1)}%`);
  console.log(`   always 0+8    ${s.n} trades  pf ${s.pf.toFixed(3)}  $/t $${s.exp.toFixed(2)}  PASS ${passOf(sh, lo2, T1).toFixed(1)}%`);
}

// ── 2. EACH SHIPPED CHOICE, OUT OF SAMPLE ONLY ──────────────────────
// The cleanest framing: freeze each candidate and score it only on the second
// half, which no full-sample sweep of this session was allowed to see when the
// choice was made... except it was. So this is a weaker test than the
// walk-forward and is reported as a cross-check, not as proof.
console.log("\n\nEACH SHIPPED CHOICE, scored on the LATE HALF only\n");
const MID = T0 + (T1 - T0) / 2;
console.log("   variant                       trades    pass     pf    $/trade");
for (const [lbl, f, d, sb] of [
  ["ORIGINAL 2+6, same-bar add", 2, 1, true],
  ["2+6, one-bar deferral", 2, 1, false],
  ["1+7, one-bar deferral", 1, 1, false],
  ["0+8 stop entry (SHIPS)", 0, 1, false],
  ["0+8, same-bar (unfixed)", 0, 1, true],
  ["0+8, two-bar deferral", 0, 2, false],
]) {
  const b = replay(f, d, sb).filter(t => t.entryTime >= MID);
  const s = stat(b);
  console.log(`   ${lbl.padEnd(30)}${String(s.n).padStart(6)}  ${passOf(b, MID, T1).toFixed(1).padStart(6)}  ` +
    `${s.pf.toFixed(3)}  ${("$" + s.exp.toFixed(2)).padStart(9)}`);
}
