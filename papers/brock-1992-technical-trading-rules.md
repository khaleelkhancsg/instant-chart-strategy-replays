---
title: Simple Technical Trading Rules and the Stochastic Properties of Stock Returns
authors: William Brock, Josef Lakonishok, Blake LeBaron
year: 1992
venue: Journal of Finance 47(5), 1731-1764
url: https://ideas.repec.org/a/bla/jfinan/v47y1992i5p1731-64.html
pdf:
tags: technical analysis, moving averages, trading range break, breakouts, bootstrap, strategy
oneLine: Moving-average and trading-range-break (breakout) rules on a century of the Dow beat four popular return models -- before costs, and before anyone counted the rules not chosen.
---

## What it says

The authors test two rule families on the Dow Jones Industrial Average from 1897
to 1986: **moving-average** crossovers and **trading range breaks** -- buy when
price breaks above its recent high, sell when it breaks below its recent low,
which is the Donchian channel breakout. Returns after buy signals were higher and
less volatile than after sell signals. Using the bootstrap, they show the pattern
is not reproduced by a random walk, an AR(1), a GARCH-M or an exponential GARCH
model of returns.

## Why it matters here

It is the founding evidence for the book this project trades: the Donchian
channel break (strategies/donchian_eff_rth.mjs, donchian_shipped.mjs) is a
trading range break with a volatility and trend gate.

## How to use it here

Read it together with its two follow-ups. Bessembinder and Chan (1998) showed
the profits disappear once trading costs are charged; Sullivan, Timmermann and
White (sullivan-1999) showed the best rule's edge does not survive out of sample
once the universe of rules is accounted for. The lesson for this repo: quote
breakout results net of commission and a tick of slippage (the MCP tools warn
when there is none), and across periods.

## Caveats

Daily index data, no costs, and a specific historical sample; intraday MNQ
breakouts under a 3:05 PM flatten rule are a different object.
