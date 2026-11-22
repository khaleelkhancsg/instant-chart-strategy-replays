// How long after a databox alert does MNQ go 10 points its way, and how far against it first?
//
//   node --max-old-space-size=12288 research/databox_ten_points.mjs
//
// The person's question (2026-11-22): the databox read as a bot would read it. Year by year, when
// it calls long or short, how long until price is 10 points that way, and how far it goes the
// other way before getting there.
//
// - The box: the indicator file itself (../TradingCustomIndicators/tradovate/emaMacdDatabox.js),
//   run bar by bar through the mock of Tradovate's runtime at its defaults (EMA 12/26, MACD
//   12/26/9). It runs on the 1-minute and 5-minute bars of data/mnq_1m_beta.bin, May 2019 - Oct
//   30 2026.
// - An alert comes at the close of the bar where it happens, all a bot can know then:
//     EMA row     the row turns to the long side from the short side, or back;
//     MACD row    the same for the MACD row;
//     both rows   the box turns both rows long, or both short (the second row joining).
//   A warning (Potentially long / short) does not change a row's side.
// - Only alerts in the New York session count: bars closing 08:30-14:55 CT, when the bots may
//   still enter. Each is followed on 1-minute bars from the next minute until 15:05 CT, the bots'
//   flat time.
// - Measured from the alert bar's close:
//     reached        the share that touch 10 points the alert's way by 15:05;
//     minutes        until the first touch, counting the minute it happens in;
//     against        how far price went the other way before that touch. The touch's own minute
//                    counts in full, because its low may have come first and a bot's stop would
//                    see it. "open only" counts just that minute's open;
//     10 before -10  the share that touch +10 before -10. A minute touching both counts as -10,
//                    the engine's stop-first rule.
// - Against what: every New York minute of the same year, entered long and short alike and
//   followed the same way. If the alerts know which way price goes, they beat that.
// - 10 points is not the same move every year: about 0.13% of NQ's price in 2019, 0.035% in 2026.
//
// RESULT (run 2026-11-22): after an alert, price reaches 10 points the alert's way as fast as it
// does from any minute, and goes as far against first. The box's flips carry no timing.
//   - 1m both rows, year by year. Each line: alerts; reach +10; minutes average (median);
//     against average (median, 90th percentile); +10 first. In brackets, every minute.
//       - 2019: 3,877; 68.1%; 50 (25); 9.5 (5.5, 23.3); 46.8% [68.2%; 49.5; 9.1; 47.6%]
//       - 2020: 5,725; 85.6%; 23.7 (7); 15.8 (7.8, 38.3); 49.3% [85.3%; 23.3; 15.3; 48.9%]
//       - 2021: 5,778; 83.8%; 23.0 (8); 14.5 (7.8, 35.5); 48.2% [84.0%; 22.6; 13.9; 49.2%]
//       - 2022: 5,700; 90.5%; 13.7 (3); 18.8 (8.8, 48.0); 48.3% [90.6%; 13.8; 18.1; 48.2%]
//       - 2023: 5,671; 86.2%; 18.8 (6); 15.1 (7.5, 38.3); 50.1% [85.8%; 19.9; 15.0; 49.4%]
//       - 2024: 5,769; 87.6%; 15.8 (5); 15.8 (8.3, 39.0); 48.6% [88.4%; 16.6; 16.4; 49.0%]
//       - 2025: 5,772; 90.3%; 14.4 (3); 18.1 (9.0, 43.8); 47.5% [90.4%; 14.5; 18.8; 47.3%]
//       - 2026: 4,783; 92.0%; 11.0 (2); 20.4 (10.0, 50.8); 45.5% [92.0%; 11.1; 20.1; 46.0%]
//     Counting only the touch minute's open, "against" falls 1-3 points (2026 17.6, every minute
//     17.5).
//   - The EMA row and MACD row alone, and the 5m alerts, read the same within a few points every
//     year. Split by side, long alerts match random longs and short alerts random shorts.
//   - The exception is 2026's 5m alerts, a little worse than any minute. Both rows give +10
//     first 41.2% against 46.0%, and 22.5 points against against 20.1; the EMA and MACD rows
//     alone 42.3% and 41.7%. That is the 5-minute reversal research/databox_predict.mjs found,
//     not something to trade the other way: it is one year among 48 year-cells.
//   - So from a databox alert, a 10-point target is usually touched within a few minutes, but so
//     it is from any minute. One alert in two first goes 10 points the other way (more often in
//     2026). With a round trip of about 1.25 points, a 10 / 10 bracket on the alerts loses.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample, indexAtOrAfter } from "../src/resample.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const MIN = 60000, TARGET = 10, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55;
const t0 = Date.now();

