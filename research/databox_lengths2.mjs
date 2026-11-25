// Lengths and warning rules, second grid: the MACD rows with every warning rule, and the 2m / 3m / 4m rows.
//
//   node --max-old-space-size=16384 research/databox_lengths2.mjs [--placebos 100]        MNQ: pick and screen
//   node --max-old-space-size=16384 research/databox_lengths2.mjs --nq [--placebos 100]   NQ 2010-2018: confirm
//
// After databox_lengths.mjs gave confirmed #3 (the 1m EMA row at 3/13 with the "slowing" warning), the same
// method on the cells it did not cover. Written before either run (2026-11-25):
// - Lines and arithmetic exactly as databox_lengths.mjs (the indicator's emaStep and rowStep, re-done and checked).
// - Cells (8): 1m MACD warning, 2m EMA warning, 2m MACD warning, 3m EMA, 3m MACD, 4m EMA, 4m MACD, 5m MACD
//   warning. EMA cells: 51 pairs x speed / shrink / slowing (153). MACD cells: 40 sets x the same 3 rules (120;
//   the indicator has only "shrink" for its MACD row now, so another rule would need a setting added). Flips are
//   left out: no flip had an edge at any length or timeframe.
// - Defaults: EMA 12/26 speed, MACD 12/26/9 shrink (the indicator's on any chart).
// - The race and edge exactly as databox_lengths.mjs. An N-minute reading counts at the 1m bar closing its bar.
// - Stage 1, MNQ (screen): per cell, the reading with the best edge on 2019-2025 (2,000 onsets there, 100 in
//   2026) is read on 2026. A cell passes when that 2026 edge is positive and beats 90 of 100 placebo markets'
//   own picks (each placebo market picking its best on its 2019-2025 the same way).
// - Stage 2, NQ 2010-2018 (confirm), only the cells that passed, picks frozen: CONFIRMED when the pick's edge
//   less the default's beats 95 of 100 placebo markets AND the pick's own edge is positive and beats 95 of 100
//   (the dilution check that #3 passed and the 5m picks of databox_lengths did not). A confirmed cell counts
//   as one of the five.
// - Check: readings already in databox_lengths.mjs (1m and 5m MACD shrink) must give its numbers exactly.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample, sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { placeboBars } from "./lib_levels.mjs";

const args = process.argv.slice(2), opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const PLACEBOS = opt("--placebos", 100), NQ = args.includes("--nq");
const MIN = 60000, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, R18 = 0.00064;
const Y0 = NQ ? 2010 : 2019, NY = NQ ? 9 : 8, NS = 10, H2 = Date.UTC(2026, 6, 1);
const EARLY = [0, 1, 2, 3, 4, 5, 6], LATE = [7], ALL9 = [0, 1, 2, 3, 4, 5, 6, 7, 8], NA = [0, 1, 2, 3, 4], NB = [5, 6, 7, 8];
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

const EMA_PAIRS = [];
for (const f of [3, 5, 8, 9, 12, 15, 20, 26]) for (const s of [13, 21, 26, 34, 50, 89, 100]) if (f < s) EMA_PAIRS.push([f, s]);
const MACD_SETS = [];
for (const [f, s] of [[5, 13], [6, 13], [8, 17], [8, 21], [12, 26], [16, 35], [19, 39], [24, 52]]) for (const g of [3, 5, 9, 13, 18]) MACD_SETS.push([f, s, g]);
const RULES = ["speed", "shrink", "slowing"];
const TFS = [1, 2, 3, 4, 5];
const CELLS = [[0, "MACD"], [1, "EMA"], [1, "MACD"], [2, "EMA"], [2, "MACD"], [3, "EMA"], [3, "MACD"], [4, "MACD"]];   // [tf index, row]
const READ = [];   // { t, cell, line, rule, name, def }
CELLS.forEach(([t, row], cell) => {
  const tf = TFS[t];
  if (row === "EMA") EMA_PAIRS.forEach(([f, s], j) => { for (const rule of RULES) READ.push({ t, cell, line: j, rule, name: `${tf}m EMA ${f}/${s} ${rule}`, def: f === 12 && s === 26 && rule === "speed" }); });
  else MACD_SETS.forEach(([f, s, g], j) => { for (const rule of RULES) READ.push({ t, cell, line: EMA_PAIRS.length + j, rule, name: `${tf}m MACD ${f}/${s}/${g} ${rule}`, def: f === 12 && s === 26 && g === 9 && rule === "shrink" }); });
});
const NR = READ.length, CELL_NAMES = CELLS.map(([t, row]) => `${TFS[t]}m ${row} warning`);

