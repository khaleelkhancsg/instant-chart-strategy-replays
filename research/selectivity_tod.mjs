// Selectivity and time of day: does a trader who skips some signals, or trades only some hours, do better
// than the mechanical "take every one"? On the box's readings, over 17 years and three markets.
//
//   node --max-old-space-size=16384 research/selectivity_tod.mjs --file data/nq_1m.bin --from 2010-06-07 --to 2019-01-01 --tag nq [--entry-open] [--placebos 100]
//   node research/selectivity_tod.mjs --analyze        (reads the four runs: nq, mnq, es, es_open)
//
// The person's question (2026-11-26): a discretionary trader can beat the same strategy run mechanically because
// they don't take every signal; and times of day matter. Written before any run:
// - Skipping at random cannot change the expected result per trade, only how many trades there are. Skipping helps
//   only if the skip uses information there at the time that separates winners from losers. So the test is of
//   the skip rules traders use, each a rule a computer can follow, judged as everything else here.
// - Readings (the indicator's arithmetic, as databox_lengths.mjs): 1m EMA 12/26 speed warning (the default),
//   1m EMA 3/13 slowing warning (#3, the box's fast row), 1m MACD 12/26/9 shrink warning, 5m EMA speed warning,
//   5m MACD shrink warning. Each warning onset calls a direction (a 5m one counts at the 1m bar closing it).
// - The race (as everywhere here): from the bar's close (or, --entry-open, the next bar's open), does price go
//   0.064% of its price the called way before as far the other way, by 15:05 CT? Counted bars close 08:30-14:55 CT.
//   A race is settled on the first bar reaching either side (both = a loss both ways) or at 15:05 (a loss).
// - TIME OF DAY: 13 slots (08:30-09:00 ... 14:30-14:55 by the bar's close). A reading's edge in a slot is its win
//   rate less every counted minute's in the same slot and direction, so the hour's own drift is netted out.
//   Discovery on NQ 2010-2018: the 6 slots with the highest edge for each reading are its "good hours". Confirm
//   on MNQ 2019-2026 and on ES 2010-2026 (close and next open): the edge in those 6 slots less the edge in the
//   other 7, positive and beating 90 of 100 placebo markets (the same slots on each), on every one of the three.
// - SKIP RULES (pass / fail, on the 1m EMA default warning and on #3), using only races settled before the signal:
//     FIRST   the reading's first signal of the session
//     HOT     the reading's last settled signal today won (against: it lost; signals with none settled are left out)
//     TILT    fewer than 2 of today's earlier signals settled as losses (stop after two losers)
//     QUIT    none of today's earlier signals settled as a win (stop after a winner)
//     SPACED  no signal of the reading in the 10 bars before (skip the chop)
//   A rule's lift: its passing signals' edge less its failing signals' (edge = win rate less every counted minute's
//   in the same half hour and direction, so a rule that keeps early signals is not credited with the hour's drift;
//   the readings fire 70-115 times a session, so FIRST, TILT and QUIT mostly keep the morning's). Screen: NQ 2010-2018 and MNQ 2019-2026 each beating 90 of 100 placebo markets
//   the same sign; confirm: ES 2010-2026 from the close and the next open, each beating 90. 10 rules x readings.
// - Placebo markets: placeboBars, seeds 3900 + p.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample, sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { rawOffsets } from "../src/levels.mjs";
import { placeboBars } from "./lib_levels.mjs";

const args = process.argv.slice(2), arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const MIN = 60000, FIRST = 8 * 60 + 30, LAST = 14 * 60 + 55, FLAT = 15 * 60 + 5, R18 = 0.00064, NSLOT = 13, SPACE = 10;
const RULES = ["FIRST", "HOT", "TILT", "QUIT", "SPACED"], RULE_READS = [0, 1];
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

