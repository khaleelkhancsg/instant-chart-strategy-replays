# MNQ Donchian + Efficiency Gate — full specification

Everything needed to reimplement this exactly in Python, including the details
that will otherwise cause silent divergence.

**Measured result:** 41.9% pass across all 2,598 thirty-day windows
(42.1% in-sample 2019-05→2023-06, 41.7% out-of-sample 2023-06→2026-07),
under no-overnight rules with a 3:05 PM CT flatten.

> **Read the [Honest limitations](#10-honest-limitations) section before trading
> this.** Commission is 47% of gross profit and slippage is modelled as zero.

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

Do not use Kelly, volatility targeting, or risk-a-fraction-of-equity. Measured on
this exact book:

| Sizing | Pass rate |
|---|---|
| **Flat 10 lots** | **41.9%** |
| Risk a fixed % of surviving cushion | **0.0%** |
| Flat 6 lots | 28.8% |
| Flat 1 lot | 0.0% |

Risk-fraction sizing collapses the position to 1–2 lots, and a **fixed $3,000
target** then becomes unreachable inside 30 days. Against a fixed-dollar target on
a deadline, throughput beats risk control.

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

### 7.2 Daily circuit breaker — −$150

Once **realised** P&L for the trading day reaches −$150, stop opening new trades
until the next reset. Let an open position finish at its bracket.

*Note: measured impact here is small (it skips only ~8% of trades) because this
book averages 2 trades/day. It was the single biggest lever in an earlier
zero-edge book; it is not one here. Keep it as cheap insurance.*

### 7.3 Daily profit stop — +$750

Once **realised** P&L for the day reaches +$750, stop opening new trades until the
next reset.

**This value matters, and the reason is subtle enough to be worth stating
carefully — it is not that "$750 is under 50% of $3,000".** $1,500 is *exactly*
50% of $3,000, so on that arithmetic a $1,500 stop should be fine.

The catch is that **a profit stop does not cap the day.** It blocks *new* entries
once the threshold is crossed; the trade that crosses it overshoots, and any
position already open keeps running to its bracket. So the realised day lands
*above* the stop, not at it:

| Profit stop | Windows with a day > $1,500 | Passes delayed by consistency |
|---|---|---|
| $750 | 95 (6.4%) | 37 (5.9%) |
| $1,500 | **749 (50.3%)** | **432 (67.0%)** |

With a $1,500 stop, half of all windows still print a day over $1,500, and at a
total near $3,000 that breaks the 50% test — so the account reaches the target and
then has to keep grinding to dilute the day before it can pass.

Proof that consistency is the whole mechanism — turning the rule off reverses the
ranking:

| Profit stop | Consistency ON | Consistency OFF |
|---|---|---|
| off | 28.7% | 42.9% |
| **$750** | **41.7%** | 42.1% |
| $1,500 | 37.7% | **43.3%** |

Note the corollary: **without the consistency rule the profit stop is nearly
worthless** (42.9% with no stop at all versus 43.3% at $1,500). Its entire value
is navigating consistency. If your firm has no consistency requirement on the
evaluation, drop the stop and size the day freely.

### 7.4 Trading-day boundary

A trading day starts at **17:00 America/New_York** (5 pm ET, DST-aware). Track
realised P&L since the last 17:00 ET reset.

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

Inverting the geometry produces a book that **resolves**: mean hold time 43
minutes, 75.0% of exits at target.

### Resulting trade profile

| | |
|---|---|
| Trades | 5,342 over 7.2 years (**2.03/day**) |
| Win rate | **75.8%** |
| Average win | $500.09 |
| Average loss | −$1,493.62 |
| Profit factor | 1.047 |
| Expectancy | **$17.15/trade** at 10 lots |
| Exits | TP 75.0% · SL 16.4% · flatten 6.2% · flip 2.4% |
| Mean hold | 43 minutes |

Many small wins, occasional large losses. That is the correct shape here.

### What to optimise if you tune it

Across 79 configurations, correlation with pass rate:

| Metric | Correlation |
|---|---|
| Profit factor | 0.134 |
| Trades per day | −0.381 |
| **Expectancy × trades/day (= $/day)** | **0.512** |

Neither edge nor frequency predicts much alone — their **product** does. This
book has the *lowest* profit factor of the qualifying candidates and the *highest*
pass rate, because 2.03 trades/day at PF 1.047 beats 0.74/day at PF 1.148.

**Tune toward dollars per day at maximum legal size, not toward a prettier profit
factor.**

---

## 10. Honest limitations

**Commission is 47% of gross profit.** $80,130 paid against $91,640 net (gross
$171,770) at $0.75/side/contract. At double commission this book is unprofitable.
Use your broker's real per-contract rate, not a flat per-trade figure.

**Slippage is modelled as ZERO.** Across 5,342 trades at 10 lots, one tick per
side costs roughly **$53,000** — more than half the net profit. Measure your real
fills before trusting anything here.

**Regime still dominates a single attempt:**

| 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|
| 18% | 33% | 49% | 53% | 46% | 38% | 50% | 37% |

**41.9% is not 70%.** Under these account rules nothing in ~2.2 billion window
simulations reached 70%. The identical search with **overnight holds allowed**
reached **83%**. The flatten rule, not the strategy, is the binding constraint —
if that rule is negotiable, it is worth about 45 percentage points.

**Funded stage:** 52.9% of runs reach a payout, median 11 days to first, median
first payout $2,365, mean $2,061 per 180 days. Leave profit in the account —
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
8. **`zoneinfo`, not fixed offsets** — the session window is CT and the P&L reset
   is ET, and they diverge across DST if you hardcode.
9. **Flatten outranks the bracket** and blocks entries until the reopen.
10. **Ten contracts flat.** Resist every instinct to make sizing clever.

---

## 12. Reference implementation

`strategies/donchian_eff_rth.mjs` in this repo. Verified through the server API:
5,342 trades, PF 1.047, $17.15/trade, 2.03/day, 41.9% pass over 2,598 windows —
identical to the research script.

To reproduce interactively: select **"MNQ Donchian + Efficiency Gate"** in the
sidebar. It ships its own execution, filter and rule defaults, so selecting it
applies the whole configuration.
