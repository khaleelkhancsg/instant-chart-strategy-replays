// A wide grid of EMA and MACD lengths (and the EMA row's warning rule), each row reading scored alone.
//
//   node --max-old-space-size=16384 research/databox_lengths.mjs [--placebos 100]
//
// The person (2026-11-25): "try other settings while the shards finish". databox_tune.mjs runs 16 settings
// through every entry/exit combination; this runs 90 lengths per timeframe through each row's own readings,
// the way databox_base.mjs scored definitions: is the base edge bigger at other lengths?
//
// Written before the run:
// - Lines: the indicator's arithmetic exactly (emaStep: the average of the first n values, then
//   prev + 2/(n+1)*(x - prev); the MACD signal from bar slow-1; ready flags; rowStep's side and warning),
//   on 1m closes and on clock-aligned 5m closes, one continuous series as the indicator runs.
// - Grid: EMA fast {3,5,8,9,12,15,20,26} x slow {13,21,26,34,50,89,100}, fast < slow (51); warning rule
//   speed (default) / shrink ("closer") / slowing, the indicator's own choices. MACD (fast, slow) {(5,13),
//   (6,13),(8,17),(8,21),(12,26),(16,35),(19,39),(24,52)} x signal {3,5,9,13,18} (40), warning shrink.
//   Readings per timeframe: EMA flips 51, EMA warnings 153, MACD flips 40, MACD warnings 40 (284; 568 in all).
// - The race and edge exactly as databox_base.mjs (18 points in 2026, 08:30-14:55 CT, by 15:05; win rate
//   less every minute's in the same direction and period). A 5m reading counts at the 1m bar that closes it.
// - Verdict: for each of 8 cells (1m / 5m x EMA / MACD x flip / warning), the reading with the best edge on
//   2019-2025 (2,000 onsets there, 100 in 2026) is read on 2026, less the default's (12/26 speed; 12/26/9
//   shrink) 2026 edge. The statistic is the mean gain over the 8 cells; better lengths = beating 95 of 100
//   placebo markets making the same picks. A single cell beating 90 is a lead.
// - Check: the defaults must equal databox_base.mjs's "cross" and current-warning rows (counts and edges).

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample, sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { placeboBars } from "./lib_levels.mjs";

const args = process.argv.slice(2), opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const PLACEBOS = opt("--placebos", 100);
const MIN = 60000, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, R18 = 0.00064;
const ES = args.includes("--es"), NQ = args.includes("--nq") || ES;   // confirm the frozen picks on NQ 2010-2018, or ES 2010-2026 (ledger, written before each run)
const Y0 = NQ ? 2010 : 2019, NY = ES ? 17 : NQ ? 9 : 8, NS = ES ? 17 : 10, H2 = Date.UTC(2026, 6, 1);
const EARLY = [0, 1, 2, 3, 4, 5, 6], LATE = [7];
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

const EMA_PAIRS = [];
for (const f of [3, 5, 8, 9, 12, 15, 20, 26]) for (const s of [13, 21, 26, 34, 50, 89, 100]) if (f < s) EMA_PAIRS.push([f, s]);
const MACD_SETS = [];
for (const [f, s] of [[5, 13], [6, 13], [8, 17], [8, 21], [12, 26], [16, 35], [19, 39], [24, 52]]) for (const g of [3, 5, 9, 13, 18]) MACD_SETS.push([f, s, g]);
const TFS = [1, 5];
const READ = [];   // { tf, cell, line (index into the timeframe's lines), what: flip | warn, rule, name }
TFS.forEach((tf, t) => {
  EMA_PAIRS.forEach(([f, s], j) => {
    READ.push({ t, cell: t * 4 + 0, line: j, what: "flip", name: `${tf}m EMA ${f}/${s} flip`, def: f === 12 && s === 26 });
    for (const rule of ["speed", "shrink", "slowing"]) READ.push({ t, cell: t * 4 + 1, line: j, what: "warn", rule, name: `${tf}m EMA ${f}/${s} ${rule}`, def: f === 12 && s === 26 && rule === "speed" });
  });
  MACD_SETS.forEach(([f, s, g], j) => {
    READ.push({ t, cell: t * 4 + 2, line: EMA_PAIRS.length + j, what: "flip", name: `${tf}m MACD ${f}/${s}/${g} flip`, def: f === 12 && s === 26 && g === 9 });
    READ.push({ t, cell: t * 4 + 3, line: EMA_PAIRS.length + j, what: "warn", rule: "shrink", name: `${tf}m MACD ${f}/${s}/${g} shrink`, def: f === 12 && s === 26 && g === 9 });
  });
});
const NR = READ.length, CELLS = ["1m EMA flip", "1m EMA warning", "1m MACD flip", "1m MACD warning", "5m EMA flip", "5m EMA warning", "5m MACD flip", "5m MACD warning"];

