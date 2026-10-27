# papers/

A research library for this project's backtesting: the methodology papers that
say how far a backtest can be trusted, the mathematics of sizing toward a
target before a floor (which is what a combine is), and the evidence behind the
strategy families traded here. Each entry is a summary in my own words with
what the paper says, why it matters here, how to use it in this project, and
its caveats -- not the paper itself.

Read them through the MCP `papers` tool (no arguments lists them, `query`
searches, `id` returns one in full), or open the files. Citations were checked
against the publishers' and indexes' records when the library was built.

PDFs, where a free author- or institution-hosted copy exists and has been
downloaded, live in `papers/pdf/` -- kept out of git, since the papers are
copyrighted. An entry's `pdf` field names its file.

## Overfitting, multiple testing and backtest protocol

| id | paper | in one line |
| --- | --- | --- |
| [benjamini-1995-false-discovery-rate](benjamini-1995-false-discovery-rate.md) | Benjamini et al. (1995), *Controlling the False Discovery Rate: A Practical and Powerful Approach to Multiple Testing* | Control the expected share of false discoveries among the findings, instead of the chance of any false discovery -- far more power when many things are tested. |
| [sullivan-1999-data-snooping-technical-rules](sullivan-1999-data-snooping-technical-rules.md) | Sullivan et al. (1999), *Data-Snooping, Technical Trading Rule Performance, and the Bootstrap* | The famous technical-rule results re-tested against the whole universe of rules that could have been searched -- strong in the original sample, gone in the decade after. |
| [white-2000-reality-check](white-2000-reality-check.md) | White (2000), *A Reality Check for Data Snooping* | A bootstrap test of whether the BEST of many models genuinely beats a benchmark, once the whole search is accounted for. |
| [hansen-2005-superior-predictive-ability](hansen-2005-superior-predictive-ability.md) | Hansen (2005), *A Test for Superior Predictive Ability* | White's Reality Check made more powerful -- studentised, and no longer dragged down by adding bad models to the comparison. |
| [romano-2005-stepwise-multiple-testing](romano-2005-stepwise-multiple-testing.md) | Romano et al. (2005), *Stepwise Multiple Testing as Formalized Data Snooping* | Not just "does the best rule beat the benchmark?" but WHICH rules do -- a stepwise bootstrap test that controls the chance of any false discovery. |
| [park-2007-technical-analysis-survey](park-2007-technical-analysis-survey.md) | Park et al. (2007), *What Do We Know About the Profitability of Technical Analysis?* | A survey of the evidence: most studies report profitable technical rules, especially in futures and FX -- but most are weakened by data snooping, ex-post rule selection and cost assumptions. |
| [marshall-2008-intraday-technical-analysis](marshall-2008-intraday-technical-analysis.md) | Marshall et al. (2008), *Does Intraday Technical Analysis in the U.S. Equity Market Have Value?* | 7,846 rules on 5-minute S&P 500 ETF data: a few dozen look significant before adjusting for the search, NONE are profitable after -- and that is before costs. |
| [bailey-2014-deflated-sharpe-ratio](bailey-2014-deflated-sharpe-ratio.md) | Bailey et al. (2014), *The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality* | How high a backtest's Sharpe ratio must be before it means anything, given how many configurations were tried and how fat-tailed the returns are. |
| [bailey-2014-pseudo-mathematics](bailey-2014-pseudo-mathematics.md) | Bailey et al. (2014), *Pseudo-Mathematics and Financial Charlatanism: The Effects of Backtest Overfitting on Out-of-Sample Performance* | The more configurations you try, the longer the history must be before the best one means anything -- and an overfit strategy tends to do worse than average out of sample. |
| [harvey-2015-backtesting-haircut](harvey-2015-backtesting-haircut.md) | Harvey et al. (2015), *Backtesting* | Replace the rule-of-thumb "halve the backtested Sharpe" with a haircut computed from how many strategies were tried -- marginal results lose almost everything. |
| [harvey-2016-cross-section-multiple-testing](harvey-2016-cross-section-multiple-testing.md) | Harvey et al. (2016), *... and the Cross-Section of Expected Returns* | After hundreds of published "factors", a new one needs a t-statistic above about 3, not 2 -- the hurdle has to rise with the number of things tried. |
| [bailey-2017-probability-of-backtest-overfitting](bailey-2017-probability-of-backtest-overfitting.md) | Bailey et al. (2017), *The Probability of Backtest Overfitting* | Estimates the chance that the configuration you picked as best in-sample is below median out of sample -- implemented in the MCP search tool. |
| [lopez-de-prado-2018-advances-financial-ml](lopez-de-prado-2018-advances-financial-ml.md) | Prado (2018), *Advances in Financial Machine Learning (book; chapters 7 and 12)* | Cross-validation for overlapping financial samples -- purge training data that overlaps the test period, embargo what follows it, and test on every combination of folds. |
| [arnott-2019-backtesting-protocol](arnott-2019-backtesting-protocol.md) | Arnott et al. (2019), *A Backtesting Protocol in the Era of Machine Learning* | A research checklist -- state the hypothesis first, count every trial, keep the out-of-sample untouched, beware of data too thin for the method. |

