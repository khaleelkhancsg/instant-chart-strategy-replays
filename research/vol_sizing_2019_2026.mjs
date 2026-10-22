// Can sizing by volatility keep the strategies' results steady across regimes?
//
// 2026 is the most volatile year in the data, and the strategies were tuned on
// it: on calmer years each trade moves fewer dollars against the same fixed
// target and day rules (research/years_2019_2026.mjs). Lot size is the one lever
// that changes nothing else, so:
//
//   1. HOW VOLATILITY IS MEASURED, and does it cluster? A day's volatility = the
//      median 2-minute ATR(14) over its 08:30-15:00 CT session (ATR = true range
//      smoothed with an EMA, alpha 2/15). How well does yesterday, the last week,
//      the last 60 days, a HAR blend (Corsi 2009: yesterday, the week and the
//      month averaged in logs), or the pre-open ATR predict today's?
//   2. SIZING RULES, every one decided with information known at the time:
//        shipped           4 lots, always
//        fewer when quiet  lots up to 4, falling with the day's forecast (the
//                          rule years_2019_2026.mjs tested, now with HAR)
//        fewer when wild   4 lots, fewer only when the forecast is ABOVE 2026's
//        target (day)      4 x 2026's volatility / the day's forecast -- MORE
//                          lots on calm days, fewer on wild ones; capped
//        target (signal)   the same with the ATR at the signal itself, the most
//                          current intraday reading; capped
//      The late-day size stays half the size. Everything else as shipped.
//      Each rule's coin-flip twin (same rule, direction random) shows whether
//      the rule amplifies an edge or only adds leverage.
//
// RESULT:
// Volatility clusters, as the literature says (Mandelbrot 1963; Engle 1982;
// Bollerslev 1986; Corsi 2009): a day's log volatility correlates 0.80 with
// the day before, 0.61 inside a year with the year's level removed. Best
// forecasts: HAR R2 0.69 (typical miss 25%), the last 5 days 0.66, yesterday
// 0.64; the 60-day median used in years_2019_2026.mjs is the worst (0.44).
// But no sizing rule keeps the 2026 result going forward. Donchian $1,250
// (2026 / before 2026 / coin-flip null / edge):
//   shipped 4 lots                    71.1 / 36.0 / 18.5 / +17
//   fewer when quiet (down only)      66.0 / 25.3 / 11.1 / +14
//   fewer when wild (down only)       62.8 / 35.0 / 17.8 / +17
//   target by day forecast, cap 8     62.9 / 38.6 / 25.3 / +13
//   target by the signal's ATR, cap 8 54.0 / 38.1 / 25.4 / +13
// Targeting volatility (more lots when calm, fewer when wild) lifts the years
// before 2026 a little, but its coin-flip twin rises more -- that is leverage,
// not edge -- and it costs 8-17 points in 2026, because the Donchian earns most
// per unit of risk on the wild days the rule shrinks. Down-only rules lose in
// both directions. Same on $3,000 (shipped 59.3 / 21.8, edge +13; best target
// 54.7 / 27.3, edge +13). The MACD's missing edge is not fixed by any rule
// (+1 to +5 over its null). The shipped fixed size already scales its dollars
// with volatility through the ATR stop and target.
//
//   node --max-old-space-size=8192 research/vol_sizing_2019_2026.mjs

import { atr } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import { E1, t1, tf2, SIGA, ML, volRel, HTF, exit20 } from "./lib_combo.mjs";

