// The 1-minute MACD WITH the momentum, and a tight stop? ($1,250 rules)
//
// The idea: instead of fading the histogram cross, follow it -- a momentum trade
// should go the right way at once, so it should need less room before its exit.
// macd_weak_strong_2026.mjs followed the strong crosses with the fade's wide
// bracket (33.5%, the same as random directions); this tests tight stops.
// Signals: every 08:30-15:00 histogram cross followed (a cross up is a BUY), or only
// the strong ones (the MACD line already on the cross's side: the trend resuming),
// each with and without the fade's volatility gate (1-min ATR >= its 10-session
// average). Entry, size and day rules as the fade: a stop-entry 0.15 ATR beyond
// the arm bar's open, live 10 bars; 4 lots; -$200 breaker, +$250 block, $600
// limit; the next cross closes the trade. Stop 0.25 to 2 ATR from the arm bar's
// open (+0.15 from the fill) or the fade's 5 ATR, all cut at the $600 line;
// target none (the next cross only), 1 or 2 ATR from the fill.
// Tight brackets on 1-minute bars cannot be judged exactly, so each is run twice:
// as the engine books it (the worst case: a stop touched on the fill bar counts,
// and a bar reaching stop and target books the stop) and in the best case
// (lib_shipped fillBarStop "close", sameBarTie "target").
//
// RESULT: no. After a 1-minute cross the price more often snaps back than runs
// on -- the reversal the fade was paid for in 2026 -- so tight stops are hit by
// it: with the next cross as the exit, a 0.5 ATR stop wins 21-30% of trades. As
// booked, no momentum setup passes more than 35.5% in 2026 (the strong crosses,
// gated, with the fade's 5 ATR stop and a 2 ATR target) against the fade's 67.7%,
// and none more than 17.5% before 2026 (the fade 28.2). Tight stops look better
// only in the best case, where the bars' ambiguity is all given to the trade --
// up to 44.6% (every cross, gated, stop 0.5, target 1) -- but its coin-flip twin
// scores 34.7% under the same assumption, so ~10 points of it is edge and the
// rest is the assumption (as booked: 8.6% against 3.9%). Forward on TopstepX's
// bars, Sep 11-Oct 26 (research/forward_macd_momentum.mjs), every momentum
// version lost -$2,500 to -$4,400, and the fade -$2,742.
//
//   node --max-old-space-size=8192 research/macd_momentum_tight.mjs

import * as S from "./lib_shipped.mjs";
import { E1, SIGA, ML, volRel } from "./lib_combo.mjs";

const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const F = { slipMult: 1, feeMult: 1, limitFillTp: "close", cancelOpposite: true, exitFirst: true,
            dayCap: 600, breaker: 200, profitBlock: 250, trig: 0.15, tpFromFill: true };
const BEST = { fillBarStop: "close", sameBarTie: "target" };
const yr = (td) => S.yearOf.get(td);
const IX = (f) => S.days.map((d, k) => (f(d, k) ? k : -1)).filter((k) => k >= 0);
const Y26 = IX((d) => yr(d) === 2026), PRE = IX((d) => yr(d) < 2026);
const pass = (arr, ix) => S.passArr(ix.map((k) => arr[k]), RULES);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

const MOM = Int8Array.from(SIGA, (x) => -x);
const vol = (k) => !(volRel[k] < 1);
const SETS = [["FOLLOW EVERY CROSS", (k) => MOM[k] !== 0],
              ["FOLLOW EVERY CROSS, volatility gate", (k) => MOM[k] !== 0 && vol(k)],
              ["FOLLOW STRONG CROSSES (trend resuming)", (k) => MOM[k] !== 0 && Math.sign(ML[k]) === MOM[k]],
              ["FOLLOW STRONG CROSSES, volatility gate", (k) => MOM[k] !== 0 && Math.sign(ML[k]) === MOM[k] && vol(k)]];
const STOPS = [0.25, 0.5, 1, 2, 5], TGTS = [null, 1, 2];
const run = (gate, sl, tg, extra = {}, signals = MOM) => E1.run((a, c, s, arm) => (gate(arm - 1) ? 4 : 0),
  { signals, ...F, slMult: sl, tpFn: (a) => (tg === null ? 1e6 : tg * a), ...extra });
