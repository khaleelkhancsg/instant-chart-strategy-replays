// How big is an ORB trade, really?
//
// A live arm on 2026-08-19 rested a 1-lot stop with a 232-point stop loss.
// That is the geometry the config asks for -- stopAt "opposite" measures risk
// to the FAR level -- but 1 lot against a $3,000 target is close to no trade at
// all. This asks whether that day was unusual or whether it is the norm.
//
//   node research/orb_risk_dist.mjs

import { setups } from "./lib_orb.mjs";

const CFG = {
  levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
  mode: "plain", stopAt: "opposite", rMult: 3.0, maxHoldMin: 5,
  retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500, maxLots: 50, maxPerDay: 1,
};

const { out, diag } = setups(CFG);
const PV = 2.0;

const lotsOf = (risk) => Math.max(1, Math.min(CFG.maxLots,
  Math.floor(CFG.riskDollars / (risk * PV))));

const risks = out.map((s) => s.risk).sort((a, b) => a - b);
const lots = out.map((s) => lotsOf(s.risk)).sort((a, b) => a - b);
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];

console.log("\n" + "=".repeat(78));
console.log("ORB TRADE SIZE, as the shipped config actually produces it");
console.log("=".repeat(78));
console.log("\n  days examined            " + diag.days);
console.log("  days with a level        " + diag.nLevel +
            "  (" + (100 * diag.nLevel / diag.days).toFixed(1) + "%)");
console.log("  days that actually armed " + out.length +
            "  (" + (100 * out.length / diag.days).toFixed(1) + "% of days)");

console.log("\n  stop distance (points), because stopAt='opposite' measures to the far level");
for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
  console.log("    p" + String(Math.round(p * 100)).padStart(2) +
              q(risks, p).toFixed(1).padStart(9) + " pts" +
              ("$" + Math.round(q(risks, p) * PV)).padStart(9) + " per lot");
}
console.log("    max" + risks[risks.length - 1].toFixed(1).padStart(8) + " pts");

console.log("\n  resulting position size");
for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
  console.log("    p" + String(Math.round(p * 100)).padStart(2) +
              String(q(lots, p)).padStart(9) + " lots");
}
const hist = new Map();
for (const l of lots) hist.set(l, (hist.get(l) || 0) + 1);
console.log("\n  how often each size comes up");
for (const [l, c] of [...hist.entries()].sort((a, b) => a[0] - b[0]).slice(0, 12)) {
  console.log("    " + String(l).padStart(3) + " lots  " +
    String(c).padStart(5) + "  " + (100 * c / lots.length).toFixed(1).padStart(5) + "%  " +
    "#".repeat(Math.round(60 * c / lots.length)));
}
const one = lots.filter((l) => l === 1).length;
console.log("\n  trades that size to exactly ONE lot: " + one +
            " of " + lots.length + "  (" + (100 * one / lots.length).toFixed(1) + "%)");

// Where does the 2026-08-19 arm sit? risk was 232.25 points.
const today = 232.25;
const pct = 100 * risks.filter((r) => r < today).length / risks.length;
console.log("  the live 2026-08-19 arm risked " + today + " pts -> percentile " +
            pct.toFixed(1) + " of all historical arms");