// ── the indicator's arithmetic (as databox_lengths.mjs) ──
function emaSeries(x, n) {
  const N = x.length, v = new Float64Array(N);
  let count = 0, total = 0, prev = NaN;
  for (let i = 0; i < N; i++) {
    if (count < n) { count++; total += x[i]; prev = total / count; } else { count++; prev = prev + (2 / (n + 1)) * (x[i] - prev); }
    v[i] = prev;
  }
  return v;
}
function lineMaker(close) {
  const N = close.length, x = Float64Array.from(close), cache = new Map(), ema = (n) => { if (!cache.has(n)) cache.set(n, emaSeries(x, n)); return cache.get(n); };
  return (j) => {
    if (j < EMA_PAIRS.length) {
      const [f, s] = EMA_PAIRS[j], a = ema(f), b = ema(s), raw = new Float64Array(N), ready = new Uint8Array(N);
      for (let i = 0; i < N; i++) { raw[i] = a[i] - b[i]; ready[i] = i >= s ? 1 : 0; }
      return { raw, ready, from: 0 };
    }
    const [f, s, g] = MACD_SETS[j - EMA_PAIRS.length], a = ema(f), b = ema(s), raw = new Float64Array(N).fill(NaN), ready = new Uint8Array(N);
    let count = 0, total = 0, prev = NaN;
    for (let i = s - 1; i < N; i++) {
      const line = a[i] - b[i];
      if (count < g) { count++; total += line; prev = total / count; } else { count++; prev = prev + (2 / (g + 1)) * (line - prev); }
      raw[i] = line - prev; ready[i] = count >= g ? 1 : 0;
    }
    return { raw, ready, from: s - 1 };
  };
}
function warnings(L, rule) {   // rowStep's warning, kept only when the row is ready
  const N = L.raw.length, warn = new Int8Array(N);
  let ps = 0, pd = NaN, pm = NaN, has = false;
  for (let i = L.from; i < N; i++) {
    const diff = L.raw[i], s = diff > 0 ? 1 : diff < 0 ? -1 : has ? ps : 0, move = has ? diff - pd : NaN;
    let w = 0;
    if (has && s !== 0) {
      if (rule === "shrink") w = s === 1 ? (diff < pd ? -1 : 0) : diff > pd ? 1 : 0;
      else if (rule === "speed" && Number.isFinite(pm)) w = s === 1 ? (move < 0 && move < pm ? -1 : 0) : move > 0 && move > pm ? 1 : 0;
      else if (rule === "slowing" && Number.isFinite(pm)) w = s === 1 ? (move < pm ? -1 : 0) : move > pm ? 1 : 0;
    }
    if (L.ready[i]) warn[i] = w;
    ps = s; pd = diff; pm = move; has = true;
  }
  return warn;
}
const onsetsOf = (st) => { const o = new Int8Array(st.length); for (let i = 1; i < st.length; i++) if (st[i] && st[i] !== st[i - 1]) o[i] = st[i]; return o; };

