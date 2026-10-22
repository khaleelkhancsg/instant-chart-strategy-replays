// What time of day does each strategy work? The two shipped $1,250
// configurations -- mnqDonchian1250.js (2-min Donchian breakout, 10-min EMA
// 9/21 filter) and mnqMacdFade1250.js (1-min MACD fade of weak crosses in a
// moving market) -- by ENTRY time, 2026 only.
//
//   1. when each one signals
//   2. its edge by entry time, every signal traded (no day rules, so a later
//      trade is not hidden by the day's profit block): trades, win rate, $ a
//      trade, the same in ATRs (the open is more volatile, so dollars alone
//      flatter it), a 90% interval from resampling DAYS, and both halves of
//      2026; then the first trade of the day against the later ones
//   3. as traded under the $1,250 rules: where the trades really are
//   4. entry windows: the pass rate with entries only inside [from, until),
//      gated in the engine's sizer (a skipped signal leaves the strategy flat,
//      free to take the next), picked on one half of 2026 and read on the other
//
// RESULT (2026 only):
// MACD fade = the first half hour. Its filtered signals bunch at the open (1.64
// a day 08:30-09:00, ~0.35 by the afternoon: the volatility gate is met mostly
// at the open). Every signal traded, 08:30-09:00 makes +$79 a trade (90%
// interval +6..+151, both halves positive); the FIRST fade of the day +$91,
// later ones +$19 (-$3 before 10:00). As traded, 121 of 172 trades and +$13,945
// of +$16,131 are 08:30-09:00; the 4 trades after 10:00 lost $1,369. Starting
// late kills it: entries from 08:40 -> 46-50%, from 09:00 -> 26% (all day
// 67.7%). Stopping early changes little (until 09:00 68.6%, until 10:00 68.9%)
// and no window holds up when picked on one half and read on the other.
// Donchian = the open, then late morning; weakest 13:00-14:30. Every signal
// traded: +$33 to +$86 a trade 08:30-10:30, -$152 10:30-11:00 (10 trades),
// +$138 / +$187 11:30-12:30 (intervals above zero, both halves), -$182 / -$71 /
// -$189 13:00-14:30 (both halves negative). As traded, 58 of 128 trades and
// +$7,331 of +$9,933 are 08:30-10:00. Yet every entry window LOWERS its pass
// rate: the open is essential (from 09:00 at best 43%, from 10:00 34%) and
// cutting the afternoon costs a little (until 13:00 69.1%, until 14:00 70.1%,
// all day 71.1%) -- as traded, afternoon trades are few, about break-even, and
// come on days the morning gave nothing. Keep it on all day.
//
//   node --max-old-space-size=8192 research/time_of_day_2026.mjs

import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import { E1, t1, tf2, SIGA, ML, volRel, HTF, exit20, NODAY, in26 } from "./lib_combo.mjs";

const T0 = Date.now();
const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const FILL = { slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: 600, profitBlock: 250, cancelOpposite: true, exitFirst: true, detail: true };
const PV = 2;
const hm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const f0 = (x, w = 7) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "-").padStart(w);
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const f2 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(2) : "-").padStart(w);
const sgn = (x, w = 7) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + Math.round(x) : "-").padStart(w);
const monthOf = new Map();
for (let i = 0; i < tf2.close.length; i++) if (!monthOf.has(tf2.tday[i])) monthOf.set(tf2.tday[i], new Date(tf2.ts[i] + 43200e3).getUTCMonth());
const half = (td) => (monthOf.get(td) < 3 ? "a" : "b");

