"""Forward check of the $1,250 Donchian at fixed lot sizes on TopstepX's own bars, from
2026-09-01 (after the research data ends) to --end (default today). Everything else as
shipped; research/donchian_2lots_42days.mjs is the history.

Read-only: logs in with bot/.env and reads 1-minute bars; places nothing. Contracts and
warm-up as in forward_full_stop_sizing.py. An evaluation is started on each session
and run to the end of the data -- passed, failed, or still open -- since a 42-day one
needs 42 sessions of forward data.

RESULT (Sep 1-Oct 22 2026, 38 sessions):
  sizing                    trades  net $   days at -$600   started each session: passed / failed / open
  shipped: 4 lots, 2 late       29  +1,484        4            19 / 13 / 6  (every start Sep 29-Oct 14 failed)
  2 lots on every trade         46  +1,878        2            20 /  0 / 18
  2 lots, 1 late                46  +2,028        1            17 /  0 / 21
Oct 14 decided most of it: at 4 lots the $600 line sat 75 points out and the short
was stopped (-$600, then -$600 again on Oct 15); at 2 lots it sat 150 points out and
the day made +$353.

    python bot/forward_fixed_lots.py [--sizes 4/2,2/2,2/1] [--end 2026-11-30] [--day 2026-10-14]
"""
import argparse
import logging
from datetime import datetime, timezone

import donchian1250_core as core
import mnq_donchian1250_bot as bm

CT = core.CT_TZ


def ms(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=CT).timestamp() * 1000


class Fixed(core.Strategy):
    # not "lots": Strategy.lots is the open position's size
    size, size_late = 4, 2

    def finish_bar(self, bar):
        info = super().finish_bar(bar)
        info.lots = self.size_late if info.used >= core.CFG["late_range_adr"] else self.size
        return info


