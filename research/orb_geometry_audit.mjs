// Is the ORB bracket geometry coherent with a five-minute hold?
//
// The live arm on 2026-08-19 rested a 929-tick stop and a 2788-tick target on
// a position that is closed at market after five minutes. Neither barrier is
// reachable in five minutes, which would make both brackets decorative and the
// "3R target" fiction. This checks whether that is true in general.
//
//   node research/orb_geometry_audit.mjs

import { setups, resolve, O, H, L, C, CT, dayEnd } from "./lib_orb.mjs";

const CFG = {
  levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
  mode: "plain", stopAt: "opposite", rMult: 3.0, maxHoldMin: 5,
  retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500, maxLots: 50, maxPerDay: 1,
};
const OPT = { rMult: 3.0, maxHoldMin: 5, riskDollars: 500, maxLots: 50 };

const { out } = setups(CFG);
const tr = out.map((s, i) => ({ ...resolve(s, OPT), s }));

console.log("\n" + "=".repeat(80));
console.log("HOW ORB TRADES ACTUALLY END");
console.log("=".repeat(80));
const why = new Map();
for (const t of tr) why.set(t.why, (why.get(t.why) || 0) + 1);
console.log("");
for (const [k, v] of [...why.entries()].sort((a, b) => b[1] - a[1])) {
  console.log("  " + k.padEnd(8) + String(v).padStart(6) +
    (100 * v / tr.length).toFixed(1).padStart(8) + "%   " +
    "#".repeat(Math.round(50 * v / tr.length)));
}

// What the position is actually worth when it is closed, in POINTS, against
// the barriers it was given.
console.log("\n" + "=".repeat(80));
console.log("HOW FAR PRICE TRAVELS IN FIVE MINUTES vs THE BARRIERS IT WAS GIVEN");
console.log("=".repeat(80));
const rows = tr.map((t) => {
  const { bar: i, dir, entryPx, risk } = t.s;
  const e0 = dayEnd.get(t.tday);
  let best = 0, worst = 0;
  for (let j = i; j < Math.min(i + OPT.maxHoldMin, e0); j++) {
    const up = (H[j] - entryPx) * dir, dn = (L[j] - entryPx) * dir;
    if (up > best) best = up;
    if (dn < worst) worst = dn;
  }
  return { risk, target: risk * OPT.rMult, best, worst, lots: t.lots };
});
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * a.length)];
const fmt = (n) => n.toFixed(1).padStart(9);
console.log("\n                              p25       p50       p75       p95");
console.log("  best excursion (pts)  " + fmt(q(rows.map(r => r.best), .25)) +
  fmt(q(rows.map(r => r.best), .5)) + fmt(q(rows.map(r => r.best), .75)) +
  fmt(q(rows.map(r => r.best), .95)));
console.log("  worst excursion (pts) " + fmt(q(rows.map(r => r.worst), .25)) +
  fmt(q(rows.map(r => r.worst), .5)) + fmt(q(rows.map(r => r.worst), .75)) +
  fmt(q(rows.map(r => r.worst), .95)));
console.log("  the STOP it was given " + fmt(q(rows.map(r => -r.risk), .25)) +
  fmt(q(rows.map(r => -r.risk), .5)) + fmt(q(rows.map(r => -r.risk), .75)) +
  fmt(q(rows.map(r => -r.risk), .95)));
console.log("  the TARGET it was given" + fmt(q(rows.map(r => r.target), .25)).slice(1) +
  fmt(q(rows.map(r => r.target), .5)) + fmt(q(rows.map(r => r.target), .75)) +
  fmt(q(rows.map(r => r.target), .95)));

const reach = rows.filter((r) => r.best >= r.target).length;
const stopped = rows.filter((r) => r.worst <= -r.risk).length;
console.log("\n  trades whose best 5-min excursion REACHED the target: " +
  reach + " of " + rows.length + "  (" + (100 * reach / rows.length).toFixed(1) + "%)");
console.log("  trades whose worst 5-min excursion REACHED the stop:   " +
  stopped + " of " + rows.length + "  (" + (100 * stopped / rows.length).toFixed(1) + "%)");
console.log("\n  So the bracket decides " +
  (100 * (reach + stopped) / rows.length).toFixed(1) + "% of trades. The other " +
  (100 - 100 * (reach + stopped) / rows.length).toFixed(1) + "% are closed at market");
console.log("  by the clock, at whatever price happens to be there.");
