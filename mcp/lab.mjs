// The research session's state, and the machinery every MCP tool shares. The
// bars and the strategies load once and stay loaded for as long as the server
// lives; full-history runs are cached by configuration. Nothing here simulates
// anything itself -- it calls src/, the same engine and evaluators the chart and
// the test suite use, so a number from a tool and a number on the chart agree.

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { resolveExec, DEFAULT_EXEC, LEGACY_EXEC } from "../src/engine.mjs";
import { resolveRules, replayWindow, DEFAULT_RULES, OUTCOME } from "../src/challenge.mjs";
import { NO_FILTER, FILTER_PERIODS } from "../src/filters.mjs";
import { sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { windowSpan } from "../src/window.mjs";
import { dayVector, bootstrapPass } from "../src/dayeval.mjs";

export const DAY = 86400000;

// A mistake the caller can fix -- reported as a tool error, not a crash.
export class UserError extends Error {}

let B = null, S = null, DAYS = null;
export function bars() { if (!B) B = loadBars().bars; return B; }
export async function strategies() { if (!S) S = await loadStrategies(); return S; }

// Every trading day as [tday, its first bar's time], in order.
function tradingDays() {
  if (DAYS) return DAYS;
  const b = bars();
  DAYS = [];
  for (let i = 0; i < b.count; i++) if (i === 0 || b.tday[i] !== b.tday[i - 1]) DAYS.push([b.tday[i], b.ts[i]]);
  return DAYS;
}

export const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : null);
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export function parseDate(v, what) {
  if (v == null || v === "") return null;
  // Dates and date-times are UTC unless they carry a zone: a bare
  // "2026-03-09T14:30" would otherwise be read in the machine's local time.
  const s = typeof v === "string" ? v.trim() : v;
  const ms = typeof s === "number" ? s
           : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T00:00:00Z"
                        : /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? s + "Z" : s);
  if (!Number.isFinite(ms)) throw new UserError(`${what}: "${v}" is not a date (use YYYY-MM-DD)`);
  return ms;
}

// ── configuration: the strategy's own defaults under the caller's overrides,
// with every key checked. A misspelt key silently ignored is a wrong answer
// that looks right, so unknown keys are refused, with the valid ones listed.
function checkKeys(what, obj, valid) {
  if (obj == null) return;
  if (typeof obj !== "object" || Array.isArray(obj)) throw new UserError(`${what} must be an object`);
  const bad = Object.keys(obj).filter((k) => !valid.has(k));
  if (bad.length) throw new UserError(`unknown ${what} key${bad.length > 1 ? "s" : ""} ${bad.map((k) => `"${k}"`).join(", ")}; valid: ${[...valid].join(", ")}`);
}
function checkParamValues(s, params) {
  for (const d of s.params || []) {
    if (!(d.key in (params || {}))) continue;
    const v = params[d.key];
    if (d.type === "select") {
      const ok = (d.options || []).map((o) => o[0]);
      if (!ok.includes(v)) throw new UserError(`params.${d.key}: "${v}" is not one of ${ok.join(", ")}`);
    } else if (!Number.isFinite(v)) throw new UserError(`params.${d.key} must be a number`);
  }
}

