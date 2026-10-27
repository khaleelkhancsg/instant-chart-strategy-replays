---
title: "Beat the Market: An Effective Intraday Momentum Strategy for S&P500 ETF (SPY)"
authors: Andrea Barbon, Andrew Aziz, Carlo Zarattini
year: 2024
venue: Swiss Finance Institute Research Paper 24-97
url: https://www.sfi.ch/de/publications/n-24-97-beat-the-market-an-effective-intraday-momentum-strategy-for-s-p500-etf-spy
pdf:
tags: intraday, momentum, noise area, trailing stop, S&P 500, strategy
oneLine: Trade with a breakout from a "noise area" around the day's open -- built from how far price typically moves from the open by each minute -- with a trailing stop.
---

## What it says

For each minute of the session the authors define a band around the day's open:
the open plus and minus the average absolute move from the open to that same
minute over the previous 14 days (a volatility multiplier of 1). Price inside
the band is noise; a break outside it is read as a demand/supply imbalance, and
the strategy follows it immediately rather than waiting for the last half-hour
(compare gao-2018), managing the position with a dynamic trailing stop. The
working paper reports, for 2007 to early 2024, a Sharpe ratio of 1.33 and an
annualised return near 20%, net of costs.

## Why it matters here

The noise area is a time-of-day-aware volatility band -- a better-founded version
of "has today already moved unusually far?" than a fixed ATR multiple, which
this project has approximated with ADR-used gates (the MACD books'
`adrMax`). It also fits the account's intraday-only rule.

## How to use it here

It can be built as a strategy file on 1-minute bars: per-minute-of-session
average absolute move from the open over the last N sessions (a rolling array
indexed by CT minute), bands around today's open, entries on a close outside the
band, and the engine's `stopFn` hook (or a trailing exitSig) for the trailing
stop. Judge it with `search` (its PBO and out-of-sample column), not its best
in-sample run.

## Caveats

A working paper by authors who also sell trading education and tools; SPY rather
than MNQ futures; results not independently replicated here.
