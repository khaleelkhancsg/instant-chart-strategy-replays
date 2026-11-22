// Every combination of the databox's states as an entry, long and short, year by year.
//
//   node --max-old-space-size=12288 research/databox_combos.mjs [--placebos N]
//
// The person's question (2026-11-22): "Potentially short on the 1 min, short on the 1 min,
// potentially short on the 5 min ... and combinations of each. Try every possible combination for
// both longs and shorts."
//
// - The box: the indicator file itself through the Tradovate mock, as research/databox_ten_points
//   .mjs runs it. Four rows: 1m EMA, 1m MACD, 5m EMA, 5m MACD, each Long, Potentially short,
//   Short or Potentially long. A 5m row reads its last closed 5-minute bar.
// - A combination: any non-empty set of rows, each held to one state. That is 624 of them, from
//   "1m MACD Potentially short" to all four rows set. Each is an entry both long and short: 1,248
//   signals.
// - It fires at the close of the minute it becomes true (it was not true the minute before), in
//   the New York session (08:30-14:55 CT). Each firing is followed on 1-minute bars to 15:05 CT,
//   as research/databox_ten_points.mjs --pct follows an alert. The target is 0.1275% of the
//   price: 10 points at 2019's median real price, 37 in 2026. Measured: the share reaching it,
//   the minutes, the points against first, and the share touching it before going the same
//   distance against (target first; a minute touching both counts as the stop).
// - The edge: a signal's target-first rate less every New York minute's in the same direction
//   and year, with z from the binomial spread at its count. A signal needs 100 firings in a year
//   to be read there.
// - Against chance, named before the first run:
//     count   the signal-years beyond 1.96 sd, against the count each placebo market gets
//             (research/lib_levels.mjs placeboBars: each minute's direction flipped at random,
//             the box run on it, everything else the same);
//     pick    the 10 signals with the best z over 2019-2025 (at least 2,000 firings there and
//             100 in 2026), read on 2026, against the same pick made on each placebo market.
// - Every signal and year is written to research/databox_combos.csv.
//
// RESULT (run 2026-11-22, 100 placebo markets): the box's states carry some information, but what
// they say turns over between years. No combination is an entry that holds.
//   - The count: 1,030 of 6,550 signal-years sit beyond 1.96 sd. Placebo markets judged the same
//     way get 458-1,036, median 753, and 1 of 100 gets as many: more than chance, p about 0.02.
//   - 2019-2025 favoured trend-following shorts: short when the 1m and 5m EMA rows are Short, beat
//     random shorts by 1-4 points of target-first rate (pooled z up to 6.1).
//   - The 10 best on 2019-2025, read on 2026: pooled z -2.0. Placebo markets' picks run -6 to 7,
//     median 0.1, and 76 of 100 do as well. They stopped working.
//   - 2026 favoured fades: short when the 1m turns down while the 5m is still bullish.
//       - "1m EMA Short + 1m MACD Pot. short + 5m EMA Pot. long", short: 654 firings, target first
//         57.0% against 49.2% (z 4.0). It held in both halves (+6.8, +9.2) but ran -1.1 to +4.2
//         in 2019-2025.
//       - Smaller cells reach 60-64% on 122-300 firings. Their mirror-image longs lose by as much.
//   - Inside 2026, the 10 best on Jan-Jun read on Jul-Oct: pooled z 2.4. Placebo markets' picks
//     run -6.7 to 6.4, median -0.5, and 12 of 100 do as well, p about 0.12: not established.
//   - Everything was picked on the data that judges it, apart from those two picks. The CSV holds
//     every cell: read a single cell with the count in mind, since about 750 of 6,550 sit past
//     1.96 sd on a market with nothing in it.
//
// The same in money (added 2026-11-22). Every entry gets the identical exit, the symmetric
// bracket: out at the target or the stop, both 0.1275% of the price away, whichever comes first,
// else at 15:05. Net of 1.25 points; net_pts_per_trade in the CSV.
//   - From every minute the bracket nets -0.4 to -2.1 points a trade in every year: a fair bet
//     less the costs.
//   - 2026's 822 signals with 100+ firings run -12.9 to +10.4 points a trade, median -1.27, 5-95%
//     -5.4 to +2.9. That is the spread their counts give on a fair bet.
//   - The 10 best by net P&L on 2019-2025, read on 2026: -2.03 a trade against -1.48 from every
//     minute (t -2.4). Placebo markets' picks give t -6.9 to 6.0, median 0.3, and 85 of 100 do
//     better.
//   - Inside 2026, the 10 best on Jan-Jun read on Jul-Oct: -1.24 against -2.06 (t 1.3). 19 of 100
//     placebo picks do as well. Not established.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample, indexAtOrAfter } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), pi = args.indexOf("--placebos");
const PLACEBOS = pi >= 0 ? Number(args[pi + 1]) : 100;
const MIN = 60000, PCT = 10 / 7844, COST_PTS = 1.25, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55;
// Slots: the years 2019-2026 (0-7), then 2026's halves, Jan-Jun (8) and Jul-Oct (9).
const Y0 = 2019, NY = 8, NS = 10, H2 = Date.UTC(2026, 6, 1), MIN_N = 100, PICK = 10;
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

