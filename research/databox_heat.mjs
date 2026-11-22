// Does any databox entry take less heat before its target? Every entry signal, year by year.
//
//   node --max-old-space-size=12288 research/databox_heat.mjs [--placebos N]
//
// The person's question (2026-11-22): after an alert, price goes a long way against the trade
// before it reaches the target. research/databox_ten_points.mjs, 2026, 1m both rows:
//   - with a 10-point target, an average of 20 points against first, median 10, 1 in 10 past 50;
//   - with the price-scaled target (37 points), 36 against, median 21, 1 in 10 past 89.
// Does any of the 780,000 entry and exit strategies change that?
//
// The heat before the target is set by the entry: where and when the trade starts, and which way.
// An exit decides only when to leave, so it cannot change the path to the target, only leave
// before it. So this reads the 1,248 entry signals of research/databox_combos.mjs: the 624 state
// combinations of the four rows, each long and short, firing the minute they become true.
//
// - Each firing is followed to 15:05 CT, as there. Heat is the furthest price goes against the
//   trade before it touches the target, counting the target's own minute in full. A firing that
//   never touches it by 15:05 counts the furthest it went against by then, so a signal cannot look
//   calm by losing the firings that never got there.
// - Two targets: 10 points, and the price-scaled one (0.1275% of the real price, 37 points in
//   2026).
// - Against what: every New York minute in the same direction and year at the same times of day.
//   That is 15-minute slots, weighted as the signal's firings fall. A quiet hour has smaller heat,
//   so a signal that fires late would otherwise look calm for nothing.
// - Also: the share that touch the 10-point target before going 40 points against, the room a
//   40-point stop gives.
// - Against chance: the same on placebo markets (research/lib_levels.mjs placeboBars).
// - Named before the first run, for each target: the 10 signals with the least heat for their
//   times over 2019-2025 (2,000 firings at least there, 100 in 2026), read on 2026, against the
//   same pick on each placebo market. Also the count of signal-years beyond 1.96 sd either way.
//
// RESULT (run 2026-11-22, 100 placebo markets): some entries do take less heat for their times,
// and it lasts. But it is because they move less both ways: none takes less heat and wins more.
//   - Every minute, counting every firing, 2026:
//       - 10 points: 31.3 points of heat on average, and the target comes before 40 against 80% of
//         the time;
//       - price-scaled (37 points): 64.6;
//       - those that touch the target average 20 and 36 (research/databox_ten_points.mjs).
//   - More signal-years calmer than their times than chance gives: 733 (10 points) and 903
//     (price-scaled) beyond 1.96 sd. Placebo markets get a median of 487 and 559, and none of 100
//     gets as many. There are more rougher ones too: 362 and 466 against 230 and 320.
//   - The pick, price-scaled: the 10 calmest for their times on 2019-2025 took 0.88 of their times'
//     heat in 2026. Placebo markets' picks run 0.87-1.11, median 0.99, and 1 of 100 is as calm.
//     They are mostly longs as the 1m turns up inside a 5m downtrend.
//       - But they move less both ways. In 2026 they reached the target 66.2% of the time against
//         71.5% from any minute, in 43.8 minutes against 35.
//       - Their target-first edge (research/databox_combos.csv) was -3.2 to +3.3 points (z -1.3 to
//         1.2). Quieter entries, not better ones.
//   - The pick, 10 points: 0.95 of their times' heat in 2026, and 19 of 100 placebo picks are as
//     calm.
//   - Exits cannot change any of this: the path to the target is set when the trade starts.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), pi = args.indexOf("--placebos");
const PLACEBOS = pi >= 0 ? Number(args[pi + 1]) : 100;
const MIN = 60000, PCT = 10 / 7844, ROOM = 40, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, NB = 26;   // 15-minute slots of closes 08:30-14:55
const Y0 = 2019, NY = 8, NS = 10, H2 = Date.UTC(2026, 6, 1), MIN_N = 100, PICK = 10, NT = 2;
const slotName = (s) => (s < NY ? String(Y0 + s) : s === 8 ? "2026 Jan-Jun" : "2026 Jul-Oct");
const TARGETS = ["10 points", "price-scaled"];
const ROWS = ["1m EMA", "1m MACD", "5m EMA", "5m MACD"], STATES = ["", "Long", "Pot. short", "Short", "Pot. long"];
const t0 = Date.now();

