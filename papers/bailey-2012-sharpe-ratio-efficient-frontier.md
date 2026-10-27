---
title: The Sharpe Ratio Efficient Frontier
authors: David H. Bailey, Marcos López de Prado
year: 2012
venue: Journal of Risk 15(2)
url: https://www.risk.net/journal-risk/2223785/sharpe-ratio-efficient-frontier
pdf:
tags: Sharpe ratio, probabilistic Sharpe ratio, minimum track record length, non-normality, methodology
oneLine: The probability that a strategy's true Sharpe ratio beats a threshold, and the minimum track record needed to show it -- longer when returns are skewed and fat-tailed.
---

## What it says

Introduces the probabilistic Sharpe ratio (PSR) -- the probability that the
true Sharpe ratio exceeds a chosen threshold given the estimate, its sample
length, skewness and kurtosis (the formula is in bailey-2014-deflated-sharpe-ratio)
-- and from it the **minimum track record length (MinTRL)**: how many
observations are needed to reject "the true Sharpe ratio is below the
threshold" at a given confidence. Negative skew and fat tails lengthen it.

## How to use it here

Before trusting a strategy on 2026 alone (about 140 trading days), check its
MinTRL. MCP `backtest` with `from: "2026-01-01"` reports it as
`daily.minTrackRecordDays`, next to `daily.psrVsZero` (the PSR against a Sharpe
ratio of 0) and the skew and kurtosis behind both. If MinTRL exceeds the days
available, 2026 cannot tell the book from the threshold, however good the number
looks. Day P&L under a hard day-loss cap is skewed, and this accounts for that.

## Caveats

Assumes the return distribution stays the same out of sample -- a regime change
(2019's 6-point ATR vs 2026's 28) breaks that.
