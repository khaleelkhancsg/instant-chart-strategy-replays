"""The MACD-cross scalp, judged on TopstepX's 1-SECOND price paths: enter at market when a
MACD(12, 26, 9) histogram cross closes (signal bars starting 08:30-15:00 CT), take +t points at
a limit, stop where the $600 day limit sits for the size traded. Per cross, on its own: the
chance the target comes first, against the win rate that size and target need to break even
-- for momentum (with the cross) and the fade (against it). The MACD runs on --tf bars (in
seconds): below a minute they are built from the 1-second bars (warmed up from 06:30 CT each
session), from a minute up from TopstepX's continuous 1-minute bars. The 1-second bars are
only the price path each trade is followed on.

Read-only: logs in with bot/.env and reads bars; places nothing. TopstepX keeps 1-second
bars for about two weeks (from 2026-10-13 when read on 10-27) and 1-minute bars for about
60 days, so this covers the latest sessions that have 1-second bars (--sessions, default 10).

Fills: the entry is the next second bar's open + 1 tick; the target fills only if price
trades through it by a tick (--touch: a touch fills); $0.75 a side per lot; the stop sits
where the loss including costs is $600 (74 points at 4 lots, 29 at 10, 14 at 20, 6.5 at 40).

RESULT (Oct 13-26 2026, 10 sessions; 1-minute MACD, 299 crosses): below break-even at every
size and target.
  lots  target  need   momentum  fade   $/trade (momentum)
     4     +2   98.7%    97.3%   97.3%     -8
     4     +8   91.5%    89.1%   89.4%    -16
    20     +2   93.8%    90.0%   88.0%    -24
    20     +4   83.3%    77.9%   80.3%    -39
    40     +4   71.4%    56.9%   61.2%   -122
    40     +8   51.7%    37.1%   45.8%   -169
Touch fills move it by 0-3 points; momentum is no better than the fade or a random direction.
The more lots, the nearer the $600 stop, and the further below break-even.
By MACD timeframe (5 s to 5 min: 389 to 9 crosses a day) the same: 4 of 168 cells (7 timeframes
x 4 sizes x 3 targets x momentum / fade) get above break-even, all on the 5-minute MACD, where
~90 crosses leave a standard error of ~5 points -- momentum at 20 lots +8 (+1.6 points), the
fade at 4 lots (+0.2 to +1.4). Best momentum cell per timeframe: 5 / 10 / 20 / 30 s -$14 to
-$17 a trade, 1 min -$8, 2 min -$8, 5 min +$14. The bracket and the costs set the odds; when
the entry happens hardly changes them.

    python bot/scalp_check_seconds.py [--tf 5,10,20,30,60,120,300] [--sessions 10] [--touch]
"""
import argparse
import logging
from datetime import datetime

import donchian1250_core as core
import mnq_donchian1250_bot as bm

CT = core.CT_TZ
TICK, FEE = 0.25, 0.75
CELLS = [(L, t) for L in (4, 10, 20, 40) for t in (2, 4, 8)]


def ema(xs, n):
    a, out, p = 2 / (n + 1), [], None
    for x in xs:
        p = x if p is None else a * x + (1 - a) * p
        out.append(p)
    return out


def crosses_of(ts, closes, tf_ms, keep):
    """(signal close time, cross direction) for every MACD histogram cross whose bar keep() accepts."""
    line = [f - s for f, s in zip(ema(closes, 12), ema(closes, 26))]
    hist = [x - y for x, y in zip(line, ema(line, 9))]
    return [(ts[i] + tf_ms, 1 if hist[i] > 0 else -1) for i in range(1, len(ts))
            if keep(ts[i]) and ((hist[i] > 0 >= hist[i - 1]) or (hist[i] < 0 <= hist[i - 1]))]


