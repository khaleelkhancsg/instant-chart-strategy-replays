---
title: Robust Performance Hypothesis Testing with the Sharpe Ratio
authors: Olivier Ledoit, Michael Wolf
year: 2008
venue: Journal of Empirical Finance 15(5), 850-859
url: https://ideas.repec.org/a/eee/empfin/v15y2008i5p850-859.html
pdf: pdf/ledoit-2008-sharpe-ratio-testing.pdf
tags: Sharpe ratio, hypothesis testing, bootstrap, comparing strategies, methodology
oneLine: The right way to ask "is A's Sharpe ratio really higher than B's?" when returns are fat-tailed and serially dependent -- a studentised block bootstrap.
---

## What it says

The classic test for the difference of two Sharpe ratios (Jobson-Korkie, as
corrected by Memmel) assumes normal, independent returns and breaks down with
fat tails or time-series dependence. Ledoit and Wolf instead build a confidence
interval for the difference with a studentised time-series bootstrap, and call
the two different when zero is outside it. It holds its size better in finite
samples.

## How to use it here

This is the statistically sound version of the MCP `compare` tool's question for
daily P&L: run both configurations, take their daily P&L series over the same
days, and bootstrap the Sharpe difference in blocks. The `compare` tool's count
of calendar months each configuration wins is the quick, robust read; this is
the formal one.

## Caveats

Power is low for small differences over short samples -- 2026 alone rarely
separates two similar books.
