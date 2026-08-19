// Everything measured so far pooled 2019-2026. MNQ's character at the NY open
// has changed enormously over that span, so a median computed across all of it
// may describe no year in particular. This splits every ORB fact by year.
//
//   node research/orb_by_year.mjs

import { setups, resolve, dayStart, TS, PV } from "./lib_orb.mjs";

const CFG = {
  levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
  mode: "plain", stopAt: "opposite", rMult: 3.0, maxHoldMin: 5,
  retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500, maxLots: 50, maxPerDay: 1,
};
const OPT = { rMult: 3.0, maxHoldMin: 5, riskDollars: 500, maxLots: 50 };

const yearOf = (tday) => new Date(TS[dayStart.get(tday)]).getUTCFullYear();

const { out, diag } = setups(CFG);
const tr = out.map((s) => ({ ...resolve(s, OPT), risk: s.risk, width: s.width }));

const byYear = new Map();
for (const t of tr) {
  const y = yearOf(t.tday);
  if (!byYear.has(y)) byYear.set(y, []);
  byYear.get(y).push(t);
}

const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * a.length)];
const sum = (a) => a.reduce((x, y) => x + y, 0);

console.log("\n" + "=".repeat(104));
console.log("ORB TRADE SHAPE BY YEAR — the stop is the level spread, so it tracks volatility");
console.log("=".repeat(104));
console.log("\n  year   trades   stop pts (p25/p50/p75/p95)      lots (p25/p50/p75)   1-lot%   $/trade      net");
for (const [y, rows] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
  const r = rows.map((x) => x.risk), l = rows.map((x) => x.lots);
  const ones = 100 * l.filter((x) => x === 1).length / l.length;
  console.log("  " + y + String(rows.length).padStart(9) +
    (q(r, .25).toFixed(1) + " / " + q(r, .5).toFixed(1) + " / " +
     q(r, .75).toFixed(1) + " / " + q(r, .95).toFixed(1)).padStart(30) +
    (q(l, .25) + " / " + q(l, .5) + " / " + q(l, .75)).padStart(22) +
    ones.toFixed(1).padStart(8) + "%" +
    ("$" + (sum(rows.map((x) => x.pnl)) / rows.length).toFixed(2)).padStart(10) +
    ("$" + Math.round(sum(rows.map((x) => x.pnl))).toLocaleString()).padStart(11));
}

console.log("\n" + "=".repeat(104));
console.log("WHERE THE 2026-08-19 ARM SITS — 232.25 pts, 1 lot");
console.log("=".repeat(104));
console.log("\n  reference set          trades   percentile of a 232.25 pt stop   median stop");
const y26 = byYear.get(2026) || [];
for (const [label, rows] of [["all years", tr], ["2026 only", y26]]) {
  const r = rows.map((x) => x.risk);
  const pct = 100 * r.filter((x) => x < 232.25).length / r.length;
  console.log("  " + label.padEnd(22) + String(rows.length).padStart(6) +
    (pct.toFixed(1) + "%").padStart(33) + q(r, .5).toFixed(1).padStart(14) + " pts");
}

// How the exits split, per year -- does the bracket bind more now?
console.log("\n" + "=".repeat(104));
console.log("HOW TRADES END, BY YEAR");
console.log("=".repeat(104));
console.log("\n  year     TIME%     SL%     TP%   win%   median favourable 5-min excursion");
for (const [y, rows] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
  const p = (w) => 100 * rows.filter((r) => r.why === w).length / rows.length;
  console.log("  " + y + p("TIME").toFixed(1).padStart(9) + p("SL").toFixed(1).padStart(8) +
    p("TP").toFixed(1).padStart(8) +
    (100 * rows.filter((r) => r.pnl > 0).length / rows.length).toFixed(1).padStart(7));
}
console.log("\n  days examined " + diag.days + ", days with a level " + diag.nLevel +
            ", days armed " + tr.length);
