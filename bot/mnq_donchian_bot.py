#!/usr/bin/env python3
"""
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MNQ DONCHIAN + EFFICIENCY-GATE BOT  —  TopstepX / ProjectX REST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Live port of `mnq_chart_lab/strategies/donchian_eff_rth.mjs`, the best
configuration found in that project. Full derivation and rationale:
    ../STRATEGY_SPEC_donchian_eff_rth.md

CONFIGURED FOR THE CURRENT REGIME, WITH A PLATFORM HARD STOP IN FORCE.
The platform enforces a hard -$1,000 stop on UNREALISED daily P&L. That is
treated as non-negotiable, and it is expensive: measured on the same config with
only the cap toggled, it costs 9.3 points in the high-volatility regime
(50.6% -> 41.3%) and 5.1 across all history (35.5% -> 30.4%). It caps the stop in
DOLLARS and so silently tightens the bracket the whole book depends on, and it
costs MORE in the volatile regime because that is where it binds hardest.
It does pay for itself in one respect: profit factor 1.033 -> 1.077 and net
$53,297 -> $90,247, because it removes the worst tail. Everything below is
measured WITH it on.

MEASURED (8 contracts, 5xATR/1.75xATR, 1 tick of slippage, hard -$1000 cap,
breaker -$500, profit block $750):
  - 41.3% in HIGH-VOLATILITY windows: 41.5% early / 41.2% late across the two
    halves. Confirmed on the real challenge.mjs engine, not the fast sweep.
    Balance across the two halves of the HIGH-VOLATILITY
    regime. The balance matters more than the level: configurations that score
    higher on one half score much worse on the other.
  - 38.2% on 2026 alone, but that slice holds ~6 independent windows and cannot
    carry weight by itself.
  - 30.5% across all 2,598 windows 2019-2026, dragged down by quiet years the
    strategy is not suited to and which are not the current market
  - pf 1.077, 69.7% win rate, 4,188 trades, net +$90,247
  - worst single loss -$8,782, and 50 trades still exceed the $2,000 trailing
    drawdown. THE CAP DOES NOT PREVENT THIS: a gap jumps the stop rather than
    touching it, and no stop of any kind helps there.
  - 48.6% of passing accounts reach a funded payout, median 12 days to pass
  - by year: 2019 8%, 2020 24%, 2021 35%, 2022 41%, 2023 33%, 2024 30%,
    2025 44%, 2026 31%

WHY 8 CONTRACTS AND NOT 10.
The all-history sweep picks 10. It is averaging 2019, at a median 2-min ATR of
4.8, with 2026 at 23.7, which is not a market anyone trades. Conditioning on the
current high-volatility regime and validating on the LATER half of it, 8 lots
scores 41.5% against 10 lots' 35.0%. 8 also wins head-to-head on all history
under this cap (31.9% vs 29.9%) at a better profit factor and a smaller worst
loss. Going further down does NOT help: 4 lots scores 34.5% and 2 lots 10.9%,
because throughput collapses against a fixed $3,000 target on a deadline. 8 is a
measured optimum, not a compromise.

DO NOT RETUNE THE 5xATR / 1.5xATR GEOMETRY FOR THE CAP.
Tightening it to 3.5/2.5 scores better on average (44.8% vs 43.4%) and is fitted:
it splits 53.9% early / 35.8% late. The shipped 5/1.5 splits 45.3% / 41.5%, the
most stable pair in the whole grid. The average was the trap; the split is the
evidence.

STRATEGY (2-minute bars, clock-aligned):
  • Donchian-30 breakout, taken WITH the break. The channel EXCLUDES the current
    bar, so it is a genuine break of prior structure.
  • ADX(14) >= 25 on the signal bar.
  • Kaufman efficiency ratio(20) > 0.5 — price must be travelling, not
    oscillating. This keeps only ~9.5% of raw signal bars and is the single
    most important gate.
  • Session 08:30-15:00 CT for SIGNALS. Late afternoon is poison: a 12:30-15:00
    window scored 20.9% against 36.2% for full RTH.
  • INVERTED GEOMETRY: 5.0xATR stop, 1.5xATR target (~0.3:1 reward:risk). Under a
    hard flatten a wide target never arrives — the wide-target books needed a
    median 6.5h for winners and 1.0h for losers, so the deadline truncated 37% of
    winners and 5% of losers. Inverting it gives a 75.8% win rate and a 43-minute
    mean hold. DO NOT "fix" this ratio because it looks wrong.
  • FLIPS ALLOWED: an opposite signal while in a position reverses it.
  • 8 contracts, FLAT. Risk-fraction sizing scored 1.6% — it collapses size and a
    fixed $3,000 target becomes unreachable. Against a fixed-dollar target on a
    deadline, throughput beats risk control, right up until one loss can end the
    account. 8 lots is where those two meet in this regime.

DAILY RULES (both are ENTRY BLOCKS on REALISED P&L — neither ever closes a
position, which is the whole point):
  • +$750 soft profit block and a -$500 circuit breaker. Both retuned for the
    capped regime: with the platform bounding the day at -$1,000 anyway, the old
    -$150 breaker just ended days early, and $1,000 of realised profit was past
    where new risk should stop. Measured worth of the move: +1.6pp.
  • Day boundary is 17:00 ET, matching the firm.

⚠️  TURN OFF YOUR PLATFORM'S UNREALISED *PROFIT* STOP. (The LOSS stop stays
    — that one is not negotiable. This is the other one.)
    A HARD cap (closing on unrealised P&L) is a different animal from the soft
    block above, and the two want opposite values. Measured at one tick:
        hard $1500 + soft $1000, 9 lots   42.3%   pf 0.964   -$52,778
        hard OFF  + soft $1000, 10 lots   41.0%   pf 1.047   +$91,640
    1.3pp of pass rate for the difference between making $91,640 and losing
    $52,778. The hard cap truncates winners at an arbitrary dollar level while
    leaving losses alone. Only keep it if you are farming resets and never
    intend to trade funded. The bot warns about this at startup; see
    `platform_hard_profit_stop_disabled` below.

⚠️  A HIGH WIN RATE IS NOT EVIDENCE THIS BOT IS WORKING.
    A 5xATR stop against a 1.5xATR target wins 5/6.5 = 76.9% of the time on a
    PURE COIN FLIP, and resolves in a*b/sigma^2 = 38 minutes. Those are exact
    results for a driftless random walk, not estimates. The backtested book is
    75.8% and 43 minutes. So the two statistics you will watch every session are
    what the BRACKET dictates and carry no information about edge at all.
    A losing week at a 76% win rate is the expected shape of this book, not a
    malfunction. Judge it on dollars per day, never on win rate.

    A 10,000-window Monte Carlo (research/monte_carlo.mjs) that simulates prices
    instead of replaying the book puts the ZERO-EDGE pass rate at 30.1%. The
    rules and the geometry deliver 30 of the backtested 42.6 points on their own;
    the entire measured edge is worth roughly 7-12 more. If that edge is even
    partly overfit, this lands nearer the null than the headline. That null was
    computed for the uncapped 10-lot book; the principle carries, the number
    would need re-running for this configuration.

ON SIZING — the reasoning that got to 8, recorded so it is not re-litigated.
    A 10,000-window Monte Carlo found a cliff wherever one stop-out exceeds the
    $2,000 trailing drawdown, on both the ATR and the contracts lever. Tested
    against the real book as sizingMode 'risk' it LOST (38.6% at $1,900 of risk
    against 41.0% flat), because the model has no jumps and real stops are gapped
    THROUGH rather than touched. Dollar-risk sizing is dead.
    What was NOT dead was the underlying point, once the regime was separated
    from the 8-year average: a FIXED smaller size chosen for current volatility
    does win. That is the difference between sizing every trade to a risk budget
    (dead) and picking one size that suits the regime (8 lots).

KNOWN LIMITATIONS (measured, not speculative):
  • COMMISSION IS 47% OF GROSS PROFIT. At double commission the book is
    unprofitable. This is the first thing to check against your real fills.
  • Slippage was modelled as ZERO in the headline. One tick per side costs ~$150
    per combine (~16 trades) and about 2.5pp of pass rate — survivable, but the
    bot measures it so you can see if yours is worse.
  • ONE LOSS STILL ENDS THE DAY. A capped loss is ~$1,000 against a -$750
    breaker, so one loser closes the session. Intended, and priced in.
  • A TRADE CAN STILL END THE ACCOUNT, CAP OR NO CAP. 50 trades in the book lose
    more than the entire $2,000 trailing drawdown and the worst is -$8,782,
    because the platform stop can only fire on a price it is shown and a gap
    jumps it. The cap cuts these from 297 to 50 — a large improvement, not
    immunity. No daily rule helps either; both are entry blocks and neither can
    touch a trade already running.
  • QUIET REGIMES ARE WHERE THIS BOOK DIES, not volatile ones: 2019 scores 8%
    at a median ATR of 4.8. If volatility collapses back toward 2019-2021
    levels, re-run research/regime_sizing.mjs before starting an evaluation. The
    right size moves with the regime, and this configuration is tuned for ATR
    around 20-24.

IMPLEMENTATION NOTES:
  1. Bars are fetched at 1-MINUTE resolution and aggregated to 2 minutes HERE,
     clock-aligned on the epoch (floor(ms / 120000)) — identical to
     src/resample.mjs. The exchange's own 2-minute aggregation is not used
     because its alignment is unverified, and a half-bar offset would silently
     make this a different strategy.
  2. ATR and ADX use a plain EMA (alpha = 2/(span+1)), NOT Wilder's smoothing.
     Wilder is the textbook default and would be wrong here.
  3. Every stage is checked against a golden fixture exported from the JS engine:
         node research/export_bot_fixture.mjs
         python bot/test_donchian_parity.py
     Run that after ANY edit to the maths below.
  4. Requires env vars PROJECT_X_USERNAME and PROJECT_X_API_KEY (.env auto-loaded).
  5. Run on a DEDICATED account — the flatten cleanup cancels ALL working orders.
  6. Update `contract_id` on every roll.
"""

