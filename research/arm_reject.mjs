// A correctly-timed arm was still rejected: "Order price is outside allowed
// range. Please set price below best ask."
//
// SHORT, ref 29555.00, armed 29553.00 (2.00 pts = 0.15xATR below). A SELL STOP
// must sit BELOW the market. If price has already traded down through 29553 by
// the time the order is sent, the stop is at or above the ask and the exchange
// refuses it.
//
// The deferral is what makes that likely. The signal bar closes, the bot waits
// one bar, THEN sends the order -- so price has had a full two minutes to cover
// the 2 points to the trigger. Meanwhile the backtest fills at armPx whenever a
// bar range touches it, with no check on where that bar OPENED. When the open is
// already past the trigger, that is a fill at a price the market has left: the
// same gap-through defect found and fixed in the ORB code.
//
// Measures how often it happens and what the headline becomes once the backtest
// is honest about it.
//
// Usage:  node research/arm_reject.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750, TOTAL = 8;
const TRIG = 0.15, ADD_WIN = 10, PV = 2, TICK = 0.25, SLIP = 0.25, PERSIDE = 0.75;
const FLAT = 905, NOENTRY = 895;
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
const { open: O, high: H, low: L, ctMin: CT, tday: TD } = tf;

// mode: "optimistic" = current backtest, fills at armPx whenever touched
//       "reject"     = placement bar opens past the trigger, exchange refuses,
//                      no trade happens (what the bot does today)
//       "market"     = send a market order instead, filling at that open
function run(mode, thruTicks = 0) {
  const thru = thruTicks * TICK;
  const trades = [];
  let rejected = 0, arms = 0, fills = 0;
  const slipPts = [];
  let pos = 0, ep = 0, slD = 0, tpD = 0, qty = 0, notional = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = 0, armEp = 0, armSl = 0, armTp = 0;
  let isLimit = false;                  // working as a LIMIT rather than a STOP
  let limitPlaced = 0, limitFilled = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  const avgFill = () => notional / qty;
  const blocked = () => capHit || dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK;
  const close_ = (px, i, exact) => {
    const xp = pos === 1 ? px - SLIP : px + SLIP;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * PV * qty - PERSIDE * 2 * qty;
    trades.push({ tday: TD[i], pnl: net });
    dayReal += net; if (dayReal <= -CAP) capHit = true;
    pos = 0; notional = 0;
  };
  const enter = (px) => {
    slipPts.push((px - armPx) * armDir);
    pos = armDir; qty = TOTAL; ep = armEp; slD = armSl; tpD = armTp;
    notional = (pos === 1 ? px + SLIP : px - SLIP) * qty;
    armDir = 0; fills++;
  };
  for (let i = 1; i < n; i++) {
    const s2 = sig[i - 1];
    const flatNow = CT[i] >= FLAT || CT[i] < 510;
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    if (pos === 0 && armDir !== 0) {
      if (flatNow || i > armBy || blocked()) armDir = 0;
      else if (mode !== "immediate" && i === armBar + 1) {
        // THE PLACEMENT BAR. Is the trigger still on the correct side of market?
        const through = armDir === 1 ? O[i] >= armPx : O[i] <= armPx;
        const touched = armDir === 1 ? H[i] >= armPx : L[i] <= armPx;
        if (through) {
          rejected++;
          if (mode === "optimistic") { if (touched) enter(armPx); }
          else if (mode === "market") enter(O[i]);
          else if (mode === "limit") {
            // A STOP is invalid on this side, but a LIMIT at the same price is
            // valid: sell-limit rests ABOVE market, buy-limit BELOW. Same entry
            // price, same intent -- and the 0.15xATR confirmation has already
            // happened, which is WHY the stop was refused. Fill now needs price
            // to come back to the level, so the side of the test flips.
            isLimit = true; limitPlaced++;
            const back = armDir === 1 ? L[i] <= armPx - thru : H[i] >= armPx + thru;
            if (back) { limitFilled++; enter(armPx); }
          }
          else armDir = 0;                      // exchange refuses, no position
        } else if (touched) enter(armPx);
      } else if (mode === "pollmkt") {
        if (armDir === 1 ? H[i] >= armPx : L[i] <= armPx) enter(armPx + armDir * thru);
      } else if (i > armBar + (mode === "immediate" ? 0 : 1)) {
        const hit = isLimit ? (armDir === 1 ? L[i] <= armPx - thru : H[i] >= armPx + thru)
                            : (armDir === 1 ? H[i] >= armPx : L[i] <= armPx);
        if (hit) { if (isLimit) limitFilled++; enter(armPx); }
      }
    }
    if (pos !== 0) {
      if (flatNow) { close_(O[i], i); continue; }
      const dir = pos;
      const lossPx = avgFill() - dir * ((CAP + dayReal) / (PV * qty));
      const rawSl = ep - dir * slD;
      const sl = dir === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
      const isCap = dir === 1 ? (sl === lossPx && lossPx > rawSl) : (sl === lossPx && lossPx < rawSl);
      const tp = ep + dir * tpD;
      const cut = isCap ? -CAP - dayReal : undefined;
      let done = false;
      if (dir === 1) {
        if (O[i] <= sl) { close_(O[i], i, cut); done = true; }
        else if (L[i] <= sl) { close_(sl, i, cut); done = true; }
        else if (H[i] >= tp) { close_(tp, i); done = true; }
      } else {
        if (O[i] >= sl) { close_(O[i], i, cut); done = true; }
        else if (H[i] >= sl) { close_(sl, i, cut); done = true; }
        else if (L[i] <= tp) { close_(tp, i); done = true; }
      }
      if (done) continue;
      if (s2 !== 0 && s2 !== pos) close_(O[i], i);
      if (pos !== 0) continue;
    }
    if (pos === 0 && s2 !== 0 && !flatNow && !blocked() && CT[i] < NOENTRY) {
      const a = A[i - 1];
      if (!(a > 0)) continue;
      arms++;
      isLimit = false;
      armDir = s2; armBar = i; armBy = i + ADD_WIN; armEp = O[i];
      armPx = O[i] + s2 * Math.max(a * TRIG, TICK);
      armSl = Math.max(a * 5, TICK); armTp = Math.max(a * 1.75, TICK);
      // IMMEDIATE placement: the order reaches the exchange a few seconds into
      // THIS bar, so this bar can fill it. Rejection is impossible here --
      // armPx is 0.15xATR beyond O[i] by construction, so the stop is always on
      // the correct side of the market at the moment it is sent. That is the
      // whole reason this variant cannot produce the error seen live.
      if (mode === "immediate" && (armDir === 1 ? H[i] >= armPx : L[i] <= armPx))
        enter(armPx);
      // POLL AND MARKET: no resting order at all. Watch price, and the instant it
      // touches the level send a market order. Cannot be rejected under any
      // circumstances, which no resting variant can claim. Costs reaction
      // slippage -- how much depends entirely on how often price is checked.
      if (mode === "pollmkt" && (armDir === 1 ? H[i] >= armPx : L[i] <= armPx))
        enter(armPx + armDir * thru);
    }
  }
  return { trades, rejected, arms, fills, slipPts, limitPlaced, limitFilled };
}

