// Does a higher win rate make an evaluation easier to pass? ($3,000 combine)
//
// The hypothesis: a strategy that wins very often, with a small reward for its
// risk, should suit an evaluation -- it only has to reach the target before the
// drawdown. Tested by changing ONLY the Donchian's target, 0.25 to 3 ATR against
// the shipped 5 ATR stop (cut at the daily limit), which moves its win rate from
// ~90% to ~45%, and the same on its coin-flip twin: each traded signal's direction
// random, everything else identical, so the same win rates with no edge.
// $3,000 rules: $2,000 trailing drawdown (locks at breakeven once the peak
// reaches $2,000), $1,000 daily limit, 50% consistency, 21 days. The $3,000
// config: 7 lots, 4 once the day has used 0.9 of its average range, -$500
// breaker, +$400 profit block, 40-minute exit.
//
// RESULT: win rate is not what passes. Exactly-zero-EV strategies ($1,000 risked
// a trade, 2 a day, section 0) pass 23.1% at a 50% win rate and 30.0% at 67%,
// then stop gaining: 30.1% at 89%. A higher win rate helps a little -- small wins
// land on the target and pass the consistency rule, and a loss past the drawdown
// costs nothing more -- but the $1,000 daily limit caps how big the rare loss
// can be, so ~30% is the ceiling for any shape with no edge. With $17.50 of costs
// a trade (zero EV before costs) 89% falls to 17.9% (67% best, 25.2%), and with
// 21 days to pass, to 7.0%. On the Donchian, only its target changed (2026 / before):
//   target     win%  needed  $/trade   pass           coin-flip twin: win%  $/trade   pass
//   0.25 ATR   88.6   94.3     -21      0.0 /  0.0                   84.3     -34     0.0 /  0.0
//   0.5 ATR    88.0   88.7      -6      5.7 /  0.3                   82.3     -29     1.6 /  0.1
//   1 ATR      71.8   69.8     +18     21.3 / 12.7                   67.4     -22    10.0 /  2.9
//   1.75 ATR   65.6   54.5    +133     59.3 / 21.8  (shipped)        57.3      -8    20.0 /  8.7
//   3 ATR      51.8   43.0    +148     45.2 / 26.8                   49.3      -5    24.8 / 13.7
// The twin, with no edge, passes LESS the more often it wins: smaller targets pay
// the same costs for smaller wins. What passes is the gap between the win rate
// and the one the payoff needs ("needed"): +11 points at the shipped target, and
// 59.3% -- twice the zero-EV ceiling.
//
//   node --max-old-space-size=8192 research/winrate_vs_pass.mjs

import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import { HTF, exit20 } from "./lib_combo.mjs";

const RULES = { target: 3000, dd: 2000, consistency: 0.5 };
const F = { slipMult: 1, feeMult: 1, limitFillTp: "close", cancelOpposite: true, exitFirst: true,
            dayCap: 1000, breaker: 500, profitBlock: 400, exitFn: exit20 };
const yr = (td) => S.yearOf.get(td);
const IX = (f) => S.days.map((d, k) => (f(d, k) ? k : -1)).filter((k) => k >= 0);
const Y26 = IX((d) => yr(d) === 2026), PRE = IX((d) => yr(d) < 2026);
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const sg = (x, w = 7) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + Math.round(x).toLocaleString("en-US") : "-").padStart(w);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

const donGate = (k) => M.RESC[k] !== 0 && HTF[k] === M.RESC[k];
const book = (tp, sig = M.RESC) => S.run((a, c, s, arm) => (donGate(arm - 1) ? (M.adrUsed(arm - 1) >= 0.9 ? 4 : 7) : 0),
                                         { signals: sig, ...F, tpMult: tp });
const TWINS = [101, 202, 303, 404, 505, 606, 707, 808].map((seed) => {
  const rnd = S.mul(seed), sig = new Int8Array(M.RESC.length);
  for (let k = 0; k < sig.length; k++) if (M.RESC[k] !== 0) sig[k] = rnd() < 0.5 ? 1 : -1;
  return sig;
});
function stats(T) {
  const w = T.filter((t) => t.pnl > 0), l = T.filter((t) => t.pnl <= 0);
  const aw = mean(w.map((t) => t.pnl)), al = -mean(l.map((t) => t.pnl));
  return { n: T.length, win: (100 * w.length) / T.length, aw, al, be: (100 * al) / (aw + al), per: mean(T.map((t) => t.pnl)) };
}
const pass = (arr, ix) => S.passArr(ix.map((k) => arr[k]), RULES);

