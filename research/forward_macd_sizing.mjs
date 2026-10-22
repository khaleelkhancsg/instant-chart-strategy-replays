// Forward check of the MACD fade ($1,250) and research/full_stop_sizing_macd.mjs on
// TopstepX's own bars, exported by bot/export_topstepx_bin.py (history from
// 2026-08-23). The signal, volatility gate and engine settings are lib_combo.mjs's
// and years_2019_2026.mjs's, copied here because lib_combo always loads the lab's
// 5-year file; run with "five-year" to check the copy: 2026 gives 172 trades,
// +$16,132 (lib_combo's), 67.6% (67.7 with the file's empty last day).
//
// The volatility gate needs 10 earlier sessions, so on TopstepX's history it is
// complete from 2026-09-07 (the default start). --vol-min 5 lets it average the
// 5-9 sessions it has before then, to cover Sep 1 like the Donchian's check.
//
//   python bot/export_topstepx_bin.py
//   node research/forward_macd_sizing.mjs [bin | five-year] [--from 2026-09-01 --vol-min 5]
//        [--to YYYY-MM-DD] [--null] [--day YYYY-MM-DD] [--days]
//
// RESULT, Sep 1-Oct 22 2026 (38 sessions, --vol-min 5; Sep 7 on as shipped in brackets):
//   sizing                        trades  net $           drawn passes    real 21-day windows
//   shipped: 4 lots                   62  -1,803 (-1,265)  31.9% (31.0)   4 of 18 (3 of 14)
//   full 5 ATR stop + target, max 4  103    +643 (+1,190)  45.8% (55.1)   7 of 18 (7 of 14)
//   at least 3 ATR of stop, max 4     75  -2,389 (-1,244)  28.1% (31.0)   1 of 18 (1 of 14)
//   coin-flip twin of shipped (8 seeds)      +6            35.0%          45.1%
// The fade made no money here: 13 of 38 days at the -$600 limit, Oct 19-22 all
// four. No better than random directions -- as before 2026 (28.2%), unlike
// Jan-Jul 2026 (67.7% against a twin's 35.6%), when no 38-day stretch lost money
// (10th percentile +$1,556; research/full_stop_sizing_macd.mjs section 7). The
// Donchian over the same days: +$1,484, 17 of 18 (bot/forward_full_stop_sizing.py). The bracket was cut as in 2026
// (stop 92%, target 97%), and the 13 trades the line stopped would have lost
// more with the full stop (-$8,966 against -$8,095). The full-stop book is ahead
// only by being smaller on the losers, and its 41 extra trades (+$1,935) -- in
// Jan-Jul 2026 its 247 extra trades lost -$6,063. Oct 22's crosses match a plain
// Python MACD on TopstepX's raw December bars, cross for cross.
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const FIVE = args[0] === "five-year";
const bin = args[0] && !args[0].startsWith("--") ? args[0] : fileURLToPath(new URL("../data/topstepx_1m.bin", import.meta.url));
if (!FIVE) process.env.ORB_BIN = path.resolve(bin);
const S = await import("./lib_shipped.mjs");
const { macd } = await import("../src/indicators.mjs");

const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const MFILL = { slipMult: 1, feeMult: 1, limitFillTp: "close", cancelOpposite: true, exitFirst: true,
                dayCap: 600, breaker: 200, profitBlock: 250, trig: 0.15, tpFromFill: true, detail: true };
const VOL_MIN = Number(opt("--vol-min", 10));
const pct = (n, d) => (d ? (100 * n) / d : NaN);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const day = (td) => new Date(td * 86400000).toISOString().slice(0, 10);
const tdOf = (s) => Date.parse(s + "T00:00:00Z") / 86400000;
const n0 = (x, w) => Math.round(x).toLocaleString("en-US").padStart(w);

