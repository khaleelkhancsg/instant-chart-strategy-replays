---
title: Market Intraday Momentum
authors: Lei Gao, Yufeng Han, Sophia Zhengzi Li, Guofu Zhou
year: 2018
venue: Journal of Financial Economics, 394-414, DOI 10.1016/j.jfineco.2018.05.009
url: https://doi.org/10.1016/j.jfineco.2018.05.009
pdf:
tags: intraday, momentum, time of day, S&P 500, strategy
oneLine: The S&P 500 ETF's first half-hour return (from the prior close) predicts its last half-hour return -- more so on volatile, high-volume and news days.
---

## What it says

Using the S&P 500 ETF from 1993 to 2013, the return over the first half-hour of
the session, measured from the previous day's close, predicts the return over
the last half-hour. The effect is stronger on more volatile days, higher-volume
days, recession days and major macroeconomic announcement days, and it appears in
ten other heavily traded ETFs. The authors relate it to infrequent portfolio
rebalancing and to late-informed traders acting near the close.

## Why it matters here

It is documented, time-of-day-specific structure in exactly the index MNQ
tracks. This project has asked when its books work best within the day; this is
a concrete, tested hypothesis about the last half-hour. The stock market's last
half-hour is 2:30-3:00 PM CT, inside the account's 3:05 PM CT flatten, so it is
tradeable here.

## How to use it here

A strategy file for it is short: read the return from the previous stock
close (3:00 PM CT) to 9:00 AM CT, and take that direction from 2:30 to 3:00 PM
CT. Then judge it with `pass_rate` and `compare` on 2026, split in two,
net of costs -- the payoff per trade is small, so slippage decides it.

## Caveats

ETF data through 2013; the effect may have been arbitraged since publication,
and a once-a-day signal is few trades for a 30-day combine.
