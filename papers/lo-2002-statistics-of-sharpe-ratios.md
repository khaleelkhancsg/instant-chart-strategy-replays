---
title: The Statistics of Sharpe Ratios
authors: Andrew W. Lo
year: 2002
venue: Financial Analysts Journal 58(4)
url: https://rpc.cfainstitute.org/research/financial-analysts-journal/2002/the-statistics-of-sharpe-ratios
pdf:
tags: Sharpe ratio, estimation error, autocorrelation, annualisation, methodology
oneLine: A Sharpe ratio is an estimate with a standard error, and serial correlation can inflate an annualised one badly.
---

## What it says

The Sharpe ratio is built from an estimated mean and volatility, so it carries
estimation error; Lo derives its sampling distribution. Two practical results:

- Annualising by sqrt(12) (or sqrt(252)) is only right when returns are
  serially uncorrelated. With autocorrelation the correct factor differs, and
  Lo gives it.
- In his hedge-fund examples, positive serial correlation in monthly returns
  overstated annual Sharpe ratios by as much as 65%, enough to reshuffle
  rankings.

## Why it matters here

Strategy P&L under prop-firm rules is serially dependent: day caps, breakers and
consistency blocks create runs, and regimes (2019 vs 2026 volatility) persist.
Any Sharpe ratio, t-statistic or confidence interval computed as if days were
independent will be too optimistic. The same dependence is why this repo's
day-sequence bootstrap (src/dayeval.mjs) draws blocks of days, not single days.

## How to use it here

When quoting a Sharpe ratio or a t-statistic from daily P&L, check the
autocorrelation of the daily series first, and prefer block-bootstrap intervals
(politis-1994) to formulas that assume independence.

## Caveats

The asymptotic results assume stationarity; a series spanning several
volatility regimes is not stationary, which argues for reporting by period as
the MCP tools do.
