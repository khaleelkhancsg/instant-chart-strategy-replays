// Is the ORB just better than the Donchian? And can the ORB be made to pass
// more?
//
// Answering the first question turned up a fault in how the ORB has always
// been backtested. When one minute trades through BOTH levels, lib_orb ignores
// that minute and keeps hunting. The live bot cannot do that: both stop orders
// rest from the bell, so the level crossed first FILLS, and its stop -- which
// is the other level -- is hit inside the same minute. That is exactly the
// 2026-08-20 trade (filled 08:30:16, stopped 08:30:38, on a bar that crossed
// both levels). The backtest instead books whatever the next clean break did.
//
// Part 1 measures how often that happens and what it is worth. Part 2 puts the
// two books on the same scoreboard under what the bot actually does. Part 3
// tests ways to make the ORB pass more under those same mechanics, each against
// a matched null where the change removes trades -- on this account dropping
// ORB trades can raise the pass rate by itself, because it frees the account
// and the shared breaker for the Donchian.
//
// RESULT (live config: levels <= 31 pts apart, $500 risk, 3R, 5-minute hold):
//   - The first level-crossing minute goes through BOTH levels on 273 of 749
//     ORB days (36.4%; 56% in 2026). The backtest booked +$48,081 on those
//     days ($176/day, 52% winners); the bot books -$145,208 (-$532/day, none
//     win). orb_bothways_check.mjs reproduces it from scratch.
//   - As the bot trades it the ORB LOSES money: -$38/trade. Alone it passes
//     10.4% (backtest said 34.8%). The account passes 33.6% with it (backtest
//     said 53.4%) and 38.2% with it switched off.
//   - Nothing tested beats switching it off: resting the stops 1-10 minutes
//     after the bell (25.9-32.3%), spread floors (36.8-38.8%), slow-trend
//     alignment (filter 37.1% vs 36.8% for a rotated trend; one-sided 24.0%),
//     counter-trend at half size (36.5%), any risk budget (24.0-35.1%).
//     orb_redesign.mjs adds close-confirmed entries and a spread floor scaled
//     to the recent opening minute: 33.5-39.2%, none clear of 38.2% in both
//     halves.
//
//   node --max-old-space-size=6144 research/orb_improve.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { ema, adx, donchian } from "../src/indicators.mjs";
import * as J from "./joint_account.mjs";
import * as B from "./lib_orb.mjs";

const T0 = Date.now();
const { bars } = loadBars();
const tf = resample(bars, 2), tf5 = resample(bars, 5);
const n1 = bars.count, n2 = tf.close.length;

// ---- the live Donchian signal: efficiency >= 0.5 plus the slow-trend rescue
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(n2);
for (let i = 30; i < n2; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const ctx = buildFilterContext(tf);
const gated = (x) => applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: x });
const G05 = gated(0.5), G045 = gated(0.45);
const t125 = ema(tf.close, 125), t500 = ema(tf.close, 500);
const RESC = Int8Array.from(G05);
for (let k = 0; k < n2; k++)
  if (G045[k] && !G05[k] && Math.sign(t125[k] - t500[k]) === raw[k]) RESC[k] = G045[k];

// ---- the ORB as backtested so far, and as the bot actually trades it
const BT_ORB = { ...J.ORB_CFG, maxWidthPts: 31 };              // live config, old backtest
const LIVE_ORB = { ...BT_ORB, bothWays: "fill" };              // what resting stops do
const days = J.days, NH = days.length >> 1, REC = 500;

const openIdx = new Map();
for (const d of B.dayKeys) {
  const e = B.dayEnd.get(d);
  let i = B.daySess.get(d);
  while (i < e && B.CT[i] < B.OPEN_CT) i++;
  if (i < e && B.CT[i] < B.FLAT_CT) openIdx.set(d, i);
}
const yearOf = (d) => new Date(B.TS[openIdx.get(d) ?? B.dayStart.get(d)]).getUTCFullYear();
const Y26 = days.map((d, k) => (yearOf(d) === 2026 ? k : -1)).filter((k) => k >= 0);

