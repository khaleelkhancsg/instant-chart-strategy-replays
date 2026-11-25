// The box overnight: do its readings work in the Globex (ETH) hours, which no study has counted?
//
//   node --max-old-space-size=16384 research/databox_eth.mjs --file data/mnq_1m_beta.bin --from 2019-05-06 --to 2026-10-31 [--placebos 100] [--tag mnq]
//
// Every databox study and idea so far counted only 08:30-14:55 CT. Written 2026-11-25 before any run:
// - Counted minutes: bars closing 18:00-07:30 CT (the 17:00 reopen hour and the 07:30-08:30 data-release hour
//   left out), within one trading day. The race: from the bar's close, does price go 0.064% of the price the
//   called way before as far the other way, within 60 minutes (and before 08:25 CT)? Unresolved = a loss for
//   both ways (as RTH races unresolved by 15:05).
// - Readings (the indicator's arithmetic, as databox_lengths.mjs): 1m EMA 12/26 speed (default), 1m EMA 3/13
//   slowing (#3), 1m MACD 12/26/9 shrink, 5m EMA 12/26 speed, 5m MACD 12/26/9 shrink, 1m EMA and 1m MACD
//   flips. A reading's edge: its win rate less every counted minute's the same way (year by year).
// - Stages: discovery on MNQ 2019-2026 (edge beating 90 of 100 placebo markets overall and in both halves,
//   2019-2022 / 2023-2026; either sign: a negative one is a continuation call); confirm the passes on NQ
//   2010-2018 and on ES 2010-2026, each once, the same sign beating 90 of 100. Passing both counts as one of
//   the five (the overnight readings are one finding however many pass).

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample, sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { placeboBars } from "./lib_levels.mjs";

const args = process.argv.slice(2), arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const FILE = arg("--file", "data/mnq_1m_beta.bin"), FROM = Date.parse(arg("--from", "2019-05-06")), TO = Date.parse(arg("--to", "2026-10-31"));
const OPEN = args.includes("--entry-open");   // the race from the next bar's open (the bid-ask bounce check)
const PLACEBOS = Number(arg("--placebos", 100)), TAG = arg("--tag", "") + (args.includes("--entry-open") ? "_open" : ""), MID = Date.parse(arg("--mid", "")) || (FROM + TO) / 2;
const MIN = 60000, R18 = 0.00064, HORIZON = 60, E0 = 18 * 60, E1 = 7 * 60 + 30, STOP = 8 * 60 + 25;
const Y0 = new Date(FROM).getUTCFullYear(), NY = new Date(TO - 1).getUTCFullYear() - Y0 + 1;
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

