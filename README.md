# MNQ Chart Lab

A visual backtester for 30-day prop-firm combines on MNQ 1-minute data. You pick
a 30-day window, see every trade on the chart, watch the equity curve run against
the trailing drawdown floor, and drag strategy parameters around while the trades
redraw underneath your cursor.

Built to answer *why* a window passed or died — not just whether it did.

```bash
node prepare.mjs      # once: CSV -> binary cache (~3s)
node server.mjs       # then: http://localhost:5178
```

---

## What you're looking at

**Price pane** — candles, with every trade drawn as an entry marker → exit marker
joined by a line, green for a winner and red for a loser. Hover a trade for its
P&L, exit reason, stop/target levels, and worst excursion; hovering also draws the
bracket that was live for it.

Trades the *rules* suppressed are drawn faded and dashed. This matters more than
it sounds: with the shipped -$150 circuit breaker, roughly half the strategy's
signals never become trades, and seeing which ones is how you tell a signal
problem from a risk-overlay problem.

**Equity pane** — cumulative P&L as a step line, the trailing drawdown floor
stepping up beneath it, and the profit target above. The shaded band between
equity and floor is your actual survivable room. A gold marker shows where the
floor locks at breakeven.

**Daily P&L pane** — one bar per CME session (17:00 ET boundaries), with the daily
profit stop, your circuit breaker, and the firm's daily limit drawn as reference
lines. Sessions that hit a lockout get a gold underline.

**The window ends when it resolves.** 30 days is a maximum, not a duration — the
evaluation is over the moment you hit the target or breach. A dashed marker shows
where, everything after it is dimmed, and trades in the dead region are drawn
faded because they never happened.

Related and easy to miss: the **50% consistency rule gates the evaluation**.
Reaching $3,000 on one oversized winning day does not pass the account — you must
keep trading to dilute that day below half of total profit. Measured here, 95% of
passing windows hit the target *first* and then need ~10 more trades, which delays
the pass and re-exposes the account to breach. That cost is real, and it is why
median days-to-pass is 13 rather than 6.

There is **no consistency rule on payouts** — the funded stage gates withdrawals
on winning days instead.

**Navigator** — every possible 30-day start across the 5 years, coloured by
outcome. Click to jump. This is the difference between "this window passed" and
"this passes 75% of the time".

### Funded stage — the part that actually pays

Passing is a gate, not the goal. The **Funded stage** panel follows the same book
*after* it passes, under the funded rules: no consistency requirement, and a
payout unlocked by **5 winning days over $150** each. It runs hundreds of funded
accounts from staggered start dates and reports how many get paid, how fast, how
much, and how many die first.

It immediately exposed something worth knowing. Withdrawing your whole balance
leaves the account sitting exactly on its locked $0 floor, so the next losing day
kills it. Leaving a buffer in changes the outcome enormously (overnight holds
allowed, 180-day horizon):

| profit left in | survive 180d | median 1st payout | mean total paid |
|---|---|---|---|
| $0 | **0.0%** | $8,627 | $10,885 |
| $1,500 | 13.1% | $7,127 | $36,385 |
| $3,000 | **44.3%** | $5,627 | **$59,391** |

A smaller first cheque for **5.5× more money overall**. Under the no-overnight
rule the same book manages only 28.6% reaching any payout at all.

> **Modelled vs assumed.** Winning-day accrual, payout unlock, withdrawals
> lowering the balance, and the trailing drawdown still killing the account are
> all modelled. The **profit split, payout cap, and required buffer are
> assumptions** — they are exposed as parameters, so set them to your firm's
> actual terms before trusting any figure here.

**Sidebar** — two panels answering two different questions. *This window* is the
anecdote in front of you, recomputed live as you drag sliders. *All windows* is
the distribution it was drawn from: pass/breach/ran-out-of-time split across all
2,598 windows, median days to pass, best and worst window, and a **pass rate by
year** breakdown. That last one matters more than the headline number — the
reference strategy ranges from 47% to 90% depending on the year, so which regime
you happen to attempt in dominates your actual outcome. The panel dims and
re-sweeps automatically ~700ms after you stop changing parameters.

### Indicators beside the strategy

**Indicators** in the sidebar adds any of 21 studies to the chart, each on a
timeframe of your choice. They are drawn on the price pane or in a pane of their
own, with their values under the crosshair:

| Group | Studies |
|---|---|
| Price | EMA, SMA, EMA cross (fast / slow), VWAP (session or RTH, with σ bands), Supertrend |
| Bands & levels | Bollinger, Keltner, Donchian, prior day & overnight levels, opening range |
| Oscillators | RSI, Stochastic, MACD, CCI, rate of change, z-score |
| Regime & volatility | ADX / DMI, ATR, efficiency ratio, choppiness, relative volume |

