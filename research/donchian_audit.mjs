// Is donchian_1250's pass rate real? Out of sample, forward, and against what luck and volatility give.
//
//   node --max-old-space-size=16384 research/donchian_audit.mjs [--seeds 20]
//
// The person (2026-11-26): "check if the donchian pass rate is actually legitimate using purely OOS and forward
// testing, as well as any other ways you can check". Written before the run:
// - In-sample: 2026 to Jul 14. The 10-minute EMA filter, the late half size, the 40-minute exit and the $1,250 day
//   blocks were all chosen on it (the strategy's notes). Its 74.5% calendar there is not evidence.
// - Out of sample, weighted first (the person's rule: 2025 and 2026 lead): 2025 by half, and the forward bars Jul 15 -
//   Oct 30 (data/mnq_1m_beta.bin; windows start Jul 15 - Sep 30, each with 30 days of bars) by half. 2019-2024 by
//   year after, as a check. Windows: the chart's calendar grid, every day, the book's full $1,250 rule set.
// - Controls, each the same number of runs (--seeds):
//     twin     the coin-flip twin (lib_eval1250 nullCfg): every signal keeps its time, gates, size and exits, and
//              takes a random direction. It has the same volatility, trade count and day rules: what is left is
//              whether the breakout's direction is right.
//     placebo  the book run on placebo markets (lib_levels placeboBars: each bar's move flipped at random, its range
//              kept). The same volatility with no trend in it: what the eval's geometry gives a book of this shape.
//              Its trade count is shown: a breakout book's efficiency filter may find few trades on a market with
//              no trends, and then the twin (identical trades) is the fair control.
// - Legitimate, per period: the real pass rate above every twin seed's and every placebo seed's (about p < 0.05 with
//   20 each), and per trade positive after costs. Judged on 2025 H1, 2025 H2, forward H1, forward H2.
// - Beside it: per-trade figures (the pass rate is a few independent windows a period); each 2026-chosen addition
//   turned off, period by period (did it help where it was not chosen?); and the average RTH range in points,
//   because a fixed-lot book on a dollar target passes more when the market moves more.

import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";
import { configOf, nullCfg } from "./lib_eval1250.mjs";
import { placeboBars } from "./lib_levels.mjs";

const args = process.argv.slice(2), SEEDS = Number(args[args.indexOf("--seeds") + 1] || 20) || 20;
const DAY = 86400000, D = (s) => Date.parse(s + "T00:00:00Z");
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);
const { bars } = loadBars("data/mnq_1m_beta.bin");
const LAST = bars.ts[bars.count - 1];
const PERIODS = [
  ["2025 Jan-Jun (OOS)", "2025-01-01", "2025-07-01", true], ["2025 Jul-Dec (OOS)", "2025-07-01", "2026-01-01", true],
  ["2026 Jan-Mar (in-sample)", "2026-01-01", "2026-04-01"], ["2026 Apr-Jul 14 (in-sample)", "2026-04-01", "2026-07-15"],
  ["forward Jul 15-Aug 22 starts", "2026-07-15", "2026-08-23", true], ["forward Aug 23-Sep 30 starts", "2026-08-23", "2026-10-01", true],
  ["2019 (from May)", "2019-05-06", "2020-01-01"], ["2020", "2020-01-01", "2021-01-01"], ["2021", "2021-01-01", "2022-01-01"],
  ["2022", "2022-01-01", "2023-01-01"], ["2023", "2023-01-01", "2024-01-01"], ["2024", "2024-01-01", "2025-01-01"],
].map(([label, a, b, judged]) => ({ label, lo: D(a), hi: D(b), judged: !!judged }));
// the chart's grid: a window starts every day on the file's first bar's clock, with 30 days of bars after it
const startsOf = (lo, hi) => { const out = []; for (let s = bars.ts[0] + Math.ceil((lo - bars.ts[0]) / DAY) * DAY; s < hi && s + 30 * DAY <= LAST; s += DAY) out.push(s); return out; };
const STARTS = PERIODS.map((p) => startsOf(p.lo, p.hi));

const cfg = await configOf("donchian_1250", {}, "1250");
const run = (c, b = bars) => runStrategy(b, c.s, c.params, c.exec, { filter: c.filter, studies: c.studies }).trades;
const passRate = (trades, k) => { const S = STARTS[k]; let n = 0; for (const s of S) if (replayWindow(trades, s, cfg.rules).outcome === OUTCOME.PASS) n++; return S.length ? (100 * n) / S.length : NaN; };
const perTrade = (trades, p) => {
  let n = 0, net = 0, gw = 0, gl = 0;
  for (const t of trades) { const ms = t.entryTs; if (!(ms >= p.lo && ms < p.hi)) continue; n++; net += t.pnl; if (t.pnl > 0) gw += t.pnl; else gl -= t.pnl; }
  return { n, net, pf: gl > 0 ? gw / gl : NaN, per: n ? net / n : NaN };
};
// the average RTH range (08:30-15:00 CT), points, per period's days
const rangeOf = (p) => {
  let td = -1, hi = -Infinity, lo = Infinity, sum = 0, days = 0;
  const close = () => { if (td >= 0 && hi > lo) { sum += hi - lo; days++; } };
  for (let i = 0; i < bars.count; i++) {
    if (bars.ts[i] < p.lo || bars.ts[i] >= p.hi) continue;
    if (bars.tday[i] !== td) { close(); td = bars.tday[i]; hi = -Infinity; lo = Infinity; }
    const ct = bars.ctMin[i]; if (ct >= 510 && ct < 900) { hi = Math.max(hi, bars.high[i]); lo = Math.min(lo, bars.low[i]); }
  }
  close(); return days ? sum / days : NaN;
};

