---
title: A Backtesting Protocol in the Era of Machine Learning
authors: Robert Arnott, Campbell R. Harvey, Harry Markowitz
year: 2019
venue: Journal of Financial Data Science 1(1), 64-74, DOI 10.3905/jfds.2019.1.064
url: https://papers.ssrn.com/abstract=3275654
pdf:
tags: backtesting, protocol, checklist, overfitting, machine learning, methodology
oneLine: A research checklist -- state the hypothesis first, count every trial, keep the out-of-sample untouched, beware of data too thin for the method.
---

## What it says

The authors give a protocol for quantitative research, written for machine
learning but meant for any backtest. Its core points: have an economic reason
for the effect before testing it; record every variation tried, because the
number of trials is what a result must be discounted for; keep an
out-of-sample period untouched until the end, and do not go back to the data
after it disappoints; expect more data to be needed than finance usually has,
which makes flexible methods especially prone to fitting noise; and prefer
simple, interpretable models whose failure would be noticed.

## How to use it here

It is the checklist the MCP tools are built around: `search` counts the
configurations it tried and reports out-of-sample results and PBO; the default
periods hold 2026 Apr-Jul out against Jan-Mar. The part the tools cannot
enforce is the discipline of not re-searching after a disappointing
out-of-sample result -- once the hold-out has been used to choose, it is
in-sample.
