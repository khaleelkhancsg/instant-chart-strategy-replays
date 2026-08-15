# MNQ Donchian + Efficiency-Gate — live bot

Python port of `strategies/donchian_eff_rth.mjs` for TopstepX / ProjectX REST.
The strategy itself, and how it was arrived at, is in
[`../STRATEGY_SPEC_donchian_eff_rth.md`](../STRATEGY_SPEC_donchian_eff_rth.md).

| | |
|---|---|
| `mnq_donchian_bot.py` | the bot |
| `test_donchian_parity.py` | 108 checks that the port matches the JS engine |
| `fixture_donchian.json` | golden output from that engine (25 days, 39 trades) |
| `run_donchian_bot.bat` | launcher — runs the parity checks first, refuses to start if they fail |

## Setup

```bash
pip install httpx python-dotenv
```

Create `bot/.env` (gitignored — never put the key in the `.bat`):

```
PROJECT_X_USERNAME=your_username
PROJECT_X_API_KEY=your_api_key
```

Then edit `CONFIG` at the top of `mnq_donchian_bot.py`:

- `contract_id` — must be the current front month, **update on every roll**
- `live_account` — `False` for sim, `True` for a real evaluation
- `dry_run` — ships `True`. Run one full session paper-only first.

## Before you arm it

**A hard -$1,000 stop on unrealised daily P&L is assumed to be in force.** The
bot does not enforce it — the platform does, and it will close positions out from
under the bot. Everything below is measured with it on.

It is expensive. Same config, only the cap toggled:

| hard stop | high-vol | 2026 | all windows | pf | net |
|---|---|---|---|---|---|
| **−$1,000 ON** | **41.3%** | 38.2% | 30.4% | 1.077 | $90,247 |
| OFF | 50.6% | 41.2% | 35.5% | 1.033 | $53,297 |

**9.3 points** in the high-volatility regime and 5.1 across all history — it costs
more in volatile markets because that is where it binds hardest. It does buy
something back: profit factor 1.033 → 1.077 and net $53,297 → $90,247, because it
removes the worst tail. If it is ever negotiable, turning it off is worth ~9pp.

**Turn off the platform's unrealised *profit* stop.** That is a different setting
and it is not free either: a $1,000 hard profit stop takes the book from pf 1.020
to 0.851 and from +$38k to −$215k. The bot warns at startup until you set
`platform_hard_profit_stop_disabled=True`.

| | pass | pf | net |
|---|---|---|---|
| **8 lots, high-vol regime (772 windows)** | **41.3%** | 1.077 | +$90,247 |
|   early half / late half | 41.5% / 41.2% | | |
| 8 lots, 2026 only (~6 independent windows) | 38.2% | | |
| 8 lots, all 2,598 windows 2019–2026 | 30.4% | | |
| 10 lots, all windows, same rules and cap | 29.9% | 1.044 | |

### Why 8 contracts

The all-history sweep picks 10, but it averages 2019 (median 2-min ATR 4.8) with
2026 (23.7) — not a market anyone trades. Conditioning on the current
high-volatility regime and validating on the **later half** of it, 8 lots scores
41.5% against 10 lots' 35.0%.

Re-checked under the 1-lot first tranche, because the split changes the answer:
8 lots splits 48.3 / 49.1 across the two halves against 10 lots' 47.3 / 51.0, so
**8 still wins on the worse half** — 48.3 vs 47.3 — and on 2026, 60.6 vs 57.0.
10 lots now edges it on the all-history *average* by 0.3pp, which is inside noise
and is the exact criterion this file warns against ranking on.

Going smaller does **not** keep helping: 4 lots scores 34.5% and 2 lots 10.9%,
because throughput collapses against a fixed $3,000 target on a deadline. 8 is a
measured optimum, not a compromise.

### Why 5×ATR / 1.75×ATR

The cap pins the stop at 62.5 points on every trade above ATR 12.5, and 2026's
median is 23.7 — so in this regime `sl_atr_mult` is close to a dead parameter and
the **target is the only geometry lever still live**.

1.75 is pass-rate neutral against the old 1.5 (41.2% vs 41.5% on the worse half,
inside the noise) and materially more profitable: pf 1.055 → 1.077, net $62,024
→ $90,247 over 4,463 trades. It also holds up better on 2026, 38.2% vs 30.9%.

**Do not tighten to 1.25** because it ranks higher on the worse half (43.3%): it
scores 21.8% on 2026, i.e. it is fitted to the pre-2026 stretch. Same trap as
3.5/2.5, which scored best on the *average* (44.8%) while splitting 53.9% early
against 35.8% late. Rank on the worse half and check the recent slice; never on
the average.

