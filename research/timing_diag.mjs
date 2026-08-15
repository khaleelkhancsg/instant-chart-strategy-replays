// How long do winners and losers actually live, and what does a losing DAY look
// like next to a winning one?
//
// Pure measurement. No proposal is made here — the point is to find out what
// shape the book really has before designing a rule, because the last three
// ideas that felt obvious (breakeven stops, trailing stops, partial exits) all
// died on contact with the data, and two of them died because I designed the
// test around an assumption instead of a measurement.
//
// Shipped configuration: 8 lots as 2+6 scale-in, 5xATR stop, 1.75xATR target,
// -$1000 hard cap, 1 tick/leg slippage, $0.75/side, profit block $750,
// circuit breaker $500.
//
// Usage:  node research/timing_diag.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const CFG = {
  contracts: 8, slAtrMult: 5.0, tpAtrMult: 1.75,
  dayLossStopUsd: 1000, dayLossStopMode: "exact", slippageTicks: 1,
  scaleInFrac: 0.25, scaleInTrigger: 0.15, scaleInWindowBars: 10,
};
const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const S = (await loadStrategies()).get("donchian_eff_rth");
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(tf.close.length);
for (let i = 30; i < raw.length; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const { trades } = runBrackets(tf, sig, A, resolveExec({ ...S.execDefaults, ...CFG }));
const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });

const mins = t => t.bars * 2;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

// ── 1. hold time by outcome ──────────────────────────────────────────
console.log(`\n1. HOLD TIME — ${trades.length} trades\n`);
const W = trades.filter(t => t.pnl > 0), L = trades.filter(t => t.pnl <= 0);
console.log("   group      n      mean    p25   median   p75    p90    max");
for (const [nm, g] of [["ALL", trades], ["winners", W], ["losers", L]]) {
  const m = g.map(mins);
  console.log(`   ${nm.padEnd(9)}${String(g.length).padStart(5)}  ${(mean(m).toFixed(1) + "m").padStart(7)}  ` +
    `${(pct(m, .25) + "m").padStart(5)}  ${(pct(m, .5) + "m").padStart(6)}  ${(pct(m, .75) + "m").padStart(5)}  ` +
    `${(pct(m, .9) + "m").padStart(5)}  ${(pct(m, 1) + "m").padStart(5)}`);
}
console.log("\n   by exit reason:");
console.log("   reason        n     % of all   mean hold   median   avg $");
const byR = new Map();
for (const t of trades) { if (!byR.has(t.reason)) byR.set(t.reason, []); byR.get(t.reason).push(t); }
for (const [r, g] of [...byR].sort((a, b) => b[1].length - a[1].length)) {
  const m = g.map(mins);
  console.log(`   ${String(r).padEnd(11)}${String(g.length).padStart(6)}  ${((100 * g.length / trades.length).toFixed(1) + "%").padStart(8)}  ` +
    `${(mean(m).toFixed(1) + "m").padStart(10)}  ${(pct(m, .5) + "m").padStart(7)}  ` +
    `${("$" + mean(g.map(t => t.pnl)).toFixed(0)).padStart(7)}`);
}

// Theory: for a driftless walk with barriers a below and b above, E[time] =
// a*b/sigma^2. Winners hit the NEAR barrier so they should resolve faster.
console.log("\n   Theory check (driftless walk, barriers 5xATR / 1.75xATR):");
console.log("     winners hit the NEAR barrier, losers the FAR one, so winners");
console.log("     should be the FAST group. Measured ratio loser/winner hold: " +
            (mean(L.map(mins)) / mean(W.map(mins))).toFixed(2) + "x");

// ── 2. does hold time predict anything at entry? ─────────────────────
// Only useful if a rule could act on it. Split by how long the trade has ALREADY
// lived and ask what it is worth from that point on.
console.log("\n2. SURVIVAL — what a trade is worth GIVEN it is still open at time T\n");
console.log("   still open at   n     eventual win%    avg $     avg $ from here*");
for (const T of [0, 10, 20, 30, 45, 60, 90, 120]) {
  const g = trades.filter(t => mins(t) >= T);
  if (g.length < 30) continue;
  const w = g.filter(t => t.pnl > 0).length;
  console.log(`   ${(T + "m").padStart(11)}  ${String(g.length).padStart(5)}  ` +
    `${((100 * w / g.length).toFixed(1) + "%").padStart(11)}  ${("$" + mean(g.map(t => t.pnl)).toFixed(0)).padStart(8)}`);
}
console.log("   * a trade still open at T has NOT yet banked anything; avg $ is its");
console.log("     final P&L. If this falls with T, old trades are the bad ones.");

