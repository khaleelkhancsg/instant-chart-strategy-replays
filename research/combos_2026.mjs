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

import fs from "node:fs";
import { macd, ema } from "../src/indicators.mjs";
import { resample } from "../src/resample.mjs";
import { loadBars } from "../src/data.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import * as ORB from "./lib_orb.mjs";

const T0 = Date.now();
const PV = 2;
const COMBINES = {
  "$1,250": { rules: { target: 1250, dd: 1000, consistency: 0.5 }, cap: 600,
              don: [2, 3, 4, 5, 6], mac: [2, 3, 4, 5, 6], orb: [200, 300, 400, 500],
              brk: [0, 200, 300, 400], pb: [0, 150, 200, 250, 350, 450] },
  "$3,000": { rules: { target: 3000, dd: 2000, consistency: 0.5 }, cap: 1000,
              don: [4, 5, 6, 7, 8, 9, 10, 12], mac: [4, 5, 6, 8, 10, 12], orb: [300, 500, 750, 1000],
              brk: [0, 300, 500, 700], pb: [0, 300, 400, 500, 750, 1000] },
};
const in26 = (td) => S.yearOf.get(td) === 2026;
const { bars } = loadBars();

// ---- shared inputs --------------------------------------------------------------------
const tf2 = M.tf, n2 = tf2.close.length;
const E1 = S.engineFor(1), t1 = E1.tf, A1 = E1.atr, n1 = t1.close.length;
// Donchian: the 10-min EMA 9/21 direction at each 2-min bar's close
const HTF = new Int8Array(n2);
{
  const T10 = resample(bars, 10), f10 = ema(T10.close, 9), s10 = ema(T10.close, 21);
  for (let k = 0, j = -1; k < n2; k++) { const lim = tf2.ts[k] + 120000 - 600000; while (j + 1 < T10.ts.length && T10.ts[j + 1] <= lim) j++; HTF[k] = j >= 0 ? Math.sign(f10[j] - s10[j]) || 0 : 0; }
}
// MACD fade: signals, the weak-cross test and the volatility gate
const { line: ML, hist: HS } = macd(t1.close, 12, 26, 9);
const SIGA = new Int8Array(n1);
for (let i = 1; i < n1; i++) if (t1.ctMin[i] >= 510 && t1.ctMin[i] < 900) SIGA[i] = -(HS[i] > 0 && HS[i - 1] <= 0 ? 1 : HS[i] < 0 && HS[i - 1] >= 0 ? -1 : 0);
const volRel = new Float64Array(n1).fill(NaN);
{
  const days = [], first = new Map(), last = new Map();
  for (let i = 0; i < n1; i++) if (t1.ctMin[i] >= 510 && t1.ctMin[i] < 900) { if (!first.has(t1.tday[i])) { first.set(t1.tday[i], i); days.push(t1.tday[i]); } last.set(t1.tday[i], i); }
  const am = new Map();
  for (const d of days) { let s = 0, c = 0; for (let i = first.get(d); i <= last.get(d); i++) { s += A1[i]; c++; } am.set(d, s / c); }
  days.forEach((d, q) => { if (q < 10) return; const avg = days.slice(q - 10, q).reduce((x, p) => x + am.get(p), 0) / 10; for (let i = first.get(d); i <= last.get(d); i++) volRel[i] = A1[i] / avg; });
}
// Levels: break-prone levels per 2026 session, in this lab's prices (levels_2026.json)
const LV = JSON.parse(fs.readFileSync(new URL("./levels_2026.json", import.meta.url), "utf8"));
const dateOf = (td) => new Date(td * 86400000).toISOString().slice(0, 10);
const lvCache = new Map();
function brkLevels(td) {
  if (lvCache.has(td)) return lvCache.get(td);
  const e = LV[dateOf(td)];
  let out = null;
  if (e && e.off != null) out = { off: e.off, p: e.levels.filter(([, t]) => /^(prior_day_high|prior_day_low|overnight_high|overnight_low)$/.test(t)).map(([, , p]) => p + e.off) };
  lvCache.set(td, out);
  return out;
}
// a break-prone level (or a raw-price round 100) crossed going from `from` to `to`
function crossedBrk(td, from, to) {
  const L = brkLevels(td);
  if (!L) return null;
  const lo = Math.min(from, to), hi = Math.max(from, to);
  if (L.p.some((p) => p > lo && p <= hi)) return true;
  return Math.floor((hi - L.off) / 100) * 100 > lo - L.off;
}
// Donchian / ORB: did the breakout go through one in the last 10 minutes? (null = no data: allowed)
function brokeThrough(T, k, W, dir, px) {
  let ext = dir === 1 ? Infinity : -Infinity;
  for (let j = Math.max(0, k - W + 1); j <= k; j++) ext = dir === 1 ? Math.min(ext, T.low[j]) : Math.max(ext, T.high[j]);
  return crossedBrk(T.tday[k], ext, px);
}