// ---- scoring -----------------------------------------------------------------
// Mirrors J.pass21 draw for draw (same seed, same 5-day blocks), but says WHY
// each window that did not pass did not pass.
const TARGET = 3000, DD = 2000, CONSIST = 0.5;
function ev3(d) {
  let c = 0, pk = 0, lk = false, md = -1e18, hit = false;
  for (const v of d) {
    c += v; if (v > md) md = v;
    if (c <= (lk ? 0 : pk - DD)) return 1;               // drawdown
    if (c > pk) pk = c;
    if (!lk && pk >= DD) lk = true;
    if (c >= TARGET) { if (md <= CONSIST * c) return 0; hit = true; }
  }
  return hit ? 3 : 2;                                  // consistency / clock
}
function outcomes(arr, seed = 4242) {
  const rnd = B.mul(seed), idx = new Array(21), buf = new Array(21), n = [0, 0, 0, 0];
  for (let d = 0; d < 12000; d++) {
    let mm = 0;
    while (mm < 21) { const st = Math.floor(rnd() * Math.max(1, arr.length - 5));
      for (let j = 0; j < 5 && mm < 21; j++) idx[mm++] = (st + j) % arr.length; }
    for (let k = 0; k < 21; k++) buf[k] = arr[idx[k]];
    n[ev3(buf)]++;
  }
  return n.map((x) => (100 * x) / 12000);
}
const slices = (arr) => ({ all: J.pass21(arr), h1: J.pass21(arr.slice(0, NH)),
                           h2: J.pass21(arr.slice(NH)), rec: J.pass21(arr.slice(-REC)),
                           y26: J.pass21(Y26.map((k) => arr[k])) });
const sched = (list) => { const m = new Map(); for (const s of list) m.set(s.bar, s); return m; };

// One ORB schedule, scored twice: the ORB book alone, and the live account
// (both books, exclusive, the Donchian with its rescue).
function score(list, orbCfg = LIVE_ORB) {
  const m = sched(list);
  const o = J.simulate("orb", { orbCfg, orbSched: m });
  const b = J.simulate("both", { exclusive: true, orbCfg, orbSched: m, donLots: 8, donSig: RESC });
  return { n: o.oTr.length, st: J.st(o.oTr), orb: slices(o.arr), both: slices(b.arr),
           orbArr: o.arr, bothArr: b.arr };
}
const f1 = (x) => x.toFixed(1).padStart(6);
const COLS = ["all", "1stH", "2ndH", "rec", "2026"];
const HEAD = "  " + "".padEnd(42) + "ORB".padStart(6) + "".padStart(13) +
  "   ORB book alone              " + "   live account (both books)";
const HEAD2 = "  " + "variant".padEnd(42) + "trades".padStart(6) + "win%".padStart(6) + "$/tr".padStart(7) +
  "   " + COLS.map((s) => s.padStart(6)).join("") + "   " + COLS.map((s) => s.padStart(6)).join("");
const five = (s) => [s.all, s.h1, s.h2, s.rec, s.y26].map(f1).join("");
function line(label, r) {
  console.log("  " + label.padEnd(42) + String(r.n).padStart(6) + r.st.win.toFixed(1).padStart(6) +
    ("$" + r.st.exp.toFixed(0)).padStart(7) + "   " + five(r.orb) + "   " + five(r.both));
}
function bar(t) { console.log("\n" + "=".repeat(118) + "\n" + t + "\n" + "=".repeat(118)); }
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const q90 = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(0.9 * s.length))]; };

const BT = B.setups(BT_ORB).out, LIVE = B.setups(LIVE_ORB).out;
const R_BT = score(BT, BT_ORB), R_LIVE = score(LIVE);

