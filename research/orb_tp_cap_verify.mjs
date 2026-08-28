// The target cap looked good: 2026 goes $241 -> $281 a trade at a 60-point cap,
// with the win rate 59.1% -> 68.2%. Before believing it, two questions.
//
//  1. Does the optimum survive a split? 66 trades cannot rank eight caps, so
//     the split is run on 2025-26 (210) as the smallest window with any power.
//  2. Is a FIXED point cap even coherent? The median favourable 5-minute
//     excursion is 57.8 pts in 2026 and 22.5 across the whole history. If the
//     mechanism is "cap the target near where price actually gets to", the best
//     cap must move with the regime. If the same 60 wins everywhere, the number
//     is fitting the sample, not the market -- so an ATR-relative cap is tested
//     alongside, which is what a real version of this idea would look like.
//
//   node research/orb_tp_cap_verify.mjs

import { setups, resolve, dayStart, dayEnd, daySess, CT, TS, H, L, C, OPEN_CT }
  from "./lib_orb.mjs";

const BASE = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08,
               minTouch: 3, mode: "plain", stopAt: "opposite", rMult: 3.0,
               maxHoldMin: 5, giveUpCt: 570, riskDollars: 500, maxLots: 50,
               maxPerDay: 1 };
const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const sum = (a) => a.reduce((x, y) => x + y, 0);
const out = setups(BASE).out;

function preAtr(day, n = 14) {
  const s0 = daySess.get(day), e0 = dayEnd.get(day);
  const idx = [];
  for (let i = s0; i < e0 && CT[i] < OPEN_CT; i++) if (CT[i] >= OPEN_CT - 120) idx.push(i);
  const tail = idx.slice(-n);
  if (tail.length < 2) return 0;
  return sum(tail.map((i) => Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]),
                                      Math.abs(L[i] - C[i - 1])))) / tail.length;
}

function run({ cap = Infinity, atrMult = 0 }) {
  return out.map((s) => {
    const tpCapPts = atrMult ? atrMult * preAtr(s.day) : cap;
    return { ...resolve(s, { rMult: 3, maxHoldMin: 5, riskDollars: 500,
                             maxLots: 50, tpCapPts }),
             year: yearOf(s.day) };
  });
}
const per = (rows) => (rows.length ? sum(rows.map((r) => r.pnl)) / rows.length : 0);
const win = (rows) => 100 * rows.filter((r) => r.pnl > 0).length / rows.length;

console.log("\n" + "=".repeat(94));
console.log("1. SPLIT THE MODERN WINDOW — pick on the first half, read the second");
console.log("=".repeat(94));
const modern = (rows) => rows.filter((r) => r.year >= 2025);
const CAPS = [20, 30, 40, 60, 80, 120, Infinity];
console.log("\n  target cap      1st half $/tr     2nd half $/tr      1st win%   2nd win%");
const rows = [];
for (const cap of CAPS) {
  const all = modern(run({ cap }));
  const h = all.length >> 1;
  const a = all.slice(0, h), b = all.slice(h);
  rows.push({ cap, a: per(a), b: per(b) });
  console.log("  " + (cap === Infinity ? "none (3R)" : cap + " pts").padEnd(14) +
    ("$" + per(a).toFixed(0)).padStart(14) + ("$" + per(b).toFixed(0)).padStart(18) +
    win(a).toFixed(1).padStart(14) + win(b).toFixed(1).padStart(11));
}
const base = rows[rows.length - 1];
const best = rows.slice(0, -1).sort((x, y) => y.a - x.a)[0];
console.log("\n  best on the 1st half: " + best.cap + " pts  ($" + best.a.toFixed(0) + ")");
console.log("  its 2nd half:         $" + best.b.toFixed(0) +
            "   vs $" + base.b.toFixed(0) + " uncapped   -> " +
            (best.b - base.b >= 0 ? "+" : "") + "$" + (best.b - base.b).toFixed(0));

console.log("\n" + "=".repeat(94));
console.log("2. IS A FIXED CAP COHERENT? the same number cannot suit both regimes");
console.log("=".repeat(94));
console.log("\n  best fixed cap by window (by $/trade)");
for (const [fy, label] of [[2026, "2026"], [2025, "2025-26"], [2022, "2022-26"],
                           [2019, "all years"]]) {
  const scored = CAPS.map((cap) => ({ cap, v: per(run({ cap }).filter((r) => r.year >= fy)) }));
  scored.sort((x, y) => y.v - x.v);
  console.log("    " + label.padEnd(12) + "best " +
    String(scored[0].cap === Infinity ? "none" : scored[0].cap + " pts").padEnd(9) +
    "$" + scored[0].v.toFixed(0) + "/tr" +
    "    uncapped $" + per(run({}).filter((r) => r.year >= fy)).toFixed(0));
}

console.log("\n  the regime-invariant form — cap as a multiple of the pre-open ATR");
console.log("  multiple      2026 $/tr    2025-26 $/tr   all years $/tr");
for (const m of [2, 3, 4, 6, 8, 0]) {
  const r = run(m ? { atrMult: m } : {});
  const cell = (fy) => "$" + per(r.filter((x) => x.year >= fy)).toFixed(0);
  console.log("  " + (m ? m + "x ATR" : "uncapped").padEnd(14) +
    cell(2026).padStart(9) + cell(2025).padStart(15) + cell(2019).padStart(16));
}
