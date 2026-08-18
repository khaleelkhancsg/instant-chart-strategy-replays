// Objective changed: keep the accounts alive. And the search is not limited to
// tweaking the shipped parameters.
//
// The structural problem is that the bot trades a flat 8 lots whether it sits
// $2,000 above the trailing-drawdown floor or $200 above it. The floor is the
// firm's: peak-$2,000 until peak reaches $2,000, then $0 for good. So define
//
//     room = equity - floor        (how much can be lost before the account dies)
//
// room starts at $2,000, stays $2,000 while you are at a new peak, and shrinks
// one-for-one with any drawdown after the floor locks. Sizing off room is the
// natural adaptive rule and the engine could not express it until now, because
// size then depends on equity and equity depends on size.
//
// Reported both ways: a 21-trading-day period, and how long an account lives
// when simply left to run.
//
// Usage:  node research/funded_survive.mjs

import { episode, mul, days } from "./lib_shipped.mjs";

const TRIALS = 12000, WIN = 21;
const pctl = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

function period(sizer, opt = {}) {
  const rnd = mul(20250817); const v = []; let dead = 0, sum = 0, tr = 0;
  for (let t = 0; t < TRIALS; t++) {
    const s = Math.floor(rnd() * (days.length - WIN - 1));
    const r = episode(s, WIN, sizer, opt);
    tr += r.trades;
    if (r.dead) { dead++; v.push(0); } else { v.push(r.acct); sum += r.acct; }
  }
  v.sort((a, b) => a - b);
  return { surv: 100 * (TRIALS - dead) / TRIALS, med: pctl(v, 0.5),
           mean: sum / TRIALS, p25: pctl(v, 0.25), trades: tr / TRIALS };
}
// How long does an account last if simply left running?
function lifetime(sizer, opt = {}, cap = 252) {
  const rnd = mul(4242); const L = [], P = [];
  for (let t = 0; t < 4000; t++) {
    const s = Math.floor(rnd() * (days.length - cap - 1));
    const r = episode(s, cap, sizer, opt);
    L.push(r.dead ? r.days : cap); P.push(r.dead ? 0 : r.acct);
  }
  L.sort((a, b) => a - b); P.sort((a, b) => a - b);
  return { medLife: pctl(L, 0.5), aliveAtYear: 100 * L.filter(x => x >= cap).length / L.length,
           medYear: pctl(P, 0.5) };
}

const HDR = "  strategy                      survive 21d   median    mean     p25   trades   median life   alive @1yr";
function row(name, sizer, opt) {
  const p = period(sizer, opt), l = lifetime(sizer, opt);
  console.log("  " + name.padEnd(30) + p.surv.toFixed(1).padStart(9) + "%" +
    ("$" + Math.round(p.med)).padStart(9) + ("$" + Math.round(p.mean)).padStart(8) +
    ("$" + Math.round(p.p25)).padStart(8) + p.trades.toFixed(1).padStart(9) +
    (l.medLife >= 252 ? ">252" : String(l.medLife)).padStart(14) + "d" +
    l.aliveAtYear.toFixed(1).padStart(12) + "%");
  return { p, l };
}

console.log("\n" + "=".repeat(118));
console.log("KEEPING FUNDED ACCOUNTS ALIVE  |  21 trading days, and how long an account lasts left running");
console.log("=".repeat(118));

console.log("\n-- baselines: flat size, no awareness of the floor --");
console.log(HDR);
row("flat 8 (live config, blk750)", () => 8, { profitBlock: 750 });
row("flat 8, block $500", () => 8, { profitBlock: 500 });
row("flat 6, block $500", () => 6, { profitBlock: 500 });
row("flat 4, block $500", () => 4, { profitBlock: 500 });
row("flat 2, block $500", () => 2, { profitBlock: 500 });

console.log("\n-- size proportional to ROOM: lots = clamp(room/K, 1, 12) --");
console.log(HDR);
for (const K of [150, 200, 250, 300, 400, 500]) {
  row("room/" + K, (a, ct, st) => Math.max(1, Math.min(12, Math.round(st.room / K))),
      { profitBlock: 500 });
}

console.log("\n-- same, but allowed to stand fully aside when room is thin --");
console.log(HDR);
for (const [K, floorLots] of [[250, 0], [300, 0], [400, 0], [250, 2], [300, 2]]) {
  row("room/" + K + ", min " + floorLots + " lots",
      (a, ct, st) => Math.max(floorLots, Math.min(12, Math.round(st.room / K))),
      { profitBlock: 500 });
}

console.log("\n-- a hard gate instead of a ramp: full size above X, small below --");
console.log(HDR);
for (const [X, lo] of [[750, 2], [1000, 2], [1250, 2], [1000, 4], [1000, 0]]) {
  row("8 if room>$" + X + " else " + lo, (a, ct, st) => (st.room > X ? 8 : lo),
      { profitBlock: 500 });
}

console.log("\n-- best ramp plus standing down once the period is up --");
console.log(HDR);
for (const sa of [1500, 2000, 3000]) {
  row("room/250, stop at +$" + sa,
      (a, ct, st) => (st.acct >= sa ? 0 : Math.max(1, Math.min(12, Math.round(st.room / 250)))),
      { profitBlock: 500 });
}
