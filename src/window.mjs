// How much data the live preview loads around a window. ISOMORPHIC.
//
// The browser re-runs a strategy over just the window on screen, so the window's
// first bar must already carry the indicator state the full-history run has there,
// and its last trade must be able to finish. Too little warm-up and the chart shows
// a different result from the sweep for the same dates; too short a tail and a trade
// still open at the window's end is cut off at the last bar loaded. Both measured:
// the three strategies that average the last 14 sessions' range disagreed with the
// sweep on every window with ~5 days of warm-up, and with overnight holds allowed a
// window-end cut changed 3-8 of 31 windows.
//
// A strategy states its needs as `warmupBars` (signal bars) and, for lookbacks
// counted in trading sessions, `warmupSessions`. Either may be a number or a
// function of the params, since a lookback is usually itself a parameter. An
// active signal filter adds its own indicators' lookback.

import { NO_FILTER, filterPeriods } from "./filters.mjs";

const DAY_MIN = 1440;
export const DEFAULT_TAIL_MIN = 3 * DAY_MIN;   // covers any intraday trade, weekends included

const valueOf = (v, params, dflt) => {
  const x = typeof v === "function" ? v(params) : v;
  return Number.isFinite(x) && x > 0 ? x : dflt;
};

function filterBars(filter) {
  if (!filter) return 0;
  const active = Object.keys(NO_FILTER).some((k) => !k.endsWith("Ct") && filter[k] !== undefined && filter[k] !== NO_FILTER[k]);
  if (!active) return 0;
  const p = filterPeriods(filter);
  // EMA-smoothed gates (ADX, ATR) need several periods to forget their seed;
  // the ATR ratio sits on a moving average of the ATR.
  return Math.max(5 * Math.max(p.adxPeriod, p.atrPeriod, p.effPeriod, p.chopPeriod, p.bwPeriod), p.volMaPeriod + 5 * p.atrPeriod);
}

// Any lookback-like integer setting, ten times over, so an EMA on it has
// forgotten its seed by the window's first bar (its weight is then ~e^-20). A
// backstop under each strategy's own warmupBars, which knows its derived periods
// (fuzz-found: tpl_ma_cross at a 344-bar slow EMA disagreed with the sweep).
const LOOKBACK_KEY = /(period|fast|slow|signal|lookback|trendma|scalebars|channel|donchian|span|length)$/i;
function lookbackBars(strategy, params) {
  let m = 0;
  for (const d of strategy.params || []) {
    if (d.type !== "int" || !LOOKBACK_KEY.test(d.key)) continue;
    const v = Number(params[d.key] ?? d.default);
    if (Number.isFinite(v) && v > m) m = v;
  }
  return 10 * m;
}

// With overnight holds a position can be open when the window starts, and the
// preview, which starts flat, only falls into step with the full run once both
// are flat on the same bar. Intraday-only runs are all flat at the deadline every
// day; an overnight position with no exit but the opposite signal can stay open
// for months (fuzz-found: a 121-day hold beat a 60-day warm-up), so only the whole
// history before the window reproduces it. The server clamps this to the data.
const ALL_HISTORY_MIN = 50 * 365 * DAY_MIN;
const holdsOvernight = (x) => !!x && (x.intradayOnly === false || (x.flattenCt != null && x.flattenCt === x.reopenCt));

export function windowSpan(strategy, params = {}, { tailMin = DEFAULT_TAIL_MIN, filter = null, exec = null } = {}) {
  const tf = params.timeframeMin || strategy.timeframeMin || 1;
  const warmupBars = Math.max(valueOf(strategy.warmupBars, params, 300), lookbackBars(strategy, params), filterBars(filter));
  const sessions = valueOf(strategy.warmupSessions, params, 0);
  // Bars are padded generously for weekends and holidays, where no bars exist.
  const byBars = Math.ceil(warmupBars * tf * 1.5) + 3 * DAY_MIN;
  // Sessions to calendar minutes: 7/5 for weekends, plus 4 days for holidays.
  const bySessions = sessions > 0 ? Math.ceil((sessions * 7) / 5 + 4) * DAY_MIN : 0;
  const overnight = holdsOvernight(exec) ? ALL_HISTORY_MIN : 0;
  return { warmupMin: Math.max(byBars, bySessions, overnight), tailMin };
}
