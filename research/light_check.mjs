// Light checks of box-warning filters over long histories and other markets (NQ 2010-2018, ES 2010-2026, MNQ).
//
//   node --max-old-space-size=16384 research/light_check.mjs --file data/es_1m.bin --from 2010-06-07 --to 2026-03-24 --ideas "B14|ADAPT" [--placebos 100] [--tag es]
//   node --max-old-space-size=16384 research/light_check.mjs --check <idea_lab batch 53 2026 json>   (F1/F2 must equal idea_lab)
//
// The box's codes, the counted minutes, the 18-point race and a filter's edge (the win rate with the filter
// less the base's win rate without it) exactly as idea_lab.mjs (confirm_vwap_slope.mjs is checked equal to it;
// this is that code with more ideas). Halves split at the middle of the span (description).
// Ideas (each frozen before any run on the data it is judged on; see the ledger):
//   F1    1m EMA warnings agreeing with VWAP's 15-minute slope (confirmed #1, expected to hurt)
//   F2    any box warning against VWAP's slope (confirmed #2, expected to help)
//   B14   1m MACD warning with the 1m EMA row in the same Potentially state (batch 14, passed 2025 at 92)
//   ADAPT any box warning on the side of VWAP's slope that did better over the previous 60 sessions: against
//         the slope when the trailing 60 sessions' against-less-with win rate is above 0, with it otherwise.
//         Only past sessions; days with under 60 sessions of history are skipped (expected to help).

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import { resample } from "../src/resample.mjs";
import { atr } from "../src/indicators.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const args = process.argv.slice(2), arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const CHECK = args.includes("--check"), PLACEBOS = CHECK ? 0 : Number(arg("--placebos", 100));
const FILE = CHECK ? "data/mnq_1m_beta.bin" : arg("--file", "data/nq_1m.bin");
const FROM = CHECK ? Date.UTC(2026, 0, 1) : Date.parse(arg("--from", "2010-06-07")), TO = CHECK ? Date.UTC(2026, 9, 31) : Date.parse(arg("--to", "2019-01-01"));
const OPEN = args.includes("--entry-open");   // the race from the next bar's open (the bid-ask bounce check)
const H2 = CHECK ? Date.UTC(2026, 6, 1) : (FROM + TO) / 2, TAG = arg("--tag", "") + (OPEN ? "_open" : "");
const WANT = CHECK ? ["F1", "F2"] : arg("--ideas", "F1|F2|B14|ADAPT").split("|");
const MIN = 60000, FLAT = 15 * 60 + 5, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, R18 = 0.00064, TRAIL = 60;
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
function boxStates(T, minutes) {
  const run = new Run(BOX, { minutes, check: false }), map = run.calc.map.bind(run.calc);
  const n = T.close.length, e = new Int8Array(n), m = new Int8Array(n);
  run.calc.map = (d, i) => { const out = map(d, i), S = run.calc.st[i]; e[i] = code(S.ema, S.emaReady); m[i] = code(S.macd, S.macdReady); return out; };
  run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
  return { e, m };
}
const pot = (a, z) => (z === 4 && a !== 4 ? 1 : z === 2 && a !== 2 ? -1 : 0);
const potAny = (x, i) => pot(x.m1[i - 1], x.m1[i]) || pot(x.e1[i - 1], x.e1[i]) || pot(x.m5[i - 1], x.m5[i]) || pot(x.e5[i - 1], x.e5[i]);
const slope = (x, i) => (Number.isFinite(x.vw[i - 15]) && Number.isFinite(x.vw[i]) ? Math.sign(x.vw[i] - x.vw[i - 15]) : 0);
const ALL_IDEAS = {
  F1: { name: "F1: 1m EMA warnings agreeing with VWAP's slope", expect: "hurts", base: (x, i) => pot(x.e1[i - 1], x.e1[i]), pass: (x, i, d) => Number.isFinite(x.vw[i - 15]) && d * (x.vw[i] - x.vw[i - 15]) > 0 },
  F2: { name: "F2: any box warning against VWAP slope", expect: "helps", base: potAny, pass: (x, i, d) => Number.isFinite(x.vw[i - 15]) && d * (x.vw[i] - x.vw[i - 15]) < 0 },
  B14: { name: "B14: both 1m rows warning together", expect: "helps", base: (x, i) => pot(x.m1[i - 1], x.m1[i]), pass: (x, i, d) => (d === 1 ? x.e1[i] === 4 : x.e1[i] === 2) },
  ADAPT: { name: "ADAPT: the VWAP-slope side that won the last 60 sessions", expect: "helps", base: potAny, adaptive: true },
  ADAPT1: { name: "ADAPT1: ADAPT on the 1m rows only (what a 1m chart's box sees)", expect: "helps", base: (x, i) => pot(x.m1[i - 1], x.m1[i]) || pot(x.e1[i - 1], x.e1[i]), adaptive: true },
  ADAPTW: { name: "ADAPTW: take warnings if they won the last 60 sessions, else fade", expect: "helps", base: potAny, adaptiveW: true },
};
const IDEAS = WANT.map((k) => { if (!ALL_IDEAS[k]) throw new Error(`no idea ${k}`); return { key: k, ...ALL_IDEAS[k] }; });

