"""Save TopstepX's 1- and 5-minute MNQ bars before they roll off the API.

Read-only: logs in with bot/.env and reads bars; places nothing. TopstepX keeps
these bars for 60 days, so run this at least that often. Each contract's raw
prices go to data/raw/topstepx, in the columns prepare.mjs reads, with symbols
as Databento writes them (MNQZ6). A run adds to what is saved: a bar already
there is kept, and one the API now reports differently is counted, not replaced.

    python bot/pull_topstepx_raw.py [--out data/raw/topstepx]
"""
import argparse
import csv
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import mnq_donchian1250_bot as bm

DAY = 86_400_000
KEPT_DAYS = 60                             # how far back TopstepX serves these bars
SPAN_DAYS = 13                             # at most 10 sessions a request, under the limit
LIMIT = 20_000                             # bars a request
TIMEFRAMES = (1, 5)                        # minutes
COLUMNS = ("ts_event", "open", "high", "low", "close", "volume", "symbol")


def contracts(now):
    """Every quarterly contract that can have bars in the window: (API id, Databento symbol)."""
    a, z = now - timedelta(days=KEPT_DAYS + 2), now + timedelta(days=120)
    q, last = a.year * 4 + (a.month - 1) // 3, z.year * 4 + (z.month - 1) // 3
    out = []
    while q <= last:
        y, code = q // 4, "HMUZ"[q % 4]
        out.append((f"CON.F.US.MNQ.{code}{y % 100}", f"MNQ{code}{y % 10}"))
        q += 1
    return out


def stamp(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000000000Z")


def fetch(api, cid, minutes, start, end):
    rows, t = {}, start
    while t < end:
        stop = min(end, t + SPAN_DAYS * DAY)
        d = api.post("/api/History/retrieveBars", {
            "contractId": cid, "live": False, "startTime": bm.iso(t), "endTime": bm.iso(stop),
            "unit": 2, "unitNumber": minutes, "limit": LIMIT, "includePartialBar": False})
        if not d.get("success", True):
            raise bm.GatewayError(f"errorCode {d.get('errorCode')} {d.get('errorMessage')}")
        bars = d.get("bars") or []
        if len(bars) >= LIMIT:
            raise bm.GatewayError(f"{len(bars)} bars in one request, so some were cut off")
        for b in bars:
            rows[stamp(bm.parse_ts(b["t"]))] = (float(b["o"]), float(b["h"]), float(b["l"]), float(b["c"]), float(b["v"]))
        t = stop
        time.sleep(0.7)                    # History allows 50 requests per 30 s
    return rows


def merge(path, fresh):
    """Add {(ts_event, symbol): bar} to the file at path. Returns (rows, added, differ)."""
    saved = {}
    if path.exists():
        with open(path, newline="") as f:
            for r in csv.DictReader(f):
                saved[r["ts_event"], r["symbol"]] = tuple(float(r[c]) for c in COLUMNS[1:6])
    added = differ = 0
    for key, bar in fresh.items():
        if key not in saved:
            saved[key] = bar
            added += 1
        elif saved[key] != bar:
            differ += 1
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(COLUMNS)
        for (ts, sym), (o, h, l, c, v) in sorted(saved.items()):
            w.writerow((ts, o, h, l, c, int(v), sym))
    os.replace(tmp, path)
    return len(saved), added, differ


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data" / "raw" / "topstepx"))
    a = ap.parse_args()
    bm.log.setLevel(logging.WARNING)
    api = bm.make_api()
    api.login()
    now = datetime.now(timezone.utc)
    end = now.timestamp() * 1000
    start = end - (KEPT_DAYS + 2) * DAY
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    failed = 0
    for minutes in TIMEFRAMES:
        fresh = {}
        for cid, sym in contracts(now):
            try:
                rows = fetch(api, cid, minutes, start, end)
            except bm.GatewayError as e:
                print(f"{cid} {minutes}m FAILED, nothing added for it: {e}")
                failed += 1
                continue
            fresh.update({(ts, sym): bar for ts, bar in rows.items()})
            print(f"{cid} {minutes}m: " + (f"{len(rows):,} bars, {min(rows)[:16]} .. {max(rows)[:16]} UTC" if rows else "no bars"))
        path = out / f"mnq_ohlcv-{minutes}m.csv"
        total, added, differ = merge(path, fresh)
        print(f"{path.name}: {total:,} bars, {added:,} new" + (f", {differ:,} differ from the API now (kept as saved)" if differ else ""))
    print(f"Run again by {now + timedelta(days=KEPT_DAYS):%Y-%m-%d}, or bars start rolling off before they are saved.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