function emaSeries(x, n) {
  const N = x.length, v = new Float64Array(N);
  let count = 0, total = 0, prev = NaN;
  for (let i = 0; i < N; i++) { if (count < n) { count++; total += x[i]; prev = total / count; } else { count++; prev = prev + (2 / (n + 1)) * (x[i] - prev); } v[i] = prev; }
  return v;
}
function emaLine(close, f, s) { const x = Float64Array.from(close), a = emaSeries(x, f), b = emaSeries(x, s), N = x.length, raw = new Float64Array(N), ready = new Uint8Array(N); for (let i = 0; i < N; i++) { raw[i] = a[i] - b[i]; ready[i] = i >= s ? 1 : 0; } return { raw, ready, from: 0 }; }
function macdLine(close, f, s, g) {
  const x = Float64Array.from(close), a = emaSeries(x, f), b = emaSeries(x, s), N = x.length, raw = new Float64Array(N).fill(NaN), ready = new Uint8Array(N);
  let count = 0, total = 0, prev = NaN;
  for (let i = s - 1; i < N; i++) { const line = a[i] - b[i]; if (count < g) { count++; total += line; prev = total / count; } else { count++; prev = prev + (2 / (g + 1)) * (line - prev); } raw[i] = line - prev; ready[i] = count >= g ? 1 : 0; }
  return { raw, ready, from: s - 1 };
}
function readings(L, rule) {   // rowStep's side and warning, as databox_lengths.mjs
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
  for (let i = 0; i < N; i++) { if (!L.ready[i]) continue; const x = L.raw[i]; side[i] = x > 0 ? 1 : x < 0 ? -1 : i ? side[i - 1] : 0; }
  return { side, warn };
}
const flipsOf = (side) => { const o = new Int8Array(side.length); for (let i = 2; i < side.length; i++) if (side[i] && side[i - 1] === -side[i]) o[i] = side[i]; return o; };
const onsetsOf = (st) => { const o = new Int8Array(st.length); for (let i = 1; i < st.length; i++) if (st[i] && st[i] !== st[i - 1]) o[i] = st[i]; return o; };
const READ = [
  { name: "1m EMA 12/26 speed warning", tf: 1, line: (c) => emaLine(c, 12, 26), kind: "warn", rule: "speed" },
  { name: "1m EMA 3/13 slowing warning (#3)", tf: 1, line: (c) => emaLine(c, 3, 13), kind: "warn", rule: "slowing" },
  { name: "1m MACD 12/26/9 shrink warning", tf: 1, line: (c) => macdLine(c, 12, 26, 9), kind: "warn", rule: "shrink" },
  { name: "5m EMA 12/26 speed warning", tf: 5, line: (c) => emaLine(c, 12, 26), kind: "warn", rule: "speed" },
  { name: "5m MACD 12/26/9 shrink warning", tf: 5, line: (c) => macdLine(c, 12, 26, 9), kind: "warn", rule: "shrink" },
  { name: "1m EMA 12/26 flip", tf: 1, line: (c) => emaLine(c, 12, 26), kind: "flip" },
  { name: "1m MACD 12/26/9 flip", tf: 1, line: (c) => macdLine(c, 12, 26, 9), kind: "flip" },
];
const NR = READ.length;

function measure(b) {
  const N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const b5 = resample(b, 5), at5 = new Int32Array(b5.close.length).fill(-1);
  const slot = new Int16Array(N).fill(-1), winU = new Uint8Array(N), winD = new Uint8Array(N);
  const bn = new Float64Array(NY * 2 * 2), bw = new Float64Array(NY * 2 * 2);   // [year][half][dir]
  let k5 = -1;
  for (let i = 1; i + 1 < N; i++) {
    let new5 = -1;
    while (k5 + 1 < b5.ts.length && b5.ts[k5 + 1] + 5 * MIN <= TS[i] + MIN) { k5++; new5 = k5; }
    if (TS[i] < FROM || TS[i] >= TO) continue;
    const cc = (CT[i] + 1) % 1440;
    if (!(cc >= E0 || cc <= E1) || TD[i + 1] !== TD[i]) continue;
    if (new5 >= 0) at5[new5] = i;
    const y = new Date(TS[i]).getUTCFullYear() - Y0;
    slot[i] = y * 2 + (TS[i] < MID ? 0 : 1);
    const P = OPEN ? b.open[i + 1] : C[i], R = R18 * (C[i] - off[i]);
    let u = 0, d = 0;
    for (let j = i + 1; j < N && j <= i + HORIZON && TD[j] === TD[i]; j++) {
      const cj = (CT[j] + 1) % 1440;
      if (cj > STOP && cj < E0) break;   // the race stops at 08:25 CT
      const up = H[j] - P >= R, dn = P - L[j] >= R;
      if (!u && (up || dn)) u = dn ? -1 : 1;
      if (!d && (up || dn)) d = up ? -1 : 1;
      if (u && d) break;
    }
    winU[i] = u === 1 ? 1 : 0; winD[i] = d === 1 ? 1 : 0;
    const s = slot[i]; bn[s * 2] += 1; bw[s * 2] += winU[i]; bn[s * 2 + 1] += 1; bw[s * 2 + 1] += winD[i];
  }
  const n = new Float64Array(NR * NY * 2 * 2), w = new Float64Array(NR * NY * 2 * 2);
  READ.forEach((R, r) => {
    const rd = readings(R.line(R.tf === 1 ? b.close : b5.close), R.kind === "flip" ? null : R.rule), calls = R.kind === "flip" ? flipsOf(rd.side) : onsetsOf(rd.warn);
    for (let k = 0; k < calls.length; k++) {
      const c = calls[k];
      if (!c) continue;
      const i = R.tf === 1 ? k : at5[k];
      if (i < 0 || slot[i] < 0) continue;
      const dir = c === 1 ? 0 : 1, x = (r * NY * 2 + slot[i]) * 2 + dir;
      n[x]++; w[x] += c === 1 ? winU[i] : winD[i];
    }
  });
  return { n, w, bn, bw };
}
function edgeOf(M, r, half) {   // half: 0, 1 or -1 (both)
  let cnt = 0, ex = 0;
  for (let y = 0; y < NY; y++) for (const h of half < 0 ? [0, 1] : [half]) for (let dir = 0; dir < 2; dir++) {
    const s = y * 2 + h, x = (r * NY * 2 + s) * 2 + dir, m = M.n[x];
    if (!m) continue;
    cnt += m; ex += M.w[x] - m * (M.bw[s * 2 + dir] / M.bn[s * 2 + dir]);
  }
  return { n: cnt, edge: cnt ? ex / cnt : NaN };
}