// ── the combinations: a set of rows, each held to a state ──
const COMBOS = [];
for (let mask = 1; mask < 16; mask++) {
  const rows = [0, 1, 2, 3].filter((r) => (mask >> r) & 1);
  const assign = (k, acc) => { if (k === rows.length) { COMBOS.push(acc.slice()); return; } for (let s = 1; s <= 4; s++) { acc.push([rows[k], s]); assign(k + 1, acc); acc.pop(); } };
  assign(0, []);
}
const NC = COMBOS.length, NCELL = 625;
const digit = (cell, r) => Math.floor(cell / 5 ** r) % 5;
const MATCH = new Uint8Array(NC * NCELL);
COMBOS.forEach((c, k) => { for (let cell = 0; cell < NCELL; cell++) MATCH[k * NCELL + cell] = c.every(([r, s]) => digit(cell, r) === s) ? 1 : 0; });
const labelOf = (c) => c.map(([r, s]) => `${ROWS[r]} ${STATES[s]}`).join(" + ");

// ── one market: every combination's firings, followed ──
// Returns, per combination x year x direction (long 0, short 1): firings, reached, minutes, points
// against and target-first wins; and the same for every New York minute.
function measure(b) {
  const N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const s1 = boxStates(b, 1), b5 = resample(b, 5), s5 = boxStates(b5, 5);
  // each minute's cell: the 1m rows at its bar, the 5m rows at the last 5-minute bar closed by its close
  const cell = new Int16Array(N).fill(-1);
  let k5 = -1;
  for (let i = 0; i < N; i++) {
    while (k5 + 1 < b5.ts.length && b5.ts[k5 + 1] + 5 * MIN <= TS[i] + MIN) k5++;
    const e1 = s1.ema[i], m1 = s1.macd[i], e5 = k5 >= 0 ? s5.ema[k5] : 0, m5 = k5 >= 0 ? s5.macd[k5] : 0;
    cell[i] = e1 + 5 * m1 + 25 * e5 + 125 * m5;
  }
  // per signal-slot-direction (A) and every minute (B): counts and sums, and the bracket's net P&L
  // (points, and basis points of the real price with their squares)
  const fields = ["n", "reached", "minutes", "against", "wins", "pts", "bp", "bpSq"];
  const size = NC * NS * 2, A = Object.fromEntries(fields.map((f) => [f, new Float64Array(size)]));
  const B = Object.fromEntries(fields.map((f) => [f, new Float64Array(NS * 2)]));
  const cache = new Map();
  for (let i = 1; i + 1 < N; i++) {
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i]) continue;
    const y = new Date(TS[i]).getUTCFullYear() - Y0;
    if (y < 0 || y >= NY) continue;
    const P = C[i], raw = C[i] - off[i], tg = PCT * raw;
    // follow long and short from the next minute. The bracket, the same for every entry: out at
    // the target or the stop, both tg away, whichever comes first (a minute touching both is the
    // stop), else at 15:05.
    const res = [1, -1].map((d) => {
      let worst = 0, race = 0, last = i;
      const out = (o) => { const net = o.p - COST_PTS; return { ...o, pts: net, bp: (net / raw) * 1e4 }; };
      for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
        last = j;
        const fav = d > 0 ? H[j] - P : P - L[j], adv = d > 0 ? P - L[j] : H[j] - P;
        if (race === 0) race = adv >= tg ? -1 : fav >= tg ? 1 : 0;
        if (fav >= tg) return out({ r: 1, m: (TS[j] - TS[i + 1]) / MIN + 1, a: Math.max(worst, adv), w: race === 1 ? 1 : 0, p: race === 1 ? tg : -tg });
        worst = Math.max(worst, adv);
      }
      return out({ r: 0, m: 0, a: 0, w: race === 1 ? 1 : 0, p: race === -1 ? -tg : d * (C[last] - P) });
    });
    const slots = y === NY - 1 ? [y, TS[i] < H2 ? 8 : 9] : [y];
    const add = (T, x, o) => { T.n[x]++; T.reached[x] += o.r; T.minutes[x] += o.m; T.against[x] += o.a; T.wins[x] += o.w; T.pts[x] += o.pts; T.bp[x] += o.bp; T.bpSq[x] += o.bp * o.bp; };
    for (const s of slots) for (let d = 0; d < 2; d++) add(B, s * 2 + d, res[d]);
    // the combinations that become true at this minute
    const c0 = cell[i - 1], c1 = cell[i];
    if (c0 === c1) continue;
    const key = c0 * NCELL + c1;
    let on = cache.get(key);
    if (!on) { on = []; for (let k = 0; k < NC; k++) if (MATCH[k * NCELL + c1] && !MATCH[k * NCELL + c0]) on.push(k); cache.set(key, on); }
    for (const k of on) for (const s of slots) for (let d = 0; d < 2; d++) add(A, (k * NS + s) * 2 + d, res[d]);
  }
  return { A, B };
}

