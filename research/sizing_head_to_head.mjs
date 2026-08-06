// Fixed contracts vs constant-dollar-risk sizing, head to head, every year.
//
// The grid search picked a risk-sized config as its best out-of-sample performer,
// but that config was CHOSEN by looking at out-of-sample results — so its OOS
// number is optimistically biased and cannot be taken at face value.
//
// This tests the underlying principle instead, which is not subject to that bias:
// hold the signal fixed, vary only how size is determined, and look at every year.
// If constant-dollar-risk sizing wins broadly rather than in one cherry-picked
// combination, it is a structural property of trading a FIXED drawdown limit
// across a 5x range of volatility — not a fit to 2026.

import { loadBars } from "../src/data.mjs";
import strat from "../strategies/trend_neutev.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { resolveExec } from "../src/engine.mjs";
import { replayWindow, resolveRules, OUTCOME } from "../src/challenge.mjs";

const { bars } = loadBars();
const DAY = 86400000;
const yearOf = (ms) => new Date(ms).getUTCFullYear();
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];

const starts = [];
for (let s = bars.ts[0]; s <= bars.ts[bars.count - 1] - 30 * DAY; s += DAY) starts.push(s);
const byYear = new Map(YEARS.map((y) => [y, starts.filter((s) => yearOf(s) === y)]));

function rateFor(trades, ss, rules) {
  let p = 0;
  for (const s of ss) if (replayWindow(trades, s, rules).outcome === OUTCOME.PASS) p++;
  return (p / ss.length) * 100;
}
const mean = (a) => a.reduce((x, v) => x + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

const SIGNALS = [
  { name: "incumbent  tf5 don30 adx25", p: { timeframeMin: 5, donchian: 30, adxMin: 25 }, sl: 2, tp: 12 },
  { name: "searched   tf3 don50 adx20", p: { timeframeMin: 3, donchian: 50, adxMin: 20 }, sl: 1, tp: 18 },
];

const SIZERS = [
  ...[2, 3, 5, 8, 10].map((c) => ({ label: `fixed ${String(c).padStart(2)} lots`, ex: { sizingMode: "fixed", contracts: c } })),
  ...[150, 250, 400, 600].map((r) => ({ label: `risk  $${String(r).padStart(3)}`, ex: { sizingMode: "risk", riskDollars: r, maxContracts: 10 } })),
];

const rules = resolveRules({ circuitBreaker: 150 });

for (const S of SIGNALS) {
  console.log(`\n${"=".repeat(96)}\n${S.name}   (sl ${S.sl}xATR, tp ${S.tp}xATR, breaker $150)\n${"=".repeat(96)}`);
  console.log("sizing            " + YEARS.map((y) => String(y).padStart(7)).join("") + "     mean    spread(sd)");

  const rows = [];
  for (const Z of SIZERS) {
    const params = resolveParams(strat, S.p);
    const exec = resolveExec({ ...Z.ex, slAtrMult: S.sl, tpAtrMult: S.tp });
    const run = runStrategy(bars, strat, params, exec);
    const per = YEARS.map((y) => rateFor(run.trades, byYear.get(y), rules));
    rows.push({ Z, per, run });
    console.log(
      `${Z.label.padEnd(17)}` + per.map((v) => (v.toFixed(1) + "%").padStart(7)).join("") +
      `  ${mean(per).toFixed(1).padStart(6)}%  ${sd(per).toFixed(1).padStart(9)}`
    );
  }

  // Under risk sizing the contract count should shrink as volatility rises —
  // that adaptation is the whole mechanism, so show it explicitly.
  const rk = rows.find((r) => r.Z.ex.sizingMode === "risk" && r.Z.ex.riskDollars === 250);
  if (rk) {
    const q = new Map(YEARS.map((y) => [y, { n: 0, q: 0 }]));
    for (const t of rk.run.trades) {
      const r = q.get(yearOf(t.entryTime));
      if (r) { r.n++; r.q += t.contracts; }
    }
    console.log("\navg contracts     " + YEARS.map((y) => {
      const r = q.get(y);
      return (r && r.n ? (r.q / r.n).toFixed(1) : "-").padStart(7);
    }).join("") + "   <- risk $250 adapting to volatility");
  }

  const best = rows.slice().sort((a, b) => mean(b.per) - mean(a.per))[0];
  const steadiest = rows.slice().sort((a, b) => sd(a.per) - sd(b.per))[0];
  console.log(`\n  highest mean : ${best.Z.label}  (${mean(best.per).toFixed(1)}%)`);
  console.log(`  most consistent: ${steadiest.Z.label}  (spread sd ${sd(steadiest.per).toFixed(1)})`);
}

// Aggregate verdict across both signals.
console.log(`\n\n${"=".repeat(96)}\nDoes the PRINCIPLE hold?\n${"=".repeat(96)}`);
let fixedWins = 0, riskWins = 0;
for (const S of SIGNALS) {
  const params = resolveParams(strat, S.p);
  const fixedMeans = [], riskMeans = [];
  for (const Z of SIZERS) {
    const exec = resolveExec({ ...Z.ex, slAtrMult: S.sl, tpAtrMult: S.tp });
    const run = runStrategy(bars, strat, params, exec);
    const m = mean(YEARS.map((y) => rateFor(run.trades, byYear.get(y), rules)));
    (Z.ex.sizingMode === "risk" ? riskMeans : fixedMeans).push(m);
  }
  const bf = Math.max(...fixedMeans), br = Math.max(...riskMeans);
  console.log(`  ${S.name}:  best fixed ${bf.toFixed(1)}%   best risk-sized ${br.toFixed(1)}%   -> ${br > bf ? "risk sizing wins" : "fixed wins"}`);
  if (br > bf) riskWins++; else fixedWins++;
}
console.log(`\n  risk sizing wins on ${riskWins}/${SIGNALS.length} independent signals.`);
