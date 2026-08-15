// The two worst exit reasons are the two that are not the bracket.
//
// From timing_diag.mjs, by exit reason:
//     TP       3080 trades   +$394   30.5m
//     SL        561          -$662   62.8m
//     DAYLOSS   440        -$1,011   41.3m
//     FLAT      251          -$285  101.2m   <- the deadline
//     FLIP       84          -$653  129.7m   <- the reversal
// FLAT and FLIP are the longest-held and both lose: -$71,535 and -$54,852 in
// aggregate. Neither is the strategy's edge expressing itself; both are what
// happens when a trade fails to resolve and something external ends it.
//
// These are worth testing precisely because they are cheap to test honestly:
//   flipOnOpposite is BINARY. Nothing to fit, so nothing to overfit.
//   the entry cutoff has ONE parameter, swept here in full rather than chosen.
//   the post-stop cooldown has ONE parameter, likewise.
// The last two candidates died because a free parameter was picked before it was
// swept, so every sweep here is part of the primary result, not a follow-up.
//
// Three ways to handle an opposite signal:
//   flip   close and reverse immediately            (what ships)
//   exit   close, but do not take the new direction (separates the two claims)
//   hold   ignore it entirely and let the bracket work
//
// Usage:  node research/deadline_flip.mjs

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

const DEF = { flipMode: "flip", noEntryMins: 10, cooldownMins: 0 };

function replay(opt = {}) {
  const o = { ...DEF, ...opt };
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const n = tf.close.length, pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - o.noEntryMins;
  const fills = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, entBar = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  let lastStopMs = -Infinity, lastStopDir = 0;
  const byReason = {};
  const avgFill = () => notional / qty;
  const close_ = (rawExit, i, exact, reason) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    fills.push({ tday: TD[i], entryTime: entTime, pnl: net, reason });
    (byReason[reason] ??= { n: 0, sum: 0 });
    byReason[reason].n++; byReason[reason].sum += net;
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    if (reason === "SL" || reason === "DAYLOSS") { lastStopMs = TS[i]; lastStopDir = pos; }
    pos = 0; pendQty = 0; addBy = -1; notional = 0;
  };
  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    if (pos !== 0) {
      if (pendQty > 0 && i - entBar >= 1 && i <= addBy &&
          (pos === 1 ? H[i] >= addPx : L[i] <= addPx)) {
        notional += (pos === 1 ? addPx + slip : addPx - slip) * pendQty;
        qty += pendQty; pendQty = 0;
      }
      if (flatNow) { close_(O[i], i, undefined, "FLAT"); continue; }
      const dir = pos;
      const lossPx = avgFill() - dir * ((CAP + dayReal) / (pv * qty));
      const rawSl = ep - dir * slD;
      const sl = dir === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
      const isCap = dir === 1 ? (sl === lossPx && lossPx > rawSl) : (sl === lossPx && lossPx < rawSl);
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
      // The opposite signal. 'hold' ignores it; 'exit' and 'flip' both close,
      // and only 'flip' is allowed to re-enter below on the same bar.
      if (o.flipMode !== "hold" && s !== 0 && s !== pos) close_(O[i], i, undefined, "FLIP");
      if (pos !== 0) continue;
      if (o.flipMode === "exit") continue;      // closed, but stand aside
    }
    if (pos === 0 && s !== 0 && !flatNow &&
        !(capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK)) {
      if (o.noEntryMins > 0 && inFlat(CT[i], cutoff, X.reopenCt)) continue;
      if (o.cooldownMins > 0 && s === lastStopDir &&
          TS[i] - lastStopMs < o.cooldownMins * 60000) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      ep = O[i]; entTime = TS[i]; pos = s; entBar = i;
      slD = Math.max(a * 5, tick); tpD = Math.max(a * 1.75, tick);
      qty = Q1; pendQty = TOTAL - Q1;
      addPx = ep + pos * Math.max(a * ADD_TRIG, tick);
      addBy = i + ADD_WIN;
      notional = (pos === 1 ? ep + slip : ep - slip) * qty;
    }
  }
  return { fills, byReason };
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
const SLICES = [["early", T0, MID], ["late", MID, T1],
                ["12m", Y12, T1], ["2026", Y26, T1], ["ALL", T0, T1]];

function run(title, cfgs) {
  console.log(`\n${title}\n`);
  const books = cfgs.map(([, o]) => replay(o));
  const cols = SLICES.map(([, lo, hi]) => {
    const maps = books.map(b => dayMap(b.fills, lo, hi));
    const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
    return pairedPass(maps, keys, 4242);
  });
  let hdr = "  config              trades";
  for (const [nm] of SLICES) hdr += nm.padStart(12);
  console.log(hdr + "     pf      net");
  cfgs.forEach(([lbl], i) => {
    const f = books[i].fills;
    let gw = 0, gl = 0, tot = 0;
    for (const x of f) { tot += x.pnl; if (x.pnl > 0) gw += x.pnl; else gl -= x.pnl; }
    let row = "  " + lbl.padEnd(20) + String(f.length).padStart(5);
    cols.forEach(c => {
      const v = c[i], d = v - c[0];
      row += (v.toFixed(1) + (i === 0 ? "" : ` ${d >= 0 ? "+" : ""}${d.toFixed(1)}`)).padStart(12);
    });
    console.log(row + `  ${(gw / gl).toFixed(3)}  ${("$" + (tot / 1000).toFixed(0) + "k").padStart(6)}`);
  });
  return books;
}

const b0 = run("1. THE OPPOSITE SIGNAL — flip is a BINARY switch, nothing to fit",
  [["flip (ships)", {}],
   ["exit, stand aside", { flipMode: "exit" }],
   ["hold, ignore it", { flipMode: "hold" }]]);
console.log("\n  exit-reason breakdown (all history):");
for (const [lbl, b] of [["flip", b0[0]], ["exit", b0[1]], ["hold", b0[2]]]) {
  const parts = Object.entries(b.byReason)
    .sort((a, c) => c[1].n - a[1].n)
    .map(([r, v]) => `${r} ${v.n}/$${(v.sum / 1000).toFixed(0)}k`).join("  ");
  console.log(`    ${lbl.padEnd(6)}${parts}`);
}

run("2. ENTRY CUTOFF before the 15:05 flatten — ONE parameter, swept in full",
  [["10 min (ships)", {}],
   ["20 min", { noEntryMins: 20 }],
   ["30 min", { noEntryMins: 30 }],
   ["45 min", { noEntryMins: 45 }],
   ["60 min", { noEntryMins: 60 }],
   ["90 min", { noEntryMins: 90 }],
   ["120 min", { noEntryMins: 120 }]]);

run("3. COOLDOWN after a stop, same direction — ONE parameter, swept in full",
  [["none (ships)", {}],
   ["10 min", { cooldownMins: 10 }],
   ["20 min", { cooldownMins: 20 }],
   ["40 min", { cooldownMins: 40 }],
   ["60 min", { cooldownMins: 60 }],
   ["120 min", { cooldownMins: 120 }]]);