## Statistics of performance: Sharpe ratios, bootstraps, comparing strategies

| id | paper | in one line |
| --- | --- | --- |
| [brock-1992-technical-trading-rules](brock-1992-technical-trading-rules.md) | Brock et al. (1992), *Simple Technical Trading Rules and the Stochastic Properties of Stock Returns* | Moving-average and trading-range-break (breakout) rules on a century of the Dow beat four popular return models -- before costs, and before anyone counted the rules not chosen. |
| [politis-1994-stationary-bootstrap](politis-1994-stationary-bootstrap.md) | Politis et al. (1994), *The Stationary Bootstrap* | Resample a dependent series in blocks of RANDOM length -- the resampled series stays stationary, unlike fixed blocks. |
| [andersen-1997-intraday-periodicity](andersen-1997-intraday-periodicity.md) | Andersen et al. (1997), *Intraday Periodicity and Volatility Persistence in Financial Markets* | Intraday volatility follows a strong, regular time-of-day pattern; filter it out before modelling volatility, or every intraday measure is distorted. |
| [lo-2002-statistics-of-sharpe-ratios](lo-2002-statistics-of-sharpe-ratios.md) | Lo (2002), *The Statistics of Sharpe Ratios* | A Sharpe ratio is an estimate with a standard error, and serial correlation can inflate an annualised one badly. |
| [magdon-ismail-2004-maximum-drawdown](magdon-ismail-2004-maximum-drawdown.md) | Magdon-Ismail et al. (2004), *On the Maximum Drawdown of a Brownian Motion* | How deep the worst drawdown is expected to be over a horizon, for a given edge and volatility -- so a backtest's drawdown can be judged against chance. |
| [politis-2004-block-length-selection](politis-2004-block-length-selection.md) | Politis et al. (2004), *Automatic Block-Length Selection for the Dependent Bootstrap (and its 2009 correction)* | A data-driven choice of block length for block bootstraps, instead of picking one by hand. |
| [ledoit-2008-sharpe-ratio-testing](ledoit-2008-sharpe-ratio-testing.md) | Ledoit et al. (2008), *Robust Performance Hypothesis Testing with the Sharpe Ratio* | The right way to ask "is A's Sharpe ratio really higher than B's?" when returns are fat-tailed and serially dependent -- a studentised block bootstrap. |
| [bailey-2012-sharpe-ratio-efficient-frontier](bailey-2012-sharpe-ratio-efficient-frontier.md) | Bailey et al. (2012), *The Sharpe Ratio Efficient Frontier* | The probability that a strategy's true Sharpe ratio beats a threshold, and the minimum track record needed to show it -- longer when returns are skewed and fat-tailed. |

## Sizing, drawdown and reaching a target (the combine's own maths)