import asyncio
import json
import logging
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

try:
    from zoneinfo import ZoneInfo
except ImportError:                                     # pragma: no cover
    from backports.zoneinfo import ZoneInfo             # type: ignore

CT_TZ = ZoneInfo("America/Chicago")
ET_TZ = ZoneInfo("America/New_York")

# ─────────────────────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────────────────────
# Values marked "spec" are part of the measured result, not suggestions. The
# headline this configuration is calibrated to is 43.4% in high-volatility
# windows / 41.5% on the later half of them, WITH the platform hard stop on.
CONFIG = {
    # instrument / account
    "contract_id": "CON.F.US.MNQ.U26",   # ⚠ update on roll; must match account type
    "live_account": False,               # False = sim/practice, True = live/funded
    "dry_run": True,                     # >>> SHIPS IN DRY-RUN <<< run one full session
                                         # paper-only, confirm the session gates, the
                                         # 15:04 flatten and the fill log look right,
                                         # THEN set False to arm it.
    "tick_size": 0.25,                   # MNQ price increment (points)
    "tick_value": 0.50,                  # $ per tick (= $2.00/point)

    # signal (spec) — see donchian_eff_rth.mjs
    "timeframe_min": 2,
    "period": 30,                        # Donchian lookback, channel excludes current bar
    "adx_min": 25,
    "adx_period": 14,
    "atr_period": 14,
    "cooldown_bars": 1,                  # bars between signals (1 == no-op, kept for parity)
    "eff_period": 20,
    "eff_min": 0.5,                      # Kaufman efficiency ratio floor. NaN FAILS the gate.

    # execution (spec)
    # 8, not the 10 the all-history sweep chose. That sweep averaged 2019 (median
    # 2-min ATR 4.8) with 2026 (23.7), which is not a market anyone trades.
    # Conditioning on the CURRENT high-volatility regime and validating on the
    # later half of it, 8 lots scores 41.5% against 10 lots' 35.0%, and beats it
    # head-to-head on all history too (31.9% vs 29.9%). See
    # research/regime_sizing.mjs.
    "contracts": 8,
    "sl_atr_mult": 5.0,
    # 1.75, not the 1.5 the uncapped book used. With the platform cap pinning the
    # stop at 62.5 points on every trade above ATR 12.5, the stop is no longer a
    # free parameter and the TARGET is the only geometry lever left. 1.75 is
    # pass-rate neutral against 1.5 (41.2% vs 41.5% on the worse half of the
    # high-volatility regime, inside the noise) and materially more profitable:
    # pf 1.055 -> 1.077, net $62,024 -> $90,247 over 4,463 trades. It also holds
    # up better on 2026 (38.2% vs 30.9%), though that slice has ~6 independent
    # windows and cannot carry weight on its own.
    # Do NOT tighten to 1.25 because it ranks higher on the worse half (43.3%):
    # it scores 21.8% on 2026, i.e. it is fitted to the pre-2026 stretch.
    "tp_atr_mult": 1.75,
    "flip_on_opposite": True,

    # -- SCALE-IN --------------------------------------------------------
    # Take a small first tranche at the signal and add the rest only once price
    # has moved `scale_in_trigger_atr` x ATR in the trade's FAVOUR.
    #
    # It is not better averaging: the add fills WORSE than the signal. It is a
    # soft stop. About 15% of trades never move even a quarter-ATR the right way
    # and those average -$278 each, so starting small means only a quarter of the
    # position ever meets them. Measured +7pp all-history and +8pp on the last 12
    # months under a pessimistic within-bar assumption, with BOTH time halves
    # improving. Adding on a DIP instead tests clearly worse - a breakout that
    # retraces is the one that failed.
    #
    # The add is a BUY above the market (or a sell below), so it can only be a
    # STOP order. A stop-limit would cap the price but miss exactly when price
    # runs fastest through the level, which are the adds most worth having.
    # Slippage is the affordable cost: break-even is 8 ticks of EXTRA slippage on
    # the add, and a plain stop should cost 1-3.
    "scale_in": True,
    "scale_in_first": 2,                 # lots taken at the signal; the rest rests
    "scale_in_trigger_atr": 0.15,        # favourable move required before adding
    "scale_in_window_bars": 10,          # give up on the add after this many bars
    "scale_in_slip_warn_ticks": 6.0,     # past this the benefit is largely gone

    # session, CT minutes past midnight
    "signal_start_ct": 8 * 60 + 30,      # 08:30 — first bar whose signal counts
    "signal_end_ct": 15 * 60,            # 15:00 — signal bars gated below this
    "no_entry_ct": 14 * 60 + 55,         # 14:55 — no NEW entries at/after this
    "flatten_ct": 15 * 60 + 4,           # 15:04 — force-flat. The firm deadline is 15:05
                                         # and the backtest models the first 2-min bucket
                                         # at/after 15:05 (i.e. 15:06); acting at 15:04
                                         # puts the fill safely INSIDE the deadline. The
                                         # cost is at most 2 minutes of one trade's life.
    "reopen_ct": 17 * 60,                # 17:00 — session reopens (no entries before then;
                                         # academic here, the gate stops at 15:00 anyway)
    "reset_hour_et": 17,                 # trading-day boundary (5pm ET), matches the firm

    # daily rules — ENTRY BLOCKS on REALISED day P&L. Neither closes a position.
    # Both retuned for the hard-cap regime. With a platform stop bounding the day
    # at -$1000, the optimum moves: the old -$150 breaker ends a day after one
    # small loser when the floor is already guaranteed, and $1000 of realised
    # profit is past where the day should stop opening new risk. Measured grid in
    # research/capped_search.mjs: -$750 / $750 is worth +1.6pp over -$150 / $1000.
    "daily_profit_block": 750.0,
    "circuit_breaker": 500.0,            # self-imposed daily loss stop (positive number).
                                         # Mid-plateau: -$300 to -$750 all score 40.9-41.2%.
    "firm_daily_loss": 1000.0,           # firm's own limit, for the warning banner only
    # The platform's hard stop on UNREALISED daily P&L. The bot does NOT enforce
    # this — the platform does, and it will close a position out from under the
    # bot. Recorded here so the entry log can say how close each trade sits to it.
    # It costs ~6pp of pass rate and is treated as non-negotiable.
    "platform_hard_loss_stop": 1000.0,
    "trailing_drawdown": 2000.0,         # firm's trailing drawdown. REPORTING ONLY — the bot
                                         # does not track cushion or resize against it. Sizing
                                         # against the drawdown was tested on real data and
                                         # LOST (see the sizing note in the header).

    # ⚠ Set this True ONLY after you have actually turned the unrealised profit
    #   stop OFF in the trading platform. It gates nothing — it exists so the
    #   startup banner stops nagging, and so "did I remember?" has an answer that
    #   survives a two-week gap. See the header.
    "platform_hard_profit_stop_disabled": False,

    # costs — reporting only; the broker charges what it charges
    "commission_per_side": 0.75,         # $ per contract per side

    # data / loop
    "fetch_days": 5,                     # 1-min history fetched each cycle. Five days of
                                         # 1-min bars exceeds the endpoint's 5000-row limit,
                                         # so the response is truncated — deliberately. The
                                         # truncation favours RECENT bars (mnq_macd_bot_v2
                                         # has run live on a 4-day window for weeks), and
                                         # five days is what keeps a Monday after a holiday
                                         # Friday above the warm-up floor. If the assumption
                                         # is ever wrong the newest bar goes stale and
                                         # `max_bar_age_s` refuses to trade — a loud failure,
                                         # not a quiet one.
    "warmup_bars_2m": 600,               # 2-min bars retained for indicators. The backtest
                                         # warms up with 900. Measured convergence against a
                                         # full-history run: 600 bars puts ATR within 1.4e-7
                                         # points and ADX within 6.6e-4, with identical
                                         # signals. The real floor is ~150 bars (still inside
                                         # 0.005 of a tick); 600 is chosen for margin, not
                                         # because it is needed.
    "max_bar_age_s": 300,                # refuse to trade on a feed this stale
    "max_entry_delay_s": 40,             # skip entries whose signal bar closed longer ago
    "flatten_poll_s": 10,                # position-check cadence inside the flatten window
    # Warn past this many ticks of |deviation|. Tightened from 4.0: the Monte
    # Carlo (research/monte_carlo.mjs) puts 3 ticks per side AT the zero-edge
    # null — 29.4% against a 30.1% null — meaning slippage alone has eaten the
    # entire edge by then. 2 ticks already costs ~6pp. A warning at 4 fires only
    # after the strategy has stopped being worth running.
    # NOTE this metric runs ~1 tick hot: it measures the fill against the SIGNAL
    # BAR'S CLOSE, so it includes crossing the spread, which the backtest never
    # charged. Read 3.0 here as roughly 2 ticks of true slippage.
    "slip_warn_ticks": 3.0,
    "state_file": "donchian_bot_state.json",
}

TICK = CONFIG["tick_size"]
BUCKET_MS = CONFIG["timeframe_min"] * 60_000

