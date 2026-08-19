// Re-run the geometry question inside the CURRENT volatility regime.
//
// Pooled 2019-2026 the ORB's median stop is 20.4 points and median size 12
// lots. In 2026 alone it is 46.7 points and 5 lots, and 13.6% of trades are a
// single lot against 3.3% pooled. So a conclusion drawn on the pooled sample
// may be describing 2019, which no longer exists.
//
// 2026 is only 66 trades, which cannot rank 30 configs. So each conclusion is
// checked on three nested windows -- 2024-26 (343), 2025-26 (210), 2026 (66).
// A finding that holds as the window tightens is about the regime; one that
// appears only in the smallest window is about the sample size.
//
//   node research/orb_regime_geometry.mjs

import { setups, resolve, dayStart, TS } from "./lib_orb.mjs";

const BASE = {
  levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
  mode: "plain", maxHoldMin: 5, retraceFrac: 0.33, giveUpCt: 570,
  riskDollars: 500, maxLots: 50, maxPerDay: 1,
};
const yearOf = (tday) => new Date(TS[dayStart.get(tday)]).getUTCFullYear();

function book(cfg, fromYear) {
  const { out } = setups(cfg);
  return out.map((s) => resolve(s, {
      rMult: cfg.rMult, maxHoldMin: cfg.maxHoldMin,
      riskDollars: cfg.riskDollars, maxLots: cfg.maxLots }))
    .filter((t) => yearOf(t.tday) >= fromYear);
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
const net = (t) => sum(t.map((r) => r.pnl));
const per = (t) => (t.length ? net(t) / t.length : 0);
const WINDOWS = [[2019, "all years"], [2024, "2024-26"], [2025, "2025-26"], [2026, "2026 only"]];

function table(title, variants) {
  console.log("\n" + "=".repeat(96));
  console.log(title);
  console.log("=".repeat(96));
  console.log("\n  variant                    " +
    WINDOWS.map(([, l]) => (l + " $/tr").padStart(17)).join(""));
  const best = new Map();
  for (const [label, cfg] of variants) {
    let line = "  " + label.padEnd(27);
    for (const [fy, wl] of WINDOWS) {
      const t = book(cfg, fy);
      line += (("$" + per(t).toFixed(0)) + " (" + t.length + ")").padStart(17);
      const k = wl;
      if (!best.has(k) || per(t) > best.get(k).v) best.set(k, { v: per(t), label });
    }
    console.log(line);
  }
  console.log("\n  best per window:");
  for (const [, wl] of WINDOWS) {
    console.log("    " + wl.padEnd(12) + best.get(wl).label +
                "   ($" + best.get(wl).v.toFixed(0) + "/trade)");
  }
}

// ---- 1. does the fixed scalp stop come back in a volatile regime? --------
const stopVariants = [["SHIPPED  opposite, 3R",
                       { ...BASE, stopAt: "opposite", rMult: 3.0 }]];
for (const stopPts of [10, 20, 30, 50])
  for (const rMult of [1.5, 3.0])
    stopVariants.push([`fixed ${stopPts}pt, ${rMult}R`,
                       { ...BASE, stopAt: "fixed", stopPts, rMult }]);
table("1. FIXED SCALP STOP vs THE ADAPTIVE ONE, BY REGIME WINDOW", stopVariants);

// ---- 2. does a nearer target come back? ---------------------------------
const tgtVariants = [];
for (const rMult of [0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0])
  tgtVariants.push([(rMult === 3.0 ? "SHIPPED  " : "         ") + rMult + "R",
                    { ...BASE, stopAt: "opposite", rMult }]);
table("2. TARGET MULTIPLE, ADAPTIVE STOP KEPT", tgtVariants);

// ---- 3. hold time ------------------------------------------------------
const holdVariants = [];
for (const maxHoldMin of [3, 5, 10, 20, 30])
  holdVariants.push([(maxHoldMin === 5 ? "SHIPPED  " : "         ") + maxHoldMin + " min",
                     { ...BASE, stopAt: "opposite", rMult: 3.0, maxHoldMin }]);
table("3. HOLD TIME", holdVariants);