| id | paper | in one line |
| --- | --- | --- |
| [kelly-1956-information-rate](kelly-1956-information-rate.md) | Jr. et al. (1956), *A New Interpretation of Information Rate (and Thorp's survey of the Kelly criterion)* | Bet the fraction that maximises the expected log of wealth -- the fastest long-run growth; more than that grows slower AND risks more. |
| [dubins-1965-how-to-gamble-if-you-must](dubins-1965-how-to-gamble-if-you-must.md) | Dubins et al. (1965), *How to Gamble If You Must: Inequalities for Stochastic Processes (book)* | To reach a goal in an unfavourable game, play BOLDLY (stake as much as is needed); in a favourable one, play timidly -- the combine's sizing question in its purest form. |
| [grossman-1993-controlling-drawdowns](grossman-1993-controlling-drawdowns.md) | Grossman et al. (1993), *Optimal Investment Strategies for Controlling Drawdowns* | Never let wealth fall below a fraction of its peak: the optimal policy risks an amount proportional to the cushion above that trailing floor. |
| [browne-1999-reaching-goals-by-a-deadline](browne-1999-reaching-goals-by-a-deadline.md) | Browne (1999), *Reaching Goals by a Deadline: Digital Options and Continuous-Time Active Portfolio Management* | The strategy that maximises the probability of reaching a wealth target by a deadline -- the combine's exact objective -- is to replicate a digital option. |
| [busseti-2016-risk-constrained-kelly](busseti-2016-risk-constrained-kelly.md) | Busseti et al. (2016), *Risk-Constrained Kelly Gambling* | Kelly growth subject to a cap on the probability of ever falling to a set drawdown -- solved exactly as a convex problem, and better than fractional Kelly. |
| [moreira-2017-volatility-managed-portfolios](moreira-2017-volatility-managed-portfolios.md) | Moreira et al. (2017), *Volatility-Managed Portfolios* | Scale exposure down when recent volatility is high: for many factors, the same expected return arrives with less risk -- though later work questions how much survives out of sample and after costs. |
| [note-combine-first-passage](note-combine-first-passage.md) | result et al. (2026), *Note: the combine as a first-passage problem* | With no edge, the chance of reaching the target before the drawdown is about room / (room + target), whatever the win rate; with an edge, less noise per dollar of edge helps, until the time limit bites. |

## Strategy evidence: technical rules, breakouts, intraday structure, trend

| id | paper | in one line |
| --- | --- | --- |
| [osler-2003-currency-orders-round-numbers](osler-2003-currency-orders-round-numbers.md) | Osler (2003), *Currency Orders and Exchange Rate Dynamics: An Explanation for the Predictive Success of Technical Analysis* | Take-profit orders cluster AT round numbers (prices reverse there); stop-loss orders cluster just BEYOND them (trends accelerate once through). |
| [moskowitz-2012-time-series-momentum](moskowitz-2012-time-series-momentum.md) | Moskowitz et al. (2012), *Time Series Momentum* | In 58 futures markets, an asset's own past 12-month return predicts its next month's -- persistence for up to a year, partly reversed later. |
| [holmberg-2013-opening-range-breakout](holmberg-2013-opening-range-breakout.md) | Holmberg et al. (2013), *Assessing the Profitability of Intraday Opening Range Breakout Strategies* | An academic test of the opening range breakout on futures -- success rate and returns against a fair-game benchmark, using only information available at the time. |
| [kaminski-2014-stop-loss-rules](kaminski-2014-stop-loss-rules.md) | Kaminski et al. (2014), *When Do Stop-Loss Rules Stop Losses?* | Under a random walk a stop-loss always lowers expected return; it only adds value when returns have momentum (serial correlation) -- the stop is a bet on the process. |
| [hurst-2017-century-of-trend-following](hurst-2017-century-of-trend-following.md) | Hurst et al. (2017), *A Century of Evidence on Trend-Following Investing* | Time-series momentum across 67 markets back to 1880: positive in every decade, low correlation to stocks and bonds, best when markets move together least. |
| [gao-2018-market-intraday-momentum](gao-2018-market-intraday-momentum.md) | Gao et al. (2018), *Market Intraday Momentum* | The S&P 500 ETF's first half-hour return (from the prior close) predicts its last half-hour return -- more so on volatile, high-volume and news days. |
| [baltussen-2021-hedging-demand-intraday-momentum](baltussen-2021-hedging-demand-intraday-momentum.md) | Baltussen et al. (2021), *Hedging Demand and Market Intraday Momentum* | Across 60+ futures since 1974, the rest of the day's return predicts the last 30 minutes -- driven by option dealers and leveraged ETFs hedging short gamma. |
| [zarattini-2023-opening-range-breakout](zarattini-2023-opening-range-breakout.md) | Zarattini et al. (2023), *Can Day Trading Really Be Profitable? Evidence of Sustainable Long-term Profits from Opening Range Breakout (ORB) Day Trading Strategy vs. Benchmark in the US Stock Market* | A 5-minute opening range breakout on QQQ reported as profitable over years -- but without slippage or an out-of-sample test, and an independent replication finds it gross-positive, net-zero. |
| [barbon-2024-beat-the-market-intraday-momentum](barbon-2024-beat-the-market-intraday-momentum.md) | Barbon et al. (2024), *Beat the Market: An Effective Intraday Momentum Strategy for S&P500 ETF (SPY)* | Trade with a breakout from a "noise area" around the day's open -- built from how far price typically moves from the open by each minute -- with a trailing stop. |

