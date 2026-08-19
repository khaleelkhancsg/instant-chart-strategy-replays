// Running the ORB bot and the Donchian bot together.
//
// The idea: neither alone produces enough trades to clear $3,000 reliably, but
// they fire at different times off different logic, so together they might raise
// throughput without lowering the quality bar on either.
//
// Whether that works turns entirely on CORRELATION. Both trade MNQ breakouts and
// both are long or short the same instrument, so if their daily P&L moves
// together, combining them is just leverage and the risk limits bind twice as
// fast. If it does not, the combination is genuinely diversifying.
//
// Both engines are on the corrected footing: lib_shipped now defaults to the
// limit-fallback entry model that actually ships (34.5%, not the unachievable
// 49.8%), and lib_orb has always had the gap-through guard.
//
// LIMITATION, stated up front: this sums DAY P&L. It cannot model the two bots
// holding positions at the same moment, which would double the size and pull the
// platform cap nearer. Treat the combined rows as the optimistic end.
//
// Usage:  node research/portfolio_two_bots.mjs

import { run as runDon, dayArr as donDays, days as DDAYS, mul, stat as donStat } from "./lib_shipped.mjs";
import { run as runOrb, dayArr as orbDays, ALL as ODAYS, stat as orbStat } from "./lib_orb.mjs";

const TARGET = 3000, DD = 2000, CONSIST = 0.5;

const ORB_CFG = {                        // the walk-forward-verified shape
  levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
  mode: "plain", stopAt: "opposite", rMult: 3.0, maxHoldMin: 1000,
  retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500, maxLots: 50, maxPerDay: 1,
};

const donT = runDon(() => 8);
const orbT = runOrb(ORB_CFG).trades;
console.log("\n" + "=".repeat(104));
console.log("TWO BOTS ON ONE ACCOUNT: DOES COMBINING THEM HELP?");
console.log("=".repeat(104));
console.log("\n  day sets: donchian " + DDAYS.length + ", orb " + ODAYS.length +
            (DDAYS.length === ODAYS.length ? "  (aligned)" : "  !! MISALIGNED !!"));

const A = donDays(donT, DDAYS);          // donchian daily P&L
const B = orbDays(orbT, ODAYS);          // orb daily P&L
const C = A.map((v, i) => v + B[i]);     // both on one account

// ---- correlation, the number the whole idea depends on -------------------
function corr(x, y) {
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; sxy += x[i] * y[i]; }
  return (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
}
const bothTraded = [];
for (let i = 0; i < A.length; i++) if (A[i] !== 0 && B[i] !== 0) bothTraded.push(i);
console.log("\n-- correlation of daily P&L --");
console.log("  all days                    r = " + corr(A, B).toFixed(3));
console.log("  days BOTH actually traded   r = " +
  corr(bothTraded.map(i => A[i]), bothTraded.map(i => B[i])).toFixed(3) +
  "   (" + bothTraded.length + " days)");
console.log("  donchian trades on " + A.filter(v => v !== 0).length + " days, orb on " +
            B.filter(v => v !== 0).length + ", both on " + bothTraded.length);

// ---- evaluation ----------------------------------------------------------
function ev(d) {
  let c = 0, pk = 0, lk = false, md = -1e18;
  for (const v of d) {
    c += v; if (v > md) md = v;
    if (c <= (lk ? 0 : pk - DD)) return 0;
    if (c > pk) pk = c;
    if (!lk && pk >= DD) lk = true;
    if (c >= TARGET && md <= CONSIST * c) return 1;
  }
  return 0;
}
function pass21(arr, draws = 12000, seed = 4242) {
  const rnd = mul(seed), idx = new Array(21), buf = new Array(21);
  let w = 0;
  for (let d = 0; d < draws; d++) {
    let mm = 0;
    while (mm < 21) { const st = Math.floor(rnd() * Math.max(1, arr.length - 5));
      for (let j = 0; j < 5 && mm < 21; j++) idx[mm++] = (st + j) % arr.length; }
    for (let k = 0; k < 21; k++) buf[k] = arr[idx[k]];
    w += ev(buf);
  }
  return 100 * w / draws;
}
// No deadline: run forward through real consecutive days until pass or bust.
function forward(arr, maxDays = 400, trials = 30000, seed = 31337) {
  const rnd = mul(seed);
  let pass = 0, bust = 0; const pd = [];
  for (let t = 0; t < trials; t++) {
    const s = Math.floor(rnd() * arr.length);
    let c = 0, pk = 0, lk = false, best = -1e18, done = false;
    for (let d = 0; d < maxDays && !done; d++) {
      const v = arr[(s + d) % arr.length];
      c += v; if (v > best) best = v;
      if (c <= (lk ? 0 : pk - DD)) { bust++; done = true; break; }
      if (c > pk) pk = c;
      if (!lk && pk >= DD) lk = true;
      if (c >= TARGET && best <= CONSIST * c) { pass++; pd.push(d + 1); done = true; }
    }
  }
  pd.sort((a, b) => a - b);
  return { pass: 100 * pass / trials, bust: 100 * bust / trials,
           med: pd.length ? pd[pd.length >> 1] : NaN };
}
// Both on ONE account: the $1,000 day cap applies to the SUM, not to each.
const Ccapped = C.map(v => Math.max(-1000, v));

console.log("\n-- pass rates --");
console.log("  book                      trades/day   $/day    21-day window   no deadline   median days");
for (const [lbl, arr, nTr] of [
  ["donchian alone (8 lots)", A, donT.length],
  ["ORB alone", B, orbT.length],
  ["both, day cap on the sum", Ccapped, donT.length + orbT.length],
  ["both, no shared cap", C, donT.length + orbT.length],
]) {
  const f = forward(arr);
  const perDay = arr.reduce((a, b) => a + b, 0) / arr.length;
  console.log("  " + lbl.padEnd(26) + (nTr / arr.length).toFixed(2).padStart(9) +
    ("$" + perDay.toFixed(2)).padStart(9) + pass21(arr).toFixed(1).padStart(14) + "%" +
    f.pass.toFixed(1).padStart(13) + "%" + String(f.med).padStart(13));
}

console.log("\n-- what the combination is actually buying --");
const dSt = donStat(donT), oSt = orbStat(orbT);
console.log("  donchian: " + donT.length + " trades, pf " + dSt.pf.toFixed(3) +
            ", $" + dSt.exp.toFixed(2) + "/trade, $" + Math.round(dSt.net / 1000) + "k net");
console.log("  orb     : " + orbT.length + " trades, pf " + oSt.pf.toFixed(3) +
            ", $" + oSt.exp.toFixed(2) + "/trade, $" + Math.round(oSt.net / 1000) + "k net");
console.log("  combined daily mean $" + (C.reduce((a, b) => a + b, 0) / C.length).toFixed(2) +
            " against $" + (A.reduce((a, b) => a + b, 0) / A.length).toFixed(2) + " donchian alone");

console.log("\n-- and separately, the ORB with no deadline is the other half of the question --");
const of_ = forward(B), df = forward(A);
console.log("  ORB      21-day " + pass21(B).toFixed(1) + "%   ->   no deadline " +
            of_.pass.toFixed(1) + "%  (busts " + of_.bust.toFixed(1) + "%, median " + of_.med + " days)");
console.log("  donchian 21-day " + pass21(A).toFixed(1) + "%   ->   no deadline " +
            df.pass.toFixed(1) + "%  (busts " + df.bust.toFixed(1) + "%, median " + df.med + " days)");
