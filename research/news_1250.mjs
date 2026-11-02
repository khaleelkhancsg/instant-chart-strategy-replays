// Red-folder news on the $1,250 books: does standing aside around the releases help?
//   node --max-old-space-size=8192 research/news_1250.mjs
//
// Each rule ('noentry': open nothing around a release; 'flat': also close what is open) and
// window (minutes before, minutes after) is scored by the house protocol on 2026: both pass-rate
// methods and both halves. Standing aside also means trading less, which moves a pass rate by
// itself, so each is set against placebo calendars: every release moved to the same clock time on
// another weekday within two weeks that had no release then. A placebo stands aside as often, at the
// same times of day, on days without the news. A rule that beats its placebos is about the news; a
// rule its placebos match is about trading less. Then the forward bars, which nothing here chose on.
//
// NEWS_WINDOWS='[[0,90],[0,120],[360,480]]' NEWS_RULES=noentry runs other windows.
//
// RESULT (2026-11-02; $1,250 eval, the books' own costs; cal = the chart's sweep, boot = the
// lib_shipped bootstrap; forward = TopstepX Sep 10 - Oct 26, 32 days, 17 windows):
//   Short windows (5 to 30 minutes either side) touch almost nothing. The big releases come at
//   7:30 CT, before either book trades, so in all of 2026 they caught three trades, all losers:
//   the Jan 22 PCE (moved to 10:00 ET that day) on both books, and the MACD fade's entry two
//   minutes after the Apr 29 FOMC decision. None forward.
//     donchian_1250   cal 74.5% -> 75.8% (ci 35-94), boot 71.1 -> 72.6; one trade of 128 changed
//     macd_fade_1250  cal 55.8% -> 55.8%, boot 67.7 -> 69.2; 172 -> 171 trades
//   Three trades are an anecdote. The placebos (0-1 of 20 as high for the Donchian) only say that
//   one trade was a loser.
//   Windows long enough to reach the open, no new trades until 90 or 120 minutes after a release:
//     donchian_1250   cal -7.8 / -6.6 (Jan-Mar -21 / -20, Apr-Jul +8 / +9), boot -10 / -6; forward +$1,647
//     macd_fade_1250  cal +3.6 / -1.9, halves opposite (-6 / +15, -19 / +19); boot -6 / -4
//   Whole release days (6 hours before to 8 after):
//     donchian_1250   cal -5.4, both halves down (-2 / -9); forward +$1,354
//     macd_fade_1250  cal +17.5 (+26 / +8), 1 placebo of 20 as high, but its bootstrap's Apr-Jul
//                     falls 5 and it loses $1,045 more forward
//   No rule helps both books, in both halves, by both methods and forward. Nothing ships.

import { RED_FOLDER } from "../src/news_calendar.mjs";
import { mulberry32, dayVector, bootstrapPass } from "../src/dayeval.mjs";
import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";
import * as E from "./lib_eval1250.mjs";

const L = E.lab, DAY = 86400000, PLACEBOS = 20;
const BOOKS = ["donchian_1250", "macd_fade_1250"];
const WINDOWS = process.env.NEWS_WINDOWS ? JSON.parse(process.env.NEWS_WINDOWS) : [[5, 5], [15, 15], [30, 30], [2, 30]];
const RULES = process.env.NEWS_RULES ? process.env.NEWS_RULES.split(",") : ["noentry", "flat"];

// A calendar with every release on another weekday within ten trading days, at the same UTC
// minute, where no real release sat.
function placebo(seed) {
  const rnd = mulberry32(seed * 7919 + 17), real = new Set(RED_FOLDER.map(([t]) => t)), out = [];
  for (const [t, k] of RED_FOLDER) {
    for (let tries = 0; tries < 100; tries++) {
      const u = t + (1 + Math.floor(rnd() * 14)) * (rnd() < 0.5 ? -1 : 1) * DAY, wd = new Date(u).getUTCDay();
      if (wd === 0 || wd === 6 || real.has(u)) continue;
      out.push([u, k]);
      break;
    }
  }
  return out.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
}
const placebos = Array.from({ length: PLACEBOS }, (_, k) => placebo(k + 1));

const last = L.bars().ts[L.bars().count - 1];
const run2026 = (cfg, opts = {}) => L.rangeRun(cfg, E.Y26, last, opts);
const calOnly = (trades, R) => L.calendar(trades, R, L.windowStarts(R, E.Y26, Infinity)).pass;

