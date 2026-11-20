// 2026's most volatile day, traded at 1 to 8 lots under each eval's limits.
//
// The person's question (2026-11-20): is 5 lots far too much for a $600 or $1,000 daily
// limit when one MNQ ranges several hundred dollars in New York's first hours? So this
// takes the day with 2026's widest New York session (08:30-15:00 CT) and shows:
//   - how far one MNQ moved that day, and in its fastest minutes;
//   - every trade the two live Donchian bots took that day, under each eval's own day
//     rules, at 1-8 lots: the stop in points and dollars, the worst dip, the result;
//   - what the day did to each account, against its daily limit and drawdown.
// The bots are intraday-only and their day rules reset each session, so a day's trades
// do not depend on what came before it.
//
// RESULT (2026-11-20):
//   - The day: 2026-06-09 had 2026's widest New York session, 1,620 points or $3,240 a
//     contract. Its first two hours ran 999 points, its biggest 1-minute bar 222 and its
//     fastest five minutes 326. The median 2026 session is 358 points.
//   - The bots' 5-ATR stops were 320-410 points that day. Above a lot or two, the daily
//     limit was the real stop: $600 is 60 points away at 5 lots, and $1,000 is 63 at 8.
//   - Their 11:04 CT short made +$1,267 at 5 lots on the $3,000 eval, but lost $1,000 at
//     8, where its entry bar reached the line.
//   - Days in 2026 that end at the daily limit:
//       the $1,250 bot on $1,250  0% at 1 lot, 5% at 2, 17% at 4, 26% at 5, 46% at 8
//       the $3,000 bot on $3,000  0% at 1 lot, 1% at 2, 19% at 4, 28% at 5, 41% at 8
//
//   node --max-old-space-size=8192 research/eval_volatile_day.mjs [YYYY-MM-DD]

import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { configOf } from "./lib_eval1250.mjs";

