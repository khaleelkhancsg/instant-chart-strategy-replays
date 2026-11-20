// What a first payout costs at each size, 1 to 8 lots, on each eval, paying its monthly fee.
//
// The person's question (2026-11-20): is 5 lots far too much for a $600 / $1,000 daily
// limit in this volatility -- go down to even 1 lot. The $1,250 eval costs $58 and the
// $3,000 eval $96, taken here as monthly fees.
//
// - Bars: 2026, Jan 1 - Oct 30 (data/mnq_1m_beta.bin). In dollars a contract all of 2026
//   is the current regime (New York's median first-two-hour range $410-815 a month), and
//   an attempt at 1 lot needs months, which the last three alone cannot hold.
// - An attempt: started on every day with 120 days of bars after it, it runs until it
//   passes or fails, or 120 days (4 months) pass. Each month started costs the fee.
// - The funded account: started on every one of those days, with the eval's drawdown and
//   daily limit, paid once 5 days have each made $150, followed 120 days.
// - The drawdown is judged on live equity, as the firm watches it, with each trade's worst
//   point counted only up to its exit (src/engine.mjs exitBarExcursion).
// - The two live Donchian bots at each size, each eval's own day rules. No edge two ways,
//   100 coin-flip twins and 50 placebo markets: the bots were tuned on these months, so
//   their real runs here are in-sample and read high.
// - Per size:
//     pass / fail / open at 4 months, and the months of fees an attempt costs;
//     funded paid / blown;
//     a payout per attempt = pass x paid;
//     fees per payout = the fees an attempt costs / payouts per attempt;
//     paid per $1 of fees = pass x the first payout's mean (zeros in) / the fees an attempt
//     costs. Both are ratios of averages over the twins or markets, not averaged ratios.
//
// RESULT (run 2026-11-20, 182 attempts, 100 twins and 50 placebo markets). Fees per first
// payout, twins / placebo markets:
//   - The $1,250 eval is cheapest at 1-4 lots, $420-740 a payout:
//       $1,250 bot  1 lot $738 / $479, 3 lots $440 / $503, 4 lots $443 / $580
//       $3,000 bot  1 lot $497 / $421
//     At 5 lots it rises to $535-774, and at 8 to $1,200-2,000.
//   - The $3,000 eval is cheapest at 2-6 lots, $650-930 a payout:
//       $1,250 bot  6 lots $657 / $903
//       $3,000 bot  3 lots $782 / $785
//     1 lot is its worst size, $1,464-15,087 a payout: 31-58% of attempts are still running
//     after four months of fees.
//   - So the $1,250 eval gets a payout for about 0.6 times the fees. Its payouts are about
//     half the size, so dollars back per dollar of fees come out even, $2-2.6 at the
//     cheapest sizes. That counts the lab's funded rule of the whole profit at the fifth
//     $150 day; a firm's cap or split comes off both alike.
//   - Small size does not raise the pass rate with no edge: the $1,250 bot passes 27% at 1
//     lot on its twins and 31% at 4. It only takes longer, 1.9 months against 1.0.
//
//   node --max-old-space-size=8192 research/eval_size_fees.mjs [--paths N]   (about 3 minutes)

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { replayWindow, simulateFunded, OUTCOME } from "../src/challenge.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { configOf, nullCfg } from "./lib_eval1250.mjs";

const DAY = 86400000, MONTH = 30, HORIZON = 120;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const TWINS = arg("--paths", 100), PLACEBOS = Math.max(1, Math.round(TWINS / 2));
const FB = loadBars("data/mnq_1m_beta.bin").bars, LAST = FB.ts[FB.count - 1];
const Y26 = Date.UTC(2026, 0, 1), iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const BOOKS = [["donchian_1250", "the $1,250 bot"], ["donchian_shipped", "the $3,000 bot"]];
const EVALS = [["1250", "$1,250", 58], ["3000", "$3,000", 96]];
const SIZES = [1, 2, 3, 4, 5, 6, 8];

const cache = new Map();
function memo(s) {
  return { ...s, compute(b, p) {
    const n = b.close.length, k = `${s.id}|${b.ts[0]}|${n}|${b.close[0]}|${b.close[n >> 1]}|${b.close[n - 1]}|${JSON.stringify(p)}`;
    if (!cache.has(k)) { if (cache.size > 6) cache.delete(cache.keys().next().value); cache.set(k, s.compute(b, p)); }
    return cache.get(k);
  } };
}
const CFG = {};
for (const [id] of BOOKS) for (const [ev] of EVALS) { const c = await configOf(id, {}, ev); CFG[`${id}|${ev}`] = { ...c, s: memo(c.s) }; }

const BARS = sliceBars(FB, indexAtOrAfter(FB.ts, Y26 - 60 * DAY), FB.count);
const STARTS = [];
for (let s = FB.ts[0] + Math.ceil((Y26 - FB.ts[0]) / DAY) * DAY; s + HORIZON * DAY <= LAST; s += DAY) STARTS.push(s);

