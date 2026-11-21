// Longer evals, smaller size: pass rates at 1-4 lots when an eval runs 45 trading days.
//
//   node --max-old-space-size=8192 research/eval_45_days.mjs
//
// The person's question (2026-11-21): give each eval 45 trading days, so a smaller size has time
// to reach the target. The lab's evals run 30 calendar days, about 21 trading days. Here each
// eval runs that, or 30 or 45 trading days (45 is about 63 calendar days). It trades at 1 to 4
// lots on the $1,250 rules: $1,250 target, $1,000 trailing drawdown, the $600 day line, 50%
// consistency.
//
// The book: donchian_1250 as shipped but for its size (the late size stays half of it, rounded),
// run once over data/mnq_1m_beta.bin. 2026 is Jan 1 - Oct 30, with evals started:
//   - on every day whose window ends by Oct 30 (the calendar method). Judged on closed trades and
//     on live equity (each trade's worst point, as the firm watches it). Split by when they start:
//     Jan-Mar, Apr - Jul 14, from Jul 15;
//   - back to back: one account from each of 2026's first 30 days, on live equity;
//   - the bootstrap: 12,000 draws of N trading days from 2026's day P&L, in 5-day blocks.
// For each: pass / fail / out of days, the median days to a pass, and the fees a pass costs at
// $58 for every month an eval runs (research/eval_size_fees.mjs's model).
//
// Named before the first run: on live equity, calendar, 2026, does any size under 4 lots at 45
// trading days pass more often than the shipped 4 lots at the lab's 30 calendar days?
//
// RESULT (run 2026-11-21; 2026 = Jan 1 - Oct 30): no. A longer eval does not let a smaller size
// pass more. At 2-4 lots the extra days turn running out of time into failures. Only 1 lot gains,
// and it stays below 4 lots. Every-day evals: 272 at 30 calendar days, 259 at 30 trading days, 238
// at 45 trading days.
//   - Live equity, every day (pass / fail / out), 30 calendar days -> 45 trading days:
//       - 4 lots: 57.7 / 41.9 / 0.4 -> 55.0 / 45.0 / 0
//       - 3 lots: 59.6 / 38.2 / 2.2 -> 59.2 / 40.8 / 0
//       - 2 lots: 47.4 / 43.4 / 9.2 -> 45.8 / 54.2 / 0
//       - 1 lot: 11.4 / 15.1 / 73.5 -> 40.3 / 45.8 / 13.9
//     The named test: 3 lots at 45 days (59.2%) against 4 lots at 30 (57.7%) is level. 2026
//     holds about seven independent 30-day windows and four of 45 days.
//   - Closed trades agree: 4 lots 63.2 -> 63.0, 2 lots 48.9 -> 56.3, 1 lot 11.4 -> 40.3.
//   - Back to back, live: 4 lots 52.0 -> 46.6, 3 lots 54.7 -> 49.9, 2 lots 50.4 -> 44.6, 1 lot
//     2.4 -> 41.6.
//   - The bootstrap (shuffled 5-day blocks of closed days) reads long windows kinder: 2 lots 41.2
//     -> 64.1. Shuffling breaks up the bad stretches that sink a slow account in the real order.
//   - Time and fees:
//       - a pass takes a median 13 days at 4 lots, 15 at 3, 19-20 at 2, 25-40 at 1;
//       - at $58 a month, every day: $100 a pass at 4 lots and 30 days, $106 at 45. 2 lots cost
//         $122-137 a pass, 1 lot $272-509.
//   - 2026 (Jan - Oct) net and days at the $600 line: 4 lots +$12,517, 27 days; 3 lots +$7,419,
//     22; 2 lots +$7,161, 9; 1 lot +$3,403, none.
//   - The cut-only dollar rule (added after the first run; 3.3 lots a trade, +$12,625, 24 days at
//     the line):
//       - live, every day: 65.1% at 30 calendar days, 63.4% at 45 trading days;
//       - back to back: 60.4%;
//       - by start: 75.6 / 64.8 / 53.2, against 4 lots' 75.6 / 52.4 / 44.2.
//     Its T comes from Jan - Jul 14 and its shape from the stress test, so only Jul 15 on is out
//     of sample.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";
import { dayVector, bootstrapPass } from "../src/dayeval.mjs";
import { configOf } from "./lib_eval1250.mjs";
import { sessionsOf, rawOffsets } from "../src/levels.mjs";

const DAY = 86400000, Y26 = Date.UTC(2026, 0, 1), APR = Date.UTC(2026, 3, 1), FWD = Date.UTC(2026, 6, 15), FEE = 58, CHAINS = 30;
const t0 = Date.now();
const { bars } = loadBars("data/mnq_1m_beta.bin");
const LAST = bars.ts[bars.count - 1], G0 = bars.ts[0];
const gridCeil = (t) => G0 + Math.ceil((t - G0) / DAY) * DAY;

