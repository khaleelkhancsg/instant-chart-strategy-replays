// The page's arithmetic, with no DOM in it, so test/ui.test.mjs can run it in Node.

// ── Chicago's clock ──────────────────────────────────────────────────────
// A bar's ctMin is already its minute of the day in Chicago, DST included
// (prepare.mjs). How far that sits from the UTC clock is the offset that day, and
// the offset gives the date, with no time-zone table in the page.
export function ctWall(ms, ctMin) {
  let off = ctMin - (Math.floor(ms / 60000) % 1440);
  if (off > 720) off -= 1440;
  else if (off < -720) off += 1440;
  return new Date(ms + off * 60000);    // read it with the getUTC* methods
}
const p2 = (x) => String(x).padStart(2, "0");
export function fmtCt(ms, ctMin) {
  const d = ctWall(ms, ctMin);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

// ── sorted arrays ────────────────────────────────────────────────────────
// First index holding a value >= v, and first holding a value > v.
export function lowerBound(xs, v) {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (xs[m] < v) lo = m + 1; else hi = m; }
  return lo;
}
export function upperBound(xs, v) {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (xs[m] <= v) lo = m + 1; else hi = m; }
  return lo;
}

// The k-th smallest value (from 0), reordering `a` as it goes. The same number a
// sort gives, in linear time: a chart scale is worked out on every frame of a pan.
export function nthSmallest(a, k) {
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >>> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}

// ── the house numbers ────────────────────────────────────────────────────
// Results are judged on 2026, and 2026 is split in two so a result has to hold in
// both halves.
export const Y2026 = Date.UTC(2026, 0, 1), APR_2026 = Date.UTC(2026, 3, 1);

// An approximate 95% interval for a pass rate (Wilson), in percent. Neighbouring
// windows share all but a day of their days, so the honest sample is about one
// window per windowDays -- which is why these are wide, and should be.
export function wilson(p, nEff) {
  if (!(nEff > 0)) return null;
  const z2 = 1.96 * 1.96, d = 1 + z2 / nEff;
  const c = (p + z2 / (2 * nEff)) / d, h = (1.96 * Math.sqrt((p * (1 - p)) / nEff + z2 / (4 * nEff * nEff))) / d;
  return [Math.max(0, c - h) * 100, Math.min(1, c + h) * 100];
}

// How the windows starting in [lo, hi) came out.
export function rateOver(windows, lo, hi, windowDays) {
  let n = 0, pass = 0, fail = 0;
  for (const w of windows) {
    if (w.startMs < lo || w.startMs >= hi) continue;
    n++;
    if (w.outcome === "PASS") pass++;
    else if (w.outcome === "FAIL") fail++;
  }
  if (!n) return null;
  return { n, pass, fail, rate: (pass / n) * 100, failRate: (fail / n) * 100, openRate: ((n - pass - fail) / n) * 100, ci: wilson(pass / n, n / windowDays) };
}

export const houseRates = (windows, windowDays) => ({
  y2026: rateOver(windows, Y2026, Infinity, windowDays),
  q1: rateOver(windows, Y2026, APR_2026, windowDays),
  q2: rateOver(windows, APR_2026, Infinity, windowDays),
});

// ── runs and the baseline ────────────────────────────────────────────────
const DAY = 86400000, LETTER = { PASS: "P", FAIL: "F" };

// A sweep kept small enough to store. One letter per window, in the sweep's order,
// is the whole result, and all it takes to pair it with another run date by date.
export function runRecord(sweep, meta) {
  const w = sweep.windows, h = houseRates(w, meta.windowDays);
  const brief = (r) => (r ? { rate: r.rate, failRate: r.failRate, n: r.n, ci: r.ci } : null);
  return {
    ...meta, at: Date.now(),
    first: w.length ? w[0].startMs : 0, outcomes: w.map((x) => LETTER[x.outcome] || "O").join(""),
    y2026: brief(h.y2026), q1: brief(h.q1), q2: brief(h.q2),
    all: sweep.summary.passRate, allFail: sweep.summary.failRate, medianDays: sweep.summary.medianDaysToPass,
    trades: sweep.stats.n, net: Math.round(sweep.stats.pnl),
    pf: Number.isFinite(sweep.stats.profitFactor) ? sweep.stats.profitFactor : null,
  };
}

