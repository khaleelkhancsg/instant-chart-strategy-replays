// Which evaluation gets to a payout more often in the current regime:
//   $1,250 target, $1,000 trailing drawdown, $600 daily limit, or
//   $3,000 target, $2,000 trailing drawdown, $1,000 daily limit?
//
// The person's question (2026-11-20): one MNQ now ranges several hundred dollars in New
// York's first hours, so judge the two on the latest bars, not on long history.
//
// - The regime: data/mnq_1m_beta.bin from Aug 1 2026 to its end (Oct 30). New York's
//   first two hours ranged a median $512 / $435 / $564 a contract in Aug / Sep / Oct
//   (Jan-Jul 2026: $411-815; 2025 mostly $260-520). TopstepX's November bars could not
//   be pulled on Nov 20: the API key was refused.
// - The books: the two live Donchian bots, each under both evals with the settings the
//   research chose for that eval (donchian_1250: 4 lots on $1,250, 7 on $3,000;
//   donchian_shipped: 4 and 8), then at other sizes.
// - Real: a combine started on every day from Aug 1 with 30 days of bars after it.
// - No edge, two ways, because no book here has shown one forward:
//     each book's coin-flip twin on the real weeks (its own times and size, random sides),
//     and the book on placebo markets made from these same weeks (every 1-minute bar's
//     direction flipped at random). Placebo markets swing within 5% of the real ones over
//     10 to 120 minutes here, so they carry this regime's volatility.
// - Live equity: the drawdown is judged on each trade's worst point (evaluateOn
//   'intraday'), as the firm watches it; closed trades alone are shown for reference.
//   At 7 or 8 lots a 5-ATR stop is a $1,000-1,400 swing now, and dips that recover
//   still fail the account.
// - Payout: a funded account started on every one of those days, with the eval's
//   trailing drawdown and daily limit, paid once 5 days have each made $150 (the lab's
//   FUNDED model, src/challenge.mjs), followed 30 days. "Per attempt" is the pass rate
//   times that payout rate; "$ per attempt" the pass rate times the first payout's mean,
//   zeros included (the whole profit at that point; a firm's cap or split comes off it).
//
// RESULT (run 2026-11-20, 100 twin seeds and 100 placebo markets, live equity):
//   - With no edge, the two evals give about the same chance of a first payout per attempt,
//     each at its best size. Chances below are $1,250 eval / $3,000 eval:
//       the $1,250 bot  24.4% / 22.8% on its twins, 12.4% / 10.0% on placebo markets
//       the $3,000 bot  17.1% / 15.9% on its twins, 13.0% / 12.0% on placebo markets
//     Coin-flip trades of any size with no strategy (research/eval_choice_geometry.mjs)
//     agree: 10.6% / 7.9% at best.
//   - The $3,000 eval pays about 1.6-2.1 times as much per attempt. Its first payout is
//     $1,700-2,400, against $900-1,300 on the $1,250 eval. Dollars per attempt, each at
//     its best size, $1,250 eval / $3,000 eval:
//       the $1,250 bot  $244 / $426 on its twins, $144 / $232 on placebo markets
//       the $3,000 bot  $172 / $369 on its twins, $141 / $260 on placebo markets
//       geometry        $114 / $173
//   - The regime moves the best size, not the ranking.
//       - The $3,000 bot's 8 lots is too big on the $3,000 eval. One trade in ten dips
//         $1,200 or more before it closes, and a typical loser closes at the $1,000 daily
//         limit. Its best is 4-6 lots: twin 15.9% at 4 against 9.3% at 8.
//       - On the $1,250 eval the $1,250 bot's 4 lots (3-5) is right. The $3,000 bot's best
//         there is 2-3.
//       - These dips are no bigger than January-July 2026's. In dollars a contract, the
//         whole of 2026 is this regime; 2025 was calmer.
//   - Live equity matters. Judged on closed trades, the $1,250 bot at 7 lots on the $3,000
//     eval left 41.7% of its windows unresolved; on live equity those fail (53.3% fail).
//     simulateFunded now takes rules.evaluateOn, as replayWindow does.
//   - Real bars, Aug-Oct, per attempt:
//       $1,250 eval  21.8% (twin 22.0%; 38 of 100 twins as high)
//       $3,000 eval  31.9% (twin 22.7%; 30 of 100 twins as high)
//     About two independent windows: chance either way.
//   - Earlier in 2026 the no-edge ranking holds. Per attempt, $1,250 eval / $3,000 eval:
//       the $1,250 bot's twins  Jan-Mar 16.3% / 16.1%, Apr-Jul 11.1% / 11.7%
//       the $3,000 bot's twins  Jan-Mar 11.4% / 8.0%,  Apr-Jul 11.1% / 5.5% (at 8 lots)
//
//   node --max-old-space-size=8192 research/eval_choice_regime.mjs [--paths N]   (about 4 minutes)

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { simulateFunded } from "../src/challenge.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { configOf, nullCfg, lab as L } from "./lib_eval1250.mjs";