export async function resolveConfig(input = {}) {
  const all = await strategies();
  const s = all.get(input.strategy);
  if (!s) throw new UserError(`unknown strategy "${input.strategy}"; call list_strategies`);
  checkKeys("params", input.params, new Set([...(s.params || []).map((d) => d.key), "timeframeMin"]));
  checkParamValues(s, input.params);
  checkKeys("exec", input.exec, new Set(Object.keys(DEFAULT_EXEC)));
  checkKeys("rules", input.rules, new Set(Object.keys(DEFAULT_RULES)));
  checkKeys("filter", input.filter, new Set([...Object.keys(NO_FILTER), ...Object.keys(FILTER_PERIODS)]));
  const params = resolveParams(s, input.params || {});
  const exec = resolveExec({ ...(s.execDefaults || {}), ...(input.legacy ? LEGACY_EXEC : {}), ...(input.exec || {}) });
  const rules = resolveRules({ ...(s.rulesDefaults || {}), ...(input.rules || {}) });
  const filter = { ...NO_FILTER, ...(s.filterDefaults || {}), ...(input.filter || {}) };
  if (exec.sameBarReentry) throw new UserError("exec.sameBarReentry re-enters at an open that came BEFORE the exit -- not a sequence anyone could trade. Leave it false.");
  const warnings = [];
  if (exec.entryType === "stop" && exec.entryRefused === "optimistic") warnings.push("entryRefused 'optimistic' fills stops the platform would refuse: an upper bound, not a result.");
  if (!(exec.slippageTicks > 0)) warnings.push("no slippage (slippageTicks 0): live MNQ market and stop fills pay about a tick a side -- pass exec.slippageTicks: 1 for a realistic figure.");
  if (!(exec.commissionModel === "flat" ? exec.commissionFlat > 0 : exec.commissionPerSide > 0)) warnings.push("no commission modelled.");
  if (input.legacy) warnings.push("legacy engine conventions (LEGACY_EXEC): reproduces pre-consolidation results, not the physically consistent fills.");
  if (exec.intradayOnly === false && (exec.dayLossStopUsd > 0 || exec.dayProfitStopUsd > 0))
    warnings.push("day caps with overnight holds: a carried position counts its P&L since the fill toward the new day's cap, where a platform marks it at the session open.");
  return { s, params, exec, rules, filter, warnings };
}

export function costLine(x) {
  const fee = x.commissionModel === "flat" ? `$${x.commissionFlat}/trade flat` : `$${x.commissionPerSide}/side/contract`;
  return `${fee}, ${x.slippageTicks} tick${x.slippageTicks === 1 ? "" : "s"} slippage/side, $${x.pointValue}/point`;
}

// The settings that differ from the strategy's own defaults: what a result is
// actually about, without the noise of every default.
export function changed(cfg) {
  const out = {};
  const p0 = resolveParams(cfg.s, {}), x0 = resolveExec(cfg.s.execDefaults || {});
  const r0 = resolveRules(cfg.s.rulesDefaults || {}), f0 = { ...NO_FILTER, ...(cfg.s.filterDefaults || {}) };
  for (const [name, now, base] of [["params", cfg.params, p0], ["exec", cfg.exec, x0], ["rules", cfg.rules, r0], ["filter", cfg.filter, f0]]) {
    const d = {};
    for (const k of Object.keys(now)) if (typeof now[k] !== "function" && JSON.stringify(now[k]) !== JSON.stringify(base[k])) d[k] = now[k];
    if (Object.keys(d).length) out[name] = d;
  }
  return out;
}

// ── runs, cached ─────────────────────────────────────────────────────────
const runCache = new Map();
const RUN_CACHE_MAX = 16;
export function fullRun(cfg) {
  const key = JSON.stringify([cfg.s.id, cfg.params, cfg.exec, cfg.filter]);
  const hit = runCache.get(key);
  if (hit) { runCache.delete(key); runCache.set(key, hit); return hit; }
  const t0 = performance.now();
  const r = runStrategy(bars(), cfg.s, cfg.params, cfg.exec, { filter: cfg.filter });
  const out = { trades: r.trades, tfMin: cfg.params.timeframeMin || 1, ms: Math.round(performance.now() - t0) };
  runCache.set(key, out);
  while (runCache.size > RUN_CACHE_MAX) runCache.delete(runCache.keys().next().value);
  return out;
}

// A run on just the bars a date range needs -- the warm-up the chart's live
// window uses before it, a tail after -- for searches, where each configuration
// runs once and the full history would be wasted work.
export function rangeRun(cfg, fromMs, toMs) {
  const b = bars();
  const span = windowSpan(cfg.s, cfg.params, { filter: cfg.filter, exec: cfg.exec, tailMin: 30 * 1440 });
  const si = indexAtOrAfter(b.ts, fromMs - span.warmupMin * 60000);
  // A book that can carry a position overnight can hold it for months, so its
  // last window's trade is only exact with every bar after it.
  const x = cfg.exec, carries = x.intradayOnly === false || (x.flattenCt === x.reopenCt && x.sessionEndFlat === "none");
  const ei = carries ? b.count : Math.min(indexAtOrAfter(b.ts, toMs + span.tailMin * 60000) + 1, b.count);
  return runStrategy(sliceBars(b, si, ei), cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, fromMs }).trades;
}