// Sessions in order, each with the time of its first bar. A window of n trading days from s ends
// when the (n+1)th session from s opens, or at the end of the data.
const sess = [];
for (let i = 0; i < bars.count; i++) if (i === 0 || bars.tday[i] !== bars.tday[i - 1]) sess.push({ td: bars.tday[i], ms: bars.ts[i] });
function firstAtOrAfter(ms) { let lo = 0, hi = sess.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sess[m].ms < ms) lo = m + 1; else hi = m; } return lo; }
const LENGTHS = [
  ["30 calendar days (the lab's)", (s) => (s + 30 * DAY <= LAST ? 30 : null), 21],
  ["30 trading days", (s) => { const k = firstAtOrAfter(s) + 30; return k < sess.length ? (sess[k].ms - s) / DAY : null; }, 30],
  ["45 trading days", (s) => { const k = firstAtOrAfter(s) + 45; return k < sess.length ? (sess[k].ms - s) / DAY : null; }, 45],
];
const days26 = sess.filter((x) => x.ms >= Y26).map((x) => x.td);

const pct = (a, n) => (n ? Math.round((1000 * a) / n) / 10 : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const months = (s, end) => Math.max(1, Math.ceil((end - s) / DAY / 30));   // each month an eval runs costs the fee

function one(trades, s, R, span) {
  const r = replayWindow(trades, s, { ...R, windowDays: span }), end = r.passMs ?? r.failMs ?? s + span * DAY;
  return { outcome: r.outcome, end, decided: r.passMs ?? r.failMs, fee: FEE * months(s, end) };
}
const tally = () => ({ pass: 0, fail: 0, out: 0, n: 0, fees: 0, passDays: [] });
function add(c, e, s) {
  c.n++; c.fees += e.fee;
  if (e.outcome === OUTCOME.PASS) { c.pass++; c.passDays.push((e.end - s) / DAY); } else if (e.outcome === OUTCOME.FAIL) c.fail++; else c.out++;
}
const shape = (c) => ({ pass: pct(c.pass, c.n), fail: pct(c.fail, c.n), out: pct(c.out, c.n), n: c.n, daysToPass: c.passDays.length ? Math.round(median(c.passDays)) : null,
                        feesPerPass: c.pass ? Math.round(c.fees / c.pass) : null });

function measure(trades, R, spanOf, bootWindow) {
  const live = { ...R, evaluateOn: "intraday" }, cal = { closed: tally(), live: tally(), janMar: tally(), aprJul: tally(), fwd: tally() };
  for (let s = gridCeil(Y26); ; s += DAY) {
    const span = spanOf(s);
    if (span == null) break;
    add(cal.closed, one(trades, s, R, span), s);
    const e = one(trades, s, live, span);
    add(cal.live, e, s);
    add(s < APR ? cal.janMar : s < FWD ? cal.aprJul : cal.fwd, e, s);
  }
  // back to back, live equity: one account from each of 2026's first 30 days
  const b2b = tally(), perAccount = [];
  for (let k = 0, s0 = gridCeil(Y26); k < CHAINS; k++, s0 += DAY) {
    let passes = 0, evals = 0;
    for (let s = s0; ; ) {
      const span = spanOf(s);
      if (span == null) break;
      const e = one(trades, s, live, span);
      add(b2b, e, s); evals++; if (e.outcome === OUTCOME.PASS) passes++;
      s = gridCeil(e.decided != null ? e.decided + 1 : s + span * DAY);
    }
    perAccount.push({ evals, passes });
  }
  const rules = { target: R.profitTarget, dd: R.trailingDD, consistency: R.consistencyGatesPass ? R.consistencyPct / 100 : 0 };
  const boot = Math.round(bootstrapPass(dayVector(trades, days26), { window: bootWindow, ...rules }) * 10) / 10;
  return { closed: shape(cal.closed), live: shape(cal.live), byStart: { janMar: shape(cal.janMar), aprJul: shape(cal.aprJul), fwd: shape(cal.fwd) },
           backToBack: { ...shape(b2b), evalsPerAccount: median(perAccount.map((a) => a.evals)), passesPerAccount: median(perAccount.map((a) => a.passes)) }, boot };
}

// The cut-only dollar rule (research/vxn_sizing_1250.mjs, stress_2022_today.mjs): lots x T / (VXN x
// the real prior close), held to 0.5-1, T fixed from 2026. Added after the first run, as the way to
// trade fewer lots that keeps 4 on ordinary days.
const vxn = fs.readFileSync("data/raw/fred/VXNCLS.csv", "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","))
  .filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && v && v.trim() !== "." && Number.isFinite(+v))
  .map(([d, v]) => ({ ms: Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)), v: +v }));
