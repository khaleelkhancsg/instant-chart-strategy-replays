---
title: On the Maximum Drawdown of a Brownian Motion
authors: Malik Magdon-Ismail, Amir F. Atiya, Amrit Pratap, Yaser S. Abu-Mostafa
year: 2004
venue: Journal of Applied Probability 41(1), 147-161
url: https://www.cambridge.org/core/journals/journal-of-applied-probability/article/on-the-maximum-drawdown-of-a-brownian-motion/F9E3B8A454B020DDEBF0AC3390EF7807
pdf:
tags: drawdown, Brownian motion, expected maximum drawdown, risk, statistics
oneLine: How deep the worst drawdown is expected to be over a horizon, for a given edge and volatility -- so a backtest's drawdown can be judged against chance.
---

## What it says

The authors derive the distribution and expected value of the maximum drawdown
of a Brownian motion with drift over a fixed horizon, as a function of drift,
volatility and horizon. With no drift it grows like the square root of the
horizon; with positive drift only like its logarithm, scaled by variance over
drift; with negative drift linearly. MATLAB's `emaxdrawdown` implements it.

## How to use it here

Given a book's daily mean and volatility (MCP `backtest`), the expected maximum
drawdown over 30 days says how often the $2,000 trailing floor should be hit by
chance alone -- a quick check on whether a pass rate is plausible, and on how
much a change in size moves the breach risk (drawdown scales with size, the
floor does not).

## Caveats

Continuous paths and constant parameters; real day P&L under caps has jumps and
regime shifts, so use it as an order-of-magnitude check.
