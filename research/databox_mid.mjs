// In-between timeframes: do 2m, 3m and 4m rows add confluence (and edge) to the box's 1m and 5m readings?
//
//   node --max-old-space-size=16384 research/databox_mid.mjs [--placebos 100]
//
// The person's question (2026-11-25): test timeframes between 1m and 5m; perhaps they add confluence and edge.
//
// Written before the run:
// - Rows: the indicator's own EMA row (12/26) and MACD row (12/26/9), run on clock-aligned 1m, 2m, 3m, 4m and
//   5m bars (the box reads whatever bars the chart has). A row on N-minute bars is known at the close of the
//   1m bar that closes its N-minute bar. Each row has a side (the line's sign), a slope (the line's change
//   on its last bar) and a warning (the indicator's own Potentially state, +1 = Potentially long).
// - Bases (the box's readings now, 8): on 1m and on 5m, EMA and MACD, a flip (the side changing) and a
//   warning onset. Each calls a direction.
// - Mid filters (46, the question): for each mid timeframe (2m, 3m, 4m) and row (EMA, MACD), the base's call
//   agreeing / not agreeing with that row's side, its slope, its warning (36); the three mid timeframes' sides
//   all agreeing / not, per row (4) and all six (2); their slopes all agreeing / not, per row (4).
// - Reference filters (description only, 12): the same 3 relations x 2 ways x 2 rows on the timeframe the box
//   already has (5m for the 1m bases, 1m for the 5m bases): what the box shows today, for comparison.
// - The race (research/idea_lab.mjs's, as databox_base.mjs): from the onset bar's close, does price go 0.064%
//   of its real price (18 points in 2026) the called way before as far the other way, by 15:05 CT? Counted
//   minutes close 08:30-14:55 CT. A filter's lift: its subset's win rate less the base's own, direction by
//   direction and period by period.
// - Verdict: for each base (8), the mid filter with the best lift on 2019-2025 (2,000 onsets there, 100 in
//   2026) is read on 2026. The statistic is the mean of the 8 picks' 2026 lifts. Each placebo market makes
//   the same picks. Mid timeframes add edge = that mean beating 95 of 100 placebo markets. A single base's
//   pick beating 90 of its placebo cells is a lead.
// - Beside it (description): each row alone on each timeframe (flips and warning onsets) as an edge over
//   every minute the same way, as databox_base.mjs; the 1m and 5m rows there must equal databox_base's
//   "cross" and current-warning rows (the check).

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const PLACEBOS = opt("--placebos", 100);
const MIN = 60000, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, R18 = 0.00064;
const Y0 = 2019, NY = 8, NS = 10, H2 = Date.UTC(2026, 6, 1);   // slots: 2019..2026 by year, 8 = 2026 Jan-Jun, 9 = Jul-Oct
const EARLY = [0, 1, 2, 3, 4, 5, 6], LATE = [7];
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

const TFS = [1, 2, 3, 4, 5], MID = [1, 2, 3], KINDS = ["EMA", "MACD"];   // MID = indexes into TFS
const BASES = [];   // tf index, row kind, flip | warn
for (const t of [0, 4]) for (let k = 0; k < 2; k++) for (const what of ["flip", "warn"]) BASES.push({ t, k, what, name: `${TFS[t]}m ${KINDS[k]} ${what === "flip" ? "flip" : "warning"}` });
const NB = BASES.length;
// filters: { name, mid, test(rel, c) } where rel(t, k) gives the row's [side, slope, warn] at the bar
const REL = ["side", "slope", "warning"];
const FILTERS = [];
for (const t of MID) for (let k = 0; k < 2; k++) for (let r = 0; r < 3; r++) for (const agree of [true, false])
  FILTERS.push({ mid: true, name: `${TFS[t]}m ${KINDS[k]} ${REL[r]} ${agree ? "agrees" : "does not agree"}`, t, k, r, agree });
for (let r = 0; r < 2; r++) {
  for (let k = 0; k < 2; k++) for (const agree of [true, false]) FILTERS.push({ mid: true, name: `2m+3m+4m ${KINDS[k]} ${REL[r]}s ${agree ? "all agree" : "not all agree"}`, stack: [k], r, agree });
  if (r === 0) for (const agree of [true, false]) FILTERS.push({ mid: true, name: `2m+3m+4m EMA and MACD sides ${agree ? "all agree" : "not all agree"}`, stack: [0, 1], r, agree });
}
for (let k = 0; k < 2; k++) for (let r = 0; r < 3; r++) for (const agree of [true, false])
  FILTERS.push({ mid: false, name: `other box timeframe ${KINDS[k]} ${REL[r]} ${agree ? "agrees" : "does not agree"}`, ref: true, k, r, agree });
