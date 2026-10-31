---
title: Adaptive Conformal Inference Under Distribution Shift
authors: Isaac Gibbs, Emmanuel Candès
year: 2021
venue: Advances in Neural Information Processing Systems 34 (NeurIPS 2021)
url: https://proceedings.neurips.cc/paper/2021/hash/0d441de75945e5acbc865406fc9a2559-Abstract.html
pdf:
tags: conformal prediction, coverage, distribution shift, quantile tracking, levels
oneLine: Keep a prediction band at its aimed coverage while the data changes under it, with one online update and no model of the data.
---

## What it says

Conformal prediction gives a band a coverage guarantee, but only if the data is
exchangeable, which a market is not. The paper treats the shift as a learning
problem in one number: after each outcome, move the miscoverage level a small step,
up after a hit and down after a miss. Over long stretches the realised coverage
then matches the aim, whatever process generated the data. Angelopoulos, Candès and
Tibshirani (Conformal PID Control for Time Series Prediction, NeurIPS 2023) show this
is a special case of quantile tracking, which updates the band itself and avoids the
empty or infinite bands the original can produce. That is the form used here.

## Why it matters here

"NQ usually moves about 1%" is a claim about a distribution, and a fixed number goes
stale as volatility changes. A self-correcting band keeps the claim true without a
volatility model, which makes it a natural way to set a percentage level.

## How to use it here

`src/levels.mjs` `conformalLevels` tracks how far a day reaches from settlement in
ADRs, each side alone, and the chart's "Self-correcting band" draws it.
`research/pct_conformal.mjs` scores it against a fixed percentage, a trailing
quantile and a fixed ADR multiple on 2026 and the forward bars.

## Caveats

Coverage holds over a long run, not on any one day, and a guarantee about how often a
band breaks says nothing about direction. On 2026 it held its aim no better than a
plain ADR multiple, and both beat a fixed percentage by about two to one.
