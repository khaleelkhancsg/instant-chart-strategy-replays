// Tighten a too-wide ORB bracket instead of living with it.
//
// The stop is the distance to the OPPOSITE level, so on a day where the two
// levels are far apart the trade gets a huge stop and a 3R target three times
// further away again. Neither is reachable inside a five-minute hold, and the
// book is a momentum trade -- so the wide-bracket days are the ones where the
// position sits through a fading move instead of being taken out of it.
//
// This caps the stop AFTER the structural distance is worked out. It is not
// stopAt:"fixed", which discards the structure on every day; the level-derived
// stop survives wherever it is already tight, and only the wide days clamp. The
// target follows, since it is rMult x the stop. And because size is $500/stop,
// clamping also RAISES the position on exactly those days.
//
// Asked for on 2026 data, which is 66 trades. That is enough to see a big
// effect and nowhere near enough to rank nine of them, so 2025-26 and the full
// history are shown alongside -- a finding that only exists in the smallest
// column is a finding about the sample size.
//
//   node research/orb_stop_cap.mjs

import { setups, resolve, dayStart, TS } from "./lib_orb.mjs";

const BASE = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08,
               minTouch: 3, mode: "plain", stopAt: "opposite", rMult: 3.0,
               maxHoldMin: 5, giveUpCt: 570, riskDollars: 500, maxLots: 50,
               maxPerDay: 1 };
const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const sum = (a) => a.reduce((x, y) => x + y, 0);

function book(cfg) {
  return setups(cfg).out.map((s) => ({
    ...resolve(s, { rMult: cfg.rMult, maxHoldMin: cfg.maxHoldMin,
                    riskDollars: cfg.riskDollars, maxLots: cfg.maxLots }),
    year: yearOf(s.day), risk: s.risk }));
}
const st = (rows) => {
  if (!rows.length) return null;
  const p = (w) => 100 * rows.filter((r) => r.why === w).length / rows.length;
  return { n: rows.length,
           win: 100 * rows.filter((r) => r.pnl > 0).length / rows.length,
           sl: p("SL"), tp: p("TP"), time: p("TIME"),
           lots: sum(rows.map((r) => r.lots)) / rows.length,
           per: sum(rows.map((r) => r.pnl)) / rows.length,
           net: sum(rows.map((r) => r.pnl)) };
};
const WINDOWS = [[2026, "2026 only"], [2025, "2025-26"], [2019, "all years"]];

console.log("\n" + "=".repeat(104));
console.log("CAPPING THE ORB STOP — 2026 first, because that is the regime being traded");
console.log("=".repeat(104));

for (const [fy, label] of WINDOWS) {
  console.log("\n  " + label);
  console.log("  cap        trades  avg lots   win%    SL%    TP%   TIME%    $/trade        net");
  for (const cap of [10, 15, 20, 25, 30, 40, 50, 75, Infinity]) {
    const cfg = cap === Infinity ? BASE : { ...BASE, stopCapPts: cap };
    const r = st(book(cfg).filter((x) => x.year >= fy));
    if (!r) continue;
    console.log("  " + (cap === Infinity ? "none" : cap + " pts").padEnd(11) +
      String(r.n).padStart(6) + r.lots.toFixed(1).padStart(10) +
      r.win.toFixed(1).padStart(7) + r.sl.toFixed(1).padStart(7) +
      r.tp.toFixed(1).padStart(7) + r.time.toFixed(1).padStart(8) +
      ("$" + r.per.toFixed(0)).padStart(11) +
      ("$" + Math.round(r.net).toLocaleString()).padStart(11) +
      (cap === Infinity ? "   <- shipped" : ""));
  }
}

// The shipped answer to a wide day is to SKIP it. Capping trades it instead.
console.log("\n" + "=".repeat(104));
console.log("SKIP THE WIDE DAYS, OR TRADE THEM TIGHTENED?");
console.log("=".repeat(104));
console.log("\n  variant                        " +
  WINDOWS.map(([, l]) => (l + " $/tr").padStart(18)).join(""));
const VARIANTS = [
  ["ungated, uncapped", {}],
  ["SHIPPED  skip width > 31", { maxWidthPts: 31 }],
  ["cap 30, keep every day", { stopCapPts: 30 }],
  ["cap 20, keep every day", { stopCapPts: 20 }],
  ["skip > 31 AND cap 30", { maxWidthPts: 31, stopCapPts: 30 }],
  ["skip > 60, cap 30", { maxWidthPts: 60, stopCapPts: 30 }],
];
for (const [label, over] of VARIANTS) {
  let line = "  " + label.padEnd(31);
  for (const [fy] of WINDOWS) {
    const r = st(book({ ...BASE, ...over }).filter((x) => x.year >= fy));
    line += (r ? "$" + r.per.toFixed(0) + " (" + r.n + ")" : "-").padStart(18);
  }
  console.log(line);
}
console.log("\n  ($/trade with the trade count in brackets — a cap keeps days the width");
console.log("   guard throws away, so the counts are not comparable on their own.)");