// the MACD fade's signal and gates, as research/lib_combo.mjs builds them
const E1 = S.engineFor(1), t1 = E1.tf, A1 = E1.atr, n1 = t1.close.length;
const { line: ML, hist: HS } = macd(t1.close, 12, 26, 9);
const SIGA = new Int8Array(n1);
for (let i = 1; i < n1; i++) if (t1.ctMin[i] >= 510 && t1.ctMin[i] < 900) SIGA[i] = -(HS[i] > 0 && HS[i - 1] <= 0 ? 1 : HS[i] < 0 && HS[i - 1] >= 0 ? -1 : 0);
const volRel = new Float64Array(n1).fill(NaN);
const SESS = [];
{
  const first = new Map(), last = new Map();
  for (let i = 0; i < n1; i++) if (t1.ctMin[i] >= 510 && t1.ctMin[i] < 900) { if (!first.has(t1.tday[i])) { first.set(t1.tday[i], i); SESS.push(t1.tday[i]); } last.set(t1.tday[i], i); }
  const am = new Map();
  for (const d of SESS) { let s = 0, c = 0; for (let i = first.get(d); i <= last.get(d); i++) { s += A1[i]; c++; } am.set(d, s / c); }
  SESS.forEach((d, k) => {
    if (k < VOL_MIN) return;
    const w = Math.min(10, k), avg = SESS.slice(k - w, k).reduce((x, p) => x + am.get(p), 0) / w;
    for (let i = first.get(d); i <= last.get(d); i++) volRel[i] = A1[i] / avg;
  });
}
const macGate = (k) => SIGA[k] !== 0 && Math.sign(ML[k]) === SIGA[k] && !(volRel[k] < 1);
const tpFn = (a, lots) => Math.min(5.15 * a, 600 / (2 * lots));
const lotsFor = (m, max) => (a) => Math.max(1, Math.min(max, Math.floor(600 / ((m + 0.15) * a * 2 + 2.5 + 1e-9))));
const SIZES = [["shipped: 4 lots", () => 4], ["full 5 ATR stop + target, max 4", lotsFor(5, 4)],
               ["full 5 ATR stop + target, max 12", lotsFor(5, 12)], ["at least 3 ATR of stop, max 4", lotsFor(3, 4)]];

const FROM = tdOf(opt("--from", FIVE ? "2026-01-01" : day(SESS[Math.min(VOL_MIN, SESS.length - 1)])));
const TO = opt("--to", null) ? tdOf(opt("--to")) : SESS[SESS.length - 1];
const EV = SESS.filter((d) => d >= FROM && d <= TO);
const inEv = (t) => t.tday >= FROM && t.tday <= TO;
const run = (fn, extra = {}, signals = SIGA) => E1.run((a, c, s, arm) => (macGate(arm - 1) ? fn(a) : 0), { signals, ...MFILL, tpFn, ...extra }).filter(inEv);
function score(T) {
  const by = new Map(EV.map((d) => [d, 0]));
  for (const t of T) by.set(t.tday, by.get(t.tday) + t.pnl);
  const arr = EV.map((d) => by.get(d));
  let rp = 0, rn = 0;
  for (let s = 0; s + 21 <= arr.length; s++, rn++) rp += S.evWith(arr.slice(s, s + 21), RULES);
  return { arr, p: arr.length >= 25 ? S.passArr(arr, RULES) : NaN, real: pct(rp, rn), rp, rn, net: T.reduce((s, t) => s + t.pnl, 0) };
}
console.log(`${FIVE ? "the lab's 5-year file" : bin}: ${n1.toLocaleString()} one-minute bars; ${EV.length} sessions ${day(EV[0])} .. ${day(EV[EV.length - 1])};` +
            ` volatility gate from ${VOL_MIN} sessions of history`);

