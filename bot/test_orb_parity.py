#!/usr/bin/env python3
"""
Parity harness for bot/orb_strategy.py.

The Python ORB module reimplements, stage by stage, logic whose numbers were
measured in JavaScript. This asserts it reproduces research/lib_orb.mjs on real
days, so a mismatch names the stage that broke rather than just moving a count.

    node research/export_orb_fixture.mjs      # regenerate the fixture
    python bot/test_orb_parity.py             # verify

Stages checked:
    1  which days produce a level at all (the 43% that do not are the point)
    2  the level prices and their tap counts
    3  which days produce an entry, and on which minute
    4  side, trigger price, stop distance and lot count
    5  structural properties that must hold whatever the fixture says
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from orb_strategy import (orb_levels, orb_entry, pivots_in, cluster_px,
                          OPEN_CT, TICK, PV, DEFAULT_CFG)

FIXTURE = HERE / "fixture_orb.json"
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


def main():
    if not FIXTURE.exists():
        print(f"Fixture missing: {FIXTURE}\nRun:  node research/export_orb_fixture.mjs")
        return 2
    fx = json.loads(FIXTURE.read_text())
    days = fx["days"]
    print(f"\nFixture: {len(days)} days, generated {fx['generated']}\n")

    # ── 1 + 2. levels ─────────────────────────────────────────
    print("1. level detection")
    lv_missing = lv_extra = lv_px = lv_taps = 0
    have_js = have_py = 0
    for d in days:
        bars = [{"o": r[1], "h": r[2], "l": r[3], "c": r[4], "ct": r[5]} for r in d["bars"]]
        mine = orb_levels(bars)
        theirs = d["levels"]
        if theirs:
            have_js += 1
        if mine:
            have_py += 1
        if theirs and not mine:
            lv_missing += 1
        elif mine and not theirs:
            lv_extra += 1
        elif mine and theirs:
            if abs(mine.hi - theirs["hi"]) > 1e-4 or abs(mine.lo - theirs["lo"]) > 1e-4:
                lv_px += 1
            if mine.taps_hi != theirs["tHi"] or mine.taps_lo != theirs["tLo"]:
                lv_taps += 1

    check(f"days with a level agree ({have_py} python / {have_js} js)",
          have_py == have_js, f"{lv_missing} missing, {lv_extra} extra")
    check("level PRICES match", lv_px == 0, f"{lv_px} days differ")
    check("tap COUNTS match", lv_taps == 0, f"{lv_taps} days differ")
    # The 43% with no level is a property of the strategy, not a bug; assert it
    # so a future change that quietly loosens the detector is visible.
    frac = have_js / len(days)
    check("roughly half the days have no qualifying level",
          0.35 < frac < 0.70, f"{100 * frac:.1f}% do")

    # ── 3 + 4. entries ────────────────────────────────────────
    print("\n2. entry selection")
    en_missing = en_extra = en_ct = en_side = en_px = en_risk = 0
    gapped_n = 0
    js_n = py_n = 0
    for d in days:
        bars = [{"o": r[1], "h": r[2], "l": r[3], "c": r[4], "ct": r[5]} for r in d["bars"]]
        lv = orb_levels(bars)
        theirs = d["entry"]
        if theirs:
            js_n += 1
        mine = None
        if lv:
            # replay minute by minute exactly as the live loop will: hand it
            # every bar from the open up to the one that just closed.
            sess = [b for b in bars if b["ct"] >= OPEN_CT]
            for j in range(1, len(sess) + 1):
                e = orb_entry(lv, sess[:j])
                if e:
                    mine = (sess[j - 1]["ct"], e)
                    break
        if mine:
            py_n += 1
        if theirs and not mine:
            en_missing += 1
        elif mine and not theirs:
            en_extra += 1
        elif mine and theirs:
            ct, e = mine
            if ct != theirs["bar_ct"]:
                en_ct += 1
            if e.side != theirs["dir"]:
                en_side += 1
            # entryPx is lib_orb's modelled FILL after its gap-through guard;
            # a live bot places at the TRIGGER, which the fixture also carries.
            # Tolerance is half a tick because the Python rounds to a tradeable
            # price and the JS does not -- see the rounding check below.
            if abs(e.trigger - theirs["trig"]) > TICK / 2 + 1e-9:
                en_px += 1
            # lib_orb measures risk from the modelled FILL; a live bot can only
            # measure from the TRIGGER it places at, because the fill is not
            # known yet. They agree except when the bar opened past the trigger,
            # and then they differ by exactly that gap -- which is asserted
            # rather than tolerated, below.
            gap = abs(theirs["entryPx"] - theirs["trig"])
            expect = abs(theirs["risk"] - gap) if theirs.get("gapped") else theirs["risk"]
            if abs(e.risk_pts - expect) > TICK / 2 + 1e-9:
                en_risk += 1
            if theirs.get("gapped"):
                gapped_n += 1

    check(f"days with an entry agree ({py_n} python / {js_n} js)",
          py_n == js_n, f"{en_missing} missing, {en_extra} extra")
    check("entry MINUTE matches", en_ct == 0, f"{en_ct} differ")
    check("entry SIDE matches", en_side == 0, f"{en_side} differ")
    check("trigger PRICE matches", en_px == 0, f"{en_px} differ")
    check("risk DISTANCE matches (fill-vs-trigger accounted for)",
          en_risk == 0, f"{en_risk} differ")
    print(f"     {gapped_n} of {js_n} entries had the bar OPEN past the trigger, so the")
    print(f"     realised fill differs from the placed price. That gap is what the live")
    print(f"     FILL CHECK reports; the backtest folds it into risk, the bot cannot.")

    # ── 5. structural properties ──────────────────────────────
    print("\n3. properties that must hold regardless of the fixture")
    bad_side = bad_stop = bad_tgt = bad_risk = bad_lots = over_cap = 0
    n_entries = 0
    for d in days:
        bars = [{"o": r[1], "h": r[2], "l": r[3], "c": r[4], "ct": r[5]} for r in d["bars"]]
        lv = orb_levels(bars)
        if not lv:
            continue
        sess = [b for b in bars if b["ct"] >= OPEN_CT]
        for j in range(1, len(sess) + 1):
            e = orb_entry(lv, sess[:j])
            if not e:
                continue
            n_entries += 1
            # the stop must be on the PROTECTIVE side, always
            if e.side == 1 and not e.stop < e.trigger:
                bad_stop += 1
            if e.side == -1 and not e.stop > e.trigger:
                bad_stop += 1
            # the target must be on the PROFITABLE side, always
            if e.side == 1 and not e.target > e.trigger:
                bad_tgt += 1
            if e.side == -1 and not e.target < e.trigger:
                bad_tgt += 1
            if e.side not in (1, -1):
                bad_side += 1
            if e.risk_pts <= 0:
                bad_risk += 1
            if not 1 <= e.lots <= DEFAULT_CFG["max_lots"]:
                bad_lots += 1
            # sizing must keep the position clear of the $1,000 platform cap
            if e.risk_usd > 1000.0:
                over_cap += 1
            break

    check(f"an inverted stop is impossible ({n_entries} entries)", bad_stop == 0,
          f"{bad_stop} inverted")
    check("target always on the profitable side", bad_tgt == 0, f"{bad_tgt} wrong")
    check("side is always +1 or -1", bad_side == 0, "")
    check("risk distance always positive", bad_risk == 0, "")
    check("lot count inside its bounds", bad_lots == 0, f"{bad_lots} outside")
    check("no position risks more than the $1,000 cap", over_cap == 0,
          f"{over_cap} would")

    # helpers, on hand-built input where the answer is obvious by inspection
    print("\n4. helper unit checks")
    # A perfectly flat series makes EVERY interior bar tie on both sides, and
    # the comparison is >= on purpose (matching the JS), so every one qualifies.
    # Real bars never tie exactly; this pins the tie-handling rather than
    # pretending flat input is filtered out.
    flat = [{"o": 1, "h": 10, "l": 0, "c": 1} for _ in range(9)]
    check("ties count as pivots, both sides", len(pivots_in(flat, 3)) == 6,
          f"got {len(pivots_in(flat, 3))}")
    spike = [{"o": 1, "h": 1, "l": 0, "c": 1} for _ in range(9)]
    spike[4]["h"] = 5
    check("a lone spike is one high pivot", 5.0 in pivots_in(spike, 3), "")
    check("clustering respects the tolerance",
          [c[1] for c in cluster_px([100.0, 100.1, 100.2, 105.0], 0.5, 2)] == [3], "")
    check("a cluster below min_touch is dropped",
          cluster_px([100.0, 105.0], 0.5, 2) == [], "")
    # 100.0 absorbs 100.4; 100.8 is 0.8 from the cluster START so it opens a new
    # one and absorbs 101.2. Two clusters, and the span never exceeds tol -- which
    # is the property that stops a cluster walking across the whole range.
    got = cluster_px([100.0, 100.4, 100.8, 101.2], 0.5, 1)
    check("cluster width is bounded by tol, not drift", len(got) == 2, f"got {got}")

    print("\n" + "=" * 62)
    print(f"  {PASS} passed, {FAIL} failed")
    print("=" * 62)
    for f in FAILURES:
        print("  x " + f)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
