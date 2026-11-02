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

// ── the data panel ───────────────────────────────────────────────────────
// What a file probably is, from its name. The panel shows the guess and it can be changed.
export function guessCsv(name) {
  const m = /ohlcv-(\d+)m/i.exec(name);
  return { source: /topstepx|mnq_ohlcv/i.test(name) ? "topstepx" : "databento", minutes: m && Number(m[1]) === 5 ? 5 : 1 };
}
const plural = (n, word) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const utcMinute = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
export const fmtBytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// What the store's status means for the person looking at it, worst first.
export function dataNotes(s, now) {
  if (s.error) return [{ level: "bad", text: s.error }];
  if (s.empty) return [{ level: "warn", text: "No store yet. Add a CSV to start one." }];
  const notes = [], day = (ms) => new Date(ms).toISOString().slice(0, 10), put = (level, text) => notes.push({ level, text }), lost = s.rolledOff ? ` ${plural(s.rolledOff, "bar")} ${s.rolledOff === 1 ? "has" : "have"} rolled off TopstepX and cannot be pulled again.` : "";
  if (s.pullBy != null) {
    const left = Math.floor((s.pullBy - now) / 86400000);
    if (left < 0) put("bad", `TopstepX bars have been rolling off for ${plural(-left, "day")}. Pull now, then the missing days can only come from Databento.`);
    else put(left <= 7 ? "bad" : left <= 21 ? "warn" : "ok", `Pull TopstepX bars ${left ? `by ${day(s.pullBy)}, ${plural(left, "day")} from now` : "today"}, or they start rolling off before they are saved.`);
  }
  if (!s.backup) put("bad", `No backup yet.${lost}`);
  else if (s.backup.behind) put("warn", `The last backup, ${day(s.backup.at)}, is older than the latest data.`);
  else put("ok", `Backed up ${day(s.backup.at)}.${lost}`);
  for (const b of s.builds || []) {
    if (b.stale) put("warn", `New bars are in the store. Rebuild the binaries to use them in ${b.name}.`);
    for (const h of b.holes || []) put("warn", `The ${b.name} file has a gap from ${h.after} to ${h.before}, ${plural(h.missing, "weekday")}.`);
  }
  if (s.conflicts) put("warn", `${plural(s.conflicts, "bar")} ${s.conflicts === 1 ? "differs" : "differ"} from what is stored. The stored bars were kept.`);
  const rank = { bad: 0, warn: 1, ok: 2 };
  return notes.sort((a, b) => rank[a.level] - rank[b.level]);
}

// The table of what is held, as the text of each cell.
export const heldRows = (sources) => sources.map((r) => [r.source, `${r.minutes}-minute`, r.rows.toLocaleString("en-US"), String(r.contracts), utcMinute(r.first), utcMinute(r.last)]);

// Where two sources overlap, how far they agree.
export const compareText = (compare) => compare.map((c) => `${c.symbol}: ${plural(c.both, "minute")} in both sources, ${((100 * c.samePrices) / c.both).toFixed(1)}% same prices, ${((100 * c.sameVolume) / c.both).toFixed(1)}% same volume, worst ${c.worst} points`).join("  ·  ");

// What a command has said, and how it ended once it has.
export function jobText(job) {
  if (!job.id) return "";
  const said = job.lines.join("\n");
  if (job.running) return said;
  return `${said}${said ? "\n\n" : ""}${job.label}: ${job.exit === 0 ? "done" : "stopped with an error"}, ${((job.endedAt - job.startedAt) / 1000).toFixed(1)} s`;
}

// ── red-folder news on the chart ─────────────────────────────────────────
// Releases ({ t, kind }, from src/news.mjs newsBetween) on a 1-minute axis: one mark a minute,
// naming all that came out then, at the first bar at or after it, so a release while the market
// is shut lands on the reopen.
export function newsMarks(ts, events, kinds) {
  const out = [];
  for (const e of events) {
    if (e.t < ts[0]) continue;
    const last = out[out.length - 1];
    if (last && last.t === e.t) { last.kinds.push(e.kind); continue; }
    const x = lowerBound(ts, e.t);
    if (x >= ts.length) break;
    out.push({ t: e.t, x, kinds: [e.kind] });
  }
  for (const m of out) m.label = m.kinds.map((k) => (kinds[k] ? kinds[k].short : k)).join(" · ");
  return out;
}
// The windows a news rule stands aside for, merged where they meet, as [x0, x1) on the axis.
export function newsSpans(ts, events, beforeMin, afterMin) {
  const out = [], b = Math.max(0, +beforeMin || 0) * 60000, a = Math.max(0, +afterMin || 0) * 60000;
  if (b + a <= 0) return out;
  for (const e of events) {
    const x0 = lowerBound(ts, e.t - b), x1 = lowerBound(ts, e.t + a);
    if (x1 <= x0) continue;
    const last = out[out.length - 1];
    if (last && x0 <= last.x1) last.x1 = Math.max(last.x1, x1); else out.push({ x0, x1 });
  }
  return out;
}
// A mark's release time on both clocks: Chicago, as the chart reads, and Eastern, as the agencies
// publish. The offset is the bar's own (ctMin against its UTC minute); Eastern is an hour on.
export function newsClock(m, ts, ctMin) {
  let off = ctMin[m.x] - (Math.floor(ts[m.x] / 60000) % 1440);
  if (off > 720) off -= 1440; else if (off < -720) off += 1440;
  const ct = (((Math.floor(m.t / 60000) + off) % 1440) + 1440) % 1440, hm = (x) => `${p2(Math.floor(x / 60) % 24)}:${p2(x % 60)}`;
  return `${hm(ct)} CT · ${hm(ct + 60)} ET`;
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
// From 07:15 CT, so the 8:30 ET releases (07:30 CT) that move the open are in view.
export const RTH_VIEW = [435, 915];    // 07:15-15:15 CT
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
  ["Templates", /^tpl_/], ["Donchian", /donchian/], ["Breakouts", /^orb|prior_day|breakout|noise_area/], ["MACD", /macd/], ["Levels", /^pct_/],
  ["Mean reversion", /fade|zscore|reversion/], ["Trend", /trend|ema|adx|momentum/],
];
const FAMILY_ORDER = ["Donchian", "Breakouts", "Trend", "MACD", "Mean reversion", "Levels", "Other", "Templates"];
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
