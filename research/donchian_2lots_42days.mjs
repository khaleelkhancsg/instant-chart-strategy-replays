// The $1,250 Donchian with 2 lots on every trade, on 42-day evaluations.
//
// Everything else as shipped (the TopstepX bot's config): RESC signals gated by
// the 10-min EMA 9/21, 40-minute exit, 5 ATR stop cut at the $600 day limit,
// 1.75 ATR target, -$300 breaker, +$250 profit block, honest fills and costs.
// Rules: $1,250 target, $1,000 trailing drawdown (locks at breakeven once the
// peak reaches $1,000), 50% consistency, and 42 trading days instead of 21.
// Sizes compared: the shipped 4 lots (2 once the day has used 0.9 of its
// average range), 2 lots on every trade, and 2 lots halved to 1 late.
//
// RESULT: on history 2 lots passes LESS, and fails on the drawdown MORE:
//                            42 days: 2026 (Jan-Mar / Apr-Jul)  real   before 2026  real  |  21 days: 2026  before
//   shipped: 4 lots, 2 late           75.7 (87.1 / 78.7)        72.4      45.2      37.4  |           71.1    36.0
//   2 lots on every trade             54.0 (47.7 / 62.3)        43.9      34.6      30.5  |           38.5    16.3
//   2 lots, 1 late                    53.9 (44.5 / 64.9)        39.8      30.9      26.4  |           33.9    12.3
// Of 100 42-day evaluations in 2026: 4 lots 76 passed / 24 hit the drawdown / 0
// ran out of days (passing on day 10); 2 lots 54 / 43 / 3 (day 15). Before 2026
// 45 / 54 / 1 against 35 / 50 / 16. Lower in every year but 2021 (49.7 vs 42.0).
// At 2 lots the $600 line sits 150 points out, so most trades get the full 5 ATR
// stop (cut on 35% of 2026's, against 78%) -- and as full_stop_sizing.mjs found,
// that costs edge: +$21 a trade against +$78 (+$10 a lot against +$23). Days
// shrink (green +$253 / red -$275, against +$359 / -$401) but the thinner edge
// drifts into the $1,000 trailing drawdown more often. The extra 21 days help 2
// lots most (+15.5 points in 2026, against +4.6), not enough. Edge over the
// coin-flip twin at 42 days: +32 (2026) / +19 (before), against +44 / +21.
// Forward, Sep 1-Oct 22 2026 (bot/forward_fixed_lots.py; 38 sessions, so no
// 42-day evaluation has finished), 2 lots came out ahead: +$1,878 against
// +$1,484, and of evaluations started on each session 20 passed / 0 failed / 18
// still open against 19 / 13 / 6. Oct 14 decided most of it: the 4-lot short
// was stopped at the line (75 points) in 4 minutes, then -$600 again on Oct 15,
// failing every start from Sep 29; at 2 lots the line was 150 points out and the
// same short reached its target (+$353 day). Of every 38-day stretch, 2 lots
// had fewer failures and as many passes in 0% of 2026's and 29% of 2019-2025's
// -- partly slowness: 2 lots leaves more evaluations open (median failures per
// stretch, 4 lots | 2 lots: 2026 3 | 15, before 14 | 0).
//
//   node --max-old-space-size=8192 research/donchian_2lots_42days.mjs

import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import { HTF, exit20 } from "./lib_combo.mjs";

const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const F = { slipMult: 1, feeMult: 1, limitFillTp: "close", cancelOpposite: true, exitFirst: true,
            dayCap: 600, breaker: 300, profitBlock: 250, exitFn: exit20 };
const yr = (td) => S.yearOf.get(td);
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const sg = (x, w = 7) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + Math.round(x).toLocaleString("en-US") : "-").padStart(w);
const pct = (n, d) => (d ? (100 * n) / d : NaN);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const IX = (f) => S.days.map((d, k) => (f(d, k) ? k : -1)).filter((k) => k >= 0);
const Y26 = IX((d) => yr(d) === 2026), PRE = IX((d) => yr(d) < 2026);
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];

const donGate = (k) => M.RESC[k] !== 0 && HTF[k] === M.RESC[k];
const book = (L, late, sig = M.RESC) => S.run((a, c, s, arm) => (donGate(arm - 1) ? (M.adrUsed(arm - 1) >= 0.9 ? late : L) : 0), { signals: sig, ...F });
const SIZES = [["shipped: 4 lots, 2 late", 4, 2], ["2 lots on every trade", 2, 2], ["2 lots, 1 late", 2, 1]];