// ── periods, and the two pass-rate methods ───────────────────────────────
// A period is a range of window START dates. The default set is the house rule:
// 2026, and 2026 split in two (January-March against April-July) so a result is
// checked inside 2026 itself, with all of history for context.
export function standardPeriods() {
  return [
    { label: "all history", from: bars().ts[0], to: Infinity },
    { label: "2026", from: Date.UTC(2026, 0, 1), to: Infinity },
    { label: "2026 Jan-Mar", from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 3, 1) },
    { label: "2026 Apr-Jul", from: Date.UTC(2026, 3, 1), to: Infinity },
  ];
}
export function readPeriods(list) {
  if (!list) return standardPeriods();
  if (!Array.isArray(list) || !list.length) throw new UserError("periods must be a non-empty array of {label, from, to}");
  return list.map((p, k) => ({ label: p.label || `period ${k + 1}`, from: parseDate(p.from, "periods.from") ?? bars().ts[0], to: parseDate(p.to, "periods.to") ?? Infinity }));
}

// Window starts on the chart's grid -- the data's first bar plus whole days --
// so every window here is one the chart's sweep scores and can show.
export function windowStarts(R, from, to) {
  const b = bars(), first = b.ts[0], last = b.ts[b.count - 1] - R.windowDays * DAY;
  const out = [];
  for (let s = first + Math.max(0, Math.ceil((from - first) / DAY)) * DAY; s < to && s <= last; s += DAY) out.push(s);
  return out;
}
export const CALENDAR = "calendar windows: a combine started on every day of the period (the chart's grid), each replayed over its real next windowDays calendar days with the full rule set (src/challenge.mjs replayWindow)";
export function calendar(trades, R, starts) {
  let pass = 0, fail = 0, net = 0;
  const toPass = [];
  for (const s of starts) {
    const r = replayWindow(trades, s, R);
    if (r.outcome === OUTCOME.PASS) { pass++; toPass.push(r.stats.daysUsed); } else if (r.outcome === OUTCOME.FAIL) fail++;
    net += r.stats.netPnl;
  }
  const n = starts.length;
  toPass.sort((a, b) => a - b);
  return n ? { windows: n, pass: pct(pass / n), ci95: wilson(pass / n, n / R.windowDays), fail: pct(fail / n), open: pct((n - pass - fail) / n),
               medianDaysToPass: toPass.length ? toPass[toPass.length >> 1] : null, meanNet: Math.round(net / n) }
           : { windows: 0 };
}
export const pct = (v) => Math.round(v * 1000) / 10;

// An approximate 95% interval for a pass rate (Wilson). Neighbouring windows
// share all but a day of their days, so the honest sample size is about one
// window per windowDays, not one per start -- which makes these wide, and
// should: 2026 holds only five or six independent 30-day periods.
export const CI_NOTE = "ci95: approximate 95% interval, counting one independent sample per windowDays of starts (neighbouring windows share most of their days)";
export function wilson(p, nEff) {
  if (!(nEff > 0)) return null;
  const z = 1.96, z2 = z * z, d = 1 + z2 / nEff;
  const c = (p + z2 / (2 * nEff)) / d, h = (z * Math.sqrt((p * (1 - p)) / nEff + z2 / (4 * nEff * nEff))) / d;
  return [pct(Math.max(0, c - h)), pct(Math.min(1, c + h))];
}

// The standard normal CDF (erfc by Chebyshev fit, ~1e-7).
export function normCdf(x) {
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.5 * z);
  const erfc = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
               t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - erfc / 2 : erfc / 2;
}

