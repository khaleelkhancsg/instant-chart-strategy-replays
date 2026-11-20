// Does the EMA + MACD databox (../TradingCustomIndicators/tradovate/emaMacdDatabox.js) predict
// the next move? On each timeframe alone and on every combination of them.
//
// The person's question (2026-11-20): use the 30-second, 1-minute and 5-minute charts, alone
// and in every combination. There are no 30-second bars here: everything held is 1-minute
// (Databento, TopstepX), and finer bars cannot be built from it. So this runs 1m and 5m
// alone and together. A 30-second series plugs in as another entry in TFS once one exists.
//
// - The box: the indicator file itself, run bar by bar through the mock of Tradovate's
//   runtime (tradovate/mock), at its defaults (EMA 9/21, MACD 12/26/9, both warnings).
//   Each row is Long, Potentially short, Short or Potentially long.
// - When it is read: at the close of every New York minute (08:30-15:00 CT) of 2026, each
//   timeframe's box as of its last CLOSED bar (a 5-minute box changes every 5 minutes).
// - What it should call: price over the next 1, 5, 15 and 30 minutes, inside the session.
// - Against what: the same box on 100 placebo markets made from these bars (each 1-minute
//   bar's direction flipped at random: the same sizes, clock and volume, nothing to
//   predict). A real effect must sit outside what they give. Every state, and every
//   combination of states across timeframes, is compared with them. The summary counts
//   are set against each placebo market judged as if it were real.
// - In three periods: Jan-Mar, Apr-Jul and Aug-Oct 2026, each alone. Cells picked on
//   Jan-Jul are read on Aug-Oct, and so are the placebo markets' picks.
// - Costs: a round trip is about 1.25 points on MNQ ($1.50 commission and a tick each
//   way), so an edge smaller than that does not pay to trade.
//
// RESULT (run 2026-11-20; 82,555 New York minutes of 2026; 100 placebo markets): the box
// does not call the next 1-30 minutes better than random markets, on 1m, on 5m, or on both.
//   - The control works. The last 5 minutes' direction shows the known reversal: -0.19 points
//     over the next minute (z -2.2) and -0.67 over the next five (z -2.0).
//   - Read as long / short, about 180 tests across the three sets. None passes |z| 2.5; two
//     reach 2.0. Trend states lean slightly the wrong way, as reversal would make them.
//   - The warnings do not call turns. After the 5m EMA row's Potentially long, price did
//     worse than after its plain Short: -1.4 points at +5 min (z -2.5) and -2.8 at +15
//     (z -1.8), lower in all three periods. That is the opposite of its name, and still
//     inside chance across this many tests.
//   - Every combination of states: 1m and 5m have 0-2 cells a horizon outside 1.96 sd,
//     where placebo markets give as many (p 0.12-1.00). 1m + 5m has 8 of 57 at +1 minute,
//     against a placebo median of 3 (p 0.04), then p 0.07, 0.35 and 0.73 at 5, 15 and 30.
//     The 10 strongest picked on Jan-Jul make +1.13 points on Aug-Oct, inside what the
//     placebo markets' picks make (-4.97 to +2.92, p 0.22).
//   - The test sees edges of 1.1-3.5 points at +15 min on one timeframe, and 2.9-8.8 on the
//     rarer 1m + 5m signals. A round trip costs 1.25, so a long-minus-short gap needs about
//     2.5 to pay.
//
//   node --max-old-space-size=8192 research/databox_predict.mjs [--placebos N]   (about a minute)

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample, sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const DAY = 86400000, MIN = 60000;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const PLACEBOS = arg("--placebos", 100);
const HORIZONS = [1, 5, 15, 30];                       // minutes ahead
const PERIODS = [["Jan-Mar", Date.UTC(2026, 0, 1)], ["Apr-Jul", Date.UTC(2026, 3, 1)], ["Aug-Oct", Date.UTC(2026, 7, 1)]];
const END = Date.UTC(2026, 10, 1);
const TFS = [{ name: "1m", min: 1 }, { name: "5m", min: 5 }];
const NT = TFS.length, NC = 25 ** NT;                  // a cell: each timeframe's (EMA, MACD) codes
const STATES = ["", "Long", "Pot. short", "Short", "Pot. long"];   // codes 1-4; 0 = warming up
const COST = 1.25;
const CONTROLS = [1, 5];                               // the control's lookbacks, minutes
const MIN_N = 300;                                     // observations a cell needs to be read

