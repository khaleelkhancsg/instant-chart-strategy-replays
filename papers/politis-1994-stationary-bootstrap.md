---
title: The Stationary Bootstrap
authors: Dimitris N. Politis, Joseph P. Romano
year: 1994
venue: Journal of the American Statistical Association 89(428), 1303-1313
url: https://gnosis.library.ucy.ac.cy/handle/7/57533
pdf:
tags: bootstrap, block bootstrap, time series, resampling, methodology
oneLine: Resample a dependent series in blocks of RANDOM length -- the resampled series stays stationary, unlike fixed blocks.
---

## What it says

Bootstrapping single observations destroys serial dependence. Block bootstraps
keep it by resampling runs of consecutive observations, but fixed-length blocks
produce a resampled series that is not stationary (the joins fall at fixed
places). The stationary bootstrap draws each block's length from a geometric
distribution with a chosen mean, starting at a uniformly random position and
wrapping around the end. The result is stationary, and the authors prove the
method consistent for weakly dependent series. The mean block length still has
to be chosen.

## Why it matters here

src/dayeval.mjs -- the day-sequence evaluator behind every pass rate quoted from
research/lib_shipped.mjs and lib_combo.mjs -- draws fixed 5-day blocks of days.
That keeps week-long runs of good and bad days together, but the fixed length is
an arbitrary choice, and it treats the joins between blocks as exchangeable.

## How to use it here

Two checks on any bootstrap pass rate: (1) vary the block length (the samplers in
src/dayeval.mjs take `block`) and see whether the answer moves; (2) a stationary
variant -- geometric block lengths with mean 5 -- is a small change to
`blockSampler` if a result proves sensitive to the fixed length. The calendar
windows method (the chart's sweep) avoids the question by using the real
sequences, at the price of far fewer independent samples.

## Caveats

No block scheme can create information the history does not hold: 139 trading
days of 2026 support only a handful of genuinely independent month-long runs.
