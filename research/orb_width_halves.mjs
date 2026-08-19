// Does the width gradient survive being split in half?
//
// orb_width_guard.mjs found $/trade decaying monotonically from $383 in the
// tightest decile to -$8 in the widest, and a "best" cut at 50 points worth
// +$5,411. The cut is the suspicious part: seven thresholds tried on one
// sample, and net is non-monotone across them ($186k at 50, $179k at 40),
// which is what noise looks like. The GRADIENT is the claim worth testing.
//
//   node research/orb_width_halves.mjs

import { setups, resolve } from "./lib_orb.mjs";

const CFG = {
  levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
  mode: "plain", stopAt: "opposite", rMult: 3.0, maxHoldMin: 5,
  retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500, maxLots: 50, maxPerDay: 1,
};
const OPT = { rMult: 3.0, maxHoldMin: 5, riskDollars: 500, maxLots: 50 };

const { out } = setups(CFG);
const tr = out.map((s) => ({ ...resolve(s, OPT), risk: s.risk }));
// Chronological halves. `bar` is the index into the 1-minute series, so the
// setup order out of setups() is already time-ordered.
const H = tr.length >> 1;
const halves = { "1st half": tr.slice(0, H), "2nd half": tr.slice(H) };

const sum = (a) => a.reduce((x, y) => x + y, 0);
const per = (rows) => sum(rows.map((r) => r.pnl)) / rows.length;

console.log("\n" + "=".repeat(86));
console.log("THE WIDTH GRADIENT, EACH HALF SEPARATELY — quartiles of stop distance");
console.log("=".repeat(86));
console.log("\n  half        quartile     stop pts     trades    $/trade     avg lots");
for (const [name, rows] of Object.entries(halves)) {
  const s = rows.slice().sort((a, b) => a.risk - b.risk);
  const Q = Math.ceil(s.length / 4);
  for (let q = 0; q < 4; q++) {
    const g = s.slice(q * Q, (q + 1) * Q);
    if (!g.length) continue;
    console.log("  " + (q === 0 ? name.padEnd(12) : "".padEnd(12)) +
      ("Q" + (q + 1)).padStart(6) +
      (g[0].risk.toFixed(1) + "-" + g[g.length - 1].risk.toFixed(1)).padStart(15) +
      String(g.length).padStart(9) +
      ("$" + per(g).toFixed(2)).padStart(12) +
      (sum(g.map((r) => r.lots)) / g.length).toFixed(1).padStart(12));
  }
  console.log("");
}

// Rank correlation between width and outcome, per half. Non-parametric, so a
// couple of large trades cannot manufacture the trend on their own.
function spearman(rows) {
  const n = rows.length;
  const rank = (key) => {
    const idx = rows.map((r, i) => i).sort((a, b) => rows[a][key] - rows[b][key]);
    const rk = new Array(n);
    for (let i = 0; i < n; i++) rk[idx[i]] = i + 1;
    return rk;
  };
  const a = rank("risk"), b = rank("pnl");
  const ma = (n + 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - ma); da += (a[i] - ma) ** 2; db += (b[i] - ma) ** 2;
  }
  return num / Math.sqrt(da * db);
}
console.log("  rank correlation of stop width vs trade P&L (negative = wider is worse)");
for (const [name, rows] of Object.entries(halves)) {
  const r = spearman(rows);
  const z = r * Math.sqrt(rows.length - 1);          // approx, large n
  console.log("    " + name.padEnd(12) + "rho " + r.toFixed(4).padStart(8) +
              "   z " + z.toFixed(2).padStart(6) +
              (Math.abs(z) > 1.96 ? "   significant" : "   NOT significant"));
}
console.log("    " + "all".padEnd(12) + "rho " + spearman(tr).toFixed(4).padStart(8));

// The cut chosen on the first half, applied to the second.
console.log("\n" + "=".repeat(86));
console.log("PICK THE CUT ON THE 1ST HALF, READ IT ON THE 2ND");
console.log("=".repeat(86));
const CUTS = [30, 40, 50, 60, 75, 100, 150, Infinity];
const netOf = (rows, cut) => sum(rows.filter((r) => r.risk <= cut).map((r) => r.pnl));
let best = null;
console.log("\n  cut        1st half net     2nd half net");
for (const c of CUTS) {
  const n1 = netOf(halves["1st half"], c), n2 = netOf(halves["2nd half"], c);
  if (!best || n1 > best.n1) best = { c, n1, n2 };
  console.log("  " + (c === Infinity ? "none" : "<= " + c + " pts").padEnd(12) +
    ("$" + Math.round(n1).toLocaleString()).padStart(14) +
    ("$" + Math.round(n2).toLocaleString()).padStart(17));
}
const base2 = netOf(halves["2nd half"], Infinity);
console.log("\n  best on the 1st half: " + (best.c === Infinity ? "none" : "<= " + best.c + " pts"));
console.log("  its 2nd-half net:     $" + Math.round(best.n2).toLocaleString() +
            "   vs $" + Math.round(base2).toLocaleString() + " ungated" +
            "   -> " + (best.n2 - base2 >= 0 ? "+" : "") +
            "$" + Math.round(best.n2 - base2).toLocaleString());
