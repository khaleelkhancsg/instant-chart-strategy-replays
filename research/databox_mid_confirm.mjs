// Confirming the in-between timeframe leads (databox_mid.mjs) on data none of them has seen: NQ 2010-2018.
//
//   node --max-old-space-size=16384 research/databox_mid_confirm.mjs [--placebos 100]
//   node --max-old-space-size=16384 research/databox_mid_confirm.mjs --check   (MNQ 2019-2026: must equal databox_mid)
//
// Written 2026-11-25, before any NQ bar is read:
// - The data: NQ (the full-size contract on the same index) 1-minute bars, 2010-06 to 2018-12, built from
//   the Databento CSV by prepare.mjs into data/nq_1m.bin. The idea loop and every databox study read MNQ
//   from 2019 on, so these nine years are unseen by all of them. 2019 on is left out (the same index's moves).
// - The leads, frozen exactly as databox_mid.mjs found them (each beat 90 of 100 placebo markets on 2019-2025
//   and on 2026):
//     L1 1m EMA warning,  the call against the 2m MACD line's last move
//     L2 1m MACD flip,    the call against the 2m MACD line's last move
//     L3 1m MACD warning, the 3m MACD line's last move agreeing
//     L4 1m MACD warning, the 3m MACD row warning the same way
//     L5 5m EMA warning,  the call against the 2m MACD line's last move
//     L6 5m MACD flip,    the 2m MACD side agreeing
//     L7 5m MACD warning, the call against the 4m EMA side
// - Measured exactly as databox_mid.mjs (the indicator's own rows on clock-aligned bars, the 18-point race
//   at 0.064% of the price, 08:30-14:55 CT, by 15:05; lift = the filtered win rate less the base's own,
//   year by year and direction by direction).
// - Verdict, one run: a lead is CONFIRMED when its lift over 2010-2018 beats 95 of 100 placebo markets. Seven
//   leads at 5% each: about 0.35 false confirmations expected; the ledger counts them.
// - Independent of confirmed #2 (warnings against VWAP's 15-minute slope)? L1, L2 and L5 are calls against
//   a short push, #2's shape. Each lead's lift is also measured inside the calls WITH VWAP's slope and inside
//   those AGAINST it. A confirmed lead counts as new only if its lift is positive and beats 90 of 100 inside
//   the calls with VWAP's slope (where #2 does not act); otherwise it is #2 again.
// - Halves 2010-2014 and 2015-2018 are described, not judged.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample, sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { placeboBars, studyLines } from "./lib_levels.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const CHECK = args.includes("--check"), PLACEBOS = CHECK ? 0 : opt("--placebos", 100);
const FILE = CHECK ? "data/mnq_1m_beta.bin" : "data/nq_1m.bin";
const Y0 = CHECK ? 2019 : 2010, NY = CHECK ? 8 : 9, TO = CHECK ? Date.UTC(2026, 9, 31) : Date.UTC(2019, 0, 1);
const H1 = CHECK ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4], H2 = CHECK ? [7] : [5, 6, 7, 8], ALL = [...H1, ...H2];
const MIN = 60000, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, R18 = 0.00064, DAY = 86400000;
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

const TFS = [1, 2, 3, 4, 5], KINDS = ["EMA", "MACD"], REL = ["side", "slope", "warning"];
// base: tf index, row, flip | warn; filter: tf index, row, relation, agree
const LEADS = [
  { id: "L1", base: [0, 0, "warn"], f: [1, 1, 1, false], mid: ["1m EMA warning", "2m MACD slope does not agree"] },
  { id: "L2", base: [0, 1, "flip"], f: [1, 1, 1, false], mid: ["1m MACD flip", "2m MACD slope does not agree"] },
  { id: "L3", base: [0, 1, "warn"], f: [2, 1, 1, true], mid: ["1m MACD warning", "3m MACD slope agrees"] },
  { id: "L4", base: [0, 1, "warn"], f: [2, 1, 2, true], mid: ["1m MACD warning", "3m MACD warning agrees"] },
  { id: "L5", base: [4, 0, "warn"], f: [1, 1, 1, false], mid: ["5m EMA warning", "2m MACD slope does not agree"] },
  { id: "L6", base: [4, 1, "flip"], f: [1, 1, 0, true], mid: ["5m MACD flip", "2m MACD side agrees"] },
  { id: "L7", base: [4, 1, "warn"], f: [3, 0, 0, false], mid: ["5m MACD warning", "4m EMA side does not agree"] },
];
const NL = LEADS.length, NS = NY, G = 3;   // groups: all, with VWAP's slope, against it