const DAY = 86400000;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const PATHS = arg("--paths", 100);
const FB = loadBars("data/mnq_1m_beta.bin").bars, LAST = FB.ts[FB.count - 1];
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

const BOOKS = [["donchian_1250", "the $1,250 bot"], ["donchian_shipped", "the $3,000 bot"]];
const EVALS = [["1250", "$1,250"], ["3000", "$3,000"]];
const SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12];
const MODES = [["live", "intraday"], ["closed", "realized"]];

// One compute per book and bars: every eval and size re-runs the engine, not the signal.
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

// A period: its bars with 60 days of warm-up, and a start on every day of it (on the grid
// of the file's first bar) that has 30 days of bars after it.
function period(from, to) {
  const bars = sliceBars(FB, indexAtOrAfter(FB.ts, from - 60 * DAY), FB.count);
  const starts = [];
  for (let s = FB.ts[0] + Math.ceil((from - FB.ts[0]) / DAY) * DAY; s <= to && s + 30 * DAY <= LAST; s += DAY) starts.push(s);
  return { from, to, bars, starts };
}

const pct = (x, n) => (n ? (100 * x) / n : 0);
const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
// One run's trades, read both ways: the eval's windows and a funded account from each start.
function read(trades, rules, P) {
  const n = P.starts.length, end = P.starts[n - 1] + 30 * DAY, inP = trades.filter((t) => t.entryTime >= P.from && t.entryTime < end);
  const out = { trades: inP.length, net: inP.reduce((a, t) => a + t.pnl, 0), lots: inP.length ? inP.reduce((a, t) => a + t.contracts, 0) / inP.length : 0 };
  for (const [mode, evaluateOn] of MODES) {
    const R = { ...rules, evaluateOn }, c = L.calendar(trades, R, P.starts), FR = { ...R, dailyProfitStop: 0 };
    let paid = 0, blown = 0, sumPay = 0; const amt = [], dpay = [];
    for (const s of P.starts) {
      const f = simulateFunded(trades, s, FR, { horizonDays: 30 });
      if (f.payouts.length) { paid++; amt.push(f.payouts[0].gross); dpay.push(f.daysToFirstPayout); sumPay += f.payouts[0].gross; }
      else if (!f.survived) blown++;
    }
    out[mode] = { pass: c.pass, fail: c.fail, open: c.open, days: c.medianDaysToPass, paid: pct(paid, n), blown: pct(blown, n),
                  amt: med(amt), dpay: med(dpay), meanPay: sumPay / n, attempt: (c.pass * pct(paid, n)) / 100, usd: (c.pass / 100) * (sumPay / n) };
  }
  return out;
}
const run = (cfg, bars, from, ex = {}) =>
  runStrategy(bars, cfg.s, cfg.params, { ...cfg.exec, ...ex }, { filter: cfg.filter, studies: cfg.studies, fromMs: from }).trades;

// Every book x eval x size on one set of bars: real, a placebo market, or a twin seed.
function sweep(P, bars, twinSeed, sizes) {
  const out = {};
  for (const [id] of BOOKS) for (const [ev] of EVALS) {
    const base = CFG[`${id}|${ev}`], cfg = twinSeed ? nullCfg(base, twinSeed) : base;
    for (const k of sizes) out[`${id}|${ev}|${k}`] = read(run(cfg, bars, P.from, k === "own" ? {} : { contracts: k }), base.rules, P);
  }
  return out;
}
const mean = (v) => { const x = v.filter((y) => y != null && Number.isFinite(y)); return x.length ? x.reduce((a, y) => a + y, 0) / x.length : null; };
function averaged(rows, key) {
  const one = (sel) => Object.fromEntries(Object.keys(sel(rows[0][key])).map((f) => [f, mean(rows.map((r) => sel(r[key])[f]))]));
  return { trades: mean(rows.map((r) => r[key].trades)), net: mean(rows.map((r) => r[key].net)), lots: mean(rows.map((r) => r[key].lots)),
           live: one((x) => x.live), closed: one((x) => x.closed) };
}
function summarise(P, sizes) {
  const real = sweep(P, P.bars, 0, sizes), pl = [], tw = [];
  for (let k = 1; k <= PATHS; k++) { pl.push(sweep(P, placeboBars(P.bars, k), 0, sizes)); tw.push(sweep(P, P.bars, k, sizes)); }
  const out = {};
  for (const key of Object.keys(real)) {
    out[key] = { real: real[key], twin: averaged(tw, key), placebo: averaged(pl, key),
                 // how many no-edge runs reach the real run's per-attempt payout rate, live equity
                 twinAsOften: tw.filter((r) => r[key].live.attempt >= real[key].live.attempt).length,
                 placeboAsOften: pl.filter((r) => r[key].live.attempt >= real[key].live.attempt).length };
  }
  return out;
}

