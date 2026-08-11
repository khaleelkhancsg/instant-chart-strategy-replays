// Monte Carlo for donchian_eff_rth — WITHOUT replaying the historical book.
//
// Every pass-rate number in this project so far came from sweeping real windows
// over real trades. That measures what DID happen once. It cannot answer two
// questions that decide whether the 42.6% is worth anything:
//
//   1. What would this configuration score with NO EDGE AT ALL? A 5xATR stop
//      against a 1.5xATR target wins 77% of the time on a coin flip. If the
//      rules and the geometry alone produce a respectable pass rate, then the
//      backtested one is mostly geometry, not skill.
//   2. How much edge is actually required to reach 42.6%, and is that plausible?
//
// So this simulates the PRICE PROCESS instead of resampling outcomes:
//
//   price      driftless arithmetic random walk (drift = the edge parameter),
//              stepped at 10-second resolution so the bracket resolves in TIME
//              rather than by a bar's high/low — no stop-before-target guess.
//   trades     arrive as a Poisson process through the session, sequential (the
//              book holds one position), each entered flat and exited by stop,
//              target, or the 15:05 flatten.
//   rules      the real challenge.mjs engine, unmodified. That code is covered
//              by the 112-test suite, so the rule half of this is not a new
//              implementation that could be wrong in a new way.
//
// INPUT PROVENANCE — what comes from where, since the point is independence:
//   from the STRATEGY CONFIG   5xATR stop, 1.5xATR target, 10 contracts, session
//   from the BROKER/FIRM       $2/point, $0.75/side, $3000 target, $2000 trailing
//                              drawdown, 50% consistency, +$1000 / -$150 blocks
//   from the INSTRUMENT        2-min RTH ATR(14): median 13.6 points across
//                              355,732 bars. A property of MNQ, not of the book.
//   from the BACKTEST          trades/day only, and it is swept rather than
//                              assumed. Nothing else.
//   NOT USED                   the historical trade list, its P&L, win rate,
//                              expectancy, or equity curve.
//
// Usage:  node research/monte_carlo.mjs [runs]

import { replayWindow, resolveRules, OUTCOME } from "../src/challenge.mjs";
import { loadStrategies } from "../src/registry.mjs";

const RUNS = Number(process.argv[2]) || 10_000;
const DAY_MS = 86_400_000;

// ── inputs ───────────────────────────────────────────────────────────
const S = (await loadStrategies()).get("donchian_eff_rth");
const X = S.execDefaults;

const P = {
  slAtr: X.slAtrMult,            // 5.0
  tpAtr: X.tpAtrMult,            // 1.5
  contracts: X.contracts,        // 10
  pointValue: 2.0,
  tickSize: 0.25,
  commissionPerSide: X.commissionPerSide,   // 0.75
  atrMode: "fixed",              // 'fixed' | 'stochastic' (AR(1), empirical marginal)
  atrPoints: 13.56,              // median 2-min RTH ATR — INSTRUMENT property
  tradesPerDay: 2.03,            // the only backtest-derived input; swept below
  slippageTicks: 0,
  driftPerBarAtr: 0,             // THE EDGE. 0 = pure null.
  tradingDays: 21,               // weekdays in a 30-calendar-day window
  sessionStartCt: 8 * 60 + 30,
  lastEntryCt: 14 * 60 + 55,
  flattenCt: 15 * 60 + 5,
  barMin: 2,
  substepsPerBar: 12,            // 10-second resolution for barrier crossing
};

const RULES = resolveRules({ ...S.rulesDefaults });

// A bar's TRUE RANGE for a driftless Brownian path is E[max-min] = sigma*sqrt(8/pi).
// That is the ONLY link between the quoted ATR and the simulation's volatility,
// and it is a property of Brownian motion, not a fitted constant.
const RANGE_FACTOR = Math.sqrt(8 / Math.PI);   // 1.5958

// ── rng ──────────────────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// ── stochastic volatility ────────────────────────────────────────────
// Holding ATR constant is the simulation's biggest lie. Real daily ATR spans
// 2.2 to 40.8 points (p1..p99) AND is highly persistent — lag-1 autocorrelation
// 0.797 over 1,855 trading days. Both matter: the dollar size of every trade
// scales with ATR, so a quiet fortnight and a violent one are different games,
// and persistence means a window does not average over that.
//
// Modelled as a Gaussian copula: an AR(1) in normal space carries the
// persistence, then the normal CDF maps onto the EMPIRICAL quantiles, so the
// marginal distribution is the real one rather than a fitted lognormal.
// Quantiles are p1..p99 of the daily median 2-min RTH ATR — instrument data.
const ATR_Q = [2.2, 4.27, 5.83, 7.33, 8.46, 9.33, 9.99, 10.71, 11.45, 12.18, 12.99,
               13.68, 14.5, 15.32, 16.43, 17.72, 19.26, 21.24, 23.62, 28.75, 40.82];
const ATR_PHI = 0.797;