const EXIT = { TP: "target", SL: "full stop", SLcap: "$600-line stop", FLIP: "next cross", FLAT: "flat time" };
const books = SIZES.map(([name, fn]) => ({ name, T: run(fn) }));
console.log("\n   sizing                              trades  avg lots   win%  stopped     net $  $/trade  $/lot  worst day   pass (21-day draws)   real 21-day windows");
for (const b of books) {
  const T = b.T, n = Math.max(1, T.length), lots = T.reduce((s, t) => s + t.lots, 0);
  Object.assign(b, score(T));
  console.log(`   ${b.name.padEnd(35)} ${String(T.length).padStart(6)} ${(lots / n).toFixed(2).padStart(9)} ${pct(T.filter((t) => t.pnl > 0).length, n).toFixed(1).padStart(6)}` +
              ` ${pct(T.filter((t) => t.why === "SL" || t.why === "SLcap").length, n).toFixed(1).padStart(7)}% ${n0(b.net, 9)} ${n0(b.net / n, 8)} ${n0(b.net / Math.max(1, lots), 6)}` +
              ` ${n0(Math.min(...b.arr), 10)}   ${b.p.toFixed(1).padStart(8)}%             ${b.real.toFixed(1).padStart(6)}% (${b.rp} of ${b.rn})`);
}

// the shipped bracket: how often the $600 line cut the stop and the target, and how the trades ended
{
  const T = books[0].T;
  let d0 = -1, real = 0, sCut = 0, tCut = 0;
  const sA = [], tA = [], atrs = [], why = {};
  for (const t of T) {
    if (t.tday !== d0) { d0 = t.tday; real = 0; }
    const capD = (600 + real) / (2 * t.lots), rawD = 5.15 * t.atr + 0.25;
    if (capD < rawD) sCut++;
    sA.push(Math.min(capD, rawD) / t.atr);
    if (tpFn(t.atr, t.lots) < 5.15 * t.atr - 1e-9) tCut++;
    tA.push(tpFn(t.atr, t.lots) / t.atr);
    atrs.push(t.atr);
    why[t.why] = (why[t.why] || 0) + 1;
    real += t.pnl;
  }
  if (T.length) console.log(`\n   the shipped bracket: stop cut on ${pct(sCut, T.length).toFixed(0)}% (median ${q(sA, 0.5).toFixed(2)} ATR), target cut on ${pct(tCut, T.length).toFixed(0)}%` +
              ` (median ${q(tA, 0.5).toFixed(2)} ATR); 1-min ATR at the signal ${q(atrs, 0.25).toFixed(1)} / ${q(atrs, 0.5).toFixed(1)} / ${q(atrs, 0.75).toFixed(1)}; trades end: ` +
              Object.entries(why).sort((x, y) => y[1] - x[1]).map(([w, n]) => `${EXIT[w] || w} ${pct(n, T.length).toFixed(0)}%`).join(", "));
}

// the trades the $600 line stopped, with the full stop at the same size (diagnostic: no line; the target formula unchanged)
{
  const wide = new Map(run(() => 4, { dayCap: 1e9 }).map((t) => [t.entBar, t]));
  const capped = books[0].T.filter((t) => t.why === "SLcap");
  let a = 0, b = 0;
  for (const t of capped) { a += t.pnl; b += wide.get(t.entBar)?.pnl ?? NaN; }
  console.log(`\n   the ${capped.length} trades the $600 line stopped: ${n0(a, 0)} at the line; with the full 5 ATR stop at the same size ${n0(b, 0)} (diagnostic: no line)`);
}