const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
function rows(T, minutes) {   // as databox_mid.mjs
  const run = new Run(BOX, { minutes, props: { vwapSlope: "off" }, check: false }), map = run.calc.map.bind(run.calc);
  const n = T.close.length, h = [new Float64Array(n).fill(NaN), new Float64Array(n).fill(NaN)], w = [new Int8Array(n), new Int8Array(n)];
  run.calc.map = (d, i) => {
    const out = map(d, i), S = run.calc.st[i];
    if (S.emaReady) { h[0][i] = S.ema.diff; w[0][i] = S.ema.warn; }
    if (S.macdReady && S.macd) { h[1][i] = S.macd.diff; w[1][i] = S.macd.warn; }
    return out;
  };
  run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
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

function measure(b) {
  const N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const vw = studyLines({ b }, "vwap", 1, { anchor: "rth", bands: 1 }).VWAP;
  const BT = TFS.map((tf) => (tf === 1 ? b : resample(b, tf))), RW = BT.map((T, t) => rows(T, TFS[t]));
  const nT = TFS.length, ptr = new Int32Array(nT).fill(-1), fresh = new Int32Array(nT);
  // [lead][base 0 | filtered 1][group][slot][dir]
  const n = new Float64Array(NL * 2 * G * NS * 2), w = new Float64Array(NL * 2 * G * NS * 2);
  const rel = (t, k, r) => { const R = RW[t][k], j = ptr[t]; return j < 0 ? 0 : r === 0 ? R.side[j] : r === 1 ? R.slope[j] : R.warn[j]; };
  for (let i = 1; i + 1 < N; i++) {
    for (let t = 0; t < nT; t++) {
      fresh[t] = -1;
      const T = BT[t], tf = TFS[t];
      while (ptr[t] + 1 < T.ts.length && T.ts[ptr[t] + 1] + tf * MIN <= TS[i] + MIN) { ptr[t]++; fresh[t] = ptr[t]; }
    }
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i] || TS[i] >= TO) continue;
    const s = new Date(TS[i]).getUTCFullYear() - Y0;
    if (s < 0 || s >= NY) continue;
    // which bases call here (computed once)
    let any = false;
    const calls = LEADS.map((Ld) => { const [t, k, what] = Ld.base, j = fresh[t]; if (j < 0) return 0; const c = what === "flip" ? RW[t][k].flip[j] : RW[t][k].won[j]; if (c) any = true; return c; });
    if (!any) continue;
    const P = C[i], Rr = R18 * (P - off[i]);
    let u = 0, d = 0;
    for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
      const up = H[j] - P >= Rr, dn = P - L[j] >= Rr;
      if (!u && (up || dn)) u = dn ? -1 : 1;
      if (!d && (up || dn)) d = up ? -1 : 1;
      if (u && d) break;
    }
    const slopeOk = Number.isFinite(vw[i - 15]) && Number.isFinite(vw[i]), vs = slopeOk ? Math.sign(vw[i] - vw[i - 15]) : 0;
    LEADS.forEach((Ld, q) => {
      const c = calls[q];
      if (!c) return;
      const dir = c === 1 ? 0 : 1, win = c === 1 ? (u === 1 ? 1 : 0) : d === 1 ? 1 : 0;
      const [ft, fk, fr, agree] = Ld.f, ok = (rel(ft, fk, fr) === c) === agree;
      const groups = [0]; if (vs && vs === c) groups.push(1); if (vs && vs === -c) groups.push(2);
      for (const g of groups) for (const which of ok ? [0, 1] : [0]) { const x = ((((q * 2 + which) * G + g) * NS + s) * 2) + dir; n[x]++; w[x] += win; }
    });
  }
  return { n, w };
}
function liftOf(M, q, g, slots) {
  let cnt = 0, ex = 0;
  for (const s of slots) for (let dir = 0; dir < 2; dir++) {
    const xf = ((((q * 2 + 1) * G + g) * NS + s) * 2) + dir, xb = ((((q * 2) * G + g) * NS + s) * 2) + dir, m = M.n[xf];
    if (!m) continue;
    cnt += m; ex += M.w[xf] - m * (M.w[xb] / M.n[xb]);
  }
  return { n: cnt, lift: cnt ? ex / cnt : NaN };
}