// ── the two strategies, exactly as shipped ─────────────────────────────────────
const donGate = (k) => M.RESC[k] !== 0 && HTF[k] === M.RESC[k];
const donLots = (k) => (M.adrUsed(k) >= 0.9 ? 2 : 4);
const macGate = (k) => SIGA[k] !== 0 && Math.sign(ML[k]) === SIGA[k] && !(volRel[k] < 1);
const tpFn = (a, q) => Math.min(5.15 * a, 600 / (2 * q));
const inWin = (c, w) => !w || (c >= w[0] && c < w[1]);
function runDon(opts, win = null) {
  return S.run((a, c, s, arm) => (inWin(c, win) && donGate(arm - 1) ? donLots(arm - 1) : 0),
               { signals: M.RESC, exitFn: exit20, ...opts }).filter((t) => in26(t.tday));
}
function runMac(opts, win = null) {
  return E1.run((a, c, s, arm) => (inWin(c, win) && macGate(arm - 1) ? 4 : 0),
                { signals: SIGA, trig: 0.15, tpFromFill: true, tpFn, ...opts }).filter((t) => in26(t.tday));
}
const asTradedDon = (win) => runDon({ ...FILL, breaker: 300, exitFn: exit20 }, win);
const asTradedMac = (win) => runMac({ ...FILL, breaker: 200 }, win);
function pass(trades) {
  const arr = S.dayArr(trades, S.days);
  const p = (ix) => S.passArr(ix.map((k) => arr[k]), RULES);
  const d26 = M.Y26.map((k) => arr[k]);
  let cp = 0, cn = 0;
  for (let q = 0; q + 21 <= d26.length; q++) { cp += S.evWith(d26.slice(q, q + 21), RULES); cn++; }
  return { y: p(M.Y26), a: p(M.Y26a), b: p(M.Y26b), real: (100 * cp) / cn };
}

// half-hour buckets of the entry time, 08:30-15:00 CT
const EDGES = []; for (let m = 510; m <= 900; m += 30) EDGES.push(m);
const bucketOf = (ct) => { for (let q = 0; q < EDGES.length - 1; q++) if (ct >= EDGES[q] && ct < EDGES[q + 1]) return q; return EDGES.length - 2; };
const NB = EDGES.length - 1;
const label = (q) => hm(EDGES[q]) + "-" + hm(EDGES[q + 1]);

// a 90% interval for the mean $ a trade, resampling whole DAYS (trades on a day move together)
function dayBootstrap(trades, B = 2000, seed = 11) {
  const byDay = new Map();
  for (const t of trades) { const a = byDay.get(t.tday) || []; a.push(t.pnl); byDay.set(t.tday, a); }
  const days = [...byDay.values()];
  if (days.length < 3) return [NaN, NaN];
  const rnd = S.mul(seed), means = [];
  for (let b = 0; b < B; b++) {
    let s = 0, n = 0;
    for (let d = 0; d < days.length; d++) { const x = days[Math.floor(rnd() * days.length)]; for (const v of x) { s += v; n++; } }
    means.push(s / n);
  }
  means.sort((x, y) => x - y);
  return [means[Math.floor(0.05 * B)], means[Math.floor(0.95 * B)]];
}

function edgeTable(name, trades, ctOf) {
  console.log(`\n   ${name}: ${trades.length.toLocaleString()} trades in 2026 with every signal taken`);
  console.log("   entry (CT)      trades  /day  win%   $/trade   90% interval      ATRs/trade   Jan-Mar  Apr-Jul    total $");
  const rows = [];
  for (let q = 0; q < NB; q++) {
    const T = trades.filter((t) => bucketOf(ctOf(t)) === q);
    if (!T.length) { console.log("   " + label(q).padEnd(14) + "      0"); continue; }
    const n = T.length, tot = T.reduce((s, t) => s + t.pnl, 0), win = (100 * T.filter((t) => t.pnl > 0).length) / n;
    const atr = T.reduce((s, t) => s + t.pnl / (PV * t.lots * t.atr), 0) / n;
    const A = T.filter((t) => half(t.tday) === "a"), Bh = T.filter((t) => half(t.tday) === "b");
    const ma = A.reduce((s, t) => s + t.pnl, 0) / Math.max(1, A.length), mb = Bh.reduce((s, t) => s + t.pnl, 0) / Math.max(1, Bh.length);
    const [lo, hi] = dayBootstrap(T);
    rows.push({ q, n, mean: tot / n, lo, hi, ma, mb, tot, atr });
    console.log("   " + label(q).padEnd(14) + String(n).padStart(7) + f2(n / M.Y26.length, 6) + f1(win, 6) + sgn(tot / n, 10) +
                ("  [" + sgn(lo, 5) + "," + sgn(hi, 5) + "]").padEnd(18) + f2(atr, 9) + "   " + sgn(A.length ? ma : NaN, 7) + sgn(Bh.length ? mb : NaN, 9) + f0(tot, 11));
  }
  return rows;
}