// ── one market ──
function measure(b) {
  const N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const BT = TFS.map((tf) => (tf === 1 ? b : resample(b, tf)));
  const slotA = new Int8Array(N).fill(-1), slotB = new Int8Array(N).fill(-1), winU = new Uint8Array(N), winD = new Uint8Array(N);
  const at = BT.map((T) => new Int32Array(T.close.length).fill(-1)), ptr = new Int32Array(TFS.length).fill(-1), fresh = new Int32Array(TFS.length);
  const bn = new Float64Array(NS * 2), bw = new Float64Array(NS * 2);
  for (let i = 1; i + 1 < N; i++) {
    for (let t = 0; t < TFS.length; t++) {
      fresh[t] = -1;
      while (ptr[t] + 1 < BT[t].ts.length && BT[t].ts[ptr[t] + 1] + TFS[t] * MIN <= TS[i] + MIN) { ptr[t]++; fresh[t] = ptr[t]; }
    }
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i]) continue;
    const y = new Date(TS[i]).getUTCFullYear() - Y0;
    if (y < 0 || y >= NY) continue;
    for (let t = 0; t < TFS.length; t++) if (fresh[t] >= 0) at[t][fresh[t]] = i;
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
  const MK = BT.map((T) => lineMaker(T.close));
  let curKey = "", curLine = null;
  READ.forEach((R, r) => {
    const key = R.t + ":" + R.line;
    if (key !== curKey) { curLine = MK[R.t](R.line); curKey = key; }
    const calls = onsetsOf(warnings(curLine, R.rule)), map = at[R.t];
    for (let k = 0; k < calls.length; k++) {
      const c = calls[k];
      if (!c) continue;
      const i = map[k];
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
function pickOf(M, cell) {
  let best = -1, bestE = -Infinity;
  READ.forEach((R, r) => {
    if (R.cell !== cell) return;
    const e = edgeOf(M, r, EARLY), l = edgeOf(M, r, LATE);
    if (e.n < 2000 || l.n < 100) return;
    if (e.edge > bestE) { bestE = e.edge; best = r; }
  });
  return best;
}
const pt = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (100 * x).toFixed(1) : "—"), high = (vals, v) => vals.filter((z) => Number.isFinite(z) && z >= v).length;

// ── run ──
const { bars: allBars } = loadBars(NQ ? "data/nq_1m.bin" : "data/mnq_1m_beta.bin");
const bars = NQ ? sliceBars(allBars, 0, indexAtOrAfter(allBars.ts, Date.UTC(2019, 0, 3))) : allBars;
const real = measure(bars);
process.stderr.write(`  ${NQ ? "NQ" : "MNQ"} real market: ${secs()}s\n`);

if (!NQ) {
  // the check against databox_lengths.mjs
  const OLD = JSON.parse(fs.readFileSync("research/databox_lengths_results.json", "utf8")).real;
  let same = 0;
  READ.forEach((R, r) => {
    const o = OLD.find((x) => x.name === R.name);
    if (!o) return;
    const e = edgeOf(real, r, EARLY), l = edgeOf(real, r, LATE);
    if (o.early.n !== e.n || o.late.n !== l.n || Math.abs(o.early.edge - e.edge) > 1e-12 || Math.abs(o.late.edge - l.edge) > 1e-12) throw new Error(`check: ${R.name} differs from databox_lengths`);
    same++;
  });
  if (same !== 80) throw new Error(`check: expected 80 shared readings, found ${same}`);
  process.stderr.write(`  check: the 80 readings shared with databox_lengths.mjs match exactly\n`);
  const RP = CELLS.map((_, c) => pickOf(real, c)), pl = [];
  for (let p = 0; p < PLACEBOS; p++) {
    const M = measure(placeboBars(bars, 3300 + p));
    pl.push({ late: CELLS.map((_, c) => { const r = pickOf(M, c); return r >= 0 ? edgeOf(M, r, LATE).edge : NaN; }), e: READ.map((_, r) => edgeOf(M, r, EARLY).edge), l: READ.map((_, r) => edgeOf(M, r, LATE).edge) });
    if ((p + 1) % 10 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
  }
  console.log(`databox lengths 2 (MNQ screen): ${NR} warning readings in ${CELLS.length} cells, ${PLACEBOS} placebo markets; ${secs()}s`);
  console.log(`a cell passes when its 2019-2025 pick's 2026 edge is positive and beats 90 of 100 placebo markets' own picks\n`);
  const cells = CELLS.map((_, c) => {
    const r = RP[c], d = READ.findIndex((R) => R.cell === c && R.def), e = edgeOf(real, r, EARLY), l = edgeOf(real, r, LATE), dl = edgeOf(real, d, LATE), de = edgeOf(real, d, EARLY);
    const hi = high(pl.map((p) => p.late[c]), l.edge), pass = l.edge > 0 && hi <= 10;
    console.log(`${CELL_NAMES[c].padEnd(16)} pick ${READ[r].name.padEnd(26)} 2019-25 ${pt(e.edge).padStart(6)} | 2026 ${pt(l.edge).padStart(6)} (${hi} of 100 as high; halves ${pt(edgeOf(real, r, [8]).edge)} / ${pt(edgeOf(real, r, [9]).edge)}) | default ${pt(de.edge)} / ${pt(dl.edge)}  ${pass ? "SCREEN PASS" : "fails the screen"}`);
    return { cell: CELL_NAMES[c], pick: READ[r].name, early: e, late: l, hi, defEarly: de, defLate: dl, pass };
  });
  console.log(`\nTOP 5 PER CELL on 2019-2025 (edge, placebo as high | 2026, placebo as high)`);
  CELLS.forEach((_, c) => {
    console.log(`\n${CELL_NAMES[c]}`);
    const rs = READ.map((_, r) => r).filter((r) => READ[r].cell === c).sort((a, b) => edgeOf(real, b, EARLY).edge - edgeOf(real, a, EARLY).edge);
    const d = rs.find((r) => READ[r].def);
    for (const r of [...rs.slice(0, 5), ...(rs.slice(0, 5).includes(d) ? [] : [d])]) {
      const e = edgeOf(real, r, EARLY), l = edgeOf(real, r, LATE);
      console.log(`  ${READ[r].name.padEnd(28)}${String(e.n + l.n).padStart(8)}${pt(e.edge).padStart(7)}${String(high(pl.map((p) => p.e[r]), e.edge)).padStart(4)}${pt(l.edge).padStart(7)}${String(high(pl.map((p) => p.l[r]), l.edge)).padStart(4)}  rank ${rs.indexOf(r) + 1}/${rs.length}${READ[r].def ? " <" : ""}`);
    }
  });
  fs.writeFileSync("research/databox_lengths2_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS, cells,
    real: READ.map((R, r) => ({ name: R.name, early: edgeOf(real, r, EARLY), late: edgeOf(real, r, LATE) })), placebo: pl.map((p) => ({ late: p.late })) }, null, 1));
  console.log(`\n(${secs()}s)\nwrote research/databox_lengths2_results.json`);
} else {
  const S1 = JSON.parse(fs.readFileSync("research/databox_lengths2_results.json", "utf8")).cells.filter((c) => c.pass);
  if (!S1.length) { console.log("no cell passed the MNQ screen: nothing to confirm"); process.exit(0); }
  const pairs = S1.map((c) => { const a = READ.findIndex((R) => R.name === c.pick), cell = READ[a].cell; return [a, READ.findIndex((R) => R.cell === cell && R.def)]; });
  const stat = (M, slots) => pairs.map(([a, d]) => ({ pick: edgeOf(M, a, slots), def: edgeOf(M, d, slots) }));
  const R0 = stat(real, ALL9), RA = stat(real, NA), RB = stat(real, NB), P = [];
  for (let p = 0; p < PLACEBOS; p++) {
    const M = measure(placeboBars(bars, 6600 + p));
    P.push(stat(M, ALL9).map((z) => ({ gain: z.pick.edge - z.def.edge, pick: z.pick.edge })));
    if ((p + 1) % 10 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
  }
  console.log(`databox lengths 2 on NQ 2010-2018 (unseen): the screened picks against the defaults, ${PLACEBOS} placebo markets; ${secs()}s`);
  const out = R0.map((z, c) => {
    const gain = z.pick.edge - z.def.edge, hg = high(P.map((q) => q[c].gain), gain), hp = high(P.map((q) => q[c].pick), z.pick.edge);
    const ok = gain > 0 && hg <= 5 && z.pick.edge > 0 && hp <= 5;
    console.log(`${S1[c].cell.padEnd(16)} ${S1[c].pick.padEnd(26)} n ${z.pick.n}  pick ${pt(z.pick.edge)} (${hp} as high)  default ${pt(z.def.edge)}  gain ${pt(gain)} (${hg} as high)  halves ${pt(RA[c].pick.edge - RA[c].def.edge)} / ${pt(RB[c].pick.edge - RB[c].def.edge)}  ${ok ? "CONFIRMED" : "not confirmed"}`);
    return { cell: S1[c].cell, pick: S1[c].pick, pickEdge: z.pick, defEdge: z.def, gain, gainHi: hg, pickHi: hp, confirmed: ok };
  });
  fs.writeFileSync("research/databox_lengths2_nq_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS, cells: out }, null, 1));
  console.log("wrote research/databox_lengths2_nq_results.json");
}
