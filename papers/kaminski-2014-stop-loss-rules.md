---
title: When Do Stop-Loss Rules Stop Losses?
authors: Kathryn M. Kaminski, Andrew W. Lo
year: 2014
venue: Journal of Financial Markets 18, 234-254
url: https://dspace.mit.edu/handle/1721.1/114876
pdf:
tags: stop-loss, momentum, random walk, risk management, strategy
oneLine: Under a random walk a stop-loss always lowers expected return; it only adds value when returns have momentum (serial correlation) -- the stop is a bet on the process.
---

## What it says

Kaminski and Lo model how a simple stop-loss rule (exit to a safe asset after
a cumulative loss, re-enter later) changes a strategy's expected return and
volatility. Under the random-walk hypothesis, the stop always reduces expected
return. With momentum -- positive serial correlation -- a stop can add value,
because the loss it cuts tends to continue. Empirically, some stop rules on
equities raised returns during stop-out periods while cutting volatility. Lo
and Remorov (2017) extend this to serial correlation, regime switching and
transaction costs, finding costs can reverse the benefit.

## How to use it here

Bracket stops in this engine are the same kind of decision. Whether a tighter
stop helps depends on whether the market trends or mean-reverts at the horizon
traded -- which is measurable: MCP `search` over `exec.slAtrMult`, judged out
of sample, is the direct test, and a stop that only helps in-sample is the
paper's random-walk case.
