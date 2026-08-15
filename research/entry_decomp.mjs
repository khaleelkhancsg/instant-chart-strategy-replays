// Does the 0+8 stop entry actually earn its keep, or is it just a worse fill?
//
// The objection is precise and worth answering precisely: price rarely reverses
// before travelling 0.15xATR, so the filter should reject almost nothing, while
// EVERY filled trade pays 0.15xATR of worse entry. On that reading it is a
// strictly late and worse mechanism.
//
// The aggregate numbers cannot settle it, because a sequential book confounds
// three things: which signals are rejected, what price the rest fill at, and
// which OTHER trades become possible when the position slot frees up early.
//
// So this simulates every signal IN ISOLATION -- each one gets both treatments,
// independently, with no position-slot competition and no daily blocks:
//
//   MARKET   fill at the signal bar's open, bracket anchored to that open
//   STOP     fill at open + 0.15xATR if touched on bars 1..10, SAME bracket
//
// The bracket is anchored to the SIGNAL price in both, which is what the bot
// does. That is the crux of the objection: the stop fill is 0.15xATR worse, but
// the target does NOT move with it, so a filled trade needs 1.60xATR instead of
// 1.75 and risks 5.15 instead of 5.00. Whether that trade is better or worse is
// an empirical question, not an obvious one.
//
// Absolute numbers here will not match the live book (no daily rules, no slot
// competition). The COMPARISON is the point.
//
// Usage:  node research/entry_decomp.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const TOTAL = 8, CAP = 1000, TRIG = 0.15, ADD_WIN = 10;
const PV = 2, TICK = 0.25, SLIP = 0.25, PERSIDE = 0.75;
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
const FLAT = 905;

// Resolve one position from bar `from` at fill price `fp`, bracket anchored to
// `ep`. Returns net P&L for 8 lots. The -$1000 cap is applied against a fresh
// day, which is the simplification this isolated study makes.
function resolve(dir, from, ep, fp, slD, tpD) {
  const lossPx = fp - dir * (CAP / (PV * TOTAL));
  const rawSl = ep - dir * slD;
  const sl = dir === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
  const isCap = dir === 1 ? sl === lossPx && lossPx > rawSl : sl === lossPx && lossPx < rawSl;
  const tp = ep + dir * tpD;
  for (let i = from; i < n && i < from + 400; i++) {
    if (CT[i] >= FLAT || TD[i] !== TD[from]) {
      const xp = dir === 1 ? O[i] - SLIP : O[i] + SLIP;
      return { pnl: (xp - fp) * dir * PV * TOTAL - PERSIDE * 2 * TOTAL, why: "FLAT" };
    }
    const hitSl = dir === 1 ? (O[i] <= sl || L[i] <= sl) : (O[i] >= sl || H[i] >= sl);
    const hitTp = dir === 1 ? H[i] >= tp : L[i] <= tp;
    if (hitSl) {
      if (isCap) return { pnl: -CAP, why: "CAP" };
      const px = (dir === 1 ? O[i] <= sl : O[i] >= sl) ? O[i] : sl;
      const xp = dir === 1 ? px - SLIP : px + SLIP;
      return { pnl: (xp - fp) * dir * PV * TOTAL - PERSIDE * 2 * TOTAL, why: "SL" };
    }
    if (hitTp) {
      const xp = dir === 1 ? tp - SLIP : tp + SLIP;
      return { pnl: (xp - fp) * dir * PV * TOTAL - PERSIDE * 2 * TOTAL, why: "TP" };
    }
  }
  return { pnl: 0, why: "NONE" };
}

const rows = [];
for (let i = 1; i < n; i++) {
  const s = sig[i - 1];
  if (!s) continue;
  if (CT[i] < 510 || CT[i] >= 900) continue;
  const a = A[i - 1];
  if (!(a > 0)) continue;
  const ep = O[i];
  const slD = Math.max(a * 5, TICK), tpD = Math.max(a * 1.75, TICK);
  const trigPx = ep + s * Math.max(a * TRIG, TICK);
  // would the stop have filled, on bars i+1 .. i+10, inside the session?
  let fillBar = -1;
  for (let j = i + 1; j <= i + ADD_WIN && j < n; j++) {
    if (CT[j] >= FLAT || TD[j] !== TD[i]) break;
    if (s === 1 ? H[j] >= trigPx : L[j] <= trigPx) { fillBar = j; break; }
  }
  const mkt = resolve(s, i, ep, s === 1 ? ep + SLIP : ep - SLIP, slD, tpD);
  const stp = fillBar > 0
    ? resolve(s, fillBar, ep, s === 1 ? trigPx + SLIP : trigPx - SLIP, slD, tpD)
    : null;
  rows.push({ i, s, a, filled: fillBar > 0, mkt: mkt.pnl, mktWhy: mkt.why,
              stp: stp ? stp.pnl : 0, stpWhy: stp ? stp.why : "NOFILL",
              lag: fillBar > 0 ? fillBar - i : 0 });
}