Each study does two jobs:
- **It reports.** The **Indicator edge** panel splits every trade of the full run
  by the study's state at its signal, over all history and over 2026:
  - with or against a line or a direction;
  - by zone for an oscillator or a band, from fading an extreme to chasing one;
  - by quintile for a level.

  It is the cheap first look at whether a combination is worth testing.
- **It can gate.** Set its gate and it refuses the entries its state does not
  allow, e.g. "longs only above the 15-minute EMA 50", "only while ADX ≥ 25",
  "no longs over RSI 70". The pass rate then says whether the combination helps.

Two rules keep a gate honest:
- **It reads closed bars only.** A study on a longer timeframe than the signal is
  read from its last bar that had closed when the signal bar closed. It is drawn
  as steps, each value appearing when it became known: a 15-minute EMA used at
  10:04 is the 09:45 bar's.
- **It refuses entries only.** A refused signal still closes an opposite position
  and still cancels a working order, so a gate never changes how a trade exits.

An example on the $1,250 tab: `donchian_shipped` passes 44.2% of 2026 windows.
Adding the live $1,250 bot's filter, an **EMA cross 9/21 on 10m** with the gate
"with", lifts that to **59.4%** (Jan–Mar 47.8, Apr–Jul 73.3). Adding its
40-minute exit too, as **Stale exit after 20 bars, 1 ATR** in Execution & costs,
gives **70.3%**. All history falls from 42.1% to 35.6% on the way, though, so this
is a 2026 edge: check both before trusting one. (The live bot also halves its
size late in the day, which the lab does not model.)

---

## Why it feels instant

The strategy files and the rules engine are **isomorphic ES modules** — the same
`.mjs` files run in Node and are imported directly by the browser. So:

- Moving a slider re-runs the *real* backtest over the visible window **in the
  page**, in 2–12ms. No request, no server round trip, nothing to debounce.
- The 5-year sweep still runs server-side (96ms backtest + 18ms for 1,796
  windows) because it needs all 1.77M bars in RAM.

Both paths execute identical code, so the fast preview can't drift from the
authoritative numbers. That's verified: at ADX 40 the in-browser window shows
-$3,652 / 8 trades / -$1,652 cushion, and the server's independent full-history
sweep reports exactly the same figures for that window.

Supporting choices: the CSV is preprocessed once into packed typed arrays (54MB,
loads in 41ms vs ~12s of parsing); a window ships as one binary blob so zoom and
pan do zero I/O; candles bucket into pixel columns so cost is bounded by chart
width, not bar count; and the crosshair lives on its own canvas so pointer moves
never repaint 30,000 candles.

---

## The strategy library

30 strategies ship in `strategies/`. **Four are templates** built to be tuned
rather than traded as-is — each collapses a whole family of ideas onto sliders:

| Template | What its parameters span |
|---|---|
| `tpl_ma_cross` | EMA or SMA, hold-the-state or trade-the-cross, optional long-MA trend filter and ADX gate |
| `tpl_channel` | Donchian / Bollinger / Keltner, and **`direction` flips it between momentum and mean reversion** — the same channel, two opposite theories |
| `tpl_oscillator` | RSI / Stochastic / z-score, fade or follow, fire on the level or on the cross back |
| `tpl_consensus` | one oscillator family at several speeds, standing aside when they disagree |