// 0. The pure math: strategies with EXACTLY zero EV, only the win rate changing. Each
// trade wins +w with probability 1000 / (w + 1000) or loses -$1,000 (the daily limit,
// the most a trade can lose); 2 trades a day, a losing trade ends the day; the
// evaluation scored as S.evWith does ($3,000, $2,000 trailing, 50% consistency).
function zeroEv(w, { cost = 0, days = 1e9, runs = 100000 } = {}) {
  const rnd = S.mul(77), p = 1000 / (w + 1000);
  let ok = 0;
  for (let r = 0; r < runs; r++) {
    let c = 0, pk = 0, lk = false, md = -1e18;
    for (let d = 0; d < days; d++) {
      let v = 0;
      for (let t = 0; t < 2; t++) { const x = rnd() < p ? w : -1000; v += x - cost; if (x < 0) break; }
      c += v; if (v > md) md = v;
      if (c <= (lk ? 0 : pk - RULES.dd)) break;
      if (c > pk) pk = c;
      if (!lk && pk >= RULES.dd) lk = true;
      if (c >= RULES.target && md <= RULES.consistency * c) { ok++; break; }
    }
  }
  return (100 * ok) / runs;
}
console.log("=".repeat(150));
console.log("0. EXACTLY-ZERO-EV STRATEGIES ($1,000 risked per trade, 2 trades a day): pass rate by win rate");
const WS = [125, 250, 500, 1000, 2000];
console.log("   win rate                                       " + WS.map((w) => `${((100 * 1000) / (w + 1000)).toFixed(0)}% (+$${w})`.padStart(14)).join(""));
for (const [label, o] of [["zero EV after costs, no time limit", {}], ["zero EV before costs ($17.50 a trade: 7 lots)", { cost: 17.5 }],
                          ["  ... and 21 days to pass", { cost: 17.5, days: 21 }]])
  console.log("   " + label.padEnd(47) + WS.map((w) => f1(zeroEv(w, o), 14)).join(""));

console.log("WIN RATE AGAINST PASS RATE -- the $3,000 Donchian with only its target changed, and its coin-flip twin (same trades, random direction: the same win rates, no edge)");
console.log("=".repeat(150));
console.log("\n   2026 trades. 'needed' = the win rate that breaks even at that average win and loss; pass = 21-day evaluations, 2026 / May 2019-Dec 2025");
console.log("   target          THE STRATEGY:  win%  needed  avg win  avg loss  $/trade   pass 2026  before   |  COIN-FLIP TWIN (8 seeds):  win%  needed  $/trade   pass 2026  before");
for (const tp of [0.25, 0.5, 1, 1.75, 3]) {
  const tr = book(tp), arr = S.dayArr(tr, S.days), s = stats(tr.filter((t) => yr(t.tday) === 2026));
  const tw = TWINS.map((sig) => { const t = book(tp, sig), a = S.dayArr(t, S.days); return { s: stats(t.filter((x) => yr(x.tday) === 2026)), p26: pass(a, Y26), pre: pass(a, PRE) }; });
  console.log(`   ${(tp + " ATR" + (tp === 1.75 ? " (shipped)" : "")).padEnd(16)}              ${f1(s.win)} ${f1(s.be, 7)} ${sg(s.aw, 8)} ${sg(-s.al, 9)} ${sg(s.per, 8)} ${f1(pass(arr, Y26), 11)} ${f1(pass(arr, PRE), 7)}` +
              `   |                            ${f1(mean(tw.map((x) => x.s.win)))} ${f1(mean(tw.map((x) => x.s.be)), 7)} ${sg(mean(tw.map((x) => x.s.per)), 8)}` +
              ` ${f1(mean(tw.map((x) => x.p26)), 11)} ${f1(mean(tw.map((x) => x.pre)), 7)}`);
}
