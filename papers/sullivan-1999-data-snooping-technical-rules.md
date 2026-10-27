---
title: Data-Snooping, Technical Trading Rule Performance, and the Bootstrap
authors: Ryan Sullivan, Allan Timmermann, Halbert White
year: 1999
venue: Journal of Finance 54(5), 1647-1691
url: https://www.fmg.ac.uk/publications/discussion-papers/data-snooping-technical-trading-rule-performance-and-bootstrap
pdf: pdf/sullivan-1999-data-snooping-technical-rules.pdf
tags: data snooping, technical analysis, moving averages, breakouts, bootstrap, out of sample
oneLine: The famous technical-rule results re-tested against the whole universe of rules that could have been searched -- strong in the original sample, gone in the decade after.
---

## What it says

Brock, Lakonishok and LeBaron (brock-1992) found that 26 simple moving-average
and trading-range-break rules beat the Dow over a century of data. This paper
asks how much of that is the luck of the rules chosen. It builds a much larger
universe of rules of the same families (moving averages, filter rules, support
and resistance breaks, channel breakouts, on-balance volume) and applies White's
Reality Check (white-2000) to the best rule in that universe.

The best rule's performance in the original sample survives the adjustment for
the whole search. In the following decade it does not: the best rules no longer
beat the benchmark once the universe they were picked from is accounted for.

## Why it matters here

The Donchian books here are channel breakouts -- one of the rule families this
paper tests -- and their parameters were found by search. The paper's pattern is
the one to guard against: an edge that is real in the period it was found in and
then fades.

## How to use it here

Treat the 2026 Jan-Mar vs Apr-Jul split as the minimum, not the whole test:
compare a book's result across years (MCP `backtest` reports by year, `pass_rate`
by period) and ask whether the edge is stable or concentrated. For a search, run
the Reality Check over its full grid (see white-2000).

## Caveats

Daily equity-index rules on a century of data are a different setting from
intraday MNQ futures with prop-firm rules; the lesson is methodological, not a
verdict on breakouts in this market.