// ── the box and the combinations, as research/databox_combos.mjs has them ──
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
function boxStates(T, minutes) {
  const run = new Run(BOX, { minutes, check: false }), map = run.calc.map.bind(run.calc);
  const n = T.close.length, ema = new Int8Array(n), macd = new Int8Array(n);
  run.calc.map = (d, i) => { const out = map(d, i), S = run.calc.st[i]; ema[i] = code(S.ema, S.emaReady); macd[i] = code(S.macd, S.macdReady); return out; };
  run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
  return { ema, macd };
}
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
const labelOf = (k) => COMBOS[k].map(([r, s]) => `${ROWS[r]} ${STATES[s]}`).join(" + ");

// ── one market ──
// Per signal x slot x direction x target: firings, summed heat and its square, reached, and (10
// points) target before 40 against. Per slot x direction x target x 15-minute slot, the same for
// every minute; and each signal's firings by 15-minute slot, to weigh the baseline by.
const SIG = NC * NS * 2 * NT, BASE = NS * 2 * NT * NB;
const sIdx = (k, s, d, t) => ((k * NS + s) * 2 + d) * NT + t, bIdx = (s, d, t, b) => ((s * 2 + d) * NT + t) * NB + b;
function measure(b) {
  const N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const s1 = boxStates(b, 1), b5 = resample(b, 5), s5 = boxStates(b5, 5);
  const cell = new Int16Array(N);
  let k5 = -1;
  for (let i = 0; i < N; i++) {
    while (k5 + 1 < b5.ts.length && b5.ts[k5 + 1] + 5 * MIN <= TS[i] + MIN) k5++;
    cell[i] = s1.ema[i] + 5 * s1.macd[i] + 25 * (k5 >= 0 ? s5.ema[k5] : 0) + 125 * (k5 >= 0 ? s5.macd[k5] : 0);
  }
  const S = { n: new Float64Array(SIG), heat: new Float64Array(SIG), sq: new Float64Array(SIG), reached: new Float64Array(SIG), room: new Float64Array(SIG) };
  const Bm = { n: new Float64Array(BASE), heat: new Float64Array(BASE), sq: new Float64Array(BASE), reached: new Float64Array(BASE), room: new Float64Array(BASE) };
  const fires = new Float64Array(NC * NS * NB);
  const cache = new Map(), res = new Float64Array(2 * NT * 3);   // per d, t: heat, reached, room
  for (let i = 1; i + 1 < N; i++) {
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i]) continue;
    const y = new Date(TS[i]).getUTCFullYear() - Y0;
    if (y < 0 || y >= NY) continue;
    const slots = y === NY - 1 ? [y, TS[i] < H2 ? 8 : 9] : [y], bk = Math.min(NB - 1, Math.floor((closeCt - FIRST) / 15));
    const P = C[i], tgs = [10, PCT * (C[i] - off[i])];
    for (let d = 0; d < 2; d++) for (let t = 0; t < NT; t++) {
      const dir = d === 0 ? 1 : -1, tg = tgs[t];
      let worst = 0, reached = 0, room = 0, decided = false;
      for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
        const fav = dir > 0 ? H[j] - P : P - L[j], adv = dir > 0 ? P - L[j] : H[j] - P;
        if (!decided && adv >= ROOM) decided = true;                               // 40 against first (or with it)
        if (fav >= tg) { worst = Math.max(worst, adv); reached = 1; if (!decided) room = 1; break; }
        worst = Math.max(worst, adv);
      }
      const r = (d * NT + t) * 3;
      res[r] = worst; res[r + 1] = reached; res[r + 2] = room;
    }
    for (const s of slots) for (let d = 0; d < 2; d++) for (let t = 0; t < NT; t++) {
      const r = (d * NT + t) * 3, x = bIdx(s, d, t, bk);
      Bm.n[x]++; Bm.heat[x] += res[r]; Bm.sq[x] += res[r] * res[r]; Bm.reached[x] += res[r + 1]; Bm.room[x] += res[r + 2];
    }
    const c0 = cell[i - 1], c1 = cell[i];
    if (c0 === c1) continue;
    const key = c0 * NCELL + c1;
    let on = cache.get(key);
    if (!on) { on = []; for (let k = 0; k < NC; k++) if (MATCH[k * NCELL + c1] && !MATCH[k * NCELL + c0]) on.push(k); cache.set(key, on); }
    for (const k of on) for (const s of slots) {
      fires[(k * NS + s) * NB + bk]++;
      for (let d = 0; d < 2; d++) for (let t = 0; t < NT; t++) {
        const r = (d * NT + t) * 3, x = sIdx(k, s, d, t);
        S.n[x]++; S.heat[x] += res[r]; S.sq[x] += res[r] * res[r]; S.reached[x] += res[r + 1]; S.room[x] += res[r + 2];
      }
    }
  }
  return { S, Bm, fires };
}