// The forward bars: TopstepX from 2026-09-10, as research/forward_1250.mjs scores them.
const FWD = loadBars("data/topstepx_1m.bin").bars, FROM = Date.UTC(2026, 8, 10), fwdLast = FWD.ts[FWD.count - 1];
const fwdDays = [];
for (let i = 0; i < FWD.count; i++) if ((i === 0 || FWD.tday[i] !== FWD.tday[i - 1]) && FWD.ts[i] >= FROM) fwdDays.push(FWD.tday[i]);
const fwdStarts = [];
for (let s = FWD.ts[0] + Math.ceil((FROM - FWD.ts[0]) / DAY) * DAY; s + 30 * DAY <= fwdLast; s += DAY) fwdStarts.push(s);
function forward(cfg) {
  const trades = runStrategy(FWD, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies: cfg.studies, fromMs: FROM }).trades, R = cfg.rules;
  const rules = { target: R.profitTarget, dd: R.trailingDD, consistency: R.consistencyGatesPass ? R.consistencyPct / 100 : 0 };
  const net = trades.reduce((s, t) => s + t.pnl, 0), cal = fwdStarts.filter((s) => replayWindow(trades, s, R).outcome === OUTCOME.PASS).length;
  return { trades: trades.length, net: Math.round(net), cal: Math.round((1000 * cal) / fwdStarts.length) / 10, boot: Math.round(bootstrapPass(dayVector(trades, fwdDays), { window: 21, ...rules }) * 10) / 10 };
}

const pad = (s, n) => String(s).padStart(n);
console.log(`2026 from the lab's bars (to ${new Date(last).toISOString().slice(0, 10)}); forward ${new Date(FROM).toISOString().slice(0, 10)} to ${new Date(fwdLast).toISOString().slice(0, 10)}, ${fwdDays.length} days, ${fwdStarts.length} windows. $1,250 eval, the books' own costs.`);
console.log(`${PLACEBOS} placebo calendars: each release moved 1-14 days to a weekday with no release at that minute.\n`);
const summary = [];
for (const id of BOOKS) {
  const base = await E.configOf(id), b = E.score(run2026(base), base.rules), bf = forward(base);
  console.log(`${id}`);
  console.log(`  ${"as shipped".padEnd(22)} cal ${pad(b.cal, 5)}% (${b.calA} / ${b.calB})  boot ${pad(b.boot, 5)}% (${b.bootA} / ${b.bootB})  ci ${b.ci[0]}-${b.ci[1]}  ${pad(b.trades, 4)} tr  net ${pad(b.net, 6)}  | fwd ${pad(bf.trades, 3)} tr net ${pad(bf.net, 5)} cal ${bf.cal}% boot ${bf.boot}%`);
  for (const rule of RULES) for (const [before, after] of WINDOWS) {
    const cfg = await E.configOf(id, { exec: { newsRule: rule, newsBeforeMin: before, newsAfterMin: after } });
    const r = E.score(run2026(cfg), cfg.rules), f = forward(cfg);
    const plc = placebos.map((ev) => calOnly(run2026(cfg, { newsEvents: ev }), cfg.rules));
    const mean = Math.round((plc.reduce((s, x) => s + x, 0) / plc.length) * 10) / 10, atLeast = plc.filter((x) => x >= r.cal).length;
    const label = `${rule === "flat" ? "flat" : "no new trades"} -${before}/+${after}`;
    console.log(`  ${label.padEnd(22)} cal ${pad(r.cal, 5)}% (${r.calA} / ${r.calB})  boot ${pad(r.boot, 5)}% (${r.bootA} / ${r.bootB})  ${pad(r.trades, 4)} tr  net ${pad(r.net, 6)}` +
                `  | placebo cal ${mean}%, ${atLeast}/${PLACEBOS} at least as high  | fwd ${pad(f.trades, 3)} tr net ${pad(f.net, 5)} cal ${f.cal}% boot ${f.boot}%`);
    summary.push({ id, rule, before, after, d: Math.round((r.cal - b.cal) * 10) / 10, dA: Math.round((r.calA - b.calA) * 10) / 10, dB: Math.round((r.calB - b.calB) * 10) / 10, dBoot: Math.round((r.boot - b.boot) * 10) / 10, atLeast, fwd: f.net - bf.net });
  }
  console.log("");
}
console.log("Change from the book as shipped, calendar points (Jan-Mar / Apr-Jul), bootstrap, and forward net:");
for (const s of summary) console.log(`  ${s.id.padEnd(15)} ${(s.rule === "flat" ? "flat" : "no new").padEnd(7)} -${s.before}/+${s.after}`.padEnd(38) + `cal ${pad(s.d > 0 ? `+${s.d}` : s.d, 6)} (${s.dA} / ${s.dB})  boot ${pad(s.dBoot > 0 ? `+${s.dBoot}` : s.dBoot, 6)}  placebos at least as high ${pad(s.atLeast, 2)}/${PLACEBOS}  fwd net ${s.fwd >= 0 ? "+" : ""}${s.fwd}`);
