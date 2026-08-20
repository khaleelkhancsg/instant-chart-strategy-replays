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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import mnq_donchian_bot as engine                                # noqa: E402
from mnq_donchian_bot import CONFIG, TICK, log                   # noqa: E402

WEBHOOK = os.environ.get("MNQ_NOTIFY_WEBHOOK", "").strip()
# How often to repeat "you are still in a position that should be closed".
NAG_EVERY_S = 30.0


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


def _push(title: str, body: str) -> None:
    """Best-effort phone push. Never raises, never blocks the trading loop."""
    if not WEBHOOK:
        return

    def go():
        try:
            import httpx
            if "ntfy.sh" in WEBHOOK:
                httpx.post(WEBHOOK, data=body.encode("utf-8"), timeout=8,
                           headers={"Title": title, "Priority": "urgent",
                                    "Tags": "chart_with_upwards_trend"})
            else:                                   # Discord / Slack style
                httpx.post(WEBHOOK, json={"content": f"**{title}**\n```\n{body}\n```",
                                          "text": f"*{title}*\n```\n{body}\n```"},
                           timeout=8)
        except Exception as exc:
            log.warning("notification webhook failed: %s", exc)
    threading.Thread(target=go, daemon=True).start()


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


def notify(title: str, lines: List[str], pattern: str = "entry") -> None:
    body = "\n".join(lines)
    width = max(62, max((_cols(x) for x in lines + [title]), default=0) + 4)

    def pad(t: str) -> str:
        return t + " " * max(0, width - 1 - _cols(t))
    bar = "━" * width
    log.info("\n┏%s┓\n┃ %s┃\n┣%s┫\n%s\n┗%s┛",
             bar, pad(title), bar,
             "\n".join("┃ " + pad(x) + "┃" for x in lines), bar)
    _beep(pattern)
    _push(title, body)


def _px(v: Optional[float]) -> str:
    return "?" if v is None else f"{v:,.2f}"


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
        # If we asked for a close and the position is still there, keep saying so.
        if self._nagging and pos:
            now = datetime.now(timezone.utc).timestamp()
            if now >= self._nag_at:
                self._nag_at = now + NAG_EVERY_S
                notify("⚠ STILL OPEN — CLOSE IT",
                       [self._nagging,
                        f"the platform still shows {pos[0].get('size', '?')} lots open.",
                        "This repeats every 30s until the position is flat."], "exit")
        elif not pos:
            self._nagging = None
        return pos

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
            f"🚀 ENTER {'LONG' if side == 0 else 'SHORT'} {size} LOTS — MARKET",
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
            "entry")
        return self._oid(f"market {'buy' if side == 0 else 'sell'} {size}")

    async def _resting(self, kind: str, side: int, size: int, price: float,
                       sl_ticks: int, tp_ticks: int) -> Optional[int]:
        sgn = 1 if side == 0 else -1
        sl_px = price - sgn * abs(sl_ticks) * TICK
        tp_px = price + sgn * abs(tp_ticks) * TICK
        risk = size * abs(sl_ticks) * TICK * CONFIG["tick_value"] / TICK
        notify(
            f"📋 WORKING ORDER — {kind.upper()} {'BUY' if side == 0 else 'SELL'} {size} LOTS",
            [f"  {kind.upper()} {'BUY' if side == 0 else 'SELL'}   {size} MNQ",
             f"    trigger      {_px(price)}",
             f"    stop loss    {_px(sl_px)}",
             f"    take profit  {_px(tp_px)}",
             "",
             f"  risk if stopped   ${risk:,.0f}",
             "  Leave it resting. You will be told when to pull it."],
            "entry")
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
        notify("🔴 CLOSE THE POSITION — MARKET, NOW",
               [f"  {msg}",
                "  This is the bot's own exit (time stop, flatten, or a flip).",
                "  It is not the bracket — the bracket stays where it is until",
                "  you cancel it, so cancel any leftover legs afterwards."],
               "exit")
        # Reported as done so the bot's state machine advances. Reality is
        # re-read every cycle from the account, and get_open_positions() nags
        # until the position is actually gone.
        self._nagging = msg
        self._nag_at = datetime.now(timezone.utc).timestamp() + NAG_EVERY_S
        return True

    async def cancel_order(self, order_id) -> bool:
        what = self._tickets.pop(order_id, f"order {order_id}")
        notify("✖ CANCEL A WORKING ORDER",
               [f"  Cancel:  {what}",
                "  It is no longer wanted — the setup expired, filled on the",
                "  other side, or the day's blocks came on."],
               "cancel")
        return True


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
            await bot.run()
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
    api = SignalClient.__new__(SignalClient)
    api._last_px, api._next_oid, api._tickets = 29350.75, 900_000, {}
    api._nagging, api._nag_at = None, 0.0
    await api.place_stop_with_bracket(0, 10, 29372.00, 95, 287)
    await asyncio.sleep(1.2)
    await api.place_stop_with_bracket(1, 10, 29348.00, 95, 284)
    await asyncio.sleep(1.2)
    await api.place_bracket_order(0, 8, 199, 70)
    await asyncio.sleep(1.2)
    await api.cancel_order(900_002)
    await asyncio.sleep(1.2)
    notify("🔴 CLOSE THE POSITION — MARKET, NOW",
           ["  Close 10 MNQ at market, now.",
            "  This is the bot's own exit (time stop, flatten, or a flip)."], "exit")
    log.info("Done. If you saw four banners, heard them, and got four pushes,")
    log.info("the channel is working.")


if __name__ == "__main__":
    try:
        asyncio.run(demo() if "--demo" in sys.argv else main())
    except KeyboardInterrupt:
        log.info("Stopped.")