const NF = FILTERS.length, MIDF = FILTERS.map((f, j) => (f.mid ? j : -1)).filter((j) => j >= 0);
// alone readings: every timeframe x row x flip / warning
const ALONE = [];
for (let t = 0; t < TFS.length; t++) for (let k = 0; k < 2; k++) for (const what of ["flip", "warn"]) ALONE.push({ t, k, what, name: `${TFS[t]}m ${KINDS[k]} ${what === "flip" ? "flip" : "warning"}` });
const NA = ALONE.length;

// ── each row's line and warning, from the indicator itself ──
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
function rows(T, minutes) {
  const run = new Run(BOX, { minutes, props: { vwapSlope: "off" }, check: false }), map = run.calc.map.bind(run.calc);
  const n = T.close.length, h = [new Float64Array(n).fill(NaN), new Float64Array(n).fill(NaN)], w = [new Int8Array(n), new Int8Array(n)];
  run.calc.map = (d, i) => {
    const out = map(d, i), S = run.calc.st[i];
    if (S.emaReady) { h[0][i] = S.ema.diff; w[0][i] = S.ema.warn; }
    if (S.macdReady && S.macd) { h[1][i] = S.macd.diff; w[1][i] = S.macd.warn; }
    return out;
  };
  run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
  // side (a line at zero keeps its side), slope, and the onsets of flips and warnings
  return h.map((line, k) => {
    const side = new Int8Array(n), slope = new Int8Array(n), flip = new Int8Array(n), won = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      const x = line[i];
      if (!Number.isFinite(x)) continue;
      side[i] = x > 0 ? 1 : x < 0 ? -1 : i ? side[i - 1] : 0;
      if (i && Number.isFinite(line[i - 1])) slope[i] = Math.sign(x - line[i - 1]);
    }
    for (let i = 2; i < n; i++) if (side[i] && side[i - 1] === -side[i]) flip[i] = side[i];
    for (let i = 1; i < n; i++) if (w[k][i] && w[k][i] !== w[k][i - 1]) won[i] = w[k][i];
    return { side, slope, warn: w[k], flip, won };
  });
}