// ── the indicator's arithmetic ──
function emaSeries(x, n) {   // emaStep over a whole series: v and count
  const N = x.length, v = new Float64Array(N);
  let count = 0, total = 0, prev = NaN;
  for (let i = 0; i < N; i++) {
    if (count < n) { count++; total += x[i]; prev = total / count; } else { count++; prev = prev + (2 / (n + 1)) * (x[i] - prev); }
    v[i] = prev;
  }
  return v;
}
// one line at a time (j: an EMA pair, then a MACD set), so a long market fits in memory
function lineMaker(close) {
  const N = close.length, x = Float64Array.from(close), cache = new Map(), ema = (n) => { if (!cache.has(n)) cache.set(n, emaSeries(x, n)); return cache.get(n); };
  return (j) => {
  if (j < EMA_PAIRS.length) {
    const [f, s] = EMA_PAIRS[j];
    const a = ema(f), b = ema(s), raw = new Float64Array(N), ready = new Uint8Array(N);
    for (let i = 0; i < N; i++) { raw[i] = a[i] - b[i]; ready[i] = i >= s ? 1 : 0; }
    return { raw, ready, from: 0 };
  }
  {
    const [f, s, g] = MACD_SETS[j - EMA_PAIRS.length];
    const a = ema(f), b = ema(s), raw = new Float64Array(N).fill(NaN), ready = new Uint8Array(N);
    let count = 0, total = 0, prev = NaN;
    for (let i = s - 1; i < N; i++) {
      const line = a[i] - b[i];
      if (count < g) { count++; total += line; prev = total / count; } else { count++; prev = prev + (2 / (g + 1)) * (line - prev); }
      raw[i] = line - prev; ready[i] = count >= g ? 1 : 0;
    }
    return { raw, ready, from: s - 1 };
  }
  };
}
// rowStep over a series (from the row's first bar), then the research's reading: side and warning only when ready
function readings(L, rule) {
  const N = L.raw.length, side = new Int8Array(N), warn = new Int8Array(N);
  let ps = 0, pd = NaN, pm = NaN, has = false;
  for (let i = L.from; i < N; i++) {
    const diff = L.raw[i], s = diff > 0 ? 1 : diff < 0 ? -1 : has ? ps : 0, move = has ? diff - pd : NaN;
    let w = 0;
    if (has && s !== 0 && rule) {
      if (rule === "shrink") w = s === 1 ? (diff < pd ? -1 : 0) : diff > pd ? 1 : 0;
      else if (rule === "speed" && Number.isFinite(pm)) w = s === 1 ? (move < 0 && move < pm ? -1 : 0) : move > 0 && move > pm ? 1 : 0;
      else if (rule === "slowing" && Number.isFinite(pm)) w = s === 1 ? (move < pm ? -1 : 0) : move > pm ? 1 : 0;
    }
    if (L.ready[i]) warn[i] = w;
    ps = s; pd = diff; pm = move; has = true;
  }
  // the research's side: from the ready line's sign, a line at zero keeping its side
  for (let i = 0; i < N; i++) { if (!L.ready[i]) continue; const x = L.raw[i]; side[i] = x > 0 ? 1 : x < 0 ? -1 : i ? side[i - 1] : 0; }
  return { side, warn };
}
const flipsOf = (side) => { const o = new Int8Array(side.length); for (let i = 2; i < side.length; i++) if (side[i] && side[i - 1] === -side[i]) o[i] = side[i]; return o; };
const onsetsOf = (st) => { const o = new Int8Array(st.length); for (let i = 1; i < st.length; i++) if (st[i] && st[i] !== st[i - 1]) o[i] = st[i]; return o; };

