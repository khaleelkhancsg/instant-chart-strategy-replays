// "Why is the ORB holding to close? Isn't it meant to be a quick scalp?"
//
// Fair catch. The parameter search drifted there and the config was then carried
// into the portfolio test without re-flagging it. What has been called "the ORB
// bot" is a pre-open-level breakout held to the close -- not the two-minute
// scalp the transcript describes, and not the push/retrace/push entry either.
//
// Hold time also drives the portfolio question directly: an ORB that holds to
// the close is in the market while the Donchian bot trades all day, so the two
// overlap almost totally on shared days and the $1,000 cap binds against a
// doubled position. A shorter hold might combine better even if it is worse
// alone.
//
// So: pass rate by hold time, alone and combined, plus how much of the session
// the ORB is actually exposed.
//
// Usage:  node research/orb_hold_portfolio.mjs

import { run as runDon, dayArr as donDays, days as DDAYS, mul } from "./lib_shipped.mjs";
import { run as runOrb, dayArr as orbDays, ALL as ODAYS, stat as orbStat } from "./lib_orb.mjs";

const TARGET = 3000, DD = 2000, CONSIST = 0.5;
const BASE = {
  levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
  mode: "plain", stopAt: "opposite", rMult: 3.0,
  retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500, maxLots: 50, maxPerDay: 1,
};

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
function pass21(arr, seed = 4242) {
  const rnd = mul(seed), idx = new Array(21), buf = new Array(21);
  let w = 0;
  for (let d = 0; d < 12000; d++) {
    let mm = 0;
    while (mm < 21) { const st = Math.floor(rnd() * Math.max(1, arr.length - 5));
      for (let j = 0; j < 5 && mm < 21; j++) idx[mm++] = (st + j) % arr.length; }
    for (let k = 0; k < 21; k++) buf[k] = arr[idx[k]];
    w += ev(buf);
  }
  return 100 * w / 12000;
}
function forward(arr, maxDays = 400, trials = 20000, seed = 31337) {
  const rnd = mul(seed);
  let pass = 0;
  for (let t = 0; t < trials; t++) {
    const s = Math.floor(rnd() * arr.length);
    let c = 0, pk = 0, lk = false, best = -1e18;
    for (let d = 0; d < maxDays; d++) {
      const v = arr[(s + d) % arr.length];
      c += v; if (v > best) best = v;
      if (c <= (lk ? 0 : pk - DD)) break;
      if (c > pk) pk = c;
      if (!lk && pk >= DD) lk = true;
      if (c >= TARGET && best <= CONSIST * c) { pass++; break; }
    }
  }
  return 100 * pass / trials;
}

const donT = runDon(() => 8);
const A = donDays(donT, DDAYS);

console.log("\n" + "=".repeat(112));
console.log("ORB HOLD TIME: ALONE, AND COMBINED WITH THE DONCHIAN BOT");
console.log("=".repeat(112));
console.log("\n  donchian alone: 21-day " + pass21(A).toFixed(1) + "%, no deadline " +
            forward(A).toFixed(1) + "%");
console.log("\n  hold      trades   pf     $/trade   median hold   ORB 21d   ORB no-dl   BOTH 21d   BOTH no-dl");
for (const h of [2, 5, 10, 20, 30, 60, 120, 240, 1000]) {
  const r = runOrb({ ...BASE, maxHoldMin: h });
  const st = orbStat(r.trades);
  const B = orbDays(r.trades, ODAYS);
  const C = A.map((v, i) => Math.max(-1000, v + B[i]));   // one account, one cap
  console.log("  " + (h === 1000 ? "to close" : h + "m").padEnd(10) +
    String(st.n).padStart(6) + st.pf.toFixed(3).padStart(7) +
    ("$" + st.exp.toFixed(2)).padStart(10) + (st.med + "m").padStart(13) +
    pass21(B).toFixed(1).padStart(10) + "%" + forward(B).toFixed(1).padStart(11) + "%" +
    pass21(C).toFixed(1).padStart(11) + "%" + forward(C).toFixed(1).padStart(12) + "%");
}

console.log("\n-- how much of the session is the ORB actually holding? --");
console.log("  RTH is 390 minutes. The donchian bot trades across all of it, so this is");
console.log("  roughly the share of the day the two books are exposed together.");
console.log("\n  hold        median hold   mean hold   share of a 390-min session");
for (const h of [5, 30, 60, 1000]) {
  const r = runOrb({ ...BASE, maxHoldMin: h });
  const hs = r.trades.map(t => t.held).sort((a, b) => a - b);
  const mean = hs.reduce((a, b) => a + b, 0) / hs.length;
  console.log("  " + (h === 1000 ? "to close" : h + "m").padEnd(12) +
    (hs[hs.length >> 1] + "m").padStart(11) + (mean.toFixed(0) + "m").padStart(12) +
    (100 * mean / 390).toFixed(0).padStart(23) + "%");
}
