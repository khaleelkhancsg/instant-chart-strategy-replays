// Do VXN's levels tell MNQ's trend days from its chop days?
//
//   node --max-old-space-size=8192 research/vxn_regime.mjs [VXN csv] [bars file] [--placebo N]
//
// The VXN csv defaults to data/raw/fred/VXNCLS.csv, the bars to data/mnq_1m_beta.bin, N to 100.
// The results go to research/vxn_regime_results.json as well.
//
// Dealer gamma is said to decide whether a day's moves keep going or fade. Dealers short gamma
// hedge with the move and dealers long gamma against it. Baltussen et al. (2021, papers/) found
// the last half hour followed the day only on short-gamma days. Gamma data costs money, but a
// GEX vendor's own 8-year test found implied volatility carries most of what it says. The
// Nasdaq-100's implied volatility, the VXN, is free: FRED series VXNCLS, Cboe's daily close
// reprinted with permission, saved to data/raw/fred/ (git-ignored). So the question: on days
// the VXN stood high, do MNQ's moves keep going more, and do EMA 12/26 crosses follow through?
//
// Each full RTH session (08:30-15:00 CT, early closes left out) is labelled by the last VXN
// close before it, the one a trader has before the open, and the days of each period are cut
// into thirds by it: low, middle, high. (Thirds of each close's standing among the 252 before it
// are a label too, but they can hardly split 2026: the VXN stood higher than in 2025 almost all
// year, so nearly every 2026 day lands in the top third.) Two more labels, for comparison: the
// VXN against its own 20-day mean (rising or falling), and the 10-session average range, the
// realised volatility the lab's gates already read.
//
// Measured per session, on the 1-minute bars:
//   VR q       the variance ratio: the q-minute moves' squares over the 1-minute moves' squares.
//              1 when moves neither carry on nor reverse, above 1 when they carry on.
//   crosses    how often the 1-minute (5-minute) EMA 12 and EMA 26 crossed in the session.
//   cross +30  after each cross, the next 30 minutes' move the cross's way, in points.
//   last 30    the 14:30-15:00 move, the way the day had gone since the prior 15:00 close, points.
//
// Each is judged against placebo markets (research/lib_levels.mjs placeboBars: each minute's move
// turned up-for-down at random, its size and clock kept) labelled with the same days. Nothing
// carries on in them, so the high-minus-low gap they give is the gap noise gives.
//
// Named before the first full run: the 15-minute variance ratio, high-VXN third less low, in
// 2026, with the same sign in each of its three parts. Everything else is read through the count
// of gaps beyond 1.96 sd against the count each placebo market gets.
//
// Added after that run: the VIX term structure, the 1-month VIX over the 3-month (FRED VIXCLS and
// VXVCLS, saved beside the VXN). It is the shape of fear rather than its level: near or above 1
// the near term is priced as the danger, as in a sell-off, when dealers are said to be short gamma.
// Its thirds are cut inside each period like the VXN's. Named before its run: the 15-minute
// variance ratio, the flattest third (highest ratio) less the steepest, in 2026, with the same
// sign in each of its three parts.
//
// RESULT (run 2026-11-21: data/mnq_1m_beta.bin to Oct 30, VXN to Nov 19, 100 placebo markets): the
// VXN does not tell MNQ's trend days from its chop days.
//   - The test named first, the 15-minute variance ratio, high-VXN third less low, 2026: +0.088,
//     z 1.5, p 0.13. Not steady inside the year: Jan-Mar -0.004, Apr-Jul 14 +0.043, Jul 15-Oct 30
//     +0.093.
//   - Of the VXN labels' gaps, the level's has 3 of 40 beyond 1.96 sd, where placebo markets get a
//     median of 2 (39% get at least 3). Of all 200 gaps (5 labels with the term structure, 5
//     periods, 8 measures), 11 sit beyond 1.96 sd. A placebo market judged the same way gets 3-24,
//     median 10, and 38% of them get at least 11.
//   - EMA 12/26 crosses in 2026:
//       - after a 1-minute cross, the next 30 minutes went +1.3 points the cross's way on high-VXN
//         days and -1.8 on low ones (gap z 1.4);
//       - for 5-minute crosses the gap is negative (z -0.3);
//       - crosses a session hardly differ (13.9 against 13.8).
//   - The paper's own effect, the last half hour carrying on the day's move, shows on 2020-2025
//     pooled: +8.7 points, z 3.1. But that is the years, not the VXN.
//       - About 400 of the pooled top third's 500 days are 2020's and 2022's; its bottom third is
//         mostly 2023-2025's.
//       - Split inside each year it goes +12.4, +1.6, -3.4, +7.2, -3.5, -13.1 points (2020-2025),
//         none beyond 1.96 sd.
//       - 2026: +14.3 (z 1.3), but -7.5 in Apr-Jul 14.
//   - The standing among the 252 closes before, the label a trader has at the open, can hardly
//     split 2026: 116 of its 208 days are in the top third and none of Apr-Jul 14's in the bottom.
//   - The realised range does no better than the VXN: 3 of 40 gaps each, placebo median 2.
//   - Nor does the VIX term structure.
//       - Its named test, the flattest third less the steepest, 2026: +0.031, z 0.5, p 0.64 (parts
//         +0.085, +0.092, +0.008).
//       - 1 of its 40 gaps beyond 1.96 sd, placebo median 2.
//       - Only 10 of 2026's sessions opened inverted (VIX at or above VIX3M), 9 of them in Jan-Mar;
//         2020-2025 had 103. Too few to judge an inverted-day rule on 2026.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { sessionsOf, adrOf } from "../src/levels.mjs";
import { ema } from "../src/indicators.mjs";
import { placeboBars, zToP } from "./lib_levels.mjs";