// ── reading one market ──
// A signal over slots: firings, its mean heat, the mean its times would give (every minute in the
// same direction, slot by slot, weighed by its firings per 15 minutes), and the z of the gap.
function cellOf(M, k, d, t, slots) {
  let n = 0, heat = 0, sq = 0, exp = 0, reached = 0, room = 0, expRoom = 0;
  for (const s of slots) {
    const x = sIdx(k, s, d, t);
    n += M.S.n[x]; heat += M.S.heat[x]; sq += M.S.sq[x]; reached += M.S.reached[x]; room += M.S.room[x];
    for (let b = 0; b < NB; b++) {
      const f = M.fires[(k * NS + s) * NB + b];
      if (!f) continue;
      const bx = bIdx(s, d, t, b);
      if (M.Bm.n[bx]) { exp += (f * M.Bm.heat[bx]) / M.Bm.n[bx]; expRoom += (f * M.Bm.room[bx]) / M.Bm.n[bx]; }
    }
  }
  const mean = n ? heat / n : NaN, v = n ? sq / n - mean * mean : NaN;
  return { n, mean, exp: n ? exp / n : NaN, ratio: exp > 0 ? heat / exp : NaN, z: v > 0 ? (heat - exp) / n / Math.sqrt(v / n) : NaN, reached: n ? reached / n : NaN, room: n ? room / n : NaN, expRoom: n ? expRoom / n : NaN, heatSum: heat, expSum: exp };
}
const INS = [0, 1, 2, 3, 4, 5, 6];
function read(M) {
  const out = [];
  for (let t = 0; t < NT; t++) {
    let calm = 0, rough = 0;
    for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) for (let s = 0; s < NY; s++) {
      const c = cellOf(M, k, d, t, [s]);
      if (c.n < MIN_N || !Number.isFinite(c.z)) continue;
      if (c.z <= -1.96) calm++; else if (c.z >= 1.96) rough++;
    }
    const cand = [];
    for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) {
      const e = cellOf(M, k, d, t, INS), l = cellOf(M, k, d, t, [7]);
      if (e.n >= 2000 && l.n >= MIN_N && Number.isFinite(e.ratio)) cand.push({ k, d, ratio: e.ratio, l });
    }
    cand.sort((a, b) => a.ratio - b.ratio);
    const picks = cand.slice(0, PICK), heat = picks.reduce((s, p) => s + p.l.heatSum, 0), exp = picks.reduce((s, p) => s + p.l.expSum, 0);
    out.push({ calm, rough, picks, pickRatio2026: heat / exp });
  }
  return out;
}

