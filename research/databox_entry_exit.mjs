// Every databox entry with every databox exit, long and short, year by year.
//
//   node --max-old-space-size=12288 research/databox_entry_exit.mjs [--placebos N]
//
// The person's question (2026-11-22): the entries alone were tested (research/databox_combos.mjs).
// Would results improve with the exit chosen from the box as well? Every pairing, then.
//
// - Entry: one of the 624 state combinations of the four rows (1m EMA, 1m MACD, 5m EMA, 5m MACD,
//   each Long, Potentially short, Short or Potentially long) becomes true at a minute's close in
//   the New York session (08:30-14:55 CT). It is taken long or short: 1,248 entry signals, as in
//   databox_combos.mjs.
// - Exit: the close of the first later minute where an exit combination is true (any of the 624),
//   else 15:05 CT, the bots' flat time. Or 15:05 alone, no exit signal. 625 exits.
// - One position at a time: an entry while a trade is open is ignored.
// - P&L is in basis points of the contract's real price at entry, after a round trip of 1.25
//   points (a tick a side and $0.75 a side a contract), so years at different prices compare.
//   The round trip is 0.43 bp at 2026's 29,000 and 1.6 at 2019's 7,800.
// - 624 x 625 x 2 = 780,000 strategies. They are picked on 2019-2025 by the t of their net P&L a
//   trade (700 trades at least there, 50 in 2026) and read on 2026. Inside 2026 they are picked on
//   Jan-Jun (50 trades) and read on Jul-Oct (25).
// - Against chance: the same search on placebo markets (research/lib_levels.mjs placeboBars:
//   each minute's direction flipped at random, the box run on them). The best of 780,000 looks
//   good anywhere. What matters is whether the real market's picks hold up later better than
//   placebo markets' picks do.
// - Named before the first run: the pooled 2026 t of the 10 best picked on 2019-2025, against the
//   placebo markets' picks, and the same inside 2026.
// - research/databox_entry_exit_top.csv: the 2,000 best on 2019-2025 and the 2,000 best on 2026,
//   with every year's trades and net P&L. --detail prints the picks' trades in the period they
//   are read on.
//
// RESULT (run 2026-11-22, 100 placebo markets, 35 minutes): no. Pairing the box's exits with its
// entries finds nothing that holds, and nothing that stands out even where it was picked.
//   - Picked on 2019-2025, the best in-sample t of 780,000 is 3.3. Placebo markets' best run
//     2.4-4.2, median 3.1.
//   - Those 10 picks in 2026: +0.55 bp a trade (about 1.6 points), t 0.6 over 1,560 trades.
//     Placebo markets' picks give t -7.3 to 6.0, median 0.2, and 44 of 100 do as well.
//   - All ten picks are longs. Five made most of their in-sample on 2022 (19.8-23.2 bp a trade
//     that year).
//   - Inside 2026, picked on Jan-Jun: the best t is 4.4 (placebo markets 3.5-7.3, median 4.6). On
//     Jul-Oct: +0.84 bp a trade (about 2.4 points), t 1.5 over 1,190 trades. 13 of 100 placebo
//     markets' picks do as well, p about 0.13.
//   - With no stop they carry tails no eval survives (--detail):
//       - in 2026 the 2019-2025 picks held 83-142 minutes (median), and 25-56% of their trades
//         rode to 15:05;
//       - their worst trades fell 349-611 points a contract at the low, and their running totals
//         549-2,198 points ($1,100-4,400 a contract);
//       - the Jan-Jun picks held 4-12 minutes (one 61), with worst lows of 177-524 points.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), pi = args.indexOf("--placebos");
const PLACEBOS = pi >= 0 ? Number(args[pi + 1]) : 20;
const MIN = 60000, COST_PTS = 1.25, OPEN = 509, LAST_ENTRY = 894, LAST_BAR = 904;   // bar CT minutes: closes 08:30 .. 14:55, out by 15:05
const Y0 = 2019, NY = 8, NS = 10, H2 = Date.UTC(2026, 6, 1), PICK = 10, MIN_IN = 700, MIN_26 = 50, MIN_H1 = 50, MIN_H2 = 25;
const slotName = (s) => (s < NY ? String(Y0 + s) : s === 8 ? "2026 Jan-Jun" : "2026 Jul-Oct");
const ROWS = ["1m EMA", "1m MACD", "5m EMA", "5m MACD"], STATES = ["", "Long", "Pot. short", "Short", "Pot. long"];
const t0 = Date.now();

