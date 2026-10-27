---
title: "... and the Cross-Section of Expected Returns"
authors: Campbell R. Harvey, Yan Liu, Heqing Zhu
year: 2016
venue: Review of Financial Studies 29(1), 5-68, DOI 10.1093/rfs/hhv059
url: https://www.nber.org/papers/w20592
pdf: pdf/harvey-2016-cross-section-multiple-testing.pdf
tags: multiple testing, t-statistic, false discovery, methodology
oneLine: After hundreds of published "factors", a new one needs a t-statistic above about 3, not 2 -- the hurdle has to rise with the number of things tried.
---

## What it says

Hundreds of variables have been reported to predict stock returns. If each was
tested at the usual 5% level (t > 2), many are false discoveries simply because
so many were tried. The authors apply multiple-testing corrections (family-wise
error rate and false discovery rate methods, allowing for correlated tests and
for tests that were run but never published) and conclude a newly proposed
factor needs a t-ratio above roughly **3.0**, with the bar rising over time as
more factors are tried.

## Why it matters here

The same arithmetic applies to every search in this repo. A pass-rate gain or a
positive expectancy that would be "significant" if it were the only thing
tested is not significant when it is the best of a grid.

## How to use it here

When a search finds an improvement, ask what t-statistic its edge has (mean
daily P&L difference over its standard error, with overlapping days in mind)
and whether it clears a hurdle that grows with the number of configurations
tried. Pair with PBO (bailey-2017) from the MCP `search` tool.

## Caveats

The 3.0 figure is calibrated to the cross-section of stock returns and the
number of factors tried there; it is a reminder of the scale of the correction,
not a constant to reuse.
