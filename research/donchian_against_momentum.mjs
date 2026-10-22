// Should the Donchian skip a breakout when the chart's momentum says no?
//
// Prompted by a live loss (2026-10-22, short at 09:48 CT): the user read the
// 1/2/5-minute MACD and EMAs as saying "don't". At the moment the bot decided,
// the 1-min MACD had crossed up, the 2- and 5-min were still falling (they
// turned at the fill), price had already dropped 7.9 ATR since 08:30 and sat
// 2.5 ATR under the 2-min EMA 21, and with a 40-point 2-min ATR the $600 day
// limit put the stop only 1.85 ATR away. One trade proves nothing, so each of
// those readings is tested on EVERY Donchian trade (the shipped $1,250 bot),
// at the signal bar's close -- what was known when it decided:
//
//   1. trades with the condition against trades without: win rate, $ a trade,
//      how many were stopped -- 2026, and May 2019-Dec 2025 (never tuned on)
//   2. the condition as a filter (no order when it holds; the strategy stays
//      flat for the next signal): pass rate 2026 (both halves) and before 2026
//
// RESULT: none of it predicts losers in a way that holds outside 2026.
//   1-min MACD already crossed against   those trades did slightly BETTER (2026 +$88 vs +$76; 2019-25 +$33 vs +$11)
//   2-min histogram turning against      worse in 2026 (13 trades, -$79) but better before (111 trades, +$32 vs +$12);
//                                        as a filter +4 pts in 2026, 0 before -- a 2026 accident
//   5-min histogram turning against      the reverse: better in 2026, worse before
//   all three turning against            never at a breakout (0 in 2026, 1 in 2019-2025): the breakout bar itself
//                                        pushes short-term momentum its way
//   stretched / late (top quarter, tenth of 2026's breakouts)  no consistent effect; as filters -7 to +1 pts in 2026
//   tight stop (the $600 stop < 2 ATR)   stopped 36% vs 12%, yet +$114 a trade in 2026 (bigger targets in dollars);
//                                        as a filter -9 pts in 2026 (83.7 / 53.2 by half), 0 before
// The 2026-10-22 trade was an ordinary breakout by these measures (2.48 ATR past
// the EMA 21 against a 2026 median of 2.8; 7.9 ATR from the day's high against
// 10.5); its 2- and 5-min MACD still agreed with it when it fired and turned
// at the fill. The unusual part was a 40-point 2-min ATR, which put the $600
// stop 1.85 ATR away. No filter is added.
//
//   node --max-old-space-size=8192 research/donchian_against_momentum.mjs

import { macd, ema } from "../src/indicators.mjs";
import { resample } from "../src/resample.mjs";
import { loadBars } from "../src/data.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import { t1, tf2, HTF, exit20 } from "./lib_combo.mjs";
import { atr } from "../src/indicators.mjs";

const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const FILL = { slipMult: 1, feeMult: 1, limitFillTp: "close", cancelOpposite: true, exitFirst: true, dayCap: 600, breaker: 300, profitBlock: 250, detail: true };
const yr = (td) => S.yearOf.get(td);
const IDX26 = S.days.map((d, k) => (yr(d) === 2026 ? k : -1)).filter((k) => k >= 0);
const PRE = S.days.map((d, k) => (yr(d) < 2026 ? k : -1)).filter((k) => k >= 0);
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const sg = (x, w = 6) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + Math.round(x) : "-").padStart(w);
const n2 = tf2.close.length;

