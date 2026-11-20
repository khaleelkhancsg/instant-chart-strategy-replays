// The two evaluations' own odds, with no strategy at all: a trader with no edge, taking
// coin-flip trades that win or lose R dollars, judged by the lab's rules (replayWindow for
// the eval, simulateFunded for the payout). It answers "whatever I trade, which eval gives
// better odds?" for research/eval_choice_regime.mjs, whose books may have timing quirks.
//
// - A trade: +R or -R, a coin flip, less costs of 3% of R (two ticks and $1.50 a contract
//   on an 80-point stop; at 40 points it would be 6%). A winner dips a uniform 0-100% of R
//   first, a loser goes the whole R: the drawdown is judged on live equity.
// - m trades a weekday (1, 2 or 4), a 30-calendar-day eval, then a funded account under
//   the same drawdown and daily limit, paid once 5 days have each made $150, followed 30
//   days. The eval's daily profit stop (half the target) and daily loss limit are soft
//   stops for the day, as in the lab; no circuit breaker.
//
// RESULT (2026-11-20, 4,000 paths a cell): at the best risk per trade, the $1,250 eval reaches
// a first payout on 10.6% of attempts and the $3,000 eval on 7.9%. That is the $1,250 eval
// at $300 and the $3,000 eval at $600, one trade a day. In dollars it reverses: $114 against
// $173 an attempt, because the $3,000 eval's payouts are bigger. Pass rates top out near 30%
// and 23%, under the no-edge 44% / 40% of a fixed drawdown. Three things pull them down:
//   - the trailing floor,
//   - live-equity dips,
//   - costs.
//
//   node research/eval_choice_geometry.mjs   (a few seconds)

import { replayWindow, simulateFunded, DEFAULT_RULES, OUTCOME } from "../src/challenge.mjs";
import { EVALS } from "../src/evals.mjs";
import { mulberry32 } from "../src/dayeval.mjs";

const DAY = 86400000, START = Date.UTC(2026, 0, 5), PATHS = 4000, COST = 0.03;
const RISKS = { "1250": [50, 100, 150, 200, 300, 400, 500, 600], "3000": [100, 200, 300, 400, 500, 600, 800, 1000] };

function path(rnd, R, m, days) {
  const out = [];
  for (let d = 0; d < days; d++) {
    const t0 = START + d * DAY, wd = new Date(t0).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (let j = 0; j < m; j++) {
      const win = rnd() < 0.5, pnl = (win ? R : -R) - COST * R;
      const entryTime = t0 + 14 * 3600000 + j * 3600000;
      out.push({ entryTime, exitTime: entryTime + 1800000, tday: Math.floor(t0 / DAY), pnl,
                 mae: win ? -rnd() * R : -R, mfe: win ? R : rnd() * R, dir: 1, contracts: 1, fees: 0 });
    }
  }
  return out;
}

const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
for (const m of [1, 2, 4]) {
  console.log(`\n${m} trade${m > 1 ? "s" : ""} a weekday`);
  for (const ev of ["1250", "3000"]) {
    const rules = { ...DEFAULT_RULES, ...EVALS[ev].rules, circuitBreaker: 0, evaluateOn: "intraday" };
    for (const R of RISKS[ev]) {
      const rnd = mulberry32(1000 * m + R);
      let pass = 0, fail = 0, paid = 0, payUsd = 0; const days = [];
      for (let k = 0; k < PATHS; k++) {
        const w = replayWindow(path(rnd, R, m, 30), START, rules);
        if (w.outcome === OUTCOME.PASS) { pass++; days.push(w.stats.daysUsed); } else if (w.outcome === OUTCOME.FAIL) fail++;
        const f = simulateFunded(path(rnd, R, m, 30), START, { ...rules, dailyProfitStop: 0 }, { horizonDays: 30 });
        if (f.payouts.length) { paid++; payUsd += f.payouts[0].gross; }
      }
      days.sort((a, b) => a - b);
      const p = (100 * pass) / PATHS, q = (100 * paid) / PATHS;
      console.log(`  $${ev === "1250" ? "1,250" : "3,000"}  R $${String(R).padStart(4)}: pass ${f1(p).padStart(4)}% fail ${f1((100 * fail) / PATHS).padStart(4)}%` +
                  ` open ${f1(100 - p - (100 * fail) / PATHS).padStart(4)}% (${days.length ? days[days.length >> 1] : "-"} d) | funded paid ${f1(q).padStart(4)}%` +
                  ` | per attempt ${f1((p * q) / 100).padStart(4)}%, $${Math.round((p / 100) * (payUsd / PATHS))}`);
    }
  }
}
