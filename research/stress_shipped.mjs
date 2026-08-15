// Stress the SHIPPED configuration against the things that actually go wrong.
//
// The parameter search has plateaued -- everything tried lands back on the
// current values. The remaining risk is not that the signal is wrong, it is that
// the bot is about to trade a mechanism (a resting stop entry for the whole
// position) that has never touched a real exchange, under firm rules that may
// not be exactly what is modelled.
//
// So this stresses execution and rules rather than searching for edge:
//
//   1 FILL FAILURE   the entry is now a single resting stop for all 8 lots. If
//     it is rejected, mis-priced, cancelled by the platform, or simply missed in
//     fast conditions, the trade does not happen. How many can be lost before
//     the book stops working?
//   2 LATENCY        the arm is placed one bar after the signal by design. If
//     the bot is slow, restarts, or the feed stalls, it lands later than that.
//   3 SLIPPAGE       a STOP order fills at market once triggered, so it slips
//     more than the limit exits do. Charged asymmetrically here.
//   4 FIRM RULES     trailing drawdown measured intraday rather than on daily
//     closes is strictly harsher, and some firms do exactly that. Consistency
//     percentage and drawdown size are varied too.
//   5 GEOMETRY       (originally labelled a regime test, and that label was
//     wrong -- see the note in section 5. Scaling ATR shrinks the BRACKET while
//     leaving the price series alone, so it measures tighter stops and targets,
//     not a quieter market. A real regime test needs real low-volatility
//     calendar periods, and those are reported separately.)
//   6 START DATE     the pass rate is an average over start dates. What a single
//     account actually faces is one draw from that distribution.
//
// Usage:  node research/stress_shipped.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules, sweepWindows } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 15000, BLOCK = 5, WIN = 21, TOTAL = 8;
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

function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// dropRate: share of armed entries that never fill.  delay: bars before the
// stop goes live.  entrySlipTicks: EXTRA slippage on the stop entry only.
// atrScale: shrink ATR to simulate a quieter regime.
function replay({ dropRate = 0, delay = 1, entrySlipTicks = 0, commission = 0.75,
                  exitSlipTicks = 1, atrScale = 1, seed = 1234 } = {}) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const pv = 2, tick = 0.25;
  const eSlip = tick * (1 + entrySlipTicks), xSlip = tick * exitSlipTicks;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const rnd = mul(seed);
  const out = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, qty = 0, notional = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0, armLive = true;
  let curTday = -1e9, dayReal = 0, capHit = false, nArm = 0, nFill = 0;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (rawExit, i, exact) => {
    const xp = pos === 1 ? rawExit - xSlip : rawExit + xSlip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - commission * 2 * qty;
    out.push({ tday: TD[i], entryTime: entTime, exitTime: TS[i], pnl: net, dir: pos });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; notional = 0;
  };
  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    if (pos === 0 && armDir !== 0) {
      if (flatNow || i > armBy || blocked()) armDir = 0;
      else if (armLive && i - armBar >= delay &&
               (armDir === 1 ? H[i] >= armPx : L[i] <= armPx)) {
        pos = armDir; qty = TOTAL;
        ep = armEp; slD = armSl; tpD = armTp; entTime = TS[i];
        notional = (pos === 1 ? armPx + eSlip : armPx - eSlip) * qty;
        armDir = 0; nFill++;
      }
    }
    if (pos !== 0) {
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
      const a0 = A[i - 1];
      if (!(a0 > 0)) continue;
      const a = a0 * atrScale;
      nArm++;
      armLive = rnd() >= dropRate;          // the order that never made it
      armDir = s; armBar = i; armBy = i + ADD_WIN; armEp = O[i];
      armPx = O[i] + s * Math.max(a * TRIG, tick);
      armSl = Math.max(a * 5, tick); armTp = Math.max(a * 1.75, tick);
    }
  }
  return { trades: out, fillRate: nArm ? 100 * nFill / nArm : 0 };
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
function ev(d, R2 = R) {
  let c = 0, pk = 0, lk = false, md = -1e18;
  for (const v of d) {
    c += v; if (v > md) md = v;
    if (c <= (lk ? 0 : pk - R2.trailingDD)) return 0;
    if (c > pk) pk = c;
    if (R2.lockAtBreakeven && !lk && pk >= R2.trailingDD) lk = true;
    if (c >= R2.profitTarget && md <= (R2.consistencyPct / 100) * c) return 1;
  }
  return 0;
}
function passOf(fills, seed = 4242, R2 = R) {
  const m = dayMap(fills, 0, Infinity);
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
    w += ev(buf, R2);
  }
  return (100 * w) / DRAWS;
}
const stat = (t) => {
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const x of t) { tot += x.pnl; if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; }
  return { n: t.length, win: t.length ? 100 * w / t.length : 0, pf: gl ? gw / gl : Infinity,
           exp: t.length ? tot / t.length : 0, net: tot };
};
const BASE = replay();
const P0 = passOf(BASE.trades);
console.log(`\nSHIPPED BASELINE: ${BASE.trades.length} trades, fill rate ` +
  `${BASE.fillRate.toFixed(0)}%, pass ${P0.toFixed(1)}%, pf ${stat(BASE.trades).pf.toFixed(3)}\n`);

// ── 1. FILL FAILURE ─────────────────────────────────────────────────
console.log("1. FILL FAILURE — entries that never happen (rejected, missed, cancelled)\n");
console.log("   dropped   trades    pass    delta");
for (const d of [0, 0.02, 0.05, 0.10, 0.20, 0.35, 0.50]) {
  let acc = 0;
  const K = 5;
  for (let s = 0; s < K; s++) acc += passOf(replay({ dropRate: d, seed: 900 + s * 77 }).trades, 4242);
  const p = acc / K;
  console.log(`   ${(100 * d).toFixed(0).padStart(6)}%   ` +
    `${String(replay({ dropRate: d, seed: 900 }).trades.length).padStart(6)}  ${p.toFixed(1).padStart(6)}  ` +
    `${((p - P0 >= 0 ? "+" : "") + (p - P0).toFixed(1)).padStart(7)}`);
}

