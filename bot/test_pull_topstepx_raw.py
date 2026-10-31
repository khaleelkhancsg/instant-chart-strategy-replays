"""bot/pull_topstepx_raw.py without the network: which contracts it asks for, how
it pages a window, what it does with the file, and that it only ever reads.

    python bot/test_pull_topstepx_raw.py

A fake gateway stands in for the API, so no login happens and nothing is sent.
"""
from __future__ import annotations

import csv
import io
import sys
import tempfile
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx

import pull_topstepx_raw as pull

DAY = pull.DAY
failures = 0
passed = 0


def check(name, ok, detail=""):
    global failures, passed
    if ok:
        passed += 1
        print(f"  ok   {name}")
    else:
        failures += 1
        print(f"  FAIL {name} {detail}")


def at(y, m, d, h=12):
    return datetime(y, m, d, h, tzinfo=timezone.utc)


def symbols(now):
    return [s for _, s in pull.contracts(now)]


pull.time = SimpleNamespace(sleep=lambda s: None)   # the pause between requests


# ---- which contracts ----
check("today: the expired one still inside the 60 days, the front and the next",
      symbols(at(2026, 10, 31)) == ["MNQU6", "MNQZ6", "MNQH7"], symbols(at(2026, 10, 31)))
check("API ids and Databento symbols line up",
      pull.contracts(at(2026, 10, 31))[1] == ("CON.F.US.MNQ.Z26", "MNQZ6"))
check("the window crosses a year", symbols(at(2027, 1, 15)) == ["MNQZ6", "MNQH7", "MNQM7"], symbols(at(2027, 1, 15)))
check("a contract 60 days gone is dropped", "MNQU6" not in symbols(at(2026, 12, 20)), symbols(at(2026, 12, 20)))
for month in range(1, 13):
    now = at(2027, month, 15)
    got = pull.contracts(now)
    codes = [c.split(".")[-1][0] for c, _ in got]
    check(f"month {month}: quarterly contracts only", set(codes) <= set("HMUZ") and 3 <= len(got) <= 4, got)


# ---- a fake gateway ----
class Fake:
    """Answers retrieveBars with whatever each contract has between start and end."""

    def __init__(self, bars=None, fail=(), login_error=None):
        self.bars, self.fail, self.calls, self.login_error = bars or {}, set(fail), [], login_error
        self.logins = 0

    def login(self):
        self.logins += 1
        if isinstance(self.login_error, Exception):
            raise self.login_error
        if self.login_error:
            raise pull.bm.GatewayError(self.login_error)

    def post(self, path, body):
        self.calls.append((path, body))
        if body["contractId"] in self.fail:
            raise pull.bm.GatewayError(f"{path}: 500")
        s, e = pull.bm.parse_ts(body["startTime"]), pull.bm.parse_ts(body["endTime"])
        rows = [b for t, b in self.bars.get((body["contractId"], body["unitNumber"]), {}).items() if s <= t < e]
        return {"success": True, "bars": rows}


def bar(ms, price=100.0, volume=7):
    return {"t": pull.bm.iso(ms), "o": price, "h": price + 1, "l": price - 1, "c": price, "v": volume}


T0 = int(at(2026, 10, 1).timestamp() * 1000)


# ---- paging ----
api = Fake({("X", 1): {T0 + k * DAY: bar(T0 + k * DAY) for k in range(40)}})
rows = pull.fetch(api, "X", 1, T0, T0 + 40 * DAY)
check("a long window is asked for in pieces, with none of its days lost", len(rows) == 40, len(rows))
check("no request is longer than the limit allows", all(pull.bm.parse_ts(b["endTime"]) - pull.bm.parse_ts(b["startTime"]) <= pull.SPAN_DAYS * DAY for _, b in api.calls))
check("each piece starts where the last ended", all(api.calls[k + 1][1]["startTime"] == api.calls[k][1]["endTime"] for k in range(len(api.calls) - 1)))
check("a forming bar is never saved", all(b["includePartialBar"] is False for _, b in api.calls))
check("minute bars: unit 2, the size asked for", all(b["unit"] == 2 and b["unitNumber"] == 1 for _, b in api.calls))


class Cut(Fake):
    def post(self, path, body):
        return {"success": True, "bars": [bar(T0)] * pull.LIMIT}


try:
    pull.fetch(Cut(), "X", 1, T0, T0 + DAY)
    check("a full page stops the pull: bars may have been cut off", False)
