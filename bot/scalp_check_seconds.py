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

RESULT (Oct 13-26 2026, 10 sessions; every cross counted, $ per trade after costs):
  1-minute MACD (299 crosses): below break-even at every size and target -- 4 lots +2 -$9,
  20 lots +4 -$39, 40 lots +8 -$169 -- and the fade no better. Touch fills move it little.
  By signal and bar size (--signal macd,ema9/21,ema20/50, --tf 5 s to 5 min): on 5-20 s bars
  (22-389 crosses a day) every cell loses for all three signals; at 30 s three are above zero
  (+$1 to +$7); the rest of the cells above zero sit on 1- to 5-minute bars, where 10 sessions
  hold 10-160 crosses. research/scalp_slow_signals.mjs ran those signals and bars on 5 years of
  1-minute bars: 190 of 192 cells lose even at best -- noise. The more lots, the nearer the
  $600 stop and the bigger the loss; when and how the entry is timed hardly changes the odds.

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


def crosses_of(ts, closes, tf_ms, keep, signal="macd"):
    """(signal close time, cross direction) for every cross whose bar keep() accepts: the MACD
    histogram through zero ("macd"), or a fast EMA through a slow one ("ema9/21")."""
    if signal == "macd":
        line = [f - s for f, s in zip(ema(closes, 12), ema(closes, 26))]
        hist = [x - y for x, y in zip(line, ema(line, 9))]
    else:
        fast, slow = (int(x) for x in signal[3:].split("/"))
        hist = [f - s for f, s in zip(ema(closes, fast), ema(closes, slow))]
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
    ap.add_argument("--tf", default="5,10,20,30,60,120,300", help="signal bar sizes in seconds (default 5,10,20,30,60,120,300)")
    ap.add_argument("--signal", default="macd", help="comma separated: macd (histogram through zero) and/or emaF/S, e.g. ema9/21")
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

    def first_passage(sigs, sign, stops):
        """For each cell (lots, target): the share of entries whose target came before the stop,
        and the $ per trade -- a target is +win, a stop -$600, an entry still open at the end of the
        data (15:05) is closed there at market. One walk per entry settles every cell; a stop and
        a target in the same second is a stop."""
        cells = [(c, stops[c], c[1] + (0 if a.touch else TICK)) for c in CELLS]
        ok, tot, pnl = {c: 0 for c in CELLS}, {c: 0 for c in CELLS}, {c: 0.0 for c in CELLS}
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
            open_ = list(cells)
            for k in range(lo, len(ts)):
                o, h, l, c = bars[k]
                adverse, favour = ((fill - l), (h - fill)) if s == 1 else ((h - fill), (fill - l))
                still = []
                for cell, X, T in open_:
                    if adverse >= X:
                        tot[cell] += 1
                        pnl[cell] -= 600
                    elif favour >= T:
                        tot[cell] += 1
                        ok[cell] += 1
                        pnl[cell] += need[cell][1]
                    else:
                        still.append((cell, X, T))
                open_ = still
                if not open_:
                    break
            for cell, X, T in open_:                    # still open at the end of the data: closed at market
                p = (bars[-1][3] - s * TICK - fill) * s * 2 * cell[0] - 2 * FEE * cell[0]
                tot[cell] += 1
                ok[cell] += p > 0
                pnl[cell] += p
        return {c: (100 * ok[c] / max(1, tot[c]), pnl[c] / max(1, tot[c])) for c in CELLS}

    need = {}
    for L, t in CELLS:
        win = L * (2 * t - 2 * FEE) - 2 * TICK * L       # the target is a limit: entry slippage only
        need[(L, t)] = (100 * 600 / (600 + win), win, (600 - 2 * FEE * L) / (2 * L) - TICK)
    stops = {c: need[c][2] for c in CELLS}
    for signal in a.signal.split(","):
        print(f"\n   {signal.upper()} -- $ PER TRADE AFTER COSTS (every cross counted), momentum | fade")
        print("   lots (stop pts) / target:  " + "".join(f"{f'{L} ({need[(L, t)][2]:.0f}) +{t}':>14}" for L, t in CELLS))
        print("   a win pays:                " + "".join(f"{f'+${need[c][1]:.0f}':>14}" for c in CELLS))
        for tf in tfs:
            tf_ms = tf * 1000
            sigs = []
            if tf < 60:
                for d, (ts, bars) in sec.items():
                    bt, bc = buckets(ts, [b[3] for b in bars], tf_ms)
                    sigs += [(at, dr, d) for at, dr in crosses_of(bt, bc, tf_ms, rth, signal)]
            else:
                bt, bc = buckets(ts1, [one[x] for x in ts1], tf_ms)
                sigs = [(at, dr, core.trading_day(at - tf_ms)) for at, dr in crosses_of(bt, bc, tf_ms, rth, signal)]
                sigs = [s for s in sigs if s[2] in sec]
            mo, fa = first_passage(sigs, 1, stops), first_passage(sigs, -1, stops)
            label = f"{tf} s" if tf < 60 else f"{tf // 60} min"
            print(f"   {label:>6} ({len(sigs) / len(sec):5.0f} a day)    " + "".join(f"{mo[c][1]:+6.0f} |{fa[c][1]:+5.0f} " for c in CELLS))
            best = max(CELLS, key=lambda c: mo[c][1])
            print(f"   {'':22}best for momentum: {best[0]} lots +{best[1]}: wins {mo[best][0]:.1f}% against {need[best][0]:.1f}% needed,"
                  f" {mo[best][1]:+.0f} $ a trade")


if __name__ == "__main__":
    main()