// ── one market ──
function measure(b) {
  const N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const BT = TFS.map((tf) => (tf === 1 ? b : resample(b, tf)));
  const RW = BT.map((T, t) => rows(T, TFS[t]));   // RW[t][k] = { side, slope, warn, flip, won }
  const nT = TFS.length, ptr = new Int32Array(nT).fill(-1), fresh = new Int32Array(nT);
  // counts: base x filter x slot x dir (filter NF = the base unfiltered); alone x slot x dir; every minute x slot x dir
  const n = new Float64Array(NB * (NF + 1) * NS * 2), w = new Float64Array(NB * (NF + 1) * NS * 2);
  const an = new Float64Array(NA * NS * 2), aw = new Float64Array(NA * NS * 2), bn = new Float64Array(NS * 2), bw = new Float64Array(NS * 2);
  const relOf = (t, k, r) => { const R = RW[t][k], j = ptr[t]; return j < 0 ? 0 : r === 0 ? R.side[j] : r === 1 ? R.slope[j] : R.warn[j]; };
  for (let i = 1; i + 1 < N; i++) {
    for (let t = 0; t < nT; t++) {   // the latest N-minute bar closed by this 1m bar's close
      fresh[t] = -1;
      const T = BT[t], tf = TFS[t];
      while (ptr[t] + 1 < T.ts.length && T.ts[ptr[t] + 1] + tf * MIN <= TS[i] + MIN) { ptr[t]++; fresh[t] = ptr[t]; }
    }
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i]) continue;
    const y = new Date(TS[i]).getUTCFullYear() - Y0;
    if (y < 0 || y >= NY) continue;
    const slots = y === NY - 1 ? [y, TS[i] < H2 ? 8 : 9] : [y];
    const P = C[i], Rr = R18 * (P - off[i]);
    let u = 0, d = 0;
    for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
      const up = H[j] - P >= Rr, dn = P - L[j] >= Rr;
      if (!u && (up || dn)) u = dn ? -1 : 1;
      if (!d && (up || dn)) d = up ? -1 : 1;
      if (u && d) break;
    }
    const winUp = u === 1 ? 1 : 0, winDn = d === 1 ? 1 : 0;
    for (const s of slots) { bn[s * 2] += 1; bw[s * 2] += winUp; bn[s * 2 + 1] += 1; bw[s * 2 + 1] += winDn; }
    for (let a = 0; a < NA; a++) {
      const A = ALONE[a], j = fresh[A.t];
      if (j < 0) continue;
      const c = A.what === "flip" ? RW[A.t][A.k].flip[j] : RW[A.t][A.k].won[j];
      if (!c) continue;
      const dir = c === 1 ? 0 : 1, win = c === 1 ? winUp : winDn;
      for (const s of slots) { const x = (a * NS + s) * 2 + dir; an[x]++; aw[x] += win; }
    }
    for (let q = 0; q < NB; q++) {
      const B = BASES[q], j = fresh[B.t];
      if (j < 0) continue;
      const c = B.what === "flip" ? RW[B.t][B.k].flip[j] : RW[B.t][B.k].won[j];
      if (!c) continue;
      const dir = c === 1 ? 0 : 1, win = c === 1 ? winUp : winDn, other = B.t === 0 ? 4 : 0;
      const add = (f) => { for (const s of slots) { const x = ((q * (NF + 1) + f) * NS + s) * 2 + dir; n[x]++; w[x] += win; } };
      add(NF);
      for (let f = 0; f < NF; f++) {
        const F = FILTERS[f];
        let ok;
        if (F.stack) ok = MID.every((t) => F.stack.every((k) => relOf(t, k, F.r) === c));
        else ok = relOf(F.ref ? other : F.t, F.k, F.r) === c;
        if (ok === F.agree) add(f);
      }
    }
  }
  return { n, w, an, aw, bn, bw };
}
// a filter's lift over some slots: its win rate less the base's own, direction by direction
function liftOf(M, q, f, slots) {
  let cnt = 0, ex = 0;
  for (const s of slots) for (let dir = 0; dir < 2; dir++) {
    const x = ((q * (NF + 1) + f) * NS + s) * 2 + dir, m = M.n[x];
    if (!m) continue;
    const y = ((q * (NF + 1) + NF) * NS + s) * 2 + dir;
    cnt += m; ex += M.w[x] - m * (M.w[y] / M.n[y]);
  }
  return { n: cnt, lift: cnt ? ex / cnt : NaN };
}
function edgeAlone(M, a, slots) {
  let cnt = 0, ex = 0;
  for (const s of slots) for (let dir = 0; dir < 2; dir++) {
    const x = (a * NS + s) * 2 + dir, m = M.an[x];
    if (!m) continue;
    cnt += m; ex += M.aw[x] - m * (M.bw[s * 2 + dir] / M.bn[s * 2 + dir]);
  }
  return { n: cnt, edge: cnt ? ex / cnt : NaN };
}
function picks(M) {
  const cells = BASES.map((B, q) => {
    let best = -1, bestE = -Infinity;
    for (const f of MIDF) {
      const e = liftOf(M, q, f, EARLY), l = liftOf(M, q, f, LATE);
      if (e.n < 2000 || l.n < 100) continue;
      if (e.lift > bestE) { bestE = e.lift; best = f; }
    }
    return { base: q, pick: best, pickName: best >= 0 ? FILTERS[best].name : "—", early: bestE, late: best >= 0 ? liftOf(M, q, best, LATE).lift : NaN };
  });
  const g = cells.map((c) => c.late).filter(Number.isFinite);
  return { cells, mean: g.reduce((s, x) => s + x, 0) / g.length };
}

// ── run ──
const { bars } = loadBars("data/mnq_1m_beta.bin");
const real = measure(bars);
process.stderr.write(`  real market: ${secs()}s\n`);
// the check: 1m and 5m rows alone must equal databox_base.mjs's cross / current-warning rows
const BASE = JSON.parse(fs.readFileSync("research/databox_base_results.json", "utf8")).real;
for (const [a, nm] of [[0, "1m EMA side: cross"], [1, "1m EMA warning: speed"], [2, "1m MACD side: cross"], [3, "1m MACD warning: shrink"], [16, "5m EMA side: cross"], [17, "5m EMA warning: speed"], [18, "5m MACD side: cross"], [19, "5m MACD warning: shrink"]]) {
  const ref = BASE.find((r) => r.name === nm), e = edgeAlone(real, a, EARLY), l = edgeAlone(real, a, LATE);
  if (ref.early.n !== e.n || ref.late.n !== l.n || Math.abs(ref.early.edge - e.edge) > 1e-12 || Math.abs(ref.late.edge - l.edge) > 1e-12)
    throw new Error(`check: ${ALONE[a].name} (${e.n}/${l.n}, ${e.edge}/${l.edge}) differs from databox_base's ${nm} (${ref.early.n}/${ref.late.n}, ${ref.early.edge}/${ref.late.edge})`);
  process.stderr.write(`  check: ${ALONE[a].name} = databox_base's ${nm} (${(e.n + l.n).toLocaleString()} onsets)\n`);
}
const RP = picks(real);
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  const M = measure(placeboBars(bars, 5500 + p)), P = picks(M);
  pl.push({ mean: P.mean, cells: P.cells.map((c) => c.late),
    lifts: BASES.map((_, q) => FILTERS.map((_, f) => ({ e: liftOf(M, q, f, EARLY).lift, l: liftOf(M, q, f, LATE).lift }))),
    alone: ALONE.map((_, a) => ({ e: edgeAlone(M, a, EARLY).edge, l: edgeAlone(M, a, LATE).edge })) });
  if ((p + 1) % 10 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
}

