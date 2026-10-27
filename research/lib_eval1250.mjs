// Scoring for the 2026 strategy work (research/combos_1250.mjs). Built on the
// MCP lab (mcp/lab.mjs), so every figure is the chart's and the tools': the same
// engine run, the same window grid, the same two pass-rate methods.
//
// Everything is 2026: trades entered from 2026-01-01, calendar windows started
// in 2026 (and in its halves, Jan-Mar and Apr-Jul), the bootstrap over 2026's
// trading days. Earlier data only warms the indicators up.
//
// nullOf() is the control the project's own history demands: the same book with
// each signal's direction decided by a coin, everything else -- timing, gates,
// size, exits, day rules -- unchanged. A rule the null matches selected TIMES,
// not directions; one a large search found and the null matches is noise.

import * as L from "../mcp/lab.mjs";
import { mulberry32 } from "../src/dayeval.mjs";

export const Y26 = Date.UTC(2026, 0, 1), APR = Date.UTC(2026, 3, 1);
export const lab = L;

export const configOf = (strategy, o = {}, evalId = "1250") =>
  L.resolveConfig({ strategy, eval: evalId, params: o.params, exec: o.exec, filter: o.filter, rules: o.rules, studies: o.studies });

// The 2026 trades, from a run over just the bars 2026 needs.
export function trades2026(cfg) {
  const b = L.bars();
  return L.rangeRun(cfg, Y26, b.ts[b.count - 1]);
}

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
export function score(trades, R) {
  const cal = (lo, hi) => L.calendar(trades, R, L.windowStarts(R, lo, hi));
  const c = cal(Y26, Infinity), ca = cal(Y26, APR), cb = cal(APR, Infinity);
  const bo = L.bootstrap(trades, R, Y26, Infinity), ba = L.bootstrap(trades, R, Y26, APR), bb = L.bootstrap(trades, R, APR, Infinity);
  let net = 0, wins = 0, gw = 0, gl = 0;
  for (const t of trades) { net += t.pnl; if (t.pnl > 0) { wins++; gw += t.pnl; } else gl -= t.pnl; }
  const n = trades.length;
  return {
    cal: c.pass, calA: ca.pass, calB: cb.pass, ci: c.ci95, boot: bo.pass, bootA: ba.pass, bootB: bb.pass,
    trades: n, net: Math.round(net), winRate: n ? r1((100 * wins) / n) : 0, perTrade: n ? Math.round(net / n) : 0,
    pf: gl > 0 ? Math.round((gw / gl) * 100) / 100 : null,
  };
}

export async function evaluate(strategy, o = {}, evalId = "1250") {
  const cfg = await configOf(strategy, o, evalId);
  return { cfg, ...score(trades2026(cfg), cfg.rules) };
}

// The coin-flip twin: each signal EVENT (a run of one nonzero value) keeps its
// bars and takes a random direction, the same one wherever the run is seen.
function flipEvents(sig, ts, seed) {
  const out = new Int8Array(sig.length);
  let flip = 1;
  for (let k = 0; k < sig.length; k++) {
    const v = sig[k];
    if (v && (k === 0 || sig[k - 1] !== v)) {
      const r = mulberry32((seed * 2654435761 + Math.floor(ts[k] / 60000)) | 0)();
      flip = r < 0.5 ? -1 : 1;
    }
    out[k] = v * flip;
  }
  return out;
}
export function nullCfg(cfg, seed) {
  const s = cfg.s;
  return { ...cfg, s: { ...s, compute(b, p) { const o = s.compute(b, p); return { ...o, sig: flipEvents(o.sig, b.ts, seed) }; } } };
}
// The null's pass rates over `seeds` coin sequences: mean, and how many seeds
// reach the real book's 2026 calendar rate.
export function nullScore(cfg, real, seeds = 20) {
  const rows = [];
  for (let k = 1; k <= seeds; k++) rows.push(score(trades2026(nullCfg(cfg, k)), cfg.rules));
  const mean = (f) => r1(rows.reduce((a, r) => a + (f(r) ?? 0), 0) / rows.length);
  return { seeds, cal: mean((r) => r.cal), calA: mean((r) => r.calA), calB: mean((r) => r.calB), boot: mean((r) => r.boot),
           atLeastReal: rows.filter((r) => r.cal >= real.cal).length, best: Math.max(...rows.map((r) => r.cal)) };
}

export const fmt = (r) => `cal ${r.cal}% (${r.calA} / ${r.calB})  boot ${r.boot}% (${r.bootA} / ${r.bootB})  ` +
  `${r.trades} tr  ${r.winRate}% won  $${r.perTrade}/tr  PF ${r.pf}  net $${r.net}`;