// ── the box, from the indicator's own code ──
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
function boxStates(T, minutes) {
  const run = new Run(BOX, { minutes, check: false }), map = run.calc.map.bind(run.calc);
  const n = T.close.length, ema = new Int8Array(n), macd = new Int8Array(n);
  run.calc.map = (d, i) => { const out = map(d, i), S = run.calc.st[i]; ema[i] = code(S.ema, S.emaReady); macd[i] = code(S.macd, S.macdReady); return out; };
  run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
  return { ema, macd };
}

// ── the combinations ──
const COMBOS = [];
for (let mask = 1; mask < 16; mask++) {
  const rows = [0, 1, 2, 3].filter((r) => (mask >> r) & 1);
  const assign = (k, acc) => { if (k === rows.length) { COMBOS.push(acc.slice()); return; } for (let s = 1; s <= 4; s++) { acc.push([rows[k], s]); assign(k + 1, acc); acc.pop(); } };
  assign(0, []);
}
const NC = COMBOS.length, NX = NC + 1, NCELL = 625, TIME_ONLY = NC;
const digit = (cell, r) => Math.floor(cell / 5 ** r) % 5;
const MATCH = new Uint8Array(NC * NCELL);
COMBOS.forEach((c, k) => { for (let cell = 0; cell < NCELL; cell++) MATCH[k * NCELL + cell] = c.every(([r, s]) => digit(cell, r) === s) ? 1 : 0; });
const labelOf = (k) => (k === TIME_ONLY ? "15:05 only" : COMBOS[k].map(([r, s]) => `${ROWS[r]} ${STATES[s]}`).join(" + "));

