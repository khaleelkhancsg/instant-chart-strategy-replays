// VXN sizing on the $1,250 Donchian (donchian_1250).
//
//   node --max-old-space-size=8192 research/vxn_sizing_1250.mjs
//
// research/vxn_regime.mjs found the VXN before the open calls the size of MNQ's session better
// than the 10-session average range in 2026 (R2 0.20 against 0.10). Sized by it, the book would
// trade bigger on quiet days and smaller on wild ones, its dollar swings steadier against the
// $1,250 eval's $1,000 drawdown and $600 day line.
//
// The rule: lots = the book's own (4, 2 late, none against the 10-minute trend) x f, rounded,
// at least 1. f is the median of the 60 VXN closes up to the one before the session, over that
// close, held to 0.5-1.5. A quiet day (the VXN under its two-month median) trades more; a wild
// day fewer. Nothing else changes: donchian_1250's signal, exits, day rules and costs (a tick a
// side, $0.75 a side a contract). The VXN is FRED's VXNCLS in data/raw/fred/ (git-ignored).
//
// Judged the lab's way (research/lib_eval1250.mjs, through mcp/lab.mjs):
//   - 2026 on the lab's bars (to Jul 14), calendar and bootstrap, and in both halves;
//   - neighbours: the median over 20, 120 and 252 closes; f to the power 0.5 and 2;
//   - the same rule on the 10-session average range (realised, not implied);
//   - fixed 3 and 5 lots, to read a variant against fixed sizes at its average lots;
//   - the shuffle twin: the same factors dealt to the period's days at random, 40 times. The
//     same sizes, but which day got which carries nothing: what the timing alone is worth;
//   - forward: everything after the lab's data, Jul 15 - Oct 30 on data/mnq_1m_beta.bin
//     (research/forward_1250.mjs's scoring), with its own shuffle twins.
//
// Named before the first run: the 60-close rule against the shipped 4 lots, 2026 calendar and
// bootstrap, by the worse half of each, and against its shuffle twins.
//
// RESULT (run 2026-11-21; 2026 = the lab's bars to Jul 14, 139 days; forward Jul 15 - Oct 30, 77
// days; 40 shuffle twins): no. Keep the shipped 4 lots.
//   - The named rule (60-close median) against the shipped book, 2026:
//       - calendar 59.4% (Jan-Mar 47.8, Apr-Jul 73.3) against 74.5% (75.6, 73.3);
//       - bootstrap 64.2% (52.1, 77.9) against 71.1% (71.8, 75.9);
//       - 134 trades, +$8,217, $61 a trade, PF 1.50, against 128, +$9,933, $78, PF 1.62.
//     2026's VXN sat above its two-month median on most days (factor median 0.92), so the rule
//     traded smaller: 3.15 lots a trade against 3.44. Fixed 3 lots does the same: 60.0%.
//   - Its timing is worth nothing in 2026. 35 of its 40 shuffle twins (the same factors on random
//     days) pass the calendar windows as often or more (mean 66.0%); 18 and 17 match its bootstrap
//     and net.
//   - Forward it does better: 66.2% calendar and +$4,120, against 44.2% and +$2,584.
//       - But it traded bigger there (3.93 lots against 3.57), and fixed 5 lots does as well
//         (70.1%, +$4,785).
//       - 6 of 40 shuffle twins match its calendar rate.
//   - At the shipped book's own average size it is level:
//       - the 20-close median (3.36 lots): 73.9% calendar, 66.0% bootstrap, forward 44.2%;
//       - f^0.5 (3.38 lots): 73.9% / 69.8%.
//   - The 10-session range in its place does no better: 53.9% / 59.7% in 2026, 66.2% forward at
//     4.06 lots.
//   - The 2026 calendar ci95 is [34.7, 94.2] for the shipped book: five or six independent windows,
//     so a 15-point gap is inside the noise. What the variants share is that their pass rates
//     follow their average size, not the VXN. 4 lots sits at the top of the 2026 curve: 3 lots
//     60.0%, 5 lots 52.1%.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { sessionsOf, adrOf } from "../src/levels.mjs";
import { mulberry32 } from "../src/dayeval.mjs";
import { configOf, trades2026, score, forwardScorer, Y26, lab as L } from "./lib_eval1250.mjs";

const DAY = 86400000, FWD_FROM = Date.UTC(2026, 6, 15), SEEDS = 40;
const VXN_FILE = "data/raw/fred/VXNCLS.csv", BETA = "data/mnq_1m_beta.bin";
const t0 = Date.now();

