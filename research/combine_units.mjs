// Two corrections to the staggering answer.
//
// (1) "No cap" was sloppy wording on my part. The cap is FIVE and always is --
//     what I was comparing was whether to limit BELOW five. The question that
//     actually matters is how many are live at once under a given stagger,
//     because if a 7-day stagger never reaches five the allowance is idle.
//
// (2) The simulation steps a TRADING-DAY array (tf.tday), so every "day" in the
//     previous table is a trading day, not a calendar day. Reported as calendar
//     weeks it was wrong.
//
// Usage:  node research/combine_units.mjs

import { run, dayArr, mul, days } from "./lib_shipped.mjs";
import { loadBars } from "../src/data.mjs";

const TARGET = 3000, DD = 2000, CONSIST = 0.5, N = 5;
const ARR = dayArr(run(() => 8), days);
const LEN = ARR.length;

// ---- (2) trading days -> calendar days, measured not assumed ----
const { bars } = loadBars();
const seen = new Set(); let firstTs = null, lastTs = null;
for (let i = 0; i < bars.count; i++) {
  if (!seen.has(bars.tday[i])) { seen.add(bars.tday[i]); if (firstTs === null) firstTs = bars.ts[i]; }
  lastTs = bars.ts[i];
}
const calDays = (lastTs - firstTs) / 86400000;
const ratio = calDays / seen.size;
console.log("\n" + "=".repeat(100));
console.log("UNITS AND CONCURRENCY");
console.log("=".repeat(100));
console.log("\n-- (2) what a 'day' meant in the previous table --");
console.log("  trading days in the dataset : " + seen.size);
console.log("  calendar days spanned       : " + Math.round(calDays));
console.log("  1 trading day               = " + ratio.toFixed(2) + " calendar days");
console.log("  -> every 'day' I quoted was a TRADING day. Multiply by " + ratio.toFixed(2) + " for calendar.");

const fresh = () => ({ c: 0, pk: 0, lk: false, best: -1e18, out: null });
function step(cb, v) {
  cb.c += v; if (v > cb.best) cb.best = v;
  if (cb.c <= (cb.lk ? 0 : cb.pk - DD)) { cb.out = "bust"; return; }
  if (cb.c > cb.pk) cb.pk = cb.c;
  if (!cb.lk && cb.pk >= DD) cb.lk = true;
  if (cb.c >= TARGET && cb.best <= CONSIST * cb.c) cb.out = "pass";
}
function campaign(base, stagger, maxDays = 900) {
  const live = []; let launched = 0, lastL = -1e9, passes = 0;
  let liveSum = 0, liveN = 0, maxLive = 0, everFive = false;
  for (let d = 0; d < maxDays; d++) {
    while (launched < N && live.length < N && d - lastL >= stagger) {
      live.push(fresh()); launched++; lastL = d;
    }
    const v = ARR[(base + d) % LEN];
    for (const cb of live) step(cb, v);
    for (let i = live.length - 1; i >= 0; i--) if (live[i].out) {
      if (live[i].out === "pass") passes++;
      live.splice(i, 1);
    }
    liveSum += live.length; liveN++;
    if (live.length > maxLive) maxLive = live.length;
    if (live.length >= 5) everFive = true;
    if (launched >= N && live.length === 0) break;
  }
  return { passes, days: liveN, meanLive: liveSum / liveN, maxLive, everFive };
}

console.log("\n-- (1) how much of the 5-slot allowance a given stagger actually uses --");
console.log("  stagger        mean live   peak live   ever hit 5 slots   P(0 pass)   trading days   calendar days");
const TRIALS = 20000;
for (const stag of [0, 3, 5, 7, 10, 14, 21]) {
  const rnd = mul(20250817);
  let mSum = 0, pkSum = 0, five = 0, zero = 0, dSum = 0;
  for (let t = 0; t < TRIALS; t++) {
    const r = campaign(Math.floor(rnd() * LEN), stag);
    mSum += r.meanLive; pkSum += r.maxLive; dSum += r.days;
    if (r.everFive) five++;
    if (r.passes === 0) zero++;
  }
  console.log("  " + String(stag === 0 ? "none" : stag + "d").padEnd(12) +
    (mSum / TRIALS).toFixed(2).padStart(10) + (pkSum / TRIALS).toFixed(2).padStart(12) +
    (100 * five / TRIALS).toFixed(0).padStart(17) + "%" +
    (100 * zero / TRIALS).toFixed(1).padStart(12) + "%" +
    (dSum / TRIALS).toFixed(0).padStart(15) + (dSum / TRIALS * ratio).toFixed(0).padStart(15));
}
console.log("\n  A combine resolves in a median of 11 trading days (pass) or 8 (bust), so any stagger");
console.log("  near that length means the earlier one is usually GONE before the next starts. The");
console.log("  5-slot allowance is only fully used when the stagger is short — which is exactly the");
console.log("  case with the correlation problem.");

console.log("\n-- launch schedule in real time --");
for (const stag of [3, 7, 14]) {
  const lastLaunch = 4 * stag;
  console.log("  stagger " + String(stag + "d").padEnd(4) + " -> 5th combine starts on trading day " +
    String(lastLaunch).padStart(3) + " = calendar day " +
    String(Math.round(lastLaunch * ratio)).padStart(3) +
    "  (~" + (lastLaunch * ratio / 7).toFixed(1) + " weeks)");
}
