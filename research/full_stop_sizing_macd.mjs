// The MACD fade ($1,250): is its stop cut by the $600 line like the Donchian's,
// and would sizing for the full stop help it? (research/full_stop_sizing.mjs is
// the Donchian's answer.)
//
// The MACD fade's bracket, as shipped (tradovate/mnqMacdFade1250.js), on
// 1-minute bars: the stop is the Donchian's rule -- 5 ATR from the arm bar's
// open, or nearer where the day would reach the $600 limit -- and the TARGET is
// capped the same way, "as far as the stop on a flat day": min(5.15 ATR,
// $600 / ($2 x lots)) from the stop-entry. At 4 lots both sides sit at most 75
// points out once the 1-minute ATR passes ~14.6. Sizing for the full stop
// therefore also restores the full target:
//
//     lots = floor( 600 / ( (5.15 x ATR + 0.5) x $2 + $1.50 ) ),  at least 1
//
// Everything else as shipped: the next cross closes the trade at the next
// open; -$200 breaker, +$250 block, $600 limit. Variants as in the Donchian
// study. The Donchian's bracket is shown beside it for comparison.
//
// RESULT: the MACD has the issue more than the Donchian, on both sides. In 2026
// the $600 line cut its stop on 96.5% of trades (Donchian 78%) and its target on
// 98.8% (median stop 2.67 ATR, target 2.61; the 1-minute ATR at its median
// signal is 28.9, because it trades only when the ATR is above its 10-session
// average). But its bracket matters less: 63% of its 2026 trades end at the
// next cross, 21% at the $600-line stop, 15% at the target. Sizing for the full
// stop -- which restores the full target too -- lowers it like the Donchian:
//                                          2026 (Jan-Mar / Apr-Jul)  before   real windows 2026 / before
//   shipped: 4 lots                         67.7 (64.8 / 73.8)       28.2     57.1 / 30.6
//   full 5 ATR stop + target, max 4         31.0 (27.4 / 32.3)       21.4     43.7 / 23.1
//   full 5 ATR stop + target, up to 12      30.6 (26.3 / 32.3)       24.3     42.9 / 26.6
//   at least 4 / 3 / 2.5 ATR of stop        33.9 / 46.0 / 52.5       23.9 / 25.7 / 27.1
// Wild days 31.7 -> 8.4. On the same 172 trades of 2026 it earns the same +$23 a
// lot: the wider bracket changes nothing per contract, the trades are just half
// the size. And smaller wins no longer reach the +$250 block, so it keeps fading
// after the day's first trade, where the MACD has no edge: 247 extra trades,
// -$6,063. The 36 trades the line stopped average -$140 a lot with the full
// stop against -$150 at the line (before 2026, 239: -$157 against -$150).
// Over 38-day stretches the shipped MACD never lost money in Jan-Jul 2026 (10th
// percentile +$1,556) and lost in 53% before 2026; the Donchian lost in 7% of
// 2026's (10th percentile +$197) and 37% before. Forward on TopstepX's bars
// (research/forward_macd_sizing.mjs) the MACD lost -$1,803 over Sep 1-Oct 22,
// no better than random directions; the Donchian made +$1,484.
//
//   node --max-old-space-size=8192 research/full_stop_sizing_macd.mjs

import { atr } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import { E1, tf2, SIGA, ML, volRel, HTF, exit20 } from "./lib_combo.mjs";

const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const F = { slipMult: 1, feeMult: 1, limitFillTp: "close", cancelOpposite: true, exitFirst: true };
const MFILL = { ...F, dayCap: 600, breaker: 200, profitBlock: 250, trig: 0.15, tpFromFill: true };
const yr = (td) => S.yearOf.get(td);
const KOF = new Map(S.days.map((d, k) => [d, k]));
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const sg = (x, w = 7) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + Math.round(x).toLocaleString("en-US") : "-").padStart(w);
const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = (n, d) => (d ? (100 * n) / d : NaN);

// each session's volatility: the median 2-min ATR over 08:30-15:00 CT (the same bands as the Donchian study)
const A2 = atr(tf2.high, tf2.low, tf2.close, 14);
const vol = new Float64Array(S.days.length).fill(NaN);
{
  let cur = -1, buf = [];
  for (let i = 0; i < tf2.close.length; i++) {
    const k = KOF.get(tf2.tday[i]);
    if (k !== cur) { if (cur >= 0 && buf.length) vol[cur] = median(buf); cur = k; buf = []; }
    if (tf2.ctMin[i] >= 510 && tf2.ctMin[i] < 900) buf.push(A2[i]);
  }
  if (buf.length) vol[cur] = median(buf);
}
const IX = (f) => S.days.map((d, k) => (f(d, k) ? k : -1)).filter((k) => k >= 0);
const Y26 = IX((d) => yr(d) === 2026), PRE = IX((d) => yr(d) < 2026);
const BANDS = [["calm days (volatility under 12)", IX((d, k) => vol[k] < 12)],
               ["medium days (12 to 18)", IX((d, k) => vol[k] >= 12 && vol[k] < 18)],
               ["busy days (18 to 24)", IX((d, k) => vol[k] >= 18 && vol[k] < 24)],
               ["wild days (24 and over)", IX((d, k) => vol[k] >= 24)]];

