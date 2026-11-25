// The databox's base readings, redefined: other ways for each row to say Long / Short and to warn
// Potentially, each judged alone by what price does next, against 100 placebo markets.
//
//   node --max-old-space-size=16384 research/databox_base.mjs [--placebos 100]
//
// The person's point (2026-11-25): every combination is built from the four rows' readings, so a
// cleaner base reading lifts everything built on it. The settings study (databox_tune.mjs) changes the
// lengths; this changes HOW a row reads its line. Edge from the base adds into the combinations (the rows
// share their closes, so not independently); it does not multiply.
//
// Written before the run:
// - Lines: each row's histogram exactly as the indicator computes it (its `diff`: the EMA row's fast EMA
//   less the slow, the MACD row's line less its signal), at the defaults (12/26, 12/26/9), on 1m bars and
//   on 5m bars. A 5m reading is known at the close of the 1m bar that closes its 5m bar.
// - Side definitions (a flip is the reading; it calls the new side):
//     cross     the line crossing zero (the box now)
//     hyst05 / hyst10 / hyst25   the side changes only once the line is 0.05 / 0.10 / 0.25 ATR beyond zero
//                (ATR 14 of the row's own bars): fewer whipsaw flips, later ones
//     hold2     a cross that has held for 2 bars
// - Warning definitions (on the plain side; the onset calls against the side):
//     shrink    the bar nearer zero than the one before (the MACD row now)
//     speed     closing by more than the bar before closed (the EMA row now)
//     slowing   moving its side's way by less than the bar before
//     fade25 / fade50   the line back 25% / 50% from its peak since the cross
//     bigfade   closing by 0.1 ATR or more in one bar
//     twofade   two bars closing in a row
//     proj3 / proj6     at this bar's closing speed, the line reaches zero within 3 / 6 bars
// - The race (research/idea_lab.mjs's): from the onset bar's close, does price go 0.064% of its real
//   price (18 points in 2026) the called way before as far the other way, by 15:05 CT? Counted from New
//   York minutes closing 08:30-14:55. A reading's edge: its win rate less every minute's in the same
//   direction and period.
// - Verdict: for each row and kind (4 rows x side / warning = 8 cells), the definition with the best edge
//   on 2019-2025 (2,000 onsets there, 100 in 2026) is read on 2026; its 2026 edge less the current
//   definition's 2026 edge is that cell's improvement. The statistic is the mean improvement over the 8
//   cells. Each placebo market makes the same picks. A better base = that mean beating 95 of 100
//   placebo markets. A single cell beating its placebo cells is a lead.
// - Beside it (description only): a warning's share followed by its row's cross within 10 bars, and a
//   flip's share undone within 5 bars; real and placebo median.
// - Check: "cross" and the current warnings ("speed" on EMA rows, "shrink" on MACD rows) must give
//   exactly the indicator's own onsets on the real market.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { atr } from "../src/indicators.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const PLACEBOS = opt("--placebos", 100);
const MIN = 60000, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, R18 = 0.00064;
const Y0 = 2019, NY = 8, NS = 10, H2 = Date.UTC(2026, 6, 1);   // slots: 2019..2026 by year, 8 = 2026 Jan-Jun, 9 = Jul-Oct
const EARLY = [0, 1, 2, 3, 4, 5, 6], LATE = [7];
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

const SIDES = ["cross", "hyst05", "hyst10", "hyst25", "hold2"];
const WARNS = ["shrink", "speed", "slowing", "fade25", "fade50", "bigfade", "twofade", "proj3", "proj6"];
const ROWS = ["1m EMA", "1m MACD", "5m EMA", "5m MACD"];
const CURRENT = { side: "cross", warn: ["speed", "shrink", "speed", "shrink"] };
const READINGS = [];
ROWS.forEach((row, r) => {
  for (const def of SIDES) READINGS.push({ row: r, kind: "side", def, name: `${row} side: ${def}` });
  for (const def of WARNS) READINGS.push({ row: r, kind: "warn", def, name: `${row} warning: ${def}` });
});
const NR = READINGS.length;

