// Does a pre-open width stand-down help the thing that actually matters?
//
// Net dollars said "wide days are worth about nothing": Q4 by width earned
// +$34.50 a trade in the first half and -$18.18 in the second. But this account
// is graded on PASS RATE, and net does not price two costs a wide day carries:
// it spends the day's single ORB shot, and while it holds it locks the Donchian
// book out of the account. So the guard has to be judged on the joint sim.
//
// joint_account.mjs refuses to report combined numbers unless both standalone
// books first reproduce their references, so the parity gate runs underneath
// all of this.
//
//   node research/orb_width_pass.mjs

import { simulate, days, pass21, forward, ORB_CFG } from "./joint_account.mjs";

const H = days.length >> 1;
const half = (arr, first) => (first ? arr.slice(0, H) : arr.slice(H));

function score(maxWidthPts) {
  const orbCfg = maxWidthPts === null ? ORB_CFG : { ...ORB_CFG, maxWidthPts };
  const r = simulate("both", { exclusive: true, orbCfg, donLots: 8 });
  return {
    all: pass21(r.arr), fwd: forward(r.arr),
    h1: pass21(half(r.arr, true)), h2: pass21(half(r.arr, false)),
    perDay: r.arr.reduce((a, b) => a + b, 0) / r.arr.length,
    liq: r.liqDays,
  };
}

console.log("\n" + "=".repeat(96));
console.log("PRE-OPEN WIDTH STAND-DOWN — joint account, 21 trading days");
console.log("=".repeat(96));
console.log("\n  guard              $/day   liquidated   21-day   no deadline   1st half   2nd half");
const rows = [];
for (const w of [null, 150, 100, 75, 60, 50, 40, 30, 25]) {
  const r = score(w);
  rows.push({ w, ...r });
  console.log("  " + (w === null ? "none (shipped)" : "width <= " + w + " pts").padEnd(18) +
    ("$" + r.perDay.toFixed(2)).padStart(7) +
    (r.liq + " (" + (100 * r.liq / days.length).toFixed(1) + "%)").padStart(13) +
    r.all.toFixed(1).padStart(9) + "%" + r.fwd.toFixed(1).padStart(12) + "%" +
    r.h1.toFixed(1).padStart(11) + "%" + r.h2.toFixed(1).padStart(10) + "%");
}

const base = rows[0];
const cand = rows.slice(1);
cand.sort((a, b) => b.h1 - a.h1);
console.log("\n  chosen on the 1ST HALF ONLY: width <= " + cand[0].w + " pts" +
            "   (1st half " + cand[0].h1.toFixed(1) + "% vs " + base.h1.toFixed(1) + "% ungated)");
console.log("  read on the 2ND half:        " + cand[0].h2.toFixed(1) + "%  vs  " +
            base.h2.toFixed(1) + "% ungated   -> " +
            (cand[0].h2 - base.h2 >= 0 ? "+" : "") +
            (cand[0].h2 - base.h2).toFixed(1) + "pp");
console.log("\n  spread of every guard on the 2nd half: " +
  Math.min(...cand.map((r) => r.h2)).toFixed(1) + "% to " +
  Math.max(...cand.map((r) => r.h2)).toFixed(1) + "%   (ungated " +
  base.h2.toFixed(1) + "%)");
