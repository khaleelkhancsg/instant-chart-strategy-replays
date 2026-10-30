// Stage 2 of the level study: what survives pressure.
//
//   node --max-old-space-size=8192 research/levels_stress.mjs
//
// RESULT (2026, then 32 forward sessions), matched edge after the placebo bias:
//   Claims the indicator makes: prior POCs +0.9 and +0.9, HVNs -1.4 and -4.0, prior-day
//   high/low -2.0 and +0.7, overnight high/low -4.0 and -5.7, all inside the noise.
//   Round 100/500 -5.5 (CI -9.8 to -1.5, q 0.17) at R 5% is the one with a signal, and
//   it went to -0.3 forward (levels_followup.mjs).
//   Drift is not the story: twin bounce rates by side differ by 1.4 points.
//   The 6 shortlisted levels kept their sign forward 2 times of 6, where coins give 3.
//   This sample can see about 13 points on a single level and 7 on a pool, so it can
//   neither confirm nor rule out the original study's +4-6 points.
// 1. POOLS. Related levels together, for power, against the claims the levels
//    indicator makes in its header.
// 2. DRIFT. How much of "highs break, lows hold" is 2026 simply rising.
// 3. THE SHORTLIST, fixed from levels_study_results.json before the forward data is
//    read: q < 0.60, the same sign in both halves, and at least 40 touches. Each goes
//    through (the 15 strongest with both halves agreeing, if none reach that):
//      - a grid of 45 definitions: R 3-20%, 0-4 ticks through, 30-120 minutes;
//      - first touches alone;
//      - twins nearer and further away;
//      - the forward bars, Sep 11 - Oct 26 2026, which nothing here has seen.
//
// Writes research/levels_stress_results.json.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as Lab from "./lib_levels.mjs";
import { buildCatalog, POOLS } from "./levels_catalog.mjs";