// ── each row's line, from the indicator itself ──
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
function lines(T, minutes) {
  const run = new Run(BOX, { minutes, props: { vwapSlope: "off" }, check: false }), map = run.calc.map.bind(run.calc);
  const n = T.close.length, he = new Float64Array(n).fill(NaN), hm = new Float64Array(n).fill(NaN), we = new Int8Array(n), wm = new Int8Array(n);
  run.calc.map = (d, i) => {
    const out = map(d, i), S = run.calc.st[i];
    if (S.emaReady) { he[i] = S.ema.diff; we[i] = S.ema.warn; }
    if (S.macdReady && S.macd) { hm[i] = S.macd.diff; wm[i] = S.macd.warn; }
    return out;
  };
  run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
  return { he, hm, we, wm };
}

// ── a definition on one line: each bar's call at its onset (+1 / -1 / 0), on that line's bars ──
function sideCalls(h, a, def) {
  const n = h.length, out = new Int8Array(n), side = new Int8Array(n);
  const k = def === "hyst05" ? 0.05 : def === "hyst10" ? 0.1 : def === "hyst25" ? 0.25 : 0;
  // each bar's side: by the cross (a line exactly at zero keeps the side), or, with hysteresis, changing
  // only once the line is k ATR beyond zero; nothing before the line is ready
  for (let i = 0; i < n; i++) {
    const x = h[i], prev = i ? side[i - 1] : 0;
    if (!Number.isFinite(x)) { side[i] = 0; continue; }
    if (k === 0) side[i] = x > 0 ? 1 : x < 0 ? -1 : prev;
    else { const m = k * a[i]; side[i] = x > m ? 1 : x < -m ? -1 : prev; }
  }
  for (let i = 2; i < n; i++) {
    if (def === "hold2") { if (side[i] && side[i] === side[i - 1] && side[i - 2] === -side[i]) out[i] = side[i]; }   // a flip, held for its second bar
    else if (side[i] && side[i - 1] === -side[i]) out[i] = side[i];   // a flip from one side to the other
  }
  return out;
}
function warnState(h, a, def) {
  const n = h.length, st = new Int8Array(n);   // +1 = Potentially long (on the short side), -1 = Potentially short
  let side = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    const x = h[i];
    if (!Number.isFinite(x)) { side = 0; peak = 0; continue; }
    const ns = x > 0 ? 1 : x < 0 ? -1 : side;
    if (ns !== side) { side = ns; peak = 0; }
    if (!side) continue;
    peak = Math.max(peak, side * x);
    const p1 = h[i - 1], p2 = h[i - 2];
    if (!Number.isFinite(p1)) continue;
    const toward = side * (p1 - x);                   // how far it closed toward zero on this bar
    const m = x - p1, pm = Number.isFinite(p2) ? p1 - p2 : NaN;
    let w = false;
    switch (def) {
      case "shrink": w = toward > 0; break;
      case "speed": w = Number.isFinite(pm) && (side === 1 ? m < 0 && m < pm : m > 0 && m > pm); break;
      case "slowing": w = Number.isFinite(pm) && (side === 1 ? m < pm : m > pm); break;
      case "fade25": w = peak > 0 && side * x <= 0.75 * peak; break;
      case "fade50": w = peak > 0 && side * x <= 0.5 * peak; break;
      case "bigfade": w = toward >= 0.1 * a[i]; break;
      case "twofade": w = toward > 0 && Number.isFinite(p2) && side * (p2 - p1) > 0; break;
      case "proj3": w = toward > 0 && (side * x) / toward <= 3; break;
      case "proj6": w = toward > 0 && (side * x) / toward <= 6; break;
    }
    if (w) st[i] = -side;
  }
  return st;
}
const onsets = (st) => { const out = new Int8Array(st.length); for (let i = 1; i < st.length; i++) if (st[i] && st[i] !== st[i - 1]) out[i] = st[i]; return out; };

