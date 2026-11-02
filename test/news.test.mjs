// Red-folder news: the calendar (src/news_calendar.mjs, built by research/news_build.mjs from the
// official schedules in research/news/), its windows (src/news.mjs) and the engine's news rule.
//   node --max-old-space-size=8192 test/news.test.mjs

import { RED_FOLDER } from "../src/news_calendar.mjs";
import { NEWS_KINDS, newsBetween, newsWindowMask, newsIndexAt } from "../src/news.mjs";
import { runBrackets, resolveExec, EXIT } from "../src/engine.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { loadBars } from "../src/data.mjs";
import { sliceBars } from "../src/resample.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { evalBase } from "../src/evals.mjs";
import { easternToUtc, buildEvents } from "../research/news_build.mjs";

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + "Z";
const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit" });
const eastern = (ms) => { const p = Object.fromEntries(ET.formatToParts(ms).map((x) => [x.type, x.value])); return { day: p.weekday, clock: `${p.hour}:${p.minute}` }; };
const at = (whenIso) => RED_FOLDER.filter(([ms]) => iso(ms) === whenIso).map(([, k]) => k).sort();

// ── the calendar ──
t("the calendar is exactly what the official sources build", () => {
  eq(buildEvents().length, RED_FOLDER.length);
  eq(JSON.stringify(buildEvents()) === JSON.stringify(RED_FOLDER), true, "rebuild src/news_calendar.mjs:");
});
t("sorted, no repeats, and every kind is one the page can name", () => {
  for (let k = 1; k < RED_FOLDER.length; k++) {
    const [a, ka] = RED_FOLDER[k - 1], [b, kb] = RED_FOLDER[k];
    if (!(a < b || (a === b && ka < kb))) throw new Error(`out of order at ${iso(b)} ${kb}`);
  }
  for (const [, k] of RED_FOLDER) if (!NEWS_KINDS[k]) throw new Error(`unknown kind ${k}`);
});
t("every release is at one of its agency's times, on a weekday, but for the March 2020 Sunday cut", () => {
  const TIMES = { NFP: ["08:30"], CPI: ["08:30"], PPI: ["08:30"], RETAIL: ["08:30"], GDP: ["08:30"], PCE: ["08:30", "10:00"], FOMC: ["14:00"], PRESSER: ["14:30"], MINUTES: ["14:00"] };
  const odd = [];
  for (const [ms, k] of RED_FOLDER) {
    const e = eastern(ms);
    if (!TIMES[k].includes(e.clock) || e.day === "Sat" || e.day === "Sun") odd.push(`${iso(ms)} ${k} ${e.day} ${e.clock}`);
  }
  eq(odd, ["2020-03-03T15:00Z FOMC Tue 10:00", "2020-03-15T21:00Z FOMC Sun 17:00", "2020-03-23T12:00Z FOMC Mon 08:00"], "the Fed's three emergency statements, at the times its press releases give:");
  eq(RED_FOLDER.filter(([ms, k]) => k === "PCE" && eastern(ms).clock === "10:00").map(([ms]) => iso(ms).slice(0, 10)), ["2025-04-30", "2025-12-05", "2026-01-22"], "PCE moved to 10:00 when GDP had 8:30:");
});
t("it agrees with ForexFactory's red folders for the 2026 weeks read", () => {
  eq(at("2026-09-10T12:30Z"), ["PPI"]); eq(at("2026-09-11T12:30Z"), ["CPI"]);
  eq(at("2026-09-16T18:00Z"), ["FOMC"]); eq(at("2026-09-16T18:30Z"), ["PRESSER"]);
  eq(at("2026-10-07T18:00Z"), ["MINUTES"]);
  eq(at("2026-10-14T12:30Z"), ["CPI"]); eq(at("2026-10-15T12:30Z"), ["PPI", "RETAIL"]);
  eq(at("2026-10-28T18:00Z"), ["FOMC"]); eq(at("2026-10-28T18:30Z"), ["PRESSER"]);
  eq(at("2026-10-29T12:30Z"), ["GDP", "PCE"]);
  eq(at("2026-11-06T13:30Z"), ["NFP"], "8:30 Eastern is 13:30 UTC once the clocks go back:");
});
t("Eastern time becomes UTC through each change of the clocks", () => {
  eq(iso(easternToUtc("2026-03-06", "08:30")), "2026-03-06T13:30Z", "winter:");
  eq(iso(easternToUtc("2026-03-08", "08:30")), "2026-03-08T12:30Z", "the morning summer time starts:");
  eq(iso(easternToUtc("2026-10-31", "14:00")), "2026-10-31T18:00Z");
  eq(iso(easternToUtc("2026-11-01", "08:30")), "2026-11-01T13:30Z", "the morning it ends:");
  eq(iso(easternToUtc("2020-03-15", "17:00")), "2020-03-15T21:00Z");
});
t("the gaps and catch-ups the agencies really had are there, and nothing else", () => {
  const count = (k, y) => RED_FOLDER.filter(([ms, kk]) => kk === k && new Date(ms).getUTCFullYear() === y).length;
  for (let y = 2019; y <= 2027; y++) eq(count("GDP", y), 4, `GDP ${y}:`);
  for (let y = 2021; y <= 2027; y++) { eq(count("FOMC", y), 8, `FOMC ${y}:`); eq(count("PRESSER", y), 8, `presser ${y}:`); }
  eq([count("FOMC", 2020), count("PRESSER", 2020)], [10, 7], "2020: seven meetings held, three emergency statements:");
  eq([count("NFP", 2025), count("CPI", 2025)], [11, 11], "October 2025 was never published:");
  eq(RED_FOLDER.some(([ms, k]) => k === "GDP" && iso(ms).startsWith("2025-10-30")), false, "the Oct 30 2025 GDP was scheduled but never released:");
  eq(at("2025-12-23T13:30Z"), ["GDP"], "Q3 2025 came out as an initial estimate after the shutdown:");
  eq(RED_FOLDER.filter(([ms, k]) => k === "GDP" && iso(ms).startsWith("2026")).map(([ms]) => iso(ms).slice(0, 10)), ["2026-02-20", "2026-04-30", "2026-07-30", "2026-10-29"], "2026's advance estimates, from BEA's titles:");
  eq(count("RETAIL", 2026), 13, "two retail reports in April 2026:");
  eq(RED_FOLDER.some(([ms, k]) => k === "RETAIL" && iso(ms).startsWith("2026-09-28")), false, "Sep 28 2026 was a revision, not a release:");
});

