// Does same-bar re-entry account for the whole divergence from lib_faithful_eval?
import { loadBars } from "../src/data.mjs";
import strat from "../strategies/macd_angle_v4.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { resolveExec, tradeStats } from "../src/engine.mjs";

const { bars } = loadBars();
const params = resolveParams(strat, {});
const s0 = Date.UTC(2021, 6, 15), s1 = Date.UTC(2026, 6, 14);

console.log("  target (their own code, their data): 21.3/day  pf 1.307  exp $8.16\n");
for (const [lbl, o] of [
  ["sameBarReentry OFF (causal)", { sameBarReentry: false }],
  ["sameBarReentry ON (as theirs)", { sameBarReentry: true }],
  ["ON + no post-stop cooldown", { sameBarReentry: true, cooldownAfterStopMins: 0 }],
  ["ON + no cooldown + no blackout", { sameBarReentry: true, cooldownAfterStopMins: 0, noEntryMinsBeforeFlat: 0 }],
]) {
  const exec = resolveExec({
    contracts: 1, sizingMode: "fixed", slAtrMult: 1.5, tpMode: "rr", tpRR: 1.2,
    flipOnOpposite: false, cooldownAfterStopMins: 60, intradayOnly: true, noEntryMinsBeforeFlat: 10,
    commissionModel: "per-contract", commissionPerSide: 1.25, slippageTicks: 0, ...o,
  });
  const r = runStrategy(bars, strat, params, exec);
  const sel = r.trades.filter((t) => t.entryTime >= s0 && t.entryTime < s1);
  const st = tradeStats(sel);
  console.log(`  ${lbl.padEnd(34)} ${st.tradesPerDay.toFixed(1).padStart(5)}/day  pf ${st.profitFactor.toFixed(3)}  exp $${st.expectancy.toFixed(2).padStart(7)}  n ${st.n.toLocaleString().padStart(8)}`);
}
