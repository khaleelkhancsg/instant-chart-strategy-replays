// ">= 8 lots" was the tightest guard tested and it won, which means the grid
// edge was the answer -- always a warning that the real optimum is outside it.
// Pushed far enough the guard becomes "never trade the ORB", and ORB off is
// just the donchian book at 34.4%, so the curve has to turn over. This finds
// where.
//
//   node research/orb_minsize_shape.mjs

import { simulate, days, pass21, ORB_CFG } from "./joint_account.mjs";
import { setups, dayStart, TS } from "./lib_orb.mjs";

const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const i24 = days.findIndex((d) => yearOf(d) >= 2024);
const n = days.length, mid = i24 + Math.floor((n - i24) / 2);

console.log("\n" + "=".repeat(94));
console.log("MINIMUM-SIZE GUARD — full shape, including past the old grid edge");
console.log("=".repeat(94));
console.log("\n  guard        width    ORB trades   all years   2024-26   1st half   2nd half     $/day");
const rows = [];
for (const [lots, w] of [[0, Infinity], [2, 125], [3, 83], [4, 62], [5, 50],
                         [8, 31], [10, 25], [12, 20], [16, 15], [20, 12], [25, 10]]) {
  const orbCfg = w === Infinity ? ORB_CFG : { ...ORB_CFG, maxWidthPts: w };
  const nTr = setups(orbCfg).out.length;
  const r = simulate("both", { exclusive: true, donLots: 8, orbCfg });
  const rec = { lots, w, nTr,
    all: pass21(r.arr), m24: pass21(r.arr.slice(i24)),
    h1: pass21(r.arr.slice(i24, mid)), h2: pass21(r.arr.slice(mid)),
    perDay: r.arr.reduce((a, b) => a + b, 0) / r.arr.length };
  rows.push(rec);
  console.log("  " + (lots === 0 ? "none" : ">= " + lots + " lots").padEnd(13) +
    (w === Infinity ? "-" : String(w)).padStart(5) +
    String(nTr).padStart(14) + (rec.all.toFixed(1) + "%").padStart(12) +
    (rec.m24.toFixed(1) + "%").padStart(10) + (rec.h1.toFixed(1) + "%").padStart(11) +
    (rec.h2.toFixed(1) + "%").padStart(11) +
    ("$" + rec.perDay.toFixed(2)).padStart(10));
}

const base = rows[0];
const peak = rows.slice().sort((a, b) => b.all - a.all)[0];
const peak24 = rows.slice().sort((a, b) => b.m24 - a.m24)[0];
console.log("\n  peak on all years : >= " + peak.lots + " lots  (" + peak.all.toFixed(1) +
            "% vs " + base.all.toFixed(1) + "% ungated)");
console.log("  peak on 2024-26   : >= " + peak24.lots + " lots  (" + peak24.m24.toFixed(1) +
            "% vs " + base.m24.toFixed(1) + "% ungated)");
console.log("\n  donchian alone is 34.4%, so the curve must fall back to that as the");
console.log("  guard tightens toward 'never trade the ORB'. A peak in the middle of");
console.log("  the range is a real trade-off; a peak still at the edge is not.");
