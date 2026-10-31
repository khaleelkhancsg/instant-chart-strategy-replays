// Does anyone act at a level? The footprint test.
//
//   node --max-old-space-size=8192 research/pct_footprint.mjs [paths]
//
// RESULT (2026, 60 placebo markets; touch-minute volume over twins): the levels people watch
// show up, and percentages from settlement do not. The day's extremes, the overnight range,
// the opening range and the initial balance together: +7.7% [+3.9, +11.6], both halves (+6.3,
// +9.7), forward +5.0 [-2.3, +11.1]. Round 100s: +3.4% [+0.8, +6.3], both halves, forward +3.5,
// and the next 5 minutes' range +2.6%. Every rung from settlement: -1.6% [-4.0, +0.7], forward
// +0.8. The off-grid control: -0.7%. None of the 114 tests clears q 0.10 (lowest 0.31), and the
// pooled row was added after the first look, so this is a pattern and not a proof. Half-percent
// rungs from the RTH open read +6.2% in 2026, and -1.2% forward: it did not last.
//
// A bounce test asks whether a level turns price, which is a lot to ask: a level can be
// watched by everybody and still go either way. This asks something smaller and far easier
// to detect. If people have orders at a price, then when price gets there, more should trade
// than usually trades at that minute of the day, and price should move more. So:
//
//   VOLUME    the touch minute's volume against the median of that clock minute over
//             the last 20 sessions, in logs.
//   AFTER     the same for the five minutes after it, volume and range.
//
// Each touch is compared with touches of the level's shifted twins on the same day, on the
// same side and in the same part of the day (lib_levels.mjs matchedMeanOf). A twin is touched
// by the same kind of move, so a fast market lifts both. What is left is the price itself.
// Volume stays on its clock minute on a placebo market, so the placebo says what the method
// gives when price and volume have nothing to do with each other.
//
// The levels people are known to watch go in beside the percentages: if the test cannot see
// the prior day's high, it cannot say anything about 1% from settlement.
//
// Writes research/pct_footprint_results.json.

import fs from "node:fs";
import * as Lab from "./lib_levels.mjs";
import * as P from "./lib_pct.mjs";
import { buildCatalog } from "./levels_catalog.mjs";
import { buildPctCatalog, PCT_POOLS } from "./pct_catalog.mjs";

const PATHS = Number(process.argv[2]) || 40, NBOOT = 1000, rFrac = 0.05, t0 = Date.now();
const real = P.loadReal(), { days } = real, D = days.length, boot = Lab.bootDays(D, NBOOT);

// The levels fixed before the session, or once set: a moving line gets its own placebo bias.
const CONTROL = {
  "All session extremes": ["Overnight high", "Overnight low", "OR15 high", "OR15 low", "IB high", "IB low", "day high so far", "day low so far"],
  "Prior day high/low": ["PD high", "PD low"], "Prior day close": ["PD close"], "Overnight high/low": ["Overnight high", "Overnight low"], "Pre-market high/low": ["Pre-market high", "Pre-market low"],
  "Opening range 15m": ["OR15 high", "OR15 low"], "Initial balance": ["IB high", "IB low"], "Prior week high/low": ["PW high", "PW low"], "Prior month high/low": ["PM high", "PM low"],
  "Prior POCs": ["PD POC (RTH)", "VP5 POC", "VP20 POC"], "RTH open": ["RTH open"], "Week/month open": ["Week open", "Month open"],
  "Round 500": ["Round 500"], "Round 100": ["Round 100"], "Round 50": ["Round 50"], "Round 25": ["Round 25"], "Monday's range": ["Monday high", "Monday low"], "Day's high/low so far": ["day high so far", "day low so far"],
};
const FP = { "Settlement itself": ["PD close"], "Every rung from settlement": ["0.25", "0.5", "0.75", "1", "1.25", "1.5", "1.75", "2", "2.5", "3"].flatMap((p) => [`settle +${p}%`, `settle -${p}%`]) };
for (const [k, v] of Object.entries(PCT_POOLS)) if (!/Noise|Fan/.test(k)) FP[k] = v;