function score(tr) {
  const arr = S.dayArr(tr, S.days), T = tr.filter((t) => yr(t.tday) === 2026);
  return { p26: pass(arr, Y26), pre: pass(arr, PRE), win: (100 * T.filter((t) => t.pnl > 0).length) / T.length,
           per: mean(T.map((t) => t.pnl)), n: T.length };
}

console.log("=".repeat(132));
console.log("THE MACD WITH THE MOMENTUM, TIGHT STOPS -- each cell: as the engine books it / best case (fill-bar stops need the close, ties go to the target)");
console.log("=".repeat(132));
const fade = score(E1.run((a, c, s, arm) => (SIGA[arm - 1] !== 0 && Math.sign(ML[arm - 1]) === SIGA[arm - 1] && vol(arm - 1) ? 4 : 0),
  { signals: SIGA, ...F, tpFn: (a, q) => Math.min(5.15 * a, 600 / (2 * q)) }));
console.log(`\n   for reference, the shipped FADE: pass 2026 ${fade.p26.toFixed(1)}, before 2026 ${fade.pre.toFixed(1)}, win ${fade.win.toFixed(1)}%, ${Math.round(fade.per)} $/trade`);
let top = null;
for (const [name, gate] of SETS) {
  const cells = new Map();
  for (const sl of STOPS) for (const tg of TGTS) {
    const a = score(run(gate, sl, tg)), b = score(run(gate, sl, tg, BEST));
    cells.set(`${sl}|${tg}`, { a, b });
    if (!top || b.p26 > top.b.p26) top = { name, gate, sl, tg, a, b };
  }
  console.log(`\n${name}` + `   (2026: ${cells.get("1|null").a.n} trades at a 1 ATR stop)`);
  const head = "   " + "".padEnd(30) + TGTS.map((t) => (t === null ? "next cross only" : `target ${t} ATR`).padStart(22)).join("");
  for (const [title, f] of [["PASS 2026", (c) => `${c.a.p26.toFixed(1)} / ${c.b.p26.toFixed(1)}`],
                            ["PASS May 2019-Dec 2025", (c) => `${c.a.pre.toFixed(1)} / ${c.b.pre.toFixed(1)}`],
                            ["WIN RATE 2026", (c) => `${c.a.win.toFixed(1)} / ${c.b.win.toFixed(1)}`],
                            ["$/TRADE 2026, after costs", (c) => `${Math.round(c.a.per)} / ${Math.round(c.b.per)}`]]) {
    console.log(head.replace("".padEnd(30), title.padEnd(30)));
    for (const sl of STOPS)
      console.log("   " + (`stop ${sl} ATR` + (sl === 5 ? " (the fade's)" : "")).padEnd(30) + TGTS.map((tg) => f(cells.get(`${sl}|${tg}`)).padStart(22)).join(""));
  }
}
// the best cell's coin-flip twin: same entries, random direction
{
  const twins = [101, 202, 303, 404, 505, 606, 707, 808].map((seed) => {
    const rnd = S.mul(seed), sig = new Int8Array(MOM.length);
    for (let k = 0; k < sig.length; k++) if (MOM[k] !== 0) sig[k] = rnd() < 0.5 ? 1 : -1;
    return [score(run(top.gate, top.sl, top.tg, {}, sig)), score(run(top.gate, top.sl, top.tg, BEST, sig))];
  });
  console.log(`\n   THE BEST CELL (by its best case): ${top.name}, stop ${top.sl} ATR, ${top.tg === null ? "next cross only" : "target " + top.tg + " ATR"}:` +
              ` pass 2026 ${top.a.p26.toFixed(1)} / ${top.b.p26.toFixed(1)}, before ${top.a.pre.toFixed(1)} / ${top.b.pre.toFixed(1)}`);
  console.log(`   its coin-flip twin (8 seeds):                 pass 2026 ${mean(twins.map((x) => x[0].p26)).toFixed(1)} / ${mean(twins.map((x) => x[1].p26)).toFixed(1)},` +
              ` before ${mean(twins.map((x) => x[0].pre)).toFixed(1)} / ${mean(twins.map((x) => x[1].pre)).toFixed(1)}`);
}