The rest:
- **The live books:** `donchian_shipped` (the $3,000 bot's exact configuration) and
  its research ancestor `donchian_eff_rth`.
- **The MACD family:** flips, fades and anticipations on 1- and 5-minute bars,
  `macd_mtf_confirm`, `macd_angle_v4`, `ema_cross_macd_fade`.
- **Session structure:** `orb`, `prior_day_break`, `gap_fade`,
  `session_range_fade`, `vwap_fade`, `zscore_fade`.
- **Trend ports:** `trend_neutev`, `trend_vol_adaptive`, `supertrend`,
  `adx_di_trend`, `triple_ema`, `macd_cross`, `momentum_roc`.

`momentum_roc` is deliberately crude — bare rate-of-change, no smoothing. It is
the baseline: if an elaborate book cannot beat it, the elaboration is not paying
for itself.

A useful sanity check: `tpl_channel`'s Donchian-30 breakout with ADX 25
reproduces `trend_neutev` **trade for trade** (11,036 trades) when given the same
2 / 12 ATR bracket. It ships with a 6 ATR target, so at their defaults the two
differ.

### Every strategy at its defaults, under the real rules

*Measured 2026-10-27 by `research/strategy_table.mjs`; every number is in
`research/strategy_table_results.json`.*

How to read the tables:
- **Each strategy is set up as the chart opens it**, with its own stop, target,
  size, gates and costs, on the evaluation's rules. The one change: every book
  is flat by 15:05 CT, because the firm forbids overnight holds. † marks the books
  that hold overnight by default, so the chart's defaults for them differ from
  these rows.
- **Pass rates are the chart's sweep:** a 30-day combine started on every day of
  the grid, each replayed with the full rule set.
- **"2026 at 1 tick"** adds a tick of slippage a side where a book's defaults
  have none. That is the realistic cost, and the tables are sorted by it.
- **2026 is a short sample.** It holds only about 5.5 independent 30-day periods,
  so a 2026 rate is good to roughly ±30 points. All history (2,598 windows) is
  the steadier read.
- **"Reach payout"** is the funded stage at its default terms.

#### $3,000 eval — $3,000 target · $2,000 trailing drawdown · $1,000 daily loss limit

| strategy | bars | trades | PF | $/trade | pass, all | pass, 2026 | Jan–Mar · Apr–Jul | 2026 at 1 tick | reach payout |
|---|---|---|---|---|---|---|---|---|---|
| `macd_cross` | 5m | 38,348 | 0.971 | −$5.80 | 13.1% | 42.4% | 56.7 · 25.3 | 43.0% | 15.4% |
| `trend_neutev` | 5m | 11,036 | 1.006 | +$2.09 | 14.9% | 43.6% | 46.7 · 40.0 | 41.8% | 28.6% |
| `tpl_channel` | 5m | 12,894 | 1.003 | +$1.07 | 18.3% | 40.6% | 46.7 · 33.3 | 38.8% | 31.1% |
| **`donchian_shipped`** | 2m | 2,945 | **1.176** | **+$40.01** | 35.5% | 32.1% | 31.1 · 33.3 | 32.1% | **55.1%** |
| **`donchian_eff_rth`** | 2m | 5,590 | 1.079 | +$28.01 | **42.0%** | 31.5% | 33.3 · 29.3 | 29.7% | 51.7% |
| `momentum_roc` | 5m | 12,401 | 1.018 | +$7.76 | 21.3% | 26.7% | 6.7 · 50.7 | 26.7% | 27.1% |
| `macd_5m_quiet_anticipate`† | 5m | 7,589 | 1.047 | +$8.65 | 26.3% | 26.1% | 23.3 · 29.3 | 23.6% | 38.6% |
| `triple_ema` | 5m | 16,045 | 0.994 | −$1.79 | 14.8% | 24.8% | 7.8 · 45.3 | 23.6% | 26.0% |
| `prior_day_break` | 5m | 1,397 | 1.008 | +$3.27 | 15.5% | 22.4% | 13.3 · 33.3 | 22.4% | 38.0% |
| `tpl_ma_cross` | 5m | 22,260 | 0.977 | −$5.51 | 9.9% | 21.8% | 35.6 · 5.3 | 21.8% | 17.1% |
| `supertrend` | 5m | 12,361 | 0.969 | −$9.64 | 11.6% | 20.6% | 15.6 · 26.7 | 20.6% | 20.6% |
| `macd_1m_quiet_anticipate`† | 1m | 29,169 | 0.854 | −$12.00 | 10.3% | 27.9% | 35.6 · 18.7 | 20.6% | 18.9% |
| `trend_vol_adaptive` | 3m | 17,711 | 0.996 | −$0.76 | 5.1% | 20.0% | 14.4 · 26.7 | 19.4% | 22.3% |
| `macd_5m_anticipate`† | 5m | 22,092 | 0.939 | −$14.91 | 12.6% | 16.4% | 20.0 · 12.0 | 15.8% | 15.1% |
| `gap_fade` | 5m | 1,572 | 1.002 | +$0.53 | 15.2% | 13.9% | 16.7 · 10.7 | 13.9% | 54.6% |
| `session_range_fade` | 5m | 2,276 | 0.884 | −$47.94 | 14.1% | 13.3% | 23.3 · 1.3 | 13.3% | 34.6% |
| `adx_di_trend` | 5m | 25,961 | 0.920 | −$17.51 | 12.2% | 15.2% | 15.6 · 14.7 | 12.7% | 18.0% |
| `orb` | 5m | 2,240 | 1.034 | +$17.09 | 16.4% | 10.9% | 11.1 · 10.7 | 10.9% | 39.7% |
| `macd_angle_v4` | 2m | 42,810 | 0.941 | −$1.65 | 1.2% | 12.7% | 23.3 · 0.0 | 10.9% | 43.7% |
| `macd_mtf_confirm`† | 1m | 11,253 | 0.770 | −$9.76 | 2.8% | 20.6% | 24.4 · 16.0 | 10.3% | 24.6% |
| `vwap_fade` | 5m | 22,908 | 0.929 | −$18.87 | 10.2% | 9.7% | 17.8 · 0.0 | 9.1% | 10.9% |
| `macd_5m_flip`† | 5m | 38,350 | 0.975 | −$5.38 | 10.2% | 10.9% | 11.1 · 10.7 | 7.9% | 12.3% |
| `macd_1m_anticipate`† | 1m | 106,560 | 0.902 | −$11.14 | 3.7% | 10.9% | 18.9 · 1.3 | 7.9% | 2.6% |
| `ema_cross_macd_fade` | 1m | 22,224 | 0.806 | −$5.88 | 1.5% | 8.5% | 15.6 · 0.0 | 6.1% | 20.9% |
| `macd_5m_fade`† | 5m | 38,350 | 0.954 | −$7.99 | 10.4% | 5.5% | 8.9 · 1.3 | 3.6% | 12.0% |
| `tpl_consensus` | 2m | 45,500 | 0.942 | −$6.47 | 11.4% | 9.1% | 16.7 · 0.0 | 3.0% | 23.7% |
| `tpl_oscillator` | 5m | 14,393 | 0.918 | −$23.72 | 8.3% | 4.2% | 0.0 · 9.3 | 2.4% | 15.4% |
| `zscore_fade` | 5m | 770 | 0.833 | −$87.61 | 2.0% | 0.0% | 0.0 · 0.0 | 0.0% | 11.7% |
| `macd_1m_flip`† | 1m | 197,173 | 0.870 | −$12.65 | 1.7% | 0.0% | 0.0 · 0.0 | 0.0% | 2.9% |
| `macd_1m_fade`† | 1m | 197,173 | 0.847 | −$12.30 | 0.3% | 0.6% | 0.0 · 1.3 | 0.0% | 0.0% |

#### $1,250 eval — $1,250 target · $1,000 trailing drawdown · $600 daily loss limit

Trades, PF and $/trade are the same as above for every book except
`donchian_shipped`, the only one with its own $1,250 settings (4 lots, a −$300
breaker, a +$250 profit block). Every other book trades its $3,000 size.

| strategy | pass, all | pass, 2026 | Jan–Mar · Apr–Jul | 2026 at 1 tick | reach payout |
|---|---|---|---|---|---|
| **`donchian_shipped`** (4 lots) | **42.1%** | **44.2%** | 45.6 · 42.7 | **44.2%** | **56.3%** |
| `trend_neutev` | 15.4% | 30.3% | 36.7 · 22.7 | 30.9% | 20.9% |
| `donchian_eff_rth` | 36.8% | 31.5% | 33.3 · 29.3 | 29.7% | 35.1% |
| `momentum_roc` | 20.9% | 24.8% | 14.4 · 37.3 | 24.2% | 25.7% |
| `tpl_channel` | 20.1% | 26.1% | 31.1 · 20.0 | 24.2% | 24.3% |
| `macd_angle_v4` | 8.2% | 24.8% | 45.6 · 0.0 | 24.2% | 28.0% |
| `macd_cross` | 14.7% | 25.5% | 30.0 · 20.0 | 23.6% | 13.4% |
| `tpl_consensus` | 20.8% | 20.6% | 13.3 · 29.3 | 20.0% | 20.9% |
| `supertrend` | 13.6% | 19.4% | 12.2 · 28.0 | 19.4% | 19.1% |
| `triple_ema` | 16.1% | 18.2% | 10.0 · 28.0 | 18.2% | 21.7% |
| `ema_cross_macd_fade` | 5.3% | 32.1% | 58.9 · 0.0 | 17.6% | 10.9% |
| `gap_fade` | 25.8% | 17.0% | 18.9 · 14.7 | 17.0% | 32.0% |
| `macd_mtf_confirm`† | 5.8% | 21.8% | 26.7 · 16.0 | 17.0% | 11.7% |
| `prior_day_break` | 17.1% | 15.8% | 8.9 · 24.0 | 15.8% | 23.1% |
| `macd_1m_quiet_anticipate`† | 9.2% | 13.9% | 18.9 · 8.0 | 15.8% | 8.3% |
| `macd_5m_quiet_anticipate`† | 24.5% | 18.2% | 21.1 · 14.7 | 15.2% | 27.7% |
| `vwap_fade` | 16.1% | 13.3% | 24.4 · 0.0 | 13.3% | 14.0% |
| `tpl_ma_cross` | 14.4% | 12.7% | 21.1 · 2.7 | 12.7% | 16.9% |
| `orb` | 14.2% | 10.3% | 11.1 · 9.3 | 10.3% | 22.6% |
| `session_range_fade` | 16.4% | 8.5% | 14.4 · 1.3 | 8.5% | 20.9% |
| `trend_vol_adaptive` | 6.5% | 9.1% | 0.0 · 20.0 | 8.5% | 15.1% |
| `macd_5m_flip`† | 6.0% | 10.3% | 14.4 · 5.3 | 8.5% | 6.6% |
| `macd_5m_anticipate`† | 9.1% | 10.3% | 17.8 · 1.3 | 7.9% | 9.1% |
| `macd_1m_anticipate`† | 2.3% | 8.5% | 11.1 · 5.3 | 6.1% | 2.3% |
| `tpl_oscillator` | 11.2% | 4.8% | 0.0 · 10.7 | 4.8% | 13.4% |
| `adx_di_trend` | 13.0% | 7.9% | 14.4 · 0.0 | 4.2% | 18.6% |
| `macd_5m_fade`† | 6.3% | 3.0% | 4.4 · 1.3 | 1.8% | 6.6% |
| `zscore_fade` | 1.4% | 0.0% | 0.0 · 0.0 | 0.0% | 6.6% |
| `macd_1m_flip`† | 1.1% | 0.0% | 0.0 · 0.0 | 0.0% | 0.9% |
| `macd_1m_fade`† | 0.4% | 0.0% | 0.0 · 0.0 | 0.0% | 0.0% |

What the tables say:
- **The two Donchian books hold up everywhere.**
  - On all history they pass 42.0% (`donchian_eff_rth`) and 35.5%
    (`donchian_shipped`) of $3,000 combines. The next best is 26.3%.
  - They carry the strongest per-trade edges (PF 1.08 and 1.18), and two of the
    three best payout rates (51.7% and 55.1%; `gap_fade` reaches 54.6%).
  - At its own $1,250 settings, `donchian_shipped` is the best book on that eval:
    42.1% over all history, 44.2% in 2026.
- **A high 2026 rate is not an edge.** `macd_cross` passes 42.4% of 2026 windows
  but 13.1% over all history, with a profit factor under 1. `trend_neutev` and
  `tpl_channel` show the same pattern: 40–44% in 2026, 15–18% over all history,
  PF about 1.0.
- **Neither eval is easier across the board.**
  - The $1,250 target is less than half the $3,000 one, so on all history 19 of
    the 30 books pass it more often.
  - But its drawdown and daily limit shrink with the target, while every book but
    `donchian_shipped` keeps its 8–10 lot size. So in 2026, at a tick of slippage,
    17 of 30 pass it less often.
  - 26 of 30 reach a funded payout less often after it: the funded account keeps
    the $1,000 drawdown.
  - Set the size in the $1,250 tab before comparing books there.
- **The 1-minute MACD flips and fades need overnight holds.** Flat by 15:05 CT,
  they pass 0.3–1.7% of windows over all history.

Two caveats before reading too much into these tables:
- **The parameters are untuned defaults.** The point of the templates is that you
  tune them, and several books will look very different after a pass through the
  sliders.
- **A pass rate at defaults is not validation.** Use the MCP tools' `search`
  (in-sample only, with an out-of-sample check and PBO) and `walk_forward` before
  trusting a tuned number.

## Adding a strategy

Drop a file in `strategies/`, click **Reload strategies**. No registration.

`strategies/_TEMPLATE.mjs` is a working annotated example. The contract:

```js
export default {
  id: "my_strategy",
  name: "Shown in the dropdown",
  timeframeMin: 5,        // clock-aligned bars built from the 1-min source
  warmupBars: 400,        // history prefetched so left-edge indicators are correct

  // Each entry becomes a live slider in the sidebar.
  params: [
    { key: "lookback", label: "Lookback", type: "int", min: 5, max: 200, step: 1, default: 30, group: "Signal" },
  ],

  compute(bars, p) {
    return {
      sig,          // Int8Array: 1 long / -1 short / 0 flat
      atr,          // Float64Array driving stop/target width
      overlays: [], // optional lines; pane 'price' or 'sub'
    };
  },
};
```

**The one hard rule:** import only from `../src/*.mjs`. A `node:fs` import here
breaks the browser preview, because the browser loads this exact file.

Stops, targets, sizing, and costs are *not* per-strategy — they live in the
shared Execution panel so any strategy can be tested under any risk envelope.

---

## The rules being simulated

Modelled on `lib_challenge_v2.mjs` from the lite backtester, so pass rates are
comparable to that work. Everything is adjustable in the sidebar. The tabs at
the top of the sidebar switch between the two evaluations (`src/evals.mjs`):

| Rule | $3,000 eval | $1,250 eval | Behaviour |
|---|---|---|---|
| Profit target | $3,000 | $1,250 | Cumulative → PASS |
| Trailing drawdown | $2,000 | $1,000 | **The only hard fail.** Locks static at breakeven once the peak reaches it |
| Trails on | Daily closes | Daily closes | EOD trailing: an intraday spike given back before the close doesn't tighten your floor |
| Firm daily loss limit | $1,000 | $600 | **Soft lockout** — stop for the session, resume next day. Not a breach. A book that models the platform's liquidation (`dayLossStopUsd`) has it set to this too |
| Daily profit stop | $1,500 | $625 | Stop trading once the day is up half the target (consistency) |
| Your daily breaker | $150 | $150 | Your own tighter stop. The biggest pass-rate lever in this project's testing |
| Consistency cap | 50% | 50% | No single day may exceed this share of total profit |
| Contract cap | 20 | 20 | The firm's per-position limit |
| No overnight positions | on | on | Flat by **3:05 PM CT**, no re-entry until the **5:00 PM CT** reopen |

Switching tabs resets what the eval decides — these numbers, plus a strategy's
own settings for that eval (`evals` in its file; `donchian_shipped` trades 4 lots
with a −$300 breaker and a +$250 block on the $1,250 eval). Every other change
you made carries across, so the same idea can be compared on both. `E` switches
too.

### The no-overnight rule changes everything

Most funded accounts forbid holding through the close. This is enforced in the
engine (Session rules panel), and it is not a minor filter — it invalidates the
entire wide-reward:risk family of strategies this project has been built around:

| | overnight allowed | intraday-only |
|---|---|---|
| `trend_neutev` (6:1) | 73.1% pass | **14.9%** |
| `trend_vol_adaptive` (18:1) | 79.7% pass | **5.1%** |

The reason is a timing asymmetry that the rule attacks directly. With overnight
holds allowed, the incumbent's **winners take a median 6.4 hours** (90th
percentile 17.9h) while its **losers resolve in a median 1.0 hour** — a tight
2×ATR stop is hit quickly, but a 12×ATR target needs most of a day to develop.