const f0 = (x) => (x == null ? "  -" : Math.round(x).toString());
const f1 = (x) => (x == null ? "  -" : (Math.round(x * 10) / 10).toFixed(1));
const usd = (x) => (x == null ? "-" : `${x < 0 ? "-" : ""}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`);
const line = (r, m = "live") => { const x = r[m];
  return `pass ${f1(x.pass).padStart(5)}% fail ${f1(x.fail).padStart(5)}% open ${f1(x.open).padStart(5)}% (${f0(x.days).padStart(2)} d)` +
    ` | funded: paid ${f1(x.paid).padStart(5)}% blown ${f1(x.blown).padStart(5)}%, 1st ${usd(x.amt).padStart(6)}` +
    ` | per attempt ${f1(x.attempt).padStart(5)}%, ${usd(x.usd).padStart(6)}`; };
const tail = (r) => ` | ${f0(r.trades).padStart(3)} tr, ${f1(r.lots)} lots, net ${usd(r.net)}`;

const RESULTS = { run: new Date().toISOString(), bars: `data/mnq_1m_beta.bin to ${iso(LAST)}`, paths: PATHS, sections: {} };
const t0 = Date.now();

// ── 1. the current regime, at each eval's own settings ──
const NOW = period(Date.UTC(2026, 7, 1), Infinity);
console.log(`Current regime: windows started ${iso(NOW.starts[0])} to ${iso(NOW.starts[NOW.starts.length - 1])} (${NOW.starts.length}), bars to ${iso(LAST)};` +
            ` ${PATHS} coin-flip twin seeds and ${PATHS} placebo markets. Costs: $0.75 a side a contract and a tick of slippage.\n`);
const own = summarise(NOW, ["own"]);
RESULTS.sections.current = own;
console.log("1. Each bot under each eval at the size its research chose for that eval. Drawdown on live equity (closed trades below)");
for (const [id, name] of BOOKS) for (const [ev, evName] of EVALS) {
  const r = own[`${id}|${ev}|own`];
  console.log(`   ${name}, ${evName} eval`);
  console.log(`     real      ${line(r.real)}${tail(r.real)}`);
  console.log(`     twin      ${line(r.twin)}${tail(r.twin)}   (${r.twinAsOften}/${PATHS} reach real's per-attempt rate)`);
  console.log(`     placebo   ${line(r.placebo)}${tail(r.placebo)}   (${r.placeboAsOften}/${PATHS})`);
  console.log(`     closed trades only: real ${line(r.real, "closed")}`);
  console.log(`                         twin ${line(r.twin, "closed")}`);
}
console.log(`   (${Math.round((Date.now() - t0) / 1000)} s)`);

// ── 2. size ──
const sz = summarise(NOW, SIZES);
RESULTS.sections.sizes = sz;
console.log("\n2. Size: lots on every trade (late trades half), each eval's own day rules, live equity");
console.log("   pass% real / twin / placebo, then per-attempt payout% real / twin / placebo, and the placebo's share out of time");
for (const [id, name] of BOOKS) {
  console.log(`   ${name}`);
  for (const k of SIZES) {
    const cell = (ev) => { const r = sz[`${id}|${ev}|${k}`];
      return `${f1(r.real.live.pass).padStart(5)} ${f1(r.twin.live.pass).padStart(5)} ${f1(r.placebo.live.pass).padStart(5)}` +
             ` / ${f1(r.real.live.attempt).padStart(5)} ${f1(r.twin.live.attempt).padStart(5)} ${f1(r.placebo.live.attempt).padStart(5)}` +
             `  open ${f1(r.placebo.live.open).padStart(5)}`; };
    console.log(`     ${String(k).padStart(2)} lots  $1,250: ${cell("1250")}   |  $3,000: ${cell("3000")}`);
  }
}
console.log(`   (${Math.round((Date.now() - t0) / 1000)} s)`);

// ── 3. earlier in 2026, to see whether the regime changes the answer ──
console.log("\n3. The same settings earlier in 2026 (live equity): pass% and per-attempt payout%");
RESULTS.sections.earlier = {};
for (const [label, a, b] of [["Jan-Mar 2026", Date.UTC(2026, 0, 1), Date.UTC(2026, 2, 31)], ["Apr-Jul 2026", Date.UTC(2026, 3, 1), Date.UTC(2026, 6, 31)]]) {
  const P = period(a, b), s = summarise(P, ["own"]);
  RESULTS.sections.earlier[label] = s;
  console.log(`   ${label} (${P.starts.length} windows)`);
  for (const [id, name] of BOOKS) for (const [ev, evName] of EVALS) {
    const r = s[`${id}|${ev}|own`], c = (x) => `${f1(x.live.pass)}%, ${f1(x.live.attempt)}%`;
    console.log(`     ${name}, ${evName}:`.padEnd(32) + `real ${c(r.real)} | twin ${c(r.twin)} | placebo ${c(r.placebo)}`);
  }
}
fs.writeFileSync("research/eval_choice_regime_results.json", JSON.stringify(RESULTS));
console.log(`\n(${Math.round((Date.now() - t0) / 1000)} s; every figure in research/eval_choice_regime_results.json)`);