// The same start dates under two runs, over the windows starting in [lo, hi): how
// many passed under each, and how many only one of them passed.
export function pairRuns(base, now, lo = -Infinity, hi = Infinity) {
  if (base.first !== now.first) return null;
  const count = Math.min(base.outcomes.length, now.outcomes.length);
  let n = 0, passBase = 0, passNow = 0, gained = 0, lost = 0;
  for (let k = 0; k < count; k++) {
    const ms = base.first + k * DAY;
    if (ms < lo || ms >= hi) continue;
    const a = base.outcomes[k] === "P", b = now.outcomes[k] === "P";
    n++;
    if (a) passBase++;
    if (b) passNow++;
    if (b && !a) gained++;
    else if (a && !b) lost++;
  }
  if (!n) return null;
  const rateBase = (passBase / n) * 100, rateNow = (passNow / n) * 100;
  return { n, gained, lost, rateBase, rateNow, change: rateNow - rateBase };
}

export const COMPARE_PERIODS = [["2026", Y2026, Infinity], ["Jan–Mar", Y2026, APR_2026], ["Apr–Jul", APR_2026, Infinity], ["All history", -Infinity, Infinity]];

export function compareRuns(base, now) {
  return {
    rows: COMPARE_PERIODS.map(([label, lo, hi]) => ({ label, pair: pairRuns(base, now, lo, hi) })),
    sameEval: base.eval === now.eval, sameWindow: base.windowDays === now.windowDays,
  };
}

// The start dates the two runs disagree on, for the navigator.
export function flips(base, now) {
  if (base.first !== now.first) return [];
  const out = [], count = Math.min(base.outcomes.length, now.outcomes.length);
  for (let k = 0; k < count; k++) {
    const a = base.outcomes[k] === "P", b = now.outcomes[k] === "P";
    if (a !== b) out.push({ ms: base.first + k * DAY, gained: b });
  }
  return out;
}

