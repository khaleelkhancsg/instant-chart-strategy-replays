# MNQ Donchian, $1,250-target evaluation: TopstepX bot

The Donchian setup researched for an evaluation with a $1,250 profit target, a $1,000 trailing drawdown, a $600 daily loss limit and a 50% consistency rule, running on TopstepX through the ProjectX Gateway API.

On 2026 data, with honest fills, 1 tick of slippage and $0.75 a side, it passed **71.1%** of 21-day evaluations (Jan–Mar 74.3%, Apr–Jul 75.1%) and 74.8% of real calendar windows. That figure comes from `research/rules_1250_2026.mjs` and `research/donchian_ema_age_2026.mjs`. It is the same strategy as `tradovate/mnqDonchian1250.js`.

| File | What it is |
|---|---|
| `mnq_donchian1250_bot.py` | The bot: the ProjectX client and the order handling |
| `donchian1250_core.py` | The strategy, with no I/O: the research engine, bar by bar |
| `test_donchian1250_parity.py` (+ `test_donchian1250_bot.py`) | Proves both trade exactly what the research measured |
| `run_donchian1250_bot.bat` | Launcher: runs the quick parity check, refuses to start if it fails |
| `../research/export_bot1250_fixture.mjs` | Writes the golden fixture the test compares against (`fixtures/`, gitignored) |

## Setup

```bash
pip install httpx python-dotenv
```

`bot/.env` (gitignored; never put the key in the `.bat`):

```
PROJECT_X_USERNAME=your_platform_username
PROJECT_X_API_KEY=your_api_key
MNQ_NOTIFY_WEBHOOK=https://ntfy.sh/your-private-topic
```

