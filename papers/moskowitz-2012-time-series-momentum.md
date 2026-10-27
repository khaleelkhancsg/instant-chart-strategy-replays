---
title: Time Series Momentum
authors: Tobias J. Moskowitz, Yao Hua Ooi, Lasse Heje Pedersen
year: 2012
venue: Journal of Financial Economics 104(2), 228-250, DOI 10.1016/j.jfineco.2011.11.003
url: https://www.aqr.com/library/journal-articles/time-series-momentum
pdf:
tags: momentum, trend following, futures, volatility scaling, strategy
oneLine: In 58 futures markets, an asset's own past 12-month return predicts its next month's -- persistence for up to a year, partly reversed later.
---

## What it says

Across 58 liquid futures (equity indices, currencies, commodities, bonds), each
instrument's own past excess return -- especially over 12 months -- predicts its
future return, with persistence for one to twelve months that partly reverses
over longer horizons. A diversified portfolio that goes long the risers and
short the fallers, each position scaled to the same volatility, earns returns
with little exposure to standard factors and does best in extreme markets. The
authors link it to under-reaction followed by delayed over-reaction.

## Why it matters here

It is the strongest general evidence that trend following works in futures --
but at monthly horizons, across many markets. The trend books here trade one
market intraday and are flat by 3:05 PM, so they capture little of that horizon;
this project's own mega-search found the winning trend geometries needed
overnight holds that the account's rules forbid.

## How to use it here

Two transferable points. Volatility scaling (sizing to a constant risk) matters
a great deal -- a later replication (Kim, Tse and Wald, 2016) attributes much of
the strategy's performance to that scaling rather than to the momentum signal --
and the engine's 'risk' sizing mode does exactly this. And the horizon matters:
an intraday rule is not evidence for, or against, the monthly effect.

## Caveats

Monthly, diversified, levered portfolio results; not a statement about one
instrument's intraday trends.