// ── the indicator's arithmetic (as databox_lengths.mjs / databox_eth.mjs) ──
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
function warnings(L, rule) {
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
const READ = [
  { name: "1m EMA 12/26 speed (default)", tf: 1, line: (c) => emaLine(c, 12, 26), rule: "speed" },
  { name: "1m EMA 3/13 slowing (#3)", tf: 1, line: (c) => emaLine(c, 3, 13), rule: "slowing" },
  { name: "1m MACD 12/26/9 shrink", tf: 1, line: (c) => macdLine(c, 12, 26, 9), rule: "shrink" },
  { name: "5m EMA 12/26 speed", tf: 5, line: (c) => emaLine(c, 12, 26), rule: "speed" },
  { name: "5m MACD 12/26/9 shrink", tf: 5, line: (c) => macdLine(c, 12, 26, 9), rule: "shrink" },
];
const NR = READ.length;

function measure(b, FROM, TO, OPEN) {
  const N = b.close.length, TS = b.ts, H = b.high, L = b.low, C = b.close, TD = b.tday, CT = b.ctMin, off = rawOffsets(b);
  const Y0 = new Date(FROM).getUTCFullYear(), NY = new Date(TO - 1).getUTCFullYear() - Y0 + 1;
  const b5 = resample(b, 5), at5 = new Int32Array(b5.close.length).fill(-1);
  const slot = new Int8Array(N).fill(-1), year = new Int8Array(N), winU = new Uint8Array(N), winD = new Uint8Array(N), done = new Int32Array(N);
  const sn = new Float64Array(NSLOT * 2), sw = new Float64Array(NSLOT * 2), yn = new Float64Array(NY * 2), yw = new Float64Array(NY * 2);
  let k5 = -1;
  for (let i = 1; i + 1 < N; i++) {
    let new5 = -1;
    while (k5 + 1 < b5.ts.length && b5.ts[k5 + 1] + 5 * MIN <= TS[i] + MIN) { k5++; new5 = k5; }
    if (TS[i] < FROM || TS[i] >= TO) continue;
    const cc = (CT[i] + 1) % 1440;
    if (cc < FIRST || cc > LAST || TD[i + 1] !== TD[i]) continue;
    if (new5 >= 0) at5[new5] = i;
    const s = Math.min(NSLOT - 1, Math.floor((cc - FIRST - 1) / 30)), y = new Date(TS[i]).getUTCFullYear() - Y0;
    slot[i] = s < 0 ? 0 : s; year[i] = y;
    const P = OPEN ? b.open[i + 1] : C[i], R = R18 * (C[i] - off[i]);
    let u = 0, d = 0, j = i + 1, end = i + 1;
    for (; j < N && TD[j] === TD[i] && CT[j] < FLAT; j++) {
      end = j;
      const up = H[j] - P >= R, dn = P - L[j] >= R;
      if (up || dn) { u = dn ? -1 : 1; d = up ? -1 : 1; break; }
    }
    winU[i] = u === 1 ? 1 : 0; winD[i] = d === 1 ? 1 : 0; done[i] = end;   // settled by the close of bar `end`
    for (const [dir, w] of [[0, winU[i]], [1, winD[i]]]) { sn[slot[i] * 2 + dir]++; sw[slot[i] * 2 + dir] += w; yn[y * 2 + dir]++; yw[y * 2 + dir] += w; }
  }
  const tod = [], rules = [];
  READ.forEach((R, r) => {
    const calls = onsetsOf(warnings(R.line(R.tf === 1 ? b.close : b5.close), R.rule));
    const sig = [];   // { i, c, win, done }
    for (let k = 0; k < calls.length; k++) {
      const c = calls[k];
      if (!c) continue;
      const i = R.tf === 1 ? k : at5[k];
      if (i < 0 || slot[i] < 0) continue;
      sig.push({ i, c, win: c === 1 ? winU[i] : winD[i] });
    }
    sig.sort((a, z) => a.i - z.i);
    const tn = new Float64Array(NSLOT), te = new Float64Array(NSLOT);
    for (const q of sig) { const dir = q.c === 1 ? 0 : 1, s = slot[q.i]; tn[s]++; te[s] += q.win - sw[s * 2 + dir] / sn[s * 2 + dir]; }
    tod.push({ n: Array.from(tn), ex: Array.from(te) });
    if (!RULE_READS.includes(r)) { rules.push(null); return; }
    // the skip rules, from what was settled before each signal's bar closed
    const acc = RULES.map(() => ({ pn: 0, pe: 0, fn: 0, fe: 0 }));
    let day = -1, today = [], lastI = -1e9;
    for (const q of sig) {
      if (TD[q.i] !== day) { day = TD[q.i]; today = []; }
      const settled = today.filter((z) => done[z.i] < q.i);   // settled by the close of the bar before this one
      const losses = settled.filter((z) => !z.win).length, wins = settled.length - losses, last = settled.length ? settled.reduce((a, z) => (done[z.i] > done[a.i] ? z : a)) : null;
      const dir = q.c === 1 ? 0 : 1, s = slot[q.i], ex = q.win - sw[s * 2 + dir] / sn[s * 2 + dir];
      const pass = [today.length === 0, last ? last.win === 1 : null, losses < 2, wins === 0, q.i - lastI > SPACE];
      pass.forEach((p, k) => { if (p === null) return; const a = acc[k]; if (p) { a.pn++; a.pe += ex; } else { a.fn++; a.fe += ex; } });
      today.push(q); lastI = q.i;
    }
    rules.push(acc);
  });
  return { tod, rules };
}

if (args.includes("--analyze")) {
  const J = Object.fromEntries(["nq", "mnq", "es", "es_open"].map((t) => [t, JSON.parse(fs.readFileSync(`research/selectivity_tod_${t}_results.json`, "utf8"))]));
  const pt = (v) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + (100 * v).toFixed(1) : "—");
  const SL = Array.from({ length: NSLOT }, (_, s) => { const a = FIRST + 30 * s, f = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; return `${f(a)}-${f(Math.min(a + 30, LAST))}`; });
  console.log("TIME OF DAY: each reading's edge by half hour (points of win rate over every minute in that half hour, same direction)\n");
  READ.forEach((R, r) => {
    console.log(R.name);
    console.log("  slot          " + ["nq", "mnq", "es"].map((t) => t.padStart(8)).join(""));
    SL.forEach((nm, s) => console.log(`  ${nm}   ${["nq", "mnq", "es"].map((t) => pt(J[t].real.tod[r].ex[s] / J[t].real.tod[r].n[s]).padStart(8)).join("")}`));
  });
  console.log("\nTIME OF DAY VERDICT: the 6 best NQ half hours per reading, read on MNQ and ES (edge in them less in the other 7)");
  const lift = (T, set) => { let a = 0, an = 0, b = 0, bn = 0; T.n.forEach((n, s) => { if (set.has(s)) { a += T.ex[s]; an += n; } else { b += T.ex[s]; bn += n; } }); return a / an - b / bn; };
  READ.forEach((R, r) => {
    const T = J.nq.real.tod[r], ord = T.n.map((n, s) => [T.ex[s] / n, s]).sort((x, y) => y[0] - x[0]), set = new Set(ord.slice(0, 6).map((z) => z[1]));
    const res = ["mnq", "es", "es_open"].map((t) => { const v = lift(J[t].real.tod[r], set), pl = J[t].placebo.map((p) => lift(p.tod[r], set)); return { t, v, beats: pl.filter((z) => z < v).length }; });
    const ok = res.every((z) => z.v > 0 && z.beats >= 90);
    console.log(`  ${R.name.padEnd(30)} good hours ${[...set].sort((a, b) => a - b).map((s) => SL[s].slice(0, 5)).join(" ")} | ${res.map((z) => `${z.t} ${pt(z.v)} (beats ${z.beats})`).join(", ")}  ${ok ? "CONFIRMED" : "not confirmed"}`);
  });
  console.log("\nSKIP RULES: passing signals' edge less failing signals' (beats = placebo markets beaten, the same sign)");
  const L = (a) => a.pe / a.pn - a.fe / a.fn;
  RULE_READS.forEach((r) => RULES.forEach((nm, k) => {
    const row = ["nq", "mnq", "es", "es_open"].map((t) => { const v = L(J[t].real.rules[r][k]), pl = J[t].placebo.map((p) => L(p.rules[r][k])); return { t, v, beats: v >= 0 ? pl.filter((z) => z < v).length : pl.filter((z) => z > v).length, n: J[t].real.rules[r][k].pn }; });
    const sg = Math.sign(row[0].v), screen = row[0].beats >= 90 && row[1].beats >= 90 && Math.sign(row[1].v) === sg, conf = screen && row.slice(2).every((z) => Math.sign(z.v) === sg && z.beats >= 90);
    console.log(`  ${READ[r].name.padEnd(30)} ${nm.padEnd(7)} ${row.map((z) => `${z.t} ${pt(z.v)} (${z.beats}; n ${z.n})`).join(", ")}  ${conf ? (sg > 0 ? "CONFIRMED: skipping helps" : "CONFIRMED: the rule hurts") : screen ? "screen pass, not confirmed" : "fails the screen"}`);
  }));
  process.exit(0);
}

