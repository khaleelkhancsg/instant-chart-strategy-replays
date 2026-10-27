---
title: "Controlling the False Discovery Rate: A Practical and Powerful Approach to Multiple Testing"
authors: Yoav Benjamini, Yosef Hochberg
year: 1995
venue: Journal of the Royal Statistical Society Series B 57(1), 289-300, DOI 10.1111/j.2517-6161.1995.tb02031.x
url: https://doi.org/10.1111/j.2517-6161.1995.tb02031.x
pdf:
tags: multiple testing, false discovery rate, statistics, methodology
oneLine: Control the expected share of false discoveries among the findings, instead of the chance of any false discovery -- far more power when many things are tested.
---

## What it says

Familywise corrections (Bonferroni and relatives) control the probability of
making even one false discovery, which becomes very conservative when hundreds
of tests are run. Benjamini and Hochberg propose controlling the false
discovery rate -- the expected proportion of false rejections among all
rejections -- with a simple step-up rule: sort the p-values, and reject every
hypothesis up to the largest k whose p-value is at most k/m times the target
rate (m tests). For independent tests it controls FDR exactly at the target.

## How to use it here

When screening many ideas at once (every strategy file against no-trade, every
filter dimension), FDR is the appropriate standard: it accepts that a few
findings will be false in exchange for finding the real ones. For picking one
configuration to trade, familywise control (romano-2005, white-2000) is the
stricter, more fitting bar.

## Caveats

Correlated tests need the Benjamini-Yekutieli variant, which is more
conservative.
