// Does price come back to the entry, and can a LATE breakeven stop exploit it?
//
// The idea being tested: winners resolve fast (median 16m) and losers slowly
// (median 44m), so a breakeven stop armed only AFTER a trade has aged past T
// should mostly miss winners — they are already closed — while catching losers
// on their way back through entry. That is a different rule from the two already
// killed: giveback_test armed on EXCURSION (fraction of target) and timing_tests
// armed on PROFIT (dollars), and both fired early, on winners. This one is
// conditioned on TIME.
//
// One mechanical constraint drives the design. "Move the stop to breakeven"
// is only a stop order if the trade is currently in PROFIT; if it is underwater,
// a stop at the entry price sits on the wrong side of the market and would fill
// immediately at a worse price than the entry. So the rule can only arm once
// the trade is both older than T and currently green, and the measurement has
// to respect that or it will price a rule that cannot be placed.
//
// Part 1 answers the question directly (how often does price revert to entry,
// winners vs losers). Part 2 tests whether the rule that follows makes money.
//
// Usage:  node research/revert_be.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 20000, BLOCK = 5, WIN = 21, TOTAL = 8, Q1 = 2, ADD_TRIG = 0.15, ADD_WIN = 10;
const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750;
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

const PROBE_T = [0, 5, 10, 15, 20, 30];       // in BARS (x2 = minutes)