const DAY = 86400000, FB = loadBars("data/mnq_1m_beta.bin").bars;
const Y26 = Date.UTC(2026, 0, 1), iso = (d) => new Date(d * DAY).toISOString().slice(0, 10);
const ct = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const usd = (x) => `${x < 0 ? "-" : ""}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;

// Every 2026 session's New York range, and its first two hours'.
const days = new Map();
for (let i = indexAtOrAfter(FB.ts, Y26); i < FB.count; i++) {
  const m = FB.ctMin[i];
  if (m < 510 || m >= 900) continue;
  let d = days.get(FB.tday[i]);
  if (!d) days.set(FB.tday[i], (d = { tday: FB.tday[i], hi: -Infinity, lo: Infinity, hi2: -Infinity, lo2: Infinity, first: i, last: i }));
  d.hi = Math.max(d.hi, FB.high[i]); d.lo = Math.min(d.lo, FB.low[i]); d.last = i;
  if (m < 630) { d.hi2 = Math.max(d.hi2, FB.high[i]); d.lo2 = Math.min(d.lo2, FB.low[i]); }
}
const all = [...days.values()].map((d) => ({ ...d, range: d.hi - d.lo, range2: d.hi2 - d.lo2 }));
const byRange = all.slice().sort((a, b) => b.range - a.range), by2h = all.slice().sort((a, b) => b.range2 - a.range2);
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
console.log(`2026 New York sessions (08:30-15:00 CT): ${all.length}; median range ${Math.round(med(all.map((d) => d.range)))} points ` +
            `(${usd(2 * med(all.map((d) => d.range)))} a contract), first two hours ${Math.round(med(all.map((d) => d.range2)))}`);
console.log("Widest sessions:      " + byRange.slice(0, 5).map((d) => `${iso(d.tday)} ${Math.round(d.range)} pts`).join(", "));
console.log("Widest first 2 hours: " + by2h.slice(0, 5).map((d) => `${iso(d.tday)} ${Math.round(d.range2)} pts`).join(", "));

const arg = process.argv[2];
const D = arg ? all.find((d) => iso(d.tday) === arg) : byRange[0];
if (!D) throw new Error(`no 2026 session on ${arg}`);

// That day minute by minute: the biggest bars and the fastest five minutes.
let big1 = 0, big1At = 0, fast5 = 0, fast5At = 0;
for (let i = D.first; i <= D.last; i++) {
  const r = FB.high[i] - FB.low[i]; if (r > big1) { big1 = r; big1At = FB.ctMin[i]; }
  if (i + 4 <= D.last) {
    let h = -Infinity, l = Infinity; for (let k = i; k <= i + 4; k++) { h = Math.max(h, FB.high[k]); l = Math.min(l, FB.low[k]); }
    if (h - l > fast5) { fast5 = h - l; fast5At = FB.ctMin[i]; }
  }
}
console.log(`\n${iso(D.tday)}: New York range ${Math.round(D.range)} points (${Math.round(D.lo)}-${Math.round(D.hi)}), ${usd(2 * D.range)} a contract;` +
            ` first two hours ${Math.round(D.range2)} points (${usd(2 * D.range2)} a contract)`);
console.log(`  biggest 1-minute bar ${Math.round(big1)} points at ${ct(big1At)} CT (${usd(2 * big1)} a contract); fastest 5 minutes ${Math.round(fast5)} points from ${ct(fast5At)} CT (${usd(2 * fast5)} a contract)`);
console.log("  what that day's moves cost per contract count:");
for (const lots of [1, 2, 3, 4, 5, 6, 8]) {
  console.log(`    ${lots} lot${lots > 1 ? "s" : " "}: the range ${usd(2 * lots * D.range).padStart(7)}, first two hours ${usd(2 * lots * D.range2).padStart(7)}, fastest 5 minutes ${usd(2 * lots * fast5).padStart(6)};` +
              ` the $600 limit is ${Math.round(600 / (2 * lots))} points away, the $1,000 limit ${Math.round(1000 / (2 * lots))}`);
}

// The whole of 2026 at each size: how often a day reaches the daily limit, and the worst day.
console.log("\nAll of 2026 at each size: days that reached the daily limit, and the worst day (live equity)");
const y26 = sliceBars(FB, indexAtOrAfter(FB.ts, Y26 - 60 * DAY), FB.count);
for (const [id, name] of [["donchian_1250", "the $1,250 bot"], ["donchian_shipped", "the $3,000 bot"]]) {
  for (const [ev, evName, limit] of [["1250", "$1,250", 600], ["3000", "$3,000", 1000]]) {
    const cfg = await configOf(id, {}, ev), cells = [];
    for (const lots of [1, 2, 3, 4, 5, 6, 8]) {
      const tr = runStrategy(y26, cfg.s, cfg.params, { ...cfg.exec, contracts: lots }, { filter: cfg.filter, studies: cfg.studies, fromMs: Y26 }).trades;
      const byDay = new Map();
      for (const t of tr) { const d = byDay.get(t.tday) || { pnl: 0, worst: 0 }; d.worst = Math.min(d.worst, d.pnl + t.mae); d.pnl += t.pnl; byDay.set(t.tday, d); }
      const ds = [...byDay.values()], hit = ds.filter((d) => d.pnl <= -limit + 25).length;
      cells.push(`${lots}: ${hit}/${ds.length} days, worst ${usd(Math.min(...ds.map((d) => d.pnl)))}`);
    }
    console.log(`  ${name} on the ${evName} eval (limit ${usd(limit)}): ${cells.join(" | ")}`);
  }
}

// The bots that day, each eval's own rules, at 1-8 lots.
const from = D.tday * DAY - 2 * DAY, bars = sliceBars(FB, indexAtOrAfter(FB.ts, from - 60 * DAY), FB.count);
for (const [id, name] of [["donchian_1250", "The $1,250 bot"], ["donchian_shipped", "The $3,000 bot"]]) {
  for (const [ev, evName, limit, dd] of [["1250", "$1,250 eval", 600, 1000], ["3000", "$3,000 eval", 1000, 2000]]) {
    const cfg = await configOf(id, {}, ev);
    console.log(`\n${name} on the ${evName} (its own size ${cfg.exec.contracts} lots; daily limit ${usd(limit)}, drawdown ${usd(dd)})`);
    for (const lots of [1, 2, 3, 4, 5, 6, 8]) {
      const tr = runStrategy(bars, cfg.s, cfg.params, { ...cfg.exec, contracts: lots }, { filter: cfg.filter, studies: cfg.studies, fromMs: from })
        .trades.filter((t) => t.tday === D.tday);
      const day = tr.reduce((a, t) => a + t.pnl, 0);
      let run = 0, worst = 0;   // the day's worst point on live equity
      for (const t of tr) { worst = Math.min(worst, run + t.mae); run += t.pnl; }
      console.log(`  ${lots} lot${lots > 1 ? "s" : " "}: ${tr.length} trade${tr.length === 1 ? "" : "s"}, day ${usd(day).padStart(7)}, worst point ${usd(worst).padStart(7)}` +
                  ` (${Math.round((-100 * worst) / limit)}% of the daily limit, ${Math.round((-100 * worst) / dd)}% of the drawdown)`);
      if (lots === cfg.exec.contracts || lots === 1 || lots === 5) for (const t of tr) {
        const stopPts = Math.abs(t.entryPrice - t.stop);
        console.log(`      ${ct(t.entryCt ?? 0)} CT ${t.dir > 0 ? "long " : "short"} ${t.contracts} at ${t.entryPrice.toFixed(2)}, stop ${Math.round(stopPts)} pts` +
                    ` (${usd(stopPts * 2 * t.contracts)}), out ${t.reason.padEnd(7)} ${usd(t.pnl).padStart(7)}, worst dip ${usd(t.mae).padStart(7)}`);
      }
    }
  }
}
