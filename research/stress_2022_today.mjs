// The 2022 stress test: 2022's moves at today's price, on the $1,250 Donchian (donchian_1250).
//
//   node --max-old-space-size=8192 research/stress_2022_today.mjs
//
// The VXN is a percentage, so a 2022-sized regime at today's price would be bigger in dollars
// than anything 2026 has shown: 2022's 5-minute ATR was 0.147% of price against 2026's 0.104%,
// its median RTH range 2.25% against 1.31% (research/regime_by_year.mjs, vxn_regime.mjs). No such
// year exists at today's price, so this builds one. Every 1-minute bar from Sep 2021 (the
// warm-up) to the end of 2022 keeps its move from the bar before as a percentage of the
// contract's real price. The path is scaled so 2022's median close is today's price, the last
// close in data/mnq_1m_beta.bin. Rolls drop out (the path is continuous), prices sit on the 0.25
// tick, and volume and clock are 2022's.
//
// donchian_1250's signal is all ratios: the Donchian breakout, ADX, efficiency, EMAs, ATR stops
// and targets, ADR used. So it fires on the same bars as in real 2022, and only its dollar lines
// see the bigger moves: the -$300 breaker, the +$250 block, the $600 day line, the eval's $1,000
// trailing drawdown and $1,250 target.
//
// Sizes, each run on the scaled 2022, the real 2022 and 2026 (the lab's bars, to Jul 14):
//   - shipped: 4 lots, 2 late;
//   - fixed 3, 2 and 1 lots;
//   - the dollar rule of research/vxn_sizing_1250.mjs: lots x T / (VXN x price), held to
//     0.5-1.5, with T fixed from 2026 (a one-sd day of $838 a contract);
//   - the same, cut only: held to 0.5-1, so it never trades above the shipped size. Added after
//     the first run, where a floor of 0.25 in this slot changed nothing (the factor never fell
//     under 0.375, where it would) and the rule traded 5.5 lots in the real 2022.
// Scored as lib_eval1250's forwardScorer scores a period on the $1,250 rules:
//   - a 30-day window started on every calendar day with 30 days after it, each ending passed,
//     failed or out of days, judged on closed trades and on live equity (each trade's worst
//     point, as the firm watches it);
//   - the bootstrap of 21-day stretches;
//   - days at the $600 line, the worst day, and the deepest fall of the year's closed equity.
//
// Named before the first run: on the scaled 2022, the dollar rule against the shipped 4 lots,
// by the calendar pass rate on live equity and its share of failed windows.
//
// RESULT (run 2026-11-21; today's price 28,546; the scaled 2022 runs 23,940-38,081; 334 calendar
// windows in 2022, 165 in 2026 to Jul 14): at today's price a 2022 breaks the shipped 4 lots. The
// dollar rule passes about half its windows, and cut only it costs nothing in 2026.
//   - The check: every 2022 session's RTH range and close-to-close move match the real ones in %
//     within 0.02 points (median range 2.209% both). donchian_1250's signals differ on 25 of
//     4,858 signal bars (the 0.25 tick).
//   - 2022 at today's price. Each line: closed pass / fail; live pass / fail; bootstrap; days at
//     the $600 line; net.
//       - shipped 4 lots: 31.1 / 68.9; 26.9 / 73.1; 30.3; 103 days; +$693.
//       - fixed 3 lots: 49.4 / 50.6; 39.5 / 60.5; 44.1; 77 days; +$9,716.
//       - fixed 2 lots: 63.5 / 33.8; 54.5 / 45.5; 65.6; 36 days; +$20,181.
//       - fixed 1 lot: 47.6 / 23.4 (29% out of days); 47.0 / 29.0; 47.5; 7 days; +$10,785.
//       - $ rule (named): 54.8 / 45.2; 45.8 / 54.2; 53.4; 67 days; +$15,263, at 2.74 lots.
//       - $ rule, cut only: the same.
//     The 5-ATR stop there is 246 points ($1,968 at 4 lots), so the $600 line is the real stop.
//   - 2022 as it was (NQ about 12,400): shipped 57.8 / 37.1; 50.0 / 49.1; 58.3. The named rule
//     traded 5.5 lots there and did worse (48.2; 41.3; 46.1); cut only is the shipped book.
//   - 2026: shipped 73.9; 70.3 live; 71.1. Named 72.7; 66.7; 65.2. Cut only 73.9; 70.9; 70.1, at
//     3.24 lots against 3.44.
//   - In research/vxn_sizing_1250.mjs's scoring, cut only:
//       - 2026: calendar 74.5% (75.6 / 73.3) and bootstrap 70.1%, against 74.5% and 71.1%;
//       - forward: 53.2% and +$3,415, against 44.2% and +$2,584.
//   - Most of the stress-year gain is size. Fixed 3 lots (2.87) and 2 lots (1.85) bracket the
//     rule's 2.74 lots and its pass rates; the rule sits a few points above that line. What it
//     adds is trading 4 lots when the dollar day is ordinary and fewer when it is not.
//   - Caveats:
//       - Cut only was chosen after the first run.
//       - The scaled year is one path, 2022's, which the Donchian traded well (58% at its own
//         price). A future wild year need not trend like it.
//       - It holds about 11 independent 30-day windows.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { sessionsOf, rawOffsets } from "../src/levels.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";
import { configOf, forwardScorer, Y26, lab as L } from "./lib_eval1250.mjs";

