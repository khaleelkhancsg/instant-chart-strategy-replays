#!/usr/bin/env python3
"""
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MNQ DONCHIAN -- $1,250-TARGET EVALUATION -- TopstepX bot (ProjectX Gateway API)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Trades the strategy in donchian1250_core.py -- the configuration measured at
71.1% of 21-day evaluations on 2026 data ($1,250 target, $1,000 trailing
drawdown, $600 daily limit, 50% consistency): Donchian 30 breakouts with ADX,
efficiency and the slow-trend rescue, only WITH the 10-minute EMA 9/21, 4 lots
(2 late in the day), a stop-entry 0.15 ATR beyond the next bar's open, 5 ATR /
1.75 ATR bracket, out after 40 minutes without 1 ATR of progress, reversed by
an opposite signal, flat at 15:06 CT, and the day stopped at -$300 / +$250 /
the -$600 limit. The strategy file says exactly how.

    python mnq_donchian1250_bot.py            trade
    python mnq_donchian1250_bot.py --check    read-only: log in, find the account
                                              and contract, read bars, positions
                                              and orders; places nothing

Before trading, run test_donchian1250_parity.py (the launcher does): it replays
2026 through THIS file's order handling against a simulated gateway and checks
every trade against the research engine.

WRITTEN FROM THE PROJECTX GATEWAY DOCS (gateway.docs.projectx.com, read
2026-10-21). What changed from the old bot, and why it stopped working:
  * the contract is looked up each session (Contract/search, the active MNQ),
    not hard-coded -- the old bot pointed at MNQU26, which expired 2026-09-18
  * no bracket objects on orders. Accounts default to "Position Brackets", in
    which Order/place REJECTS stopLossBracket/takeProfitBracket. This bot
    places its own stop and target orders after the fill, at the strategy's
    exact prices, and cancels the other when one fills. It works in either
    bracket mode -- but turn OFF any default position bracket (auto SL/TP) in
    the platform, or the platform adds orders of its own to every position.
  * login is by API key only (Auth/loginKey); the token lasts 24 hours and is
    refreshed with Auth/validate
  * Order/cancel works on simulated accounts only -- an evaluation is one

Credentials: bot/.env (gitignored) with PROJECT_X_USERNAME and
PROJECT_X_API_KEY. Never put the key in the .bat launcher.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import httpx

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import donchian1250_core as core                                   # noqa: E402

# ─────────────────────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────────────────────
CONFIG = {
    "api_base": "https://api.topstepx.com",
    # Which account. Empty = the only active account that can trade; with more
    # than one the bot lists them and stops -- set the exact name here.
    "account_name": "",
    # Empty = look up the active MNQ contract every session (recommended).
    "contract_id": "",
    "symbol_id": "F.US.MNQ",
    # The API's "live" flag for bars and contract search: the sim (False) or
    # live (True) market-data subscription.
    "live_data": False,
    "history_days": 30,          # 1-minute history loaded at start (EMA 500 on 2-min bars needs ~2 weeks to settle)
    "bar_settle_s": 1.0,         # after a 2-minute boundary, wait this long before reading the bar that closed
    "open_wait_s": 8.0,          # ...and at most this long for the new bar's first trade (its open)
    "poll_s": 1.0,               # fills / positions while an order or a trade is live
    # Orders on the tick grid, rounded the way that keeps the engine's trigger
    # exactly: a buy stop or sell limit rounds UP, a sell stop or buy limit DOWN,
    # so "the bar traded through the price" is the same test. Only the parity
    # replay turns this off (to compare dollars to the engine to the cent).
    "round_to_tick": True,
    # The day-limit stop sits where the day reaches -$600 BEFORE commission, as
    # the engine models it; the platform's own daily-loss limit, if set to $600,
    # fires a few ticks sooner -- same outcome. True pulls the bot's stop in by the
    # round-trip commission instead (commission_per_side below).
    "cap_stop_fees": False,
    "commission_per_side": 0.75,
    # Belt and braces: whatever the bar feed says, from this CT minute on any
    # position is closed and every order of ours cancelled. Topstep's deadline is
    # 15:10 CT and its risk desk starts flattening at 15:08.
    "hard_flat_ct": 15 * 60 + 7,
    "state_file": "donchian1250_state.json",
    "tag": "D1250",
}

ORDER_LIMIT, ORDER_MARKET, ORDER_STOP = 1, 2, 4
SIDE_BUY, SIDE_SELL = 0, 1
POS_LONG, POS_SHORT = 1, 2
TICK = core.CFG["tick"]
PV = core.CFG["point_value"]

# ─────────────────────────────────────────────────────────────
#  LOGGING
# ─────────────────────────────────────────────────────────────
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass
log = logging.getLogger("D1250")
if not log.handlers:
    log.setLevel(logging.INFO)
    _sh = logging.StreamHandler()
    _sh.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-7s  %(message)s", "%Y-%m-%d %H:%M:%S"))
    log.addHandler(_sh)
    log.propagate = False


def add_file_log() -> Path:
    d = Path(os.environ.get("MNQ_LOG_DIR", HERE / "logs"))
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"donchian1250_{datetime.now():%Y%m%d_%H%M%S}.log"
    fh = logging.FileHandler(p, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-7s  %(message)s", "%Y-%m-%d %H:%M:%S"))
    log.addHandler(fh)
    return p


# ─────────────────────────────────────────────────────────────
#  TIME AND PRICES
# ─────────────────────────────────────────────────────────────
def iso(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(s) -> float:
    """ProjectX timestamps ('2025-07-18T21:00:01.268009+00:00', '...Z') -> epoch ms."""
    s = str(s).strip().replace("Z", "+00:00")
    if "." in s:
        head, rest = s.split(".", 1)
        frac, tz = rest, ""
        for sep in ("+", "-"):
            if sep in rest:
                frac, tz = rest.split(sep, 1)
                tz = sep + tz
                break
        s = head + "." + frac[:6].ljust(6, "0") + tz
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp() * 1000.0


def ct_label(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).astimezone(core.CT_TZ).strftime("%H:%M CT")


def tday_start_ms(tday: int) -> float:
    """The CME session for trading day `tday` opens 17:00 New York the evening before."""
    d = datetime(1970, 1, 1) + timedelta(days=tday - 1)
    return datetime(d.year, d.month, d.day, 17, 0, tzinfo=core.NY_TZ).timestamp() * 1000.0


def round_order_px(px: float, side: int, kind: int) -> float:
    """Tick-grid price that triggers on exactly the same bars as the exact price:
    a BUY stop or SELL limit fills once price reaches px or higher -> round up;
    a SELL stop or BUY limit once it reaches px or lower -> round down."""
    up = (side == SIDE_BUY and kind == ORDER_STOP) or (side == SIDE_SELL and kind == ORDER_LIMIT)
    q = px / TICK
    n = math.ceil(q - 1e-9) if up else math.floor(q + 1e-9)
    return round(n * TICK, 2)


# ─────────────────────────────────────────────────────────────
#  PROJECTX GATEWAY CLIENT (REST)
# ─────────────────────────────────────────────────────────────
class GatewayError(RuntimeError):
    pass


LOGIN_ERRORS = {
    3: "InvalidCredentials -- the userName/apiKey pair did not match an active key (use the platform login "
       "username, not an email; regenerate the key under Settings > API)",
    7: "AgreementsNotSigned -- log into the platform and accept the pending agreements",
    9: "ApiSubscriptionNotFound -- no active API subscription",
    10: "ApiKeyAuthenticationDisabled -- the firm has turned off API-key login",
}


class ProjectX:
    """The endpoints this bot uses, as documented at gateway.docs.projectx.com.
    Every response carries success / errorCode / errorMessage; a failed call
    still returns HTTP 200, so the body is what is checked."""

    TOKEN_REFRESH_S = 20 * 3600          # tokens last 24h

    def __init__(self, username: str, api_key: str, base: str = CONFIG["api_base"], transport=None,
                 clock=time.time, sleep=time.sleep):
        self.username, self.api_key = username, api_key
        self.http = httpx.Client(base_url=base, timeout=15.0, transport=transport,
                                 headers={"accept": "text/plain", "Content-Type": "application/json"})
        self.token: Optional[str] = None
        self.token_at = 0.0
        self.clock, self.sleep = clock, sleep

    def _raw(self, path: str, body: dict, auth: bool = True) -> dict:
        headers = {"Authorization": f"Bearer {self.token}"} if auth and self.token else {}
        r = self.http.post(path, json=body, headers=headers)
        if r.status_code == 401 and auth:
            raise PermissionError("401")
        if r.status_code == 429:
            raise ConnectionError("429 rate limited")
        r.raise_for_status()
        return r.json()

    def post(self, path: str, body: dict) -> dict:
        self.ensure_token()
        last = None
        for attempt in range(4):
            try:
                return self._raw(path, body)
            except PermissionError:
                log.warning("401 on %s -- logging in again", path)
                self.login()
            except (httpx.TransportError, httpx.HTTPStatusError, ConnectionError) as e:
                last = e
                wait = 2.0 * (attempt + 1) if "429" in str(e) else 0.5 * (attempt + 1)
                log.warning("%s failed (%s), retry in %.1fs", path, e, wait)
                self.sleep(wait)
        raise GatewayError(f"{path}: {last}")

    # ---- auth ----
    def login(self) -> None:
        if not self.username or not self.api_key:
            raise GatewayError("PROJECT_X_USERNAME and PROJECT_X_API_KEY must be set (bot/.env)")
        d = self._raw("/api/Auth/loginKey", {"userName": self.username, "apiKey": self.api_key}, auth=False)
        if not d.get("success") or not d.get("token"):
            code = d.get("errorCode")
            raise GatewayError(f"login failed: errorCode {code} {LOGIN_ERRORS.get(code, d.get('errorMessage') or '')}")
        self.token, self.token_at = d["token"], self.clock()
        log.info("logged in (ProjectX Gateway)")

    def ensure_token(self) -> None:
        if self.token is None:
            self.login()
        elif self.clock() - self.token_at > self.TOKEN_REFRESH_S:
            try:
                d = self._raw("/api/Auth/validate", {})
                if d.get("success") and d.get("newToken"):
                    self.token, self.token_at = d["newToken"], self.clock()
                    log.info("session token refreshed")
                    return
            except Exception as e:                                # pragma: no cover
                log.warning("token refresh failed (%s) -- logging in again", e)
            self.login()

    # ---- reference data ----
    def accounts(self) -> List[dict]:
        return self.post("/api/Account/search", {"onlyActiveAccounts": True}).get("accounts") or []

    def search_contracts(self, text: str, live: bool) -> List[dict]:
        return self.post("/api/Contract/search", {"searchText": text, "live": live}).get("contracts") or []

    def contract_by_id(self, cid: str) -> Optional[dict]:
        return self.post("/api/Contract/searchById", {"contractId": cid}).get("contract")

    def bars(self, cid: str, live: bool, start_ms: float, end_ms: float, partial: bool, limit: int = 20000) -> List[dict]:
        d = self.post("/api/History/retrieveBars", {
            "contractId": cid, "live": live, "startTime": iso(start_ms), "endTime": iso(end_ms),
            "unit": 2, "unitNumber": 1, "limit": limit, "includePartialBar": partial})
        if not d.get("success", True):
            raise GatewayError(f"retrieveBars: errorCode {d.get('errorCode')} {d.get('errorMessage')}")
        out = d.get("bars") or []
        out.sort(key=lambda b: parse_ts(b["t"]))
        return out

    # ---- orders, positions, trades ----
    def place(self, account_id: int, cid: str, type_: int, side: int, size: int, limit_price=None,
              stop_price=None, tag: Optional[str] = None) -> dict:
        return self.post("/api/Order/place", {
            "accountId": account_id, "contractId": cid, "type": type_, "side": side, "size": int(size),
            "limitPrice": limit_price, "stopPrice": stop_price, "trailPrice": None, "customTag": tag,
            "stopLossBracket": None, "takeProfitBracket": None})

    def cancel(self, account_id: int, order_id: int) -> dict:
        return self.post("/api/Order/cancel", {"accountId": account_id, "orderId": order_id})

    def modify(self, account_id: int, order_id: int, size=None, limit_price=None, stop_price=None) -> dict:
        return self.post("/api/Order/modify", {"accountId": account_id, "orderId": order_id, "size": size,
                                                "limitPrice": limit_price, "stopPrice": stop_price, "trailPrice": None})

    def open_orders(self, account_id: int) -> List[dict]:
        return self.post("/api/Order/searchOpen", {"accountId": account_id}).get("orders") or []

    def positions(self, account_id: int) -> List[dict]:
        return self.post("/api/Position/searchOpen", {"accountId": account_id}).get("positions") or []

    def close_position(self, account_id: int, cid: str) -> dict:
        return self.post("/api/Position/closeContract", {"accountId": account_id, "contractId": cid})

    def trades(self, account_id: int, start_ms: float) -> List[dict]:
        return self.post("/api/Trade/search", {"accountId": account_id, "startTimestamp": iso(start_ms),
                                               "endTimestamp": None}).get("trades") or []


# ─────────────────────────────────────────────────────────────
#  THE BOT
# ─────────────────────────────────────────────────────────────
class Bot:
    """Feeds the strategy closed 2-minute bars and the broker's fills, and
    carries out what it asks for, in the engine's order (see core.Strategy):

      every 2-minute boundary   read the bar that closed and the new bar's open;
                                fills from before the boundary are booked to the
                                bar that closed, which then finishes (a new order
                                from its signal); the new bar begins: the resting
                                entry is cancelled or placed (stop, or limit if the
                                open is already through it), flat at 15:06; then
                                fills at the open (a stop gapped through), then
                                the 40-minute exit and a reversal at the open
      while anything is live    fills every second: an entry fill gets its stop
                                and target at once; a stop or target fill cancels
                                the other and books the trade

    The position is tracked from the fills themselves, in time order, so each
    fill is booked to the bar it happened in; the broker's position is checked
    against it as a safety net.
    """

    def __init__(self, api: ProjectX, cfg: Optional[dict] = None, clock=time.time, sleep=time.sleep,
                 state_path: Optional[Path] = None):
        self.api = api
        self.cfg = dict(CONFIG, **(cfg or {}))
        self.clock, self.sleep = clock, sleep
        self.state_path = Path(state_path) if state_path else HERE / self.cfg["state_file"]
        self.strat = core.Strategy()
        self.account_id: Optional[int] = None
        self.account_name = ""
        self.cid: Optional[str] = None
        self.rows: Dict[float, Dict[float, tuple]] = {}   # completed minutes of buckets not yet closed, by bucket
        self.last_row_ts: Optional[float] = None            # the newest completed minute seen
        self.closed_upto = -1.0                     # the last 2-minute bucket fed to the strategy
        self.cur_bucket: Optional[float] = None     # the bucket begun and not yet closed
        self.pending_open: Optional[float] = None   # a bucket waiting for its first trade
        self.entry: Optional[dict] = None           # the working entry order
        self.dead_entries: Dict[int, dict] = {}     # entry orders cancelled lately (a late fill is caught)
        self.legs: Dict[str, dict] = {}             # "sl" / "tp" -> the working exit order
        self.trade: Optional[dict] = None           # the open position, from its fills
        self.seen: Dict[int, dict] = {}             # today's fills on our contract
        self.session_tday: Optional[int] = None
        self.run_id = uuid.uuid4().hex[:6]
        self.seq = 0
        self.last_pos_check = -1e18
        self.events: List[dict] = []                # what happened, for the log and the tests
        self._saved: Optional[str] = None
        self.pending_close: Optional[str] = None    # a close that did not go through, retried every poll
        self.retry_entry: Optional[core.Action] = None   # an entry order lost to a network error
        self.halted = ""                            # why the bot stopped opening trades, if it has

    # ---------- helpers ----------
    def now_ms(self) -> float:
        return self.clock() * 1000.0

    def _tag(self, what: str) -> str:
        self.seq += 1
        return f"{self.cfg['tag']}-{self.run_id}-{self.seq}-{what}"

    def _price(self, px: float, side: int, kind: int) -> float:
        return round_order_px(px, side, kind) if self.cfg["round_to_tick"] else px

    def _event(self, kind: str, **kw) -> dict:
        e = {"kind": kind, "ms": self.now_ms(), "bucket": self.cur_bucket, **kw}
        self.events.append(e)
        return e

    def busy_orders(self) -> bool:
        """Something can fill: a working order, a trade, or an entry cancelled in
        the last few minutes that might still report a fill."""
        if self.dead_entries:
            cut = self.now_ms() - 10 * 60_000
            for k in [k for k, v in self.dead_entries.items() if v.get("dead_at", 0) < cut]:
                del self.dead_entries[k]
        return (self.entry is not None or self.strat.pos != 0 or bool(self.legs) or self.trade is not None
                or bool(self.dead_entries))

    def market_active(self) -> bool:
        """Minutes have been printing lately (not a weekend, the daily halt or a holiday)."""
        return self.last_row_ts is not None and self.now_ms() - self.last_row_ts < 10 * 60_000

    def busy(self) -> bool:
        return (self.busy_orders() or self.pending_close is not None or self.retry_entry is not None
                or (self.pending_open is not None and self.market_active()))

    # ---------- start ----------
    def start(self) -> None:
        self.api.login()
        self._pick_account()
        self._pick_contract()
        self._load_history()
        self._restore()
        log.info("ready: %s on %s, %d two-minute bars of history, day so far %+.2f",
                 self.account_name, self.cid, len(self.strat.info), self.strat.day_real)

    def _pick_account(self) -> None:
        accts = self.api.accounts()
        for a in accts:
            log.info("   account %-28s id=%-10s balance %10.2f canTrade=%s", a.get("name"), a.get("id"),
                     float(a.get("balance") or 0), a.get("canTrade"))
        want = self.cfg["account_name"].strip().lower()
        pick = ([a for a in accts if str(a.get("name", "")).lower() == want] if want
                else [a for a in accts if a.get("canTrade")])
        if len(pick) != 1:
            raise GatewayError(f"no active account named {self.cfg['account_name']!r}" if want and not pick
                               else "set CONFIG['account_name'] to one of the accounts listed above")
        a = pick[0]
        if not a.get("canTrade"):
            raise GatewayError(f"account {a.get('name')} cannot trade right now")
        self.account_id, self.account_name = a["id"], a.get("name", "")
        log.info("trading account %s (id %s)", self.account_name, self.account_id)

    def _pick_contract(self) -> None:
        if self.cfg["contract_id"]:
            c = self.api.contract_by_id(self.cfg["contract_id"])
            if not c:
                raise GatewayError(f"contract {self.cfg['contract_id']} not found")
            if not c.get("activeContract"):
                log.warning("contract %s is NOT the active contract -- orders will be refused (errorCode 9)", c.get("id"))
        else:
            cs = [c for c in self.api.search_contracts("MNQ", self.cfg["live_data"])
                  if c.get("symbolId") == self.cfg["symbol_id"] and c.get("activeContract")]
            if not cs:
                raise GatewayError("no active MNQ contract found (Contract/search 'MNQ')")
            c = cs[0]
        if abs(float(c.get("tickSize", TICK)) - TICK) > 1e-12 or abs(float(c.get("tickValue", 0.5)) - TICK * PV) > 1e-9:
            raise GatewayError(f"contract {c.get('id')} is not MNQ-sized (tick {c.get('tickSize')}, value {c.get('tickValue')})")
        if c.get("id") != self.cid:
            if self.cid:
                log.warning("contract changed %s -> %s (roll)", self.cid, c.get("id"))
            self.cid = c["id"]
            log.info("contract %s (%s, %s)", self.cid, c.get("name"), c.get("description"))

    # ---------- bars ----------
    def _store(self, bars: List[dict], before_ms: float) -> Optional[dict]:
        """Keep the completed minutes (start < before_ms) of buckets not yet closed;
        return the first minute at or after before_ms that has traded -- the new
        bar's open -- if there is one."""
        first_new = None
        for b in bars:
            if float(b.get("v") or 0) <= 0:
                continue                      # a minute with no trades is no bar (the research data has none)
            t = parse_ts(b["t"])
            if t < before_ms:
                bk = math.floor(t / core.BUCKET_MS) * core.BUCKET_MS
                if bk > self.closed_upto:
                    self.rows.setdefault(bk, {})[t] = (float(b["o"]), float(b["h"]), float(b["l"]), float(b["c"]),
                                                       float(b.get("v") or 0))
                if self.last_row_ts is None or t > self.last_row_ts:
                    self.last_row_ts = t
            elif first_new is None and t < before_ms + core.BUCKET_MS:
                first_new = {"t": t, "o": float(b["o"])}
        return first_new

    def _load_history(self) -> None:
        now = self.now_ms()
        start = now - self.cfg["history_days"] * 86_400_000
        step = 13 * 86_400_000                 # under the 20,000-bar limit per request
        t = start
        self.closed_upto = -1.0
        while t < now:
            self._store(self.api.bars(self.cid, self.cfg["live_data"], t, min(now, t + step), partial=False), now)
            t += step
        cur = math.floor(now / core.BUCKET_MS) * core.BUCKET_MS
        rows = sorted((ts, *v) for bk, m in self.rows.items() if bk < cur for ts, v in m.items())
        bars = core.aggregate_2m(rows)
        for b in bars:
            self.strat.add_history(b)
        self.closed_upto = bars[-1].ts if bars else -1.0
        self.rows = {bk: m for bk, m in self.rows.items() if bk > self.closed_upto}
        log.info("history: %d one-minute bars -> %d two-minute bars, last closed %s",
                 len(rows), len(bars), ct_label(self.closed_upto) if bars else "-")
        if len(bars) < core.CFG["rescue_floor_bars"]:
            log.warning("only %d bars of history: the slow-trend rescue needs %d", len(bars), core.CFG["rescue_floor_bars"])

    def _bucket_bar(self, bucket: float) -> Optional[core.Bar]:
        rows = sorted((ts, *v) for ts, v in self.rows.get(bucket, {}).items())
        bars = core.aggregate_2m(rows)
        return bars[0] if bars else None

    # ---------- the session ----------
    def _ensure_session(self) -> None:
        """A new trading day: today's fills only; the contract re-checked when flat."""
        td = core.trading_day(self.now_ms())
        if td == self.session_tday:
            return
        self.session_tday = td
        self.seen = {t["id"]: t for t in self._fetch_trades()}
        if not self.busy_orders():
            old = self.cid
            try:
                self._pick_contract()
            except Exception as e:                                  # pragma: no cover
                log.error("contract check failed: %s", e)
            if old is not None and self.cid != old:
                self.rows.clear()
                self.last_row_ts = None
                self.strat = core.Strategy()
                self._load_history()

    def _fetch_trades(self) -> List[dict]:
        start = tday_start_ms(self.session_tday) if self.session_tday else self.now_ms() - 86_400_000
        out = []
        for t in self.api.trades(self.account_id, start):
            if t.get("contractId") == self.cid and not t.get("voided"):
                t["_ms"] = parse_ts(t["creationTimestamp"])
                out.append(t)
        out.sort(key=lambda t: (t["_ms"], t["id"]))
        return out

    # ---------- state, for a restart ----------
    def _save(self) -> None:
        s = self.strat
        state = {
            "account_id": self.account_id, "contract_id": self.cid, "tday": s.cur_tday, "day_real": s.day_real,
            "cap_hit": s.cap_hit,
            "arm": None if not s.armed() else {
                "dir": s.arm_dir, "px": s.arm_px, "ts": self._ts_of(s.arm_bar), "ep": s.arm_ep, "lots": s.arm_lots,
                "atr": s.arm_atr, "sl": s.arm_sl, "tp": s.arm_tp, "is_limit": s.is_limit, "sig_ts": s.arm_sig_ts,
                "order_id": self.entry["id"] if self.entry else None},
            "trade": None if s.pos == 0 else {
                "dir": s.pos, "lots": s.lots, "avg": s.avg, "ep": s.ep, "slD": s.slD, "tpD": s.tpD,
                "ent_ts": self._ts_of(s.ent_bar), "atr": s.ent_atr, "mx": s.mx, "mn": s.mn, "lim_fill": s.lim_fill,
                "since": self.trade["since"] if self.trade else None,
                "legs": {k: v["id"] for k, v in self.legs.items()}},
        }
        text = json.dumps(state)
        if text == self._saved:
            return
        try:
            tmp = self.state_path.with_suffix(".tmp")
            tmp.write_text(text)
            tmp.replace(self.state_path)
            self._saved = text
        except Exception as e:                                      # pragma: no cover
            log.warning("state save failed: %s", e)

    def _ts_of(self, i: int) -> Optional[float]:
        if 0 <= i < len(self.strat.info):
            return self.strat.info[i].ts
        if i == len(self.strat.info) and self.cur_bucket is not None:
            return self.cur_bucket
        return None

    def _index_of(self, ts: Optional[float]) -> Optional[int]:
        if ts is None:
            return None
        if self.cur_bucket is not None and ts == self.cur_bucket:
            return len(self.strat.info)
        for q in range(len(self.strat.info) - 1, max(-1, len(self.strat.info) - 400), -1):
            if self.strat.info[q].ts == ts:
                return q
        return None

    def _restore(self) -> None:
        """After a (re)start: the day's result, and any trade or order of ours."""
        s = self.strat
        now = self.now_ms()
        self.session_tday = core.trading_day(now)
        trades = self._fetch_trades()
        self.seen = {t["id"]: t for t in trades}
        try:
            st = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        except Exception:
            st = {}
        same_day = (st.get("tday") == self.session_tday and st.get("account_id") == self.account_id
                    and st.get("contract_id") == self.cid)
        d, size, avg = self._broker_position()
        working = {o["id"]: o for o in self.api.open_orders(self.account_id) if o.get("contractId") == self.cid}
        ours = {oid: o for oid, o in working.items() if str(o.get("customTag") or "").startswith(self.cfg["tag"] + "-")}
        s.cur_tday = self.session_tday
        if same_day:
            s.day_real, s.cap_hit = float(st.get("day_real") or 0.0), bool(st.get("cap_hit"))
        else:
            s.day_real = sum((t.get("profitAndLoss") or 0.0) - (t.get("fees") or 0.0) for t in trades) if not size else 0.0
            s.cap_hit = s.day_real <= -core.CFG["day_cap"]
        if s.day_real:
            log.info("the day so far: %+.2f", s.day_real)
        tr = st.get("trade") if same_day else None
        arm = st.get("arm") if same_day else None
        cur = math.floor(now / core.BUCKET_MS) * core.BUCKET_MS
        self.cur_bucket = None
        if size and tr and tr.get("dir") == d and int(tr.get("lots") or 0) == size:
            s.pos, s.lots, s.avg = d, size, float(tr["avg"])
            s.ep, s.slD, s.tpD, s.ent_atr = tr["ep"], tr["slD"], tr["tpD"], tr["atr"]
            s.mx, s.mn, s.lim_fill = tr["mx"], tr["mn"], bool(tr["lim_fill"])
            q = self._index_of(tr.get("ent_ts"))
            s.ent_bar = q if q is not None else len(s.info) - 1
            self.trade = {"since": tr.get("since") or now, "dir": d, "qty": size}
            for k, oid in (tr.get("legs") or {}).items():
                if oid in working:
                    o = working[oid]
                    self.legs[k] = {"id": oid, "px": o.get("stopPrice") or o.get("limitPrice"), "size": o.get("size"),
                                    "cap": "-cap" in str(o.get("customTag") or "")}
            log.info("restored the open trade: %s %d @ %.2f", "LONG" if d == 1 else "SHORT", size, s.avg)
            for oid in ours:
                if oid not in {v["id"] for v in self.legs.values()}:
                    self._cancel(oid, "not part of the restored trade")
            self._protect()                      # places whatever leg is missing
        elif size:
            log.error("an open position (%+d @ %.2f) the saved state does not describe -- closing it", d * size, avg)
            for oid in ours:
                self._cancel(oid, "unknown position")
            self.trade = {"since": now, "dir": d, "qty": size, "late": True}
            self._flatten("UNKNOWN")
        else:
            keep = None
            if arm and arm.get("order_id") in ours:
                q = self._index_of(arm.get("ts"))
                if q is not None:
                    s.arm_dir, s.arm_px, s.arm_bar, s.arm_by = arm["dir"], arm["px"], q, q + core.CFG["arm_bars"]
                    s.arm_ep, s.arm_lots, s.arm_atr, s.arm_sl, s.arm_tp = arm["ep"], arm["lots"], arm["atr"], arm["sl"], arm["tp"]
                    s.is_limit, s.arm_sig_ts = bool(arm["is_limit"]), arm.get("sig_ts") or 0.0
                    keep = arm["order_id"]
                    o = ours[keep]
                    self.entry = {"id": keep, "dir": s.arm_dir, "px": o.get("stopPrice") or o.get("limitPrice"),
                                  "lots": s.arm_lots, "limit": s.is_limit, "filled": 0}
                    log.info("restored the working entry order %s (%s %d @ %s)", keep,
                             "BUY" if s.arm_dir == 1 else "SELL", s.arm_lots, self.entry["px"])
            for oid in ours:
                if oid != keep:
                    self._cancel(oid, "left over from a previous run")
        others = [o for oid, o in working.items() if oid not in ours]
        if others:
            log.warning("%d working order(s) on %s were not placed by this bot -- leaving them alone", len(others), self.cid)
        self._join_current(cur)

    def _join_current(self, cur: float) -> None:
        """Begin the bar in progress, if it has traded yet."""
        try:
            bars = self.api.bars(self.cid, self.cfg["live_data"], cur - 10 * 60_000, self.now_ms() + 60_000, partial=True)
        except Exception as e:                                       # pragma: no cover
            log.warning("could not read the bar in progress: %s", e)
            bars = []
        first = self._store(bars, cur)
        if first is not None:
            self._begin(cur, first["o"], core.ct_minute(first["t"]), core.trading_day(first["t"]))
        else:
            self.pending_open = cur

    # ---------- fills ----------
    def _broker_position(self) -> Tuple[int, int, float]:
        for p in self.api.positions(self.account_id):
            if p.get("contractId") == self.cid and int(p.get("size") or 0) > 0:
                return (1 if p.get("type") == POS_LONG else -1), int(p["size"]), float(p.get("averagePrice") or 0.0)
        return 0, 0, 0.0

    def _sync(self, before: Optional[float] = None) -> None:
        """Book new fills in time order -- only those before `before` (ms), so each
        fill goes to the bar it happened in. With no `before`, the broker's
        position is then checked against the bot's as a safety net."""
        new = [t for t in self._fetch_trades() if t["id"] not in self.seen and (before is None or t["_ms"] < before)]
        for t in new:
            self.seen[t["id"]] = t
            self._fill(t)
        if before is None:
            self._reconcile()

    def _fill(self, t: dict) -> None:
        oid, qty = t.get("orderId"), int(t["size"])
        side = 1 if t.get("side") == SIDE_BUY else -1
        tr = self.trade
        if self.entry is not None and oid == self.entry["id"]:
            self._entry_fill(t)
            return
        if oid in self.dead_entries and (tr is None or tr.get("late")):
            # An entry the strategy had cancelled or replaced filled anyway -- it lost
            # the race with the cancel. The strategy holds no trade, so it is closed
            # at once; its dollars still count for the day.
            if tr is None:
                log.warning("entry order %s filled (%d @ %s) after it was cancelled -- closing it", oid, qty, t.get("price"))
                self._event("late_fill", order=oid)
                self.trade = {"since": t["_ms"], "dir": side, "qty": qty, "late": True}
            else:
                tr["qty"] += qty if side == tr["dir"] else -qty
            return
        if tr is None:
            log.warning("a fill the bot did not place (order %s, %s %d @ %s) -- it will be closed", oid,
                        "BUY" if side == 1 else "SELL", qty, t.get("price"))
            self._event("unknown_fill", order=oid)
            self.trade = {"since": t["_ms"], "dir": side, "qty": qty, "late": True}
            return
        if side == tr["dir"]:
            tr["qty"] += qty
            return
        tr["qty"] -= qty
        leg = next((k for k, v in self.legs.items() if v["id"] == oid), None)
        if leg:
            self.legs[leg]["filled"] = self.legs[leg].get("filled", 0) + qty
        if tr["qty"] > 0:
            # part of the position is gone: the other leg must not outsize what is left
            for k, v in self.legs.items():
                if k != leg and v.get("size") != tr["qty"]:
                    r = self.api.modify(self.account_id, v["id"], size=tr["qty"])
                    if r.get("success"):
                        v["size"] = tr["qty"]
            if not tr.get("late"):
                self.strat.lots = tr["qty"]
            return
        if tr.get("late"):
            self._book_late()
        else:
            self._booked_exit(leg)

    def _entry_fill(self, t: dict) -> None:
        e = self.entry
        q = int(t["size"])
        e["filled"] += q
        e.setdefault("fills", []).append((float(t["price"]), q))
        qty = sum(x for _, x in e["fills"])
        avg = sum(p * x for p, x in e["fills"]) / qty
        if self.trade is None:
            self.strat.on_entry_fill(self.strat.cur, avg, qty)
            self.trade = {"since": t["_ms"], "dir": e["dir"], "qty": qty}
            log.info("FILLED  %s %d @ %.2f (%s %.2f)", "BUY" if e["dir"] == 1 else "SELL", qty, avg,
                     "market" if e.get("market") else "limit" if e["limit"] else "stop", e["px"])
            self._event("fill", dir=e["dir"], px=avg, lots=qty)
        else:                                       # a further part of the same order
            self.trade["qty"] = qty
            self.strat.lots, self.strat.avg = qty, avg
        if e["filled"] >= e["lots"]:
            self.entry = None
        else:
            log.warning("entry partly filled (%d of %d) -- cancelling the rest", e["filled"], e["lots"])
            self._drop_entry("partial fill")
        self._protect(replace=True)
        self._save()

    def _reconcile(self) -> None:
        """The broker's position against the bot's, once every fill is in."""
        self.last_pos_check = self.clock()
        d, size, avg = self._broker_position()
        tr = self.trade
        held = tr["qty"] * tr["dir"] if tr else 0
        if d * size != held:
            log.error("the broker shows %+d contracts, the bot expects %+d", d * size, held)
            if size == 0 and tr is not None:
                tr["qty"] = 0                      # closed by something the bot did not see fill
                if tr.get("late"):
                    self._book_late()
                else:
                    self._booked_exit(None)
                return
            if tr is None:
                self.trade = {"since": self.now_ms(), "dir": d, "qty": size, "late": True}
            else:
                tr.update(dir=d, qty=size, late=True)
            self._flatten("UNKNOWN")
            return
        if tr is not None and tr.get("late") and size:
            self._flatten("LATE")
            return
        if size == 0 and self.legs:
            for k in list(self.legs):
                self._cancel(self.legs[k]["id"], "flat")
            self.legs.clear()
        if self.strat.pos != 0 and size and "sl" not in self.legs:
            log.warning("the open trade has no stop working -- placing it")
            self._protect()

    def _trade_net(self) -> float:
        """Dollars of every fill since the trade opened, after commission."""
        since = self.trade["since"] if self.trade else 0.0
        return sum((t.get("profitAndLoss") or 0.0) - (t.get("fees") or 0.0) for t in self.seen.values() if t["_ms"] >= since)

    def _booked_exit(self, leg: Optional[str]) -> None:
        net = self._trade_net()
        if leg == "sl":
            why = "SLcap" if self.legs["sl"].get("cap") else "SL"
        elif leg == "tp":
            why = "TP"
        else:
            why = (self.trade or {}).get("closing") or "EXT"
        s = self.strat
        self._event("exit", why=why, net=net, lots=s.lots, dir=s.pos)
        log.info("CLOSED  %s %d  %s  %+.2f   day %+.2f", "LONG" if s.pos == 1 else "SHORT", s.lots, why, net, s.day_real + net)
        s.on_exit(s.cur, net, why)
        for k in list(self.legs):
            if k != leg:
                self._cancel(self.legs[k]["id"], f"{why} closed the trade")
        self.legs.clear()
        self.trade = None
        if s.blocked():
            log.info("day done: %s (%+.2f)", s.block_reason(), s.day_real)
        self._save()

    def _book_late(self) -> None:
        net = self._trade_net()
        self.strat.day_real += net
        if self.strat.day_real <= -core.CFG["day_cap"]:
            self.strat.cap_hit = True
        self._event("late_closed", net=net)
        log.info("late fill closed: %+.2f, day %+.2f", net, self.strat.day_real)
        self.trade = None
        self._save()

    # ---------- orders ----------
    def _cancel(self, oid: int, why: str) -> bool:
        try:
            r = self.api.cancel(self.account_id, oid)
        except GatewayError as e:
            log.error("cancel %s (%s) failed: %s -- CHECK THE PLATFORM", oid, why, e)
            return False
        if r.get("success"):
            log.info("cancelled %s (%s)", oid, why)
            return True
        if r.get("errorCode") == 6:
            # "Live accounts not supported" / follower accounts: the API cannot cancel here
            self.halted = f"the account cannot cancel orders through the API ({r.get('errorMessage')})"
            log.critical("%s -- NO NEW TRADES. Cancel order %s on the platform by hand.", self.halted, oid)
            return False
        log.warning("cancel %s (%s) not accepted: errorCode %s %s -- it may have filled", oid, why, r.get("errorCode"),
                    r.get("errorMessage") or "")
        return False

    def _drop_entry(self, why: str) -> None:
        e = self.entry
        if e is None:
            return
        self._cancel(e["id"], why)
        self.dead_entries[e["id"]] = dict(e, dead_at=self.now_ms())
        self.entry = None

    def _place_entry(self, a: core.Action) -> None:
        if self.entry is not None:
            self._drop_entry("replaced by a newer signal")
        self.retry_entry = None
        if self.halted:
            log.error("not placing the entry: %s", self.halted)
            return
        side = SIDE_BUY if a.dir == 1 else SIDE_SELL
        kind = ORDER_LIMIT if a.limit else ORDER_STOP
        px = self._price(a.px, side, kind)
        try:
            r = self.api.place(self.account_id, self.cid, kind, side, a.lots,
                               limit_price=px if kind == ORDER_LIMIT else None,
                               stop_price=px if kind == ORDER_STOP else None, tag=self._tag("entry"))
        except GatewayError as e:
            log.error("entry order failed (%s) -- will retry while the order is still due", e)
            self.retry_entry = a
            return
        what = f"{'BUY' if side == SIDE_BUY else 'SELL'} {a.lots} {'LIMIT' if a.limit else 'STOP'} @ {px:.2f}"
        if r.get("success"):
            self.entry = {"id": r["orderId"], "dir": a.dir, "px": px, "lots": a.lots, "limit": a.limit, "filled": 0}
            log.info("ORDER   %s  (exact %.4f)", what, a.px)
            self._event("order", dir=a.dir, px=px, lots=a.lots, limit=a.limit)
            return
        log.warning("%s refused: errorCode %s %s", what, r.get("errorCode"), r.get("errorMessage") or "")
        if kind == ORDER_STOP:
            # The bar's open was short of the price (else this would be a limit), but
            # the market got through it before the order arrived: the engine has this
            # stop filled during the bar. A market order is the nearest thing to that.
            r = self.api.place(self.account_id, self.cid, ORDER_MARKET, side, a.lots, tag=self._tag("entry-mkt"))
            if r.get("success"):
                self.entry = {"id": r["orderId"], "dir": a.dir, "px": px, "lots": a.lots, "limit": False, "filled": 0,
                              "market": True}
                log.info("ORDER   %s %d at MARKET (the stop was already through)", "BUY" if side == SIDE_BUY else "SELL", a.lots)
                self._event("order", dir=a.dir, px=None, lots=a.lots, limit=False, market=True)
                self._sync()
                return
            log.error("market entry refused too: errorCode %s %s", r.get("errorCode"), r.get("errorMessage") or "")

    def _protect(self, replace: bool = False) -> None:
        """Stop and target for the open trade, at the strategy's prices."""
        s = self.strat
        if s.pos == 0:
            return
        sl, tp, is_cap = s.protective()
        if is_cap and self.cfg["cap_stop_fees"]:
            sl += s.pos * (2 * self.cfg["commission_per_side"]) / PV
        side = SIDE_SELL if s.pos == 1 else SIDE_BUY
        for k, kind, px in (("sl", ORDER_STOP, sl), ("tp", ORDER_LIMIT, tp)):
            if k in self.legs and not replace:
                continue
            if k in self.legs:
                self._cancel(self.legs.pop(k)["id"], "re-sizing")
            p = self._price(px, side, kind)
            cap = k == "sl" and is_cap
            r = self.api.place(self.account_id, self.cid, kind, side, s.lots,
                               limit_price=p if kind == ORDER_LIMIT else None,
                               stop_price=p if kind == ORDER_STOP else None, tag=self._tag(k + ("-cap" if cap else "")))
            if r.get("success"):
                self.legs[k] = {"id": r["orderId"], "px": p, "size": s.lots, "cap": cap}
                log.info("   %s %s %d @ %.2f%s", "STOP  " if k == "sl" else "TARGET", "SELL" if side == SIDE_SELL else "BUY",
                         s.lots, p, "  (day limit)" if cap else "")
            else:
                log.warning("%s refused: errorCode %s %s", k, r.get("errorCode"), r.get("errorMessage") or "")
                if k == "sl":
                    # the market is already through the stop: the engine has this trade stopped out
                    self._flatten("SL")
                    return

    def _flatten(self, why: str) -> None:
        for k in list(self.legs):
            self._cancel(self.legs[k]["id"], why)
        self.legs.clear()
        if self.trade is not None:
            self.trade["closing"] = why
        self._event("close", why=why)
        self._close_now(why)
        if self.trade is not None and self.trade.get("qty", 0) > 0:
            # The close did not go through. The trade must not sit without its stop
            # while the close is retried.
            log.error("the %s close did not go through -- stop and target back on, retrying every poll", why)
            self.pending_close = why
            if not self.trade.get("late"):
                self._protect()

    def _close_now(self, why: str) -> None:
        try:
            r = self.api.close_position(self.account_id, self.cid)
            if not r.get("success"):
                log.warning("close (%s): errorCode %s %s", why, r.get("errorCode"), r.get("errorMessage") or "")
        except GatewayError as e:
            log.error("close (%s) failed: %s", why, e)
        try:
            self._sync()
        except GatewayError as e:
            log.error("could not read the fills after the close: %s", e)
        if self.trade is None:
            self.pending_close = None

    def _execute(self, acts: List[core.Action]) -> None:
        for a in acts:
            if a.kind == "cancel_arm":
                log.info("cancel the %s order: %s", "BUY" if a.dir == 1 else "SELL", a.why)
                self._drop_entry(a.why)
            elif a.kind == "place_arm":
                self._place_entry(a)
            elif a.kind == "close":
                log.info("close the trade: %s", a.why)
                self._flatten(a.why)

    # ---------- the clock ----------
    def _begin(self, bucket: float, o: float, ct: int, tday: int) -> None:
        i = len(self.strat.info)
        acts = self.strat.begin_bar(i, o, tday, ct)
        self.cur_bucket, self.pending_open = bucket, None
        self._execute(acts)
        if self.busy_orders():
            self._sync()                               # anything that filled at the open (a stop gapped through)
        self._execute(self.strat.open_exits(i))
        self._save()

    def on_boundary(self, T: float) -> None:
        """The 2-minute bucket starting at T (ms) has opened; the one before it has closed."""
        self._ensure_session()
        first, deadline = None, self.clock() + self.cfg["open_wait_s"]
        while True:
            start = (self.last_row_ts if self.last_row_ts is not None else T - 3_600_000) - 10 * 60_000
            first = self._store(self.api.bars(self.cid, self.cfg["live_data"], start, self.now_ms() + 60_000,
                                              partial=True), T)
            if first is not None or self.clock() >= deadline or not self.market_active():
                break
            self.sleep(0.5)
        if self.busy_orders():
            self._sync(before=T)
        # close every bucket that has ended, in order
        for b in sorted(bk for bk in self.rows if self.closed_upto < bk and bk + core.BUCKET_MS <= T):
            bar = self._bucket_bar(b)
            del self.rows[b]
            if bar is None:
                continue
            if self.cur_bucket != b:
                if self.closed_upto >= 0:
                    log.warning("the bar at %s was never begun on time -- running its open now", ct_label(b))
                self._begin(b, bar.o, bar.ct, bar.tday)
            self.strat.finish_bar(bar)
            self.closed_upto, self.cur_bucket = b, None
            info = self.strat.info[-1]
            if info.sig != 0:
                log.info("SIGNAL  %s, bar %s closed at %.2f%s -> %s", "LONG" if info.sig == 1 else "SHORT", ct_label(b),
                         info.c, " (trend rescue)" if info.rescued else "",
                         f"{info.lots} lots" if info.enter else "not traded (against the 10-min EMA)")
        if first is not None:
            self._begin(T, first["o"], core.ct_minute(first["t"]), core.trading_day(first["t"]))
        else:
            self.pending_open = T
        if not self.busy_orders() and self.clock() - self.last_pos_check > 600:
            self._sync()                               # idle: still look for a fill or a position nobody expects
        self._save()

    def poll(self) -> None:
        """Between boundaries: fills, a bar waiting for its first trade, retries."""
        if self.pending_close is not None and self.trade is not None:
            self._close_now(self.pending_close)
        if self.retry_entry is not None:
            a = self.retry_entry
            s = self.strat
            if s.armed() and self.entry is None and self.trade is None and s.arm_dir == a.dir and s.arm_px == a.px:
                self._place_entry(a)
            else:
                self.retry_entry = None
        if self.pending_open is not None and self.market_active():
            T = self.pending_open
            first = self._store(self.api.bars(self.cid, self.cfg["live_data"], T - 10 * 60_000, self.now_ms() + 60_000,
                                              partial=True), T)
            if first is not None:
                self._begin(T, first["o"], core.ct_minute(first["t"]), core.trading_day(first["t"]))
        if self.busy_orders():
            end = self.cur_bucket + core.BUCKET_MS if self.cur_bucket is not None else None
            self._sync(before=end)
            if self.clock() - self.last_pos_check > 5 and (end is None or self.now_ms() < end):
                self._reconcile()
        self._hard_flat()

    def _hard_flat(self) -> None:
        ct = core.ct_minute(self.now_ms())
        if not (self.cfg["hard_flat_ct"] <= ct < 17 * 60):
            return
        if self.strat.pos != 0 or self.entry is not None or self.legs:
            log.error("past %02d:%02d CT with an order or a trade live -- closing everything",
                      self.cfg["hard_flat_ct"] // 60, self.cfg["hard_flat_ct"] % 60)
            self._drop_entry("hard flat")
            if self.strat.pos != 0 or self.trade is not None:
                self._flatten("FLAT")

    def run(self) -> None:
        """The live loop."""
        while True:
            now = self.clock()
            T = math.floor(now * 1000 / core.BUCKET_MS) * core.BUCKET_MS
            try:
                if (now * 1000 >= T + self.cfg["bar_settle_s"] * 1000 and self.cur_bucket != T
                        and self.pending_open != T and self.closed_upto < T):
                    self.on_boundary(T)
                elif self.busy():
                    self.poll()
            except (GatewayError, httpx.HTTPError) as e:
                log.error("gateway: %s", e)
            nxt = (T + core.BUCKET_MS) / 1000 + self.cfg["bar_settle_s"]
            wait = self.cfg["poll_s"] if self.busy() else max(0.2, nxt - self.clock())
            self.sleep(min(wait, 30.0))


# ─────────────────────────────────────────────────────────────
#  ENTRY POINT
# ─────────────────────────────────────────────────────────────
def make_api() -> ProjectX:
    try:
        from dotenv import load_dotenv
        load_dotenv(HERE / ".env")
    except ImportError:                                             # pragma: no cover
        pass
    return ProjectX(os.environ.get("PROJECT_X_USERNAME", ""), os.environ.get("PROJECT_X_API_KEY", ""))


def check_only(api: ProjectX, cfg: Optional[dict] = None) -> int:
    """Read-only: everything the bot needs, nothing placed."""
    bot = Bot(api, cfg=cfg)
    api.login()
    bot._pick_account()
    bot._pick_contract()
    now = bot.now_ms()
    bars = api.bars(bot.cid, bot.cfg["live_data"], now - 3 * 3_600_000, now + 60_000, partial=True)
    log.info("bars: %d one-minute bars in the last 3 hours; newest %s, now %s (%s)", len(bars),
             ct_label(parse_ts(bars[-1]["t"])) if bars else "-", ct_label(now),
             "market open" if bars and now - parse_ts(bars[-1]["t"]) < 5 * 60_000 else "market quiet or closed")
    if bars:
        b = bars[-1]
        log.info("   newest bar: %s", {k: b.get(k) for k in ("t", "o", "h", "l", "c", "v")})
    hist = api.bars(bot.cid, bot.cfg["live_data"], now - 13 * 86_400_000, now, partial=False)
    log.info("history: %d one-minute bars over the last 13 days (the bot loads 30 days in such chunks)", len(hist))
    log.info("open positions: %s", api.positions(bot.account_id))
    log.info("working orders: %s", api.open_orders(bot.account_id))
    log.info("check done -- nothing was placed")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="MNQ Donchian, $1,250-target evaluation, TopstepX")
    ap.add_argument("--check", action="store_true", help="read-only connectivity check; places nothing")
    ap.add_argument("--account", default=None, help="the account's exact name (overrides CONFIG['account_name'])")
    args = ap.parse_args()
    log.info("log file %s", add_file_log())
    api = make_api()
    cfg = {"account_name": args.account} if args.account else None
    if args.check:
        return check_only(api, cfg)
    bot = Bot(api, cfg=cfg)
    bot.start()
    try:
        bot.run()
    except KeyboardInterrupt:
        log.info("stopped by hand -- any working order or open trade is left as it is: check the platform")
    return 0


if __name__ == "__main__":
    sys.exit(main())
