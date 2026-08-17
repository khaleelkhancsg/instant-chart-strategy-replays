// "Since passing sooner is better for me, ship the 8-then-12 split, right?"
//
// The inference rests on a premise worth checking. The 21-day window in the
// evaluator is a SAMPLING DEVICE, not a deadline: passOf() draws 21 consecutive
// days and asks whether that stretch reached +$3,000 before violating the
// trailing drawdown. It estimates pass probability; it does not model a rule
// that the combine must be finished in 21 days.
//
// That matters because the metric table showed the gain living entirely in the
// hard-task regime: +4.6pp at a 15-day window, -0.1pp at 30 days. If there is no
// real deadline, the 30-day figure is the relevant one and the feature is worth
// nothing. If there IS a deadline -- or a monthly cost that makes speed worth
// money -- the 15-day figure is.
//
// So stop inferring from window sensitivity and simulate the thing directly:
// run the combine forward day by day until it passes, busts, or times out, and
// look at the whole distribution of outcomes and durations.
//
// Usage:  node research/time_to_pass.mjs

import { run, dayArr, mul, days, H1, H2, inSet, passOf } from "./lib_shipped.mjs";

const TARGET = 3000, DD = 2000, CONSIST = 0.5;
const flat8 = () => 8, split = (a, ct) => ct < 630 ? 8 : 12;
const A8 = dayArr(run(flat8), days);
const AS = dayArr(run(split), days);

// One combine attempt, walked forward from a random start through real
// consecutive days. Returns how it ended and after how many trading days.
function attempt(arr, start, maxDays) {
  let c = 0, pk = 0, lk = false, best = -1e18;
  for (let d = 0; d < maxDays; d++) {
    const v = arr[(start + d) % arr.length];
    c += v; if (v > best) best = v;
    if (c <= (lk ? 0 : pk - DD)) return { out: "bust", days: d + 1 };
    if (c > pk) pk = c;
    if (!lk && pk >= DD) lk = true;
    if (c >= TARGET && best <= CONSIST * c) return { out: "pass", days: d + 1 };
  }
  return { out: "open", days: maxDays };
}

function profile(arr, maxDays, trials = 40000, seed = 31337) {
  const rnd = mul(seed);
  let pass = 0, bust = 0, open = 0;
  const pd = [], bd = [];
  for (let i = 0; i < trials; i++) {
    const r = attempt(arr, Math.floor(rnd() * arr.length), maxDays);
    if (r.out === "pass") { pass++; pd.push(r.days); }
    else if (r.out === "bust") { bust++; bd.push(r.days); }
    else open++;
  }
  pd.sort((a, b) => a - b); bd.sort((a, b) => a - b);
  return { pass: 100 * pass / trials, bust: 100 * bust / trials, open: 100 * open / trials,
           medPass: pd.length ? pd[pd.length >> 1] : NaN,
           p25: pd.length ? pd[Math.floor(pd.length * 0.25)] : NaN,
           p75: pd.length ? pd[Math.floor(pd.length * 0.75)] : NaN,
           medBust: bd.length ? bd[bd.length >> 1] : NaN };
}

console.log("\n" + "=".repeat(104));
console.log("SHOULD THE 8-THEN-12 SPLIT SHIP? SIMULATE THE COMBINE FORWARD INSTEAD OF SAMPLING WINDOWS");
console.log("=".repeat(104));

console.log("\n-- (1) with a hard deadline: probability of finishing in time --");
console.log("  deadline    flat 8 pass   split pass   delta      flat 8 bust   split bust");
for (const md of [10, 15, 21, 30, 45, 60, 90]) {
  const a = profile(A8, md), b = profile(AS, md);
  console.log("  " + (md + " days").padEnd(12) + a.pass.toFixed(1).padStart(11) + "%" +
    b.pass.toFixed(1).padStart(12) + "%" + (b.pass - a.pass).toFixed(1).padStart(8) + "pp" +
    a.bust.toFixed(1).padStart(15) + "%" + b.bust.toFixed(1).padStart(12) + "%");
}

console.log("\n-- (2) with NO deadline, which is the usual case: run until it passes or busts --");
console.log("  horizon     flat 8 pass   split pass   delta   |   flat 8 bust   split bust   still open");
for (const md of [120, 250, 500]) {
  const a = profile(A8, md), b = profile(AS, md);
  console.log("  " + (md + " days").padEnd(12) + a.pass.toFixed(1).padStart(11) + "%" +
    b.pass.toFixed(1).padStart(12) + "%" + (b.pass - a.pass).toFixed(1).padStart(8) + "pp   |" +
    a.bust.toFixed(1).padStart(14) + "%" + b.bust.toFixed(1).padStart(12) + "%" +
    (a.open.toFixed(1) + "/" + b.open.toFixed(1) + "%").padStart(13));
}

console.log("\n-- (3) how long does a PASS take, when it happens? (250-day horizon) --");
const a250 = profile(A8, 250), b250 = profile(AS, 250);
console.log("  rule       pass%   bust%   median days   25th   75th   median days to BUST");
for (const [lbl, p] of [["flat 8 ", a250], ["8 -> 12", b250]])
  console.log("  " + lbl + p.pass.toFixed(1).padStart(9) + "%" + p.bust.toFixed(1).padStart(7) + "%" +
    String(p.medPass).padStart(14) + String(p.p25).padStart(7) + String(p.p75).padStart(7) +
    String(p.medBust).padStart(22));

console.log("\n-- (4) the trade being made, stated plainly --");
console.log("  Passing SOONER and passing AT ALL are different objectives, and the split");
console.log("  trades one for the other. Speed comes from size; size also reaches the");
console.log("  $2,000 trailing drawdown sooner. Which one you want decides whether to ship.");
console.log("\n  If you face a real deadline (or pay monthly for the attempt), read section 1.");
console.log("  If you can simply keep trading until it resolves, read section 2 -- and the");
console.log("  21-day figure quoted everywhere in this project is neither.");

console.log("\n-- (5) sanity: the window-sampled numbers this project has been quoting --");
console.log("  flat 8  21-day windows: " + passOf(run(flat8), days).toFixed(1) + "%");
console.log("  split   21-day windows: " + passOf(run(split), days).toFixed(1) + "%");