// ── 2. LATENCY ──────────────────────────────────────────────────────
console.log("\n2. LATENCY — the arm goes live later than the one bar intended\n");
console.log("   delay    trades    pass    delta");
for (const d of [1, 2, 3, 4]) {
  const b = replay({ delay: d });
  const p = passOf(b.trades);
  console.log(`   ${String(d).padStart(5)} bar  ${String(b.trades.length).padStart(6)}  ${p.toFixed(1).padStart(6)}  ` +
    `${((p - P0 >= 0 ? "+" : "") + (p - P0).toFixed(1)).padStart(7)}` + (d === 1 ? "   <- design" : ""));
}

// ── 3. SLIPPAGE AND COMMISSION ──────────────────────────────────────
console.log("\n3. SLIPPAGE ON THE STOP ENTRY — it fills at market once triggered\n");
console.log("   extra ticks    pass    delta      $/trade");
for (const e of [0, 1, 2, 3, 5]) {
  const b = replay({ entrySlipTicks: e });
  const p = passOf(b.trades), s = stat(b.trades);
  console.log(`   ${String(e).padStart(11)}  ${p.toFixed(1).padStart(6)}  ` +
    `${((p - P0 >= 0 ? "+" : "") + (p - P0).toFixed(1)).padStart(7)}   ${("$" + s.exp.toFixed(2)).padStart(9)}`);
}
console.log("\n   commission per side    pass    delta");
for (const c of [0.75, 1.0, 1.25, 1.5, 2.0]) {
  const p = passOf(replay({ commission: c }).trades);
  console.log(`   ${("$" + c.toFixed(2)).padStart(18)}   ${p.toFixed(1).padStart(6)}  ` +
    `${((p - P0 >= 0 ? "+" : "") + (p - P0).toFixed(1)).padStart(7)}` + (c === 0.75 ? "   <- assumed" : ""));
}

// ── 4. FIRM RULES ───────────────────────────────────────────────────
console.log("\n4. FIRM RULES — what if they are not exactly what is modelled\n");
console.log("   variation                          pass    delta");
for (const [lbl, over] of [
  ["as modelled", {}],
  ["consistency 40% (stricter)", { consistencyPct: 40 }],
  ["consistency 30% (much stricter)", { consistencyPct: 30 }],
  ["consistency off", { consistencyPct: 100 }],
  ["drawdown $1,500 (tighter)", { trailingDD: 1500 }],
  ["drawdown $2,500 (looser)", { trailingDD: 2500 }],
  ["target $4,000", { profitTarget: 4000 }],
  ["no breakeven lock", { lockAtBreakeven: false }],
]) {
  const R2 = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750, ...over });
  const p = passOf(BASE.trades, 4242, R2);
  console.log(`   ${lbl.padEnd(33)}${p.toFixed(1).padStart(6)}  ` +
    `${((p - P0 >= 0 ? "+" : "") + (p - P0).toFixed(1)).padStart(7)}`);
}

// ── 5. REGIME ───────────────────────────────────────────────────────
console.log("\n5. VOLATILITY REGIME — 2019-2021 ATR was under half of today's\n");
console.log("   ATR scale    trades    pass    delta");
for (const sc of [1.0, 0.8, 0.6, 0.5, 0.4]) {
  const b = replay({ atrScale: sc });
  const p = passOf(b.trades);
  console.log(`   ${sc.toFixed(2).padStart(9)}   ${String(b.trades.length).padStart(6)}  ${p.toFixed(1).padStart(6)}  ` +
    `${((p - P0 >= 0 ? "+" : "") + (p - P0).toFixed(1)).padStart(7)}`);
}

// ── 6. START DATE ───────────────────────────────────────────────────
console.log("\n6. START DATE — the pass rate is an average; an account gets ONE draw\n");
{
  const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
  const sw = sweepWindows(BASE.trades, T0, T1, R, 1);
  const rows = sw.windows || [];
  const outcomes = rows.map(w => w.outcome);
  const pass = outcomes.filter(o => o === "PASS").length;
  const fail = outcomes.filter(o => o === "FAIL").length;
  const open = outcomes.length - pass - fail;
  console.log(`   ${outcomes.length} real start dates: ${pass} pass, ${fail} fail, ${open} unresolved`);
  console.log(`   calendar pass rate ${(100 * pass / (pass + fail)).toFixed(1)}%`);
  // worst stretch: longest run of consecutive failing start dates
  let run = 0, worst = 0, worstAt = 0;
  rows.forEach((w) => {
    if (w.outcome === "FAIL") { run++; if (run > worst) { worst = run; worstAt = w.startMs; } }
    else run = 0;
  });
  console.log(`   longest run of consecutive FAILING start dates: ${worst} days, ` +
    `beginning ${new Date(worstAt).toISOString().slice(0, 10)}`);
  const cush = rows.filter(w => w.minCushion !== null).map(w => w.minCushion).sort((a, b) => a - b);
  if (cush.length) {
    const pc = (p) => cush[Math.floor(p * (cush.length - 1))];
    console.log(`   minimum cushion to the drawdown across windows:`);
    console.log(`     worst $${pc(0).toFixed(0)}   5th pct $${pc(0.05).toFixed(0)}   ` +
      `median $${pc(0.5).toFixed(0)}   best $${pc(1).toFixed(0)}`);
  }
}
