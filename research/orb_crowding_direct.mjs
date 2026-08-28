// How many donchian trades does the ORB actually cost?
//
// The argument is that a losing ORB trade spends the day's -$500 breaker and
// blocks everything that would have followed. That is a real mechanism -- the
// question is its size, and it is directly countable: run the donchian book
// alone, run it beside the ORB, and diff.
//
// Two separate costs are in there and worth separating:
//   EXCLUSIVITY  the ORB holds the account for five minutes and the donchian
//                cannot enter during it
//   BUDGET       an ORB loss eats the breaker and blocks the rest of the day
//
//   node research/orb_crowding_direct.mjs

import { simulate, days, ORB_CFG } from "./joint_account.mjs";
import { dayStart, TS } from "./lib_orb.mjs";

const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const SHIP = { ...ORB_CFG, maxWidthPts: 31 };
const sum = (a) => a.reduce((x, y) => x + y, 0);

const alone = simulate("don", { exclusive: true, donLots: 8, orbCfg: SHIP });
const both = simulate("both", { exclusive: true, donLots: 8, orbCfg: SHIP });
const capped = simulate("both", { exclusive: true, donLots: 8,
                                  orbCfg: { ...SHIP, tpCapPts: 60 } });

console.log("\n" + "=".repeat(96));
console.log("WHAT THE ORB COSTS THE DONCHIAN BOOK");
console.log("=".repeat(96));
console.log("\n  run                          donchian trades   lost vs alone   don $/day");
for (const [label, r] of [["donchian alone", alone],
                          ["+ ORB (shipped)", both],
                          ["+ ORB, 60pt target cap", capped]]) {
  const d = r.dTr.length;
  console.log("  " + label.padEnd(28) + String(d).padStart(15) +
    (label === "donchian alone" ? "-" :
     (alone.dTr.length - d) + " (" +
     (100 * (alone.dTr.length - d) / alone.dTr.length).toFixed(1) + "%)").padStart(16) +
    ("$" + (sum(r.dTr) / days.length).toFixed(2)).padStart(12));
}

// Of the days where the ORB lost, how many then blocked a donchian trade?
const orbDays = new Map();
both.oTr.forEach((pnl, i) => orbDays.set(both.oDay[i],
  (orbDays.get(both.oDay[i]) || 0) + pnl));
const lossDays = [...orbDays.entries()].filter(([, p]) => p < 0).map(([d]) => d);
const bigLoss = [...orbDays.entries()].filter(([, p]) => p <= -500).map(([d]) => d);

const donByDay = (r) => {
  const m = new Map();
  r.dDay.forEach((d) => m.set(d, (m.get(d) || 0) + 1));
  return m;
};
const aloneD = donByDay(alone), bothD = donByDay(both);
let lostOnLossDays = 0, lostOnWinDays = 0;
for (const d of days) {
  const gap = (aloneD.get(d) || 0) - (bothD.get(d) || 0);
  if (gap <= 0) continue;
  if (orbDays.has(d) && orbDays.get(d) < 0) lostOnLossDays += gap;
  else lostOnWinDays += gap;
}

console.log("\n" + "=".repeat(96));
console.log("SPLITTING THE COST");
console.log("=".repeat(96));
console.log("\n  ORB traded on                       " + orbDays.size + " days of " + days.length);
console.log("  ...of which it LOST on              " + lossDays.length +
            "  (" + (100 * lossDays.length / orbDays.size).toFixed(1) + "% of its trades)");
console.log("  ...lost enough to spend the breaker " + bigLoss.length +
            "  (" + (100 * bigLoss.length / days.length).toFixed(1) + "% of ALL days)");
console.log("\n  donchian trades lost on ORB LOSS days   " + lostOnLossDays);
console.log("  donchian trades lost on other days      " + lostOnWinDays +
            "   (exclusivity, not budget)");
console.log("  total                                   " +
            (alone.dTr.length - both.dTr.length));
console.log("\n  So the budget mechanism costs " + lostOnLossDays + " donchian entries across " +
            days.length + " days,");
console.log("  or one every " + (days.length / Math.max(1, lostOnLossDays)).toFixed(0) +
            " trading days.");

// And does capping the target actually reduce the ORB's losing days?
const capDays = new Map();
capped.oTr.forEach((pnl, i) => capDays.set(capped.oDay[i],
  (capDays.get(capped.oDay[i]) || 0) + pnl));
const capLoss = [...capDays.values()].filter((p) => p < 0).length;
const capBig = [...capDays.values()].filter((p) => p <= -500).length;
console.log("\n  with a 60-point target cap:");
console.log("    losing ORB days       " + capLoss + "   vs " + lossDays.length + " uncapped");
console.log("    breaker-spending days " + capBig + "   vs " + bigLoss.length + " uncapped");
console.log("    donchian trades       " + capped.dTr.length + "   vs " + both.dTr.length);
