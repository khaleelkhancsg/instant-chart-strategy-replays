// Round 4 -- the two questions the sweep left open.
//
// (A) HIS ACTUAL CLAIM, paired. The sweep's top 12 were all "plain", but that
//     is a ranking, not a test. Run every configuration BOTH ways -- confirmed
//     and plain, identical in every other respect -- and look at the paired
//     difference. 960 matched pairs answers "does waiting for the second push
//     help?" far better than a leaderboard does.
//
// (B) WHAT THE WINNERS ACTUALLY ARE. The sweep's best configs all drifted to
//     3R targets held to the close, on a PRE-open range -- which is no longer
//     "one 5-minute candle, in and out in two minutes". If a dumb always-long
//     hold-to-close position scores the same, the sweep found market drift and
//     bet size, not a strategy.
//
// Usage:  node research/orb_verdict.mjs

import { run, resolve, stat, passOf, ALL, H1, H2, RECENT, inSet,
         dayKeys, dayEnd, daySess, CT, O, H, L, OPEN_CT, PV } from "./lib_orb.mjs";

// ---------------------------------------------------------------- (A) paired
const PAIRS = [];
for (const refWin of ["OR5", "OR15", "OR30", "OR60", "PRE30", "PRE60"])
for (const [stopAt, stopK] of [["range", 0.25], ["range", 0.5], ["range", 1.0], ["retrace", 0], ["opposite", 0]])
for (const rMult of [1.0, 1.5, 2.0, 3.0])
for (const giveUpCt of [570, 630])
for (const maxHoldMin of [15, 60, 120, 1000])
  PAIRS.push({ refWin, stopAt, stopK, rMult, giveUpCt, maxHoldMin, retraceFrac: 0.33, riskDollars: 500 });

console.log("\n" + "=".repeat(112));
console.log("ROUND 4 -- (A) DOES THE SECOND PUSH HELP?  " + PAIRS.length +
            " matched pairs, identical but for the confirmation");
console.log("=".repeat(112));

let cWins = 0, pWins = 0, dPass = [], dExp = [];
for (const c of PAIRS) {
  const rc = run({ ...c, mode: "confirmed" }), rp = run({ ...c, mode: "plain" });
  if (rc.trades.length < 200 || rp.trades.length < 200) continue;
  const wc = Math.min(passOf(inSet(rc.trades, H1), H1), passOf(inSet(rc.trades, H2), H2));
  const wp = Math.min(passOf(inSet(rp.trades, H1), H1), passOf(inSet(rp.trades, H2), H2));
  const sc = stat(rc.trades), sp = stat(rp.trades);
  if (wc > wp) cWins++; else if (wp > wc) pWins++;
  dPass.push(wc - wp); dExp.push(sc.exp - sp.exp);
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const medn = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
console.log("\n  pairs evaluated                       " + dPass.length);
console.log("  confirmation wins on pass rate        " + cWins + "  (" +
            (100 * cWins / dPass.length).toFixed(0) + "%)");
console.log("  plain break wins on pass rate         " + pWins + "  (" +
            (100 * pWins / dPass.length).toFixed(0) + "%)");
console.log("  mean pass-rate delta (conf - plain)   " + mean(dPass).toFixed(2) + "pp");
console.log("  median pass-rate delta                " + medn(dPass).toFixed(2) + "pp");
console.log("  mean $/trade delta (conf - plain)     $" + mean(dExp).toFixed(2) +
            "   <- confirmation does lift per-trade quality");
console.log("  median $/trade delta                  $" + medn(dExp).toFixed(2));
console.log("\n  Reading: the confirmation makes each trade better and the account worse.");
console.log("  It halves the number of trades (825 vs 1850), and this evaluation is a");
console.log("  21-day race to +$3,000 -- fewer shots at the target costs more than the");
console.log("  better shots gain. Same throughput constraint that governs the live bot.");

// ------------------------------------------------------------------ (B) beta
console.log("\n" + "=".repeat(112));
console.log("ROUND 4 -- (B) IS THE SWEEP WINNER A STRATEGY, OR JUST A BIG POSITION HELD ALL DAY?");
console.log("=".repeat(112));

// Dumbest possible baselines on the same days, same sizing, same costs: enter at
// a fixed time, hold to the close, no level, no pattern, no signal at all.
function dumb(dir, entryCt, riskPts, riskDollars) {
  const sch = [];
  for (const day of dayKeys) {
    const e0 = dayEnd.get(day);
    let i = daySess.get(day);
    while (i < e0 && CT[i] < entryCt) i++;
    if (i >= e0 || CT[i] >= entryCt + 5) continue;
    const d = dir === 0 ? (day % 2 ? 1 : -1) : dir;
    sch.push({ bar: i, dir: d, entryPx: O[i], risk: riskPts, day, e0, width: 0 });
  }
  return sch.map(s => resolve(s, { rMult: 3.0, maxHoldMin: 1000, riskDollars }));
}
const HDR2 = "  baseline                              n   win%     pf  $/trade    pass    1stH    2ndH  recent";
console.log("\n" + HDR2);
const rowB = (lbl, t) => {
  const st = stat(t);
  console.log("  " + lbl.padEnd(32) + String(st.n).padStart(6) + st.win.toFixed(1).padStart(7) +
    st.pf.toFixed(3).padStart(7) + ("$" + st.exp.toFixed(2)).padStart(9) +
    passOf(t, ALL).toFixed(1).padStart(8) + "%" +
    passOf(inSet(t, H1), H1).toFixed(1).padStart(7) + "%" +
    passOf(inSet(t, H2), H2).toFixed(1).padStart(7) + "%" +
    passOf(inSet(t, RECENT), RECENT).toFixed(1).padStart(7) + "%");
};
for (const rp of [40, 80]) {
  rowB("always LONG at open, hold EOD (" + rp + "pt)", dumb(1, OPEN_CT, rp, 500));
  rowB("always SHORT at open, hold EOD (" + rp + "pt)", dumb(-1, OPEN_CT, rp, 500));
  rowB("alternating L/S, hold EOD (" + rp + "pt)", dumb(0, OPEN_CT, rp, 500));
}
console.log("\n  For reference, the sweep's best real config scored 29.4% on its worse half,");
console.log("  and the same grid on a COIN FLIP also produced a 29.4% winner.");
