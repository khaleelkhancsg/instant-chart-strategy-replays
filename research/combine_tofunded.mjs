// Attempts are paid for as they are opened, so an idle slot costs nothing and
// the five-slot allowance is a rate limit rather than a budget. That removes
// the reason to cap total attempts at five: you simply keep attempting until
// funded. The real trade is now explicit --
//
//   more parallel  = fewer calendar days to the first pass, more fees burned
//   more sequential= more days, fewer fees
//
// So measure exactly that: for each level of concurrency, time to the FIRST
// pass and fees spent by then. Runs until funded, no five-attempt limit.
//
// Usage:  node research/combine_tofunded.mjs

import { run, dayArr, mul, days } from "./lib_shipped.mjs";
import { loadBars } from "../src/data.mjs";

const TARGET = 3000, DD = 2000, CONSIST = 0.5;
const ARR = dayArr(run(() => 8), days);
const LEN = ARR.length;
const { bars } = loadBars();
const sd = new Set(); let f = null, l = null;
for (let i = 0; i < bars.count; i++) { if (!sd.has(bars.tday[i])) { sd.add(bars.tday[i]); if (f === null) f = bars.ts[i]; } l = bars.ts[i]; }
const RATIO = ((l - f) / 86400000) / sd.size;

const fresh = () => ({ c: 0, pk: 0, lk: false, best: -1e18, out: null });
function step(cb, v) {
  cb.c += v; if (v > cb.best) cb.best = v;
  if (cb.c <= (cb.lk ? 0 : cb.pk - DD)) { cb.out = "bust"; return; }
  if (cb.c > cb.pk) cb.pk = cb.c;
  if (!cb.lk && cb.pk >= DD) cb.lk = true;
  if (cb.c >= TARGET && cb.best <= CONSIST * cb.c) cb.out = "pass";
}

// Keep `conc` attempts running, replacing each as it resolves, until the first
// pass. Returns trading days elapsed and attempts opened.
function toFunded(base, conc, stagger, maxDays = 2000) {
  const live = []; let fees = 0, lastL = -1e9;
  for (let d = 0; d < maxDays; d++) {
    while (live.length < conc && d - lastL >= stagger) { live.push(fresh()); fees++; lastL = d; }
    const v = ARR[(base + d) % LEN];
    for (const cb of live) step(cb, v);
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i].out === "pass") return { days: d + 1, fees };
      if (live[i].out) live.splice(i, 1);
    }
  }
  return { days: maxDays, fees };
}

const TRIALS = 20000;
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
console.log("\n" + "=".repeat(112));
console.log("TIME AND FEES TO YOUR FIRST FUNDED ACCOUNT  |  attempts billed on open, so run until funded");
console.log("=".repeat(112));
console.log("\n  running at once   median days   mean days   calendar days   90th pct   mean fees   fees per pass");
for (const [conc, stag] of [[1, 0], [2, 0], [2, 5], [3, 0], [3, 5], [4, 0], [5, 0], [5, 3], [5, 7]]) {
  const rnd = mul(20250817);
  const dd = [], ff = [];
  for (let t = 0; t < TRIALS; t++) {
    const r = toFunded(Math.floor(rnd() * LEN), conc, stag);
    dd.push(r.days); ff.push(r.fees);
  }
  dd.sort((a, b) => a - b);
  const md = dd.reduce((a, b) => a + b, 0) / TRIALS;
  const mf = ff.reduce((a, b) => a + b, 0) / TRIALS;
  console.log("  " + (conc + (stag ? " (stagger " + stag + "d)" : "")).padEnd(18) +
    String(pct(dd, 0.5)).padStart(11) + md.toFixed(1).padStart(12) +
    (md * RATIO).toFixed(0).padStart(16) + String(pct(dd, 0.9)).padStart(11) +
    mf.toFixed(2).padStart(12) + mf.toFixed(2).padStart(15));
}

console.log("\n-- and if you want MORE than one funded account, how many fees per account --");
console.log("  running at once   accounts wanted   median days   calendar days   mean fees   fees per account");
for (const conc of [1, 2, 3, 5])
for (const want of [1, 3]) {
  const rnd = mul(777);
  const dd = []; let fSum = 0;
  for (let t = 0; t < 4000; t++) {
    const base = Math.floor(rnd() * LEN);
    const live = []; let fees = 0, passes = 0, day = 0;
    for (let d = 0; d < 3000; d++) {
      while (live.length < conc) { live.push(fresh()); fees++; }
      const v = ARR[(base + d) % LEN];
      for (const cb of live) step(cb, v);
      for (let i = live.length - 1; i >= 0; i--) if (live[i].out) {
        if (live[i].out === "pass") passes++;
        live.splice(i, 1);
      }
      if (passes >= want) { day = d + 1; break; }
      day = d + 1;
    }
    dd.push(day); fSum += fees;
  }
  dd.sort((a, b) => a - b);
  const mf = fSum / 4000;
  console.log("  " + String(conc).padEnd(18) + String(want).padStart(11) +
    String(pct(dd, 0.5)).padStart(15) +
    (dd.reduce((a, b) => a + b, 0) / dd.length * RATIO).toFixed(0).padStart(16) +
    mf.toFixed(2).padStart(12) + (mf / want).toFixed(2).padStart(19));
}
console.log("\n  1 trading day = " + RATIO.toFixed(2) + " calendar days");
