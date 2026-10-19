// Low reward:risk with heavy leverage: 8 to 50 MNQ on the Donchian book.
// 2026 ONLY: every number comes from 2026 trades and from 21-day windows
// drawn from 2026 days (2 Jan - 14 Jul, 139 sessions). Earlier history only
// warms the indicators up.
//
// Size changes the bracket, not just the dollars: the $1,000 daily loss cap
// becomes the stop once 5 ATR is worth more than $1,000, which at 50 lots is
// 10 points (2026's 2-min ATR is ~26). So the target is set as a multiple of
// the stop the trade can ACTUALLY have at that size, measured from the fill.
// Day rules as live (-$500 breaker, +$750 profit block), plus a run without
// the profit block, since at 50 lots one win can be worth more than $750.
//
// Random-direction entries at 50 lots show what leverage does to a book with
// no edge at all.
//
// RESULT (2026 only): every step up in size lowers the pass rate, at every
// target. Sim fills: the live target goes 36.9% (8 lots) -> 13.5% (16) -> 7.2%
// (25) -> 2.8% (35) -> 0.8% (50); RR 0.1 is 0.5% at 16 lots and 0% above. At 50
// lots the cap makes the stop 10 points against a ~26-point 2-min ATR, the win
// rate at RR 0.1 falls to 31%, and every target loses $580-690 a trade. Turning
// the profit block off and random direction do not rescue it.
//
//   node --max-old-space-size=8192 research/donchian_low_rr_leverage.mjs

import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const days = S.days;
const at = (arr, ix) => S.passArr(ix.map((k) => arr[k]));
const PV = 2;
const stopDist = (a, lots) => Math.min(5.15 * a, 1000 / (PV * lots));
const in2026 = (t) => S.yearOf.get(t.tday) === 2026;
function score(lots, opts, signals = M.RESC) {
  const tr = S.run(() => lots, { signals, ...opts }).filter(in2026);
  const arr = S.dayArr(tr, days);
  const w = tr.filter((t) => t.pnl > 0).length;
  return { n: tr.length, win: (100 * w) / tr.length, exp: tr.reduce((s, t) => s + t.pnl, 0) / tr.length,
           y26: at(arr, M.Y26), a26: at(arr, M.Y26a), b26: at(arr, M.Y26b) };
}
const f1 = (x, w = 7) => x.toFixed(1).padStart(w);
const LOTS = [8, 16, 25, 35, 50];
const TGT = [["RR 0.1", 0.1], ["RR 0.2", 0.2], ["RR 0.3", 0.3], ["RR 0.5", 0.5], ["RR 1", 1], ["live 1.75 ATR", null]];
const MODELS = [["SIM FILLS (no slippage, $0.75/side commission)", { slipMult: 0, feeMult: 1 }],
                ["REALISTIC (1 tick slippage each way, $0.75/side)", { slipMult: 1, feeMult: 1 }]];
const tgtOpts = (rr) => (rr === null ? {} : { tpFromFill: true, tpFn: (a, q) => rr * stopDist(a, q) });

console.log("\n  2026 ONLY -- 2 Jan - 14 Jul 2026, 139 sessions");
for (const [mName, m] of MODELS) {
  for (const pb of [750, 0]) {
    console.log("\n" + "=".repeat(118) + "\n" + mName + (pb ? ", live day rules" : ", profit block OFF") + "\n" + "=".repeat(118));
    const res = LOTS.map((lots) => TGT.map(([, rr]) => score(lots, { ...m, profitBlock: pb, ...tgtOpts(rr) })));
    for (const [title, fmt] of [["2026 pass rate", (r) => f1(r.y26, 14)],
                                ["Jan-Mar / Apr-Jul", (r) => (r.a26.toFixed(1) + " / " + r.b26.toFixed(1)).padStart(14)],
                                ["2026 win rate %", (r) => f1(r.win, 14)], ["2026 $ per trade", (r) => f1(r.exp, 14)]]) {
      console.log("\n  " + title.padEnd(18) + "stop at this size" + TGT.map(([t]) => t.padStart(14)).join(""));
      LOTS.forEach((lots, i) => console.log("  " + (lots + " lots").padEnd(18) + ("<= " + (1000 / (PV * lots)).toFixed(1) + " pts").padStart(17) +
        res[i].map(fmt).join("")));
    }
  }
}

console.log("\n" + "=".repeat(118) + "\nRANDOM DIRECTION, 50 lots, sim fills, live day rules: leverage on a book with no edge (mean of 10 coin seeds)\n" + "=".repeat(118));
const coin = (k, s) => { let x = (k * 2654435761 + s * 97531) >>> 0; x ^= x >>> 16; x = Math.imul(x, 2246822507) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };
console.log("\n  " + "target".padEnd(14) + "win%".padStart(8) + "$/trade".padStart(9) + "2026".padStart(8) + "Jan-Mar".padStart(9) + "Apr-Jul".padStart(9));
for (const [t, rr] of TGT) {
  const rs = [];
  for (let s = 1; s <= 10; s++) {
    const R = Int8Array.from(M.RESC);
    for (let k = 0; k < R.length; k++) if (R[k]) R[k] = coin(k, s) < 0.5 ? 1 : -1;
    rs.push(score(50, { slipMult: 0, feeMult: 1, ...tgtOpts(rr) }, R));
  }
  const mean = (k) => rs.reduce((a, r) => a + r[k], 0) / rs.length;
  console.log("  " + t.padEnd(14) + f1(mean("win"), 8) + f1(mean("exp"), 9) + f1(mean("y26"), 8) + f1(mean("a26"), 9) + f1(mean("b26"), 9));
}