function erf(x) {
  // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  return s * (1 - poly * Math.exp(-x * x));
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

function atrFromNormal(z) {
  const u = Math.min(1, Math.max(0, normCdf(z)));
  const x = u * (ATR_Q.length - 1);
  const i = Math.min(ATR_Q.length - 2, Math.floor(x));
  return ATR_Q[i] + (x - i) * (ATR_Q[i + 1] - ATR_Q[i]);
}

function gaussPair(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  const r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}

// ── one simulated window ─────────────────────────────────────────────
function simulateWindow(p, rnd, startMs) {
  const K = p.substepsPerBar;
  const stepMin = p.barMin / K;
  const dollarsPerPoint = p.pointValue * p.contracts;
  const fees = p.commissionPerSide * 2 * p.contracts;
  // Slippage is adverse on BOTH legs, matching engine.mjs.
  const slipCost = p.slippageTicks * p.tickSize * 2 * dollarsPerPoint;
  const meanGapMin = (p.lastEntryCt - p.sessionStartCt) / p.tradesPerDay;

  const trades = [];
  let spare = null;
  const norm = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    const [a, b] = gaussPair(rnd);
    spare = b;
    return a;
  };

  // Volatility state. 'fixed' pins ATR; 'stochastic' runs the AR(1) copula, drawn
  // from its stationary distribution so a window is not born at the median.
  let z = norm();

  for (let d = 0; d < p.tradingDays; d++) {
    if (p.atrMode === "stochastic") {
      z = ATR_PHI * z + Math.sqrt(1 - ATR_PHI * ATR_PHI) * norm();
    }
    const atr = p.atrMode === "stochastic" ? atrFromNormal(z) : p.atrPoints;
    const sigmaStep = (atr / RANGE_FACTOR) / Math.sqrt(K);
    const stepVar = sigmaStep * sigmaStep;
    const driftStep = (p.driftPerBarAtr * atr) / K;
    const tp = p.tpAtr * atr;
    const sl = p.slAtr * atr;

    // Place trading day d on a calendar day, skipping weekends.
    const calDay = d + Math.floor(d / 5) * 2;
    const dayBase = startMs + calDay * DAY_MS;
    let clock = p.sessionStartCt;

    for (;;) {
      // Poisson arrivals -> exponential gaps between signals.
      clock += -Math.log(1 - rnd()) * meanGapMin;
      if (clock >= p.lastEntryCt) break;

      const entryCt = clock;
      let x = 0;                       // P&L in points, in the trade's direction
      let t = entryCt;
      let exitPx = null, reason = null;
      let worst = 0;

      while (t < p.flattenCt) {
        const x0 = x;
        x += driftStep + sigmaStep * norm();
        t += stepMin;
        if (x < worst) worst = x;
        if (x <= -sl) { exitPx = -sl; reason = "SL"; break; }
        if (x >= tp) { exitPx = tp; reason = "TP"; break; }
        // BROWNIAN-BRIDGE CORRECTION. A step can cross a barrier and come back
        // inside before the next sample, and simply checking the endpoints
        // misses it. That is not a rounding error: at 10-second steps it biases
        // the null by -$15.84 per trade, which is the size of the entire
        // commission and half the edge being tested for. P(touch B between two
        // interior points) = exp(-2*(B-x0)*(B-x1)/variance).
        if (Math.exp(-2 * (tp - x0) * (tp - x) / stepVar) > rnd()) { exitPx = tp; reason = "TP"; break; }
        if (Math.exp(-2 * (x0 + sl) * (x + sl) / stepVar) > rnd()) { exitPx = -sl; reason = "SL"; break; }
      }
      if (exitPx === null) { exitPx = x; reason = "FLAT"; t = p.flattenCt; }

      const gross = exitPx * dollarsPerPoint;
      const pnl = gross - fees - slipCost;
      trades.push({
        entryTime: dayBase + entryCt * 60_000,
        exitTime: dayBase + t * 60_000,
        tday: calDay,
        dir: rnd() < 0.5 ? 1 : -1,
        pnl, gross, fees: fees + slipCost,
        mae: Math.min(0, worst * dollarsPerPoint),
        mfe: 0,
        reason,
      });
      clock = t;
    }
  }
  return trades;
}

// ── one configuration ────────────────────────────────────────────────
function runConfig(overrides, runs, seed = 12345) {
  const p = { ...P, ...overrides };
  const rnd = mulberry32(seed);
  let pass = 0, fail = 0, open = 0;
  let nTrades = 0, nWins = 0, grossSum = 0, netSum = 0, holdSum = 0;
  const daysToPass = [], finals = [];

  for (let r = 0; r < runs; r++) {
    const trades = simulateWindow(p, rnd, 0);
    for (const t of trades) {
      nTrades++;
      if (t.pnl > 0) nWins++;
      grossSum += t.gross;
      netSum += t.pnl;
      holdSum += (t.exitTime - t.entryTime) / 60_000;
    }
    const w = replayWindow(trades, 0, RULES);
    if (w.outcome === OUTCOME.PASS) { pass++; daysToPass.push(w.stats.daysUsed); }
    else if (w.outcome === OUTCOME.FAIL) fail++;
    else open++;
    finals.push(w.stats.netPnl);
  }

  finals.sort((a, b) => a - b);
  daysToPass.sort((a, b) => a - b);
  const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);
  const rate = (100 * pass) / runs;
  // Binomial standard error — 10,000 runs pins the rate to about +/-1pp.
  const se = 100 * Math.sqrt((rate / 100) * (1 - rate / 100) / runs);

  return {
    p, runs, pass, fail, open,
    passRate: rate, se,
    winRate: (100 * nWins) / nTrades,
    grossPerTrade: grossSum / nTrades,
    netPerTrade: netSum / nTrades,
    meanHold: holdSum / nTrades,
    tradesPerDay: nTrades / (runs * p.tradingDays),
    medianFinal: finals[finals.length >> 1],
    medianDaysToPass: daysToPass.length ? daysToPass[daysToPass.length >> 1] : null,
    p05: pct(finals, 0.05), p25: pct(finals, 0.25), p75: pct(finals, 0.75), p95: pct(finals, 0.95),
  };
}


export { runConfig, P, RULES, RANGE_FACTOR };
