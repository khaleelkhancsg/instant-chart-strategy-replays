---
title: A Reality Check for Data Snooping
authors: Halbert White
year: 2000
venue: Econometrica 68(5), 1097-1126, DOI 10.1111/1468-0262.00152
url: https://www.econometricsociety.org/publications/econometrica/2000/09/01/reality-check-data-snooping
pdf:
tags: data snooping, multiple testing, bootstrap, model selection, methodology
oneLine: A bootstrap test of whether the BEST of many models genuinely beats a benchmark, once the whole search is accounted for.
---

## What it says

When many models (trading rules, configurations) are compared against a
benchmark and the best is reported, its apparent outperformance is partly the
luck of having looked many times. White's **Reality Check** tests the null
hypothesis that *no* model in the full set beats the benchmark.

The test statistic is the best model's average outperformance. Its distribution
under the null is obtained by bootstrapping the performance differences of all
models jointly (with a time-series bootstrap that keeps their dependence), so
the p-value accounts for every model that was tried, not just the winner.

## Why it matters here

Every research question in this repo is a search: brackets, gates, time
windows, sizes. The honest question is not "is the winner good?" but "is the
winner better than the best of an equally large search of rules with no edge
would be?" -- which is exactly this test.

## How to use it here

Treat the configurations of an MCP `search` as the model set and a benchmark
(no trade, or the shipped configuration) as the comparison. Build each
configuration's daily P&L difference from the benchmark, bootstrap the days
jointly in blocks (the stationary bootstrap -- politis-1994 -- is the one White
uses), and compare the observed best mean difference with the bootstrap
distribution of the best. A configuration that only wins against its own
search's noise is not a finding.

## Caveats

The test can lose power when the set contains many poor or irrelevant models;
Hansen's SPA test (hansen-2005) addresses that. It tests the best model's edge
over the benchmark, not whether the best is the best.