# ─────────────────────────────────────────────────────────────
#  LOGGING
# ─────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s  %(levelname)-7s  %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S")
log = logging.getLogger("MNQ-DONCH")
_log_dir = Path(os.environ.get("MNQ_LOG_DIR", "logs"))
_log_dir.mkdir(parents=True, exist_ok=True)
_fh = logging.FileHandler(_log_dir / f"donchian_{datetime.now():%Y%m%d_%H%M%S}.log",
                          encoding="utf-8")
_fh.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-7s  %(message)s",
                                   "%Y-%m-%d %H:%M:%S"))
logging.getLogger().addHandler(_fh)
DIV = "─" * 60


# ═════════════════════════════════════════════════════════════
#  PURE MATHS — mirrors src/indicators.mjs and src/resample.mjs
#  Every function here is asserted against the JS engine by
#  bot/test_donchian_parity.py. Change nothing without re-running it.
# ═════════════════════════════════════════════════════════════
def ema(values: Sequence[float], span: int) -> List[float]:
    """EMA seeded on the first value. NOT Wilder — see header note 2."""
    n = len(values)
    if n == 0:
        return []
    a = 2.0 / (span + 1)
    b = 1.0 - a
    out = [float(values[0])]
    for i in range(1, n):
        out.append(a * values[i] + b * out[-1])
    return out


def true_range(H: Sequence[float], L: Sequence[float], C: Sequence[float]) -> List[float]:
    n = len(C)
    if n == 0:
        return []
    tr = [H[0] - L[0]]
    for i in range(1, n):
        pc = C[i - 1]
        tr.append(max(H[i] - L[i], abs(H[i] - pc), abs(L[i] - pc)))
    return tr


def atr_series(H, L, C, period: int) -> List[float]:
    return ema(true_range(H, L, C), period)


def adx_series(H, L, C, period: int) -> List[float]:
    """Directional index smoothed with an EMA at every stage."""
    n = len(C)
    if n == 0:
        return []
    tr = [0.0] * n
    pdm = [0.0] * n
    ndm = [0.0] * n
    tr[0] = H[0] - L[0]
    for i in range(1, n):
        pc = C[i - 1]
        tr[i] = max(H[i] - L[i], abs(H[i] - pc), abs(L[i] - pc))
        up = H[i] - H[i - 1]
        dn = L[i - 1] - L[i]
        pdm[i] = up if (up > dn and up > 0) else 0.0
        ndm[i] = dn if (dn > up and dn > 0) else 0.0
    atr_e = ema(tr, period)
    pdi_e = ema(pdm, period)
    ndi_e = ema(ndm, period)
    dx = [0.0] * n
    for i in range(n):
        a = atr_e[i]
        pdi = 0.0 if a == 0 else 100.0 * pdi_e[i] / a
        ndi = 0.0 if a == 0 else 100.0 * ndi_e[i] / a
        s = pdi + ndi
        dx[i] = 0.0 if s == 0 else 100.0 * abs(pdi - ndi) / s
    return ema(dx, period)


def donchian(H: Sequence[float], L: Sequence[float], p: int) -> Tuple[List[float], List[float]]:
    """Rolling extremes of the PREVIOUS p bars — the current bar is excluded, so a
    close beyond the channel is a break of prior structure and not a bar being
    compared against itself. NaN until p bars of history exist."""
    n = len(H)
    hh = [math.nan] * n
    ll = [math.nan] * n
    qh: List[int] = []   # indices, decreasing highs
    ql: List[int] = []   # indices, increasing lows
    for i in range(n):
        if i > 0:
            j = i - 1
            while qh and H[qh[-1]] <= H[j]:
                qh.pop()
            qh.append(j)
            while ql and L[ql[-1]] >= L[j]:
                ql.pop()
            ql.append(j)
            while qh[0] < i - p:
                qh.pop(0)
            while ql[0] < i - p:
                ql.pop(0)
        if i >= p:
            hh[i] = H[qh[0]]
            ll[i] = L[ql[0]]
    return hh, ll


def efficiency_ratio(C: Sequence[float], p: int = 20) -> List[float]:
    """Kaufman efficiency ratio: net displacement over total path travelled.
    1.0 = a straight line, ~0 = pure chop. NaN until p bars exist."""
    n = len(C)
    out = [math.nan] * n
    path = 0.0
    for i in range(1, n):
        path += abs(C[i] - C[i - 1])
        if i > p:
            path -= abs(C[i - p] - C[i - p - 1])
        if i >= p:
            out[i] = 0.0 if path == 0 else abs(C[i] - C[i - p]) / path
    return out


class Bar2m:
    """A clock-aligned 2-minute bar. `ct_min` is the CT minute the bar OPENS at,
    which is what every session rule keys off — matching src/resample.mjs."""
    __slots__ = ("ts", "open", "high", "low", "close", "volume", "ct_min", "tday")

    def __init__(self, ts: int, o: float, h: float, l: float, c: float, v: float):
        self.ts = ts
        self.open = o
        self.high = h
        self.low = l
        self.close = c
        self.volume = v
        self.ct_min = 0
        self.tday = 0

    def __repr__(self) -> str:                                   # pragma: no cover
        return (f"Bar2m({datetime.fromtimestamp(self.ts / 1000, timezone.utc):%Y-%m-%d %H:%M} "
                f"O{self.open} H{self.high} L{self.low} C{self.close})")


def aggregate_2m(bars1m: Sequence[dict], now_utc: Optional[datetime] = None) -> List[Bar2m]:
    """Aggregate 1-minute bars into clock-aligned 2-minute bars.

    Bucketing is floor(epoch_ms / 120000), identical to src/resample.mjs. Buckets
    are formed from whatever 1-minute bars exist, so a quiet minute with no
    prints does not shift the grid — which is exactly why the alignment must come
    from the clock and not from counting bars.

    The final bucket is DROPPED unless wall-clock time has passed its end. A
    bucket can legitimately contain a single 1-minute bar (the other minute had
    no trades), so completeness has to be judged on time, never on bar count.
    """
    out: List[Bar2m] = []
    cur = -1
    for b in bars1m:
        ts = _bar_ms(b)
        if ts is None:
            continue
        o, h, l, c = _ohlc(b)
        bucket = ts // BUCKET_MS
        if bucket != cur:
            cur = bucket
            out.append(Bar2m(bucket * BUCKET_MS, o, h, l, c, 0.0))
        cell = out[-1]
        if h > cell.high:
            cell.high = h
        if l < cell.low:
            cell.low = l
        cell.close = c
        cell.volume += _vol(b)

    if out:
        now = now_utc or datetime.now(timezone.utc)
        end_ms = out[-1].ts + BUCKET_MS
        if now.timestamp() * 1000 < end_ms:
            out.pop()

    for cell in out:
        dt = datetime.fromtimestamp(cell.ts / 1000, timezone.utc)
        ct = dt.astimezone(CT_TZ)
        cell.ct_min = ct.hour * 60 + ct.minute
        cell.tday = trading_day_of(dt)
    return out


def raw_signals(bars: Sequence[Bar2m], cfg: dict) -> Tuple[List[int], List[float]]:
    """Ungated Donchian breakout + ADX floor. Mirrors donchian_eff_rth.mjs
    `compute()`. Returns (signals, ATR series).

    Kept separate from the gate so each stage can be diffed against the JS
    engine on its own — a mismatch then names the stage instead of just moving
    the trade count.
    """
    H = [b.high for b in bars]
    L = [b.low for b in bars]
    C = [b.close for b in bars]
    n = len(C)

    a = atr_series(H, L, C, cfg["atr_period"])
    adx = adx_series(H, L, C, cfg["adx_period"])
    dh, dl = donchian(H, L, cfg["period"])

    sig = [0] * n
    last = -(10 ** 9)
    for i in range(cfg["period"], n):
        if i - last < cfg["cooldown_bars"]:
            continue
        if adx[i] < cfg["adx_min"]:
            continue
        # The channel excludes the current bar, so this is a genuine break of
        # prior structure rather than a bar comparing against itself.
        if C[i] > dh[i]:
            sig[i] = 1
            last = i
        elif C[i] < dl[i]:
            sig[i] = -1
            last = i
    return sig, a


def apply_gate(sig: List[int], bars: Sequence[Bar2m], cfg: dict) -> List[int]:
    """Session + efficiency gate. Mirrors src/filters.mjs `applyFilters` with
    {startCt, endCt, effMin}. Returns a NEW list; `sig` is left alone.

    This gate is the strategy. It keeps roughly 9.5% of raw signal bars, and on
    a short sample it subsumes the ADX floor entirely — every breakout with an
    efficiency ratio above 0.5 in RTH already has ADX above 25. Do not read that
    as ADX being useless; read it as the efficiency ratio doing the work.
    """
    out = list(sig)
    start, end = cfg["signal_start_ct"], cfg["signal_end_ct"]
    emin = cfg["eff_min"]
    eff = efficiency_ratio([b.close for b in bars], cfg["eff_period"])
    for i in range(len(out)):
        if out[i] == 0:
            continue
        ct = bars[i].ct_min
        in_window = (start <= ct < end) if end >= start else (ct >= start or ct < end)
        if not in_window:
            out[i] = 0
            continue
        # A NaN reading FAILS an active band — an unknown regime is not a
        # qualifying one. (src/filters.mjs inBand)
        e = eff[i]
        if emin > 0 and (not math.isfinite(e) or e < emin):
            out[i] = 0
    return out