So a 3:05 PM CT deadline truncates **36.7% of winners but only 5.2% of losers**,
and **$1.73M of the $4.03M gross profit sits in exactly those truncated winners**.
The rule removes ~43% of gross profit and leaves the losses untouched.
(Re-measured 2026-10-27 by `research/readme_figures.mjs`, as are the reference
strategy's and the funded stage's figures.)

**If your account has this rule, both shipped strategies are unusable as tuned.**
A viable intraday book needs a reward:risk that can resolve inside the hours
actually available, not 6:1 or 18:1 — see `research/intraday_only.mjs`.

Two deliberate deviations from `lib_challenge_v2`, both toward realism:

1. **Window membership is by entry time.** You start a combine flat, so a trade
   opened before day 1 can't count. (v2 filtered on exit time.) Affects at most
   one trade per window.
2. **`Breach measured on: Open equity`** checks each trade's worst excursion
   (MAE), not just its realised close — real firms breach on live equity. Because
   we can't know whether MFE or MAE printed first inside a trade, the peak is
   ratcheted *before* the breach test: the pessimistic ordering. Default is
   `Realised P&L only`, which matches v2.

### Commission

Defaults to **$0.75/side/contract** (= $12 round trip on 8 lots), which is what a
broker actually charges. Legacy lite_backtester runs used a **flat $5/trade**,
understating cost by 2–3× at 8–10 lots. Switch the model in the Execution panel if
you're reconciling against those numbers. Total commission paid is shown in the
stats so it's never invisible.

