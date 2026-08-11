# MNQ Donchian + Efficiency-Gate — live bot

Python port of `strategies/donchian_eff_rth.mjs` for TopstepX / ProjectX REST.
The strategy itself, and how it was arrived at, is in
[`../STRATEGY_SPEC_donchian_eff_rth.md`](../STRATEGY_SPEC_donchian_eff_rth.md).

| | |
|---|---|
| `mnq_donchian_bot.py` | the bot |
| `test_donchian_parity.py` | 79 checks that the port matches the JS engine |
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

**Turn off the platform's $1,500 unrealised profit stop.** That hard cap and the
`+$1,000` soft block this bot enforces are different mechanisms and want opposite
values. Measured at one tick of slippage:

| | pass | profit factor | net |
|---|---|---|---|
| hard $1500 + soft $1000, 9 lots | 42.3% | 0.964 | −$52,778 |
| **hard off + soft $1000, 10 lots** | **41.0%** | **1.047** | **+$91,640** |

1.3pp of pass rate for the difference between making $91,640 and losing $52,778.
The bot warns at startup until you set `platform_hard_profit_stop_disabled=True`,
which is a note to yourself, not a control — it changes nothing in the platform.

## Verifying the port

```bash
node ../research/export_bot_fixture.mjs   # regenerate the fixture
python test_donchian_parity.py            # 79 checks
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
and 15:00 CT. 10 contracts, 5×ATR stop and 1.5×ATR target — the inverted
geometry is deliberate and is what makes trades resolve before the flatten.
Flips on an opposite signal. Flat by 15:04 CT against a firm 15:05 deadline.

Two daily rules, both **entry blocks on realised P&L that never close a
position**: +$1,000 profit block (the single largest lever in the configuration,
worth 26.7% → 41.0%) and a −$150 circuit breaker. Day rolls at 17:00 ET.

## Things worth knowing before running it

- **Commission is 47% of gross profit.** At double commission the book is
  unprofitable. Check your real fills first.
- **One loss ends the day.** A 5×ATR stop on 10 lots risks $1,000–$3,000 against
  a $150 breaker. Intended, and priced into the 42.6%.
- **The headline assumed zero slippage.** One tick per side is ≈$150 per combine
  and ≈2.5pp. The bot logs realised entry slippage every fill and warns past 4
  ticks of mean absolute deviation — judge on `|avg|`, not the signed number.
- **42.6% is not 70%.** Under a no-overnight rule nothing in ~2.2 billion window
  simulations reached 70%. The flatten, not the strategy, is the constraint.

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
