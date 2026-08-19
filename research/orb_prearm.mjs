// Can the ORB levels be known BEFORE the bell?
//
// They have to be. 85.6% of ORB entries fire in the first two minutes after
// 08:30, 62.7% in the first minute, and an arm landing at 08:38 -- which is
// what the live bot did on 2026-08-19 -- keeps 2.1% of the book and loses money
// on the residue. The orders must already be resting when the bell rings.
//
// The window is 06:30-08:29 inclusive, and pivotsIn skips the last `pivotK`
// bars (they can only ever be neighbours), so the last three minutes contribute
// nothing except `ref`, the final close. The question is how much the levels
// move if the bot computes them a minute or two early and places then.
//
//   node research/orb_prearm.mjs

import { touchLevels, daySess, dayEnd, dayKeys, OPEN_CT } from "./lib_orb.mjs";

const CFG = { pivotK: 3, tolFrac: 0.08, minTouch: 3 };
const A = OPEN_CT - 120;

console.log("\n" + "=".repeat(84));
console.log("LEVELS COMPUTED EARLY vs LEVELS COMPUTED AT THE BELL");
console.log("=".repeat(84));
console.log("\n  computed at   days with     identical   hi or lo       level lost   level");
console.log("                a level       levels      moved          entirely     gained");

for (const lead of [1, 2, 3, 5]) {
  let both = 0, same = 0, moved = 0, lost = 0, gained = 0, refDays = 0;
  for (const day of dayKeys) {
    const s0 = daySess.get(day), e0 = dayEnd.get(day);
    if (s0 == null) continue;
    const full = touchLevels(s0, e0, A, OPEN_CT, CFG);
    const early = touchLevels(s0, e0, A, OPEN_CT - lead, CFG);
    if (full) refDays++;
    if (full && early) {
      both++;
      if (full.hi === early.hi && full.lo === early.lo) same++; else moved++;
    } else if (full && !early) lost++;
    else if (!full && early) gained++;
  }
  console.log("  08:" + String(30 - lead).padStart(2, "0") + " CT" +
    String(refDays).padStart(13) +
    (same + " (" + (100 * same / refDays).toFixed(1) + "%)").padStart(15) +
    (moved + " (" + (100 * moved / refDays).toFixed(1) + "%)").padStart(13) +
    String(lost).padStart(15) + String(gained).padStart(11));
}

console.log("\n  'level lost' = the early window found no qualifying level and the full");
console.log("  one did, so arming early would sit out a day the backtest traded.");
console.log("  'moved' days still arm, just at a slightly different price.");
