// Size each Donchian trade so the FULL 5 ATR stop fits inside the $600 day limit?
//
// At 4 lots the stop is "5 ATR, or nearer where the trade would lose $600":
// once the 2-minute ATR is above ~14.6 points the $600 line is the nearer, so in
// a market like 2026's most trades get a stop well inside 5 ATR (1.85 ATR on the
// live loss of 2026-10-22, ATR 40.6). The alternative: before each entry, take
// the most lots for which the full stop -- 5 ATR from the arm bar's open, 5.15
// ATR from the fill -- plus a tick each way and $0.75 a side fits in $600:
//
//     lots = floor( 600 / ( (5.15 x ATR + 0.5) x $2 + $1.50 ) ),  at least 1
//
// (ATR 40 -> 1 lot, 27 -> 2, 19 -> 3, 14.5 and below -> 4.) The target is never
// cut in this strategy -- always 1.75 ATR -- so the full geometry is kept and
// only the dollar size moves. Everything else as shipped; the late-day size
// stays half. Variants: capped at the shipped 4 lots, or allowed up to 12 on
// calm days; and, to see the trade-off, sizes that only guarantee 4 / 3 / 2.5
// ATR of stop. Scored on 2026 (both halves), on May 2019-Dec 2025, and on days
// grouped by how volatile they were (the median 2-min ATR of 08:30-15:00): a
// 21-day evaluation drawn from days of one kind only.
//
// RESULT: it lowers the pass rate everywhere in the history ($1,250 rules,
// 21-day evaluations; 2026 (Jan-Mar / Apr-Jul) and May 2019-Dec 2025):
//   shipped: 4 lots, stop cut to the $600 line   71.1 (74.3 / 75.1)   36.0
//   full 5 ATR stop, at most 4 lots              22.0 (14.8 / 31.4)   21.7
//   full 5 ATR stop, up to 12 lots when calm     21.6 (14.3 / 31.2)   25.7
//   at least 4 / 3 / 2.5 ATR of stop, max 4      34.5 / 54.2 / 59.9   26.8 / 31.5 / 33.3
// Lower in every year 2020-2025 (level in 2019) and on every kind of day:
// wild days 58.1 -> 28.3, busy 38.8 -> 16.9. The cut stop is what the 2026
// result was earned with: the $600 line was nearer than 5 ATR on 78% of 2026's
// trades (median stop 3.4 ATR; 17% of its signals at a 2-min ATR of 40+),
// 31% before 2026. Why the full stop loses:
//   - it shrinks the trades that pay most: 1 lot from ATR 30 up; on 2026's
//     wild days shipped +$2,398, full stop -$213;
//   - the wider stop does not rescue what the line stops: of those trades in
//     2026 (17) / before (142), 12% / 11% came back to the target and 35% / 48%
//     went on to the full 5 ATR stop; with it they average -$192 / -$170 a lot
//     against -$159 / -$157 at the line;
//   - smaller trades leave the -$300 / +$250 day rules unfired, so it keeps
//     trading on days the shipped book is done: 70 more trades in 2026, -$1,394.
//   On the same 128 trades of 2026 it makes +$14 a lot against +$23.
// Forward, Sep 1-Oct 22 2026 on TopstepX bars (bot/forward_full_stop_sizing.py,
// 38 trading days nothing was tuned on), it came out AHEAD: 67.7% drawn passes
// against 62.4%, real 21-day windows level (17 of 18 each), +$1,970 against
// +$1,484 -- 3 of the 4 trades the line stopped bounced (2026-10-22: -$21 at
// 1 lot against -$600) and its extra trades made +$936. Of every 38-day
// stretch of history the full stop made more money in 2% of 2026's and 37% of
// 2019-2025's, and passed more real windows in 0% / 9%. Four trades against
// 159: shipped sizing kept; re-run the forward check as live data accrues.
//
//   node --max-old-space-size=8192 research/full_stop_sizing.mjs

import { atr } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import { tf2, HTF, exit20 } from "./lib_combo.mjs";

