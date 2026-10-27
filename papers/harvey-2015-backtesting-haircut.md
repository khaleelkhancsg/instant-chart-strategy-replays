---
title: Backtesting
authors: Campbell R. Harvey, Yan Liu
year: 2015
venue: Journal of Portfolio Management, Fall 2015
url: https://people.duke.edu/~charvey/Research/Published_Papers/P120_Backtesting.PDF
pdf: pdf/harvey-2015-backtesting-haircut.pdf
tags: multiple testing, Sharpe ratio, haircut, profit hurdle, methodology
oneLine: Replace the rule-of-thumb "halve the backtested Sharpe" with a haircut computed from how many strategies were tried -- marginal results lose almost everything.
---

## What it says

Practitioners often discount a backtested Sharpe ratio by 50%. Harvey and Liu
derive the discount instead: convert the Sharpe ratio to a t-statistic, adjust
its p-value for the number of tests run (with Bonferroni, Holm or
Benjamini-Hochberg-Yekutieli style corrections), and convert back. The haircut
is nonlinear: high Sharpe ratios are only moderately reduced, while marginal
ones are cut by far more than half. They also give a minimum profit hurdle a
strategy must clear to count as significant given the search behind it.

## How to use it here

For a candidate from an MCP `search`, take its daily P&L Sharpe ratio and the
number of configurations tried, and apply the haircut before comparing it with
the shipped book. A configuration that only edges the incumbent in-sample is
the marginal case the haircut wipes out.

## Caveats

Assumes the tests' correlation can be summarised; overlapping grid points make
the effective number of tests smaller than the grid size.
