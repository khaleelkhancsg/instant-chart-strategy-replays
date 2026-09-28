# Tradovate indicators for the live bot

Two custom indicators that draw what `bot/mnq_donchian_bot.py` sees and does, on the chart you trade from.

| File | Chart | Shows |
|---|---|---|
| `mnqDonchianBot.js` | **2-minute** MNQ | Donchian channel, the signals the bot acts on, the stop-entry each one arms, the bracket, fills and exits |
| `mnqOrbBot.js` | **1-minute** MNQ | The two ORB levels with tap counts, the resting buy/sell stops, stand-down days, the entry with lot size, the bracket and the exit |

## Install

1. In Tradovate, open the custom indicator code editor and create a new indicator.
2. Paste the **entire** contents of one file, save. Repeat for the other.
3. Add each to the right chart from the indicator list (tagged **MNQ bot**).

## Chart setup

- **Include the overnight session.** The Donchian channel, ATR and ADX run over every bar, overnight included, exactly as the bot does. An RTH-only chart gives different channels and different signals.
- **Load at least 5 days on the Donchian chart.** The slow-trend rescue needs 1,500 two-minute bars (about 2½ trading days) behind a signal before it counts, exactly as the bot needs 1,500 in its fetch. With less loaded, the indicator still draws every plain signal but no rescued ones, and the trend EMAs stay hidden until they have settled. The ORB chart only needs 06:30-08:30 CT.
- **One check on first load:** the ORB level lines should start on the **08:30 CT** candle. If they start one candle late, turn on `barTimeIsClose` in both indicators (it means Tradovate stamps bars at their close rather than their open).

## Reading it

Donchian: `▲`/`▼` is a signal; hollow `△`/`▽` is a signal the **slow-trend rescue** let through (efficiency 0.45-0.5, taken because the 2-min EMA 125 is on its side of the EMA 500, drawn as the faint blue and purple lines). The gold line is the stop-entry it arms (signal close ± 0.15×ATR, live for 10 bars from the bar after next), `●` is where it fills (`● lim` when the stop was refused and re-placed as a limit), then `TP`/`SL`/`FLIP`/`FLAT`.

ORB: blue lines are the levels, gold the resting stops one tick beyond, grey levels mean the bot stands the day down (levels more than 31 points apart). `▲ 12` is a long entry at 12 lots, `?` a minute that broke both levels.

## What the indicators cannot see

They have no access to your account, so they draw every setup as if the day were flat:

- the **$500 circuit breaker** and **$750 profit block**, which stop new arms once the day's realised P&L crosses them;
- the **$1,000 day cap tightening** after a loss: the bot's stop moves in as the day goes red, the drawn one does not;
- the **ORB owning the account**, which blocks Donchian entries while it holds.

So a signal the bot skipped is almost always one of those three.

## Verified

```
node --max-old-space-size=6144 tradovate/verify.mjs
```

runs both files exactly as Tradovate would, with its tool modules stubbed, and checks 28 things, including:

- every indicator value and signal against `bot/fixture_donchian.json`, the golden file the Python bot is tested against, including the trend EMAs and the rescued signals;
- 10,851 Donchian signals over seven years (1,781 of them rescued) against the research rule;
- all 1,626 trades taken on a flat day against `research/lib_shipped.mjs`, the validated model of the stop-entry, bracket and cap;
- ORB levels and entries on 260 days of `bot/fixture_orb.json`, and all 1,045 entries and exits over seven years against `research/lib_orb.mjs`;
- the CT clock on all 2.5M bars, and that re-calling `map()` on a still-forming bar changes nothing.

**Not verified:** Tradovate's own API surface (module format, parameter helpers, plot styles, the graphics `Text` item, `d.timestamp()` being the bar open). That was written from knowledge of the API, not checked against Tradovate's examples. The lines use only the most basic parts of it. If the markers cause trouble, turn off `showMarkers`, and the lines still draw.
