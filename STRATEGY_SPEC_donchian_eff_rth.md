# MNQ Donchian + Efficiency Gate — full specification

Everything needed to reimplement this exactly in Python, including the details
that will otherwise cause silent divergence.

**Measured result:** 43.9% of all 2,598 thirty-day windows passed — 44.0%
in-sample (2019-05→2023-06), 43.9% out-of-sample (2023-06→2026-07) — under
no-overnight rules with a 3:05 PM CT flatten, a hard $1,500 unrealised daily
profit stop and a soft $1,000 entry block.

> ## ⚠ This configuration LOSES MONEY long-run
>
> It passes 43.9% of combines while being **net −$81,299 over 7.2 years**
> (profit factor 0.949, −$14.46 per trade). That is not a contradiction, it is
> the point: a combine is a 30-day sprint that **stops the moment you pass**, so
> a book that wins small and often — and occasionally loses enormously — reaches
> +$3,000 before −$2,000 more often than a genuinely profitable book, while the
> catastrophic losses land in windows that were going to fail anyway.
>
> **There is a direct trade-off, and you should choose deliberately:**
>
> | Setup | Pass rate | Profit factor | Net over 7.2 years |
> |---|---|---|---|
> | Hard $1,500 + soft $1,000 | **43.9%** | 0.949 | **−$81,299** |
> | Soft $1,000 only (no hard cap) | 41.9% | **1.047** | **+$91,640** |
>
> Two extra percentage points of pass rate cost you the entire edge. If you plan
> to **trade the funded account**, take the profitable version. If you plan to
> **pass evaluations and reset cheaply**, the higher pass rate is defensible.
> See §9a.
>
> Also read [Honest limitations](#10-honest-limitations): commission alone
> exceeds gross profit here, and slippage is modelled as zero.

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
this exact book, with both daily stops in force:

| Contracts | IS | OOS | worst |
|---|---|---|---|
| 1 | 0.0% | 0.9% | **0.0%** |
| 4 | 22.6% | 24.5% | 22.6% |
| 6 | 33.4% | 38.8% | 33.4% |
| 8 | 42.1% | 42.8% | 42.1% |
| 9 | 44.2% | 43.6% | 43.6% |
| **10** | **44.0%** | **43.9%** | **43.9%** |

Also measured: risking a fixed % of the surviving cushion scores **0.0%**, because
it collapses the position to 1–2 lots — and at 1 lot the pass rate *is* 0.0%. A
**fixed $3,000 target** is simply unreachable at that size inside 30 days.

Against a fixed-dollar target on a deadline, **throughput beats risk control**.
The curve is nearly flat from 9 to 10 lots, so 9 is a reasonable choice if you
want a little margin against the contract cap.

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

### 7.3 Daily profit stop — +$1,000 soft, +$1,500 hard

Once **realised** P&L for the day reaches **+$1,000**, stop opening new trades
until the next reset. Separately, the platform closes any open position the
instant realised+unrealised P&L touches **+$1,500**. Both are needed — see §7.3a.

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

### 7.3a Use BOTH stops — they are different rules and want opposite values

There are two distinct mechanisms, and confusing them will cost you several
percentage points:

| | What it does | Acts on |
|---|---|---|
| **Hard cap** (`dayProfitStopUsd`) | **Closes** the open position | realised + **unrealised** |
| **Soft block** (`dailyProfitStop`) | Stops **opening** new trades | **realised** only |

**They want opposite values.** The setting cannot be carried from one to the
other:

| | $750 | $1,500 |
|---|---|---|
| Soft block | **41.7%** | 37.7% |
| Hard cap | 25.9% | **39.7%** |

**$1,500 is exactly the right hard cap**, and not by coincidence: it is the
largest daily cap that can *never* violate the 50% consistency rule against a
$3,000 target. The sweep peaks there sharply:

| Hard cap | Pass rate (9 lots) | Passes delayed by consistency |
|---|---|---|
| $1,300 | 37.0% | 0.0% |
| $1,400 | 38.9% | 0.0% |
| **$1,500** | **39.7%** | **0.0%** |
| $1,550 | 39.1% | 15.8% |
| $1,600 | 37.7% | 37.9% |
| $2,000 | 33.8% | 73.6% |

Below $1,500 the cap truncates winners for no consistency benefit. Above it,
violations reappear immediately.

### The best configuration uses both

| Setup | IS | OOS |
|---|---|---|
| Hard $1,500 alone, 9 lots | 39.7% | 40.8% |
| Soft $750 alone, 10 lots | 42.1% | 41.7% |
| **Hard $1,500 + soft $1,000, 10 lots** | **44.0%** | **43.9%** |

The two do different jobs and compose. The hard cap guarantees no day ever breaks
consistency; the soft block stops you taking *new* risk late in a good day
**without truncating a position already running** — it can still ride to the
$1,500 cap. Neither alone gets there.

To implement: keep the platform's hard $1,500 unrealised stop, and add a rule in
the bot that **stops opening new trades once realised day P&L reaches +$1,000**.

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

As shipped (hard $1,500 cap + soft $1,000 block, 10 lots):

| | Shipped (both stops) | Soft block only |
|---|---|---|
| Trades | 5,623 (**2.14/day**) | 5,342 (2.03/day) |
| Win rate | **62.8%** | 75.8% |
| Average win | $426.49 | $500.09 |
| Average loss | −$757.59 | −$1,493.62 |
| Largest loss | **−$10,995** | −$10,995 |
| Profit factor | 0.949 | **1.047** |
| Expectancy | −$14.46 | **+$17.15** |
| Exits | TP 54.9% · **DAYCAP 24.9%** · SL 13.6% · flatten 4.9% · flip 1.8% | TP 75.0% · SL 16.4% · flatten 6.2% · flip 2.4% |
| Mean hold | 35 min | 43 min |
| Pass rate | **43.9%** | 41.9% |

Many small wins, occasional very large losses. Note the largest single loss is
**−$10,995** — over five times the entire drawdown limit. It happens because the
stop is 5×ATR wide and a gap can blow straight through it; a window containing one
of those is simply dead. That is the cost of the inverted geometry.

Note also that the hard cap converts a quarter of all exits into DAYCAP closes,
which is precisely the mechanism that trades edge for pass rate.

### 9a. Passing versus profiting — they are different objectives

This is the single most important thing to understand before deploying it.

Everything in this project was optimised for **pass rate**, which is
P(+$3,000 before −$2,000 within 30 days). That is *not* the same as making money,
and at the margin the two conflict:

| | Pass rate | Profit factor | Net, 7.2 years |
|---|---|---|---|
| Hard cap + soft block | **43.9%** | 0.949 | **−$81,299** |
| Soft block only | 41.9% | **1.047** | **+$91,640** |

The combine **stops the moment you pass**, so a book that wins small and often
banks the target before its rare catastrophic loss arrives. Those losses then land
in windows that fail — which costs you 2 points of pass rate but destroys
long-run P&L.

**Decide which you are doing:**

- **Passing evaluations to collect funded accounts** → the higher pass rate is
  defensible, provided a reset is cheap relative to a payout.
- **Trading the funded account** → use the profitable version. Disable the hard
  cap, keep the soft $1,000 entry block, accept 41.9%.

Measured funded outcomes are close either way over 180 days (50.0% vs 52.9% reach
a payout; mean $2,093 vs $2,061), but that horizon is too short for a negative
per-trade edge to fully express itself. Over a long funded run, profit factor is
what decides the outcome.

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

**Commission exceeds gross profit as shipped.** $84,345 paid against $3,046 gross,
for **−$81,299 net**, at $0.75/side/contract across 5,623 trades. Without the hard
cap the same book is +$91,640 net on $171,770 gross, with commission at 47%.
Either way this is a high-turnover book whose viability is decided by execution
cost — use your broker's real per-contract rate, never a flat per-trade figure.

**Slippage is modelled as ZERO.** Across 5,623 trades at 10 lots, **one tick per
side costs roughly $56,000**. That is larger than the entire gross profit of the
shipped configuration. Measure your real fills before trusting any number here;
this is the assumption most likely to be wrong and most likely to be fatal.

**A single loss can be five times the drawdown limit.** Largest observed:
−$10,995 against a $2,000 limit, because a 5×ATR stop can be gapped straight
through. Any window containing one is dead regardless of everything else.

**Regime still dominates a single attempt:**

| 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|
| 22% | 31% | 55% | 50% | 47% | 39% | 57% | 42% |

**43.9% is not 70%.** Under these account rules nothing in ~2.2 billion window
simulations reached 70%. The identical search with **overnight holds allowed**
reached **83%**. The flatten rule, not the strategy, is the binding constraint —
if that rule is negotiable, it is worth about 45 percentage points.

**Funded stage:** 50.0% of runs reach a payout, median 11 days to first, median
first payout $2,806, mean $2,093 per 180 days. Leave profit in the account —
withdrawing everything parks you on the locked $0 floor and the next losing day
ends it. And note §9a: over a horizon longer than 180 days, a profit factor below
1.0 will assert itself.

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

`strategies/donchian_eff_rth.mjs` in this repo, which ships this exact
configuration: 5,623 trades, PF 0.949, −$14.46/trade, 2.14/day, **43.9% pass**
over 2,598 windows (44.0% IS / 43.9% OOS), median 8 days to pass.

To reproduce interactively: select **"MNQ Donchian + Efficiency Gate"** in the
sidebar. It ships its own execution, filter and rule defaults, so selecting it
applies the whole configuration — including both daily stops.

**To run the profitable variant instead** (41.9%, PF 1.047, +$91,640): set
`dayProfitStopUsd` to 0 in the Execution panel, leaving the soft $1,000 block in
Combine rules.

### Worked example

A passing window, 2019-05-08: passed in **9 days**, 15 trades taken and 3 skipped
by daily rules, net $3,084, best day $1,189 (39% of profit, inside the 50% cap),
and the closest it came to the trailing floor was $1,695.