const st = (arr, key) => {
  if (!arr.length) return { n: 0, win: 0, pf: 0, exp: 0, net: 0 };
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const r of arr) { const v = r[key]; tot += v; if (v > 0) { w++; gw += v; } else gl -= v; }
  return { n: arr.length, win: 100 * w / arr.length, pf: gl ? gw / gl : Infinity,
           exp: tot / arr.length, net: tot };
};
const filled = rows.filter(r => r.filled), missed = rows.filter(r => !r.filled);

console.log(`\n${rows.length} signals studied in isolation (no slot competition, no daily rules)\n`);
console.log("1. HOW OFTEN DOES THE FILTER ACTUALLY REJECT?\n");
console.log(`   never touched +0.15xATR within 10 bars: ${missed.length} of ${rows.length}` +
  `  (${(100 * missed.length / rows.length).toFixed(1)}%)`);
{
  const lags = filled.map(r => r.lag).sort((a, b) => a - b);
  const p = (q) => lags[Math.floor(q * (lags.length - 1))];
  console.log(`   of those that did fill, bars waited: median ${p(0.5)}, 75th ${p(0.75)}, ` +
    `90th ${p(0.9)}, max ${p(1)}`);
  const same = filled.filter(r => r.lag === 1).length;
  console.log(`   filled on the very next bar: ${same} (${(100 * same / filled.length).toFixed(0)}% of fills)`);
}

console.log("\n2. WHAT THE FILTER SAVES — what the REJECTED signals would have done\n");
console.log("   population                       n     win%     pf    $/trade      net");
for (const [lbl, arr, key] of [
  ["ALL signals, entered at market", rows, "mkt"],
  ["  ...the ones that WOULD fill", filled, "mkt"],
  ["  ...the ones REJECTED", missed, "mkt"],
]) {
  const s = st(arr, key);
  console.log(`   ${lbl.padEnd(32)}${String(s.n).padStart(5)}  ${s.win.toFixed(1).padStart(6)}  ` +
    `${s.pf.toFixed(3)}  ${("$" + s.exp.toFixed(2)).padStart(9)}  ${("$" + (s.net / 1000).toFixed(0) + "k").padStart(7)}`);
}

console.log("\n3. WHAT THE WORSE FILL COSTS — same signals, both treatments\n");
console.log("   treatment                        n     win%     pf    $/trade      net");
{
  const m = st(filled, "mkt"), s2 = st(filled, "stp");
  console.log(`   ${"filled signals @ MARKET".padEnd(32)}${String(m.n).padStart(5)}  ${m.win.toFixed(1).padStart(6)}  ` +
    `${m.pf.toFixed(3)}  ${("$" + m.exp.toFixed(2)).padStart(9)}  ${("$" + (m.net / 1000).toFixed(0) + "k").padStart(7)}`);
  console.log(`   ${"filled signals @ STOP +0.15".padEnd(32)}${String(s2.n).padStart(5)}  ${s2.win.toFixed(1).padStart(6)}  ` +
    `${s2.pf.toFixed(3)}  ${("$" + s2.exp.toFixed(2)).padStart(9)}  ${("$" + (s2.net / 1000).toFixed(0) + "k").padStart(7)}`);
  const dd = s2.exp - m.exp;
  console.log(`\n   the worse fill is worth ${(dd >= 0 ? "+" : "") + "$" + dd.toFixed(2)}/trade ` +
    `on the signals it fills`);
}

console.log("\n4. THE WHOLE DECOMPOSITION, per signal seen\n");
{
  const all = st(rows, "mkt");
  const stopTotal = filled.reduce((s, r) => s + r.stp, 0);
  const stopPerSignal = stopTotal / rows.length;
  const savedPerSignal = -st(missed, "mkt").net / rows.length;
  const fillCostPerSignal = (st(filled, "stp").net - st(filled, "mkt").net) / rows.length;
  console.log(`   market entry, every signal        $${all.exp.toFixed(2)} per signal`);
  console.log(`   + not taking the rejected ones    ${(savedPerSignal >= 0 ? "+" : "") + "$" + savedPerSignal.toFixed(2)}`);
  console.log(`   + the worse fill on the rest      ${(fillCostPerSignal >= 0 ? "+" : "") + "$" + fillCostPerSignal.toFixed(2)}`);
  console.log(`   = stop entry, every signal        $${stopPerSignal.toFixed(2)} per signal`);
  console.log(`\n   net effect of the mechanism: ${(stopPerSignal - all.exp >= 0 ? "+" : "") + "$" +
    (stopPerSignal - all.exp).toFixed(2)} per signal seen`);
}

console.log("\n5. EXIT MIX — is the stop entry really just hitting target more often?\n");
console.log("   treatment      TP%     SL%    CAP%   FLAT%");
for (const [lbl, arr, key] of [["market", filled, "mktWhy"], ["stop", filled, "stpWhy"]]) {
  const c = {};
  for (const r of arr) c[r[key]] = (c[r[key]] || 0) + 1;
  const p = (k) => ((100 * (c[k] || 0) / arr.length).toFixed(1) + "%").padStart(7);
  console.log(`   ${lbl.padEnd(12)}${p("TP")}${p("SL")}${p("CAP")}${p("FLAT")}`);
}