## Scale-in (new)

The bot no longer takes all 8 lots at the signal. It takes **1**, and rests a
**stop order for the remaining 7** at entry + 0.15×ATR, cancelled if unfilled
after 10 bars.

| | all history | 12 months | 2026 | pf |
|---|---|---|---|---|
| all 8 at the signal | 30.8% | 37.9% | 40.0% | 1.092 |
| 2 + 6 @ 0.15×ATR | 37.7% | 45.7% | 49.1% | 1.143 |
| **1 + 7 @ 0.15×ATR (ships)** | **+2.5pp on that** | | | **1.332** |

**The first tranche is ONE lot, not two.** The sweep is monotone — 1 > 2 > 3 > 4
> 6 — and 1 is the boundary, so nothing is fitted; you cannot hold less than a
contract. It follows directly from the one-bar deferral below: if the edge is in
not committing size before confirmation, commit as little as possible until it
arrives. Average size barely moves (7.06 vs 7.21 lots) because confirmed trades
still reach 8 either way — what changes is that the ~13% which never confirm now
risk one lot instead of two.

| slice | 1+7 minus 2+6 | 95% band | P(better) |
|---|---|---|---|
| early half | +3.24pp | 1.0 .. 4.6 | 100% |
| late half | +1.70pp | 0.4 .. 3.4 | 98% |
| last 12m | +4.56pp | 2.8 .. 6.4 | 100% |
| 2026 | +4.17pp | 2.4 .. 6.2 | 100% |
| **all history** | **+2.53pp** | 0.4 .. 4.4 | 100% |

On the real engine: pf 1.286 → **1.332**, net $271k → **$299k**, all-history pass
46.2% → **48.7%**. It wins at all six add-window settings tested (4/6/10/15/20/30
bars), which is the robustness test that killed the volume filter.

**Confirmation does NOT compound.** Two adds and three adds were tested at every
sensible split and trigger — 2+3+3, 2+2+4, 2+4+2, 1+3+4, a four-rung ladder — and
every one loses, −3.2pp to −7.5pp. Each extra tranche buys its confirmation with a
worse average entry while the dollar cap tightens as size grows, so the last
tranche arrives at the worst price with the least room. One round of
confirmation is all this book supports.

Both rows are measured with the **full rule set on** — $3,000 target, $2,000
trailing drawdown, the **50% consistency rule**, and the **−$1,000 hard cap**.
Not hypothetical: 14% of base trades and 10% of scale-in trades exit via the cap.
Consistency is barely binding here (30.8% → 31.1% with it off) because the $750
profit block already keeps days small.

**The gain is a property of the capped account, not of the strategy.** Toggling
only the cap:

| | cap −$1,000 | cap OFF |
|---|---|---|
| all 8 at the signal | 30.8% / 37.9% | **35.5% / 46.9%** |
| 2 + 6 @ 0.15×ATR | **37.7% / 45.7%** | 34.1% / 42.1% |

Uncapped, scale-in is *worse* — −1.4pp all-history and −4.8pp on 12 months. The
reason is that the cap is a dollar limit, so its distance in points scales with
size: at 2 lots it sits 250 points away and the designed 5×ATR stop governs; at 8
it pulls in to 62.5. Starting small therefore buys a genuinely wide stop while
little is at risk, then accepts a tight one once the trade has proven itself.
Remove the cap and that asymmetry disappears, leaving only the confirmed trades
carrying a full-size 5×ATR stop — far too much against a $2,000 drawdown.

**So do not carry this to an uncapped account.** If the cap is ever lifted, plain
8-at-the-signal is the better book and this section stops applying.

It is **not** better averaging — the add fills *worse* than the signal. It's a
soft stop: ~15% of trades never move even a quarter-ATR the right way, and those
average **−$278** each, so only a quarter of the position ever meets them. Adding
on a *dip* instead tests clearly worse; a breakout that retraces is the one that
failed.

**Why a stop and not a limit.** The add is a buy *above* the market, so it can
only be a stop. A stop-limit would cap the price but miss exactly when price runs
fastest through the level — the adds most worth having. Slippage is the
affordable cost: break-even is **8 ticks** of extra slippage on the add, and a
plain stop should cost 1–3.

**The add is placed one bar AFTER entry, and that delay is the entire edge.**
A 2-minute bar's range is roughly one ATR, so a 0.15×ATR trigger gets touched
somewhere inside the *entry bar itself* for **81%** of signals — almost
mechanically, carrying no information. Resting the order immediately therefore
adds to nearly everything, including the breakouts that spiked and died, which is
the exact population scale-in exists to stay small in.