const args = process.argv.slice(2), pi = args.indexOf("--placebo");
const PLACEBOS = pi >= 0 ? Number(args[pi + 1]) || 100 : 100;
const pos = args.filter((a, k) => !a.startsWith("--") && (pi < 0 || k !== pi + 1));
const VXN_FILE = pos[0] || "data/raw/fred/VXNCLS.csv", BARS_FILE = pos[1] || "data/mnq_1m_beta.bin";
const VIX_FILE = "data/raw/fred/VIXCLS.csv", VIX3M_FILE = "data/raw/fred/VXVCLS.csv";
const DAY = 86400000, LOOK = 252, FULL_RTH = 385, FWD1 = 30, FWD5 = 6;
const t0 = Date.now();

// ── the VXN, and where each close stood among the 252 before it ──
function readVxn(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").trim().split(/\r?\n/).slice(1)) {
    const [d, v] = line.split(","), m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((d || "").trim()), x = Number(v);
    if (m && v != null && v.trim() !== "" && v.trim() !== "." && Number.isFinite(x)) out.push({ ms: Date.UTC(+m[1], +m[2] - 1, +m[3]), v: x });
  }
  return out;
}
// the share of the `look` values before k that are below vals[k]
function standing(vals, look) {
  const out = new Float64Array(vals.length).fill(NaN);
  for (let k = look; k < vals.length; k++) {
    if (!Number.isFinite(vals[k])) continue;
    let below = 0, seen = 0;
    for (let j = k - look; j < k; j++) if (Number.isFinite(vals[j])) { seen++; if (vals[j] < vals[k]) below++; }
    if (seen >= look * 0.9) out[k] = below / seen;
  }
  return out;
}
const third = (r) => (Number.isFinite(r) ? (r < 1 / 3 ? 0 : r < 2 / 3 ? 1 : 2) : -1);