function measure(ev, sample, sessions) {
  const { b } = sample, lv = P.excessOf(b, sessions, (i) => b.volume[i]), lr = P.excessOf(b, sessions, (i) => b.high[i] - b.low[i] + 0.25);
  const vol = new Float32Array(ev.n), volAfter = new Float32Array(ev.n), rangeAfter = new Float32Array(ev.n);
  const av = (a, k) => { let s = 0, c = 0; for (let j = k + 1; j <= k + 5; j++) { const x = a[j]; if (x === x) { s += x; c++; } } return c ? s / c : NaN; };
  for (let i = 0; i < ev.n; i++) { const k = ev.bar[i]; vol[i] = lv[k]; volAfter[i] = av(lv, k); rangeAfter[i] = av(lr, k); }
  return { vol, volAfter, rangeAfter };
}
const ALL = { ...CONTROL, ...FP };
function run(sample, sessions) {
  const c1 = buildCatalog(sample), c2 = buildPctCatalog(sample), seen = new Set(), cat = [];
  for (const lv of c1.concat(c2)) if (!seen.has(lv.tag)) { seen.add(lv.tag); cat.push(lv); }
  const idx = new Map(cat.map((c, i) => [c.tag, i])), ev = Lab.runLevels(sample, cat, { rFrac, thru: 1, twins: 8 }), ids = Lab.byTag(ev, cat.length);
  const pick = (tags) => Int32Array.from(tags.flatMap((k) => { if (!idx.has(k)) throw new Error(`no level ${k}`); return [...ids[idx.get(k)]]; }));
  return { ev, cat, pick, ...measure(ev, sample, sessions) };
}
const sess = (s) => s.sessions.filter((x) => x.rthA >= 0);
const base = run(real, sess(real)), fwd = P.loadForward(), fbase = run(fwd, sess(fwd)), FD = fwd.days.length, fboot = Lab.bootDays(FD, NBOOT);
const dist = {};
for (let p = 0; p < PATHS; p++) {
  const s = { ...real, b: Lab.placeboBars(real.b, 60000 + p) }, r = run(s, sess(real));
  for (const [name, tags] of Object.entries(ALL)) {
    const ids = r.pick(tags);
    for (const m of ["vol", "volAfter", "rangeAfter"]) { const e = Lab.matchedMeanOf(r.ev, ids, r[m], D, boot, 0); if (e) (dist[`${name}|${m}`] ||= []).push(e.mean); }
  }
  console.log(`  ${p + 1} of ${PATHS} placebo paths, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
const rows = [];
for (const [name, tags] of Object.entries(ALL)) {
  const ids = base.pick(tags), row = { name, control: name in CONTROL };
  for (const m of ["vol", "volAfter", "rangeAfter"]) {
    const e = Lab.matchedMeanOf(base.ev, ids, base[m], D, boot, NBOOT), a = Lab.matchedMeanOf(base.ev, ids.filter((i) => days[base.ev.day[i]].half === 0), base[m], D, boot, 0), z = Lab.matchedMeanOf(base.ev, ids.filter((i) => days[base.ev.day[i]].half === 1), base[m], D, boot, 0);
    const d = dist[`${name}|${m}`] || [], mean = P.mean(d), sd = P.sdOf(d), adj = e.mean - mean, zs = sd > 0 ? adj / sd : 0;
    const ff = Lab.matchedMeanOf(fbase.ev, fbase.pick(tags), fbase[m], FD, fboot, NBOOT);
    row[m] = { pct: 100 * (Math.exp(adj) - 1), lo: 100 * (Math.exp(e.lo - mean) - 1), hi: 100 * (Math.exp(e.hi - mean) - 1), z: zs, p: Math.max(e.p, Lab.zToP(zs)), n: e.n, h1: 100 * (Math.exp(a.mean - mean) - 1), h2: 100 * (Math.exp(z.mean - mean) - 1),
               fwd: ff ? 100 * (Math.exp(ff.mean) - 1) : null, fwdLo: ff ? 100 * (Math.exp(ff.lo) - 1) : null, fwdHi: ff ? 100 * (Math.exp(ff.hi) - 1) : null, fwdN: ff ? ff.n : 0 };
  }
  rows.push(row);
}
const q = Lab.bh(rows.flatMap((r) => ["vol", "volAfter", "rangeAfter"].map((m) => r[m].p)));
rows.forEach((r, i) => ["vol", "volAfter", "rangeAfter"].forEach((m, j) => { r[m].q = q[i * 3 + j]; }));
fs.writeFileSync(new URL("./pct_footprint_results.json", import.meta.url), JSON.stringify({ paths: PATHS, sessions: D, rows }));
const f = (e) => `${P.f1(e.pct).padStart(6)}% [${P.f1(e.lo)}, ${P.f1(e.hi)}] z${P.f1(e.z).padStart(5)} q${e.q.toFixed(2)} (${P.f1(e.h1)}, ${P.f1(e.h2)}) fwd ${P.f1(e.fwd)} [${P.f1(e.fwdLo)}, ${P.f1(e.fwdHi)}] n${e.fwdN}`;
for (const [title, want] of [["LEVELS PEOPLE ARE KNOWN TO WATCH", true], ["PERCENTAGE LEVELS", false]]) {
  console.log(`\n${title}. Excess over twins: touch-minute volume | next 5 minutes' volume | next 5 minutes' range`);
  for (const r of rows.filter((x) => x.control === want)) console.log(`${r.name.padEnd(32)} n${String(r.vol.n).padEnd(5)} ${f(r.vol).padEnd(84)} | ${f(r.rangeAfter)}`);
}
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
