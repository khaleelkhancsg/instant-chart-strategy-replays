// Confirmed #1 and #2 (the VWAP-slope rule) re-checked on NQ 2010-2018: a light copy of idea_lab.mjs's batch 53.
//
//   node --max-old-space-size=16384 research/confirm_vwap_slope.mjs [--placebos 100]
//   node --max-old-space-size=16384 research/confirm_vwap_slope.mjs --check   (MNQ 2026: must equal idea_lab batch 53)
//
// The ledger planned idea_lab.mjs --batch 53 --file data/nq_1m.bin in three spans. Its full context (the
// level catalog) needs 6-7 GB and about 130 s a placebo market per 3-year span: over 7 hours. Stopped before
// any result was read; this computes only what F1 and F2 read, with the same rules:
// - The box's codes on 1m bars and on 5m bars (at the last closed 5m bar), the indicator's own; a warning
//   is a code turning Pot. long (4) or Pot. short (2). F1's base potE1: the 1m EMA row's. F2's base potAny:
//   the first of 1m MACD, 1m EMA, 5m MACD, 5m EMA warning at that minute.
// - F1 passes when the call agrees with the RTH VWAP's 15-minute slope (expected to hurt); F2 when it is
//   against it (expected to help). The VWAP is the lab's study (vwap, rth anchor), as the catalog builds it.
// - Counted minutes, the race (18 points at 0.064% of the price), and the edge exactly as idea_lab.mjs: the
//   win rate with the filter less the win rate of the same base without it, pooled.
// - Holds = the expected sign and beating 95 of 100 placebo markets (F1 as low, F2 as high), NQ 2010-06-07
//   to 2019-01-01 in one run. Not counted toward the five (both are already confirmed).

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import { resample } from "../src/resample.mjs";
import { atr } from "../src/indicators.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const CHECK = args.includes("--check"), PLACEBOS = CHECK ? 0 : opt("--placebos", 100);
const FILE = CHECK ? "data/mnq_1m_beta.bin" : "data/nq_1m.bin";
const FROM = CHECK ? Date.UTC(2026, 0, 1) : Date.UTC(2010, 5, 7), TO = CHECK ? Date.UTC(2026, 9, 31) : Date.UTC(2019, 0, 1);
const H2 = CHECK ? Date.UTC(2026, 6, 1) : Date.UTC(2014, 6, 1);
const MIN = 60000, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, R18 = 0.00064;
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
function boxStates(T, minutes) {   // as idea_lab.mjs
  const run = new Run(BOX, { minutes, check: false }), map = run.calc.map.bind(run.calc);
  const n = T.close.length, e = new Int8Array(n), m = new Int8Array(n);
  run.calc.map = (d, i) => { const out = map(d, i), S = run.calc.st[i]; e[i] = code(S.ema, S.emaReady); m[i] = code(S.macd, S.macdReady); return out; };
  run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
  return { e, m };
}
const pot = (a, z) => (z === 4 && a !== 4 ? 1 : z === 2 && a !== 2 ? -1 : 0);
const IDEAS = [
  { name: "F1: 1m EMA warnings agreeing with VWAP's slope", expect: "hurts", base: (x, i) => pot(x.e1[i - 1], x.e1[i]), pass: (x, i, d) => Number.isFinite(x.vw[i - 15]) && d * (x.vw[i] - x.vw[i - 15]) > 0 },
  { name: "F2: any box warning against VWAP slope", expect: "helps", base: (x, i) => pot(x.m1[i - 1], x.m1[i]) || pot(x.e1[i - 1], x.e1[i]) || pot(x.m5[i - 1], x.m5[i]) || pot(x.e5[i - 1], x.e5[i]), pass: (x, i, d) => Number.isFinite(x.vw[i - 15]) && d * (x.vw[i] - x.vw[i - 15]) < 0 },
];