// of S.passArr's own draws (12,000, seed 4242, 5-day blocks): passed / hit the drawdown / ran out of days, and when
function outcomes(arr, ix, days) {
  const v = ix.map((k) => arr[k]), n = v.length, rnd = S.mul(4242), o = { pass: 0, fail: 0, time: 0, passDay: [], failDay: [], endPnl: [] };
  if (n < days + 4) return null;
  for (let d = 0; d < 12000; d++) {
    const buf = [];
    while (buf.length < days) { const st = Math.floor(rnd() * Math.max(1, n - 5)); for (let j = 0; j < 5 && buf.length < days; j++) buf.push(v[(st + j) % n]); }
    let c = 0, pk = 0, lk = false, md = -1e18, r = "time", at = days;
    for (let k = 0; k < buf.length; k++) {
      const x = buf[k];
      c += x; if (x > md) md = x;
      if (c <= (lk ? 0 : pk - RULES.dd)) { r = "fail"; at = k + 1; break; }
      if (c > pk) pk = c;
      if (!lk && pk >= RULES.dd) lk = true;
      if (c >= RULES.target && md <= RULES.consistency * c) { r = "pass"; at = k + 1; break; }
    }
    o[r]++;
    if (r === "pass") o.passDay.push(at); else if (r === "fail") o.failDay.push(at); else o.endPnl.push(c);
  }
  return o;
}
const realRate = (arr, ix, days) => { let p = 0, n = 0; for (let s = 0; s + days <= ix.length; s++, n++) p += S.evWith(ix.slice(s, s + days).map((k) => arr[k]), RULES); return { p: pct(p, n), n }; };
const passD = (arr, ix, days) => (ix.length < days + 4 ? NaN : S.passArr(ix.map((k) => arr[k]), { ...RULES, window: days }));

console.log("=".repeat(124));
console.log("THE $1,250 DONCHIAN AT 2 LOTS ON EVERY TRADE, 42-DAY EVALUATIONS (21 for reference) -- everything else as shipped");
console.log("=".repeat(124));
const res = SIZES.map(([name, L, late]) => { const tr = book(L, late); return { name, L, late, tr, arr: S.dayArr(tr, S.days) }; });

console.log("\n1. PASS RATE             42 days: 2026 (Jan-Mar / Apr-Jul)  real windows   before 2026  real windows  |  21 days: 2026  before");
for (const r of res) {
  const r26 = realRate(r.arr, Y26, 42), rpre = realRate(r.arr, PRE, 42);
  console.log("   " + r.name.padEnd(24) + f1(passD(r.arr, Y26, 42), 15) + " (" + passD(r.arr, M.Y26a, 42).toFixed(1) + " / " + passD(r.arr, M.Y26b, 42).toFixed(1) + ")" +
              f1(r26.p, 10) + ` of ${r26.n}` + f1(passD(r.arr, PRE, 42), 12) + f1(rpre.p, 10) + ` of ${rpre.n}` +
              "  |" + f1(passD(r.arr, Y26, 21), 14) + f1(passD(r.arr, PRE, 21), 8));
}
console.log("\n   42-day pass rate by year:   " + YEARS.map((y) => String(y).padStart(7)).join("") + "    2026");
for (const r of res) console.log("   " + r.name.padEnd(28) + YEARS.map((y) => f1(passD(r.arr, IX((d) => yr(d) === y), 42), 7)).join("") + f1(passD(r.arr, Y26, 42), 8));

console.log("\n2. HOW 42-DAY EVALUATIONS END (of 100): passed / hit the drawdown / ran out of days; median days to pass and to fail; P&L when time ran out");
for (const [label, ix] of [["2026", Y26], ["before 2026", PRE]]) {
  for (const r of res) {
    const o = outcomes(r.arr, ix, 42);
    console.log(`   ${label.padEnd(12)} ${r.name.padEnd(24)} ${(o.pass / 120).toFixed(0).padStart(3)} / ${(o.fail / 120).toFixed(0).padStart(3)} / ${(o.time / 120).toFixed(0).padStart(3)}` +
                `     pass on day ${String(med(o.passDay)).padStart(2)}, fail on day ${String(med(o.failDay)).padStart(2)}` +
                `     out of days: median ${sg(med(o.endPnl), 6)}, ${pct(o.endPnl.filter((x) => x >= 1250).length, o.endPnl.length).toFixed(0)}% of them past $1,250 but held back by the consistency rule`);
  }
}

