// The chart page's arithmetic, without a browser.   node test/ui.test.mjs
//
// public/ui.mjs holds what the page works out and has no DOM in it. Nothing here
// draws: the page itself is checked by opening it.

import { loadBars } from "../src/data.mjs";
import { ctWall, fmtCt, lowerBound, upperBound, nthSmallest, wilson, rateOver, houseRates, Y2026, APR_2026 } from "../public/ui.mjs";

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

console.log(`\n${"=".repeat(64)}\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:"); for (const f of failures) console.log("  - " + f); }
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