// ── reading one market ──
// the z of every signal-year's target-first rate against every minute's (n >= MIN_N), and the pick
function read({ A, B }) {
  const z = new Float64Array(NC * NS * 2).fill(NaN);
  let beyond = 0;
  for (let k = 0; k < NC; k++) for (let s = 0; s < NS; s++) for (let d = 0; d < 2; d++) {
    const x = (k * NS + s) * 2 + d, n = A.n[x], pb = B.wins[s * 2 + d] / B.n[s * 2 + d];
    if (n < (s < NY ? MIN_N : MIN_N / 2) || !(pb > 0 && pb < 1)) continue;
    z[x] = (A.wins[x] / n - pb) / Math.sqrt((pb * (1 - pb)) / n);
    if (s < NY && Math.abs(z[x]) >= 1.96) beyond++;               // the count is over whole years
  }
  // a pick: the best pooled z over the `early` slots, read on the `late` ones
  const pooled = (k, d, ss) => { let ex = 0, v = 0, n = 0; for (const s of ss) { const x = (k * NS + s) * 2 + d, pb = B.wins[s * 2 + d] / B.n[s * 2 + d]; ex += A.wins[x] - A.n[x] * pb; v += A.n[x] * pb * (1 - pb); n += A.n[x]; } return { z: v > 0 ? ex / Math.sqrt(v) : NaN, ex, v, n }; };
  const pick = (early, late, minEarly, minLate) => {
    const cand = [];
    for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) {
      const e = pooled(k, d, early), l = pooled(k, d, late);
      if (e.n >= minEarly && l.n >= minLate) cand.push({ k, d, zEarly: e.z, l });
    }
    cand.sort((a, b) => b.zEarly - a.zEarly);
    const picks = cand.slice(0, PICK), ex = picks.reduce((s, p) => s + p.l.ex, 0), v = picks.reduce((s, p) => s + p.l.v, 0);
    return { picks, z: v > 0 ? ex / Math.sqrt(v) : NaN };
  };
  const p1 = pick([0, 1, 2, 3, 4, 5, 6], [7], 2000, MIN_N), p2 = pick([8], [9], MIN_N, MIN_N / 2);
  // the same on the bracket's net P&L: each signal's net bp a trade over every minute's in the
  // same direction and slot, and the t of that excess
  const pooledPnl = (k, d, ss) => {
    let ex = 0, v = 0, n = 0, pts = 0, base = 0;
    for (const s of ss) {
      const x = (k * NS + s) * 2 + d, bx = s * 2 + d, m = A.n[x];
      if (!m) continue;
      ex += A.bp[x] - (m * B.bp[bx]) / B.n[bx]; v += A.bpSq[x] - (A.bp[x] * A.bp[x]) / m; n += m;
      pts += A.pts[x]; base += (m * B.pts[bx]) / B.n[bx];
    }
    return { t: v > 0 ? ex / Math.sqrt(v) : NaN, ex, v, n, pts, base };
  };
  const pickPnl = (early, late, minEarly, minLate) => {
    const cand = [];
    for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) {
      const e = pooledPnl(k, d, early), l = pooledPnl(k, d, late);
      if (e.n >= minEarly && l.n >= minLate) cand.push({ k, d, tEarly: e.t, l });
    }
    cand.sort((a, b) => b.tEarly - a.tEarly);
    const picks = cand.slice(0, PICK), ex = picks.reduce((s, p) => s + p.l.ex, 0), v = picks.reduce((s, p) => s + p.l.v, 0);
    const n = picks.reduce((s, p) => s + p.l.n, 0), pts = picks.reduce((s, p) => s + p.l.pts, 0), base = picks.reduce((s, p) => s + p.l.base, 0);
    return { picks, t: v > 0 ? ex / Math.sqrt(v) : NaN, ptsPerTrade: n ? pts / n : NaN, basePerTrade: n ? base / n : NaN };
  };
  const q1 = pickPnl([0, 1, 2, 3, 4, 5, 6], [7], 2000, MIN_N), q2 = pickPnl([8], [9], MIN_N, MIN_N / 2);
  return { z, beyond, picks: p1.picks, pickZ2026: p1.z, picksH: p2.picks, pickZH2: p2.z, pnl: q1, pnlH: q2, pooledPnl };
}