function read(trades, rules, fee) {
  const R = { ...rules, evaluateOn: "intraday", windowDays: HORIZON }, FR = { ...R, dailyProfitStop: 0 };
  let pass = 0, fail = 0, months = 0, paid = 0, blown = 0, pay = 0;
  for (const s of STARTS) {
    const w = replayWindow(trades, s, R);
    const end = w.outcome === OUTCOME.PASS ? w.passMs : w.outcome === OUTCOME.FAIL ? w.failMs : s + HORIZON * DAY;
    months += Math.max(1, Math.ceil((end - s) / (MONTH * DAY)));
    if (w.outcome === OUTCOME.PASS) pass++; else if (w.outcome === OUTCOME.FAIL) fail++;
    const f = simulateFunded(trades, s, FR, { horizonDays: HORIZON });
    if (f.payouts.length) { paid++; pay += f.payouts[0].gross; } else if (!f.survived) blown++;
  }
  // Fees and payouts per attempt; their ratios are taken only after averaging over runs.
  const n = STARTS.length, P = pass / n, Q = paid / n;
  return { pass: 100 * P, fail: 100 * fail / n, open: 100 * (n - pass - fail) / n, months: months / n, paid: 100 * Q, blown: 100 * blown / n,
           attempt: 100 * P * Q, cost: (fee * months) / n, usd: P * (pay / n), firstPay: paid ? pay / paid : null };
}
const run = (cfg, bars, ex) => runStrategy(bars, cfg.s, cfg.params, { ...cfg.exec, ...ex }, { filter: cfg.filter, studies: cfg.studies, fromMs: Y26 }).trades;
function sweep(bars, seed) {
  const out = {};
  for (const [id] of BOOKS) for (const [ev, , fee] of EVALS) {
    const base = CFG[`${id}|${ev}`], cfg = seed ? nullCfg(base, seed) : base;
    for (const k of SIZES) out[`${id}|${ev}|${k}`] = read(run(cfg, bars, { contracts: k }), base.rules, fee);
  }
  return out;
}
const ratios = (c) => ({ ...c, feesPerPayout: c.attempt > 0 ? c.cost / (c.attempt / 100) : null, perFee: c.usd / c.cost });
const avg = (rows, key) => ratios(Object.fromEntries(Object.keys(rows[0][key]).map((f) => {
  const v = rows.map((r) => r[key][f]).filter((x) => x != null && Number.isFinite(x));
  return [f, v.length ? v.reduce((a, x) => a + x, 0) / v.length : null];
})));

const t0 = Date.now();
console.log(`2026 attempts: ${STARTS.length}, started ${iso(STARTS[0])} to ${iso(STARTS[STARTS.length - 1])}, each followed ${HORIZON} days; bars to ${iso(LAST)};` +
            ` ${TWINS} twins, ${PLACEBOS} placebo markets; fees $58 / $96 a month; live equity\n`);
const real = sweep(BARS, 0), tw = [], pl = [];
for (let k = 1; k <= TWINS; k++) tw.push(sweep(BARS, k));
for (let k = 1; k <= PLACEBOS; k++) pl.push(sweep(placeboBars(BARS, k), 0));
const OUT = { run: new Date().toISOString(), starts: [iso(STARTS[0]), iso(STARTS[STARTS.length - 1])], horizonDays: HORIZON, twins: TWINS, placebos: PLACEBOS, cells: {} };

const f1 = (x) => (x == null ? "   -" : (Math.round(x * 10) / 10).toFixed(1));
const usd = (x) => (x == null ? "      -" : `$${Math.round(x).toLocaleString("en-US")}`);
for (const [id, name] of BOOKS) for (const [ev, evName, fee] of EVALS) {
  console.log(`${name} on the ${evName} eval ($${fee} a month)`);
  console.log("  lots |      no edge (twins / placebo markets)                                                        | real (in-sample)");
  for (const k of SIZES) {
    const key = `${id}|${ev}|${k}`, t = avg(tw, key), p = avg(pl, key), r = ratios(real[key]);
    OUT.cells[key] = { real: r, twin: t, placebo: p };
    console.log(`  ${String(k).padStart(4)} | pass ${f1(t.pass)} / ${f1(p.pass)}% (open ${f1(t.open)}), ${f1(t.months)} months` +
                ` | paid ${f1(t.paid)} / ${f1(p.paid)}% | payout per attempt ${f1(t.attempt)} / ${f1(p.attempt)}%` +
                ` | fees per payout ${usd(t.feesPerPayout)} / ${usd(p.feesPerPayout)}, $${f1(t.perFee)} / $${f1(p.perFee)} per $1` +
                ` | ${f1(r.attempt)}%, ${usd(r.feesPerPayout)}`);
  }
}
fs.writeFileSync("research/eval_size_fees_results.json", JSON.stringify(OUT));
console.log(`\n(${Math.round((Date.now() - t0) / 1000)} s; research/eval_size_fees_results.json)`);