// ── the VXN, and each trading day's factor ──
const vxn = fs.readFileSync(VXN_FILE, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","))
  .filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && v && v.trim() !== "." && Number.isFinite(+v))
  .map(([d, v]) => ({ ms: Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)), v: +v }));
function lastBefore(ms) {
  let lo = 0, hi = vxn.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (vxn[m].ms < ms) { at = m; lo = m + 1; } else hi = m - 1; }
  return at;
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
function vxnFactor(W, e = 1, lo = 0.5, hi = 1.5) {
  const memo = new Map();
  return (td) => {
    let f = memo.get(td);
    if (f !== undefined) return f;
    const k = lastBefore(td * DAY);
    f = k >= W - 1 ? clamp((median(vxn.slice(k - W + 1, k + 1).map((x) => x.v)) / vxn[k].v) ** e, lo, hi) : 1;
    memo.set(td, f);
    return f;
  };
}
// The same on the 10-session average range (src/levels.mjs adrOf: the sessions before), against
// its median over the W sessions before.
function adrFactor(b, W, lo = 0.5, hi = 1.5) {
  const ss = sessionsOf(b), adr = adrOf(ss), map = new Map();
  for (let k = 0; k < ss.length; k++) {
    const prev = [];
    for (let j = Math.max(0, k - W); j < k; j++) if (Number.isFinite(adr[j])) prev.push(adr[j]);
    if (Number.isFinite(adr[k]) && prev.length >= W * 0.8) map.set(ss[k].td, clamp(median(prev) / adr[k], lo, hi));
  }
  return (td) => map.get(td) ?? 1;
}

// The book with its sizeMult multiplied by a day's factor. Each gets its own id, so no run is
// mistaken for another's.
let uid = 0;
function withFactor(cfg, factor) {
  const s = cfg.s;
  return { ...cfg, s: { ...s, id: `${s.id}~size${++uid}`, compute(b, p) {
    const o = s.compute(b, p), n = b.close.length, m = o.sizeMult, out = new Float64Array(n);
    for (let k = 0; k < n; k++) out[k] = (m ? m[k] : 1) * factor(b.tday[k]);
    return { ...o, sizeMult: out };
  } } };
}
// The factors of `days`, dealt to them in a random order; other days keep their own.
function shuffled(factor, days, seed) {
  const vals = days.map(factor), r = mulberry32(seed);
  for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
  const map = new Map(days.map((td, i) => [td, vals[i]]));
  return (td) => (map.has(td) ? map.get(td) : factor(td));
}

// ── the bars and the scoring ──
const lab = L.bars(), labLast = lab.ts[lab.count - 1];
const beta = loadBars(BETA).bars, F = forwardScorer(beta, FWD_FROM);
const betaRun = sliceBars(beta, indexAtOrAfter(beta.ts, Y26 - 120 * DAY), beta.count);
const tradeDays = (b, from, to) => { const out = []; for (let i = 0; i < b.count; i++) if ((i === 0 || b.tday[i] !== b.tday[i - 1]) && b.ts[i] >= from && b.ts[i] < to) out.push(b.tday[i]); return out; };
const days26 = tradeDays(lab, Y26, labLast + 1), daysFwd = F.days;
const lots = (tr) => (tr.length ? Math.round((tr.reduce((s, t) => s + t.contracts, 0) / tr.length) * 100) / 100 : 0);
function run(cfg) {
  const tr = trades2026(cfg), fw = runStrategy(betaRun, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies: cfg.studies, fromMs: FWD_FROM }).trades;
  return { ...score(tr, cfg.rules), lots: lots(tr), fwd: { ...F.score(fw, cfg.rules), lots: lots(fw) } };
}

const base = await configOf("donchian_1250");
const ADR = adrFactor(beta, 60);
const ROWS = [
  ["shipped: 4 lots", base],
  ["fixed 3 lots", await configOf("donchian_1250", { exec: { contracts: 3 } })],
  ["fixed 5 lots", await configOf("donchian_1250", { exec: { contracts: 5 } })],
  ["VXN, 60-close median (named)", withFactor(base, vxnFactor(60))],
  ["  VXN, 20-close median", withFactor(base, vxnFactor(20))],
  ["  VXN, 120-close median", withFactor(base, vxnFactor(120))],
  ["  VXN, 252-close median", withFactor(base, vxnFactor(252))],
  ["  VXN, 60, f^0.5 (softer)", withFactor(base, vxnFactor(60, 0.5))],
  ["  VXN, 60, f^2 (stronger)", withFactor(base, vxnFactor(60, 2))],
  ["10-session range, 60 median", withFactor(base, ADR)],
];

