// Does the VXN tell a choppy session from a trending one, over the whole day?
//
//   node --max-old-space-size=8192 research/vxn_chop_day.mjs [--placebo N]
//
// The VXN comes from data/raw/fred/VXNCLS.csv (git-ignored; see research/vxn_regime.mjs), the bars
// from data/mnq_1m_beta.bin, N defaults to 100. The results go to research/vxn_chop_day_results.json.
//
// research/vxn_regime.mjs found the VXN calls how big a session will be, but not whether its moves
// carry on over 5 to 30 minutes, nor how often the EMA 12/26 crosses in a session. A trader's
// choppy day is the whole session, though: a lot of movement that ends up nowhere. So two
// whole-session measures, both free of the session's size, on the same days (full RTH sessions
// from 2020, each labelled by the last VXN close before it, cut into thirds inside each period):
//   chop   the Choppiness Index (Dreiss) over the session's 1-minute bars: 100 x log10(the bars'
//          summed true ranges / the session's high - low) / log10(bars). High when the bars travel
//          far but the range stays narrow; low when they travel one way.
//   kept   |RTH close - RTH open| / (high - low): the share of the day's range the close kept.
//          Near 1 on a trend day, near 0 when the day ends where it began. Trend days are the
//          sessions that keep at least 0.7 of it.
// Each is judged against placebo markets (research/lib_levels.mjs placeboBars: each minute's move
// turned up-for-down at random, its size and clock kept) labelled with the same days. They give
// the gap between thirds that noise gives, and the level a market where nothing carries on gives.
//
// Named before the first run: chop, high-VXN third less low, 2026, with the same sign in each of
// its three parts (Jan-Mar, Apr-Jul 14, Jul 15-Oct 30).
//
// RESULT (run 2026-11-21: data/mnq_1m_beta.bin to Oct 30, VXN to Nov 19, 100 placebo markets): no.
// The VXN calls how big a session will be, not whether it chops.
//   - The test named first, the Choppiness Index, high-VXN third less low, 2026: -0.07, z -0.10,
//     p 0.92. Parts +1.55, +1.07, -0.29.
//   - 2026 by VXN third (low / mid / high), real against placebo markets:
//       - Choppiness Index 49.2 / 49.1 / 49.5, placebo 49.0 / 49.2 / 49.4.
//       - share of the range the close kept 0.465 / 0.488 / 0.447, placebo 0.463 / 0.456 / 0.458.
//       - trend days 20.3% / 20.3% / 24.3%, placebo 22.2% / 21.3% / 21.6% (gap z 0.8).
//       - median range 277 / 388 / 440 points.
//     A high-VXN day is about 60% bigger but no choppier or smoother, and both are as choppy as a
//     market whose minutes were turned up-for-down at random (2026 trend days 21.6%, placebo 21.7%).
//   - 2020-2025 pooled, high-VXN days kept a little more of their range: +0.036 beyond placebo,
//     z 2.2; trend days 29.4% against 24.4%, z 2.0.
//       - Inside each year it flips: trend days -7.8 to +6.4 points, none beyond 1.2 sd.
//       - The pooled gap is 2022's. It was a high-VXN year with 34.4% trend days, where the others
//         had 22.8-27.1%, and inside 2022 the high third had fewer (z -1.2).
//   - Of the 30 cells (3 measures x 5 periods, gap and correlation), three sit beyond 1.96 sd. Two
//     are the 2020-2025 pooled gaps above. The third is Jan-Mar 2026's correlation of trend days
//     with the VXN, 0.26, z 2.2; Apr-Jul 14 and Jul 15-Oct 30 give -0.01 and -0.03.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { sessionsOf } from "../src/levels.mjs";
import { placeboBars, zToP } from "./lib_levels.mjs";

const args = process.argv.slice(2), pi = args.indexOf("--placebo");
const PLACEBOS = pi >= 0 ? Number(args[pi + 1]) || 100 : 100;
const VXN_FILE = "data/raw/fred/VXNCLS.csv", BARS_FILE = "data/mnq_1m_beta.bin";
const DAY = 86400000, FULL_RTH = 385, TREND = 0.7;
const t0 = Date.now();

function readVxn(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").trim().split(/\r?\n/).slice(1)) {
    const [d, v] = line.split(","), m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((d || "").trim()), x = Number(v);
    if (m && v != null && v.trim() !== "" && v.trim() !== "." && Number.isFinite(x)) out.push({ ms: Date.UTC(+m[1], +m[2] - 1, +m[3]), v: x });
  }
  return out;
}
// the last close strictly before a trading day's date
function lastBefore(series, ms) {
  let lo = 0, hi = series.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (series[m].ms < ms) { at = m; lo = m + 1; } else hi = m - 1; }
  return at;
}

