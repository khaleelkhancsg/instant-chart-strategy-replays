// The MCP tools: { name, description, inputSchema, run(args) -> plain object }.
// Each one is a thin, documented question over src/ -- see mcp/lab.mjs. Inputs
// are checked strictly (an unknown key is refused, not ignored), every pass rate
// says which method produced it, and every result says what it cost to trade.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tradeStats } from "../src/engine.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";
import { resample, sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { STRATEGY_DIR } from "../src/registry.mjs";
import { mulberry32 } from "../src/dayeval.mjs";
import { EVAL_IDS, evalOf } from "../src/evals.mjs";
import { STUDIES, STUDY_TFS, gateLabel, studyEdge, studyOnSignal, resolveStudies, gateKey } from "../src/studies.mjs";
import * as L from "./lab.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAPERS = path.join(HERE, "..", "papers");
export const CHART = process.env.CHART_LAB_URL || "http://localhost:5178";

// ── input schema pieces ──────────────────────────────────────────────────
const CFG = {
  strategy: { type: "string", description: "Strategy id, as list_strategies gives it." },
  params: { type: "object", description: "Signal parameters to override; describe_strategy lists each with its default and range. Unknown keys are refused." },
  exec: { type: "object", description: "Execution overrides (src/engine.mjs DEFAULT_EXEC), e.g. contracts, slAtrMult, tpAtrMult, tpMode, entryType (market|stop|limit), entryTriggerAtr, entryWindowBars, slippageTicks, commissionPerSide, dayLossStopUsd, dayLossStopMode, dayBreakerUsd, dayProfitBlockUsd, maxBarsInTrade, staleBars + staleMfeAtr (leave a trade that has not gone that many ATRs in its favour within that many bars), intradayOnly, flattenCt, reopenCt. Unknown keys are refused." },
  filter: { type: "object", description: "Signal gates (src/filters.mjs): startCt/endCt in CT minutes of the day, adxMin/adxMax, effMin/effMax, volMin/volMax, chopMin/chopMax, bwMin/bwMax, and their periods." },
  rules: { type: "object", description: "Combine rules (src/challenge.mjs DEFAULT_RULES): profitTarget, trailingDD, trailingMode (eod|intraday), lockAtBreakeven, windowDays, consistencyPct, consistencyGatesPass, dailyLossLimit, circuitBreaker, dailyProfitStop, minTradingDays." },
  eval: { type: "string", enum: EVAL_IDS, description: "Which evaluation (src/evals.mjs): '3000' = $3,000 target, $2,000 trailing drawdown, $1,000 daily limit (default); '1250' = $1,250 target, $1,000 trailing, $600 daily limit. It sets the firm's rules, the platform loss cap where the book models one, and the strategy's own settings for that eval (describe_strategy shows them); params/exec/rules given here go on top." },
  studies: { type: "array", items: { type: "object" }, description: "Indicator studies (list_studies), each {type, tf, params, gate}: tf in minutes (0 = the signal's), gate 'off' or one the study offers, e.g. {type: 'emacross', tf: 10, params: {fast: 9, slow: 21}, gate: 'with'}. A gate refuses ENTRIES its state does not allow (a refused signal still closes an opposite position); a study on a longer timeframe is read from its last closed bar. backtest reports every study's edge by state (byStudy)." },
  legacy: { type: "boolean", description: "Run with the engine's pre-consolidation conventions (LEGACY_EXEC) to reproduce an old recorded result. Default false." },
};
const PERIODS = { type: "array", items: { type: "object" },
  description: "Window-start ranges to report: [{label, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD'}]. Default: all history, 2026, 2026 Jan-Mar, 2026 Apr-Jul." };
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const yearOf = (ms) => new Date(ms).getUTCFullYear();
function groupStats(trades) {
  let net = 0, wins = 0, gw = 0, gl = 0;
  for (const t of trades) { net += t.pnl; if (t.pnl > 0) { wins++; gw += t.pnl; } else gl -= t.pnl; }
  return { trades: trades.length, net: Math.round(net), winRate: trades.length ? L.pct(wins / trades.length) : 0,
           profitFactor: gl > 0 ? Math.round((gw / gl) * 1000) / 1000 : null };
}
const compactTrade = (t) => ({
  entry: L.iso(t.entryTime), exit: L.iso(t.exitTime), dir: t.dir === 1 ? "long" : "short", contracts: t.contracts,
  entryPrice: +t.entryPrice.toFixed(2), exitPrice: +t.exitPrice.toFixed(2), reason: t.reason, pnl: +t.pnl.toFixed(2),
  ...(t.entryType && t.entryType !== "market" ? { order: t.limitFill ? "stop->limit" : t.entryType } : {}),
});

// Snap a date to the chart's window grid, as the chart's date box does.
function snapStart(ms, R) {
  const b = L.bars(), first = b.ts[0], last = Math.floor((b.ts[b.count - 1] - R.windowDays * L.DAY - first) / L.DAY);
  return first + Math.max(0, Math.min(last, Math.round((ms - first) / L.DAY))) * L.DAY;
}

// ── the tools ────────────────────────────────────────────────────────────
export const TOOLS = [
  {
    name: "list_strategies",
    description: "List the chart lab's strategies: id, name, signal timeframe, order model and whether it holds overnight. Every other tool takes one of these ids.",
    inputSchema: obj({ query: { type: "string", description: "Optional text to match in the id or name." } }),
    async run({ query } = {}) {
      const q = (query || "").toLowerCase();
      return [...(await L.strategies()).values()]
        .filter((s) => !q || s.id.toLowerCase().includes(q) || (s.name || "").toLowerCase().includes(q))
        .map((s) => ({ id: s.id, name: s.name, timeframeMin: s.timeframeMin ?? 1, params: (s.params || []).length,
                       entry: s.execDefaults?.entryType ?? "market", overnight: s.execDefaults?.intradayOnly === false,
                       ...(s.evals ? { ownEvalSettings: Object.keys(s.evals) } : {}) }));
    },
  },
  {
    name: "list_studies",
    description: "The indicator studies that can be added to any configuration (the 'studies' argument of the other tools, and the chart's Indicators panel): each type's parameters with defaults and ranges, the timeframes it can run on, and the gates it offers with what each means. A study with gate 'off' only reports its edge by state; with a gate it refuses entries.",
    inputSchema: obj({}),
    async run() {
      return {
        timeframes: [0, ...STUDY_TFS], note: "tf 0 = the strategy's signal timeframe. Readings are causal: a study on a longer timeframe than the signal is read from its last closed bar.",
        studies: Object.entries(STUDIES).map(([type, d]) => {
          const p0 = Object.fromEntries(d.params.map((x) => [x.key, x.default]));
          return { type, name: d.name, group: d.group, pane: d.pane, kind: d.kind,
                   params: d.params.map((x) => ({ key: x.key, label: x.label, default: x.default, ...(x.options ? { options: x.options.map((o) => o[0]) } : { min: x.min, max: x.max }) })),
                   gates: Object.fromEntries(d.gates.map((g) => [g, gateLabel(type, g, p0)])), ...(d.hint ? { hint: d.hint } : {}) };
        }),
      };
    },
  },
  {
    name: "describe_strategy",
    description: "Everything about one strategy: its parameters (default, range, options, hint), the execution, filter and rules defaults it ships with, and the notes at the top of its file (its history and measured results).",
    inputSchema: obj({ strategy: CFG.strategy }, ["strategy"]),
    async run({ strategy }) {
      const s = (await L.strategies()).get(strategy);
      if (!s) throw new L.UserError(`unknown strategy "${strategy}"; call list_strategies`);
      let notes = "";
      try {
        const src = fs.readFileSync(path.join(STRATEGY_DIR, s.file), "utf8");
        notes = src.split(/\r?\n/).filter((l, k, a) => a.slice(0, k + 1).every((x) => x.startsWith("//") || x.trim() === "")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n").trim();
      } catch { /* notes are a courtesy */ }
      return {
        id: s.id, name: s.name, description: s.description, timeframeMin: s.timeframeMin ?? 1,
        params: (s.params || []).map((d) => ({ key: d.key, label: d.label, type: d.type, default: d.default,
                                                ...(d.min != null ? { min: d.min, max: d.max } : {}), ...(d.options ? { options: d.options.map((o) => o[0]) } : {}),
                                                ...(d.hint ? { hint: d.hint } : {}) })),
        execDefaults: s.execDefaults || {}, filterDefaults: s.filterDefaults || {}, rulesDefaults: s.rulesDefaults || {},
        ...(s.evals ? { evalSettings: s.evals } : {}),
        notes: notes.length > 6000 ? notes.slice(0, 6000) + "\n[... truncated]" : notes,
      };
    },
  },
  {
    name: "backtest",
    description: "Run one strategy configuration over the full 2019-2026 MNQ 1-minute history (or a date range) and report its trades: count, win rate, profit factor, expectancy, net, worst drawdown of closed-trade equity; results by year, exit reason, entry hour (CT), weekday, direction and volatility regime; daily P&L statistics with the probabilistic Sharpe ratio and minimum track record; and optionally the trades themselves. Uses the same engine as the chart.",
    inputSchema: obj({ ...CFG, from: { type: "string", description: "Entry dates from (YYYY-MM-DD). Default: start of data." },
                       to: { type: "string", description: "Entry dates before (YYYY-MM-DD). Default: end of data." },
                       trades: { type: "integer", description: "How many of the most recent trades to return (0-500). Default 0." } }, ["strategy"]),
    async run(a) {
      const cfg = await L.resolveConfig(a);
      const from = L.parseDate(a.from, "from") ?? -Infinity, to = L.parseDate(a.to, "to") ?? Infinity;
      const run = L.fullRun(cfg);
      const tr = run.trades.filter((t) => t.entryTime >= from && t.entryTime < to);
      const st = tradeStats(tr);
      let cum = 0, peak = 0, maxDD = 0, bars = 0;
      for (const t of tr) { cum += t.pnl; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); bars += t.bars; }
      const group = (key) => { const m = new Map(); for (const t of tr) { const k = key(t); if (!m.has(k)) m.set(k, []); m.get(k).push(t); } return m; };
      const years = group((t) => yearOf(t.entryTime)), exits = group((t) => t.reason);
      const hours = group((t) => (t.entryCt == null ? null : Math.floor(t.entryCt / 60)));
      const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const weekdays = group((t) => WEEKDAY[new Date(t.tday * L.DAY).getUTCDay()]);
      // Volatility regime: the ATR at the signal against that year's median, in
      // quintiles -- relative to its own year, since MNQ's ATR quadrupled 2019-2026.
      const yearMedian = new Map();
      for (const [y, ts] of years) { const a2 = ts.map((t) => t.atr).filter(Number.isFinite).sort((p, q) => p - q); yearMedian.set(y, a2[a2.length >> 1]); }
      const rel = tr.map((t) => t.atr / yearMedian.get(yearOf(t.entryTime))).filter(Number.isFinite).sort((p, q) => p - q);
      const cuts = [0.2, 0.4, 0.6, 0.8].map((q) => rel[Math.floor(q * (rel.length - 1))]);
      const vol = group((t) => { const r = t.atr / yearMedian.get(yearOf(t.entryTime)); return Number.isFinite(r) ? `Q${1 + cuts.filter((c) => r > c).length}` : null; });
      const table = (m, order) => [...m].filter(([k]) => k != null).sort((p, q) => (order ? order(p[0], q[0]) : 0)).map(([k, t]) => ({ key: k, ...groupStats(t) }));
      const days = L.dailyStats(tr, Number.isFinite(from) ? from : -Infinity, Number.isFinite(to) ? to : Infinity);
      const n = Math.max(0, Math.min(500, Math.trunc(a.trades || 0)));
      // Every study's states at these trades' signals (src/studies.mjs studyEdge).
      const byStudy = cfg.studies.length ? cfg.studies.map((st) => studyEdge(tr, studyOnSignal(L.bars(), L.signalBars(cfg), st))) : null;
      return {
        strategy: cfg.s.id, changed: L.changed(cfg), costs: L.costLine(cfg.exec), warnings: cfg.warnings,
        period: { from: tr.length ? L.iso(tr[0].entryTime) : null, to: tr.length ? L.iso(tr[tr.length - 1].entryTime) : null },
        stats: { trades: st.n, winRate: L.pct(st.winRate / 100), profitFactor: Number.isFinite(st.profitFactor) ? +st.profitFactor.toFixed(3) : null,
                 expectancy: +st.expectancy.toFixed(2), net: Math.round(st.pnl), avgWin: Math.round(st.avgWin), avgLoss: Math.round(st.avgLoss),
                 maxWin: Math.round(st.maxWin || 0), maxLoss: Math.round(st.maxLoss || 0), longs: st.longs, shorts: st.shorts,
                 tradesPerDay: +st.tradesPerDay.toFixed(2), fees: Math.round(st.fees), maxDrawdown: Math.round(maxDD),
                 avgHoldMin: tr.length ? Math.round((bars / tr.length) * run.tfMin) : 0 },
        byYear: [...years].map(([y, t]) => ({ year: y, ...groupStats(t) })),
        byExit: Object.fromEntries([...exits].map(([k, t]) => [k, groupStats(t)])),
        byEntryHourCt: table(hours, (p, q) => ((p + 7) % 24) - ((q + 7) % 24)),
        byWeekday: table(weekdays, (p, q) => WEEKDAY.indexOf(p) - WEEKDAY.indexOf(q)),
        byDirection: table(group((t) => (t.dir === 1 ? "long" : "short"))),
        byVolatility: table(vol, (p, q) => p.localeCompare(q)),
        daily: days,
        ...(byStudy ? { byStudy } : {}),
        notes: { daily: L.DAILY_NOTE, byVolatility: "ATR at the signal relative to the median ATR of that year's trades, in quintiles (Q1 calmest)", byEntryHourCt: "hour of the fill, Chicago time, in session order from 17:00", byWeekday: "the trading day the trade closed in (its session opens at 17:00 CT the evening before)",
                 ...(byStudy ? { byStudy: "each study's state at every trade's signal bar, read as a gate would read it; all = these trades, y2026 = those entered in 2026. A bucket shows what gating on it would have kept, before any knock-on effect on the trades that follow -- confirm a gate with pass_rate or compare." } : {}) },
        ...(n ? { trades: tr.slice(-n).map(compactTrade) } : {}),
        runMs: run.ms,
      };
    },
  },
  {
    name: "pass_rate",
    description: "The combine pass rate of a configuration, by period. 'calendar' replays a 30-day (rules.windowDays) combine started on every day, with the full rule set -- the chart's sweep. 'bootstrap' draws 12,000 runs of trading days in 5-day blocks -- the method research/lib_shipped.mjs quotes. Default periods are the house rule: all history, 2026, and 2026 Jan-Mar vs Apr-Jul.",
    inputSchema: obj({ ...CFG, method: { type: "string", enum: ["calendar", "bootstrap", "both"], description: "Default 'calendar'." }, periods: PERIODS }, ["strategy"]),
    async run(a) {
      const cfg = await L.resolveConfig(a), method = a.method || "calendar";
      const run = L.fullRun(cfg), R = cfg.rules;
      const rows = L.readPeriods(a.periods).map((p) => ({
        period: p.label, from: L.isoDay(p.from), to: Number.isFinite(p.to) ? L.isoDay(p.to) : "end of data",
        ...(method !== "bootstrap" ? { calendar: L.calendar(run.trades, R, L.windowStarts(R, p.from, p.to)) } : {}),
        ...(method !== "calendar" ? { bootstrap: L.bootstrap(run.trades, R, p.from, p.to) } : {}),
      }));
      return {
        strategy: cfg.s.id, eval: cfg.eval, changed: L.changed(cfg), costs: L.costLine(cfg.exec),
        rules: { profitTarget: R.profitTarget, trailingDD: R.trailingDD, trailingMode: R.trailingMode, lockAtBreakeven: R.lockAtBreakeven,
                 windowDays: R.windowDays, consistencyPct: R.consistencyGatesPass ? R.consistencyPct : 0, dailyLossLimit: R.dailyLossLimit,
                 circuitBreaker: R.circuitBreaker, dailyProfitStop: R.dailyProfitStop, minTradingDays: R.minTradingDays },
        warnings: [...cfg.warnings, ...(method !== "calendar" ? L.bootstrapCaveats(R, cfg.exec) : [])],
        methods: { ...(method !== "bootstrap" ? { calendar: L.CALENDAR } : {}), ...(method !== "calendar" ? { bootstrap: L.BOOTSTRAP } : {}), ci95: L.CI_NOTE },
        periods: rows, trades: run.trades.length,
      };
    },
  },
  {
    name: "compare",
    description: "Two configurations on the SAME windows, paired: each one's pass rate, how many windows only A passes and only B passes, and how many calendar months each wins -- by period. Neighbouring windows share most of their days, so the months count is the honest robustness read, not the window count.",
    inputSchema: obj({ a: obj(CFG, ["strategy"]), b: obj(CFG, ["strategy"]), periods: PERIODS }, ["a", "b"]),
    async run({ a, b, periods }) {
      const A = await L.resolveConfig(a), Bc = await L.resolveConfig(b);
      const ta = L.fullRun(A).trades, tb = L.fullRun(Bc).trades;
      const R0 = { windowDays: Math.max(A.rules.windowDays, Bc.rules.windowDays) };
      const rows = L.readPeriods(periods).map((p) => {
        const starts = L.windowStarts(R0, p.from, p.to);
        let pa = 0, pb = 0, both = 0, onlyA = 0, onlyB = 0, na = 0, nb = 0;
        const months = new Map();
        for (const s of starts) {
          const ra = replayWindow(ta, s, A.rules), rb = replayWindow(tb, s, Bc.rules);
          const xa = ra.outcome === OUTCOME.PASS, xb = rb.outcome === OUTCOME.PASS;
          pa += xa; pb += xb; both += xa && xb; onlyA += xa && !xb; onlyB += xb && !xa;
          na += ra.stats.netPnl; nb += rb.stats.netPnl;
          const m = L.isoDay(s).slice(0, 7), c = months.get(m) || [0, 0];
          c[0] += xa; c[1] += xb; months.set(m, c);
        }
        let mA = 0, mB = 0, mT = 0;
        for (const [x, y] of months.values()) { if (x > y) mA++; else if (y > x) mB++; else mT++; }
        const n = starts.length || 1;
        return { period: p.label, windows: starts.length, aPass: L.pct(pa / n), bPass: L.pct(pb / n), both, onlyA, onlyB,
                 neither: starts.length - both - onlyA - onlyB, aMeanNet: Math.round(na / n), bMeanNet: Math.round(nb / n),
                 monthsAWins: mA, monthsBWins: mB, monthsTied: mT };
      });
      return { a: { strategy: A.s.id, eval: A.eval, changed: L.changed(A), costs: L.costLine(A.exec) }, b: { strategy: Bc.s.id, eval: Bc.eval, changed: L.changed(Bc), costs: L.costLine(Bc.exec) },
               warnings: [...A.warnings.map((w) => "a: " + w), ...Bc.warnings.map((w) => "b: " + w)], method: L.CALENDAR, periods: rows };
    },
  },
  {
    name: "search",
    description: "Grid-search a strategy with a holdout and an overfitting check. Every combination of the grid is run on the data the periods need (fast), ranked on the IN-SAMPLE pass rate only, and reported with its OUT-OF-SAMPLE pass rate; it also gives the in/out-of-sample rank correlation and the probability of backtest overfitting (CSCV, Bailey et al.) over the whole evaluation span. In-sample windows whose 30 days run into the out-of-sample period are purged, so the in-sample never sees out-of-sample trades. Defaults: in-sample 2026 Jan-Mar, out-of-sample 2026 Apr-Jul.",
    inputSchema: obj({ ...CFG,
      grid: { type: "object", description: "Values to try, keyed 'params.<key>' | 'exec.<key>' | 'filter.<key>' | 'rules.<key>', or for the studies passed 'studies.<n>.params.<key>' | 'studies.<n>.tf' | 'studies.<n>.gate', e.g. {\"exec.slAtrMult\": [2, 3, 5], \"studies.0.params.length\": [20, 50, 100]}." },
      inSample: { type: "object", description: "{from, to} window-start dates for ranking. Default 2026-01-01 to 2026-04-01." },
      outOfSample: { type: "object", description: "{from, to} window-start dates held out. Default 2026-04-01 to the end." },
      top: { type: "integer", description: "How many of the best in-sample to report (default 10)." },
      maxConfigs: { type: "integer", description: "Most combinations to run (default 300, at most 3000); a larger grid is sampled." },
      timeBudgetSec: { type: "integer", description: "Stop and report what is done after this long (default 90)." },
      purge: { type: "boolean", description: "Drop in-sample windows whose days run into the out-of-sample period (default true): without it the in-sample already sees out-of-sample trades." } }, ["strategy", "grid"]),
    async run(a) {
      const space = gridSpace(a.grid, Math.max(1, Math.min(3000, Math.trunc(a.maxConfigs || 300))), a.studies);
      const isP = { from: L.parseDate(a.inSample?.from, "inSample.from") ?? Date.UTC(2026, 0, 1), to: L.parseDate(a.inSample?.to, "inSample.to") ?? Date.UTC(2026, 3, 1) };
      const oosP = { from: L.parseDate(a.outOfSample?.from, "outOfSample.from") ?? Date.UTC(2026, 3, 1), to: L.parseDate(a.outOfSample?.to, "outOfSample.to") ?? Infinity };
      const base = await L.resolveConfig(a), W = gridWindowDays(base, a.grid), R0 = { windowDays: W };
      const oosStarts = L.windowStarts(R0, oosP.from, oosP.to);
      // Purge (Lopez de Prado): a 30-day window started late in-sample runs
      // into the out-of-sample days, so its outcome already knows them. Drop
      // every in-sample window whose days touch the out-of-sample windows'.
      const oosLo = oosStarts.length ? oosStarts[0] : Infinity, oosHi = oosStarts.length ? oosStarts[oosStarts.length - 1] + W * L.DAY : -Infinity;
      const isAll = L.windowStarts(R0, isP.from, isP.to);
      const isStarts = a.purge === false ? isAll : isAll.filter((s) => s + W * L.DAY <= oosLo || s >= oosHi);
      const purged = isAll.length - isStarts.length;
      const starts = [...new Set([...isStarts, ...oosStarts])].sort((x, y) => x - y);
      if (starts.length < 8 || !isStarts.length || !oosStarts.length) throw new L.UserError("the periods hold too few windows (after purging the in-sample windows that overlap the out-of-sample)");
      const inIs = new Set(isStarts), inOos = new Set(oosStarts);
      const isMask = starts.map((s) => inIs.has(s)), oosMask = starts.map((s) => inOos.has(s));
      const rate = (pass, mask) => { let n = 0, p = 0; pass.forEach((x, k) => { if (mask[k]) { n++; p += x; } }); return n ? p / n : 0; };
      const grid = await evalGrid(space, a, starts, W, Math.max(5, Math.trunc(a.timeBudgetSec || 90)) * 1000);
      const results = grid.results.map((r) => ({ ...r, is: rate(r.pass, isMask), oos: rate(r.pass, oosMask) }));
      if (!results.length) throw new L.UserError("no configuration finished inside the time budget");
      // in-sample rank vs out-of-sample rank
      const rankOf = (vals) => { const ix = vals.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(vals.length);
        for (let i = 0; i < ix.length;) { let j = i; while (j + 1 < ix.length && ix[j + 1][0] === ix[i][0]) j++; for (let k = i; k <= j; k++) r[ix[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
      const ri = rankOf(results.map((r) => r.is)), ro = rankOf(results.map((r) => r.oos));
      const N = results.length, mi = (N + 1) / 2;
      let num = 0, di = 0, dd = 0;
      for (let k = 0; k < N; k++) { num += (ri[k] - mi) * (ro[k] - mi); di += (ri[k] - mi) ** 2; dd += (ro[k] - mi) ** 2; }
      const spearman = di > 0 && dd > 0 ? num / Math.sqrt(di * dd) : null;
      // Ties on the in-sample rate keep their (seeded, random) run order: breaking
      // them on the out-of-sample rate would let the holdout pick the winner.
      const sorted = results.map((r, k) => ({ ...r, k })).sort((x, y) => y.is - x.is || x.k - y.k);
      // PBO by combinatorially symmetric cross-validation: split the windows into 8
      // contiguous blocks, and for every way of calling 4 of them in-sample, ask
      // where the in-sample winner lands out of sample.
      let pbo = null;
      if (N >= 2) {
        const S = 8, nb = starts.length, blockOf = starts.map((_, k) => Math.min(S - 1, Math.floor((k * S) / nb)));
        const pc = results.map((r) => { const c = new Array(S).fill(0); r.pass.forEach((x, k) => { c[blockOf[k]] += x; }); return c; });
        const wc = new Array(S).fill(0); blockOf.forEach((b) => wc[b]++);
        let splits = 0, over = 0;
        for (let m = 0; m < 1 << S; m++) {
          if (popcount(m) !== S / 2) continue;
          splits++;
          const rateIn = pc.map((c) => sumWhere(c, m, true) / sumWhere(wc, m, true));
          const rateOut = pc.map((c) => sumWhere(c, m, false) / sumWhere(wc, m, false));
          let best = 0; for (let k = 1; k < N; k++) if (rateIn[k] > rateIn[best]) best = k;
          const w = rankOf(rateOut)[best] / (N + 1);
          if (w <= 0.5) over++;
        }
        pbo = Math.round((over / splits) * 1000) / 1000;
      }
      const top = Math.max(1, Math.min(50, Math.trunc(a.top || 10)));
      const best = sorted[0];
      return {
        strategy: base.s.id, costs: L.costLine(base.exec), warnings: base.warnings,
        tried: N, of: space.total, sampled: space.sampled, stoppedEarly: grid.stoppedEarly,
        method: `${L.CALENDAR}; ranked on in-sample only`,
        inSample: { from: L.isoDay(isP.from), to: Number.isFinite(isP.to) ? L.isoDay(isP.to) : "end", windows: isMask.filter(Boolean).length, purged },
        outOfSample: { from: L.isoDay(oosP.from), to: Number.isFinite(oosP.to) ? L.isoDay(oosP.to) : "end", windows: oosMask.filter(Boolean).length },
        top: sorted.slice(0, top).map((r) => ({ settings: r.set, inSample: L.pct(r.is), outOfSample: L.pct(r.oos), trades: r.trades })),
        overfitting: {
          inVsOutRankCorrelation: spearman == null ? null : +spearman.toFixed(3),
          bestInSampleLandsOutOfSample: `rank ${Math.round(ro[best.k])} of ${N} (1 = worst)`,
          pbo, pboMethod: "CSCV over 8 contiguous blocks of the evaluation windows, 70 in/out splits: the share of splits where the in-sample best lands at or below the out-of-sample median (Bailey, Borwein, Lopez de Prado & Zhu). Near 0 = the ranking carries over; 0.5 or more = it does not. Windows near a block edge share days with the next block, which flatters the carry-over a little.",
        },
        note: `The best of ${N} in-sample results overstates its edge by construction; judge it by its out-of-sample column and the overfitting figures.`,
      };
    },
  },
  {
    name: "walk_forward",
    description: "Test the SELECTION, not a configuration: step through time (a month at a time by default), each step choosing the grid's best configuration on the trailing in-sample months -- only windows that had finished before the step began -- and trading it for the step. Reports the walk-forward's out-of-sample pass rate against the base configuration held fixed, the grid's median configuration, the best single configuration in hindsight, and the per-step hindsight ceiling no selection rule can beat -- the honest answer to 'does re-optimising help?'. Default: steps through 2026, three months in-sample.",
    inputSchema: obj({ ...CFG,
      grid: { type: "object", description: "Values to choose among, keyed 'params.<key>' | 'exec.<key>' | 'filter.<key>' | 'rules.<key>' | 'studies.<n>.params.<key>' | 'studies.<n>.tf' | 'studies.<n>.gate' (as in search)." },
      from: { type: "string", description: "Start of the first out-of-sample step (YYYY-MM-DD). Default 2026-01-01." },
      to: { type: "string", description: "No step starts on or after this date (YYYY-MM-DD). Default: end of data." },
      inSampleMonths: { type: "integer", description: "Trailing months each step chooses on (default 3)." },
      stepMonths: { type: "integer", description: "Months traded before choosing again (default 1)." },
      maxConfigs: { type: "integer", description: "Most grid combinations (default 200, at most 1000); a larger grid is sampled." },
      timeBudgetSec: { type: "integer", description: "Stop running configurations after this long and walk forward over those done (default 120)." } }, ["strategy", "grid"]),
    async run(a) {
      const space = gridSpace(a.grid, Math.max(1, Math.min(1000, Math.trunc(a.maxConfigs || 200))), a.studies);
      const from = L.parseDate(a.from, "from") ?? Date.UTC(2026, 0, 1), to = L.parseDate(a.to, "to") ?? Infinity;
      const isM = Math.max(1, Math.trunc(a.inSampleMonths || 3)), stepM = Math.max(1, Math.trunc(a.stepMonths || 1));
      const base = await L.resolveConfig(a), W = gridWindowDays(base, a.grid);
      const starts = L.windowStarts({ windowDays: W }, addMonths(from, -isM), to);
      if (!starts.length) throw new L.UserError("no windows between the first in-sample month and the end");
      const grid = await evalGrid(space, a, starts, W, Math.max(5, Math.trunc(a.timeBudgetSec || 120)) * 1000);
      const configs = grid.results;
      if (!configs.length) throw new L.UserError("no configuration finished inside the time budget");
      const baseTrades = L.rangeRun(base, starts[0], starts[starts.length - 1] + W * L.DAY);
      const basePass = starts.map((s) => replayWindow(baseTrades, s, base.rules).outcome === OUTCOME.PASS);
      const rate = (flags, ks) => ks.reduce((n, k) => n + flags[k], 0) / ks.length;
      const steps = [], oos = [];          // oos: [window index, the chosen configuration]
      let oracle = 0;
      for (let m = from; m <= starts[starts.length - 1] && m < to; m = addMonths(m, stepM)) {
        const mEnd = addMonths(m, stepM), mIs = addMonths(m, -isM);
        // In-sample: windows that started in the trailing months AND had run their
        // course before the step begins -- what a trader could have known then.
        const inIs = [], inOos = [];
        starts.forEach((s, k) => { if (s >= mIs && s + W * L.DAY <= m) inIs.push(k); else if (s >= m && s < mEnd) inOos.push(k); });
        if (!inOos.length || !inIs.length) continue;
        let best = 0;
        for (let c = 1; c < configs.length; c++) if (rate(configs[c].pass, inIs) > rate(configs[best].pass, inIs)) best = c;
        for (const k of inOos) oos.push([k, best]);
        oracle += Math.max(...configs.map((c) => rate(c.pass, inOos))) * inOos.length;
        steps.push({ outOfSample: `${L.isoDay(starts[inOos[0]])} to ${L.isoDay(starts[inOos[inOos.length - 1]])}`, windows: inOos.length,
                     chose: configs[best].set, inSamplePass: L.pct(rate(configs[best].pass, inIs)),
                     outOfSamplePass: L.pct(rate(configs[best].pass, inOos)), basePass: L.pct(rate(basePass, inOos)) });
      }
      if (!steps.length) throw new L.UserError("no step had both in-sample and out-of-sample windows -- move 'from' later or shorten inSampleMonths");
      const n = oos.length, wf = oos.reduce((s, [k, c]) => s + configs[c].pass[k], 0) / n;
      const fixed = configs.map((c) => oos.reduce((s, [k]) => s + c.pass[k], 0) / n).sort((p, q) => p - q);
      return {
        strategy: base.s.id, changed: L.changed(base), costs: L.costLine(base.exec), warnings: base.warnings,
        configurations: configs.length, of: space.total, sampled: space.sampled, stoppedEarly: grid.stoppedEarly,
        method: `${L.CALENDAR}; each step trades the configuration with the best pass rate over its in-sample windows`,
        inSampleMonths: isM, stepMonths: stepM,
        outOfSample: {
          windows: n, walkForward: L.pct(wf), ci95: L.wilson(wf, n / W), baseFixed: L.pct(oos.reduce((s, [k]) => s + basePass[k], 0) / n),
          medianConfiguration: L.pct(fixed[(fixed.length - 1) >> 1]), bestFixedInHindsight: L.pct(fixed[fixed.length - 1]), perStepCeiling: L.pct(oracle / n),
        },
        steps,
        notes: {
          reading: "If walkForward does not beat baseFixed, re-optimising on this grid adds noise, not edge. bestFixedInHindsight is the best single configuration chosen after the fact; perStepCeiling picks the best one for every step after the fact -- no selection rule can beat it.",
          ci95: L.CI_NOTE,
        },
      };
    },
  },
  {
    name: "sensitivity",
    description: "How fragile a configuration is: each setting moved either side of its value, one at a time, with pass rates over all history and over 2026 -- a knife-edge optimum shows as a sharp drop next to the chosen value. Numbers go to x0.6/0.8/1.2/1.4 (small whole numbers +-1 and +-2, times of day +-30 and +-60 minutes), choices to every option; slippage is stressed at 0-3 ticks. Default settings: the strategy's numeric parameters, the stop and target multiples, and slippage.",
    inputSchema: obj({ ...CFG,
      keys: { type: "array", items: { type: "string" }, description: "Settings to vary, e.g. ['params.period', 'exec.slAtrMult', 'exec.entryType', 'studies.0.params.lo', 'studies.0.tf']. Default: see above." },
      timeBudgetSec: { type: "integer", description: "Stop and report what is done after this long (default 120)." } }, ["strategy"]),
    async run(a) {
      const base = await L.resolveConfig(a);
      const t0 = performance.now(), budget = Math.max(5, Math.trunc(a.timeBudgetSec || 120)) * 1000;
      const startsCache = new Map();
      const startsFrom = (R, from) => { const k = `${R.windowDays}|${from}`; if (!startsCache.has(k)) startsCache.set(k, L.windowStarts(R, from, Infinity)); return startsCache.get(k); };
      const score = (cfg) => {
        const tr = L.fullRun(cfg).trades, R = cfg.rules;
        return { all: L.calendar(tr, R, startsFrom(R, -Infinity)).pass, y2026: L.calendar(tr, R, startsFrom(R, Date.UTC(2026, 0, 1))).pass, trades: tr.length };
      };
      const descs = new Map((base.s.params || []).map((d) => [d.key, d]));
      const groups = { params: base.params, exec: base.exec, filter: base.filter, rules: base.rules };
      let keys = a.keys;
      if (keys == null) {
        keys = (base.s.params || []).filter((d) => ["int", "float", "time"].includes(d.type) && !/^viz/.test(d.key)).map((d) => `params.${d.key}`);
        keys.push(base.exec.tpMode === "rr" ? "exec.tpRR" : "exec.tpAtrMult", "exec.slAtrMult", "exec.slippageTicks");
      }
      if (!Array.isArray(keys) || !keys.length) throw new L.UserError("keys must be a non-empty array");
      for (const key of keys) {
        if (studySlot(key, base.studies)) continue;
        const m = /^(params|exec|filter|rules)\.([A-Za-z0-9_]+)$/.exec(key);
        if (!m) throw new L.UserError(`key "${key}" must look like params.<key>, exec.<key>, filter.<key>, rules.<key> or studies.<n>.params.<key> / .tf / .gate`);
        if (!(m[2] in groups[m[1]])) throw new L.UserError(`unknown setting "${key}"`);
      }
      const baseScore = score(base), out = [];
      let stoppedEarly = false;
      for (const key of keys) {
        if (performance.now() - t0 > budget) { stoppedEarly = true; break; }
        // A study's setting: its own descriptor, or its timeframes and gates as choices.
        const slot = studySlot(key, base.studies);
        const [g, k] = key.split(".");
        const cur = slot ? (slot.param ? base.studies[slot.n].params[slot.param] : base.studies[slot.n][slot.field]) : groups[g][k];
        const values = !slot ? sensitivityValues(key, cur, descs.get(k))
                     : slot.field === "tf" ? [...new Set([0, ...STUDY_TFS.filter((m) => m <= 60), cur])].sort((p, q) => p - q)
                     : slot.field === "gate" ? ["off", ...STUDIES[base.studies[slot.n].type].gates]
                     : sensitivityValues(`params.${slot.param}`, cur, slot.desc);
        if (!values) { out.push({ key, current: cur, skipped: "no natural neighbours (a zero or open-ended setting): try explicit values with search" }); continue; }
        const rows = [];
        for (const v of values) {
          if (performance.now() - t0 > budget) { stoppedEarly = true; break; }
          if (v === cur) { rows.push({ value: v, current: true, ...baseScore }); continue; }
          const o = { params: { ...(a.params || {}) }, exec: { ...(a.exec || {}) }, filter: { ...(a.filter || {}) }, rules: { ...(a.rules || {}) }, studies: cloneStudies(a.studies) };
          if (slot) setStudy(o.studies, slot, v); else o[g][k] = v;
          rows.push({ value: v, ...score(await L.resolveConfig({ strategy: a.strategy, legacy: a.legacy, eval: a.eval, ...o })) });
        }
        const spread = (f) => Math.round((Math.max(...rows.map(f)) - Math.min(...rows.map(f))) * 10) / 10;
        const top = rows.reduce((p, q) => (q.y2026 > p.y2026 ? q : p));
        out.push({ key, current: cur, rows, spread2026: spread((r) => r.y2026), spreadAll: spread((r) => r.all), best2026: top.value,
                   ...(rows.length < values.length ? { partial: true } : {}) });
      }
      out.sort((p, q) => (q.spread2026 ?? -1) - (p.spread2026 ?? -1));
      return {
        strategy: base.s.id, changed: L.changed(base), costs: L.costLine(base.exec), warnings: base.warnings, method: L.CALENDAR,
        current: baseScore, keys: out, stoppedEarly,
        note: "Sorted by how far the 2026 pass rate moves across each setting's range. A large spread, or the current value on a narrow peak with its neighbours well below, marks a result that depends on the exact setting -- an optimum likely fitted to noise. 'all' is every window in history, 'y2026' the windows starting in 2026.",
      };
    },
  },
  {
    name: "window",
    description: "One 30-day combine window in detail -- what the chart's 'This window' panel shows: every trade (taken, or skipped by a daily rule) with times, prices, reason and the running P&L against the trailing floor, the day-by-day P&L, and how it resolved. The date snaps to the chart's window grid, as the chart's date box does.",
    inputSchema: obj({ ...CFG, date: { type: "string", description: "The window's first trading day, YYYY-MM-DD." } }, ["strategy", "date"]),
    async run(a) {
      const cfg = await L.resolveConfig(a);
      const start = snapStart(L.parseDate(a.date, "date"), cfg.rules);
      const r = replayWindow(L.fullRun(cfg).trades, start, cfg.rules);
      const b = L.bars(), first = indexAtOrAfter(b.ts, start);
      return {
        strategy: cfg.s.id, changed: L.changed(cfg), costs: L.costLine(cfg.exec), warnings: cfg.warnings,
        window: { start: L.iso(start), tradingDay: first < b.count ? L.isoDay(b.tday[first] * L.DAY) : null, end: L.iso(r.endMs) },
        outcome: r.outcome, resolvedAt: L.iso(r.passMs ?? r.failMs),
        stats: { net: Math.round(r.stats.netPnl), trades: r.stats.trades, skipped: r.stats.skipped, tradingDays: r.stats.tradingDays,
                 bestDay: Math.round(r.stats.bestDay), profitNeeded: Math.round(r.stats.profitNeeded), finalFloor: Math.round(r.stats.finalFloor),
                 closestToBreach: r.stats.minCushion == null ? null : Math.round(r.stats.minCushion) },
        trades: r.events.map((e) => ({ ...compactTrade(e.t), taken: e.taken, ...(e.skip ? { skipped: e.skip } : {}), cum: Math.round(e.cum), floor: Math.round(e.floor) })),
        days: r.days.map((d) => ({ day: L.isoDay(d.day * L.DAY), pnl: Math.round(d.pnl), trades: d.taken, ...(d.skipped ? { skipped: d.skipped } : {}) })),
      };
    },
  },
  {
    name: "bars",
    description: "Raw MNQ price bars for a time range (back-adjusted continuous contract, 2019-05 to 2026-07): time (UTC), open, high, low, close, volume and the bar's minute of the day in Chicago time. Resampled clock-aligned like the engine's.",
    inputSchema: obj({ from: { type: "string", description: "Start, YYYY-MM-DD or an ISO time (UTC)." }, to: { type: "string", description: "End, exclusive." },
                       timeframeMin: { type: "integer", description: "Bar size in minutes (1-1440). Default 1." },
                       limit: { type: "integer", description: "Most bars to return (default 500, at most 5000)." } }, ["from", "to"]),
    async run(a) {
      const b = L.bars(), from = L.parseDate(a.from, "from"), to = L.parseDate(a.to, "to");
      const tf = Math.max(1, Math.min(1440, Math.trunc(a.timeframeMin || 1))), lim = Math.max(1, Math.min(5000, Math.trunc(a.limit || 500)));
      const s = indexAtOrAfter(b.ts, from), e = indexAtOrAfter(b.ts, to);
      const t = resample(sliceBars(b, s, e), tf), n = t.close.length;
      const rows = [];
      for (let i = 0; i < Math.min(n, lim); i++) rows.push([L.iso(t.ts[i]), t.open[i], t.high[i], t.low[i], t.close[i], t.volume[i], t.ctMin ? t.ctMin[i] : null]);
      return { columns: ["timeUtc", "open", "high", "low", "close", "volume", "ctMin"], timeframeMin: tf, bars: rows, truncated: n > lim, available: n };
    },
  },
  {
    name: "chart_state",
    description: "What the person is looking at in the chart lab (http://localhost:5178) right now: the evaluation tab, the strategy and every setting, the indicators on the chart (and which gate entries), the 30-day window on screen, the visible time range, the window's result and trades, and the sweep's summary -- with each indicator's edge by state -- if one has run. Use it before answering about 'this window' or 'this trade'.",
    inputSchema: obj({}),
    async run() {
      const r = await chartFetch("/api/chart/state");
      return r;
    },
  },
  {
    name: "chart_apply",
    description: "Change what the chart lab shows: switch strategy or evaluation tab, set params / exec / filter / rules / funded settings (merged over the current ones), replace the indicator studies on the chart, move to a window by date, and optionally run the full sweep. Returns the chart's state after it has applied the change -- the same numbers the person now sees.",
    inputSchema: obj({ strategy: CFG.strategy, eval: { ...CFG.eval, description: "Switch the evaluation tab ('3000' or '1250'). Settings the eval decides reset; other changes carry over, as the tabs do." },
                       params: CFG.params, exec: CFG.exec, filter: CFG.filter, rules: CFG.rules,
                       studies: { ...CFG.studies, description: "REPLACES the chart's indicators: [{type, tf, params, gate}] (list_studies). [] removes them all." },
                       funded: { type: "object", description: "Funded-stage settings." },
                       date: { type: "string", description: "Move to the window starting this trading day (YYYY-MM-DD)." },
                       reset: { type: "boolean", description: "Start from the strategy's own defaults (under the eval) rather than the current settings." },
                       sweep: { type: "boolean", description: "Also run the full-history sweep and wait for it." } }),
    async run(a) {
      if (a.eval != null) { try { evalOf(a.eval); } catch (e) { throw new L.UserError(e.message); } }
      if (a.studies != null) { try { resolveStudies(a.studies, { strict: true }); } catch (e) { throw new L.UserError(`studies: ${e.message}; call list_studies`); } }
      if (a.strategy) await L.resolveConfig({ strategy: a.strategy, eval: a.eval, params: a.params, exec: a.exec, filter: a.filter, rules: a.rules });
      return chartFetch("/api/chart/apply", a);
    },
  },
  {
    name: "papers",
    description: "The research library in papers/: methodology papers on backtest overfitting and multiple testing, and the strategy literature behind the books here, each summarised with how it applies to this project. No arguments lists them; 'query' searches titles, tags and text; 'id' returns one in full.",
    inputSchema: obj({ query: { type: "string" }, id: { type: "string", description: "A paper's id from the list." } }),
    async run({ query, id } = {}) {
      const all = readPapers();
      if (id) {
        const p = all.find((x) => x.id === id);
        if (!p) throw new L.UserError(`no paper "${id}"; ids: ${all.map((x) => x.id).join(", ")}`);
        return p;
      }
      const q = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
      return all.filter((p) => q.every((w) => (p.title + " " + p.tags.join(" ") + " " + p.text).toLowerCase().includes(w)))
                .map(({ id, title, authors, year, venue, tags, oneLine, pdf }) => ({ id, title, authors, year, venue, tags, oneLine, pdf }));
    },
  },
];

function popcount(m) { let c = 0; while (m) { c += m & 1; m >>= 1; } return c; }
function sumWhere(arr, mask, inSet) { let s = 0; for (let j = 0; j < arr.length; j++) if (((mask >> j) & 1) === (inSet ? 1 : 0)) s += arr[j]; return s; }
const addMonths = (ms, k) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, d.getUTCDate()); };

// A grid's combinations in a seeded random order -- all of them, or `cap` drawn
// without replacement when there are more -- so a run cut short by its time
// budget has still tried an even spread of the grid. combo(idx, a) is one
// combination's overrides laid over the caller's own.
// A study's setting in a grid or sensitivity key: studies.<index>.tf,
// studies.<index>.gate or studies.<index>.params.<key>, for the request's studies.
const STUDY_KEY = /^studies\.(\d+)\.(tf|gate|params\.([A-Za-z0-9_]+))$/;
function studySlot(key, studies) {
  const m = STUDY_KEY.exec(key);
  if (!m) return null;
  const n = Number(m[1]), st = (studies || [])[n];
  if (!st) throw new L.UserError(`"${key}": there is no study ${n} -- pass it in 'studies'`);
  const D = STUDIES[st.type];
  if (!D) throw new L.UserError(`"${key}": unknown study type "${st.type}"`);
  if (m[3] && !D.params.some((d) => d.key === m[3])) throw new L.UserError(`"${key}": ${st.type} has no param "${m[3]}"; it has ${D.params.map((d) => d.key).join(", ") || "none"}`);
  return { n, field: m[3] ? "params" : m[2], param: m[3] || null, desc: m[3] ? D.params.find((d) => d.key === m[3]) : null };
}
const cloneStudies = (list) => (list || []).map((st) => ({ ...st, params: { ...(st.params || {}) } }));
function setStudy(studies, slot, v) {
  if (slot.param) studies[slot.n].params[slot.param] = v; else studies[slot.n][slot.field] = v;
}

function gridSpace(grid, cap, studies) {
  const keys = Object.keys(grid || {});
  if (!keys.length) throw new L.UserError("grid is empty");
  for (const k of keys) {
    if (!/^(params|exec|filter|rules)\.[A-Za-z0-9_]+$/.test(k) && !studySlot(k, studies))
      throw new L.UserError(`grid key "${k}" must look like params.<key>, exec.<key>, filter.<key>, rules.<key> or studies.<n>.params.<key> / .tf / .gate`);
    if (!Array.isArray(grid[k]) || !grid[k].length) throw new L.UserError(`grid["${k}"] must be a non-empty array`);
  }
  const total = keys.reduce((m, k) => m * grid[k].length, 1), r = mulberry32(7);
  if (total > 1e15) throw new L.UserError("the grid is too large to index; narrow it");
  let order;
  if (total <= 2e6) {
    order = Array.from({ length: total }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    order = order.slice(0, cap);
  } else {
    const seen = new Set();
    while (seen.size < cap) seen.add(Math.floor(r() * total));
    order = [...seen];
  }
  const combo = (idx, a) => {
    const o = { params: { ...(a.params || {}) }, exec: { ...(a.exec || {}) }, filter: { ...(a.filter || {}) }, rules: { ...(a.rules || {}) }, studies: cloneStudies(a.studies) }, set = {};
    for (const k of keys) {
      const v = grid[k][idx % grid[k].length]; idx = Math.floor(idx / grid[k].length);
      const slot = studySlot(k, a.studies);
      if (slot) setStudy(o.studies, slot, v); else { const [g, key] = k.split("."); o[g][key] = v; }
      set[k] = v;
    }
    return { o, set };
  };
  return { total, order, sampled: total > cap, combo };
}
// Windows sized for the longest window any combination uses, so every window
// evaluated fits inside the data.
const gridWindowDays = (base, grid) => Math.max(base.rules.windowDays, ...(grid["rules.windowDays"] || []).map(Number).filter(Number.isFinite));

// Every combination's pass (true) or not on every window start. Combinations
// that differ only in rules share one engine run, and a run's trades are dropped
// once its combinations are scored; the time budget is checked between runs.
async function evalGrid(space, a, starts, W, budgetMs) {
  const t0 = performance.now(), groups = new Map();
  for (const idx of space.order) {
    const { o, set } = space.combo(idx, a);
    const cfg = await L.resolveConfig({ strategy: a.strategy, legacy: a.legacy, eval: a.eval, studies: a.studies, ...o });
    const rk = JSON.stringify([cfg.params, cfg.exec, cfg.filter, gateKey(cfg.studies)]);
    if (!groups.has(rk)) groups.set(rk, []);
    groups.get(rk).push({ cfg, set });
  }
  const results = [];
  let stoppedEarly = false;
  for (const list of groups.values()) {
    if (performance.now() - t0 > budgetMs) { stoppedEarly = true; break; }
    const trades = L.rangeRun(list[0].cfg, starts[0], starts[starts.length - 1] + W * L.DAY);
    for (const { cfg, set } of list)
      results.push({ set, trades: trades.length, pass: starts.map((s) => replayWindow(trades, s, cfg.rules).outcome === OUTCOME.PASS) });
  }
  return { results, stoppedEarly };
}

// The values sensitivity tries for one setting, its current value among them;
// null when it has no natural neighbours.
const CHOICES = {
  "exec.entryType": ["market", "stop", "limit"], "exec.tpMode": ["atr", "rr"], "exec.sizingMode": ["fixed", "risk"],
  "exec.dayLossStopMode": ["price", "exact"], "exec.entryRefused": ["limit", "optimistic"], "exec.limitFillTp": ["high", "close"],
  "exec.fillBarStop": ["touch", "close"], "rules.trailingMode": ["eod", "intraday"],
};
function sensitivityValues(key, v, d) {
  const [g, k] = key.split(".");
  if (key === "exec.slippageTicks") return [...new Set([0, 1, 2, 3, v])].sort((p, q) => p - q);
  if (g === "params" && d && d.type === "select") return d.options.map((o) => o[0]);
  if (CHOICES[key]) return CHOICES[key];
  if (typeof v === "boolean") return [false, true];
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const pd = g === "params" ? d : null;
  const isInt = pd ? pd.type !== "float" : Number.isInteger(v) && !/(Mult|RR|Atr|Frac|Pct)$/.test(k);
  const step = pd && pd.step ? pd.step : isInt ? 1 : null;
  const lo = pd && pd.min != null ? pd.min : k === "contracts" ? 1 : 0, hi = pd && pd.max != null ? pd.max : Infinity;
  let raw;
  if (pd && pd.type === "time") raw = [-60, -30, 30, 60].map((m) => v + m);
  else if (isInt && Math.abs(v) < 5 * step) raw = [-2, -1, 1, 2].map((m) => v + m * step);
  else if (v === 0) { if (!step) return null; raw = [step, 2 * step, 4 * step]; }
  else raw = [0.6, 0.8, 1.2, 1.4].map((m) => v * m);
  const snap = (x) => +Math.min(hi, Math.max(lo, step ? Math.round(x / step) * step : +x.toPrecision(3))).toFixed(6);
  return [...new Set([v, ...raw.map(snap)])].sort((p, q) => p - q);
}

// The chart page talks to server.mjs; these tools talk to the same server.
async function chartFetch(p, body) {
  let res;
  try {
    res = await fetch(CHART + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  } catch {
    throw new L.UserError(`the chart lab is not running at ${CHART}. Start it (node server.mjs, or the chart-lab preview) and open the page.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new L.UserError(data.error || `chart lab answered ${res.status}`);
  return data;
}

// papers/<id>.md with a small front matter block: title, authors, year, venue,
// url, pdf, tags, oneLine.
function readPapers() {
  if (!fs.existsSync(PAPERS)) return [];
  return fs.readdirSync(PAPERS).filter((f) => f.endsWith(".md") && f !== "README.md").sort().map((f) => {
    const raw = fs.readFileSync(path.join(PAPERS, f), "utf8").replace(/\r\n/g, "\n");
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    const meta = {};
    if (m) for (const line of m[1].split("\n")) { const k = line.indexOf(":"); if (k > 0) meta[line.slice(0, k).trim()] = line.slice(k + 1).trim(); }
    const pdf = meta.pdf && fs.existsSync(path.join(PAPERS, meta.pdf)) ? `papers/${meta.pdf}` : null;
    return { id: f.replace(/\.md$/, ""), title: meta.title || f, authors: meta.authors || "", year: meta.year || "", venue: meta.venue || "",
             url: meta.url || "", tags: (meta.tags || "").split(",").map((t) => t.trim()).filter(Boolean), oneLine: meta.oneLine || "",
             pdf, text: m ? raw.slice(m[0].length).trim() : raw };
  });
}
