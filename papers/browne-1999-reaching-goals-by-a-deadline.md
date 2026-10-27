---
title: "Reaching Goals by a Deadline: Digital Options and Continuous-Time Active Portfolio Management"
authors: Sid Browne
year: 1999
venue: Advances in Applied Probability 31(2), 551-577, DOI 10.1239/aap/1029955147
url: https://doi.org/10.1239/aap/1029955147
pdf:
tags: target, deadline, maximize probability, digital option, combine, money management
oneLine: The strategy that maximises the probability of reaching a wealth target by a deadline -- the combine's exact objective -- is to replicate a digital option.
---

## What it says

Browne solves for the dynamic strategy that maximises the probability of
reaching a target wealth by a fixed deadline, investing in risky assets and a
riskless one. For a single asset with constant parameters, the optimal policy
is to hold the replicating portfolio of a digital (binary) option on reaching
the target -- and, strikingly, it does not depend on the asset's drift. The
amount at risk grows as the deadline approaches, is largest when the account is
about midway to the target, and shrinks as the target comes within reach (and,
like a deep out-of-the-money option's delta, when it is very far away).

## How to use it here

This is the combine's actual objective (reach $3,000 within 30 days, before the
floor). Its practical shape for sizing: commit more as the deadline nears while
the target is still in play, and less as the target comes within reach, since
there is little to gain and much to lose. Sizing that depends on the account
cannot be scored from one trade list, as the chart's sweep scores everything
else; research/lib_shipped.mjs's `episode` runner -- the engine re-run per
window with the account visible to its `sizer` -- is the way to test it.

## Caveats

Continuous trading with no drawdown floor; a combine has both a floor and
discrete contracts, so treat the shape, not the formula, as the guide.