// ── the box, from the indicator's own code ──
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const rowsOf = (T) => Array.from({ length: T.close.length }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] }));
const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
function boxStates(T, minutes) {
  const run = new Run(BOX, { minutes, check: false }), map = run.calc.map.bind(run.calc);
  const n = T.close.length, ema = new Int8Array(n), macd = new Int8Array(n);
  run.calc.map = (d, i) => {
    const out = map(d, i), S = run.calc.st[i];
    ema[i] = code(S.ema, S.emaReady); macd[i] = code(S.macd, S.macdReady);
    return out;
  };
  run.compute(rowsOf(T));
  return { ema, macd };
}

// ── one market: every New York minute's joint state and what followed ──
function tablesOf(base) {
  const series = TFS.map((tf) => {
    const T = tf.min === 1 ? base : resample(base, tf.min);
    return { T, ms: tf.min * MIN, ...boxStates(T, tf.min) };
  });
  const n = base.close.length, ptr = new Int32Array(NT).fill(-1);
  const tab = HORIZONS.map(() => PERIODS.map(() => ({ n: new Float64Array(NC), s: new Float64Array(NC), q: new Float64Array(NC) })));
  // the control: the last 1 and 5 minutes' move, up or down, as the "state" (cells 1 = up, 3 = down)
  tab.control = CONTROLS.map(() => HORIZONS.map(() => PERIODS.map(() => ({ n: new Float64Array(5), s: new Float64Array(5) }))));
  const from = indexAtOrAfter(base.ts, PERIODS[0][1]);
  for (let i = 0; i < n && base.ts[i] < END; i++) {
    // each timeframe's last closed bar at this minute's close
    for (let t = 0; t < NT; t++) {
      const S = series[t];
      while (ptr[t] + 1 < S.T.close.length && S.T.ts[ptr[t] + 1] + S.ms <= base.ts[i] + MIN) ptr[t]++;
    }
    if (i < from || base.ctMin[i] < 510 || base.ctMin[i] >= 900) continue;
    let cell = 0, ok = true;
    for (let t = 0; t < NT; t++) {
      const S = series[t], k = ptr[t], e = k >= 0 ? S.ema[k] : 0, m = k >= 0 ? S.macd[k] : 0;
      if (!e || !m) { ok = false; break; }
      cell = cell * 25 + e * 5 + m;
    }
    if (!ok) continue;
    let p = PERIODS.length - 1;
    while (p > 0 && base.ts[i] < PERIODS[p][1]) p--;
    const past = CONTROLS.map((k) => (i >= k && base.ts[i - k] === base.ts[i] - k * MIN && base.tday[i - k] === base.tday[i]
      ? Math.sign(base.close[i] - base.close[i - k]) : 0));
    HORIZONS.forEach((h, hi) => {
      const j = i + h;
      if (j >= n || base.ts[j] !== base.ts[i] + h * MIN || base.tday[j] !== base.tday[i] || base.ctMin[j] >= 900) return;
      const r = base.close[j] - base.close[i], c = tab[hi][p];
      c.n[cell]++; c.s[cell] += r; c.q[cell] += r * r;
      past.forEach((sg, k) => { if (sg) { const x = tab.control[k][hi][p], at = sg > 0 ? 1 : 3; x.n[at]++; x.s[at] += r; } });
    });
  }
  return tab;
}

