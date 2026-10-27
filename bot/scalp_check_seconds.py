"""The MACD-cross scalp on TopstepX's 1-SECOND bars: enter at market when a 1-minute MACD(12,
26, 9) histogram cross closes (08:30-15:00 CT), take +t points at a limit, stop where the
$600 day limit sits for the size traded. Per cross, on its own: the chance the target comes
first, against the win rate that size and target need to break even -- for momentum (with
the cross), the fade (against it) and their average (a random direction).

Read-only: logs in with bot/.env and reads bars; places nothing. TopstepX keeps 1-second
bars for about two weeks (from 2026-10-13 when read on 10-27) and 1-minute bars for about
60 days, so this covers the latest sessions that have 1-second bars (--sessions, default 10).

Fills: the entry is the next second bar's open + 1 tick; the target fills only if price
trades through it by a tick (--touch: a touch fills); $0.75 a side per lot; the stop sits
where the loss including costs is $600 (74 points at 4 lots, 29 at 10, 14 at 20, 6.5 at 40).

RESULT (Oct 13-26 2026, 10 sessions, 299 crosses): below break-even at every size and target.
  lots  target  need   momentum  fade   $/trade (momentum)
     4     +2   98.7%    97.3%   97.3%     -8
     4     +8   91.5%    89.1%   89.4%    -16
    20     +2   93.8%    90.0%   88.0%    -24
    20     +4   83.3%    77.9%   80.3%    -39
    40     +4   71.4%    56.9%   61.2%   -122
    40     +8   51.7%    37.1%   45.8%   -169
Touch fills move it by 0-3 points; momentum is no better than the fade or a random direction.
The more lots, the nearer the $600 stop, and the further below break-even.

    python bot/scalp_check_seconds.py [--sessions 10] [--touch]
"""
import argparse
import logging
from datetime import datetime

import donchian1250_core as core
import mnq_donchian1250_bot as bm

CT = core.CT_TZ
TICK, FEE = 0.25, 0.75


def ema(xs, n):
    a, out, p = 2 / (n + 1), [], None
    for x in xs:
        p = x if p is None else a * x + (1 - a) * p
        out.append(p)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--sessions", type=int, default=10, help="the latest N sessions with 1-second bars (default 10)")
    ap.add_argument("--touch", action="store_true", help="a touch of the target fills (default: price must trade through it)")
    a = ap.parse_args()
    bm.log.setLevel(logging.WARNING)
    api = bm.make_api()
    api.login()
    cid = [c for c in api.search_contracts("MNQ", False) if c.get("symbolId") == "F.US.MNQ" and c.get("activeContract")][0]["id"]
    now = datetime.now(CT).timestamp() * 1000

    # 1-minute bars: the MACD and the sessions
    one, t = {}, now - 40 * 86_400_000
    while t < now:
        for b in api.bars(cid, False, t, min(now, t + 13 * 86_400_000), partial=False):
            if float(b.get("v") or 0) > 0:
                one[bm.parse_ts(b["t"])] = float(b["c"])
        t += 13 * 86_400_000
    ts1 = sorted(one)
    line = [f - s for f, s in zip(ema([one[x] for x in ts1], 12), ema([one[x] for x in ts1], 26))]
    hist = [x - y for x, y in zip(line, ema(line, 9))]
    sessions = sorted({core.trading_day(x) for x in ts1 if 510 <= core.ct_minute(x) < 900})

    # 1-second bars for the latest sessions that have them
    sec = {}
    for d in reversed(sessions):
        if len(sec) >= a.sessions:
            break
        dt = datetime.fromtimestamp((d + 0.5) * 86400, CT)
        t0 = datetime(dt.year, dt.month, dt.day, 8, 30, tzinfo=CT).timestamp() * 1000
        t1 = datetime(dt.year, dt.month, dt.day, 15, 5, tzinfo=CT).timestamp() * 1000
        rows, t = {}, t0
        while t < min(t1, now):
            r = api.post("/api/History/retrieveBars", {"contractId": cid, "live": False, "startTime": bm.iso(t),
                                                       "endTime": bm.iso(min(t1, t + 19_000_000)), "unit": 1, "unitNumber": 1,
                                                       "limit": 20000, "includePartialBar": False})
            for b in r.get("bars") or []:
                rows[bm.parse_ts(b["t"])] = (float(b["o"]), float(b["h"]), float(b["l"]), float(b["c"]))
            t += 19_000_000
        if not rows:
            break                                       # older than TopstepX keeps
        ts = sorted(rows)
        sec[d] = (ts, [rows[x] for x in ts])
    crosses = []
    for i in range(1, len(ts1)):
        d, ct = core.trading_day(ts1[i]), core.ct_minute(ts1[i])
        if d in sec and 510 <= ct < 900 and ((hist[i] > 0 >= hist[i - 1]) or (hist[i] < 0 <= hist[i - 1])):
            crosses.append((ts1[i], 1 if hist[i] > 0 else -1, d))
    day = lambda d: datetime.fromtimestamp((d + 0.5) * 86400, CT)   # noqa: E731
    print(f"{cid}: {len(sec)} sessions with 1-second bars, {day(min(sec)):%Y-%m-%d} .. {day(max(sec)):%Y-%m-%d}; {len(crosses)} crosses;"
          f" target fills on {'a touch' if a.touch else 'a trade through it'}")

    def first_passage(sign, t, X):
        ok = tot = 0
        for st, dr, d in crosses:
            ts, bars = sec[d]
            lo, hi = 0, len(ts)
            while lo < hi:
                mid = (lo + hi) // 2
                if ts[mid] < st + 60_000:
                    lo = mid + 1
                else:
                    hi = mid
            if lo >= len(ts):
                continue
            s = sign * dr
            fill = bars[lo][0] + s * TICK
            tp, sl = fill + s * (t + (0 if a.touch else TICK)), fill - s * X
            for k in range(lo, len(ts)):
                o, h, l, c = bars[k]
                if (l <= sl) if s == 1 else (h >= sl):
                    tot += 1
                    break
                if (h >= tp) if s == 1 else (l <= tp):
                    tot += 1
                    ok += 1
                    break
        return 100 * ok / max(1, tot)

    print("   lots  stop pts  target  win $   need to break even   MOMENTUM    FADE    random   momentum $ per trade")
    for L in (4, 10, 20, 40):
        X = (600 - 2 * FEE * L) / (2 * L) - TICK
        for t in (2, 4, 8):
            win = L * (2 * t - 2 * FEE) - 2 * TICK * L
            need = 100 * 600 / (600 + win)
            pm, pf = first_passage(1, t, X), first_passage(-1, t, X)
            print(f"   {L:4d}  {X:8.1f}  {t:+6d}  {win:+6.0f}   {need:13.1f}%     {pm:7.1f}%  {pf:6.1f}%  {(pm + pf) / 2:6.1f}%"
                  f"   {pm / 100 * win - (1 - pm / 100) * 600:+10.0f}")


if __name__ == "__main__":
    main()
