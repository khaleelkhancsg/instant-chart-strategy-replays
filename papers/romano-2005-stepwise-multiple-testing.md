---
title: Stepwise Multiple Testing as Formalized Data Snooping
authors: Joseph P. Romano, Michael Wolf
year: 2005
venue: Econometrica 73(4), 1237-1282, DOI 10.1111/j.1468-0262.2005.00615.x
url: https://econ-papers.upf.edu/en/onepaper.php?id=712
pdf: pdf/romano-2005-stepwise-multiple-testing.pdf
tags: multiple testing, data snooping, bootstrap, familywise error, methodology
oneLine: Not just "does the best rule beat the benchmark?" but WHICH rules do -- a stepwise bootstrap test that controls the chance of any false discovery.
---

## What it says

White's Reality Check (white-2000) answers one question: is the best model
better than the benchmark? Romano and Wolf's StepM procedure identifies the set
of models that beat it, while controlling the familywise error rate (the chance
of even one false "winner") and using the joint dependence of the test
statistics through the bootstrap. It is stepwise: after rejecting the clearest
cases, it re-tests the rest with a smaller critical value, so it finds more
true winners than a single-step test. Studentising the statistics is
recommended.

## How to use it here

When a grid search turns up several configurations that all look better than
the shipped book, StepM tells which of them survive the size of the search --
not just whether the top one does. Daily P&L differences against the benchmark,
block-bootstrapped jointly, are the input.
