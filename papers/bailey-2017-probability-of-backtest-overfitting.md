---
title: The Probability of Backtest Overfitting
authors: David H. Bailey, Jonathan M. Borwein, Marcos López de Prado, Qiji Jim Zhu
year: 2017
venue: Journal of Computational Finance 20(4), DOI 10.21314/JCF.2016.322
url: https://papers.ssrn.com/abstract=2326253
pdf: pdf/bailey-2017-probability-of-backtest-overfitting.pdf
tags: overfitting, multiple testing, cross-validation, PBO, CSCV, methodology
oneLine: Estimates the chance that the configuration you picked as best in-sample is below median out of sample -- implemented in the MCP search tool.
---

## What it says

When many configurations are tried on the same history and the best one is kept,
its in-sample result is biased upward by the selection itself. The paper turns
that into a number: the **probability of backtest overfitting (PBO)**, the
probability that the in-sample winner performs *below the median* of the
configurations out of sample.

It estimates PBO with **combinatorially symmetric cross-validation (CSCV)**:

1. Record every configuration's performance over the evaluation period, split into
   S equal, contiguous blocks.
2. For every way of choosing S/2 blocks as in-sample (the rest out-of-sample),
   find the in-sample best configuration and its relative rank out of sample.
3. PBO is the share of those splits in which that rank is at or below the median.

Because every block is in-sample for half the splits and out-of-sample for the
other half, the estimate does not hinge on one arbitrary train/test cut. The
authors argue a single hold-out is a weak guard for exactly that reason: with
one cut, a lucky or unlucky stretch decides the verdict.

## Why it matters here

This project has searched very large configuration spaces (the August 2026
mega-search scored 515,262 configurations). Every "best found" number from such a
search carries selection bias, and the 2026 Jan-Mar vs Apr-Jul split is one
hold-out -- the kind of single cut the paper warns about.

## How to use it here

The MCP `search` tool computes PBO by CSCV over 8 contiguous blocks of the
evaluation windows (70 in/out splits) on the pass-rate metric, alongside the
in/out-of-sample rank correlation. Read it as:

- **near 0** -- the in-sample ranking carries over; the winner is probably real;
- **around 0.5 or above** -- the ranking does not carry over; the "best" is noise.

A search should be judged on its out-of-sample column and its PBO, never on the
top in-sample number.

## Caveats

Pass-rate windows overlap heavily (a 30-day window started every day), so blocks
are not independent and the estimate is coarse with few blocks. PBO also says
nothing about whether *any* configuration has an edge -- a whole grid of losers
can have a PBO of 0.
