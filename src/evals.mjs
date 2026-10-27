// Evaluation presets. ISOMORPHIC.
//
// The two evaluations the books here are traded on, as rule sets that the
// chart's tabs, the sweep and the MCP tools all resolve the same way:
//
//   "3000"  the 50K combine: $3,000 target, $2,000 trailing drawdown, $1,000
//           daily loss limit. These are DEFAULT_RULES, so choosing it changes
//           nothing.
//   "1250"  $1,250 target, $1,000 trailing drawdown, $600 daily loss limit: the
//           rules research/rules_1250_2026.mjs measured and the $1,250 bot trades.
//
// Both have 30 days, 50% consistency gating the pass, and end-of-day trailing
// that locks at breakeven.
//
// An eval sets the firm's numbers, plus the daily profit stop. That stop exists
// for the consistency rule and sits at half the target: past it, the day starts
// raising the profit the window needs.
//
// Two things follow a strategy into an eval:
//   1. A book that models the platform's daily-loss liquidation
//      (exec.dayLossStopUsd > 0) has it set to the eval's daily limit. It is the
//      same rule, enforced on live P&L.
//   2. A strategy may declare its own settings for an eval, as
//      `evals: { "1250": { params, exec, filter, rules } }`. Size and day stops
//      measured for one account do not carry over to another.

import { DEFAULT_RULES } from "./challenge.mjs";
import { DEFAULT_EXEC } from "./engine.mjs";
import { NO_FILTER } from "./filters.mjs";
import { resolveParams } from "./run.mjs";

export const EVALS = {
  "3000": {
    id: "3000", label: "$3,000 eval",
    blurb: "$3,000 target · $2,000 trailing drawdown · $1,000 daily loss limit",
    rules: { profitTarget: 3000, trailingDD: 2000, dailyLossLimit: 1000, dailyProfitStop: 1500 },
  },
  "1250": {
    id: "1250", label: "$1,250 eval",
    blurb: "$1,250 target · $1,000 trailing drawdown · $600 daily loss limit",
    rules: { profitTarget: 1250, trailingDD: 1000, dailyLossLimit: 600, dailyProfitStop: 625 },
  },
};
export const DEFAULT_EVAL = "3000";
// In this order: Object.keys would sort these numeric-looking ids ascending.
export const EVAL_IDS = ["3000", "1250"];

export function evalOf(id) {
  const key = id == null || id === "" ? DEFAULT_EVAL : String(id);
  const ev = EVALS[key];
  if (!ev) throw new Error(`unknown eval "${id}"; one of ${EVAL_IDS.join(", ")}`);
  return ev;
}

// What a strategy starts from under an eval. Layers, last wins: the engine's and
// the rules' defaults; the eval's rules; the strategy's own envelope (execDefaults,
// filterDefaults, rulesDefaults); the platform loss cap set to the eval's limit;
// the strategy's settings for this eval.
export function evalBase(strategy, evalId = DEFAULT_EVAL) {
  const ev = evalOf(evalId);
  const own = (strategy.evals && strategy.evals[ev.id]) || {};
  const exec = { ...DEFAULT_EXEC, ...(strategy.execDefaults || {}) };
  if (exec.dayLossStopUsd > 0) exec.dayLossStopUsd = ev.rules.dailyLossLimit;
  return {
    params: resolveParams(strategy, own.params || {}),
    exec: { ...exec, ...(own.exec || {}) },
    rules: { ...DEFAULT_RULES, ...ev.rules, ...(strategy.rulesDefaults || {}), ...(own.rules || {}) },
    filter: { ...NO_FILTER, ...(strategy.filterDefaults || {}), ...(own.filter || {}) },
  };
}

// Every setting an eval decides for this strategy, as "group.key", over the
// evals given. Switching evals resets these; other changes carry across.
export function evalKeys(strategy, ids = EVAL_IDS) {
  const out = new Set();
  for (const id of ids) {
    const ev = evalOf(id);
    for (const k of Object.keys(ev.rules)) out.add(`rules.${k}`);
    if ((strategy.execDefaults || {}).dayLossStopUsd > 0) out.add("exec.dayLossStopUsd");
    const own = (strategy.evals && strategy.evals[ev.id]) || {};
    for (const g of ["params", "exec", "filter", "rules"]) for (const k of Object.keys(own[g] || {})) out.add(`${g}.${k}`);
  }
  return out;
}