// ── 3. day level ─────────────────────────────────────────────────────
const days = new Map();
for (const t of trades) {
  if (!days.has(t.tday)) days.set(t.tday, []);
  days.get(t.tday).push(t);
}
// Apply the daily entry blocks exactly as challenge.mjs does.
const dayRec = [];
for (const [d, ts] of days) {
  let acc = 0, taken = [];
  for (const t of ts) {
    if (acc >= R.dailyProfitStop || acc <= -R.circuitBreaker) continue;
    acc += t.pnl; taken.push(t);
  }
  if (!taken.length) continue;
  let peak = 0, run = 0, trough = 0;
  for (const t of taken) { run += t.pnl; if (run > peak) peak = run; if (run < trough) trough = run; }
  dayRec.push({ d, pnl: acc, n: taken.length, peak, trough,
                first: taken[0], last: taken[taken.length - 1],
                wins: taken.filter(t => t.pnl > 0).length,
                giveback: peak - acc });
}
const WD = dayRec.filter(x => x.pnl > 0), LD = dayRec.filter(x => x.pnl <= 0);
console.log(`\n3. DAYS — ${dayRec.length} trading days\n`);
console.log("   group        n      mean$   median$    trades/day   win% of trades");
for (const [nm, g] of [["ALL", dayRec], ["winning days", WD], ["losing days", LD]]) {
  console.log(`   ${nm.padEnd(13)}${String(g.length).padStart(5)}  ` +
    `${("$" + mean(g.map(x => x.pnl)).toFixed(0)).padStart(8)}  ${("$" + pct(g.map(x => x.pnl), .5).toFixed(0)).padStart(8)}  ` +
    `${mean(g.map(x => x.n)).toFixed(2).padStart(12)}  ` +
    `${((100 * g.reduce((s, x) => s + x.wins, 0) / g.reduce((s, x) => s + x.n, 0)).toFixed(1) + "%").padStart(14)}`);
}
console.log(`\n   winning days are ${(100 * WD.length / dayRec.length).toFixed(1)}% of days`);
console.log(`   avg winning day $${mean(WD.map(x => x.pnl)).toFixed(0)}   ` +
            `avg losing day $${mean(LD.map(x => x.pnl)).toFixed(0)}   ` +
            `ratio ${(mean(WD.map(x => x.pnl)) / -mean(LD.map(x => x.pnl))).toFixed(2)}`);

console.log("\n   by number of trades taken that day:");
console.log("   trades   days     mean$    win-day%");
for (let k = 1; k <= 5; k++) {
  const g = dayRec.filter(x => (k < 5 ? x.n === k : x.n >= 5));
  if (!g.length) continue;
  console.log(`   ${(k < 5 ? String(k) : "5+").padStart(6)}  ${String(g.length).padStart(5)}  ` +
    `${("$" + mean(g.map(x => x.pnl)).toFixed(0)).padStart(8)}  ` +
    `${((100 * g.filter(x => x.pnl > 0).length / g.length).toFixed(1) + "%").padStart(9)}`);
}

console.log("\n   FIRST trade of the day predicts the day?");
console.log("   first trade   days     mean day$   win-day%   avg later trades");
for (const [nm, f] of [["won", x => x.first.pnl > 0], ["lost", x => x.first.pnl <= 0]]) {
  const g = dayRec.filter(f);
  console.log(`   ${nm.padEnd(13)}${String(g.length).padStart(5)}  ` +
    `${("$" + mean(g.map(x => x.pnl)).toFixed(0)).padStart(11)}  ` +
    `${((100 * g.filter(x => x.pnl > 0).length / g.length).toFixed(1) + "%").padStart(8)}  ` +
    `${mean(g.map(x => x.n - 1)).toFixed(2).padStart(16)}`);
}

// ── 4. day give-back: the day-level version of the user's question ───
console.log("\n4. DAY GIVE-BACK — days that were up and finished lower\n");
console.log("   Of days whose running P&L peaked at >= X, how many closed below it,");
console.log("   and how much was handed back?");
console.log("   peaked >=    days   closed lower   avg given back   avg close");
for (const X of [250, 500, 750, 1000, 1500]) {
  const g = dayRec.filter(x => x.peak >= X);
  if (!g.length) continue;
  const lower = g.filter(x => x.giveback > 0);
  console.log(`   ${("$" + X).padStart(9)}   ${String(g.length).padStart(5)}   ` +
    `${((100 * lower.length / g.length).toFixed(0) + "%").padStart(12)}   ` +
    `${("$" + mean(lower.map(x => x.giveback)).toFixed(0)).padStart(14)}   ` +
    `${("$" + mean(g.map(x => x.pnl)).toFixed(0)).padStart(9)}`);
}
console.log("\n   And the mirror — days that were DOWN and recovered:");
console.log("   troughed <=  days   closed higher   avg recovered   avg close");
for (const X of [-250, -500, -750]) {
  const g = dayRec.filter(x => x.trough <= X);
  if (!g.length) continue;
  const up = g.filter(x => x.pnl > x.trough);
  console.log(`   ${("$" + X).padStart(9)}   ${String(g.length).padStart(5)}   ` +
    `${((100 * up.length / g.length).toFixed(0) + "%").padStart(13)}   ` +
    `${("$" + mean(up.map(x => x.pnl - x.trough)).toFixed(0)).padStart(13)}   ` +
    `${("$" + mean(g.map(x => x.pnl)).toFixed(0)).padStart(9)}`);
}
