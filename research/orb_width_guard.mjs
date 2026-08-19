// Are the wide-level days worth trading?
//
// stopAt="opposite" makes the stop the distance to the far level, and size is
// then normalised to $500 of risk. So a wide level pair does not produce a
// bigger bet -- it produces a SMALLER one. The live arm on 2026-08-19 sat at
// the 99.2nd percentile of width and sized to a single lot, which cannot move
// a $3,000 target in a five-minute hold.
//
// If those days earn nothing, a width guard is free: the book stands down and
// stops paying commission and tail risk for a position too small to matter.
//
//   node research/orb_width_guard.mjs

import { setups, resolve } from "./lib_orb.mjs";

const CFG = {
  levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
  mode: "plain", stopAt: "opposite", rMult: 3.0, maxHoldMin: 5,
  retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500, maxLots: 50, maxPerDay: 1,
};
const OPT = { rMult: 3.0, maxHoldMin: 5, riskDollars: 500, maxLots: 50 };

const { out } = setups(CFG);
const tr = out.map((s) => ({ ...resolve(s, OPT), risk: s.risk }));
tr.sort((a, b) => a.risk - b.risk);

const sum = (a) => a.reduce((x, y) => x + y, 0);
const stat = (rows) => {
  const p = rows.map((r) => r.pnl);
  const w = p.filter((x) => x > 0);
  const g = sum(w), l = -sum(p.filter((x) => x <= 0));
  return {
    n: rows.length,
    net: sum(p),
    per: sum(p) / rows.length,
    win: 100 * w.length / rows.length,
    pf: l > 0 ? g / l : Infinity,
    lots: sum(rows.map((r) => r.lots)) / rows.length,
  };
};

console.log("\n" + "=".repeat(92));
console.log("ORB TRADES BY LEVEL WIDTH — deciles, widest last");
console.log("=".repeat(92));
console.log("\n  decile   stop pts      avg lots   trades      net    $/trade   win%     pf");
const D = Math.ceil(tr.length / 10);
for (let d = 0; d < 10; d++) {
  const rows = tr.slice(d * D, (d + 1) * D);
  if (!rows.length) continue;
  const s = stat(rows);
  console.log("    " + String(d + 1).padStart(2) +
    (rows[0].risk.toFixed(1) + "-" + rows[rows.length - 1].risk.toFixed(1)).padStart(14) +
    s.lots.toFixed(1).padStart(11) + String(s.n).padStart(9) +
    ("$" + Math.round(s.net).toLocaleString()).padStart(10) +
    ("$" + s.per.toFixed(2)).padStart(10) +
    s.win.toFixed(1).padStart(7) + s.pf.toFixed(3).padStart(8));
}

console.log("\n" + "=".repeat(92));
console.log("WHAT A WIDTH GUARD WOULD COST OR SAVE");
console.log("=".repeat(92));
console.log("\n  guard              kept   dropped        net kept   net dropped   $/trade kept");
const all = stat(tr);
console.log("  none (shipped)   " + String(all.n).padStart(6) + String(0).padStart(10) +
  ("$" + Math.round(all.net).toLocaleString()).padStart(16) + "".padStart(14) +
  ("$" + all.per.toFixed(2)).padStart(15));
for (const cap of [150, 100, 75, 60, 50, 40, 30]) {
  const keep = tr.filter((r) => r.risk <= cap);
  const drop = tr.filter((r) => r.risk > cap);
  const k = stat(keep), d = drop.length ? stat(drop) : { net: 0 };
  console.log("  stop <= " + String(cap).padStart(3) + " pts   " +
    String(k.n).padStart(6) + String(drop.length).padStart(10) +
    ("$" + Math.round(k.net).toLocaleString()).padStart(16) +
    ("$" + Math.round(d.net).toLocaleString()).padStart(14) +
    ("$" + k.per.toFixed(2)).padStart(15));
}

// The same cut expressed the way the bot would actually apply it.
console.log("\n  equivalently, as a minimum position size:");
console.log("  min lots     kept   dropped        net kept   net dropped   $/trade kept");
for (const ml of [2, 3, 4, 5, 6, 8]) {
  const keep = tr.filter((r) => r.lots >= ml);
  const drop = tr.filter((r) => r.lots < ml);
  const k = stat(keep), d = drop.length ? stat(drop) : { net: 0 };
  console.log("    >=" + String(ml).padStart(2) + "     " +
    String(k.n).padStart(6) + String(drop.length).padStart(10) +
    ("$" + Math.round(k.net).toLocaleString()).padStart(16) +
    ("$" + Math.round(d.net).toLocaleString()).padStart(14) +
    ("$" + k.per.toFixed(2)).padStart(15));
}