---

## Data pipeline

`prepare.mjs` turns the Databento CSV batches into `data/mnq_1m.bin`:

- **Multiple source files merged.** Databento delivers overlapping batches; list
  them all and they are combined into one series, deduplicated on
  (timestamp, symbol) by a linear merge of the sorted runs. Overlapping rows are
  compared field-by-field and the build **aborts** if any disagree, rather than
  silently picking a winner. Across the current two files, 2,624,027 overlapping
  rows agreed exactly.
- Parsed straight from a `Buffer` — no giant intermediate string, no per-row objects
- Calendar-spread rows (`MNQU1-MNQZ1`) dropped
- Dominant contract per day chosen by volume → single continuous front-month
- Panama Canal back-adjustment removes the rollover jump (a fake 120pt gap is
  exactly the kind of artifact that manufactures a phantom edge)
- CME trading-day index (17:00 ET, DST-aware) precomputed per bar

Result: **2,534,706 bars**, 2019-05-05 → 2026-07-14 — MNQ's entire history, since
the contract launched in May 2019.

```bash
node prepare.mjs                       # uses the default source list
node prepare.mjs --in a.csv --in b.csv # or name them explicitly
```

> Early MNQ is complete but thin: 2019 averages 1,335 bars/session (the same
> coverage as today) at **137 contracts/bar versus 1,148 in 2025**. The bars are
> real and the session coverage is full, but fills in 2019 would have been harder
> than the backtest's slippage setting assumes.

