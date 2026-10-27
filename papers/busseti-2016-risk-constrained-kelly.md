---
title: Risk-Constrained Kelly Gambling
authors: Enzo Busseti, Ernest K. Ryu, Stephen Boyd
year: 2016
venue: Journal of Investing 25(3), 118-134
url: https://web.stanford.edu/~boyd/papers/kelly.html
pdf: pdf/busseti-2016-risk-constrained-kelly.pdf
tags: Kelly criterion, drawdown, position sizing, convex optimization, money management
oneLine: Kelly growth subject to a cap on the probability of ever falling to a set drawdown -- solved exactly as a convex problem, and better than fractional Kelly.
---

## What it says

The authors add a constraint to the Kelly problem: the probability that wealth
ever falls to a chosen fraction of its starting value must stay below a set
level. They derive a bound on that drawdown probability which turns the
problem into a convex optimisation that is guaranteed to respect the
constraint, and show in simulation that the bound is fairly tight. A single
risk-aversion parameter trades growth against drawdown risk, and the result
beats fractional Kelly at the same risk or the same growth.

## How to use it here

A prop account IS a drawdown constraint -- the trailing floor. For the funded
stage, this is the principled way to size: maximise growth subject to a small
probability of touching the floor, instead of a fixed contract count. The
engine's `sizer` hook can take a contract count computed this way from the
account's room above the floor (research/lib_shipped.mjs `episode` passes that
room to the sizer).

## Caveats

It assumes the distribution of outcomes per bet is known; here it is estimated
from a backtest, so feed it a conservative edge.
