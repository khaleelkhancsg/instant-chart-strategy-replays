// Tests that follow from timing_diag.mjs. Three findings drive them:
//
//   1. Losers live 2.14x as long as winners (66.5m vs 31.1m), and a trade still
//      open at 10 minutes has NEGATIVE expectancy (-$38, falling to -$243 by an
//      hour) against +$61 at entry. All the edge is in the first few minutes.
//   2. FLAT (-$285 x 251) and FLIP (-$653 x 84) are the two longest-held exit
//      reasons and both lose. Old trades are the bad trades.
//   3. Day level: the circuit breaker makes its own evidence. Days that trough
//      below -$500 "recover 0% of the time" only because the breaker bans
//      further entries at exactly that point. The data cannot answer whether a
//      looser breaker would recover; only a re-run can.
//
// A time stop WAS tested in giveback_test.mjs and lost. That test is not
// trustworthy: it fired only when the bar would NOT have hit the stop or the
// target, which is lookahead inside the bar — the same defect that killed the
// partial exit. Here the time exit is taken at the bar OPEN, before the bracket
// is resolved, which is what a market order actually does.
//
// The daily blocks are applied INSIDE the replay so they causally change which
// trades get taken, rather than being skipped post-hoc on a fixed trade list.
// The baseline is computed the same way, so every comparison is like-for-like.
//
// Usage:  node research/timing_tests.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 20000, BLOCK = 5, WIN = 21, TOTAL = 8, Q1 = 2, ADD_TRIG = 0.15, ADD_WIN = 10;
const CAP = 1000;
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

const DEF = {
  timeStop: 0,        // bars; exit at market at the open of this bar
  beUsd: 0,           // move stop to breakeven once unrealised >= this many $
  beLockUsd: 0,       // ...and lock in this many $ rather than exactly flat
  breaker: 500,       // block entries once the day is <= -this
  profitBlock: 750,   // block entries once the day is >= this
  dayGiveback: 0,     // block entries once the day falls this far from its peak
  dayBreakeven: 0,    // block entries if the day peaked >= this and returned to 0
  tradeStopUsd: 0,    // per-TRADE dollar stop, distinct from the per-DAY cap
};