### How the roll spread is measured (this part is subtle)

The obvious way to size a rollover gap — *(first bar of the new contract)* minus
*(last bar of the old one)* — is wrong, and wrong in a way that hides itself.
It measures the contract spread **plus whatever the market moved in between**.

That is harmless when the handover lands mid-session (one minute apart), but
**4 of the 20 MNQ rolls land at the Sunday 22:00 UTC reopen**, where "in between"
is a 49-hour weekend. Adjusting by that combined number removes the spread *and
erases a real weekend move from history*:

| Roll | Naive gap | True spread | Move erased |
|---|---|---|---|
| 2026-06-14 (Sun) | 654pt | **294.75pt** | 359pt |
| 2022-06-12 (Sun) | −118pt | **+28.75pt** | −147pt (*wrong sign*) |
| 2022-03-13 (Sun) | 43.25pt | **−4.5pt** | 48pt |

So the spread is measured from **both contracts quoted at the same minute**,
which has no time-passage component at all. Every roll has 6,000–9,000
overlapping bars available, and all 20 are measured at the exact handover minute.
294.75pt is textbook cost-of-carry at 29,888 with ~4% rates; 654pt was not.

`verify_rolls.mjs` proves the result independently: across every seam, the move
the continuous series shows is confirmed by the **incoming** contract to within
6.25pt worst case (typically <1pt). The residual moves are real market moves,
correctly preserved rather than adjusted away.