function measure(sample) {
  const b = sample.b, N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const s1 = boxStates(b, 1), bb = resample(b, 5), s5 = boxStates(bb, 5), a5 = atr(bb.high, bb.low, bb.close, 14);
  const e5 = new Int8Array(N), m5 = new Int8Array(N), A5 = new Float64Array(N);
  for (let i = 0, k = -1; i < N; i++) { while (k + 1 < bb.ts.length && bb.ts[k + 1] + 5 * MIN <= TS[i] + MIN) k++; e5[i] = k >= 0 ? s5.e[k] : 0; m5[i] = k >= 0 ? s5.m[k] : 0; A5[i] = k >= 0 ? a5[k] : NaN; }
  const x = { e1: s1.e, m1: s1.m, e5, m5, vw: Lab.studyLines(sample, "vwap", 1, { anchor: "rth", bands: 1 }).VWAP };
  const a1 = atr(H, L, C, 14);
  // every counted minute's race, once
  const win = new Int8Array(N), counted = new Uint8Array(N);
  for (let i = 31; i + 1 < N; i++) {
    const ms = TS[i];
    if (ms < FROM || ms >= TO) continue;
    const closeCt = (CT[i] + 1) % 1440;
    if (closeCt < FIRST || closeCt > LAST || TD[i + 1] !== TD[i] || !(A5[i] > 0) || !(a1[i - 1] > 0)) continue;
    counted[i] = 1;
    const P = OPEN ? b.open[i + 1] : C[i], R = R18 * (C[i] - off[i]);
    let up = 0, dn = 0;
    for (let j = i + 1; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
      const hu = H[j] - P >= R, hd = P - L[j] >= R;
      if (!up && (hu || hd)) up = hd ? -1 : 1;
      if (!dn && (hu || hd)) dn = hu ? -1 : 1;
      if (up && dn) break;
    }
    win[i] = (up === 1 ? 1 : 0) | (dn === 1 ? 2 : 0);   // bit 1: long wins, bit 2: short wins
  }
  const won = (i, d) => (d === 1 ? win[i] & 1 : (win[i] >> 1) & 1);
  // every counted minute's win rate by half and direction (a signal's baseline), and by session (ADAPTW's trailing yardstick)
  const bn = new Float64Array(4), bw = new Float64Array(4), dayRate = new Map();
  for (let i = 31; i + 1 < N; i++) {
    if (!counted[i]) continue;
    const h = TS[i] < H2 ? 0 : 1; let r = dayRate.get(TD[i]); if (!r) dayRate.set(TD[i], (r = [0, 0, 0, 0]));
    for (const [dir, d] of [[0, 1], [1, -1]]) { bn[h * 2 + dir]++; bw[h * 2 + dir] += won(i, d); r[dir * 2]++; r[dir * 2 + 1] += won(i, d); }
  }
  return IDEAS.map((idea) => {
    if (idea.adaptiveW) {   // a signal: the warning's call, or its reverse, by the trailing 60 sessions' warning edge
      const t = new Float64Array(6), hist = [];   // [half]: n, wins, expected wins
      let cur = null, curTd = -1, mode = 0, days = 0;
      for (let i = 31; i + 1 < N; i++) {
        if (!counted[i]) continue;
        const d = idea.base(x, i);
        if (!d) continue;
        if (TD[i] !== curTd) {
          if (cur) { hist.push(cur); if (hist.length > TRAIL) hist.shift(); }
          cur = [0, 0]; curTd = TD[i];
          if (hist.length < TRAIL) mode = 0; else { let n = 0, e = 0; for (const z of hist) { n += z[0]; e += z[1]; } mode = n ? (e > 0 ? 1 : -1) : 0; if (mode) days++; }
        }
        const r = dayRate.get(TD[i]), dir = d === 1 ? 0 : 1;
        cur[0]++; cur[1] += won(i, d) - r[dir * 2 + 1] / r[dir * 2];   // used from tomorrow
        if (!mode) continue;
        const c = mode * d, h = TS[i] < H2 ? 0 : 1, cd = c === 1 ? 0 : 1;
        t[h * 3]++; t[h * 3 + 1] += won(i, c); t[h * 3 + 2] += bw[h * 2 + cd] / bn[h * 2 + cd];
      }
      const e = (n, w, x2) => (n ? (w - x2) / n : NaN);
      return { key: idea.key, name: idea.name, n: t[0] + t[3], nh: [t[0], t[3]], edge: e(t[0] + t[3], t[1] + t[4], t[2] + t[5]), h1: e(t[0], t[1], t[2]), h2: e(t[3], t[4], t[5]), days };
    }
    const t = new Float64Array(4), u = new Float64Array(4);   // [half]: n, wins (filter true / false)
    // ADAPT: each session's against / with tallies, and the trailing 60 sessions' sums before it
    const hist = [];   // { a: [n, w], w: [n, w] } per finished session
    let cur = null, curTd = -1, mode = 0, days = 0;
    const startDay = (td) => {
      if (cur) { hist.push(cur); if (hist.length > TRAIL) hist.shift(); }
      cur = { a: [0, 0], w: [0, 0] }; curTd = td;
      if (hist.length < TRAIL) { mode = 0; return; }
      let an = 0, aw = 0, wn = 0, ww = 0; for (const h of hist) { an += h.a[0]; aw += h.a[1]; wn += h.w[0]; ww += h.w[1]; }
      mode = an && wn ? (aw / an - ww / wn > 0 ? -1 : 1) : 0;   // -1: keep warnings against the slope; +1: with it
      if (mode) days++;
    };
    for (let i = 31; i + 1 < N; i++) {
      if (!counted[i]) continue;
      const d = idea.base(x, i);
      if (!d) continue;
      let ok;
      if (idea.adaptive) {
        if (TD[i] !== curTd) startDay(TD[i]);
        const s = slope(x, i), w1 = won(i, d);
        if (s) { const g = d * s < 0 ? cur.a : cur.w; g[0]++; g[1] += w1; }   // today's tally, used from tomorrow
        if (!mode) continue;
        ok = s !== 0 && d * s === mode;
      } else ok = !!idea.pass(x, i, d);
      const h = TS[i] < H2 ? 0 : 1, arr = ok ? t : u;
      arr[h * 2]++; arr[h * 2 + 1] += won(i, d);
    }
    const e = (a, c) => a[1] / a[0] - c[1] / c[0];
    return { key: idea.key, name: idea.name, n: t[0] + t[2], nh: [t[0], t[2]], edge: e([t[0] + t[2], t[1] + t[3]], [u[0] + u[2], u[1] + u[3]]), h1: e([t[0], t[1]], [u[0], u[1]]), h2: e([t[2], t[3]], [u[2], u[3]]), days };
  });
}

