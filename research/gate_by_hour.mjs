// "ADX 25 is a high bar -- how is anything entering at 15:30?"
//
// Because none of the three gates measures SIZE. ADX, the Kaufman efficiency
// ratio and a Donchian breakout are all scale-free: they ask whether a move is
// tidy and whether it exceeds a recent range, never whether it is big. A quiet
// afternoon compresses the range, so a small tidy drift clears all three just as
// easily as a violent opening drive -- and clears them on a 60-minute Donchian
// lookback that has itself shrunk.
//
// Two further things make "ADX 25" much softer than it sounds:
//   - it is computed on 2-MINUTE bars, so 14 periods is 28 minutes, not 14 days
//   - it uses a plain EMA (alpha 2/(n+1)), not Wilder's (alpha 1/n), so it is
//     roughly twice as responsive and crosses its threshold far more often
//
// This measures all of that rather than asserting it.
//
// Usage:  node research/gate_by_hour.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { atr, adx, donchian, efficiencyRatio } from "../src/indicators.mjs";

const { bars } = loadBars();
const tf = resample(bars, 2);
const A = atr(tf.high, tf.low, tf.close, 14);
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const eff = efficiencyRatio(tf.close, 20);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const { close: C, high: H, low: L, ctMin: CT } = tf;
const n = C.length;

const et = (ct) => String(Math.floor((ct + 60) / 60)).padStart(2, "0") + ":" +
                   String((ct + 60) % 60).padStart(2, "0");
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length * p)]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---- how restrictive is ADX 25 here at all? ------------------------------
const rth = [];
for (let i = 30; i < n; i++) if (CT[i] >= 510 && CT[i] < 900) rth.push(ax[i]);
console.log("\n" + "=".repeat(104));
console.log("WHY TRADES STILL FIRE LATE IN THE DAY");
console.log("=".repeat(104));
console.log("\n-- first: ADX 25 is not a high bar on 2-minute EMA bars --");
console.log("  RTH bars measured:            " + rth.length.toLocaleString());
console.log("  share with ADX >= 25:         " + (100 * rth.filter(v => v >= 25).length / rth.length).toFixed(1) + "%");
console.log("  ADX percentiles  10/25/50/75/90:  " +
  [0.1, 0.25, 0.5, 0.75, 0.9].map(p => pct(rth, p).toFixed(1)).join("  "));
console.log("  -> 25 sits near the " +
  (100 * rth.filter(v => v < 25).length / rth.length).toFixed(0) + "th percentile. On a DAILY Wilder");
console.log("     chart ADX 25 is a real trend filter; on 2-minute EMA bars it is close to a coin flip.");

// ---- the gates, and the market, by half hour ----------------------------
console.log("\n-- the gates do not tighten in the afternoon. The MARKET shrinks. --");
console.log("  window        bars   ADX>=25   eff>=0.5   both   ATR pts   Donchian width   break rate   signal rate");
const B = new Map();
for (let i = 30; i < n; i++) {
  if (CT[i] < 510 || CT[i] >= 900) continue;
  const b = Math.floor((CT[i] - 510) / 30);
  if (!B.has(b)) B.set(b, []);
  B.get(b).push(i);
}
const rows = [];
for (const b of [...B.keys()].sort((x, y) => x - y)) {
  const idx = B.get(b);
  const a25 = idx.filter(i => ax[i] >= 25).length;
  const e50 = idx.filter(i => eff[i] >= 0.5).length;
  const both = idx.filter(i => ax[i] >= 25 && eff[i] >= 0.5).length;
  const brk = idx.filter(i => C[i] > dh[i] || C[i] < dl[i]).length;
  const sigN = idx.filter(i => ax[i] >= 25 && eff[i] >= 0.5 && (C[i] > dh[i] || C[i] < dl[i])).length;
  const atrM = mean(idx.map(i => A[i]));
  const dw = mean(idx.map(i => dh[i] - dl[i]));
  rows.push({ b, n: idx.length, atrM, dw, sig: 100 * sigN / idx.length });
  console.log("  " + (et(510 + b * 30) + "-" + et(510 + b * 30 + 30)).padEnd(14) +
    String(idx.length).padStart(6) +
    (100 * a25 / idx.length).toFixed(1).padStart(9) + "%" +
    (100 * e50 / idx.length).toFixed(1).padStart(10) + "%" +
    (100 * both / idx.length).toFixed(1).padStart(7) + "%" +
    atrM.toFixed(1).padStart(10) + dw.toFixed(1).padStart(17) +
    (100 * brk / idx.length).toFixed(1).padStart(13) + "%" +
    (100 * sigN / idx.length).toFixed(2).padStart(13) + "%");
}

const first = rows[0], last = rows[rows.length - 1];
console.log("\n  09:30-10:00 vs 15:30-16:00:");
console.log("    ATR              " + first.atrM.toFixed(1) + " -> " + last.atrM.toFixed(1) +
            " pts  (" + (100 * last.atrM / first.atrM - 100).toFixed(0) + "%)");
console.log("    Donchian width   " + first.dw.toFixed(1) + " -> " + last.dw.toFixed(1) +
            " pts  (" + (100 * last.dw / first.dw - 100).toFixed(0) + "%)");
console.log("    signal rate      " + first.sig.toFixed(2) + "% -> " + last.sig.toFixed(2) + "% of bars");

// ---- what that means for the trade you get ------------------------------
console.log("\n-- so the afternoon trade is not a worse trade, it is a SMALLER one --");
console.log("  the bracket is ATR-scaled: stop 5xATR, target 1.75xATR, at $2/point x 8 lots");
console.log("\n  window        ATR pts   target pts   target $   stop pts    stop $   cap allows");
for (const r of rows) {
  const tp = 1.75 * r.atrM, sl = 5 * r.atrM;
  console.log("  " + (et(510 + r.b * 30) + "-" + et(510 + r.b * 30 + 30)).padEnd(14) +
    r.atrM.toFixed(1).padStart(7) + tp.toFixed(1).padStart(13) +
    ("$" + Math.round(tp * 2 * 8)).padStart(11) + sl.toFixed(1).padStart(11) +
    ("$" + Math.round(sl * 2 * 8)).padStart(10) +
    (sl * 2 * 8 > 1000 ? "   cap binds (62.5 pts)" : "   stop fits"));
}
