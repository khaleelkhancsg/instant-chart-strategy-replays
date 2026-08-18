// The missing control. "room/250 + stop at +$2,000" scored 72.8% survival and
// $2,001 median, beating flat 8 on both -- but the stand-down was never tested
// on FLAT size inside the same episode runner, so the credit may belong entirely
// to it and not to the room-scaling.
//
// Usage:  node research/funded_control.mjs

import { episode, mul, days } from "./lib_shipped.mjs";

const TRIALS = 12000, WIN = 21;
const pctl = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
function period(sizer, opt = {}) {
  const rnd = mul(20250817); const v = []; let dead = 0, sum = 0;
  for (let t = 0; t < TRIALS; t++) {
    const r = episode(Math.floor(rnd() * (days.length - WIN - 1)), WIN, sizer, opt);
    if (r.dead) { dead++; v.push(0); } else { v.push(r.acct); sum += r.acct; }
  }
  v.sort((a, b) => a - b);
  return { surv: 100 * (TRIALS - dead) / TRIALS, med: pctl(v, 0.5), mean: sum / TRIALS, p25: pctl(v, 0.25) };
}
function lifetime(sizer, opt = {}, cap = 252) {
  const rnd = mul(4242); const L = [];
  for (let t = 0; t < 4000; t++) {
    const r = episode(Math.floor(rnd() * (days.length - cap - 1)), cap, sizer, opt);
    L.push(r.dead ? r.days : cap);
  }
  return 100 * L.filter(x => x >= cap).length / L.length;
}
const HDR = "  strategy                        survive 21d   median    mean     p25   alive @1yr";
function row(name, sizer, opt) {
  const p = period(sizer, opt), a = lifetime(sizer, opt);
  console.log("  " + name.padEnd(32) + p.surv.toFixed(1).padStart(9) + "%" +
    ("$" + Math.round(p.med)).padStart(9) + ("$" + Math.round(p.mean)).padStart(8) +
    ("$" + Math.round(p.p25)).padStart(8) + a.toFixed(1).padStart(12) + "%");
  return { surv: p.surv, med: p.med, alive: a };
}
const flat = (k) => () => k;
const flatStop = (k, sa) => (a, ct, st) => (st.acct >= sa ? 0 : k);
const roomStop = (K, sa) => (a, ct, st) =>
  (st.acct >= sa ? 0 : Math.max(1, Math.min(12, Math.round(st.room / K))));

console.log("\n" + "=".repeat(104));
console.log("IS IT THE ROOM-SCALING OR THE STAND-DOWN?");
console.log("=".repeat(104));
console.log("\n" + HDR);
row("flat 8, no stop", flat(8), { profitBlock: 500 });
row("room/250, no stop", (a, c, s) => Math.max(1, Math.min(12, Math.round(s.room / 250))), { profitBlock: 500 });
console.log("");
for (const sa of [1500, 2000, 2500]) {
  row("flat 8, stop +$" + sa, flatStop(8, sa), { profitBlock: 500 });
  row("room/250, stop +$" + sa, roomStop(250, sa), { profitBlock: 500 });
  console.log("");
}
console.log("  -> if the two rows in each pair match, the room-scaling is doing nothing.");

console.log("\n-- the survival frontier: flat size x stand-down, ranked by alive @1yr --");
console.log(HDR);
const rows = [];
for (const k of [2, 3, 4, 6, 8])
for (const sa of [1000, 1500, 2000, 3000, 0]) {
  const name = "flat " + k + (sa ? ", stop +$" + sa : ", no stop");
  const p = period(sa ? flatStop(k, sa) : flat(k), { profitBlock: 500 });
  const a = lifetime(sa ? flatStop(k, sa) : flat(k), { profitBlock: 500 });
  rows.push({ name, ...p, alive: a });
}
rows.sort((x, y) => y.alive - x.alive);
for (const r of rows.slice(0, 12))
  console.log("  " + r.name.padEnd(32) + r.surv.toFixed(1).padStart(9) + "%" +
    ("$" + Math.round(r.med)).padStart(9) + ("$" + Math.round(r.mean)).padStart(8) +
    ("$" + Math.round(r.p25)).padStart(8) + r.alive.toFixed(1).padStart(12) + "%");

console.log("\n-- annualised: median profit per 21 days x expected periods survived in a year --");
console.log("  strategy                        median   alive@1yr   rough annual median");
for (const r of rows.slice(0, 8)) {
  // 252 trading days = 12 periods; survival compounds, so expected periods
  // traded is the sum of survival^k over the year.
  const s21 = r.surv / 100;
  let exp = 0, p = 1;
  for (let k = 0; k < 12; k++) { exp += p; p *= s21; }
  console.log("  " + r.name.padEnd(32) + ("$" + Math.round(r.med)).padStart(7) +
    r.alive.toFixed(1).padStart(11) + "%" + ("$" + Math.round(r.med * exp)).padStart(21));
}