// ── the box, from the indicator's own code (as research/databox_predict.mjs runs it) ──
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
const side = (c) => (c === 1 || c === 2 ? 1 : c === 3 || c === 4 ? -1 : 0);
function boxStates(T, minutes) {
  const run = new Run(BOX, { minutes, check: false }), map = run.calc.map.bind(run.calc);
  const n = T.close.length, ema = new Int8Array(n), macd = new Int8Array(n);
  run.calc.map = (d, i) => {
    const out = map(d, i), S = run.calc.st[i];
    ema[i] = code(S.ema, S.emaReady); macd[i] = code(S.macd, S.macdReady);
    return out;
  };
  const rows = Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] }));
  run.compute(rows);
  return { ema, macd };
}

const { bars } = loadBars("data/mnq_1m_beta.bin");
const N = bars.close.length, TS = bars.ts, H = bars.high, L = bars.low, O = bars.open, C = bars.close, TD = bars.tday, CT = bars.ctMin;
const yearOf = (ms) => new Date(ms).getUTCFullYear();

// One alert, followed: price P at the alert's close, direction d, from 1-minute bar j0 on.
function follow(j0, P, d) {
  const td = TD[j0];
  let worst = 0, race = 0;
  for (let j = j0; j < N && TD[j] === td && CT[j] < FLAT; j++) {
    const fav = d > 0 ? H[j] - P : P - L[j], adv = d > 0 ? P - L[j] : H[j] - P, advOpen = d > 0 ? P - O[j] : O[j] - P;
    if (race === 0) race = adv >= TARGET ? -1 : fav >= TARGET ? 1 : 0;
    if (fav >= TARGET) return { reached: true, minutes: (TS[j] - TS[j0]) / MIN + 1, against: Math.max(worst, adv), againstOpen: Math.max(worst, advOpen, 0), race };
    worst = Math.max(worst, adv);
  }
  return { reached: false, race };
}