except pull.bm.GatewayError as e:
    check("a full page stops the pull: bars may have been cut off", "cut off" in str(e))


class Refused(Fake):
    def post(self, path, body):
        return {"success": False, "errorCode": 3, "errorMessage": "no"}


try:
    pull.fetch(Refused(), "X", 1, T0, T0 + DAY)
    check("a failed answer is not taken for no bars", False)
except pull.bm.GatewayError as e:
    check("a failed answer is not taken for no bars", "errorCode 3" in str(e))


# ---- the file ----
def saved(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / "mnq_ohlcv-1m.csv"
    a, b, c = "2026-10-01T14:00:00.000000000Z", "2026-10-01T14:01:00.000000000Z", "2026-10-01T14:02:00.000000000Z"
    one = (100.0, 101.0, 99.0, 100.25, 7.0)
    got = pull.merge(path, {(b, "MNQZ6"): one, (a, "MNQZ6"): one})
    check("a first run writes every bar", got == (2, 2, 0), got)
    rows = saved(path)
    check("sorted by time, in the columns the store reads", [r["ts_event"] for r in rows] == [a, b] and list(rows[0]) == list(pull.COLUMNS))
    check("volume is a whole number", rows[0]["volume"] == "7")
    got = pull.merge(path, {(a, "MNQZ6"): (1.0, 2.0, 0.5, 1.5, 9.0), (c, "MNQZ6"): one})
    check("a later run adds what is new and counts what differs", got == (3, 1, 1), got)
    check("a bar already saved is kept", saved(path)[0]["close"] == "100.25")
    check("a bar the API has dropped stays saved", len(saved(path)) == 3)
    check("two contracts in one minute are two bars", pull.merge(path, {(a, "MNQH7"): one})[0] == 4)
    check("no temporary file is left", [p.name for p in Path(tmp).iterdir()] == [path.name])


# ---- a whole run ----
def run(api, tmp):
    pull.bm.make_api = lambda: api
    argv, out = sys.argv, io.StringIO()
    sys.argv = ["pull", "--out", tmp]
    try:
        with redirect_stdout(out):
            code = pull.main()
    finally:
        sys.argv = argv
    return code, out.getvalue()


now = datetime.now(timezone.utc)
ms = int(now.timestamp() * 1000) - 2 * DAY
ms -= ms % 300_000
live = [c for c, _ in pull.contracts(now)]

with tempfile.TemporaryDirectory() as tmp:
    api = Fake({(live[1], 1): {ms: bar(ms)}, (live[1], 5): {ms: bar(ms)}})
    code, text = run(api, tmp)
    check("a clean run exits 0", code == 0, text)
    check("it logs in once", api.logins == 1, api.logins)
    check("it only ever asks for bars: no order, no account, nothing else", {p for p, _ in api.calls} == {"/api/History/retrieveBars"}, {p for p, _ in api.calls})
    check("both bar sizes are saved", sorted(p.name for p in Path(tmp).iterdir()) == ["mnq_ohlcv-1m.csv", "mnq_ohlcv-5m.csv"])
    check("it says when to run again", "Run again by" in text, text)

with tempfile.TemporaryDirectory() as tmp:
    api = Fake({(live[1], 1): {ms: bar(ms)}, (live[1], 5): {ms: bar(ms)}}, fail=[live[0]])
    code, text = run(api, tmp)
    check("one contract failing exits 1, so the store says so", code == 1, code)
    check("it names what failed", "FAILED, nothing added for it" in text, text)
    check("the others are still saved", len(saved(Path(tmp) / "mnq_ohlcv-1m.csv")) == 1)

with tempfile.TemporaryDirectory() as tmp:
    code, text = run(Fake(), tmp)
    check("a run with no bars at all writes empty files and no date", code == 0 and "Run again by" not in text, text)

with tempfile.TemporaryDirectory() as tmp:
    api = Fake(login_error="login failed: errorCode 3")
    code, text = run(api, tmp)
    check("a refused login stops the run, in words", code == 1 and "Could not log in" in text and "errorCode 3" in text, text)
    check("and asks for nothing", api.calls == [])
    check("and writes nothing", not list(Path(tmp).iterdir()))

with tempfile.TemporaryDirectory() as tmp:
    code, text = run(Fake(login_error=httpx.ConnectError("no network")), tmp)
    check("no network at login stops it the same way", code == 1 and "no network" in text, text)

print(f"\n{'=' * 64}\n  {passed} passed, {failures} failed\n{'=' * 64}")
sys.exit(1 if failures else 0)
