"""Forward check of research/full_stop_sizing.mjs on TopstepX's own bars, from
2026-09-01 (after the research data ends) to --end (default today).

Read-only: logs in with bot/.env and reads 1-minute bars; places nothing.
TopstepX keeps 1-minute history from 2026-08-23 only, so a week of warm-up, then
the evaluation from Sep 1. The September contract (U26) up to its roll, the
December (Z26) after, each with its own warm-up (no back-adjustment needed); add
the March contract to PERIODS after the December roll. Every trade is replayed
with the engine's fill model (donchian1250_core.reference_replay) at these sizes:
  shipped            4 lots (2 late), stop = the nearer of 5 ATR and the $600 line
  full 5 ATR, max 4  the most lots for which the FULL 5 ATR stop fits in $600
  full 5 ATR, max 12 the same, allowed above 4 when the market is calm
  3 ATR, max 4       the most lots for which at least 3 ATR of stop fits in $600
plus, as a diagnostic only, 4 lots with NO $600 line (every stop the full 5 ATR),
to show what the trades the line stopped would have done.

RESULT (Sep 1-Oct 22 2026, 38 trading days): the full stop came out ahead here,
against 5 years of history (research/full_stop_sizing.mjs):
  sizing                  trades  avg lots  net $   drawn passes  real 21-day windows
  shipped: 4 lots             29      3.79  +1,484     62.4%        17 of 18
  full 5 ATR stop, max 4      51      1.82  +1,970     67.7%        17 of 18
  at least 3 ATR, max 4       36      2.89  +1,514     56.3%        18 of 18
The line stopped 4 trades; with the full stop at 4 lots three bounced (-143,
+364, -85; 2026-10-22 -$85 at 4 lots, -$21 at the full-stop size of 1) and one
lost -$1,350. The full-stop book's 22 extra trades (days the shipped book was
done) made +$936; in 2026's research data its 70 extra trades lost -$1,394.
The shipped stop was cut on 83% of trades (78% in Jan-Jul 2026).

    python bot/forward_full_stop_sizing.py [--end 2026-11-30]
"""
import argparse
import logging
from datetime import datetime, timezone

import donchian1250_core as core
import mnq_donchian1250_bot as bm

CT = core.CT_TZ
PV, CAPD = 2.0, 600.0
RULES = {"shipped: 4 lots": None, "full 5 ATR stop, max 4": (5, 4), "full 5 ATR stop, max 12": (5, 12),
         "at least 3 ATR of stop, max 4": (3, 4)}
WIDE = "diagnostic: 4 lots, no $600 line"
WIDE_CFG = {**core.CFG, "day_cap": 1e9}


def ms(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=CT).timestamp() * 1000


