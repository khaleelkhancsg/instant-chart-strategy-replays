#!/usr/bin/env python3
"""
Does the $1,250 Donchian bot trade what the research measured?

Checks bot/donchian1250_core.py and bot/mnq_donchian1250_bot.py against the
research engine (research/lib_shipped.mjs, the $1,250 rules), using the golden
fixture research/export_bot1250_fixture.mjs writes from the same data:

  1. 2-minute bars built from the raw 1-minute bars = the engine's, bar for bar
  2. every indicator the strategy reads, on every 2-minute bar: ATR, ADX, the
     Donchian channel, efficiency, the gated signal and the slow-trend rescue,
     the 10-minute EMA direction, the day's range used, the size, the filter
  3. the strategy replayed with the engine's fill model: EVERY 2026 trade --
     direction, entry and exit bar, size, fill price, exit reason, dollars
  4. the 2026 pass rate from those trades = the research's (71.1%)
  5. THE BOT ITSELF -- its order handling, fill tracking and P&L -- replayed
     through 2026 against a simulated ProjectX gateway that fills like the
     engine: the same trades and the same pass rate
  6. the live order path in situations the replay cannot reach: a refused stop,
     a partial fill, an order that fills before it can be cancelled, a restart
     with a position open, the flat time, the day rules

    python test_donchian1250_parity.py            everything (~2 minutes)
    python test_donchian1250_parity.py --quick    the bot over the last 20 sessions
                                                  only (~15 s; the launcher runs this)

The fixture is raw market data, so it is gitignored; this script builds it if
it is missing:
    node --max-old-space-size=8192 research/export_bot1250_fixture.mjs
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import time
from array import array
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
os.environ.setdefault("MNQ_LOG_DIR", str(HERE / "logs_test"))

import donchian1250_core as core                                 # noqa: E402

FIX = HERE / "fixtures"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok)))
    print(("  PASS  " if ok else "  FAIL  ") + name + (("   " + detail) if detail else ""))
    return ok


# ── fixture ─────────────────────────────────────────────────────────────────
_TYPES = {"Float64Array": "d", "Float32Array": "f", "Int32Array": "i", "Int16Array": "h", "Int8Array": "b"}


def read_bin(file, layout):
    raw = (FIX / file).read_bytes()
    assert raw[:4] == b"D125", file + ": bad magic"
    n = int.from_bytes(raw[8:12], "little")
    off, cols = 16, {}
    for name, ctor in layout:
        a = array(_TYPES[ctor])
        size = a.itemsize * n
        a.frombytes(raw[off:off + size])
        off += size
        cols[name] = a
    return n, cols


def load_fixture():
    need = ["donchian1250_1m.bin", "donchian1250_2m.bin", "donchian1250_trades.json"]
    if not all((FIX / f).exists() for f in need):
        print("Fixture missing -- building it from the research data (node) ...")
        root = HERE.parent
        r = subprocess.run(["node", "--max-old-space-size=8192", "research/export_bot1250_fixture.mjs"], cwd=root)
        if r.returncode != 0:
            print("Could not build the fixture. Run from the repo root:\n"
                  "    node --max-old-space-size=8192 research/export_bot1250_fixture.mjs")
            sys.exit(2)
    meta = json.loads((FIX / "donchian1250_trades.json").read_text())
    n1, one = read_bin("donchian1250_1m.bin", meta["layout1m"])
    n2, two = read_bin("donchian1250_2m.bin", meta["layout2m"])
    rows = list(zip(one["ts"], one["open"], one["high"], one["low"], one["close"], one["volume"]))
    return meta, rows, n2, two


# ── 1-4: the strategy against the engine ────────────────────────────────────
def check_strategy(meta, rows, n2, eng):
    print("\n1. TWO-MINUTE BARS from the raw 1-minute bars")
    bars = core.aggregate_2m(rows)
    same = len(bars) == n2
    bad = 0
    for q, b in enumerate(bars[:n2]):
        if not (b.ts == eng["ts"][q] and b.o == eng["open"][q] and b.h == eng["high"][q] and b.l == eng["low"][q]
                and b.c == eng["close"][q] and b.ct == eng["ct"][q] and b.tday == eng["tday"][q]):
            bad += 1
    check(f"{len(bars):,} bars: time, open, high, low, close, CT minute, trading day", same and bad == 0,
          f"engine {n2:,}, {bad} differ")

    print("\n2. EVERY READING THE STRATEGY USES, on every 2-minute bar")
    ind = core.Indicators()
    infos = [ind.add(b) for b in bars]
    first26 = meta["first2026"]
    k26 = next(q for q, b in enumerate(bars) if b.tday >= first26)
    worst = {"atr": 0.0, "adx": 0.0, "eff": 0.0, "dh": 0.0}
    off = {"raw": 0, "sig": 0, "htf": 0, "trend": 0, "enter": 0, "lots": 0}
    n_sig = n_res = n_enter = n_late = 0
    for q in range(k26, n2):
        f = infos[q]
        for key, mine in (("atr", f.atr), ("adx", f.adx), ("eff", f.eff)):
            theirs = eng[key][q]
            if math.isfinite(theirs) or math.isfinite(mine):
                worst[key] = max(worst[key], abs(mine - theirs) / max(1.0, abs(theirs)))
        if not (f.dh == eng["dh"][q] and f.dl == eng["dl"][q]):
            worst["dh"] = max(worst["dh"], 1.0)
        off["raw"] += f.raw != eng["raw"][q]
        off["sig"] += f.sig != eng["sig"][q]
        off["htf"] += f.htf != eng["htf"][q]
        off["trend"] += f.trend != eng["trend"][q]
        off["enter"] += int(f.enter) != eng["enter"][q]
        if f.sig != 0:
            n_sig += 1
            n_res += f.rescued
            off["lots"] += f.lots != eng["lots"][q]
            n_enter += f.enter
            n_late += f.lots == 2
    n = n2 - k26
    check(f"ATR / ADX / efficiency on all {n:,} 2026 bars", max(worst["atr"], worst["adx"], worst["eff"]) < 1e-9,
          f"largest relative differences {worst['atr']:.1e} / {worst['adx']:.1e} / {worst['eff']:.1e}")
    check("Donchian channel (previous 30 bars) on every 2026 bar, exactly", worst["dh"] == 0)
    check("raw breakout on every 2026 bar", off["raw"] == 0, f"{off['raw']} off")
    check("gated signal (efficiency + slow-trend rescue) on every 2026 bar", off["sig"] == 0 and off["trend"] == 0,
          f"{off['sig']} off; {n_sig} signals, {n_res} by the rescue")
    check("10-minute EMA 9/21 direction on every 2026 bar", off["htf"] == 0, f"{off['htf']} off")
    check("size at every signal: 4 lots, 2 late in the day", off["lots"] == 0, f"{off['lots']} off; {n_late} at 2 lots")
    check("which signals the EMA filter lets through", off["enter"] == 0, f"{off['enter']} off; {n_enter} of {n_sig} traded")

    print("\n3. THE STRATEGY REPLAYED THROUGH 2026 with the engine's fills")
    t0 = time.time()
    mine = [t for t in core.reference_replay(bars) if t["tday"] >= first26]
    theirs = [t for t in meta["trades"] if t["tday"] >= first26]
    same = 0
    first_diff = None
    for a, b in zip(mine, theirs):
        ok = (a["entTs"] == b["entTs"] and a["xTs"] == b["xTs"] and a["dir"] == b["dir"] and a["lots"] == b["lots"]
              and a["why"] == b["why"] and abs(a["avg"] - b["avg"]) < 1e-9 and abs(a["pnl"] - b["pnl"]) < 1e-6)
        same += ok
        if not ok and first_diff is None:
            first_diff = (a, b)
    check(f"every 2026 trade: entry and exit bar, direction, size, fill, exit reason, dollars",
          same == len(theirs) == len(mine),
          f"{same} of {len(theirs)} identical (replay {len(mine)}, {time.time() - t0:.1f}s)"
          + (f"\n        first difference: bot {first_diff[0]}\n                          engine {first_diff[1]}" if first_diff else ""))

    print("\n4. THE 2026 PASS RATE from the replayed trades")
    pr = pass_rates(mine, meta)
    want = meta["pass2026"]
    check("pass rate = the research's", all(abs(pr[k] - want[k]) < 1e-9 for k in ("y", "a", "b", "real")),
          f"{pr['y']:.1f}% (Jan-Mar {pr['a']:.1f}, Apr-Jul {pr['b']:.1f}), real windows {pr['real']:.1f}%   "
          f"research {want['y']:.1f}% ({want['a']:.1f}, {want['b']:.1f}), {want['real']:.1f}%")
    return bars, infos


def pass_rates(trades, meta):
    rules = meta["rules"]
    kw = {"target": rules["target"], "dd": rules["dd"], "consistency": rules["consistency"]}
    by = {}
    for t in trades:
        by[t["tday"]] = by.get(t["tday"], 0.0) + t["pnl"]
    arr = lambda days: [by.get(d, 0.0) for d in days]          # noqa: E731
    d26 = arr(meta["days2026"])
    real = [core.ev_with(d26[q:q + 21], **kw) for q in range(len(d26) - 21 + 1)]
    return {"y": core.pass_rate(d26, **kw), "a": core.pass_rate(arr(meta["days2026a"]), **kw),
            "b": core.pass_rate(arr(meta["days2026b"]), **kw), "real": 100.0 * sum(real) / len(real)}


def main():
    t0 = time.time()
    print("=" * 100)
    print("THE $1,250 DONCHIAN BOT vs the research engine (research/export_bot1250_fixture.mjs)")
    print("=" * 100)
    meta, rows, n2, eng = load_fixture()
    check_strategy(meta, rows, n2, eng)
    if "--strategy-only" not in sys.argv:
        import logging
        import mnq_donchian1250_bot as bm                           # noqa: E402
        import test_donchian1250_bot as tb                          # noqa: E402
        counts = {"WARNING": 0, "ERROR": 0}

        class _Count(logging.Handler):
            def emit(self, record):
                if record.levelname in counts:
                    counts[record.levelname] += 1
        bm.log.setLevel(logging.INFO if "--verbose" in sys.argv else logging.WARNING)
        if "--verbose" not in sys.argv:
            for h in list(bm.log.handlers):
                bm.log.removeHandler(h)
        bm.log.addHandler(_Count())
        tb.run_all(meta, rows, check, pass_rates, quick="--quick" in sys.argv)
        print(f"        (the bot logged {counts['WARNING']} warnings and {counts['ERROR']} errors across all of section 5-6;"
              f" the scenarios in 6 provoke some on purpose)")
    bad = [n for n, ok in RESULTS if not ok]
    print("\n" + "=" * 100)
    print(f"{len(RESULTS) - len(bad)} of {len(RESULTS)} checks passed ({time.time() - t0:.0f}s)")
    if bad:
        print("FAILED:\n  " + "\n  ".join(bad))
    print("=" * 100)
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