console.log("\n3. THE TRADES AND DAYS, 2026 | before 2026        trades  avg lots  $/trade     net $  stop cut  days at -$600  best day  avg green / red day");
for (const [label, P] of [["2026", (t) => yr(t.tday) === 2026], ["before 2026", (t) => yr(t.tday) < 2026]]) {
  const ix = label === "2026" ? Y26 : PRE;
  for (const r of res) {
    const T = r.tr.filter(P), n = T.length;
    let day = -1, real = 0, cut = 0;
    for (const t of T) { if (t.tday !== day) { day = t.tday; real = 0; } if ((600 + real) / (2 * t.lots) < 5.15 * t.atr + 0.25) cut++; real += t.pnl; }
    const dv = ix.map((k) => r.arr[k]), g = dv.filter((x) => x > 0), rd = dv.filter((x) => x < 0);
    console.log(`   ${label.padEnd(12)} ${r.name.padEnd(28)} ${String(n).padStart(6)} ${f1(T.reduce((s, t) => s + t.lots, 0) / n, 9)} ${sg(T.reduce((s, t) => s + t.pnl, 0) / n, 8)}` +
                ` ${sg(T.reduce((s, t) => s + t.pnl, 0), 9)} ${f1(pct(cut, n), 8)}% ${String(dv.filter((x) => x <= -599.5).length).padStart(13)}` +
                ` ${sg(Math.max(...dv), 9)}   ${sg(g.reduce((s, x) => s + x, 0) / g.length, 6)} / ${sg(rd.reduce((s, x) => s + x, 0) / rd.length, 0)}`);
  }
}

// 4. the forward check's view (bot/forward_fixed_lots.py), on history: in every 38-day stretch,
// an evaluation started on each day and run to the stretch's end -- passed, failed or still open
function starts(arr, st) {
  const o = { pass: 0, fail: 0, open: 0 };
  for (let s = 0; s < st.length; s++) {
    let c = 0, pk = 0, lk = false, md = -1e18, r = "open";
    for (let k = s; k < st.length; k++) {
      const x = arr[st[k]];
      c += x; if (x > md) md = x;
      if (c <= (lk ? 0 : pk - RULES.dd)) { r = "fail"; break; }
      if (c > pk) pk = c;
      if (!lk && pk >= RULES.dd) lk = true;
      if (c >= RULES.target && md <= RULES.consistency * c) { r = "pass"; break; }
    }
    o[r]++;
  }
  return o;
}
console.log("\n4. EVERY 38-DAY STRETCH, an evaluation started on each day and run to the stretch's end (Sep 1-Oct 22 2026: 4 lots 19 passed / 13 failed,");
console.log("   2 lots 20 / 0): how often 2 lots on every trade had fewer failures and at least as many passes; median failures of 38, 4 lots | 2 lots");
for (const [label, ix] of [["2026", Y26], ["before 2026", PRE]]) {
  let n = 0, fewer = 0, both = 0, zero = 0;
  const fa = [], fb = [];
  for (let s = 0; s + 38 <= ix.length; s++) {
    const st = ix.slice(s, s + 38), a = starts(res[0].arr, st), b = starts(res[1].arr, st);
    n++; if (b.fail < a.fail) fewer++; if (b.fail < a.fail && b.pass >= a.pass) both++; if (b.fail === 0 && a.fail >= 13) zero++;
    fa.push(a.fail); fb.push(b.fail);
  }
  console.log(`   ${label.padEnd(12)} ${n} stretches: fewer failures in ${f1(pct(fewer, n), 0)}%, fewer failures and as many passes in ${f1(pct(both, n), 0)}%,` +
              ` none failed at 2 lots while 13+ failed at 4 in ${f1(pct(zero, n), 0)}%;  median failures ${med(fa)} | ${med(fb)}`);
}

// 5. the coin-flip twin at 42 days: each traded signal's direction random, everything else the same
console.log("\n5. EDGE: the coin-flip twin (8 seeds), 42 days           2026: strategy / twin / edge     before 2026: strategy / twin / edge");
for (const r of res.slice(0, 2)) {
  const twins = [101, 202, 303, 404, 505, 606, 707, 808].map((seed) => {
    const rnd = S.mul(seed), sig = new Int8Array(M.RESC.length);
    for (let k = 0; k < sig.length; k++) if (M.RESC[k] !== 0) sig[k] = rnd() < 0.5 ? 1 : -1;
    return S.dayArr(book(r.L, r.late, sig), S.days);
  });
  const tw = (ix) => twins.reduce((s, a) => s + passD(a, ix, 42), 0) / twins.length;
  const [a, b] = [passD(r.arr, Y26, 42), passD(r.arr, PRE, 42)], [ta, tb] = [tw(Y26), tw(PRE)];
  console.log("   " + r.name.padEnd(52) + f1(a, 8) + " /" + f1(ta, 5) + " /" + sg(a - ta, 5) + f1(b, 20) + " /" + f1(tb, 5) + " /" + sg(b - tb, 5));
}
