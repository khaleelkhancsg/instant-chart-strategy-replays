---
title: "Can Day Trading Really Be Profitable? Evidence of Sustainable Long-term Profits from Opening Range Breakout (ORB) Day Trading Strategy vs. Benchmark in the US Stock Market"
authors: Carlo Zarattini, Andrew Aziz
year: 2023
venue: SSRN working paper 4416622
url: https://papers.ssrn.com/abstract=4416622
pdf:
tags: opening range breakout, ORB, intraday, day trading, strategy
oneLine: A 5-minute opening range breakout on QQQ reported as profitable over years -- but without slippage or an out-of-sample test, and an independent replication finds it gross-positive, net-zero.
---

## What it says

The paper trades the direction of the first 5-minute bar of the US session on
QQQ (long after a rising first bar, short after a falling one), with a stop at
the opening range and a fixed reward multiple, and reports long-run
profitability against buy-and-hold, with leverage. Secondary summaries report a
low hit rate offset by winners several times the risk.

## Why it matters here

This project's own ORB research reached the critics' conclusion independently:
once the minutes that break both opening-range levels are handled as the live
bot would trade them, the ORB book loses (see the project notes on the ORB
both-levels flaw), and the account passes more often with ORB off.

## How to use it here

As a caution about fills more than as a strategy: a resting stop at a level fills
at the open when the market gaps through it (the engine's `entryGapFill`), and a
bar that crosses both levels has to be resolved the way the bot actually would.
strategies/orb.mjs and research/lib_orb.mjs implement it on the one engine.

## Caveats

Reported without slippage and without an out-of-sample period; an independent
replication on index CFDs (2015-2026) found results close to the paper's before
costs and indistinguishable from zero after them. Treat headline figures from
secondary summaries as unverified.