const lotsFor = (m, max) => (a) => Math.max(1, Math.min(max, Math.floor(600 / ((m + 0.15) * a * 2 + 2.5 + 1e-9))));
const SIZES = [
  ["shipped: 4 lots, stop and target cut at $600", () => 4],
  ["full 5 ATR stop + target, at most 4 lots", lotsFor(5, 4)],
  ["full 5 ATR stop + target, up to 12 when calm", lotsFor(5, 12)],
  ["at least 4 ATR of stop, at most 4 lots", lotsFor(4, 4)],
  ["at least 3 ATR of stop, at most 4 lots", lotsFor(3, 4)],
  ["at least 2.5 ATR of stop, at most 4 lots", lotsFor(2.5, 4)],
];
const macGate = (k) => SIGA[k] !== 0 && Math.sign(ML[k]) === SIGA[k] && !(volRel[k] < 1);
// the target formula is fixed at the $600 line, so the no-line diagnostic below changes only the stop
const tpFn = (a, lots) => Math.min(5.15 * a, 600 / (2 * lots));
const run = (fn, extra = {}) => E1.run((a, c, s, arm) => (macGate(arm - 1) ? fn(a) : 0), { signals: SIGA, ...MFILL, tpFn, ...extra });
const pass = (arr, ix) => (ix.length < 25 ? NaN : S.passArr(ix.map((k) => arr[k]), RULES));
// real windows: every 21-day stretch of consecutive sessions, in calendar order
const realPass = (arr, ix) => { let p = 0, n = 0; for (let s = 0; s + 21 <= ix.length; s++, n++) p += S.evWith(ix.slice(s, s + 21).map((k) => arr[k]), RULES); return pct(p, n); };
const P26 = (t) => yr(t.tday) === 2026, PPRE = (t) => yr(t.tday) < 2026;

console.log("=".repeat(128));
console.log("THE MACD FADE ($1,250) AND THE $600 LINE -- is its bracket cut like the Donchian's, and does sizing for the full stop help?");
console.log("=".repeat(128));

// 0. the two brackets side by side, as shipped
function bracket(T, tpOf) {
  let day = -1, real = 0, sCut = 0, tCut = 0;
  const sA = [], tA = [], atrs = [], why = {};
  for (const t of T) {
    if (t.tday !== day) { day = t.tday; real = 0; }
    const capD = (600 + real) / (2 * t.lots), rawD = 5.15 * t.atr + 0.25;
    if (capD < rawD) sCut++;
    sA.push(Math.min(capD, rawD) / t.atr);
    const [tp, full] = tpOf(t);
    if (tp < full - 1e-9) tCut++;
    tA.push(tp / t.atr);
    atrs.push(t.atr);
    why[t.why] = (why[t.why] || 0) + 1;
    real += t.pnl;
  }
  return { n: T.length, sCut: pct(sCut, T.length), tCut: pct(tCut, T.length), sMed: q(sA, 0.5), tMed: q(tA, 0.5), atr: [q(atrs, 0.25), q(atrs, 0.5), q(atrs, 0.75)], why };
}
const EXIT = { TP: "target", SL: "full stop", SLcap: "$600-line stop", FLIP: "next signal", XSIG: "40-min exit", FLAT: "flat time" };
const donShip = S.run((a, c, s, arm) => (M.RESC[arm - 1] !== 0 && HTF[arm - 1] === M.RESC[arm - 1] ? (M.adrUsed(arm - 1) >= 0.9 ? 2 : 4) : 0),
                      { signals: M.RESC, ...F, dayCap: 600, breaker: 300, profitBlock: 250, exitFn: exit20 });
const macShip = run(() => 4, { detail: true });
console.log("\n0. THE BRACKETS AS SHIPPED, at 4 lots (the Donchian 2 late in the day). Stop / target distances from the fill, in ATRs of each one's own bars");
console.log("   strategy   period        trades   stop cut   median stop   target cut   median target   ATR at the signal (quartiles)   how trades end");
for (const [name, T, tpOf] of [["Donchian", donShip, (t) => [1.6 * t.atr, 1.6 * t.atr]], ["MACD fade", macShip, (t) => [tpFn(t.atr, t.lots), 5.15 * t.atr]]]) {
  for (const [label, P] of [["2026", P26], ["before 2026", PPRE]]) {
    const b = bracket(T.filter(P), tpOf);
    console.log(`   ${name.padEnd(10)} ${label.padEnd(12)} ${String(b.n).padStart(7)} ${f1(b.sCut, 9)}% ${b.sMed.toFixed(2).padStart(10)} ATR ${f1(b.tCut, 10)}% ${b.tMed.toFixed(2).padStart(12)} ATR` +
                `   ${b.atr.map((x) => x.toFixed(1)).join(" / ").padStart(20)}        ` +
                Object.entries(b.why).sort((x, y) => y[1] - x[1]).map(([w, n]) => `${EXIT[w] || w} ${f1(pct(n, b.n), 0)}%`).join(", "));
  }
}

