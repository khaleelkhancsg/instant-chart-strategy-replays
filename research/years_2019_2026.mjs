// The strategies built on 2026 alone, run on every other year of MNQ data
// (May 2019, when MNQ began trading, to December 2025). EVERY parameter exactly
// as shipped -- signals, filters, exits, the 40-minute rule, the day rules in
// dollars, the costs. The ONLY thing allowed to change outside 2026 is the lot
// size, and only DOWN (2026 is the most volatile year in the data).
//
//   $1,250 combine ($1,000 trailing, $600 daily limit, 50% consistency)
//     Donchian (the TopstepX bot)  4 lots, 2 late in the day   -$300 / +$250
//     MACD fade                    4 lots                      -$200 / +$250
//   $3,000 combine ($2,000 trailing, $1,000 daily limit, 50% consistency)
//     Donchian alone               7 lots, 4 late              -$500 / +$400
//     Donchian + MACD side by side 7 + 6 lots, each its own rules
//
// A smaller size keeps the shipped ratios (Donchian late size = half, or 4/7 on
// $3,000; the pair's MACD = 6/7 of the Donchian's). Each year is scored like
// 2026 was: the pass rate of 21-day evaluations drawn from that year's own
// days (5-day blocks, days without a trade count as zero), and every real
// 21-day window. Sizing outside 2026, three ways:
//   shipped        the 2026 size, no change
//   best           the best size for that year -- picked on the year itself,
//                  so an upper bound, not something you could have traded
//   to volatility  each day, the shipped size x (recent volatility / 2026's),
//                  rounded, never above the shipped size, never below 1 lot --
//                  known on the morning, so tradeable
//
// RESULT -- built on 2026, read on May 2019-Dec 2025 (1,722 sessions it never saw):
//                        2026   before 2026   coin-flip null before 2026   by year 2019..2025
//   Donchian $1,250      71.1      36.0             18.0                   1.5 20.3 30.2 58.3 31.9 39.2 47.0
//   MACD fade $1,250     67.7      28.2             26.7                   2.8 27.2 35.1 30.3 26.2 36.1 29.1
//   Donchian $3,000      59.3      21.8              8.7                   0.2 10.0 16.5 46.4 15.6 23.7 36.2
//   Both, $3,000         70.5      28.7               -                    1.1 20.7 28.6 34.8 32.8 34.4 32.7
// The DONCHIAN's edge is real in every year: it beats its coin-flip twin (same
// entries in time, size, exits and day rules, direction random) by +1 2019, +5,
// +13, +33, +15, +19, +25 2025, +42 2026, and its edge in ATRs is positive
// 2021-2025. The MACD FADE's is not: +2 overall (-8 2019, +2, +9, 0, +1, +11, -3),
// negative dollars in five of seven years -- its 2026 result looks fitted to 2026.
// Volatility (median 2-min ATR 4.4 in 2019 ... 21.4 in 2026) drives the level.
// A SMALLER size never helps: the best size is the shipped one in nearly every
// year (the exceptions are within noise), and sizing down to the year's
// volatility lowers every strategy (Donchian 36.0 -> 22.7). In a calm year a
// smaller size turns drawdown failures into evaluations that run out of days:
// Donchian 2021 at 4 lots 30 pass / 46 fail / 24 out of days, at 2 lots 10 / 11 / 79.
// 42-DAY EVALUATIONS (--days 42), same draws otherwise:
//                        2026   before 2026   coin-flip null before 2026   by year 2019..2025
//   Donchian $1,250      75.7      45.2             24.3                   5.3 30.2 42.0 62.1 44.6 42.0 51.4
//   MACD fade $1,250     68.2      30.7             27.4                   4.4 33.3 41.5 30.7 27.5 38.4 29.7
//   Donchian $3,000      70.2      37.5             16.7                   1.5 21.6 33.7 60.9 34.2 34.2 46.6
//   Both, $3,000         71.6      31.8               -                    2.5 24.6 34.6 36.0 38.1 37.0 33.6
// Twice the time helps what has an edge and was running out of days -- the
// Donchian, most of all on $3,000 (21.8 -> 37.5 before 2026; 59.3 -> 70.2 in
// 2026) -- and barely moves the MACD, whose misses were drawdowns, not time
// (2025 at 42 days: 30 pass / 70 drawdown / 0 out of days). Out of days nearly
// vanishes for everything. Outside 2026 the Donchian alone now beats the pair
// on $3,000 (37.5 vs 31.8): the MACD's gift was speed. Smaller sizes still do
// not help overall (best size each year 46.4 vs shipped 45.2; to volatility 41.7).
// Real 42-day calendar windows read lower than the bootstrap outside 2026
// (Donchian $1,250 37.4%): bad stretches cluster in time.
//
//   node --max-old-space-size=8192 research/years_2019_2026.mjs [--days 42]

