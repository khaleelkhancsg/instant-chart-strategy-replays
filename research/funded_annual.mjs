// CORRECTION to the alive@1yr column in funded_control.mjs.
//
// The stand-down there was absolute -- once acct >= $1,000 the sizer returned 0
// forever, so over a 252-day run the account simply stopped trading and could no
// longer die. That inflated survival for every stop config and made the annual
// figures meaningless.
//
// A stand-down is a PER-PERIOD rule: stop once the period is up $X, resume next
// period. Equity, peak and the locked floor all carry across periods; only the
// baseline resets. Rebuilt that way, in one continuous 252-day episode where the
// sizer re-bases every 21 trading days.
//
// Usage:  node research/funded_annual.mjs

import { episode, mul, days } from "./lib_shipped.mjs";

const YEAR = 252, WIN = 21, TRIALS = 6000;
const pctl = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

// Per-period stand-down: baseline re-bases every WIN trading days.
function periodic(lots, stopAt) {
  let base = 0, per = -1;
  return (a, ct, st) => {
    const k = Math.floor((st.day - 1) / WIN);
    if (k !== per) { per = k; base = st.acct; }
    if (stopAt > 0 && st.acct - base >= stopAt) return 0;
    return lots;
  };
}

function year(lots, stopAt) {
  const rnd = mul(31337); const P = [], L = [];
  for (let t = 0; t < TRIALS; t++) {
    const s = Math.floor(rnd() * (days.length - YEAR - 1));
    const r = episode(s, YEAR, periodic(lots, stopAt), { profitBlock: 500 });
    P.push(r.dead ? 0 : r.acct);
    L.push(r.dead ? r.days : YEAR);
  }
  P.sort((a, b) => a - b); L.sort((a, b) => a - b);
  return { med: pctl(P, 0.5), p25: pctl(P, 0.25), p75: pctl(P, 0.75),
           alive: 100 * L.filter(x => x >= YEAR).length / L.length,
           medLife: pctl(L, 0.5) };
}

console.log("\n" + "=".repeat(104));
console.log("ONE YEAR (252 TRADING DAYS), STAND-DOWN RESETTING EVERY 21 DAYS, NO WITHDRAWALS");
console.log("=".repeat(104));
console.log("\n  strategy                 alive @1yr   median life   median year   25th      75th");
const rows = [];
for (const k of [2, 3, 4, 6, 8, 10])
for (const sa of [0, 750, 1000, 1500, 2000, 3000]) {
  const r = year(k, sa);
  rows.push({ name: k + " lots" + (sa ? ", stop +$" + sa : ", no stop"), k, sa, ...r });
}
rows.sort((a, b) => b.med - a.med);
for (const r of rows.slice(0, 14))
  console.log("  " + r.name.padEnd(24) + r.alive.toFixed(1).padStart(9) + "%" +
    (r.medLife >= YEAR ? ">252" : String(r.medLife)).padStart(13) + "d" +
    ("$" + Math.round(r.med)).padStart(14) + ("$" + Math.round(r.p25)).padStart(9) +
    ("$" + Math.round(r.p75)).padStart(10));

console.log("\n-- the two you would actually choose between --");
const cur = rows.find(r => r.k === 8 && r.sa === 0);
const best = rows[0];
const safest = rows.slice().sort((a, b) => b.alive - a.alive)[0];
for (const [lbl, r] of [["current-style (8 lots, no stop)", cur],
                        ["highest median year", best],
                        ["highest survival", safest]])
  console.log("  " + lbl.padEnd(34) + r.name.padEnd(22) +
    " alive " + r.alive.toFixed(1) + "%   median year $" + Math.round(r.med));

console.log("\n-- and how it holds up on the two halves of history --");
console.log("  strategy                 1st half alive / median      2nd half alive / median");
for (const r of [cur, best, safest]) {
  const out = [];
  for (const [lo, hi] of [[0, days.length >> 1], [days.length >> 1, days.length]]) {
    const rnd = mul(909); const P = [], L = [];
    for (let t = 0; t < 3000; t++) {
      const s = lo + Math.floor(rnd() * Math.max(1, hi - lo - YEAR - 1));
      const e = episode(s, YEAR, periodic(r.k, r.sa), { profitBlock: 500 });
      P.push(e.dead ? 0 : e.acct); L.push(e.dead ? e.days : YEAR);
    }
    P.sort((a, b) => a - b);
    out.push((100 * L.filter(x => x >= YEAR).length / L.length).toFixed(1) + "% / $" +
             Math.round(pctl(P, 0.5)));
  }
  console.log("  " + r.name.padEnd(24) + out[0].padStart(22) + out[1].padStart(29));
}
