---
title: Volatility-Managed Portfolios
authors: Alan Moreira, Tyler Muir
year: 2017
venue: Journal of Finance 72(4), 1611-1644
url: https://www.nber.org/papers/w22208
pdf: pdf/moreira-2017-volatility-managed-portfolios.pdf
tags: volatility scaling, position sizing, risk, money management
oneLine: Scale exposure down when recent volatility is high: for many factors, the same expected return arrives with less risk -- though later work questions how much survives out of sample and after costs.
---

## What it says

Scaling a strategy's exposure by the inverse of its recent variance raised
alphas and Sharpe ratios for the market, value, momentum, profitability and
other factors and the currency carry trade, because volatility moves without a
matching move in expected returns. The strategy cuts risk most in crises.
Later studies report that the gains are much weaker out of sample and can
vanish after trading costs.

## Why it matters here

It is the evidence behind sizing by volatility, which this project tested for
the Donchian bot (lot size against intraday volatility, full-stop sizing). In
the engine, `sizingMode: 'risk'` holds dollar risk per stop-out constant, which
is a form of volatility management.

## How to use it here

Compare fixed and risk sizing with MCP `compare` on 2026 and across years; the
volatility regime shift from 2019 (ATR ~6) to 2026 (~28) is the test the paper's
critics would ask for.