const days = [...new Set(tf.tday)].sort((a, b) => a - b);
const H1 = days.slice(0, days.length >> 1), H2 = days.slice(days.length >> 1);
const RECENT = days.slice(-500);
function ev(d) {
  let c = 0, pk = 0, lk = false, md = -1e18;
  for (const v of d) {
    c += v; if (v > md) md = v;
    if (c <= (lk ? 0 : pk - 2000)) return 0;
    if (c > pk) pk = c;
    if (!lk && pk >= 2000) lk = true;
    if (c >= 3000 && md <= 0.5 * c) return 1;
  }
  return 0;
}
function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function passOf(tr, keys) {
  const m = new Map(); for (const d of keys) m.set(d, 0);
  for (const t of tr) if (m.has(t.tday)) m.set(t.tday, m.get(t.tday) + t.pnl);
  const arr = keys.map(k => m.get(k)); const rnd = mul(4242);
  const idx = new Array(21), buf = new Array(21); let w = 0;
  for (let d = 0; d < 12000; d++) {
    let mm = 0;
    while (mm < 21) { const st = Math.floor(rnd() * Math.max(1, arr.length - 5));
      for (let j = 0; j < 5 && mm < 21; j++) idx[mm++] = (st + j) % arr.length; }
    for (let k = 0; k < 21; k++) buf[k] = arr[idx[k]];
    w += ev(buf);
  }
  return 100 * w / 12000;
}
const stat = (t) => {
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const x of t) { tot += x.pnl; if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; }
  return { n: t.length, win: 100 * w / t.length, pf: gw / gl, exp: tot / t.length, net: tot };
};
const inSet = (t, s) => { const q = new Set(s); return t.filter(x => q.has(x.tday)); };

