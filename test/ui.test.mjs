// The chart page's arithmetic, without a browser.   node test/ui.test.mjs
//
// public/ui.mjs holds what the page works out and has no DOM in it. Nothing here
// draws: the page itself is checked by opening it.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { ctWall, fmtCt, lowerBound, upperBound, nthSmallest, wilson, rateOver, houseRates, runRecord, pairRuns, compareRuns, flips, linkSettings, linkDiff,
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
  eq([fake.tday[a], fake.ctMin[a], fake.tday[e - 1], fake.ctMin[e - 1]], [101, 510, 101, 900]);
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