// ── readings at each 2-minute bar's close ─────────────────────────────────────────────
const C = tf2.close, A2 = atr(tf2.high, tf2.low, tf2.close, 14);
const { hist: H2 } = macd(C, 12, 26, 9);
const E21 = ema(C, 21);
const { hist: H1 } = macd(t1.close, 12, 26, 9);
const { bars } = loadBars();
const T5 = resample(bars, 5);
const { hist: H5 } = macd(T5.close, 12, 26, 9);
const h1 = new Float64Array(n2).fill(NaN), s1 = new Float64Array(n2).fill(NaN);
const h5 = new Float64Array(n2).fill(NaN), s5 = new Float64Array(n2).fill(NaN);
{
  let j = 0, m = 0;
  for (let k = 0; k < n2; k++) {
    const close = tf2.ts[k] + 120000;
    while (j + 1 < t1.ts.length && t1.ts[j + 1] + 60000 <= close) j++;        // last 1-min bar closed by then
    if (t1.ts[j] + 60000 <= close && j > 0) { h1[k] = H1[j]; s1[k] = H1[j] - H1[j - 1]; }
    while (m + 1 < T5.ts.length && T5.ts[m + 1] + 300000 <= close) m++;       // last 5-min bar closed by then
    if (T5.ts[m] + 300000 <= close && m > 0) { h5[k] = H5[m]; s5[k] = H5[m] - H5[m - 1]; }
  }
}
// the day's extreme since 08:30, up to and including the bar
const sessHi = new Float64Array(n2).fill(NaN), sessLo = new Float64Array(n2).fill(NaN);
{
  let day = null, hi = -Infinity, lo = Infinity;
  for (let k = 0; k < n2; k++) {
    if (tf2.tday[k] !== day) { day = tf2.tday[k]; hi = -Infinity; lo = Infinity; }
    if (tf2.ctMin[k] >= 510 && tf2.ctMin[k] < 1020) { hi = Math.max(hi, tf2.high[k]); lo = Math.min(lo, tf2.low[k]); }   // 08:30 on, not the evening before
    sessHi[k] = hi; sessLo[k] = lo;
  }
}
const lotsAt = (k) => (M.adrUsed(k) >= 0.9 ? 2 : 4);
const stretch = (k, d) => (d * (C[k] - E21[k])) / A2[k];                                   // beyond the 2-min EMA 21, in ATRs
const lateness = (k, d) => (d === 1 ? C[k] - sessLo[k] : sessHi[k] - C[k]) / A2[k];        // from the day's extreme since 08:30
const stopAtr = (k) => Math.min(5, 600 / (2 * lotsAt(k)) / A2[k]);                         // where the stop really is, in ATRs
// thresholds from the 2026 signals themselves: the most stretched / latest quarter and tenth
const sig26 = [];
for (let k = 1; k < n2; k++) if (yr(tf2.tday[k]) === 2026 && M.RESC[k] !== 0 && HTF[k] === M.RESC[k]) sig26.push(k);
const q = (arr, p) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const ST = sig26.map((k) => stretch(k, M.RESC[k])), LT = sig26.map((k) => lateness(k, M.RESC[k])), SA = sig26.map((k) => stopAtr(k));
const st75 = q(ST, 0.75), st90 = q(ST, 0.9), lt75 = q(LT, 0.75), lt90 = q(LT, 0.9);
// conditions on the signal bar k, for a trade in direction d (true = "the chart says no")
const COND = [
  ["1-min MACD already crossed against", (k, d) => Math.sign(h1[k]) === -d],
  ["2-min MACD histogram turning against", (k, d) => Math.sign(H2[k] - H2[k - 1]) === -d],
  ["5-min MACD histogram turning against", (k, d) => Math.sign(s5[k]) === -d],
  ["1, 2 and 5-min histograms all turning against", (k, d) => Math.sign(s1[k]) === -d && Math.sign(H2[k] - H2[k - 1]) === -d && Math.sign(s5[k]) === -d],
  [`stretched: the most stretched quarter (> ${st75.toFixed(1)} ATR past the EMA 21)`, (k, d) => stretch(k, d) > st75],
  [`stretched: the most stretched tenth (> ${st90.toFixed(1)} ATR)`, (k, d) => stretch(k, d) > st90],
  [`late: the latest quarter (> ${lt75.toFixed(1)} ATR from the day's extreme)`, (k, d) => lateness(k, d) > lt75],
  [`late: the latest tenth (> ${lt90.toFixed(1)} ATR)`, (k, d) => lateness(k, d) > lt90],
  ["tight: the $600 stop under 2 ATR away", (k) => stopAtr(k) < 2],
  ["this trade's profile: (stretched or late) quarter, AND tight", (k, d) => (stretch(k, d) > st75 || lateness(k, d) > lt75) && stopAtr(k) < 2],
];
const donGate = (k) => M.RESC[k] !== 0 && HTF[k] === M.RESC[k];
const run = (skip) => S.run((a, c, s, arm) => {
  const k = arm - 1;
  if (!donGate(k) || (skip && skip(k, M.RESC[k]))) return 0;
  return lotsAt(k);
}, { signals: M.RESC, ...FILL, exitFn: exit20 });
function pass(trades) {
  const arr = S.dayArr(trades, S.days);
  const p = (ix) => S.passArr(ix.map((k) => arr[k]), RULES);
  return { y: p(M.Y26), a: p(M.Y26a), b: p(M.Y26b), pre: p(PRE) };
}

