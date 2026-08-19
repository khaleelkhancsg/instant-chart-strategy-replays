#!/usr/bin/env python3
"""
Opening-range breakout strategy, as a set of PURE functions.

The second book for the combined bot. It trades once a day off a level drawn
from the two hours before the New York open, and it is deliberately kept
separate from mnq_donchian_bot.py: no API, no state, no clock. Everything here
takes bars in and returns a decision, so it can be diffed stage by stage
against research/lib_orb.mjs the same way the Donchian pipeline is.

    node research/export_orb_fixture.mjs      # regenerate the fixture
    python bot/test_orb_parity.py             # verify

WHAT IT DOES, and why each piece is the way it is:

  LEVEL      Not the high and low of the pre-open range. Swing pivots in the
             window are clustered by price, and the densest cluster above the
             reference price and the densest below become the levels. That is
             what a discretionary trader means by "where price keeps reacting",
             and it usually sits INSIDE the range rather than at its edges.

  ENTRY      A plain break of the level, entered on a resting stop one tick
             beyond it. No push/retrace/push confirmation: measured over 704
             matched pairs, waiting for the second push improves each trade by
             $26.69 and costs 4.66pp of pass rate, because it halves the number
             of trades.

  AMBIGUITY  If one minute breaks BOTH levels, that minute is ignored and the
             hunt continues. Abandoning the day instead cost 26% of days that
             had a level, and was worth 23.6% -> 38.4%.

  SIZE       Risk-normalised to $500 a trade, which keeps every position clear
             of the $1,000 platform cap. Measured: 0 of 1,045 trades ever
             reached it, worst was -$625.

  EXIT       Stop on the opposite level, target at 3R, and a five-minute time
             stop. Longer holds score better under a 21-day deadline and worse
             without one; five minutes is the best pairing with the Donchian
             book on both measures.
"""

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

TICK = 0.25
PV = 2.0                       # $ per point, MNQ

# CT minutes. The NY open is 08:30 Chicago; the pre-open window is the two
# hours before it; the hunt gives up at 09:30 Chicago (10:30 New York).
OPEN_CT = 510
DEFAULT_CFG = {
    "pre_window_min": 120,     # PRE120
    "pivot_k": 3,
    "tol_frac": 0.08,
    "min_touch": 3,
    "give_up_ct": 570,
    "buf_ticks": 0.0,          # ticks beyond the level that count as a break
    "trigger_ticks": 1.0,      # where the resting stop sits, beyond the level
    "r_mult": 3.0,
    "max_hold_min": 5,
    "risk_dollars": 500.0,
    "max_lots": 50,
}


@dataclass
class OrbLevels:
    """The two levels for one session, plus the working the choice came from."""
    hi: float
    lo: float
    taps_hi: int
    taps_lo: int
    win_hi: float              # the pre-open window's actual extremes, kept
    win_lo: float              # because the stop is measured to the far level
    ref: float                 # last price before the open


@dataclass
class OrbEntry:
    side: int                  # +1 long, -1 short
    trigger: float             # resting stop price
    stop: float
    target: float
    risk_pts: float
    lots: int
    risk_usd: float


def pivots_in(bars: Sequence[dict], k: int) -> List[float]:
    """Prices where the market came and turned away.

    A bar qualifies if its high is the highest, or its low the lowest, of its
    +/-k neighbourhood. Both count as taps of the same level: a price can be
    respected from either side, which is the whole reason the level matters.
    """
    out: List[float] = []
    n = len(bars)
    for i in range(k, n - k):
        is_h = is_l = True
        for j in range(1, k + 1):
            if not (bars[i]["h"] >= bars[i - j]["h"] and bars[i]["h"] >= bars[i + j]["h"]):
                is_h = False
            if not (bars[i]["l"] <= bars[i - j]["l"] and bars[i]["l"] <= bars[i + j]["l"]):
                is_l = False
        if is_h:
            out.append(bars[i]["h"])
        if is_l:
            out.append(bars[i]["l"])
    return out


def cluster_px(pivots: Sequence[float], tol: float, min_touch: int) -> List[Tuple[float, int]]:
    """Greedy price clustering, returning (mean price, tap count).

    A cluster keeps absorbing pivots while they stay within `tol` of where it
    STARTED, not of its running mean, so cluster width is bounded by tol and the
    result cannot drift across a wide range one pivot at a time.
    """
    if not pivots:
        return []
    piv = sorted(pivots)
    groups: List[List[float]] = [[piv[0]]]
    for p in piv[1:]:
        if p - groups[-1][0] <= tol:
            groups[-1].append(p)
        else:
            groups.append([p])
    return [(sum(g) / len(g), len(g)) for g in groups if len(g) >= min_touch]