const FILE = arg("--file", "data/nq_1m.bin"), FROM = Date.parse(arg("--from", "2010-06-07")), TO = Date.parse(arg("--to", "2019-01-01"));
const OPEN = args.includes("--entry-open"), PLACEBOS = Number(arg("--placebos", 100)), TAG = arg("--tag", "") + (OPEN ? "_open" : "");
const { bars: all } = loadBars(FILE);
const bars = sliceBars(all, indexAtOrAfter(all.ts, FROM - 200 * 86400000), indexAtOrAfter(all.ts, TO + 2 * 86400000));
const real = measure(bars, FROM, TO, OPEN);
process.stderr.write(`  ${FILE} ${new Date(FROM).toISOString().slice(0, 10)} to ${new Date(TO).toISOString().slice(0, 10)}${OPEN ? " (next open)" : ""}: real ${secs()}s\n`);
const placebo = [];
for (let p = 0; p < PLACEBOS; p++) {
  placebo.push(measure(placeboBars(bars, 3900 + p), FROM, TO, OPEN));
  if ((p + 1) % 10 === 0) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`);
}
if (TAG) fs.writeFileSync(`research/selectivity_tod_${TAG}_results.json`, JSON.stringify({ run: new Date().toISOString(), file: FILE, from: FROM, to: TO, open: OPEN, real, placebo }));
console.log(`wrote research/selectivity_tod_${TAG}_results.json (${secs()}s)`);
