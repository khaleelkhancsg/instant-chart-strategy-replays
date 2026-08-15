// What the shipped 0+8 stop entry should look like in a live log, and what
// should stop the session.
//
// The bot is about to trade a mechanism that has never touched an exchange. The
// useful thing is not another pass rate, it is a set of numbers that can be
// checked against a day of real fills -- and a short list of observations that
// mean something is wrong rather than merely unlucky.
//
// Everything here is the shipped configuration: 8 lots, stop entry at
// +0.15xATR placed one bar after the signal, 10-bar window, 5xATR / 1.75xATR
// anchored to the SIGNAL price, -$1000 cap, +$750 / -$500 daily rules,
// 08:30-15:00 CT with a flatten at 15:04.
//
// Usage:  node research/live_expectations.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const TOTAL = 8, CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750;
const TRIG = 0.15, ADD_WIN = 10, PV = 2, TICK = 0.25, SLIP = 0.25, PERSIDE = 0.75;
const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const n = tf.close.length;
const raw = new Int8Array(n);
for (let i = 30; i < n; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
const FLAT = 905, NOENTRY = 895;

const trades = [];
let arms = 0, fills = 0, expired = 0;
const lags = [];
let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0, qty = 0, notional = 0;
let entBar = 0, eATR = 0, capAtEntry = false;
let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0, armA = 0;
let curTday = -1e9, dayReal = 0, capHit = false;
const avgFill = () => notional / qty;
const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
const close_ = (px, i, exact, why) => {
  const xp = pos === 1 ? px - SLIP : px + SLIP;
  const net = exact !== undefined ? exact
            : (xp - avgFill()) * pos * PV * qty - PERSIDE * 2 * qty;
  trades.push({ tday: TD[i], entryTime: entTime, pnl: net, why,
                mins: (i - entBar) * 2, atr: eATR, capAtEntry });
  dayReal += net;
  if (dayReal <= -CAP) capHit = true;
  pos = 0; notional = 0;
};
for (let i = 1; i < n; i++) {
  const s = sig[i - 1];
  const flatNow = CT[i] >= FLAT || CT[i] < 510;
  if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
  if (pos === 0 && armDir !== 0) {
    if (flatNow || i > armBy || blocked()) { if (armDir) expired++; armDir = 0; }
    else if (i > armBar && (armDir === 1 ? H[i] >= armPx : L[i] <= armPx)) {
      pos = armDir; qty = TOTAL; ep = armEp; slD = armSl; tpD = armTp;
      entTime = TS[i]; entBar = i; eATR = armA;
      capAtEntry = (CAP / (PV * TOTAL)) < armSl;
      notional = (pos === 1 ? armPx + SLIP : armPx - SLIP) * qty;
      lags.push(i - armBar); fills++; armDir = 0;
    }
  }
  if (pos !== 0) {
    if (flatNow) { close_(O[i], i, undefined, "FLAT"); continue; }
    const dir = pos;
    const lossPx = avgFill() - dir * ((CAP + dayReal) / (PV * qty));
    const rawSl = ep - dir * slD;
    const sl = dir === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
    const isCap = dir === 1 ? (sl === lossPx && lossPx > rawSl) : (sl === lossPx && lossPx < rawSl);
    const tp = ep + dir * tpD;
    const cut = isCap ? -CAP - dayReal : undefined;
    const rn = isCap ? "CAP" : "SL";
    let done = false;
    if (dir === 1) {
      if (O[i] <= sl) { close_(O[i], i, cut, rn); done = true; }
      else if (L[i] <= sl) { close_(sl, i, cut, rn); done = true; }
      else if (H[i] >= tp) { close_(tp, i, undefined, "TP"); done = true; }
    } else {
      if (O[i] >= sl) { close_(O[i], i, cut, rn); done = true; }
      else if (H[i] >= sl) { close_(sl, i, cut, rn); done = true; }
      else if (L[i] <= tp) { close_(tp, i, undefined, "TP"); done = true; }
    }
    if (done) continue;
    if (s !== 0 && s !== pos) close_(O[i], i, undefined, "FLIP");
    if (pos !== 0) continue;
  }
  if (pos === 0 && s !== 0 && !flatNow && !blocked() && CT[i] < NOENTRY) {
    const a = A[i - 1];
    if (!(a > 0)) continue;
    arms++;
    armDir = s; armBar = i; armBy = i + ADD_WIN; armEp = O[i]; armA = a;
    armPx = O[i] + s * Math.max(a * TRIG, TICK);
    armSl = Math.max(a * 5, TICK); armTp = Math.max(a * 1.75, TICK);
  }
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const days = new Map();
for (const t of trades) days.set(t.tday, (days.get(t.tday) ?? 0) + t.pnl);
const perDayCount = new Map();
for (const t of trades) perDayCount.set(t.tday, (perDayCount.get(t.tday) ?? 0) + 1);
const allDays = new Set(); for (let i = 0; i < n; i++) allDays.add(tf.tday[i]);
const dayPnls = [...allDays].map(d => days.get(d) ?? 0);

console.log("\n=== WHAT NORMAL LOOKS LIKE ===\n");
console.log("ORDER LIFECYCLE");
console.log(`  arms placed                ${arms}`);
console.log(`  filled                     ${fills}  (${(100 * fills / arms).toFixed(1)}%)`);
console.log(`  expired unfilled           ${arms - fills}  (${(100 * (arms - fills) / arms).toFixed(1)}%)`);
console.log(`  bars from arm to fill      median ${pct(lags, .5)}, 75th ${pct(lags, .75)}, ` +
  `90th ${pct(lags, .9)}, max ${pct(lags, 1)}`);
console.log(`  filled on the FIRST live bar  ${(100 * lags.filter(x => x === 1).length / lags.length).toFixed(0)}% of fills`);

console.log("\nPER DAY");
const c = [0, 0, 0, 0];
for (const d of allDays) { const k = Math.min(3, perDayCount.get(d) ?? 0); c[k]++; }
console.log(`  no trade at all            ${(100 * c[0] / allDays.size).toFixed(0)}% of days`);
console.log(`  exactly 1 trade            ${(100 * c[1] / allDays.size).toFixed(0)}%`);
console.log(`  exactly 2                  ${(100 * c[2] / allDays.size).toFixed(0)}%`);
console.log(`  3 or more                  ${(100 * c[3] / allDays.size).toFixed(0)}%`);
console.log(`  trades per calendar day    ${(trades.length / allDays.size).toFixed(2)}`);

console.log("\nPER TRADE");
let w = 0, gw = 0, gl = 0;
for (const t of trades) { if (t.pnl > 0) { w++; gw += t.pnl; } else gl -= t.pnl; }
console.log(`  win rate                   ${(100 * w / trades.length).toFixed(1)}%`);
console.log(`  profit factor              ${(gw / gl).toFixed(3)}`);
console.log(`  hold time                  median ${pct(trades.map(t => t.mins), .5)}m, ` +
  `75th ${pct(trades.map(t => t.mins), .75)}m, 90th ${pct(trades.map(t => t.mins), .9)}m`);
const byWhy = {};
for (const t of trades) byWhy[t.why] = (byWhy[t.why] ?? 0) + 1;
console.log("  exit reasons               " + Object.entries(byWhy).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${(100 * v / trades.length).toFixed(0)}%`).join("   "));
const capBind = trades.filter(t => t.capAtEntry).length;
console.log(`  cap is the nearer stop     ${(100 * capBind / trades.length).toFixed(0)}% of entries`);
console.log(`  typical stop distance      ${(CAP / (PV * TOTAL)).toFixed(1)} pts when capped, ` +
  `5xATR otherwise (ATR median ${pct(trades.map(t => t.atr), .5).toFixed(1)})`);

console.log("\nPER DAY P&L");
console.log(`  mean                       $${(dayPnls.reduce((a, b) => a + b, 0) / dayPnls.length).toFixed(0)}`);
console.log(`  median                     $${pct(dayPnls, .5).toFixed(0)}`);
console.log(`  5th / 95th percentile      $${pct(dayPnls, .05).toFixed(0)} / $${pct(dayPnls, .95).toFixed(0)}`);
console.log(`  worst / best day           $${pct(dayPnls, 0).toFixed(0)} / $${pct(dayPnls, 1).toFixed(0)}`);
console.log(`  losing days                ${(100 * dayPnls.filter(v => v < 0).length / dayPnls.length).toFixed(0)}%`);
{
  let run = 0, worst = 0;
  for (const d of [...allDays].sort((a, b) => a - b)) {
    const v = days.get(d) ?? 0;
    if (v < 0) { run++; if (run > worst) worst = run; } else if (v > 0) run = 0;
  }
  console.log(`  longest losing streak      ${worst} days`);
}

console.log("\n\n=== RED FLAGS ===\n");
console.log("TIMING — the one thing worth stopping for");
console.log("  the arm must go out on the bar AFTER the signal bar closes.");
console.log("  same bar   -18pp   (34.4% vs 52.9%)   two bars late  -8.8pp");
console.log("  Check the first three trades against the log timestamps. If the");
console.log("  order is sent within the same 2-minute bucket as the signal, stop.");
console.log("");
console.log("FILL PRICE");
console.log(`  expect fills at or within ~2 ticks of entry + 0.15xATR`);
console.log("  each extra tick of entry slippage costs about 1.5pp of pass rate");
console.log("  3+ ticks of MEAN absolute slippage is a red flag, not a bad day");
console.log("");
console.log("BRACKET PRICES — the largest untested assumption");
console.log(`  on a filled 8-lot entry the stop should sit ${(CAP / (PV * TOTAL)).toFixed(1)} points away`);
console.log("  whenever 5xATR is wider than that, and 5xATR away when it is not.");
console.log("  A stop at 62.5 points on a ONE-lot order, or a target on the wrong");
console.log("  side, means the tick convention differs from what was assumed.");
console.log("");
console.log("ORDER STATE — these are bugs, not variance");
console.log("  more than one working entry order at any moment");
console.log("  a working order while the platform shows no position AND no arm");
console.log("  a position larger than 8 lots");
console.log("  an order still working after 15:04 CT");
console.log("");
console.log("NOT RED FLAGS — expected shape, do not react");
console.log(`  a losing day: ${(100 * dayPnls.filter(v => v < 0).length / dayPnls.length).toFixed(0)}% of days lose`);
console.log(`  several losing days in a row: the record is ${(() => { let r = 0, wst = 0;
  for (const d of [...allDays].sort((a, b) => a - b)) { const v = days.get(d) ?? 0;
    if (v < 0) { r++; if (r > wst) wst = r; } else if (v > 0) r = 0; } return wst; })()} consecutive`);
console.log(`  a day with no trade at all: ${(100 * c[0] / allDays.size).toFixed(0)}% of days`);
console.log("  an arm that expires unfilled: 13% of them do, and that is the edge");
console.log("  one loss ending the day: a capped loss is ~$1000 against a -$500 breaker");
