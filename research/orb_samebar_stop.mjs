// "Bought on a sharp wick, instantly hit the stop on that same wick."
//
// The ORB stop is the OPPOSITE level, so its distance is the level SPREAD. A
// tight spread therefore does not just mean a big position -- it means the stop
// sits inside whatever a single bar can do. In 2026 the 2-minute ATR is ~35
// points, so a 12-point level pair puts entry and stop inside one candle's
// range, and the resting stop entry can fill at the top of a wick that is
// already on its way back down.
//
// resolve() models this: it checks the ENTRY bar's own low against the stop. So
// "held == 0 and why == SL" is exactly the event described, and it is countable.
//
//   node research/orb_samebar_stop.mjs

import { setups, resolve, dayStart, TS, H, L, C, O } from "./lib_orb.mjs";

const BASE = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08,
               minTouch: 3, mode: "plain", stopAt: "opposite", rMult: 3.0,
               maxHoldMin: 5, giveUpCt: 570, riskDollars: 500, maxLots: 50,
               maxPerDay: 1 };
const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();

// Simple 1-minute ATR at the entry bar, so "tight" can be expressed against
// what the market was actually doing that morning rather than in raw points.
function atrAt(i, n = 14) {
  let s = 0, c = 0;
  for (let j = Math.max(1, i - n); j < i; j++) {
    s += Math.max(H[j] - L[j], Math.abs(H[j] - C[j - 1]), Math.abs(L[j] - C[j - 1]));
    c++;
  }
  return c ? s / c : 0;
}

function analyse(cfg) {
  const { out } = setups(cfg);
  return out.map((s) => {
    const r = resolve(s, { rMult: cfg.rMult, maxHoldMin: cfg.maxHoldMin,
                           riskDollars: cfg.riskDollars, maxLots: cfg.maxLots });
    const a = atrAt(s.bar);
    return { ...r, atr: a, rAtr: a > 0 ? s.risk / a : Infinity,
             sameBar: r.why === "SL" && r.held === 0, year: yearOf(r.tday) };
  });
}

const all = analyse(BASE);
const kept = analyse({ ...BASE, maxWidthPts: 31 });     // the guard shipped yesterday

console.log("\n" + "=".repeat(100));
console.log("STOPPED OUT ON THE ENTRY BAR ITSELF, BY YEAR");
console.log("=".repeat(100));
console.log("\n  year   trades   same-bar stops   median stop / 1-min ATR   trades with stop < 1 ATR");
for (const y of [...new Set(all.map((t) => t.year))].sort()) {
  const rows = all.filter((t) => t.year === y);
  const sb = rows.filter((t) => t.sameBar).length;
  const ra = rows.map((t) => t.rAtr).sort((a, b) => a - b);
  const under = rows.filter((t) => t.rAtr < 1).length;
  console.log("  " + y + String(rows.length).padStart(9) +
    (sb + " (" + (100 * sb / rows.length).toFixed(1) + "%)").padStart(17) +
    ra[ra.length >> 1].toFixed(2).padStart(26) +
    (under + " (" + (100 * under / rows.length).toFixed(1) + "%)").padStart(27));
}

console.log("\n" + "=".repeat(100));
console.log("WHAT THE WIDTH GUARD DID TO THAT — it keeps the TIGHT-stop days by construction");
console.log("=".repeat(100));
console.log("\n  book                    trades   same-bar stops   med stop/ATR   stop < 1 ATR   $/trade");
for (const [lbl, rows] of [["no guard, all years", all],
                           ["guard <=31pt, all yr", kept],
                           ["no guard, 2026", all.filter((t) => t.year >= 2026)],
                           ["guard <=31pt, 2026", kept.filter((t) => t.year >= 2026)]]) {
  const sb = rows.filter((t) => t.sameBar).length;
  const ra = rows.map((t) => t.rAtr).sort((a, b) => a - b);
  const under = rows.filter((t) => t.rAtr < 1).length;
  console.log("  " + lbl.padEnd(24) + String(rows.length).padStart(6) +
    (sb + " (" + (100 * sb / rows.length).toFixed(1) + "%)").padStart(17) +
    ra[ra.length >> 1].toFixed(2).padStart(15) +
    ((100 * under / rows.length).toFixed(1) + "%").padStart(15) +
    ("$" + (rows.reduce((a, b) => a + b.pnl, 0) / rows.length).toFixed(0)).padStart(10));
}

console.log("\n" + "=".repeat(100));
console.log("WHAT A SAME-BAR STOP COSTS, AND WHETHER THE TRADE WAS RIGHT ANYWAY");
console.log("=".repeat(100));
const sb = all.filter((t) => t.sameBar);
console.log("\n  same-bar stop-outs, all years: " + sb.length + " of " + all.length +
            "  ($" + Math.round(sb.reduce((a, b) => a + b.pnl, 0)).toLocaleString() + " total, $" +
            (sb.reduce((a, b) => a + b.pnl, 0) / sb.length).toFixed(0) + "/trade)");
console.log("  their median stop / 1-min ATR: " +
  sb.map((t) => t.rAtr).sort((a, b) => a - b)[sb.length >> 1].toFixed(2) +
  "   vs " + all.map((t) => t.rAtr).sort((a, b) => a - b)[all.length >> 1].toFixed(2) +
  " for the book as a whole");