// ── one market: every entry x exit, its trades' gross P&L by slot ──
const SZ = NC * NX * NS;
// each 1-minute bar's cell: the 1m rows at its bar, the 5m rows at the last 5-minute bar closed by its close
function cellsOf(b) {
  const N = b.close.length, TS = b.ts;
  const s1 = boxStates(b, 1), b5 = resample(b, 5), s5 = boxStates(b5, 5);
  const cell = new Int16Array(N);
  let k5 = -1;
  for (let i = 0; i < N; i++) {
    while (k5 + 1 < b5.ts.length && b5.ts[k5 + 1] + 5 * MIN <= TS[i] + MIN) k5++;
    cell[i] = s1.ema[i] + 5 * s1.macd[i] + 25 * (k5 >= 0 ? s5.ema[k5] : 0) + 125 * (k5 >= 0 ? s5.macd[k5] : 0);
  }
  return cell;
}
// One strategy's trades from `from` to `to`, in points a contract (net of the round trip), with the
// minutes held and whether it rode to 15:05: the detail a bot would need, stop or no stop.
function tradesOf(b, cell, E, X, d, from, to) {
  const N = b.close.length, TS = b.ts, C = b.close, TD = b.tday, CT = b.ctMin, out = [];
  for (let i = 1; i < N; ) {
    if (!(CT[i] >= OPEN && CT[i] <= LAST_BAR) || (TD[i] === TD[i - 1] && CT[i - 1] >= OPEN && CT[i - 1] <= LAST_BAR)) { i++; continue; }
    const a = i;
    let z = i;
    while (z + 1 < N && TD[z + 1] === TD[a] && CT[z + 1] >= OPEN && CT[z + 1] <= LAST_BAR) z++;
    i = z + 1;
    if (TS[a] < from || TS[a] >= to || z - a + 1 < 30) continue;
    let free = -1;
    for (let m = a; m <= z && CT[m] <= LAST_ENTRY; m++) {
      if (m <= free || !MATCH[E * NCELL + cell[m]] || MATCH[E * NCELL + cell[m - 1]]) continue;
      let ex = z;
      if (X !== TIME_ONLY) for (let j = m + 1; j <= z; j++) if (MATCH[X * NCELL + cell[j]]) { ex = j; break; }
      let worst = 0;
      for (let j = m + 1; j <= ex; j++) worst = Math.min(worst, d * ((d > 0 ? b.low[j] : b.high[j]) - C[m]));
      out.push({ pts: d * (C[ex] - C[m]) - COST_PTS, minutes: ex - m, toFlat: ex === z, worst, ts: TS[m] });
      free = ex;
    }
  }
  return out;
}
function measure(b) {
  const N = b.close.length, TS = b.ts, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const cell = cellsOf(b);
  const n = new Float64Array(SZ), sum = new Float64Array(SZ), sq = new Float64Array(SZ), cost = new Float64Array(SZ);
  const onsetCache = new Map(), MAXL = 420;
  const NT = new Int16Array(NX * (MAXL + 1)), F = new Int16Array(NC * MAXL), FN = new Int16Array(NC), used = [];
  for (let i = 1; i < N; ) {
    // a New York segment: one trading day's bars from the 08:30 close to the 15:04 bar
    if (!(CT[i] >= OPEN && CT[i] <= LAST_BAR) || (TD[i] === TD[i - 1] && CT[i - 1] >= OPEN && CT[i - 1] <= LAST_BAR)) { i++; continue; }
    const a = i;
    let z = i;
    while (z + 1 < N && TD[z + 1] === TD[a] && CT[z + 1] >= OPEN && CT[z + 1] <= LAST_BAR && z + 1 - a < MAXL) z++;
    i = z + 1;
    const L = z - a + 1, yr = new Date(TS[a]).getUTCFullYear() - Y0;
    if (yr < 0 || yr >= NY || L < 30) continue;
    const half = yr === NY - 1 ? (TS[a] < H2 ? 8 : 9) : -1;
    // for each exit: the first minute at or after m where it is true (L if none)
    for (let X = 0; X < NC; X++) {
      const base = X * (L + 1);
      let nt = L;
      NT[base + L] = L;
      for (let m = L - 1; m >= 0; m--) { if (MATCH[X * NCELL + cell[a + m]]) nt = m; NT[base + m] = nt; }
    }
    { const base = TIME_ONLY * (L + 1); for (let m = 0; m <= L; m++) NT[base + m] = L; }
    // the entries that fire in this segment
    for (const E of used) FN[E] = 0;
    used.length = 0;
    for (let m = 0; m < L; m++) {
      if (CT[a + m] > LAST_ENTRY) break;
      const c0 = cell[a + m - 1], c1 = cell[a + m];
      if (c0 === c1) continue;
      const key = c0 * NCELL + c1;
      let on = onsetCache.get(key);
      if (!on) { on = []; for (let k = 0; k < NC; k++) if (MATCH[k * NCELL + c1] && !MATCH[k * NCELL + c0]) on.push(k); onsetCache.set(key, on); }
      for (const E of on) { if (FN[E] === 0) used.push(E); F[E * MAXL + FN[E]++] = m; }
    }
    // every entry x exit: its trades, one at a time
    for (const E of used) {
      const cnt = FN[E], fb = E * MAXL;
      for (let X = 0; X < NX; X++) {
        const base = X * (L + 1), idx = (E * NX + X) * NS + yr, idxH = half >= 0 ? (E * NX + X) * NS + half : -1;
        let free = -1;
        for (let q = 0; q < cnt; q++) {
          const m = F[fb + q];
          if (m <= free) continue;
          const x = NT[base + m + 1], ex = x < L ? x : L - 1, ia = a + m, raw = C[ia] - off[ia];
          const g = ((C[a + ex] - C[ia]) / raw) * 1e4, c = (COST_PTS / raw) * 1e4;
          n[idx]++; sum[idx] += g; sq[idx] += g * g; cost[idx] += c;
          if (idxH >= 0) { n[idxH]++; sum[idxH] += g; sq[idxH] += g * g; cost[idxH] += c; }
          free = ex;
        }
      }
    }
  }
  return { n, sum, sq, cost };
}