const vxn = readVxn(VXN_FILE), vv = vxn.map((x) => x.v);
const vs = standing(vv, LOOK);
const vchg = vv.map((v, k) => { if (k < 19) return NaN; let s = 0; for (let j = k - 19; j <= k; j++) s += vv[j]; return v / (s / 20) - 1; });
// the last close strictly before a trading day's date
function lastBefore(series, ms) {
  let lo = 0, hi = series.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (series[m].ms < ms) { at = m; lo = m + 1; } else hi = m - 1; }
  return at;
}
const vxnBefore = (ms) => lastBefore(vxn, ms);
// The VIX term structure, the 1-month VIX over the 3-month, on the dates both closed.
const term = fs.existsSync(VIX_FILE) && fs.existsSync(VIX3M_FILE) ? (() => {
  const v3 = new Map(readVxn(VIX3M_FILE).map((x) => [x.ms, x.v]));
  return readVxn(VIX_FILE).filter((x) => v3.has(x.ms)).map((x) => ({ ms: x.ms, v: x.v / v3.get(x.ms) }));
})() : null;

// ── the bars, the sessions and the days scored ──
const { bars } = loadBars(BARS_FILE);
const sessions = sessionsOf(bars), adr = adrOf(sessions);
const days = [];
sessions.forEach((s, k) => {
  const ms = s.td * DAY, prev = sessions[k - 1];
  if (ms < Date.UTC(2020, 0, 1) || s.rthA < 0 || s.rthZ - s.rthA < FULL_RTH || !prev || prev.rthA < 0) return;
  let l30 = -1;                                    // the bar that closes at 14:30
  for (let i = s.rthA; i < s.rthZ; i++) if (bars.ctMin[i] < 870) l30 = i;
  if (l30 < 0 || bars.ctMin[s.rthZ - 1] !== 899) return;
  const vk = vxnBefore(ms), tk = term ? lastBefore(term, ms) : -1;
  days.push({ td: s.td, ms, a: s.rthA, z: s.rthZ, pc: prev.rthZ - 1, l30, vxn: vk >= 0 ? vv[vk] : NaN,
              raw: { level: vk >= 0 ? vv[vk] : NaN, stand: vk >= 0 ? vs[vk] : NaN, rising: vk >= 0 ? vchg[vk] : NaN, range: adr[k],
                     term: tk >= 0 ? term[tk].v : NaN } });
});
const dayOf = new Map(days.map((d, j) => [d.td, j]));
const LABELS = [["level", "VXN level, thirds of each period"], ["stand", "VXN standing among the 252 closes before (known at the open)"],
                ["rising", "VXN against its 20-day mean, thirds of each period"], ["range", "10-session average range (realised), thirds of each period"],
                ...(term ? [["term", "VIX over VIX3M (term structure; high = flat or inverted), thirds of each period"]] : [])];
const PERIODS = [
  ["2020-2025", Date.UTC(2020, 0, 1), Date.UTC(2026, 0, 1)],
  ["2026 Jan-Mar", Date.UTC(2026, 0, 1), Date.UTC(2026, 3, 1)],
  ["2026 Apr-Jul 14", Date.UTC(2026, 3, 1), Date.UTC(2026, 6, 15)],
  ["2026 Jul 15-Oct 30", Date.UTC(2026, 6, 15), Infinity],
  ["2026", Date.UTC(2026, 0, 1), Infinity],
];
// Each year of 2020-2025 alone, to see whether a 2020-2025 gap is one year's. Context only: they
// stay out of the count of gaps beyond 1.96 sd.
const YEARS = [2020, 2021, 2022, 2023, 2024, 2025].map((y) => [String(y), Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1)]);
const MAIN = new Set(PERIODS.map(([p]) => p));
PERIODS.push(...YEARS);
// Each day's third, for each label and period (-1: not in the period, or no reading). The cut
// points are the period's own, except for the standing, whose thirds are fixed.
const GROUP = {};
for (const [lab] of LABELS) for (const [pname, from, to] of PERIODS) {
  const inP = (d) => d.ms >= from && d.ms < to && Number.isFinite(d.raw[lab]);
  const vals = days.filter(inP).map((d) => d.raw[lab]).sort((a, b) => a - b);
  const c1 = vals[Math.floor(vals.length / 3)], c2 = vals[Math.floor((2 * vals.length) / 3)];
  GROUP[`${lab}|${pname}`] = Int8Array.from(days, (d) => (!inP(d) ? -1 : lab === "stand" ? third(d.raw[lab]) : d.raw[lab] < c1 ? 0 : d.raw[lab] < c2 ? 1 : 2));
}
const MEASURES = [["vr5", "VR 5 min"], ["vr15", "VR 15 min"], ["vr30", "VR 30 min"], ["x1", "1m crosses a session"], ["x5", "5m crosses a session"],
                  ["f1", "1m cross +30 min, pts"], ["f5", "5m cross +30 min, pts"], ["lh", "last 30 min with the day, pts"]];