// ── run ──
const { bars: all } = loadBars(FILE);
const from = CHECK ? Date.UTC(2019, 0, 1) : all.ts[0];
const bars = sliceBars(all, indexAtOrAfter(all.ts, from - 200 * DAY), indexAtOrAfter(all.ts, TO + 2 * DAY));
process.stderr.write(`  ${FILE}: ${new Date(bars.ts[0]).toISOString().slice(0, 10)} to ${new Date(bars.ts[bars.close.length - 1]).toISOString().slice(0, 10)}, ${bars.close.length.toLocaleString()} bars\n`);
const real = measure(bars);
process.stderr.write(`  real market: ${secs()}s\n`);
const pt = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (100 * x).toFixed(1) : "—");
if (CHECK) {   // must equal databox_mid.mjs's real lifts, 2019-2026 n-weighted
  const MID = JSON.parse(fs.readFileSync("research/databox_mid_results.json", "utf8"));
  for (const [q, Ld] of LEADS.entries()) {
    const bq = MID.bases.indexOf(Ld.mid[0]), fq = MID.filters.indexOf(Ld.mid[1]), ref = MID.real.lifts[bq][fq];
    const refLift = (ref.e.lift * ref.e.n + ref.l.lift * ref.l.n) / (ref.e.n + ref.l.n), mine = liftOf(real, q, 0, ALL);
    if (bq < 0 || fq < 0 || mine.n !== ref.e.n + ref.l.n || Math.abs(mine.lift - refLift) > 1e-12) throw new Error(`check: ${Ld.id} ${mine.n} ${mine.lift} vs databox_mid ${ref.e.n + ref.l.n} ${refLift}`);
    process.stderr.write(`  check: ${Ld.id} = databox_mid's ${Ld.mid.join(" / ")} (${mine.n.toLocaleString()}, ${pt(mine.lift)})\n`);
  }
  process.exit(0);
}
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  const M = measure(placeboBars(bars, 8800 + p));
  pl.push(LEADS.map((_, q) => [0, 1, 2].map((g) => ({ all: liftOf(M, q, g, ALL).lift, h1: liftOf(M, q, g, H1).lift, h2: liftOf(M, q, g, H2).lift }))));
  if ((p + 1) % 10 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
}
const high = (vals, v) => vals.filter((z) => Number.isFinite(z) && z >= v).length;
console.log(`databox in-between leads on NQ ${Y0}-2018 (unseen), ${PLACEBOS} placebo markets; ${secs()}s`);
console.log(`lift = points of win rate over the base's own; "hi" = placebo markets as high. Confirmed: beats 95 of 100. New (not #2): also beats 90 inside the calls with VWAP's slope`);
console.log(`${"lead".padEnd(56)}${"n".padStart(8)}${"lift".padStart(7)}${"hi".padStart(4)}${"10-14".padStart(7)}${"15-18".padStart(7)}${"with".padStart(7)}${"hi".padStart(4)}${"against".padStart(8)}${"hi".padStart(4)}`);
const out = LEADS.map((Ld, q) => {
  const a = liftOf(real, q, 0, ALL), h1 = liftOf(real, q, 0, H1), h2 = liftOf(real, q, 0, H2), gw = liftOf(real, q, 1, ALL), ga = liftOf(real, q, 2, ALL);
  const hi = high(pl.map((p) => p[q][0].all), a.lift), hw = high(pl.map((p) => p[q][1].all), gw.lift), ha = high(pl.map((p) => p[q][2].all), ga.lift);
  const confirmed = hi <= 5, isNew = confirmed && gw.lift > 0 && hw <= 10;
  const v = confirmed ? (isNew ? "CONFIRMED, NEW" : "CONFIRMED, but #2 again") : "not confirmed";
  console.log(`${(Ld.id + " " + Ld.mid.join(", ")).padEnd(56)}${String(a.n).padStart(8)}${pt(a.lift).padStart(7)}${String(hi).padStart(4)}${pt(h1.lift).padStart(7)}${pt(h2.lift).padStart(7)}${pt(gw.lift).padStart(7)}${String(hw).padStart(4)}${pt(ga.lift).padStart(8)}${String(ha).padStart(4)}  ${v}`);
  return { id: Ld.id, lead: Ld.mid, n: a.n, lift: a.lift, hi, h1: h1.lift, h2: h2.lift, with: gw, withHi: hw, against: ga, againstHi: ha, verdict: v };
});
console.log(`\n(${secs()}s)`);
fs.writeFileSync("research/databox_mid_confirm_results.json", JSON.stringify({ run: new Date().toISOString(), file: FILE, placebos: PLACEBOS, leads: out, placebo: pl }, null, 1));
console.log("wrote research/databox_mid_confirm_results.json");