const NBOOT = 1000, t0 = Date.now();
const PL = JSON.parse(fs.readFileSync(new URL("./levels_placebo_results.json", import.meta.url), "utf8"));
const sample = Lab.loadSample({ to: Date.UTC(2026, 6, 15) }), { days } = sample, D = days.length;
const cat = buildCatalog(sample), tagIdx = new Map(cat.map((c, i) => [c.tag, i]));
const boot = Lab.bootDays(D, NBOOT);
const f = (x, d = 1) => (x == null ? "-" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}`);
const fm = (e) => (e ? `${f(e.edge)} [${f(e.lo)}, ${f(e.hi)}] n${e.n}` : "no touches");
const out = {};

// ── pools ──
for (const names of Object.values(POOLS)) for (const k of names) if (!tagIdx.has(k)) throw new Error(`no level "${k}"`);

console.log(`POOLS, matched edge in points of bounce rate, 2026 (${D} sessions). R = 5% and 12% of the daily range.\n`);
const poolRows = [];
for (const rFrac of [0.05, 0.12]) {
  const ev = Lab.runLevels(sample, cat, { rFrac, thru: 1, twins: 8 }), ids = Lab.byTag(ev, cat.length);
  for (const [name, tags] of Object.entries(POOLS)) {
    const all = Int32Array.from(tags.flatMap((k) => [...ids[tagIdx.get(k)]]));
    const m = Lab.matchedEdgeOf(ev, all, D, boot, NBOOT);
    if (!m) continue;
    const a = Lab.matchedEdgeOf(ev, all, D, boot, 200, (i) => days[ev.day[i]].half === 0), z = Lab.matchedEdgeOf(ev, all, D, boot, 200, (i) => days[ev.day[i]].half === 1);
    const c = Lab.calibrate(m.edge, PL.res[`pool:${name}|${rFrac}`]);
    poolRows.push({ name, r: rFrac, ...m, adj: c.adj, bias: c.bias, z: c.z, p: Math.max(m.p, c.pPlacebo), h1: a && a.edge, h2: z && z.edge });
  }
}
const pq = Lab.bh(poolRows.map((r) => r.p));
poolRows.forEach((r, i) => { r.q = pq[i]; });
for (const name of Object.keys(POOLS)) {
  const [a, b] = [0.05, 0.12].map((r) => poolRows.find((x) => x.name === name && x.r === r));
  const s = (x) => (x ? `${f(x.adj).padStart(6)} [${f(x.lo).padStart(6)}, ${f(x.hi).padStart(6)}] z${f(x.z).padStart(5)} q${x.q.toFixed(2)} (${f(x.h1).padStart(5)} /${f(x.h2).padStart(6)}) n${x.n}` : "-");
  console.log(`${name.padEnd(34)} ${s(a).padEnd(58)} ${s(b)}`);
}
out.pools = poolRows;

// ── drift ──
console.log(`\nDRIFT. Twin bounce rate by side, R 5%: an arbitrary price, so any gap between the sides is the market, not a level.`);
{
  const ev = Lab.runLevels(sample, cat, { rFrac: 0.05, thru: 1, twins: 8 });
  const c = { 1: [0, 0], [-1]: [0, 0] };
  for (let i = 0; i < ev.n; i++) if (!ev.real[i] && ev.oc[i]) { c[ev.side[i]][1]++; if (ev.oc[i] === 1) c[ev.side[i]][0]++; }
  const sup = (100 * c[1][0]) / c[1][1], res = (100 * c[-1][0]) / c[-1][1];
  console.log(`  support (price above it) ${sup.toFixed(1)}%   resistance (price below it) ${res.toFixed(1)}%   gap ${f(sup - res)} points`);
  out.drift = { sup, res };
}

// ── the shortlist ──
const study = JSON.parse(fs.readFileSync(new URL("./levels_study_results.json", import.meta.url), "utf8"));
const short = study.rows.filter((r) => r.q < 0.6 && r.sameSign && r.n >= 40).sort((a, b) => a.p - b.p);
if (!short.length) short.push(...study.rows.filter((r) => r.sameSign && r.n >= 40).sort((a, b) => a.p - b.p).slice(0, 15));
console.log(`\nSHORTLIST: ${short.length} level and size pairs, fixed before reading the forward bars.`);

// Forward bars: after the roll, so raw and adjusted prices agree.
const fwd = Lab.loadSample({ file: fileURLToPath(new URL("../data/topstepx_1m.bin", import.meta.url)), from: Date.UTC(2026, 8, 11), warmDays: 20 });
const fcat = buildCatalog(fwd), ftag = new Map(fcat.map((c, i) => [c.tag, i])), FD = fwd.days.length, fboot = Lab.bootDays(FD, NBOOT);
console.log(`Forward: ${FD} sessions, ${new Date(fwd.days[0].ms).toISOString().slice(0, 10)} to ${new Date(fwd.days[FD - 1].ms).toISOString().slice(0, 10)}.`);

const GRID = [];
for (const r of [0.03, 0.05, 0.08, 0.12, 0.2]) for (const thru of [0, 1, 4]) for (const hold of [30, 60, 120]) GRID.push({ rFrac: r, thru, hold });
const results = [];
for (const s of short) {
  const t = tagIdx.get(s.tag), one = [cat[t]], base = { rFrac: s.r, thru: 1, hold: 60, twins: 8 };
  const sign = Math.sign(s.edge), ids0 = (ev) => Lab.byTag(ev, 1)[0];
  // the grid of definitions: how many agree with the headline's sign, and how many clear zero
  let agree = 0, clear = 0, tested = 0;
  for (const g of GRID) {
    const ev = Lab.runLevels(sample, one, { ...g, twins: 8 }), m = Lab.matchedEdgeOf(ev, ids0(ev), D, boot, 300);
    if (!m || m.n < 15) continue;
    tested++;
    if (Math.sign(m.edge) === sign) agree++;
    if (sign > 0 ? m.lo > 0 : m.hi < 0) clear++;
  }
  // first touches, then every touch whatever came before it
  const ev0 = Lab.runLevels(sample, one, base), first = Lab.matchedEdgeOf(ev0, ids0(ev0), D, boot, NBOOT, (i) => ev0.no[i] === 0);
  const evAll = Lab.runLevels(sample, one, { ...base, chain: false }), every = Lab.matchedEdgeOf(evAll, ids0(evAll), D, boot, NBOOT);
  // the forward bars, at the headline definition
  const ft = ftag.get(s.tag), evF = ft == null ? null : Lab.runLevels(fwd, [fcat[ft]], base), fm0 = evF ? Lab.matchedEdgeOf(evF, ids0(evF), FD, fboot, NBOOT) : null;
  const ep = evF ? Lab.edgeOf(evF, ids0(evF), FD, fboot, 200) : null;
  results.push({ family: s.family, tag: s.tag, r: s.r, edge: s.edge, lo: s.lo, hi: s.hi, q: s.q, n: s.n, agree, tested, clear, first, every, fwd: fm0, evReal: s.evReal, evTwin: s.evTwin, fwdEvReal: ep && ep.evReal, fwdEvTwin: ep && ep.evTwin, sameFwd: fm0 ? Math.sign(fm0.edge) === sign : null });
}
const fq = Lab.bh(results.map((r) => (r.fwd ? r.fwd.p : 1)));
results.forEach((r, i) => { r.fq = fq[i]; });
console.log(`\n${"level".padEnd(30)} R    2026 matched edge            grid: agree/clear of n   first touch         FORWARD`);
for (const r of results) {
  console.log(`${r.tag.padEnd(30)} ${String(r.r * 100).padEnd(3)}  ${fm(r).padEnd(30)} ${`${r.agree}/${r.clear} of ${r.tested}`.padEnd(18)} ${(r.first ? f(r.first.edge) : "-").padEnd(8)} ${fm(r.fwd).padEnd(30)} ${r.sameFwd ? "same sign" : "FLIPPED"}${r.fq < 0.1 ? " q<0.10" : ""}`);
}
const same = results.filter((r) => r.sameFwd).length;
console.log(`\nForward sign agreed on ${same} of ${results.length}. Coin flips would agree on about ${results.length / 2}.`);
out.short = results; out.forwardSessions = FD;
fs.writeFileSync(new URL("./levels_stress_results.json", import.meta.url), JSON.stringify(out));
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