// ── reading one market ──
// Pooled over slots: trades, mean net bp a trade and its t, for a direction (+1 long, -1 short).
function pooled(M, E, X, d, slots) {
  let n = 0, s = 0, q = 0, c = 0;
  for (const sl of slots) { const i = (E * NX + X) * NS + sl; n += M.n[i]; s += M.sum[i]; q += M.sq[i]; c += M.cost[i]; }
  if (!n) return { n: 0, mean: NaN, t: NaN, s: 0, q: 0, c: 0 };
  const mean = (d * s - c) / n, v = q / n - (s / n) ** 2;
  return { n, mean, t: v > 0 ? mean / Math.sqrt(v / n) : NaN, s: d * s, q, c };
}
const INS = [0, 1, 2, 3, 4, 5, 6];
function pick(M, early, late, minE, minL) {
  const top = [];   // keep the best PICK by t on `early`
  let best = -Infinity;
  for (let E = 0; E < NC; E++) for (let X = 0; X < NX; X++) for (const d of [1, -1]) {
    const e = pooled(M, E, X, d, early);
    if (e.n < minE || !(e.t > (top.length < PICK ? -Infinity : top[top.length - 1].t))) { if (e.n >= minE && e.t > best) best = e.t; continue; }
    const l = pooled(M, E, X, d, late);
    if (l.n < minL) continue;
    if (e.t > best) best = e.t;
    top.push({ E, X, d, t: e.t, mean: e.mean, n: e.n, late: l });
    top.sort((p, r) => r.t - p.t);
    if (top.length > PICK) top.pop();
  }
  // the picks' late trades pooled: mean net bp and its t
  let n = 0, s = 0, q = 0, c = 0;
  for (const p of top) { n += p.late.n; s += p.late.s; q += p.late.q; c += p.late.c; }
  const mean = n ? (s - c) / n : NaN, v = n ? q / n - (s / n) ** 2 : NaN;
  return { picks: top, best, lateMean: mean, lateT: v > 0 ? mean / Math.sqrt(v / n) : NaN, lateN: n };
}
const read = (M) => ({ year: pick(M, INS, [7], MIN_IN, MIN_26), inside: pick(M, [8], [9], MIN_H1, MIN_H2) });

const { bars } = loadBars("data/mnq_1m_beta.bin");
const real = measure(bars);
process.stderr.write(`  real market measured, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
const R = read(real);
process.stderr.write(`  read, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
// --detail: the picks' trades in the period they are read on, then stop (no placebo markets)
if (args.includes("--detail")) {
  const cell = cellsOf(bars), Y26 = Date.UTC(2026, 0, 1), END = Date.UTC(2027, 0, 1);
  const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : "—"), f1d = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—");
  for (const [title, P, from] of [["The 10 best on 2019-2025, in 2026", R.year, Y26], ["The 10 best on 2026 Jan-Jun, in Jul-Oct", R.inside, H2]]) {
    console.log(`\n${title}: trades, net points a trade, minutes held (median), share riding to 15:05, worst trade's low point and worst close, deepest fall of the running total (points a contract)`);
    for (const p of P.picks) {
      const tr = tradesOf(bars, cell, p.E, p.X, p.d, from, END), pts = tr.map((t) => t.pts), mins = tr.map((t) => t.minutes).sort((a, b) => a - b);
      let cum = 0, peak = 0, fall = 0;
      for (const x of pts) { cum += x; peak = Math.max(peak, cum); fall = Math.max(fall, peak - cum); }
      console.log(`  ${(p.d > 0 ? "long " : "short") } ${labelOf(p.E).slice(0, 50).padEnd(51)} exit ${labelOf(p.X).slice(0, 44).padEnd(45)} ${String(tr.length).padStart(4)} ${f1d(pts.reduce((s, x) => s + x, 0) / pts.length).padStart(6)} ${String(mins[mins.length >> 1]).padStart(4)}m ` +
                  `${f0((100 * tr.filter((t) => t.toFlat).length) / tr.length).padStart(3)}% ${f0(Math.min(...tr.map((t) => t.worst))).padStart(6)} ${f0(Math.min(...pts)).padStart(6)} ${f0(fall).padStart(6)}`);
    }
  }
  process.exit(0);
}
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  const r = read(measure(placeboBars(bars, 9300 + p)));
  pl.push({ bestIn: r.year.best, pickT: r.year.lateT, pickMean: r.year.lateMean, bestH1: r.inside.best, insideT: r.inside.lateT, insideMean: r.inside.lateMean });
  process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}

