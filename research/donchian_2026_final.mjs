// The 2026 answer: which changes survive being CHOSEN on one part of 2026 and
// READ on the other, and what they add up to. Weighted to 2026 above every
// other year, as asked -- a change counts if it helps 2026, whatever it does
// elsewhere.
//
// Why this test: 2026 is 139 days, one day moves its pass rate ~3.5pp, and
// random rules reach +15-21pp there by luck. The 872 mined pattern rules
// (donchian_patterns.mjs) FAIL it -- the best picked on Jan-Mar is 5-10pp worse
// than the live book on Apr-Jul. Picking within a family of settings on one
// half and reading the other half is the check that separates a real 2026
// behaviour from a fitted one.
//
// RESULT. Three families pass it; the time exit alone does not:
//   day's range already >= ~0.9x its 10-day average (skip or half size)
//                                  Jan-Mar pick -> Apr-Jul +9.0 / +17.0
//                                  Apr-Jul pick -> Jan-Mar +10.4 / +4.4
//   7 lots instead of 8            best in BOTH halves: +12.8 / +8.8
//   7 lots + out if not +1 ATR by 20 bars   -> +14.9 / +10.9
//   the 20-bar exit on 8 lots      -> -0.1 / -5.3 (fails)
// Stacked -- 7 lots, out if not +1 ATR by 20 bars, and 4 lots (or skip) once
// the day's range reaches 0.9x ADR -- 2026 goes 34.5% -> 54.4% (half) / 56.1%
// (skip): better in both halves, in 6 of 7 months, and still +9.7 / +13.1 with
// its best three days put back. The cost is the other years: 2025 -9.3 / -13.5,
// all years -5.9 / -7.1. The mechanism for each is plausible: 2026's ATR (~26)
// makes the $1,000 cap the stop at 8 lots (62.5 pts, ~2.4 ATR), 7 lots widens it
// to 71 pts; the wider stop lets dead trades linger, which the 20-bar exit
// trims; and a breakout taken after the day has already covered its usual
// range has little left to run.
//
//   node --max-old-space-size=8192 research/donchian_2026_final.mjs

import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const { tf } = M;
const { ts: TS } = tf;
const { adrUsed } = M;

const live = M.evalCfg(M.LIVE);
const at = (arr, ix) => S.passArr(ix.map((k) => arr[k]));
const sg = (x) => ((x >= 0 ? "+" : "") + x.toFixed(1)).padStart(6);
const run = (cfg, sizer) => (sizer ? M.evalOpts(M.build(cfg), sizer) : M.evalCfg(cfg));

console.log("\n  Live: 2026 " + live.y26.toFixed(1) + "% (Jan-Mar " + live.a26.toFixed(1) + ", Apr-Jul " + live.b26.toFixed(1) +
  "), 2025 " + live.y25.toFixed(1) + "%, all years " + live.all.toFixed(1) + "%");

// ---- 1. pick on one half of 2026, read the other ---------------------------------------
console.log("\n  1. EACH FAMILY: pick the best setting on one half of 2026, read it on the other half");
const fams = {
  "day's range, skip": [0.7, 0.8, 0.9, 1.0, 1.1, 1.25].map((x) => ["skip >= " + x + " ADR", run(M.LIVE, (a, c, s, arm) => (adrUsed(arm - 1) >= x ? 0 : 8))]),
  "day's range, half size": [0.7, 0.8, 0.9, 1.0, 1.1, 1.25].map((x) => ["half >= " + x + " ADR", run(M.LIVE, (a, c, s, arm) => (adrUsed(arm - 1) >= x ? 4 : 8))]),
  "lots": [5, 6, 7, 9, 10].map((l) => [l + " lots", run({ ...M.LIVE, lots: l })]),
  "time exit on 8 lots": [[10, 0.5], [10, 1], [20, 0.5], [20, 1], [30, 0.5], [30, 1]].map(([n, y]) => ["not +" + y + " ATR by " + n, run({ ...M.LIVE, tx: ["nr", n, y] })]),
  "7 lots + time exit": [[10, 1], [20, 0.5], [20, 1], [30, 1]].map(([n, y]) => ["7 lots, not +" + y + " by " + n, run({ ...M.LIVE, lots: 7, tx: ["nr", n, y] })]),
};
for (const [fam, rows] of Object.entries(fams)) {
  const bA = rows.reduce((a, x) => (x[1].a26 > a[1].a26 ? x : a)), bB = rows.reduce((a, x) => (x[1].b26 > a[1].b26 ? x : a));
  console.log("    " + fam.padEnd(24) + "picked on Jan-Mar: " + bA[0].padEnd(22) + "-> Apr-Jul" + sg(bA[1].b26 - live.b26) +
    "     picked on Apr-Jul: " + bB[0].padEnd(22) + "-> Jan-Mar" + sg(bB[1].a26 - live.a26));
}