// ── one market ──
function measure(b, check) {
  const N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const b5 = resample(b, 5);
  const L1 = lines(b, 1), L5 = lines(b5, 5);
  const a1 = atr(b.high, b.low, b.close, 14), a5 = atr(b5.high, b5.low, b5.close, 14);
  const lineOf = [[L1.he, a1], [L1.hm, a1], [L5.he, a5], [L5.hm, a5]];
  // every reading's onsets on its own bars
  const calls = READINGS.map((R) => { const [h, a] = lineOf[R.row]; return R.kind === "side" ? sideCalls(h, a, R.def) : onsets(warnState(h, a, R.def)); });
  if (check) {   // "cross" and the current warnings must be the indicator's own
    const own = [[L1.he, L1.we], [L1.hm, L1.wm], [L5.he, L5.we], [L5.hm, L5.wm]];
    READINGS.forEach((R, j) => {
      if (R.kind === "warn" && R.def === CURRENT.warn[R.row]) {
        const mine = calls[j], theirs = onsets(own[R.row][1]);
        let same = 0;   // past the warm-up (the indicator reads the line from its first bar, this from its ready bar)
        for (let i = 200; i < mine.length; i++) { if (mine[i] !== theirs[i]) throw new Error(`${R.name} differs from the indicator at bar ${i}: ${mine[i]} vs ${theirs[i]}`); if (mine[i]) same++; }
        process.stderr.write(`  check: ${R.name} = the indicator's own, ${same.toLocaleString()} onsets\n`);
      }
    });
  }
  // the race from every counted minute, and every minute's base rates by (slot, direction)
  const n = new Float64Array(NR * NS * 2), w = new Float64Array(NR * NS * 2), bn = new Float64Array(NS * 2), bw = new Float64Array(NS * 2);
  const follow = new Float64Array(NR * 2);   // description: [count, followed]
  let k5 = -1;
  for (let i = 1; i + 1 < N; i++) {
    let new5 = -1;
    while (k5 + 1 < b5.ts.length && b5.ts[k5 + 1] + 5 * MIN <= TS[i] + MIN) { k5++; new5 = k5; }
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
    for (let r = 0; r < NR; r++) {
      const R = READINGS[r], on5 = R.row >= 2;
      if (on5 && new5 < 0) continue;
      const c = on5 ? calls[r][new5] : calls[r][i];
      if (!c) continue;
      const dir = c === 1 ? 0 : 1, win = c === 1 ? winUp : winDn;
      for (const s of slots) { const x = (r * NS + s) * 2 + dir; n[x]++; w[x] += win; }
    }
  }
  // description: warnings followed by their row's cross within 10 bars; flips undone within 5
  READINGS.forEach((R, r) => {
    const [h] = lineOf[R.row], c = calls[r];
    for (let i = 0; i < c.length; i++) {
      if (!c[i]) continue;
      let hit = false;
      if (R.kind === "warn") { for (let j = i + 1; j <= i + 10 && j < h.length; j++) if (Number.isFinite(h[j]) && c[i] * h[j] > 0) { hit = true; break; } }
      else { for (let j = i + 1; j <= i + 5 && j < h.length; j++) if (Number.isFinite(h[j]) && c[i] * h[j] < 0) { hit = true; break; } }
      follow[r * 2]++; if (hit) follow[r * 2 + 1]++;
    }
  });
  return { n, w, bn, bw, follow };
}
// a reading's edge over some slots: its win rate less every minute's, direction by direction
function edgeOf(M, r, slots) {
  let cnt = 0, ex = 0;
  for (const s of slots) for (let dir = 0; dir < 2; dir++) {
    const x = (r * NS + s) * 2 + dir, m = M.n[x];
    if (!m) continue;
    cnt += m; ex += M.w[x] - m * (M.bw[s * 2 + dir] / M.bn[s * 2 + dir]);
  }
  return { n: cnt, edge: cnt ? ex / cnt : NaN };
}
// the verdict's picks: per row and kind, the best definition on 2019-2025, read on 2026, less the current
function picks(M) {
  const cells = [];
  for (let row = 0; row < 4; row++) for (const kind of ["side", "warn"]) {
    const cur = kind === "side" ? CURRENT.side : CURRENT.warn[row];
    let bestR = -1, bestE = -Infinity;
    READINGS.forEach((R, r) => {
      if (R.row !== row || R.kind !== kind) return;
      const e = edgeOf(M, r, EARLY), l = edgeOf(M, r, LATE);
      if (e.n < 2000 || l.n < 100) return;
      if (e.edge > bestE) { bestE = e.edge; bestR = r; }
    });
    const curR = READINGS.findIndex((R) => R.row === row && R.kind === kind && R.def === cur);
    const late = bestR >= 0 ? edgeOf(M, bestR, LATE).edge : NaN, curLate = edgeOf(M, curR, LATE).edge;
    cells.push({ row, kind, pick: bestR, pickName: bestR >= 0 ? READINGS[bestR].def : "—", early: bestE, late, curLate, gain: late - curLate });
  }
  const g = cells.map((c) => c.gain).filter(Number.isFinite);
  return { cells, mean: g.reduce((s, x) => s + x, 0) / g.length };
}

