// Which combination of the four indicators passes most -- ORB, Donchian, MACD
// fade, and the Levels? Every combination, on both combines. 2026 ONLY, honest
// fills, realistic costs, cancelOpposite, causal exit order.
//
//   $1,250 combine: target $1,250, trailing drawdown $1,000, daily limit $600
//   $3,000 combine: target $3,000, trailing drawdown $2,000, daily limit $1,000
//   both with the 50% consistency rule
//
// The strategies, as their Tradovate indicators trade them:
//   ORB       mnqOrbBot.js: the pre-open "touch" levels (06:30-08:30), stop at
//             the other level, 3R target, out after 5 minutes, $X risk a trade,
//             entries until 09:30, levels over 31 pts apart skipped; a minute
//             through both levels is booked as it would really fill
//   Donchian  mnqDonchian1250.js: Donchian 30 + ADX + efficiency + rescue,
//             only with the 10-min EMA 9/21, 40-min exit, smaller late in the day
//   MACD      mnqMacdFade1250.js: fades weak 1-min MACD crosses in a moving market
//   Levels    evidenceSRLevels.js draws levels; it does not trade. In a
//             combination it is a FILTER, using what the level study supported:
//             Donchian and ORB only take breakouts that went through a
//             break-prone level (prior-day/overnight high or low, round 100) in
//             the last 10 minutes; the MACD skips fades of a push that did.
//
// One account: the strategies share the day's P&L, so the daily limit, the
// circuit breaker and the profit block apply to their COMBINED result. Each
// strategy is first run alone with no day rules, recording every trade's entry
// and exit time and its worst-point P&L bar by bar; the combination is then
// replayed through one account in time order. A trade's stop is cut at the
// account's remaining daily budget, exactly as the engine's daily-limit stop
// works (it books exactly the budget). Two ways to share the account:
//   A  each strategy trades on its own (positions can overlap; P&L adds)
//   B  one position at a time, first come first served
// Sizes per strategy are each one's best alone on that combine; the day rules
// (breaker, profit block) are searched per combination.
//
// RESULT (2026 only; one account, day rules shared; replaying one strategy
// alone reproduces the engine exactly -- Donchian 71.1%, MACD 67.7%):
// $1,250 combine: the Donchian alone is best -- 71.1% (Jan-Mar 74.3, Apr-Jul
// 75.1); picked on Jan-Mar it reads 75.1% on Apr-Jul. MACD alone 69.1%,
// Donchian + MACD 65.5%; anything with the ORB 41-57%; the ORB alone 10% (25
// trades in 2026). The Levels filter lowers every combination (Donchian 71.1
// -> 65.2, MACD 69.1 -> 47.0). One bar late: Donchian 59.3%, MACD 41.6%.
// $3,000 combine: Donchian + MACD 61.5% (61.2 / 69.7) edges the Donchian alone
// (59.3%, 49.6 / 70.8; 7 lots) and the MACD alone (56.3%; 6 lots), but one bar
// late it falls to 31.1% (Donchian alone 45.2%), and no combination wins when
// picked on one half and read on the other. ORB and Levels lower everything.
// Why combining rarely helps: the strategies share one profit block, so the
// day's first win ends the day -- a second strategy mostly REPLACES the first
// one's trade instead of adding to it. Only the bigger $3,000 target, which
// needs more trades, gains a little from the extra opportunities.
//
//   node --max-old-space-size=8192 research/combos_2026.mjs

import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import { in26, HTF, SIGA, ML, volRel, E1, NODAY, exit20, donTrades, macTrades, orbTrades, account, score } from "./lib_combo.mjs";

const T0 = Date.now();
const COMBINES = {
  "$1,250": { rules: { target: 1250, dd: 1000, consistency: 0.5 }, cap: 600,
              don: [2, 3, 4, 5, 6], mac: [2, 3, 4, 5, 6], orb: [200, 300, 400, 500],
              brk: [0, 200, 300, 400], pb: [0, 150, 200, 250, 350, 450] },
  "$3,000": { rules: { target: 3000, dd: 2000, consistency: 0.5 }, cap: 1000,
              don: [4, 5, 6, 7, 8, 9, 10, 12], mac: [4, 5, 6, 8, 10, 12], orb: [300, 500, 750, 1000],
              brk: [0, 300, 500, 700], pb: [0, 300, 400, 500, 750, 1000] },
};

const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const f2 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(2) : "-").padStart(w);
function bestRules(trades, C, model) {
  let best = null;
  for (const brk of C.brk) for (const pb of C.pb) {
    const r = score(account(trades, { cap: C.cap, brk, pb, model }), C.rules);
    if (!best || r.y > best.r.y) best = { brk, pb, r };
  }
  return best;
}
const rulesTxt = (b) => (b.brk ? "-$" + b.brk : "no breaker") + " / " + (b.pb ? "+$" + b.pb : "no block");