// ---- 2. stacked ---------------------------------------------------------------------------
console.log("\n  2. STACKED\n");
console.log("  " + "".padEnd(52) + "  2026  d2026 JanMar AprJul best3back months+   d2025   dAll  2026 trades");
const j3 = (r) => {
  const b = M.Y26.map((k) => [k, r.arr[k] - live.arr[k]]).filter(([, v]) => v > 0).sort((a, c) => c[1] - a[1]).slice(0, 3);
  const a = Float64Array.from(r.arr); for (const [k] of b) a[k] = live.arr[k]; return at(a, M.Y26) - live.y26;
};
const mk = (d) => { const t = new Date(TS[S.dayFirstBar.get(d)] + 43200e3); return t.getUTCFullYear() * 100 + t.getUTCMonth() + 1; };
const D = { ...M.LIVE, lots: 7, tx: ["nr", 20, 1] };
for (const [nm, cfg, sz] of [
  ["live", M.LIVE, null],
  ["A  half size once range >= 0.9 ADR", M.LIVE, (a, c, s, arm) => (adrUsed(arm - 1) >= 0.9 ? 4 : 8)],
  ["B  skip once range >= 0.9 ADR", M.LIVE, (a, c, s, arm) => (adrUsed(arm - 1) >= 0.9 ? 0 : 8)],
  ["C  7 lots", { ...M.LIVE, lots: 7 }, null],
  ["D  7 lots + out if not +1 ATR by 20 bars", D, null],
  ["A+D  D, 4 lots once range >= 0.9 ADR", D, (a, c, s, arm) => (adrUsed(arm - 1) >= 0.9 ? 4 : 7)],
  ["B+D  D, skip once range >= 0.9 ADR", D, (a, c, s, arm) => (adrUsed(arm - 1) >= 0.9 ? 0 : 7)],
  ["B+D  at 0.8 ADR", D, (a, c, s, arm) => (adrUsed(arm - 1) >= 0.8 ? 0 : 7)],
  ["B+D  at 1.0 ADR", D, (a, c, s, arm) => (adrUsed(arm - 1) >= 1.0 ? 0 : 7)],
  ["A+D  at 0.8 ADR", D, (a, c, s, arm) => (adrUsed(arm - 1) >= 0.8 ? 4 : 7)],
  ["A+D  at 1.0 ADR", D, (a, c, s, arm) => (adrUsed(arm - 1) >= 1.0 ? 4 : 7)],
]) {
  const r = run(cfg, sz);
  const diff = new Map(); M.days.forEach((d, k) => { const m = mk(d); if (m >= 202601) diff.set(m, (diff.get(m) || 0) + r.arr[k] - live.arr[k]); });
  const up = [...diff.values()].filter((v) => v > 0).length;
  const n26 = r.tr.filter((t) => S.yearOf.get(t.tday) === 2026).length;
  console.log("  " + nm.padEnd(52) + r.y26.toFixed(1).padStart(6) + sg(r.y26 - live.y26) + sg(r.a26 - live.a26) + sg(r.b26 - live.b26) +
    sg(j3(r)).padStart(10) + (up + "/7").padStart(8) + sg(r.y25 - live.y25).padStart(8) + sg(r.all - live.all) + String(n26).padStart(12));
}