def buckets(ts, closes, tf_ms):
    out_t, out_c = [], []
    for t, c in zip(ts, closes):
        b = t - t % tf_ms
        if out_t and out_t[-1] == b:
            out_c[-1] = c
        else:
            out_t.append(b)
            out_c.append(c)
    return out_t, out_c


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tf", default="5,10,20,30,60,120,300", help="MACD bar sizes in seconds (default 5,10,20,30,60,120,300)")
    ap.add_argument("--sessions", type=int, default=10, help="the latest N sessions with 1-second bars (default 10)")
    ap.add_argument("--touch", action="store_true", help="a touch of the target fills (default: price must trade through it)")
    a = ap.parse_args()
    tfs = [int(x) for x in a.tf.split(",")]
    bm.log.setLevel(logging.WARNING)
    api = bm.make_api()
    api.login()
    cid = [c for c in api.search_contracts("MNQ", False) if c.get("symbolId") == "F.US.MNQ" and c.get("activeContract")][0]["id"]
    now = datetime.now(CT).timestamp() * 1000

    one, t = {}, now - 40 * 86_400_000                  # 1-minute bars: the minute MACDs and the sessions
    while t < now:
        for b in api.bars(cid, False, t, min(now, t + 13 * 86_400_000), partial=False):
            if float(b.get("v") or 0) > 0:
                one[bm.parse_ts(b["t"])] = float(b["c"])
        t += 13 * 86_400_000
    ts1 = sorted(one)
    sessions = sorted({core.trading_day(x) for x in ts1 if 510 <= core.ct_minute(x) < 900})

    sec = {}                                            # 1-second bars, 06:30-15:05 CT, latest sessions that have them
    for d in reversed(sessions):
        if len(sec) >= a.sessions:
            break
        dt = datetime.fromtimestamp((d + 0.5) * 86400, CT)
        t0 = datetime(dt.year, dt.month, dt.day, 6, 30, tzinfo=CT).timestamp() * 1000
        t1 = datetime(dt.year, dt.month, dt.day, 15, 5, tzinfo=CT).timestamp() * 1000
        rows, t = {}, t0
        while t < min(t1, now):
            r = api.post("/api/History/retrieveBars", {"contractId": cid, "live": False, "startTime": bm.iso(t),
                                                       "endTime": bm.iso(min(t1, t + 19_000_000)), "unit": 1, "unitNumber": 1,
                                                       "limit": 20000, "includePartialBar": False})
            for b in r.get("bars") or []:
                rows[bm.parse_ts(b["t"])] = (float(b["o"]), float(b["h"]), float(b["l"]), float(b["c"]))
            t += 19_000_000
        if not any(510 <= core.ct_minute(x) < 900 for x in rows):
            break                                       # older than TopstepX keeps
        ts = sorted(rows)
        sec[d] = (ts, [rows[x] for x in ts])
    day = lambda d: datetime.fromtimestamp((d + 0.5) * 86400, CT)   # noqa: E731
    rth = lambda x: 510 <= core.ct_minute(x) < 900                    # noqa: E731
    print(f"{cid}: {len(sec)} sessions with 1-second bars, {day(min(sec)):%Y-%m-%d} .. {day(max(sec)):%Y-%m-%d};"
          f" target fills on {'a touch' if a.touch else 'a trade through it'}")

    def first_passage(sigs, sign, t, X):
        ok = tot = 0
        for at, dr, d in sigs:
            ts, bars = sec[d]
            lo, hi = 0, len(ts)
            while lo < hi:
                mid = (lo + hi) // 2
                if ts[mid] < at:
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

    need = {}
    for L, t in CELLS:
        win = L * (2 * t - 2 * FEE) - 2 * TICK * L       # the target is a limit: entry slippage only
        need[(L, t)] = (100 * 600 / (600 + win), win, (600 - 2 * FEE * L) / (2 * L) - TICK)
    print("\n   ACTUAL WIN RATE MINUS THE WIN RATE NEEDED TO BREAK EVEN, in points (positive = profitable), momentum | fade")
    print("   lots (stop pts) / target:  " + "".join(f"{f'{L} ({need[(L, t)][2]:.0f}) +{t}':>14}" for L, t in CELLS))
    print("   needed:                    " + "".join(f"{need[c][0]:13.1f}%" for c in CELLS))
    for tf in tfs:
        tf_ms = tf * 1000
        sigs = []
        if tf < 60:
            for d, (ts, bars) in sec.items():
                bt, bc = buckets(ts, [b[3] for b in bars], tf_ms)
                sigs += [(at, dr, d) for at, dr in crosses_of(bt, bc, tf_ms, rth)]
        else:
            bt, bc = buckets(ts1, [one[x] for x in ts1], tf_ms)
            sigs = [(at, dr, core.trading_day(at - tf_ms)) for at, dr in crosses_of(bt, bc, tf_ms, rth)]
            sigs = [s for s in sigs if s[2] in sec]
        res = {c: (first_passage(sigs, 1, c[1], need[c][2]), first_passage(sigs, -1, c[1], need[c][2])) for c in CELLS}
        label = f"{tf} s" if tf < 60 else f"{tf // 60} min"
        print(f"   {label:>6} ({len(sigs) / len(sec):5.0f} a day)    " + "".join(f"{res[c][0] - need[c][0]:+6.1f} |{res[c][1] - need[c][0]:+5.1f} " for c in CELLS))
        best = max(CELLS, key=lambda c: res[c][0] - need[c][0])
        p = res[best][0] / 100
        print(f"   {'':22}best for momentum: {best[0]} lots +{best[1]}: {res[best][0]:.1f}% against {need[best][0]:.1f}% needed,"
              f" {p * need[best][1] - (1 - p) * 600:+.0f} $ a trade")


if __name__ == "__main__":
    main()
