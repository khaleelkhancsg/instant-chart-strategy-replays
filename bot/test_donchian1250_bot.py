"""
Sections 5 and 6 of test_donchian1250_parity.py: the BOT ITSELF -- its ProjectX
client, order handling, fill tracking and P&L -- against a simulated ProjectX
Gateway.

FakeGateway answers the same HTTP endpoints, with the same request and
response shapes, as gateway.docs.projectx.com documents (via
httpx.MockTransport, so the bot's real client code runs). It serves the
fixture's 1-minute bars as the clock reaches them, and fills orders the way the
research engine does, so a faithful bot must reproduce the engine's trades:

  * a resting entry stop fills when the bar trades through it, at the order
    price plus a tick; a limit when the bar trades back to it, the same
  * a stop or target fills at its price minus a tick; the stop is checked
    before the target in a bar; on the bar a LIMIT entry filled, the target
    counts only if the bar also closed beyond it
  * a stop the bar OPENS through fills at the open (minus a tick)
  * a market order fills at the current price -- the bar's open -- less a tick
  * $0.75 a side; the day-limit stop (the bot tags it) is booked at exactly
    what is left of the day's $600, as the firm's daily-loss limit would
  * a stop on the wrong side of the market is refused; bracket objects are
    refused (the account is in Position Brackets mode)
"""

from __future__ import annotations

import bisect
import json
import math
import tempfile
from collections import Counter, deque
from datetime import datetime, timezone
from pathlib import Path

import httpx

import donchian1250_core as core
import mnq_donchian1250_bot as botmod

PV = 2.0
BRACKET_MSG = "Brackets cannot be used with Position Brackets. You must enable Auto OCO Brackets."