const vxn = readVxn(VXN_FILE);
const { bars } = loadBars(BARS_FILE);
const sessions = sessionsOf(bars);
// The sessions research/vxn_regime.mjs scores: full RTH sessions from 2020 that run to the 14:59 bar.
const days = [];
sessions.forEach((s, k) => {
  const ms = s.td * DAY, prev = sessions[k - 1];
  if (ms < Date.UTC(2020, 0, 1) || s.rthA < 0 || s.rthZ - s.rthA < FULL_RTH || !prev || prev.rthA < 0) return;
  if (bars.ctMin[s.rthZ - 1] !== 899) return;
  const vk = lastBefore(vxn, ms);
  if (vk >= 0) days.push({ td: s.td, ms, a: s.rthA, z: s.rthZ, vxn: vxn[vk].v, pts: s.hi - s.lo });
});

const YEARS = [2020, 2021, 2022, 2023, 2024, 2025].map((y) => [String(y), Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1)]);
const MAIN = [
  ["2020-2025", Date.UTC(2020, 0, 1), Date.UTC(2026, 0, 1)],
  ["2026 Jan-Mar", Date.UTC(2026, 0, 1), Date.UTC(2026, 3, 1)],
  ["2026 Apr-Jul 14", Date.UTC(2026, 3, 1), Date.UTC(2026, 6, 15)],
  ["2026 Jul 15-Oct 30", Date.UTC(2026, 6, 15), Infinity],
  ["2026", Date.UTC(2026, 0, 1), Infinity],
];
const PERIODS = [...MAIN, ...YEARS];
// each day's VXN third inside each period (-1: not in it), cut at the period's own thirds
const GROUP = {}, CUTS = {};
for (const [p, from, to] of PERIODS) {
  const inP = (d) => d.ms >= from && d.ms < to;
  const vals = days.filter(inP).map((d) => d.vxn).sort((a, b) => a - b);
  const c1 = vals[Math.floor(vals.length / 3)], c2 = vals[Math.floor((2 * vals.length) / 3)];
  CUTS[p] = [vals[0], c1, c2, vals[vals.length - 1]];
  GROUP[p] = Int8Array.from(days, (d) => (!inP(d) ? -1 : d.vxn < c1 ? 0 : d.vxn < c2 ? 1 : 2));
}

const MEASURES = [["chop", "Choppiness Index (high = choppy)"], ["kept", "share of the range the close kept"], ["trend", `trend days (kept >= ${TREND})`]];
// the measures of every scored session, on one set of bars (the real ones, or a placebo market)
function measure(b) {
  return days.map((d) => {
    let hi = -Infinity, lo = Infinity, tr = 0;
    for (let i = d.a; i < d.z; i++) {
      const h = b.high[i], l = b.low[i], pc = i > d.a ? b.close[i - 1] : b.open[i];
      if (h > hi) hi = h;
      if (l < lo) lo = l;
      tr += Math.max(h, pc) - Math.min(l, pc);
    }
    const rng = hi - lo;
    if (!(rng > 0)) return { chop: NaN, kept: NaN, trend: NaN };
    const kept = Math.abs(b.close[d.z - 1] - b.open[d.a]) / rng;
    return { chop: (100 * Math.log10(tr / rng)) / Math.log10(d.z - d.a), kept, trend: kept >= TREND ? 1 : 0 };
  });
}
const corr = (a, b) => { const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let ab = 0, aa = 0, bb = 0; for (let i = 0; i < n; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; } return ab / Math.sqrt(aa * bb); };
// each period's thirds' means, and each measure's correlation with the VXN across its days
function summarise(per) {
  const out = {};
  for (const [p] of PERIODS) {
    const g = GROUP[p], acc = [0, 1, 2].map(() => ({ n: 0, chop: 0, kept: 0, trend: 0 })), xs = [], ys = { chop: [], kept: [], trend: [] };
    days.forEach((d, j) => {
      const t = g[j], m = per[j];
      if (t < 0 || !Number.isFinite(m.chop)) return;
      const a = acc[t];
      a.n++;
      xs.push(d.vxn);
      for (const [k] of MEASURES) { a[k] += m[k]; ys[k].push(m[k]); }
    });
    out[p] = { thirds: acc.map((a) => ({ n: a.n, chop: a.chop / a.n, kept: a.kept / a.n, trend: a.trend / a.n })),
               corr: Object.fromEntries(MEASURES.map(([k]) => [k, corr(xs, ys[k])])) };
  }
  return out;
}

