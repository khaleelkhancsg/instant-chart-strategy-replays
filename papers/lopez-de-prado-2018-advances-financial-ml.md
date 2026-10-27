---
title: Advances in Financial Machine Learning (book; chapters 7 and 12)
authors: Marcos López de Prado
year: 2018
venue: Wiley, ISBN 978-1-119-48208-6
url: https://www.wiley.com/en-us/Advances+in+Financial+Machine+Learning-p-9781119482086
pdf:
tags: cross-validation, purging, embargo, CPCV, walk-forward, overfitting, methodology
oneLine: Cross-validation for overlapping financial samples -- purge training data that overlaps the test period, embargo what follows it, and test on every combination of folds.
---

## What it says

Chapter 7: ordinary k-fold cross-validation leaks information in finance,
because samples overlap in time (a 30-day window started each day shares 29
days with its neighbour). **Purging** drops training samples whose time span
overlaps the test fold; an **embargo** also drops those immediately after it.
Chapter 12: **combinatorial purged cross-validation (CPCV)** splits the history
into groups and tests on every combination of k groups, which yields many
out-of-sample paths -- a distribution of results rather than one walk-forward
path -- and ties directly to the probability of backtest overfitting.

## How to use it here

Calendar windows overlap by construction, so any in/out-of-sample split of
window STARTS leaks unless the boundary is purged: a window starting on 31
March runs to 30 April, inside "Apr-Jul". The MCP `search` tool purges by
default -- it drops every in-sample window whose days reach the out-of-sample
windows' and reports how many -- and `walk_forward` purges each step the same
way.
