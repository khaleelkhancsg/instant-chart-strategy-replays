// Round 2: the +/-$500 trigger fires in a MEDIAN OF ONE DAY, so it staggers
// almost nothing -- the bot's day P&L swings are large next to $500 (one trade
// risks ~$1,277 and the day cap is $1,000). Implied correlation still 0.596.
//
// So: what stagger actually decorrelates, what does concurrency cost, and what
// is the efficient frontier between speed and wipeout risk?
//
// Usage:  node research/combine_frontier.mjs

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

// maxConc = how many may run at once; stagger = min days between launches.
// Launches exactly N combines total, so fees are identical across policies.
function campaign(base, maxConc, stagger, maxDays = 900) {
  const live = []; let launched = 0, lastLaunch = -1e9, passes = 0, busts = 0;
  const order = [];
  for (let d = 0; d < maxDays; d++) {
    while (launched < N && live.length < maxConc && d - lastLaunch >= stagger) {
      live.push(fresh()); launched++; lastLaunch = d;
    }
    const v = ARR[(base + d) % LEN];
    for (const cb of live) step(cb, v);
    for (let i = live.length - 1; i >= 0; i--) if (live[i].out) {
      if (live[i].out === "pass") { passes++; order.push({ d, ok: true }); }
      else { busts++; order.push({ d, ok: false }); }
      live.splice(i, 1);
    }
    if (launched >= N && live.length === 0) return { passes, busts, days: d + 1, order };
  }
  return { passes, busts, days: maxDays, order };
}

const TRIALS = 20000;
function evaluate(maxConc, stagger) {
  const rnd = mul(20250817);
  let sum = 0, sq = 0, zero = 0, dSum = 0, feesTo1 = 0, got1 = 0;
  for (let t = 0; t < TRIALS; t++) {
    const r = campaign(Math.floor(rnd() * LEN), maxConc, stagger);
    sum += r.passes; sq += r.passes * r.passes; dSum += r.days;
    if (r.passes === 0) zero++;
    // fees spent up to and including the first pass (attempts launched by then)
    let n = 0, found = false;
    for (const o of r.order) { n++; if (o.ok) { found = true; break; } }
    if (found) { feesTo1 += n; got1++; }
  }
  const m = sum / TRIALS;
  return { m, sd: Math.sqrt(sq / TRIALS - m * m), zero: 100 * zero / TRIALS,
           days: dSum / TRIALS, fees1: feesTo1 / Math.max(1, got1), p1: 100 * got1 / TRIALS };
}

console.log("\n" + "=".repeat(112));
console.log("EFFICIENT FRONTIER: 5 COMBINES, IDENTICAL FEES, ONLY THE SCHEDULE VARIES");
console.log("=".repeat(112));
console.log("\n  max at once   stagger   E[passes]     SD   P(0 pass)   P(>=1 pass)   fees to 1st pass   days");
for (const [conc, stag] of [[5, 0], [5, 3], [5, 7], [5, 14], [5, 21], [5, 30],
                            [3, 0], [3, 7], [3, 14], [3, 21],
                            [2, 0], [2, 7], [2, 14],
                            [1, 0]]) {
  const r = evaluate(conc, stag);
  console.log("  " + String(conc).padStart(6) + String(stag === 0 ? "none" : stag + "d").padStart(12) +
    r.m.toFixed(2).padStart(11) + r.sd.toFixed(2).padStart(7) + r.zero.toFixed(1).padStart(11) + "%" +
    r.p1.toFixed(1).padStart(13) + "%" + r.fees1.toFixed(2).padStart(17) + r.days.toFixed(0).padStart(9));
}

console.log("\n-- the two questions that pick your policy --");
const A = evaluate(5, 0), B = evaluate(1, 0);
console.log("  If you want FIVE funded accounts as fast as possible:");
console.log("    all at once -> E 5 passes " + A.m.toFixed(2) + ", done in " + A.days.toFixed(0) +
            " days, but " + A.zero.toFixed(1) + "% chance of ZERO");
console.log("  If you want ONE funded account with near-certainty:");
console.log("    one at a time -> " + B.p1.toFixed(1) + "% chance of at least one, " +
            B.fees1.toFixed(2) + " fees to get it, " + B.days.toFixed(0) + " days for all five");

console.log("\n-- the abandon option, which only sequencing gives you --");
console.log("  Stop launching after k consecutive busts. Same strategy, fewer fees burned when");
console.log("  it is going badly. Not available if all five are already live.");
console.log("\n  policy            stop after   E[passes]   E[fees]   passes per fee");
for (const [conc, stag, kmax] of [[5, 0, 99], [1, 0, 99], [1, 0, 2], [1, 0, 3], [2, 7, 2], [2, 7, 3]]) {
  const rnd = mul(4242);
  let pSum = 0, fSum = 0;
  for (let t = 0; t < TRIALS; t++) {
    const base = Math.floor(rnd() * LEN);
    const live = []; let launched = 0, lastL = -1e9, passes = 0, streak = 0, stopped = false;
    for (let d = 0; d < 900; d++) {
      while (!stopped && launched < N && live.length < conc && d - lastL >= stag) {
        live.push(fresh()); launched++; lastL = d;
      }
      const v = ARR[(base + d) % LEN];
      for (const cb of live) step(cb, v);
      for (let i = live.length - 1; i >= 0; i--) if (live[i].out) {
        if (live[i].out === "pass") { passes++; streak = 0; }
        else { streak++; if (streak >= kmax) stopped = true; }
        live.splice(i, 1);
      }
      if (live.length === 0 && (stopped || launched >= N)) break;
    }
    pSum += passes; fSum += launched;
  }
  const ep = pSum / TRIALS, ef = fSum / TRIALS;
  console.log("  " + ("conc " + conc + ", stagger " + (stag || 0) + "d").padEnd(20) +
    String(kmax === 99 ? "never" : kmax + " busts").padStart(10) +
    ep.toFixed(2).padStart(12) + ef.toFixed(2).padStart(10) + (ep / ef).toFixed(3).padStart(17));
}
