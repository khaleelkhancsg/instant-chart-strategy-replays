---
title: Intraday Periodicity and Volatility Persistence in Financial Markets
authors: Torben G. Andersen, Tim Bollerslev
year: 1997
venue: Journal of Empirical Finance 4(2-3), 115-158, DOI 10.1016/S0927-5398(97)00004-2
url: https://ideas.repec.org/a/eee/empfin/v4y1997i2-3p115-158.html
pdf:
tags: intraday, volatility, seasonality, time of day, statistics
oneLine: Intraday volatility follows a strong, regular time-of-day pattern; filter it out before modelling volatility, or every intraday measure is distorted.
---

## What it says

Return volatility in foreign exchange and equity markets has a pronounced
intraday pattern -- high at the open, lower midday, rising into the close for
stocks, with spikes at scheduled announcements. Andersen and Bollerslev show
that this periodicity dominates high-frequency return dynamics and must be
removed (they model it with a flexible seasonal component) before volatility
persistence can be measured properly.

## Why it matters here

ATR on 1- or 2-minute bars inherits that pattern: a 5xATR stop placed at 8:31
CT is set off opening-auction volatility and is far wider in points than the
same rule at 12:30. Strategies that size or place brackets by ATR are therefore
time-of-day dependent whether intended or not.

## How to use it here

Look at a book's results by entry hour (MCP `backtest` reports them) and
consider normalising ATR by its usual value at that minute of the session (the
same idea as the noise area in barbon-2024).