const { bars } = loadBars("data/mnq_1m_beta.bin");
const real = measure(bars), R = read(real);
process.stderr.write(`  real market: ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  const r = read(measure(placeboBars(bars, 9100 + p)));
  pl.push({ beyond: r.beyond, pickZ2026: r.pickZ2026, pickZH2: r.pickZH2, pnlT: r.pnl.t, pnlPts: r.pnl.ptsPerTrade, pnlHT: r.pnlH.t });
  if ((p + 1) % 10 === 0) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}

// ── write every signal and slot: each year, then 2026's halves ──
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : "");
const lines = ["signal,direction,period,firings,reached_pct,minutes_avg,against_avg,target_first_pct,every_minute_target_first_pct,edge_pts,z,net_pts_per_trade,every_minute_net_pts,net_bp_per_trade,every_minute_net_bp"];
const { A, B } = real;
for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) for (let s = 0; s < NS; s++) {
  const x = (k * NS + s) * 2 + d, n = A.n[x], bx = s * 2 + d;
  if (!n) continue;
  const p = (100 * A.wins[x]) / n, pb = (100 * B.wins[bx]) / B.n[bx];
  lines.push([`"${labelOf(COMBOS[k])}"`, d ? "short" : "long", slotName(s), n, r1((100 * A.reached[x]) / n), r1(A.reached[x] ? A.minutes[x] / A.reached[x] : NaN),
              r1(A.reached[x] ? A.against[x] / A.reached[x] : NaN), r1(p), r1(pb), r1(p - pb), r1(R.z[x]),
              (A.pts[x] / n).toFixed(2), (B.pts[bx] / B.n[bx]).toFixed(2), (A.bp[x] / n).toFixed(3), (B.bp[bx] / B.n[bx]).toFixed(3)].join(","));
}
fs.writeFileSync("research/databox_combos.csv", lines.join("\n"));

// ── print ──
const sorted = (xs) => xs.filter(Number.isFinite).sort((a, b) => a - b);
const cnt = sorted(pl.map((p) => p.beyond)), pz = sorted(pl.map((p) => p.pickZ2026)), ph = sorted(pl.map((p) => p.pickZH2));
let tested = 0;
for (let k = 0; k < NC; k++) for (let y = 0; y < NY; y++) for (let d = 0; d < 2; d++) if (Number.isFinite(R.z[(k * NS + y) * 2 + d])) tested++;
console.log(`${NC} combinations x long and short = ${NC * 2} signals; ${tested} signal-years with ${MIN_N}+ firings`);
console.log(`Beyond 1.96 sd: ${R.beyond} of ${tested}. Placebo markets: ${cnt[0]}-${cnt[cnt.length - 1]}, median ${cnt[cnt.length >> 1]}; ${pl.filter((p) => p.beyond >= R.beyond).length} of ${PLACEBOS} get as many.`);
const yrs = (k, d) => Array.from({ length: NY }, (_, y) => { const x = (k * NS + y) * 2 + d; const n = A.n[x], pb = B.wins[y * 2 + d] / B.n[y * 2 + d]; return n >= MIN_N ? (100 * (A.wins[x] / n - pb)).toFixed(1).padStart(6) : "     —"; }).join("");
const show = (title, picks, z, zs, key) => {
  console.log(`\n${title} (pooled z ${r1(z)}; placebo markets' picks ${r1(zs[0])} to ${r1(zs[zs.length - 1])}, median ${r1(zs[zs.length >> 1])}, ${pl.filter((p) => p[key] >= z).length} of ${PLACEBOS} as high):`);
  console.log(`${"signal".padEnd(64)}${"dir".padEnd(6)}${"z picked".padStart(9)}${"z read".padStart(8)}   edge by year 2019..2026 (target-first points)`);
  for (const p of picks) console.log(`${labelOf(COMBOS[p.k]).padEnd(64)}${(p.d ? "short" : "long").padEnd(6)}${String(r1(p.zEarly)).padStart(9)}${String(r1(p.l.ex / Math.sqrt(p.l.v))).padStart(8)}   ${yrs(p.k, p.d)}`);
};
show(`The pick: the ${PICK} best on 2019-2025, read on 2026`, R.picks, R.pickZ2026, pz, "pickZ2026");
show(`Inside 2026: the ${PICK} best on Jan-Jun, read on Jul-Oct`, R.picksH, R.pickZH2, ph, "pickZH2");
// 2026's strongest, for the record (picked on 2026 itself, so read with the count above)
const z26 = [];
for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) { const x = (k * NS + 7) * 2 + d; if (Number.isFinite(R.z[x])) z26.push({ k, d, z: R.z[x], n: A.n[x], x }); }
z26.sort((a, b) => b.z - a.z);
console.log(`\n2026's 10 highest and 10 lowest z (picked on 2026 itself):`);
const half = (k, d, s) => { const x = (k * NS + s) * 2 + d, n = A.n[x], pb = B.wins[s * 2 + d] / B.n[s * 2 + d]; return n >= MIN_N / 2 ? (100 * (A.wins[x] / n - pb)).toFixed(1) : "—"; };
for (const s of [...z26.slice(0, 10), ...z26.slice(-10)]) {
  const pb = B.wins[7 * 2 + s.d] / B.n[7 * 2 + s.d];
  console.log(`${labelOf(COMBOS[s.k]).padEnd(64)}${(s.d ? "short" : "long").padEnd(6)} n ${String(s.n).padStart(5)}  target first ${(100 * A.wins[s.x] / s.n).toFixed(1)}% vs ${(100 * pb).toFixed(1)}%  z ${s.z.toFixed(2).padStart(6)}  halves ${half(s.k, s.d, 8)} / ${half(s.k, s.d, 9)}   by year ${yrs(s.k, s.d)}`);
}
console.log(`\nEvery minute, target first (long / short): ${Array.from({ length: NS }, (_, s) => `${slotName(s)} ${(100 * B.wins[s * 2] / B.n[s * 2]).toFixed(1)}/${(100 * B.wins[s * 2 + 1] / B.n[s * 2 + 1]).toFixed(1)}`).join(", ")}`);
// ── the same bracket's net P&L: every minute, the signals' spread, and the pick ──
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—");
console.log(`\nThe bracket's net points a trade from every minute (long / short): ${Array.from({ length: NS }, (_, s) => `${slotName(s)} ${f2(B.pts[s * 2] / B.n[s * 2])}/${f2(B.pts[s * 2 + 1] / B.n[s * 2 + 1])}`).join(", ")}`);
{
  const v = [];
  for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) { const x = (k * NS + 7) * 2 + d; if (A.n[x] >= MIN_N) v.push(A.pts[x] / A.n[x]); }
  v.sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  console.log(`2026, the ${v.length} signals with ${MIN_N}+ firings: net points a trade from ${f2(q(0))} (5% ${f2(q(0.05))}, median ${f2(q(0.5))}, 95% ${f2(q(0.95))}) to ${f2(q(1))}`);
}
const tz = sorted(pl.map((p) => p.pnlT)), th = sorted(pl.map((p) => p.pnlHT));
for (const [title, P, zs, key, late] of [[`The ${PICK} best by net P&L on 2019-2025, read on 2026`, R.pnl, tz, "pnlT", 7], [`Inside 2026: the ${PICK} best on Jan-Jun, read on Jul-Oct`, R.pnlH, th, "pnlHT", 9]]) {
  console.log(`\n${title}: ${f2(P.ptsPerTrade)} net points a trade against ${f2(P.basePerTrade)} from every minute, t of the excess ${r1(P.t)}. ` +
              `Placebo markets' picks t ${r1(zs[0])} to ${r1(zs[zs.length - 1])}, median ${r1(zs[zs.length >> 1])}; ${pl.filter((p) => p[key] >= P.t).length} of ${PLACEBOS} as high`);
  for (const p of P.picks) console.log(`  ${labelOf(COMBOS[p.k]).padEnd(64)}${(p.d ? "short" : "long").padEnd(6)} t picked ${r1(p.tEarly)}, read: ${f2(p.l.n ? p.l.pts / p.l.n : NaN)} net pts a trade (every minute ${f2(p.l.n ? p.l.base / p.l.n : NaN)}), ${p.l.n} trades`);
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s; wrote research/databox_combos.csv (${lines.length - 1} rows)`);
const pk = (ps) => ps.map((p) => ({ signal: labelOf(COMBOS[p.k]), dir: p.d ? "short" : "long", zPicked: p.zEarly, zRead: p.l.ex / Math.sqrt(p.l.v), nRead: p.l.n }));
const pkP = (ps) => ps.map((p) => ({ signal: labelOf(COMBOS[p.k]), dir: p.d ? "short" : "long", tPicked: p.tEarly, netPtsRead: p.l.n ? p.l.pts / p.l.n : null, everyMinutePts: p.l.n ? p.l.base / p.l.n : null, nRead: p.l.n }));
fs.writeFileSync("research/databox_combos_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS, beyond: R.beyond, tested, placeboBeyond: cnt,
  pick: { z: R.pickZ2026, placebo: pz, picks: pk(R.picks) }, pickInside2026: { z: R.pickZH2, placebo: ph, picks: pk(R.picksH) },
  pnlPick: { t: R.pnl.t, ptsPerTrade: R.pnl.ptsPerTrade, basePerTrade: R.pnl.basePerTrade, placebo: tz, picks: pkP(R.pnl.picks) },
  pnlPickInside2026: { t: R.pnlH.t, ptsPerTrade: R.pnlH.ptsPerTrade, basePerTrade: R.pnlH.basePerTrade, placebo: th, picks: pkP(R.pnlH.picks) } }, null, 1));