function replay(opt = {}) {
  const o = { ...DEF, ...opt };
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const n = O.length, pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const fills = [];
  let pos = 0, ep = 0, entBar = 0, entTime = 0, slD = 0, tpD = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  let curTday = -1e9, dayReal = 0, dayPeak = 0, capHit = false;
  let protect = null, nTime = 0, nBe = 0, nTrades = 0;

  const avgFill = () => notional / qty;
  const bank = (rawExit, i, exact, q) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * q - perSide * 2 * q;
    fills.push({ tday: TD[i], entryTime: entTime, net });
    dayReal += net;
    if (dayReal > dayPeak) dayPeak = dayReal;
    if (dayReal <= -CAP) capHit = true;
  };
  const close_ = (rawExit, i, exact) => {
    bank(rawExit, i, exact, qty);
    pos = 0; pendQty = 0; addBy = -1; notional = 0; protect = null;
  };
  // Entry blocked? All day rules are ENTRY blocks: none of them can touch a
  // position that is already running, which is the same contract the live bot
  // honours.
  const blocked = () => {
    if (capHit) return true;
    if (o.breaker > 0 && dayReal <= -o.breaker) return true;
    if (o.profitBlock > 0 && dayReal >= o.profitBlock) return true;
    if (o.dayGiveback > 0 && dayPeak > 0 && dayPeak - dayReal >= o.dayGiveback) return true;
    if (o.dayBreakeven > 0 && dayPeak >= o.dayBreakeven && dayReal <= 0) return true;
    return false;
  };

  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; dayPeak = 0; capHit = false; }

    if (pos !== 0) {
      if (pendQty > 0 && i <= addBy && (pos === 1 ? H[i] >= addPx : L[i] <= addPx)) {
        notional += (pos === 1 ? addPx + slip : addPx - slip) * pendQty;
        qty += pendQty; pendQty = 0;
      }
      if (flatNow) { close_(O[i], i); continue; }
      const dir = pos;
      const lossPx = avgFill() - dir * ((CAP + dayReal) / (pv * qty));
      const rawSl = ep - dir * slD;
      let sl = dir === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
      let isCap = dir === 1 ? (sl === lossPx && lossPx > rawSl)
                            : (sl === lossPx && lossPx < rawSl);
      // A per-TRADE dollar stop is not the same rule as the per-day cap: with
      // ~1.9 trades a day, a $500 trade stop still allows a $1000 day, whereas
      // the cap bounds the day and lets a single trade use all of it.
      if (o.tradeStopUsd > 0) {
        const tsPx = avgFill() - dir * (o.tradeStopUsd / (pv * qty));
        if (dir === 1 ? tsPx > sl : tsPx < sl) { sl = tsPx; isCap = false; }
      }
      if (protect !== null && (dir === 1 ? protect > sl : protect < sl)) {
        sl = protect; isCap = false;
      }
      const tp = ep + dir * tpD;

      // 1) a gap THROUGH the stop fills at the open, and outranks everything.
      const gapped = dir === 1 ? O[i] <= sl : O[i] >= sl;
      if (gapped) { close_(O[i], i, isCap ? -CAP - dayReal : undefined); continue; }
      // 2) the time stop is a MARKET order at this bar's open. It is taken
      //    before the bracket is resolved because that is when it is sent —
      //    waiting to see whether the bar would have reached the target is
      //    exactly the lookahead that invalidated the earlier version.
      if (o.timeStop > 0 && i - entBar >= o.timeStop) {
        close_(O[i], i); nTime++; continue;
      }
      // 3) intrabar bracket, stop before target.
      let exited = false;
      if (dir === 1) {
        if (L[i] <= sl) { close_(sl, i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (H[i] >= tp) { close_(tp, i); exited = true; }
      } else {
        if (H[i] >= sl) { close_(sl, i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (L[i] <= tp) { close_(tp, i); exited = true; }
      }
      if (exited) continue;
      if (X.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], i);
      if (pos !== 0) {
        // 4) arm the dollar breakeven at this bar's CLOSE, live from the next —
        //    the bot sees a closed bar and then modifies its resting stop.
        if (o.beUsd > 0 && protect === null) {
          const best = dir === 1 ? H[i] : L[i];
          const openUsd = (best - avgFill()) * dir * pv * qty;
          if (openUsd >= o.beUsd) {
            protect = avgFill() + dir * (o.beLockUsd / (pv * qty));
            nBe++;
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
    }
  }
  return { fills, nTime, nBe, nTrades };
}

function dayMap(fills, lo, hi) {
  const m = new Map(); let day = null, acc = 0;
  for (const f of fills) {
    if (f.entryTime < lo || f.entryTime >= hi) continue;
    if (f.tday !== day) { if (day !== null) m.set(day, acc); day = f.tday; acc = 0; }
    acc += f.net;                       // blocks already applied inside replay
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

function table(title, note, cfgs) {
  console.log(`\n${title}\n`);
  if (note) console.log(note + "\n");
  const books = cfgs.map(([, o]) => replay(o));
  const cols = SLICES.map(([, lo, hi]) => {
    const maps = books.map(b => dayMap(b.fills, lo, hi));
    const keys = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
    return pairedPass(maps, keys, 4242);
  });
  let hdr = "  config                trades";
  for (const [nm] of SLICES) hdr += nm.padStart(14);
  console.log(hdr);
  cfgs.forEach(([lbl], i) => {
    let row = "  " + lbl.padEnd(20) + String(books[i].nTrades).padStart(6);
    cols.forEach(c => {
      const v = c[i], d = v - c[0];
      row += (v.toFixed(1) + "%" + (i === 0 ? "" : ` ${d >= 0 ? "+" : ""}${d.toFixed(1)}`)).padStart(14);
    });
    console.log(row);
  });
  // net + expectancy, all history
  console.log("");
  cfgs.forEach(([lbl], i) => {
    const f = books[i].fills;
    let gw = 0, gl = 0, tot = 0;
    for (const x of f) { tot += x.net; if (x.net > 0) gw += x.net; else gl -= x.net; }
    console.log(`    ${lbl.padEnd(22)}pf ${(gw / gl).toFixed(3)}   $/trade ${("$" + (tot / f.length).toFixed(2)).padStart(8)}` +
      `   net ${("$" + (tot / 1000).toFixed(0) + "k").padStart(7)}` +
      (books[i].nTime ? `   time-exits ${books[i].nTime}` : "") +
      (books[i].nBe ? `   BE armed ${books[i].nBe}` : ""));
  });
}

table("TEST A — TIME STOP, causal this time (market order at the bar open)",
  "  The survival curve says a trade open past ~10 minutes has negative\n" +
  "  expectancy. If that is actionable at all, it is here.",
  [["ship (none)", {}],
   ["exit after 10m", { timeStop: 5 }],
   ["exit after 20m", { timeStop: 10 }],
   ["exit after 30m", { timeStop: 15 }],
   ["exit after 45m", { timeStop: 23 }],
   ["exit after 60m", { timeStop: 30 }],
   ["exit after 90m", { timeStop: 45 }],
   ["exit after 120m", { timeStop: 60 }]]);

table("TEST B — BREAKEVEN AT A DOLLAR PROFIT",
  "  The earlier breakeven test armed on a fraction of the TARGET, so the\n" +
  "  trigger moved with volatility. A fixed dollar trigger is a different rule:\n" +
  "  it arms early in quiet markets and late in fast ones.",
  [["ship (none)", {}],
   ["BE at +$200", { beUsd: 200 }],
   ["BE at +$300", { beUsd: 300 }],
   ["BE at +$400", { beUsd: 400 }],
   ["BE at +$500", { beUsd: 500 }],
   ["BE at +$750", { beUsd: 750 }],
   ["BE+$100 at +$400", { beUsd: 400, beLockUsd: 100 }],
   ["BE+$200 at +$500", { beUsd: 500, beLockUsd: 200 }]]);

table("TEST C — CIRCUIT BREAKER (the day-loss entry block)",
  "  The diagnostic cannot answer this: days that trough below -$500 recover\n" +
  "  0% of the time ONLY because the breaker bans entries at that point. The\n" +
  "  block is re-run here so the counterfactual actually exists.",
  [["ship (-$500)", {}],
   ["breaker -$250", { breaker: 250 }],
   ["breaker -$400", { breaker: 400 }],
   ["breaker -$650", { breaker: 650 }],
   ["breaker -$800", { breaker: 800 }],
   ["breaker -$1000", { breaker: 1000 }],
   ["no breaker", { breaker: 0 }]]);

table("TEST D — PROFIT BLOCK (the day-profit entry block)", "",
  [["ship (+$750)", {}],
   ["block +$400", { profitBlock: 400 }],
   ["block +$550", { profitBlock: 550 }],
   ["block +$1000", { profitBlock: 1000 }],
   ["block +$1500", { profitBlock: 1500 }],
   ["no block", { profitBlock: 0 }]]);

table("TEST E — DAY-LEVEL GIVE-BACK STOP",
  "  23% of days that reached +$250 closed lower, handing back $874 on average.\n" +
  "  Stop entering for the day once the day falls this far from its own peak.",
  [["ship (none)", {}],
   ["give-back $250", { dayGiveback: 250 }],
   ["give-back $400", { dayGiveback: 400 }],
   ["give-back $600", { dayGiveback: 600 }],
   ["give-back $800", { dayGiveback: 800 }],
   ["day BE from +$300", { dayBreakeven: 300 }],
   ["day BE from +$500", { dayBreakeven: 500 }]]);

table("TEST F — PER-TRADE DOLLAR STOP (tighter than the day cap)",
  "  The -$1000 cap bounds the DAY, so one trade can spend all of it; a per-trade " + "stop bounds each trade instead, leaving room for a second attempt.",
  [["ship (cap only)", {}],
   ["trade stop $300", { tradeStopUsd: 300 }],
   ["trade stop $450", { tradeStopUsd: 450 }],
   ["trade stop $600", { tradeStopUsd: 600 }],
   ["trade stop $750", { tradeStopUsd: 750 }],
   ["trade stop $900", { tradeStopUsd: 900 }]]);
