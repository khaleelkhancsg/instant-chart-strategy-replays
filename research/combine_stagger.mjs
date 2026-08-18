// Five combines at once: does staggering the starts help, and by how much?
//
// THE FACT THAT GOVERNS EVERYTHING: one bot, one strategy, one signal stream.
// Whatever happens to the market on a given day happens to every running
// combine on that day. They are not five independent bets, they are one bet
// copied five times. Launch them together and they share an equity curve
// exactly -- same day P&L, same drawdown state, same outcome. They pass as a
// block or fail as a block.
//
// Staggering does not decorrelate the MARKET. It decorrelates the WINDOW: each
// combine is then a different 21-ish-day slice of the same process, with its own
// peak and its own trailing-drawdown state. That is real diversification of
// sampling risk, and it is free.
//
// Modelled on the real calendar: on global day d every ACTIVE combine receives
// the same daily P&L. Only their internal state differs, because they started
// at different d. That is what makes the correlation less than one but more
// than zero.
//
// Every policy launches exactly FIVE combines, so cost is held constant and the
// only thing varying is when.
//
// Usage:  node research/combine_stagger.mjs

import { run, dayArr, mul, days } from "./lib_shipped.mjs";

const TARGET = 3000, DD = 2000, CONSIST = 0.5, N = 5;
const ARR = dayArr(run(() => 8), days);
const LEN = ARR.length;

const fresh = () => ({ c: 0, pk: 0, lk: false, best: -1e18, day: 0, out: null });
function step(cb, v) {
  cb.c += v; if (v > cb.best) cb.best = v;
  cb.day++;
  if (cb.c <= (cb.lk ? 0 : cb.pk - DD)) { cb.out = "bust"; return; }
  if (cb.c > cb.pk) cb.pk = cb.c;
  if (!cb.lk && cb.pk >= DD) cb.lk = true;
  if (cb.c >= TARGET && cb.best <= CONSIST * cb.c) cb.out = "pass";
}

// policy(state) decides whether to launch another combine on this day.
function campaign(base, policy, maxDays = 400) {
  const live = [], done = [];
  let launched = 0;
  const launch = () => { live.push(fresh()); launched++; };
  launch();
  for (let d = 0; d < maxDays; d++) {
    const v = ARR[(base + d) % LEN];
    for (const cb of live) step(cb, v);
    for (let i = live.length - 1; i >= 0; i--)
      if (live[i].out) { done.push(live[i]); live.splice(i, 1); }
    while (launched < N && policy(live, done, d)) launch();
    if (launched >= N && live.length === 0) return { done, days: d + 1 };
  }
  return { done, days: maxDays };
}

const POLICIES = {
  "all 5 on day 1":        () => true,
  "next at +/-$500":       (live) => live.length > 0 && Math.abs(live[live.length - 1].c) >= 500,
  "next at +/-$1000":      (live) => live.length > 0 && Math.abs(live[live.length - 1].c) >= 1000,
  "next every 3 days":     (live, done, d) => d > 0 && d % 3 === 0,
  "next every 7 days":     (live, done, d) => d > 0 && d % 7 === 0,
  "next every 14 days":    (live, done, d) => d > 0 && d % 14 === 0,
  "one at a time":         (live) => live.length === 0,
};

const TRIALS = 20000;
console.log("\n" + "=".repeat(108));
console.log("FIVE COMBINES: DOES STAGGERING HELP?  |  every policy launches exactly 5, so cost is identical");
console.log("=".repeat(108));
console.log("\n  policy                 E[passes]     SD    P(0 pass)   P(>=1)   P(>=3)   P(all 5)   calendar days");
const results = {};
for (const [name, pol] of Object.entries(POLICIES)) {
  const rnd = mul(20250817);
  let sum = 0, sumSq = 0, zero = 0, one = 0, three = 0, five = 0, dSum = 0;
  for (let t = 0; t < TRIALS; t++) {
    const r = campaign(Math.floor(rnd() * LEN), pol);
    const p = r.done.filter(x => x.out === "pass").length;
    sum += p; sumSq += p * p; dSum += r.days;
    if (p === 0) zero++; if (p >= 1) one++; if (p >= 3) three++; if (p === 5) five++;
  }
  const m = sum / TRIALS, sd = Math.sqrt(sumSq / TRIALS - m * m);
  results[name] = { m, sd };
  console.log("  " + name.padEnd(22) + m.toFixed(2).padStart(8) + sd.toFixed(2).padStart(8) +
    (100 * zero / TRIALS).toFixed(1).padStart(11) + "%" + (100 * one / TRIALS).toFixed(1).padStart(8) + "%" +
    (100 * three / TRIALS).toFixed(1).padStart(8) + "%" + (100 * five / TRIALS).toFixed(1).padStart(10) + "%" +
    (dSum / TRIALS).toFixed(0).padStart(14));
}

console.log("\n-- what the theory says the bounds are --");
const p1 = results["one at a time"].m / N;
console.log("  single-combine pass probability p = " + (100 * p1).toFixed(1) + "%");
console.log("  E[passes] = 5p = " + (5 * p1).toFixed(2) + " for EVERY policy — scheduling cannot change it");
console.log("  SD if perfectly correlated  = 5*sqrt(p(1-p))   = " +
  (5 * Math.sqrt(p1 * (1 - p1))).toFixed(2));
console.log("  SD if fully independent     = sqrt(5*p(1-p))   = " +
  Math.sqrt(5 * p1 * (1 - p1)).toFixed(2) + "   <- the floor, a sqrt(5) = 2.24x reduction");

console.log("\n-- implied average pairwise correlation of outcomes, from SD --");
console.log("  policy                    SD    implied rho");
for (const [name, r] of Object.entries(results)) {
  const v = r.sd * r.sd, base = N * p1 * (1 - p1);
  const rho = (v / base - 1) / (N - 1);
  console.log("  " + name.padEnd(22) + r.sd.toFixed(2).padStart(8) + rho.toFixed(3).padStart(15));
}

console.log("\n-- how long does the +/-$500 trigger actually take to fire? --");
{
  const rnd = mul(555); const hits = [];
  for (let t = 0; t < 20000; t++) {
    const cb = fresh(); const b = Math.floor(rnd() * LEN);
    for (let d = 0; d < 200; d++) {
      step(cb, ARR[(b + d) % LEN]);
      if (Math.abs(cb.c) >= 500 || cb.out) { hits.push(d + 1); break; }
    }
  }
  hits.sort((a, b) => a - b);
  console.log("  days to reach +/-$500:  median " + hits[hits.length >> 1] +
    "   25th " + hits[Math.floor(hits.length * 0.25)] +
    "   75th " + hits[Math.floor(hits.length * 0.75)] +
    "   mean " + (hits.reduce((a, b) => a + b, 0) / hits.length).toFixed(1));
}