def iso_ms(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()


class Clock:
    def __init__(self, t: float):
        self.t = t

    def now(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.t += s


class FakeGateway:
    ACCOUNT = {"id": 4711, "name": "TEST_1250", "balance": 50000.0, "canTrade": True, "isVisible": True}
    CONTRACT = {"id": "CON.F.US.MNQ.Z26", "name": "MNQZ6", "description": "Micro E-mini Nasdaq-100: December 2026",
                "tickSize": 0.25, "tickValue": 0.5, "activeContract": True, "symbolId": "F.US.MNQ"}

    def __init__(self, rows, clock: Clock, slip=0.25, fee=0.75, cap=600.0):
        self.rows, self.ts = rows, [r[0] for r in rows]
        self.clock = clock
        self.slip, self.fee, self.cap = slip, fee, cap
        self.orders: dict = {}
        self.trades: list = []
        self.pos, self.qty, self.avg = 0, 0, 0.0
        self.pos_since, self.pos_fees, self.pos_entry_limit, self.pos_entry_bucket = None, 0.0, False, None
        self.price = None
        self.nid, self.tid = 9000, 70000
        self.calls = Counter()
        self.call_times = {"hist": deque(), "other": deque()}
        self.max_rate = {"hist": 0, "other": 0}
        self.brackets_seen = 0
        self.tags = set()
        self.dup_tags = 0
        # test hooks
        self.refuse_stops = 0          # refuse the next n stop orders
        self.split_next_entry = 0      # fill the next entry in two parts: this many contracts first, then stop
        self.fill_next_cancel = False     # the next ENTRY order cancelled fills (at its price) instead
        self.on_open = None               # f(fake, bar, first_ms) as each bar opens

    # ---- HTTP ----
    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body = json.loads(request.content.decode() or "{}")
        self.calls[path] += 1
        now = self.clock.now()
        kind = "hist" if path == "/api/History/retrieveBars" else "other"
        win = 30.0 if kind == "hist" else 60.0
        q = self.call_times[kind]
        q.append(now)
        while q and q[0] < now - win:
            q.popleft()
        self.max_rate[kind] = max(self.max_rate[kind], len(q))
        if path != "/api/Auth/loginKey" and request.headers.get("Authorization") != "Bearer T":
            return httpx.Response(401)
        fn = {
            "/api/Auth/loginKey": self._login, "/api/Auth/validate": self._validate,
            "/api/Account/search": lambda b: self._ok(accounts=[dict(self.ACCOUNT)]),
            "/api/Contract/search": lambda b: self._ok(contracts=[dict(self.CONTRACT)]),
            "/api/Contract/searchById": lambda b: self._ok(
                contract=dict(self.CONTRACT) if b.get("contractId") == self.CONTRACT["id"] else None),
            "/api/History/retrieveBars": self._bars,
            "/api/Order/place": self._place, "/api/Order/cancel": self._cancel, "/api/Order/modify": self._modify,
            "/api/Order/searchOpen": lambda b: self._ok(orders=[self._pub(o) for o in self.orders.values() if o["status"] == 1]),
            "/api/Order/search": lambda b: self._ok(orders=[self._pub(o) for o in self.orders.values()]),
            "/api/Position/searchOpen": self._positions, "/api/Position/closeContract": self._close,
            "/api/Trade/search": self._trades,
        }.get(path)
        if fn is None:
            return httpx.Response(404)
        return httpx.Response(200, json=fn(body))

    @staticmethod
    def _ok(**kw):
        return {**kw, "success": True, "errorCode": 0, "errorMessage": None}

    @staticmethod
    def _err(code, msg=None, **kw):
        return {**kw, "success": False, "errorCode": code, "errorMessage": msg}

    def _login(self, b):
        if not b.get("userName") or not b.get("apiKey"):
            return self._err(3, token=None)
        return {"token": "T", "success": True, "errorCode": 0, "errorMessage": None}

    def _validate(self, b):
        return self._ok(newToken="T")

    def _bars(self, b):
        assert b["unit"] == 2 and b["unitNumber"] == 1 and b["limit"] <= 20000
        now = self.clock.now() * 1000
        start, end = botmod.parse_ts(b["startTime"]), botmod.parse_ts(b["endTime"])
        lo, hi = bisect.bisect_left(self.ts, start), bisect.bisect_left(self.ts, min(end, now + 1))
        out = []
        for t, o, h, l, c, v in self.rows[lo:hi]:
            if t + 60_000 <= now:
                out.append({"t": iso_ms(t), "o": o, "h": h, "l": l, "c": c, "v": v})
            elif b["includePartialBar"]:
                out.append({"t": iso_ms(t), "o": o, "h": o, "l": o, "c": o, "v": 1})   # just opened
        assert len(out) <= b["limit"]
        out.reverse()                                             # newest first, as the docs' example
        return self._ok(bars=out)

    def _pub(self, o):
        return {k: v for k, v in o.items() if not k.startswith("_")}

    def _place(self, b):
        self.nid += 1
        oid = self.nid
        if b.get("stopLossBracket") or b.get("takeProfitBracket"):
            self.brackets_seen += 1
            return self._err(2, BRACKET_MSG, orderId=oid)
        tag = b.get("customTag")
        if tag is not None:
            if tag in self.tags:
                self.dup_tags += 1
                return self._err(2, "customTag must be unique", orderId=oid)
            self.tags.add(tag)
        t, side, size = b["type"], b["side"], int(b["size"])
        d = 1 if side == 0 else -1
        now = self.clock.now() * 1000
        if t == 4:
            p = b["stopPrice"]
            if self.refuse_stops > 0 and self.qty == 0:
                self.refuse_stops -= 1
                return self._err(2, "Invalid stop price", orderId=oid)
            if self.price is not None and ((d == 1 and p <= self.price) or (d == -1 and p >= self.price)):
                return self._err(2, "Invalid stop price", orderId=oid)
        o = {"id": oid, "accountId": b["accountId"], "contractId": b["contractId"], "symbolId": "F.US.MNQ",
             "creationTimestamp": iso_ms(now), "updateTimestamp": iso_ms(now), "status": 1, "type": t, "side": side,
             "size": size, "limitPrice": b.get("limitPrice"), "stopPrice": b.get("stopPrice"), "fillVolume": 0,
             "filledPrice": None, "customTag": tag, "_ms": now}
        self.orders[oid] = o
        if t == 2:
            self._fill(o, self.price + d * self.slip, now)
        return self._ok(orderId=oid)

    def _cancel(self, b):
        o = self.orders.get(b["orderId"])
        if o is None or o["status"] != 1:
            return self._err(2)
        if self.fill_next_cancel and "entry" in str(o.get("customTag")) and self.qty == 0:
            self.fill_next_cancel = False
            d = 1 if o["side"] == 0 else -1
            p = o["stopPrice"] if o["type"] == 4 else o["limitPrice"]
            self._fill(o, p + d * self.slip, self.clock.now() * 1000 - 1)
            return self._err(2)
        o["status"] = 3
        o["updateTimestamp"] = iso_ms(self.clock.now() * 1000)
        return self._ok()

    def _modify(self, b):
        o = self.orders.get(b["orderId"])
        if o is None or o["status"] != 1:
            return self._err(2)
        for k_in, k_out in (("size", "size"), ("limitPrice", "limitPrice"), ("stopPrice", "stopPrice")):
            if b.get(k_in) is not None:
                o[k_out] = b[k_in]
        return self._ok()

    def _positions(self, b):
        if self.qty == 0:
            return self._ok(positions=[])
        return self._ok(positions=[{"id": 1, "accountId": b["accountId"], "contractId": self.CONTRACT["id"],
                                    "creationTimestamp": iso_ms(self.pos_since), "type": 1 if self.pos == 1 else 2,
                                    "size": self.qty, "averagePrice": self.avg}])

    def _close(self, b):
        if self.qty == 0:
            return self._err(2)
        now = self.clock.now() * 1000
        self.nid += 1
        o = {"id": self.nid, "accountId": b["accountId"], "contractId": b["contractId"], "symbolId": "F.US.MNQ",
             "creationTimestamp": iso_ms(now), "updateTimestamp": iso_ms(now), "status": 1, "type": 2,
             "side": 1 if self.pos == 1 else 0, "size": self.qty, "limitPrice": None, "stopPrice": None,
             "fillVolume": 0, "filledPrice": None, "customTag": None, "_ms": now}
        self.orders[o["id"]] = o
        self._fill(o, self.price - self.pos * self.slip, now)
        return self._ok()

    def _trades(self, b):
        start = botmod.parse_ts(b["startTimestamp"])
        return self._ok(trades=[{k: v for k, v in t.items() if k != "_ms"} for t in self.trades if t["_ms"] >= start])

    # ---- matching ----
    def _day_before(self, ms):
        td = core.trading_day(ms)
        return sum((t["profitAndLoss"] or 0.0) - t["fees"] for t in self.trades
                   if t["_ms"] < ms and core.trading_day(t["_ms"]) == td)

    def _fill(self, o, px, ms, qty=None, exact_net=None):
        d = 1 if o["side"] == 0 else -1
        q = int(qty if qty is not None else o["size"] - o["fillVolume"])
        fee = self.fee * q
        pnl = None
        if self.qty == 0 or d == self.pos:
            if self.qty == 0:
                self.pos_since, self.pos_fees = ms, 0.0
            self.avg = (self.avg * self.qty + px * q) / (self.qty + q)
            self.qty += q
            self.pos = d
            self.pos_fees += fee
        else:
            q = min(q, self.qty)
            fee = self.fee * q
            pnl = (px - self.avg) * self.pos * PV * q
            if exact_net is not None:
                pnl = exact_net + self.pos_fees + fee
            self.qty -= q
            if self.qty == 0:
                self.pos = 0
        self.tid += 1
        self.trades.append({"id": self.tid, "accountId": self.ACCOUNT["id"], "contractId": self.CONTRACT["id"],
                            "creationTimestamp": iso_ms(ms), "price": px, "profitAndLoss": pnl, "fees": fee,
                            "side": o["side"], "size": q, "voided": False, "orderId": o["id"], "_ms": ms})
        o["fillVolume"] += q
        o["filledPrice"] = px
        o["updateTimestamp"] = iso_ms(ms)
        if o["fillVolume"] >= o["size"]:
            o["status"] = 2

    def _working(self, reduce: bool):
        out = []
        for o in self.orders.values():
            if o["status"] != 1:
                continue
            d = 1 if o["side"] == 0 else -1
            if (self.qty > 0 and d == -self.pos) == reduce:
                out.append(o)
        return sorted(out, key=lambda o: o["id"])

    def _exact(self, o):
        if "-cap" in str(o.get("customTag") or ""):
            return -self.cap - self._day_before(self.pos_since)
        return None

    def open_bar(self, bar: core.Bar, first_ms: float) -> None:
        """The bar opens: a stop the open is through fills at the open."""
        self.price = bar.o
        if self.on_open:
            self.on_open(self, bar, first_ms)
        if self.qty:
            for o in self._working(reduce=True):
                if o["type"] == 4 and ((self.pos == 1 and bar.o <= o["stopPrice"]) or (self.pos == -1 and bar.o >= o["stopPrice"])):
                    self._fill(o, bar.o - self.pos * self.slip, first_ms, exact_net=self._exact(o))
                    break

    def run_bar(self, bar: core.Bar, first_ms: float, react) -> None:
        """The bar trades: the engine's order of events, the bot reacting to each fill."""
        t_in = min(first_ms + 30_000, bar.ts + 119_000)
        t_out = min(first_ms + 90_000, bar.ts + 119_500)
        if self.qty == 0:
            for o in self._working(reduce=False):
                d = 1 if o["side"] == 0 else -1
                p = o["stopPrice"] if o["type"] == 4 else o["limitPrice"]
                if o["type"] == 4:
                    hit = bar.h >= p if d == 1 else bar.l <= p
                else:
                    hit = bar.l <= p if d == 1 else bar.h >= p
                if hit:
                    self.price = p
                    q = None
                    if self.split_next_entry:
                        q, self.split_next_entry = self.split_next_entry, 0
                    self._fill(o, p + d * self.slip, t_in, qty=q)
                    self.pos_entry_limit, self.pos_entry_bucket = o["type"] == 1, bar.ts
                    react(t_in + 500)
                    break
        if not self.qty:
            return
        d = self.pos
        fill_bar = self.pos_entry_bucket == bar.ts
        legs = self._working(reduce=True)
        sl = next((o for o in legs if o["type"] == 4), None)
        tp = next((o for o in legs if o["type"] == 1), None)
        if sl is not None:
            s = sl["stopPrice"]
            if fill_bar and ((bar.o <= s) if d == 1 else (bar.o >= s)):
                self.price = bar.o
                self._fill(sl, bar.o - d * self.slip, t_out, exact_net=self._exact(sl))
                react(t_out + 500)
                return
            if (bar.l <= s) if d == 1 else (bar.h >= s):
                self.price = s
                self._fill(sl, s - d * self.slip, t_out, exact_net=self._exact(sl))
                react(t_out + 500)
                return
        if tp is not None:
            t = tp["limitPrice"]
            hit = (bar.h >= t) if d == 1 else (bar.l <= t)
            if hit and not (fill_bar and self.pos_entry_limit and ((bar.c < t) if d == 1 else (bar.c > t))):
                self.price = t
                self._fill(tp, t - d * self.slip, t_out)
                react(t_out + 500)
        self.price = bar.c


# ── the replay ────────────────────────────────────────────────────────────────
def replay(rows, from_tday, to_tday=None, cfg=None, hooks=None, state_dir=None, restart_at=None):
    """Run the bot through the bars of [from_tday, to_tday] against FakeGateway.
    Returns (bot, fake). restart_at: a bar timestamp at which the bot is stopped
    and a NEW bot started from its state file (a restart mid-session)."""
    bars = core.aggregate_2m(rows)
    k0 = next(q for q, b in enumerate(bars) if b.tday >= from_tday)
    k1 = len(bars) if to_tday is None else next((q for q, b in enumerate(bars) if b.tday > to_tday), len(bars))
    firsts = {}
    for r in rows:
        firsts.setdefault(math.floor(r[0] / core.BUCKET_MS) * core.BUCKET_MS, r[0])
    clock = Clock(bars[k0].ts / 1000 - 1.0)
    fake = FakeGateway(rows, clock)
    if hooks:
        hooks(fake)
    tmp = tempfile.TemporaryDirectory() if state_dir is None else None
    path = Path(state_dir or tmp.name) / "state.json"
    # The test's own account and contract, whatever CONFIG names for live trading
    # (those are checked against the real gateway by `mnq_donchian1250_bot.py --check`).
    cfg = {"round_to_tick": False, **(cfg or {}), "account_name": FakeGateway.ACCOUNT["name"], "contract_id": ""}

    def new_bot():
        api = botmod.ProjectX("tester", "key", base="https://gateway.test", transport=httpx.MockTransport(fake.handler),
                              clock=clock.now, sleep=clock.sleep)
        b = botmod.Bot(api, cfg=cfg, clock=clock.now, sleep=clock.sleep, state_path=path)
        b.start()
        return b

    b = new_bot()
    bots = [b]
    for q in range(k0, k1):
        bar = bars[q]
        f = firsts[bar.ts]
        if restart_at is not None and bar.ts == restart_at:
            clock.t = f / 1000 - 0.5
            b = new_bot()
            bots.append(b)
        clock.t = f / 1000 + 1.0
        fake.open_bar(bar, f)
        b.on_boundary(bar.ts)

        def react(ms, b=b):
            clock.t = ms / 1000
            b.poll()
        fake.run_bar(bar, f, react)
    end = bars[k1 - 1].ts + core.BUCKET_MS
    clock.t = end / 1000 + 1.0
    b.on_boundary(end)
    if tmp is not None:
        tmp.cleanup()
    b.all_events = [e for x in bots for e in x.events]
    return b, fake


def bot_trades(events):
    """The bot's trades in the engine's terms."""
    out, ent = [], None
    for e in events:
        if e["kind"] == "fill":
            ent = e
        elif e["kind"] == "exit" and ent is not None:
            why = {"TIME": "XSIG"}.get(e["why"], e["why"])
            out.append({"entTs": ent["bucket"], "xTs": e["bucket"], "dir": ent["dir"], "lots": e["lots"], "avg": ent["px"],
                        "pnl": e["net"], "why": why, "tday": core.trading_day(e["ms"])})
            ent = None
    return out


def compare(mine, theirs, tol=1e-6):
    same, first = 0, None
    for a, b in zip(mine, theirs):
        ok = (a["entTs"] == b["entTs"] and a["xTs"] == b["xTs"] and a["dir"] == b["dir"] and a["lots"] == b["lots"]
              and a["why"] == b["why"] and abs(a["avg"] - b["avg"]) < 1e-6 and abs(a["pnl"] - b["pnl"]) < tol)
        same += ok
        if not ok and first is None:
            first = (a, b)
    return same, first


def run_all(meta, rows, check, pass_rates, quick=False):
    first26 = meta["first2026"]
    start = meta["days2026"][-20] if quick else first26
    theirs = [t for t in meta["trades"] if t["tday"] >= start]

    print("\n5. THE BOT ITSELF " + ("over the last 20 sessions (--quick; the full run covers all of 2026)" if quick else "through 2026")
          + ", against a simulated ProjectX gateway that fills like the engine")
    import time
    t0 = time.time()
    b, fake = replay(rows, start)
    mine = [t for t in bot_trades(b.all_events) if t["tday"] >= start]
    same, first = compare(mine, theirs)
    check("every trade the bot made: entry and exit bar, direction, size, fill, exit reason, dollars",
          same == len(theirs) == len(mine),
          f"{same} of {len(theirs)} identical (bot {len(mine)}, {time.time() - t0:.0f}s)"
          + (f"\n        first difference: bot {first[0]}\n                          engine {first[1]}" if first else ""))
    if not quick:
        pr, want = pass_rates(mine, meta), meta["pass2026"]
        check("2026 pass rate from the bot's own trades = the research's",
              all(abs(pr[k] - want[k]) < 1e-9 for k in ("y", "a", "b", "real")),
              f"{pr['y']:.1f}% (Jan-Mar {pr['a']:.1f}, Apr-Jul {pr['b']:.1f}), real windows {pr['real']:.1f}%")
    led = {}
    for t in fake.trades:
        td = core.trading_day(t["_ms"])
        led[td] = led.get(td, 0.0) + (t["profitAndLoss"] or 0.0) - t["fees"]
    booked = {}
    for t in mine:
        booked[t["tday"]] = booked.get(t["tday"], 0.0) + t["pnl"]
    worst = max(abs(led.get(d, 0.0) - booked.get(d, 0.0)) for d in set(led) | set(booked))
    check("the gateway's own ledger = what the bot booked, every day", worst < 1e-6, f"largest difference ${worst:.6f}")
    check("never sent a bracket object (they are refused in Position Brackets mode)", fake.brackets_seen == 0)
    check("every customTag unique across the account", fake.dup_tags == 0, f"{len(fake.tags)} tags")
    check("within the documented rate limits (History 50 per 30s, others 200 per 60s)",
          fake.max_rate["hist"] <= 50 and fake.max_rate["other"] <= 200,
          f"busiest: {fake.max_rate['hist']} History calls in 30s, {fake.max_rate['other']} others in 60s; "
          f"{sum(fake.calls.values()):,} calls in all")
    left = [o for o in fake.orders.values() if o["status"] == 1]
    check("nothing left working, no position left open at the end", not left and fake.qty == 0,
          f"{len(left)} orders, {fake.qty} contracts")
    by = Counter(t["why"] for t in mine)
    print("        exits: " + ", ".join(f"{k} {v}" for k, v in by.most_common()))
    if quick:
        print("\n6. THE LIVE ORDER PATH where the replay cannot reach")
        scenario_tests(rows, meta, theirs, check, b.all_events)
        return

    print("\n   ...with orders on the tick grid, as live (the only change: prices rounded to 0.25)")
    t0 = time.time()
    b2, fake2 = replay(rows, first26, cfg={"round_to_tick": True})
    mine2 = [t for t in bot_trades(b2.all_events) if t["tday"] >= first26]
    same_bars = sum(1 for a, c in zip(mine2, theirs) if a["entTs"] == c["entTs"] and a["xTs"] == c["xTs"]
                    and a["why"] == c["why"] and a["lots"] == c["lots"])
    pr2 = pass_rates(mine2, meta)
    drift = sum(a["pnl"] for a in mine2) - sum(c["pnl"] for c in theirs)
    off_grid = sum(1 for o in fake2.orders.values() for k in ("limitPrice", "stopPrice")
                   if o.get(k) is not None and abs(o[k] / 0.25 - round(o[k] / 0.25)) > 1e-9)
    check("live rounding: every order on the 0.25 grid", off_grid == 0, f"{off_grid} off the grid")
    check("live rounding: the same trades on the same bars, for the same reasons", same_bars == len(theirs) == len(mine2),
          f"{same_bars} of {len(theirs)}; dollars {drift:+.2f} over 2026 against the engine ({time.time() - t0:.0f}s)")
    print(f"        2026 pass rate with rounded orders: {pr2['y']:.1f}% (Jan-Mar {pr2['a']:.1f}, Apr-Jul {pr2['b']:.1f}), "
          f"real windows {pr2['real']:.1f}%")

    print("\n6. THE LIVE ORDER PATH where the replay cannot reach")
    scenario_tests(rows, meta, theirs, check, b.all_events)


def scenario_tests(rows, meta, theirs, check, events):
    first26 = meta["first2026"]
    # pick days from the engine's trades
    by_day = {}
    for t in theirs:
        by_day.setdefault(t["tday"], []).append(t)
    plain_day = next(d for d, ts in by_day.items() if ts[0]["why"] in ("TP", "SL", "SLcap", "XSIG"))

    # a) a stop refused at placement -> market order (on a day whose first order was a stop that filled)
    stop_day = None
    for q, e in enumerate(events):
        if e["kind"] == "order" and not e.get("limit") and q + 1 < len(events) and events[q + 1]["kind"] == "fill":
            stop_day = core.trading_day(e["ms"])
            break
    if stop_day is None:
        print("  (skipped: no day in the replayed span opened with a stop entry)")
        stop_day = plain_day
    b, fake = replay(rows, stop_day, stop_day, hooks=lambda f: setattr(f, "refuse_stops", 1))
    ev = b.all_events
    mkt = [e for e in ev if e["kind"] == "order" and e.get("market")]
    fills = [e for e in ev if e["kind"] == "fill"]
    tags = [str(o.get("customTag")) for o in fake.orders.values()]
    first_legs = [t for t in tags if t.endswith("-sl") or t.endswith("-sl-cap") or t.endswith("-tp")][:2]
    check("a refused entry stop (the market got there first) goes in at MARKET and gets its stop and target",
          len(mkt) == 1 and len(fills) >= 1 and len(first_legs) == 2 and fake.qty == 0,
          f"{len(mkt)} market entry, {len(fills)} fills, legs {first_legs}, flat at the end: {fake.qty == 0}")

    # b) an entry that fills in part: the rest is cancelled, the legs sized to what filled
    b, fake = replay(rows, plain_day, plain_day, hooks=lambda f: setattr(f, "split_next_entry", 1))
    first_fill = next((e for e in b.all_events if e["kind"] == "fill"), None)
    entries = [o for o in fake.orders.values() if o["type"] in (1, 4) and "entry" in str(o.get("customTag"))]
    legs = [o for o in fake.orders.values() if ("-sl" in str(o.get("customTag")) or "-tp" in str(o.get("customTag")))]
    check("a partly filled entry: the rest is cancelled, the stop and target cover just what filled",
          first_fill is not None and first_fill["lots"] == 1 and any(o["status"] == 3 for o in entries)
          and legs and all(o["size"] == 1 for o in legs[:2]) and fake.qty == 0,
          f"filled {first_fill['lots'] if first_fill else 0}, legs sized {[o['size'] for o in legs[:2]]}, flat {fake.qty == 0}")

    # c) an entry the strategy cancels fills before the cancel lands: closed at once, counted for the day
    # (a day on which the bot cancelled a working entry, from section 5)
    cancel_day = None
    for e in events:
        if e["kind"] == "order":
            last_order_day = core.trading_day(e["ms"])
        if e["kind"] == "close":
            continue
    cancels = [e for e in events if e["kind"] == "order"]
    days_with_orders = sorted({core.trading_day(e["ms"]) for e in cancels})
    fills_by_day = Counter(core.trading_day(e["ms"]) for e in events if e["kind"] == "fill")
    orders_by_day = Counter(core.trading_day(e["ms"]) for e in cancels)
    cancel_day = next((d for d in days_with_orders if orders_by_day[d] > fills_by_day[d]), None)
    if cancel_day is not None:
        b, fake = replay(rows, cancel_day, cancel_day, hooks=lambda f: setattr(f, "fill_next_cancel", True))
        late = [e for e in b.all_events if e["kind"] == "late_fill"]
        closed = [e for e in b.all_events if e["kind"] == "late_closed"]
        check("an entry that fills as it is being cancelled is closed at once and its dollars count for the day",
              len(late) == 1 and len(closed) == 1 and fake.qty == 0 and abs(b.strat.day_real - sum(
                  (t["profitAndLoss"] or 0) - t["fees"] for t in fake.trades if core.trading_day(t["_ms"]) == cancel_day)) < 1e-6,
              f"late fills {len(late)}, closed {len(closed)}, day {b.strat.day_real:+.2f}")
    else:
        check("an entry that fills as it is being cancelled (no cancelled entry found to test)", False)

    # d) a restart with a trade open: the trade, its stop and its target carry on; same result
    long_trade = next(t for t in theirs if t["xTs"] - t["entTs"] >= 6 * core.BUCKET_MS)
    d0 = long_trade["tday"]
    restart = long_trade["entTs"] + 3 * core.BUCKET_MS
    with tempfile.TemporaryDirectory() as tmpd:
        b, fake = replay(rows, d0, d0, state_dir=tmpd, restart_at=restart)
    mine = bot_trades(b.all_events)
    eng = [t for t in theirs if t["tday"] == d0]
    same, _ = compare(mine, eng)
    check("a restart with a trade open picks up the trade, its stop and target, and ends the day like the engine",
          same == len(eng) == len(mine) and fake.qty == 0,
          f"{same} of {len(eng)} trades that day identical across the restart")

    # e) a position nobody placed (a manual trade, a platform bracket) is found and closed
    d1 = plain_day
    noon = {}

    def stray(f):
        def on_open(fake, bar, first_ms):
            if not noon and bar.ct >= 12 * 60 and fake.qty == 0 and not any(o["status"] == 1 for o in fake.orders.values()):
                fake.nid += 1
                o = {"id": fake.nid, "accountId": fake.ACCOUNT["id"], "contractId": fake.CONTRACT["id"], "symbolId": "F.US.MNQ",
                     "creationTimestamp": iso_ms(first_ms), "updateTimestamp": iso_ms(first_ms), "status": 1, "type": 2,
                     "side": 0, "size": 3, "limitPrice": None, "stopPrice": None, "fillVolume": 0, "filledPrice": None,
                     "customTag": None, "_ms": first_ms}
                fake.orders[o["id"]] = o
                fake._fill(o, bar.o, first_ms - 1)
                noon["ms"] = first_ms
        f.on_open = on_open
    b, fake = replay(rows, d1, d1, hooks=stray)
    closes = [e for e in b.all_events if e["kind"] == "close" and e["why"] in ("UNKNOWN", "LATE")]
    within = closes and closes[0]["ms"] - noon.get("ms", 0) <= 12 * 60_000
    day = sum((t["profitAndLoss"] or 0) - t["fees"] for t in fake.trades if core.trading_day(t["_ms"]) == d1)
    check("a position the bot did not open (a manual trade) is found and closed within minutes, its dollars counted",
          bool(noon) and bool(within) and fake.qty == 0 and abs(b.strat.day_real - day) < 1e-6,
          f"closed {(closes[0]['ms'] - noon['ms']) / 60000:.0f} min later" if closes and noon else "not closed")
