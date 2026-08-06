// 30-day combine rules engine. ISOMORPHIC.
//
// Replays a strategy's trade list against prop-firm evaluation rules and returns
// a full timeline — not just a verdict — because the point of this tool is to
// SEE why a window passed or died.
//
// The rule set mirrors the validated lib_challenge_v2.mjs from the lite
// backtester, with the operational overlay (circuit breaker / daily profit stop)
// folded into the same pass so skipped trades are visible on the chart:
//
//   HARD FAIL  — total trailing drawdown only. Nothing else can blow the account.
//   SOFT STOPS — daily loss limit, daily profit stop, circuit breaker. These stop
//                you opening new trades for the rest of that session; you resume
//                at the next 17:00 ET reset. They are NOT breaches.
//   PASS       — cumulative profit >= target AND no single day contributed more
//                than `consistencyPct` of it AND >= minTradingDays traded.
//
// Two deliberate deviations from lib_challenge_v2, both toward realism:
//   1. Window membership is by ENTRY time. You start a combine flat, so a trade
//      opened before day 1 cannot count. (v2 filtered on exit time.) Affects at
//      most one trade per window.
//   2. `evaluateOn: 'intraday'` checks breaches against each trade's worst
//      excursion (MAE), not just its realised close. Real firms breach on live
//      equity. Because we cannot know whether MFE or MAE printed first inside a
//      trade, the peak is ratcheted BEFORE the breach test — the pessimistic
//      ordering.

export const DEFAULT_RULES = {
  profitTarget: 3000,
  trailingDD: 2000,
  trailingMode: "eod",      // 'eod' (ratchets on daily closes) | 'intraday'
  lockAtBreakeven: true,    // floor freezes at $0 once peak >= trailingDD
  dailyLossLimit: 1000,     // firm's soft daily lockout
  dailyProfitStop: 1500,    // stop trading once a day is up this much
  circuitBreaker: 150,      // your own tighter daily loss stop (0 = off)
  consistencyPct: 50,       // max single-day share of total profit at pass
  minTradingDays: 0,
  windowDays: 30,
  evaluateOn: "realized",   // 'realized' | 'intraday'
  maxContracts: 10,
};

export function resolveRules(r = {}) {
  return { ...DEFAULT_RULES, ...r };
}

export const OUTCOME = { PASS: "PASS", FAIL: "FAIL", OPEN: "IN_PROGRESS" };

