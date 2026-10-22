"""TopstepX 1-minute MNQ bars as one continuous series in the lab's binary format
(src/data.mjs, "MNQB" v2), so research code can run on the bars the bot trades:
lib_shipped.mjs reads the file ORB_BIN names, and research/forward_macd_sizing.mjs
takes it as its first argument.

Read-only: logs in with bot/.env and reads bars; places nothing. TopstepX keeps
1-minute history from 2026-08-23. Each contract covers the trading days from its
roll to the next one; earlier contracts' prices are shifted by the spread to the
next contract on the last session before each roll (the median over the minutes
both traded), as prepare.mjs splices contracts. Add the next contract to
CONTRACTS after each roll. tday / ctMin come from donchian1250_core, bit-identical
to prepare.mjs's.

    python bot/export_topstepx_bin.py [--out data/topstepx_1m.bin] [--end 2026-10-22]
"""
import argparse
import logging
from array import array
from datetime import datetime
from pathlib import Path

import donchian1250_core as core
import mnq_donchian1250_bot as bm

CT = core.CT_TZ
START = (2026, 8, 23)                     # TopstepX's 1-minute history begins here
CONTRACTS = [("CON.F.US.MNQ.U26", None),  # (contract, the trading day it takes over)
             ("CON.F.US.MNQ.Z26", (2026, 9, 11))]


def ms(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=CT).timestamp() * 1000


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data" / "topstepx_1m.bin"))
    ap.add_argument("--end", default=datetime.now(CT).strftime("%Y-%m-%d"), help="last session, YYYY-MM-DD (default today)")
    a = ap.parse_args()
    end = datetime.strptime(a.end, "%Y-%m-%d")
    t_end = ms(end.year, end.month, end.day, 16)
    bm.log.setLevel(logging.WARNING)
    api = bm.make_api()
    api.login()

    def fetch(cid):
        rows, t = {}, ms(*START)
        while t < t_end:
            for b in api.bars(cid, False, t, min(t_end, t + 13 * 86_400_000), partial=False):
                if float(b.get("v") or 0) > 0:
                    rows[bm.parse_ts(b["t"])] = (float(b["o"]), float(b["h"]), float(b["l"]), float(b["c"]), float(b["v"]))
            t += 13 * 86_400_000
        return rows

    data = [fetch(cid) for cid, _ in CONTRACTS]
    rolls = [None] + [core.trading_day(ms(*r, 9)) for _, r in CONTRACTS[1:]]
    # the spread to the next contract on the last session before each roll
    shift = [0.0] * len(CONTRACTS)
    for i in range(len(CONTRACTS) - 2, -1, -1):
        prev, nxt, roll = data[i], data[i + 1], rolls[i + 1]
        shared = [ts for ts in prev if ts in nxt and core.trading_day(ts) < roll and 510 <= core.ct_minute(ts) < 900]
        last = max(core.trading_day(ts) for ts in shared)
        d = sorted(nxt[ts][3] - prev[ts][3] for ts in shared if core.trading_day(ts) == last)
        spread = round(d[len(d) // 2] / 0.25) * 0.25
        shift[i] = shift[i + 1] + spread
        print(f"{CONTRACTS[i][0]} -> {CONTRACTS[i + 1][0]}: spread {spread:+.2f} on the session before the roll ({len(d)} shared minutes)")
    rows = []
    for i, rws in enumerate(data):
        lo, hi = rolls[i], rolls[i + 1] if i + 1 < len(rolls) else None
        for ts, (o, h, l, c, v) in rws.items():
            td = core.trading_day(ts)
            if (lo is None or td >= lo) and (hi is None or td < hi):
                rows.append((ts, o + shift[i], h + shift[i], l + shift[i], c + shift[i], v))
    rows.sort()
    cols = list(zip(*rows))
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        f.write(b"MNQB")
        f.write(array("I", [2, len(rows), 0]).tobytes())
        f.write(array("d", cols[0]).tobytes())
        for c in cols[1:6]:
            f.write(array("f", c).tobytes())
        f.write(array("i", [core.trading_day(ts) for ts in cols[0]]).tobytes())
        f.write(array("h", [core.ct_minute(ts) for ts in cols[0]]).tobytes())
    first, last = (datetime.fromtimestamp(x / 1000, CT) for x in (rows[0][0], rows[-1][0]))
    print(f"wrote {len(rows):,} bars, {first:%Y-%m-%d %H:%M} .. {last:%Y-%m-%d %H:%M} CT, to {out}")


if __name__ == "__main__":
    main()
