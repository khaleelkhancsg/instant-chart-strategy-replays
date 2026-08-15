#!/usr/bin/env python3
"""
Parity harness for mnq_donchian_bot.py.

The bot reimplements, in Python, a pipeline whose measured 42.6% pass rate was
produced by JavaScript. "It looks the same" is not evidence. This asserts the
Python reproduces the JS output STAGE BY STAGE against a golden fixture, so a
mismatch names the stage that broke instead of just "the trades differ".

    node research/export_bot_fixture.mjs      # regenerate the fixture
    python bot/test_donchian_parity.py        # verify

Stages checked:
    1  clock-aligned 2-minute aggregation (incl. CT minute + trading day)
    2  ATR / ADX / efficiency ratio / Donchian
    3  raw signals
    4  gated signals (session + efficiency)
    5  full trade replay: bracket, flatten priority, flips, no same-bar re-entry
    6  warm-up sufficiency at the bot's live retention
    7  daily entry-block semantics
    8  self-checks on the session/day-boundary helpers

Zero dependencies beyond the bot module itself.
"""

import json
import math
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# The bot creates a log file on import; keep test runs out of the live log dir.
os.environ.setdefault("MNQ_LOG_DIR", str(HERE / "logs_test"))

import mnq_donchian_bot as bot  # noqa: E402

# Keep the harness from writing a state file next to the real one — a test run
# must never be able to hand the live bot a bogus day-start balance.
bot.CONFIG["state_file"] = str(HERE / "logs_test" / "test_state.json")
(HERE / "logs_test").mkdir(exist_ok=True)

FIXTURE = HERE / "fixture_donchian.json"

PASS = FAIL = 0
FAILURES = []