// ── everything measured on one set of bars (the real ones, or a placebo market) ──
function measure(b) {
  const C = b.close, e12 = ema(C, 12), e26 = ema(C, 26);
  const t5 = resample(b, 5), c5 = t5.close, g12 = ema(c5, 12), g26 = ema(c5, 26);
  const per = days.map(() => ({ vr5: NaN, vr15: NaN, vr30: NaN, x1: 0, x5: 0, f1s: 0, f1n: 0, f5s: 0, f5n: 0, lh: NaN }));
  days.forEach((d, j) => {
    const p = per[j], L = d.z - d.a - 1;
    for (const q of [5, 15, 30]) {
      const nb = Math.floor(L / q);
      let ss = 0, bs = 0;
      for (let k = 0; k < nb; k++) {
        let s = 0;
        for (let t = d.a + 1 + k * q, e = t + q; t < e; t++) { const r = C[t] - C[t - 1]; s += r; ss += r * r; }
        bs += s * s;
      }
      if (ss > 0) p[`vr${q}`] = bs / ss;
    }
    for (let t = d.a + 1; t < d.z; t++) {
      const u = e12[t] - e26[t], w = e12[t - 1] - e26[t - 1];
      if (!(u * w < 0)) continue;
      p.x1++;
      if (t + FWD1 < d.z) { p.f1s += Math.sign(u) * (C[t + FWD1] - C[t]); p.f1n++; }
    }
    const rod = C[d.l30] - C[d.pc];
    if (rod !== 0) p.lh = Math.sign(rod) * (C[d.z - 1] - C[d.l30]);
  });
  for (let k = 1; k < c5.length; k++) {
    const ct = t5.ctMin[k];
    if (ct < 510 || ct >= 900) continue;
    const j = dayOf.get(t5.tday[k]);
    if (j === undefined) continue;
    const u = g12[k] - g26[k], w = g12[k - 1] - g26[k - 1];
    if (!(u * w < 0)) continue;
    per[j].x5++;
    const f = k + FWD5;
    if (f < c5.length && t5.tday[f] === t5.tday[k] && t5.ctMin[f] < 900) { per[j].f5s += Math.sign(u) * (c5[f] - c5[k]); per[j].f5n++; }
  }
  return per;
}

// the three thirds' means of every measure, for each label and period
function summarise(per) {
  const out = {};
  for (const [lab] of LABELS) for (const [pname] of PERIODS) {
    const g = [0, 1, 2].map(() => ({ n: 0, vr5: 0, vr15: 0, vr30: 0, x1: 0, x5: 0, f1s: 0, f1n: 0, f5s: 0, f5n: 0, lh: 0, lhn: 0, vrn: 0 }));
    const grp = GROUP[`${lab}|${pname}`];
    days.forEach((d, j) => {
      const t = grp[j];
      if (t < 0) return;
      const s = g[t], p = per[j];
      s.n++; s.x1 += p.x1; s.x5 += p.x5; s.f1s += p.f1s; s.f1n += p.f1n; s.f5s += p.f5s; s.f5n += p.f5n;
      if (Number.isFinite(p.vr15)) { s.vr5 += p.vr5; s.vr15 += p.vr15; s.vr30 += p.vr30; s.vrn++; }
      if (Number.isFinite(p.lh)) { s.lh += p.lh; s.lhn++; }
    });
    out[`${lab}|${pname}`] = g.map((s) => ({
      n: s.n, vr5: s.vr5 / s.vrn, vr15: s.vr15 / s.vrn, vr30: s.vr30 / s.vrn, x1: s.x1 / s.n, x5: s.x5 / s.n,
      f1: s.f1s / s.f1n, f1n: s.f1n, f5: s.f5s / s.f5n, f5n: s.f5n, lh: s.lh / s.lhn,
    }));
  }
  return out;
}

