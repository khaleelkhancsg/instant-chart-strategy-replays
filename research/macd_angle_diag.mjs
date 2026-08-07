// Which execution setting makes the port diverge from the original?
//
// The original reports pf 1.373, exp $9.43/trade, 27.6 trades/day over
// 2021-07-15..2026-03-23. The port produced pf 0.913 at 15.9 trades/day — about
// 58% of the expected frequency, which points at something SUPPRESSING trades
// rather than at the signal maths. This isolates each execution rule in turn.

import { loadBars } from "../src/data.mjs";
import strat from "../strategies/macd_angle_v4.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { resolveExec, tradeStats } from "../src/engine.mjs";

const { bars } = loadBars();
const params = resolveParams(strat, {});
const selStart = Date.UTC(2021, 6, 15), selEnd = Date.UTC(2026, 2, 23);

const BASE = {
  contracts: 1, sizingMode: "fixed",
  slAtrMult: 1.5, tpMode: "rr", tpRR: 1.2,
  flipOnOpposite: false, cooldownAfterStopMins: 60,
  intradayOnly: true, noEntryMinsBeforeFlat: 10,
  commissionModel: "per-contract", commissionPerSide: 1.25, slippageTicks: 0,
};

function measure(label, over) {
  const exec = resolveExec({ ...BASE, ...over });
  const r = runStrategy(bars, strat, params, exec);
  const sel = r.trades.filter((t) => t.entryTime >= selStart && t.entryTime < selEnd);
  const s = tradeStats(sel);
  console.log(
    `  ${label.padEnd(42)} ${s.tradesPerDay.toFixed(1).padStart(6)}/day  pf ${s.profitFactor.toFixed(3).padStart(6)}  ` +
    `exp $${s.expectancy.toFixed(2).padStart(7)}  win ${s.winRate.toFixed(1).padStart(5)}%  n ${s.n.toLocaleString().padStart(8)}`
  );
  return s;
}

console.log("TARGET (original's own reported figures)");
console.log(`  ${"lib_faithful_eval, $2.50 RT, calib. slippage".padEnd(42)} ${"27.6".padStart(6)}/day  pf ${"1.373".padStart(6)}  exp $${"9.43".padStart(7)}\n`);

console.log("PORT, isolating each execution rule");
measure("as shipped (all rules on)", {});
measure("no 60-min post-stop cooldown", { cooldownAfterStopMins: 0 });
measure("force-flip on opposite signal", { flipOnOpposite: true });
measure("no late-entry blackout", { noEntryMinsBeforeFlat: 0 });
measure("no intraday flatten at all", { intradayOnly: false });
measure("cooldown off + force-flip on", { cooldownAfterStopMins: 0, flipOnOpposite: true });
measure("cooldown off + no blackout", { cooldownAfterStopMins: 0, noEntryMinsBeforeFlat: 0 });
measure("all three off", { cooldownAfterStopMins: 0, flipOnOpposite: true, noEntryMinsBeforeFlat: 0 });

console.log("\nGEOMETRY — does the reported pf appear at a different stop/target?");
for (const sl of [1, 1.5, 2, 2.5]) {
  for (const rr of [0.7, 1.2, 2]) {
    measure(`sl ${sl}xATR  tp ${rr}R  (cooldown off, flip on)`, {
      slAtrMult: sl, tpRR: rr, cooldownAfterStopMins: 0, flipOnOpposite: true,
    });
  }
}

console.log("\nSESSION WINDOW — is the RTH gate the frequency limiter?");
for (const [a, b, lbl] of [[8 * 60 + 30, 15 * 60, "08:30-15:00 CT (RTH, as shipped)"],
                           [8 * 60 + 30, 14 * 60 + 55, "08:30-14:55 CT"],
                           [0, 1439, "no session gate at all"]]) {
  const p2 = resolveParams(strat, { rthStartCt: a, rthEndCt: b });
  const exec = resolveExec({ ...BASE, cooldownAfterStopMins: 0, flipOnOpposite: true });
  const r = runStrategy(bars, strat, p2, exec);
  const sel = r.trades.filter((t) => t.entryTime >= selStart && t.entryTime < selEnd);
  const s = tradeStats(sel);
  console.log(`  ${lbl.padEnd(42)} ${s.tradesPerDay.toFixed(1).padStart(6)}/day  pf ${s.profitFactor.toFixed(3).padStart(6)}  exp $${s.expectancy.toFixed(2).padStart(7)}  n ${s.n.toLocaleString().padStart(8)}`);
}