The username is your platform login, not your email. Keys are made under **Settings > API** at topstepx.com. `MNQ_NOTIFY_WEBHOOK` is the same ntfy topic the signal bot uses (see [Phone notifications](#phone-notifications)).

**In the platform, before the first run:**

1. **Turn off any automatic stop or target on new positions** (Settings > Risk Settings). The bot places its own stop and target. A platform bracket would add a second pair of orders to every trade.
2. **Use a dedicated account.** The bot closes any MNQ position on the account that it did not open. It leaves orders it did not place alone, but reports them.
3. Optional: a personal daily loss limit of $600. The bot already stops the day at -$600. The platform's limit is a backstop if the bot is not running.

If more than one account is active, the bot lists them and stops. Put the exact name in `CONFIG["account_name"]`, or pass it each time: `python mnq_donchian1250_bot.py --account "EXACT-ACCOUNT-NAME"`.

## Running it

```bash
python mnq_donchian1250_bot.py --check
```

The `--check` run is read-only: it logs in, finds the account and the active MNQ contract, and reads bars, positions and orders. It places nothing. Run it first (add `--account "NAME"` if you have more than one account).

Checked against TopstepX on 2026-10-21 (practice account): login, accounts, the active contract (MNQZ6, found by itself), live 1-minute bars including the forming minute, 13 days of history in one request, positions and orders.

Then start the bot with `run_donchian1250_bot.bat`, or `python mnq_donchian1250_bot.py`. Start it before 08:30 CT: it loads 30 days of 1-minute history on start, which takes a few seconds. It runs around the clock. Outside 08:30–15:06 CT it only keeps its indicators current.

The bot is for **simulated accounts** (evaluations, practice). The API's cancel and close endpoints do not support live accounts. If a cancel is refused for that reason, the bot stops opening trades and says so.

## Phone notifications

The bot pushes to your phone through ntfy, on the topic in `MNQ_NOTIFY_WEBHOOK` in `bot/.env`. That is the same variable and topic `mnq_signal_bot.py` uses. Without it the bot still trades; it only logs.

| Priority | When |
|---|---|
| **high** (breaks through) | Something needs you: a stop or target refused, a close that failed (it retries with the stop back on), a position the bot did not open, an order that filled while being cancelled, a gateway error, still live at the hard flat time, the early-close list running out, the bot stopping on an error |
| **default** | What happened: started, filled (stop, target, risk, reward), closed (reason, dollars, day total, and "day done" when a day rule ends it), the session summary at 15:06, an early close today, a contract roll, stopped by hand |
| **low** (silent) | An entry order placed; "still running" every 60 minutes during the session (`MNQ_HEARTBEAT_MIN` in `.env`, 0 turns it off) |

That is about three default pushes a day, plus the silent ones. The same alert is not repeated inside its quiet period, and a failed push never stops the bot.

```bash
python mnq_donchian1250_bot.py --test-notify
```

The `--test-notify` run sends one test push and says whether ntfy accepted it.

## What it does, and when

Every 2 minutes, at the clock-aligned boundary (plus 1 second for the bar to settle):

1. It reads the 2-minute bar that just closed, and the open of the one starting.
2. Fills from before the boundary are booked to the bar that closed. That bar then finishes. If the bar before it signalled, a new stop-entry is set up 0.15 ATR beyond the closed bar's open.
3. The new bar begins. A working entry is cancelled if:
   - it is the flat time (15:06 CT);
   - its 10 bars are up;
   - the day is done (-$300, +$250 or -$600);
   - a signal came the other way.

   Otherwise, on its first live bar, the entry goes in as a **stop**. If the bar opened already through the price, it goes in as a **limit** at the same price.
4. Fills at the open are applied (a stop the open gapped through).
5. Then the exits decided on the closed bar, as a market order at the open:
   - the 40-minute exit (no 1 ATR of profit by the 20th bar);
   - a reversal (a signal the other way);
   - flat at 15:06 CT.

Between boundaries, while anything is live, it checks fills every second. An entry fill immediately gets its **stop** (5 ATR from the arm bar's open, or nearer where the day would reach -$600) and **target** (1.75 ATR) as separate orders. When one fills, the other is cancelled.

Orders are placed on the tick grid, rounded so they trigger on exactly the same price moves as the research's exact prices:

- a buy stop or sell limit rounds up;
- a sell stop or buy limit rounds down.

## Early closes

On some holidays CME closes early, and Topstep liquidates anything still open 15 minutes before that close. The bot keeps the gaps it keeps on a normal day, measured from the firm's cutoff:

| | Normal day | Early close |
|---|---|---|
| No new orders from | 14:55 | 15 minutes before the cutoff |
| Flat | 15:06 | the first bar opening from 5 minutes before the cutoff |
| Hard flat, by the clock | 15:07 | 3 minutes before the cutoff |
| The firm's deadline | 15:10 | the cutoff |

| Day | Cutoff (CT) | No new orders | Flat |
|---|---|---|---|
| Thu Nov 26 2026, Thanksgiving | 11:45 | 11:30 | 11:40 |
| Fri Nov 27 2026 | 12:00 | 11:45 | 11:56 |
| Thu Dec 24 2026, Christmas Eve | 12:00 | 11:45 | 11:56 |

- **The list** is `EARLY_CUTOFF` in `donchian1250_core.py`, taken from Topstep's [holiday trading hours](https://help.topstep.com/en/articles/13350348-topstep-holiday-trading-hours). That page says hours can change with the exchange, so check it before each holiday.
- **Keeping it current:** at start-up the bot warns once fewer than three weeks are left on the list. Add the next year's dates then. A day the market is closed all day needs no entry.
- **On the day** it pushes "Early close today" with the times, at the start of the session, or at start-up if you start it that morning.

## How it was verified

`python test_donchian1250_parity.py` runs 38 checks, against a fixture written from the same data and the same engine run as the research:

| Check | Result |
|---|---|
| 2-minute bars built from the raw 1-minute bars | all 128,282 identical |
| ATR, ADX, efficiency, Donchian channel, gated signal + rescue, 10-min EMA direction, size, filter: every 2026 bar | identical (0.0 difference) |
| The strategy replayed with the engine's fill model: every 2026 trade | 128 of 128 identical |
| 2026 pass rate from those trades | 71.1% (74.3 / 75.1), real windows 74.8%, as the research |
| **The bot itself** (its ProjectX client, order handling, fill tracking and P&L) through 2026, against a simulated gateway built to the docs | **128 of 128 trades identical, 71.1%** |
| The same with orders rounded to the tick grid, as live | the same 128 trades on the same bars for the same reasons; +$28 over 2026; 71.1% |
| Order path the replay cannot reach | handled: a refused stop, a partial fill, an order filling as it is cancelled, a restart mid-trade, a position the bot did not open |
| Early closes, replaying real days with a cutoff on the schedule | an open trade goes out at the flat time, a working entry is cancelled, no new orders after the no-entry time, and normal days change by nothing |
| Phone notifications | a push for every fill and exit (with its dollars and the day's total) and a summary every trading day matching that day's result; nothing sent during tests; same `MNQ_NOTIFY_WEBHOOK` as the signal bot |

The simulated gateway answers the documented endpoints with the documented shapes, so the bot's real HTTP client runs. It fills like the research engine, which is why a faithful bot must reproduce the research's trades exactly. It also checks that the bot:

- never sends a bracket object;
- never reuses a customTag;
- stays inside the documented rate limits (History 50 per 30 s, everything else 200 per 60 s).

`--quick` runs the bot replay over the last 20 sessions only (about 20 s); the launcher uses it. **Run the full test after any change to the code.**

## What live trading can still do differently

The tests prove the bot makes the research's decisions. These are the ways the market can still give different results:

- **Data.** Live bars come from ProjectX, the research's from Databento, back-adjusted at rolls. Both are built from CME trades. In the week around a quarterly roll, the indicators on the new contract's own history can differ slightly from the continuous series.
- **Timing.** Each boundary's orders reach the exchange a second or two after the bar opens, not at the open.
  - A stop the market passes in those seconds is sent as a market order.
  - An entry that fills just before its cancel arrives is closed at once; its result still counts for the day.
  - A stop and target are placed about a second after the entry fills.
- **Fills.** Real slippage instead of a fixed tick; limits fill at their price or better; a stop gapped through fills at the gap.
- **Costs.** The broker's commission, not $0.75 a side.

## Why the old bot stopped

From the ProjectX docs, 2026-10-21:

- `mnq_donchian_bot.py` hard-codes `CON.F.US.MNQ.U26`, which expired on 2026-09-18 (its state file stops that day). This bot finds the active MNQ contract every session.
- Accounts now default to **Position Brackets**. In that mode, `Order/place` rejects any order that carries `stopLossBracket` / `takeProfitBracket`, and the old bot sent them on every entry. This bot sends none. It works in either bracket mode.
