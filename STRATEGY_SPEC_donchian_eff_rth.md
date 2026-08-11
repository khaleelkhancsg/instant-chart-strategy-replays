# MNQ Donchian + Efficiency Gate — full specification

Everything needed to reimplement this exactly in Python, including the details
that will otherwise cause silent divergence.

## The configuration in one table

| | |
|---|---|
| Instrument | MNQ, continuous front month |
| Signal bars | 2-minute, clock-aligned |
| Signal | Donchian-30 breakout, **with** the break, `ADX ≥ 25` |
| Regime gate | Kaufman efficiency ratio **> 0.5** |
| Session gate | **08:30–15:00 America/Chicago** |
| Stop / target | **5 × ATR** / **1.5 × ATR** (≈ 0.3 : 1) |
| Size | **10 contracts, flat** |
| Daily profit block | **+$1,000 realised**, blocks *new entries* only |
| Daily circuit breaker | **−$150 realised** |
| Platform hard profit stop | **off** — see §7.3a |
| Flatten | **15:05 CT**, no entries after 14:55 CT |

**Measured:** **42.6%** of all 2,598 thirty-day windows passed, median **8 days**
to pass. In-sample 43.5% / out-of-sample 41.4% assuming perfect fills; **41.3% /
41.0% at one tick of slippage per side**, which is the number to plan against.

Over the same 7.2 years the book is **profit factor 1.047, +$17.15 per trade,
+$91,640 net**.

