// The chart page's arithmetic, without a browser.   node test/ui.test.mjs
//
// public/ui.mjs holds what the page works out and has no DOM in it. Nothing here
// draws: the page itself is checked by opening it.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { NEWS_KINDS } from "../src/news.mjs";
import { newsMarks, newsSpans, newsClock, dataNotes, heldRows, compareText, jobText, guessCsv, fmtBytes, ctWall, fmtCt, lowerBound, upperBound, nthSmallest, wilson, rateOver, houseRates, runRecord, pairRuns, compareRuns, flips, linkSettings, linkDiff,
        logPosition, logValue, LOG_TRACK, autoCandle, CANDLE_SIZES, sessionView, stepDays, familyOf, bookRate, pickerRows } from "../public/ui.mjs";

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

console.log("\nChicago's clock");
console.log("---------------");
const { bars } = loadBars();
const CT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const intl = (ms) => {
  const p = Object.fromEntries(CT.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
};
t("a bar's clock and date match the time-zone database, across 7 years of bars", () => {
  let bad = 0, first = "";
  for (let i = 0; i < bars.count; i += 997) {
    const a = fmtCt(bars.ts[i], bars.ctMin[i]), b = intl(bars.ts[i]);
    if (a !== b) { bad++; first ||= `${new Date(bars.ts[i]).toISOString()}: ${a} vs ${b}`; }
  }
  eq(bad, 0, first);
});
t("both sides of a clock change, and either side of midnight", () => {
  const cases = [
    // [UTC, the bar's minute of the day in Chicago, what the chart should say]
    ["2026-03-06T14:30:00Z", 8 * 60 + 30, "2026-03-06 08:30"],   // before DST
    ["2026-03-10T13:30:00Z", 8 * 60 + 30, "2026-03-10 08:30"],   // after it: the reported bug read 13:30
    ["2026-03-09T04:59:00Z", 23 * 60 + 59, "2026-03-08 23:59"],  // the UTC date is a day ahead
    ["2026-03-09T05:00:00Z", 0, "2026-03-09 00:00"],
    ["2026-01-05T00:00:00Z", 18 * 60, "2026-01-04 18:00"],       // Sunday evening's session
  ];
  for (const [iso, ct, want] of cases) eq(fmtCt(Date.parse(iso), ct), want, iso);
});
t("the wall clock is read with the getUTC methods", () => {
  const d = ctWall(Date.parse("2026-03-10T13:30:00Z"), 510);
  eq([d.getUTCHours(), d.getUTCMinutes(), d.getUTCDate()], [8, 30, 10]);
});

console.log("\nsorted arrays");
console.log("-------------");
t("lowerBound and upperBound agree with a scan, repeats included", () => {
  for (let run = 0; run < 400; run++) {
    const n = Math.floor(rnd() * 40), xs = Float64Array.from({ length: n }, () => Math.floor(rnd() * 15)).sort();
    for (const v of [-1, 0, 3.5, 7, 15, 99]) {
      const lo = xs.findIndex((x) => x >= v), hi = xs.findIndex((x) => x > v);
      eq(lowerBound(xs, v), lo < 0 ? n : lo, `lower ${v} in ${[...xs]}:`);
      eq(upperBound(xs, v), hi < 0 ? n : hi, `upper ${v} in ${[...xs]}:`);
    }
  }
});
t("nthSmallest is the value a sort gives", () => {
  for (let run = 0; run < 600; run++) {
    const n = 1 + Math.floor(rnd() * 300), range = rnd() < 0.3 ? 4 : 1e6;
    const a = Float64Array.from({ length: n }, () => Math.floor(rnd() * range) * (rnd() < 0.5 ? -1 : 1));
    const sorted = a.slice().sort();
    for (const k of [0, n - 1, Math.floor(n * 0.02), Math.floor(n * 0.5), Math.min(n - 1, Math.floor(n * 0.98))]) {
      eq(nthSmallest(a, k), sorted[k], `k=${k} of ${n}:`);
    }
    eq([...a.slice().sort()], [...sorted], "it only reorders:");
  }
});

console.log("\nthe house numbers");
console.log("-----------------");
const day = (iso) => Date.parse(iso + "T22:03:00Z");
const windows = [
  { startMs: day("2025-12-30"), outcome: "PASS" },        // before 2026: not counted
  { startMs: day("2026-01-05"), outcome: "PASS" },
  { startMs: day("2026-03-31"), outcome: "FAIL" },        // the last of Jan-Mar
  { startMs: day("2026-04-01"), outcome: "PASS" },        // the first of Apr-Jul
  { startMs: day("2026-06-01"), outcome: "IN_PROGRESS" },
];
t("2026 and its halves split at the first of April, and exclude 2025", () => {
  const h = houseRates(windows, 30);
  eq([h.y2026.n, h.y2026.pass, h.y2026.fail], [4, 2, 1]);
  eq([h.q1.n, h.q1.rate], [2, 50]);
  eq([h.q2.n, h.q2.rate], [2, 50]);
  eq(h.y2026.openRate, 25);
});
t("no windows in a period is no figure, not a zero", () => eq(rateOver(windows, Date.UTC(2020, 0, 1), Date.UTC(2021, 0, 1), 30), null));
t("windows from Jul 15 are the forward period, not Apr-Jul's", () => {
  const more = [...windows, { startMs: day("2026-07-14"), outcome: "FAIL" }, { startMs: day("2026-07-15"), outcome: "PASS" }, { startMs: day("2026-09-30"), outcome: "FAIL" }];
  const h = houseRates(more, 30);
  eq([h.q2.n, h.fwd.n, h.fwd.rate], [3, 2, 50], "the last day of the lab's data is still Apr-Jul's:");
  eq(h.y2026.n, 7, "2026 is all of them:");
  eq(houseRates(windows, 30).fwd, null, "the published bars have none:");
});
t("the interval counts one sample per window length, and stays inside 0-100", () => {
  const [lo, hi] = wilson(0.745, 5.5);
  if (!(lo > 30 && lo < 40 && hi > 90 && hi < 97)) throw new Error(`${lo}-${hi}`);
  eq(wilson(0.5, 0), null);
  const [a, b] = wilson(1, 2);
  if (!(a >= 0 && b === 100)) throw new Error(`${a}-${b}`);
});

console.log("\nruns and the baseline");
console.log("---------------------");
// A run from a string of outcomes, one letter per day from the first of January.
const first = Date.parse("2026-01-01T22:03:00Z"), DAY = 86400000;
const NAMES = { P: "PASS", F: "FAIL", O: "IN_PROGRESS" };
const runOf = (letters, over = {}) => runRecord({
  windows: [...letters].map((c, k) => ({ startMs: first + k * DAY, outcome: NAMES[c] })),
  summary: { passRate: 1, failRate: 2, medianDaysToPass: 9 }, stats: { n: 10, pnl: 123.6, profitFactor: Infinity },
}, { key: letters, strategy: "x", name: "X", eval: "1250", windowDays: 30, hash: "#s=x&d=2026-01-05", ...over });

t("a run keeps one letter per window, and survives being stored", () => {
  const r = JSON.parse(JSON.stringify(runOf("PFOP")));
  eq(r.outcomes, "PFOP");
  eq([r.first, r.net, r.pf, r.y2026.n], [first, 124, null, 4]);
  eq(r.y2026.rate, 50);
});
t("two runs pair date by date: gained and lost are counted, not netted", () => {
  const p = pairRuns(runOf("PPFF"), runOf("PFPF"));
  eq([p.n, p.gained, p.lost, p.rateBase, p.rateNow, p.change], [4, 1, 1, 50, 50, 0]);
});
t("a run that ran out of time is not a pass, and is gained like a breach is", () => {
  const p = pairRuns(runOf("OF"), runOf("PP"));
  eq([p.gained, p.lost, p.rateBase], [2, 0, 0]);
});
t("a period counts only the windows that start in it", () => {
  const p = pairRuns(runOf("PPPP"), runOf("FFFF"), first + DAY, first + 3 * DAY);
  eq([p.n, p.lost], [2, 2]);
  eq(pairRuns(runOf("P"), runOf("F"), first + 9 * DAY, Infinity), null);
});
t("runs of different lengths pair over what they share; a different grid does not pair", () => {
  eq(pairRuns(runOf("PPP"), runOf("FF")).n, 2);
  eq(pairRuns(runOf("P"), { ...runOf("P"), first: first + DAY }), null);
  eq(flips(runOf("P"), { ...runOf("F"), first: first + DAY }), []);
});
t("the comparison has 2026 first, and says when the rules are not the same", () => {
  const c = compareRuns(runOf("PF"), runOf("FP", { eval: "3000", windowDays: 20 }));
  eq(c.rows.map((r) => r.label), ["2026", "Jan–Mar", "Apr–Jul", "All history"]);
  eq([c.sameEval, c.sameWindow], [false, false]);
  eq(compareRuns(runOf("P"), runOf("P")).sameEval, true);
});
t("a comparison shows the forward period only where both runs reach it", () => {
  // one window a day from Jan 1: day 195 is Jul 15
  const base = runOf("P".repeat(195) + "F".repeat(10)), now = runOf("P".repeat(195) + "PPPPPFFFFF");
  const rows = compareRuns(base, now).rows, row = (label) => rows.find((r) => r.label === label);
  eq(rows.map((r) => r.label), ["2026", "Jan–Mar", "Apr–Jul", "Since Jul 15", "All history"]);
  eq([row("Since Jul 15").pair.n, row("Since Jul 15").pair.change, row("Apr–Jul").pair.change], [10, 50, 0], "the five gained are all after Jul 14:");
  eq(compareRuns(runOf("P".repeat(195)), runOf("P".repeat(195))).rows.some((r) => r.label === "Since Jul 15"), false, "published bars: no row:");
});
t("the strip's marks are the dates that differ, in order, by which way", () => {
  eq(flips(runOf("PFPO"), runOf("PPFP")).map((f) => [(f.ms - first) / DAY, f.gained]), [[1, true], [2, false], [3, true]]);
});
t("a link's settings leave out its date and view, and two links diff by key", () => {
  eq([...linkSettings("#s=a&d=2026-01-02&tvf=0&x.contracts=6")], [["s", "a"], ["x.contracts", "6"]]);
  eq(linkDiff("#s=a&d=2026-01-02&x.contracts=4&r.windowDays=20", "#s=a&d=2026-03-09&x.contracts=6&p.fast=9"),
     [{ key: "x.contracts", a: "4", b: "6" }, { key: "r.windowDays", a: "20", b: null }, { key: "p.fast", a: null, b: "9" }]);
  eq(linkDiff("#s=a&d=1", "#s=a&d=2"), []);
});

console.log("\nsliders and the view");
console.log("--------------------");
const STOP = { min: 0.25, max: 1000, step: 0.25 };
t("the stop's log track puts the useful values in the middle of the slider", () => {
  const at = (v) => logPosition(v, STOP) / LOG_TRACK;
  if (!(at(2) > 0.2 && at(2) < 0.3 && at(20) > 0.45 && at(20) < 0.6)) throw new Error(`${at(2)} ${at(20)}`);
  eq([logPosition(0.25, STOP), logPosition(1000, STOP)], [0, LOG_TRACK]);
});
t("every position gives a value in range, on a step, rising along the track", () => {
  let last = -Infinity;
  for (let p = 0; p <= LOG_TRACK; p++) {
    const v = logValue(p, STOP);
    if (v < STOP.min || v > STOP.max) throw new Error(`${p} -> ${v}`);
    if (v < last) throw new Error(`fell at ${p}`);
    if (v < 20 && !Number.isInteger(v / STOP.step)) throw new Error(`off the step: ${v}`);
    last = v;
  }
  eq([logValue(0, STOP), logValue(LOG_TRACK, STOP)], [0.25, 1000]);
});
t("a value survives the slider: where it sits gives it back, or a neighbour", () => {
  for (const v of [0.5, 1, 2, 3, 5, 8, 12]) {
    const back = logValue(logPosition(v, STOP), STOP);
    if (Math.abs(back - v) > 0.25 + 1e-9) throw new Error(`${v} -> ${back}`);
  }
});
t("auto candles get wider as the view does, and each is at least the width asked for", () => {
  eq(autoCandle(1022 / 30000), 120);     // a 30-day window: 2-hour candles
  eq(autoCandle(1022 / 420), 2);         // one morning-to-close day: 2-minute candles
  eq(autoCandle(10), 1);
  eq(autoCandle(1e-6), 1440);            // past the largest, the largest
  for (const px of [0.01, 0.05, 0.2, 1, 3]) {
    const m = autoCandle(px);
    if (m * px < 4 && m !== CANDLE_SIZES.at(-1)) throw new Error(`${m} at ${px}`);
    const k = CANDLE_SIZES.indexOf(m);
    if (k > 0 && CANDLE_SIZES[k - 1] * px >= 4) throw new Error(`${m} is not the smallest at ${px}`);
  }
});
// Three trading days of 1-minute bars, the evening session then the day.
const fake = (() => {
  const tday = [], ctMin = [];
  for (const td of [100, 101, 102]) {
    for (let m = 1020; m < 1440; m += 30) { tday.push(td); ctMin.push(m); }  // 17:00 on the evening before
    for (let m = 0; m < 960; m += 30) { tday.push(td); ctMin.push(m); }      // to 16:00
  }
  return { tday: Int32Array.from(tday), ctMin: Int16Array.from(ctMin) };
})();
t("a day's view runs from its morning to its close, not from the evening before", () => {
  const [a, e] = sessionView(fake, fake.tday.indexOf(101));
  // from 07:15 CT, so the 07:30 bar, which an 8:30 ET release lands on, is the first in view
  eq([fake.tday[a], fake.ctMin[a], fake.tday[e - 1], fake.ctMin[e - 1]], [101, 450, 101, 900]);
});
t("a week's view ends on the last day it can reach", () => {
  const [a, e] = sessionView(fake, 0, 5);
  eq([fake.tday[a], fake.tday[e - 1], fake.ctMin[e - 1]], [100, 102, 900]);
  const [b, f] = sessionView(fake, 0, 2);
  eq([fake.tday[b], fake.tday[f - 1]], [100, 101]);
});
t("a day with no bars in those hours shows what it has", () => {
  const short = { tday: Int32Array.from([7, 7, 7]), ctMin: Int16Array.from([1020, 1050, 1080]) };
  eq(sessionView(short, 1), [0, 3]);
});
t("stepping days moves whole trading days and stops at the ends", () => {
  const i = fake.tday.indexOf(100);
  eq(fake.tday[stepDays(fake, i, 1)], 101);
  eq(fake.tday[stepDays(fake, i, 2)], 102);
  eq(fake.tday[stepDays(fake, i, 9)], 102);
  eq(fake.tday[stepDays(fake, fake.tday.indexOf(102), -1)], 101);
  eq(fake.tday[stepDays(fake, i, -3)], 100);
});

console.log("\nthe strategy picker");
console.log("-------------------");
const table = JSON.parse(fs.readFileSync(new URL("../research/strategy_table_results.json", import.meta.url), "utf8"));
const books = table.rows.map((r) => ({ id: r.id, name: r.name, description: "" }));
t("every book has a family, and the obvious ones are where they should be", () => {
  eq(books.filter((b) => familyOf(b.id) === "Other").map((b) => b.id), []);
  eq(["donchian_1250", "orb_trend", "macd_fade_1250", "vwap_fade", "trend_pullback", "tpl_ma_cross", "ema_cross_macd_fade", "supertrend"].map(familyOf),
     ["Donchian", "Breakouts", "MACD", "Mean reversion", "Trend", "Templates", "MACD", "Trend"]);
  eq(familyOf("something_new"), "Other");
});
t("the rate shown includes a tick of slippage, and halves show only when they are that run", () => {
  const row = { evals: { "1250": { pass2026: 50, pass2026OneTick: 40, passJanMar: 60, passAprJul: 30, slippageTicks: 0 } } };
  eq(bookRate(row, "1250"), { rate: 40, q1: null, q2: null });
  row.evals["1250"].slippageTicks = 1;
  eq(bookRate(row, "1250"), { rate: 40, q1: 60, q2: 30 });
  eq(bookRate(row, "3000"), null);
  eq(bookRate(undefined, "1250"), null);
});
t("the data panel says what needs doing, worst first", () => {
  const now = Date.UTC(2026, 9, 31), day = 86400000, base = { pullBy: now + 59 * day, backup: { at: now, behind: false }, rolledOff: 5000, conflicts: 0, builds: [{ name: "main", holes: [] }] };
  const levels = (s) => dataNotes({ ...base, ...s }, now).map((x) => x.level);
  eq(levels({}), ["ok", "ok"]);
  eq(levels({ pullBy: now + 20 * day }), ["warn", "ok"], "three weeks left:");
  eq(levels({ pullBy: now + 7 * day }), ["bad", "ok"], "a week left:");
  eq(levels({ pullBy: now - 3 * day })[0], "bad");
  if (!/rolling off for 3 days/.test(dataNotes({ ...base, pullBy: now - 3 * day }, now)[0].text)) throw new Error("it should say how long");
  eq(levels({ backup: null }), ["bad", "ok"], "no backup:");
  if (!/5,000 bars have rolled off TopstepX and cannot be pulled again/.test(dataNotes({ ...base, backup: null }, now)[0].text)) throw new Error("it should say what is at risk");
  eq(levels({ backup: { at: now, behind: true } }), ["warn", "ok"], "an old backup:");
  eq(levels({ conflicts: 2 }), ["warn", "ok", "ok"]);
  eq(levels({ builds: [{ name: "beta", stale: true, holes: [{ after: "2026-07-15", before: "2026-08-28", missing: 31 }] }] }), ["warn", "warn", "ok", "ok"]);
  eq(dataNotes({ empty: true }, now)[0].text, "No store yet. Add a CSV to start one.");
  eq(dataNotes({ error: "boom" }, now), [{ level: "bad", text: "boom" }]);
  eq(dataNotes({ ...base, pullBy: null }, now).length, 1, "nothing from TopstepX yet:");
});
t("the data panel's deadline turns on the exact day", () => {
  const now = Date.UTC(2026, 9, 31, 12), day = 86400000, base = { backup: { at: now, behind: false }, conflicts: 0, builds: [] };
  const note = (left) => dataNotes({ ...base, pullBy: now + left * day }, now).find((n) => /Pull|rolling/.test(n.text));
  eq([22, 21, 8, 7, 1, 0, 0.5].map((d) => note(d).level), ["ok", "warn", "warn", "bad", "bad", "bad", "bad"]);
  eq(note(21).text, "Pull TopstepX bars by 2026-11-21, 21 days from now, or they start rolling off before they are saved.");
  eq(note(1).text, "Pull TopstepX bars by 2026-11-01, 1 day from now, or they start rolling off before they are saved.");
  eq(note(0.5).text, "Pull TopstepX bars today, or they start rolling off before they are saved.", "under a day left:");
  eq(note(-1).text, "TopstepX bars have been rolling off for 1 day. Pull now, then the missing days can only come from Databento.");
  eq(note(-0.5).level, "bad", "just past it:");
});
t("the data panel counts one of a thing as one", () => {
  const now = Date.UTC(2026, 9, 31), s = { pullBy: null, backup: { at: now, behind: false }, rolledOff: 1, conflicts: 1, builds: [{ name: "beta", holes: [{ after: "a", before: "b", missing: 1 }] }] };
  eq(dataNotes(s, now).map((n) => n.text), ["The beta file has a gap from a to b, 1 weekday.", "1 bar differs from what is stored. The stored bars were kept.", "Backed up 2026-10-31. 1 bar has rolled off TopstepX and cannot be pulled again."]);
});
t("the data panel leaves out what does not apply", () => {
  const now = Date.UTC(2026, 9, 31);
  eq(dataNotes({ pullBy: null, backup: { at: now, behind: false }, rolledOff: 0, conflicts: 0, builds: [] }, now), [{ level: "ok", text: "Backed up 2026-10-31." }]);
  eq(dataNotes({ pullBy: null, backup: null, rolledOff: 0, conflicts: 0 }, now), [{ level: "bad", text: "No backup yet." }], "no builds listed:");
  eq(dataNotes({ error: "boom", empty: true }, now).length, 1, "an error comes first:");
  const order = dataNotes({ pullBy: now + 3 * 86400000, backup: { at: now, behind: true }, rolledOff: 0, conflicts: 0, builds: [{ name: "beta", stale: true, holes: [] }] }, now).map((n) => n.level);
  eq(order, ["bad", "warn", "warn"], "worst first:");
});
t("red-folder releases land on the chart's minutes, named together when they share one", () => {
  const at = (h, m) => Date.UTC(2026, 9, 15, h, m), ts = Float64Array.from({ length: 10 }, (_, i) => at(12, 25) + i * 60000);
  const ev = [{ t: at(12, 20), kind: "CPI" }, { t: at(12, 30), kind: "PPI" }, { t: at(12, 30), kind: "RETAIL" }, { t: at(12, 40), kind: "NFP" }];
  eq(newsMarks(ts, ev, NEWS_KINDS), [{ t: at(12, 30), x: 5, kinds: ["PPI", "RETAIL"], label: "PPI · Retail" }], "before and after the bars are left out:");
  const gap = Float64Array.from([at(12, 0), at(12, 1), at(13, 0)]);
  eq(newsMarks(gap, [{ t: at(12, 30), kind: "FOMC" }], NEWS_KINDS).map((m) => m.x), [2], "released while shut: on the reopen:");
});
t("the windows a news rule stands aside for are merged where they meet", () => {
  const at = (h, m) => Date.UTC(2026, 9, 15, h, m), ts = Float64Array.from({ length: 60 }, (_, i) => at(12, 0) + i * 60000);
  eq(newsSpans(ts, [{ t: at(12, 30), kind: "CPI" }], 2, 3), [{ x0: 28, x1: 33 }]);
  eq(newsSpans(ts, [{ t: at(12, 30), kind: "CPI" }, { t: at(12, 33), kind: "PPI" }], 2, 3), [{ x0: 28, x1: 36 }], "two that touch:");
  eq(newsSpans(ts, [{ t: at(12, 30), kind: "CPI" }], 0, 0), [], "no window:");
  eq(newsSpans(ts, [{ t: at(12, 30), kind: "CPI" }], "2", "3"), [{ x0: 28, x1: 33 }], "settings from a link:");
});
t("a release's time reads on both clocks, through the clock change", () => {
  const sum = Date.UTC(2026, 9, 15, 12, 30), win = Date.UTC(2026, 10, 6, 13, 30);
  // ctMin is each bar's Chicago minute: UTC-5 in October, UTC-6 in November
  eq(newsClock({ t: sum, x: 0 }, [sum], [7 * 60 + 30]), "07:30 CT · 08:30 ET");
  eq(newsClock({ t: win, x: 0 }, [win], [7 * 60 + 30]), "07:30 CT · 08:30 ET");
  eq(newsClock({ t: Date.UTC(2026, 9, 28, 18, 0), x: 0 }, [Date.UTC(2026, 9, 28, 18, 0)], [13 * 60]), "13:00 CT · 14:00 ET");
  eq(newsClock({ t: Date.UTC(2020, 2, 15, 21, 0), x: 0 }, [Date.UTC(2020, 2, 15, 22, 0)], [17 * 60]), "16:00 CT · 17:00 ET", "a Sunday release, read from the reopen's bar:");
});
t("the data panel's table, comparison and command output read as words", () => {
  eq(heldRows([{ source: "databento", minutes: 1, rows: 3784340, contracts: 33, first: Date.UTC(2019, 4, 5, 22, 3), last: Date.UTC(2026, 6, 14, 23, 59) }]),
     [["databento", "1-minute", "3,784,340", "33", "2019-05-05 22:03", "2026-07-14 23:59"]]);
  eq(heldRows([]), []);
  eq(compareText([]), "", "nothing overlaps yet:");
  eq(compareText([{ symbol: "MNQZ6", both: 1000, samePrices: 985, sameVolume: 1000, worst: 1.75 }, { symbol: "MNQU6", both: 1, samePrices: 1, sameVolume: 0, worst: 0 }]),
     "MNQZ6: 1,000 minutes in both sources, 98.5% same prices, 100.0% same volume, worst 1.75 points  ·  MNQU6: 1 minute in both sources, 100.0% same prices, 0.0% same volume, worst 0 points");
  eq(jobText({}), "", "nothing has run:");
  eq(jobText({ id: 1, label: "Back up", running: true, lines: ["one", "two"] }), "one\ntwo", "running, no ending yet:");
  eq(jobText({ id: 1, label: "Back up", running: false, exit: 0, lines: ["one"], startedAt: 1000, endedAt: 2600 }), "one\n\nBack up: done, 1.6 s");
  eq(jobText({ id: 1, label: "Back up", running: false, exit: 3, lines: [], startedAt: 0, endedAt: 50 }), "Back up: stopped with an error, 0.1 s", "no output at all:");
});
t("a CSV's source and bar size are guessed from its name", () => {
  eq(guessCsv("glbx-mdp3-20260715-20261030.ohlcv-1m.csv"), { source: "databento", minutes: 1 });
  eq(guessCsv("mnq_ohlcv-5m.csv"), { source: "topstepx", minutes: 5 });
  eq(guessCsv("topstepx bars.csv"), { source: "topstepx", minutes: 1 });
  eq(guessCsv("bars.csv"), { source: "databento", minutes: 1 });
  eq(guessCsv("GLBX-MDP3.OHLCV-5M.CSV"), { source: "databento", minutes: 5 });
  eq(guessCsv("mnq_ohlcv-1m_aug28-31.csv"), { source: "topstepx", minutes: 1 });
  eq(guessCsv("ohlcv-15m.csv").minutes, 1, "a size the panel does not offer:");
  eq([fmtBytes(0), fmtBytes(1023), fmtBytes(1048575), fmtBytes(1073741823)], ["1 KB", "1 KB", "1024 KB", "1024 MB"], "the edges of each unit:");
  eq([fmtBytes(2048), fmtBytes(333 * 1048576), fmtBytes(1.5 * 1073741824)], ["2 KB", "333 MB", "1.5 GB"]);
});
t("the list runs best first in each family, on the evaluation in force", () => {
  const groups = pickerRows(books, table.rows, "1250", new Set());
  const don = groups.find((g) => g.title === "Donchian").books;
  eq(don[0].id, "donchian_1250");
  eq(don[0].book.rate, 74.5);
  for (const g of groups) for (let k = 1; k < g.books.length; k++) if (g.books[k - 1].book.rate < g.books[k].book.rate) throw new Error(g.title);
  eq(groups.reduce((n, g) => n + g.books.length, 0), books.length);
});
t("favourites go on top, once", () => {
  const groups = pickerRows(books, table.rows, "1250", new Set(["orb", "donchian_1250"]));
  eq(groups[0].title, "Favourites");
  eq(groups[0].books.map((b) => b.id), ["donchian_1250", "orb"]);
  eq(groups.flatMap((g) => g.books).filter((b) => b.id === "orb").length, 1);
});
t("a search keeps every word, across name and id, and an empty family goes", () => {
  const groups = pickerRows(books, table.rows, "1250", new Set(), "macd fade 1250");
  eq(groups.map((g) => g.title), ["MACD"]);
  eq(groups[0].books.map((b) => b.id), ["macd_fade_1250"]);
  eq(pickerRows(books, table.rows, "1250", new Set(), "nothing like this"), []);
});
t("a book the table has not measured still lists, last in its family", () => {
  const groups = pickerRows([...books, { id: "donchian_new", name: "New Donchian", description: "" }], table.rows, "1250", new Set());
  const don = groups.find((g) => g.title === "Donchian").books;
  eq([don.at(-1).id, don.at(-1).book], ["donchian_new", null]);
});

console.log(`\n${"=".repeat(64)}\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:"); for (const f of failures) console.log("  - " + f); }
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
