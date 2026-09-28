// How BROAD is each 2026 candidate's gain? Month by month through 2026 in
// dollars against the live book, and year by year in pass rate.
//
// A pass rate over 139 days can be moved by a single day, and selection
// checks inside 2026 (pick on Jan-Mar, read Apr-Jul) came back negative for
// the mined pattern rules. What is left to ask of a candidate is whether its
// gain is spread across the months, the way a real change in behaviour would
// be, or sits in one or two of them.
//
// RESULT: June 2026 carries most of every candidate's gain (skip at 0.9 x ADR
// +$5,293 of +$8,447; 7 lots +$4,043 of +$6,757; 3+ stretch flags +$7,212 of
// +$10,411), though most gain in 5 of the 7 months. Year by year they are
// negative in most other years; the 20-bar "not +1 ATR" exit is -$484 over
// 2026 on its own and only helps paired with 7 lots.
//
//   node --max-old-space-size=8192 research/donchian_2026_breadth.mjs

import { atr, ema, stochastic } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const { tf } = M;
const { high: H, low: L, close: C, volume: V, ctMin: CT, tday: TD, ts: TS } = tf;
const n2 = C.length;
const A = atr(H, L, C, 14), E20 = ema(C, 20), STK = stochastic(H, L, C, 14, 3).k;

// the day's RTH range so far against its 10-day average (the "ADR used")
const rthHi = new Float64Array(n2).fill(NaN), rthLo = new Float64Array(n2).fill(NaN), VW = new Float64Array(n2).fill(NaN);
const dayRange = new Map();
{
  let day = -1, h = -Infinity, l = Infinity, pv = 0, vv = 0;
  for (let i = 0; i < n2; i++) {
    if (TD[i] !== day) { if (day !== -1 && h > l) dayRange.set(day, h - l); day = TD[i]; h = -Infinity; l = Infinity; pv = 0; vv = 0; }
    if (CT[i] >= 510 && CT[i] < 900) {
      if (H[i] > h) h = H[i]; if (L[i] < l) l = L[i];
      const tp = (H[i] + L[i] + C[i]) / 3; pv += tp * V[i]; vv += V[i];
      rthHi[i] = h; rthLo[i] = l; VW[i] = vv > 0 ? pv / vv : tp;
    }
  }
  if (h > l) dayRange.set(day, h - l);
}
const dk = [...new Set(TD)], adr = new Map();
for (let j = 1; j < dk.length; j++) {
  const r = dk.slice(Math.max(0, j - 10), j).map((d) => dayRange.get(d)).filter((x) => x > 0);
  if (r.length) adr.set(dk[j], r.reduce((a, b) => a + b, 0) / r.length);
}
const used = (k) => { const a = adr.get(TD[k]); return a ? (rthHi[k] - rthLo[k]) / a : 0; };
const d = (k) => M.RESC[k];
const flags = (k) => (used(k) >= 0.9) + ((C[k] - VW[k]) * d(k) / A[k] >= 5) + ((C[k] - E20[k]) * d(k) / A[k] >= 3) +
  ((d(k) === 1 ? STK[k] : 100 - STK[k]) >= 98.5) +
  ((H[k] > L[k] ? (d(k) === 1 ? C[k] - L[k] : H[k] - C[k]) / (H[k] - L[k]) : 0.5) >= 0.94);

const CAND = [
  ["half size once the day's range >= 0.9 x ADR", M.LIVE, (a, ct, s, arm) => (used(arm - 1) >= 0.9 ? 4 : 8)],
  ["skip once the day's range >= 0.9 x ADR", M.LIVE, (a, ct, s, arm) => (used(arm - 1) >= 0.9 ? 0 : 8)],
  ["skip when 3+ stretch flags", M.LIVE, (a, ct, s, arm) => (flags(arm - 1) >= 3 ? 0 : 8)],
  ["7 lots", { ...M.LIVE, lots: 7 }, null],
  ["out if not +1 ATR by 20 bars (else live)", { ...M.LIVE, tx: ["nr", 20, 1] }, null],
  ["7 lots + out if not +1 ATR by 20 bars", { ...M.LIVE, lots: 7, tx: ["nr", 20, 1] }, null],
  ["stage-2 best: 7 lots, not +1 ATR by 20 bars, br 300, pb 500", { ...M.LIVE, lots: 7, br: 300, pb: 500, tx: ["nr", 20, 1] }, null],
  ["7 lots + half size once range >= 0.9 x ADR", { ...M.LIVE, lots: 7 }, (a, ct, s, arm) => (used(arm - 1) >= 0.9 ? 4 : 7)],
];

const live = M.evalCfg(M.LIVE);
const monthKey = (d) => { const t = new Date(TS[S.dayFirstBar.get(d)] + 43200e3); return t.getUTCFullYear() * 100 + t.getUTCMonth() + 1; };
const M26 = [202601, 202602, 202603, 202604, 202605, 202606, 202607];
const YRS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const yIx = (y) => M.days.map((dd, k) => (S.yearOf.get(dd) === y ? k : -1)).filter((k) => k >= 0);
const at = (arr, ix) => S.passArr(ix.map((k) => arr[k]));
const sg = (x) => ((x >= 0 ? "+" : "") + x.toFixed(1)).padStart(6);
const usd = (x) => ((x >= 0 ? "+$" : "-$") + Math.abs(Math.round(x)).toLocaleString()).padStart(8);

console.log("\n  2026, DOLLARS against the live book, month by month (and how many of the 7 months it gained in)\n");
console.log("  " + "".padEnd(58) + M26.map((m) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"][m % 100 - 1].padStart(8)).join("") + "   months up   2026 total");
const results = [];
for (const [label, cfg, sizer] of CAND) {
  const r = sizer ? M.evalOpts(M.build(cfg), sizer) : M.evalCfg(cfg);
  const diff = new Map();
  M.days.forEach((dd, k) => { const m = monthKey(dd); diff.set(m, (diff.get(m) || 0) + r.arr[k] - live.arr[k]); });
  const vals = M26.map((m) => diff.get(m) || 0);
  console.log("  " + label.padEnd(58) + vals.map(usd).join("") + (vals.filter((v) => v > 0).length + "/7").padStart(12) +
    usd(vals.reduce((a, b) => a + b, 0)).padStart(13));
  results.push([label, r]);
}
console.log("\n  PASS RATE change against the live book, year by year\n");
console.log("  " + "".padEnd(58) + YRS.map((y) => String(y).padStart(7)).join(""));
console.log("  " + "live book pass rate".padEnd(58) + YRS.map((y) => at(live.arr, yIx(y)).toFixed(1).padStart(7)).join(""));
for (const [label, r] of results)
  console.log("  " + label.padEnd(58) + YRS.map((y) => sg(at(r.arr, yIx(y)) - at(live.arr, yIx(y))).padStart(7)).join(""));
