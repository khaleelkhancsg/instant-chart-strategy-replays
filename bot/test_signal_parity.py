#!/usr/bin/env python3
"""
Two things about the signal bot, both worth asserting.

  1. IT CANNOT TRADE. The underlying client used here raises on every write
     method. If SignalClient ever forwards one, this file fails loudly. That is
     the whole safety claim, so it is tested rather than reasoned about.

  2. IT DECIDES THE SAME THINGS. The same scenarios are run twice -- once with
     the bot talking to a plain recording client, once with the same client
     behind SignalClient -- and the instruction streams must match on side,
     size, price and bracket ticks. Signal mode is meant to be the live bot with
     a different output device, and this is what makes that true rather than
     hopeful.

    python bot/test_signal_parity.py
"""

import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
os.environ.setdefault("MNQ_LOG_DIR", str(HERE / "logs_test"))
os.environ.pop("MNQ_NOTIFY_WEBHOOK", None)          # never push from a test

import mnq_donchian_bot as bot                       # noqa: E402
import mnq_signal_bot as sigbot                      # noqa: E402
from orb_strategy import OrbLevels                   # noqa: E402

bot.CONFIG["state_file"] = str(HERE / "logs_test" / "test_state_signal.json")
(HERE / "logs_test").mkdir(exist_ok=True)
sigbot.notify = lambda *a, **k: None                 # silence banners and beeps

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


class Recorder:
    """Stands in for TopstepXClient. Records instructions, never matches them."""

    WRITES = ("place_bracket_order", "place_stop_with_bracket",
              "place_limit_with_bracket", "close_position", "cancel_order")

    def __init__(self, forbid_writes=False, balance=50_000.0):
        self._balance = balance
        self.calls = []
        self.position = None
        self.forbid = forbid_writes

    def _w(self, name, *args):
        if self.forbid:
            raise AssertionError(
                f"SignalClient forwarded {name}{args} to the real platform")
        self.calls.append((name,) + args)

    @property
    def balance(self):
        return self._balance

    async def connect(self):
        return None

    async def refresh_balance(self):
        return self._balance

    async def get_bars_1m(self, days=5):
        return []

    async def get_open_positions(self):
        return [self.position] if self.position else []

    async def get_open_orders(self):
        return []

    async def place_bracket_order(self, side, size, sl, tp):
        self._w("place_bracket_order", side, size, sl, tp)
        return 1234

    async def place_stop_with_bracket(self, side, size, px, sl, tp):
        self._w("place_stop_with_bracket", side, size, round(px, 2), sl, tp)
        return 5000 + len(self.calls)

    async def place_limit_with_bracket(self, side, size, px, sl, tp):
        self._w("place_limit_with_bracket", side, size, round(px, 2), sl, tp)
        return 6000 + len(self.calls)

    async def close_position(self):
        self._w("close_position")
        self.position = None
        return True

    async def cancel_order(self, oid):
        self._w("cancel_order")
        return True


class Spy(sigbot.SignalClient):
    """SignalClient that records what it was ASKED to do, so it can be diffed."""

    def __init__(self, real):
        super().__init__(real)
        self.calls = []

    async def place_bracket_order(self, side, size, sl, tp):
        self.calls.append(("place_bracket_order", side, size, sl, tp))
        return await super().place_bracket_order(side, size, sl, tp)

    async def place_stop_with_bracket(self, side, size, px, sl, tp):
        self.calls.append(("place_stop_with_bracket", side, size, round(px, 2), sl, tp))
        return await super().place_stop_with_bracket(side, size, px, sl, tp)

    async def place_limit_with_bracket(self, side, size, px, sl, tp):
        self.calls.append(("place_limit_with_bracket", side, size, round(px, 2), sl, tp))
        return await super().place_limit_with_bracket(side, size, px, sl, tp)

    async def close_position(self):
        self.calls.append(("close_position",))
        return await super().close_position()

    async def cancel_order(self, oid):
        self.calls.append(("cancel_order",))
        return await super().cancel_order(oid)