const T0 = Date.now();
const R1250 = { target: 1250, dd: 1000, consistency: 0.5 }, R3000 = { target: 3000, dd: 2000, consistency: 0.5 };
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const yr = (td) => S.yearOf.get(td);
const IDX = {};
for (const y of YEARS) IDX[y] = S.days.map((d, k) => (yr(d) === y ? k : -1)).filter((k) => k >= 0);
const PRE = S.days.map((d, k) => (yr(d) < 2026 ? k : -1)).filter((k) => k >= 0);
const KOF = new Map(S.days.map((d, k) => [d, k]));
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const f2 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(2) : "-").padStart(w);
const sg = (x, w = 6) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(0) : "-").padStart(w);
const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const mean = (a) => { const s = a.filter(Number.isFinite); return s.length ? s.reduce((p, x) => p + x, 0) / s.length : NaN; };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ── 1. volatility, day by day ───────────────────────────────────────────────────────────
const A2 = atr(tf2.high, tf2.low, tf2.close, 14);
const nD = S.days.length;
const vol = new Float64Array(nD).fill(NaN), pre = new Float64Array(nD).fill(NaN);
{
  let cur = -1, buf = [];
  const flush = () => { if (cur >= 0 && buf.length) vol[cur] = median(buf); };
  for (let i = 0; i < tf2.close.length; i++) {
    const k = KOF.get(tf2.tday[i]);
    if (k !== cur) { flush(); cur = k; buf = []; }
    const ct = tf2.ctMin[i];
    if (ct >= 510 && ct < 900) buf.push(A2[i]);
    else if (ct < 510 && ct >= 300) pre[k] = A2[i];             // the last 2-min bar before 08:30
  }
  flush();
}
const lv = Array.from(vol, (v) => (v > 0 ? Math.log(v) : NaN));
// forecasts for day k from days before it (and, for "pre-open", the bars before 08:30 of day k)
const lag = (k, n) => { const out = []; for (let j = k - 1; j >= 0 && out.length < n; j--) if (Number.isFinite(lv[j])) out.push(lv[j]); return out; };
const FC = {
  "yesterday": (k) => { const l = lag(k, 1); return l.length ? l[0] : NaN; },
  "last 5 days": (k) => { const l = lag(k, 5); return l.length === 5 ? mean(l) : NaN; },
  "last 60 days (median)": (k) => { const l = lag(k, 60); return l.length >= 10 ? median(l) : NaN; },
  "HAR: yesterday, week, month": (k) => { const l = lag(k, 22); return l.length === 22 ? (l[0] + mean(l.slice(0, 5)) + mean(l)) / 3 : NaN; },
  "pre-open ATR (08:28)": (k) => (pre[k] > 0 ? Math.log(pre[k]) : NaN),
};
function fitR2(xs, ys) {
  const n = xs.length, mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const b = sxy / sxx, a = my - b * mx;
  let sse = 0, ape = 0;
  for (let i = 0; i < n; i++) { const p = a + b * xs[i]; sse += (ys[i] - p) ** 2; ape += Math.abs(Math.exp(ys[i] - p) - 1); }
  return { r2: 1 - sse / syy, mape: (100 * ape) / n, corr: sxy / Math.sqrt(sxx * syy) };
}
console.log("=".repeat(124));
console.log("SIZING BY VOLATILITY -- the 2026 strategies on every year, May 2019 - Jul 2026");
console.log("=".repeat(124));
console.log("\n1. A DAY'S VOLATILITY = the median 2-minute ATR(14) of its 08:30-15:00 CT session. Does it cluster?");
{
  const ac = (L) => { const xs = [], ys = []; for (let k = L; k < nD; k++) if (Number.isFinite(lv[k]) && Number.isFinite(lv[k - L])) { xs.push(lv[k - L]); ys.push(lv[k]); } return fitR2(xs, ys).corr; };
  console.log(`   correlation of a day's (log) volatility with the day before: ${ac(1).toFixed(2)};  5 days before: ${ac(5).toFixed(2)};  20 days before: ${ac(20).toFixed(2)}`);
  // the same, with each year's level removed: does a wild day predict a wild next day inside a regime too?
  const ym = new Map(YEARS.map((y) => [y, mean(IDX[y].map((k) => lv[k]))]));
  const xs = [], ys = [];
  for (let k = 1; k < nD; k++) if (Number.isFinite(lv[k]) && Number.isFinite(lv[k - 1]) && yr(S.days[k]) === yr(S.days[k - 1])) { const m = ym.get(yr(S.days[k])); xs.push(lv[k - 1] - m); ys.push(lv[k] - m); }
  console.log(`   ...within each year (its own level taken out): ${fitR2(xs, ys).corr.toFixed(2)} -- yes, a wild day tends to be followed by a wild day`);
  console.log("   how well each forecast predicts the day's volatility (2019-2026; R2 of log volatility, typical miss):");
  for (const [name, fn] of Object.entries(FC)) {
    const xs = [], ys = [];
    for (let k = 0; k < nD; k++) { const p = fn(k); if (Number.isFinite(p) && Number.isFinite(lv[k])) { xs.push(p); ys.push(lv[k]); } }
    const r = fitR2(xs, ys);
    console.log(`     ${name.padEnd(30)} R2 ${r.r2.toFixed(2)}   typical miss ${r.mape.toFixed(0)}%`);
  }
}

// ── the strategies, sized by a rule ──────────────────────────────────────────────────────
const F = { slipMult: 1, feeMult: 1, limitFillTp: "close", cancelOpposite: true, exitFirst: true };
const donGate = (k) => M.RESC[k] !== 0 && HTF[k] === M.RESC[k];
const macGate = (k) => SIGA[k] !== 0 && Math.sign(ML[k]) === SIGA[k] && !(volRel[k] < 1);
const harK = new Float64Array(nD).fill(NaN);
for (let k = 0; k < nD; k++) { const p = FC["HAR: yesterday, week, month"](k); harK[k] = Number.isFinite(p) ? Math.exp(p) : NaN; }
const REF_DAY = median(IDX[2026].map((k) => vol[k]));
const sigAtr26 = (gate, T, A) => { const v = []; for (let k = 0; k < T.close.length; k++) if (yr(T.tday[k]) === 2026 && T.ctMin[k] >= 510 && T.ctMin[k] < 900 && gate(k)) v.push(A[k]); return median(v); };
const REF_SIG_D = sigAtr26(donGate, tf2, A2);
const REF_SIG_M = sigAtr26(macGate, t1, E1.atr);
const coin = (sig, seed) => { const rnd = S.mul(seed), o = new Int8Array(sig.length); for (let k = 0; k < sig.length; k++) if (sig[k] !== 0) o[k] = rnd() < 0.5 ? 1 : -1; return o; };