// The year's tally of followed alerts.
const tally = () => ({ n: 0, reached: 0, minutes: [], against: [], againstOpen: [], race: 0 });
function add(t, r) {
  t.n++;
  if (r.race === 1) t.race++;
  if (!r.reached) return;
  t.reached++; t.minutes.push(r.minutes); t.against.push(r.against); t.againstOpen.push(r.againstOpen);
}
const q = (xs, p) => { if (!xs.length) return null; const s = Float64Array.from(xs).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const avg = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const shape = (t) => ({
  alerts: t.n, reachedPct: r1((100 * t.reached) / t.n), minutesAvg: r1(avg(t.minutes)), minutesMedian: r1(q(t.minutes, 0.5)),
  againstAvg: r1(avg(t.against)), againstMedian: r1(q(t.against, 0.5)), against90: r1(q(t.against, 0.9)), againstOpenAvg: r1(avg(t.againstOpen)),
  tenFirstPct: r1((100 * t.race) / t.n),
});

// ── the alerts on each timeframe ──
const TFS = [["1m", 1], ["5m", 5]], KINDS = ["EMA row", "MACD row", "both rows"];
const out = { alerts: {}, baseline: {} };
for (const [tfName, tf] of TFS) {
  const T = tf === 1 ? bars : resample(bars, tf), st = boxStates(T, tf);
  process.stderr.write(`  ${tfName} box computed, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  const years = {};
  for (let k = 1; k < T.close.length; k++) {
    const closeMs = T.ts[k] + tf * MIN, closeCt = (T.ctMin[k] + tf) % 1440;
    if (closeCt < FIRST || closeCt > LAST) continue;
    const e0 = side(st.ema[k - 1]), e1 = side(st.ema[k]), m0 = side(st.macd[k - 1]), m1 = side(st.macd[k]);
    const b0 = e0 && e0 === m0 ? e0 : 0, b1 = e1 && e1 === m1 ? e1 : 0;
    const fired = [e0 && e1 && e1 !== e0 ? e1 : 0, m0 && m1 && m1 !== m0 ? m1 : 0, b1 && b1 !== b0 ? b1 : 0];
    if (!fired.some(Boolean)) continue;
    const j0 = indexAtOrAfter(TS, closeMs);
    if (j0 >= N || TD[j0] !== T.tday[k]) continue;
    const y = yearOf(closeMs);
    years[y] ||= KINDS.map(() => ({ all: tally(), long: tally(), short: tally() }));
    fired.forEach((d, i) => {
      if (!d) return;
      const r = follow(j0, T.close[k], d);
      add(years[y][i].all, r); add(years[y][i][d > 0 ? "long" : "short"], r);
    });
  }
  out.alerts[tfName] = {};
  KINDS.forEach((kind, i) => {
    out.alerts[tfName][kind] = {};
    for (const y of Object.keys(years).sort()) out.alerts[tfName][kind][y] = { all: shape(years[y][i].all), long: shape(years[y][i].long), short: shape(years[y][i].short) };
  });
}
// ── the baseline: every New York minute, long and short ──
{
  const years = {};
  for (let i = 0; i + 1 < N; i++) {
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i]) continue;
    const y = yearOf(TS[i]);
    years[y] ||= { all: tally(), long: tally(), short: tally() };
    for (const d of [1, -1]) { const r = follow(i + 1, C[i], d); add(years[y].all, r); add(years[y][d > 0 ? "long" : "short"], r); }
  }
  for (const y of Object.keys(years).sort()) out.baseline[y] = { all: shape(years[y].all), long: shape(years[y].long), short: shape(years[y].short) };
}

// ── print ──
const pad = (s, w) => String(s ?? "—").padStart(w);
const head = `${"year".padEnd(6)}${pad("alerts", 8)}${pad("reach +10", 11)}${pad("min avg", 9)}${pad("min med", 9)}${pad("against avg", 13)}${pad("med", 6)}${pad("90%", 6)}${pad("open only", 11)}${pad("+10 first", 11)}`;
const line = (y, s) => `${y.padEnd(6)}${pad(s.alerts, 8)}${pad(s.reachedPct + "%", 11)}${pad(s.minutesAvg, 9)}${pad(s.minutesMedian, 9)}${pad(s.againstAvg, 13)}${pad(s.againstMedian, 6)}${pad(s.against90, 6)}${pad(s.againstOpenAvg, 11)}${pad(s.tenFirstPct + "%", 11)}`;
for (const [tfName] of TFS) for (const kind of KINDS) {
  console.log(`\n== ${tfName} ${kind}: long and short alerts together ==\n${head}`);
  for (const [y, s] of Object.entries(out.alerts[tfName][kind])) console.log(line(y, s.all));
}
console.log(`\n== the baseline: every New York minute, entered long and short ==\n${head}`);
for (const [y, s] of Object.entries(out.baseline)) console.log(line(y, s.all));
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s`);
fs.writeFileSync("research/databox_ten_points_results.json", JSON.stringify({ run: new Date().toISOString(), target: TARGET, results: out }, null, 1));
console.log("wrote research/databox_ten_points_results.json");
