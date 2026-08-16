// Round 7 -- verify the tap-counted level, because it is the first thing in
// this investigation that beat its own null.
//
// Best config from the round-6 sweep scored 32.9% on its worse half against
// 17.7% for the best direction-shuffled config: a 15.3pp gap, where the
// range-extreme version had exactly zero. That is worth a real battery.
//
// The decisive test is not direction shuffling. It is SHUFFLING THE LEVELS
// between days: same days, same window, same distance, same stop size, but the
// level's inset borrowed from another day. Everything survives except the one
// claim being made -- that this particular price matters because price kept
// turning there.
//
// Usage:  node research/orb_touch_verify.mjs
//         ORB_BIN=data/mes_1m.bin ORB_PV=5 node research/orb_touch_verify.mjs

import { run, stat, passOf, HDR, row, ALL, H1, H2, RECENT, inSet, PV } from "./lib_orb.mjs";

const WIN = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
              mode: "plain", stopAt: "opposite", rMult: 3.0, maxHoldMin: 1000,
              retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500 };

console.log("\n" + "=".repeat(124));
console.log("ROUND 7 -- VERIFYING THE TAP-COUNTED LEVEL" + (PV === 5 ? "   [MES, $5/pt]" : "   [MNQ, $2/pt]"));
console.log("=".repeat(124));

console.log("\n-- (1) THE DECISIVE CONTROL: shuffle the LEVELS between days --");
console.log("   identical days, identical geometry; only 'this price was tapped' is destroyed");
console.log(HDR);
row("tap-counted levels (real)", run(WIN));
for (const s of [5, 11, 23, 42, 77]) row("  levels shuffled, seed " + s, run({ ...WIN, levelMode: "touchShuffled", levelSeed: s }));
row("  direction shuffled", run({ ...WIN, flipSeed: 99 }));

console.log("\n-- (2) boundary check: PRE120 was the widest window in the grid. Does it peak or keep climbing? --");
console.log(HDR);
for (const refWin of ["PRE60", "PRE90", "PRE120", "PRE150", "PRE180"]) {
  const r = run({ ...WIN, refWin });
  row(refWin + " (real)", r);
  row("  " + refWin + " levels shuffled", run({ ...WIN, refWin, levelMode: "touchShuffled" }));
}

console.log("\n-- (3) cost sensitivity --");
console.log(HDR);
for (const cm of [1, 1.5, 2, 3]) row("costs x" + cm, run({ ...WIN, costMult: cm }));

console.log("\n-- (4) does it work in both directions, or is it long-only drift? --");
const t = run(WIN).trades;
for (const d of [1, -1]) {
  const sub = t.filter(x => x.dir === d);
  const st = stat(sub);
  console.log("  " + (d === 1 ? "LONG " : "SHORT") + "  n=" + String(st.n).padStart(4) +
    "  win " + st.win.toFixed(1) + "%  pf " + st.pf.toFixed(3) +
    "  $/trade " + st.exp.toFixed(2).padStart(8) +
    "  net $" + Math.round(st.net).toLocaleString());
}

console.log("\n-- (5) walk-forward: choose on the FIRST half only, then read the second --");
const GRID = [];
for (const refWin of ["PRE60", "PRE90", "PRE120", "PRE150"])
for (const pivotK of [2, 3])
for (const tolFrac of [0.05, 0.08, 0.15])
for (const minTouch of [3, 4])
for (const mode of ["confirmed", "plain"])
for (const [stopAt, stopK] of [["range", 0.5], ["range", 1.0], ["opposite", 0]])
for (const rMult of [1.5, 2.0, 3.0])
for (const maxHoldMin of [120, 1000])
  GRID.push({ ...WIN, refWin, pivotK, tolFrac, minTouch, mode, stopAt, stopK, rMult, maxHoldMin });

const sc = (c, lm) => {
  const r = run(lm ? { ...c, levelMode: lm } : c);
  if (r.trades.length < 200) return null;
  return { c, p1: passOf(inSet(r.trades, H1), H1), p2: passOf(inSet(r.trades, H2), H2),
           n: r.trades.length, exp: stat(r.trades).exp };
};
const real = [], shuf = [];
for (const c of GRID) { const a = sc(c, null); if (a) real.push(a);
                        const b = sc(c, "touchShuffled"); if (b) shuf.push(b); }
const topR = real.slice().sort((a, b) => b.p1 - a.p1).slice(0, 10);
const topS = shuf.slice().sort((a, b) => b.p1 - a.p1).slice(0, 10);
const avg = (a, k) => a.reduce((x, y) => x + y[k], 0) / a.length;
console.log("  configs evaluated: " + real.length);
console.log("  REAL     top-10 by 1st half:  1stH " + avg(topR, "p1").toFixed(1) +
            "%  ->  held-out 2ndH " + avg(topR, "p2").toFixed(1) + "%");
console.log("  SHUFFLED top-10 by 1st half:  1stH " + avg(topS, "p1").toFixed(1) +
            "%  ->  held-out 2ndH " + avg(topS, "p2").toFixed(1) + "%");
console.log("  gap on the HELD-OUT half:     " + (avg(topR, "p2") - avg(topS, "p2")).toFixed(1) + "pp");
console.log("  whole-grid mean:  real 2ndH " + avg(real, "p2").toFixed(1) +
            "%   shuffled 2ndH " + avg(shuf, "p2").toFixed(1) + "%");
console.log("  whole-grid mean $/trade:  real $" + avg(real, "exp").toFixed(2) +
            "   shuffled $" + avg(shuf, "exp").toFixed(2));