// Locate the first trade with entryTime >= startMs. Trades must be entry-sorted.
function firstTradeAt(trades, startMs) {
  let lo = 0, hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (trades[mid].entryTime < startMs) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Full replay of one 30-day window, with every intermediate state kept.
 *
 * @param trades sorted by entryTime, each needing {entryTime, exitTime, pnl, mae, mfe, ...}
 * @param startMs window start (epoch ms)
 * @param rules   see DEFAULT_RULES
 */
export function replayWindow(trades, startMs, rules = {}) {
  const R = resolveRules(rules);
  const endMs = startMs + R.windowDays * 86400000;
  const capPct = R.consistencyPct / 100;
  const intraday = R.evaluateOn === "intraday";
  const eodTrail = R.trailingMode === "eod";

  let cum = 0;
  let peak = 0;        // intraday-trailing high-water mark
  let eodPeak = 0;     // best daily CLOSE so far (eod-trailing mark)
  let locked = false;
  let curDay = null, dayPnl = 0, maxDayPnl = 0;
  let tradingDays = 0, dayHadTrade = false;
  let minCushion = Infinity;

  const events = [];
  const days = [];
  let outcome = OUTCOME.OPEN;
  let passMs = null, failMs = null, targetHitMs = null, lockMs = null;

  const floorNow = () => {
    if (locked) return 0;
    return (eodTrail ? eodPeak : peak) - R.trailingDD;
  };

  const closeDay = () => {
    if (curDay === null) return;
    if (eodTrail) {
      if (cum > eodPeak) eodPeak = cum;
      if (R.lockAtBreakeven && !locked && eodPeak >= R.trailingDD) { locked = true; lockMs = days.length ? days[days.length - 1].lastMs : startMs; }
    }
    const d = days[days.length - 1];
    d.pnl = dayPnl;
    d.cumEnd = cum;
    d.floorAfter = floorNow();
    d.eodPeak = eodPeak;
  };

  const i0 = firstTradeAt(trades, startMs);
  for (let k = i0; k < trades.length; k++) {
    const t = trades[k];
    if (t.entryTime >= endMs) break;

    const day = t.tday;
    if (day !== curDay) {
      closeDay();
      curDay = day;
      dayPnl = 0;
      dayHadTrade = false;
      days.push({
        day, firstMs: t.entryTime, lastMs: t.exitTime,
        pnl: 0, taken: 0, skipped: 0, lockout: null,
        cumEnd: cum, floorAfter: floorNow(), eodPeak,
      });
    }
    const D = days[days.length - 1];
    D.lastMs = Math.max(D.lastMs, t.exitTime);

    // ── soft stops: do we take this trade at all? ──
    let skip = null;
    if (R.dailyProfitStop > 0 && dayPnl >= R.dailyProfitStop) skip = "profitStop";
    else if (R.circuitBreaker > 0 && dayPnl <= -R.circuitBreaker) skip = "breaker";
    else if (R.dailyLossLimit > 0 && dayPnl <= -R.dailyLossLimit) skip = "dailyLoss";

    if (skip) {
      if (!D.lockout) D.lockout = skip;
      D.skipped++;
      events.push({ k, taken: false, skip, cumBefore: cum, cum, floor: floorNow(), day, dayPnl, t });
      continue;
    }

    const cumBefore = cum;
    if (!dayHadTrade) { dayHadTrade = true; tradingDays++; }
    D.taken++;

    // ── intraday breach test, pessimistically ordered ──
    let breachedIntra = false;
    if (intraday) {
      if (!eodTrail) {
        const hiEquity = cum + (t.mfe || 0);
        if (hiEquity > peak) peak = hiEquity;
        if (R.lockAtBreakeven && !locked && peak >= R.trailingDD) { locked = true; lockMs = t.exitTime; }
      }
      const loEquity = cum + (t.mae || 0);
      if (loEquity <= floorNow()) breachedIntra = true;
      minCushion = Math.min(minCushion, loEquity - floorNow());
    }

    cum += t.pnl;
    dayPnl += t.pnl;
    if (dayPnl > maxDayPnl) maxDayPnl = dayPnl;

    if (!eodTrail) {
      if (cum > peak) peak = cum;
      if (R.lockAtBreakeven && !locked && peak >= R.trailingDD) { locked = true; lockMs = t.exitTime; }
    }
    const floor = floorNow();
    if (!intraday) minCushion = Math.min(minCushion, cum - floor);

    events.push({ k, taken: true, skip: null, cumBefore, cum, floor, day, dayPnl, t });

    if (targetHitMs === null && cum >= R.profitTarget) targetHitMs = t.exitTime;

    if (breachedIntra || cum <= floor) {
      outcome = OUTCOME.FAIL;
      failMs = t.exitTime;
      const ev = events[events.length - 1];
      ev.breach = true;
      ev.breachKind = breachedIntra ? "intraday" : "realized";
      break;
    }
    if (cum >= R.profitTarget && maxDayPnl <= capPct * cum && tradingDays >= R.minTradingDays) {
      outcome = OUTCOME.PASS;
      passMs = t.exitTime;
      events[events.length - 1].pass = true;
      break;
    }
  }
  closeDay();

  const takenEvents = events.filter((e) => e.taken);
  const wins = takenEvents.filter((e) => e.t.pnl > 0).length;
  let gw = 0, gl = 0;
  for (const e of takenEvents) { if (e.t.pnl > 0) gw += e.t.pnl; else gl += -e.t.pnl; }

  const resolveMs = passMs ?? failMs ?? null;
  const daysUsed = resolveMs === null
    ? Math.min(R.windowDays, Math.ceil((endMs - startMs) / 86400000))
    : Math.ceil((resolveMs - startMs) / 86400000);

  return {
    startMs, endMs, outcome, passMs, failMs, targetHitMs, lockMs,
    events, days,
    rules: R,
    stats: {
      netPnl: cum,
      trades: takenEvents.length,
      skipped: events.length - takenEvents.length,
      winRate: takenEvents.length ? (wins / takenEvents.length) * 100 : 0,
      profitFactor: gl === 0 ? (gw > 0 ? Infinity : 0) : gw / gl,
      expectancy: takenEvents.length ? cum / takenEvents.length : 0,
      tradingDays,
      daysUsed,
      maxDayPnl,
      consistencyRatio: cum > 0 ? (maxDayPnl / cum) * 100 : 0,
      minCushion: minCushion === Infinity ? null : minCushion,
      finalFloor: floorNow(),
      locked,
      peak: eodTrail ? eodPeak : peak,
    },
  };
}

/**
 * Sweep every window start across the dataset. This is the "how often would this
 * actually pass?" number — a single window is an anecdote, the sweep is the
 * distribution.
 *
 * Returns one compact record per window (no timelines) so it stays cheap enough
 * to recompute whenever parameters change.
 */
export function sweepWindows(trades, datasetStart, datasetEnd, rules = {}, stepDays = 1) {
  const R = resolveRules(rules);
  const windowMs = R.windowDays * 86400000;
  const stepMs = Math.max(1, stepDays) * 86400000;
  const lastStart = datasetEnd - windowMs;
  const out = [];
  let pass = 0, fail = 0, open = 0;

  for (let s = datasetStart; s <= lastStart; s += stepMs) {
    const r = replayWindow(trades, s, R);
    if (r.outcome === OUTCOME.PASS) pass++;
    else if (r.outcome === OUTCOME.FAIL) fail++;
    else open++;
    out.push({
      startMs: s,
      outcome: r.outcome,
      netPnl: Math.round(r.stats.netPnl),
      trades: r.stats.trades,
      daysUsed: r.stats.daysUsed,
      minCushion: r.stats.minCushion === null ? null : Math.round(r.stats.minCushion),
    });
  }

  const n = out.length || 1;
  const passed = out.filter((w) => w.outcome === OUTCOME.PASS);
  const medDays = passed.length
    ? passed.map((w) => w.daysUsed).sort((a, b) => a - b)[Math.floor(passed.length / 2)]
    : null;

  return {
    windows: out,
    summary: {
      n: out.length,
      passRate: (pass / n) * 100,
      failRate: (fail / n) * 100,
      openRate: (open / n) * 100,
      medianDaysToPass: medDays,
      meanNet: out.reduce((a, w) => a + w.netPnl, 0) / n,
    },
  };
}