const real = run(cfg);
if (!real.length) throw new Error("no trades");
const tKey = Object.keys(real[0]).find((k) => /entry/i.test(k) && /ts|ms|time/i.test(k));
process.stderr.write(`  real: ${real.length} trades (entry time field "${tKey}"), ${secs()}s\n`);
for (const t of real) t.entryTs = t[tKey];
const R = PERIODS.map((p, k) => ({ pass: passRate(real, k), ...perTrade(real, p), range: rangeOf(p), windows: STARTS[k].length }));
const twin = [], plac = [];
for (let s = 1; s <= SEEDS; s++) {
  const tw = run(nullCfg(cfg, s)); for (const t of tw) t.entryTs = t[tKey];
  twin.push(PERIODS.map((p, k) => ({ pass: passRate(tw, k), ...perTrade(tw, p) })));
  const pb = placeboBars(bars, 7000 + s), pt = run(cfg, pb); for (const t of pt) t.entryTs = t[tKey];
  plac.push(PERIODS.map((p, k) => ({ pass: passRate(pt, k), ...perTrade(pt, p) })));
  process.stderr.write(`  seed ${s}/${SEEDS}, ${secs()}s\n`);
}
const ABL = [
  ["no 10-min EMA filter", { params: { htfGate: "off" } }], ["no late half size", { params: { lateRangeUsed: 0 } }],
  ["no 40-min exit", { exec: { staleBars: 0 } }], ["no day blocks (-$300 / +$250)", { exec: { dayBreakerUsd: 0, dayProfitBlockUsd: 0 } }],
  ["no slow-trend rescue", { params: { rescueMin: 0 } }],
];
const abl = [];
for (const [name, o] of ABL) {
  const c = await configOf("donchian_1250", o, "1250"), tr = run(c); for (const t of tr) t.entryTs = t[tKey];
  abl.push({ name, rows: PERIODS.map((p, k) => passRate(tr, k)) });
}

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—"), money = (x) => (Number.isFinite(x) ? (x >= 0 ? "+$" : "-$") + Math.abs(Math.round(x)).toLocaleString() : "—");
const q = (a, f) => { const v = a.map(f).filter(Number.isFinite).sort((x, y) => x - y); return { med: v[v.length >> 1], max: v[v.length - 1] }; };
console.log(`donchian_1250 audit, $1,250 eval, calendar windows; ${SEEDS} coin-flip twins and ${SEEDS} placebo markets; ${secs()}s\n`);
console.log(`${"period".padEnd(30)}${"wins".padStart(5)}${"real".padStart(7)}${"twin med/max".padStart(14)}${"placebo med/max".padStart(17)}  ${"trades".padStart(6)}${"net".padStart(9)}${"PF".padStart(6)}${"$/tr".padStart(7)}${"twin $/tr".padStart(10)}${"twin/plac n".padStart(12)}${"RTH range".padStart(11)}`);
PERIODS.forEach((p, k) => {
  const r = R[k], tw = q(twin, (z) => z[k].pass), pl = q(plac, (z) => z[k].pass), twp = q(twin, (z) => z[k].per), twn = q(twin, (z) => z[k].n), pln = q(plac, (z) => z[k].n);
  const legit = r.pass > tw.max && r.pass > pl.max && r.per > 0;
  const bt = twin.filter((z) => z[k].pass < r.pass).length, bp = plac.filter((z) => z[k].pass < r.pass).length;
  console.log(`${p.label.padEnd(30)}${String(r.windows).padStart(5)}${f1(r.pass).padStart(7)}${`${f1(tw.med)}/${f1(tw.max)}`.padStart(14)}${`${f1(pl.med)}/${f1(pl.max)}`.padStart(17)}  ${String(r.n).padStart(6)}${money(r.net).padStart(9)}${f1(r.pf).padStart(6)}${money(r.per).padStart(7)}${money(twp.med).padStart(10)}${`${twn.med}/${pln.med}`.padStart(12)}${f1(r.range).padStart(11)}  beats ${bt}/${bp} of ${SEEDS}${p.judged ? (legit ? "  BEATS LUCK" : "  does not beat luck") : ""}`);
});
// added after the first full run (a lead, not the verdict): the four judged periods pooled, each seed paired across them
const J = PERIODS.map((p, k) => (p.judged ? k : -1)).filter((k) => k >= 0), avg = (row) => J.reduce((a, k) => a + row[k].pass, 0) / J.length;
const ra = avg(R), tws = twin.map(avg), pls = plac.map(avg);
console.log(`
pooled over the four out-of-sample periods (added after the first run): real ${f1(ra)}%; beats ${tws.filter((z) => z < ra).length} of ${SEEDS} twins (median ${f1(q(twin, avg).med)}%) and ${pls.filter((z) => z < ra).length} of ${SEEDS} placebo markets (median ${f1(q(plac, avg).med)}%)`);
console.log(`\nEach 2026-chosen addition turned off (calendar pass rate; the shipped book first):`);
console.log(`${"".padEnd(32)}${PERIODS.map((p) => p.label.split(" (")[0].slice(0, 12).padStart(13)).join("")}`);
console.log(`${"shipped".padEnd(32)}${R.map((r) => f1(r.pass).padStart(13)).join("")}`);
for (const a of abl) console.log(`${a.name.padEnd(32)}${a.rows.map((x) => f1(x).padStart(13)).join("")}`);
