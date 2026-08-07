// Does the MACD-Angle v4 book survive THIS account's rules?
//
// It is the one ported strategy that is both intraday-native AND high-frequency
// (~27.6 trades/day claimed), which is precisely the combination the earlier
// analysis said should produce high pass rates: enough trades for a real edge to
// resolve inside a 30-day window, and a design that never needed the overnight
// hold the 3:05 PM CT flatten takes away.
//
// Step 1 checks the PORT is faithful by reproducing the original's own reported
// per-trade statistics (pf ~1.373, ~27.6 trades/day). If those do not come out,
// nothing downstream means anything.
// Step 2 then measures it under this tool's rules, IS/OOS split.

import { loadBars } from "../src/data.mjs";
import strat from "../strategies/macd_angle_v4.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { resolveExec, tradeStats } from "../src/engine.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { flatten, fastSweep, assertParity, windowStarts } from "./lib_search.mjs";

const { bars } = loadBars();
const RULES = resolveRules({});
const SPLIT = Date.UTC(2023, 5, 1);
const all = windowStarts(bars, RULES.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);

// The original's validated execution, exactly as its header specifies.
const VALIDATED = {
  contracts: 1, sizingMode: "fixed",
  slAtrMult: 1.5, tpMode: "rr", tpRR: 1.2,
  flipOnOpposite: false, cooldownAfterStopMins: 60,
  intradayOnly: true, noEntryMinsBeforeFlat: 10,
};

console.log("STEP 1 — is the port faithful?\n");
console.log("  original reports: pf 1.373, exp $9.43/trade, 27.6 trades/day");
console.log("  (measured on 2021-07-15..2026-03-23, its selection period,");
console.log("   at $2.50 RT/contract with a calibrated slippage model)\n");

// Match the original's cost model and date range as closely as this tool allows.
const selStart = Date.UTC(2021, 6, 15), selEnd = Date.UTC(2026, 2, 23);
const params = resolveParams(strat, {});
const execLikeOriginal = resolveExec({
  ...VALIDATED, commissionModel: "per-contract", commissionPerSide: 1.25, slippageTicks: 0,
});
const full = runStrategy(bars, strat, params, execLikeOriginal);
const sel = full.trades.filter((t) => t.entryTime >= selStart && t.entryTime < selEnd);
const s = tradeStats(sel);
console.log(`  this port      : pf ${s.profitFactor.toFixed(3)}, exp $${s.expectancy.toFixed(2)}/trade, ${s.tradesPerDay.toFixed(1)} trades/day, ${s.n.toLocaleString()} trades`);
console.log(`  win rate ${s.winRate.toFixed(1)}%, avg win $${s.avgWin.toFixed(0)}, avg loss $${s.avgLoss.toFixed(0)}\n`);

// ── Step 2: this account's rules ──
console.log("STEP 2 — under THIS account's rules (flat 3:05pm CT, consistency gates pass)\n");
const exec = resolveExec({ ...VALIDATED, commissionModel: "per-contract", commissionPerSide: 0.75 });
const run = runStrategy(bars, strat, params, exec);
const st = tradeStats(run.trades);
console.log(`  full history: ${st.n.toLocaleString()} trades, ${st.tradesPerDay.toFixed(1)}/day, pf ${st.profitFactor.toFixed(3)}, exp $${st.expectancy.toFixed(2)}`);

assertParity(run.trades, IS.slice(0, 400), RULES, 1);
assertParity(run.trades, IS.slice(0, 400), RULES, 4);
console.log(`  fast-replay parity verified\n`);

const T = flatten(run.trades);
console.log("  lots     IS pass   OOS pass    worst");
const rows = [];
for (let c = 1; c <= 10; c++) {
  const is = fastSweep(T, IS, RULES, c);
  const oos = fastSweep(T, OOS, RULES, c);
  rows.push({ c, is: is.pass, oos: oos.pass });
  console.log(`  ${String(c).padStart(4)}  ${is.pass.toFixed(1).padStart(8)}%  ${oos.pass.toFixed(1).padStart(8)}%  ${Math.min(is.pass, oos.pass).toFixed(1).padStart(7)}%`);
}

// ── Step 3: does its geometry want retuning under these rules? ──
console.log("\n\nSTEP 3 — stop/target sweep at its own signal (worst half of IS/OOS)\n");
const SLS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
const RRS = [0.5, 0.75, 1, 1.2, 1.5, 2, 3, 4, 6];
const out = [];
let n = 0;
for (const sl of SLS) {
  for (const rr of RRS) {
    const e = resolveExec({ ...VALIDATED, slAtrMult: sl, tpRR: rr, commissionPerSide: 0.75 });
    const r = runStrategy(bars, strat, params, e);
    if (r.trades.length < 200) continue;
    const F = flatten(r.trades);
    for (let c = 1; c <= 10; c++) {
      const is = fastSweep(F, IS, RULES, c);
      n++;
      if (is.pass < 30) continue;
      const oos = fastSweep(F, OOS, RULES, c);
      out.push({ sl, rr, c, is: is.pass, oos: oos.pass, w: Math.min(is.pass, oos.pass), trades: r.trades.length, pf: r.stats.profitFactor });
    }
  }
  process.stdout.write(`\r  sl ${sl} … ${n} configs   `);
}
out.sort((a, b) => b.w - a.w);
console.log(`\n\n  ${n} configs evaluated\n`);
console.log("    sl    tp(R)  lots     IS%     OOS%   worst      pf   trades");
for (const r of out.slice(0, 20)) {
  console.log(`  ${String(r.sl).padStart(4)}  ${String(r.rr).padStart(7)}  ${String(r.c).padStart(4)}  ${r.is.toFixed(1).padStart(6)}  ${r.oos.toFixed(1).padStart(7)}  ${r.w.toFixed(1).padStart(6)}  ${r.pf.toFixed(3).padStart(6)}  ${String(r.trades).padStart(7)}`);
}
if (out.length) {
  const b = out[0];
  console.log(`\n  BEST: sl ${b.sl}×ATR, tp ${b.rr}R, ${b.c} lots → IS ${b.is.toFixed(1)}% / OOS ${b.oos.toFixed(1)}% (worst ${b.w.toFixed(1)}%)`);
} else {
  console.log("\n  nothing reached the 30% in-sample floor");
}
