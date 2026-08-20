// The transcript's strategy with the abandon rule fixed.
//
// "break" on a failed setup ended the session. The video's own example needs
// the opposite: the long off the upper level fails, and the SHORT off the lower
// level later that morning is the trade he takes and books. Letting the hunt
// restart takes the book from 538 trades to 1031 -- 507 days were losing their
// shot to the first failure.
//
// Two more readings of the source are swept here rather than assumed:
//   retraceFrac  "just some sort of retrace for at least like 5 seconds" reads
//                much shallower than a third of the push
//   maxPerDay    he takes one trade, but the day plainly offered two setups
//
//   node research/orb_transcript_v2.mjs

import { setups, resolve, dayStart, TS } from "./lib_orb.mjs";

const L = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08,
            minTouch: 3, giveUpCt: 570, riskDollars: 500, maxLots: 50 };
const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const sum = (a) => a.reduce((x, y) => x + y, 0);
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * a.length)];

function build(cfg) {
  const { out } = setups(cfg);
  return out.map((s) => resolve(s, { rMult: cfg.rMult ?? 3,
    maxHoldMin: cfg.maxHoldMin ?? 5, riskDollars: cfg.riskDollars,
    maxLots: cfg.maxLots }));
}
function row(label, cfg) {
  const t = build(cfg);
  const mod = t.filter((x) => yearOf(x.tday) >= 2024);
  const pt = (r) => (r.length ? sum(r.map((x) => x.pnl)) / r.length : 0);
  console.log("  " + label.padEnd(38) + String(t.length).padStart(7) +
    q(t.map((x) => x.risk), .5).toFixed(1).padStart(9) +
    q(t.map((x) => x.lots), .5).toString().padStart(8) +
    (100 * t.filter((x) => x.pnl > 0).length / t.length).toFixed(1).padStart(7) +
    ("$" + pt(t).toFixed(0)).padStart(10) +
    ("$" + Math.round(sum(t.map((x) => x.pnl))).toLocaleString()).padStart(12) +
    ("$" + pt(mod).toFixed(0) + " (" + mod.length + ")").padStart(14));
  return t;
}

console.log("\n" + "=".repeat(114));
console.log("TRANSCRIPT STRATEGY, ABANDON RULE FIXED");
console.log("=".repeat(114));
console.log("\n  variant                              trades  med stop med lots   win%   $/trade" +
            "         net   2024-26 $/tr");
row("SHIPPED  plain, opposite stop, 3R",
    { ...L, mode: "plain", stopAt: "opposite", rMult: 3, maxHoldMin: 5, maxPerDay: 1 });
row("transcript, abandon=break (before)",
    { ...L, mode: "confirmed", stopAt: "level", rMult: 3, maxHoldMin: 5, maxPerDay: 1 });
row("transcript, abandon=reset",
    { ...L, mode: "confirmed", stopAt: "level", rMult: 3, maxHoldMin: 5,
      maxPerDay: 1, abandon: "reset" });
console.log("");
for (const retraceFrac of [0.1, 0.2, 0.33, 0.5]) {
  row("  retrace " + retraceFrac + " of the push",
      { ...L, mode: "confirmed", stopAt: "level", rMult: 3, maxHoldMin: 5,
        maxPerDay: 1, abandon: "reset", retraceFrac });
}
console.log("");
for (const maxPerDay of [1, 2, 3]) {
  row("  up to " + maxPerDay + " trade(s) a day",
      { ...L, mode: "confirmed", stopAt: "level", rMult: 3, maxHoldMin: 5,
        maxPerDay, abandon: "reset", retraceFrac: 0.2 });
}
console.log("");
for (const [tpMode, lbl] of [["R", "3R"], ["liqNear", "nearest liquidity"],
                             ["liqBest", "most-tapped liquidity"],
                             ["windowExt", "opposite level"]]) {
  row("  target: " + lbl,
      { ...L, mode: "confirmed", stopAt: "level", rMult: 3, maxHoldMin: 5,
        maxPerDay: 1, abandon: "reset", retraceFrac: 0.2, tpMode });
}
console.log("");
for (const maxHoldMin of [2, 3, 5, 10]) {
  row("  hold " + maxHoldMin + " min",
      { ...L, mode: "confirmed", stopAt: "level", rMult: 3, maxHoldMin,
        maxPerDay: 1, abandon: "reset", retraceFrac: 0.2 });
}