// ── the windows ──
const bars1m = (startMs, n, step = 60000) => ({ ts: Float64Array.from({ length: n }, (_, i) => startMs + i * step), tfMin: step / 60000 });
const CPI = Date.UTC(2026, 9, 14, 12, 30);
t("a window covers the bars that overlap it, and only those", () => {
  const b = bars1m(CPI - 10 * 60000, 21), m = newsWindowMask(b, 2, 3);
  eq([...m].map((x, i) => (x ? i - 10 : null)).filter((x) => x !== null), [-2, -1, 0, 1, 2], "1-minute bars, 2 before and 3 after:");
  const five = bars1m(CPI - 30 * 60000, 13, 5 * 60000), m5 = newsWindowMask(five, 2, 3);
  eq([...m5].map((x, i) => (x ? (i - 6) * 5 : null)).filter((x) => x !== null), [-5, 0], "5-minute bars: the 8:25 bar overlaps 8:28, the 8:35 bar starts as it closes:");
  eq([...newsWindowMask(b, 0, 0)].some(Boolean), false, "a window of nothing:");
  eq([...newsWindowMask(bars1m(Date.UTC(2026, 9, 14, 3), 60), 30, 30)].some(Boolean), false, "a quiet night:");
  eq([...newsWindowMask(b, "2", "3")], [...m], "settings from a link arrive as text:");
});
t("releases are found between two times, start included, end not", () => {
  eq(newsBetween(CPI, CPI + 1).map((e) => e.kind), ["CPI"]);
  eq(newsBetween(CPI - 1, CPI).length, 0);
  eq(RED_FOLDER[newsIndexAt(CPI)][1], "CPI");
});