// =============================================================================
bar("1. THE MINUTE THAT CROSSES BOTH LEVELS -- the backtest skips it, the bot cannot");
// =============================================================================
{
  const btDay = new Map(BT.map((s) => [s.day, s]));
  const liveDay = new Map(LIVE.map((s) => [s.day, s]));
  const changed = [...liveDay.keys()].filter((d) => btDay.get(d)?.bar !== liveDay.get(d).bar);
  console.log("\n  ORB days (live config, levels <= 31 pts apart): " + LIVE.length +
    ".  First level-crossing minute went through BOTH levels on " + changed.length +
    " (" + (100 * changed.length / LIVE.length).toFixed(1) + "%).");
  const byY = new Map();
  for (const d of liveDay.keys()) {
    const y = yearOf(d), o = byY.get(y) || [0, 0];
    o[0]++; if (changed.includes(d)) o[1]++; byY.set(y, o);
  }
  console.log("  by year: " + [...byY].map(([y, o]) => y + " " + (100 * o[1] / o[0]).toFixed(0) + "%").join("   "));

  // What each version books on those days, standalone.
  const dayPnl = (r, set) => {
    const m = new Map(); r.orbArr.forEach((v, k) => m.set(days[k], v));
    const v = [...set].map((d) => m.get(d) || 0);
    return { n: v.length, tot: v.reduce((a, x) => a + x, 0), win: v.filter((x) => x > 0).length };
  };
  const a = dayPnl(R_BT, changed), b = dayPnl(R_LIVE, changed);
  console.log("\n  on those " + changed.length + " days      backtest (skips the minute)   what the bot does (fills, stops)");
  console.log("  ORB P&L                    " + ("$" + Math.round(a.tot).toLocaleString()).padStart(12) +
    ("$" + Math.round(b.tot).toLocaleString()).padStart(30));
  console.log("  per day                    " + ("$" + (a.tot / a.n).toFixed(0)).padStart(12) +
    ("$" + (b.tot / b.n).toFixed(0)).padStart(30));
  console.log("  winning days               " + (100 * a.win / a.n).toFixed(0).padStart(11) + "%" +
    (100 * b.win / b.n).toFixed(0).padStart(29) + "%");

  console.log("\n" + HEAD + "\n" + HEAD2);
  line("backtest, no width guard (skips the minute)", score(B.setups(J.ORB_CFG).out, J.ORB_CFG));
  line("backtest, live config (skips the minute)", R_BT);
  line("bot, no width guard (fills, stops)", score(B.setups({ ...J.ORB_CFG, bothWays: "fill" }).out,
                                                   { ...J.ORB_CFG, bothWays: "fill" }));
  line("bot, live config (fills, stops)", R_LIVE);
}

// =============================================================================
bar("2. THE SAME SCOREBOARD -- each book alone on the account, then both, as the bot trades them");
// =============================================================================
{
  const rows = [
    ["Donchian alone, shipped gate (eff >= 0.5)", J.simulate("don", { donSig: G05 })],
    ["Donchian alone, live (+ slow-trend rescue)", J.simulate("don", { donSig: RESC })],
    ["ORB alone, as backtested until now", J.simulate("orb", { orbCfg: BT_ORB, orbSched: sched(BT) })],
    ["ORB alone, as the bot trades it", J.simulate("orb", { orbCfg: LIVE_ORB, orbSched: sched(LIVE) })],
    ["BOTH, as backtested until now", J.simulate("both", { exclusive: true, orbCfg: BT_ORB, orbSched: sched(BT),
                                                          donLots: 8, donSig: RESC })],
    ["BOTH, as the bot trades them", J.simulate("both", { exclusive: true, orbCfg: LIVE_ORB, orbSched: sched(LIVE),
                                                         donLots: 8, donSig: RESC })],
  ];
  console.log("\n  " + "".padEnd(44) + "trades".padStart(7) + "$/day".padStart(8) +
    "   21-day pass:  all  1stH  2ndH  last500  2026" + "   no deadline");
  for (const [label, r] of rows) {
    const n = r.dTr.length + r.oTr.length;
    const s = slices(r.arr);
    console.log("  " + label.padEnd(44) + String(n).padStart(7) + ("$" + mean(r.arr).toFixed(0)).padStart(8) +
      "   " + " ".repeat(11) + [s.all, s.h1, s.h2].map(f1).join("") + f1(s.rec).padStart(9) + f1(s.y26) +
      f1(J.forward(r.arr)).padStart(12) + "%");
  }
  console.log("\n  WHY the windows that did not pass did not pass (share of all 21-day windows):");
  console.log("  " + "".padEnd(44) + "passed".padStart(8) + "drawdown".padStart(10) +
    "clock ran out".padStart(15) + "consistency".padStart(13));
  for (const [label, r] of rows) {
    const o = outcomes(r.arr);
    console.log("  " + label.padEnd(44) + f1(o[0]).padStart(8) + f1(o[1]).padStart(10) +
      f1(o[2]).padStart(15) + f1(o[3]).padStart(13));
  }
}

// =============================================================================
bar("3. LEVERS, judged under what the bot actually does");
// =============================================================================
console.log("\n" + HEAD + "\n" + HEAD2);
line("live ORB (fills on a both-levels minute)", R_LIVE);

// ---- 3a. rest the stops after the opening minute(s) -------------------------
// The both-levels minute is overwhelmingly the 08:30 bar. Arming later skips
// it; a side whose trigger is already behind the price by then is refused.
console.log("\n  a) rest the stops later than the bell");
for (const armCt of [511, 512, 513, 515, 520]) {
  const c = { ...LIVE_ORB, armCt };
  line("   arm at 08:" + String(armCt - 480).padStart(2, "0"), score(B.setups(c).out, c));
}

