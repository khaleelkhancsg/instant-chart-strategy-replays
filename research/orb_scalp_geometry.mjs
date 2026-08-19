// Make the ORB an actual scalp: fixed stop, near target, real size.
//
// As shipped, stopAt="opposite" ties the stop to the level SPREAD, so the
// geometry is whatever the pre-open range happened to be. Measured over 1,045
// entries against a five-minute hold:
//
//   median stop given      20.4 pts   median adverse excursion   -8.1 pts
//   median target given    61.1 pts   median favourable          13.5 pts
//   target reached          11.5%     time-stopped at market      56.8%
//
// The target is roughly 4.5x further than price actually travels in the time
// allowed, so it is decorative. And because size = $500 / stop, a wide day
// collapses the position -- the live arm on 2026-08-19 took ONE lot.
//
// A fixed stop inverts that: the geometry stays a scalp and SIZE absorbs the
// day's character. Selection is on the first half only; the second half is
// never used to choose anything.
//
//   node research/orb_scalp_geometry.mjs

import { setups, resolve, dayKeys, stat, H1, H2, inSet } from "./lib_orb.mjs";

const BASE = {
  levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
  mode: "plain", maxHoldMin: 5, retraceFrac: 0.33, giveUpCt: 570,
  riskDollars: 500, maxLots: 50, maxPerDay: 1,
};

function book(cfg) {
  const { out } = setups(cfg);
  const opt = { rMult: cfg.rMult, maxHoldMin: cfg.maxHoldMin,
                riskDollars: cfg.riskDollars, maxLots: cfg.maxLots };
  return out.map((s) => resolve(s, opt));
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
const net = (t) => sum(t.map((r) => r.pnl));
const per = (t) => net(t) / t.length;
const lots = (t) => sum(t.map((r) => r.lots)) / t.length;
const wins = (t) => 100 * t.filter((r) => r.pnl > 0).length / t.length;
const tpRate = (t) => 100 * t.filter((r) => r.why === "TP").length / t.length;

console.log("\n" + "=".repeat(104));
console.log("SHIPPED GEOMETRY vs SCALP GEOMETRY");
console.log("=".repeat(104));
console.log("\n  config                       avg lots   win%    TP%    $/trade" +
            "       1st half       2nd half           all");

function row(label, cfg) {
  const t = book(cfg);
  const t1 = inSet(t, H1), t2 = inSet(t, H2);
  console.log("  " + label.padEnd(28) + lots(t).toFixed(1).padStart(8) +
    wins(t).toFixed(1).padStart(7) + tpRate(t).toFixed(1).padStart(7) +
    ("$" + per(t).toFixed(2)).padStart(11) +
    ("$" + Math.round(net(t1)).toLocaleString()).padStart(15) +
    ("$" + Math.round(net(t2)).toLocaleString()).padStart(15) +
    ("$" + Math.round(net(t)).toLocaleString()).padStart(14));
  return { t, n1: net(t1), n2: net(t2) };
}

const shipped = row("shipped (opposite, 3R)",
  { ...BASE, stopAt: "opposite", rMult: 3.0 });

console.log("");
const grid = [];
for (const stopPts of [5, 8, 10, 15, 20, 30])
  for (const rMult of [0.75, 1.0, 1.5, 2.0, 3.0])
    grid.push({ stopPts, rMult });

for (const g of grid) {
  const cfg = { ...BASE, stopAt: "fixed", stopPts: g.stopPts, rMult: g.rMult };
  const t = book(cfg);
  const t1 = inSet(t, H1), t2 = inSet(t, H2);
  grid[grid.indexOf(g)].res = { t, n1: net(t1), n2: net(t2), per: per(t) };
}
grid.sort((a, b) => b.res.n1 - a.res.n1);

console.log("  ranked by FIRST HALF only — the second half is the read-out");
console.log("  stop / target             avg lots   win%    TP%    $/trade" +
            "       1st half       2nd half           all");
for (const g of grid.slice(0, 10)) {
  const t = g.res.t;
  console.log("  " + (g.stopPts + " pts stop, " + g.rMult + "R").padEnd(28) +
    lots(t).toFixed(1).padStart(8) + wins(t).toFixed(1).padStart(7) +
    tpRate(t).toFixed(1).padStart(7) + ("$" + per(t).toFixed(2)).padStart(11) +
    ("$" + Math.round(g.res.n1).toLocaleString()).padStart(15) +
    ("$" + Math.round(g.res.n2).toLocaleString()).padStart(15) +
    ("$" + Math.round(net(t)).toLocaleString()).padStart(14));
}

const best = grid[0];
console.log("\n  best on the 1st half: " + best.stopPts + " pt stop, " + best.rMult + "R");
console.log("    1st half  $" + Math.round(best.res.n1).toLocaleString() +
            "   vs shipped $" + Math.round(shipped.n1).toLocaleString());
console.log("    2nd half  $" + Math.round(best.res.n2).toLocaleString() +
            "   vs shipped $" + Math.round(shipped.n2).toLocaleString() +
            "   -> " + (best.res.n2 - shipped.n2 >= 0 ? "+" : "") +
            "$" + Math.round(best.res.n2 - shipped.n2).toLocaleString());
console.log("\n  worst config in the grid on the 2nd half: $" +
  Math.round(Math.min(...grid.map((g) => g.res.n2))).toLocaleString() +
  "   best: $" + Math.round(Math.max(...grid.map((g) => g.res.n2))).toLocaleString());
console.log("  (shipped sits at $" + Math.round(shipped.n2).toLocaleString() + ")");