def compute_signals(bars: Sequence[Bar2m], cfg: dict) -> Tuple[List[int], List[float]]:
    """Return (gated signals, ATR series) for every bar — what the bot trades."""
    sig, a = raw_signals(bars, cfg)
    return apply_gate(sig, bars, cfg), a


def trading_day_of(dt_utc: datetime) -> int:
    """Days since epoch for the CME trading day, which rolls at 17:00 ET.
    Matches nyTradingDay() in prepare.mjs — the daily rules bucket on this."""
    et = dt_utc.astimezone(ET_TZ)
    d = et.date()
    if et.hour >= CONFIG["reset_hour_et"]:
        d = d + timedelta(days=1)
    return (d - datetime(1970, 1, 1).date()).days


def trading_day_key(now_utc: datetime) -> str:
    et = now_utc.astimezone(ET_TZ)
    d = et.date()
    if et.hour >= CONFIG["reset_hour_et"]:
        d = d + timedelta(days=1)
    return d.isoformat()


# ─────────────────────────────────────────────────────────────
#  BAR PARSING (the history endpoint's field names vary)
# ─────────────────────────────────────────────────────────────
def _ohlc(bar: dict) -> Tuple[float, float, float, float]:
    def g(keys):
        for k in keys:
            if k in bar and bar[k] is not None:
                return float(bar[k])
        return 0.0
    return (g(("open", "o", "Open")), g(("high", "h", "High")),
            g(("low", "l", "Low")), g(("close", "c", "Close")))


def _vol(bar: dict) -> float:
    for k in ("volume", "v", "Volume"):
        if k in bar and bar[k] is not None:
            try:
                return float(bar[k])
            except (TypeError, ValueError):
                return 0.0
    return 0.0


def _ts(bar: dict) -> Optional[str]:
    for k in ("t", "timestamp", "datetime", "time"):
        if k in bar and bar[k] is not None:
            return str(bar[k])
    return None


def _bar_utc(bar: dict) -> Optional[datetime]:
    raw = _ts(bar)
    if raw is None:
        return None
    s = raw.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _bar_ms(bar: dict) -> Optional[int]:
    if "ms" in bar and bar["ms"] is not None:      # fixture / test convenience
        return int(bar["ms"])
    dt = _bar_utc(bar)
    return None if dt is None else int(dt.timestamp() * 1000)


# ═════════════════════════════════════════════════════════════
#  TOPSTEPX REST CLIENT
#  Same client as mnq_macd_bot_v2.py, including the signed-bracket-ticks
#  behaviour confirmed live 2026-07-21.
# ═════════════════════════════════════════════════════════════
import httpx                                                     # noqa: E402
from dotenv import load_dotenv                                   # noqa: E402

load_dotenv()


class TopstepXClient:
    BASE = "https://api.topstepx.com/api"
    TOKEN_TTL_S = 23 * 3600

    def __init__(self) -> None:
        self._token: Optional[str] = None
        self._token_time: Optional[datetime] = None
        self._account_id: Optional[int] = None
        self._balance: float = 0.0

    async def connect(self) -> None:
        await self._login()
        await self._resolve_account()

    async def _login(self) -> None:
        username = os.environ.get("PROJECT_X_USERNAME", "")
        api_key = os.environ.get("PROJECT_X_API_KEY", "")
        if not username or not api_key:
            raise EnvironmentError("PROJECT_X_USERNAME and PROJECT_X_API_KEY must be set")
        data = await self._raw_post("/Auth/loginKey",
                                    {"userName": username, "apiKey": api_key}, auth=False)
        token = data.get("token") or data.get("sessionToken")
        if not token:
            raise RuntimeError(f"Auth failed: {data.get('errorMessage', 'no token')}")
        self._token = token
        self._token_time = datetime.now(timezone.utc)
        log.info("✅ Authenticated (TopstepX REST)")

    async def _ensure_token(self) -> None:
        now = datetime.now(timezone.utc)
        if (self._token is None or self._token_time is None or
                (now - self._token_time).total_seconds() > self.TOKEN_TTL_S):
            await self._login()

    async def _resolve_account(self) -> None:
        data = await self._post("/Account/search", {"onlyActiveAccounts": True})
        accounts = data.get("accounts", [])
        if not accounts:
            raise RuntimeError("No active accounts found")
        acct = accounts[0]                                        # CHANGE ACCOUNT NUMBER HERE
        self._account_id = acct["id"]
        self._balance = float(acct.get("balance", 0))
        log.info("✅ Account: %s (id=%s bal=%.2f)",
                 acct.get("name", ""), self._account_id, self._balance)

    async def _raw_post(self, path: str, body: dict, auth: bool = True) -> dict:
        headers = {"Content-Type": "application/json", "Accept": "text/plain"}
        if auth and self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        async with httpx.AsyncClient(timeout=15.0) as http:
            resp = await http.post(f"{self.BASE}{path}", json=body, headers=headers)
            resp.raise_for_status()
            return resp.json()

    async def _post(self, path: str, body: dict) -> dict:
        await self._ensure_token()
        for attempt in range(3):
            try:
                return await self._raw_post(path, body)
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 401:
                    log.warning("401 on %s — refreshing token", path)
                    await self._login()
                    continue
                raise
            except Exception as e:
                if attempt == 2:
                    raise
                log.warning("%s attempt %d failed: %s", path, attempt + 1, e)
                await asyncio.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"All retries exhausted for {path}")

    async def refresh_balance(self) -> float:
        try:
            data = await self._post("/Account/search", {"onlyActiveAccounts": True})
            accts = data.get("accounts", [])
            if accts:
                self._balance = float(accts[0].get("balance", self._balance))
        except Exception as exc:
            log.debug("Balance refresh failed: %s", exc)
        return self._balance

    @property
    def balance(self) -> float:
        return self._balance

    async def get_bars_1m(self, days: int = 5) -> List[dict]:
        """Native 1-minute bars. Aggregation to 2 minutes happens locally —
        see aggregate_2m() and header note 1."""
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=days)
        body = {
            "contractId": CONFIG["contract_id"],
            "live": CONFIG["live_account"],
            "startTime": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "endTime": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "unit": 2,               # Minute
            "unitNumber": 1,         # native 1-min
            "limit": 5000,
            "includePartialBar": False,
        }
        for attempt in range(3):
            try:
                data = await self._post("/History/retrieveBars", body)
                bars = data.get("bars") or []
                bars.sort(key=lambda b: str(b.get("t", "")))
                return bars
            except Exception as exc:
                log.warning("get_bars attempt %d: %s", attempt + 1, exc)
                await asyncio.sleep(1.5 * (attempt + 1))
        return []

    async def place_bracket_order(self, side: int, size: int,
                                  sl_ticks: int, tp_ticks: int) -> Optional[int]:
        """side: 0=Buy, 1=Sell.  SL bracket type=4 (Stop), TP type=1 (Limit).

        ProjectX bracket `ticks` are SIGNED offsets from the FILL price, which is
        exactly what the backtest measures the bracket from. LONG: SL negative /
        TP positive; SHORT: SL positive / TP negative. Callers pass magnitudes.
        """
        sl_signed = -abs(sl_ticks) if side == 0 else abs(sl_ticks)
        tp_signed = abs(tp_ticks) if side == 0 else -abs(tp_ticks)
        body = {
            "accountId": self._account_id,
            "contractId": CONFIG["contract_id"],
            "type": 2,          # Market
            "side": side,
            "size": size,
            "limitPrice": None, "stopPrice": None, "trailPrice": None, "customTag": None,
            "stopLossBracket": {"ticks": sl_signed, "type": 4},
            "takeProfitBracket": {"ticks": tp_signed, "type": 1},
        }
        try:
            data = await self._post("/Order/place", body)
            if not data.get("success", False):
                log.error("Order rejected: %s", data.get("errorMessage"))
                return None
            oid = data.get("orderId")
            log.info("✅ Bracket placed | orderId=%s side=%d size=%d sl=%+dt tp=%+dt",
                     oid, side, size, sl_signed, tp_signed)
            return oid
        except Exception as exc:
            log.error("place_bracket_order failed: %s", exc)
            return None

    async def place_stop_with_bracket(self, side: int, size: int, stop_price: float,
                                      sl_ticks: int, tp_ticks: int):
        """A resting STOP entry that arrives WITH its own protective bracket.

        Used for the scale-in tranche. The caller chooses the bracket ticks so
        that, filling at `stop_price`, the stop and target land on the same
        ABSOLUTE prices as the first tranche's — which is what the backtest
        models. A slipped fill shifts them by the slippage, which is acceptable.
        Contracts sitting with no stop at all is not, which is why the bracket
        travels with the order rather than being attached afterwards.
        """
        sl_signed = -abs(sl_ticks) if side == 0 else abs(sl_ticks)
        tp_signed = abs(tp_ticks) if side == 0 else -abs(tp_ticks)
        body = {
            "accountId": self._account_id,
            "contractId": CONFIG["contract_id"],
            "type": 4,          # Stop
            "side": side,
            "size": size,
            "limitPrice": None,
            "stopPrice": round(stop_price / CONFIG["tick_size"]) * CONFIG["tick_size"],
            "trailPrice": None, "customTag": None,
            "stopLossBracket": {"ticks": sl_signed, "type": 4},
            "takeProfitBracket": {"ticks": tp_signed, "type": 1},
        }
        try:
            data = await self._post("/Order/place", body)
            if not data.get("success", False):
                log.error("Scale-in stop rejected: %s", data.get("errorMessage"))
                return None
            oid = data.get("orderId")
            log.info("➕ ADD resting | orderId=%s side=%d size=%d stop @ %.2f  sl=%+dt tp=%+dt",
                     oid, side, size, stop_price, sl_signed, tp_signed)
            return oid
        except Exception as exc:
            log.error("place_stop_with_bracket failed: %s", exc)
            return None

    async def get_open_positions(self) -> List[dict]:
        try:
            data = await self._post("/Position/searchOpen", {"accountId": self._account_id})
            return data.get("positions", [])
        except Exception as exc:
            log.warning("get_open_positions failed: %s", exc)
            return []

    async def close_position(self) -> bool:
        try:
            data = await self._post("/Position/closeContract",
                                    {"accountId": self._account_id,
                                     "contractId": CONFIG["contract_id"]})
            return bool(data.get("success", False))
        except Exception as exc:
            log.error("close_position failed: %s", exc)
            return False

    async def get_open_orders(self) -> List[dict]:
        try:
            data = await self._post("/Order/searchOpen", {"accountId": self._account_id})
            return data.get("orders", [])
        except Exception as exc:
            log.debug("get_open_orders failed: %s", exc)
            return []

    async def cancel_order(self, order_id) -> bool:
        try:
            data = await self._post("/Order/cancel",
                                    {"accountId": self._account_id, "orderId": order_id})
            return bool(data.get("success", False))
        except Exception as exc:
            log.warning("cancel_order %s failed: %s", order_id, exc)
            return False