const pad = (s, n) => String(s).padStart(n);
const line = (label, r) => `${label.padEnd(31)}${pad(r.lots, 5)}${pad(r.trades, 5)}${pad(r.net, 8)}${pad(r.perTrade, 6)}${pad(r.pf, 6)}` +
  `${pad(`${r.cal} (${r.calA}/${r.calB})`, 20)}${pad(Math.min(r.calA, r.calB), 6)}${pad(`${r.boot} (${r.bootA}/${r.bootB})`, 20)}${pad(Math.min(r.bootA, r.bootB), 6)}` +
  ` | ${pad(r.fwd.lots, 5)}${pad(r.fwd.trades, 4)}${pad(r.fwd.net, 7)}${pad(r.fwd.cal, 6)}${pad(r.fwd.boot, 6)}`;
console.log(`2026 = the lab's bars, ${new Date(Y26).toISOString().slice(0, 10)} to ${new Date(labLast).toISOString().slice(0, 10)}, ${days26.length} trading days; forward = ${BETA} from 2026-07-15, ${daysFwd.length} trading days`);
console.log(`${"".padEnd(31)}${pad("lots", 5)}${pad("tr", 5)}${pad("net", 8)}${pad("$/tr", 6)}${pad("PF", 6)}${pad("cal (Jan-Mar/Apr-Jul)", 20)}${pad("worse", 6)}${pad("boot (halves)", 20)}${pad("worse", 6)} | fwd: lots  tr    net   cal  boot`);
const out = {};
for (const [label, cfg] of ROWS) { out[label] = run(cfg); console.log(line(label, out[label])); }
console.log(`  2026 calendar ci95 for the shipped book: ${JSON.stringify(out["shipped: 4 lots"].ci)}; for the named rule: ${JSON.stringify(out["VXN, 60-close median (named)"].ci)}`);

// ── the shuffle twins: the named rule's factors on random days ──
const named = vxnFactor(60), real = out["VXN, 60-close median (named)"];
const tw = [];
for (let s = 1; s <= SEEDS; s++) {
  const shuf26 = withFactor(base, shuffled(named, days26, s)), shufFwd = withFactor(base, shuffled(named, daysFwd, 1000 + s));
  const a = score(trades2026(shuf26), base.rules);
  const fw = F.score(runStrategy(betaRun, shufFwd.s, base.params, base.exec, { filter: base.filter, studies: base.studies, fromMs: FWD_FROM }).trades, base.rules);
  tw.push({ ...a, fwd: fw });
}
const mean = (f) => Math.round((tw.reduce((s, r) => s + f(r), 0) / tw.length) * 10) / 10;
const atLeast = (f) => tw.filter((r) => f(r) >= f(real)).length;
console.log(`\nThe named rule's shuffle twins (${SEEDS}): the same factors on random days of each period`);
console.log(`  2026: cal ${mean((r) => r.cal)}% (${mean((r) => r.calA)}/${mean((r) => r.calB)}), boot ${mean((r) => r.boot)}%, net ${mean((r) => r.net)}`);
console.log(`        twins at least as good as the rule: cal ${atLeast((r) => r.cal)}/${SEEDS}, worse-half cal ${atLeast((r) => Math.min(r.calA, r.calB))}/${SEEDS}, boot ${atLeast((r) => r.boot)}/${SEEDS}, net ${atLeast((r) => r.net)}/${SEEDS}`);
console.log(`  forward: cal ${mean((r) => r.fwd.cal)}%, boot ${mean((r) => r.fwd.boot)}%, net ${mean((r) => r.fwd.net)}; twins at least as good: cal ${atLeast((r) => r.fwd.cal)}/${SEEDS}, net ${atLeast((r) => r.fwd.net)}/${SEEDS}`);

// how the named rule's factors fell
const f26 = days26.map(named), ffw = daysFwd.map(named), share = (xs, lo, hi) => Math.round((100 * xs.filter((x) => x >= lo && x < hi).length) / xs.length);
console.log(`\nThe named rule's factor by day: 2026 median ${median(f26).toFixed(2)} (under 0.75: ${share(f26, 0, 0.75)}%, 0.75-1.25: ${share(f26, 0.75, 1.25)}%, over: ${share(f26, 1.25, 9)}%); forward median ${median(ffw).toFixed(2)}`);
console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`);
fs.writeFileSync("research/vxn_sizing_1250_results.json", JSON.stringify({ run: new Date().toISOString(), seeds: SEEDS, rows: out, twins: tw }, null, 1));
console.log("wrote research/vxn_sizing_1250_results.json");
