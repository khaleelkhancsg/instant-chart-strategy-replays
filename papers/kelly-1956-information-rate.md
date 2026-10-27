---
title: A New Interpretation of Information Rate (and Thorp's survey of the Kelly criterion)
authors: John L. Kelly Jr.; Edward O. Thorp
year: 1956
venue: Bell System Technical Journal 35(4), 917-926; Thorp, "The Kelly Criterion in Blackjack, Sports Betting, and the Stock Market", Handbook of Asset and Liability Management (2006)
url: https://sites.oxy.edu/lengyel/M330/thorp/paper.htm
pdf:
tags: Kelly criterion, position sizing, growth, risk of ruin, money management
oneLine: Bet the fraction that maximises the expected log of wealth -- the fastest long-run growth; more than that grows slower AND risks more.
---

## What it says

Kelly showed that a gambler with an edge maximises the long-run growth rate of
capital by betting a fixed fraction that maximises expected log wealth; for a
simple bet won with probability p at odds b, the fraction is p - (1 - p)/b.
Thorp's survey carries it to blackjack, sports betting and securities, with the
practical lessons: betting more than Kelly lowers growth and raises drawdowns
sharply; fractional Kelly (half Kelly is common) gives up a little growth for a
large cut in volatility; and the inputs (the edge) are estimates, so full Kelly
on an overestimated edge is overbetting.

## How to use it here

A combine is not a growth problem -- it is reaching a target before a floor
within a deadline (see browne-1999, dubins-1965, note-combine-first-passage) --
so Kelly sizing is not the right objective for the evaluation. It is the right
reference for the FUNDED account, where survival and growth matter, and its
lesson about overestimated edges applies everywhere: size on the out-of-sample
edge, not the in-sample one.