# ═════════════════════════════════════════════════════════════
#  BOT
# ═════════════════════════════════════════════════════════════
class DonchianBot:
    def __init__(self, api: TopstepXClient) -> None:
        self.api = api
        self.in_position = False
        self._pos_dir = 0
        self._last_bar_ts: Optional[int] = None
        self._session_key: Optional[str] = None
        self._day_start_balance: float = 0.0
        self._balance_at_entry: Optional[float] = None
        self._state_path = Path(CONFIG["state_file"])
        self._pv = CONFIG["tick_value"] / CONFIG["tick_size"]     # $/point/contract (= 2.0)
        # entry-slippage measurement — single fills are noise, the mean is not
        self._slip_sum = 0.0
        self._slip_abs_sum = 0.0
        self._slip_n = 0
        # scale-in: the resting add order and its deadline
        self._add_oid = None
        self._add_px = 0.0
        self._add_deadline = None
        self._add_lots = 0
        self._first_lots = 0
        # The add is DEFERRED by one bar — see _place_entry for why.
        self._add_pending = None
        # dry-run virtual book
        self._v_pos = 0
        self._v_entry = 0.0
        self._v_sl = 0.0
        self._v_tp = 0.0
        self._v_day_pnl = 0.0
        self._v_qty = 0
        self._v_add_px = 0.0
        self._v_add_left = 0
        self._v_trades = 0
        self._v_wins = 0

    # ---- persistence ----
    def _load_state(self) -> None:
        try:
            if self._state_path.exists():
                s = json.loads(self._state_path.read_text())
                self._session_key = s.get("session_key")
                self._day_start_balance = float(s.get("day_start_balance", 0.0))
                be = s.get("balance_at_entry")
                self._balance_at_entry = float(be) if be is not None else None
        except Exception as exc:
            log.debug("state load failed: %s", exc)

    def _save_state(self) -> None:
        try:
            self._state_path.write_text(json.dumps({
                "session_key": self._session_key,
                "day_start_balance": self._day_start_balance,
                "balance_at_entry": self._balance_at_entry,
            }))
        except Exception as exc:
            log.debug("state save failed: %s", exc)

    def _roll_session_if_needed(self) -> None:
        key = trading_day_key(datetime.now(timezone.utc))
        if key == self._session_key:
            return
        if self._slip_n:
            log.info("📊 previous session entry slippage: signed %+.2ft, |avg| %.2ft "
                     "over %d fills (judge on |avg| — the sign is just drift)",
                     self._slip_sum / self._slip_n,
                     self._slip_abs_sum / self._slip_n, self._slip_n)
        self._session_key = key
        self._day_start_balance = self.api.balance
        self._v_day_pnl = 0.0
        self._slip_sum = self._slip_abs_sum = 0.0
        self._slip_n = 0
        self._save_state()
        log.info("🗓  New trading day %s | start balance = %.2f", key, self._day_start_balance)

    # ---- daily rules ----
    def _day_pnl(self) -> float:
        if CONFIG["dry_run"]:
            return self._v_day_pnl
        return self.api.balance - self._day_start_balance

    def _entry_blocked(self) -> Tuple[bool, str]:
        """Both rules are ENTRY blocks on REALISED day P&L. Neither closes an open
        position — that distinction is the whole reason the profit block costs no
        edge (spec §7). Check order matches challenge.mjs."""
        p = self._day_pnl()
        cap = CONFIG["daily_profit_block"]
        brk = CONFIG["circuit_breaker"]
        if cap > 0 and p >= cap:
            return True, f"daily profit block (realised {p:+.0f} >= {cap:+.0f})"
        if brk > 0 and p <= -brk:
            return True, f"circuit breaker (realised {p:+.0f} <= {-brk:+.0f})"
        return False, ""

    # ---- session helpers ----
    @staticmethod
    def _ct_now() -> int:
        ct = datetime.now(timezone.utc).astimezone(CT_TZ)
        return ct.hour * 60 + ct.minute

    @staticmethod
    def _in_flat_window(ct: int) -> bool:
        f, r = CONFIG["flatten_ct"], CONFIG["reopen_ct"]
        return (f <= ct < r) if r > f else (ct >= f or ct < r)

    def _entry_allowed_now(self, ct: int) -> Tuple[bool, str]:
        if self._in_flat_window(ct):
            return False, "flatten window"
        if self._in_flat_window_from(ct, CONFIG["no_entry_ct"]):
            return False, (f"no new entries within "
                           f"{CONFIG['flatten_ct'] - CONFIG['no_entry_ct']}m of the flatten")
        return True, ""

    @staticmethod
    def _in_flat_window_from(ct: int, cutoff: int) -> bool:
        r = CONFIG["reopen_ct"]
        return (cutoff <= ct < r) if r > cutoff else (ct >= cutoff or ct < r)

    # ---- position sync ----
    async def _sync_position(self) -> None:
        positions = await self.api.get_open_positions()
        open_sz, ptype = 0, 0
        for p in positions:
            if abs(p.get("size", 0)) <= 0:
                continue
            pcid = p.get("contractId")
            if pcid is not None and pcid != CONFIG["contract_id"]:
                continue
            open_sz = p.get("size", 0)
            ptype = p.get("type", 0)
            break
        was_open = self.in_position
        self.in_position = open_sz != 0
        if ptype == 1:
            self._pos_dir = 1
        elif ptype == 2:
            self._pos_dir = -1
        else:
            self._pos_dir = 1 if open_sz > 0 else (-1 if open_sz < 0 else 0)
        if was_open and not self.in_position:
            # FIRST, before anything else: a resting add outlives the position
            # that justified it and would re-enter, unmanaged, on the next touch.
            await self._cancel_add("position closed")
            realised = (self.api.balance - self._balance_at_entry
                        if self._balance_at_entry is not None else None)
            log.info("🔄 closed → flat | realised %s | day P&L %+.0f",
                     ("%+.0f" % realised) if realised is not None else "unknown",
                     self._day_pnl())
            self._balance_at_entry = None
            self._save_state()
            # The platform's hard -$1000 stop can close a position without going
            # through this bot's bracket, which can leave the stop or target leg
            # working. A stray leg would later fill and open a position nothing is
            # managing, so sweep them whenever we transition to flat.
            for o in await self.api.get_open_orders():
                oid = o.get("id", o.get("orderId"))
                if oid is not None:
                    log.warning("🧹 cancelling orphaned order %s left after the close", oid)
                    await self.api.cancel_order(oid)

    # ---- flatten ----
    async def _enforce_flatten(self) -> None:
        """Firm rule: no overnight positions, flat by 3:05 PM CT. This outranks
        the bracket unconditionally — the backtest closes at the flatten bar's
        open regardless of where stop and target sit, and so does this."""
        if CONFIG["dry_run"] or not self._in_flat_window(self._ct_now()):
            return
        await self._cancel_add("flatten window")
        await self._sync_position()
        if self.in_position:
            log.info("🕓 FLATTEN: closing position (firm deadline 15:05 CT, acting at %02d:%02d)",
                     CONFIG["flatten_ct"] // 60, CONFIG["flatten_ct"] % 60)
            await self.api.close_position()
            await self._sync_position()
        if not self.in_position:
            for o in await self.api.get_open_orders():
                oid = o.get("id", o.get("orderId"))
                if oid is not None:
                    await self.api.cancel_order(oid)

    # ---- the resting scale-in order ----
    async def _cancel_add(self, why: str) -> None:
        """Kill the resting add. EVERY path that leaves a position comes here.

        This is the most dangerous piece of the scale-in machinery. A working
        stop order left behind after the position closes will open a fresh,
        unmanaged position the next time price touches it — a position with no
        signal behind it and, worse, one the bot does not know it has. The
        failure is silent, so the cancel is loud when it fails.
        """
        # A DEFERRED add is just as dangerous as a resting one: if the position
        # closes before the next bar, placing it then would open a fresh
        # unmanaged position. Drop it first, and unconditionally.
        if self._add_pending is not None:
            self._add_pending = None
            log.info("✖ deferred add dropped (%s)", why)
        if self._add_oid is None:
            return
        oid, self._add_oid = self._add_oid, None
        self._add_deadline = None
        try:
            ok = await self.api.cancel_order(oid)
            if ok:
                log.info("✖ add order cancelled (%s)", why)
            else:
                log.error("🛑 add order %s did NOT cancel (%s). If it is still working it can "
                          "open an unmanaged position — CHECK THE PLATFORM NOW.", oid, why)
        except Exception as exc:
            log.error("🛑 cancel of add order %s FAILED (%s): %s — CHECK THE PLATFORM NOW.",
                      oid, why, exc)

    async def _service_add(self) -> None:
        """Place a deferred add, expire it once its window passes, notice a fill.

        _evaluate() runs once per completed 2-minute bar, so an add parked here by
        the previous bar's entry goes to the exchange exactly one bar late — which
        is the behaviour that was measured. See _place_entry.
        """
        if self._add_pending is not None and self.in_position:
            a = self._add_pending
            self._add_pending = None
            self._add_oid = await self.api.place_stop_with_bracket(
                a["side"], a["lots"], a["px"], a["sl_ticks"], a["tp_ticks"])
            if self._add_oid is None:
                log.warning("⚠  add order REJECTED — running at %d lots instead of %d",
                            self._first_lots, CONFIG["contracts"])
                return
            self._add_px = a["px"]
            self._add_lots = a["lots"]
            self._add_deadline = a["deadline"]
            return
        if self._add_pending is not None and not self.in_position:
            # Position gone before the add was ever placed. Nothing to cancel,
            # but the parked order must not survive.
            self._add_pending = None
            log.info("✖ deferred add dropped (flat before it was placed)")
            return
        if self._add_oid is None:
            return
        if self._add_deadline and datetime.now(timezone.utc) >= self._add_deadline:
            await self._cancel_add(f"{CONFIG['scale_in_window_bars']}-bar window expired")
            return
        # Has it filled? The position growing past the first tranche is the tell.
        for p in await self.api.get_open_positions():
            pcid = p.get("contractId")
            if pcid is not None and pcid != CONFIG["contract_id"]:
                continue
            # ANY growth beyond the first tranche means it filled — testing for
            # the full configured size would miss a partial fill and leave the
            # bot believing an add is still resting when it is already on.
            if abs(p.get("size", 0)) > (self._first_lots or 0):
                fill = None
                for k in ("averagePrice", "avgPrice", "price"):
                    if p.get(k) is not None:
                        fill = float(p[k]); break
                log.info("✅ ADD FILLED — now %d lots%s", abs(p.get("size", 0)),
                         f", blended fill {fill:.2f}" if fill else "")
                self._add_oid = None
                self._add_deadline = None
            break

    # ---- the bracket the platform will actually allow ----
    def _bracket_points(self, atr_v: float, qty: int = None):
        """Return (stop_points, target_points, capped, cap_points).

        `qty` is the size the bracket will actually be placed on, which is NOT
        always the configured total: under scale-in the first tranche is smaller,
        and the platform cap is a DOLLAR limit, so fewer contracts means the cap
        sits FURTHER away in points. Using the full size here would place a stop
        four times tighter than the position warrants and cut the first tranche
        out of trades the backtest holds.

        The platform liquidates at a fixed DOLLAR loss for the day, so the widest
        stop it will ever honour is (cap + realised day P&L) / ($ per point).
        Placing a bracket at a raw 5xATR beyond that is not a wider stop, it is a
        stop that never fills — the platform gets there first, and any risk figure
        computed from it is fiction. The bot places the NEARER of the two, which
        is also exactly what the backtest models (engine.mjs dayLossStopUsd), so
        live behaviour matches the run that measured this configuration instead of
        depending on the firm's liquidation to save it.
        """
        raw_sl = max(CONFIG["sl_atr_mult"] * atr_v, TICK)
        tp = max(CONFIG["tp_atr_mult"] * atr_v, TICK)
        cap = CONFIG.get("platform_hard_loss_stop", 0.0)
        if cap <= 0:
            return raw_sl, tp, False, float("inf")
        # Room left today: a day already in profit has more, one already down has
        # less. Mirrors the engine's realised-P&L-aware cap.
        room = cap + self._day_pnl()
        lots = qty if qty else CONFIG["contracts"]
        cap_pts = max(TICK, room / (self._pv * lots))
        if raw_sl <= cap_pts:
            return raw_sl, tp, False, cap_pts
        return cap_pts, tp, True, cap_pts

    def _warn_if_capped(self, sl_pts, tp_pts, atr_v, capped) -> None:
        """The cap does not merely cut the loss, it changes the STRATEGY.

        Win rate follows the bracket identity S/(S+T). This book was measured at
        5.0/1.5 = 3.33:1, about 77% on a coin flip. When the cap bites, the ratio
        collapses and the win rate follows it down — at high ATR that lands well
        outside anything that was ever backtested.
        """
        if not capped:
            return
        ratio = sl_pts / max(tp_pts, 1e-9)
        implied = 100.0 * sl_pts / (sl_pts + tp_pts)
        design = CONFIG["sl_atr_mult"] / CONFIG["tp_atr_mult"]
        log.warning("⚠  PLATFORM CAP BINDS: stop cut from %.1fxATR to %.2fxATR (%.1f pts). "
                    "Ratio %.2f:1 against the designed %.2f:1, so the implied coin-flip "
                    "win rate is %.0f%% not %.0f%%.",
                    CONFIG["sl_atr_mult"], sl_pts / max(atr_v, 1e-9), sl_pts,
                    ratio, design, implied, 100.0 * design / (design + 1))
        # Deliberately NOT advising a stand-down. The first version of this said
        # to, and the numbers do not support it: the cap holds risk at a constant
        # $1,000 while the target keeps scaling with ATR, so the gap between the
        # geometric win rate and the break-even win rate is roughly CONSTANT
        # across volatility (-1.9pp at ATR 10, -1.1pp at ATR 30). High ATR is not
        # structurally worse here, and the high-volatility regime is where this
        # book scores best. The warning is information, not a signal to stop.
        if ratio < 2.0:
            log.info("   ↳ risk is now fixed at the cap while reward keeps scaling with ATR, "
                     "so this is expected in a volatile regime and is inside the measured "
                     "numbers. Not a reason to stand down.")

    # ---- entry ----
    async def _place_entry(self, sig: int, atr_v: float, ref_px: float) -> None:
        qty = CONFIG["contracts"]
        first_lots = qty
        if CONFIG.get("scale_in") and qty >= 2:
            first_lots = max(1, min(qty - 1, int(CONFIG["scale_in_first"])))
        # Bracket the FIRST TRANCHE against its own size. Once the add fills the
        # position is larger and the platform's cap moves nearer on its own — the
        # engine models exactly that, as a dynamic stop against current size.
        sl_pts, tp_pts, capped, cap_pts = self._bracket_points(atr_v, first_lots)
        sl_ticks = max(1, round(sl_pts / TICK))
        tp_ticks = max(1, round(tp_pts / TICK))
        side = 0 if sig == 1 else 1
        risk = first_lots * sl_pts * self._pv
        reward = first_lots * tp_pts * self._pv
        sl_px = ref_px - sig * sl_pts
        tp_px = ref_px + sig * tp_pts

        log.info("🚀 ENTRY %-5s x%d | ref %.2f | SL %.2f (%dt, -$%.0f%s)  TP %.2f (%dt, +$%.0f)",
                 "LONG" if sig == 1 else "SHORT", qty, ref_px,
                 sl_px, sl_ticks, risk, " CAPPED" if capped else "",
                 tp_px, tp_ticks, reward)
        self._warn_if_capped(sl_pts, tp_pts, atr_v, capped)
        if risk > CONFIG["circuit_breaker"] * 2:
            log.info("   ↳ this single trade risks $%.0f against a $%.0f breaker — one loss "
                     "ends the day. Intended; priced into the 43.4%%.",
                     risk, CONFIG["circuit_breaker"])
        # The single most consequential number in the whole run, and the one the
        # daily rules CANNOT protect: both are entry blocks, so neither can stop
        # a trade already running from taking out the account.
        dd = CONFIG["trailing_drawdown"]
        if dd > 0:
            log.info("   ↳ stop is %.0f%% of the $%.0f trailing drawdown%s",
                     100.0 * risk / dd, dd,
                     "  ⚠ ONE LOSS EXCEEDS THE DRAWDOWN" if risk >= dd else "")

        self._balance_at_entry = self.api.balance
        self._save_state()

        first = first_lots
        oid = await self.api.place_bracket_order(side, first, sl_ticks, tp_ticks)
        if oid is None:
            log.error("❌ entry failed — staying flat")
            self._balance_at_entry = None
            self._save_state()
            return
        await asyncio.sleep(2)
        await self._sync_position()
        if not self.in_position:
            log.warning("⚠  order placed but no position visible — check the platform")
            return
        await self._log_fill(sig, ref_px, first_lots)

        # ── the resting add ──
        if first >= qty:
            return
        rest = qty - first
        add_px = round((ref_px + sig * max(CONFIG["scale_in_trigger_atr"] * atr_v, TICK)) / TICK) * TICK
        # Bracket ticks are measured from the ADD's own fill, chosen so the levels
        # coincide with the first tranche's rather than being offset from it.
        add_sl_ticks = max(1, round(abs(add_px - sl_px) / TICK))
        add_tp_ticks = max(1, round(abs(tp_px - add_px) / TICK))
        log.info("   ↳ scale-in: %d lots now, %d resting at %.2f (%.2fxATR away). "
                 "Roughly 15%% of trades never reach it — that is the point.",
                 first, rest, add_px, CONFIG["scale_in_trigger_atr"])
        # DEFERRED BY ONE BAR, deliberately. A 2-minute bar's range is roughly one
        # ATR, so a 0.15xATR trigger is touched somewhere inside the ENTRY bar for
        # ~81% of signals — almost mechanically, and with no information in it.
        # Resting the order immediately therefore adds to nearly everything,
        # including the breakouts that spiked and died, which is the exact
        # population scale-in exists to stay small in. Measured, that is the whole
        # of the edge: add from the entry bar and the book scores 31.8% with pf
        # 1.116, WORSE than not scaling in at all; add one bar later and it is
        # 46.5% with pf 1.338. Longer delays decay smoothly from there (43.9% at
        # +2 bars, 38.2% at +5) because they start costing size on the winners.
        # research/samebar_add.mjs holds the measurement.
        self._first_lots = first
        self._add_pending = {
            "side": side, "lots": rest, "px": add_px,
            "sl_ticks": add_sl_ticks, "tp_ticks": add_tp_ticks,
            "deadline": datetime.now(timezone.utc) + timedelta(
                minutes=CONFIG["scale_in_window_bars"] * CONFIG["timeframe_min"]),
        }

    async def _log_fill(self, sig: int, ref_px: float, lots: int = None) -> None:
        """Deviation of the actual fill from the SIGNAL BAR'S CLOSE.

        That reference is deliberate. The backtest fills at the next bar's open,
        which has not been published yet at the moment the order goes out, so it
        cannot be compared against directly. Measuring from the close captures
        the close-to-open gap AND the true slippage together — which is the whole
        cost of acting on the signal, and the number the 41.0%-at-one-tick column
        should be judged against.

        Judge on |avg|: the sign is only which way price drifted in the seconds
        to order arrival, so signed fills cancel out and flatter you."""
        fill = None
        for p in await self.api.get_open_positions():
            pcid = p.get("contractId")
            if pcid is not None and pcid != CONFIG["contract_id"]:
                continue
            for k in ("averagePrice", "avgPrice", "price"):
                if p.get(k) is not None:
                    fill = float(p[k])
                    break
            break
        if fill is None:
            return
        dev_ticks = (fill - ref_px) * sig / TICK          # + = paid up, adverse
        self._slip_sum += dev_ticks
        self._slip_abs_sum += abs(dev_ticks)
        self._slip_n += 1
        log.info("📐 FILL %.2f vs ref %.2f | %+.1ft ($%+.0f) | session |avg| %.2ft over %d",
                 fill, ref_px, dev_ticks,
                 -dev_ticks * CONFIG["tick_value"] * (lots or CONFIG["contracts"]),
                 self._slip_abs_sum / self._slip_n, self._slip_n)
        if self._slip_n >= 5 and self._slip_abs_sum / self._slip_n > CONFIG["slip_warn_ticks"]:
            log.warning("⚠  |avg| slippage %.2ft exceeds %.1ft. The headline assumed ZERO and "
                        "was still only 41.0%% at ONE tick — measure before trusting it.",
                        self._slip_abs_sum / self._slip_n, CONFIG["slip_warn_ticks"])

    # ---- dry-run virtual book ----
    def _dry_step(self, bar: Bar2m, sig: int, atr_v: float) -> None:
        # 0) the resting add fills once price has moved far enough the right way.
        #    Modelled here too, or the paper book would trade a different size
        #    from the live one and the dry run would not mean anything.
        if self._v_pos != 0 and self._v_add_left > 0:
            reached = (bar.high >= self._v_add_px if self._v_pos == 1
                       else bar.low <= self._v_add_px)
            if reached:
                q, add = self._v_qty, self._v_add_left
                self._v_entry = (self._v_entry * q + self._v_add_px * add) / (q + add)
                self._v_qty += add
                self._v_add_left = 0
                log.info("✅ DRY ADD filled %d @ %.2f — now %d lots, avg %.2f",
                         add, self._v_add_px, self._v_qty, self._v_entry)

        # 1) resolve an open virtual position on this bar, stop BEFORE target and
        #    gap-throughs filled at the open — matching src/engine.mjs ordering.
        if self._v_pos != 0:
            o, h, l = bar.open, bar.high, bar.low
            px = reason = None
            if self._v_pos == 1:
                if o <= self._v_sl:
                    px, reason = o, "SL(gap)"
                elif l <= self._v_sl:
                    px, reason = self._v_sl, "SL"
                elif h >= self._v_tp:
                    px, reason = self._v_tp, "TP"
            else:
                if o >= self._v_sl:
                    px, reason = o, "SL(gap)"
                elif h >= self._v_sl:
                    px, reason = self._v_sl, "SL"
                elif l <= self._v_tp:
                    px, reason = self._v_tp, "TP"
            if px is not None:
                self._dry_exit(px, reason)
        # 2) flatten outranks the bracket
        if self._v_pos != 0 and self._in_flat_window(bar.ct_min):
            self._dry_exit(bar.open, "FLAT")

        blocked, why = self._entry_blocked()
        log.info("%s", DIV)
        log.info("[2m %s CT] O=%.2f H=%.2f L=%.2f C=%.2f | ATR=%.2f | sig=%+d | %s | dayP&L=%+.0f",
                 f"{bar.ct_min // 60:02d}:{bar.ct_min % 60:02d}",
                 bar.open, bar.high, bar.low, bar.close, atr_v, sig,
                 ("VPOS " + ("▲" if self._v_pos == 1 else "▼")) if self._v_pos else "flat",
                 self._v_day_pnl)

        # 3) flip
        if self._v_pos != 0 and CONFIG["flip_on_opposite"] and sig != 0 and sig != self._v_pos:
            self._dry_exit(bar.close, "FLIP")
        if self._v_pos != 0 or sig == 0 or atr_v <= 0:
            return
        ok, gate = self._entry_allowed_now(bar.ct_min)
        if not ok:
            log.info("⏸  DRY entry suppressed: %s", gate)
            return
        if blocked:
            log.info("⏸  DRY entry suppressed: %s", why)
            return
        # The live bot fills at the NEXT bar's open; the virtual book has no next
        # bar yet, so it uses this close as the reference. That is a ~1 bar
        # optimism in the dry run ONLY — the real fill is measured by _log_fill.
        # The paper book must respect the platform cap too, or its P&L is fiction:
        # it would print losses of $2,400 that the platform would never allow.
        total0 = CONFIG["contracts"]
        first0 = (max(1, min(total0 - 1, int(CONFIG["scale_in_first"])))
                  if CONFIG.get("scale_in") and total0 >= 2 else total0)
        sl_pts, tp_pts, capped, _ = self._bracket_points(atr_v, first0)
        self._v_pos, self._v_entry = sig, bar.close
        self._v_sl = bar.close - sig * sl_pts
        self._v_tp = bar.close + sig * tp_pts
        total = CONFIG["contracts"]
        if CONFIG.get("scale_in") and total >= 2:
            self._v_qty = max(1, min(total - 1, int(CONFIG["scale_in_first"])))
            self._v_add_left = total - self._v_qty
            self._v_add_px = bar.close + sig * max(
                CONFIG["scale_in_trigger_atr"] * atr_v, TICK)
        else:
            self._v_qty, self._v_add_left = total, 0
        log.info("🧪 DRY ENTRY %-5s x%d%s @ %.2f | SL %.2f  TP %.2f | risk $%.0f%s / reward $%.0f",
                 "LONG" if sig == 1 else "SHORT", self._v_qty,
                 f" (+{self._v_add_left} @ {self._v_add_px:.2f})" if self._v_add_left else "",
                 bar.close, self._v_sl, self._v_tp,
                 self._v_qty * sl_pts * self._pv,
                 " CAPPED" if capped else "",
                 self._v_qty * tp_pts * self._pv)
        self._warn_if_capped(sl_pts, tp_pts, atr_v, capped)

    def _dry_exit(self, px: float, reason: str) -> None:
        q = self._v_qty or CONFIG["contracts"]
        fees = 2 * CONFIG["commission_per_side"] * q
        pnl = (px - self._v_entry) * self._v_pos * self._pv * q - fees
        self._v_day_pnl += pnl
        self._v_trades += 1
        if pnl > 0:
            self._v_wins += 1
        log.info("🧪 DRY EXIT  %-5s @ %.2f (%s) | %+.0f | day %+.0f | %d trades, %.0f%% win",
                 "LONG" if self._v_pos == 1 else "SHORT", px, reason, pnl, self._v_day_pnl,
                 self._v_trades, 100.0 * self._v_wins / max(1, self._v_trades))
        self._v_pos = 0
        self._v_qty = 0
        self._v_add_left = 0

    # ---- main cycle ----
    async def _evaluate(self) -> bool:
        """One decision at a 2-minute boundary. Returns False if no new completed
        bar was available, so the caller retries.

        CAUSALITY: the signal is read from the bar that JUST CLOSED and filled at
        the open of the bar now beginning — which is right now. Nothing here ever
        looks at a price that had not printed when the decision was made.
        """
        raw = await self.api.get_bars_1m(days=CONFIG["fetch_days"])
        bars = aggregate_2m(raw)
        need = max(CONFIG["warmup_bars_2m"], CONFIG["period"] + CONFIG["eff_period"] + 5)
        if len(bars) < need:
            log.info("warming up (%d/%d 2-min bars)", len(bars), need)
            return False
        bars = bars[-CONFIG["warmup_bars_2m"]:]

        last = bars[-1]
        if last.ts == self._last_bar_ts:
            return False                       # no new completed bar yet — retry
        now = datetime.now(timezone.utc)
        age_s = now.timestamp() - (last.ts + BUCKET_MS) / 1000.0
        if age_s > CONFIG["max_bar_age_s"]:
            log.error("🛑 STALE FEED: newest completed bar closed %.0fs ago (> %ds). "
                      "Not trading on this.", age_s, CONFIG["max_bar_age_s"])
            return False
        self._last_bar_ts = last.ts

        sig, atr_arr = compute_signals(bars, CONFIG)
        s = sig[-1]
        atr_v = atr_arr[-1]

        if s != 0 and age_s > CONFIG["max_entry_delay_s"]:
            log.warning("⏱  STALE SIGNAL: bar closed %.0fs ago (> %ds) — entry skipped",
                        age_s, CONFIG["max_entry_delay_s"])
            s = 0

        await self.api.refresh_balance()
        self._roll_session_if_needed()

        if CONFIG["dry_run"]:
            self._dry_step(last, s, atr_v)
            return True

        await self._enforce_flatten()
        await self._sync_position()
        await self._service_add()

        blocked, why = self._entry_blocked()
        log.info("%s", DIV)
        log.info("[2m %02d:%02d CT] O=%.2f H=%.2f L=%.2f C=%.2f V=%.0f | ATR=%.2f | sig=%+d "
                 "| %s | dayP&L=%+.0f bal=%.2f",
                 last.ct_min // 60, last.ct_min % 60,
                 last.open, last.high, last.low, last.close, last.volume, atr_v, s,
                 ("IN POS " + ("▲" if self._pos_dir == 1 else "▼")) if self.in_position else "flat",
                 self._day_pnl(), self.api.balance)

        # ── flip: an opposite signal reverses the position ──
        if self.in_position:
            # Inside the flatten window there is nothing to reverse INTO, and
            # _enforce_flatten above has already tried to close. Reaching here
            # means that close failed, so retry it as a close rather than
            # logging a reversal that can never open its second leg.
            if self._in_flat_window(self._ct_now()):
                log.warning("⚠  still in position inside the flatten window — closing")
                await self.api.close_position()
                await self._sync_position()
                return True
            if not (CONFIG["flip_on_opposite"] and s != 0 and s != self._pos_dir):
                return True
            await self._cancel_add("flip")
            log.info("🔃 FLIP: %s signal against a %s position — closing to reverse",
                     "LONG" if s == 1 else "SHORT", "LONG" if self._pos_dir == 1 else "SHORT")
            await self.api.close_position()
            for o in await self.api.get_open_orders():
                oid = o.get("id", o.get("orderId"))
                if oid is not None:
                    await self.api.cancel_order(oid)
            await asyncio.sleep(2)
            await self.api.refresh_balance()
            await self._sync_position()
            if self.in_position:
                log.warning("⚠  flip close did not complete — no reversal this bar")
                return True
            # Re-test the daily rules AFTER settling: the backtest evaluates the
            # reversal with the closed trade's P&L already in the day, so a flip
            # that crosses +$1,000 must not open the other side.
            blocked, why = self._entry_blocked()

        if s == 0 or atr_v <= 0 or not math.isfinite(atr_v):
            return True
        ok, gate = self._entry_allowed_now(self._ct_now())
        if not ok:
            log.info("⏸  entry suppressed: %s", gate)
            return True
        if blocked:
            log.info("⏸  entry suppressed: %s", why)
            return True
        await self._place_entry(s, atr_v, last.close)
        return True

    # ---- loop ----
    @staticmethod
    def _secs_to_next_bar() -> float:
        """Wake ~2s after each 2-minute boundary. Buckets are clock-aligned on
        the epoch, so a boundary is any even minute with zero seconds."""
        now = datetime.now(timezone.utc)
        into = (now.minute % CONFIG["timeframe_min"]) * 60 + now.second + now.microsecond / 1e6
        return max(CONFIG["timeframe_min"] * 60 - into + 2.0, 1.0)

    async def _sleep_to_next_bar(self) -> None:
        """Sleep to the next bar, but wake early enough to hit the flatten
        deadline. A 2-minute cadence would otherwise let a position live up to
        two minutes past 15:05, which is the one rule that must never slip."""
        deadline = datetime.now(timezone.utc) + timedelta(seconds=self._secs_to_next_bar())
        while True:
            remaining = (deadline - datetime.now(timezone.utc)).total_seconds()
            if remaining <= 0:
                return
            near_flatten = (not CONFIG["dry_run"] and self.in_position and
                            CONFIG["no_entry_ct"] <= self._ct_now() < CONFIG["reopen_ct"])
            if not near_flatten:
                await asyncio.sleep(remaining)
                return
            await asyncio.sleep(min(CONFIG["flatten_poll_s"], remaining))
            try:
                await self._enforce_flatten()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.exception("flatten check error: %s", exc)

    async def _seed(self) -> None:
        await self.api.refresh_balance()
        self._load_state()
        self._roll_session_if_needed()
        if not CONFIG["dry_run"]:
            await self._sync_position()
        log.info("Seeded | bal=%.2f  in_position=%s  session=%s  dayP&L=%+.0f",
                 self.api.balance, self.in_position, self._session_key, self._day_pnl())

    @staticmethod
    def _startup_checks() -> None:
        if not CONFIG["platform_hard_profit_stop_disabled"]:
            log.warning("⚠  PLATFORM HARD PROFIT STOP — is it OFF?")
            log.warning("   The recommended configuration replaces a $1,500 unrealised stop "
                        "with the +$1,000 REALISED entry block this bot enforces itself. "
                        "Measured at one tick: hard-cap ON = 42.3%% pass but pf 0.964 and "
                        "-$52,778; hard-cap OFF = 41.0%% pass, pf 1.047 and +$91,640.")
            log.warning("   Turn it off in the platform, then set "
                        "platform_hard_profit_stop_disabled=True to silence this.")
        if CONFIG["daily_profit_block"] <= 0:
            log.warning("⚠  daily_profit_block is OFF. It is one of the largest levers in this "
                        "configuration; with the -$1000 platform stop in force the "
                        "measured optimum is $750.")
        risk_hint = CONFIG["contracts"] * CONFIG["sl_atr_mult"]
        log.info("Risk: %d lots x %.1fxATR stop = %.0f x ATR points of exposure "
                 "($%.0f per ATR point). One loss trips the $%.0f breaker.",
                 CONFIG["contracts"], CONFIG["sl_atr_mult"], risk_hint,
                 risk_hint * CONFIG["tick_value"] / CONFIG["tick_size"],
                 CONFIG["circuit_breaker"])

    async def run(self) -> None:
        log.info("=" * 60)
        log.info("MNQ DONCHIAN + EFFICIENCY-GATE BOT | contract=%s live=%s dry=%s",
                 CONFIG["contract_id"], CONFIG["live_account"], CONFIG["dry_run"])
        log.info("signal: Donchian-%d break (excl. current bar), ADX(%d)>=%d, "
                 "efficiency(%d)>%.2f, %d-min bars",
                 CONFIG["period"], CONFIG["adx_period"], CONFIG["adx_min"],
                 CONFIG["eff_period"], CONFIG["eff_min"], CONFIG["timeframe_min"])
        log.info("session CT: signals %02d:%02d-%02d:%02d | last entry %02d:%02d | flatten %02d:%02d",
                 CONFIG["signal_start_ct"] // 60, CONFIG["signal_start_ct"] % 60,
                 CONFIG["signal_end_ct"] // 60, CONFIG["signal_end_ct"] % 60,
                 CONFIG["no_entry_ct"] // 60, CONFIG["no_entry_ct"] % 60,
                 CONFIG["flatten_ct"] // 60, CONFIG["flatten_ct"] % 60)
        log.info("exec: %d contracts, SL %.1fxATR / TP %.1fxATR, flips %s",
                 CONFIG["contracts"], CONFIG["sl_atr_mult"], CONFIG["tp_atr_mult"],
                 "ON" if CONFIG["flip_on_opposite"] else "OFF")
        log.info("daily (ENTRY BLOCKS on realised P&L, never closes): profit +%.0f / breaker -%.0f "
                 "| reset %02d:00 ET", CONFIG["daily_profit_block"], CONFIG["circuit_breaker"],
                 CONFIG["reset_hour_et"])
        self._startup_checks()
        log.info("=" * 60)
        await self._seed()

        first = True
        while True:
            if not first:
                await self._sleep_to_next_bar()
            first = False
            try:
                await self._enforce_flatten()
            except Exception as exc:
                log.exception("flatten check error: %s", exc)
            # Retry until the just-closed bar is available (the feed can lag a
            # few seconds after the boundary).
            for _ in range(15):
                try:
                    if await self._evaluate():
                        break
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    log.exception("evaluate error: %s", exc)
                await asyncio.sleep(2)


# ─────────────────────────────────────────────────────────────
#  MAIN (reconnect loop)
# ─────────────────────────────────────────────────────────────
async def main() -> None:
    if not os.environ.get("PROJECT_X_API_KEY") or not os.environ.get("PROJECT_X_USERNAME"):
        raise EnvironmentError("Set PROJECT_X_API_KEY and PROJECT_X_USERNAME")
    attempt = 0
    while True:
        attempt += 1
        if attempt > 1:
            log.info("🔄 reconnect #%d in 30s ...", attempt)
            await asyncio.sleep(30)
        api = TopstepXClient()
        bot = DonchianBot(api)
        try:
            await api.connect()
            await bot.run()
            break
        except asyncio.CancelledError:
            log.info("Cancelled.")
            raise
        except Exception as exc:
            log.exception("fatal: %s", exc)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Stopped by user.")