// a sizing rule: (base lots, day index, ATR at the signal, signal-ATR reference) -> lots
const RULESETS = (base, capx) => [
  ["shipped (fixed)", () => base],
  ["fewer when quiet (down only)", (k) => (Number.isFinite(harK[k]) ? clamp(Math.round((base * harK[k]) / REF_DAY), 1, base) : base)],
  ["fewer when wild (down only)", (k) => (Number.isFinite(harK[k]) ? clamp(Math.round((base * REF_DAY) / harK[k]), 1, base) : base)],
  ...capx.map((c) => [`target by the day's forecast, cap ${c}`, (k) => (Number.isFinite(harK[k]) ? clamp(Math.round((base * REF_DAY) / harK[k]), 1, c) : base)]),
  ...capx.map((c) => [`target by the ATR at the signal, cap ${c}`, (k, a, ref) => clamp(Math.round((base * ref) / a), 1, c)]),
];
function pass(arr, ix, rules) {
  if (ix.length < 25) return { p: NaN, real: NaN };
  const v = ix.map((k) => arr[k]);
  let cp = 0, cn = 0;
  for (let q = 0; q + 21 <= v.length; q++) { cp += S.evWith(v.slice(q, q + 21), rules); cn++; }
  return { p: S.passArr(v, rules), real: (100 * cp) / cn };
}
function study(title, rules, base, capx, run, sig) {
  console.log("\n" + "-".repeat(124) + "\n" + title + "\n" + "-".repeat(124));
  console.log("   " + "".padEnd(40) + "2026  before 2026   null  edge  |" + YEARS.filter((y) => y < 2026).map((y) => String(y).padStart(6)).join("") +
              "  | average lots 2019..2026");
  const out = [];
  for (const [name, fn] of RULESETS(base, capx)) {
    const tr = run(fn, sig);
    const arr = S.dayArr(tr, S.days);
    const p26 = pass(arr, IDX[2026], rules).p, pp = pass(arr, PRE, rules).p;
    const nulls = [11, 22, 33, 44].map((seed) => pass(S.dayArr(run(fn, coin(sig, seed)), S.days), PRE, rules).p);
    const pn = mean(nulls);
    const lots = YEARS.map((y) => mean(tr.filter((t) => yr(t.tday) === y).map((t) => t.lots)));
    console.log("   " + name.padEnd(40) + f1(p26, 4) + f1(pp, 9) + f1(pn, 9) + sg(pp - pn, 6) + "  |" +
                YEARS.filter((y) => y < 2026).map((y) => f1(pass(arr, IDX[y], rules).p, 6)).join("") + "  | " + lots.map((x) => x.toFixed(1)).join(" "));
    out.push({ name, p26, pp, pn });
  }
  return out;
}

const donRun = (lim) => (fn, sig) => S.run((a, c, s, arm) => {
  if (!donGate(arm - 1)) return 0;
  const L = fn(KOF.get(tf2.tday[arm]), a, REF_SIG_D);
  return M.adrUsed(arm - 1) >= 0.9 ? Math.max(1, Math.round(L * lim.late)) : L;
}, { signals: sig, ...F, exitFn: exit20, ...lim.opts });
const macRun = (fn, sig) => E1.run((a, c, s, arm) => (macGate(arm - 1) ? fn(KOF.get(t1.tday[arm]), a, REF_SIG_M) : 0),
  { signals: sig, ...F, dayCap: 600, breaker: 200, profitBlock: 250, trig: 0.15, tpFromFill: true, tpFn: (a, q) => Math.min(5.15 * a, 600 / (2 * q)) });

console.log(`\n   references: 2026's median day volatility ${REF_DAY.toFixed(1)} pts; median 2-min ATR at the Donchian's signals in 2026 ${REF_SIG_D.toFixed(1)};` +
            ` 1-min ATR at the MACD's ${REF_SIG_M.toFixed(1)}`);
console.log("\n2. SIZING RULES -- 21-day pass rate; 'null' = the same rule with coin-flip directions (before 2026), 'edge' = the difference");
const d1250 = study("DONCHIAN, $1,250 (the bot): base 4 lots, half late in the day; -$300 / +$250 / -$600", R1250, 4, [8, 12],
                    donRun({ late: 0.5, opts: { dayCap: 600, breaker: 300, profitBlock: 250 } }), M.RESC);
const d3000 = study("DONCHIAN, $3,000: base 7 lots, 4/7 late; -$500 / +$400 / -$1,000", R3000, 7, [14, 21],
                    donRun({ late: 4 / 7, opts: { dayCap: 1000, breaker: 500, profitBlock: 400 } }), M.RESC);
const m1250 = study("MACD FADE, $1,250: base 4 lots; -$200 / +$250 / -$600", R1250, 4, [8, 12], macRun, SIGA);
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