// trade for trade against the shipped book
{
  const A = new Map(books[0].T.map((t) => [t.entBar, t]));
  const tot = (xs) => xs.reduce((s, t) => s + t.pnl, 0), lot = (xs) => tot(xs) / Math.max(1, xs.reduce((s, t) => s + t.lots, 0));
  console.log("\n   SHIPPED vs EACH SIZING, trade for trade              trades   shipped $   $/lot      sizing $   $/lot");
  for (const b of books.slice(1)) {
    const B = new Map(b.T.map((t) => [t.entBar, t]));
    const both = books[0].T.filter((t) => B.has(t.entBar)), bothB = both.map((t) => B.get(t.entBar));
    const onlyA = books[0].T.filter((t) => !B.has(t.entBar)), onlyB = b.T.filter((t) => !A.has(t.entBar));
    console.log(`   ${b.name.padEnd(35)} both         ${String(both.length).padStart(6)} ${n0(tot(both), 11)} ${n0(lot(both), 7)} ${n0(tot(bothB), 13)} ${n0(lot(bothB), 7)}`);
    console.log(`   ${"".padEnd(35)} only shipped ${String(onlyA.length).padStart(6)} ${n0(tot(onlyA), 11)} ${n0(lot(onlyA), 7)}`);
    console.log(`   ${"".padEnd(35)} only sizing  ${String(onlyB.length).padStart(6)} ${"".padStart(19)} ${n0(tot(onlyB), 13)} ${n0(lot(onlyB), 7)}`);
  }
}

if (args.includes("--null")) {
  // the coin-flip twin: each signal's direction random; same gate, size, bracket and day rules (years_2019_2026.mjs)
  const r = [];
  for (const seed of [101, 202, 303, 404, 505, 606, 707, 808]) {
    const rnd = S.mul(seed), sig = new Int8Array(n1);
    for (let k = 0; k < n1; k++) if (SIGA[k] !== 0) sig[k] = rnd() < 0.5 ? 1 : -1;
    r.push(score(run(() => 4, {}, sig)));
  }
  const mean = (f) => r.reduce((x, y) => x + f(y), 0) / r.length;
  console.log(`\n   coin-flip twin (8 seeds, 4 lots): pass ${mean((x) => x.p).toFixed(1)}% (range ${Math.min(...r.map((x) => x.p)).toFixed(1)}-${Math.max(...r.map((x) => x.p)).toFixed(1)}),` +
              ` real windows ${mean((x) => x.real).toFixed(1)}%, net ${n0(mean((x) => x.net), 0)} (range ${n0(Math.min(...r.map((x) => x.net)), 0)} to ${n0(Math.max(...r.map((x) => x.net)), 0)})`);
}
if (opt("--day", null)) {
  const td = tdOf(opt("--day")), hm = (i) => `${String(Math.floor(t1.ctMin[i] / 60)).padStart(2, "0")}:${String(t1.ctMin[i] % 60).padStart(2, "0")}`;
  console.log(`\n   ${opt("--day")}: every cross 08:30-15:00 CT (fade direction, histogram, MACD line, volatility against its 10-session average)`);
  for (let i = 0; i < n1; i++) if (t1.tday[i] === td && SIGA[i] !== 0)
    console.log(`     ${hm(i)}  fade ${SIGA[i] === 1 ? "BUY " : "SELL"}  hist ${HS[i].toFixed(2).padStart(7)}  line ${ML[i].toFixed(2).padStart(8)}  vol ${volRel[i].toFixed(2)}  ${macGate(i) ? "faded" : "-"}`);
  for (const t of books[0].T.filter((t) => t.tday === td))
    console.log(`     trade: signal ${hm(t.sigBar)}, ${t.dir === 1 ? "LONG" : "SHORT"} ${t.lots} filled ${hm(t.entBar)} @ ${t.avg.toFixed(2)}, out ${hm(t.xBar)} ${t.why} ${t.pnl.toFixed(2)}`);
}
if (args.includes("--days")) {
  console.log("\n   DAYS WHERE THE BOOKS DIFFER    " + books.map((b) => b.name.slice(0, 22).padStart(24)).join(""));
  EV.forEach((d, k) => {
    const v = books.map((b) => b.arr[k]);
    if (Math.max(...v) - Math.min(...v) > 0.5) console.log(`   ${day(d)}                  ` + v.map((x) => n0(x, 24)).join(""));
  });
}
