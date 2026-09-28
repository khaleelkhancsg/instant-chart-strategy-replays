// Stage 4: is a 2026 improvement a real change in behaviour, or a few days?
//
// Weighted to 2026 above everything else, as asked: a candidate counts if it
// helps 2026, whatever it does in other years. But 2026 is 139 trading days,
// and on the live book one day's swing moves its pass rate ~3.5pp
// (donchian_entry_additions.mjs: a +3.5pp "gain" there was one trade on
// 2026-05-18). So every candidate is checked INSIDE 2026:
//
//   HALVES     better in January-March AND in April-July
//   JACKKNIFE  its best 1, 2, 3, 5 days of 2026 put back to what the live book
//              did -- does it still beat the live book?
//   PLATEAU    each setting moved one notch either way: do the neighbours also
//              beat the live book in 2026?
//
// Candidates: the top of stage 2's random search by 2026 and the settings
// stage 1 ranked highest in 2026. 2025 and the full history are printed for
// context only. Reads research/donchian_joint_search_results.json, which is
// not versioned (10 MB): run donchian_joint_search.mjs first.
//
// RESULT: stage 2's 2026 leaders all share two things -- 6-7 lots instead of
// 8, and a 20-bar (40-minute) "not working" exit -- and they pass every check
// here (+14 to +17.6 in 2026, both halves, +4 to +7 with the best three days
// put back, 11-19 of their one-notch neighbours also better) at a cost of -8 to
// -22pp in 2025. But these checks are weak evidence for configs that were
// SELECTED on the whole of 2026 out of 30,000; donchian_2026_final.mjs does
// the stronger test (pick on one half of 2026, read the other).
//
//   node --max-old-space-size=8192 research/donchian_robustness.mjs

import fs from "node:fs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const live = M.evalCfg(M.LIVE);
const at = (arr, ix) => S.passArr(ix.map((k) => arr[k]));
const sg = (x) => ((x >= 0 ? "+" : "") + x.toFixed(1)).padStart(6);

function jack(r) {
  const d = M.Y26.map((k) => [k, r.arr[k] - live.arr[k]]);
  const changed = d.filter(([, v]) => Math.abs(v) > 0.005).length;
  const best = d.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const row = [];
  for (const K of [1, 2, 3, 5]) {
    const a = Float64Array.from(r.arr);
    for (const [k] of best.slice(0, K)) a[k] = live.arr[k];
    row.push(at(a, M.Y26) - live.y26);
  }
  return { changed, row };
}
const STEPS = { sl: [3, 4, 5, 6, 8], tp: [1.25, 1.5, 1.75, 2, 2.25, 2.5, 3], trig: [0.1, 0.15, 0.2, 0.3],
                lots: [6, 7, 8, 9, 10], br: [300, 400, 500, 650, 800, 0], pb: [500, 750, 1000, 1500, 0] };