> Both halves of this were bugs at some point. The first build reported a
> 233,233,920-point seam — gaps were measured against already-adjusted prices,
> compounding at every rollover. Silently wrong data is the worst failure mode
> here, which is why `prepare.mjs` verifies its own output and why `audit.mjs`
> exists at all.

Practical impact of the same-minute fix on the reference strategy: pass rate
75.6% → 75.7%, net P&L $15,319 → $18,157. Small, because it touches one bar at
4 of 20 rolls — but it is the difference between a series that reflects what
happened and one that doesn't.

---

## Verification

```bash
npm run check          # test.mjs, audit.mjs, legacy parity, the MCP server, the chart link
npm run verify-rolls   # seam coherence against the incoming contract
FUZZ_SEED=7 FUZZ_SCALE=3 node test.mjs   # the randomised invariants, harder
```

**`test/legacy_parity.mjs`** holds the research libraries' adapters to frozen
oracles of their pre-consolidation results. **`test/mcp.test.mjs`** drives the MCP
server over stdio and checks each tool against `src/` directly.
**`test/chart_link.test.mjs`** covers the page ↔ server link.

**`test.mjs` — 261 tests, all passing.** The approach is to test optimised code
against a naive reference that is obviously correct, and rule logic against
numbers hand-traced on paper:

- Indicator studies:
  - every study's reading on the signal bars is unchanged when later bars are
    cut away (no lookahead);
  - the 15-minute bar a 2-minute signal at 10:04 reads is traced by hand;
  - VWAP, the day levels and the opening range match a naive recomputation;
  - a gate refuses entries only;
  - the live window matches the sweep with random gates on random timeframes.
- Evaluations: the $3,000 eval leaves every strategy's defaults exactly as they
  were, and the $1,250 eval layers the firm's numbers, the platform cap and a
  strategy's own settings in order.

- Indicators cross-checked against independent implementations — the O(n)
  Donchian deque against O(n·p) brute force at 5 periods × 400 bars, ADX against
  a from-scratch reimplementation, rolling stats against literal window means.
- Engine invariants: entry fills at the *open* of the bar after the signal;
  bar *i*'s own high/low provably cannot change whether it was entered;
  stop-before-target inside one bar; gap-through-stop fills at the open; flip
  closes and re-enters same-bar; P&L, fees, slippage, and MAE/MFE arithmetic.
- Rules traced by hand: floor trailing, the breakeven lock, `<=` boundary
  behaviour, soft lockouts that skip trades without failing, consistency, EOD vs
  intraday trailing, and `sweepWindows` agreeing with `replayWindow` at every
  start it reports.
- Real data: the final contract piece matches the source CSV **exactly** across
  20,000 bars (it takes zero adjustment, so any parse or pack error would show);
  prices stay on the 0.25 tick grid; resampling conserves volume and true
  extremes.

**`audit.mjs` — data artifact sweep.** OHLC integrity, timestamp ordering and
duplicates, rollover seams, the largest jumps classified session-gap vs
intra-session, tick-grid adherence, and volume sanity. Current verdict: *no
artifacts found*.

**Chart rendering** (browser console, `window.lab`): trade markers land on the
exact bar of their entry time (0ms offset over 123 trades); pixel-column
bucketing preserves the true high and low exactly; indicator overlays align to
their own timeframe bucket (0 misaligned of 6,877); skipped trades are excluded
from the equity curve.

**Browser/server equivalence:** 12 randomised configs — timeframes 1/3/5/15m,
ADX 10–42, 1–10 contracts, both trailing modes, window starts across 4 years,
trade counts from 2 to 144 — produced **identical** outcome, net P&L, and trade
count from the in-page preview and the server's independent full-history sweep.

### Two things the data legitimately contains