const DAY = 86400000, WARM = Date.UTC(2021, 8, 1), Y22 = Date.UTC(2022, 0, 1), Y23 = Date.UTC(2023, 0, 1), TICK = 0.25;
const VXN_FILE = "data/raw/fred/VXNCLS.csv", BETA = "data/mnq_1m_beta.bin";
const t0 = Date.now();

// ── the VXN ──
const vxn = fs.readFileSync(VXN_FILE, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","))
  .filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && v && v.trim() !== "." && Number.isFinite(+v))
  .map(([d, v]) => ({ ms: Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)), v: +v }));
function lastBefore(ms) {
  let lo = 0, hi = vxn.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (vxn[m].ms < ms) { at = m; lo = m + 1; } else hi = m - 1; }
  return at;
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

// ── the bars: the real 2022, the scaled one, and 2026 ──
const lab = L.bars();
const counted = (b) => ({ ...b, count: b.ts.length });   // sliceBars leaves count off; the scorer needs it
const real22 = counted(sliceBars(lab, indexAtOrAfter(lab.ts, WARM), indexAtOrAfter(lab.ts, Y23)));
const beta = loadBars(BETA).bars, betaOff = rawOffsets(beta);
const TODAY = beta.close[beta.count - 1] - betaOff[beta.count - 1];

// Each bar's open, high, low and close as a move from the bar before, in percent of the
// contract's real price, rebuilt into one continuous path, then scaled so 2022's median close
// is `target`.
function scaled(b, target) {
  const off = rawOffsets(b), n = b.ts.length;
  const O = new Float64Array(n), H = new Float64Array(n), Lw = new Float64Array(n), C = new Float64Array(n);
  O[0] = b.open[0] - off[0]; H[0] = b.high[0] - off[0]; Lw[0] = b.low[0] - off[0]; C[0] = b.close[0] - off[0];
  for (let i = 1; i < n; i++) {
    const g = C[i - 1] / (b.close[i - 1] - off[i - 1]), base = b.close[i - 1];   // path over real, at the bar before
    O[i] = C[i - 1] + (b.open[i] - base) * g;
    H[i] = C[i - 1] + (b.high[i] - base) * g;
    Lw[i] = C[i - 1] + (b.low[i] - base) * g;
    C[i] = C[i - 1] + (b.close[i] - base) * g;
  }
  const in22 = []; for (let i = 0; i < n; i++) if (b.ts[i] >= Y22) in22.push(C[i]);
  const k = target / median(in22), tick = (x) => Math.round((x * k) / TICK) * TICK;
  return { ...b, open: Float32Array.from(O, tick), high: Float32Array.from(H, tick), low: Float32Array.from(Lw, tick), close: Float32Array.from(C, tick), rolls: [], scale: k, count: n };
}
const sc22 = scaled(real22, TODAY);

// ── the sizes ──
const T = JSON.parse(fs.readFileSync("research/vxn_sizing_1250_results.json", "utf8")).dollar.T;
// the factor on one set of bars: T over the VXN before the session times that session's real prior close
function dollarFactor(b, lo = 0.5, hi = 1.5) {
  const ss = sessionsOf(b), off = rawOffsets(b), px = new Map();
  let last = NaN;
  for (const s of ss) { if (Number.isFinite(last)) px.set(s.td, last); if (s.rthA >= 0) last = s.close - off[s.rthZ - 1]; }
  return (td) => { const k = lastBefore(td * DAY), p = px.get(td); return k >= 0 && p > 0 ? clamp(T / (vxn[k].v * p), lo, hi) : 1; };
}
let uid = 0;
function withFactor(cfg, factor) {
  const s = cfg.s;
  return { ...cfg, s: { ...s, id: `${s.id}~stress${++uid}`, compute(b, p) {
    const o = s.compute(b, p), n = b.close.length, m = o.sizeMult, out = new Float64Array(n);
    for (let k = 0; k < n; k++) out[k] = (m ? m[k] : 1) * factor(b.tday[k]);
    return { ...o, sizeMult: out };
  } } };
}
const base = await configOf("donchian_1250");
const fixed = async (c) => configOf("donchian_1250", { exec: { contracts: c } });
const SIZES = [
  ["shipped: 4 lots", () => base],
  ["fixed 3 lots", () => fixed(3)],
  ["fixed 2 lots", () => fixed(2)],
  ["fixed 1 lot", () => fixed(1)],
  ["$ rule, 0.5-1.5 (named)", (b) => withFactor(base, dollarFactor(b))],
  ["$ rule, cut only (0.5-1)", (b) => withFactor(base, dollarFactor(b, 0.5, 1))],
];