console.log("=".repeat(118));
console.log("TIME OF DAY -- the shipped $1,250 Donchian and MACD fade, by ENTRY time (Chicago), 2026 only");
console.log("=".repeat(118));

// ── 1. when each one signals ──────────────────────────────────────────────────────
console.log("\n1. WHEN EACH ONE SIGNALS (signals a day in each half hour, 2026)");
{
  const nd = M.Y26.length;
  const cnt = (T, sig, gate) => {
    const raw = new Array(NB).fill(0), ok = new Array(NB).fill(0);
    for (let k = 0; k < T.close.length; k++) {
      if (!in26(T.tday[k]) || sig[k] === 0 || T.ctMin[k] < 510 || T.ctMin[k] >= 900) continue;
      const q = bucketOf(T.ctMin[k]); raw[q]++; if (gate(k)) ok[q]++;
    }
    return { raw, ok };
  };
  const d = cnt(tf2, M.RESC, donGate), m = cnt(t1, SIGA, macGate);
  console.log("   " + "".padEnd(14) + "   Donchian: breakouts  with the 10-min EMA      MACD: crosses  weak, moving market");
  for (let q = 0; q < NB; q++)
    console.log("   " + label(q).padEnd(14) + f2(d.raw[q] / nd, 18) + f2(d.ok[q] / nd, 21) + f2(m.raw[q] / nd, 21) + f2(m.ok[q] / nd, 20));
}

// ── 2. edge by entry time, every signal taken ─────────────────────────────────────────
console.log("\n2. THE EDGE BY ENTRY TIME, every signal traded (no day rules; one position at a time; 1 tick + $0.75 a side)");
const donAll = runDon(NODAY), macAll = runMac(NODAY);
const ctD = (t) => tf2.ctMin[t.entBar], ctM = (t) => t1.ctMin[t.entBar];
const donRows = edgeTable("DONCHIAN (2-min, entry = the stop-entry fill)", donAll, ctD);
const macRows = edgeTable("MACD FADE (1-min, entry = the stop-entry fill)", macAll, ctM);

console.log("\n   the first trade of the day against the later ones ($ a trade, trades)");
for (const [name, T, ctOf] of [["Donchian", donAll, ctD], ["MACD", macAll, ctM]]) {
  const seen = new Set(), first = [], later = [];
  for (const t of T) { if (seen.has(t.tday)) later.push(t); else { seen.add(t.tday); first.push(t); } }
  const m = (x) => (x.length ? x.reduce((s, t) => s + t.pnl, 0) / x.length : NaN);
  const early = (x) => x.filter((t) => ctOf(t) < 600), late = (x) => x.filter((t) => ctOf(t) >= 600);
  console.log(`   ${name.padEnd(9)} first ${sgn(m(first))} (${first.length})   later ${sgn(m(later))} (${later.length})` +
              `   |  before 10:00: first ${sgn(m(early(first)))} (${early(first).length}), later ${sgn(m(early(later)))} (${early(later).length})` +
              `   from 10:00: first ${sgn(m(late(first)))} (${late(first).length}), later ${sgn(m(late(later)))} (${late(later).length})`);
}

