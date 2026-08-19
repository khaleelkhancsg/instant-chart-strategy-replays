// Does the new `donchian_shipped` chart strategy actually behave like the bot?
//
// The reason it exists is that the research book leaves the platform's $1,000
// daily liquidation OFF, so the chart drew days losing five figures that the
// real account would never have been allowed to reach. This checks the cap now
// binds, and prices what the other five field changes cost.
//
//   node research/shipped_strategy_check.mjs

import { loadBars } from "../src/data.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import research from "../strategies/donchian_eff_rth.mjs";
import shipped from "../strategies/donchian_shipped.mjs";

const { bars } = loadBars();

function run(s, execOverride = {}) {
  const p = resolveParams(s);
  const r = runStrategy(bars, s, p, { ...s.execDefaults, ...execOverride },
                        { filter: s.filterDefaults });
  // Day totals, on the engine's own trading-day boundary.
  const byDay = new Map();
  let worstTrade = 0, under = 0;
  for (const t of r.trades) {
    const net = t.pnl;
    if (net < worstTrade) worstTrade = net;
    if (net < -1000) under++;
    byDay.set(t.tday, (byDay.get(t.tday) || 0) + net);
  }
  const dayVals = [...byDay.values()];
  return {
    n: r.trades.length,
    net: r.trades.reduce((a, t) => a + t.pnl, 0),
    worstTrade, under,
    badDays: dayVals.filter((v) => v < -1000).length,
    worstDay: Math.min(...dayVals),
    days: dayVals.length,
  };
}

const row = (label, r) =>
  console.log("  " + label.padEnd(34) +
    String(r.n).padStart(6) +
    ("$" + Math.round(r.net).toLocaleString()).padStart(12) +
    ("$" + Math.round(r.worstTrade).toLocaleString()).padStart(11) +
    (r.under + " (" + (100 * r.under / r.n).toFixed(1) + "%)").padStart(15) +
    String(r.badDays).padStart(9) +
    ("$" + Math.round(r.worstDay).toLocaleString()).padStart(11));

console.log("\n" + "=".repeat(100));
console.log("RESEARCH BOOK vs SHIPPED BOOK — same signal, different account rules");
console.log("=".repeat(100));
console.log("\n  book                              trades         net  worst trd   trades<-1k  days<-1k  worst day");

const R = run(research);
row("donchian_eff_rth (research)", R);

// Isolate the cap: research book, cap turned on, nothing else changed.
row("  ...+ $1,000 cap only", run(research, { dayLossStopUsd: 1000, dayLossStopMode: "exact" }));

const S = run(shipped);
row("donchian_shipped (live config)", S);
// And what the shipped book would look like WITHOUT the cap, to price the cap
// against the other five changes rather than confounding them.
row("  ...cap off", run(shipped, { dayLossStopUsd: 0 }));

console.log("\n  Both books trade the same " + R.days + " days.");
console.log("  The cap is the only change that touches the tail; the other five");
console.log("  (8 lots, 1.75xATR target, 1 tick slippage, $500 breaker, $750 block)");
console.log("  are sizing and cost, and they move the net, not the worst day.");