// ── print ──
const pt = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (100 * x).toFixed(1) : "—");
const high = (vals, v) => vals.filter((z) => Number.isFinite(z) && z >= v).length;
console.log(`databox in-between timeframes: ${NB} bases x ${MIDF.length} mid filters (+${NF - MIDF.length} reference), ${PLACEBOS} placebo markets; ${secs()}s`);
console.log(`lift = points of win rate in the 18-point race over the base's own; "hi" = placebo markets as high`);
console.log(`\nVERDICT: per base, the best mid filter on 2019-2025, read on 2026`);
RP.cells.forEach((c, q) => {
  const vals = pl.map((p) => p.cells[q]);
  console.log(`  ${BASES[q].name.padEnd(17)} pick ${c.pickName.padEnd(44)} 2019-25 ${pt(c.early).padStart(6)} | 2026 ${pt(c.late).padStart(6)} (placebo ${high(vals, c.late)} of ${vals.length} as high)`);
});
const mv = pl.map((p) => p.mean), mh = high(mv, RP.mean);
console.log(`  mean 2026 lift over the 8 picks ${pt(RP.mean)}; placebo markets ${mh} of ${mv.length} as high: ${mh <= 5 ? "MID TIMEFRAMES ADD EDGE (beats 95 of 100)" : "no added edge"}`);
console.log(`\nEACH ROW ALONE: edge over every minute the same way (2019-2025 | 2026, H1, H2), placebo markets as high`);
console.log(`${"reading".padEnd(18)}${"onsets".padStart(9)}${"2019-25".padStart(9)}${"hi".padStart(4)}${"2026".padStart(8)}${"hi".padStart(4)}${"H1".padStart(7)}${"H2".padStart(7)}`);
ALONE.forEach((A, a) => {
  const e = edgeAlone(real, a, EARLY), l = edgeAlone(real, a, LATE);
  console.log(`${A.name.padEnd(18)}${String(e.n + l.n).padStart(9)}${pt(e.edge).padStart(9)}${String(high(pl.map((p) => p.alone[a].e), e.edge)).padStart(4)}${pt(l.edge).padStart(8)}${String(high(pl.map((p) => p.alone[a].l), l.edge)).padStart(4)}${pt(edgeAlone(real, a, [8]).edge).padStart(7)}${pt(edgeAlone(real, a, [9]).edge).padStart(7)}`);
});
console.log(`\nEVERY FILTER (lift on 2019-2025 | 2026, each with placebo markets as high; * = beats 90 in both)`);
BASES.forEach((B, q) => {
  console.log(`\n${B.name}`);
  FILTERS.forEach((F, f) => {
    const e = liftOf(real, q, f, EARLY), l = liftOf(real, q, f, LATE);
    const he = high(pl.map((p) => p.lifts[q][f].e), e.lift), hl = high(pl.map((p) => p.lifts[q][f].l), l.lift);
    console.log(`  ${F.name.padEnd(46)}${String(e.n + l.n).padStart(8)}${pt(e.lift).padStart(7)}${String(he).padStart(4)}${pt(l.lift).padStart(7)}${String(hl).padStart(4)}${he <= 10 && hl <= 10 ? " *" : ""}`);
  });
});
console.log(`\n(${secs()}s)`);
fs.writeFileSync("research/databox_mid_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS, bases: BASES.map((B) => B.name), filters: FILTERS.map((F) => F.name),
  verdict: RP, real: { lifts: BASES.map((_, q) => FILTERS.map((_, f) => ({ e: liftOf(real, q, f, EARLY), l: liftOf(real, q, f, LATE) }))), alone: ALONE.map((_, a) => ({ e: edgeAlone(real, a, EARLY), l: edgeAlone(real, a, LATE) })) }, placebo: pl }, null, 1));
console.log("wrote research/databox_mid_results.json");