> **Before you trade it, read [§9a](#9a-passing-versus-profiting) and
> [§10](#10-honest-limitations).** A higher pass rate is available (42.3% at one
> tick) but only by turning this into a book that loses $52,778 — §7.3a explains
> the trade and why it is declined here.

---

## 1. Instrument and data

| Item | Value |
|---|---|
| Symbol | **MNQ**, front month, rolled on volume |
| Tick size | 0.25 index points |
| **Point value** | **$2.00 per index point per contract** |
| Source bars | 1-minute OHLCV |
| Signal bars | **2-minute**, clock-aligned |

**Continuous contract.** Splice on the highest-volume contract per day and
back-adjust additively (Panama). Measure each roll's gap from **both contracts
quoted at the same minute**, never close-to-close — 4 of 20 MNQ rolls land at the
Sunday 22:00 UTC reopen, and a close-to-close gap there absorbs a 49-hour weekend
move into the adjustment. On this data that error reached **359 points**.

---

## 2. Bar construction

Aggregate 1-minute bars into **clock-aligned** 2-minute buckets:

```python
bucket = floor(timestamp_ms / (2 * 60_000))
```

- open = first 1-min open in the bucket
- high = max, low = min, close = last close, volume = sum
- The bar's timestamp is the **bucket start**

Do **not** group in fixed chunks of two by index — that drifts out of phase after
every session gap and cannot be reproduced live.

Only completed bars are used. Never the forming bar.

---

## 3. Indicators

**Smoothing is standard EMA, `alpha = 2/(n+1)`, seeded `ema[0] = x[0]`.**
NOT Wilder's `1/n`. TA-Lib and pandas-ta default to Wilder for ATR/ADX — if you
use their defaults you will get different signals and must re-validate.

### 3.1 ATR(14)

```
TR[0] = High[0] - Low[0]
TR[i] = max(High[i]-Low[i], |High[i]-Close[i-1]|, |Low[i]-Close[i-1]|)
ATR   = EMA(TR, 14)
```

### 3.2 ADX(14)

```
up = High[i]-High[i-1];  dn = Low[i-1]-Low[i]
+DM[i] = up  if (up > dn and up > 0) else 0
-DM[i] = dn  if (dn > up and dn > 0) else 0

atrE = EMA(TR,14);  pdiE = EMA(+DM,14);  ndiE = EMA(-DM,14)
+DI = 100*pdiE/atrE          (0 if atrE == 0)
-DI = 100*ndiE/atrE          (0 if atrE == 0)
DX  = 100*|(+DI)-(-DI)| / ((+DI)+(-DI))     (0 if denominator == 0)
ADX = EMA(DX, 14)
```

### 3.3 Donchian channel (30, **prior bars only**)

At bar `i`, over bars `i-30 … i-1`, **excluding bar i**:

```
DonHigh[i] = max(High[i-30 : i])
DonLow[i]  = min(Low[i-30 : i])
```

Undefined (NaN) for `i < 30`. Excluding the current bar is essential — including
it makes the bar compare against itself and the breakout becomes meaningless.

### 3.4 Kaufman efficiency ratio (20) — the regime gate

```
ER[i] = |Close[i] - Close[i-20]| / sum(|Close[j] - Close[j-1]| for j in i-19..i)
```

Net travel divided by total path length. `1.0` = a straight line, `~0` = pure
chop. Undefined for `i < 20`. **A NaN reading must FAIL the gate, never pass it.**

This gate keeps only **9.5%** of raw signal bars, and it is what makes the book
work at all.

---

## 4. Entry

Evaluated at the **close of each completed 2-minute bar `i`**. All conditions:

1. **Session** — bar `i`'s time is within **08:30:00 ≤ t < 15:00:00 America/Chicago**
2. **Regime** — `ER[i] > 0.5`
3. **Trend** — `ADX[i] ≥ 25`
4. **Break** — long if `Close[i] > DonHigh[i]`, short if `Close[i] < DonLow[i]`
5. **Flat** — no position currently open
6. **Cooldown** — at least 1 bar since the last signal (i.e. no enforced spacing)
7. **Daily rules** — see §7; if the day is locked out, no entry

**Fill: at the OPEN of bar `i+1`.** The signal is confirmed at bar `i`'s close and
filled at the next bar's open. Bar `i+1`'s high/low/close must never influence
the decision to enter.

All timestamps in **America/Chicago**, DST-aware. Use `zoneinfo`, not a fixed
offset.

---

## 5. Exit — a fixed ATR bracket

On entry at price `EP`, with `A = ATR[i]` (the **signal** bar's ATR, fixed for the
life of the trade — do not recompute):

| | Distance | Long | Short |
|---|---|---|---|
| Stop | `5 × A` | `EP − 5A` | `EP + 5A` |
| Target | `1.5 × A` | `EP + 1.5A` | `EP − 1.5A` |

That is roughly **0.3 : 1 reward:risk** — deliberately inverted. See §9.

Per subsequent bar, check in this exact order (**stop has priority over target**):

**Long**
1. if `Open ≤ Stop` → exit at **Open** (gapped through)
2. elif `Low ≤ Stop` → exit at **Stop**
3. elif `High ≥ Target` → exit at **Target**

**Short**
1. if `Open ≥ Stop` → exit at **Open**
2. elif `High ≥ Stop` → exit at **Stop**
3. elif `Low ≤ Target` → exit at **Target**

When both levels sit inside one bar you cannot know which printed first, so
**assume the loss**.

**Flip:** an opposite signal while in a position closes at the next bar's open and
may open the new position on that same bar.

**No re-entry on the bar a trade exited.** The only available fill price would be
that bar's open, which occurred *before* the exit. This is not pedantry — the same
mistake in another backtester turned a losing book (PF 0.94) into a winning one
(PF 1.37) and accounted for 91% of its trades.

No trailing stop. No breakeven move. No scale-out (measured: scaling out cost
4.6–8.6 percentage points).

---

## 6. Position sizing

**Ten contracts. Flat. Always.**

Measured at one tick of slippage, in the recommended configuration:

| Contracts | IS | OOS | worst |
|---|---|---|---|
| 6 | 30.6% | 37.2% | 30.6% |
| 8 | 40.0% | 38.3% | 38.3% |
| 9 | 42.2% | 40.1% | 40.1% |
| **10** | **41.3%** | **41.0%** | **41.0%** |

Do not use Kelly, volatility targeting, or risk-a-fraction-of-equity. Risking a
fixed % of the surviving cushion scores **0.0%**, because it collapses the
position to 1–2 lots — and at 1 lot the pass rate *is* 0.0%. A **fixed $3,000
target** is simply unreachable at that size inside 30 days.

Against a fixed-dollar target on a deadline, **throughput beats risk control**.

---

## 7. Session and daily rules — enforced by the bot, not the signal

### 7.1 Flatten (hard requirement)

- **Flat by 15:05 America/Chicago.** Any open position closes at the open of the
  first bar at or after 15:05 CT, market order.
- **No new entries** between 15:05 CT and the 17:00 CT reopen.
- **No new entries after 14:55 CT** (10 minutes before the flatten) — a trade
  opened at 15:04 can only be flattened for the cost of the fill.

The flatten outranks the bracket: it fires regardless of where stop and target
sit.

### 7.2 Daily circuit breaker — −$150 realised

Once **realised** P&L for the trading day reaches −$150, stop opening new trades
until the next reset. Let an open position finish at its bracket.

*Measured impact here is small — it skips only ~8% of trades, because this book
averages 2 trades/day and rarely gets the second trade in a day that the breaker
needs in order to bite. It was the single biggest lever in an earlier zero-edge
book; it is not one here. Keep it as cheap insurance.*

### 7.3 Daily profit block — +$1,000 realised

Once **realised** P&L for the day reaches **+$1,000**, stop opening new trades
until the next reset. **Do not close the open position** — let it run to its
bracket.

**This is the single largest lever in the whole configuration.** At 10 lots and
one tick of slippage:

| Block | Pass rate |
|---|---|
| off | **26.7%** |
| $750 | 39.3% |
| **$1,000** | **41.0%** |
| $1,250 | 40.3% |

It works by keeping any single day under 50% of total profit, which is what the
consistency rule requires (§8). And it costs nothing in edge, because it only
prevents *new* risk — it never truncates a trade already working.

### 7.3a Why the platform's hard profit stop is switched OFF

Most platforms also offer a stop on **unrealised** P&L that *flattens* the
position the instant realised+open touches a number. That is a different rule
from §7.3 and it behaves differently:

| | What it does | Acts on |
|---|---|---|
| **Soft block** (§7.3) | Stops **opening** new trades | realised only |
| **Hard cap** | **Closes** the open position | realised + **unrealised** |

If you use a hard cap, **$1,500 is the correct value** — it is the largest daily
cap that can never violate the 50% consistency rule against a $3,000 target, and
the sweep peaks there sharply:

| Hard cap | Pass rate (9 lots) | Passes delayed by consistency |
|---|---|---|
| $1,300 | 37.0% | 0.0% |
| $1,400 | 38.9% | 0.0% |
| **$1,500** | **39.7%** | **0.0%** |
| $1,550 | 39.1% | 15.8% |
| $1,600 | 37.7% | 37.9% |

**But it is switched off here**, because it truncates winners at an arbitrary
dollar level while leaving losses untouched. At one tick of slippage:

| Setup | Pass @ 1 tick | Profit factor | Net over 7.2 years |
|---|---|---|---|
| Hard $1,500 + soft $1,000, 9 lots | **42.3%** | 0.964 | **−$52,778** |
| **Soft $1,000 only, 10 lots** | 41.0% | **1.047** | **+$91,640** |

**1.3 percentage points of pass rate, for the difference between making $91,640
and losing $52,778.** Declined. Turn the hard cap on only if you are farming
resets and will never trade the funded account.

### 7.4 Trading-day boundary

A trading day starts at **17:00 America/New_York** (5 pm ET, DST-aware). Track
realised P&L since the last 17:00 ET reset.

Note the two timezones: the **session window is CT**, the **P&L reset is ET**.
They diverge if you hardcode offsets.

---

## 8. The evaluation rules being targeted

| Rule | Value | Behaviour |
|---|---|---|
| Profit target | $3,000 | Cumulative → PASS |
| Trailing drawdown | $2,000 | **The only hard fail.** Trails the best **daily close**, locks static at breakeven once peak ≥ $2,000 |
| Consistency | 50% | No single day may exceed half of total profit — **blocks the pass** until diluted |
| Firm daily loss limit | $1,000 | Soft lockout, resume next session. Not a breach |
| Contract cap | 10 | |
| Window | 30 days | Ends the moment you pass or breach |

---

## 9. Why the geometry is inverted — do not "fix" it

A 5×ATR stop against a 1.5×ATR target looks wrong. It is the single most
important thing about this configuration.

Under a 3:05 PM CT flatten, a wide target never arrives. Measured on the books
this project started with (6:1 and 18:1 targets):

- winners took a **median 6.5 hours** (90th percentile 18.3h)
- losers resolved in a **median 1.0 hour**
- the deadline therefore truncated **36.9% of winners** but only **5.1% of losers**
- **$1.70M of $3.97M gross profit** sat in exactly those truncated winners

Inverting the geometry produces a book that **resolves**.

### Resulting trade profile

| | |
|---|---|
| Trades | 5,342 over 7.2 years (**2.03/day**) |
| Win rate | **75.8%** |
| Average win | $500 |
| Average loss | −$1,494 |
| **Largest loss** | **−$10,995** |
| Profit factor | **1.047** |
| Expectancy | **+$17.15/trade** |
| Exits | TP 75.0% · SL 16.4% · flatten 6.2% · flip 2.4% |
| Mean hold | **43 minutes** |
| Net / commission | +$91,640 / $80,130 |

Many small wins, occasional very large losses. The largest single loss is
**−$10,995 — over five times the entire drawdown limit**, because a 5×ATR stop
can be gapped straight through. A window containing one of those is dead
regardless of everything else. That is the price of this geometry.

### 9a. Passing versus profiting

Everything in this project was optimised for **pass rate**, which is
P(+$3,000 before −$2,000 within 30 days). That is *not* the same as making money,
and at the margin the two conflict.

Long-run P&L is genuinely the **wrong lens for the evaluation itself**: a combine
is pass/fail, attempts are independent, and negative live expectancy does not
disqualify a book whose only job is to reach $3,000 once.

**But it stops applying the moment you are funded** — and as §7.3a shows, the
trade-off nearly dissolves anyway under realistic fills. Buying 1.3pp by turning
+$91,640 into −$52,778 is a bad deal unless resets are your business model.

The recommended configuration is therefore the one that both passes at ~41% and
makes money.

### What to optimise if you tune it

Across 79 configurations, correlation with pass rate:

| Metric | Correlation |
|---|---|
| Profit factor | 0.134 |
| Trades per day | −0.381 |
| **Expectancy × trades/day (= $/day)** | **0.512** |

Neither edge nor frequency predicts much alone — their **product** does. Raw
frequency without edge is actively bad (a 47.96 trades/day book at PF 0.930 scored
12.6%); high edge with too few trades is equally useless (PF 1.347 at 0.48/day
scored 36.7%).

**Tune toward dollars per day at maximum legal size, not toward a prettier profit
factor.**

---

## 10. Honest limitations

**Commission is 47% of gross profit.** $80,130 paid against $171,770 gross, for
+$91,640 net, at $0.75/side/contract across 5,342 trades. This is a high-turnover
book whose viability is decided by execution cost — use your broker's real
per-contract rate, never a flat per-trade figure. **At double commission it is
unprofitable.**

**Slippage costs about $150 per combine.** One tick per side at 10 lots is $10
round trip, and a window takes a median of 16 trades:

| Ticks/side | Cost per combine | Pass rate | vs zero |
|---|---|---|---|
| 0 | $0 | 41.4% | — |
| 0.5 | $80 | — | — |
| **1** | **$150** | **41.0%** | **−0.4pp** |
| 2 | $300 | 38.2% | −3.2pp |

Note this configuration is **more robust to slippage than the hard-cap variant**
(−0.4pp vs −2.6pp at one tick), because it has genuine edge to absorb the cost.
The right denominator is *one combine*, not the 5,342 trades across 7.2 years you
will never take consecutively.

**A single loss can be five times the drawdown limit** (−$10,995 observed against
a $2,000 limit). Any window containing one is dead.

**Regime dominates a single attempt:**

| 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|
| 22% | 31% | 54% | 50% | 47% | 37% | 51% | 41% |

**~41% is not 70%.** Under these account rules nothing in ~2.2 billion window
simulations reached 70%. The identical search with **overnight holds allowed**
reached **83%**. The flatten rule, not the strategy, is the binding constraint —
if it is ever negotiable, it is worth about 45 percentage points.

**Funded stage:** 49.7% of runs reach a payout, median 11 days to first, median
first payout $2,820, mean $2,148 per 180 days. **Leave profit in the account** —
withdrawing everything parks you on the locked $0 floor and the next losing day
ends it.

---

## 11. Python porting checklist

1. **EMA, not Wilder**, for ATR and ADX. The most common source of divergence.
2. **Clock-aligned 2-minute bars**, completed only; act at bar close, fill at the
   next bar's open.
3. **Donchian excludes the current bar.**
4. **Signal-bar ATR** fixes the bracket for the life of the trade.
5. **Stop-before-target** priority; gap-through fills at the open.
6. **No re-entry on the bar a trade exited.**
7. **A NaN efficiency ratio fails the gate**, never passes it.
8. **`zoneinfo`, not fixed offsets** — session window is CT, P&L reset is ET.
9. **Flatten outranks the bracket** and blocks entries until the reopen.
10. **The $1,000 daily profit rule blocks new ENTRIES only** — it must not close
    an open position. If your platform's daily profit target flattens instead,
    turn it off and implement the block in the bot. See §7.3a.
11. **Ten contracts flat.** Resist every instinct to make sizing clever.

---

## 12. Reference implementation

`strategies/donchian_eff_rth.mjs` in this repo ships this exact configuration:
5,342 trades, PF 1.047, +$17.15/trade, 2.03/day, **42.6% pass** across all 2,598
windows (43.5% IS / 41.4% OOS at zero slippage; 41.3% / 41.0% at one tick),
median 8 days to pass.

To reproduce interactively: select **"MNQ Donchian + Efficiency Gate"** in the
sidebar. It ships its own execution, filter and rule defaults, so selecting it
applies the whole configuration.

**To run the maximum-pass-rate variant instead** (42.3% at one tick, but PF 0.964
and −$52,778): set `dayProfitStopUsd` to 1500 and `contracts` to 9 in the
Execution panel.

### Worked example

A passing window, 2019-05-08: passed in **9 days**, 15 trades taken and 3 skipped
by daily rules, net $3,084, best day $1,189 (39% of profit, inside the 50% cap),
and the closest it came to the trailing floor was $1,695.