// The settings a chart link carries, by key. Its date and which view it shows are
// not settings: a run does not change with the window on screen.
const NOT_SETTINGS = new Set(["d", "tvf"]);
export function linkSettings(hash) {
  const out = new Map();
  for (const [k, v] of new URLSearchParams(String(hash).replace(/^#/, ""))) if (!NOT_SETTINGS.has(k)) out.set(k, v);
  return out;
}
// What differs between two links; null for a setting one of them leaves at its default.
export function linkDiff(hashA, hashB) {
  const a = linkSettings(hashA), b = linkSettings(hashB), out = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(k) !== b.get(k)) out.push({ key: k, a: a.get(k) ?? null, b: b.get(k) ?? null });
  }
  return out;
}

// ── a slider over orders of magnitude ────────────────────────────────────
// Stop and target run from 0.25 to 1000 (no stop), so on an even track every useful
// value sits in the first 1%. On a log track the value 2 sits a quarter of the way
// along. The position is 0-1000; values snap to the setting's step, and more coarsely
// where the track is too fine to hit one.
export const LOG_TRACK = 1000;
export const logPosition = (v, d) => Math.round((Math.log(Math.max(v, d.min) / d.min) / Math.log(d.max / d.min)) * LOG_TRACK);
export function logValue(pos, d) {
  if (pos >= LOG_TRACK) return d.max;
  const v = d.min * Math.pow(d.max / d.min, pos / LOG_TRACK), snap = v >= 200 ? 10 : v >= 20 ? 1 : d.step;
  return Math.min(d.max, Math.max(d.min, Math.round(v / snap) * snap));
}

// ── what the chart shows ─────────────────────────────────────────────────
// Candle sizes in minutes, and Auto's choice among them: the smallest that gives each
// candle `wanted` pixels at this zoom. It sizes the drawing only, never the signals.
export const CANDLE_SIZES = [1, 2, 3, 5, 10, 15, 30, 60, 120, 240, 1440];
export const autoCandle = (pxPerBar, wanted = 4) => CANDLE_SIZES.find((m) => m * pxPerBar >= wanted) ?? CANDLE_SIZES[CANDLE_SIZES.length - 1];

// The bars of one trading day between two Chicago clock times, as [first, end). A day
// with none in that span (a holiday's short session) gives all of its bars. Trading
// days only ever rise along the bars, which is what makes the search valid.
export const RTH_VIEW = [495, 915];    // 08:15-15:15 CT
function dayBars(bars, td, fromCt, toCt) {
  const lo = lowerBound(bars.tday, td), hi = upperBound(bars.tday, td);
  let a = lo;
  while (a < hi && !(bars.ctMin[a] >= fromCt && bars.ctMin[a] <= toCt)) a++;
  if (a >= hi) return [lo, hi];
  let e = a;
  while (e + 1 < hi && bars.ctMin[e + 1] >= fromCt && bars.ctMin[e + 1] <= toCt) e++;
  return [a, e + 1];
}

// `days` trading days starting with the one bar i is in: from the first day's morning
// to the last one's close, as a view.
export function sessionView(bars, i, days = 1, [fromCt, toCt] = RTH_VIEW) {
  const n = bars.tday.length, first = bars.tday[Math.max(0, Math.min(n - 1, i))];
  let td = first;
  for (let d = 1; d < days; d++) {
    const k = upperBound(bars.tday, td);
    if (k >= n) break;
    td = bars.tday[k];
  }
  return [dayBars(bars, first, fromCt, toCt)[0], dayBars(bars, td, fromCt, toCt)[1]];
}

// The bar `days` trading days on from bar i, or back with a negative count; where the
// bars run out it stops at the last day it could reach.
export function stepDays(bars, i, days) {
  const n = bars.tday.length;
  let k = Math.max(0, Math.min(n - 1, i));
  for (let d = 0; d < Math.abs(days); d++) {
    const next = days > 0 ? upperBound(bars.tday, bars.tday[k]) : lowerBound(bars.tday, bars.tday[k]) - 1;
    if (next < 0 || next >= n) break;
    k = next;
  }
  return k;
}

// ── the strategy picker ──────────────────────────────────────────────────
// A new strategy file lands in the family its id names, or under Other.
const FAMILIES = [
  ["Templates", /^tpl_/], ["Donchian", /donchian/], ["Breakouts", /^orb|prior_day|breakout/], ["MACD", /macd/],
  ["Mean reversion", /fade|zscore|reversion/], ["Trend", /trend|ema|adx|momentum/],
];
const FAMILY_ORDER = ["Donchian", "Breakouts", "Trend", "MACD", "Mean reversion", "Other", "Templates"];
export const familyOf = (id) => (FAMILIES.find(([, re]) => re.test(id)) || ["Other"])[0];

// What the measured table says of a book on an evaluation (research/strategy_table.mjs):
// its 2026 rate with a tick of slippage a side, and its halves when the book's own
// defaults include that slippage, because the table's halves are at the defaults.
export function bookRate(row, evalId) {
  const e = row && row.evals && row.evals[evalId];
  if (!e) return null;
  return { rate: e.pass2026OneTick ?? e.pass2026, q1: e.slippageTicks >= 1 ? e.passJanMar : null, q2: e.slippageTicks >= 1 ? e.passAprJul : null };
}

// The list to show: favourites first, then the families, the best book first in each.
// A search keeps every word it is given, across the name, the id and the description.
export function pickerRows(list, rows, evalId, favs, query = "") {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean), byId = new Map(rows.map((r) => [r.id, r]));
  const hit = (s) => { const text = `${s.name} ${s.id} ${s.description || ""}`.toLowerCase(); return words.every((w) => text.includes(w)); };
  const out = list.filter(hit).map((s) => ({ ...s, family: familyOf(s.id), fav: favs.has(s.id), book: bookRate(byId.get(s.id), evalId) }));
  const best = (a, b) => (b.book ? b.book.rate : -1) - (a.book ? a.book.rate : -1) || a.name.localeCompare(b.name);
  const groups = [["Favourites", out.filter((s) => s.fav)], ...FAMILY_ORDER.map((f) => [f, out.filter((s) => !s.fav && s.family === f)])];
  return groups.filter(([, g]) => g.length).map(([title, g]) => ({ title, books: g.sort(best) }));
}
