// Why does dropping PROFITABLE trades raise the pass rate?
//
// The ">= 8 lots" guard removes 145 of 343 trades on 2024-26 and they average
// +$4 -- +$39 in 2026. Discarding winners and passing MORE only makes sense if
// those trades cost something the trade's own P&L does not capture. The
// candidate is exclusivity: an ORB position owns the account, so a 2-lot ORB
// trade blocks the 8-lot Donchian book behind it.
//
// If that is the mechanism, the guard should HURT the ORB book standing alone
// and HELP it when the two share an account.
//
//   node research/orb_minsize_why.mjs

import { simulate, days, pass21, ORB_CFG } from "./joint_account.mjs";
import { dayStart, TS } from "./lib_orb.mjs";

const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const i24 = days.findIndex((d) => yearOf(d) >= 2024);
const GUARD = { ...ORB_CFG, maxWidthPts: 31 };     // ~ ">= 8 lots"

console.log("\n" + "=".repeat(88));
console.log("THE GUARD, BOOK BY BOOK — exclusivity is the thing being tested");
console.log("=".repeat(88));
console.log("\n  books        guard        all years   2024-26      $/day   ORB trades held");
for (const books of ["orb", "both"]) {
  for (const [label, cfg] of [["none", ORB_CFG], [">= 8 lots", GUARD]]) {
    const r = simulate(books, { exclusive: true, donLots: 8, orbCfg: cfg });
    console.log("  " + books.padEnd(13) + label.padEnd(13) +
      (pass21(r.arr).toFixed(1) + "%").padStart(9) +
      (pass21(r.arr.slice(i24)).toFixed(1) + "%").padStart(11) +
      ("$" + (r.arr.reduce((a, b) => a + b, 0) / r.arr.length).toFixed(2)).padStart(11) +
      String(r.oMin ?? "-").padStart(18));
  }
}

console.log("\n  If the guard lowers the ORB-only pass rate and raises the joint one,");
console.log("  the trades it drops were paying for themselves but blocking a bigger");
console.log("  book behind them — which is a cost only the joint account can see.");

// And the donchian book alone, as the fixed reference either side.
const d = simulate("don", { exclusive: true, donLots: 8 });
console.log("\n  donchian alone (unaffected by the guard): " +
            pass21(d.arr).toFixed(1) + "% all years, " +
            pass21(d.arr.slice(i24)).toFixed(1) + "% 2024-26");
