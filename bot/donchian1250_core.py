"""
MNQ Donchian for the $1,250-target evaluation -- the strategy, with no I/O.

This is the research engine (research/lib_shipped.mjs, run with the $1,250
rules exactly as tradovate/verify_1250.mjs and research/combos_2026.mjs run it)
rewritten as a bar-by-bar state machine the live bot can drive. Nothing here
talks to a broker: the bot (mnq_donchian1250_bot.py) feeds it bars and fills,
and carries out the orders it asks for. bot/test_donchian1250_parity.py checks
every stage against the engine, and replays 2026 through it trade for trade.

THE STRATEGY (2-minute bars, clock-aligned)
  signal   close outside the PREVIOUS 30 bars' high/low, ADX(14) >= 25, Kaufman
           efficiency(20) >= 0.5, bar opening 08:30 <= t < 15:00 CT. Or the
           slow-trend rescue: efficiency 0.45-0.5 when the 2-min EMA 125 is on
           the breakout's side of the EMA 500.
  filter   only when the 10-MINUTE EMA 9 is on the breakout's side of the 10-min
           EMA 21 (10-min bars that have closed by the signal bar's close)
  size     4 lots; 2 once the day's RTH range has covered 90% of the average RTH
           range of the previous 10 sessions
  entry    the bar after the signal arms a stop-entry 0.15 x ATR beyond that
           bar's OPEN; it can fill from the next bar on, for 10 bars. If that
           next bar opens already through it, it rests as a LIMIT at the same
           price instead. A signal the other way cancels it.
  bracket  stop 5 x ATR from the arm bar's open, or nearer where the day would
           reach the $600 limit; target 1.75 x ATR from the arm bar's open
  exits    the bracket; out at the next open if the trade has not been 1 ATR in
           profit by the 20th bar after entry (40 minutes); an opposite signal
           (reversing); flat at the first bar opening at/after 15:05 CT
           (i.e. 15:06). Exits decided on a closed bar happen at the next open,
           after a gap through the stop at that open and before that bar's range.
  day      no new orders once the day is -$300 (breaker), +$250 (profit block)
           or at the -$600 limit. Days roll at 17:00 New York.

ARITHMETIC: every indicator here repeats src/indicators.mjs operation for
operation (EMA alpha 2/(n+1) seeded with the first value -- NOT Wilder), and
2-minute bars are built like src/resample.mjs (clock-aligned on the epoch,
float32 prices, the bar's CT minute is its FIRST 1-minute bar's). Change
nothing here without re-running the parity test.
"""

from __future__ import annotations

import math
import struct
from collections import deque
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

try:
    from zoneinfo import ZoneInfo
except ImportError:                                     # pragma: no cover
    from backports.zoneinfo import ZoneInfo             # type: ignore

CT_TZ = ZoneInfo("America/Chicago")
NY_TZ = ZoneInfo("America/New_York")
BUCKET_MS = 120_000          # 2-minute bars
HTF_MS = 600_000             # 10-minute bars for the EMA filter

CFG = {
    # signal
    "period": 30, "adx_period": 14, "adx_min": 25.0, "atr_period": 14,
    "eff_period": 20, "eff_min": 0.5,
    "rescue_min": 0.45, "trend_fast": 125, "trend_slow": 500, "rescue_floor_bars": 1500,
    "start_ct": 510, "end_ct": 900,          # signal bars opening 08:30 <= t < 15:00 CT; also the RTH range window
    # 10-minute EMA filter
    "ema_fast": 9, "ema_slow": 21,
    # orders
    "no_entry_ct": 895,                      # no new order on a bar opening at/after 14:55 CT
    "flat_ct": 905,                          # flat at the first bar opening at/after 15:05 CT
    "trig_atr": 0.15, "arm_bars": 10, "sl_atr": 5.0, "tp_atr": 1.75,
    "contracts": 4, "late_contracts": 2, "late_range_adr": 0.9, "adr_sessions": 10,
    "time_exit_bars": 20, "time_exit_atr": 1.0,
    # day rules
    "day_cap": 600.0, "breaker": 300.0, "profit_block": 250.0,
    # instrument
    "point_value": 2.0, "tick": 0.25,
}

_F32 = struct.Struct("<f")