def run_eval(arr, target=1250.0, dd=1000.0, cons=0.5):
    """The evaluation over arr until it passes or fails; (outcome, days used, P&L)."""
    c, pk, lk, md = 0.0, 0.0, False, -1e18
    for k, v in enumerate(arr):
        c += v
        md = max(md, v)
        if c <= (0 if lk else pk - dd):
            return "fail", k + 1, c
        pk = max(pk, c)
        if not lk and pk >= dd:
            lk = True
        if c >= target and md <= cons * c:
            return "pass", k + 1, c
    return "open", len(arr), c


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--sizes", default="4/2,2/2,2/1", help="lots/lots-late, comma separated (default 4/2,2/2,2/1)")
    ap.add_argument("--end", default=datetime.now(CT).strftime("%Y-%m-%d"), help="last session, YYYY-MM-DD (default today)")
    ap.add_argument("--day", help="also list each size's trades on this day, YYYY-MM-DD")
    a = ap.parse_args()
    sizes = [tuple(int(x) for x in s.split("/")) for s in a.sizes.split(",")]
    names = [("shipped: 4 lots, 2 late" if s == (4, 2) else f"{s[0]} lots on every trade" if s[0] == s[1] else f"{s[0]} lots, {s[1]} late") for s in sizes]
    end = datetime.strptime(a.end, "%Y-%m-%d")
    bm.log.setLevel(logging.WARNING)
    api = bm.make_api()
    api.login()

    def fetch(cid, t0, t1):
        rows, t = {}, t0
        while t < t1:
            for b in api.bars(cid, False, t, min(t1, t + 13 * 86_400_000), partial=False):
                if float(b.get("v") or 0) > 0:
                    rows[bm.parse_ts(b["t"])] = (float(b["o"]), float(b["h"]), float(b["l"]), float(b["c"]), float(b["v"]))
            t += 13 * 86_400_000
        return sorted((ts, *v) for ts, v in rows.items())

    roll = core.trading_day(ms(2026, 9, 11, 9))      # from this trading day on, the December contract
    last = core.trading_day(ms(end.year, end.month, end.day, 9))
    periods = [("CON.F.US.MNQ.U26", ms(2026, 8, 23), ms(2026, 9, 11, 16), core.trading_day(ms(2026, 9, 1, 9)), min(roll - 1, last)),
               ("CON.F.US.MNQ.Z26", ms(2026, 8, 23), ms(end.year, end.month, end.day, 16), roll, last)]
    trades = {n: [] for n in names}
    days = []
    for cid, t0, t1, d0, d1 in periods:
        if d1 < d0:
            continue
        bars = core.aggregate_2m(fetch(cid, t0, t1))
        days += sorted({b.tday for b in bars if d0 <= b.tday <= d1 and 510 <= b.ct < 900})
        saved = core.Strategy
        for name, (L, late) in zip(names, sizes):
            Fixed.size, Fixed.size_late = L, late
            core.Strategy = Fixed
            try:
                trades[name] += [t for t in core.reference_replay(bars) if d0 <= t["tday"] <= d1]
            finally:
                core.Strategy = saved
    day = lambda d: datetime.fromtimestamp((d + 0.5) * 86400, timezone.utc)   # noqa: E731

    print(f"FORWARD {day(days[0]):%Y-%m-%d} .. {day(days[-1]):%Y-%m-%d}: {len(days)} sessions on TopstepX's bars; engine fills, 1 tick + $0.75 a side")
    print("   sizing                     trades  avg lots  $/trade     net $  worst day  days at -$600  best day")
    arrs = {}
    for name in names:
        T = trades[name]
        by = {}
        for t in T:
            by[t["tday"]] = by.get(t["tday"], 0.0) + t["pnl"]
        arrs[name] = arr = [by.get(d, 0.0) for d in days]
        n = max(1, len(T))
        print(f"   {name:26} {len(T):6} {sum(t['lots'] for t in T) / n:9.2f} {sum(t['pnl'] for t in T) / n:+8.0f} {sum(arr):+9,.0f}"
              f" {min(arr):+10,.0f} {sum(1 for x in arr if x <= -599.5):14} {max(arr):+9,.0f}")

    print("\n   AN EVALUATION STARTED ON EACH SESSION, run to the end of the data")
    print("   start        " + "".join(f"{n:>30}" for n in names))
    summ = {n: {"pass": [], "fail": [], "open": []} for n in names}
    for s, d in enumerate(days):
        cells = []
        for name in names:
            r, k, c = run_eval(arrs[name][s:])
            summ[name][r].append((k, c))
            cells.append(f"{r} day {k} ({c:+,.0f})" if r != "open" else f"open after {k} ({c:+,.0f})")
        print(f"   {day(d):%Y-%m-%d}   " + "".join(f"{x:>30}" for x in cells))
    print()
    med = lambda xs: sorted(xs)[len(xs) // 2] if xs else "-"   # noqa: E731
    for name in names:
        s = summ[name]
        print(f"   {name:26} passed {len(s['pass']):2} (median day {med([k for k, _ in s['pass']])}), failed {len(s['fail']):2}"
              f" (median day {med([k for k, _ in s['fail']])}), still open {len(s['open']):2}"
              + (f" (P&L {min(c for _, c in s['open']):+,.0f} .. {max(c for _, c in s['open']):+,.0f})" if s["open"] else ""))
    if a.day:
        print()
        for name in names:
            for t in trades[name]:
                e = datetime.fromtimestamp(t["entTs"] / 1000, CT)
                if e.strftime("%Y-%m-%d") == a.day:
                    print(f"   {a.day}, {name:26}: {'SHORT' if t['dir'] == -1 else 'LONG'} {t['lots']} at {e:%H:%M} CT,"
                          f" out {datetime.fromtimestamp(t['xTs'] / 1000, CT):%H:%M} {t['why']}, {t['pnl']:+.2f}  (ATR {t['atr']:.1f})")


if __name__ == "__main__":
    main()
