#!/usr/bin/env python3
"""
Integration tests for the ORB book inside mnq_donchian_bot.

orb_strategy.py is verified against the JS by test_orb_parity.py. This is the
other half: that the LIVE bot arms it, notices its fill, keeps the two books
from ever holding at once, honours the five-minute time stop, and cleans up.

Exclusivity is the property worth the most attention. The two books were
measured holding simultaneously for twelve minutes across seven years, so
forbidding it costs 0.3pp -- but only if the bot actually forbids it. Every
path that could open a second position is asserted here.

    python bot/test_orb_integration.py
"""

import asyncio
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
os.environ.setdefault("MNQ_LOG_DIR", str(HERE / "logs_test"))

import mnq_donchian_bot as bot            # noqa: E402
from orb_strategy import OrbLevels        # noqa: E402

bot.CONFIG["state_file"] = str(HERE / "logs_test" / "test_state_orb.json")
(HERE / "logs_test").mkdir(exist_ok=True)

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


class Api:
    """Records orders; never matches them. The point is the SEQUENCE."""

    def __init__(self, balance=50_000.0):
        self._balance = balance
        self.orders, self.adds, self.limits = [], [], []
        self.cancels = 0
        self.closes = 0
        self.position = None
        self.reject_stop = False

    @property
    def balance(self):
        return self._balance

    async def refresh_balance(self):
        return self._balance

    async def get_bars_1m(self, days=5):
        return []

    async def place_bracket_order(self, side, size, sl, tp):
        self.orders.append((side, size, sl, tp))
        self.position = {"size": size, "type": 1 if side == 0 else 2,
                         "price": 20000.0, "contractId": bot.CONFIG["contract_id"]}
        return 1234

    async def place_stop_with_bracket(self, side, size, px, sl, tp):
        self.adds.append((side, size, px, sl, tp))
        return None if self.reject_stop else 5000 + len(self.adds)

    async def place_limit_with_bracket(self, side, size, px, sl, tp):
        self.limits.append((side, size, px, sl, tp))
        return 6000 + len(self.limits)

    async def get_open_positions(self):
        return [self.position] if self.position else []

    async def get_open_orders(self):
        return []

    async def close_position(self):
        self.closes += 1
        self.position = None
        return True

    async def cancel_order(self, oid):
        self.cancels += 1
        return True


LV = OrbLevels(hi=20050.0, lo=19950.0, taps_hi=4, taps_lo=3,
               win_hi=20080.0, win_lo=19920.0, ref=20000.0)


def make(ct, *, levels=LV, day_pnl=0.0, position=None):
    api = Api()
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
    return b, api


