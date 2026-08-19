// "One lot isn't much money" — so what happens if the ORB risks more?
//
// Geometry is settled: the level-spread stop is a volatility normaliser and
// replacing it with a fixed scalp stop loses two thirds of the book, while
// pulling the target in loses money monotonically in both halves. The only
// honest lever left on trade SIZE is the risk budget itself.
//
// $500 was chosen so a stop-out stays clear of the $1,000 platform cap -- 0 of
// 1,045 trades ever reached it, worst -$625. Raising it buys size on every day,
// not just the wide ones, and pays for it in liquidations. Pass rate is the
// scoreboard, so this is measured on the joint account.
//
//   node research/orb_risk_budget.mjs

import { simulate, days, pass21, forward, ORB_CFG } from "./joint_account.mjs";
import { setups, resolve } from "./lib_orb.mjs";

const H = days.length >> 1;
const half = (arr, first) => (first ? arr.slice(0, H) : arr.slice(H));

console.log("\n" + "=".repeat(100));
console.log("ORB RISK BUDGET — standalone book first, so the sizing is visible");
console.log("=".repeat(100));
console.log("\n  budget   avg lots   max lots   worst trade   trades at the $1k cap   $/trade");
for (const riskDollars of [400, 500, 650, 800, 1000, 1250]) {
  const cfg = { ...ORB_CFG, riskDollars };
  const { out } = setups(cfg);
  const t = out.map((s) => resolve(s, { rMult: cfg.rMult, maxHoldMin: cfg.maxHoldMin,
                                        riskDollars, maxLots: cfg.maxLots }));
  const lots = t.map((r) => r.lots);
  const capped = t.filter((r) => r.capped).length;
  console.log("  $" + String(riskDollars).padEnd(7) +
    (lots.reduce((a, b) => a + b, 0) / lots.length).toFixed(1).padStart(9) +
    String(Math.max(...lots)).padStart(11) +
    ("$" + Math.round(Math.min(...t.map((r) => r.raw))).toLocaleString()).padStart(14) +
    (capped + " (" + (100 * capped / t.length).toFixed(1) + "%)").padStart(24) +
    ("$" + (t.reduce((a, b) => a + b.pnl, 0) / t.length).toFixed(2)).padStart(10));
}

console.log("\n" + "=".repeat(100));
console.log("THE SAME BUDGETS ON THE JOINT ACCOUNT — 21 trading days");
console.log("=".repeat(100));
console.log("\n  budget     $/day   liquidated   21-day   no deadline   1st half   2nd half");
const rows = [];
for (const riskDollars of [400, 500, 650, 800, 1000, 1250]) {
  const r = simulate("both", { exclusive: true, donLots: 8,
                               orbCfg: { ...ORB_CFG, riskDollars } });
  const rec = { riskDollars, all: pass21(r.arr), fwd: forward(r.arr),
                h1: pass21(half(r.arr, true)), h2: pass21(half(r.arr, false)),
                perDay: r.arr.reduce((a, b) => a + b, 0) / r.arr.length, liq: r.liqDays };
  rows.push(rec);
  console.log("  $" + String(riskDollars).padEnd(7) +
    ("$" + rec.perDay.toFixed(2)).padStart(8) +
    (rec.liq + " (" + (100 * rec.liq / days.length).toFixed(1) + "%)").padStart(13) +
    rec.all.toFixed(1).padStart(9) + "%" + rec.fwd.toFixed(1).padStart(12) + "%" +
    rec.h1.toFixed(1).padStart(11) + "%" + rec.h2.toFixed(1).padStart(10) + "%");
}
const ship = rows.find((r) => r.riskDollars === 500);
const best1 = rows.slice().sort((a, b) => b.h1 - a.h1)[0];
console.log("\n  shipped $500                     21-day " + ship.all.toFixed(1) +
            "%   2nd half " + ship.h2.toFixed(1) + "%");
console.log("  best on the 1st half: $" + best1.riskDollars +
            "        2nd half " + best1.h2.toFixed(1) + "%  -> " +
            (best1.h2 - ship.h2 >= 0 ? "+" : "") + (best1.h2 - ship.h2).toFixed(1) +
            "pp against shipped");