console.log("=".repeat(124));
console.log("SHOULD THE DONCHIAN SKIP A BREAKOUT WHEN THE CHART'S MOMENTUM SAYS NO? (the shipped $1,250 bot; readings at the signal bar's close)");
console.log("=".repeat(124));
console.log(`
At the 2026 signals (${sig26.length} traded breakouts): beyond the 2-min EMA 21 -- median ${q(ST, 0.5).toFixed(1)} ATR, top quarter > ${st75.toFixed(1)}, top tenth > ${st90.toFixed(1)};` +
            ` from the day's extreme -- median ${q(LT, 0.5).toFixed(1)} ATR, top quarter > ${lt75.toFixed(1)}, top tenth > ${lt90.toFixed(1)};` +
            ` stop distance -- median ${q(SA, 0.5).toFixed(1)} ATR, ${SA.filter((x) => x < 2).length} under 2.`);
console.log("   The 2026-10-22 short: 2.48 ATR beyond the EMA 21, 7.9 ATR from the day's high, stop 1.85 ATR away.");
const base = run(null);
const P0 = pass(base);
console.log(`\nAll trades: 2026 ${base.filter((t) => yr(t.tday) === 2026).length}, before 2026 ${base.filter((t) => yr(t.tday) < 2026).length};` +
            ` pass rate 2026 ${P0.y.toFixed(1)}% (${P0.a.toFixed(1)} / ${P0.b.toFixed(1)}), before 2026 ${P0.pre.toFixed(1)}%`);
const stat = (T) => {
  const n = T.length;
  if (!n) return "".padStart(32);
  const w = T.filter((t) => t.pnl > 0).length, st = T.filter((t) => t.why === "SL" || t.why === "SLcap").length;
  return String(n).padStart(5) + f1((100 * w) / n, 6) + sg(T.reduce((s, t) => s + t.pnl, 0) / n, 7) + f1((100 * st) / n, 7) + "%";
};
console.log("\n1. TRADES WITH THE CONDITION (\"the chart says no\") against those without      trades  win%  $/trade stopped");
for (const [name, fn] of COND) {
  const yes = (t) => fn(t.sigBar, t.dir);
  for (const [lbl, T] of [["2026", base.filter((t) => yr(t.tday) === 2026)], ["2019-2025", base.filter((t) => yr(t.tday) < 2026)]]) {
    const a = T.filter(yes), b = T.filter((t) => !yes(t));
    console.log("   " + (lbl === "2026" ? name : "").padEnd(52) + lbl.padEnd(11) + "said no:" + stat(a) + "    said go:" + stat(b));
  }
}
console.log("\n2. AS A FILTER -- no order when the chart says no              2026 (Jan-Mar / Apr-Jul)   before 2026   trades skipped in 2026");
console.log("   " + "none (shipped)".padEnd(56) + f1(P0.y) + " (" + P0.a.toFixed(1) + " / " + P0.b.toFixed(1) + ")" + f1(P0.pre, 12));
for (const [name, fn] of COND) {
  const tr = run(fn), P = pass(tr);
  const n0 = base.filter((t) => yr(t.tday) === 2026).length, n1 = tr.filter((t) => yr(t.tday) === 2026).length;
  console.log("   " + name.padEnd(56) + f1(P.y) + " (" + P.a.toFixed(1) + " / " + P.b.toFixed(1) + ")" + f1(P.pre, 12) +
              ("   " + sg(P.y - P0.y, 0) + " / " + sg(P.pre - P0.pre, 0) + " pts").padEnd(18) + String(n0 - n1).padStart(6));
}