const real = summarise(measure(bars));
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  pl.push(summarise(measure(placeboBars(bars, 7000 + p))));
  if ((p + 1) % 20 === 0) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}

// ── the real gaps against the placebo markets' ──
const stats = (xs) => { const v = xs.filter(Number.isFinite), m = v.reduce((a, x) => a + x, 0) / v.length; return { mean: m, sd: Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1)) }; };
const results = {};
for (const key of Object.keys(real)) {
  results[key] = {};
  for (const [m] of MEASURES) {
    const r = real[key], gap = r[2][m] - r[0][m];
    const pg = stats(pl.map((s) => s[key][2][m] - s[key][0][m]));
    const thirds = [0, 1, 2].map((t) => { const ps = stats(pl.map((s) => s[key][t][m])); return { real: r[t][m], placebo: ps.mean, z: (r[t][m] - ps.mean) / ps.sd }; });
    const z = (gap - pg.mean) / pg.sd;
    const beyond = pl.filter((s) => Math.abs(s[key][2][m] - s[key][0][m] - pg.mean) >= Math.abs(gap - pg.mean)).length;
    results[key][m] = { gap, placeboGap: pg.mean, z, p: zToP(z), pRank: (beyond + 1) / (PLACEBOS + 1), thirds, n: r.map((t) => t.n) };
  }
}

// How many gaps sit beyond 1.96 placebo standard deviations, against how many a placebo market
// gets when it is judged the same way against the other placebo markets: the count noise gives.
const counts = {};
for (const [lab] of [...LABELS, ["all"]]) {
  const keys = Object.keys(real).filter((k) => MAIN.has(k.split("|")[1]) && (lab === "all" || k.startsWith(`${lab}|`)));
  const realN = keys.reduce((a, k) => a + MEASURES.filter(([m]) => Math.abs(results[k][m].z) >= 1.96).length, 0);
  const plN = pl.map((_, p) => keys.reduce((a, k) => a + MEASURES.filter(([m]) => {
    const others = stats(pl.filter((__, q) => q !== p).map((s) => s[k][2][m] - s[k][0][m]));
    return Math.abs((pl[p][k][2][m] - pl[p][k][0][m] - others.mean) / others.sd) >= 1.96;
  }).length, 0)).sort((a, b) => a - b);
  counts[lab] = { cells: keys.length * MEASURES.length, real: realN, placeboMedian: plN[Math.floor(plN.length / 2)],
                  placeboRange: [plN[0], plN[plN.length - 1]], pAtLeast: plN.filter((x) => x >= realN).length / plN.length };
}