// ---- 3b. the level spread ------------------------------------------------------
// A both-levels minute needs a range wider than the spread, so the narrowest
// spreads are the most exposed. The live guard keeps ONLY spreads <= 31 points.
console.log("\n  b) which level spreads to trade (live: 0-31 pts)");
for (const [lo, hi] of [[0, Infinity], [0, 31], [8, 31], [12, 31], [16, 31], [12, 45], [16, 60], [20, Infinity]]) {
  const c = { ...LIVE_ORB, maxWidthPts: hi };
  const list = B.setups(c).out.filter((s) => s.width >= lo);
  line("   spread " + lo + "-" + (hi === Infinity ? "any" : hi) + " pts", score(list, c));
}

// ---- 3c. slow-trend alignment, one side armed --------------------------------
// With ONE stop resting, a both-levels minute is only a loss when that stop's
// level was crossed first, and 1-minute bars cannot say. The engine books the
// stop every time, so these rows are a PESSIMISTIC bound.
const known = (t) => {
  const nX = t.close.length, out = new Int32Array(n1).fill(-1);
  let k = 0, cur = -1;
  for (let i = 0; i < n1; i++) { while (k < nX && t.srcLast[k] <= i) { cur = k; k++; } out[i] = cur; }
  return out;
};
const known2 = known(tf);
const trendAtOpen = new Map();
for (const [d, i] of openIdx) {
  const j = known2[i - 1];
  const v = j >= 0 ? Math.sign(t125[j] - t500[j]) : 0;
  trendAtOpen.set(d, Number.isFinite(v) ? v : 0);
}
console.log("\n  c) slow trend (2-min EMA 125 vs 500 before the bell) -- one-sided rows are a pessimistic bound");
const trendVariants = (rd) => ({
  filter: LIVE.filter((s) => rd.get(s.day) === s.dir),
  oneSided: B.setups({ ...LIVE_ORB, sideOf: (d) => rd.get(d) || 0 }).out,
  tilt: LIVE.map((s) => (rd.get(s.day) === -s.dir ? { ...s, riskDollars: 250 } : s)),
});
const TV = trendVariants(trendAtOpen), TR = {};
for (const [k, lbl] of [["filter", "   keep only entries WITH the trend"], ["oneSided", "   arm only the trend side"],
                        ["tilt", "   counter-trend entries at half size"]]) {
  TR[k] = score(TV[k]); line(lbl, TR[k]);
}
{
  // Null: the same trend series rotated by 20 offsets -- same long/short mix,
  // same run lengths, wrong sessions.
  const keys = [...trendAtOpen.keys()], vals = keys.map((d) => trendAtOpen.get(d));
  const OFFS = Array.from({ length: 20 }, (_, k) => 60 + k * Math.floor((keys.length - 120) / 20));
  const acc = { filter: [], oneSided: [], tilt: [] };
  for (const off of OFFS) {
    const v = trendVariants(new Map(keys.map((d, k) => [d, vals[(k + off) % vals.length]])));
    for (const k of Object.keys(acc)) acc[k].push(score(v[k]));
  }
  console.log("     null = trend series rotated 20 ways:   ORB alone mean / 90th / real beats     account mean / 90th / real beats");
  for (const k of Object.keys(acc)) {
    const oa = acc[k].map((r) => r.orb.all), ba = acc[k].map((r) => r.both.all);
    console.log("     " + k.padEnd(36) + f1(mean(oa)).padStart(16) + f1(q90(oa)) +
      (oa.filter((x) => x < TR[k].orb.all).length + "/20").padStart(10) +
      f1(mean(ba)).padStart(24) + f1(q90(ba)) + (ba.filter((x) => x < TR[k].both.all).length + "/20").padStart(10));
  }
}

// ---- 3d. the risk budget, for the ORB book alone -----------------------------
console.log("\n  d) risk per ORB trade (live $500)");
for (const rd of [350, 650, 800, 1000]) {
  const c = { ...LIVE_ORB, riskDollars: rd };
  line("   $" + rd, score(B.setups(c).out, c));
}

// ---- 3e. no ORB at all -----------------------------------------------------------
{
  const don = J.simulate("don", { donSig: RESC });
  const s = slices(don.arr);
  console.log("\n  " + "e) ORB switched off (Donchian alone)".padEnd(42) + " ".repeat(19) + "   " +
    " ".repeat(30) + "   " + five(s));
}

console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
