// The one code path that turns (bars + strategy + params) into trades.
// ISOMORPHIC — the server calls it for the 5-year sweep, the browser calls it on
// every slider move. Having a single implementation is the whole reason the live
// preview can be trusted: there is no second engine to drift out of sync.

import { resample } from "./resample.mjs";
import { runBrackets, tradeStats, resolveExec } from "./engine.mjs";

/**
 * @param bars1m   1-minute bars {ts,open,high,low,close,volume,tday}
 * @param strategy a module from strategies/ (default export)
 * @param params   resolved signal params
 * @param exec     execution config (contracts, stops, costs) — see DEFAULT_EXEC
 * @param opts.fromMs  discard trades entering before this (warm-up trimming)
 */
export function runStrategy(bars1m, strategy, params, exec, opts = {}) {
  const tfMin = params.timeframeMin ?? strategy.timeframeMin ?? 1;
  const tf = resample(bars1m, tfMin);
  const out = strategy.compute(tf, params);
  const x = resolveExec(exec);
  const { trades } = runBrackets(tf, out.sig, out.atr, x);

  const kept = opts.fromMs != null
    ? trades.filter((t) => t.entryTime >= opts.fromMs)
    : trades;

  return {
    trades: kept,
    tf,
    overlays: out.overlays || [],
    stats: tradeStats(kept),
  };
}

// Merge a strategy's declared param defaults with user overrides.
export function resolveParams(strategy, overrides = {}) {
  const p = {};
  for (const d of strategy.params || []) p[d.key] = d.default;
  p.timeframeMin = strategy.timeframeMin ?? 1;
  return { ...p, ...overrides };
}