LV = OrbLevels(hi=20050.0, lo=19950.0, taps_hi=4, taps_lo=3,
               win_hi=20080.0, win_lo=19920.0, ref=20000.0)
POS = {"size": 8, "type": 1, "price": 20000.0, "contractId": bot.CONFIG["contract_id"]}


def build(api, ct, *, levels=LV, day_pnl=0.0, position=None):
    api.position = position
    b = bot.DonchianBot(api)
    b._session_key = "T"
    b._day_start_balance = api.balance - day_pnl
    b._ct_now = lambda: ct
    b._orb_day = "T"
    b._orb_levels = levels
    if position:
        b.in_position = True
        b._pos_dir = 1 if position["type"] == 1 else -1
    return b


SCENARIOS = [
    ("ORB arms both sides at the open", bot.ORB_OPEN_CT + 1, {}),
    ("hunt window expiry cancels", bot.CONFIG["orb_give_up_ct"] + 1, {"oids": [1, 2]}),
    ("profit block prevents arming", bot.ORB_OPEN_CT + 1, {"day_pnl": 900.0}),
    ("circuit breaker cancels", bot.ORB_OPEN_CT + 1,
     {"day_pnl": -600.0, "oids": [7, 8]}),
    ("no level, book stands down", bot.ORB_OPEN_CT + 1, {"levels": None}),
    ("a position cancels resting orders", bot.ORB_OPEN_CT + 1,
     {"position": POS, "owner": "don", "oids": [11, 12]}),
]


def run_scenario(api, ct, opts):
    b = build(api, ct, levels=opts.get("levels", LV),
              day_pnl=opts.get("day_pnl", 0.0), position=opts.get("position"))
    if opts.get("owner"):
        b._pos_owner = opts["owner"]
    if opts.get("oids"):
        b._orb_oids = list(opts["oids"])
    asyncio.run(b._service_orb([]))
    return b


