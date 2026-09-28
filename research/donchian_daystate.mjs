// Two kinds of context nothing else here reads, weighted to 2026 as asked.
//
//   DAY STATE  what the book did on the previous day(s). The account dies on
//              its trailing drawdown, and two -$1,000 cap days nearly spend it,
//              so: trade smaller, or not at all, the day after a cap day, after
//              any losing day, after two losing days in a row -- and the
//              opposite, after a big winning day.
//   CALENDAR   monthly options expiry (third Friday) and the day before it,
//              when pinning can make breakouts fail; the first and last
//              trading days of the month; Mondays and Fridays.
//
// Each rule acts through the size of every arm on the affected day. Scored on
// 2026 (and its two halves, and with its best three days put back), with 2025
// and the full history for context, against skipping RANDOM days at the same
// rate.
//
// RESULT: nothing. Protecting the account after a bad day backfires -- the day
// after a -$1,000 cap day is a GOOD day for this book, and skipping it costs
// 17.2pp in 2026 (half size -7.9). Calendar rules are within noise (options
// expiry +0.8). The null is the useful number: skipping random whole days
// reaches +15.9 in 2026 by luck and passes the inside-2026 test 8-18% of the
// time, which is the bar any 2026 result here has to be read against.
//
//   node --max-old-space-size=8192 research/donchian_daystate.mjs

import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const { tf } = M;
const { ctMin: CT, tday: TD, ts: TS } = tf;
const n2 = TD.length;
const days = M.days, dayPos = new Map(days.map((d, k) => [d, k]));
// the calendar date of each session, from its first RTH bar
const cal = new Map();
for (let i = 0; i < n2; i++) if (CT[i] >= 510 && CT[i] < 900 && !cal.has(TD[i])) {
  const t = new Date(TS[i]); cal.set(TD[i], { dow: t.getUTCDay(), dom: t.getUTCDate(), mon: t.getUTCMonth(), yr: t.getUTCFullYear() });
}
const opex = (d) => { const c = cal.get(d); return !!c && c.dow === 5 && c.dom >= 15 && c.dom <= 21; };
const nextIs = (d, f) => { const k = dayPos.get(d); return k != null && k + 1 < days.length && f(days[k + 1]); };
const firstOfMonth = (d) => { const k = dayPos.get(d), c = cal.get(d), p = cal.get(days[k - 1]); return !!c && (!p || p.mon !== c.mon); };
const lastOfMonth = (d) => { const k = dayPos.get(d), c = cal.get(d), q = cal.get(days[k + 1]); return !!c && (!q || q.mon !== c.mon); };

const live = M.evalCfg(M.LIVE);
const at = (arr, ix) => S.passArr(ix.map((k) => arr[k]));
const sg = (x) => ((x >= 0 ? "+" : "") + x.toFixed(1)).padStart(6);
function withBest3Back(r) {
  const best = M.Y26.map((k) => [k, r.arr[k] - live.arr[k]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const a = Float64Array.from(r.arr); for (const [k] of best) a[k] = live.arr[k];
  return at(a, M.Y26) - live.y26;
}
// run with a per-day lot rule that can read the book's own previous days
function evalDayRule(lotsFor) {
  const dayPnl = new Map();
  const opts = { ...M.build(M.LIVE), onTrade: (t) => dayPnl.set(t.tday, (dayPnl.get(t.tday) || 0) + t.pnl) };
  const prev = (d, back) => { const k = dayPos.get(d); return k - back >= 0 ? dayPnl.get(days[k - back]) ?? 0 : 0; };
  const r = M.evalOpts(opts, (a, ct, seq, arm) => lotsFor(TD[arm], prev));
  r.j3 = withBest3Back(r);
  return r;
}
function row(label, r, affected) {
  const ok = r.y26 > live.y26 && r.a26 >= live.a26 && r.b26 >= live.b26 && r.j3 > 0 ? "  <- holds up inside 2026" : "";
  console.log("  " + label.padEnd(56) + (affected ?? "").toString().padStart(7) + sg(r.y26 - live.y26) + sg(r.a26 - live.a26) +
    sg(r.b26 - live.b26) + sg(r.j3).padStart(10) + sg(r.y25 - live.y25).padStart(8) + sg(r.all - live.all).padStart(7) + ok);
}
console.log("\n  Live: 2026 " + live.y26.toFixed(1) + "% (Jan-Mar " + live.a26.toFixed(1) + ", Apr-Jul " + live.b26.toFixed(1) +
  "), 2025 " + live.y25.toFixed(1) + "%, all " + live.all.toFixed(1) + "%");
console.log("\n  " + "rule".padEnd(56) + "days*".padStart(7) + "  d2026 JanMar AprJul best3back   d2025   dAll");
console.log("  (* 2026 sessions the rule changes the size on, where it can be counted in advance)");

console.log("\n  DAY STATE -- sized on what the book did the previous day(s)");
const cap = (v) => v <= -900;
for (const [nm, lots] of [["skip", 0], ["half size", 4], ["6 lots", 6]]) {
  row(nm + " the day after a -$1,000 cap day", evalDayRule((d, prev) => (cap(prev(d, 1)) ? lots : 8)));
  row(nm + " the day after any losing day", evalDayRule((d, prev) => (prev(d, 1) < 0 ? lots : 8)));
  row(nm + " after two losing days in a row", evalDayRule((d, prev) => (prev(d, 1) < 0 && prev(d, 2) < 0 ? lots : 8)));
  row(nm + " the day after a +$700 day", evalDayRule((d, prev) => (prev(d, 1) >= 700 ? lots : 8)));
}

console.log("\n  CALENDAR");
const cnt26 = (f) => days.filter((d) => S.yearOf.get(d) === 2026 && f(d)).length;
for (const [nm, f] of [["monthly options expiry (3rd Friday)", opex], ["the day before options expiry", (d) => nextIs(d, opex)],
                       ["first trading day of the month", firstOfMonth], ["last trading day of the month", lastOfMonth],
                       ["Mondays", (d) => cal.get(d)?.dow === 1], ["Fridays", (d) => cal.get(d)?.dow === 5]])
  for (const [kn, lots] of [["skip", 0], ["half size", 4]])
    row(kn + " on " + nm, evalDayRule((d) => (f(d) ? lots : 8)), cnt26(f));

console.log("\n  NULL -- skip RANDOM whole days, 50 draws each, at the rates the rules above use");
{
  const hash = (k, s) => { let x = (k * 2654435761 + s * 97531) >>> 0; x ^= x >>> 16; x = Math.imul(x, 2246822507) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };
  for (const rate of [0.05, 0.2, 0.4]) {
    const d26 = [];
    let pass = 0;
    for (let s = 1; s <= 50; s++) {
      const r = evalDayRule((d) => (hash(d, s) < rate ? 0 : 8));
      d26.push(r.y26 - live.y26);
      if (r.y26 > live.y26 && r.a26 >= live.a26 && r.b26 >= live.b26 && r.j3 > 0) pass++;
    }
    d26.sort((a, b) => a - b);
    console.log("    skip " + (100 * rate).toFixed(0).padStart(2) + "% of days at random: 2026 change median " + sg(d26[25]).trim() +
      ", 90th pct " + sg(d26[45]).trim() + ", max " + sg(d26[49]).trim() + "; hold up inside 2026 " + pass + "/50");
  }
}
