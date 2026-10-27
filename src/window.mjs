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
// counted in trading sessions, `warmupSessions` -- a number or a function of the
// params, since a session count is usually itself a parameter.

const DAY_MIN = 1440;
export const DEFAULT_TAIL_MIN = 3 * DAY_MIN;   // covers any intraday trade, weekends included

export function windowSpan(strategy, params = {}, { tailMin = DEFAULT_TAIL_MIN } = {}) {
  const tf = params.timeframeMin || strategy.timeframeMin || 1;
  const warmupBars = strategy.warmupBars || 300;
  const ws = strategy.warmupSessions;
  const sessions = typeof ws === "function" ? ws(params) : (ws || 0);
  // Bars are padded generously for weekends and holidays, where no bars exist.
  const byBars = Math.ceil(warmupBars * tf * 1.5) + 3 * DAY_MIN;
  // Sessions to calendar minutes: 7/5 for weekends, plus 4 days for holidays.
  const bySessions = sessions > 0 ? Math.ceil((sessions * 7) / 5 + 4) * DAY_MIN : 0;
  return { warmupMin: Math.max(byBars, bySessions), tailMin };
}