console.log("\n" + "=".repeat(108));
console.log("HOW OFTEN IS THE ARM ALREADY THROUGH ITS TRIGGER WHEN THE BOT SENDS IT?");
console.log("=".repeat(108));
const o = run("optimistic");
console.log("\n  arms placed                       " + o.arms);
console.log("  placement bar OPENS past trigger  " + o.rejected +
            "   (" + (100 * o.rejected / o.arms).toFixed(1) + "% of arms)");
console.log("\n  Each of those is an order the exchange refuses, AND a fill the backtest books");
console.log("  at a price the market has already left.");

console.log("\n  handling                        fills   win%     pf   $/trade      net    pass   1stH   2ndH  recent");
for (const [lbl, mode] of [["optimistic (current backtest)", "optimistic"],
                           ["rejected, no trade (live now)", "reject"],
                           ["market order at the open", "market"],
                           ["place IMMEDIATELY, no deferral", "immediate"],
                           ["LIMIT, fills on touch", "limit"],
                           ["LIMIT, must trade 1 tick through", "limit1"],
                           ["LIMIT, must trade 2 ticks through", "limit2"],
                           ["poll + MARKET on touch, +0t", "pollmkt0"],
                           ["poll + MARKET on touch, +1t", "pollmkt1"],
                           ["poll + MARKET on touch, +2t", "pollmkt2"],
                           ["poll + MARKET on touch, +4t", "pollmkt4"]]) {
  const thru = mode === "limit1" ? 1 : mode === "limit2" ? 2
             : mode.startsWith("pollmkt") ? Number(mode.slice(-1)) : 0;
  const base = mode.startsWith("limit") ? "limit"
             : mode.startsWith("pollmkt") ? "pollmkt" : mode;
  const r = run(base, thru), s = stat(r.trades);
  const avgSlip = r.slipPts.length ? r.slipPts.reduce((a, b) => a + b, 0) / r.slipPts.length : 0;
  console.log("  " + lbl.padEnd(30) + String(r.fills).padStart(6) + s.win.toFixed(1).padStart(7) +
    s.pf.toFixed(3).padStart(7) + ("$" + s.exp.toFixed(2)).padStart(10) +
    ("$" + Math.round(s.net / 1000) + "k").padStart(9) +
    passOf(r.trades, days).toFixed(1).padStart(8) + "%" +
    passOf(inSet(r.trades, H1), H1).toFixed(1).padStart(6) + "%" +
    passOf(inSet(r.trades, H2), H2).toFixed(1).padStart(6) + "%" +
    passOf(inSet(r.trades, RECENT), RECENT).toFixed(1).padStart(7) + "%" +
    (mode === "market" ? "   avg fill " + avgSlip.toFixed(2) + " pts past trigger" : "") +
    (mode.startsWith("limit") ? "   " + r.limitFilled + "/" + r.limitPlaced + " limits filled (" +
      (100 * r.limitFilled / Math.max(1, r.limitPlaced)).toFixed(1) + "%)" : ""));
}