const vxnBefore = (ms) => { let lo = 0, hi = vxn.length - 1, at = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (vxn[m].ms < ms) { at = m; lo = m + 1; } else hi = m - 1; } return at; };
const T = JSON.parse(fs.readFileSync("research/vxn_sizing_1250_results.json", "utf8")).dollar.T;
const PX = (() => { const ss = sessionsOf(bars), off = rawOffsets(bars), m = new Map(); let last = NaN; for (const x of ss) { if (Number.isFinite(last)) m.set(x.td, last); if (x.rthA >= 0) last = x.close - off[x.rthZ - 1]; } return m; })();
const cutOnly = (td) => { const k = vxnBefore(td * DAY), p = PX.get(td); return k >= 0 && p > 0 ? Math.min(1, Math.max(0.5, T / (vxn[k].v * p))) : 1; };
let uid = 0;
const withFactor = (cfg, f) => ({ ...cfg, s: { ...cfg.s, id: `${cfg.s.id}~len${++uid}`, compute(b, p) {
  const o = cfg.s.compute(b, p), n = b.close.length, m = o.sizeMult, out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[k] = (m ? m[k] : 1) * f(b.tday[k]);
  return { ...o, sizeMult: out };
} } });
const SIZES = [4, 3, 2, 1, "cut"];
const out = {}, lotsOf = {};
for (const c of SIZES) {
  const cfg = c === "cut" ? withFactor(await configOf("donchian_1250"), cutOnly) : await configOf("donchian_1250", { exec: { contracts: c } });
  const trades = runStrategy(bars, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies: cfg.studies }).trades;
  const t26 = trades.filter((t) => t.entryTime >= Y26);
  lotsOf[c] = { lots: Math.round((t26.reduce((s, t) => s + t.contracts, 0) / t26.length) * 100) / 100, trades: t26.length, net: Math.round(t26.reduce((s, t) => s + t.pnl, 0)),
                limitDays: dayVector(trades, days26).filter((v) => v <= -590).length };
  out[c] = {};
  for (const [label, spanOf, bw] of LENGTHS) out[c][label] = measure(trades, cfg.rules, spanOf, bw);
}

// ── print ──
const pad = (s, n) => String(s ?? "—").padStart(n);
const pfo = (r) => `${r.pass} / ${r.fail} / ${r.out}`;
console.log(`2026 = Jan 1 - ${new Date(LAST).toISOString().slice(0, 10)} on data/mnq_1m_beta.bin. Per size, 2026: ${SIZES.map((c) => `${c === "cut" ? "cut-only" : c + " lots"} ${lotsOf[c].lots} a trade, ${lotsOf[c].trades} trades, $${lotsOf[c].net}, ${lotsOf[c].limitDays} days at the $600 line`).join("; ")}\n`);
for (const [label] of LENGTHS) {
  const n = out[4][label].live.n;
  console.log(`== ${label}: ${n} evals started on every day of 2026 that has room for one ==`);
  console.log(`${"".padEnd(8)}${pad("closed: pass/fail/out", 24)}${pad("live: pass/fail/out", 22)}${pad("live by start: Jan-Mar / Apr-Jul / Jul15+", 43)}${pad("days to pass", 14)}${pad("$ a pass", 10)}${pad("boot", 7)}${pad("back to back, live", 21)}${pad("acct: evals, passes", 21)}${pad("$ a pass", 10)}`);
  for (const c of SIZES) {
    const r = out[c][label], b = r.byStart;
    console.log(`${(c === "cut" ? "cut-only" : c + " lots").padEnd(8)}${pad(pfo(r.closed), 24)}${pad(pfo(r.live), 22)}${pad(`${b.janMar.pass} / ${b.aprJul.pass} / ${b.fwd.pass}`, 43)}${pad(r.live.daysToPass, 14)}${pad(r.live.feesPerPass, 10)}${pad(r.boot, 7)}` +
      `${pad(pfo(r.backToBack), 21)}${pad(`${r.backToBack.evalsPerAccount}, ${r.backToBack.passesPerAccount}`, 21)}${pad(r.backToBack.feesPerPass, 10)}`);
  }
  console.log(`  (starts by part: Jan-Mar ${out[4][label].byStart.janMar.n}, Apr-Jul 14 ${out[4][label].byStart.aprJul.n}, from Jul 15 ${out[4][label].byStart.fwd.n})\n`);
}
console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`);
fs.writeFileSync("research/eval_45_days_results.json", JSON.stringify({ run: new Date().toISOString(), fee: FEE, sizes: lotsOf, results: out }, null, 1));
console.log("wrote research/eval_45_days_results.json");