// ---- each strategy alone, no day rules: candidate trades with their paths ----------------------
// path[q] = worst P&L so far (raw, before exit costs) by bar q of the trade -- what the
// daily-limit stop compares with the remaining budget
const exit20 = (k, d, st) => k - st.entBar >= 20 && (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) < st.atr;
const NODAY = { slipMult: 1, feeMult: 1, limitFillTp: "close", cancelOpposite: true, exitFirst: true, breaker: 0, profitBlock: 0, dayCap: 1e9, detail: true };
function fromEngine(id, pri, t, T) {
  const openExit = t.why === "FLIP" || t.why === "XSIG" || t.why === "FLAT";
  const path = [], ts = [];
  let w = Infinity;
  for (let j = t.entBar; j <= t.xBar; j++) {
    const adv = j === t.xBar && openExit ? T.open[j] : (t.dir === 1 ? Math.min(T.open[j], T.low[j]) : Math.max(T.open[j], T.high[j]));
    w = Math.min(w, (adv - t.avg) * t.dir * PV * t.lots);
    path.push(w); ts.push(T.ts[j]);
  }
  return { id, pri, tday: t.tday, t0: T.ts[t.entBar], t1: T.ts[t.xBar], pnl: t.pnl, path, ts };
}
const shift1 = (a) => { const o = new Int8Array(a.length); for (let i = 1; i < a.length; i++) o[i] = a[i - 1]; return o; };
const RESC1 = shift1(M.RESC), SIGA1 = shift1(SIGA);
function donTrades(cap, lots, levels, { late: delay = false, slip = 1 } = {}) {
  const late = Math.max(1, Math.round((lots * 4) / 7));
  const sizer = (a, c, s, arm) => {
    const k = arm - 1 - (delay ? 1 : 0);                       // the bar the signal really came from
    if (HTF[k] !== M.RESC[k]) return 0;
    if (levels && brokeThrough(tf2, k, 5, M.RESC[k], tf2.close[k]) === false) return 0;
    return M.adrUsed(k) >= 0.9 ? late : lots;
  };
  return S.run(sizer, { signals: delay ? RESC1 : M.RESC, ...NODAY, slipMult: slip, exitFn: exit20 }).filter((t) => in26(t.tday)).map((t) => fromEngine("Donchian", 0, t, tf2));
}
function macTrades(cap, lots, levels, { late: delay = false, slip = 1 } = {}) {
  const sizer = (a, c, s, arm) => {
    const k = arm - 1 - (delay ? 1 : 0), sg = SIGA[k];
    if (!(Math.sign(ML[k]) === sg && !(volRel[k] < 1))) return 0;
    if (levels && brokeThrough(t1, k, 10, -sg, t1.close[k]) === true) return 0;       // the push went the other way
    return lots;
  };
  return E1.run(sizer, { signals: delay ? SIGA1 : SIGA, ...NODAY, slipMult: slip, trig: 0.15, tpFromFill: true, tpFn: (a, q) => Math.min(5.15 * a, cap / (2 * q)) })
    .filter((t) => in26(t.tday)).map((t) => fromEngine("MACD", 1, t, t1));
}
const ORB_CFG = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3, mode: "plain", stopAt: "opposite",
                  rMult: 3, maxHoldMin: 5, retraceFrac: 0.33, giveUpCt: 570, maxLots: 50, maxPerDay: 1, bothWays: "fill", maxWidthPts: 31 };
