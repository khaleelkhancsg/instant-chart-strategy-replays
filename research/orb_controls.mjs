// Round 2 on the "one 5-minute candle" strategy: kill the artifacts, then see
// what is actually left.
//
// Round 1 produced exactly one positive row -- confirmed entry with the stop on
// the OPPOSITE side of the opening range, +$166/trade. Before believing it,
// three things have to be ruled out:
//
//   1. THE CAP ARTIFACT. At 8 lots a stop wider than 62.5 points implies a loss
//      bigger than the $1,000 platform cap, so the loss is truncated while the
//      2R win is not. That asymmetry manufactures profit out of nothing, and the
//      "opposite side" stop is wide by construction -- the most exposed variant.
//   2. DIRECTION. If shuffling the long/short call does not hurt, the breakout
//      direction carries no information and what is left is pure geometry.
//   3. SIZING. Real risk-per-trade sizing removes the truncation entirely, so a
//      finding that survives it is about the market, not about the cap.
//
// Usage:  node research/orb_controls.mjs

import { run, setups, resolve, stat, passOf, HDR, row, ALL, PV, CAP, LOTS } from "./lib_orb.mjs";

const base = { refWin: "OR5", rMult: 2.0, retraceFrac: 0.33, giveUpCt: 570, mode: "confirmed" };
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

console.log("\n" + "=".repeat(124));
console.log("ROUND 2 -- CONTROLS ON THE ONE POSITIVE VARIANT");
console.log("=".repeat(124));

// ---- 1. how exposed is each stop rule to the cap truncation? ---------------
console.log("\n-- (1) planned risk per trade at 8 lots. Anything over $1,000 has its LOSS truncated but not its win --");
console.log("  stop rule        median risk    mean risk   % over the $1,000 cap");
for (const stopAt of ["range", "level", "retrace", "opposite"]) {
  const { out } = setups({ ...base, stopAt, stopK: 0.5 });
  const usd = out.map(s => s.risk * PV * LOTS);
  const over = 100 * usd.filter(v => v > CAP).length / usd.length;
  console.log("  " + stopAt.padEnd(17) + ("$" + Math.round(med(usd))).padStart(11) +
    ("$" + Math.round(usd.reduce((a, b) => a + b, 0) / usd.length)).padStart(13) +
    over.toFixed(1).padStart(20) + "%");
}

// ---- 2. the positive row, with each artifact removed in turn ---------------
console.log("\n-- (2) the +$166 row, taken apart --");
console.log(HDR);
const opp = { ...base, stopAt: "opposite" };
row("opposite stop (round 1)", run(opp));
row("  + direction shuffled", run({ ...opp, flipSeed: 99 }));
row("  + direction shuffled (s2)", run({ ...opp, flipSeed: 7 }));
row("  + direction shuffled (s3)", run({ ...opp, flipSeed: 12345 }));

// risk-normalised sizing: every trade risks the same dollars, so nothing is
// truncated and the cap asymmetry disappears.
for (const rd of [250, 500]) {
  row("  risk-sized $" + rd + "/trade", run({ ...opp, riskDollars: rd }));
  row("    shuffled", run({ ...opp, riskDollars: rd, flipSeed: 99 }));
}

// keep 8 lots but drop the trades the cap would have truncated
{
  const { out } = setups(opp);
  const keep = out.filter(s => s.risk * PV * LOTS <= CAP);
  const trades = keep.map(s => resolve(s, opp));
  row("  8 lots, cap-safe only", { trades, diag: {} });
  let rnd = 99 >>> 0;
  const coin = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd > 2147483648; };
  row("    shuffled", { trades: keep.map(s => resolve(s, { ...opp, flipDir: coin() ? 1 : -1 })), diag: {} });
}

// ---- 3. does the confirmation help under risk-normalised sizing? -----------
console.log("\n-- (3) the actual claim, with sizing that cannot cheat: confirmed vs plain, $500 risk/trade --");
console.log(HDR);
for (const stopAt of ["range", "opposite", "level"]) {
  const c = { ...base, stopAt, stopK: 0.5, riskDollars: 500 };
  const rc = run({ ...c, mode: "confirmed" });
  const rp = run({ ...c, mode: "plain" });
  row(stopAt + ": confirmed", rc);
  row(stopAt + ": plain", rp);
  row(stopAt + ": confirmed shuffled", run({ ...c, mode: "confirmed", flipSeed: 99 }));
  console.log("");
}
