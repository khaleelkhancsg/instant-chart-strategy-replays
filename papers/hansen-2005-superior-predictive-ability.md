---
title: A Test for Superior Predictive Ability
authors: Peter Reinhard Hansen
year: 2005
venue: Journal of Business & Economic Statistics 23(4), 365-380
url: https://doi.org/10.1198/073500105000000063
pdf:
tags: data snooping, multiple testing, bootstrap, model selection, methodology
oneLine: White's Reality Check made more powerful -- studentised, and no longer dragged down by adding bad models to the comparison.
---

## What it says

Hansen keeps the question of White's Reality Check (white-2000) -- does any
model beat the benchmark once the search is accounted for? -- and fixes two
weaknesses:

- **Studentisation.** Each model's outperformance is scaled by its own standard
  error, so a volatile model with a large but noisy mean does not dominate.
- **Irrelevant alternatives.** In the Reality Check, adding clearly bad models
  to the set makes the test more conservative, so a researcher could weaken it
  just by including junk. The SPA test discounts models that are clearly worse
  than the benchmark when setting the null distribution, which makes it more
  powerful and less sensitive to what else was tried.

## Why it matters here

Grids in this repo contain many configurations that are obviously poor (stops
too tight, targets unreachable). Under the plain Reality Check they would make
it harder to recognise a real improvement; under SPA they do not.

## How to use it here

As with the Reality Check: daily P&L differences against a benchmark for every
configuration of a search, bootstrapped jointly in blocks. Prefer SPA when the
grid is wide and includes extreme settings.

## Caveats

Like the Reality Check it asks whether the best beats the benchmark, not which
configuration is best; and the block bootstrap needs enough days to be reliable,
which a single quarter of 2026 strains.