// ── reading the tables ──
// The codes of a cell: [e1, m1, e5, m5] for TFS = [1m, 5m].
const codesOf = (cell) => { const out = new Array(2 * NT); for (let t = NT - 1; t >= 0; t--) { out[2 * t + 1] = cell % 5; cell = Math.floor(cell / 5); out[2 * t] = cell % 5; cell = Math.floor(cell / 5); } return out; };
const CODES = Array.from({ length: NC }, (_, c) => codesOf(c));
// Sum a table's cells that pass `pred` over horizons hi and periods ps.
function agg(tab, hi, ps, pred) {
  let n = 0, s = 0;
  for (const p of ps) { const c = tab[hi][p]; for (let k = 0; k < NC; k++) if (c.n[k] && pred(CODES[k])) { n += c.n[k]; s += c.s[k]; } }
  return { n, s };
}
const ALL = PERIODS.map((_, p) => p);
const mean = (a) => (a.n ? a.s / a.n : NaN);

// The timeframe sets: every non-empty combination.
const SETS = [];
for (let mask = 1; mask < 1 << NT; mask++) SETS.push(TFS.map((tf, t) => (mask >> t) & 1 ? t : -1).filter((t) => t >= 0));
const setName = (S) => S.map((t) => TFS[t].name).join(" + ");

// The signals each set is read as: long when every chosen row on every timeframe says so.
const rowsIn = (S, which) => S.flatMap((t) => (which === "ema" ? [2 * t] : which === "macd" ? [2 * t + 1] : [2 * t, 2 * t + 1]));
function signals(S) {
  const out = [];
  for (const [which, label] of [["both", "both rows"], ["ema", "EMA row"], ["macd", "MACD row"]]) {
    const R = rowsIn(S, which);
    out.push({ name: `${label}: all Long vs all Short`, long: (c) => R.every((r) => c[r] === 1), short: (c) => R.every((r) => c[r] === 3) });
    out.push({ name: `${label}: long side vs short side`, long: (c) => R.every((r) => c[r] === 1 || c[r] === 2), short: (c) => R.every((r) => c[r] === 3 || c[r] === 4) });
  }
  // the warnings: a row's Potentially short against its plain Long (and the mirror), the other codes free
  for (const t of S) for (const [r, label] of [[2 * t, `${TFS[t].name} EMA`], [2 * t + 1, `${TFS[t].name} MACD`]]) {
    out.push({ name: `${label}: Pot. long vs Short (the warning, short side)`, long: (c) => c[r] === 4, short: (c) => c[r] === 3 });
    out.push({ name: `${label}: Long vs Pot. short (the warning, long side)`, long: (c) => c[r] === 1, short: (c) => c[r] === 2 });
  }
  // across timeframes: the higher one's box Long on both rows while the lower one's MACD turns
  if (S.length > 1) {
    const hi = S[S.length - 1], lo = S[0];
    out.push({ name: `${TFS[hi].name} both Long + ${TFS[lo].name} MACD Pot. long (pullback ending), mirrored`,
      long: (c) => c[2 * hi] === 1 && c[2 * hi + 1] === 1 && c[2 * lo + 1] === 4,
      short: (c) => c[2 * hi] === 3 && c[2 * hi + 1] === 3 && c[2 * lo + 1] === 2 });
    out.push({ name: `${TFS[hi].name} both Long + ${TFS[lo].name} both Pot. long, mirrored`,
      long: (c) => c[2 * hi] === 1 && c[2 * hi + 1] === 1 && c[2 * lo] === 4 && c[2 * lo + 1] === 4,
      short: (c) => c[2 * hi] === 3 && c[2 * hi + 1] === 3 && c[2 * lo] === 2 && c[2 * lo + 1] === 2 });
  }
  return out;
}
// A signal's edge: what followed its longs minus what followed its shorts (drift-free), points.
function edge(tab, hi, ps, sig) {
  const L = agg(tab, hi, ps, sig.long), Sh = agg(tab, hi, ps, sig.short);
  return { e: L.n >= MIN_N && Sh.n >= MIN_N ? mean(L) - mean(Sh) : NaN, nl: L.n, ns: Sh.n, ml: mean(L), ms: mean(Sh) };
}
// A set's cells: the distinct states of its rows, each against the minute's average.
function cellsOf(S) {
  const R = rowsIn(S, "both"), keys = new Map();
  for (let k = 0; k < NC; k++) {
    const c = CODES[k];
    if (c.some((x) => x === 0)) continue;
    const key = R.map((r) => c[r]).join("");
    if (!keys.has(key)) keys.set(key, R.map((r) => c[r]));
  }
  return [...keys.entries()].map(([key, vals]) => ({ key, vals, pred: (c) => R.every((r, j) => c[r] === vals[j]) }));
}
function excess(tab, hi, ps, cell) {
  const a = agg(tab, hi, ps, cell.pred), all = agg(tab, hi, ps, () => true);
  return { e: a.n >= MIN_N ? mean(a) - mean(all) : NaN, n: a.n };
}

