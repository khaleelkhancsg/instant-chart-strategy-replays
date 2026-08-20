#!/usr/bin/env python3
"""
The same bot, but it tells YOU what to do instead of doing it.

    python bot/mnq_signal_bot.py

WHY IT IS A WRAPPER AND NOT A COPY
Every decision here comes from mnq_donchian_bot -- the same signal, the same
levels, the same sizing, the same ORB arm timing, the same daily blocks. This
file imports that module and replaces ONLY the execution layer. There is no
second copy of the strategy to drift out of step, and the parity tests that
cover the live bot cover this one for free.

The seam is the API object. DonchianBot talks to `self.api` through eleven
methods; six of them read and five of them write. SignalClient passes the six
reads straight through to the real TopstepX client -- so balances, bars and,
crucially, YOUR MANUALLY OPENED POSITIONS are all real -- and turns the five
writes into notifications.

That last part matters more than it sounds. Because positions are read from the
live account, the bot sees your fill when you place the order yourself. The ORB
five-minute clock, the 15:04 flatten, the exclusivity between the two books and
the daily loss tracking all run off what you actually did, not off a simulation.
If you skip a signal, nothing breaks: the bot sees flat and carries on.

WHAT IT WILL NOT DO
It never sends an order, never cancels one, never closes a position. If the
platform needs to be touched, you touch it.

NOTIFICATIONS
Console banner and a beep always. Set MNQ_NOTIFY_WEBHOOK to a Discord, Slack or
ntfy.sh URL to get them on your phone, which is the only channel that helps if
you are not at the desk -- the ORB gives you about ninety seconds.

    setx MNQ_NOTIFY_WEBHOOK "https://ntfy.sh/your-private-topic"

Credentials are the same as the live bot's and still come from bot/.env.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import mnq_donchian_bot as engine                                # noqa: E402
from mnq_donchian_bot import CONFIG, TICK, log                   # noqa: E402

WEBHOOK = os.environ.get("MNQ_NOTIFY_WEBHOOK", "").strip()
# How often to repeat "you are still in a position that should be closed".
NAG_EVERY_S = 30.0
# Minutes between "still online" pings. 0 turns them off.
HEARTBEAT_MIN = int(os.environ.get("MNQ_HEARTBEAT_MIN", "60"))


# ─────────────────────────────────────────────────────────────
#  GETTING YOUR ATTENTION
# ─────────────────────────────────────────────────────────────
def _beep(pattern: str = "entry") -> None:
    """Non-blocking. Silence is not an error -- headless boxes have no beeper."""
    def go():
        try:
            import winsound
            tones = {"entry": [(880, 140), (1320, 220)],
                     "exit": [(660, 140), (440, 260)],
                     "cancel": [(520, 90), (520, 90)]}.get(pattern, [(880, 200)])
            for freq, ms in tones:
                winsound.Beep(freq, ms)
        except Exception:
            try:
                sys.stdout.write("\a")
                sys.stdout.flush()
            except Exception:
                pass
    threading.Thread(target=go, daemon=True).start()


def _push(title: str, body: str, priority: str = "default") -> None:
    """Best-effort phone push. Never raises, never blocks the trading loop.

    Priority is not decoration. Trade alerts go out urgent so they break through
    Do Not Disturb; the hourly heartbeat goes out low, because an alert that
    buzzes every hour through the night is one you mute -- and a muted channel
    loses you the 08:30 ORB, which is the whole reason the channel exists.
    """
    if not WEBHOOK:
        return

    url, payload = push_payload(WEBHOOK, title, body, priority)

    def go():
        try:
            import httpx
            httpx.post(url, json=payload, timeout=8)
        except Exception as exc:
            log.warning("notification webhook failed: %s", exc)
    threading.Thread(target=go, daemon=True).start()


# ntfy priority is numeric over JSON: 1 min, 2 low, 3 default, 4 high, 5 max.
_NTFY_PRIORITY = {"min": 1, "low": 2, "default": 3, "high": 4, "urgent": 5}


def push_payload(webhook: str, title: str, body: str, priority: str):
    """Build (url, json) for the webhook. Pure, so it can be tested offline.

    ntfy's header-based API takes the title in an HTTP header, and HTTP headers
    are ASCII — so a title starting with an emoji fails to encode and the push is
    silently lost. Every title here starts with one. Its JSON endpoint takes the
    whole message as a UTF-8 body instead, which is why this posts to the base
    URL with the topic in the payload rather than to the topic URL.
    """
    if "ntfy" in webhook:
        base, _, topic = webhook.rstrip("/").rpartition("/")
        return base or "https://ntfy.sh", {
            "topic": topic,
            "title": title,
            "message": body,
            "priority": _NTFY_PRIORITY.get(priority, 3),
        }
    # Discord and Slack both take a JSON body, so Unicode was never a problem
    # there; sending both keys lets one URL serve either.
    return webhook, {"content": f"**{title}**\n```\n{body}\n```",
                     "text": f"*{title}*\n```\n{body}\n```"}


def _cols(text: str) -> int:
    """Rendered width. Emoji and CJK occupy two terminal columns but count once
    in len(), which is what makes an otherwise fine box come out ragged."""
    import unicodedata
    n = 0
    for ch in text:
        if unicodedata.combining(ch):
            continue
        n += 2 if (unicodedata.east_asian_width(ch) in "WF" or ch >= "\U0001F300") else 1
    return n


def notify(title: str, lines: List[str], pattern: Optional[str] = "entry",
           priority: str = "default") -> None:
    """pattern=None stays silent locally — used by the heartbeat, which should
    reach the phone without making a noise in the room every hour.

    PRIORITY POLICY, because it decides whether an alert is useful or ignored:
      high     something must be done NOW — place it, cancel it, close it
      default  something happened and you want to know — fills, exits, startup
      low      the heartbeat, which must never train you to swipe alerts away
    Nothing uses ntfy's max/urgent level. That one is for a fire alarm, and an
    alert that overrides every phone setting is one you eventually silence.
    """
    body = "\n".join(lines)
    width = max(62, max((_cols(x) for x in lines + [title]), default=0) + 4)

    def pad(t: str) -> str:
        return t + " " * max(0, width - 1 - _cols(t))
    bar = "━" * width
    log.info("\n┏%s┓\n┃ %s┃\n┣%s┫\n%s\n┗%s┛",
             bar, pad(title), bar,
             "\n".join("┃ " + pad(x) + "┃" for x in lines), bar)
    if pattern:
        _beep(pattern)
    _push(title, body, priority)


def _px(v: Optional[float]) -> str:
    return "?" if v is None else f"{v:,.2f}"


# Which book asked for this. The two behave completely differently once filled
# -- the ORB is out in five minutes, the donchian can run to the 15:04 flatten
# -- so knowing which one is looking at you decides how you manage it.
_BOOKS = {
    "_service_orb": "ORB",
    "_orb_cancel": "ORB",
    "_service_add": "DONCHIAN",
    "_place_entry": "DONCHIAN",
    "_cancel_add": "DONCHIAN",
    "_enforce_flatten": "FLATTEN",
    "_handle_flip": "DONCHIAN",
}


def _book() -> str:
    """Read the call stack for the method that asked. The bot has one call site
    per book, so this is exact rather than a guess -- and it beats threading a
    label through eleven method signatures that exist to mirror a REST client."""
    import inspect
    f = inspect.currentframe()
    seen = 0
    while f is not None and seen < 12:
        name = f.f_code.co_name
        if name in _BOOKS:
            return _BOOKS[name]
        f = f.f_back
        seen += 1
    return "BOT"


# ─────────────────────────────────────────────────────────────
#  THE EXECUTION LAYER, REPLACED
# ─────────────────────────────────────────────────────────────
class SignalClient:
    """Same eleven methods DonchianBot expects. Reads are real; writes talk."""

    def __init__(self, real: engine.TopstepXClient) -> None:
        self._real = real
        self._last_px: Optional[float] = None
        self._next_oid = 900_000
        self._tickets: Dict[int, str] = {}          # synthetic id -> description
        self._nagging: Optional[str] = None
        self._nag_at = 0.0
        # Your fill is invisible to this process until the account shows it, so
        # the transition is watched for rather than assumed.
        self._in_pos = False
        self._fill_bal: Optional[float] = None
        self._fill_at: Optional[datetime] = None

    # ---- reads: straight through -------------------------------------
    async def connect(self) -> None:
        await self._real.connect()

    @property
    def balance(self) -> float:
        return self._real.balance

    async def refresh_balance(self) -> float:
        return await self._real.refresh_balance()

    async def get_bars_1m(self, days: int = 5) -> List[dict]:
        bars = await self._real.get_bars_1m(days=days)
        for b in reversed(bars or []):
            try:
                self._last_px = engine._ohlc(b)[3]
                break
            except Exception:
                continue
        return bars

    async def get_open_positions(self) -> List[dict]:
        pos = await self._real.get_open_positions()
        now = datetime.now(timezone.utc)

        # ---- your fill, and the end of the trade ----------------------
        # The orders are yours, so nothing else in this process knows when one
        # of them actually filled. Watching the account for the transition is
        # the only way to tell you the clock has started -- and for the ORB the
        # clock is the whole trade.
        if pos and not self._in_pos:
            p = pos[0]
            size = p.get("size", "?")
            longish = p.get("type") == 1
            self._in_pos, self._fill_bal, self._fill_at = True, self._real.balance, now
            book = "ORB" if engine.ORB_OPEN_CT <= self._ct() < CONFIG["orb_give_up_ct"] \
                   else "DONCHIAN"
            lines = [f"  {size} MNQ {'LONG' if longish else 'SHORT'} at {_px(p.get('price'))}",
                     "  The bot can see it and is now managing the clock."]
            if book == "ORB":
                out_by = now + timedelta(minutes=CONFIG["orb_max_hold_min"])
                lines += ["",
                          f"  ORB time stop at {out_by.astimezone(engine.CT_TZ):%H:%M:%S} CT "
                          f"({CONFIG['orb_max_hold_min']} min) — out at market then.",
                          "  CANCEL THE OTHER SIDE if you have not already."]
            else:
                lines += ["", "  Runs to its bracket, or the 15:04 CT flatten."]
            notify(f"✅ {book} — FILLED, YOU ARE IN", lines, "entry")
        elif not pos and self._in_pos:
            self._in_pos = False
            pnl = self._real.balance - (self._fill_bal or self._real.balance)
            held = (now - self._fill_at).total_seconds() / 60.0 if self._fill_at else 0.0
            notify("⬜ FLAT — TRADE IS DONE",
                   [f"  realised   ${pnl:+,.2f}",
                    f"  held       {held:.1f} min",
                    f"  balance    ${self._real.balance:,.2f}",
                    "  Check no bracket legs are still working."],
                   "cancel")
            self._nagging = None

        # If we asked for a close and the position is still there, keep saying so.
        if self._nagging and pos:
            if now.timestamp() >= self._nag_at:
                self._nag_at = now.timestamp() + NAG_EVERY_S
                notify("⚠ STILL OPEN — CLOSE IT",
                       [self._nagging,
                        f"the platform still shows {pos[0].get('size', '?')} lots open.",
                        "This repeats every 30s until the position is flat."],
                       pattern="exit", priority="high")
        elif not pos:
            self._nagging = None
        return pos

    @staticmethod
    def _ct() -> int:
        ct = datetime.now(timezone.utc).astimezone(engine.CT_TZ)
        return ct.hour * 60 + ct.minute

    async def get_open_orders(self) -> List[dict]:
        return await self._real.get_open_orders()

    # ---- writes: notifications ---------------------------------------
    def _oid(self, desc: str) -> int:
        self._next_oid += 1
        self._tickets[self._next_oid] = desc
        return self._next_oid

    async def place_bracket_order(self, side: int, size: int,
                                  sl_ticks: int, tp_ticks: int) -> Optional[int]:
        sgn = 1 if side == 0 else -1
        sl_pts, tp_pts = abs(sl_ticks) * TICK, abs(tp_ticks) * TICK
        ref = self._last_px
        notify(
            f"🚀 {_book()} — ENTER {'LONG' if side == 0 else 'SHORT'} {size} LOTS AT MARKET",
            [f"  MARKET {'BUY' if side == 0 else 'SELL'}   {size} MNQ",
             f"  last traded price   {_px(ref)}",
             "",
             "  bracket, measured FROM YOUR FILL (this is the exact instruction):",
             f"    stop loss     {sl_pts:,.2f} pts {'below' if side == 0 else 'above'} fill"
             + (f"   (~{_px(ref - sgn * sl_pts)})" if ref else ""),
             f"    take profit   {tp_pts:,.2f} pts {'above' if side == 0 else 'below'} fill"
             + (f"   (~{_px(ref + sgn * tp_pts)})" if ref else ""),
             "",
             f"  risk if stopped   ${size * sl_pts * CONFIG['tick_value'] / TICK:,.0f}",
             "  the ~ prices are from the last bar close, not your fill.",
             "  Set the bracket from the price you actually get."],
            "entry", priority="high")
        return self._oid(f"market {'buy' if side == 0 else 'sell'} {size}")

    async def _resting(self, kind: str, side: int, size: int, price: float,
                       sl_ticks: int, tp_ticks: int) -> Optional[int]:
        sgn = 1 if side == 0 else -1
        sl_px = price - sgn * abs(sl_ticks) * TICK
        tp_px = price + sgn * abs(tp_ticks) * TICK
        risk = size * abs(sl_ticks) * TICK * CONFIG["tick_value"] / TICK
        book = _book()
        lines = [f"  {kind.upper()} {'BUY' if side == 0 else 'SELL'}   {size} MNQ",
                 f"    trigger      {_px(price)}",
                 f"    stop loss    {_px(sl_px)}",
                 f"    take profit  {_px(tp_px)}",
                 "",
                 f"  risk if stopped   ${risk:,.0f}"]
        if kind == "stop":
            # 40.8% of arms are refused because price is already through the
            # trigger. The live bot re-places the same price as a LIMIT and that
            # is worth ~2.6pp of pass rate; placing by hand you have to do it.
            lines += ["",
                      "  If the platform REFUSES this stop, price has already gone",
                      "  through the trigger. Place a LIMIT at the SAME price instead",
                      "  — do not chase it with a market order."]
        if book == "ORB":
            lines += ["",
                      f"  ORB: both sides rest. First fill wins — cancel the other.",
                      f"  Time stop {CONFIG['orb_max_hold_min']} min from fill, then out at market."]
        elif book == "DONCHIAN":
            lines += ["", "  Donchian: runs to its bracket or the 15:04 CT flatten."]
        lines.append("  Leave it resting. You will be told when to pull it.")
        notify(f"📋 {book} — {kind.upper()} {'BUY' if side == 0 else 'SELL'} "
               f"{size} LOTS", lines, "entry", priority="high")
        return self._oid(f"{kind} {'buy' if side == 0 else 'sell'} {size} @ {price:.2f}")

    async def place_stop_with_bracket(self, side: int, size: int, stop_price: float,
                                      sl_ticks: int, tp_ticks: int) -> Optional[int]:
        return await self._resting("stop", side, size, stop_price, sl_ticks, tp_ticks)

    async def place_limit_with_bracket(self, side: int, size: int, limit_price: float,
                                       sl_ticks: int, tp_ticks: int) -> Optional[int]:
        return await self._resting("limit", side, size, limit_price, sl_ticks, tp_ticks)

    async def close_position(self) -> bool:
        pos = await self._real.get_open_positions()
        size = pos[0].get("size", "?") if pos else "?"
        msg = f"Close {size} MNQ at market, now."
        notify(f"🔴 {_book()} — CLOSE THE POSITION, MARKET, NOW",                [f"  {msg}",
                "  This is the bot's own exit (time stop, flatten, or a flip).",
                "  It is not the bracket — the bracket stays where it is until",
                "  you cancel it, so cancel any leftover legs afterwards."],
               pattern="exit", priority="high")
        # Reported as done so the bot's state machine advances. Reality is
        # re-read every cycle from the account, and get_open_positions() nags
        # until the position is actually gone.
        self._nagging = msg
        self._nag_at = datetime.now(timezone.utc).timestamp() + NAG_EVERY_S
        return True

    async def cancel_order(self, order_id) -> bool:
        what = self._tickets.pop(order_id, f"order {order_id}")
        notify(f"✖ {_book()} — CANCEL A WORKING ORDER",                [f"  Cancel:  {what}",
                "  It is no longer wanted — the setup expired, filled on the",
                "  other side, or the day's blocks came on."],
               pattern="cancel", priority="high")
        return True


# ─────────────────────────────────────────────────────────────
#  "STILL ONLINE"
# ─────────────────────────────────────────────────────────────
async def heartbeat(api: "SignalClient", bot) -> None:
    """Say the bot is alive, on a wall clock, every HEARTBEAT_MIN minutes.

    Deliberately its own task rather than a check inside the trading loop. The
    failure this exists to catch is the loop STOPPING -- a suspended host, a
    frozen request, a wedged await -- and a heartbeat that rides on the loop
    cannot report a loop that is not running. Running it independently means a
    stall shows up as a heartbeat saying the last bar is two hours old, which is
    a far more useful message than silence.

    Silence still means something: if the process is gone, so are these.
    """
    while True:
        await asyncio.sleep(max(60, HEARTBEAT_MIN * 60))
        try:
            notify("💤 STILL ONLINE", heartbeat_lines(api, bot),
                   pattern=None, priority="low")
        except asyncio.CancelledError:
            raise
        except Exception as exc:                     # never kill the heartbeat
            log.warning("heartbeat failed: %s", exc)


def heartbeat_lines(api: "SignalClient", bot) -> List[str]:
    """The body of one heartbeat. Split out so it can be read without waiting an
    hour, and so the stale-feed branch is directly testable."""
    now = datetime.now(timezone.utc)
    ct = now.astimezone(engine.CT_TZ)
    lines = [f"  {ct:%H:%M} CT   ({ct:%a %d %b})"]

    # Feed freshness is the point. A process that is up but reading a dead feed
    # is the dangerous state, not a comforting one.
    ts = getattr(bot, "_last_bar_ts", None)
    if ts:
        age = (now.timestamp() * 1000 - (ts + 120_000)) / 60_000.0
        lines.append(f"  last bar    {age:.0f} min old"
                     + ("   ⚠ STALE — CHECK IT" if age > 6 else ""))
    else:
        lines.append("  last bar    none seen yet")

    if getattr(bot, "in_position", False):
        owner = getattr(bot, "_pos_owner", None) or "?"
        lines.append(f"  position    IN, {owner.upper()} book")
    else:
        lines.append("  position    flat")

    oids = getattr(bot, "_orb_oids", None)
    if oids:
        lines.append(f"  ORB         {len(oids)} orders should be resting")
    elif getattr(bot, "_orb_done", False):
        lines.append("  ORB         done for today")
    elif ct.hour * 60 + ct.minute < engine.ORB_OPEN_CT:
        lines.append("  ORB         waiting for 08:30 CT")

    day0 = getattr(bot, "_day_start_balance", None)
    bal = api.balance
    if day0:
        lines.append(f"  day P&L     ${bal - day0:+,.2f}")
    lines.append(f"  balance     ${bal:,.2f}")
    return lines


# ─────────────────────────────────────────────────────────────
async def main() -> None:
    if not os.environ.get("PROJECT_X_API_KEY") or not os.environ.get("PROJECT_X_USERNAME"):
        raise EnvironmentError("Set PROJECT_X_API_KEY and PROJECT_X_USERNAME (bot/.env)")

    log.info("=" * 62)
    log.info("SIGNAL MODE — this process places NOTHING. You do the clicking.")
    log.info("  strategy      identical to mnq_donchian_bot (imported, not copied)")
    log.info("  positions     read from the live account, so it sees YOUR fills")
    log.info("  phone push    %s", WEBHOOK.split("/")[-1] if WEBHOOK else
             "off — set MNQ_NOTIFY_WEBHOOK to enable")
    log.info("  heartbeat     %s",
             ("every %d min, low priority" % HEARTBEAT_MIN) if HEARTBEAT_MIN > 0
             else "off (MNQ_HEARTBEAT_MIN=0)")
    log.info("  ORB fires within ~2 minutes of 08:30 CT and is done by ~08:37.")
    log.info("=" * 62)

    attempt = 0
    while True:
        attempt += 1
        if attempt > 1:
            log.info("🔄 reconnect #%d in 30s ...", attempt)
            await asyncio.sleep(30)
        real = engine.TopstepXClient()
        api = SignalClient(real)
        bot = engine.DonchianBot(api)
        try:
            await api.connect()
            notify("✅ SIGNAL BOT LIVE", [
                f"  account balance   ${api.balance:,.2f}",
                f"  contract          {CONFIG['contract_id']}",
                "  Watching. Nothing will be placed for you."], "cancel")
            hb = asyncio.create_task(heartbeat(api, bot)) if HEARTBEAT_MIN > 0 else None
            try:
                await bot.run()
            finally:
                if hb:
                    hb.cancel()
            break
        except asyncio.CancelledError:
            log.info("Cancelled.")
            raise
        except Exception as exc:
            log.exception("fatal: %s", exc)


async def demo() -> None:
    """python bot/mnq_signal_bot.py --demo

    Fires one of each notification with real numbers from 2026-08-20, so the
    console format, the beeps and the phone webhook can all be checked while
    nothing is at stake. Worth doing once before trusting it: the ORB gives you
    about ninety seconds, which is no time to discover the push is misconfigured.
    """
    log.info("Sending one of each. Phone push: %s", WEBHOOK or "OFF")

    # A stand-in account, so the fill and flat alerts run through exactly the
    # code path they will use live rather than being faked for the demo.
    class _Acct:
        balance = 50_242.74
        position = None

        async def get_open_positions(self):
            return [self.position] if self.position else []

    api = SignalClient(_Acct())
    api._last_px = 29350.75
    # Called through frames named after the bot's real call sites, so the demo
    # exercises the same book-labelling the live run will produce rather than
    # falling back to a generic tag.
    async def _service_orb():
        await api.place_stop_with_bracket(0, 10, 29372.00, 95, 287)
        await asyncio.sleep(1.2)
        await api.place_stop_with_bracket(1, 10, 29348.00, 95, 284)

    async def _service_add():
        await api.place_stop_with_bracket(0, 8, 29410.25, 199, 70)

    async def _orb_cancel():
        await api.cancel_order(900_002)

    async def _enforce_flatten():
        notify("🔴 FLATTEN — CLOSE THE POSITION, MARKET, NOW",                ["  Close 8 MNQ at market, now.",
                "  15:04 CT. The firm's deadline is 15:05 — do not be late.",
                "  Cancel any leftover bracket legs afterwards."],
               pattern="exit", priority="high")

    await _service_orb()
    await asyncio.sleep(1.2)
    await _service_add()
    await asyncio.sleep(1.2)
    await _orb_cancel()
    await asyncio.sleep(1.2)
    api._real.position = {"size": 10, "type": 1, "price": 29372.25}
    await api.get_open_positions()
    await asyncio.sleep(1.2)
    api._real.position = None
    api._real.balance = 49_755.54
    await api.get_open_positions()
    await asyncio.sleep(1.2)
    await _enforce_flatten()
    await asyncio.sleep(1.2)

    class _HbBot:
        in_position, _pos_owner, _orb_oids, _orb_done = False, None, [], False
        _day_start_balance = 50_242.74
        _last_bar_ts = int(datetime.now(timezone.utc).timestamp() * 1000) - 180_000
    notify("💤 STILL ONLINE", heartbeat_lines(api, _HbBot()),
           pattern=None, priority="low")
    log.info("Done. Eight alerts: five HIGH (place / cancel / close), two DEFAULT")
    log.info("(filled, flat) and one LOW (the heartbeat). If all eight reached the")
    log.info("phone and the heartbeat was the quiet one, the channel is working.")


if __name__ == "__main__":
    try:
        asyncio.run(demo() if "--demo" in sys.argv else main())
    except KeyboardInterrupt:
        log.info("Stopped.")