// ── run ──
const { bars } = loadBars("data/mnq_1m_beta.bin");
const real = measure(bars, true);
process.stderr.write(`  real market (and the check against the indicator's own warnings): ${secs()}s\n`);
const RP = picks(real);
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  const M = measure(placeboBars(bars, 4400 + p), false);
  pl.push({ mean: picks(M).mean, cells: picks(M).cells.map((c) => c.gain), edges: READINGS.map((_, r) => ({ e: edgeOf(M, r, EARLY).edge, l: edgeOf(M, r, LATE).edge, h1: edgeOf(M, r, [8]).edge, h2: edgeOf(M, r, [9]).edge })),
    follow: READINGS.map((_, r) => M.follow[r * 2 + 1] / M.follow[r * 2]) });
  if ((p + 1) % 10 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
}

// ── print ──
const pt = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (100 * x).toFixed(1) : "—"), pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(0) + "%" : "—");
const high = (vals, v) => vals.filter((z) => Number.isFinite(z) && z >= v).length, low = (vals, v) => vals.filter((z) => Number.isFinite(z) && z <= v).length;
console.log(`databox base readings: ${NR} definitions (4 rows x ${SIDES.length} side + ${WARNS.length} warning), ${PLACEBOS} placebo markets; ${secs()}s`);
console.log(`edge = points of win rate in the 18-point race over every minute the same way; "hi" = placebo markets with an edge as high`);
console.log(`\nVERDICT: per row and kind, the best definition on 2019-2025, read on 2026, less the current definition's 2026 edge`);
RP.cells.forEach((c, j) => {
  const vals = pl.map((p) => p.cells[j]);
  console.log(`  ${(ROWS[c.row] + " " + c.kind).padEnd(15)} pick ${c.pickName.padEnd(8)} 2019-25 ${pt(c.early).padStart(6)} | 2026 ${pt(c.late).padStart(6)} vs current ${pt(c.curLate).padStart(6)}: gain ${pt(c.gain).padStart(6)} (placebo ${high(vals, c.gain)} of ${vals.length} as high)`);
});
const mv = pl.map((p) => p.mean), mh = high(mv, RP.mean);
console.log(`  mean gain over the 8 cells ${pt(RP.mean)}; placebo markets ${mh} of ${mv.length} as high: ${mh <= 5 ? "A BETTER BASE (beats 95 of 100)" : "not a better base"}`);
console.log(`\nEVERY DEFINITION: edge on 2019-2025 and 2026 (halves), each against the placebo markets; share followed by a cross in 10 bars (warnings) or undone in 5 (flips), real vs placebo median`);
console.log(`${"reading".padEnd(30)}${"onsets".padStart(9)}${"2019-25".padStart(9)}${"hi".padStart(4)}${"2026".padStart(8)}${"hi".padStart(4)}${"H1".padStart(7)}${"H2".padStart(7)}${"follow".padStart(8)}${"placebo".padStart(9)}`);
READINGS.forEach((R, r) => {
  const e = edgeOf(real, r, EARLY), l = edgeOf(real, r, LATE), h1 = edgeOf(real, r, [8]), h2 = edgeOf(real, r, [9]);
  const fv = pl.map((p) => p.follow[r]).sort((a, b) => a - b);
  console.log(`${R.name.padEnd(30)}${String(e.n + l.n).padStart(9)}${pt(e.edge).padStart(9)}${String(high(pl.map((p) => p.edges[r].e), e.edge)).padStart(4)}${pt(l.edge).padStart(8)}${String(high(pl.map((p) => p.edges[r].l), l.edge)).padStart(4)}${pt(h1.edge).padStart(7)}${pt(h2.edge).padStart(7)}${pc(real.follow[r * 2 + 1] / real.follow[r * 2]).padStart(8)}${pc(fv[fv.length >> 1]).padStart(9)}`);
});
console.log(`\n(${secs()}s)`);
fs.writeFileSync("research/databox_base_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS, readings: READINGS.map((R) => R.name),
  verdict: RP, real: READINGS.map((R, r) => ({ name: R.name, early: edgeOf(real, r, EARLY), late: edgeOf(real, r, LATE), h1: edgeOf(real, r, [8]), h2: edgeOf(real, r, [9]), follow: real.follow[r * 2 + 1] / real.follow[r * 2] })), placebo: pl }, null, 1));
console.log("wrote research/databox_base_results.json");
