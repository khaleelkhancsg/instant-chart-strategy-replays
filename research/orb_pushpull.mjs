// "One 5-minute candle a day" -- the YouTube opening-range strategy, formalised.
//
// The transcript is discretionary prose. What it actually commits to:
//   1. Trade only around the NY open (09:30 ET = ctMin 510 here, Chicago).
//   2. Draw a level from where price has been reacting most before/at the open.
//   3. Do NOT enter on the first break. Wait for  push -> retrace -> second push
//      past the first push's extreme, then enter with the momentum.
//   4. Stop "basically at this level" (the broken level).
//   5. Target "off liquidity" -- undefined, so it needs an R multiple proxy.
//   6. One trade a day, held minutes not hours.
//
// The only novel claim is (3): that push/retrace/push filters out fake
// breakouts. Everything else is a standard opening-range breakout, which is old
// and well documented. So the headline test is CONFIRMED vs PLAIN under
// IDENTICAL risk geometry -- same level, same stop distance, same R target,
// same costs -- so the only difference is whether you wait for the second push.
//
// RESOLUTION HONESTY: he works off ~5-second bars ("a retrace for at least 5
// seconds"). These are 1-minute bars. No intrabar ordering is ever assumed:
// each leg must land on a STRICTLY LATER bar than the previous leg. That makes
// this slower to trigger than his version and skips days where one bar contains
// the whole pattern. It cannot manufacture an edge.
//
// Usage:  node research/orb_pushpull.mjs

import { run, HDR, row, ALL } from "./lib_orb.mjs";

console.log("\n" + "=".repeat(124));
console.log('THE "ONE 5-MINUTE CANDLE" STRATEGY ON MNQ  |  ' + ALL.length +
            " days, 2019-05 to 2026-07  |  8 lots, $1,000 day cap, 1 tick slip + $0.75/side");
console.log("=".repeat(124));

const base = { refWin: "OR5", stopAt: "range", stopK: 0.5, rMult: 2.0, retraceFrac: 0.33, giveUpCt: 570 };

console.log("\n-- (1) the claim: does waiting for the second push help? matched risk (0.5x OR width), 2R target --");
console.log(HDR);
const conf = run({ ...base, mode: "confirmed" });
row("confirmed (push-ret-push)", conf);
const plain = run({ ...base, mode: "plain" });
row("plain break (no confirm)", plain);
row("confirmed, direction shuffled", run({ ...base, mode: "confirmed", flipSeed: 99 }));
row("plain, direction shuffled", run({ ...base, mode: "plain", flipSeed: 99 }));

console.log("\n  funnel confirmed: " + JSON.stringify(conf.diag));
console.log("  funnel plain:     " + JSON.stringify(plain.diag));

console.log("\n-- (2) his literal stop (\"basically at this level\") --");
console.log(HDR);
row("confirmed, stop at level", run({ ...base, stopAt: "level", mode: "confirmed" }));
row("confirmed, stop at retrace", run({ ...base, stopAt: "retrace", mode: "confirmed" }));
row("confirmed, stop opposite side", run({ ...base, stopAt: "opposite", mode: "confirmed" }));