| when the add may fill | add rate | avg lots | pf | pass |
|---|---|---|---|---|
| entry bar | 95% | 7.67 | 1.116 | 31.8% |
| **one bar later (shipped)** | 87% | 7.21 | **1.338** | **46.5%** |
| +2 bars | 72% | 6.33 | 1.298 | 43.9% |
| +5 bars | 47% | 4.82 | 1.272 | 38.2% |
| no scale-in at all | — | 8.00 | 1.128 | 30.9% |

Adding from the entry bar is **worse than not scaling in at all**. One bar is the
shortest delay that tests anything; longer delays decay smoothly because they
start costing size on the winners. It survives slippage on the add (+1 tick
−0.9pp, +2 ticks −1.5pp). The bot originally sent the add immediately — within
seconds of the entry fill — which put it on the wrong side of this by 15pp.
Measurement in [`../research/samebar_add.mjs`](../research/samebar_add.mjs).

**The one dangerous failure mode.** A resting add that outlives its position will
open a fresh, unmanaged position on the next touch. Every exit path routes through
`_cancel_add()` — position closed, flatten window, flip, window expiry — and the
harness tests each. If a cancel ever fails the bot logs it at ERROR with an
instruction to check the platform; that message means go and look.

Both tranches carry their own bracket, with the add's tick offsets chosen so its
stop and target land on the *same absolute prices* as the first tranche's.

**The first tranche's stop is sized against the first tranche.** The cap is a
dollar limit, so 2 lots reach it 250 points out, not the 62.5 that 8 lots imply.
Sizing that bracket against the configured total — which the bot did until this
was caught — puts a stop 2.2× too tight on the one tranche meant to ride widest,
and it would stop out of trades the backtest holds to target. Eleven checks pin
the cap distance at 1, 2, 4 and 8 lots; reintroducing the bug fails nine of them.

## Verifying the port


```bash
node ../research/export_bot_fixture.mjs   # regenerate the fixture
python test_donchian_parity.py            # 108 checks
```

The harness asserts the Python reproduces the JS **stage by stage** — 2-minute
aggregation, ATR/ADX/efficiency/Donchian, raw signals, the gate, then a full
trade replay — so a failure names the stage that broke. Section 9 drives
`_evaluate()` itself against a scripted broker, because correct maths does not
stop the trading path from entering after the cutoff or stacking positions.

Both were mutation-tested. 19 of 20 deliberate defects were caught; the survivor
(removing the cooldown) is inert at `cooldown_bars=1` by arithmetic, not by
oversight. **Re-run the harness after any edit to the maths or the decision
path** — that is what the launcher does automatically.

## What it does, briefly

2-minute clock-aligned bars. Donchian-30 breakout (channel excludes the current
bar), ADX(14) ≥ 25, and Kaufman efficiency(20) > 0.5, taken only between 08:30
and 15:00 CT. **8 contracts** (1 at the signal, 7 added on follow-through), 5×ATR stop and 1.75×ATR target — the inverted
geometry is deliberate and is what makes trades resolve before the flatten.
Flips on an opposite signal. Flat by 15:04 CT against a firm 15:05 deadline.

Two daily rules, both **entry blocks on realised P&L that never close a
position**: a +$750 profit block and a −$500 circuit breaker. Both were retuned
for the capped regime — with the platform bounding the day at −$1,000 anyway, the
old −$150 breaker just ended days early. Worth +1.6pp. Day rolls at 17:00 ET.

## A high win rate is not evidence it is working

A 5×ATR stop against a 1.75×ATR target wins **5/6.75 = 74.1% on a pure coin
flip**, and resolves in a·b/σ² = 45 minutes. Those are exact results for a driftless
random walk. The backtested book lands right on that — so the two statistics
you will watch every session are what the *bracket* dictates, and carry no
information about edge.

A losing week at a 74% win rate is the expected shape of this book, not a
malfunction. **Judge it on dollars per day, never on win rate.**

A 10,000-window Monte Carlo ([`../research/monte_carlo.mjs`](../research/monte_carlo.mjs))
that simulates prices instead of replaying the book puts the **zero-edge pass rate
at 30.1%** for the uncapped 10-lot configuration. Most of a headline pass rate is
rules and geometry, not edge. That null has not been re-run for this
configuration, but the principle carries: if the edge is even partly overfit,
expect something much nearer the null than the headline.

## Volatility drives the pass rate more than anything else

Measured on every window, real engine, by volatility decile:

| decile | window ATR | pass | stop | reward | ratio |
|---|---|---|---|---|---|
| 1 | 2.4–6.2 | 14.7% | $357 | $125 | 2.86:1 |
| 4 | 10.9–12.1 | 31.5% | $925 | $324 | 2.86:1 |
| 7 | 14.3–15.6 | 30.8% | $1,000 | $416 | 2.40:1 |
| **9** | **18.3–21.9** | **50.0%** | $1,000 | $563 | 1.78:1 |
| 10 | 21.9–36.3 | 45.4% | $1,000 | $699 | 1.43:1 |

Bottom five deciles average 24.5%, top five 36.3% — an **11.8pp** spread, and
35pp between the extremes. The stop:target ratio *falls* from 2.86:1 to 1.43:1
as volatility rises, which looks alarming, but the pass rate goes the other way:
above ATR 12.5 the cap fixes risk at $1,000 while reward keeps scaling, so a
volatile window simply pays more for the same risk. Against a fixed $3,000 target
on a deadline, that is what matters. Quiet markets fail because the trades are
too small to get there.

This is the single largest determinant of whether an evaluation passes — larger
than any parameter in the config. Check the regime before starting one.

## Sizing: how this got to 8, so it is not re-litigated

The Monte Carlo found a cliff wherever one stop-out exceeds the $2,000 trailing
drawdown, on both the ATR and the contracts lever. Tested on the real book as
`sizingMode: 'risk'` it **lost** — 38.6% at $1,900 of risk against 41.0% flat —
because the model has no jumps and real stops get gapped *through* rather than
touched. **Dollar-risk sizing is dead.**

What was not dead was the underlying point, once the regime was separated from
the 8-year average: a *fixed* smaller size chosen for current volatility does
win. That is the difference between sizing every trade to a risk budget (dead)
and picking one size that suits the regime (8 lots).

## Things worth knowing before running it

- **Commission is a large share of gross profit.** Check your real fills first;
  at double commission the book does not survive.
- **One loss ends the day.** A capped loss is ~$1,000 against a −$500 breaker,
  so one loser closes the session. Intended, and priced in.
- **Tail risk on the book actually traded is bounded, but that is a modelling
  assumption, not a guarantee.** An earlier draft of this file said 50 trades
  lose more than the $2,000 trailing drawdown, worst −$8,782. That was computed
  on the RAW engine output, which contains trades the daily blocks prevent — the
  engine has no profit block, so it keeps trading days that stopped at +$750.
  Recomputed on the book that is actually traded: **no trade loses more than
  $2,000 and no day finishes below −$1,011**, in either cap mode (exact
  −$1,726 worst trade / −$1,011 worst day; price −$1,742 / −$1,038). A
  −$1,726 trade is not $1,726 of risk: it is a day that was up $700 being cut
  to −$1,000, which is the cap working. What remains is that a real limit move
  or halt would break the assumption that the platform can always liquidate near
  the cap, and no such event is in this dataset. Neither daily rule would help:
  both are entry blocks and neither can touch a trade already running.
- **Slippage.** The bot logs realised entry slippage every fill and warns past 3
  ticks of mean absolute deviation — judge on `|avg|`, not the signed number. The
  Monte Carlo puts 3 ticks per side *at* the zero-edge null, and the metric runs
  about a tick hot because it measures against the signal bar's close and so
  includes crossing the spread.
- **Quiet regimes are where this book dies, not volatile ones.** 2019 scores 8%
  at a median ATR of 4.8. This configuration is tuned for ATR around 20–24; if
  volatility collapses back toward 2019–2021 levels, re-run
  [`../research/regime_sizing.mjs`](../research/regime_sizing.mjs) before starting
  an evaluation, because the right size moves with the regime.
- **40%+ needs the current regime.** Across all 2,598 windows this scores 30.4%.
  The ~41% is high-volatility windows specifically. Do not quote the two
  interchangeably.

## Differences from the backtest, and why

| | backtest | bot |
|---|---|---|
| flatten | first 2-min bar opening at/after 15:05 CT, i.e. 15:06 | 15:04 wall clock |
| flip | checks bar `i`'s high/low for a bracket hit *before* reversing | reverses at the bar open, since bar `i` has not happened yet |
| fills | bar open, zero slippage | market order, slippage measured and logged |

The flatten difference is conservative — it puts the fill inside the firm
deadline at a cost of at most two minutes of one trade. The flip difference is
unavoidable and, if anything, more honest than the backtest: the backtest peeks
at a bar that has not printed yet when it decides not to flip.