// `beAfterBars`  arm a breakeven stop once the trade is older than this AND green
// `beLockUsd`    park the stop this many dollars beyond breakeven instead of on it
// `beMinUsd`     additionally require this much open profit before arming
// `probe`        collect path facts instead of changing behaviour
function replay(opt = {}) {
  const o = { beAfterBars: 0, beLockUsd: 0, beMinUsd: 0, probe: false, ...opt };
  const { open: O, high: H, low: L, close: C, ctMin: CT, tday: TD, ts: TS } = tf;
  const n = O.length, pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const fills = [], probes = [];
  let pos = 0, ep = 0, entBar = 0, entTime = 0, slD = 0, tpD = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  let protect = null, nArmed = 0, nFired = 0, nTrades = 0;
  let pr = null;                                   // probe record for the open trade

  const avgFill = () => notional / qty;
  const bank = (rawExit, i, exact, q) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * q - perSide * 2 * q;
    fills.push({ tday: TD[i], entryTime: entTime, net });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    return net;
  };
  const close_ = (rawExit, i, exact) => {
    const net = bank(rawExit, i, exact, qty);
    if (pr) { pr.pnl = net; pr.bars = i - entBar; probes.push(pr); pr = null; }
    pos = 0; pendQty = 0; addBy = -1; notional = 0; protect = null;
  };
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;

  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }

    if (pos !== 0) {
      if (pendQty > 0 && i <= addBy && (pos === 1 ? H[i] >= addPx : L[i] <= addPx)) {
        notional += (pos === 1 ? addPx + slip : addPx - slip) * pendQty;
        qty += pendQty; pendQty = 0;
      }
      const dir = pos, af = avgFill(), age = i - entBar;
      // PROBE: has price traded back through the entry, for each threshold that
      // has already elapsed? Recorded before any exit so the fact survives.
      if (pr) {
        for (let k = 0; k < PROBE_T.length; k++) {
          if (age > PROBE_T[k] && pr.openAt[k] &&
              (dir === 1 ? L[i] <= af : H[i] >= af)) pr.touched[k] = true;
        }
      }
      if (flatNow) { close_(O[i], i); continue; }
      const lossPx = af - dir * ((CAP + dayReal) / (pv * qty));
      const rawSl = ep - dir * slD;
      let sl = dir === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
      let isCap = dir === 1 ? (sl === lossPx && lossPx > rawSl)
                            : (sl === lossPx && lossPx < rawSl);
      if (protect !== null && (dir === 1 ? protect > sl : protect < sl)) {
        sl = protect; isCap = false;
      }
      const tp = ep + dir * tpD;
      let exited = false;
      if (dir === 1) {
        if (O[i] <= sl) { if (sl === protect) nFired++; close_(O[i], i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (L[i] <= sl) { if (sl === protect) nFired++; close_(sl, i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (H[i] >= tp) { close_(tp, i); exited = true; }
      } else {
        if (O[i] >= sl) { if (sl === protect) nFired++; close_(O[i], i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (H[i] >= sl) { if (sl === protect) nFired++; close_(sl, i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (L[i] <= tp) { close_(tp, i); exited = true; }
      }
      if (exited) continue;
      if (X.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], i);
      if (pos !== 0) {
        // record open-state at each threshold, at the bar close
        if (pr) {
          for (let k = 0; k < PROBE_T.length; k++) {
            if (age === PROBE_T[k]) {
              pr.openAt[k] = true;
              pr.greenAt[k] = (C[i] - af) * dir > 0;
            }
          }
        }
        // ARM: older than T, and currently green by at least beMinUsd. A stop at
        // the entry can only be placed from the profitable side.
        if (o.beAfterBars > 0 && protect === null && age >= o.beAfterBars) {
          const openUsd = (C[i] - af) * dir * pv * qty;
          if (openUsd > Math.max(0, o.beMinUsd)) {
            protect = af + dir * (o.beLockUsd / (pv * qty));
            nArmed++;
          }
        }
        continue;
      }
    }

    if (pos === 0 && s !== 0 && !flatNow && !blocked()) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      ep = O[i]; entBar = i; entTime = TS[i]; pos = s; nTrades++;
      slD = Math.max(a * 5, tick); tpD = Math.max(a * 1.75, tick);
      qty = Q1; pendQty = TOTAL - Q1;
      addPx = ep + pos * Math.max(a * ADD_TRIG, tick);
      addBy = i + ADD_WIN;
      notional = (pos === 1 ? ep + slip : ep - slip) * qty;
      protect = null;
      if (o.probe) pr = { openAt: PROBE_T.map(() => false), greenAt: PROBE_T.map(() => false),
                          touched: PROBE_T.map(() => false), pnl: 0, bars: 0 };
    }
  }
  return { fills, probes, nArmed, nFired, nTrades };
}

// ── PART 1: how often does price revert to entry? ────────────────────
const P = replay({ probe: true }).probes;
const wins = P.filter(p => p.pnl > 0), losses = P.filter(p => p.pnl <= 0);
console.log(`\n1. REVERSION TO ENTRY — ${P.length} trades ` +
            `(${wins.length} winners, ${losses.length} losers)\n`);
console.log("   Of trades STILL OPEN at T and currently GREEN, how often does");
console.log("   price later trade back through the average entry?\n");
console.log("    T     open  green   -> of those green ones, touch entry later:");
console.log("                            winners          losers        all");
for (let k = 0; k < PROBE_T.length; k++) {
  const open = P.filter(p => p.openAt[k]);
  const green = open.filter(p => p.greenAt[k]);
  const gw = green.filter(p => p.pnl > 0), gl = green.filter(p => p.pnl <= 0);
  const f = a => a.length ? (100 * a.filter(p => p.touched[k]).length / a.length) : NaN;
  console.log(`   ${(PROBE_T[k] * 2 + "m").padStart(4)}  ${String(open.length).padStart(5)}  ` +
    `${String(green.length).padStart(5)}   ` +
    `${(f(gw).toFixed(1) + "%").padStart(14)}  ${(f(gl).toFixed(1) + "%").padStart(14)}  ` +
    `${(f(green).toFixed(1) + "%").padStart(9)}`);
}
console.log("\n   The gap between those two columns is the entire opportunity: a");
console.log("   breakeven stop cannot tell them apart, it only sees the touch.\n");
console.log("   What the green-at-T population is worth if simply held:");
console.log("    T     green    winners      losers     avg $   sum $");
for (let k = 0; k < PROBE_T.length; k++) {
  const green = P.filter(p => p.openAt[k] && p.greenAt[k]);
  if (!green.length) continue;
  const gw = green.filter(p => p.pnl > 0), gl = green.filter(p => p.pnl <= 0);
  const sum = a => a.reduce((s, p) => s + p.pnl, 0);
  console.log(`   ${(PROBE_T[k] * 2 + "m").padStart(4)}  ${String(green.length).padStart(6)}  ` +
    `${(String(gw.length) + " / $" + (sum(gw) / 1000).toFixed(0) + "k").padStart(11)}  ` +
    `${(String(gl.length) + " / $" + (sum(gl) / 1000).toFixed(0) + "k").padStart(11)}  ` +
    `${("$" + (sum(green) / green.length).toFixed(0)).padStart(7)}  ${("$" + (sum(green) / 1000).toFixed(0) + "k").padStart(6)}`);
}

// ── PART 2: does the rule that follows actually pay? ─────────────────
function dayMap(fills, lo, hi) {
  const m = new Map(); let day = null, acc = 0;
  for (const f of fills) {
    if (f.entryTime < lo || f.entryTime >= hi) continue;
    if (f.tday !== day) { if (day !== null) m.set(day, acc); day = f.tday; acc = 0; }
    acc += f.net;
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
  const rnd = mul(seed), n = keys.length, idx = new Array(WIN);
  const wins = maps.map(() => 0);
  const arrs = maps.map(m => keys.map(k => m.get(k) ?? 0));
  const buf = new Array(WIN);
  for (let d = 0; d < DRAWS; d++) {
    let m = 0;
    while (m < WIN) { const st = Math.floor(rnd() * Math.max(1, n - BLOCK));
      for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = (st + j) % n; }
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

const CFG = [
  ["ship (none)", {}],
  ["BE after 20m", { beAfterBars: 10 }],
  ["BE after 30m", { beAfterBars: 15 }],
  ["BE after 40m", { beAfterBars: 20 }],
  ["BE after 60m", { beAfterBars: 30 }],
  ["BE after 90m", { beAfterBars: 45 }],
  ["BE+$100 after 40m", { beAfterBars: 20, beLockUsd: 100 }],
  ["BE-$100 after 40m", { beAfterBars: 20, beLockUsd: -100 }],
  ["BE after 40m, +$150", { beAfterBars: 20, beMinUsd: 150 }],
];
const books = CFG.map(([, o]) => replay(o));
const cols = SLICES.map(([, lo, hi]) => {
  const maps = books.map(b => dayMap(b.fills, lo, hi));
  const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  return pairedPass(maps, keys, 4242);
});
console.log("\n2. TIME-CONDITIONED BREAKEVEN STOP\n");
let hdr = "  config               armed  fired";
for (const [nm] of SLICES) hdr += nm.padStart(14);
console.log(hdr);
CFG.forEach(([lbl], i) => {
  let row = "  " + lbl.padEnd(20) + String(books[i].nArmed).padStart(6) + String(books[i].nFired).padStart(7);
  cols.forEach(c => {
    const v = c[i], d = v - c[0];
    row += (v.toFixed(1) + "%" + (i === 0 ? "" : ` ${d >= 0 ? "+" : ""}${d.toFixed(1)}`)).padStart(14);
  });
  console.log(row);
});
console.log("");
CFG.forEach(([lbl], i) => {
  const f = books[i].fills;
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const x of f) { tot += x.net; if (x.net > 0) { w++; gw += x.net; } else gl -= x.net; }
  console.log(`    ${lbl.padEnd(22)}win ${((100 * w / f.length).toFixed(1) + "%").padStart(6)}   ` +
    `pf ${(gw / gl).toFixed(3)}   $/trade ${("$" + (tot / f.length).toFixed(2)).padStart(8)}   ` +
    `net ${("$" + (tot / 1000).toFixed(0) + "k").padStart(7)}`);
});
