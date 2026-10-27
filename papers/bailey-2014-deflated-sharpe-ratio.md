---
title: "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality"
authors: David H. Bailey, Marcos López de Prado
year: 2014
venue: Journal of Portfolio Management 40(5), 94-107, DOI 10.3905/jpm.2014.40.5.094
url: https://papers.ssrn.com/abstract=2460551
pdf: pdf/bailey-2014-deflated-sharpe-ratio.pdf
tags: overfitting, multiple testing, Sharpe ratio, selection bias, non-normality, methodology
oneLine: How high a backtest's Sharpe ratio must be before it means anything, given how many configurations were tried and how fat-tailed the returns are.
---

## What it says

A Sharpe ratio estimated from a backtest has sampling error, and it is inflated
twice over when it is the best of many trials and when returns are skewed or
fat-tailed. The paper builds a test in two steps.

**Probabilistic Sharpe ratio.** The probability that the true Sharpe ratio
exceeds a benchmark SR*, given an estimate SR from T observations with skewness
g3 and (non-excess) kurtosis g4:

    PSR(SR*) = Phi( (SR - SR*) * sqrt(T - 1) / sqrt(1 - g3*SR + (g4 - 1)/4 * SR^2) )

(Sharpe ratios here are per observation, not annualised.)

**Deflated Sharpe ratio.** Set the benchmark SR* to the Sharpe ratio the *best*
of N independent trials would reach by luck alone:

    SR0 = sqrt(V) * ( (1 - g) * Phi^-1(1 - 1/N) + g * Phi^-1(1 - 1/(N*e)) )

where V is the variance of the trials' Sharpe ratios and g ~ 0.5772 (the
Euler-Mascheroni constant). DSR = PSR(SR0). A DSR above about 0.95 is evidence
the result is not explained by the search; a low one says it is.

Check the paper for the exact statement before relying on these formulas.

## Why it matters here

The research in this repo tried thousands to hundreds of thousands of
configurations per question. A "best" profit factor or Sharpe ratio quoted from
such a search has to clear SR0, not zero. Fat tails matter too: MNQ day P&L under
a hard day-loss cap is strongly skewed, which the PSR denominator penalises.

## How to use it here

MCP `backtest` returns the inputs under `daily`, over every trading day in the
period with flat days as $0:

- `sharpe` is the daily Sharpe ratio (SR);
- `skew` and `kurtosis` are g3 and g4;
- `days` is T;
- `psrVsZero` is the probabilistic Sharpe ratio against 0.

Deflating it then needs two more inputs:

- N, the number of configurations tried in the search that produced the
  candidate (MCP `search` reports it as `tried`);
- V, the variance of the Sharpe ratios across that grid (run `backtest` on a few
  of the grid's configurations).

Then replace 0 with the expected maximum Sharpe ratio of N trials as the
benchmark. For pass rates rather than Sharpe ratios, PBO (bailey-2017) is the
analogue, and the `search` tool computes it directly.

## Caveats

N is "independent" trials; neighbouring grid points are highly correlated, so the
effective N is smaller than the grid size -- the paper discusses estimating it.