def f32(x: float) -> float:
    """Round to single precision, as the engine's Float32Array bars are stored."""
    return _F32.unpack(_F32.pack(x))[0]


# ── time: the same conventions as prepare.mjs ─────────────────────────────────
_hour_cache: Dict[int, Tuple[int, int]] = {}


def _hour_info(hr: int) -> Tuple[int, int]:
    """(CT minute-of-day at the start of this UTC hour, CME trading day)."""
    v = _hour_cache.get(hr)
    if v is None:
        dt = datetime.fromtimestamp(hr * 3600, timezone.utc)
        ct = dt.astimezone(CT_TZ)
        ny = dt.astimezone(NY_TZ)
        d = ny.date()
        if ny.hour >= 17:                       # the CME day rolls at 17:00 New York
            d = d + timedelta(days=1)
        v = (ct.hour * 60 + ct.minute, (d - date(1970, 1, 1)).days)
        if len(_hour_cache) > 200_000:
            _hour_cache.clear()
        _hour_cache[hr] = v
    return v


def ct_minute(ms: float) -> int:
    hr = int(ms // 3_600_000)
    base, _ = _hour_info(hr)
    return (base + int((ms - hr * 3_600_000) // 60_000)) % 1440


def trading_day(ms: float) -> int:
    return _hour_info(int(ms // 3_600_000))[1]


# ── 2-minute bars ─────────────────────────────────────────────────────────────
class Bar:
    """A clock-aligned 2-minute bar. ts = the bucket start (ms); ct = the CT minute
    of its FIRST 1-minute bar; tday = the trading day of its last one."""
    __slots__ = ("ts", "o", "h", "l", "c", "v", "ct", "tday")

    def __init__(self, ts, o, h, l, c, v, ct, tday):
        self.ts, self.o, self.h, self.l, self.c, self.v, self.ct, self.tday = ts, o, h, l, c, v, ct, tday

    def __repr__(self):                                       # pragma: no cover
        t = datetime.fromtimestamp(self.ts / 1000, timezone.utc).astimezone(CT_TZ)
        return f"Bar({t:%Y-%m-%d %H:%M} CT O{self.o} H{self.h} L{self.l} C{self.c})"


def aggregate_2m(rows) -> List[Bar]:
    """1-minute bars (ts_ms, o, h, l, c, v), ascending, -> 2-minute bars, exactly
    as src/resample.mjs builds them. Every bucket seen is returned: the caller
    decides whether the last one is complete."""
    out: List[Bar] = []
    cur = None
    for ts, o, h, l, c, v in rows:
        b = int(ts // BUCKET_MS)
        if b != cur:
            cur = b
            out.append(Bar(b * BUCKET_MS, f32(o), f32(h), f32(l), f32(c), 0.0, ct_minute(ts), trading_day(ts)))
        bar = out[-1]
        hh, ll = f32(h), f32(l)
        if hh > bar.h:
            bar.h = hh
        if ll < bar.l:
            bar.l = ll
        bar.c = f32(c)
        bar.v += v
        bar.tday = trading_day(ts)
    return out


# ── indicators, one bar at a time ─────────────────────────────────────────────
class Info:
    """Everything the strategy reads from one closed 2-minute bar."""
    __slots__ = ("i", "ts", "o", "h", "l", "c", "ct", "tday", "atr", "adx", "dh", "dl", "eff",
                 "raw", "sig", "trend", "htf", "used", "lots", "enter", "rescued")


class Indicators:
    """src/indicators.mjs, incrementally. Call add() with each closed bar in order."""

    def __init__(self, cfg: dict = CFG):
        self.k = cfg
        self.n = 0
        p = cfg["period"]
        self._hq: deque = deque(maxlen=p)          # the previous `period` highs / lows
        self._lq: deque = deque(maxlen=p)
        self._cq: deque = deque(maxlen=cfg["eff_period"] + 1)
        self._path = 0.0
        self._prev: Optional[Bar] = None
        self._atr = self._trx = self._pdmx = self._ndmx = self._adx = math.nan
        self._tf = self._ts = math.nan
        a = 2.0 / (cfg["atr_period"] + 1)
        self._aA, self._bA = a, 1.0 - a
        a = 2.0 / (cfg["adx_period"] + 1)
        self._aX, self._bX = a, 1.0 - a
        a = 2.0 / (cfg["trend_fast"] + 1)
        self._aF, self._bF = a, 1.0 - a
        a = 2.0 / (cfg["trend_slow"] + 1)
        self._aS, self._bS = a, 1.0 - a
        a = 2.0 / (cfg["ema_fast"] + 1)
        self._aHF, self._bHF = a, 1.0 - a
        a = 2.0 / (cfg["ema_slow"] + 1)
        self._aHS, self._bHS = a, 1.0 - a
        # 10-minute EMA state
        self._hF = self._hS = math.nan
        self._bkt = None            # 10-min bucket of the previous bar
        self._bkt_closed = None     # the last 10-min bucket already folded into the EMAs
        self._prev_c = math.nan
        # the day's RTH range and the average of the previous sessions'
        self._tday = None
        self._rhi = self._rlo = math.nan
        self._day_hist: deque = deque(maxlen=cfg["adr_sessions"])   # previous sessions' ranges (None = no RTH)
        self._adr = None

    @staticmethod
    def _ema(a, b, x, prev):
        return x if not math.isfinite(prev) else a * x + b * prev

    def add(self, bar: Bar) -> Info:
        k, i, prev = self.k, self.n, self._prev
        h, l, c = bar.h, bar.l, bar.c
        # true range: indicators.mjs trueRange (atr) and adx() take the same three values
        if prev is None:
            tr = h - l
            pdm = ndm = 0.0
        else:
            pc = prev.c
            a_, b_, c_ = h - l, abs(h - pc), abs(l - pc)
            tr = (a_ if a_ > c_ else c_) if a_ > b_ else (b_ if b_ > c_ else c_)
            up, dn = h - prev.h, prev.l - l
            pdm = up if (up > dn and up > 0) else 0.0
            ndm = dn if (dn > up and dn > 0) else 0.0
        self._atr = self._ema(self._aA, self._bA, tr, self._atr)
        self._trx = self._ema(self._aX, self._bX, tr, self._trx)
        self._pdmx = self._ema(self._aX, self._bX, pdm, self._pdmx)
        self._ndmx = self._ema(self._aX, self._bX, ndm, self._ndmx)
        a = self._trx
        pdi = 0.0 if a == 0 else (100 * self._pdmx) / a
        ndi = 0.0 if a == 0 else (100 * self._ndmx) / a
        s = pdi + ndi
        dx = 0.0 if s == 0 else (100 * abs(pdi - ndi)) / s
        self._adx = self._ema(self._aX, self._bX, dx, self._adx)
        # Donchian over the PREVIOUS `period` bars
        p = k["period"]
        if i >= p:
            dh, dl = max(self._hq), min(self._lq)
        else:
            dh = dl = math.nan
        self._hq.append(h)
        self._lq.append(l)
        # Kaufman efficiency, the running path exactly as efficiencyRatio()
        q = k["eff_period"]
        cq = self._cq
        if i >= 1:
            self._path += abs(c - cq[-1])
            if i > q:
                self._path -= abs(cq[-q] - cq[-q - 1])     # |C[i-q] - C[i-q-1]|
        cq.append(c)
        if i >= q:
            eff = 0.0 if self._path == 0 else abs(c - cq[0]) / self._path
        else:
            eff = math.nan
        # slow trend
        self._tf = self._ema(self._aF, self._bF, c, self._tf)
        self._ts = self._ema(self._aS, self._bS, c, self._ts)
        d = self._tf - self._ts
        trend = 1 if d > 0 else (-1 if d < 0 else 0)
        # raw breakout and the gate
        raw = 0
        if i >= p and not (self._adx < k["adx_min"]):
            if c > dh:
                raw = 1
            elif c < dl:
                raw = -1
        in_win = k["start_ct"] <= bar.ct < k["end_ct"]
        plain = raw if (raw != 0 and in_win and math.isfinite(eff) and eff >= k["eff_min"]) else 0
        rescued = (plain == 0 and raw != 0 and in_win and i + 1 >= k["rescue_floor_bars"]
                   and math.isfinite(eff) and eff >= k["rescue_min"] and trend == raw)
        sig = plain if plain != 0 else (raw if rescued else 0)
        # the 10-minute EMA 9/21: a bucket counts once it has closed -- at the close
        # of its last 2-minute slot, or when the next bucket's first bar arrives
        bkt = bar.ts // HTF_MS
        if self._bkt is not None and self._bkt != bkt and self._bkt_closed != self._bkt:
            self._fold10(self._prev_c)
            self._bkt_closed = self._bkt
        if bar.ts - bkt * HTF_MS == HTF_MS - BUCKET_MS:
            self._fold10(c)
            self._bkt_closed = bkt
        self._bkt = bkt
        self._prev_c = c
        htf = 0
        if math.isfinite(self._hF):
            e = self._hF - self._hS
            htf = 1 if e > 0 else (-1 if e < 0 else 0)
        # the day's RTH range against the previous sessions' (research/lib_donchian_mgmt.mjs adrUsed)
        if bar.tday != self._tday:
            if self._tday is not None:
                self._day_hist.append(self._rhi - self._rlo if self._rhi > self._rlo else None)
            self._tday = bar.tday
            self._rhi = self._rlo = math.nan
            r = [x for x in self._day_hist if x is not None and x > 0]
            self._adr = (sum_in_order(r) / len(r)) if r else None
        if in_win:
            self._rhi = h if not math.isfinite(self._rhi) else max(self._rhi, h)
            self._rlo = l if not math.isfinite(self._rlo) else min(self._rlo, l)
            used = (self._rhi - self._rlo) / self._adr if self._adr else 0.0
        else:
            used = math.nan if self._adr else 0.0
        lots = k["late_contracts"] if used >= k["late_range_adr"] else k["contracts"]
        enter = sig != 0 and htf == sig

        info = Info()
        info.i, info.ts, info.o, info.h, info.l, info.c, info.ct, info.tday = i, bar.ts, bar.o, h, l, c, bar.ct, bar.tday
        info.atr, info.adx, info.dh, info.dl, info.eff = self._atr, self._adx, dh, dl, eff
        info.raw, info.sig, info.trend, info.htf, info.used, info.lots, info.enter = raw, sig, trend, htf, used, lots, enter
        info.rescued = bool(rescued)
        self._prev = bar
        self.n += 1
        return info

    def _fold10(self, x):
        self._hF = self._ema(self._aHF, self._bHF, x, self._hF)
        self._hS = self._ema(self._aHS, self._bHS, x, self._hS)


def sum_in_order(xs) -> float:
    s = 0.0
    for x in xs:
        s += x
    return s


# ── the order logic ───────────────────────────────────────────────────────────
class Action:
    """What the strategy wants done now. kind: 'cancel_arm' | 'place_arm' | 'close'."""
    __slots__ = ("kind", "why", "dir", "px", "lots", "limit")

    def __init__(self, kind, why="", dir=0, px=0.0, lots=0, limit=False):
        self.kind, self.why, self.dir, self.px, self.lots, self.limit = kind, why, dir, px, lots, limit

    def __repr__(self):                                       # pragma: no cover
        if self.kind == "place_arm":
            return f"Action(place {'LIMIT' if self.limit else 'STOP'} {'BUY' if self.dir == 1 else 'SELL'} {self.lots} @ {self.px:.4f})"
        return f"Action({self.kind} {self.why})"


class Strategy:
    """The engine's state machine, split at the points where a live bot has to
    wait for the market. For bar i, in this order:

        begin_bar(i, ...)    at bar i's OPEN: a new day resets the day rules; a
                             resting order is cancelled (flat time, 10 bars up, day
                             rules, a signal the other way) or, on its first live
                             bar, placed as a stop -- or a limit if the open is
                             already through it; an open trade is closed at the
                             flat time
        <broker>             a stop the open gapped through fills at the open
        open_exits(i)        the exits decided on the closed bar: 40-minute exit,
                             opposite signal -- at the open
        <broker>             the bar trades: the resting order may fill
                             (on_entry_fill), the stop or target may fill (on_exit)
        finish_bar(bar i)    bar i has closed: arm from the PREVIOUS bar's signal
                             at bar i's open (if nothing filled or exited this bar,
                             or the trade was reversed at the open), then read
                             bar i's indicators

    The engine does exactly this inside one loop iteration; see
    reference_replay() for the iteration rebuilt from these pieces.
    """

    def __init__(self, cfg: dict = CFG):
        self.k = cfg
        self.ind = Indicators(cfg)
        self.info: List[Info] = []
        # position
        self.pos = 0
        self.lots = 0
        self.avg = 0.0
        self.ep = self.slD = self.tpD = 0.0
        self.ent_bar = -1
        self.ent_atr = 0.0
        self.mx = self.mn = 0.0
        self.lim_fill = False
        # the resting stop-entry
        self.arm_dir = 0
        self.arm_px = 0.0
        self.arm_bar = -1
        self.arm_by = -1
        self.arm_ep = 0.0
        self.arm_lots = 0
        self.arm_atr = 0.0
        self.arm_sl = self.arm_tp = 0.0
        self.is_limit = False
        self.arm_sig_ts = 0.0
        # the day
        self.cur_tday = None
        self.day_real = 0.0
        self.cap_hit = False
        # the bar in progress
        self.cur = -1
        self.cur_open = math.nan
        self.cur_ct = 0
        self.no_arm = False      # something filled or exited this bar (not a reversal): no new order this bar

    # ---- helpers ----
    def blocked(self) -> bool:
        k = self.k
        return (self.cap_hit or (k["breaker"] > 0 and self.day_real <= -k["breaker"])
                or (k["profit_block"] > 0 and self.day_real >= k["profit_block"]))

    def block_reason(self) -> str:
        k = self.k
        if self.cap_hit:
            return "daily limit"
        if k["profit_block"] > 0 and self.day_real >= k["profit_block"]:
            return "profit block"
        return "breaker"

    def flat_now(self, ct: int) -> bool:
        return ct >= self.k["flat_ct"] or ct < self.k["start_ct"]

    def armed(self) -> bool:
        return self.pos == 0 and self.arm_dir != 0

    def arm_live(self, i: int) -> bool:
        """The resting order can fill during bar i."""
        return self.armed() and i > self.arm_bar

    # ---- history ----
    def add_history(self, bar: Bar) -> Info:
        """A closed bar from before the bot started: indicators only."""
        info = self.ind.add(bar)
        self.info.append(info)
        return info

    # ---- bar i opens ----
    def begin_bar(self, i: int, o: float, tday: int, ct: int) -> List[Action]:
        k = self.k
        self.cur, self.cur_open, self.cur_ct, self.no_arm = i, o, ct, False
        if tday != self.cur_tday:
            self.cur_tday, self.day_real, self.cap_hit = tday, 0.0, False
        s2 = self.info[i - 1].sig if i >= 1 else 0
        flat = self.flat_now(ct)
        acts: List[Action] = []
        if self.armed():
            if flat or i > self.arm_by or self.blocked() or (s2 != 0 and s2 != self.arm_dir):
                why = ("flat time" if flat else "10 bars up" if i > self.arm_by else
                       ("day done: " + self.block_reason()) if self.blocked() else "signal the other way")
                acts.append(Action("cancel_arm", why, self.arm_dir, self.arm_px, self.arm_lots, self.is_limit))
                self.arm_dir = 0
            elif i == self.arm_bar + 1:
                if not self.is_limit and (o >= self.arm_px if self.arm_dir == 1 else o <= self.arm_px):
                    self.is_limit = True            # a stop here would be refused: same price as a limit
                acts.append(Action("place_arm", "", self.arm_dir, self.arm_px, self.arm_lots, self.is_limit))
        if self.pos != 0 and flat:
            acts.append(Action("close", "FLAT", self.pos))
        return acts

    def open_exits(self, i: int) -> List[Action]:
        """At bar i's open, after any stop the open gapped through: exits decided on bar i-1."""
        if self.pos == 0 or self.flat_now(self.cur_ct):
            return []
        k = self.k
        kk = i - 1
        if k["time_exit_bars"] > 0 and kk - self.ent_bar >= k["time_exit_bars"]:
            fav = (self.mx - self.avg) if self.pos == 1 else (self.avg - self.mn)
            if fav < k["time_exit_atr"] * self.ent_atr:
                return [Action("close", "TIME", self.pos)]
        s2 = self.info[i - 1].sig
        if s2 != 0 and s2 != self.pos:
            return [Action("close", "FLIP", self.pos)]
        return []

    # ---- fills ----
    def on_entry_fill(self, i: int, avg: float, lots: Optional[int] = None) -> None:
        """The resting order filled during bar i at average price `avg`."""
        self.pos = self.arm_dir
        self.lots = int(lots) if lots else self.arm_lots
        self.avg = avg
        self.ep, self.slD, self.tpD = self.arm_ep, self.arm_sl, self.arm_tp
        self.ent_bar = i
        self.ent_atr = self.arm_atr
        self.mx = self.mn = self.arm_px
        self.lim_fill = self.is_limit
        self.arm_dir = 0
        if i == self.cur:
            self.no_arm = True

    def protective(self) -> Tuple[float, float, bool]:
        """(stop, target, the stop is the day-limit stop) for the open trade --
        constant for the life of the trade, since the day's realised P&L only
        changes when a trade closes."""
        k, d = self.k, self.pos
        loss_px = self.avg - d * ((k["day_cap"] + self.day_real) / (k["point_value"] * self.lots))
        raw_sl = self.ep - d * self.slD
        sl = max(raw_sl, loss_px) if d == 1 else min(raw_sl, loss_px)
        is_cap = (sl == loss_px and loss_px > raw_sl) if d == 1 else (sl == loss_px and loss_px < raw_sl)
        return sl, self.ep + d * self.tpD, is_cap

    def on_exit(self, i: int, net: float, why: str) -> None:
        """The open trade closed during (or at the open of) bar i for `net` dollars."""
        self.day_real += net
        if self.day_real <= -self.k["day_cap"]:
            self.cap_hit = True
        self.pos = 0
        if why != "FLIP" and i == self.cur:
            self.no_arm = True

    # ---- bar i closes ----
    def finish_bar(self, bar: Bar) -> Info:
        k, i = self.k, len(self.info)
        if i >= 1 and i == self.cur and not self.no_arm and self.pos == 0:
            s2 = self.info[i - 1].sig
            if s2 != 0 and not self.flat_now(self.cur_ct) and not self.blocked() and self.cur_ct < k["no_entry_ct"]:
                sb = self.info[i - 1]
                a = sb.atr
                if a > 0:
                    q = sb.lots if sb.enter else 0
                    if q >= 1:
                        t = k["tick"]
                        self.is_limit = False
                        self.arm_dir, self.arm_bar, self.arm_by = s2, i, i + k["arm_bars"]
                        self.arm_ep, self.arm_lots, self.arm_atr = self.cur_open, q, a
                        self.arm_px = self.cur_open + s2 * max(a * k["trig_atr"], t)
                        self.arm_sl = max(a * k["sl_atr"], t)
                        self.arm_tp = max(a * k["tp_atr"], t)
                        self.arm_sig_ts = sb.ts
        info = self.ind.add(bar)
        self.info.append(info)
        if self.pos != 0 and i >= self.ent_bar:
            if i == self.ent_bar:
                if bar.c > self.mx:
                    self.mx = bar.c
                if bar.c < self.mn:
                    self.mn = bar.c
            else:
                if bar.h > self.mx:
                    self.mx = bar.h
                if bar.l < self.mn:
                    self.mn = bar.l
        return info


# ── the engine's fills, for replaying history through Strategy ────────────────
def reference_replay(bars: List[Bar], cfg: dict = CFG, slip: float = 0.25, fee: float = 0.75,
                     on_trade=None) -> List[dict]:
    """Run Strategy over closed 2-minute bars with the engine's own fill model
    (research/lib_shipped.mjs makeRun): entries at the order price plus a tick,
    exits at the price minus a tick, $0.75 a side, a day-limit stop booked at
    exactly the day's remaining budget, the stop checked before the target, and
    on the bar a limit entry filled the target only if the bar also closed beyond
    it. Returns the engine's trade records."""
    st = Strategy(cfg)
    pv = cfg["point_value"]
    trades: List[dict] = []

    def book(i, px, why, exact=None):
        d, q = st.pos, st.lots
        xp = px - slip if d == 1 else px + slip
        net = exact if exact is not None else (xp - st.avg) * d * pv * q - fee * 2 * q
        t = {"tday": bars[i].tday, "entTs": bars[st.ent_bar].ts, "xTs": bars[i].ts, "dir": d, "lots": q,
             "avg": st.avg, "pnl": net, "why": why, "entCt": bars[st.ent_bar].ct, "atr": st.ent_atr,
             "sigTs": st_sig_ts[0]}
        trades.append(t)
        if on_trade:
            on_trade(t)
        st.on_exit(i, net, why)

    st_sig_ts = [0.0]
    for i, b in enumerate(bars):
        if i == 0:
            st.finish_bar(b)
            continue
        acts = st.begin_bar(i, b.o, b.tday, b.ct)
        for a in acts:
            if a.kind == "close":                         # FLAT, at the open
                book(i, b.o, a.why)
        # a stop the open gapped through
        if st.pos != 0:
            sl, tp, cap = st.protective()
            if (b.o <= sl) if st.pos == 1 else (b.o >= sl):
                book(i, b.o, "SLcap" if cap else "SL", (-cfg["day_cap"] - st.day_real) if cap else None)
        for a in st.open_exits(i):
            book(i, b.o, "XSIG" if a.why == "TIME" else a.why)
        # the bar trades
        if st.arm_live(i):
            d, p = st.arm_dir, st.arm_px
            hit = ((b.l <= p) if d == 1 else (b.h >= p)) if st.is_limit else ((b.h >= p) if d == 1 else (b.l <= p))
            if hit:
                st_sig_ts[0] = st.arm_sig_ts
                st.on_entry_fill(i, p + d * slip)
                st.mx = st.mn = p
                sl, tp, cap = st.protective()
                ex = (-cfg["day_cap"] - st.day_real) if cap else None
                if (b.o <= sl) if d == 1 else (b.o >= sl):
                    book(i, b.o, "SLcap" if cap else "SL", ex)
                elif (b.l <= sl) if d == 1 else (b.h >= sl):
                    book(i, sl, "SLcap" if cap else "SL", ex)
                elif ((b.h >= tp) if d == 1 else (b.l <= tp)) and not (st.lim_fill and ((b.c < tp) if d == 1 else (b.c > tp))):
                    book(i, tp, "TP")
        elif st.pos != 0:
            d = st.pos
            sl, tp, cap = st.protective()
            ex = (-cfg["day_cap"] - st.day_real) if cap else None
            if (b.l <= sl) if d == 1 else (b.h >= sl):
                book(i, sl, "SLcap" if cap else "SL", ex)
            elif (b.h >= tp) if d == 1 else (b.l <= tp):
                book(i, tp, "TP")
        st.finish_bar(b)
    return trades


# ── the pass rate, as research/lib_shipped.mjs computes it ────────────────────
def _imul(a: int, b: int) -> int:
    return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF


def _i32(x: int) -> int:
    x &= 0xFFFFFFFF
    return x - 0x100000000 if x & 0x80000000 else x


def mulberry32(seed: int):
    """S.mul(seed): the engine's mulberry32 generator."""
    state = [_i32(seed)]

    def rnd() -> float:
        a = _i32(state[0] + 0x6D2B79F5)
        state[0] = a
        t = _imul(a ^ ((a & 0xFFFFFFFF) >> 15), 1 | a)
        t = (_i32(t + _imul(t ^ (t >> 7), 61 | t)) ^ t) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
    return rnd


def ev_with(d, target=1250.0, dd=1000.0, consistency=0.5) -> int:
    c, pk, lk, md = 0.0, 0.0, False, -1e18
    for v in d:
        c += v
        if v > md:
            md = v
        if c <= (0.0 if lk else pk - dd):
            return 0
        if c > pk:
            pk = c
        if not lk and pk >= dd:
            lk = True
        if c >= target and (consistency <= 0 or md <= consistency * c):
            return 1
    return 0


def pass_rate(arr, draws=12000, seed=4242, window=21, **rules) -> float:
    """S.passArr: 21-day evaluations from 5-day blocks of the day results."""
    rnd = mulberry32(seed)
    n = len(arr)
    w = 0
    for _ in range(draws):
        idx = []
        while len(idx) < window:
            st = math.floor(rnd() * max(1, n - 5))
            for j in range(5):
                if len(idx) >= window:
                    break
                idx.append((st + j) % n)
        w += ev_with([arr[q] for q in idx], **rules)
    return 100.0 * w / draws