// ── run ──
const t0 = Date.now(), sec = () => Math.round((Date.now() - t0) / 1000);
const FB = loadBars("data/mnq_1m_beta.bin").bars;
const BASE = sliceBars(FB, indexAtOrAfter(FB.ts, Date.UTC(2025, 10, 1)), FB.count);
console.log(`Bars: ${new Date(BASE.ts[0]).toISOString().slice(0, 10)} to ${new Date(BASE.ts[BASE.close.length - 1]).toISOString().slice(0, 10)} (1-minute; warm-up from Nov 2025); timeframes ${TFS.map((t) => t.name).join(", ")}; ${PLACEBOS} placebo markets`);
const REAL = tablesOf(BASE);
const PL = [];
for (let k = 1; k <= PLACEBOS; k++) { PL.push(tablesOf(placeboBars(BASE, k))); if (k % 10 === 0) console.log(`  ${k} placebo markets (${sec()} s)`); }
const nAll = HORIZONS.map((_, hi) => agg(REAL, hi, ALL, () => true).n);
console.log(`New York minutes read: ${nAll.map((n, hi) => `${n.toLocaleString("en-US")} at +${HORIZONS[hi]} min`).join(", ")}\n`);

const stats = (real, pl) => {
  const v = pl.filter(Number.isFinite), m = v.reduce((a, x) => a + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, v.length - 1));
  const p = (1 + v.filter((x) => Math.abs(x - m) >= Math.abs(real - m)).length) / (1 + v.length);
  return { c: real - m, z: sd > 0 ? (real - m) / sd : NaN, sd, p, m };
};
const f2 = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "  -  ");
const OUT = { run: new Date().toISOString(), timeframes: TFS.map((t) => t.name), horizons: HORIZONS, periods: PERIODS.map((p) => p[0]), placebos: PLACEBOS, sets: [], control: [] };

// The control first: can this test see a real effect? Short-term reversal is one the lab has
// measured before (research/regime_bias.mjs), so the last minutes' direction should show it.
console.log("Control: the last 1 and 5 minutes up minus down, points over the next 1 / 5 / 15 / 30 minutes, real (beyond placebo) [z]");
CONTROLS.forEach((k, ki) => {
  const ctrl = (T, hi, ps) => { let nu = 0, su = 0, nd = 0, sd = 0; for (const p of ps) { const x = T.control[ki][hi][p]; nu += x.n[1]; su += x.s[1]; nd += x.n[3]; sd += x.s[3]; } return nu && nd ? su / nu - sd / nd : NaN; };
  const row = HORIZONS.map((h, hi) => { const r = ctrl(REAL, hi, ALL), st = stats(r, PL.map((T) => ctrl(T, hi, ALL))); return { h, e: r, c: st.c, z: st.z, p: st.p }; });
  OUT.control.push({ lookback: k, h: row });
  console.log(`  last ${k} minute${k > 1 ? "s" : " "} ${row.map((x) => `${f2(x.e)} (${f2(x.c)}) [${x.z.toFixed(1)}]`).join("  ")}`);
});
console.log("");

