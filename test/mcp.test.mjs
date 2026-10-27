// The MCP server end to end.   node test/mcp.test.mjs
//
// Spawns mcp/server.mjs, speaks the protocol to it over stdio as a client does,
// calls every tool, and checks the numbers against the same questions asked of
// src/ directly -- the server must add nothing and lose nothing.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { resolveExec } from "../src/engine.mjs";
import { resolveRules, replayWindow, OUTCOME } from "../src/challenge.mjs";
import { NO_FILTER } from "../src/filters.mjs";
import { evalBase } from "../src/evals.mjs";
import { STUDIES, resolveStudy } from "../src/studies.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
const eq = (a, b, m = "") => { if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

// ── a minimal client ─────────────────────────────────────────────────────
const child = spawn(process.execPath, ["--max-old-space-size=8192", path.join(ROOT, "mcp", "server.mjs")], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "", buf = "", nextId = 1;
const pending = new Map(), stray = [];
child.stderr.on("data", (d) => { stderr += d; });
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { stray.push(line); continue; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); } else stray.push(line);
  }
});
const request = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = async (name, args) => {
  const r = await request("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`protocol error ${r.error.code}: ${r.error.message}`);
  const text = r.result.content[0].text;
  if (r.result.isError) return { error: text };
  return JSON.parse(text);
};

console.log("\nMCP server: protocol");
console.log("--------------------");
let init = null;
await t("initialize answers in the client's protocol version and offers tools", async () => {
  init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  eq(init.result.protocolVersion, "2025-06-18");
  if (!init.result.capabilities.tools) throw new Error("no tools capability");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
});
await t("ping, an unknown method, and tools/list", async () => {
  eq(JSON.stringify((await request("ping")).result), "{}");
  eq((await request("no/such/method")).error.code, -32601);
  const names = (await request("tools/list")).result.tools.map((x) => x.name);
  for (const n of ["list_strategies", "list_studies", "describe_strategy", "backtest", "pass_rate", "compare", "search", "walk_forward", "sensitivity", "window", "bars", "chart_state", "chart_apply", "papers"])
    if (!names.includes(n)) throw new Error(`missing tool ${n}`);
});

console.log("\nMCP server: tools against src/");
console.log("------------------------------");
const { bars } = loadBars(); const S = await loadStrategies();
const direct = (id, x = {}) => {
  const s = S.get(id);
  return runStrategy(bars, s, resolveParams(s, x.params || {}), resolveExec({ ...(s.execDefaults || {}), ...(x.exec || {}) }),
                     { filter: { ...NO_FILTER, ...(s.filterDefaults || {}), ...(x.filter || {}) } }).trades;
};
await t("list_strategies and describe_strategy", async () => {
  const list = await call("list_strategies", {});
  eq(list.length, S.size, "every strategy listed:");
  eq(list.find((x) => x.id === "donchian_shipped").entry, "stop", "the shipped book's order:");
  const d = await call("describe_strategy", { strategy: "donchian_shipped" });
  if (!d.params.some((p) => p.key === "effMin") || !d.notes.includes("SHIPPED")) throw new Error("params or notes missing");
});
await t("backtest: the same trades and net as running the engine directly", async () => {
  const r = await call("backtest", { strategy: "donchian_shipped", trades: 3 });
  const tr = direct("donchian_shipped");
  eq(r.stats.trades, tr.length, "trades:");
  eq(r.stats.net, Math.round(tr.reduce((a, x) => a + x.pnl, 0)), "net:");
  eq(r.trades.length, 3);
  const y = await call("backtest", { strategy: "momentum_roc", exec: { slippageTicks: 1 }, from: "2026-01-01" });
  const ty = direct("momentum_roc", { exec: { slippageTicks: 1 } }).filter((x) => x.entryTime >= Date.UTC(2026, 0, 1));
  eq(y.stats.trades, ty.length, "2026 trades with an override:");
});
await t("pass_rate: calendar windows equal replayWindow over the chart's grid; both methods labelled", async () => {
  const r = await call("pass_rate", { strategy: "donchian_shipped", method: "both" });
  const s = S.get("donchian_shipped"), R = resolveRules(s.rulesDefaults), tr = direct("donchian_shipped");
  const first = bars.ts[0], last = bars.ts[bars.count - 1] - R.windowDays * 86400000;
  let n = 0, p = 0;
  for (let st = first + Math.ceil((Date.UTC(2026, 0, 1) - first) / 86400000) * 86400000; st <= last; st += 86400000) { n++; p += replayWindow(tr, st, R).outcome === OUTCOME.PASS; }
  const row = r.periods.find((x) => x.period === "2026");
  eq(row.calendar.windows, n, "2026 windows:");
  eq(row.calendar.pass, Math.round((p / n) * 1000) / 10, "2026 pass rate:");
  if (!(row.bootstrap.pass >= 0) || !r.methods.bootstrap || !r.methods.calendar) throw new Error("bootstrap missing");
  eq(r.periods.map((x) => x.period).join(), "all history,2026,2026 Jan-Mar,2026 Apr-Jul", "the house periods:");
});
await t("strict inputs: an unknown key, a bad option and a non-causal fill are refused, not ignored", async () => {
  if (!(await call("backtest", { strategy: "donchian_shipped", exec: { slAtrMul: 3 } })).error?.includes("slAtrMul")) throw new Error("misspelt exec key accepted");
  if (!(await call("backtest", { strategy: "donchian_shipped", params: { nope: 1 } })).error?.includes("nope")) throw new Error("unknown param accepted");
  if (!(await call("backtest", { strategy: "tpl_oscillator", params: { osc: "macd" } })).error) throw new Error("a bad select value accepted");
  if (!(await call("backtest", { strategy: "momentum_roc", exec: { sameBarReentry: true } })).error) throw new Error("same-bar re-entry accepted");
  if (!(await call("backtest", { strategy: "no_such_book" })).error) throw new Error("an unknown strategy accepted");
  const w = await call("backtest", { strategy: "momentum_roc" });
  if (!w.warnings.some((x) => x.includes("slippage"))) throw new Error("no warning for a book without slippage");
});
await t("compare: a configuration against itself is a perfect tie", async () => {
  const r = await call("compare", { a: { strategy: "donchian_shipped" }, b: { strategy: "donchian_shipped" } });
  for (const p of r.periods) { eq(p.onlyA, 0); eq(p.onlyB, 0); eq(p.aPass, p.bPass); }
  const m = await call("compare", { a: { strategy: "donchian_shipped" }, b: { strategy: "donchian_shipped", exec: { entryType: "market" } } });
  if (!(m.periods[0].onlyA + m.periods[0].onlyB > 0)) throw new Error("stop vs market entries made no difference");
});
await t("search: ranks in-sample only, reports out-of-sample and an overfitting estimate", async () => {
  const r = await call("search", { strategy: "momentum_roc", exec: { slippageTicks: 1 }, grid: { "params.lookback": [5, 10, 20], "exec.slAtrMult": [1, 2] } });
  eq(r.tried, 6); eq(r.of, 6);
  for (let k = 1; k < r.top.length; k++) if (r.top[k].inSample > r.top[k - 1].inSample) throw new Error("not ranked by in-sample");
  if (!(r.overfitting.pbo >= 0 && r.overfitting.pbo <= 1)) throw new Error("no PBO");
  if (!(await call("search", { strategy: "momentum_roc", grid: { "params.lookbak": [5] } })).error) throw new Error("a misspelt grid key accepted");
});
await t("backtest breakdowns add up; daily statistics and pass-rate intervals are sane", async () => {
  const r = await call("backtest", { strategy: "donchian_shipped", from: "2026-01-01" });
  const sum = (rows) => rows.reduce((n, x) => n + x.trades, 0);
  eq(sum(r.byEntryHourCt), r.stats.trades, "by hour:"); eq(sum(r.byWeekday), r.stats.trades, "by weekday:"); eq(sum(r.byDirection), r.stats.trades, "by direction:");
  if (sum(r.byVolatility) > r.stats.trades || sum(r.byVolatility) < r.stats.trades * 0.95) throw new Error("volatility buckets do not cover the trades");
  if (!(r.daily.days > 100 && r.daily.psrVsZero >= 0 && r.daily.psrVsZero <= 1 && r.daily.sd > 0)) throw new Error("daily stats: " + JSON.stringify(r.daily));
  const p = await call("pass_rate", { strategy: "donchian_shipped", method: "both" });
  for (const row of p.periods) for (const m of [row.calendar, row.bootstrap]) {
    const [lo, hi] = m.ci95;
    if (!(lo <= m.pass && m.pass <= hi)) throw new Error(`${row.period}: ci95 ${lo}-${hi} misses ${m.pass}`);
  }
});
await t("walk_forward: a grid of just the base walks forward to the base; the ceilings are ordered", async () => {
  const one = await call("walk_forward", { strategy: "momentum_roc", exec: { slippageTicks: 1 }, grid: { "params.lookback": [12] } });
  const o1 = one.outOfSample;
  eq(o1.walkForward, o1.baseFixed, "walk-forward vs base:"); eq(o1.bestFixedInHindsight, o1.walkForward); eq(o1.perStepCeiling, o1.walkForward);
  if (!(one.steps.length >= 5)) throw new Error(`only ${one.steps.length} steps over 2026`);
  eq(one.steps.reduce((n, x) => n + x.windows, 0), o1.windows, "steps cover the out-of-sample windows:");
  const g = await call("walk_forward", { strategy: "momentum_roc", exec: { slippageTicks: 1 }, grid: { "params.lookback": [6, 12, 24], "exec.slAtrMult": [1.5, 3] } });
  eq(g.configurations, 6);
  const o = g.outOfSample;
  if (!(o.perStepCeiling >= o.walkForward && o.perStepCeiling >= o.bestFixedInHindsight && o.bestFixedInHindsight >= o.medianConfiguration))
    throw new Error("ceilings out of order: " + JSON.stringify(o));
});
await t("sensitivity: slippage stress and a parameter's neighbours; the current row is pass_rate's", async () => {
  const r = await call("sensitivity", { strategy: "donchian_shipped", keys: ["exec.slippageTicks", "params.effMin"] });
  const sl = r.keys.find((k) => k.key === "exec.slippageTicks"), ef = r.keys.find((k) => k.key === "params.effMin");
  eq(sl.rows.map((x) => x.value).join(), "0,1,2,3", "slippage values:");
  eq(ef.rows.map((x) => x.value).join(), "0.3,0.4,0.5,0.6,0.7", "effMin values:");
  const p = await call("pass_rate", { strategy: "donchian_shipped" });
  const cur = sl.rows.find((x) => x.current);
  eq(cur.y2026, p.periods.find((x) => x.period === "2026").calendar.pass, "2026 at the current settings:");
  eq(cur.all, p.periods.find((x) => x.period === "all history").calendar.pass, "all history at the current settings:");
  if (!(sl.rows[0].all >= sl.rows[3].all)) throw new Error("more slippage passed more often");
  if (!(await call("sensitivity", { strategy: "donchian_shipped", keys: ["exec.slAtrMul"] })).error) throw new Error("a misspelt key accepted");
});
await t("window: one window's trades and result, on the chart's grid", async () => {
  const r = await call("window", { strategy: "donchian_shipped", date: "2026-03-09" });
  eq(r.window.tradingDay, "2026-03-09", "snapped to the trading day typed:");
  const s = S.get("donchian_shipped"), R = resolveRules(s.rulesDefaults);
  const start = Date.parse(r.window.start.replace(" ", "T") + ":00Z");
  const real = replayWindow(direct("donchian_shipped"), start, R);
  eq(r.outcome, real.outcome); eq(r.stats.net, Math.round(real.stats.netPnl));
});
await t("eval '1250': the $1,250 rules and the strategy's own settings, equal to src/ directly", async () => {
  const r = await call("pass_rate", { strategy: "donchian_shipped", eval: "1250" });
  eq(r.eval, "1250"); eq(r.rules.profitTarget, 1250); eq(r.rules.trailingDD, 1000); eq(r.rules.dailyLossLimit, 600);
  const s = S.get("donchian_shipped"), b = evalBase(s, "1250");
  eq(b.exec.contracts, 4, "the book's own $1,250 size:");
  const tr = runStrategy(bars, s, b.params, resolveExec(b.exec), { filter: b.filter }).trades, R = resolveRules(b.rules);
  const first = bars.ts[0], last = bars.ts[bars.count - 1] - R.windowDays * 86400000;
  let n = 0, p = 0;
  for (let st = first + Math.ceil((Date.UTC(2026, 0, 1) - first) / 86400000) * 86400000; st <= last; st += 86400000) { n++; p += replayWindow(tr, st, R).outcome === OUTCOME.PASS; }
  eq(r.periods.find((x) => x.period === "2026").calendar.pass, Math.round((p / n) * 1000) / 10, "2026 pass rate:");
  if (!(await call("pass_rate", { strategy: "donchian_shipped", eval: "5000" })).error) throw new Error("an unknown eval accepted");
  eq(JSON.stringify((await call("backtest", { strategy: "donchian_shipped", eval: "1250" })).changed), JSON.stringify({ eval: "1250" }), "the eval's own settings are not 'changed':");
});
await t("studies: list_studies, a gate equal to src/ directly, byStudy adding up, bad studies refused", async () => {
  const cat = await call("list_studies", {});
  eq(cat.studies.length, Object.keys(STUDIES).length, "every study type listed:");
  if (!cat.studies.find((x) => x.type === "emacross").gates.with) throw new Error("no gate wording");
  const studies = [{ type: "emacross", tf: 10, params: { fast: 9, slow: 21 }, gate: "with" }, { type: "rsi" }];
  const r = await call("backtest", { strategy: "donchian_shipped", eval: "1250", studies });
  const s = S.get("donchian_shipped"), b = evalBase(s, "1250");
  const tr = runStrategy(bars, s, b.params, resolveExec(b.exec), { filter: b.filter, studies: studies.map((x) => resolveStudy(x)) }).trades;
  eq(r.stats.trades, tr.length, "gated trades:"); eq(r.stats.net, Math.round(tr.reduce((a, x) => a + x.pnl, 0)), "gated net:");
  eq(r.byStudy.length, 2);
  for (const e of r.byStudy) for (const tb of e.tables) eq(tb.rows.reduce((a, x) => a + x.all.trades, 0) + tb.unread, r.stats.trades, `${e.label} ${tb.title}:`);
  eq(r.byStudy[0].tables[0].rows.find((x) => x.key === "against").all.trades, 0, "nothing against the gate:");
  for (const bad of [[{ type: "nope" }], [{ type: "rsi", gate: "sideways" }], [{ type: "rsi", params: { lenght: 3 } }], [{ type: "rsi", tf: 7 }], { type: "rsi" }])
    if (!(await call("backtest", { strategy: "donchian_shipped", studies: bad })).error) throw new Error(`accepted studies ${JSON.stringify(bad)}`);
  const w = await call("window", { strategy: "donchian_shipped", eval: "1250", studies, date: "2026-03-09" });
  if (!w.outcome) throw new Error("window with studies did not answer");
});
await t("search and sensitivity vary a study's settings; a study key without its study is refused", async () => {
  const studies = [{ type: "emacross", tf: 10, params: { fast: 9, slow: 21 }, gate: "with" }];
  const g = await call("search", { strategy: "donchian_shipped", eval: "1250", studies, grid: { "studies.0.tf": [5, 10, 15], "studies.0.gate": ["off", "with"] } });
  eq(g.tried, 6, "combinations:");
  const off = g.top.filter((r) => r.settings["studies.0.gate"] === "off");
  if (off.length !== 3 || new Set(off.map((r) => r.inSample)).size !== 1) throw new Error("with the gate off, the timeframe should not matter: " + JSON.stringify(off));
  const s = await call("sensitivity", { strategy: "donchian_shipped", eval: "1250", studies, keys: ["studies.0.gate", "studies.0.params.slow"] });
  const gate = s.keys.find((k) => k.key === "studies.0.gate");
  eq(gate.rows.map((r) => r.value).join(), "off,with,against", "gate values:");
  eq(gate.rows.find((r) => r.current).value, "with");
  const plain = await call("pass_rate", { strategy: "donchian_shipped", eval: "1250" });
  eq(gate.rows.find((r) => r.value === "off").y2026, plain.periods.find((x) => x.period === "2026").calendar.pass, "gate off = no study:");
  if (!(await call("search", { strategy: "donchian_shipped", studies, grid: { "studies.1.tf": [5] } })).error) throw new Error("a missing study accepted");
  if (!(await call("search", { strategy: "donchian_shipped", studies, grid: { "studies.0.params.nope": [5] } })).error) throw new Error("a bad study param accepted");
});
await t("bars: OHLC rows, resampled", async () => {
  const r = await call("bars", { from: "2026-03-09T14:30", to: "2026-03-09T15:30", timeframeMin: 5 });
  eq(r.bars.length, 12, "an hour of 5-minute bars:");
  if (!(r.bars[0][2] >= r.bars[0][3])) throw new Error("high below low");
});
await t("papers and chart tools answer (or say plainly why not)", async () => {
  const p = await call("papers", {});
  if (!Array.isArray(p)) throw new Error("papers did not list");
  const c = await call("chart_state", {});
  if (!(c.error || c.strategy)) throw new Error("chart_state neither answered nor explained");
});
await t("stdout carried protocol messages only", async () => { eq(stray.length, 0, `stray stdout lines (${stray.slice(0, 2).join(" | ")}):`); });

child.stdin.end();
console.log(`\n${"=".repeat(64)}\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:"); for (const f of failures) console.log("  - " + f); console.log("\nserver stderr:\n" + stderr.slice(-2000)); }
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
