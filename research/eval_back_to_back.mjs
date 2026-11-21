// Pass and fail rates when each eval starts only after the last one ends, against one started
// on every day.
//
//   node --max-old-space-size=8192 research/eval_back_to_back.mjs
//
// The lab's calendar rate starts a 30-day eval on every day and counts the share that pass. A
// trader with one account runs them back to back: an eval ends when it passes, fails or reaches
// 30 days, and the next starts at the next session. Back to back, a failure ends early and the
// next eval starts straight after it, often inside the same bad stretch, while a pass can take
// weeks. So the share of evals that pass need not be the every-day rate.
//
// The book: donchian_1250 as shipped (4 lots, 2 late) on the $1,250 rules, run once over
// data/mnq_1m_beta.bin. Judged on closed trades and on live equity (each trade's worst point, as
// the firm watches it).
// Periods:
//   - 2026, Jan 1 - Oct 30: the year so far, as a trader would have run it;
//   - its parts, Jan 1 - Jul 14 (the lab's 2026) and Jul 15 - Oct 30 (forward);
//   - each year 2019-2025 at its own price, for context only (the house judges on 2026).
// Every day: an eval started on every day whose 30 days fit in the period.
// Back to back: a chain of evals from each of the period's first 30 days, each run to the end of
// the period. An eval whose 30 days do not fit is not started. Pooled over the 30 chains: the
// share of evals that pass, fail and run out of days; per chain, the evals and passes, and the
// days and evals to the first pass.
//
// RESULT (run 2026-11-21; 2,523 trades; 30 accounts a period): on live equity, the way the firm
// judges, back to back passes fewer evals in 2026 than the every-day rate says. On closed trades
// it matches or passes more.
//   - 2026, Jan 1 - Oct 30, each line pass / fail / out of days:
//       - live: every day 57.7 / 41.9 / 0.4 (272 starts); back to back 52.0 / 47.8 / 0.2 (573
//         evals; every account 47-53%);
//       - closed: every day 63.2 / 34.9 / 1.8; back to back 67.8 / 31.1 / 1.0 (accounts 63-69%).
//   - Jan 1 - Jul 14: live 70.3 against 58.7 (accounts 50-60%); closed 74.5 against 76.1.
//   - Jul 15 - Oct 30: live 44.2 against 45.4; closed 44.2 against 55.6.
//   - Why: back to back, each outcome counts as often as it fits in the time it takes.
//       - On live equity in 2026 a failure takes a median 13 days against 16 for a pass, and
//         failures come in runs. The account from Jan 1 failed three in a row Mar 18 - Apr 21 and
//         three Jul 29 - Sep 1.
//       - On closed trades both take 16 days.
//       - Running out of days takes all 30, so it shrinks back to back: 2020 on closed trades,
//         21.4% of every-day starts against 11.4% of evals.
//   - One account through 2026 (the median of 30 start days):
//       - live: 19 evals and 10 passes, the first on the first eval after 22 days;
//       - closed: 16 and 11.
//       - At $58 an eval: about $112 a pass back to back, $101 at the every-day rate.
//   - Years 2019-2025 at their own prices (context): back to back less every day runs from -4.3 to
//     +7.1 points on closed trades and -2.0 to +6.7 on live equity (2019 passes nothing either
//     way). 2026's -5.7 on live equity, -11.6 in Jan - Jul, is the widest gap in the data.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";
import { configOf } from "./lib_eval1250.mjs";

const DAY = 86400000, WINDOW = 30, CHAINS = 30, FEE = 58;   // the $1,250 eval's monthly fee (research/eval_size_fees.mjs)
const t0 = Date.now();
const { bars } = loadBars("data/mnq_1m_beta.bin");
const cfg = await configOf("donchian_1250");
const trades = runStrategy(bars, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies: cfg.studies }).trades;
const LAST = bars.ts[bars.count - 1], G0 = bars.ts[0];
const gridCeil = (t) => G0 + Math.ceil((t - G0) / DAY) * DAY;   // the first start on the lab's grid at or after t

const PERIODS = [
  ["2026, Jan 1 - Oct 30", Date.UTC(2026, 0, 1), LAST],
  ["  Jan 1 - Jul 14", Date.UTC(2026, 0, 1), Date.UTC(2026, 6, 15)],
  ["  Jul 15 - Oct 30", Date.UTC(2026, 6, 15), LAST],
  ...[2019, 2020, 2021, 2022, 2023, 2024, 2025].map((y) => [String(y), Math.max(Date.UTC(y, 0, 1), G0), Date.UTC(y + 1, 0, 1)]),
];
const MODES = [["closed", cfg.rules], ["live", { ...cfg.rules, evaluateOn: "intraday" }]];