def check(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        FAILURES.append(f"{name}: {detail}")
        print(f"  FAIL  {name}   {detail}")


def close_enough(a, b, tol):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if isinstance(a, float) and math.isnan(a):
        return b is None or (isinstance(b, float) and math.isnan(b))
    return abs(a - b) <= tol


def max_dev(mine, theirs):
    """Largest absolute deviation, ignoring positions the fixture stores as null
    (JS NaN). A NaN on one side and a number on the other is reported as inf."""
    worst = 0.0
    for m, t in zip(mine, theirs):
        m_nan = m is None or (isinstance(m, float) and math.isnan(m))
        t_nan = t is None
        if m_nan and t_nan:
            continue
        if m_nan != t_nan:
            return math.inf
        worst = max(worst, abs(m - t))
    return worst


# ═══════════════════════════════════════════════════════════════
def main():
    if not FIXTURE.exists():
        print(f"Fixture missing: {FIXTURE}\nRun:  node research/export_bot_fixture.mjs")
        return 2

    fx = json.loads(FIXTURE.read_text())
    exec_cfg = fx["exec"]
    filt = fx["filter"]
    params = fx["params"]

    print(f"\nFixture: {len(fx['bars1m']):,} 1-min bars -> {len(fx['bars2m']):,} 2-min bars, "
          f"{len(fx['trades'])} trades")
    print(f"Generated {fx['generated']}\n")

    # Config the bot's pure functions run under, taken FROM THE FIXTURE so the
    # test cannot pass by both sides sharing a wrong constant.
    cfg = {
        "timeframe_min": fx["timeframeMin"],
        "period": params["period"],
        "adx_min": params["adxMin"],
        "adx_period": params["adxPeriod"],
        "atr_period": params["atrPeriod"],
        "cooldown_bars": params["cooldownBars"],
        "eff_period": 20,
        "eff_min": filt["effMin"],
        "signal_start_ct": filt["startCt"],
        "signal_end_ct": filt["endCt"],
    }

    # ── 1. aggregation ────────────────────────────────────────
    print("1. clock-aligned 2-minute aggregation")
    raw1m = [{"ms": r[0], "o": r[1], "h": r[2], "l": r[3], "c": r[4]} for r in fx["bars1m"]]
    # `now` far in the future so no bucket is trimmed as incomplete; bucket
    # trimming is exercised separately below.
    future = datetime.fromtimestamp(fx["bars1m"][-1][0] / 1000 + 86400, timezone.utc)
    bars = bot.aggregate_2m(raw1m, now_utc=future)

    check("bar count", len(bars) == len(fx["bars2m"]),
          f"{len(bars)} vs {len(fx['bars2m'])}")
    n = min(len(bars), len(fx["bars2m"]))
    bad_ts = bad_ohlc = bad_ct = bad_day = 0
    for i in range(n):
        ts, o, h, l, c, ct, td = fx["bars2m"][i]
        b = bars[i]
        if b.ts != ts:
            bad_ts += 1
        if not (close_enough(b.open, o, 1e-4) and close_enough(b.high, h, 1e-4)
                and close_enough(b.low, l, 1e-4) and close_enough(b.close, c, 1e-4)):
            bad_ohlc += 1
        if b.ct_min != ct:
            bad_ct += 1
        if b.tday != td:
            bad_day += 1
    check("bucket timestamps", bad_ts == 0, f"{bad_ts} differ")
    check("bucket OHLC", bad_ohlc == 0, f"{bad_ohlc} differ")
    check("CT minute of bar open", bad_ct == 0, f"{bad_ct} differ")
    check("trading day (17:00 ET roll)", bad_day == 0, f"{bad_day} differ")

    # Every bucket must sit on an even minute of the hour — the property that
    # makes local aggregation equivalent to the exchange's, if its grid matches.
    check("buckets are clock-aligned",
          all(b.ts % (fx["timeframeMin"] * 60000) == 0 for b in bars), "")

    # Incomplete-bucket trimming: judged on TIME, never on bar count, because a
    # bucket can legitimately hold one 1-minute bar when the other minute is quiet.
    last_ts = fx["bars2m"][-1][0]
    mid = datetime.fromtimestamp((last_ts + 60_000) / 1000, timezone.utc)
    trimmed = bot.aggregate_2m(raw1m, now_utc=mid)
    check("drops the in-progress bucket", len(trimmed) == len(bars) - 1,
          f"{len(trimmed)} vs {len(bars) - 1}")
    just_after = datetime.fromtimestamp((last_ts + 120_000) / 1000, timezone.utc)
    check("keeps a bucket the moment it completes",
          len(bot.aggregate_2m(raw1m, now_utc=just_after)) == len(bars), "")

    # ── 2. indicators ─────────────────────────────────────────
    print("\n2. indicators")
    H = [b.high for b in bars]
    L = [b.low for b in bars]
    C = [b.close for b in bars]
    my_atr = bot.atr_series(H, L, C, cfg["atr_period"])
    my_adx = bot.adx_series(H, L, C, cfg["adx_period"])
    my_eff = bot.efficiency_ratio(C, cfg["eff_period"])
    my_dh, my_dl = bot.donchian(H, L, cfg["period"])

    # Fixture values are rounded to 6dp, and the bars themselves come from
    # float32 storage on the JS side, so 1e-5 on a ~20000-point instrument is
    # ~5e-10 relative — far tighter than a quarter-point tick.
    for label, mine, key, tol in (
        ("ATR(14), EMA not Wilder", my_atr, "atr", 1e-4),
        ("ADX(14), EMA at every stage", my_adx, "adx", 1e-4),
        ("Kaufman efficiency(20)", my_eff, "eff", 1e-5),
        ("Donchian high (excl. current bar)", my_dh, "donHigh", 1e-4),
        ("Donchian low (excl. current bar)", my_dl, "donLow", 1e-4),
    ):
        d = max_dev(mine, fx["indicators"][key])
        check(label, d <= tol, f"max deviation {d:.3e} > {tol:.0e}")

    # Donchian must genuinely exclude the current bar, or a breakout compares a
    # bar against itself and can never trigger.
    excl_ok = True
    for i in range(cfg["period"], min(len(bars), 400)):
        if abs(my_dh[i] - max(H[i - cfg["period"]:i])) > 1e-6:
            excl_ok = False
            break
    check("Donchian window is [i-p, i-1]", excl_ok, "")

    # ── 3 & 4. signals ────────────────────────────────────────
    # Both stages call the BOT's functions. An earlier version of this harness
    # recomputed the raw signal inline, which meant stage 3 tested the test:
    # mutating the bot's ADX floor from 25 to 20 left it green.
    print("\n3. raw signals (Donchian break + ADX floor)")
    raw_sig, my_atr2 = bot.raw_signals(bars, cfg)
    diff_raw = sum(1 for a, b in zip(raw_sig, fx["sigRaw"]) if a != b)
    check("raw signals", diff_raw == 0, f"{diff_raw} of {len(raw_sig)} differ")
    check("ATR returned alongside the signal",
          max_dev(my_atr2, fx["indicators"]["atr"]) <= 1e-4, "")

    # The ADX floor must actually bind on the raw signal, or nothing downstream
    # can detect it drifting.
    loosened = bot.raw_signals(bars, dict(cfg, adx_min=0))[0]
    n_adx_cut = sum(1 for a, b in zip(raw_sig, loosened) if a != b)
    check("the ADX floor removes signals", n_adx_cut > 0,
          "ADX >= %d cut nothing — it cannot be verified here" % cfg["adx_min"])

    print("\n4. session + efficiency gate")
    my_sig = bot.apply_gate(raw_sig, bars, cfg)
    diff_mask = sum(1 for a, b in zip(my_sig, fx["sigMasked"]) if a != b)
    check("gated signals", diff_mask == 0, f"{diff_mask} of {len(my_sig)} differ")
    check("compute_signals composes the two stages",
          bot.compute_signals(bars, cfg)[0] == my_sig, "")

    n_raw = sum(1 for s in fx["sigRaw"] if s)
    n_gate = sum(1 for s in fx["sigMasked"] if s)
    check("the gate is the point (keeps well under a third of signals)",
          n_gate < n_raw * 0.33, f"{n_gate}/{n_raw} kept")

    # A NaN efficiency reading must FAIL an active band rather than sail through.
    # With the shipped params NaN can never coincide with a signal (eff needs 20
    # bars, Donchian needs 30), so force the overlap with a longer eff period —
    # otherwise this branch is untested and a sign flip in it goes unnoticed.
    nan_cfg = dict(cfg, eff_period=len(bars))       # eff is NaN everywhere
    nan_gated = bot.apply_gate(raw_sig, bars, nan_cfg)
    check("NaN efficiency fails the gate", not any(nan_gated),
          f"{sum(1 for s in nan_gated if s)} signals survived an all-NaN reading")
    check("...and it is the NaN doing it, not the window",
          any(bot.apply_gate(raw_sig, bars, dict(nan_cfg, eff_min=0))), "")

    # ── 5. trade replay ───────────────────────────────────────
    print("\n5. execution replay (bracket, flatten, flips)")
    trades = replay(bars, my_sig, my_atr2, exec_cfg)
    exp = fx["trades"]
    check("trade count", len(trades) == len(exp), f"{len(trades)} vs {len(exp)}")

    m = min(len(trades), len(exp))
    fields = {"entryTime": 0, "exitTime": 0, "dir": 0, "contracts": 0,
              "entryPrice": 1e-4, "exitPrice": 1e-4, "stop": 1e-4, "target": 1e-4,
              "pnl": 1e-2, "gross": 1e-2, "fees": 1e-6, "reason": 0}
    for f, tol in fields.items():
        bad = 0
        for i in range(m):
            a, b = trades[i][f], exp[i][f]
            if isinstance(a, str) or isinstance(b, str):
                if a != b:
                    bad += 1
            elif not close_enough(a, b, tol):
                bad += 1
        check(f"trade.{f}", bad == 0, f"{bad} of {m} differ")

    if m:
        net_mine = sum(t["pnl"] for t in trades)
        net_theirs = sum(t["pnl"] for t in exp)
        check("net P&L", abs(net_mine - net_theirs) < 0.5,
              f"${net_mine:,.2f} vs ${net_theirs:,.2f}")
        print(f"        ({len(exp)} trades, net ${net_theirs:,.2f}, "
              f"{sum(1 for t in exp if t['pnl'] > 0) / max(1, len(exp)) * 100:.1f}% win)")

    # Structural properties the replay must exhibit, independent of the fixture.
    check("no position survives the flatten deadline",
          all(bar_ct(bars, t["exitIdx"]) < exec_cfg["flattenCt"] or
              t["reason"] in ("FLAT", "EOD") for t in trades), "")
    cutoff = exec_cfg["flattenCt"] - exec_cfg["noEntryMinsBeforeFlat"]
    check(f"no entry at/after {cutoff // 60:02d}:{cutoff % 60:02d} CT",
          all(bar_ct(bars, t["entryIdx"]) < cutoff for t in trades), "")
    check("no entry outside the RTH signal window",
          all(filt["startCt"] <= bar_ct(bars, t["entryIdx"] - 1) < filt["endCt"]
              for t in trades if t["entryIdx"] > 0), "")
    check("no same-bar re-entry",
          all(trades[i]["entryIdx"] > trades[i - 1]["exitIdx"] or
              trades[i]["entryIdx"] == trades[i - 1]["exitIdx"] and
              trades[i - 1]["reason"] == "FLIP"
              for i in range(1, len(trades))), "")
    check("every trade is intraday",
          all(t["tday"] == bars[t["entryIdx"]].tday for t in trades), "")

    # ── 6. warm-up ────────────────────────────────────────────
    print("\n6. warm-up sufficiency at the bot's live retention")
    keep = bot.CONFIG["warmup_bars_2m"]
    if len(bars) > keep + 50:
        tail = bars[-keep:]
        tH = [b.high for b in tail]
        tL = [b.low for b in tail]
        tC = [b.close for b in tail]
        t_atr = bot.atr_series(tH, tL, tC, cfg["atr_period"])
        t_adx = bot.adx_series(tH, tL, tC, cfg["adx_period"])
        d_atr = max(abs(t_atr[-i] - my_atr[-i]) for i in range(1, 201))
        d_adx = max(abs(t_adx[-i] - my_adx[-i]) for i in range(1, 201))
        # A quarter point is one tick; the EMAs must converge far inside that or
        # the live bracket would sit at a different price than the backtest's.
        check(f"ATR converges within {keep} bars", d_atr < 0.01,
              f"max deviation {d_atr:.2e} points over the last 200 bars")
        check(f"ADX converges within {keep} bars", d_adx < 0.05,
              f"max deviation {d_adx:.2e} over the last 200 bars")
        t_sig, _ = bot.compute_signals(tail, cfg)
        diff = sum(1 for i in range(1, 201) if t_sig[-i] != my_sig[-i])
        check("identical signals from the truncated history", diff == 0,
              f"{diff} of the last 200 bars differ")
    else:
        check("warm-up test has enough bars", False, "fixture too short")

    # ── 7. daily entry blocks ─────────────────────────────────
    print("\n7. daily rule semantics")
    b = bot.DonchianBot.__new__(bot.DonchianBot)
    b._v_day_pnl = 0.0
    saved_dry = bot.CONFIG["dry_run"]
    bot.CONFIG["dry_run"] = True
    try:
        cap = bot.CONFIG["daily_profit_block"]
        brk = bot.CONFIG["circuit_breaker"]
        b._v_day_pnl = 0.0
        check("flat day is not blocked", b._entry_blocked()[0] is False, "")
        b._v_day_pnl = cap - 1
        check("just under the profit block trades", b._entry_blocked()[0] is False, "")
        b._v_day_pnl = cap
        blocked, why = b._entry_blocked()
        check("at the profit block, entries stop", blocked and "profit" in why, why)
        b._v_day_pnl = -brk + 1
        check("just above the breaker trades", b._entry_blocked()[0] is False, "")
        b._v_day_pnl = -brk
        blocked, why = b._entry_blocked()
        check("at the breaker, entries stop", blocked and "breaker" in why, why)
        # The distinction the whole configuration rests on: these rules block new
        # ENTRIES and must never close a position. A soft block costs no edge
        # precisely because a trade already running is untouched (spec §7).
        check("_entry_blocked cannot close a position",
              "close_position" not in bot.DonchianBot._entry_blocked.__code__.co_names, "")
        check("the flatten is the only close path outside the bracket",
              {"close_position"} >= {c for c in bot.DonchianBot._evaluate.__code__.co_names
                                     if c == "close_position"}, "")
    finally:
        bot.CONFIG["dry_run"] = saved_dry

    # ── 8. session helpers ────────────────────────────────────
    print("\n8. session + day-boundary helpers")
    f_ct = bot.CONFIG["flatten_ct"]
    check("flatten window starts at the flatten minute",
          bot.DonchianBot._in_flat_window(f_ct) and
          not bot.DonchianBot._in_flat_window(f_ct - 1), "")
    check("flatten window ends at the reopen",
          not bot.DonchianBot._in_flat_window(bot.CONFIG["reopen_ct"]), "")
    check("flatten acts inside the firm 15:05 CT deadline",
          bot.CONFIG["flatten_ct"] <= 15 * 60 + 5,
          f"flatten_ct={bot.CONFIG['flatten_ct']}")
    check("no-entry cutoff precedes the flatten",
          bot.CONFIG["no_entry_ct"] < bot.CONFIG["flatten_ct"], "")
    check("signal window ends before the no-entry cutoff leaves no room",
          bot.CONFIG["signal_end_ct"] >= bot.CONFIG["no_entry_ct"], "")

    # 17:00 ET is the boundary; 16:59 ET belongs to the day it is in.
    d_before = bot.trading_day_of(datetime(2026, 7, 8, 20, 59, tzinfo=timezone.utc))  # 16:59 ET
    d_after = bot.trading_day_of(datetime(2026, 7, 8, 21, 1, tzinfo=timezone.utc))    # 17:01 ET
    check("trading day rolls at 17:00 ET", d_after == d_before + 1,
          f"{d_before} -> {d_after}")
    check("an RTH session shares one trading day",
          bot.trading_day_of(datetime(2026, 7, 8, 13, 30, tzinfo=timezone.utc)) ==
          bot.trading_day_of(datetime(2026, 7, 8, 20, 0, tzinfo=timezone.utc)), "")

    # DST: the CT session must stay at 08:30 CT in both halves of the year.
    jan = datetime(2026, 1, 15, 14, 30, tzinfo=timezone.utc)   # 08:30 CST
    jul = datetime(2026, 7, 15, 13, 30, tzinfo=timezone.utc)   # 08:30 CDT
    ct = lambda d: (d.astimezone(bot.CT_TZ).hour * 60 + d.astimezone(bot.CT_TZ).minute)
    check("session gate is DST-correct", ct(jan) == 510 and ct(jul) == 510,
          f"Jan {ct(jan)}, Jul {ct(jul)}")

    check("cooldown_bars=1 is inert by construction",
          bot.CONFIG["cooldown_bars"] <= 1 and
          bot.raw_signals(bars, dict(cfg, cooldown_bars=1))[0] ==
          bot.raw_signals(bars, dict(cfg, cooldown_bars=0))[0],
          "cooldown_bars > 1 would need its own parity case")

    # ── 9. live decision path ─────────────────────────────────
    # Sections 1-8 verify the maths. This drives _evaluate() itself against a
    # scripted broker, because the maths being right does not stop the trading
    # path from entering after the cutoff, ignoring the flatten, or opening a
    # second position on top of one already running.
    print("\n9. live decision path (_evaluate against a scripted broker)")
    run_live_path_tests(fx, bars)

    # ── summary ───────────────────────────────────────────────
    print(f"\n{'=' * 62}")
    print(f"  {PASS} passed, {FAIL} failed")
    if FAILURES:
        print()
        for f in FAILURES:
            print(f"  x {f}")
    print(f"{'=' * 62}\n")
    return 1 if FAIL else 0


def bar_ct(bars, i):
    return bars[i].ct_min if 0 <= i < len(bars) else -1


# ═══════════════════════════════════════════════════════════════
#  Scripted broker for the live decision path
# ═══════════════════════════════════════════════════════════════
class FakeClient:
    """Records what the bot asked for. No network, no order matching — the point
    is the SEQUENCE of decisions, not the fills."""

    def __init__(self, bars1m, balance=50_000.0):
        self._bars1m = bars1m
        self._balance = balance
        self.orders = []          # (side, size, sl_ticks, tp_ticks)
        self.adds = []            # (side, size, stop_price, sl_ticks, tp_ticks)
        self.closes = 0
        self.cancels = 0
        self.position = None      # {"size": int, "type": 1|2, "price": float}

    @property
    def balance(self):
        return self._balance

    async def refresh_balance(self):
        return self._balance

    async def get_bars_1m(self, days=5):
        return self._bars1m

    async def place_bracket_order(self, side, size, sl_ticks, tp_ticks):
        self.orders.append((side, size, sl_ticks, tp_ticks))
        self.position = {"size": size, "type": 1 if side == 0 else 2,
                         "price": 20000.0, "contractId": bot.CONFIG["contract_id"]}
        return 1234

    async def place_stop_with_bracket(self, side, size, stop_price, sl_ticks, tp_ticks):
        self.adds.append((side, size, stop_price, sl_ticks, tp_ticks))
        return 5678

    async def get_open_positions(self):
        return [self.position] if self.position else []

    async def close_position(self):
        self.closes += 1
        self.position = None
        return True

    async def get_open_orders(self):
        return []

    async def cancel_order(self, oid):
        self.cancels += 1
        return True


def make_bot(bars1m, ct_now, day_pnl=0.0, position=None):
    """A bot wired to a scripted broker, with wall-clock CT pinned so session
    gates can be exercised without waiting for 14:55."""
    api = FakeClient(bars1m)
    api.position = position
    b = bot.DonchianBot(api)
    b._session_key = bot.trading_day_key(datetime.now(timezone.utc))
    b._day_start_balance = api.balance - day_pnl
    b._ct_now = lambda: ct_now          # shadow the staticmethod on this instance
    if position:
        b.in_position = True
        b._pos_dir = 1 if position["type"] == 1 else -1
    return b, api


def run_live_path_tests(fx, bars):
    import asyncio

    saved = {k: bot.CONFIG[k] for k in ("dry_run", "max_bar_age_s", "max_entry_delay_s")}
    bot.CONFIG["dry_run"] = False
    # The fixture is historical, so the staleness guards would refuse every bar.
    # They are verified separately below with the real values restored.
    bot.CONFIG["max_bar_age_s"] = 10 ** 12
    bot.CONFIG["max_entry_delay_s"] = 10 ** 12

    try:
        # Find a 1-minute prefix that ends exactly on a bar carrying a LONG signal,
        # so _evaluate is guaranteed something to act on.
        sig_idx = next((i for i in range(len(bars) - 1, 0, -1)
                        if fx["sigMasked"][i] == 1), None)
        if sig_idx is None:
            check("fixture contains a long signal", False, "none found")
            return
        end_ms = bars[sig_idx].ts + 120_000
        prefix = [{"ms": r[0], "o": r[1], "h": r[2], "l": r[3], "c": r[4]}
                  for r in fx["bars1m"] if r[0] < end_ms]
        sig_ct = bars[sig_idx].ct_min

        def run(ct, **kw):
            b, api = make_bot(prefix, ct, **kw)
            asyncio.run(b._evaluate())
            return b, api

        # a) a clean signal in-session places exactly one bracket
        b, api = run(sig_ct + 2)
        check("a gated signal places one bracket order", len(api.orders) == 1,
              f"{len(api.orders)} orders")
        if api.orders:
            side, size, sl_t, tp_t = api.orders[0]
            check("...buy side for a long", side == 0, f"side={side}")
            # With scale-in the first order is the FIRST TRANCHE, not the full
            # size; the remainder rests as a stop order and is checked below.
            want = (bot.CONFIG["scale_in_first"] if bot.CONFIG.get("scale_in")
                    else bot.CONFIG["contracts"])
            check("...at the configured first-tranche size", size == want,
                  f"size={size} want={want}")
            check("...stop wider than target (inverted geometry)", sl_t > tp_t,
                  f"sl={sl_t}t tp={tp_t}t")
            # The bracket must be the NEARER of the designed 5xATR stop and the
            # distance the platform's hard dollar cap allows. Placing it beyond
            # the cap would be a stop that never fills, and would make every risk
            # figure the bot logs fiction.
            #
            # The cap is a DOLLAR limit, so its distance in POINTS depends on how
            # many contracts are actually on. Under scale-in the first tranche is
            # small and the cap therefore sits proportionally further away — at 2
            # lots it is 250 points, not the 62.5 that 8 lots implies. Computing
            # this against the configured total would place a stop four times
            # tighter than the position warrants; that is the bug this asserts
            # against, so `size` (what was really sent) is the only correct
            # denominator here.
            atr_at_signal = fx["indicators"]["atr"][sig_idx]
            designed = bot.CONFIG["sl_atr_mult"] * atr_at_signal
            cap = bot.CONFIG["platform_hard_loss_stop"]
            cap_pts = cap / (2.0 * size)      # $/point = tick_value/tick_size
            want_sl = min(designed, cap_pts)
            check("...stop is the nearer of 5xATR and the cap for the size sent",
                  abs(sl_t * 0.25 - want_sl) < 0.3,
                  f"{sl_t * 0.25:.2f} pts vs expected {want_sl:.2f} "
                  f"(designed {designed:.2f}, cap at {size} lots {cap_pts:.2f})")
            # The invariant that actually protects the account: whatever size went
            # out, the dollars behind its stop stay inside the cap.
            risk = sl_t * 0.25 * 2.0 * size
            check("...and the tranche sent never risks more than the cap",
                  risk <= cap + 1, f"${risk:.0f} > ${cap:.0f} on {size} lots")
            if designed <= cap_pts:
                ratio = sl_t / tp_t
                want = bot.CONFIG["sl_atr_mult"] / bot.CONFIG["tp_atr_mult"]
                check("...uncapped, the ratio is the designed one",
                      abs(ratio - want) < 0.02, f"{ratio:.3f} vs {want:.3f}")

        # b) the entry cutoff
        _, api = run(bot.CONFIG["no_entry_ct"])
        check("no entry AT the 14:55 cutoff", len(api.orders) == 0,
              f"{len(api.orders)} orders")
        _, api = run(bot.CONFIG["no_entry_ct"] - 1)
        check("...but one minute earlier is fine", len(api.orders) == 1, "")

        # c) the flatten window
        _, api = run(bot.CONFIG["flatten_ct"] + 1)
        check("no entry inside the flatten window", len(api.orders) == 0, "")

        # d) daily entry blocks stop new risk
        _, api = run(sig_ct + 2, day_pnl=bot.CONFIG["daily_profit_block"])
        check("profit block stops new entries", len(api.orders) == 0, "")
        check("...and does NOT close anything", api.closes == 0,
              f"{api.closes} closes — a soft block must never flatten")
        _, api = run(sig_ct + 2, day_pnl=-bot.CONFIG["circuit_breaker"])
        check("circuit breaker stops new entries", len(api.orders) == 0, "")
        check("...and does NOT close anything", api.closes == 0, "")

        # e) an open position in the SAME direction is left alone
        longpos = {"size": 10, "type": 1, "price": 20000.0,
                   "contractId": bot.CONFIG["contract_id"]}
        _, api = run(sig_ct + 2, position=dict(longpos))
        check("a same-direction signal never stacks a second position",
              len(api.orders) == 0 and api.closes == 0,
              f"{len(api.orders)} orders, {api.closes} closes")

        # f) flip: an opposite signal reverses
        shortpos = {"size": 10, "type": 2, "price": 20000.0,
                    "contractId": bot.CONFIG["contract_id"]}
        _, api = run(sig_ct + 2, position=dict(shortpos))
        check("an opposite signal closes the position", api.closes == 1,
              f"{api.closes} closes")
        check("...and re-enters the other way", len(api.orders) == 1 and api.orders[0][0] == 0,
              f"orders={api.orders}")

        # g) a flip that crosses the profit block must not open the other side
        _, api = run(sig_ct + 2, position=dict(shortpos),
                     day_pnl=bot.CONFIG["daily_profit_block"])
        check("a blocked flip closes but does not reverse",
              api.closes == 1 and len(api.orders) == 0,
              f"{api.closes} closes, {len(api.orders)} orders")

        # h) the flatten closes an open position outright
        b, api = make_bot(prefix, bot.CONFIG["flatten_ct"], position=dict(longpos))
        asyncio.run(b._enforce_flatten())
        check("the flatten closes an open position", api.closes == 1,
              f"{api.closes} closes")
        b, api = make_bot(prefix, bot.CONFIG["flatten_ct"] - 1, position=dict(longpos))
        asyncio.run(b._enforce_flatten())
        check("...and does nothing a minute before it", api.closes == 0, "")

    finally:
        bot.CONFIG.update(saved)

    # ── the cap scales with size, not with the config ──
    # The platform liquidates at a fixed DOLLAR loss, so halving the contracts
    # DOUBLES how far away that limit sits in points. The bot originally computed
    # the cap against CONFIG["contracts"] regardless of what it was about to
    # send, which under scale-in put a 62.5-point stop on a 2-lot tranche that
    # should have carried 250 — four times too tight, stopping the small tranche
    # out of trades the backtest holds all the way to target. Guard it directly.
    capbot, _capapi = make_bot(bars, sig_ct)
    cap_usd = bot.CONFIG["platform_hard_loss_stop"]
    if cap_usd > 0:
        tiny_atr = 0.2                     # small enough that the cap never binds
        big_atr = 200.0                    # large enough that it always binds
        for lots in (1, 2, 4, 8):
            _, _, _, cap_pts = capbot._bracket_points(big_atr, lots)
            check(f"cap sits at the right distance for {lots} lots",
                  abs(cap_pts - cap_usd / (2.0 * lots)) < 1e-6,
                  f"{cap_pts:.2f} vs {cap_usd / (2.0 * lots):.2f}")
            sl_pts, _, capped, _ = capbot._bracket_points(big_atr, lots)
            check(f"...and {lots} lots behind it risk exactly the cap",
                  capped and abs(sl_pts * 2.0 * lots - cap_usd) < 1.0,
                  f"${sl_pts * 2.0 * lots:.0f} vs ${cap_usd:.0f}")
        # A small tranche must NOT inherit the full-size cap.
        first_lots = (bot.CONFIG["scale_in_first"] if bot.CONFIG.get("scale_in")
                      else bot.CONFIG["contracts"])
        if first_lots < bot.CONFIG["contracts"]:
            small, _, _, _ = capbot._bracket_points(big_atr, first_lots)
            full, _, _, _ = capbot._bracket_points(big_atr, bot.CONFIG["contracts"])
            check("first tranche gets a WIDER stop than the full size would",
                  small > full * 1.5,
                  f"{small:.1f} pts at {first_lots} lots vs {full:.1f} at "
                  f"{bot.CONFIG['contracts']}")
        # Below the cap the designed geometry survives untouched at any size.
        a, _, capped_small, _ = capbot._bracket_points(tiny_atr, 1)
        check("a stop inside the cap is left at its designed distance",
              (not capped_small) and abs(a - bot.CONFIG["sl_atr_mult"] * tiny_atr) < 1e-9,
              f"{a:.4f}, capped={capped_small}")
        # Default argument still means the configured total, so nothing that calls
        # it without a size changes behaviour.
        d, _, _, dcap = capbot._bracket_points(big_atr)
        check("omitting the size falls back to the configured total",
              abs(dcap - cap_usd / (2.0 * bot.CONFIG["contracts"])) < 1e-6,
              f"{dcap:.2f}")

    # ── scale-in ──
    # Needs the same overrides section 9 uses: live path, staleness guards off.
    saved2 = {k: bot.CONFIG[k] for k in ("dry_run", "max_bar_age_s", "max_entry_delay_s")}
    bot.CONFIG["dry_run"] = False
    bot.CONFIG["max_bar_age_s"] = 10 ** 12
    bot.CONFIG["max_entry_delay_s"] = 10 ** 12
    try:
      if bot.CONFIG.get("scale_in"):
          b, api = run(sig_ct + 2)
          total, first = bot.CONFIG["contracts"], bot.CONFIG["scale_in_first"]
          check("scale-in: first tranche is the configured size",
                len(api.orders) == 1 and api.orders[0][1] == first, f"orders={api.orders}")
          # THE ADD IS DEFERRED BY ONE BAR. A 2-min bar's range is about one ATR,
          # so a 0.15xATR trigger is touched inside the ENTRY bar for ~81% of
          # signals with no information in it. Resting the order immediately adds
          # to nearly everything, including the breakouts that spiked and died —
          # measured at 31.8% / pf 1.116, WORSE than not scaling in. One bar later
          # is 46.5% / pf 1.338. So "nothing sent yet" is the correct state here.
          check("scale-in: NO add order is sent on the entry bar",
                len(api.adds) == 0, f"adds={api.adds}")
          check("scale-in: the add is parked for the next bar instead",
                b._add_pending is not None and b._add_pending["lots"] == total - first,
                f"pending={b._add_pending}")
          # Now let one more bar pass: _service_add is what sends it.
          if b._add_pending is not None:
              api.position = {"contractId": bot.CONFIG["contract_id"],
                              "size": first, "averagePrice": 100.0}
              b.in_position, b._pos_dir = True, 1
              asyncio.run(b._service_add())
          check("scale-in: one resting add for the remainder, one bar late",
                len(api.adds) == 1 and api.adds[0][1] == total - first, f"adds={api.adds}")
          check("...and the parked copy is cleared once sent", b._add_pending is None)
          if api.adds and api.orders:
              side, size, stop_px, a_sl, a_tp = api.adds[0]
              check("...add is on the SAME side as the entry", side == api.orders[0][0], "")
              # The add's bracket must land on the same ABSOLUTE levels as the first
              # tranche's — otherwise the two halves get managed differently and the
              # position has two stops at two prices.
              atr_at = fx["indicators"]["atr"][sig_idx]
              trig = bot.CONFIG["scale_in_trigger_atr"] * atr_at
              ent_sl, ent_tp = api.orders[0][2] * 0.25, api.orders[0][3] * 0.25
              check("...add's stop distance reaches the SHARED stop",
                    abs(a_sl * 0.25 - (ent_sl + trig)) < 0.6,
                    f"{a_sl * 0.25:.2f} vs {ent_sl + trig:.2f}")
              check("...add's target distance reaches the SHARED target",
                    abs(a_tp * 0.25 - (ent_tp - trig)) < 0.6,
                    f"{a_tp * 0.25:.2f} vs {ent_tp - trig:.2f}")

          # THE DANGEROUS PATH. A resting stop that outlives its position opens a
          # fresh unmanaged position on the next touch, with no signal behind it.
          b2, api2 = make_bot(prefix, sig_ct + 2)
          b2._add_oid, b2.in_position, b2._pos_dir = 999, True, 1
          api2.position = None                        # platform reports flat
          asyncio.run(b2._sync_position())
          check("scale-in: add is cancelled the moment the position closes",
                b2._add_oid is None and api2.cancels >= 1,
                f"add_oid={b2._add_oid} cancels={api2.cancels}")

          b3, api3 = make_bot(prefix, bot.CONFIG["flatten_ct"])
          b3._add_oid = 999
          asyncio.run(b3._enforce_flatten())
          check("scale-in: add is cancelled in the flatten window",
                b3._add_oid is None and api3.cancels >= 1, "")

          b4, api4 = make_bot(prefix, sig_ct + 2)
          b4._add_oid = 999
          b4._add_deadline = datetime.now(timezone.utc) - timedelta(minutes=1)
          asyncio.run(b4._service_add())
          check("scale-in: add expires once its window passes",
                b4._add_oid is None and api4.cancels >= 1, "")

          b5, api5 = make_bot(prefix, sig_ct + 2)
          b5._add_oid = 999
          b5._add_deadline = datetime.now(timezone.utc) + timedelta(hours=1)
          asyncio.run(b5._service_add())
          check("...but survives while the window is still open",
                b5._add_oid == 999 and api5.cancels == 0, "")

          # A DEFERRED add is exactly as dangerous as a resting one: if the
          # position is gone by the next bar, sending it would open a fresh
          # unmanaged position with no signal behind it. Two ways out.
          b6, api6 = make_bot(prefix, sig_ct + 2)
          b6._add_pending = {"side": 0, "lots": 6, "px": 100.0, "sl_ticks": 10,
                             "tp_ticks": 5, "deadline": datetime.now(timezone.utc)}
          b6.in_position = False
          asyncio.run(b6._service_add())
          check("scale-in: a parked add is DROPPED if the position is gone",
                b6._add_pending is None and len(api6.adds) == 0,
                f"pending={b6._add_pending} adds={api6.adds}")

          b7, api7 = make_bot(prefix, sig_ct + 2)
          b7._add_pending = {"side": 0, "lots": 6, "px": 100.0, "sl_ticks": 10,
                             "tp_ticks": 5, "deadline": datetime.now(timezone.utc)}
          asyncio.run(b7._cancel_add("test"))
          check("scale-in: _cancel_add drops a parked add too",
                b7._add_pending is None, f"pending={b7._add_pending}")

          b8, api8 = make_bot(prefix, sig_ct + 2)
          b8._add_pending = {"side": 0, "lots": 6, "px": 100.0, "sl_ticks": 10,
                             "tp_ticks": 5, "deadline": datetime.now(timezone.utc)}
          b8.in_position, b8._pos_dir = True, 1
          api8.position = {"contractId": bot.CONFIG["contract_id"],
                           "size": 2, "averagePrice": 100.0}
          asyncio.run(b8._service_add())
          check("...but is SENT while the position is still open",
                len(api8.adds) == 1 and b8._add_oid is not None,
                f"adds={api8.adds}")


      # ── PROPERTY TEST: no add may survive being flat ──
      # Five separate paths clear the add (position closed, flatten window, flip,
      # window expiry, and the deferred-drop in _service_add). Reading them and
      # believing they are exhaustive is how the last three defects got shipped,
      # so drive the state machine through randomised event sequences instead and
      # assert the invariant after every step:
      #
      #     the platform reports flat  =>  no add order live AND none parked
      #
      # A violation means a working stop order with no position behind it, which
      # opens a fresh unmanaged position on the next touch. That is the single
      # worst thing this bot can do.
      if bot.CONFIG.get("scale_in"):
          import random as _rnd
          rng = _rnd.Random(20260815)
          violations, steps = [], 0
          for trial in range(240):
              b, api = make_bot(prefix, sig_ct + 2)
              # random starting state
              if rng.random() < 0.5:
                  b._add_oid = 900 + trial
                  b._add_deadline = (datetime.now(timezone.utc) +
                                     timedelta(minutes=rng.choice([-5, 20])))
              if rng.random() < 0.5:
                  b._add_pending = {"side": rng.choice([0, 1]), "lots": 6,
                                    "px": 100.0, "sl_ticks": 10, "tp_ticks": 5,
                                    "deadline": datetime.now(timezone.utc) +
                                                timedelta(minutes=20)}
              b.in_position = rng.random() < 0.6
              b._pos_dir = rng.choice([1, -1])
              api.position = ({"contractId": bot.CONFIG["contract_id"],
                               "size": rng.choice([2, 8]), "averagePrice": 100.0}
                              if b.in_position else None)
              for _ in range(rng.randint(1, 6)):
                  ev = rng.choice(["sync", "service", "flatten", "flip", "vanish"])
                  try:
                      if ev == "vanish":
                          api.position = None        # platform closed it out
                          asyncio.run(b._sync_position())
                      elif ev == "sync":
                          asyncio.run(b._sync_position())
                      elif ev == "service":
                          asyncio.run(b._service_add())
                      elif ev == "flatten":
                          asyncio.run(b._enforce_flatten())
                      elif ev == "flip":
                          asyncio.run(b._cancel_add("flip"))
                  except Exception as exc:
                      violations.append(f"trial {trial} {ev} raised {exc!r}")
                      break
                  # Every live bar ends with _sync_position, so that is where the
                  # invariant must hold. _enforce_flatten outside its window is a
                  # deliberate no-op and cannot be asked to establish it alone.
                  asyncio.run(b._sync_position())
                  steps += 1
                  if not b.in_position and (b._add_oid is not None or
                                            b._add_pending is not None):
                      violations.append(
                          f"trial {trial} after {ev}: flat but "
                          f"oid={b._add_oid} pending={b._add_pending is not None}")
                      break
          check(f"no add survives being flat ({steps} randomised steps)",
                not violations, "; ".join(violations[:3]))

    finally:
        bot.CONFIG.update(saved2)

    # i) staleness guards, with the shipped values back in force
    bot.CONFIG["dry_run"] = False
    try:
        b, api = make_bot([{"ms": r[0], "o": r[1], "h": r[2], "l": r[3], "c": r[4]}
                           for r in fx["bars1m"]], 12 * 60)
        import asyncio as _a
        ok = _a.run(b._evaluate())
        check("a stale feed is refused outright", ok is False and len(api.orders) == 0,
              f"returned {ok}, {len(api.orders)} orders")
    finally:
        bot.CONFIG.update(saved)


def in_flat(ct, flatten, reopen):
    return (flatten <= ct < reopen) if reopen > flatten else (ct >= flatten or ct < reopen)


def replay(bars, sig, atr, x):
    """Reimplementation of src/engine.mjs `runBrackets` for the fixed-size,
    no-hard-cap configuration this bot ships.

    TEST-ONLY. The live bot never runs this — the broker holds the bracket. It
    exists so the DECISION SEQUENCE can be verified: flatten outranking the
    bracket, stop resolving before target, gap-throughs filling at the open, no
    re-entry on the exit bar, and flips reversing at the bar open.
    """
    tick = x["tickSize"]
    pv = x["pointValue"]
    q = int(x["contracts"])
    slip = x["slippageTicks"] * tick
    fees = (x["commissionFlat"] if x["commissionModel"] == "flat"
            else x["commissionPerSide"] * 2 * q)
    intraday = bool(x["intradayOnly"])
    cutoff = x["flattenCt"] - (x["noEntryMinsBeforeFlat"] or 0)

    trades = []
    pos = 0
    ep = sl_d = tp_d = 0.0
    ei = 0

    def close_(raw_exit, reason, i):
        nonlocal pos
        exit_px = raw_exit - slip if pos == 1 else raw_exit + slip
        entry_fill = ep + slip if pos == 1 else ep - slip
        gross = (exit_px - entry_fill) * pos * pv * q
        trades.append({
            "entryIdx": ei, "exitIdx": i,
            "entryTime": bars[ei].ts, "exitTime": bars[i].ts,
            "dir": pos, "contracts": q,
            "entryPrice": entry_fill, "exitPrice": exit_px,
            "stop": ep - sl_d if pos == 1 else ep + sl_d,
            "target": ep + tp_d if pos == 1 else ep - tp_d,
            "pnl": gross - fees, "gross": gross, "fees": fees,
            "tday": bars[i].tday, "reason": reason,
        })
        pos = 0

    for i in range(1, len(bars)):
        s = sig[i - 1]
        b = bars[i]
        flat_now = intraday and in_flat(b.ct_min, x["flattenCt"], x["reopenCt"])

        if pos != 0:
            # The flatten deadline outranks the bracket unconditionally.
            if flat_now:
                close_(b.open, "FLAT", i)
                continue
            exited = False
            if pos == 1:
                s_px, t_px = ep - sl_d, ep + tp_d
                if b.open <= s_px:
                    close_(b.open, "SL", i); exited = True
                elif b.low <= s_px:
                    close_(s_px, "SL", i); exited = True
                elif b.high >= t_px:
                    close_(t_px, "TP", i); exited = True
            else:
                s_px, t_px = ep + sl_d, ep - tp_d
                if b.open >= s_px:
                    close_(b.open, "SL", i); exited = True
                elif b.high >= s_px:
                    close_(s_px, "SL", i); exited = True
                elif b.low <= t_px:
                    close_(t_px, "TP", i); exited = True
            if exited and not x["sameBarReentry"]:
                continue
            if x["maxBarsInTrade"] > 0 and i - ei >= x["maxBarsInTrade"]:
                close_(b.open, "TIME", i)
                continue
            if x["flipOnOpposite"] and s != 0 and s != pos:
                close_(b.open, "FLIP", i)      # may re-enter below
            if pos != 0:
                continue

        if pos == 0 and s != 0 and not flat_now:
            if intraday and x["noEntryMinsBeforeFlat"] > 0 and \
                    in_flat(b.ct_min, cutoff, x["reopenCt"]):
                continue
            a = atr[i - 1]                     # ATR at the SIGNAL bar, not the fill bar
            if a is not None and math.isfinite(a) and a > 0:
                ep, ei, pos = b.open, i, s
                sl_d = max(a * x["slAtrMult"], tick)
                tp_d = (max(sl_d * x["tpRR"], tick) if x["tpMode"] == "rr"
                        else max(a * x["tpAtrMult"], tick))

    if pos != 0:
        close_(bars[-1].close, "EOD", len(bars) - 1)
    return trades


if __name__ == "__main__":
    sys.exit(main())