import { atr } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import { E1, tf2, SIGA, ML, volRel, HTF, exit20, donTrades, macTrades, account } from "./lib_combo.mjs";

const T0 = Date.now();
const PV = 2;
// the evaluation length in trading days: node research/years_2019_2026.mjs --days 42
const DAYS = (() => { const i = process.argv.indexOf("--days"); return i > 0 ? Number(process.argv[i + 1]) : 21; })();
const R1250 = { target: 1250, dd: 1000, consistency: 0.5 }, R3000 = { target: 3000, dd: 2000, consistency: 0.5 };
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const yr = (td) => S.yearOf.get(td);
const IDX = {};
for (const y of YEARS) IDX[y] = S.days.map((d, k) => (yr(d) === y ? k : -1)).filter((k) => k >= 0);
const PRE = S.days.map((d, k) => (yr(d) < 2026 ? k : -1)).filter((k) => k >= 0);
const FIVE = S.days.map((d, k) => (d >= Date.UTC(2021, 6, 15) / 86400000 ? k : -1)).filter((k) => k >= 0);
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const f2 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(2) : "-").padStart(w);
const sg = (x, w = 8) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + Math.round(x).toLocaleString("en-US") : "-").padStart(w);
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

// ── volatility: each session's median 2-minute ATR over 08:30-15:00 CT ──────────────────
const A2 = atr(tf2.high, tf2.low, tf2.close, 14);
const dayVol = new Map();
{
  let cur = null, buf = [];
  for (let i = 0; i < tf2.close.length; i++) {
    if (tf2.tday[i] !== cur) { if (cur !== null && buf.length) dayVol.set(cur, median(buf)); cur = tf2.tday[i]; buf = []; }
    if (tf2.ctMin[i] >= 510 && tf2.ctMin[i] < 900) buf.push(A2[i]);
  }
  if (buf.length) dayVol.set(cur, median(buf));
}
const volOfYear = (y) => median(IDX[y].map((k) => dayVol.get(S.days[k])).filter(Number.isFinite));
const REF = volOfYear(2026);
// known on the morning of day k: the median of the previous 60 sessions
const trailRatio = S.days.map((d, k) => {
  const v = S.days.slice(Math.max(0, k - 60), k).map((x) => dayVol.get(x)).filter(Number.isFinite);
  return v.length >= 10 ? median(v) / REF : NaN;
});