def orb_levels(day_bars: Sequence[dict], cfg: dict = None) -> Optional[OrbLevels]:
    """Levels for one session from its pre-open window.

    `day_bars` are 1-minute bars for the trading day, each a dict with keys
    o/h/l/c and ct (CT minute of the bar). Returns None when no price in the
    window was tapped often enough on BOTH sides -- which happens on about 43%
    of days, and on those days the setup being described simply does not exist.
    """
    cfg = {**DEFAULT_CFG, **(cfg or {})}
    lo_ct = OPEN_CT - cfg["pre_window_min"]
    win = [b for b in day_bars if lo_ct <= b["ct"] < OPEN_CT]
    k = cfg["pivot_k"]
    if len(win) < 4 * k + 6:
        return None

    whi = max(b["h"] for b in win)
    wlo = min(b["l"] for b in win)
    if not whi > wlo:
        return None

    tol = max(TICK * 2, (whi - wlo) * cfg["tol_frac"])
    piv = pivots_in(win, k)
    if len(piv) < cfg["min_touch"]:
        return None
    clusters = cluster_px(piv, tol, cfg["min_touch"])
    if not clusters:
        return None

    ref = win[-1]["c"]

    def pick(side: int):
        cands = [c for c in clusters if (c[0] > ref if side > 0 else c[0] < ref)]
        if not cands:
            return None
        # most taps wins; ties go to the NEARER level, which is the one price
        # can realistically reach inside a session.
        cands.sort(key=lambda c: (-c[1], abs(c[0] - ref)))
        return cands[0]

    up, dn = pick(1), pick(-1)
    if up is None or dn is None:
        return None
    return OrbLevels(hi=up[0], lo=dn[0], taps_hi=up[1], taps_lo=dn[1],
                     win_hi=whi, win_lo=wlo, ref=ref)


def orb_entry(levels: OrbLevels, session_bars: Sequence[dict],
              cfg: dict = None) -> Optional[OrbEntry]:
    """The entry to arm right now, or None.

    `session_bars` are the 1-minute bars from the open up to and including the
    one that just closed. Stateless on purpose: it replays the day each time, so
    a restart mid-session reaches the same decision as an uninterrupted run.

    Returns an entry only when the MOST RECENT bar is the one that broke a
    level, so a caller polling once a minute arms exactly once.
    """
    cfg = {**DEFAULT_CFG, **(cfg or {})}
    buf = cfg["buf_ticks"] * TICK
    for idx, b in enumerate(session_bars):
        if b["ct"] >= cfg["give_up_ct"]:
            return None
        up = b["h"] > levels.hi + buf
        dn = b["l"] < levels.lo - buf
        if up and dn:
            # One minute broke both. OHLC cannot say which came first, so this
            # bar carries no information -- skip it and keep hunting rather than
            # abandoning the session.
            continue
        if not (up or dn):
            continue
        # A level broke. Only act if it broke on the bar that just closed;
        # anything earlier means the day has already had its shot.
        if idx != len(session_bars) - 1:
            return None
        side = 1 if up else -1
        level = levels.hi if up else levels.lo
        trigger = _round_tick(level + side * cfg["trigger_ticks"] * TICK)
        far = levels.lo if up else levels.hi
        risk_pts = abs(trigger - far)
        if risk_pts < TICK:
            return None
        lots = max(1, min(int(cfg["max_lots"]),
                          int(cfg["risk_dollars"] // (risk_pts * PV))))
        return OrbEntry(
            side=side,
            trigger=trigger,
            stop=_round_tick(trigger - side * risk_pts),
            target=_round_tick(trigger + side * risk_pts * cfg["r_mult"]),
            risk_pts=risk_pts,
            lots=lots,
            risk_usd=risk_pts * PV * lots,
        )
    return None


def _round_tick(px: float) -> float:
    """Round to a tradeable price, HALF UP.

    Not Python's round(), which is banker's rounding and sends a .5 to the
    nearest EVEN. JavaScript's Math.round is half-up, and the levels here are
    cluster MEANS, so landing exactly halfway between two ticks is common rather
    than rare -- it happened on 2 of 133 entries in the fixture. Matching the
    JS convention keeps the bot and the backtest from silently disagreeing by
    half a tick on the ties.
    """
    import math
    return math.floor(px / TICK + 0.5) * TICK