const pct = (a, n) => (n ? Math.round((1000 * a) / n) / 10 : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
function everyDay(from, to, R) {
  const c = { pass: 0, fail: 0, out: 0, n: 0 };
  for (let s = gridCeil(from); s + WINDOW * DAY <= to; s += DAY) {
    const o = replayWindow(trades, s, R).outcome;
    c.n++; if (o === OUTCOME.PASS) c.pass++; else if (o === OUTCOME.FAIL) c.fail++; else c.out++;
  }
  return c;
}
// One account: evals back to back from `s0` to the end of the period.
function chain(s0, to, R) {
  const evals = [];
  for (let s = s0; s + WINDOW * DAY <= to; ) {
    const r = replayWindow(trades, s, R), end = r.passMs ?? r.failMs;
    evals.push({ start: s, outcome: r.outcome, ended: end ?? r.endMs });
    s = end != null ? gridCeil(end + 1) : r.endMs;
  }
  return evals;
}
function backToBack(from, to, R) {
  const c = { pass: 0, fail: 0, out: 0, n: 0 }, perChain = [], firstDays = [], firstEvals = [];
  let never = 0, chains = 0;
  for (let k = 0, s0 = gridCeil(from); k < CHAINS && s0 + WINDOW * DAY <= to; k++, s0 += DAY) {
    const ev = chain(s0, to, R);
    chains++;
    for (const e of ev) { c.n++; if (e.outcome === OUTCOME.PASS) c.pass++; else if (e.outcome === OUTCOME.FAIL) c.fail++; else c.out++; }
    perChain.push({ evals: ev.length, passes: ev.filter((e) => e.outcome === OUTCOME.PASS).length });
    const i = ev.findIndex((e) => e.outcome === OUTCOME.PASS);
    if (i < 0) never++; else { firstDays.push((ev[i].ended - s0) / DAY); firstEvals.push(i + 1); }
  }
  const shares = perChain.filter((p) => p.evals).map((p) => (100 * p.passes) / p.evals).sort((a, b) => a - b);
  return { ...c, chains, never, evalsPerChain: median(perChain.map((p) => p.evals)), passesPerChain: median(perChain.map((p) => p.passes)),
           daysToFirst: median(firstDays), evalsToFirst: median(firstEvals), shareRange: shares.length ? [Math.round(shares[0]), Math.round(shares[shares.length - 1])] : null };
}
// How long evals last, by outcome, back to back (all chains pooled): the mechanism behind any gap.
function durations(from, to, R) {
  const d = { pass: [], fail: [], out: [] };
  for (let k = 0, s0 = gridCeil(from); k < CHAINS && s0 + WINDOW * DAY <= to; k++, s0 += DAY)
    for (const e of chain(s0, to, R)) d[e.outcome === OUTCOME.PASS ? "pass" : e.outcome === OUTCOME.FAIL ? "fail" : "out"].push((e.ended - e.start) / DAY);
  return { pass: median(d.pass), fail: median(d.fail), out: median(d.out) };
}

const out = {};
const pad = (s, n) => String(s ?? "—").padStart(n);
for (const [mode, R] of MODES) {
  console.log(`\n== judged on ${mode === "live" ? "live equity" : "closed trades"} ==`);
  console.log(`${"".padEnd(22)}${pad("every day: pass / fail / out", 30)}${pad("n", 5)}  |${pad("back to back: pass / fail / out", 33)}${pad("evals", 7)}${pad("chain: evals, passes", 22)}${pad("1st pass: days, evals", 23)}${pad("no pass", 9)}${pad("days a pass / fail", 20)}${pad("accounts", 12)}`);
  out[mode] = {};
  for (const [name, from, to] of PERIODS) {
    const e = everyDay(from, to, R), b = backToBack(from, to, R), d = durations(from, to, R);
    out[mode][name.trim()] = { everyDay: { pass: pct(e.pass, e.n), fail: pct(e.fail, e.n), out: pct(e.out, e.n), n: e.n },
      backToBack: { pass: pct(b.pass, b.n), fail: pct(b.fail, b.n), out: pct(b.out, b.n), evals: b.n, chains: b.chains, evalsPerChain: b.evalsPerChain,
        passesPerChain: b.passesPerChain, daysToFirst: b.daysToFirst, evalsToFirst: b.evalsToFirst, chainsWithoutPass: b.never, accountPassShareRange: b.shareRange }, medianDays: d };
    console.log(`${name.padEnd(22)}${pad(`${pct(e.pass, e.n)} / ${pct(e.fail, e.n)} / ${pct(e.out, e.n)}`, 30)}${pad(e.n, 5)}  |` +
      `${pad(`${pct(b.pass, b.n)} / ${pct(b.fail, b.n)} / ${pct(b.out, b.n)}`, 33)}${pad(b.n, 7)}${pad(`${b.evalsPerChain}, ${b.passesPerChain}`, 22)}` +
      `${pad(`${b.daysToFirst == null ? "—" : Math.round(b.daysToFirst)}, ${b.evalsToFirst ?? "—"}`, 23)}${pad(`${b.never}/${b.chains}`, 9)}${pad(`${d.pass == null ? "—" : Math.round(d.pass)} / ${d.fail == null ? "—" : Math.round(d.fail)}`, 20)}${pad(b.shareRange ? `${b.shareRange[0]}-${b.shareRange[1]}%` : "—", 12)}`);
  }
}
// One account from Jan 1 2026, eval by eval, both ways of judging: what back to back looks like.
const iso = (ms) => new Date(ms).toISOString().slice(5, 10);
for (const [mode, R] of MODES) {
  const ev = chain(gridCeil(Date.UTC(2026, 0, 1)), LAST, R);
  console.log(`\nOne account from Jan 1 2026, ${mode === "live" ? "live equity" : "closed trades"}: ${ev.map((e) => `${iso(e.start)}-${iso(e.ended)} ${e.outcome === OUTCOME.PASS ? "PASS" : e.outcome === OUTCOME.FAIL ? "fail" : "out"}`).join(", ")}`);
}
console.log(`\n(${trades.length} trades; back to back pools ${CHAINS} chains, one from each of a period's first ${CHAINS} days; fee $${FEE} an eval; ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
fs.writeFileSync("research/eval_back_to_back_results.json", JSON.stringify({ run: new Date().toISOString(), chains: CHAINS, window: WINDOW, results: out }, null, 1));
console.log("wrote research/eval_back_to_back_results.json");