function measure(sample) {
  const b = sample.b, N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const s1 = boxStates(b, 1), bb = resample(b, 5), s5 = boxStates(bb, 5), a5 = atr(bb.high, bb.low, bb.close, 14);
  const e5 = new Int8Array(N), m5 = new Int8Array(N), A5 = new Float64Array(N);
  for (let i = 0, k = -1; i < N; i++) { while (k + 1 < bb.ts.length && bb.ts[k + 1] + 5 * MIN <= TS[i] + MIN) k++; e5[i] = k >= 0 ? s5.e[k] : 0; m5[i] = k >= 0 ? s5.m[k] : 0; A5[i] = k >= 0 ? a5[k] : NaN; }
  const x = { e1: s1.e, m1: s1.m, e5, m5, vw: Lab.studyLines(sample, "vwap", 1, { anchor: "rth", bands: 1 }).VWAP };
  const a1 = atr(H, L, C, 14);
  return IDEAS.map((idea) => {
    const t = new Float64Array(2 * 2), u = new Float64Array(2 * 2);   // [half]: n, wins (filter true / false)
    for (let i = 31; i + 1 < N; i++) {
      const ms = TS[i];
      if (ms < FROM || ms >= TO) continue;
      const closeCt = (CT[i] + 1) % 1440;
      if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i] || !(A5[i] > 0) || !(a1[i - 1] > 0)) continue;
      const d = idea.base(x, i);
      if (!d) continue;
      const P = C[i], R = R18 * (P - off[i]);
      let up = 0, dn = 0;
      for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
        const hu = H[j] - P >= R, hd = P - L[j] >= R;
        if (!up && (hu || hd)) up = hd ? -1 : 1;
        if (!dn && (hu || hd)) dn = hu ? -1 : 1;
        if (up && dn) break;
      }
      const win = d === 1 ? (up === 1 ? 1 : 0) : dn === 1 ? 1 : 0, h = ms < H2 ? 0 : 1, arr = idea.pass(x, i, d) ? t : u;
      arr[h * 2]++; arr[h * 2 + 1] += win;
    }
    const e = (a, c) => a[1] / a[0] - c[1] / c[0];
    return { name: idea.name, n: t[0] + t[2], nh: [t[0], t[2]], edge: e([t[0] + t[2], t[1] + t[3]], [u[0] + u[2], u[1] + u[3]]), h1: e([t[0], t[1]], [u[0], u[1]]), h2: e([t[2], t[3]], [u[2], u[3]]) };
  });
}

const real = Lab.loadSample({ file: FILE, from: FROM, to: TO });
const R = measure(real);
process.stderr.write(`  ${FILE} real market: ${secs()}s\n`);
const pt = (v) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + (100 * v).toFixed(1) : "—");
if (CHECK) {   // idea_lab.mjs --batch 53 --year 2026 must give the same n per half and edge
  const ref = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--check") + 1], "utf8")).real;
  R.forEach((o, k) => {
    const q = ref[k];
    if (q.name !== o.name || q.n0h0 !== o.nh[0] || q.n0h1 !== o.nh[1] || Math.abs(q.edge0 - o.edge) > 1e-12) throw new Error(`check: ${o.name}: ${o.nh} ${o.edge} vs idea_lab ${q.n0h0},${q.n0h1} ${q.edge0}`);
    process.stderr.write(`  check: ${o.name} = idea_lab batch 53 (${o.n} warnings, ${pt(o.edge)})\n`);
  });
  process.exit(0);
}
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  pl.push(measure({ ...real, b: Lab.placeboBars(real.b, 7700 + 53 * 1000 + p) }));
  if ((p + 1) % 10 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
}
console.log(`confirmed #1 / #2 on NQ 2010-06-07 to 2018-12-31 (unseen), ${PLACEBOS} placebo markets; ${secs()}s`);
const out = R.map((o, k) => {
  const vals = pl.map((p) => p[k].edge), beats = o.name.startsWith("F1") ? vals.filter((z) => z > o.edge).length : vals.filter((z) => z < o.edge).length;
  const right = IDEAS[k].expect === "helps" ? o.edge > 0 : o.edge < 0, v = right && beats >= 95 ? "HOLDS" : right && beats >= 90 ? "holds at 90 only" : "does not hold";
  console.log(`  ${o.name.padEnd(48)} n ${o.n}  edge ${pt(o.edge)} (beats ${beats} of ${vals.length} placebo markets the expected way)  halves ${pt(o.h1)} / ${pt(o.h2)}  ${v}`);
  return { ...o, beats, verdict: v };
});
fs.writeFileSync("research/confirm_vwap_slope_nq_results.json", JSON.stringify({ run: new Date().toISOString(), placebos: PLACEBOS, ideas: out, placebo: pl }, null, 1));
console.log("wrote research/confirm_vwap_slope_nq_results.json");