// ── one market ──
function measure(b) {
  const N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const b5 = resample(b, 5);
  // each 1m bar: counted?, its slots, the race's winners; and the 1m bar at which each 5m bar counts
  const slotA = new Int8Array(N).fill(-1), slotB = new Int8Array(N).fill(-1), winU = new Uint8Array(N), winD = new Uint8Array(N);
  const at5 = new Int32Array(b5.close.length).fill(-1);
  const bn = new Float64Array(NS * 2), bw = new Float64Array(NS * 2);
  let k5 = -1;
  for (let i = 1; i + 1 < N; i++) {
    let new5 = -1;
    while (k5 + 1 < b5.ts.length && b5.ts[k5 + 1] + 5 * MIN <= TS[i] + MIN) { k5++; new5 = k5; }
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i]) continue;
    const y = new Date(TS[i]).getUTCFullYear() - Y0;
    if (y < 0 || y >= NY) continue;
    if (new5 >= 0) at5[new5] = i;
    slotA[i] = y; if (y === NY - 1 && !NQ) slotB[i] = TS[i] < H2 ? 8 : 9;
    const P = C[i], Rr = R18 * (P - off[i]);
    let u = 0, d = 0;
    for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
      const up = H[j] - P >= Rr, dn = P - L[j] >= Rr;
      if (!u && (up || dn)) u = dn ? -1 : 1;
      if (!d && (up || dn)) d = up ? -1 : 1;
      if (u && d) break;
    }
    winU[i] = u === 1 ? 1 : 0; winD[i] = d === 1 ? 1 : 0;
    for (const s of [slotA[i], slotB[i]]) if (s >= 0) { bn[s * 2] += 1; bw[s * 2] += winU[i]; bn[s * 2 + 1] += 1; bw[s * 2 + 1] += winD[i]; }
  }
  const n = new Float64Array(NR * NS * 2), w = new Float64Array(NR * NS * 2);
  const MK = [lineMaker(b.close), lineMaker(b5.close)];
  let curKey = "", curLine = null;
  READ.forEach((R, r) => {
    const key = R.t + ":" + R.line;
    if (key !== curKey) { curLine = MK[R.t](R.line); curKey = key; }
    const rd = readings(curLine, R.what === "flip" ? null : R.rule);
    const calls = R.what === "flip" ? flipsOf(rd.side) : onsetsOf(rd.warn);
    for (let k = 0; k < calls.length; k++) {
      const c = calls[k];
      if (!c) continue;
      const i = R.t === 0 ? k : at5[k];
      if (i < 0 || slotA[i] < 0) continue;
      const dir = c === 1 ? 0 : 1, win = c === 1 ? winU[i] : winD[i];
      for (const s of [slotA[i], slotB[i]]) if (s >= 0) { const x = (r * NS + s) * 2 + dir; n[x]++; w[x] += win; }
    }
  });
  return { n, w, bn, bw };
}
function edgeOf(M, r, slots) {
  let cnt = 0, ex = 0;
  for (const s of slots) for (let dir = 0; dir < 2; dir++) {
    const x = (r * NS + s) * 2 + dir, m = M.n[x];
    if (!m) continue;
    cnt += m; ex += M.w[x] - m * (M.bw[s * 2 + dir] / M.bn[s * 2 + dir]);
  }
  return { n: cnt, edge: cnt ? ex / cnt : NaN };
}
function picks(M) {
  const cells = CELLS.map((_, cell) => {
    let best = -1, bestE = -Infinity;
    READ.forEach((R, r) => {
      if (R.cell !== cell) return;
      const e = edgeOf(M, r, EARLY), l = edgeOf(M, r, LATE);
      if (e.n < 2000 || l.n < 100) return;
      if (e.edge > bestE) { bestE = e.edge; best = r; }
    });
    const dr = READ.findIndex((R) => R.cell === cell && R.def), late = best >= 0 ? edgeOf(M, best, LATE).edge : NaN, dl = edgeOf(M, dr, LATE).edge;
    return { cell, pick: best, pickName: best >= 0 ? READ[best].name : "—", early: bestE, late, defLate: dl, gain: late - dl };
  });
  const g = cells.map((c) => c.gain).filter(Number.isFinite);
  return { cells, mean: g.reduce((s, x) => s + x, 0) / g.length };
}