// ── the strategies, exactly as shipped ─────────────────────────────────────────────────
const F = { slipMult: 1, feeMult: 1, limitFillTp: "close", cancelOpposite: true, exitFirst: true };
const donGate = (k) => M.RESC[k] !== 0 && HTF[k] === M.RESC[k];
const macGate = (k) => SIGA[k] !== 0 && Math.sign(ML[k]) === SIGA[k] && !(volRel[k] < 1);
// The null: the same strategy with each traded signal's DIRECTION replaced by a
// coin flip -- same entries in time, same size, stop, target, 40-minute exit
// and day rules -- so whatever it passes is the rules and the geometry, not edge.
function coin(sig, seed) {
  const rnd = S.mul(seed), out = new Int8Array(sig.length);
  for (let k = 0; k < sig.length; k++) if (sig[k] !== 0) out[k] = rnd() < 0.5 ? 1 : -1;
  return out;
}
const NULL_SEEDS = [101, 202, 303, 404, 505, 606, 707, 808];
const STRATS = [
  { name: "DONCHIAN, $1,250 combine (the TopstepX bot): 4 lots, 2 late in the day; -$300 / +$250 / -$600 daily limit",
    short: "Donchian $1,250", rules: R1250, sizes: [4, 3, 2, 1],
    trades: (L, sig = M.RESC) => S.run((a, c, s, arm) => (donGate(arm - 1) ? (M.adrUsed(arm - 1) >= 0.9 ? Math.max(1, Math.round(L / 2)) : L) : 0),
                                       { signals: sig, ...F, dayCap: 600, breaker: 300, profitBlock: 250, exitFn: exit20 }),
    nullSig: M.RESC },
  { name: "MACD FADE, $1,250 combine: 4 lots; -$200 / +$250 / -$600 daily limit",
    short: "MACD fade $1,250", rules: R1250, sizes: [4, 3, 2, 1],
    trades: (L, sig = SIGA) => E1.run((a, c, s, arm) => (macGate(arm - 1) ? L : 0),
                                      { signals: sig, ...F, dayCap: 600, breaker: 200, profitBlock: 250, trig: 0.15, tpFromFill: true,
                                        tpFn: (a, q) => Math.min(5.15 * a, 600 / (2 * q)) }),
    nullSig: SIGA },
  { name: "DONCHIAN ALONE, $3,000 combine: 7 lots, 4 late; -$500 / +$400 / -$1,000 daily limit",
    short: "Donchian $3,000", rules: R3000, sizes: [7, 6, 5, 4, 3, 2, 1],
    trades: (L, sig = M.RESC) => S.run((a, c, s, arm) => (donGate(arm - 1) ? (M.adrUsed(arm - 1) >= 0.9 ? Math.max(1, Math.round((L * 4) / 7)) : L) : 0),
                                       { signals: sig, ...F, dayCap: 1000, breaker: 500, profitBlock: 400, exitFn: exit20 }),
    nullSig: M.RESC },
  { name: "DONCHIAN + MACD SIDE BY SIDE, $3,000 combine: 7 + 6 lots, each with its own rules (D -$500/+$400, M +$300); -$1,000 limit",
    short: "Both side by side $3,000", rules: R3000, sizes: [7, 6, 5, 4, 3, 2, 1], label: (L) => `${L}+${Math.max(1, Math.round((L * 6) / 7))}`,
    day: (L) => {
      const acct = account([...donTrades(1000, L, false, { all: true }), ...macTrades(1000, Math.max(1, Math.round((L * 6) / 7)), false, { all: true })],
                           { cap: 1000, log: true, per: { Donchian: { brk: 500, pb: 400, own: true }, MACD: { brk: 0, pb: 300, own: true } } });
      const tr = [];
      for (const [d, lg] of acct.logs) for (const x of lg) if (x.pnl !== undefined) tr.push({ tday: d, pnl: x.pnl, lots: x.lots, atr: NaN });
      return { arr: S.days.map((d) => acct.day.get(d) || 0), trades: tr };
    } },
];

function passOn(arr, ix, rules) {
  if (ix.length < DAYS + 4) return { p: NaN, real: NaN };
  const v = ix.map((k) => arr[k]);
  let cp = 0, cn = 0;
  for (let q = 0; q + DAYS <= v.length; q++) { cp += S.evWith(v.slice(q, q + DAYS), rules); cn++; }
  return { p: S.passArr(v, { ...rules, window: DAYS }), real: (100 * cp) / cn };
}
// of the same draws S.passArr makes: passed / hit the drawdown / ran out of days
function outcomes(arr, ix, { target, dd, consistency }) {
  const v = ix.map((k) => arr[k]), n = v.length, rnd = S.mul(4242), o = { pass: 0, fail: 0, time: 0 };
  for (let d = 0; d < 12000; d++) {
    const buf = [];
    while (buf.length < DAYS) { const st = Math.floor(rnd() * Math.max(1, n - 5)); for (let j = 0; j < 5 && buf.length < DAYS; j++) buf.push(v[(st + j) % n]); }
    let c = 0, pk = 0, lk = false, md = -1e18, r = "time";
    for (const x of buf) {
      c += x; if (x > md) md = x;
      if (c <= (lk ? 0 : pk - dd)) { r = "fail"; break; }
      if (c > pk) pk = c;
      if (!lk && pk >= dd) lk = true;
      if (c >= target && (consistency <= 0 || md <= consistency * c)) { r = "pass"; break; }
    }
    o[r]++;
  }
  return o;
}