const orbSetups = ORB.setups(ORB_CFG).out.filter((s) => in26(s.day));
function orbTrades(cap, risk, levels) {
  const out = [];
  for (const s of orbSetups) {
    if (levels && brokeThrough(t1, s.bar, 10, s.dir, s.entryPx) === false) continue;
    const r = ORB.resolve(s, { ...ORB_CFG, riskDollars: risk });
    const i = s.bar, x = i + r.held, fill = s.entryPx + s.dir * ORB.SLIP;
    const openExit = r.why === "FLAT" || r.why === "TIME" || (x > i && (s.dir === 1 ? ORB.O[x] <= s.entryPx - s.dir * s.risk || ORB.O[x] >= s.entryPx + s.dir * s.risk * ORB_CFG.rMult
                                                                                 : ORB.O[x] >= s.entryPx - s.dir * s.risk || ORB.O[x] <= s.entryPx + s.dir * s.risk * ORB_CFG.rMult));
    const path = [], ts = [];
    let w = Infinity;
    for (let j = i; j <= x; j++) {
      const adv = j === x && openExit ? ORB.O[j] : (s.dir === 1 ? Math.min(ORB.O[j], ORB.L[j]) : Math.max(ORB.O[j], ORB.H[j]));
      w = Math.min(w, (adv - fill) * s.dir * PV * r.lots);
      path.push(w); ts.push(ORB.TS[j]);
    }
    out.push({ id: "ORB", pri: 2, tday: s.day, t0: ORB.TS[i], t1: ORB.TS[x], pnl: r.raw, path, ts });
  }
  return out;
}

// ---- one account ------------------------------------------------------------------------------
function account(trades, { cap, brk, pb, model }) {
  const byDay = new Map();
  for (const t of trades) { const a = byDay.get(t.tday) || []; a.push(t); byDay.set(t.tday, a); }
  const day = new Map();
  let nTaken = 0;
  for (const [d, list] of byDay) {
    list.sort((a, b) => a.t0 - b.t0 || a.pri - b.pri);
    let real = 0, capHit = false;
    const open = [];
    const settle = (t) => {
      open.sort((a, b) => a.t1 - b.t1);
      while (open.length && open[0].t1 <= t) { real += open.shift().pnl; if (real <= -cap) capHit = true; }
    };
    for (const tr of list) {
      settle(tr.t0);
      if (capHit || (brk > 0 && real <= -brk) || (pb > 0 && real >= pb)) continue;
      if (model === "B" && open.length) continue;
      const budget = cap + real;
      let pnl = tr.pnl, t1x = tr.t1;
      for (let q = 0; q < tr.path.length; q++) if (tr.path[q] <= -budget) { pnl = -budget; t1x = tr.ts[q]; break; }
      open.push({ t1: t1x, pnl }); nTaken++;
    }
    settle(Infinity);
    day.set(d, Math.max(real, -cap));
  }
  return { day, nTaken };
}
function score(acct, rules) {
  const arr = S.days.map((d) => acct.day.get(d) || 0);
  const p = (ix) => S.passArr(ix.map((k) => arr[k]), rules);
  const d26 = M.Y26.map((k) => arr[k]);
  let cp = 0, cn = 0;
  for (let q = 0; q + 21 <= d26.length; q++) { cp += S.evWith(d26.slice(q, q + 21), rules); cn++; }
  const tot = d26.reduce((s, v) => s + v, 0);
  return { y: p(M.Y26), a: p(M.Y26a), b: p(M.Y26b), real: (100 * cp) / cn, n: acct.nTaken, perDay: acct.nTaken / M.Y26.length, exp: tot / Math.max(1, acct.nTaken) };
}
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