const real = summarise(measure(bars));
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  pl.push(summarise(measure(placeboBars(bars, 7000 + p))));
  if ((p + 1) % 20 === 0) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}

// ── the real gaps and correlations against the placebo markets' ──
const stats = (xs) => { const v = xs.filter(Number.isFinite), m = v.reduce((a, x) => a + x, 0) / v.length; return { mean: m, sd: Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1)) }; };
const results = {};
for (const [p] of PERIODS) {
  results[p] = {};
  for (const [m] of MEASURES) {
    const r = real[p], gap = r.thirds[2][m] - r.thirds[0][m];
    const pg = stats(pl.map((s) => s[p].thirds[2][m] - s[p].thirds[0][m])), pc = stats(pl.map((s) => s[p].corr[m]));
    const z = (gap - pg.mean) / pg.sd;
    results[p][m] = {
      gap, placeboGap: pg.mean, placeboGapSd: pg.sd, z, p: zToP(z),
      corr: r.corr[m], placeboCorr: pc.mean, placeboCorrSd: pc.sd, zCorr: (r.corr[m] - pc.mean) / pc.sd,
      thirds: [0, 1, 2].map((t) => { const ps = stats(pl.map((s) => s[p].thirds[t][m])); return { n: r.thirds[t].n, real: r.thirds[t][m], placebo: ps.mean, z: (r.thirds[t][m] - ps.mean) / ps.sd }; }),
    };
  }
}
// the median range in points of each third: the size the VXN does call, for comparison
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const rangePts = Object.fromEntries(PERIODS.map(([p]) => [p, [0, 1, 2].map((t) => med(days.filter((_, j) => GROUP[p][j] === t).map((d) => d.pts)))]));

// ── print ──
const f = (x, d = 2) => (Number.isFinite(x) ? (x >= 0 ? " " : "") + x.toFixed(d) : "   —");
const dp = (m) => (m === "chop" ? 1 : m === "kept" ? 3 : 3);
console.log(`${days.length} full sessions from 2020, ${PLACEBOS} placebo markets, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
for (const [p] of MAIN) {
  const c = CUTS[p];
  console.log(`== ${p}: VXN thirds ${c[0].toFixed(1)}-${c[1].toFixed(1)} / ${c[1].toFixed(1)}-${c[2].toFixed(1)} / ${c[2].toFixed(1)}-${c[3].toFixed(1)}, days ${real[p].thirds.map((t) => t.n).join(" / ")} ==`);
  console.log(`  ${"median range, pts".padEnd(36)} ${rangePts[p].map((x) => x.toFixed(0).padStart(8)).join("")}`);
  for (const [m, name] of MEASURES) {
    const r = results[p][m];
    console.log(`  ${name.padEnd(36)} ${r.thirds.map((t) => `${f(t.real, dp(m))}`.padStart(8)).join("")}   placebo ${r.thirds.map((t) => f(t.placebo, dp(m))).join(" /")}` +
                `   high-low beyond placebo ${f(r.gap - r.placeboGap, dp(m))} (z ${f(r.z, 1)})   corr with VXN ${f(r.corr, 3)} (placebo ${f(r.placeboCorr, 3)}, z ${f(r.zCorr, 1)})`);
  }
  console.log("");
}
console.log("Each year alone, high-VXN third less low beyond placebo (z):");
console.log(`${"".padEnd(38)}${YEARS.map(([p]) => p.padStart(16)).join("")}`);
for (const [m, name] of MEASURES) console.log(`  ${name.padEnd(36)}${YEARS.map(([p]) => { const r = results[p][m]; return `${f(r.gap - r.placeboGap, dp(m))} (${f(r.z, 1)})`.padStart(16); }).join("")}`);
const prim = results["2026"].chop, parts = ["2026 Jan-Mar", "2026 Apr-Jul 14", "2026 Jul 15-Oct 30"].map((p) => f(results[p].chop.gap - results[p].chop.placeboGap, 2));
console.log(`\nThe test named first: Choppiness Index, high-VXN third less low, 2026: ${f(prim.gap - prim.placeboGap, 2)}, z ${f(prim.z, 2)}, p ${prim.p.toFixed(3)}; parts ${parts.join(",")}`);

fs.writeFileSync("research/vxn_chop_day_results.json", JSON.stringify({ run: new Date().toISOString(), bars: BARS_FILE, vxn: VXN_FILE, placebos: PLACEBOS, days: days.length, trendCut: TREND, cuts: CUTS, rangePts, results }, null, 1));
console.log(`\nwrote research/vxn_chop_day_results.json`);