console.log("=".repeat(132));
console.log("THE 2026 STRATEGIES ON EVERY OTHER YEAR -- " + DAYS + "-DAY EVALUATIONS -- every parameter as shipped; outside 2026 only the lot size may change, and only down");
console.log("=".repeat(132));
console.log("\nVOLATILITY: each year's median 2-minute ATR in the 08:30-15:00 session, and against 2026");
console.log("   " + YEARS.map((y) => String(y).padStart(9)).join(""));
console.log("   " + YEARS.map((y) => f1(volOfYear(y), 9)).join("") + "   points");
console.log("   " + YEARS.map((y) => (" x" + (volOfYear(y) / REF).toFixed(2)).padStart(9)).join(""));
console.log("   " + YEARS.map((y) => String(IDX[y].length).padStart(9)).join("") + "   sessions" + "   (2019 = May-Dec, 2026 = Jan-14 Jul)");

const summary = [];
for (const st of STRATS) {
  const lab = st.label || ((L) => String(L));
  const runs = new Map();
  for (const L of st.sizes) {
    if (st.day) runs.set(L, st.day(L));
    else { const tr = st.trades(L); runs.set(L, { arr: S.dayArr(tr, S.days), trades: tr }); }
  }
  const ship = st.sizes[0];
  console.log("\n" + "-".repeat(132) + "\n" + st.name + "\n" + "-".repeat(132));
  const head = st.sizes.map((L) => (lab(L) + (L === ship ? "*" : "")).padStart(7)).join("");
  console.log("        AT THE SHIPPED SIZE                                              |  PASS RATE BY SIZE (* shipped)");
  console.log("year    trades  /day  win%     net $   $/trade  ATRs/trade   real " + String(DAYS).padStart(2) + "d  |" + head + "   best");
  const best = {};
  for (const y of YEARS) {
    const { arr, trades } = runs.get(ship);
    const T = trades.filter((t) => yr(t.tday) === y);
    const n = T.length, net = T.reduce((s, t) => s + t.pnl, 0);
    const atrU = T.filter((t) => Number.isFinite(t.atr)).reduce((s, t) => s + t.pnl / (PV * t.lots * t.atr), 0) / Math.max(1, T.filter((t) => Number.isFinite(t.atr)).length);
    const win = (100 * T.filter((t) => t.pnl > 0).length) / Math.max(1, n);
    const ps = st.sizes.map((L) => passOn(runs.get(L).arr, IDX[y], st.rules));
    let bi = 0; ps.forEach((x, i) => { if (x.p > ps[bi].p) bi = i; });
    best[y] = st.sizes[bi];
    console.log(String(y).padEnd(6) + String(n).padStart(7) + f2(n / IDX[y].length, 6) + f1(win, 6) + sg(net, 10) + sg(n ? net / n : NaN, 10) +
                (st.day ? "".padStart(12) : f2(atrU, 12)) + f1(passOn(arr, IDX[y], st.rules).real, 11) + "  |" +
                ps.map((x) => f1(x.p, 7)).join("") + "   " + lab(st.sizes[bi]).padStart(4) + (y === 2026 ? "   <- built here" : ""));
  }
  if (st.nullSig) {
    const nulls = NULL_SEEDS.map((seed) => S.dayArr(st.trades(ship, coin(st.nullSig, seed)), S.days));
    const nyr = (ix) => nulls.reduce((s, arr) => s + passOn(arr, ix, st.rules).p, 0) / nulls.length;
    const shipArr = runs.get(ship).arr;
    st.nullYears = YEARS.map((y) => nyr(IDX[y]));
    st.nullPre = nyr(PRE);
    console.log("NULL  coin-flip direction, same everything else (mean of " + NULL_SEEDS.length + " seeds), shipped size:");
    console.log("      " + YEARS.map((y, i) => `${y} ${st.nullYears[i].toFixed(1)}`).join("   ") + `   | before 2026 ${st.nullPre.toFixed(1)}`);
    console.log("      the strategy minus the null: " + YEARS.map((y, i) => `${y} ${sg(passOn(shipArr, IDX[y], st.rules).p - st.nullYears[i], 0)}`).join("   ") +
                `   | before 2026 ${sg(passOn(shipArr, PRE, st.rules).p - st.nullPre, 0)}`);
  }
  {
    const arr = runs.get(ship).arr;
    console.log("OUTCOMES at the shipped size, of 100 evaluations: passed / hit the drawdown / ran out of days");
    console.log("      " + YEARS.map((y) => { const o = outcomes(arr, IDX[y], st.rules); return `${y} ` + [o.pass, o.fail, o.time].map((x) => Math.round(x / 120)).join("/"); }).join("   "));
  }
  // sizing outside 2026
  const compose = (pick) => S.days.map((d, k) => runs.get(yr(d) === 2026 ? ship : pick(d, k)).arr[k]);
  const volSize = (k) => { const r = trailRatio[k]; if (!Number.isFinite(r)) return ship; const L = Math.max(1, Math.min(ship, Math.round(ship * r))); return st.sizes.includes(L) ? L : ship; };
  const pol = [["shipped size", () => ship], ["best size each year (picked on the year: an upper bound)", (d) => best[yr(d)]],
               ["sized to volatility (tradeable)", (d, k) => volSize(k)]];
  console.log("   before 2026 (May 2019-Dec 2025, " + PRE.length + " sessions)                         pass   real " + DAYS + "d   |  5 years Jul 2021-Jul 2026 (with 2026 as shipped)");
  const row = {};
  for (const [lbl, pick] of pol) {
    const arr = compose(pick);
    const a = passOn(arr, PRE, st.rules), b = passOn(arr, FIVE, st.rules);
    row[lbl] = a.p;
    console.log("     " + lbl.padEnd(62) + f1(a.p) + f1(a.real, 9) + "   |  " + f1(b.p) + "  real " + f1(b.real, 5));
  }
  {
    const used = PRE.map((k) => volSize(k));
    const byY = YEARS.filter((y) => y < 2026).map((y) => { const u = IDX[y].map((k) => volSize(k)); return `${y} ${(u.reduce((s, x) => s + x, 0) / u.length).toFixed(1)}`; });
    console.log("     (sized to volatility, average lots: " + byY.join(", ") + ")");
    const arr = compose((d, k) => volSize(k));
    console.log("     sized to volatility, by year: " + YEARS.filter((y) => y < 2026).map((y) => `${y} ${passOn(arr, IDX[y], st.rules).p.toFixed(1)}`).join(", "));
  }
  const p26 = passOn(runs.get(ship).arr, IDX[2026], st.rules).p;
  summary.push({ name: st.short, p26, null26: st.nullYears ? st.nullYears[YEARS.length - 1] : NaN, nullPre: st.nullPre ?? NaN, ship: row["shipped size"], best: row["best size each year (picked on the year: an upper bound)"], vol: row["sized to volatility (tradeable)"],
                 years: YEARS.filter((y) => y < 2026).map((y) => passOn(runs.get(ship).arr, IDX[y], st.rules).p) });
  process.stderr.write(`  ${st.short} done ${((Date.now() - T0) / 1000).toFixed(0)}s\n`);
}

console.log("\n" + "=".repeat(132) + "\nSUMMARY -- pass rate of " + DAYS + "-day evaluations");
console.log("   " + "".padEnd(26) + "2026 (null)     before 2026: shipped (null)   best size/yr   to volatility  |  " + YEARS.filter((y) => y < 2026).map((y) => String(y).padStart(6)).join(""));
for (const s of summary)
  console.log("   " + s.name.padEnd(26) + f1(s.p26, 6) + (" (" + (Number.isFinite(s.null26) ? s.null26.toFixed(1) : " - ") + ")").padEnd(9) +
              f1(s.ship, 16) + (" (" + (Number.isFinite(s.nullPre) ? s.nullPre.toFixed(1) : " - ") + ")").padEnd(9) + f1(s.best, 13) + f1(s.vol, 16) +
              "  |  " + s.years.map((x) => f1(x, 6)).join(""));
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