const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const FILL = { slipMult: 1, feeMult: 1, limitFillTp: "close", cancelOpposite: true, exitFirst: true, dayCap: 600, breaker: 300, profitBlock: 250 };
const yr = (td) => S.yearOf.get(td);
const KOF = new Map(S.days.map((d, k) => [d, k]));
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const sg = (x, w = 7) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + Math.round(x).toLocaleString("en-US") : "-").padStart(w);
const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

// each session's volatility: the median 2-min ATR over 08:30-15:00 CT
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
               ["busy days (18 to 24) -- Sep-Oct 2026 median 20.5", IX((d, k) => vol[k] >= 18 && vol[k] < 24)],
               ["wild days (24 and over) -- the last 10 sessions: 25.0", IX((d, k) => vol[k] >= 24)]];

// a sizing rule: lots for the ATR at the signal
const lotsFor = (m, max) => (a) => Math.max(1, Math.min(max, Math.floor(600 / ((m + 0.15) * a * 2 + 2.5 + 1e-9))));
const SIZES = [
  ["shipped: 4 lots, the stop cut to the $600 line", () => 4],
  ["full 5 ATR stop, at most 4 lots", lotsFor(5, 4)],
  ["full 5 ATR stop, up to 12 lots when calm", lotsFor(5, 12)],
  ["at least 4 ATR of stop, at most 4 lots", lotsFor(4, 4)],
  ["at least 3 ATR of stop, at most 4 lots", lotsFor(3, 4)],
  ["at least 2.5 ATR of stop, at most 4 lots", lotsFor(2.5, 4)],
];
const donGate = (k) => M.RESC[k] !== 0 && HTF[k] === M.RESC[k];
const run = (fn, extra = {}) => S.run((a, c, s, arm) => {
  if (!donGate(arm - 1)) return 0;
  const L = fn(a);
  return M.adrUsed(arm - 1) >= 0.9 ? Math.max(1, Math.round(L / 2)) : L;
}, { signals: M.RESC, ...FILL, exitFn: exit20, ...extra });
function pass(arr, ix) {
  if (ix.length < 25) return NaN;
  return S.passArr(ix.map((k) => arr[k]), RULES);
}

console.log("=".repeat(128));
console.log("FULL 5 ATR STOP INSIDE $600 -- sizing each Donchian trade so its whole stop fits the day limit (the $1,250 bot)");
console.log("=".repeat(128));
console.log("\n   lots at a given 2-min ATR:      " + [10, 14, 15, 20, 25, 27, 30, 35, 40, 50].map((a) => `ATR ${a}: ${lotsFor(5, 12)(a)}`).join("   "));
console.log("   days in each group: " + BANDS.map(([n, ix]) => `${n.split(" (")[0]} ${ix.length} (2026: ${ix.filter((k) => yr(S.days[k]) === 2026).length})`).join(",  "));

const res = [];
for (const [name, fn] of SIZES) {
  const tr = run(fn), arr = S.dayArr(tr, S.days);
  const T26 = tr.filter((t) => yr(t.tday) === 2026), TP = tr.filter((t) => yr(t.tday) < 2026);
  const st = (T) => ({ n: T.length, lots: T.reduce((s, t) => s + t.lots, 0) / T.length, win: (100 * T.filter((t) => t.pnl > 0).length) / T.length,
                       stop: (100 * T.filter((t) => t.why === "SL" || t.why === "SLcap").length) / T.length, per: T.reduce((s, t) => s + t.pnl, 0) / T.length,
                       net: T.reduce((s, t) => s + t.pnl, 0) });
  res.push({ name, arr, tr, s26: st(T26), sp: st(TP), y: pass(arr, Y26), a: pass(arr, M.Y26a), b: pass(arr, M.Y26b), pre: pass(arr, PRE),
             bands: BANDS.map(([, ix]) => pass(arr, ix)), years: [2019, 2020, 2021, 2022, 2023, 2024, 2025].map((y) => pass(arr, IX((d) => yr(d) === y))) });
}
console.log("\n1. PASS RATE (21-day evaluations)                              2026 (Jan-Mar / Apr-Jul)   before 2026  |  2019  2020  2021  2022  2023  2024  2025");
for (const r of res)
  console.log("   " + r.name.padEnd(56) + f1(r.y) + " (" + r.a.toFixed(1) + " / " + r.b.toFixed(1) + ")" + f1(r.pre, 11) + "    |" + r.years.map((x) => f1(x, 6)).join(""));
