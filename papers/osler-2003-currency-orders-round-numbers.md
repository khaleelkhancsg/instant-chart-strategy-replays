---
title: "Currency Orders and Exchange Rate Dynamics: An Explanation for the Predictive Success of Technical Analysis"
authors: Carol L. Osler
year: 2003
venue: Journal of Finance 58(5), 1791-1819, DOI 10.1111/1540-6261.00588
url: https://www.newyorkfed.org/medialibrary/media/research/staff_reports/sr125.html
pdf: pdf/osler-2003-currency-orders-round-numbers.pdf
tags: support and resistance, round numbers, stop-loss orders, take-profit orders, order flow, strategy
oneLine: Take-profit orders cluster AT round numbers (prices reverse there); stop-loss orders cluster just BEYOND them (trends accelerate once through).
---

## What it says

From about 9,700 stop-loss and take-profit orders at a large dealing bank,
Osler finds both kinds cluster at round numbers, differently. Take-profit
orders bunch most tightly exactly at the round number, which helps explain
reversals at support and resistance. Stop-loss orders bunch just beyond round
numbers, so once price crosses a round number the triggered stops push it
further -- trends accelerate through the level.

## Why it matters here

This project's own level study (the Tradovate S/R work) measured that round
100s on MNQ tend to BREAK rather than hold -- consistent with the stop-loss
side of Osler's account. It is also a reason a resting stop order at an obvious
level fills worse than its price in fast markets: the engine's `entryGapFill`
fills at the open when price gaps through.

## Caveats

Currency orders at one bank, 1999-2000; futures order books differ, but the
mechanism (clustered resting orders at salient prices) is general.