for (const S of SETS) {
  const name = setName(S), rec = { set: name, signals: [], scan: [] };
  console.log(`════ ${name} ════`);
  // 1. the signals
  console.log("  signals: long minus short, points over the next 1 / 5 / 15 / 30 minutes; real (beyond placebo) [z], then the beyond-placebo by period at +15");
  for (const sig of signals(S)) {
    const row = { name: sig.name, h: [] };
    const cells = HORIZONS.map((h, hi) => {
      const r = edge(REAL, hi, ALL, sig), st = stats(r.e, PL.map((T) => edge(T, hi, ALL, sig).e));
      const per = PERIODS.map((_, p) => { const rp = edge(REAL, hi, [p], sig); return rp.e - PL.map((T) => edge(T, hi, [p], sig).e).filter(Number.isFinite).reduce((a, x, _, arr) => a + x / arr.length, 0); });
      // the smallest edge this test would call (1.96 placebo sd), to set against costs
      row.h.push({ h, e: r.e, nl: r.nl, ns: r.ns, c: st.c, z: st.z, p: st.p, per, detectable: 1.96 * st.sd });
      return `${f2(r.e)} (${f2(st.c)}) [${Number.isFinite(st.z) ? st.z.toFixed(1) : "-"}]`;
    });
    const at15 = row.h[2];
    console.log(`  ${sig.name.padEnd(64)} ${cells.join("  ")}   ${at15.per.map(f2).join(" / ")}   n ${at15.nl.toLocaleString("en-US")} / ${at15.ns.toLocaleString("en-US")}` +
                `   sees ${Number.isFinite(at15.detectable) ? at15.detectable.toFixed(1) : "-"}`);
    rec.signals.push(row);
  }
  // 2. every state of the set's rows: how many sit outside the placebo markets, against chance
  const cells = cellsOf(S);
  console.log(`  every state (${cells.length} cells, at least ${MIN_N} minutes each):`);
  for (let hi = 0; hi < HORIZONS.length; hi++) {
    const realE = cells.map((c) => excess(REAL, hi, ALL, c).e), plE = PL.map((T) => cells.map((c) => excess(T, hi, ALL, c).e));
    const mu = cells.map((_, j) => plE.reduce((a, r) => a + (Number.isFinite(r[j]) ? r[j] : 0), 0) / plE.filter((r) => Number.isFinite(r[j])).length);
    const sdv = cells.map((_, j) => { const v = plE.map((r) => r[j]).filter(Number.isFinite); return Math.sqrt(v.reduce((a, x) => a + (x - mu[j]) ** 2, 0) / Math.max(1, v.length - 1)); });
    const z = (vals) => vals.map((v, j) => (Number.isFinite(v) && sdv[j] > 0 ? (v - mu[j]) / sdv[j] : NaN));
    const count = (zs) => zs.filter((x) => Math.abs(x) >= 1.96).length;
    const realZ = z(realE), realCount = count(realZ);
    // each placebo market judged against the others, as if it were real
    const nullCounts = plE.map((r, k) => {
      const others = plE.filter((_, j) => j !== k);
      return count(r.map((v, j) => { const o = others.map((x) => x[j]).filter(Number.isFinite), m = o.reduce((a, x) => a + x, 0) / o.length, sd = Math.sqrt(o.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, o.length - 1)); return Number.isFinite(v) && sd > 0 ? (v - m) / sd : NaN; }));
    });
    const p = (1 + nullCounts.filter((x) => x >= realCount).length) / (1 + nullCounts.length);
    const readable = realE.filter(Number.isFinite).length;
    // consistent: outside 1.96 overall and the same sign in all three periods
    const perE = PERIODS.map((_, pp) => cells.map((c) => excess(REAL, hi, [pp], c).e - PL.map((T) => excess(T, hi, [pp], c).e).filter(Number.isFinite).reduce((a, x, _, arr) => a + x / arr.length, 0)));
    const steady = cells.map((c, j) => Math.abs(realZ[j]) >= 1.96 && perE.every((pe) => Math.sign(pe[j]) === Math.sign(realZ[j]))).reduce((a, x) => a + x, 0);
    const big = cells.map((c, j) => ({ c, j, z: realZ[j], e: realE[j] - mu[j], n: excess(REAL, hi, ALL, c).n })).filter((x) => Number.isFinite(x.z)).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 3);
    const label = (x) => x.c.vals.map((v, k) => `${TFS[S[k >> 1]].name} ${k % 2 ? "MACD" : "EMA"} ${STATES[v]}`).join(", ");
    console.log(`    +${String(HORIZONS[hi]).padStart(2)} min: ${readable} readable, ${realCount} outside 1.96 sd (placebo markets: ${Math.min(...nullCounts)}-${Math.max(...nullCounts)}, median ${nullCounts.slice().sort((a, b) => a - b)[nullCounts.length >> 1]}; p ${p.toFixed(2)}); ${steady} also the same sign in all three periods`);
    for (const x of big) console.log(`        ${label(x).padEnd(80)} ${f2(x.e)} pts beyond placebo, z ${x.z.toFixed(1)}, n ${x.n.toLocaleString("en-US")}`);
    rec.scan.push({ h: HORIZONS[hi], readable, outside: realCount, nullMin: Math.min(...nullCounts), nullMax: Math.max(...nullCounts), p, steady, top: big.map((x) => ({ state: label(x), beyond: x.e, z: x.z, n: x.n })) });
  }
  // 3. chosen on Jan-Jul, read on Aug-Oct: the 10 strongest cells at +15, against the same done on placebo markets
  const hi = 2, AB = [0, 1], C = [2];
  const pick = (T, others) => {
    const sc = cells.map((c) => {
      const e = excess(T, hi, AB, c).e, o = others.map((X) => excess(X, hi, AB, c).e).filter(Number.isFinite);
      const m = o.reduce((a, x) => a + x, 0) / o.length, sd = Math.sqrt(o.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, o.length - 1));
      return { c, z: Number.isFinite(e) && sd > 0 ? (e - m) / sd : NaN };
    }).filter((x) => Number.isFinite(x.z)).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 10);
    // their Aug-Oct excess, signed the way Jan-Jul called it, beyond the others' mean on Aug-Oct
    const v = sc.map((x) => { const e = excess(T, hi, C, x.c).e, o = others.map((X) => excess(X, hi, C, x.c).e).filter(Number.isFinite); return Number.isFinite(e) ? Math.sign(x.z) * (e - o.reduce((a, y) => a + y, 0) / o.length) : NaN; }).filter(Number.isFinite);
    return v.length ? v.reduce((a, x) => a + x, 0) / v.length : NaN;
  };
  const realOos = pick(REAL, PL), nullOos = PL.map((T, k) => pick(T, PL.filter((_, j) => j !== k)));
  const pOos = (1 + nullOos.filter((x) => x >= realOos).length) / (1 + nullOos.length);
  console.log(`  chosen on Jan-Jul, read on Aug-Oct (the 10 strongest states at +15 min): ${f2(realOos)} pts in the called direction; placebo markets' picks ${f2(Math.min(...nullOos))} to ${f2(Math.max(...nullOos))}, p ${pOos.toFixed(2)}\n`);
  rec.outOfSample = { picked: 10, h: 15, real: realOos, nullMin: Math.min(...nullOos), nullMax: Math.max(...nullOos), p: pOos };
  OUT.sets.push(rec);
}
fs.writeFileSync("research/databox_predict_results.json", JSON.stringify(OUT));
console.log(`(${sec()} s; research/databox_predict_results.json)`);