// ── run ──
const { bars: allBars } = loadBars(ES ? "data/es_1m.bin" : NQ ? "data/nq_1m.bin" : "data/mnq_1m_beta.bin");
const bars = ES ? allBars : NQ ? sliceBars(allBars, 0, indexAtOrAfter(allBars.ts, Date.UTC(2019, 0, 3))) : allBars;
const real = measure(bars);
if (NQ) {   // the 8 cells' picks, frozen from the MNQ run, against the defaults on NQ 2010-2018
  const V = JSON.parse(fs.readFileSync("research/databox_lengths_results.json", "utf8")).verdict.cells, ALL = Array.from({ length: NY }, (_, k) => k), A = ES ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 1, 2, 3, 4], B = ES ? [8, 9, 10, 11, 12, 13, 14, 15, 16] : [5, 6, 7, 8];
  const pairs = V.map((c) => [READ.findIndex((R) => R.name === c.pickName), READ.findIndex((R) => R.cell === c.cell && R.def)]);
  if (pairs.some(([a, d]) => a < 0 || d < 0)) throw new Error("a frozen pick is missing");
  process.stderr.write(`  ${ES ? "ES" : "NQ"} ${new Date(bars.ts[0]).toISOString().slice(0, 10)} to ${new Date(bars.ts[bars.close.length - 1]).toISOString().slice(0, 10)}, real market ${secs()}s
`);
  const stat = (M, slots) => pairs.map(([a, d]) => ({ pick: edgeOf(M, a, slots), def: edgeOf(M, d, slots) }));
  const R0 = stat(real, ALL), RA = stat(real, A), RB = stat(real, B), P = [];
  for (let p = 0; p < PLACEBOS; p++) {
    const M = measure(placeboBars(bars, 6600 + p));
    P.push(stat(M, ALL).map((z) => ({ gain: z.pick.edge - z.def.edge, pick: z.pick.edge, def: z.def.edge })));
    if ((p + 1) % 10 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s
`);
  }
  const pt = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (100 * x).toFixed(1) : "—"), high = (vals, v) => vals.filter((z) => Number.isFinite(z) && z >= v).length;
  console.log(`databox lengths on ${ES ? "ES 2010-2026" : "NQ 2010-2018"} (unseen): the MNQ picks against the defaults, ${PLACEBOS} placebo markets; ${secs()}s`);
  console.log(`${"cell".padEnd(16)}${"pick".padEnd(24)}${"n".padStart(8)}${"pick".padStart(7)}${"hi".padStart(4)}${"default".padStart(9)}${"hi".padStart(4)}${"gain".padStart(7)}${"hi".padStart(4)}${(ES ? "10-17" : "10-14").padStart(7)}${(ES ? "18-26" : "15-18").padStart(7)}`);
  const out = R0.map((z, c) => {
    const gain = z.pick.edge - z.def.edge, hg = high(P.map((q) => q[c].gain), gain), hp = high(P.map((q) => q[c].pick), z.pick.edge), hd = high(P.map((q) => q[c].def), z.def.edge);
    const ga = RA[c].pick.edge - RA[c].def.edge, gb = RB[c].pick.edge - RB[c].def.edge, v = ES ? (gain > 0 && hg <= 10 && z.pick.edge > 0 && hp <= 10 ? "CONFIRMED on ES (10% bar, own edge too)" : "not confirmed on ES") : gain > 0 && hg <= 5 ? "CONFIRMED better than the default" : "not confirmed";
    console.log(`${CELLS[c].padEnd(16)}${V[c].pickName.padEnd(24)}${String(z.pick.n).padStart(8)}${pt(z.pick.edge).padStart(7)}${String(hp).padStart(4)}${pt(z.def.edge).padStart(9)}${String(hd).padStart(4)}${pt(gain).padStart(7)}${String(hg).padStart(4)}${pt(ga).padStart(7)}${pt(gb).padStart(7)}  ${v}`);
    return { cell: CELLS[c], pick: V[c].pickName, pickEdge: z.pick, defEdge: z.def, gain, gainHi: hg, pickHi: hp, defHi: hd, gain1014: ga, gain1518: gb, verdict: v };
  });
  fs.writeFileSync(ES ? "research/databox_lengths_es_results.json" : "research/databox_lengths_nq_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS, cells: out, placebo: P }, null, 1));
  console.log(`wrote research/databox_lengths_${ES ? "es" : "nq"}_results.json`);
  process.exit(0);
}
process.stderr.write(`  real market: ${secs()}s\n`);
const BASE = JSON.parse(fs.readFileSync("research/databox_base_results.json", "utf8")).real;
for (const [nm, ref] of [["1m EMA 12/26 flip", "1m EMA side: cross"], ["1m EMA 12/26 speed", "1m EMA warning: speed"], ["1m MACD 12/26/9 flip", "1m MACD side: cross"], ["1m MACD 12/26/9 shrink", "1m MACD warning: shrink"],
  ["5m EMA 12/26 flip", "5m EMA side: cross"], ["5m EMA 12/26 speed", "5m EMA warning: speed"], ["5m MACD 12/26/9 flip", "5m MACD side: cross"], ["5m MACD 12/26/9 shrink", "5m MACD warning: shrink"]]) {
  const r = READ.findIndex((R) => R.name === nm), B = BASE.find((x) => x.name === ref), e = edgeOf(real, r, EARLY), l = edgeOf(real, r, LATE);
  if (B.early.n !== e.n || B.late.n !== l.n || Math.abs(B.early.edge - e.edge) > 1e-12 || Math.abs(B.late.edge - l.edge) > 1e-12)
    throw new Error(`check: ${nm} (${e.n}/${l.n}, ${e.edge}/${l.edge}) differs from databox_base's ${ref} (${B.early.n}/${B.late.n}, ${B.early.edge}/${B.late.edge})`);
  process.stderr.write(`  check: ${nm} = databox_base's ${ref} (${(e.n + l.n).toLocaleString()} onsets)\n`);
}
const RP = picks(real), pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  const M = measure(placeboBars(bars, 6600 + p)), P = picks(M);
  pl.push({ mean: P.mean, cells: P.cells.map((c) => c.gain), e: READ.map((_, r) => edgeOf(M, r, EARLY).edge), l: READ.map((_, r) => edgeOf(M, r, LATE).edge) });
  if ((p + 1) % 10 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
}

// ── print ──
const pt = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (100 * x).toFixed(1) : "—");
const high = (vals, v) => vals.filter((z) => Number.isFinite(z) && z >= v).length;
console.log(`databox lengths: ${NR} readings (${EMA_PAIRS.length} EMA pairs x 3 rules, ${MACD_SETS.length} MACD sets, 1m and 5m), ${PLACEBOS} placebo markets; ${secs()}s`);
console.log(`\nVERDICT: per cell, the best reading on 2019-2025, read on 2026, less the default's 2026 edge`);
RP.cells.forEach((c, j) => {
  const vals = pl.map((p) => p.cells[j]);
  console.log(`  ${CELLS[j].padEnd(16)} pick ${c.pickName.padEnd(24)} 2019-25 ${pt(c.early).padStart(6)} | 2026 ${pt(c.late).padStart(6)} vs default ${pt(c.defLate).padStart(6)}: gain ${pt(c.gain).padStart(6)} (placebo ${high(vals, c.gain)} of ${vals.length} as high)`);
});
const mv = pl.map((p) => p.mean), mh = high(mv, RP.mean);
console.log(`  mean gain over the 8 cells ${pt(RP.mean)}; placebo markets ${mh} of ${mv.length} as high: ${mh <= 5 ? "BETTER LENGTHS (beats 95 of 100)" : "no better lengths"}`);
console.log(`\nTOP 8 PER CELL on 2019-2025 (edge, placebo as high | 2026 edge, placebo as high, halves); the default marked <`);
CELLS.forEach((name, cell) => {
  console.log(`\n${name}`);
  const rs = READ.map((R, r) => r).filter((r) => READ[r].cell === cell).sort((a, b) => edgeOf(real, b, EARLY).edge - edgeOf(real, a, EARLY).edge);
  const dr = rs.find((r) => READ[r].def), show = rs.slice(0, 8).includes(dr) ? rs.slice(0, 8) : [...rs.slice(0, 8), dr];
  for (const r of show) {
    const e = edgeOf(real, r, EARLY), l = edgeOf(real, r, LATE);
    console.log(`  ${READ[r].name.padEnd(26)}${String(e.n + l.n).padStart(8)}${pt(e.edge).padStart(7)}${String(high(pl.map((p) => p.e[r]), e.edge)).padStart(4)}${pt(l.edge).padStart(7)}${String(high(pl.map((p) => p.l[r]), l.edge)).padStart(4)}${pt(edgeOf(real, r, [8]).edge).padStart(7)}${pt(edgeOf(real, r, [9]).edge).padStart(7)}  rank ${rs.indexOf(r) + 1}/${rs.length}${READ[r].def ? " <" : ""}`);
  }
});
console.log(`\n(${secs()}s)`);
fs.writeFileSync("research/databox_lengths_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS, verdict: RP,
  real: READ.map((R, r) => ({ name: R.name, early: edgeOf(real, r, EARLY), late: edgeOf(real, r, LATE), h1: edgeOf(real, r, [8]), h2: edgeOf(real, r, [9]) })), placebo: pl }, null, 1));
console.log("wrote research/databox_lengths_results.json");
