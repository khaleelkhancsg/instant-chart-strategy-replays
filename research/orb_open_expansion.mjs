// Today's trade, and the flaw it exposes.
//
//   08:30:02  levels 29371.70 / 29348.12  -> spread 23.58 pts
//             armed LONG 10 lots @ 29372.00, stop 29348.25 (23.75 pts, $478)
//   08:30:16  filled
//   08:30:38  stopped out, -$487
//   the 08:30 bar: O 29351.00  H 29433.75  L 29338.50  C 29426.75
//
// A 95-point opening bar against a 23.75-point stop. The position never had
// room. And the stop was not badly chosen -- it is the opposite LEVEL, exactly
// as designed. The flaw is that the stop is sized from PRE-OPEN structure while
// the trade is taken in the most violent minute of the day, where the range
// runs several times the pre-open ATR.
//
// The max-width guard shipped yesterday makes this worse by construction: it
// removes wide level pairs, so what remains is tight ones.
//
//   node research/orb_open_expansion.mjs

import { setups, resolve, dayStart, dayEnd, daySess, dayKeys, TS, CT,
         H, L, C, O, OPEN_CT } from "./lib_orb.mjs";

const BASE = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08,
               minTouch: 3, mode: "plain", stopAt: "opposite", rMult: 3.0,
               maxHoldMin: 5, giveUpCt: 570, riskDollars: 500, maxLots: 50,
               maxPerDay: 1 };
const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * a.length)];

// ATR over the pre-open window only -- everything here is known by 08:30.
function preOpenAtr(day, n = 14) {
  const s0 = daySess.get(day), e0 = dayEnd.get(day);
  const idx = [];
  for (let i = s0; i < e0 && CT[i] < OPEN_CT; i++) if (CT[i] >= OPEN_CT - 120) idx.push(i);
  const tail = idx.slice(-n);
  if (tail.length < 2) return 0;
  let s = 0;
  for (const i of tail) s += Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]),
                                      Math.abs(L[i] - C[i - 1]));
  return s / tail.length;
}
// The realised range of the first five minutes -- NOT causal, diagnosis only.
function openRange(day, mins = 5) {
  const s0 = daySess.get(day), e0 = dayEnd.get(day);
  let hi = -Infinity, lo = Infinity;
  for (let i = s0; i < e0; i++) {
    if (CT[i] < OPEN_CT || CT[i] >= OPEN_CT + mins) continue;
    if (H[i] > hi) hi = H[i]; if (L[i] < lo) lo = L[i];
  }
  return hi > lo ? hi - lo : 0;
}

console.log("\n" + "=".repeat(98));
console.log("HOW MUCH THE OPEN EXPANDS OVER THE PRE-OPEN, BY YEAR");
console.log("=".repeat(98));
console.log("\n  year   days   median pre-open ATR   median first-5-min range   expansion   p90 range");
for (const y of [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
  const ds = dayKeys.filter((d) => yearOf(d) === y && daySess.get(d) != null);
  const a = ds.map((d) => preOpenAtr(d)).filter((x) => x > 0);
  const r = ds.map((d) => openRange(d)).filter((x) => x > 0);
  if (!a.length || !r.length) continue;
  console.log("  " + y + String(ds.length).padStart(7) +
    q(a, .5).toFixed(2).padStart(22) + q(r, .5).toFixed(1).padStart(27) +
    (q(r, .5) / q(a, .5)).toFixed(1).padStart(12) + "x" +
    q(r, .9).toFixed(1).padStart(11));
}

const { out } = setups(BASE);
const tr = out.map((s) => {
  const r = resolve(s, { rMult: 3, maxHoldMin: 5, riskDollars: 500, maxLots: 50 });
  const a = preOpenAtr(s.day), or5 = openRange(s.day);
  return { ...r, spread: s.width, atr: a, kAtr: a > 0 ? s.width / a : Infinity,
           kOpen: or5 > 0 ? s.risk / or5 : Infinity, year: yearOf(s.day) };
});

console.log("\n" + "=".repeat(98));
console.log("DOES A STOP THAT IS SMALL RELATIVE TO THE OPEN ACTUALLY LOSE?");
console.log("=".repeat(98));
console.log("\n  stop / first-5-min range    trades    SL%    win%    $/trade      2026 $/tr");
const BK = [[0, .25], [.25, .5], [.5, 1], [1, 2], [2, 99]];
for (const [a, b] of BK) {
  const g = tr.filter((t) => t.kOpen >= a && t.kOpen < b);
  if (!g.length) continue;
  const g26 = g.filter((t) => t.year >= 2026);
  console.log("  " + (a + " - " + (b === 99 ? "inf" : b)).padStart(21) +
    String(g.length).padStart(11) +
    (100 * g.filter((t) => t.why === "SL").length / g.length).toFixed(1).padStart(7) +
    (100 * g.filter((t) => t.pnl > 0).length / g.length).toFixed(1).padStart(8) +
    ("$" + (g.reduce((x, y) => x + y.pnl, 0) / g.length).toFixed(0)).padStart(11) +
    (g26.length ? "$" + (g26.reduce((x, y) => x + y.pnl, 0) / g26.length).toFixed(0) +
      " (" + g26.length + ")" : "-").padStart(15));
}

console.log("\n" + "=".repeat(98));
console.log("THE CAUSAL VERSION — spread measured against the PRE-OPEN ATR, known at 08:30");
console.log("=".repeat(98));
console.log("\n  spread / pre-open ATR       trades    SL%    win%    $/trade      2026 $/tr");
for (const [a, b] of [[0, 1.5], [1.5, 2.5], [2.5, 4], [4, 7], [7, 999]]) {
  const g = tr.filter((t) => t.kAtr >= a && t.kAtr < b);
  if (!g.length) continue;
  const g26 = g.filter((t) => t.year >= 2026);
  console.log("  " + (a + " - " + (b === 999 ? "inf" : b)).padStart(21) +
    String(g.length).padStart(11) +
    (100 * g.filter((t) => t.why === "SL").length / g.length).toFixed(1).padStart(7) +
    (100 * g.filter((t) => t.pnl > 0).length / g.length).toFixed(1).padStart(8) +
    ("$" + (g.reduce((x, y) => x + y.pnl, 0) / g.length).toFixed(0)).padStart(11) +
    (g26.length ? "$" + (g26.reduce((x, y) => x + y.pnl, 0) / g26.length).toFixed(0) +
      " (" + g26.length + ")" : "-").padStart(15));
}

const today = tr.filter((t) => t.kAtr <= 2.5);
console.log("\n  Today's trade: spread 23.58 pts, pre-open 2-min ATR 19.89 (1-min ~10.5),");
console.log("  so spread / pre-open ATR ~ 2.2 — the second bucket. Its stop was 25% of");
console.log("  the 95-point opening bar it was taken in.");
