---
title: "Note: the combine as a first-passage problem"
authors: chart lab notes (classical result; see Feller, An Introduction to Probability Theory and Its Applications, vol. 1, the classical ruin problem)
year: 2026
venue: project note
url:
pdf:
tags: prop firm, combine, gambler's ruin, win rate, leverage, note
oneLine: With no edge, the chance of reaching the target before the drawdown is about room / (room + target), whatever the win rate; with an edge, less noise per dollar of edge helps, until the time limit bites.
---

## The result

Treat the account as a random walk that starts at 0, passes at +a (the profit
target) and fails at -b (the room above the trailing floor). If its P&L drifts at
mu per unit time with volatility sigma, the probability of reaching +a first is

    P(pass) = (1 - exp(-2 mu b / sigma^2)) / (1 - exp(-2 mu (a + b) / sigma^2))

and with no drift (mu -> 0) it reduces to **b / (a + b)**. For the $3,000 target
and $2,000 drawdown: 2,000 / 5,000 = 40%.

## What it says about win rate

At zero edge the formula has no win-rate term: a 90%-win, tiny-reward book and a
30%-win, large-reward book both pass about b/(a+b) of the time in the limit of
small steps. A high win rate changes the SHAPE of the path (many small steps up,
rare large steps down), not the destination odds. Rules break the symmetry,
though, and that is where win rate genuinely matters for a combine:

- the **consistency rule** (best day at most 50% of profit) penalises lumpy wins,
  which favours many small winners;
- **big steps overshoot**: a large loss can jump past the floor and a large win
  past the target, so the continuous formula is only a guide for coarse books;
- the **time limit** (30 days) leaves some runs unresolved.

## What it says about leverage

Scaling size by k scales mu and sigma by k, so the exponent 2 mu b / sigma^2
falls by a factor of k: with a positive edge, MORE size LOWERS the pass
probability given unlimited time, because noise grows faster than drift relative
to fixed dollar barriers. Smaller size is safer but slower -- and the 30-day
limit is what makes some size necessary. The optimum sits where the time limit
starts to bind, which is why the chart's sweep (real 30-day windows) rather than
this formula should decide contract counts.

## How to use it here

As a sanity check on any pass rate: a book with no edge should pass near
b/(a+b) before rules; a figure far above that needs an edge to explain it, and a
figure far below it is the rules (consistency, daily limits, overshoot) or costs
at work.