const { bars } = loadBars("data/mnq_1m_beta.bin");
const real = measure(bars), R = read(real);
process.stderr.write(`  real market: ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  pl.push(read(measure(placeboBars(bars, 9500 + p))).map((r) => ({ calm: r.calm, rough: r.rough, pickRatio2026: r.pickRatio2026 })));
  if ((p + 1) % 10 === 0) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}

// ── print ──
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—"), f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—"), pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(0) + "%" : "—");
const sorted = (xs) => xs.filter(Number.isFinite).sort((a, b) => a - b), rng = (xs) => { const v = sorted(xs); return `${f2(v[0])}-${f2(v[v.length - 1])}, median ${f2(v[v.length >> 1])}`; };
// every minute, by year: mean heat (all firings) and the 10-point target before 40 against
console.log("Every New York minute, long and short together. Mean heat (points; firings that never reach the target count their heat to 15:05), and for 10 points the share touching it before 40 against:");
for (let s = 0; s < NS; s++) {
  const m = (t) => { let n = 0, h = 0, r = 0; for (let d = 0; d < 2; d++) for (let b = 0; b < NB; b++) { const x = bIdx(s, d, t, b); n += real.Bm.n[x]; h += real.Bm.heat[x]; r += real.Bm.room[x]; } return { h: h / n, r: r / n }; };
  console.log(`  ${slotName(s).padEnd(14)} 10 points: heat ${f1(m(0).h).padStart(5)}, target before 40 against ${pc(m(0).r).padStart(4)}   price-scaled: heat ${f1(m(1).h).padStart(5)}`);
}
for (let t = 0; t < NT; t++) {
  const r = R[t];
  console.log(`\n== ${TARGETS[t]} target ==`);
  console.log(`  signal-years calmer than their times beyond 1.96 sd: ${r.calm}; rougher: ${r.rough}. Placebo markets: calmer ${rng(pl.map((p) => p[t].calm)).replace(/\.00/g, "")}, rougher ${rng(pl.map((p) => p[t].rough)).replace(/\.00/g, "")}; ` +
              `${pl.filter((p) => p[t].calm >= r.calm).length} of ${PLACEBOS} as many calm`);
  console.log(`  the 10 calmest for their times on 2019-2025, in 2026: heat ${f2(r.pickRatio2026)} x what their times give. Placebo markets' picks ${rng(pl.map((p) => p[t].pickRatio2026))}; ${pl.filter((p) => p[t].pickRatio2026 <= r.pickRatio2026).length} of ${PLACEBOS} as calm`);
  console.log(`  ${"signal".padEnd(64)}${"dir".padEnd(6)}${"x 19-25".padStart(8)}${"2026 heat".padStart(11)}${"for its times".padStart(14)}${"n".padStart(6)}   heat x its times by year 2019..2026`);
  for (const p of r.picks) {
    const byYear = Array.from({ length: NY }, (_, s) => { const c = cellOf(real, p.k, p.d, t, [s]); return (c.n >= MIN_N ? f2(c.ratio) : "—").padStart(6); }).join("");
    console.log(`  ${labelOf(p.k).padEnd(64)}${(p.d ? "short" : "long").padEnd(6)}${f2(p.ratio).padStart(8)}${f1(p.l.mean).padStart(11)}${f1(p.l.exp).padStart(14)}${String(p.l.n).padStart(6)}   ${byYear}`);
  }
  // 2026's spread, signal by signal (100 firings or more)
  const r26 = [];
  for (let k = 0; k < NC; k++) for (let d = 0; d < 2; d++) { const c = cellOf(real, k, d, t, [7]); if (c.n >= MIN_N) r26.push({ k, d, c }); }
  r26.sort((a, b) => a.c.ratio - b.c.ratio);
  const q = (p) => r26[Math.min(r26.length - 1, Math.floor(p * r26.length))].c.ratio;
  console.log(`  2026, ${r26.length} signals with ${MIN_N}+ firings: heat x its times from ${f2(q(0))} (5% ${f2(q(0.05))}, median ${f2(q(0.5))}, 95% ${f2(q(0.95))}) to ${f2(q(1))}`);
  console.log(`  2026's 5 calmest for their times (picked on 2026 itself):`);
  for (const x of r26.slice(0, 5)) {
    const byYear = Array.from({ length: NY }, (_, s) => { const c = cellOf(real, x.k, x.d, t, [s]); return (c.n >= MIN_N ? f2(c.ratio) : "—").padStart(6); }).join("");
    console.log(`    ${labelOf(x.k).padEnd(62)}${(x.d ? "short" : "long").padEnd(6)} heat ${f1(x.c.mean)} against ${f1(x.c.exp)} for its times, n ${x.c.n}, reached ${pc(x.c.reached)}${t === 0 ? `, before 40 against ${pc(x.c.room)} (its times ${pc(x.c.expRoom)})` : ""}   by year ${byYear}`);
  }
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s`);
fs.writeFileSync("research/databox_heat_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS,
  targets: R.map((r, t) => ({ target: TARGETS[t], calm: r.calm, rough: r.rough, pickRatio2026: r.pickRatio2026, picks: r.picks.map((p) => ({ signal: labelOf(p.k), dir: p.d ? "short" : "long", ratio1925: p.ratio, heat2026: p.l.mean, exp2026: p.l.exp, n2026: p.l.n })),
    placebo: pl.map((p) => p[t]) })) }, null, 1));