const real = Lab.loadSample({ file: FILE, from: FROM, to: TO });
const R = measure(real);
process.stderr.write(`  ${FILE} ${new Date(FROM).toISOString().slice(0, 10)} to ${new Date(TO).toISOString().slice(0, 10)}, real market: ${secs()}s\n`);
const pt = (v) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + (100 * v).toFixed(1) : "—");
if (CHECK) {
  const ref = JSON.parse(fs.readFileSync(args[args.indexOf("--check") + 1], "utf8")).real;
  R.forEach((o, k) => {
    const q = ref[k];
    if (q.n0h0 !== o.nh[0] || q.n0h1 !== o.nh[1] || Math.abs(q.edge0 - o.edge) > 1e-12) throw new Error(`check: ${o.name}: ${o.nh} ${o.edge} vs idea_lab ${q.n0h0},${q.n0h1} ${q.edge0}`);
    process.stderr.write(`  check: ${o.name} = idea_lab batch 53 (${o.n}, ${pt(o.edge)})\n`);
  });
  process.exit(0);
}
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  pl.push(measure({ ...real, b: Lab.placeboBars(real.b, 5100 + p) }));
  if ((p + 1) % 10 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
}
console.log(`light check${OPEN ? " (races from the next bar's open)" : ""}: ${FILE} ${new Date(FROM).toISOString().slice(0, 10)} to ${new Date(TO).toISOString().slice(0, 10)}, ${PLACEBOS} placebo markets; ${secs()}s`);
const out = R.map((o, k) => {
  const idea = IDEAS[k], up = idea.expect === "helps", vals = pl.map((p) => p[k].edge), beats = vals.filter((z) => (up ? z < o.edge : z > o.edge)).length;
  const hv1 = pl.map((p) => p[k].h1), hv2 = pl.map((p) => p[k].h2), b1 = hv1.filter((z) => (up ? z < o.h1 : z > o.h1)).length, b2 = hv2.filter((z) => (up ? z < o.h2 : z > o.h2)).length;
  const right = up ? o.edge > 0 : o.edge < 0, v = right && beats >= 95 ? "beats 95" : right && beats >= 90 ? "beats 90" : !right && vals.length && beats <= 10 ? "REVERSED" : "neither";
  console.log(`  ${o.name.padEnd(58)} n ${String(o.n).padStart(7)}  edge ${pt(o.edge).padStart(5)} (beats ${beats} of ${vals.length} the expected way; halves ${pt(o.h1)} [${b1}] / ${pt(o.h2)} [${b2}])${idea.adaptive || idea.adaptiveW ? `  days ${o.days}` : ""}  ${v}`);
  return { ...o, beats, beatsH: [b1, b2], verdict: v };
});
if (TAG) fs.writeFileSync(`research/light_check_${TAG}_results.json`, JSON.stringify({ run: new Date().toISOString(), file: FILE, from: FROM, to: TO, placebos: PLACEBOS, ideas: out, placebo: pl }, null, 1));
