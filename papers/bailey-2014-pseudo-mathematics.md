---
title: "Pseudo-Mathematics and Financial Charlatanism: The Effects of Backtest Overfitting on Out-of-Sample Performance"
authors: David H. Bailey, Jonathan M. Borwein, Marcos López de Prado, Qiji Jim Zhu
year: 2014
venue: Notices of the American Mathematical Society 61(5), 458-471
url: https://www.ams.org/notices/201405/
pdf: pdf/bailey-2014-pseudo-mathematics.pdf
tags: overfitting, minimum backtest length, multiple testing, methodology
oneLine: The more configurations you try, the longer the history must be before the best one means anything -- and an overfit strategy tends to do worse than average out of sample.
---

## What it says

The paper shows how easily a backtest can be made to look excellent on pure
noise. If N strategies with no edge are tried, the best in-sample Sharpe ratio
grows with N; the expected maximum of N standard normal draws is roughly
sqrt(2 ln N). With a backtest of y years, an annualised Sharpe ratio's sampling
error is roughly 1/sqrt(y), so the best of N zero-edge strategies shows an
annualised Sharpe near **sqrt(2 ln N / y)** by luck alone (an approximation).

Example: 1,000 trials on 5 years -> about sqrt(2 x 6.9 / 5) = 1.66. That is a
"great" backtest produced by nothing at all.

From this the authors derive a **minimum backtest length**: the history needed
before a given in-sample Sharpe ratio could not be produced by the number of
trials attempted. They also argue that overfitting can do worse than waste a
search: a strategy tuned to the noise of one stretch can be *negatively*
related to the next stretch, so the in-sample winner may underperform.

## Why it matters here

This repo's history has examples of both effects: the MACD-Angle v4 headline
pass rate that came from a non-causal re-entry, and the 2026-only tuning where a
configuration ranked higher on the earlier half "is fitted to the pre-2026
stretch" (bot/mnq_donchian_bot.py). One quarter of 2026 is a very short
backtest for a search over hundreds of configurations.

## How to use it here

Before trusting a search result, ask whether the history is long enough for the
number of trials: compare the winner's in-sample result with what the best of N
noise strategies would reach. The MCP `search` tool reports how many
configurations it tried and the out-of-sample result; a winner whose
out-of-sample rank is middling is the paper's warning made concrete.

## Caveats

The sqrt(2 ln N) figure assumes independent, normal trials; correlated grids
need fewer effective trials, and fat tails need more.