def main():
    print("\nORB integration\n")
    OPEN = bot.ORB_OPEN_CT

    # ── arming ────────────────────────────────────────────────
    b, api = make(OPEN + 1)
    asyncio.run(b._service_orb([]))
    check("arms BOTH sides at the open", len(api.adds) == 2, f"adds={api.adds}")
    if len(api.adds) == 2:
        longs = [a for a in api.adds if a[0] == 0]
        shorts = [a for a in api.adds if a[0] == 1]
        check("one long, one short", len(longs) == 1 and len(shorts) == 1, "")
        check("long trigger sits ABOVE the upper level",
              longs[0][2] > LV.hi, f"{longs[0][2]} vs {LV.hi}")
        check("short trigger sits BELOW the lower level",
              shorts[0][2] < LV.lo, f"{shorts[0][2]} vs {LV.lo}")
        check("both sized under the $1,000 cap",
              all(a[1] * abs(LV.hi - LV.lo) * 2 <= 1200 for a in api.adds),
              f"lots={[a[1] for a in api.adds]}")
    check("both order ids are tracked for cancellation",
          len(b._orb_oids) == 2, f"oids={b._orb_oids}")

    b2, api2 = make(OPEN + 1)
    asyncio.run(b2._service_orb([]))
    asyncio.run(b2._service_orb([]))
    check("a second pass does not double-arm", len(api2.adds) == 2, f"adds={api2.adds}")

    # ── no level, blocked, expired ────────────────────────────
    b3, api3 = make(OPEN + 1, levels=None)
    asyncio.run(b3._service_orb([]))
    check("no level -> nothing armed and the book is done",
          len(api3.adds) == 0 and b3._orb_done, f"adds={api3.adds}")

    b4, api4 = make(OPEN + 1, day_pnl=900.0)     # past the +$750 profit block
    asyncio.run(b4._service_orb([]))
    check("daily profit block prevents arming", len(api4.adds) == 0, f"adds={api4.adds}")

    b5, api5 = make(bot.CONFIG["orb_give_up_ct"] + 1)
    b5._orb_oids = [1, 2]
    asyncio.run(b5._service_orb([]))
    check("hunt window expiry cancels the resting orders",
          api5.cancels == 2 and b5._orb_oids == [] and b5._orb_done,
          f"cancels={api5.cancels}")

    b6, api6 = make(OPEN + 1, day_pnl=-600.0)    # past the -$500 breaker
    b6._orb_oids = [7, 8]
    asyncio.run(b6._service_orb([]))
    check("circuit breaker cancels resting orders", api6.cancels == 2, "")

    # ── exclusivity: one book at a time ───────────────────────
    pos = {"size": 8, "type": 1, "price": 20000.0,
           "contractId": bot.CONFIG["contract_id"]}
    b7, api7 = make(OPEN + 1, position=pos)
    b7._pos_owner = "don"
    asyncio.run(b7._service_orb([]))
    check("ORB does not arm while the donchian holds",
          len(api7.adds) == 0, f"adds={api7.adds}")

    b8, api8 = make(OPEN + 1, position=pos)
    b8._pos_owner = "don"
    b8._orb_oids = [11, 12]
    asyncio.run(b8._service_orb([]))
    check("a position appearing cancels resting ORB orders",
          api8.cancels == 2 and b8._orb_oids == [], f"cancels={api8.cancels}")

    # ── the five-minute time stop ─────────────────────────────
    b9, api9 = make(OPEN + 20, position=pos)
    b9._pos_owner = "orb"
    b9._orb_entry_ts = datetime.now(timezone.utc) - timedelta(minutes=2)
    asyncio.run(b9._service_orb([]))
    check("time stop does NOT fire early", api9.closes == 0, "")

    b10, api10 = make(OPEN + 20, position=pos)
    b10._pos_owner = "orb"
    b10._orb_entry_ts = datetime.now(timezone.utc) - timedelta(
        minutes=bot.CONFIG["orb_max_hold_min"] + 0.5)
    asyncio.run(b10._service_orb([]))
    check("time stop closes the position once the hold is up",
          api10.closes == 1, f"closes={api10.closes}")
    check("...and releases the account", b10._pos_owner is None and not b10.in_position,
          f"owner={b10._pos_owner} in_pos={b10.in_position}")

    # ── the day roll ──────────────────────────────────────────
    b11, api11 = make(OPEN + 1)
    b11._orb_done = True
    b11._orb_levels = LV
    b11._pos_owner = "orb"
    b11._session_key = "OLD"
    b11._roll_session_if_needed()
    check("a new day resets the ORB book",
          not b11._orb_done and b11._orb_levels is None
          and b11._orb_day is None and b11._pos_owner is None,
          f"done={b11._orb_done} lv={b11._orb_levels} owner={b11._pos_owner}")

    # ── a refused stop must not leave a phantom ───────────────
    b12, api12 = make(OPEN + 1)
    api12.reject_stop = True
    asyncio.run(b12._service_orb([]))
    check("refused stops leave nothing tracked",
          b12._orb_oids == [], f"oids={b12._orb_oids}")

    # ── property: no path opens a second position ─────────────
    print("\nproperty: two books can never both hold")
    import random
    rnd = random.Random(20250819)
    bad = 0
    for _ in range(300):
        bp, ap = make(OPEN + rnd.randint(1, 55))
        for _ in range(12):
            act = rnd.randint(0, 4)
            if act == 0:
                asyncio.run(bp._service_orb([]))
            elif act == 1 and not bp.in_position:
                ap.position = dict(pos)
                bp.in_position, bp._pos_dir = True, 1
                if bp._orb_oids and bp._pos_owner is None:
                    bp._pos_owner = "orb"
                    bp._orb_entry_ts = datetime.now(timezone.utc)
                    bp._orb_done = True
                    asyncio.run(bp._orb_cancel("filled"))
            elif act == 2 and bp.in_position:
                ap.position = None
                bp.in_position, bp._pos_dir = False, 0
                bp._pos_owner = None
                bp._orb_entry_ts = None
            elif act == 3:
                asyncio.run(bp._orb_cancel("random"))
            else:
                bp._ct_now = lambda c=rnd.randint(OPEN, OPEN + 70): c
            # INVARIANT: never a position and resting ORB orders together
            if bp.in_position and bp._orb_oids:
                bad += 1
                break
    check("no position ever coexists with resting ORB orders (300 sequences)",
          bad == 0, f"{bad} violations")

    print("\n" + "=" * 62)
    print(f"  {PASS} passed, {FAIL} failed")
    print("=" * 62)
    for f in FAILURES:
        print("  x " + f)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