// ── 3. as traded ────────────────────────────────────────────────────────────────────────
console.log("\n3. AS TRADED under the $1,250 rules (day rules on: the first win or loss usually ends the day)");
const donT = asTradedDon(null), macT = asTradedMac(null);
const pD = pass(donT), pM = pass(macT);
console.log(`   check: Donchian ${pD.y.toFixed(1)}% (${pD.a.toFixed(1)} / ${pD.b.toFixed(1)}), MACD ${pM.y.toFixed(1)}% (${pM.a.toFixed(1)} / ${pM.b.toFixed(1)}) -- the shipped numbers`);
console.log("   entry (CT)          Donchian: trades  win%  $/trade  total $        MACD: trades  win%  $/trade  total $");
for (let q = 0; q < NB; q++) {
  const row = (T, ctOf) => {
    const X = T.filter((t) => bucketOf(ctOf(t)) === q);
    if (!X.length) return "".padStart(37);
    const tot = X.reduce((s, t) => s + t.pnl, 0);
    return String(X.length).padStart(14) + f1((100 * X.filter((t) => t.pnl > 0).length) / X.length, 6) + sgn(tot / X.length, 9) + f0(tot, 9);
  };
  console.log("   " + label(q).padEnd(14) + row(donT, ctD) + "     " + row(macT, ctM));
}
{
  const share = (T, ctOf, from, until) => {
    const X = T.filter((t) => ctOf(t) >= from && ctOf(t) < until);
    return `${X.length} trades, ${sgn(X.reduce((s, t) => s + t.pnl, 0), 0)}`;
  };
  console.log(`   Donchian: 08:30-10:00 ${share(donT, ctD, 510, 600)};  10:00-12:00 ${share(donT, ctD, 600, 720)};  12:00-15:00 ${share(donT, ctD, 720, 900)}`);
  console.log(`   MACD:     08:30-09:00 ${share(macT, ctM, 510, 540)};  09:00-10:00 ${share(macT, ctM, 540, 600)};  10:00-15:00 ${share(macT, ctM, 600, 900)}`);
}

// ── 4. entry windows ────────────────────────────────────────────────────────────────────
console.log("\n4. ENTRY WINDOWS -- the pass rate with new entries only inside [from, until) (2026 / Jan-Mar / Apr-Jul, real windows)");
function windowGrid(name, run, froms, untils, base) {
  const res = [];
  for (const a of froms) for (const b of untils) if (b > a + 20) res.push({ w: [a, b], r: pass(run([a, b])) });
  res.sort((x, y) => y.r.y - x.r.y);
  console.log(`\n   ${name}: all day ${base.y.toFixed(1)}% (${base.a.toFixed(1)} / ${base.b.toFixed(1)}), real ${base.real.toFixed(1)}%;  best of ${res.length} windows:`);
  for (const x of res.slice(0, 6))
    console.log("     " + (hm(x.w[0]) + "-" + hm(x.w[1])).padEnd(14) + f1(x.r.y) + " (" + x.r.a.toFixed(1) + " / " + x.r.b.toFixed(1) + ")  real " + x.r.real.toFixed(1));
  console.log("   every window, 2026 pass rate (rows: from, columns: until):");
  console.log("     " + "".padEnd(7) + untils.map((b) => hm(b).padStart(7)).join(""));
  for (const a of froms) console.log("     " + hm(a).padEnd(7) + untils.map((b) => { const x = res.find((y) => y.w[0] === a && y.w[1] === b); return x ? f1(x.r.y, 7) : "".padStart(7); }).join(""));
  for (const [fit, test, fl, tl] of [["a", "b", "Jan-Mar", "Apr-Jul"], ["b", "a", "Apr-Jul", "Jan-Mar"]]) {
    const pick = res.slice().sort((x, y) => y.r[fit] - x.r[fit])[0];
    console.log(`   picked on ${fl}: ${hm(pick.w[0])}-${hm(pick.w[1])} -> ${pick.r[test].toFixed(1)}% on ${tl} (all day: ${base[test].toFixed(1)}%)`);
  }
  return res;
}
const donWins = windowGrid("DONCHIAN", asTradedDon, [510, 540, 570, 600, 630, 660], [600, 660, 720, 780, 840, 900], pD);
const macWins = windowGrid("MACD FADE", asTradedMac, [510, 520, 530, 540], [540, 555, 570, 600, 630, 660, 720, 900], pM);

console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