def lots_for(atr, rule):
    m, cap = rule
    per_lot = ((m + 0.15) * atr + 0.5) * PV + 1.5    # the stop from the fill, a tick each way, $0.75 a side
    return max(1, min(cap, int(CAPD // per_lot)))


class Sized(core.Strategy):
    rule = None

    def finish_bar(self, bar):
        info = super().finish_bar(bar)
        if self.rule is not None:
            L = lots_for(info.atr, self.rule)
            # half late in the day, rounded like the research (Math.round: halves up)
            info.lots = max(1, int(L / 2 + 0.5)) if info.used >= core.CFG["late_range_adr"] else L
        return info


def replay(bars, rule, cfg=core.CFG):
    saved, Sized.rule, core.Strategy = core.Strategy, rule, Sized
    try:
        return core.reference_replay(bars, cfg)
    finally:
        core.Strategy = saved


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--end", default=datetime.now(CT).strftime("%Y-%m-%d"), help="last session, YYYY-MM-DD (default today)")
    end = datetime.strptime(ap.parse_args().end, "%Y-%m-%d")
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
    t_end = ms(end.year, end.month, end.day, 16)
    periods = [("CON.F.US.MNQ.U26", ms(2026, 8, 23), ms(2026, 9, 11, 16), core.trading_day(ms(2026, 9, 1, 9)), min(roll - 1, last)),
               ("CON.F.US.MNQ.Z26", ms(2026, 8, 23), t_end, roll, last)]

    days_all, results, vols, sig_atr = [], {k: {} for k in [*RULES, WIDE]}, [], []
    for cid, t0, t1, d0, d1 in periods:
        if d1 < d0:
            continue
        rows = fetch(cid, t0, t1)
        bars = core.aggregate_2m(rows)
        ind = core.Indicators()
        byday = {}
        for b in bars:
            i = ind.add(b)
            if d0 <= b.tday <= d1 and 510 <= b.ct < 900:
                byday.setdefault(b.tday, []).append(i.atr)
                if i.sig != 0 and i.enter:
                    sig_atr.append(i.atr)
        vols += [(d, sorted(v)[len(v) // 2]) for d, v in byday.items()]
        days_all += sorted(byday)
        day = lambda d: datetime.fromtimestamp((d + 0.5) * 86400, timezone.utc)   # noqa: E731
        print(f"{cid}: {len(rows):,} one-minute bars, evaluated {len(byday)} trading days {day(d0):%m-%d} .. {day(d1):%m-%d}")
        for name, rule in [*RULES.items(), (WIDE, None)]:
            for t in replay(bars, rule, WIDE_CFG if name == WIDE else core.CFG):
                if d0 <= t["tday"] <= d1:
                    results[name][t["entTs"]] = t

    days_all = sorted(set(days_all))
    vols.sort()
    med = lambda xs: sorted(xs)[len(xs) // 2]                                              # noqa: E731
    q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))]                       # noqa: E731
    print(f"\nVOLATILITY (median 2-min ATR of a session's 08:30-15:00): the period {med([v for _, v in vols]):.1f},"
          f" last 10 sessions {med([v for _, v in vols[-10:]]):.1f}; at the traded signals {med(sig_atr):.1f}"
          f"   (Jan-Jul 2026 research data: sessions 21.4, signals 26.2)")

    def evaluate(trades):
        by = {}
        for t in trades:
            by[t["tday"]] = by.get(t["tday"], 0.0) + t["pnl"]
        arr = [by.get(d, 0.0) for d in days_all]
        kw = dict(target=1250, dd=1000, consistency=0.5)
        real = [core.ev_with(arr[s:s + 21], **kw) for s in range(len(arr) - 20)]
        return arr, core.pass_rate(arr, **kw), 100 * sum(real) / max(1, len(real)), len(real)

    book = {n: sorted(results[n].values(), key=lambda t: t["entTs"]) for n in results}
    arrs = {}
    print(f"\nFORWARD: {len(days_all)} trading days; engine fills, 1 tick + $0.75 a side")
    print("   sizing                          trades  avg lots   win%  stopped     net $  $/trade  $/lot  worst day   pass (21-day draws)   real 21-day windows")
    for name in RULES:
        T = book[name]
        arr, p, real, nreal = evaluate(T)
        arrs[name] = arr
        n = max(1, len(T))
        stopped = sum(1 for t in T if t["why"] in ("SL", "SLcap"))
        net = sum(t["pnl"] for t in T)
        print(f"   {name:31} {len(T):6}  {sum(t['lots'] for t in T) / n:8.2f} {100 * sum(t['pnl'] > 0 for t in T) / n:6.1f}"
              f"  {100 * stopped / n:6.1f}%  {net:+8,.0f}  {net / n:+7.0f} {net / max(1, sum(t['lots'] for t in T)):+6.0f}"
              f"  {min(arr, default=0):+9,.0f}   {p:8.1f}%             {real:6.1f}% of {nreal}")

    # how often the shipped stop was cut (as in research/full_stop_sizing.mjs section 4)
    ship = book["shipped: 4 lots"]
    day_, real_, cut, stop_atr, atrs = None, 0.0, 0, [], []
    for t in ship:
        if t["tday"] != day_:
            day_, real_ = t["tday"], 0.0
        cap_d, raw_d = (600 + real_) / (2 * t["lots"]), 5.15 * t["atr"] + 0.25
        cut += cap_d < raw_d
        stop_atr.append(min(cap_d, raw_d) / t["atr"])
        atrs.append(t["atr"])
        real_ += t["pnl"]
    if ship:
        n = len(ship)
        print(f"\n   the shipped stop: cut on {100 * cut / n:.0f}% of {n} trades, median {med(stop_atr):.2f} ATR; 2-min ATR at the signal"
              f" quartiles {q(atrs, .25):.1f} / {q(atrs, .5):.1f} / {q(atrs, .75):.1f}, {100 * sum(a >= 40 for a in atrs) / n:.0f}% at 40 or more"
              f"   (Jan-Jul 2026: cut on 78%, 19.5 / 26.2 / 35.5, 17% at 40+)")

    print("\n   SHIPPED TRADES STOPPED AT THE $600 LINE -> the same trade with the full 5 ATR stop (4 lots, no line; diagnostic)")
    for t in ship:
        if t["why"] == "SLcap":
            w = results[WIDE].get(t["entTs"])
            e = datetime.fromtimestamp(t["entTs"] / 1000, CT)
            print(f"     {e:%m-%d %H:%M} {'SHORT' if t['dir'] == -1 else 'LONG ':5} {t['lots']}  ATR {t['atr']:5.1f}   at the line {t['pnl']:+8.0f}"
                  + (f"   full stop: {w['why']:5} {w['pnl']:+8.0f} ({w['pnl'] / w['lots']:+.0f} a lot)" if w else "   (no match)"))

    print("\n   SHIPPED vs EACH SIZING, trade for trade          trades   shipped $   $/lot      sizing $   $/lot")
    A = results["shipped: 4 lots"]
    tot = lambda xs: sum(t["pnl"] for t in xs)                                                # noqa: E731
    lot = lambda xs: tot(xs) / max(1, sum(t["lots"] for t in xs))                             # noqa: E731
    for name in list(RULES)[1:]:
        B = results[name]
        both, bothB = [A[k] for k in A if k in B], [B[k] for k in A if k in B]
        onlyA, onlyB = [A[k] for k in A if k not in B], [B[k] for k in B if k not in A]
        print(f"   {name:31} both         {len(both):6} {tot(both):+11,.0f} {lot(both):+7.0f} {tot(bothB):+13,.0f} {lot(bothB):+7.0f}")
        print(f"   {'':31} only shipped {len(onlyA):6} {tot(onlyA):+11,.0f} {lot(onlyA):+7.0f}")
        print(f"   {'':31} only sizing  {len(onlyB):6} {'':19} {tot(onlyB):+13,.0f} {lot(onlyB):+7.0f}")

    names = list(RULES)
    print("\n   DAYS WHERE THE BOOKS DIFFER    " + "".join(f"{n[:22]:>24}" for n in names))
    for k, d in enumerate(days_all):
        vals = [arrs[n][k] for n in names]
        if max(vals) - min(vals) > 0.5:
            print(f"   {datetime.fromtimestamp((d + 0.5) * 86400, timezone.utc):%Y-%m-%d}                  " + "".join(f"{v:+24,.0f}" for v in vals))


if __name__ == "__main__":
    main()