console.log("\n   lots at a given 1-min ATR:      " + [8, 10, 12, 14, 15, 18, 20, 25, 30].map((a) => `ATR ${a}: ${lotsFor(5, 12)(a)}`).join("   "));
const res = [];
for (const [name, fn] of SIZES) {
  const tr = run(fn, { detail: true }), arr = S.dayArr(tr, S.days);
  const st = (T) => ({ n: T.length, lots: T.reduce((s, t) => s + t.lots, 0) / T.length, win: pct(T.filter((t) => t.pnl > 0).length, T.length),
                       stop: pct(T.filter((t) => t.why === "SL" || t.why === "SLcap").length, T.length), per: T.reduce((s, t) => s + t.pnl, 0) / T.length,
                       net: T.reduce((s, t) => s + t.pnl, 0) });
  res.push({ name, arr, tr, s26: st(tr.filter(P26)), sp: st(tr.filter(PPRE)), y: pass(arr, Y26), a: pass(arr, M.Y26a), b: pass(arr, M.Y26b), pre: pass(arr, PRE),
             r26: realPass(arr, Y26), rpre: realPass(arr, PRE),
             bands: BANDS.map(([, ix]) => pass(arr, ix)), years: [2019, 2020, 2021, 2022, 2023, 2024, 2025].map((y) => pass(arr, IX((d) => yr(d) === y))) });
}
console.log("\n1. PASS RATE (21-day evaluations)                              2026 (Jan-Mar / Apr-Jul)   before 2026  |  2019  2020  2021  2022  2023  2024  2025  | real windows 2026 / before");
for (const r of res)
  console.log("   " + r.name.padEnd(56) + f1(r.y) + " (" + r.a.toFixed(1) + " / " + r.b.toFixed(1) + ")" + f1(r.pre, 11) + "    |" + r.years.map((x) => f1(x, 6)).join("") +
              "  |" + f1(r.r26, 8) + " /" + f1(r.rpre, 6));
console.log("\n2. BY HOW VOLATILE THE DAYS ARE (evaluations made only of days of that kind, all years)");
console.log("   " + "".padEnd(56) + BANDS.map(([n]) => n.split(" (")[0].padStart(14)).join(""));
for (const r of res) console.log("   " + r.name.padEnd(56) + r.bands.map((x) => f1(x, 14)).join(""));
console.log("\n3. THE TRADES, 2026 | before 2026            trades  avg lots   win%  stopped  $/trade     net $   |  trades  avg lots   win%  stopped  $/trade");
for (const r of res) {
  const a = r.s26, b = r.sp;
  console.log("   " + r.name.padEnd(42) + String(a.n).padStart(6) + f1(a.lots, 10) + f1(a.win, 7) + f1(a.stop, 8) + "%" + sg(a.per, 9) + sg(a.net, 10) +
              "   |" + String(b.n).padStart(8) + f1(b.lots, 10) + f1(b.win, 7) + f1(b.stop, 8) + "%" + sg(b.per, 9));
}