function neighbours(c) {
  const out = [];
  const bump = (arr, v, dir) => { const i = arr.indexOf(v); return i < 0 ? null : arr[i + dir] ?? null; };
  for (const [k, arr] of Object.entries(STEPS))
    for (const dir of [-1, 1]) { const v = bump(arr, c[k], dir); if (v !== null) out.push({ ...c, [k]: v }); }
  if (c.st) {
    const [t, a, b] = c.st;
    const sa = t === "be" ? 0.25 : t === "ch" ? 0.5 : t === "sb" ? null : 5;
    for (const dir of [-1, 1]) {
      if (sa !== null && a + dir * sa >= 0) out.push({ ...c, st: [t, +(a + dir * sa).toFixed(2), b] });
      if (b + dir * 0.5 >= (t === "be" ? -1 : 0)) out.push({ ...c, st: [t, a, +(b + dir * 0.5).toFixed(2)] });
    }
    out.push({ ...c, st: undefined });
  }
  if (c.tx) {
    const [t, a, b] = c.tx;
    for (const dir of [-1, 1]) if (a + dir * 10 > 0) out.push({ ...c, tx: [t, a + dir * 10, b] });
    out.push({ ...c, tx: undefined });
  }
  if (c.ex) { const [si, ci, g] = c.ex; out.push({ ...c, ex: [si, ci, g ? 0 : 3] }); out.push({ ...c, ex: undefined }); }
  return out;
}
const out = [];
function report(label, c, { lotsFn = null, nb = true } = {}) {
  const r = lotsFn ? M.evalOpts(M.build(c), lotsFn) : M.evalCfg(c);
  const j = jack(r);
  const halves = r.a26 >= live.a26 && r.b26 >= live.b26;
  let okN = null, nN = 0;
  let line2 = "";
  if (nb && !lotsFn) {
    const ns = neighbours(c).map((x) => M.evalCfg(x));
    nN = ns.length; okN = ns.filter((x) => x.y26 > live.y26).length;
    line2 = "    plateau: " + okN + " of " + nN + " one-notch neighbours also beat live in 2026 (their mean change " +
      sg(ns.reduce((a, x) => a + x.y26 - live.y26, 0) / nN).trim() + ")";
  }
  console.log("\n  " + label);
  console.log("    2026 " + r.y26.toFixed(1) + sg(r.y26 - live.y26) + "   Jan-Mar " + sg(r.a26 - live.a26).trim() + "  Apr-Jul " +
    sg(r.b26 - live.b26).trim() + "   | context: 2025 " + sg(r.y25 - live.y25).trim() + ", all years " + sg(r.all - live.all).trim());
  console.log("    changes " + j.changed + " of 139 days in 2026; with its best 1/2/3/5 days put back:" + j.row.map(sg).join(""));
  if (line2) console.log(line2);
  const o = { label, d26: r.y26 - live.y26, j3: j.row[2], halves, okN, nN };
  out.push(o);
  return o;
}

console.log("\n" + "=".repeat(118));
console.log("STAGE 4 -- robustness inside 2026.  Live: 2026 " + live.y26.toFixed(1) + "% (Jan-Mar " + live.a26.toFixed(1) +
  ", Apr-Jul " + live.b26.toFixed(1) + "); 2025 " + live.y25.toFixed(1) + "%; all " + live.all.toFixed(1) + "%");
console.log("=".repeat(118));

// ---- stage 1's 2026 leaders: fewer lots ---------------------------------------------
for (const lots of [7, 6]) report("[stage 1] " + lots + " lots (everything else live)", { ...M.LIVE, lots });
report("[stage 1] chandelier trail 4 ATR once +1 ATR", { ...M.LIVE, st: ["ch", 1, 4] });
// ---- stage 2's leaders by 2026 -------------------------------------------------------
const J = JSON.parse(fs.readFileSync(new URL("./donchian_joint_search_results.json", import.meta.url)));
const top = J.res.slice().sort((a, b) => b.y26 - a.y26).slice(0, 12);
for (const r of top) {
  const o = report("[stage 2] " + r.name, r.c);
  if (Math.abs(o.d26 + live.y26 - r.y26) > 0.05) console.log("    !! does not reproduce stage 2's 2026 score of " + r.y26.toFixed(1));
}

console.log("\n" + "=".repeat(118));
console.log("VERDICT -- better in 2026, in BOTH halves of it, still better with its best 3 days put back,");
console.log("and (where it has settings) most one-notch neighbours better in 2026 too");
console.log("=".repeat(118));
const keep = out.filter((o) => o.d26 > 0 && o.halves && o.j3 > 0 && (o.okN === null || o.okN >= o.nN / 2));
if (!keep.length) console.log("\n  none.");
for (const o of keep.sort((a, b) => b.j3 - a.j3))
  console.log("  2026 " + sg(o.d26) + ", best-3-back " + sg(o.j3) + "   " + o.label + (o.okN !== null ? "   (" + o.okN + "/" + o.nN + " neighbours)" : ""));