// ---- check: one strategy through the replay = the engine with day rules ------------------------
{
  const C = COMBINES["$1,250"];
  const replay = (tr, brk, pb) => score(account(tr, { cap: C.cap, brk, pb, model: "A" }), C.rules);
  const d = replay(donTrades(600, 4, false), 300, 250), m = replay(macTrades(600, 4, false), 200, 250);
  // the same strategies through the engine's own day rules
  const de = S.run((a, c, s, arm) => (HTF[arm - 1] === M.RESC[arm - 1] ? (M.adrUsed(arm - 1) >= 0.9 ? 2 : 4) : 0),
                   { signals: M.RESC, ...NODAY, detail: false, exitFn: exit20, breaker: 300, profitBlock: 250, dayCap: 600 }).filter((t) => in26(t.tday));
  const me = E1.run((a, c, s, arm) => (Math.sign(ML[arm - 1]) === SIGA[arm - 1] && !(volRel[arm - 1] < 1) ? 4 : 0),
                    { signals: SIGA, ...NODAY, detail: false, breaker: 200, profitBlock: 250, dayCap: 600, trig: 0.15, tpFromFill: true, tpFn: (a, q) => Math.min(5.15 * a, 600 / (2 * q)) }).filter((t) => in26(t.tday));
  const pe = (tr) => { const arr = S.dayArr(tr, S.days); return S.passArr(M.Y26.map((k) => arr[k]), C.rules); };
  console.log(`check -- one strategy replayed through the account = the engine with its own day rules:`);
  console.log(`  Donchian: replay ${d.y.toFixed(1)}% (${d.n} trades)   engine ${pe(de).toFixed(1)}% (${de.length} trades)`);
  console.log(`  MACD:     replay ${m.y.toFixed(1)}% (${m.n} trades)   engine ${pe(me).toFixed(1)}% (${me.length} trades)`);
}

// ---- every combination on both combines -------------------------------------------------------------
const STRATS = ["ORB", "Donchian", "MACD"];
const SUBSETS = [];
for (let mask = 1; mask < 8; mask++) SUBSETS.push(STRATS.filter((_, i) => mask & (1 << i)));
const summary = {};
for (const [cname, C] of Object.entries(COMBINES)) {
  console.log("\n" + "=".repeat(132) + `\n${cname} COMBINE: target $${C.rules.target}, trailing drawdown $${C.rules.dd}, daily limit $${C.cap}, 50% consistency -- 2026\n` + "=".repeat(132));
  // 1. each strategy's size, picked alone (levels off)
  const gen = { ORB: orbTrades, Donchian: donTrades, MACD: macTrades };
  const grids = { ORB: C.orb, Donchian: C.don, MACD: C.mac };
  const size = {};
  console.log("\n  each strategy alone, by size (best day rules for each; model A)");
  for (const id of STRATS) {
    const rows = grids[id].map((sz) => ({ sz, b: bestRules(gen[id](C.cap, sz, false), C, "A") }));
    rows.sort((x, y) => y.b.r.y - x.b.r.y);
    size[id] = rows[0].sz;
    console.log("   " + id.padEnd(10) + rows.map((x) => (id === "ORB" ? "$" + x.sz + " risk" : x.sz + " lots") + " " + x.b.r.y.toFixed(1) + "%").join("   ") + "    -> " + (id === "ORB" ? "$" + size[id] + " risk" : size[id] + " lots"));
  }
  // 2. candidates at those sizes, with and without the Levels filter
  const cand = {};
  for (const id of STRATS) for (const lv of [false, true]) cand[id + (lv ? "+L" : "")] = gen[id](C.cap, size[id], lv);
  // 3. every combination, both account models
  console.log("\n  " + "combination".padEnd(36) + " model   2026 JanMar AprJul  real  trades a day   $/day-trade   best day rules");
  const all = [];
  for (const sub of SUBSETS) for (const lv of [false, true]) {
    const trades = sub.flatMap((id) => cand[id + (lv ? "+L" : "")]);
    const label = sub.join(" + ") + (lv ? " + Levels" : "");
    for (const model of ["A", "B"]) {
      if (model === "B" && sub.length === 1) continue;
      const b = bestRules(trades, C, model);
      all.push({ label, model, b, sub, lv });
      console.log("  " + label.padEnd(36) + ("  " + model).padEnd(6) + f1(b.r.y) + f1(b.r.a, 7) + f1(b.r.b, 7) + f1(b.r.real) + String(b.r.n).padStart(7) + f2(b.r.perDay, 6) + f1(b.r.exp, 13) + "   " + rulesTxt(b));
    }
  }
  // 4. is the best combination still best when picked on one half and read on the other?
  for (const [fit, test, fl, tl] of [["a", "b", "Jan-Mar", "Apr-Jul"], ["b", "a", "Apr-Jul", "Jan-Mar"]]) {
    const top = all.slice().sort((x, y) => y.b.r[fit] - x.b.r[fit])[0];
    console.log(`  picked on ${fl}: ${top.label} (model ${top.model}, ${rulesTxt(top.b)}) -> ${top.b.r[test].toFixed(1)}% on ${tl}`);
  }
  summary[cname] = all;
  // 5. the contenders under stress: Donchian, MACD, Donchian + MACD (model A), each
  // with its best day rules from above
  console.log("\n  the contenders under stress (2026 / Jan-Mar / Apr-Jul)");
  const contenders = [["Donchian", ["Donchian"]], ["MACD", ["MACD"]], ["Donchian + MACD", ["Donchian", "MACD"]]];
  for (const [lbl, sub] of contenders) {
    const row = all.find((x) => x.label === lbl && x.model === "A");
    const run = (opt) => {
      const tr = sub.flatMap((id) => (id === "Donchian" ? donTrades(C.cap, size.Donchian, false, opt) : macTrades(C.cap, size.MACD, false, opt)));
      return score(account(tr, { cap: C.cap, brk: row.b.brk, pb: row.b.pb, model: "A" }), C.rules);
    };
    const cells = [["as tested", {}], ["2 ticks slippage", { slip: 2 }], ["one bar later", { late: true }]].map(([l, o]) => { const r = run(o); return l + " " + r.y.toFixed(1) + " (" + r.a.toFixed(1) + "/" + r.b.toFixed(1) + ")"; });
    console.log("   " + lbl.padEnd(18) + rulesTxt(row.b).padEnd(26) + cells.join("    "));
  }
  process.stderr.write(`  ${cname} done ${((Date.now() - T0) / 1000).toFixed(0)}s\n`);
}
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