def main():
    print("\nsignal bot parity\n")

    # ── 1. it cannot trade ────────────────────────────────────
    print("safety: no write ever reaches the platform")
    for name, ct, opts in SCENARIOS:
        guard = Recorder(forbid_writes=True)
        try:
            run_scenario(Spy(guard), ct, opts)
            check(f"no order placed — {name}", True)
        except AssertionError as exc:
            check(f"no order placed — {name}", False, str(exc))

    # The time stop is the one path that closes a position.
    guard = Recorder(forbid_writes=True)
    spy = Spy(guard)
    b = build(spy, bot.ORB_OPEN_CT + 20, position=POS)
    b._pos_owner = "orb"
    b._orb_entry_ts = datetime.now(timezone.utc) - __import__("datetime").timedelta(
        minutes=bot.CONFIG["orb_max_hold_min"] + 0.5)
    try:
        asyncio.run(b._service_orb([]))
        check("no position closed — ORB time stop", True)
    except AssertionError as exc:
        check("no position closed — ORB time stop", False, str(exc))
    check("...but it DID tell you to close",
          ("close_position",) in spy.calls, f"calls={spy.calls}")

    # ── 2. it decides the same things ─────────────────────────
    print("\nparity: identical instructions in both modes")
    for name, ct, opts in SCENARIOS:
        direct = Recorder()
        run_scenario(direct, ct, opts)
        spy = Spy(Recorder(forbid_writes=True))
        run_scenario(spy, ct, opts)
        check(f"same instruction stream — {name}",
              direct.calls == spy.calls,
              f"\n      live  {direct.calls}\n      signal{spy.calls}")

    # ── 2b. THE DONCHIAN PATH ─────────────────────────────────
    # The scenarios above are all ORB. The donchian book reaches the platform
    # through completely different call sites -- _service_add for the stop
    # entry, _place_entry for a market one, _enforce_flatten for the 15:04 exit
    # -- so "both books alert" is not implied by any of them.
    print("")
    print("coverage: the donchian book alerts too")

    def armed(api):
        b = bot.DonchianBot(api)
        b._session_key = "T"
        b._day_start_balance = api.balance
        b._ct_now = lambda: 10 * 60
        b._last_bar_ts = 1_000_000
        b._add_pending = {
            "side": 0, "lots": 8, "px": 20010.0, "sl_ticks": 199, "tp_ticks": 70,
            "deadline": datetime.now(timezone.utc) + __import__("datetime").timedelta(minutes=20),
            "want_sl_px": 19960.25, "want_tp_px": 20027.5,
            "sig_ts": 1_000_000 - 120_000, "atr": 14.0,
        }
        return b

    guard = Recorder(forbid_writes=True)
    spy = Spy(guard)
    try:
        asyncio.run(armed(spy)._service_add())
        check("no order placed - donchian stop entry", True)
    except AssertionError as exc:
        check("no order placed - donchian stop entry", False, str(exc))
    check("donchian stop entry DID alert",
          any(c[0] == "place_stop_with_bracket" for c in spy.calls),
          f"calls={spy.calls}")
    direct = Recorder()
    asyncio.run(armed(direct)._service_add())
    check("same instruction stream - donchian stop entry",
          direct.calls == spy.calls,
          f"live {direct.calls} vs signal {spy.calls}")

    # The flatten is how nearly every donchian trade actually ends.
    guard = Recorder(forbid_writes=True)
    guard.position = dict(POS)
    spy = Spy(guard)
    b = bot.DonchianBot(spy)
    b._session_key = "T"
    b._day_start_balance = spy.balance
    b._ct_now = lambda: bot.CONFIG["flatten_ct"] + 1
    b.in_position, b._pos_dir = True, 1
    try:
        asyncio.run(b._enforce_flatten())
        check("no position closed - 15:04 flatten", True)
    except AssertionError as exc:
        check("no position closed - 15:04 flatten", False, str(exc))
    check("the flatten DID alert",
          ("close_position",) in spy.calls, f"calls={spy.calls}")

    # And a plain market entry, for the non-stop-entry configuration.
    saved = bot.CONFIG["scale_in"]
    bot.CONFIG["scale_in"] = False
    guard = Recorder(forbid_writes=True)
    spy = Spy(guard)
    b = bot.DonchianBot(spy)
    b._session_key = "T"
    b._day_start_balance = spy.balance
    b._ct_now = lambda: 10 * 60
    try:
        asyncio.run(b._place_entry(1, 14.0, 20000.0))
        check("no order placed - donchian market entry", True)
    except AssertionError as exc:
        check("no order placed - donchian market entry", False, str(exc))
    bot.CONFIG["scale_in"] = saved
    check("donchian market entry DID alert",
          any(c[0] == "place_bracket_order" for c in spy.calls), f"calls={spy.calls}")

    # ── 2c. alerts say WHICH book ─────────────────────────────
    print("")
    print("labelling: each alert names the book that asked")
    seen = []
    real_notify = sigbot.notify
    sigbot.notify = lambda t, l, pattern="entry", priority="default": seen.append(t)
    guard = Recorder(forbid_writes=True)
    run_scenario(sigbot.SignalClient(guard), bot.ORB_OPEN_CT + 1, {})
    check("ORB arms are labelled ORB",
          seen and all("ORB" in t for t in seen), f"titles={seen}")
    seen.clear()
    asyncio.run(armed(sigbot.SignalClient(Recorder(forbid_writes=True)))._service_add())
    check("donchian arms are labelled DONCHIAN",
          seen and all("DONCHIAN" in t for t in seen), f"titles={seen}")
    sigbot.notify = real_notify

    # ── 3. the seam is complete ───────────────────────────────
    print("\ninterface: SignalClient covers everything the bot calls")
    missing = [m for m in ("connect", "balance", "refresh_balance", "get_bars_1m",
                           "get_open_positions", "get_open_orders",
                           "place_bracket_order", "place_stop_with_bracket",
                           "place_limit_with_bracket", "close_position",
                           "cancel_order")
               if not hasattr(sigbot.SignalClient, m)]
    check("every method DonchianBot uses exists", not missing, f"missing={missing}")

    real_writes = [m for m in Recorder.WRITES
                   if not hasattr(sigbot.SignalClient, m)]
    check("every WRITE method is overridden", not real_writes, f"missing={real_writes}")

    # ── 4. the nag ────────────────────────────────────────────
    print("\nfollow-up: it keeps asking until the position is really gone")
    rec = Recorder()
    rec.position = dict(POS)
    sc = sigbot.SignalClient(rec)
    asyncio.run(sc.close_position())
    check("a close request starts nagging", sc._nagging is not None)
    sc._nag_at = 0.0
    seen = []
    sigbot.notify = lambda t, l, pattern="entry", priority="default": seen.append(t)
    asyncio.run(sc.get_open_positions())
    check("nags while the position is still open",
          any("STILL OPEN" in s for s in seen), f"seen={seen}")
    rec.position = None
    seen.clear()
    asyncio.run(sc.get_open_positions())
    check("stops nagging once flat",
          not any("STILL OPEN" in s for s in seen) and sc._nagging is None,
          f"seen={seen}")

    # ── 5. it tells you when YOUR order filled, and when it ended ──
    # Nothing in this process places the orders, so the account is the only
    # place a fill shows up. Missing it would leave the ORB's five-minute clock
    # running with nobody told it had started.
    print("")
    print("fills: the account is watched for your own executions")
    rec2 = Recorder()
    sc2 = sigbot.SignalClient(rec2)
    seen.clear()
    asyncio.run(sc2.get_open_positions())
    check("flat start is silent", not seen, f"seen={seen}")

    rec2.position = dict(POS)
    seen.clear()
    asyncio.run(sc2.get_open_positions())
    check("alerts when your order fills",
          any("FILLED" in s for s in seen), f"seen={seen}")
    seen.clear()
    asyncio.run(sc2.get_open_positions())
    check("does not re-alert while still in", not seen, f"seen={seen}")

    rec2.position = None
    seen.clear()
    asyncio.run(sc2.get_open_positions())
    check("alerts when the trade is done",
          any("FLAT" in s for s in seen), f"seen={seen}")
    seen.clear()
    asyncio.run(sc2.get_open_positions())
    check("does not re-alert while flat", not seen, f"seen={seen}")
    sigbot.notify = real_notify if "real_notify" in dir() else (lambda *a, **k: None)

    # ── 6. the heartbeat ──────────────────────────────────────
    # It exists to catch the trading loop STOPPING, so the thing worth asserting
    # is that a dead feed produces a WARNING rather than a cheerful "all fine".
    print("")
    print("heartbeat: says alive, and says when the feed went quiet")

    class FakeBot:
        in_position = False
        _pos_owner = None
        _orb_oids = []
        _orb_done = False
        _day_start_balance = 50_000.0
        _last_bar_ts = None

    fb = FakeBot()
    sc3 = sigbot.SignalClient(Recorder())
    ms = lambda mins: int(datetime.now(timezone.utc).timestamp() * 1000) - mins * 60_000

    fb._last_bar_ts = ms(2)
    fresh = sigbot.heartbeat_lines(sc3, fb)
    check("reports a fresh feed without warning",
          any("last bar" in x for x in fresh) and not any("STALE" in x for x in fresh),
          f"lines={fresh}")
    check("reports flat and the balance",
          any("flat" in x for x in fresh) and any("balance" in x for x in fresh),
          f"lines={fresh}")

    fb._last_bar_ts = ms(120)                      # feed died two hours ago
    stale = sigbot.heartbeat_lines(sc3, fb)
    check("flags a stale feed instead of saying all is well",
          any("STALE" in x for x in stale), f"lines={stale}")

    fb.in_position, fb._pos_owner = True, "orb"
    fb._last_bar_ts = ms(2)
    held = sigbot.heartbeat_lines(sc3, fb)
    check("names the book holding the position",
          any("ORB book" in x for x in held), f"lines={held}")

    seen = []
    sigbot.notify = lambda t, l, pattern=None, priority="default": seen.append((t, priority))
    sigbot.notify("💤 STILL ONLINE", fresh, pattern=None, priority="low")
    check("heartbeat is LOW priority, so it cannot mute the trade alerts",
          seen and seen[-1][1] == "low", f"seen={seen}")
    sigbot.notify = lambda *a, **k: None

    # ── 6b. the priority policy ───────────────────────────────
    # An alert that overrides every phone setting is one that eventually gets
    # silenced, and a silenced channel costs the 08:30 ORB. So only "do this
    # now" gets high; everything informational sits at default; the heartbeat
    # sits at low and nothing uses ntfy's max level at all.
    print("")
    print("priority: act-now is high, news is default, heartbeat is low")
    fired = []
    sigbot.notify = lambda title, lines, pattern="entry", priority="default":         fired.append((title, priority))
    saved_hook, sigbot.WEBHOOK = sigbot.WEBHOOK, ""
    asyncio.run(sigbot.demo())
    sigbot.WEBHOOK = saved_hook
    sigbot.notify = lambda *a, **k: None

    def prio(fragment):
        return [p for t, p in fired if fragment in t]

    for frag in ("STOP BUY", "STOP SELL", "CANCEL A WORKING ORDER", "CLOSE THE POSITION"):
        check(f"high: {frag}", prio(frag) and all(p == "high" for p in prio(frag)),
              f"{frag} -> {prio(frag)}")
    for frag in ("FILLED", "TRADE IS DONE"):
        check(f"default: {frag}", prio(frag) and all(p == "default" for p in prio(frag)),
              f"{frag} -> {prio(frag)}")
    check("low: STILL ONLINE", prio("STILL ONLINE") == ["low"], f"{prio('STILL ONLINE')}")
    check("nothing uses ntfy's max level",
          not [p for _, p in fired if p in ("urgent", "max")],
          f"{[ (t,p) for t,p in fired if p in ('urgent','max') ]}")
    check("high maps to ntfy 4, default 3, low 2",
          (sigbot.push_payload("https://ntfy.sh/t", "a", "b", "high")[1]["priority"] == 4
           and sigbot.push_payload("https://ntfy.sh/t", "a", "b", "default")[1]["priority"] == 3
           and sigbot.push_payload("https://ntfy.sh/t", "a", "b", "low")[1]["priority"] == 2),
          "mapping wrong")

    # ── 7. the push payload ───────────────────────────────────
    # Every alert title starts with an emoji, and ntfy's header API puts the
    # title in an HTTP header, which is ASCII-only. That silently lost every
    # push. The JSON endpoint carries UTF-8, so the rule is: nothing
    # non-ASCII may ever end up in a header.
    print("")
    print("push: unicode titles must survive the wire")
    url, p = sigbot.push_payload("https://ntfy.sh/some-topic",
                                 "✅ SIGNAL BOT LIVE", "line one\nline two", "urgent")
    check("ntfy posts to the base url with the topic in the body",
          url == "https://ntfy.sh" and p.get("topic") == "some-topic",
          f"url={url} payload={p}")
    check("the emoji title is carried in the JSON body, not a header",
          p.get("title") == "✅ SIGNAL BOT LIVE", f"payload={p}")
    try:
        import json as _json
        _json.dumps(p).encode("utf-8")
        check("the payload encodes as utf-8", True)
    except Exception as exc:
        check("the payload encodes as utf-8", False, str(exc))
    bad = [k for k, v in p.items()
           if isinstance(v, str) and any(ord(c) > 127 for c in v) and k not in
           ("title", "message")]
    check("no non-ascii anywhere a header could be built from", not bad, f"{bad}")
    check("priority maps to ntfy's numeric scale",
          p.get("priority") == 5
          and sigbot.push_payload("https://ntfy.sh/t", "a", "b", "low")[1]["priority"] == 2,
          f"payload={p}")
    d_url, d_p = sigbot.push_payload("https://discord.com/api/webhooks/1/abc",
                                     "💤 STILL ONLINE", "body", "low")
    check("discord and slack urls are left alone",
          d_url.endswith("/abc") and "content" in d_p and "text" in d_p,
          f"url={d_url} payload={d_p}")

    print("\n" + "=" * 62)
    print(f"  {PASS} passed, {FAIL} failed")
    print("=" * 62)
    for f in FAILURES:
        print("  x " + f)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