// Daily P&L statistics over every trading day of [from, to), flat days as 0:
// what the Sharpe-based tests in papers/ (PSR, MinTRL, DSR, haircuts) start from.
export const DAILY_NOTE = "daily: every trading day in the period, days without a trade as $0. sharpe is per day (annualised x sqrt(252) alongside); psrVsZero is the probabilistic Sharpe ratio, the chance the true daily Sharpe exceeds 0 given the sample's length, skew and kurtosis; minTrackRecordDays is how many days that would need to reach 95% (papers/bailey-2012-sharpe-ratio-efficient-frontier)";
export function dailyStats(trades, from, to) {
  const keys = tradingDays().filter(([, ms]) => ms >= from && ms < to).map(([d]) => d);
  const v = dayVector(trades, keys), n = v.length;
  if (n < 5) return null;
  let s = 0, best = -Infinity, worst = Infinity, up = 0;
  for (const x of v) { s += x; if (x > best) best = x; if (x < worst) worst = x; if (x > 0) up++; }
  const mean = s / n;
  let m2 = 0, m3 = 0, m4 = 0, ac = 0;
  for (let k = 0; k < n; k++) { const d = v[k] - mean; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; if (k) ac += d * (v[k - 1] - mean); }
  const sd = Math.sqrt(m2 / (n - 1)), sdPop = Math.sqrt(m2 / n);
  const skew = sdPop > 0 ? m3 / n / sdPop ** 3 : 0, kurt = sdPop > 0 ? m4 / n / sdPop ** 4 : 3;
  const sr = sd > 0 ? mean / sd : 0, denom = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  const round = (x, k = 3) => Math.round(x * 10 ** k) / 10 ** k;
  return {
    days: n, mean: round(mean, 2), sd: round(sd, 2), sharpe: round(sr, 4), sharpeAnnualised: round(sr * Math.sqrt(252), 3),
    skew: round(skew), kurtosis: round(kurt), autocorrLag1: m2 > 0 ? round(ac / m2) : 0,
    best: Math.round(best), worst: Math.round(worst), positiveDays: pct(up / n),
    psrVsZero: denom > 0 ? round(normCdf((sr * Math.sqrt(n - 1)) / Math.sqrt(denom))) : null,
    minTrackRecordDays: sr > 0 && denom > 0 ? Math.ceil(1 + denom * (1.6449 / sr) ** 2) : null,
  };
}

export const BOOTSTRAP = "day-sequence bootstrap: 12,000 runs of a combine's worth of trading days (windowDays x 5/7, 21 for 30), drawn in blocks of 5 consecutive days from the period's days and judged on target, end-of-day trailing drawdown locking at breakeven, and consistency (src/dayeval.mjs) -- the method research/lib_shipped.mjs quotes. Daily rules act only through the engine (exec), not here";
export function bootstrap(trades, R, from, to) {
  const keys = tradingDays().filter(([, ms]) => ms >= from && ms < to).map(([d]) => d);
  if (keys.length < 10) return { days: keys.length, pass: null };
  const vec = dayVector(trades, keys);
  const window = Math.max(1, Math.round((R.windowDays * 5) / 7));
  const consistency = R.consistencyGatesPass ? R.consistencyPct / 100 : 0;
  const p = bootstrapPass(vec, { window, target: R.profitTarget, dd: R.trailingDD, consistency }) / 100;
  // 12,000 draws pin the estimate down; the days themselves are the limit --
  // one independent run of `window` days per window of history.
  return { days: keys.length, window, pass: Math.round(p * 1000) / 10, ci95: wilson(p, keys.length / window) };
}
export function bootstrapCaveats(R, x) {
  const c = [];
  if (R.trailingMode !== "eod") c.push("the bootstrap trails on day closes; these rules trail intraday");
  if (!R.lockAtBreakeven) c.push("the bootstrap locks the floor at breakeven; these rules do not");
  // A rules-layer daily stop counts in the bootstrap only if the engine enforces
  // one at least as tight -- the day vector is built from the engine's trades.
  const covered = (rule, ...engine) => !(rule > 0) || engine.some((v) => v > 0 && v <= rule);
  const missing = [];
  if (!covered(R.dailyLossLimit, x.dayLossStopUsd, x.dayBreakerUsd)) missing.push(`dailyLossLimit $${R.dailyLossLimit} (exec.dayLossStopUsd)`);
  if (!covered(R.circuitBreaker, x.dayBreakerUsd, x.dayLossStopUsd)) missing.push(`circuitBreaker $${R.circuitBreaker} (exec.dayBreakerUsd)`);
  if (!covered(R.dailyProfitStop, x.dayProfitBlockUsd, x.dayProfitStopUsd)) missing.push(`dailyProfitStop $${R.dailyProfitStop} (exec.dayProfitBlockUsd)`);
  if (missing.length) c.push(`the bootstrap sees only what the engine enforces, so these rules-layer daily stops do not count there: ${missing.join(", ")} -- set the exec equivalents to include them`);
  if (R.minTradingDays > 0) c.push("minTradingDays is not in the bootstrap");
  return c;
}