Neither is a defect, both will look like one if you don't expect them:

1. **3,752 moves over 40pt inside a single 1-minute bar.** Real — they cluster on
   CPI and FOMC print times. The largest, 438.5pt, is 2025-04-09 17:19 UTC.
2. **No bar exists at 17:00 ET.** CME halts 17:00–18:00 ET daily, so the first
   bar of every session is 18:00 ET — verified across 600/600 boundaries, holding
   through both EDT and EST.

---

## Reference strategy

`strategies/trend_neutev.mjs` — the shipped neutral-EV trend book from
`CHALLENGE_STRATEGY_SPEC.md`: 5-min Donchian-30 breakout, ADX ≥ 25, 2×ATR stop,
12×ATR target (6:1), 8 contracts.

With overnight holds allowed, as its spec has it, across **2,598 windows / 7.2
years**: **73.1% pass**, 19.6% breach, 7.3% unresolved, median 13 days to pass.
The spec documents ~73%, and that agreement holds over 2.2 years the strategy
was never tuned on. (Flat by 3:05 PM CT, it passes 14.9% — see above.)

Its per-trade edge over the full history is **profit factor 1.012, +$4.66/trade**
— about zero, as the spec's ~1.01 says. This book is explicitly a neutral-EV
design: it passes because of the challenge *structure* (short window,
stop-on-pass, lenient EOD trailing, tight breaker), not because of an edge. Set
ADX minimum to 32 for the positive-EV variant.

**The 5-year figure was optimistic.** From 2021-07 alone the same config passes
77.1% and nets +$79,121; MNQ's first two years (−$30,930) take it to 73.1% and
+$48,191. More history did not flatter it, which is the point of having it.

Pass rate by year — the widest spread in the project, and the strongest argument
that regime dominates everything else:

| 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|
| 46.5% | 64.8% | **90.1%** | 71.0% | 73.2% | 86.9% | 76.7% | 58.8% |

(2019 and 2026 are partial years. Re-measured 2026-10-27 on the current engine.)

One mechanic the tool surfaces that's easy to miss: median net per passing window
is ~$7,200, not ~$3,000. The consistency rule is why. A single 12×ATR winner on 8
lots is ~$3,300, which is more than 50% of a $3,000 target — so hitting the target
on one big day doesn't pass, and you must keep grinding until the best day is
diluted to half the total. The daily profit stop can't prevent this, since it only
blocks *new* entries and a single trade can blow straight through it.

---

## Keyboard

| Key | Action |
|---|---|
| `←` / `→` | Step window ±1 day |
| `Shift` + `←`/`→` | Step ±7 days |
| `e` | Switch evaluation ($3,000 ↔ $1,250) |
| `r` | Reset zoom |
| Wheel / drag | Zoom / pan |
| Double-click | Fit window |

The full sweep runs on demand (**Run full sweep**); after the first run it
re-sweeps automatically ~700ms after you stop adjusting parameters.

### Panels and links

- **Trades in this window** lists every signal, including those a rule blocked.
  Click one to zoom the chart to it; **CSV** downloads the list.
- **All windows** shows the pass rate with a 95% interval. The interval counts one
  independent sample per 30 days of start dates, because neighbouring windows
  share most of their days. It also shows the 2026 check (all of 2026, then
  Jan–Mar against Apr–Jul), and **CSV** downloads every window's result.
- **P&L by hour and weekday** shows where the profit comes from, over all of
  history and over 2026.
- **Indicators** and **Indicator edge**: see "Indicators beside the strategy".
  Your indicators are remembered between visits.
- **The evaluation tabs** sit above the strategy picker; the tab you used last is
  remembered too.
- **The address bar** carries the strategy, the window, the evaluation, the
  indicators and every setting changed from the strategy's defaults, so a link
  brings the exact view back.

---

## Research through Claude (MCP)

`mcp/server.mjs` exposes the engine as MCP tools, registered for this folder in
`.mcp.json`. Claude Code offers to enable it when a session opens here:

- **Research:** `backtest`, `pass_rate`, `compare`, `search`, `walk_forward`,
  `sensitivity`, `window`.
- **Evaluations and indicators:** every configuration takes `eval` (`"3000"` or
  `"1250"`) and `studies` (`list_studies` gives the catalogue). `backtest`
  reports each study's edge by state. `search`, `walk_forward` and `sensitivity`
  can vary a study's settings, e.g. `studies.0.params.lo` or `studies.0.tf`, so an
  indicator combination gets the same in-sample / out-of-sample treatment as
  anything else.
- **The chart:** `chart_state` reads what the open page shows; `chart_apply`
  changes it, including the eval tab and the indicators.
- **The papers library:** `papers`.

Every tool runs `src/`, so its numbers are the chart's numbers. `CLAUDE.md` holds
the house rules for reporting them.
