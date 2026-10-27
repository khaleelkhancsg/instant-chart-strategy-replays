---
title: Optimal Investment Strategies for Controlling Drawdowns
authors: Sanford J. Grossman, Zhongquan Zhou
year: 1993
venue: Mathematical Finance 3(3), 241-276, DOI 10.1111/j.1467-9965.1993.tb00044.x
url: https://ideas.repec.org/a/bla/mathfi/v3y1993i3p241-276.html
pdf:
tags: drawdown, trailing floor, position sizing, portfolio optimization, money management
oneLine: Never let wealth fall below a fraction of its peak: the optimal policy risks an amount proportional to the cushion above that trailing floor.
---

## What it says

An investor must keep wealth above a fixed fraction of its running maximum --
a trailing floor. Grossman and Zhou show the optimal policy invests in the
risky asset in proportion to the **surplus**: current wealth minus the floor.
As wealth nears the floor, exposure shrinks toward zero; as a new peak is made,
the floor rises with it. They also discuss a "decayed drawdown" variant in
which old peaks are gradually forgotten.

## How to use it here

The combine's trailing drawdown is exactly this floor, in dollars rather than a
fraction. The paper's answer -- size in proportion to the cushion above the floor
-- is the "trade smaller when close to the floor" idea research/lib_shipped.mjs's
`episode` runner was built to test: it re-runs the engine for each window with
the account's room above the floor passed to the `sizer` hook. (The chart's
sweep scores one trade list across all windows, so it cannot size by account.)

## Caveats

Continuous-time and continuous trading; a futures account trades whole
contracts with gaps, so the cushion rule is a guide, not an exact policy (Klass
and Nowicki showed its optimality does not carry over to discrete time).