// ── the scoring ──
const r1 = (x) => Math.round(x * 10) / 10;
function scoreOn(bars, from, trades, rules) {
  const F = forwardScorer(bars, from), live = { ...rules, evaluateOn: "intraday" };
  const ends = (R) => {
    const c = { pass: 0, fail: 0, open: 0 };
    for (const s of F.starts) { const o = replayWindow(trades, s, R).outcome; if (o === OUTCOME.PASS) c.pass++; else if (o === OUTCOME.FAIL) c.fail++; else c.open++; }
    const n = F.starts.length;
    return { pass: r1((100 * c.pass) / n), fail: r1((100 * c.fail) / n), open: r1((100 * c.open) / n), windows: n };
  };
  const base = F.score(trades, rules), byDay = new Map();
  for (const t of trades) { const d = Math.floor(t.exitTime / DAY); byDay.set(d, (byDay.get(d) || 0) + t.pnl); }
  let cum = 0, peak = 0, fall = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) { cum += t.pnl; peak = Math.max(peak, cum); fall = Math.max(fall, peak - cum); }
  const lots = trades.length ? trades.reduce((s, t) => s + t.contracts, 0) / trades.length : 0;
  const stopPts = trades.length ? trades.reduce((s, t) => s + Math.abs(t.entryPrice - t.stop), 0) / trades.length : 0;
  return {
    ...base, lots: Math.round(lots * 100) / 100, closed: ends(rules), live: ends(live),
    worstDay: Math.round(Math.min(0, ...byDay.values())), deepestFall: Math.round(fall), stopPts: Math.round(stopPts),
  };
}
const PERIODS = [
  ["2022 at today's price", sc22, Y22],
  ["2022 as it was", real22, Y22],
  ["2026 (to Jul 14)", lab, Y26],
];
const out = {};
for (const [pname, bars, from] of PERIODS) {
  out[pname] = {};
  const runFrom = bars === lab ? counted(sliceBars(lab, indexAtOrAfter(lab.ts, from - 120 * DAY), lab.count)) : bars;
  for (const [label, make] of SIZES) {
    const cfg = await make(runFrom);
    const trades = runStrategy(runFrom, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies: cfg.studies, fromMs: from }).trades;
    out[pname][label] = scoreOn(runFrom, from, trades, cfg.rules);
  }
}

// ── print ──
const pc = (b) => { const off = rawOffsets(b), xs = []; for (let i = 0; i < b.ts.length; i++) if (b.ts[i] >= Y22 && b.ts[i] < Y23) xs.push(b.close[i] - off[i]); xs.sort((a, c) => a - c); return xs; };
const s22 = pc(sc22), r22 = pc(real22);
console.log(`Today's price (last close in ${BETA}): ${TODAY.toFixed(2)}. The scaled 2022 runs ${s22[0].toFixed(0)}-${s22[s22.length - 1].toFixed(0)}, median ${median(s22).toFixed(0)}; the real one ${r22[0].toFixed(0)}-${r22[r22.length - 1].toFixed(0)}, median ${median(r22).toFixed(0)} (x${sc22.scale.toFixed(3)} on the rebuilt path).`);
console.log(`The dollar rule's T: VXN x price ${T.toFixed(0)}, a one-sd day of $${((T / 100 / Math.sqrt(252)) * 2).toFixed(0)} a contract.\n`);
const pad = (s, n) => String(s).padStart(n);
for (const [pname] of PERIODS) {
  console.log(`== ${pname} ==`);
  console.log(`${"".padEnd(26)}${pad("lots", 6)}${pad("trades", 7)}${pad("net", 9)}${pad("$/tr", 6)}${pad("stop pts", 9)}${pad("closed: pass / fail / out", 27)}${pad("live: pass / fail / out", 25)}${pad("boot", 6)}${pad("$600 days", 10)}${pad("worst day", 10)}${pad("deepest fall", 13)}`);
  for (const [label] of SIZES) {
    const r = out[pname][label];
    console.log(`${label.padEnd(26)}${pad(r.lots, 6)}${pad(r.trades, 7)}${pad(r.net, 9)}${pad(r.perTrade, 6)}${pad(r.stopPts, 9)}${pad(`${r.closed.pass} / ${r.closed.fail} / ${r.closed.open}`, 27)}${pad(`${r.live.pass} / ${r.live.fail} / ${r.live.open}`, 25)}${pad(r.boot, 6)}${pad(r.downDays, 10)}${pad(r.worstDay, 10)}${pad(r.deepestFall, 13)}`);
  }
  console.log(`  (${out[pname]["shipped: 4 lots"].closed.windows} calendar windows)\n`);
}
console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`);
fs.writeFileSync("research/stress_2022_today_results.json", JSON.stringify({ run: new Date().toISOString(), today: TODAY, scale: sc22.scale, T, results: out }, null, 1));
console.log("wrote research/stress_2022_today_results.json");
