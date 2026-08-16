// Round 8 -- "take profit off liquidity", implemented instead of substituted.
//
// Every earlier round replaced it with a fixed R multiple, which is the one
// place the formalisation openly departed from what he describes. He gives one
// concrete handle -- "it can even be off another level" -- and the surrounding
// vocabulary is standard: liquidity means resting stop orders, which pool just
// beyond prices the market has already turned at. That is the same pivot
// clustering already built for the entry level, run over the overnight session.
//
// Six readings, all computed strictly from bars before the open:
//   windowExt  the pre-open window's extreme in the direction of travel
//   liqNear    nearest overnight pivot cluster beyond entry
//   liqFar     second nearest
//   liqBest    the cluster with the most taps beyond entry
//   prevDay    prior day's RTH high (long) or low (short)
//   sessExt    the overnight session extreme
//
// The structural difference from a fixed R is that the target DISTANCE now
// varies per trade. That also makes the 1-second question real: a near target
// lands inside the same 1-minute bar as the stop far more often than a 3R
// target does, and 1-minute OHLC cannot say which came first. Section (3)
// measures exactly that.
//
// Usage:  node research/orb_liquidity.mjs

import { run, setups, stat, passOf, HDR, row, ALL, H1, H2, RECENT, inSet } from "./lib_orb.mjs";

const TOUCH = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
                retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500, maxHoldMin: 1000 };
const GEO  = { ...TOUCH, mode: "plain", stopAt: "opposite" };     // strongest shape found
const HIS  = { ...TOUCH, mode: "confirmed", stopAt: "level", maxHoldMin: 120 };  // his rule
const MODES = ["windowExt", "liqNear", "liqFar", "liqBest", "prevDay", "sessExt"];

console.log("\n" + "=".repeat(124));
console.log("ROUND 8 -- TAKE PROFIT AT LIQUIDITY");
console.log("=".repeat(124));

// ---- 1. what do these targets actually look like? -------------------------
console.log("\n-- (1) target geometry: is a liquidity target even reachable, and how far is it in R? --");
console.log("  target      trades w/ target   median R   mean R   %targets closer than 1R   % of setups with no target");
for (const tpMode of MODES) {
  const { out, diag } = setups({ ...GEO, tpMode, tpFallback: "skip" });
  if (!out.length) { console.log("  " + tpMode.padEnd(12) + "   none"); continue; }
  const rs = out.map(s => (s.tpPx - s.entryPx) * s.dir / s.risk).sort((a, b) => a - b);
  const base = setups({ ...GEO, tpMode: "R" }).out.length;
  console.log("  " + tpMode.padEnd(12) + String(out.length).padStart(14) +
    rs[rs.length >> 1].toFixed(2).padStart(11) +
    (rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2).padStart(9) +
    (100 * rs.filter(r => r < 1).length / rs.length).toFixed(0).padStart(24) + "%" +
    (100 * (base - out.length) / base).toFixed(0).padStart(26) + "%");
}

// ---- 2. does a liquidity target beat a fixed R? ---------------------------
console.log("\n-- (2) his full rule: tap levels + push/retrace/push + stop at the level --");
console.log(HDR);
for (const r of [1.5, 2, 3]) row("fixed " + r + "R target", run({ ...HIS, tpMode: "R", rMult: r }));
for (const tpMode of MODES) row("liquidity: " + tpMode, run({ ...HIS, tpMode, tpFallback: "R", rMult: 2 }));

console.log("\n-- (2b) on the strongest geometry found (plain break, opposite-side stop, held to close) --");
console.log(HDR);
for (const r of [1.5, 2, 3]) row("fixed " + r + "R target", run({ ...GEO, tpMode: "R", rMult: r }));
for (const tpMode of MODES) row("liquidity: " + tpMode, run({ ...GEO, tpMode, tpFallback: "R", rMult: 3 }));

// ---- 3. THE POLLING QUESTION ---------------------------------------------
console.log("\n-- (3) what would 1-second data actually buy? --");
console.log("   When one 1-minute bar contains BOTH the stop and the target, its OHLC cannot say");
console.log("   which came first. Every result above assumes the STOP came first. Assuming the");
console.log("   TARGET came first is the other extreme. The truth is between, and the gap is the");
console.log("   most that finer resolution could possibly be worth.");
console.log("\n  target            ambiguous bars    pass (stop first)   pass (target first)     spread");
for (const tpMode of ["R", ...MODES]) {
  const c = { ...GEO, tpMode, tpFallback: "R", rMult: 3 };
  const pess = run({ ...c, barFirst: "stop" }), opt = run({ ...c, barFirst: "target" });
  const amb = 100 * pess.trades.filter(t => t.ambig).length / pess.trades.length;
  const a = passOf(pess.trades, ALL), b = passOf(opt.trades, ALL);
  console.log("  " + tpMode.padEnd(16) + amb.toFixed(1).padStart(13) + "%" +
    a.toFixed(1).padStart(20) + "%" + b.toFixed(1).padStart(21) + "%" +
    (b - a).toFixed(1).padStart(11) + "pp");
}

// ---- 4. the control that matters -----------------------------------------
console.log("\n-- (4) level-shuffle control on the best liquidity variant --");
console.log("   same days, same geometry, level borrowed from another day");
console.log(HDR);
let best = null;
for (const tpMode of MODES) {
  const r = run({ ...GEO, tpMode, tpFallback: "R", rMult: 3 });
  const w = Math.min(passOf(inSet(r.trades, H1), H1), passOf(inSet(r.trades, H2), H2));
  if (!best || w > best.w) best = { w, tpMode };
}
console.log("  (best liquidity target by worse half: " + best.tpMode + ")");
row(best.tpMode + " (real levels)", run({ ...GEO, tpMode: best.tpMode, tpFallback: "R", rMult: 3 }));
for (const s of [5, 11, 23, 42, 77])
  row("  levels shuffled, seed " + s,
      run({ ...GEO, tpMode: best.tpMode, tpFallback: "R", rMult: 3, levelMode: "touchShuffled", levelSeed: s }));