console.log("\n2. BY HOW VOLATILE THE DAYS ARE (evaluations made only of days of that kind, all years)");
console.log("   " + "".padEnd(56) + BANDS.map(([n]) => n.split(" (")[0].padStart(14)).join(""));
for (const r of res) console.log("   " + r.name.padEnd(56) + r.bands.map((x) => f1(x, 14)).join(""));
console.log("\n3. THE TRADES, 2026 | before 2026            trades  avg lots   win%  stopped  $/trade     net $   |  trades  avg lots   win%  stopped  $/trade");
for (const r of res) {
  const a = r.s26, b = r.sp;
  console.log("   " + r.name.padEnd(42) + String(a.n).padStart(6) + f1(a.lots, 10) + f1(a.win, 7) + f1(a.stop, 8) + "%" + sg(a.per, 9) + sg(a.net, 10) +
              "   |" + String(b.n).padStart(8) + f1(b.lots, 10) + f1(b.win, 7) + f1(b.stop, 8) + "%" + sg(b.per, 9));
}
// where the shipped and the full-stop books part: wild days in 2026
{
  const [ship, full] = [res[0], res[1]];
  const wild26 = BANDS[3][1].filter((k) => yr(S.days[k]) === 2026);
  const sum = (arr, ix) => ix.reduce((s, k) => s + arr[k], 0);
  console.log(`\n   on 2026's wild days (${wild26.length}): shipped ${sg(sum(ship.arr, wild26), 0)}, full stop ${sg(sum(full.arr, wild26), 0)}`);
}

// 4. How often the shipped stop is cut, and what the cut is worth. The stop a
// trade had is the nearer of 5.15 ATR from the fill (plus the tick of slippage)
// and the $600 line, which sits (600 + the day's result so far) / ($2 x lots)
// from the fill.
const P26 = (t) => yr(t.tday) === 2026, PPRE = (t) => yr(t.tday) < 2026;
const pct = (n, d) => (d ? (100 * n) / d : NaN);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const ship = run(() => 4, { detail: true }), full = run(lotsFor(5, 4), { detail: true });
// diagnostic only (not tradeable): 4 lots with NO $600 line, so every stop is the full 5 ATR
const wide = run(() => 4, { detail: true, dayCap: 1e9 });
console.log("\n4. THE SHIPPED STOP: how often the $600 line is nearer than 5 ATR (2026 | before 2026)");
for (const [label, P] of [["2026", P26], ["before 2026", PPRE]]) {
  const T = ship.filter(P);
  let day = -1, real = 0, cut = 0;
  const atrs = [], stopAtr = [];
  for (const t of T) {
    if (t.tday !== day) { day = t.tday; real = 0; }
    const capD = (600 + real) / (2 * t.lots), rawD = 5.15 * t.atr + 0.25;
    if (capD < rawD) cut++;
    stopAtr.push(Math.min(capD, rawD) / t.atr); atrs.push(t.atr);
    real += t.pnl;
  }
  console.log(`   ${label.padEnd(12)} ${T.length} trades: the stop was cut on ${f1(pct(cut, T.length), 0)}%; stop distance median ${q(stopAtr, 0.5).toFixed(2)} ATR` +
              ` (quartiles ${q(stopAtr, 0.25).toFixed(2)} / ${q(stopAtr, 0.75).toFixed(2)});  2-min ATR at the signal: quartiles ${q(atrs, 0.25).toFixed(1)} / ${q(atrs, 0.5).toFixed(1)} / ${q(atrs, 0.75).toFixed(1)},` +
              ` ${f1(pct(atrs.filter((a) => a >= 40).length, atrs.length), 0)}% at 40 or more`);
}