// ── the engine's rule ──
// 40 one-minute bars that drift up a tick a bar; a window over bars 10 to 14.
function synth(n = 40) {
  const ts = new Float64Array(n), o = new Float32Array(n), h = new Float32Array(n), l = new Float32Array(n), c = new Float32Array(n), v = new Float32Array(n), td = new Int32Array(n);
  for (let i = 0; i < n; i++) { ts[i] = Date.UTC(2026, 0, 5, 15) + i * 60000; o[i] = 100 + i * 0.25; c[i] = o[i] + 0.25; h[i] = c[i] + 0.25; l[i] = o[i] - 0.25; v[i] = 1; td[i] = 1; }
  return { ts, open: o, high: h, low: l, close: c, volume: v, tday: td };
}
const mask = (n, from, to) => { const m = new Uint8Array(n); for (let i = from; i <= to; i++) m[i] = 1; return m; };
const atr = (n) => new Float64Array(n).fill(4);
function run(sigAt, rule, extra = {}) {
  const b = synth(), n = b.ts.length, sig = new Int8Array(n), seen = [];
  for (const [k, d] of sigAt) sig[k] = d;
  const x = resolveExec({ contracts: 1, intradayOnly: false, slAtrMult: 50, tpAtrMult: 50, slippageTicks: 0, commissionPerSide: 0, newsRule: rule, newsMask: mask(n, 10, 14), ...extra,
    onSignal: (k, dir, what, info) => seen.push({ k, dir, what, why: info && info.why }) });
  return { trades: runBrackets(b, sig, atr(n), x).trades, seen };
}
const brief = (tr) => tr.map((x) => [x.dir, x.entryIdx ?? x.entryBar ?? null, x.reason]);
t("off changes nothing", () => {
  const a = run([[4, 1], [11, -1], [20, 1]], "off"), b = run([[4, 1], [11, -1], [20, 1]], "off", { newsMask: undefined });
  eq(a.trades, b.trades);
});
t("no new trades: nothing opens in the window, but a position already open is held", () => {
  const r = run([[4, 1], [16, -1]], "noentry");
  eq(r.trades.length, 2); eq(r.trades[0].reason, EXIT.FLIP, "the long runs through the window to the short:");
  const s = run([[11, 1]], "noentry");
  eq(s.trades.length, 0, "a signal whose fill would land in the window:");
  eq(s.seen.filter((e) => e.what === "refused").map((e) => [e.k, e.why]), [[11, "news"]]);
});
t("no new trades: a flip in the window still exits, but does not reverse", () => {
  const r = run([[4, 1], [11, -1]], "noentry");
  eq(r.trades.map((x) => [x.dir, x.reason]), [[1, EXIT.FLIP]]);
  eq(r.seen.some((e) => e.k === 11 && e.what === "refused" && e.why === "news"), true);
});
t("flat: an open position is closed at the window's first open, and nothing reopens until it ends", () => {
  const b = synth(), r = run([[4, 1], [12, 1], [16, 1]], "flat");
  eq(r.trades.map((x) => [x.dir, x.reason]), [[1, EXIT.NEWS], [1, EXIT.EOD]]);
  eq(r.trades[0].exitPrice, b.open[10], "at the open of bar 10:");
  eq(r.trades[0].exitTime, b.ts[10]);
  eq(r.trades[1].entryTime, b.ts[17], "the next entry is the signal after the window:");
});
t("a working order is cancelled when the window starts", () => {
  const r = run([[8, 1]], "noentry", { entryType: "stop", entryTriggerAtr: 100, entryWindowBars: 20 });
  eq(r.trades.length, 0);
  eq(r.seen.filter((e) => e.what === "cancelled").map((e) => [e.k, e.why]), [[8, "news"]]);
});
t("a rule with no mask is refused, not ignored", () => {
  let threw = false;
  try { run([[4, 1]], "flat", { newsMask: undefined }); } catch { threw = true; }
  eq(threw, true);
});

// ── on real bars, through runStrategy ──
const { bars } = loadBars();
const strategies = await loadStrategies();
const s = strategies.get("donchian_1250"), base = evalBase(s, "1250"), params = resolveParams(s, base.params);
const i0 = bars.ts.findIndex((x) => x >= Date.UTC(2025, 11, 1)), b26 = sliceBars(bars, i0, bars.count);
const real = (rule, before = 15, after = 15) => runStrategy(b26, s, params, { ...base.exec, newsRule: rule, newsBeforeMin: before, newsAfterMin: after }, { fromMs: Date.UTC(2026, 0, 1) });
const off = real("off"), noentry = real("noentry"), flat = real("flat");
const windows = RED_FOLDER.map(([ms]) => [ms - 15 * 60000, ms + 15 * 60000]);
const inside = (ms) => windows.some(([a, z]) => ms >= a && ms < z);
t("donchian_1250 in 2026: no new trades opens none inside a window", () => {
  const bad = noentry.trades.filter((x) => inside(x.entryTime));
  eq(bad.map((x) => iso(x.entryTime)), []);
  if (!(off.trades.some((x) => inside(x.entryTime)))) throw new Error("the book never trades near news, so this proves nothing");
});
t("donchian_1250 in 2026: flat holds nothing into a window, and its NEWS exits are at a window's first bar", () => {
  for (const x of flat.trades) {
    if (inside(x.entryTime)) throw new Error(`entered inside at ${iso(x.entryTime)}`);
    for (const [a] of windows) if (x.entryTime < a && x.exitTime > a) throw new Error(`held ${iso(x.entryTime)} - ${iso(x.exitTime)} across ${iso(a)}`);
    // A bar that overlaps a window at all is inside it, so on these 2-minute bars a news exit lands
    // at the open of the bar holding the window's start: up to a bar ahead of it.
    if (x.reason === EXIT.NEWS && !windows.some(([a]) => x.exitTime > a - 2 * 60000 && x.exitTime <= a)) throw new Error(`a news exit at ${iso(x.exitTime)}`);
  }
  if (!flat.trades.some((x) => x.reason === EXIT.NEWS)) throw new Error("no position was ever open at a window, so this proves nothing");
});
t("donchian_1250 in 2026: off is the book as it was", () => {
  const plain = runStrategy(b26, s, params, base.exec, { fromMs: Date.UTC(2026, 0, 1) });
  eq(off.trades.map((x) => [x.entryTime, x.exitTime, x.pnl]), plain.trades.map((x) => [x.entryTime, x.exitTime, x.pnl]));
});

console.log(`\n${"=".repeat(64)}\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:"); for (const f of failures) console.log(`  - ${f}`); }
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
