// The stop is not the problem. The target might be.
//
// orb_scalp_geometry.mjs replaced the level-spread stop with a fixed one and
// every variant collapsed -- best $32,222 on held-out data against $95,975 for
// the shipped book. That stop is not an accident of the design, it is a
// volatility normaliser: close levels -> tight stop -> big size, wide levels ->
// wide stop -> small size. Removing it removes the sizing logic.
//
// So keep it, and move only the TARGET, which is the part that never gets hit:
// 3R is a median 61.1 points against a median 13.5-point favourable excursion
// in the five minutes allowed, and only 11.5% of trades ever reach it.
//
//   node research/orb_target_only.mjs

import { setups, resolve, stat, H1, H2, inSet } from "./lib_orb.mjs";

const BASE = {
  levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
  mode: "plain", stopAt: "opposite", maxHoldMin: 5, retraceFrac: 0.33,
  giveUpCt: 570, riskDollars: 500, maxLots: 50, maxPerDay: 1,
};

function book(cfg) {
  const { out } = setups(cfg);
  return out.map((s) => resolve(s, {
    rMult: cfg.rMult, maxHoldMin: cfg.maxHoldMin,
    riskDollars: cfg.riskDollars, maxLots: cfg.maxLots }));
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
const net = (t) => sum(t.map((r) => r.pnl));
const tpRate = (t) => 100 * t.filter((r) => r.why === "TP").length / t.length;
const winR = (t) => 100 * t.filter((r) => r.pnl > 0).length / t.length;

console.log("\n" + "=".repeat(96));
console.log("TARGET SWEEP — adaptive stop kept, only the R multiple moves");
console.log("=".repeat(96));
console.log("\n  hold   target    TP%   win%    $/trade      1st half     2nd half          all");
const rows = [];
for (const maxHoldMin of [3, 5, 10]) {
  for (const rMult of [0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0]) {
    const t = book({ ...BASE, rMult, maxHoldMin });
    const n1 = net(inSet(t, H1)), n2 = net(inSet(t, H2));
    rows.push({ maxHoldMin, rMult, t, n1, n2 });
    console.log("  " + String(maxHoldMin).padStart(4) + "m" +
      (rMult + "R").padStart(8) + tpRate(t).toFixed(1).padStart(7) +
      winR(t).toFixed(1).padStart(7) +
      ("$" + (net(t) / t.length).toFixed(2)).padStart(11) +
      ("$" + Math.round(n1).toLocaleString()).padStart(14) +
      ("$" + Math.round(n2).toLocaleString()).padStart(13) +
      ("$" + Math.round(net(t)).toLocaleString()).padStart(13));
  }
  console.log("");
}

const ship = rows.find((r) => r.maxHoldMin === 5 && r.rMult === 3.0);
const ranked = rows.slice().sort((a, b) => b.n1 - a.n1);
console.log("=".repeat(96));
console.log("  shipped (5m, 3R)               1st $" + Math.round(ship.n1).toLocaleString() +
            "   2nd $" + Math.round(ship.n2).toLocaleString());
console.log("  best on the 1st half: " + ranked[0].maxHoldMin + "m, " + ranked[0].rMult +
            "R   1st $" + Math.round(ranked[0].n1).toLocaleString() +
            "   2nd $" + Math.round(ranked[0].n2).toLocaleString() +
            "  -> " + (ranked[0].n2 - ship.n2 >= 0 ? "+" : "") +
            "$" + Math.round(ranked[0].n2 - ship.n2).toLocaleString() + " vs shipped");
console.log("  shipped rank on the 1st half: #" + (ranked.indexOf(ship) + 1) +
            " of " + rows.length);
console.log("\n  Does a NEARER target ever win? best 2nd-half among rMult <= 1.5: $" +
  Math.round(Math.max(...rows.filter((r) => r.rMult <= 1.5).map((r) => r.n2))).toLocaleString());
console.log("  best 2nd-half among rMult >= 2:                              $" +
  Math.round(Math.max(...rows.filter((r) => r.rMult >= 2).map((r) => r.n2))).toLocaleString());