// ── print ──
const f = (x, d = 2) => (Number.isFinite(x) ? (x >= 0 ? " " : "") + x.toFixed(d) : "   —");
const y26 = days.filter((d) => d.ms >= Date.UTC(2026, 0, 1)).map((d) => d.vxn).filter(Number.isFinite).sort((a, b) => a - b);
console.log(`VXN before each 2026 session: ${y26.length} days, low ${y26[0]}, median ${y26[Math.floor(y26.length / 2)]}, high ${y26[y26.length - 1]}`);
console.log(`${days.length} full sessions from 2020, ${PLACEBOS} placebo markets, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
const SHOWN = PERIODS.filter(([p]) => MAIN.has(p));
for (const [lab, title] of LABELS) {
  console.log(`== ${title}: top third less bottom third, real (z against ${PLACEBOS} placebo markets) ==`);
  console.log(`${"".padEnd(30)}${SHOWN.map(([p]) => p.padStart(20)).join("")}`);
  console.log(`${"days, bottom / top".padEnd(30)}${SHOWN.map(([p]) => { const n = results[`${lab}|${p}`].vr15.n; return `${n[0]} / ${n[2]}`.padStart(20); }).join("")}`);
  for (const [m, name] of MEASURES) {
    console.log(`${name.padEnd(30)}${SHOWN.map(([p]) => { const r = results[`${lab}|${p}`][m]; return `${f(r.gap - r.placeboGap, m.startsWith("vr") ? 3 : 2)} (${f(r.z, 1)})`.padStart(20); }).join("")}`);
  }
  console.log("");
}
console.log("VXN level, each year alone: top third less bottom third (z):");
console.log(`${"".padEnd(30)}${YEARS.map(([p]) => p.padStart(14)).join("")}`);
for (const [m, name] of MEASURES) {
  console.log(`${name.padEnd(30)}${YEARS.map(([p]) => { const r = results[`level|${p}`][m]; return `${f(r.gap - r.placeboGap, m.startsWith("vr") ? 3 : 1)} (${f(r.z, 1)})`.padStart(14); }).join("")}`);
}
console.log("");
console.log("Each third against its placebo markets, VXN level, 2026 and 2020-2025 (real, placebo, z):");
for (const p of ["2026", "2020-2025"]) for (const [m, name] of MEASURES) {
  const r = results[`level|${p}`][m];
  console.log(`  ${p.padEnd(10)} ${name.padEnd(30)} ${r.thirds.map((t, k) => `${["low", "mid", "high"][k]} ${f(t.real, 3)} vs ${f(t.placebo, 3)} (${f(t.z, 1)})`).join("   ")}`);
}
console.log("\nGaps beyond 1.96 sd, against the count each placebo market gets judged the same way:");
for (const [lab, c] of Object.entries(counts))
  console.log(`  ${lab.padEnd(8)} ${String(c.real).padStart(3)} of ${c.cells}; placebo markets ${c.placeboRange[0]}-${c.placeboRange[1]}, median ${c.placeboMedian}; ${(100 * c.pAtLeast).toFixed(0)}% have at least as many`);
const prim = results["level|2026"].vr15;
console.log(`\nThe test named first: VR 15 min, high-VXN third less low, 2026: ${f(prim.gap - prim.placeboGap, 3)}, z ${f(prim.z, 2)}, p ${prim.p.toFixed(3)} (placebo rank ${prim.pRank.toFixed(3)})`);
if (term) {
  const tp = results["term|2026"].vr15, parts = ["2026 Jan-Mar", "2026 Apr-Jul 14", "2026 Jul 15-Oct 30"].map((p) => { const r = results[`term|${p}`].vr15; return f(r.gap - r.placeboGap, 3); });
  console.log(`The term structure's named test: VR 15 min, flattest third less steepest, 2026: ${f(tp.gap - tp.placeboGap, 3)}, z ${f(tp.z, 2)}, p ${tp.p.toFixed(3)}; parts ${parts.join(", ")}`);
  for (const [p, from, to] of PERIODS.filter(([q]) => MAIN.has(q))) {
    const ds = days.filter((d) => d.ms >= from && d.ms < to && Number.isFinite(d.raw.term)), inv = ds.filter((d) => d.raw.term >= 1).length;
    const c = ds.map((d) => d.raw.term).sort((a, b) => a - b);
    console.log(`  ${p.padEnd(20)} VIX/VIX3M before the open: ${c.length} days, ${inv} at or above 1 (inverted); thirds cut at ${c[Math.floor(c.length / 3)].toFixed(3)} and ${c[Math.floor((2 * c.length) / 3)].toFixed(3)}`);
  }
}

fs.writeFileSync("research/vxn_regime_results.json", JSON.stringify({ run: new Date().toISOString(), bars: BARS_FILE, vxn: VXN_FILE, placebos: PLACEBOS, days: days.length, counts, results }, null, 1));
console.log(`\nwrote research/vxn_regime_results.json`);