// ── print ──
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—"), f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const dist = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? `${f1(v[0])} to ${f1(v[v.length - 1])}, median ${f1(v[v.length >> 1])}` : "—"; };
const atLeast = (key, x) => pl.filter((p) => p[key] >= x).length;
const byYear = (E, X, d) => Array.from({ length: NY }, (_, y) => { const r = pooled(real, E, X, d, [y]); return (r.n >= 30 ? f1(r.mean) : "—").padStart(6); }).join("");
const show = (title, P, lateName) => {
  console.log(`\n${title}`);
  console.log(`${"entry".padEnd(58)}${"exit".padEnd(46)}${"dir".padEnd(6)}${"t".padStart(6)}${"bp/tr".padStart(7)}${("t " + lateName).padStart(11)}${"bp/tr".padStart(7)}${"n".padStart(6)}   net bp a trade by year 2019..2026`);
  for (const p of P.picks) console.log(`${labelOf(p.E).slice(0, 57).padEnd(58)}${labelOf(p.X).slice(0, 45).padEnd(46)}${(p.d > 0 ? "long" : "short").padEnd(6)}${f1(p.t).padStart(6)}${f2(p.mean).padStart(7)}${f1(p.late.t).padStart(11)}${f2(p.late.mean).padStart(7)}${String(p.late.n).padStart(6)}   ${byYear(p.E, p.X, p.d)}`);
};
console.log(`${NC} entries x ${NX} exits x long and short = ${(NC * NX * 2).toLocaleString()} strategies; ${PLACEBOS} placebo markets; ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`\nPicked on 2019-2025, read on 2026:`);
console.log(`  the best in-sample t: real ${f1(R.year.best)}; placebo markets ${dist(pl.map((p) => p.bestIn))}`);
console.log(`  the ${PICK} picks on 2026: ${f2(R.year.lateMean)} bp a trade, t ${f1(R.year.lateT)} over ${R.year.lateN} trades; placebo markets' picks t ${dist(pl.map((p) => p.pickT))} (${atLeast("pickT", R.year.lateT)} of ${PLACEBOS} as high)`);
console.log(`Inside 2026, picked on Jan-Jun, read on Jul-Oct:`);
console.log(`  the best in-sample t: real ${f1(R.inside.best)}; placebo markets ${dist(pl.map((p) => p.bestH1))}`);
console.log(`  the ${PICK} picks on Jul-Oct: ${f2(R.inside.lateMean)} bp a trade, t ${f1(R.inside.lateT)} over ${R.inside.lateN} trades; placebo markets' picks t ${dist(pl.map((p) => p.insideT))} (${atLeast("insideT", R.inside.lateT)} of ${PLACEBOS} as high)`);
show(`The ${PICK} best on 2019-2025, and their 2026:`, R.year, "2026");
show(`The ${PICK} best on 2026 Jan-Jun, and their Jul-Oct:`, R.inside, "Jul-Oct");
console.log(`\n(1 bp is about 2.9 points at 2026's price, 0.8 at 2019's. ${((Date.now() - t0) / 1000).toFixed(0)}s)`);

// ── the 2,000 best on 2019-2025 and on 2026, every slot ──
const rank = (slots, minN) => {
  const out = [];
  for (let E = 0; E < NC; E++) for (let X = 0; X < NX; X++) for (const d of [1, -1]) { const r = pooled(real, E, X, d, slots); if (r.n >= minN && Number.isFinite(r.t)) out.push({ E, X, d, t: r.t }); }
  return out.sort((a, b) => b.t - a.t).slice(0, 2000);
};
const lines = ["ranked_on,rank,entry,exit,direction,t_ranked," + Array.from({ length: NS }, (_, s) => `${slotName(s)} trades,${slotName(s)} net bp`).join(",")];
for (const [name, slots, minN] of [["2019-2025", INS, MIN_IN], ["2026", [7], MIN_26]]) rank(slots, minN).forEach((r, k) => {
  const cells = Array.from({ length: NS }, (_, s) => { const p = pooled(real, r.E, r.X, r.d, [s]); return `${p.n},${p.n ? p.mean.toFixed(3) : ""}`; });
  lines.push([name, k + 1, `"${labelOf(r.E)}"`, `"${labelOf(r.X)}"`, r.d > 0 ? "long" : "short", r.t.toFixed(2), ...cells].join(","));
});
fs.writeFileSync("research/databox_entry_exit_top.csv", lines.join("\n"));
const pk = (P) => P.picks.map((p) => ({ entry: labelOf(p.E), exit: labelOf(p.X), dir: p.d > 0 ? "long" : "short", tPicked: p.t, bpPicked: p.mean, tRead: p.late.t, bpRead: p.late.mean, nRead: p.late.n }));
fs.writeFileSync("research/databox_entry_exit_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS, strategies: NC * NX * 2,
  year: { best: R.year.best, lateMean: R.year.lateMean, lateT: R.year.lateT, picks: pk(R.year) }, inside: { best: R.inside.best, lateMean: R.inside.lateMean, lateT: R.inside.lateT, picks: pk(R.inside) }, placebo: pl }, null, 1));
console.log("wrote research/databox_entry_exit_top.csv and research/databox_entry_exit_results.json");
