// "I want to take advantage of the edge before a regime change."
//
// Two separate questions hide in that, and they have different answers.
//
//   (a) Does concurrency actually convert the edge into accounts faster?
//   (b) Is a regime change something you can see coming, or only survive?
//
// Usage:  node research/edge_decay.mjs

import { run, dayArr, mul, days, yearOf, passOf, inSet, stat } from "./lib_shipped.mjs";

const TARGET = 3000, DD = 2000, CONSIST = 0.5;
const TRADES = run(() => 8);
const ARR = dayArr(TRADES, days);
const LEN = ARR.length;

console.log("\n" + "=".repeat(104));
console.log("HOW FAST DOES THE EDGE CONVERT, AND CAN A REGIME CHANGE BE SEEN COMING?");
console.log("=".repeat(104));

// ---- (b) the edge is NOT stable, which is the premise of the worry --------
console.log("\n-- (b1) the edge by calendar year, which is the reason to worry at all --");
const years = [...new Set([...yearOf.values()])].sort();
const yearly = [];
for (const y of years) {
  const yd = days.filter(d => yearOf.get(d) === y);
  if (yd.length < 120) continue;
  const t = inSet(TRADES, yd), s = stat(t);
  yearly.push({ y, pass: passOf(t, yd), exp: s.exp, pf: s.pf });
  console.log("  " + y + "   pass " + passOf(t, yd).toFixed(1).padStart(5) + "%   pf " +
    s.pf.toFixed(3) + "   $/trade " + s.exp.toFixed(2).padStart(7));
}

// ---- can a good stretch be recognised in advance? ------------------------
console.log("\n-- (b2) does a good stretch PREDICT the next one? rolling 60-trading-day blocks --");
const B = 60, blocks = [];
for (let i = 0; i + B <= LEN; i += B) {
  const sl = ARR.slice(i, i + B);
  blocks.push(sl.reduce((a, b) => a + b, 0) / B);
}
let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
for (let i = 0; i + 1 < blocks.length; i++) {
  const x = blocks[i], y = blocks[i + 1];
  n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
}
const r = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
console.log("  " + blocks.length + " blocks of 60 trading days");
console.log("  correlation between one block's $/day and the NEXT block's: r = " + r.toFixed(3));
console.log("  r^2 = " + (r * r).toFixed(3) + "  ->  the last three months explain " +
  (100 * r * r).toFixed(0) + "% of the next three");
// how often does a good block follow a good block?
let gg = 0, g = 0;
const med = blocks.slice().sort((a, b) => a - b)[blocks.length >> 1];
for (let i = 0; i + 1 < blocks.length; i++) {
  if (blocks[i] > med) { g++; if (blocks[i + 1] > med) gg++; }
}
console.log("  after an above-median block, the next is above-median " +
  (100 * gg / g).toFixed(0) + "% of the time (coin flip = 50%)");

// ---- (a) does concurrency convert faster? -------------------------------
const fresh = () => ({ c: 0, pk: 0, lk: false, best: -1e18, out: null });
function step(cb, v) {
  cb.c += v; if (v > cb.best) cb.best = v;
  if (cb.c <= (cb.lk ? 0 : cb.pk - DD)) { cb.out = "bust"; return; }
  if (cb.c > cb.pk) cb.pk = cb.c;
  if (!cb.lk && cb.pk >= DD) cb.lk = true;
  if (cb.c >= TARGET && cb.best <= CONSIST * cb.c) cb.out = "pass";
}
function toN(base, conc, want, maxDays = 3000) {
  const live = []; let fees = 0, passes = 0;
  for (let d = 0; d < maxDays; d++) {
    while (live.length < conc) { live.push(fresh()); fees++; }
    const v = ARR[(base + d) % LEN];
    for (const cb of live) step(cb, v);
    for (let i = live.length - 1; i >= 0; i--) if (live[i].out) {
      if (live[i].out === "pass") passes++;
      live.splice(i, 1);
    }
    if (passes >= want) return { days: d + 1, fees };
  }
  return { days: maxDays, fees };
}
console.log("\n-- (a) trading days to reach N funded accounts, by how many you run at once --");
console.log("  want   conc 1        conc 2        conc 3        conc 5      (median days / mean fees)");
for (const want of [1, 2, 3, 5]) {
  let line = "  " + String(want).padEnd(7);
  for (const conc of [1, 2, 3, 5]) {
    const rnd = mul(31337); const dd = []; let fSum = 0;
    for (let t = 0; t < 6000; t++) {
      const r = toN(Math.floor(rnd() * LEN), conc, want);
      dd.push(r.days); fSum += r.fees;
    }
    dd.sort((a, b) => a - b);
    line += (String(dd[dd.length >> 1]) + "d / " + (fSum / 6000).toFixed(1) + "f").padEnd(14);
  }
  console.log(line);
}
console.log("\n  (running fewer than N in parallel cannot beat N, because the combines are the");
console.log("   same bet: when the window is good they pass TOGETHER, on the same day.)");
