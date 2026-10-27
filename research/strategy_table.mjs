// Every strategy at its defaults, under each evaluation -- the README's table.
//
//   node --max-old-space-size=8192 research/strategy_table.mjs
//
// The engine and rules are src/'s, configured the way the chart opens a strategy
// (src/evals.mjs evalBase), with one change: positions are flat by the 15:05 CT
// deadline for every book, because the firm forbids overnight holds. The few
// books that hold overnight by default are marked. Pass rates are the chart's
// sweep (calendar windows, a combine started on every day of the grid); "1 tick"
// re-runs the book with a tick of slippage a side where its defaults have none.
// "Reach payout" is the funded stage at its defaults (src/challenge.mjs
// sweepFunded), as the chart's Funded panel shows it.
//
// Writes research/strategy_table_results.json and prints the markdown tables.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { runStrategy } from "../src/run.mjs";
import { resolveExec, tradeStats } from "../src/engine.mjs";
import { sweepWindows, sweepFunded, resolveRules, resolveFunded } from "../src/challenge.mjs";
import { evalBase, EVAL_IDS, EVALS } from "../src/evals.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { bars } = loadBars();
const strategies = await loadStrategies();
const first = bars.ts[0], last = bars.ts[bars.count - 1];
const Y26 = Date.UTC(2026, 0, 1), APR = Date.UTC(2026, 3, 1);
const pct = (x) => Math.round(x * 10) / 10;
const rate = (ws, lo, hi = Infinity) => {
  const x = ws.filter((w) => w.startMs >= lo && w.startMs < hi);
  return x.length ? pct((100 * x.filter((w) => w.outcome === "PASS").length) / x.length) : null;
};

// Runs keyed by configuration: most books trade identically under both evals.
const runs = new Map();
const runOf = (s, b, exec) => {
  const key = JSON.stringify([s.id, b.params, exec, b.filter]);
  if (!runs.has(key)) runs.set(key, runStrategy(bars, s, b.params, exec, { filter: b.filter }).trades);
  return runs.get(key);
};

const rows = [];
const t0 = Date.now();
for (const [id, s] of [...strategies].sort((p, q) => p[0].localeCompare(q[0]))) {
  const row = { id, name: s.name, tf: s.timeframeMin ?? 1, overnightByDefault: (s.execDefaults || {}).intradayOnly === false, evals: {} };
  for (const ev of EVAL_IDS) {
    const b = evalBase(s, ev);
    const exec = resolveExec({ ...b.exec, intradayOnly: true });
    const rules = resolveRules(b.rules);
    const trades = runOf(s, b, exec);
    const st = tradeStats(trades);
    const ws = sweepWindows(trades, first, last, rules, 1).windows;
    const funded = sweepFunded(trades, first, last, rules, resolveFunded({}), 7).summary;
    const slipped = exec.slippageTicks >= 1 ? trades : runOf(s, b, { ...exec, slippageTicks: 1 });
    const ws1 = slipped === trades ? ws : sweepWindows(slipped, first, last, rules, 1).windows;
    row.evals[ev] = {
      contracts: exec.contracts, slippageTicks: exec.slippageTicks,
      trades: st.n, profitFactor: Number.isFinite(st.profitFactor) ? Math.round(st.profitFactor * 1000) / 1000 : null,
      expectancy: Math.round(st.expectancy * 100) / 100, net: Math.round(st.pnl),
      passAll: rate(ws, -Infinity), pass2026: rate(ws, Y26), passJanMar: rate(ws, Y26, APR), passAprJul: rate(ws, APR),
      pass2026OneTick: rate(ws1, Y26), passAllOneTick: rate(ws1, -Infinity),
      reachPayout: pct(funded.reachedPayout),
    };
  }
  rows.push(row);
  process.stderr.write(`  ${id} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}

const out = { measured: new Date().toISOString().slice(0, 10), data: `${new Date(first).toISOString().slice(0, 10)} to ${new Date(last).toISOString().slice(0, 10)}`,
              method: "calendar windows (the chart's sweep), flat by 15:05 CT, each strategy's own defaults under the eval", rows };
fs.writeFileSync(path.join(HERE, "strategy_table_results.json"), JSON.stringify(out, null, 1));

// ── markdown ──
const f = (v, dp = 1) => (v == null ? "—" : v.toFixed(dp));
const money = (v) => (v < 0 ? `−$${Math.abs(v).toFixed(2)}` : `+$${v.toFixed(2)}`);
const byKey = (ev, k) => [...rows].sort((p, q) => (q.evals[ev][k] ?? -1) - (p.evals[ev][k] ?? -1) || (q.evals[ev].passAll ?? -1) - (p.evals[ev].passAll ?? -1));
const mark = (r) => `\`${r.id}\`${r.overnightByDefault ? "†" : ""}`;
console.log(`\n### ${EVALS["3000"].label} — ${EVALS["3000"].blurb}\n`);
console.log("| strategy | bars | trades | PF | $/trade | pass, all | pass, 2026 | Jan–Mar · Apr–Jul | 2026 at 1 tick | reach payout |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const r of byKey("3000", "pass2026OneTick")) {
  const e = r.evals["3000"];
  console.log(`| ${mark(r)} | ${r.tf}m | ${e.trades.toLocaleString("en-US")} | ${e.profitFactor == null ? "—" : e.profitFactor.toFixed(3)} | ${money(e.expectancy)} | ${f(e.passAll)}% | ${f(e.pass2026)}% | ${f(e.passJanMar)} · ${f(e.passAprJul)} | ${f(e.pass2026OneTick)}% | ${f(e.reachPayout)}% |`);
}
console.log(`\n### ${EVALS["1250"].label} — ${EVALS["1250"].blurb}\n`);
console.log("| strategy | pass, all | pass, 2026 | Jan–Mar · Apr–Jul | 2026 at 1 tick | reach payout |");
console.log("|---|---|---|---|---|---|");
for (const r of byKey("1250", "pass2026OneTick")) {
  const e = r.evals["1250"];
  console.log(`| ${mark(r)}${e.contracts !== r.evals["3000"].contracts ? ` (${e.contracts} lots)` : ""} | ${f(e.passAll)}% | ${f(e.pass2026)}% | ${f(e.passJanMar)} · ${f(e.passAprJul)} | ${f(e.pass2026OneTick)}% | ${f(e.reachPayout)}% |`);
}
console.log(`\n(${rows.length} strategies, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