// 5. The trades the $600 line stopped: what the same trade does with the full
// 5 ATR stop, at the same 4 lots (the diagnostic run above).
console.log("\n5. TRADES STOPPED AT THE $600 LINE -- the same trade with the full 5 ATR stop instead (same lots, same exits otherwise)");
{
  const D = new Map(wide.map((t) => [t.entBar, t]));
  for (const [label, P] of [["2026", P26], ["before 2026", PPRE]]) {
    const capped = ship.filter((t) => P(t) && t.why === "SLcap");
    const m = capped.map((t) => [t, D.get(t.entBar)]).filter(([, d]) => d);
    const by = {};
    for (const [, d] of m) by[d.why] = (by[d.why] || 0) + 1;
    const capLot = m.reduce((s, [t]) => s + t.pnl / t.lots, 0) / m.length;
    const fullLot = m.reduce((s, [, d]) => s + d.pnl / d.lots, 0) / m.length;
    console.log(`   ${label.padEnd(12)} ${capped.length} trades stopped at the line (matched ${m.length}): at the line ${sg(capLot, 0)} a lot;` +
                ` with the full stop ${sg(fullLot, 0)} a lot -- ` + Object.entries(by).sort((a, b) => b[1] - a[1])
                  .map(([w, n]) => `${{ TP: "back to the target", XSIG: "40-minute exit", SL: "the full 5 ATR stop", FLIP: "opposite signal", FLAT: "flat time" }[w] || w} ${f1(pct(n, m.length), 0)}%`).join(", "));
    const lost = m.filter(([, d]) => d.why === "SL");
    if (lost.length) console.log(`   ${"".padEnd(12)} the ${lost.length} that went on to the full stop lost ${sg(lost.reduce((s, [, d]) => s + d.pnl / d.lots, 0) / lost.length, 0)} a lot on average`);
  }
}

// 6. Where the two books part: the trades both take (the full-stop book at its
// own size and stop), and the trades only one of them takes (the day rules --
// -$300 breaker, +$250 block, $600 limit -- trigger at different times when the
// size differs).
console.log("\n6. SHIPPED vs FULL 5 ATR STOP (max 4), trade for trade        trades   shipped $   $/lot   full stop $   $/lot");
{
  const A = new Map(ship.map((t) => [t.entBar, t])), B = new Map(full.map((t) => [t.entBar, t]));
  const tot = (xs) => xs.reduce((s, t) => s + t.pnl, 0), lot = (xs) => tot(xs) / Math.max(1, xs.reduce((s, t) => s + t.lots, 0));
  for (const [label, P] of [["2026", P26], ["before 2026", PPRE]]) {
    const both = ship.filter((t) => P(t) && B.has(t.entBar)), bothB = both.map((t) => B.get(t.entBar));
    const onlyA = ship.filter((t) => P(t) && !B.has(t.entBar)), onlyB = full.filter((t) => P(t) && !A.has(t.entBar));
    console.log(`   ${label.padEnd(12)} taken by both`.padEnd(61) + String(both.length).padStart(6) + sg(tot(both), 12) + sg(lot(both), 8) + sg(tot(bothB), 14) + sg(lot(bothB), 8));
    console.log(`   ${"".padEnd(12)} only shipped (the full-stop book's day had ended)`.padEnd(61) + String(onlyA.length).padStart(6) + sg(tot(onlyA), 12) + sg(lot(onlyA), 8));
    console.log(`   ${"".padEnd(12)} only full stop (the shipped day had ended)`.padEnd(61) + String(onlyB.length).padStart(6) + "".padStart(20) + sg(tot(onlyB), 14) + sg(lot(onlyB), 8));
  }
}

// 7. Is the forward result (Sep 1-Oct 22 2026, 38 trading days, full stop ahead
// on net and on drawn passes, level on real windows) unusual? Every 38-day
// stretch of history, scored the same way: real 21-day windows inside it, and
// the net.
console.log("\n7. EVERY 38-DAY STRETCH OF HISTORY -- how often the full 5 ATR stop (max 4) comes out ahead of shipped, as it did on Sep 1-Oct 22");
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
