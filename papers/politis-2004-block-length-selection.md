---
title: Automatic Block-Length Selection for the Dependent Bootstrap (and its 2009 correction)
authors: Dimitris N. Politis, Halbert White; correction with Andrew Patton
year: 2004
venue: Econometric Reviews 23(1), 53-70; correction 28(4), 372-375 (2009)
url: https://public.econ.duke.edu/~ap172/Patton_Politis_White_2009.pdf
pdf: pdf/patton-2009-block-length-correction.pdf
tags: bootstrap, block bootstrap, block length, time series, methodology
oneLine: A data-driven choice of block length for block bootstraps, instead of picking one by hand.
---

## What it says

Every block bootstrap needs a block length (the mean length, for the stationary
bootstrap). Too short and the dependence is broken; too long and there are too
few distinct blocks. Politis and White estimate the optimal length from the
data, using the series' autocorrelation through a flat-top spectral estimate.
The 2009 correction (Patton, Politis and White) fixes the stationary-bootstrap
formula after an error was found in the variance result it relied on; use the
corrected version. The R package `blocklength` implements it.

## How to use it here

src/dayeval.mjs uses a fixed 5-day block. Estimate the optimal length from a
strategy's daily P&L series and compare: if it is far from 5, re-run the
bootstrap pass rate with that block (the samplers take `block`) and see whether
the result moves.
