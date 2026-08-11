# MNQ Donchian + Efficiency-Gate — live bot

Python port of `strategies/donchian_eff_rth.mjs` for TopstepX / ProjectX REST.
The strategy itself, and how it was arrived at, is in
[`../STRATEGY_SPEC_donchian_eff_rth.md`](../STRATEGY_SPEC_donchian_eff_rth.md).

| | |
|---|---|
| `mnq_donchian_bot.py` | the bot |
| `test_donchian_parity.py` | 80 checks that the port matches the JS engine |
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
under the bot. It costs about 6 points of pass rate, because capping the loss in
*dollars* silently tightens the 5×ATR bracket the book depends on. Everything
below is measured with it on.

**Turn off the platform's unrealised *profit* stop.** That is a different setting
and it is not free either: a $1,000 hard profit stop takes the book from pf 1.020
to 0.851 and from +$38k to −$215k. The bot warns at startup until you set
`platform_hard_profit_stop_disabled=True`.

| | pass | pf | net |
|---|---|---|---|
| **8 lots, high-vol regime — early half / late half** | **41.5% / 41.2%** | 1.077 | +$90,247 |
| 8 lots, 2026 only (~6 independent windows) | 38.2% | | |
| 8 lots, all 2,598 windows 2019–2026 | 30.5% | | |
| 10 lots, all windows, same rules and cap | 29.9% | 1.044 | |

### Why 8 contracts

The all-history sweep picks 10, but it averages 2019 (median 2-min ATR 4.8) with
2026 (23.7) — not a market anyone trades. Conditioning on the current
high-volatility regime and validating on the **later half** of it, 8 lots scores
41.5% against 10 lots' 35.0%, and wins head-to-head on all history too.

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

## Verifying the port

```bash
node ../research/export_bot_fixture.mjs   # regenerate the fixture
python test_donchian_parity.py            # 80 checks
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
and 15:00 CT. **8 contracts**, 5×ATR stop and 1.75×ATR target — the inverted
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
- **A trade can still end the account, cap or no cap.** 50 trades in the book
  lose more than the entire $2,000 trailing drawdown, worst −$8,782, because the
  platform stop only fires on a price it is shown and a gap jumps it. The cap
  cuts these from 297 to 50 — a large improvement, not immunity. Neither daily
  rule helps: both are entry blocks and neither can touch a trade already
  running.
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
- **40%+ needs the current regime.** Across all 2,598 windows this scores 30.5%.
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