// 4. the trades the $600 line stopped, with the full 5 ATR stop instead (diagnostic: no line, same lots, same target)
console.log("\n4. TRADES STOPPED AT THE $600 LINE -- the same trade with the full 5 ATR stop instead (same lots and target)");
{
  const wide = run(() => 4, { detail: true, dayCap: 1e9 });
  const D = new Map(wide.map((t) => [t.entBar, t]));
  for (const [label, P] of [["2026", P26], ["before 2026", PPRE]]) {
    const m = macShip.filter((t) => P(t) && t.why === "SLcap").map((t) => [t, D.get(t.entBar)]).filter(([, d]) => d);
    if (!m.length) { console.log(`   ${label.padEnd(12)} none`); continue; }
    const by = {};
    for (const [, d] of m) by[d.why] = (by[d.why] || 0) + 1;
    console.log(`   ${label.padEnd(12)} ${m.length} trades: at the line ${sg(m.reduce((s, [t]) => s + t.pnl / t.lots, 0) / m.length, 0)} a lot;` +
                ` with the full stop ${sg(m.reduce((s, [, d]) => s + d.pnl / d.lots, 0) / m.length, 0)} a lot -- ` +
                Object.entries(by).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${EXIT[w] || w} ${f1(pct(n, m.length), 0)}%`).join(", "));
  }
}

// 5. trade for trade: what both books take, and what only one takes
console.log("\n5. SHIPPED vs FULL STOP + TARGET (max 4), trade for trade   trades   shipped $   $/lot   full stop $   $/lot");
{
  const ship = res[0].tr, full = res[1].tr;
  const A = new Map(ship.map((t) => [t.entBar, t])), B = new Map(full.map((t) => [t.entBar, t]));
  const tot = (xs) => xs.reduce((s, t) => s + t.pnl, 0), lot = (xs) => tot(xs) / Math.max(1, xs.reduce((s, t) => s + t.lots, 0));
  for (const [label, P] of [["2026", P26], ["before 2026", PPRE]]) {
    const both = ship.filter((t) => P(t) && B.has(t.entBar)), bothB = both.map((t) => B.get(t.entBar));
    const onlyA = ship.filter((t) => P(t) && !B.has(t.entBar)), onlyB = full.filter((t) => P(t) && !A.has(t.entBar));
    console.log(`   ${label.padEnd(12)} taken by both`.padEnd(61) + String(both.length).padStart(6) + sg(tot(both), 12) + sg(lot(both), 8) + sg(tot(bothB), 14) + sg(lot(bothB), 8));
    console.log(`   ${"".padEnd(12)} only shipped`.padEnd(61) + String(onlyA.length).padStart(6) + sg(tot(onlyA), 12) + sg(lot(onlyA), 8));
    console.log(`   ${"".padEnd(12)} only full stop`.padEnd(61) + String(onlyB.length).padStart(6) + "".padStart(20) + sg(tot(onlyB), 14) + sg(lot(onlyB), 8));
  }
}

// 6. every 38-day stretch of history (the length of the forward check, Sep 1-Oct 22 2026)
console.log("\n6. EVERY 38-DAY STRETCH OF HISTORY -- how often the full stop + target (max 4) comes out ahead of shipped");
{
  const [a, b] = [res[0].arr, res[1].arr];
  for (const [label, ix] of [["2026", Y26], ["before 2026", PRE]]) {
    const wa = [], wb = [];
    for (let s = 0; s + 21 <= ix.length; s++) {
      wa.push(S.evWith(ix.slice(s, s + 21).map((k) => a[k]), RULES));
      wb.push(S.evWith(ix.slice(s, s + 21).map((k) => b[k]), RULES));
    }
    let n = 0, net = 0, win = 0, tie = 0;
    for (let s = 0; s + 38 <= ix.length; s++) {
      const pa = wa.slice(s, s + 18).reduce((x, y) => x + y, 0), pb = wb.slice(s, s + 18).reduce((x, y) => x + y, 0);
      const na = ix.slice(s, s + 38).reduce((x, k) => x + a[k], 0), nb = ix.slice(s, s + 38).reduce((x, k) => x + b[k], 0);
      n++; if (nb > na) net++; if (pb > pa) win++; if (pb === pa) tie++;
    }
    console.log(`   ${label.padEnd(12)} ${n} stretches: full stop made more money in ${f1(pct(net, n), 0)}%, passed more real windows in ${f1(pct(win, n), 0)}%` +
                ` (level in ${f1(pct(tie, n), 0)}%)`);
  }
}

// 7. how the SHIPPED books' 38-day results spread, to read a forward stretch against (both strategies)
console.log("\n7. THE SHIPPED BOOKS OVER EVERY 38-DAY STRETCH: net $ (10th percentile / median), share that lost money, real windows passed (median of 18)");
{
  const donArr = S.dayArr(donShip, S.days), macArr = res[0].arr;
  for (const [name, a] of [["Donchian", donArr], ["MACD fade", macArr]]) {
    for (const [label, ix] of [["2026", Y26], ["before 2026", PRE]]) {
      const w = [];
      for (let s = 0; s + 21 <= ix.length; s++) w.push(S.evWith(ix.slice(s, s + 21).map((k) => a[k]), RULES));
      const nets = [], wins = [];
      for (let s = 0; s + 38 <= ix.length; s++) { nets.push(ix.slice(s, s + 38).reduce((x, k) => x + a[k], 0)); wins.push(w.slice(s, s + 18).reduce((x, y) => x + y, 0)); }
      console.log(`   ${name.padEnd(10)} ${label.padEnd(12)} ${String(nets.length).padStart(5)} stretches:  net ${sg(q(nets, 0.1), 7)} / ${sg(q(nets, 0.5), 7)},` +
                  ` lost money in ${f1(pct(nets.filter((x) => x < 0).length, nets.length), 5)}%, real windows passed ${q(wins, 0.5)} of 18 (lowest ${Math.min(...wins)})`);
    }
  }
}