const { bars: all } = loadBars(FILE);
const bars = sliceBars(all, indexAtOrAfter(all.ts, FROM - 200 * 86400000), indexAtOrAfter(all.ts, TO + 2 * 86400000));
const real = measure(bars);
process.stderr.write(`  ${FILE} ${new Date(FROM).toISOString().slice(0, 10)} to ${new Date(TO).toISOString().slice(0, 10)}, real market: ${secs()}s\n`);
const pl = [];
for (let p = 0; p < PLACEBOS; p++) {
  const M = measure(placeboBars(bars, 2200 + p));
  pl.push(READ.map((_, r) => [edgeOf(M, r, -1).edge, edgeOf(M, r, 0).edge, edgeOf(M, r, 1).edge]));
  if ((p + 1) % 10 === 0 || p + 1 === PLACEBOS) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
}
const pt = (v) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + (100 * v).toFixed(1) : "—");
const beat = (vals, v) => (v >= 0 ? vals.filter((z) => z < v).length : vals.filter((z) => z > v).length);   // placebo markets beaten, in the reading's own direction
console.log(`databox overnight (18:00-07:30 CT, 60-minute race${OPEN ? ", from the next bar's open" : ""}): ${FILE} ${new Date(FROM).toISOString().slice(0, 10)} to ${new Date(TO).toISOString().slice(0, 10)}, halves split ${new Date(MID).toISOString().slice(0, 10)}, ${PLACEBOS} placebo markets; ${secs()}s`);
const out = READ.map((R, r) => {
  const a = edgeOf(real, r, -1), h1 = edgeOf(real, r, 0), h2 = edgeOf(real, r, 1);
  const b0 = beat(pl.map((p) => p[r][0]), a.edge), b1 = beat(pl.map((p) => p[r][1]), h1.edge), b2 = beat(pl.map((p) => p[r][2]), h2.edge);
  const same = Math.sign(h1.edge) === Math.sign(a.edge) && Math.sign(h2.edge) === Math.sign(a.edge), pass = same && b0 >= 90 && b1 >= 90 && b2 >= 90;
  console.log(`  ${R.name.padEnd(34)} n ${String(a.n).padStart(7)}  edge ${pt(a.edge).padStart(5)} (beats ${b0})  halves ${pt(h1.edge)} (${b1}) / ${pt(h2.edge)} (${b2})  ${pass ? (a.edge > 0 ? "PASS (as called)" : "PASS (the other way: a continuation call)") : ""}`);
  return { name: R.name, n: a.n, edge: a.edge, h1: h1.edge, h2: h2.edge, beats: [b0, b1, b2], pass };
});
if (TAG) fs.writeFileSync(`research/databox_eth_${TAG}_results.json`, JSON.stringify({ run: new Date().toISOString(), file: FILE, from: FROM, to: TO, mid: MID, placebos: PLACEBOS, readings: out, placebo: pl }, null, 1));
