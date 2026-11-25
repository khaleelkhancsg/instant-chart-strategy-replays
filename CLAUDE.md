# MNQ Chart Lab — notes for Claude

A 30-day prop-firm combine backtester on 7 years of MNQ 1-minute bars. One engine
(`src/`) runs in Node, in the browser chart and behind the MCP tools, so a number
from any of them agrees with the others.

## Research through the MCP tools, not one-off scripts

`.mcp.json` registers the `mnq-chart-lab` server (`node mcp/server.mjs`). Its tools:

| tool | answers |
| --- | --- |
| `list_strategies`, `describe_strategy` | what exists, every parameter, the notes at the top of each file |
| `list_studies` | the indicator studies any configuration can add: parameters, timeframes, gates |
| `backtest` | trade stats; by year, exit, entry hour, weekday, direction and volatility; daily Sharpe, PSR and MinTRL |
| `pass_rate` | combine pass rate by period, `calendar` and/or `bootstrap`, each with a ci95 |
| `compare` | two configurations on the same windows, paired, with months won |
| `search` | a grid ranked in-sample only, with out-of-sample, purge, rank correlation and PBO |
| `walk_forward` | whether re-choosing from a grid month by month beats holding the base configuration |
| `sensitivity` | how far the pass rate moves when each setting is nudged (knife-edge check) |
| `window`, `bars` | one 30-day window in detail (with `explain`: why each trade entered); raw bars |
| `chart_state`, `chart_apply` | read and drive the chart page the person has open, Tradovate indicators included |
| `papers` | the methodology library in `papers/` |

Every configuration also takes:
- **`eval`**: `"3000"` (the default; $3,000 target, $2,000 drawdown, $1,000 daily
  limit) or `"1250"` ($1,250, $1,000, $600). `src/evals.mjs` `evalBase` layers the
  firm's numbers, the platform loss cap where a book models one, and a strategy's
  own `evals` settings.
- **`studies`**: indicators from `src/studies.mjs`, each `{type, tf, params, gate}`.
  - With `gate: "off"` they only report: `backtest` returns `byStudy`, the trades
    split by each study's state at their signal.
  - With a gate they refuse entries.
  - `search` / `walk_forward` / `sensitivity` vary them through keys like
    `studies.0.params.lo`.

When a question needs something the tools cannot do, write the script against
`src/` (`runStrategy`, `replayWindow`, `src/dayeval.mjs`). Never copy engine or
rule logic into a script: that is a second engine, and it drifts.

## House rules for any number reported

- **Judge on 2026, and check inside 2026**: Jan–Mar vs Apr–Jul. The tools' default
  periods do this; all history is context.
- **Name the eval** a pass rate is for: $3,000 or $1,250. The same book can rank
  very differently on the two.
- **An indicator edge is a lead, not a result.** `byStudy` / the Indicator edge
  panel split the full run's trades; a gate also changes the trades that follow.
  Confirm a gate with `pass_rate` or `compare`, and with `search` / `walk_forward`
  if its settings were chosen.
- **Name the pass-rate method.**
  - `calendar` is the chart's sweep: a window started on every day of the grid
    (`bars.ts[0] + k days`), each replayed with the full rule set.
  - `bootstrap` is research/lib_shipped's: 12,000 draws of 21 trading days in
    5-day blocks, seed 4242. It is about 1 point above calendar on the shipped book.
  - Back to back (`research/eval_back_to_back.mjs`) is one account: each eval starts when the
    last ends.
    - Each outcome counts as often as it fits in its time, so quick failures count more and
      30-day run-outs count less.
    - `donchian_1250` in 2026 on live equity: 52.0% back to back against 57.7% calendar.
      Jan 1-Jul 14: 58.7% against 70.3%.
    - On closed trades it matches calendar or sits above it (67.8% against 63.2%).
    - Calendar answers "one attempt on a random day". Back to back answers "the share of my
      evals that pass if I keep going".
- **Quote the ci95.** Neighbouring windows share most of their days, so 2026 holds
  only about 5.5 independent 30-day samples. A 10-point gap in 2026 can be noise.
  `sensitivity` shows 2026 rates swinging ±20 points on small parameter nudges.
- **Include costs.** One tick a side of slippage and $0.75/side/contract is the
  realistic baseline. The tools warn when a configuration has none.
- **Grid searches:**
  - rank on in-sample only, and report out-of-sample and PBO alongside;
  - test re-optimising itself with `walk_forward`;
  - on the shipped book, re-choosing monthly from a 3×3 grid of `effMin` and
    stop width scored 27.3% out of sample in 2026, below the 32.1% of holding the
    base.

## Verdict rules: screen, confirm, forward (2026-11-23)

What it takes for an idea to count. Every research verdict in this lab uses this funnel.
- **Screen (stage 1), on the data the idea came from:** it beats 90 of 100 placebo markets
  (about p 0.10), in BOTH halves of the period (2026: Jan-Jun and Jul-Oct, or Jan-Mar and
  Apr-Jul), after costs. Passing promotes it to confirmation. It is not a result.
- **Confirm (stage 2), on data not used to find or tune it:** freeze the exact rules and the
  test in writing first, run once, and beat 95 of 100 placebo markets (p 0.05) or stricter.
  - Data not used: another year (2019-2025 for a 2026 idea, 2026 for an older one), or bars
    after the hold-out.
  - No changes after seeing the result. A changed rule goes back to stage 1.
- **Forward (stage 3):** paper or live data the research never saw, with the rules fixed. Write
  the kill rule in advance (e.g. drawdown beyond the backtest's worst). Only this counts as final.
- **Count every variant tried** on a dataset, and quote it beside any best-of result. The
  more tried, the bigger the margin needed: published research asks t > 3 for a new factor
  (Harvey, Liu & Zhu 2016). Use the Deflated Sharpe or PBO (`search`) when choosing among
  many.
- **A test added after looking is a lead, never a verdict.** Say so whenever you quote one.
- **Every idea needs a reason:** who is on the other side, or what forced flow or structure
  makes it work. Mined patterns with no reason need a stricter confirmation.
- The ledger of what has been tried, and its verdicts, is `critic_loop/LEDGER.md` and
  `critic_loop/RULED_OUT.md` (outside this repo).

## Engine conventions (src/engine.mjs)

- **No trade sees the future: proven end to end** (`research/lookahead_audit.mjs`, 2026-11-21).
  - The whole pipeline runs again on data cut short at each 2026 trade's entry bar, at its exit
    bar, at 400 signal bars (gate refusals included) and at 150 random minutes. Every trade and
    signal the cut data could know matches the full run to the cent.
  - The three bot books pass every cut: 198, 244 and 285 trades. So do all 35 other strategies,
    on signal and random cuts.
  - The audit catches two planted peeks: acting a bar early, and the day's final range. Random
    cuts alone catch neither, which is why it cuts at signals, entries and exits.
  - test.mjs section 7 keeps a sampled copy for the three books, with the one-bar-early canary.
  - It cannot see a factor built outside `compute()` from the whole file, such as a day's VXN
    factor. Read those by hand: the VXN close dated before the session, the prior session's
    close.
- **`DEFAULT_EXEC` is the physically consistent model:**
  - an exit decided at a bar's close fills at the next open;
  - a bar can stop out the trade it filled;
  - gaps fill at the open;
  - a session that closes early is flattened at its last bar;
  - a platform day cap ends the day;
  - a new session never acts on the previous session's last signal.
- **`LEGACY_EXEC` reproduces pre-consolidation results.** The `research/lib_*.mjs`
  adapters use it. `test/legacy_parity.mjs` holds them to frozen oracles in
  `test/oracles/`, so an adapter's numbers change only when an oracle is regenerated
  on purpose.
- **`sameBarReentry` is non-causal.** It re-enters at an open that came before the
  exit, and the MCP refuses it.
- **Indicator gates (`entryGate`) refuse entries only.** The refused signal still
  flips an opposite position and cancels a working order. Studies read their last
  CLOSED bar (`closedIndexMap`, clock-based like a live bot).
- **A trade's `mae` / `mfe` count its exit bar only up to the exit** (`exitBarExcursion`
  'toExit'; `LEGACY_EXEC` keeps 'bar', the whole bar).
  - Nothing of the bar counts after an exit at its open.
  - A stop inside the bar counts the adverse side only to the fill, and a target the
    favourable side only to the target. The bar's other extreme stays in.
  - The exit's own fill always counts, so a stop booked on a stop entry's fill bar dips at
    least to it.
  - `evaluateOn: 'intraday'` reads these. test.mjs section 3 works the cases and checks
    the exit invariant on random walks.
- **`staleBars` / `staleMfeAtr`** leave a trade at the next open once it has run
  that many bars without being that many ATRs in favour. It is the $1,250 bot's
  40-minute exit, and the research's `exitFn` trade for trade.
- **A strategy's `sizeMult`** (from `compute()`, per bar, read at the signal)
  multiplies the size, rounded and at least 1. `0` refuses the entry the way a gate
  does, so the signal still flips. `donchian_1250` uses it for the 10-minute EMA
  filter and its late half size, and `macd_fade_1250` for its weak-cross and
  volatility gates, as the research's sizers did. Under risk sizing it multiplies the
  dollar risk before the lots are rounded and capped, so a quarter of a capped A trade
  is still a quarter of the risk (`cammy_value_levels` sizes its grades and `sizeX` so).
- **`tpMaxUsd`** caps the target at that many dollars for the size traded, as the
  MACD fade's `min(5.15 ATR, $600 / (2 x lots))`.
- **A strategy's own orders**: `orderPx`, `stopPts` and `targetPts` from `compute()`,
  per signal bar. NaN leaves that signal to the configured entry.
  - The order rests on the bar after the signal only, from its open.
  - It is a limit when its price is on the passive side of the signal bar's close, and
    a stop when not. So the coin-flip twin's opposite order fills on the same bar at the
    same price.
  - The bracket is measured from the order's price, and risk sizing divides by its stop.
  - `cammy_value_levels` rests its limits this way. test.mjs 3b works the cases by hand
    and section 8 fuzzes them.
- **`dayMaxWins` / `dayMaxLosses`**: no new orders, and working ones cancelled, once the
  day has had that many winning or losing trades, counted by net P&L (0 = off).
- **`onSignal(k, dir, what, info)`** reports what became of each signal: entered,
  armed then filled / replaced / cancelled / expired, flipped, held, ignored,
  dropped, refused (with `why`). It observes only; test.mjs section 17 holds the
  trades identical with it on. `runStrategy({ trace: true })` collects it as
  `signals`.
- **Day caps and overnight holds.** `dayLossStopUsd` and `dayProfitStopUsd` measure
  an open position from its fill, so use them with intraday-only books.
- **Red-folder news** (`newsRule` 'off' | 'noentry' | 'flat', `newsBeforeMin`,
  `newsAfterMin`). The engine reads only `newsMask`, one flag a bar, which runStrategy builds
  from `src/news_calendar.mjs` (`src/news.mjs` `newsWindowMask`; `opts.newsEvents` swaps in a
  placebo calendar). A bar that overlaps a window at all is inside it. 'noentry' refuses entries
  and cancels working orders and resting adds; 'flat' also closes at the window's first open with
  reason NEWS. A rule with no mask throws rather than being ignored. test.mjs sections 8 and 12
  fuzz it: no entry in a window, nothing held into one under 'flat', and live = sweep.
- **The calendar is built, never edited** (`node research/news_build.mjs` from the official
  sources in `research/news/`, whose README says where each came from). `test/news.test.mjs`
  fails when `src/news_calendar.mjs` is not what the sources build.
- **A strategy's `warmupBars` / `warmupSessions` cover everything `compute()` reads.** That
  means ten lengths of an EMA and twenty of an RSI, whose averages move 1 / length a bar. A
  value that stands still exactly must not be left to rounding (an RSI on an unchanged close).
  test.mjs section 10 starts the bars exactly that far before a cut and wants every output and
  filter verdict after it to be the full run's; section 14 does the same for studies.
- **After any engine change:**
  - run `npm run check` and a few fuzz seeds;
  - re-measure every strategy's defaults;
  - say what moved.

## Tests

- `npm run check`: test.mjs (505), audit, legacy parity (15), MCP end to end (19),
  chart link (13), the indicator mock (101, `npm run test:mock`), the page's arithmetic
  (42, `npm run test:ui`), the level study's engine (23, `npm run test:levels`), the raw
  store (36, `npm run test:store`), the Data panel's routes (21, `npm run test:data`), the
  TopstepX pull (44, `npm run test:pull`), red-folder news (17, `npm run test:news`), the $1,250
  Tradovate indicators (41, `npm run verify:tradovate`, about 2 minutes).
- `FUZZ_SEED=<n> FUZZ_SCALE=<k> node test.mjs`: the randomised invariants.
- `PARITY_SEED`, `PARITY_SCALE`: the same for test/legacy_parity.mjs.

## The chart

- `node server.mjs` serves http://localhost:5178; the preview config is "chart-lab".
- **What a request says can never stop the server.** It listens on the whole network, and
  an async handler that throws ends the process. So the URL is parsed against a fixed base, never
  the request's `Host`, and everything else a request controls stays inside the handler's `try`.
- **Restart the server after editing `src/` or `strategies/`.** Node loads them
  once, while the page fetches the new files. Until then the page's window and
  the server's sweep run different code and disagree.
- The page posts what it shows to `/api/chart/state`, and `chart_apply` pushes
  changes it applies.
- The address bar carries the strategy, the window, the eval, the indicators and
  every changed setting
  (`#s=donchian_shipped&d=2026-03-09&e=1250&st=emacross:10::with&x.slippageTicks=1`),
  so a view can be shared or restored.
- With no link, a visit opens where the last one left off, zoom included
  (localStorage `mnq.last`, `mnq.view`). A first visit opens on `donchian_1250`,
  the $1,250 eval, in 2026.
- **`public/ui.mjs` is the page's arithmetic, with no DOM,** and `test/ui.test.mjs`
  runs it in Node. Put new logic there; `chart.js` draws and `app.js` wires. Browsers
  are not part of `npm run check`, so check anything else on the page itself.
- **Everything leads with 2026:** the top bar's figure, the line under the navigator
  and the head of "All windows", with all history below as context. The navigator
  shows 2026 alone unless "All" is picked.
- **Compare runs** keeps each finished sweep as a small record, one letter per window
  (`runRecord`), in localStorage only. A pinned baseline is paired with the current
  run date by date, as the `compare` tool does: the two have been checked equal on
  every period. `chart_state` carries it as `baseline`.
- **Which bars:** the Data selector under the title picks `latest` (`data/mnq_1m_beta.bin`, the
  default) or `main` (frozen at Jul 14, the published figures). The server holds both and reads
  latest again when a rebuild replaces it; every request names one (`?data=` on /api/meta and
  /api/window, `data` in the sweep's body, `main` when absent), and the link carries it. On
  latest, `houseRates` gives windows from Jul 15 their own period (`fwd`, "since Jul 15"), and
  Apr–Jul also counts windows starting Jun 15 – Jul 14 that run into the forward bars, so it reads
  lower than the published 73.3. `chart_state` reports `data`; `chart_apply` takes it.
- **Time:** the axis and crosshair read Chicago time, worked out from each bar's
  `ctMin`. `chart_state` and the CSVs stay in UTC.
- **Split and pop-out** (`app.js`):
  - `S.chart2` is a second ChartView on the same run.
  - A pop-out is the same page at `?pop=1&tf=M` (`POP`). It is one chart, saves nothing to
    localStorage, posts no state and runs no sweeps.
  - It follows the main window through `BroadcastChannel("mnq-chart")`: `state` carries the hash,
    `hover` the crosshair's `{ts, price}`.
  - Crosshairs link by bar time, never by index, because windows load different warm-ups.
- **Each chart draws its own indicator set** (`MAIN_SET`, `RIGHT_SET`, `POP_SET` in `app.js`).
  - `MAIN_SET` is `S.studies` / `S.tv`: the run reads it (gates, the edge), and the hash and
    `chart_state` carry it.
  - The others are for looking only: their studies' gates stay off, so every chart shows the same
    trades. Their warm-up is still loaded (`lookStudies`).
  - `RIGHT_SET` is kept in localStorage `mnq.right`, and `chart_state` reports it as `rightChart`.
    `POP_SET` is kept in the pop-out's own query (`pst`, `ptv`). In a pop-out, `S.studies` still
    holds the main window's set, run but not drawn.
- **The plain chart** (`strategies/plain_chart.mjs`, `chartOnly: true`) has no signals.
  - The page hides the P&L panes, the trade figures and the strategy's own gates, and runs no sweep.
  - `research/strategy_table.mjs` skips it, and the picker lists it first.
- **Frames** are under 7 ms on every strategy at the full window. Keep it so: a frame
  must not sort, and zoomed out each pixel draws one thing (`nthSmallest`, the
  histogram's columns, dots for dense trades).
- **A book that holds overnight loads all of history** (src/window.mjs), so its re-run
  takes up to 0.8 s and happens on a pause, not on every step. That cost is the price
  of matching the sweep. A slow Tradovate indicator gets the same treatment.
- **Data lives in the raw store, `data/store.db`, and the engine never reads it.**
  `store.mjs` and `src/store.mjs` hold it, `src/series.mjs` is the one build, shared with
  `prepare.mjs`, and `store.config.json` says what gets built. `npm run data:add`, `data:pull`,
  `data:status`, `data:build`, `data:backup`.
  - `data/mnq_1m.bin` is frozen: Databento only, to Jul 14 2026. Every published figure was
    measured on it, and `data:build` refuses a difference without `--force`. Never move its
    date without re-measuring and saying what moved.
  - `data/mnq_1m_beta.bin` adds Databento Jul 15 - Sep 11 (`data/raw/databento/`, added Nov 2)
    and TopstepX after, to Oct 30 with no gap. The chart reads it through its Data selector; the
    MCP tools do not, and sweeps do not skip windows across a gap (there is none now).
  - **TopstepX keeps 1- and 5-minute bars for only 60 days.** `npm run data:pull` saves them, and
    `data:status` gives the date to pull by.
  - **The ⚙ Data panel** (`public/datapanel.js`, `src/datajobs.mjs`) runs that same `store.mjs` as
    a process of its own, one at a time, so a rebuild never holds up the chart. What the status
    means is in `ui.mjs` (`dataNotes`, `heldRows`, `compareText`, `jobText`), and its backup folder
    is in `data/store.settings.json`, git-ignored.
  - **Every `/api/data/` route stays behind `fromThisMachine`.** They read and write files, and
    the server listens on every interface. `--force` has no button, on purpose.
  - **Test the panel on a copy.** `test/data_routes.test.mjs` runs the real routes and the real
    `store.mjs` on a temporary folder, and `dataRoutes` takes `here` and `run` for that. Nothing
    but `bot/test_pull_topstepx_raw.py`'s fake gateway stands in for the API.
  - **`fileProblem` refuses a file before a row goes in,** because nothing can take one back out.
    Add to it, not to the build, when a new kind of bad file turns up.
  - **Keep a status read under a second.** It runs each time the panel opens, so it hops the
    primary key (`coverage`, `heldBars`) rather than reading every bar.
  - `data/topstepx_1m.bin` is what the forward tests read, as saved on Oct 27, and nothing
    rebuilds it. `data/topstepx_raw_1m.bin` is the percent study's, built by `prepare.mjs`.
- Strategy table for the README: `node --max-old-space-size=8192
  research/strategy_table.mjs`. The README's other figures come from
  `research/readme_figures.mjs`.

## The $1,250 books, and testing a new one

- **`donchian_1250` is the $1,250 bot whole and the book to beat.**
  - 2026: calendar 74.5%, bootstrap 71.1%.
  - Forward, Sep 10 - Oct 26 2026: +$2,532, every window passed.
  - Forward over everything after the lab's data, Jul 15 - Oct 30 (77 days, the beta file):
    +$2,584, PF 1.24, but 44.2% of windows (calendar), against its coin-flip twin's 44.9%. Jul 15
    - Sep 9 netted -$15; August -$1,163. Its edge over a coin flip is not established forward.
- **`macd_fade_1250` reproduces the research's 67.7% exactly, but lost forward.**
- **`trend_pullback`, `orb_trend` and `macd_momentum` are the indicator
  combinations.** Each was tuned on 2026, and none held forward. Their headers
  carry the numbers.
- **`cammy_value_levels` (Cammy Capital's volume profile strategy) has no edge.**
  - At Cammy's own risk (`sizeX` 1) no window ends inside 30 days. Its default, 5x, is the
    least at which most of 2026's windows end. There it passes 34.5% of them and placebo
    markets pass 31.8%; forward, 42.9% against 36.2%.
  - It beats every coin-flip twin, but placebo markets match it. Its 60% win rate is the bar
    a limit fills on, whose target counts whenever that bar's high reached it (76 of 168).
  - No version of its 41 holds by the worse half. A POC as an entry even unstacked is a lead
    (forward 80.5% against placebo's 44.9%), not a result.
  - `research/cammy_protocol.mjs` runs it all (about 40 minutes); its header has the figures.
- **The protocol** (`research/lib_eval1250.mjs` scores it, through `mcp/lab.mjs`):
  - score 2026 by both methods, and in both halves;
  - pick on one half and read the other;
  - choose by the worse half;
  - check the neighbours;
  - compare with the coin-flip twin (`nullCfg`);
  - **for a book that rests limit orders, use placebo paths instead** (`research/lib_levels.mjs`
    `placeboBars`, as `research/cammy_protocol.mjs` does). Flipped, a buy limit is a sell stop
    at the same price, and on the bar they fill the engine credits the limit's target where it
    charges the stop's stop. Such a book beats every twin on a random walk;
  - quote per-trade figures when nothing passes: a book sized below the target's reach scores
    0% everywhere, and its pass rates rank nothing;
  - then run `research/forward_1250.mjs`: `FORWARD_FROM=2026-07-15` with `data/mnq_1m_beta.bin`
    scores everything after the lab's data, 77 days nothing was chosen on. With no arguments it
    reproduces the published Sep 10 - Oct 26 run on `data/topstepx_1m.bin`.
  - Grids go in `research/combos_1250_new.mjs`; single-factor screens of the
    shipped books in `research/combos_1250.mjs`.
- **A book that wins in 2026 but not in the half-split or forward is selection,
  not edge.** That is the record here: every large 2026 grid's best fell apart on
  the other half.

## Entry explanations (`src/explain.mjs`)

Every strategy's `compute()` returns `explain(k)`. That is the chart's entry
card, the signals layer's tooltips, the `window` tool's `explain` and
`chart_state`'s `explained`.
- **Each condition's `pass` is the signal loop's own expression**, NaN handling
  included. For example, `!(adx < min)` where the loop skips `adx < min`, but
  `adx >= min` where it skips `!(adx >= min)`.
- **Derive the verdict with `verdict(cand, checks)`.** Return `size` when the
  strategy returns `sizeMult`.
- **Marks** use the strategy's bar indexes, or time for a longer timeframe's bar.
  None may reach past bar k.
- **State a loop carries is replayed from the session's start or the latest
  cross.** That covers the one-per-side ORB slots, the gap's first window price
  and a MACD build. Never read it from later bars.
- **A book that wraps another and changes `sig` must return its own `explain`.**
  Spreading the base's output carries the base's explain with it, which would
  describe the wrong signal.
- **Shared families have helpers there:** `donchianAdxExplain`, `channelBreak`,
  `consensusExplain`, `htfTrend`, and the cross, ADX and ADR pieces. The MACD
  families' helpers live in `macd_1m_flip`, `macd_1m_fade` and
  `macd_5m_anticipate`.
- test.mjs section 17 checks a new strategy automatically:
  - the verdict equals `sig` and `sizeMult` on every bar, at the defaults and at
    random settings;
  - no failing condition on a bar that fired;
  - nothing changes when later bars exist;
  - no mark past the signal bar.

## Looking at a Tradovate indicator

`tradovate/mock/` is a mock of Tradovate's indicator runtime, drawn on this project's
own chart. Use it for any new or changed indicator, before calling it finished.
Nothing external is involved: no API, and no page outside the chart.

- **Check it:** `npm run mock -- <name> --date <day>` prints the problems, how its
  labels fit on that day, and a link to the chart. `<name>` is a file in `tradovate/`
  or `../TradingCustomIndicators/tradovate/`, or `builtin:<name>`.
- **Show it:** open that link in the preview ("chart-lab"), zoom to about 6 px a bar
  (the indicator's card shows the figure), and screenshot it. The person can open the
  same link themselves, or use **Tradovate indicators** in the sidebar.
- **Iterate:** edit the `.js`, press ↻ on the card, read the overlap count. That count
  is how a label layout gets judged, not a guess from the source.
- **On the chart** an indicator is a study with a `tv` field: panes, the crosshair and
  the price scale treat it like any other, and `ChartView._drawTradovate` draws it
  through `tradovate/mock/draw.mjs`.
- **The runtime** (`runtime.mjs`) follows Tradovate's definitions, and `vendor/` holds
  its real tools and built-ins. `test/mock.test.mjs` runs all of them through it, so a
  rule that a built-in breaks is the rule that is wrong. `tradovate/mock/README.md`
  lists what is an assumption.
- `tradovate/verify_1250.mjs` runs on this same runtime: there is one emulation.

## Adding an indicator study

- Add an entry to `STUDIES` in `src/studies.mjs`: name, group, pane, kind (`price`,
  `trend`, `band`, `osc`, `level`), params, warm-up, gates, levels, and a causal
  `compute(bars, params)`.
- Price levels are built in `src/levels.mjs`: `out[i]` may use bars up to i only. A
  band can return `mid`, which is what reads 0.5, as a profile's POC does.
- test.mjs section 14 then checks it for lookahead, its warm-up and live = sweep
  automatically. The warm-up check starts the bars exactly the declared warm-up before a
  cut and wants every reading and gate verdict after it to be the full run's, so:
  - state kept until an event (a side, a level, a swing) lapses inside the warm-up:
    `HOLD` in src/studies.mjs;
  - a recursion that never settles (Supertrend's bands, the SAR) runs afresh in blocks of
    whole weeks, each bar reading the run begun a block earlier (`blockRuns`);
  - a running sum adds only values exact in binary (prices on the tick grid, whole
    volumes, H + L + C rather than its third), or the window is summed afresh each bar.
- A new kind of computation (not built on `src/indicators.mjs`) also gets a naive
  reference test there, as VWAP and the day levels have.

## Testing a level

`research/lib_levels.mjs` is the level study's engine, run on any line a study draws.
`levels_catalog.mjs` lists 215 levels and the pools of related ones.

- **In this order:** `levels_placebo.mjs` (10 minutes, others read its results), then
  `levels_study.mjs`, `levels_stress.mjs`, `levels_theories.mjs`, `levels_gates.mjs`,
  `levels_books.mjs`. `levels_replicate.mjs` checks the engine against the original study.
- **Shifted twins are not enough on their own.** They are fair for a fixed level, but a
  line that depends on the path can fool them: a flipping Supertrend once showed +19.6 on
  real bars, 45 of 45 definitions and the forward bars agreeing, and +18.6 on placebo
  markets. `placeboBars` flips each bar at random, so nothing a level could use is left,
  and each level is judged against its own placebo edges. Run any surprising result
  through this before believing it.
- **The bar:** q under 0.10 across everything tested, 40 or more touches, the same sign in
  both halves, then the forward bars.
- **A touch is price reaching the level.** A line jumping over price is not one.
- **The sample's reach:** about 13 points of bounce rate on one level, 7 on a pool.
- **Result (2026):** no level passes. See `research/levels_stress.mjs` for the figures.

## Percent levels

`src/levels.mjs` builds them on each contract's real price (`rawOffsets`, from `bars.rolls`),
and the chart's "Percent levels" group draws them. `strategies/pct_levels.mjs` trades any of
them, and `strategies/noise_area.mjs` is the published noise-area breakout. `research/pct_*.mjs`
is the study, on `data/topstepx_raw_1m.bin` for the forward bars (`lib_pct.mjs` says how to build it).

- **A placebo path keeps the market's real price.** It has no drift, so it wanders away from
  the rally that really happened, and the same points then read as a different percentage.
  `placeboBars` carries `rawOff`, so `rawOffsets` gives the real price on a path. Flipping whole
  days must leave every day's range alone (`test/levels.test.mjs`). Use it on any percentage.
- **Four places had missed it (fixed 2026-11-21).** The back-adjusted close sits about 3,600
  points above the real one in 2020-2022, so a percentage of it read about a quarter low there.
  - `roc` in `src/indicators.mjs` takes the offsets as a third argument. It feeds
    `momentum_roc`, the ROC study and `tpl_consensus`'s ROC family. `momentum_roc`, 2019-2026:
    12,401 trades become 15,307, PF 1.018 becomes 1.002. On the $1,250 eval its 2026 rate
    goes from 24.8% to 22.4%.
  - `research/vxn_regime.mjs`'s range percentages and `research/regime_by_year.mjs`'s ATR %.
  - `research/anticipate_gates.mjs`'s ATR% and ADR% gates. Nothing there passes.
- **2026 is the widest year in points, not in percent.** The 5-minute ATR in % of the real price
  was 0.140 in 2020, 0.147 in 2022 and 0.104 in 2026. Points (and dollars a contract) are what
  the evals feel, so 2026's sizes fit 2026. But a 2022-sized move at today's price would be
  about 1.4 times the 2026 swing.
- **A rate means nothing without its placebo rate.** Most of what traders quote about ranges and
  gaps is geometry: `research/lib_pct.mjs` `testRates` sets any rule beside noise.
- **The footprint test sees what a bounce test cannot** (`research/pct_footprint.mjs`): volume and
  range at a touch against the level's twins, with the levels people are known to watch as controls.
- **The odds ladder needs no R and no twins** (`research/pct_ladder.mjs`): from any rung, the next
  rung up or down is a coin flip on a random walk.

## Regime bias

`research/regime_bias.mjs` tests whether a long/short bias can call the next bar's move.
- **What it covers:**
  - twenty biases (EMAs, VWAP, crosses, moves, Donchian, MACD three ways, ADX, Supertrend,
    RSI) and two measures of how hard price leans;
  - 5-minute to weekly bars;
  - each calendar year from 2019 alone, as the person asked.
  - It writes `research/regime_bias_results.json`.
- **Judge a long-minus-short edge against placebo markets, never a slide null.** The raw edge
  leans negative on its own. A move against a persistent bias flips it, which shrinks that
  move's own group and weighs it more, and five placebo runs showed the lean as strongly as the
  real bars. So each cell is set against the same cell on 100 placebo markets, and the counts
  against each placebo market judged against the others. 20 placebo markets gave p-values
  too coarse to read.
- **Result:** nothing beats random markets taken together.
  - 47 of 1,090 year-cells are significant, where placebo markets give 14–114 (median 60).
  - Of 28 timeframe p-values, one is under 0.05 (luck gives 1.4): the daily trend held
    through the next NY session is wrong every year for two biases, p 0.01.
  - The lead is price against the week's VWAP on 15-minute bars: above its placebos and
    profitable after costs on one MNQ in all eight years, found after the fact.
  - 5-minute reversal is real, but about 0.3 points a bar: far under costs.

## Which eval: $1,250 or $3,000

- **Four scripts answer it** (fees: $58 and $96 a month):
  - `research/eval_choice_regime.mjs`: the two live Donchian bots through each eval and on
    to a first payout, on Aug 1 – Oct 30 2026 bars, with twins and placebo markets;
  - `research/eval_size_fees.mjs`: 1–8 lots on 2026, with attempts running up to four months
    at a fee a month;
  - `research/eval_volatile_day.mjs`: 2026-06-09, the widest session, and days at the limit;
  - `research/eval_choice_geometry.mjs`: coin-flip trades with no strategy.
- **Judge the drawdown on live equity** (`evaluateOn: 'intraday'`; `simulateFunded` takes it
  too). On closed trades, 7 lots on the $3,000 eval looked 41.7% unresolved, and those windows
  fail on live equity.
- **Score small sizes with fees, not 30-day windows.** A month-long window calls a slow
  attempt "unresolved" when in truth it costs another month's fee.
- **Result:** with no edge, the chance of a payout per attempt is about the same on both, and
  the $3,000 eval's payouts are about twice the size. At $58 against $96:
  - the $1,250 eval gets a payout for about 0.6 times the fees ($420–740 against $650–930);
  - dollars back per dollar of fees come out even.
  - Best sizes: 1–4 lots on the $1,250 eval, 2–6 on the $3,000 eval. 1 lot is the $3,000
    eval's worst.
- **A longer eval does not let a smaller size pass more** (`research/eval_45_days.mjs`,
  `donchian_1250`, 2026 Jan–Oct, live equity, every day, 30 calendar days against 45 trading
  days):
  - 4 lots 57.7% → 55.0%; 3 lots 59.6% → 59.2%; 2 lots 47.4% → 45.8%; 1 lot 11.4% → 40.3%.
  - At 2–4 lots the extra days turn running out of time into failures.
  - The bootstrap reads long windows kinder (2 lots 41% → 64%), because its shuffled blocks
    break up the bad stretches.
  - The cut-only dollar rule (3.3 lots a trade) gave 65.1% at 30 days and 60.4% back to back,
    against 57.7% and 52.0%. Only Jul 15 on is out of sample for it.

## The EMA + MACD databox

`research/databox_predict.mjs` runs the indicator file itself through the mock (a wrapper on
`calc.map` reads `calc.st[i]`), so its states are the indicator's own.
- **It finds no predictive ability on 1m, 5m or 1m + 5m in 2026,** against 100 placebo markets,
  at EMA 12/26 and MACD 12/26/9 (the defaults since 2026-11-21) as at 9/21.
  Its control, the 5-minute reversal, shows at z −2.
- **The warnings lean the wrong way where they lean at all.**
  - The EMA row warns when its gap closes faster than the bar before (since 2026-11-21). The
    first rule, any closing gap, contradicted the MACD row on fading bounces; `closer` keeps it.
  - Under the new rule, the 5m EMA "Potentially long" was followed by −2.65 points over 15
    minutes (z −3.3, all three periods, shrinking). That is reversal, found after the fact:
    a lead.
- **Read as a bot's alerts, its flips reach 10 points no faster than any minute does**
  (`research/databox_ten_points.mjs`). It covers the EMA row, the MACD row and both rows, on 1m
  and 5m, 2019-2026.
  - Each alert is followed from its bar's close to 15:05 CT, against every New York minute
    entered both ways.
  - 2026, 1m both rows: 92% reach +10, in 11 minutes on average (median 2). They go 18-20
    points against first (median 10, 1 in 10 past 50), and +10 comes first 45.5% of the time.
    Every minute: 92%, 11.1, 17.5-20.1, 46.0%.
  - Every year and kind matches its baseline, long against random longs and short against random
    shorts. The exception is 2026's 5m alerts, a little worse (+10 first 41%): the reversal
    lean again.
  - `--pct` holds the target to the same share of the price, 0.1275% (10 points at 2019's 7,844,
    37 in 2026). The years then look alike:
    - about 7 in 10 reach it, with a median 7-25 minutes;
    - price goes about one target against first on average (half a target at the median).
    - The alerts still match any minute, and the 2026 5m lean is gone at this size.
- **Every combination of states as an entry** (`research/databox_combos.mjs`, CSV beside it).
  - The set: 624 combinations of the four rows' states, each long and short, 2019-2026, on the
    price-scaled target, against 100 placebo markets.
  - More strong cells than chance (1,030 of 6,550 against a median 753, p about 0.02). But they
    turn over:
    - 2019-2025 favoured trend-following shorts, and those failed in 2026 (picked z -2.0);
    - 2026 favoured shorts on a 1m turn inside a bullish 5m, which were flat or negative before;
    - picked on Jan-Jun and read on Jul-Oct, they give z 2.4, p 0.12.
  - No combination is an entry that holds.
- **Exits from the box as well** (`research/databox_entry_exit.mjs`): every entry x every exit
  combination (or 15:05 alone), long and short, 780,000 strategies, P&L in bp after costs, one
  position at a time.
  - Even in-sample nothing stands out: the best of 2019-2025 has t 3.3, where placebo markets'
    best is a median 3.1.
  - Picked on 2019-2025 and read on 2026: t 0.6, matched by 44 of 100 placebo picks. Picked on
    Jan-Jun 2026 and read on Jul-Oct: t 1.5, matched by 13 of 100.
  - With no stop, the picks' running totals fell 549-2,198 points a contract in 2026.
- **Room adds no edge** (`research/databox_room.mjs`, CSVs and JSON beside it).
  - The test: every entry with one grid of 144 exits, in 5-minute ATRs (about 28 points in
    2026). Targets and stops are 0.5-5 ATR or none, held 15, 40 or 120 minutes or to 15:05.
    That makes 179,712 strategies and 1.28 billion trades a market, against 100 placebo markets.
  - t counts each session as one draw. A per-trade t is inflated by overlapping firings held to
    15:05: one placebo market's picks scored t 11 out of sample.
  - Picked on 2019-2025 and read on 2026, the picks lost 2.82 points a trade against 0.97 for every
    minute with the same exits (t -1.7, 96 of 100 placebo picks as high).
  - The roomy exits only (stop 2 ATR+, held 40 minutes+): -1.74 against -0.28 (72 of 100).
    Jan-Jun read on Jul-Oct: 58 of 100. A strategy's t does not carry between periods (r 0.08,
    29 of 100).
  - A planted +1 point a trade shows at t 3.4, so the test can see an edge that size. With room
    the noise doubles, so an edge needs about 2 points to show.
  - Room buys win rate, not edge: a 0.5-ATR target with a 3-ATR stop wins 84% from any minute and
    still loses money.
  - The one lead (added after looking): the 10 best on 2026, read back on 2019-2025, beat every
    placebo market (mean t 1.64 against at most 1.39).
    - Most of them are one setup: short when the 1m EMA turns Pot. short while the 5m rows read
      Pot. long, 0.5-ATR target, no stop, out by 15:05.
    - Net after costs: about breakeven 2019-2024 (2022 -8.1 a trade), +8.7 in 2025, +13.4 in 2026.
    - The forward direction failed, so treat it as a lead.
- **Reading the box live adds nothing** (`research/databox_live.mjs`, JSON beside it).
  - Every room strategy is read five ways:
    - at the close;
    - the 5m rows from the forming 5-minute bar, read each minute (exact);
    - tick by tick inside each minute, three ways.
  - Each row's histogram is a straight line in the forming bar's price, so the price where a
    combination turns true is exact. Whether the minute's high or low came after the entry is not
    known: the run reads it worst, middle (likelier order) and best.
  - 60% of live flips undo themselves by the minute's close.
  - Live against close, strategy by strategy, gains what random markets gain: 5m live +0.0003
    points a trade (placebo median +0.0011), middle +0.0007 (+0.0008).
  - Only the best reading's picks sit beyond placebo (t 7.6, 96th percentile). On random markets
    they score t 5.9 at the median: assuming the minute's unknown wick came after the entry makes
    the edge. The middle reading: 53 of 100 placebo picks as high.
  - Settling the order inside the minute needs second-by-second bars.
- **Momentum slowing points to nothing** (`research/databox_slowing.mjs`; the EMA row's `slowing`
  rule, also in the lab study, warns when the gap moves its side's way less than the bar before).
  - It fires before the turn 64% of the time on 1m, as it does on placebo markets: the rule's own
    arithmetic.
  - Price still goes 31-33 points the other way first (placebo 32). 8% of its warnings lead to a
    cross (placebo 8%).
  - As a reversal entry it was worse than random in 2019-2025 and average in 2026.
  - Every combination rerun with it (`databox_room.mjs --ema-warning slowing`): 65 of 100 placebo
    picks as high.
- **Dojis, levels and VWAP as turn calls** (`research/turn_context.mjs`; `--year 2025` confirms).
  - Screened on 2026 and confirmed unchanged on 2025, against 100 placebo markets.
  - Dojis alone call nothing. Two leads from 2026 failed on 2025:
    - a doji at a level (+0.8, 13 of 100);
    - the 1m EMA warning plus a doji (-2.9).
  - One effect held in both years: at RTH VWAP, a bounce call wins about 1.5-2 points of win rate
    less than a plain fade (99 of 100 placebo markets as high, both years and both halves of
    2025). Price goes through VWAP more often than chance gives.
  - Volume nodes leaned the same way in 2026, but the lean flipped in 2025.
- **Heat before the target is set by the entry** (`research/databox_heat.mjs`): exits cannot
  change the path to the target.
  - Counting every firing, a 10-point target in 2026 averages 31 points against first (80%
    touch it before 40 against). The price-scaled target averages 65.
  - Some entries are calmer for their times than chance gives, and the calmest from 2019-2025
    stayed calmer in 2026 (0.88 of the heat, 1 of 100 placebo picks as calm). But they also
    reached the target less often (66% against 72%) and more slowly. Their target-first edge was
    about 0: quieter entries, not better ones.
- **The box's flips come late, by the arithmetic** (`research/databox_swings.mjs`). Measured on
  the swing line (the `zigzag` study, below):
  - When the 1m box turns both Long in 2026, two-thirds of the up-swing is done: 68% on a
    37-point line, against 66% on placebo markets. 26.5 points are left, 8 minutes after the low.
  - The Potentially warnings do not call the turn. 1m EMA Pot. long fires after the low 60% of
    the time, MACD 46%. Before it, price falls a further 35-39 points, as from any minute.
- **The swing line** (`zigzag`, "Swing line (zig-zag, hindsight)") joins the real swing highs and
  lows, a swing ending when price comes back a set share of the price (src/indicators.mjs
  `zigzagPivots`).
  - Drawn with hindsight, it is `hindsight: true` with `gates: []`: it draws and never gates.
  - The causal-reading tests skip it, and test.mjs checks it cannot gate.
  - So does `zerolag` ("Smooth price (zero-lag, hindsight)"), an EMA run forward then back. It
    turns where price turns. Beside an EMA of the same length, the gap between them is the EMA's
    lag.
- **Tuning on what the chart shows does not find the turn** (`research/turn_predict.mjs`).
  - The features: price against EMA 9 / 21, EMA slope and curve, the MACD histogram and its
    changes, RSI and its change, recent moves, 5m context, the day's range, time of day, volume
    and the box.
  - A logistic model fitted on 2019-2025 scores AUC 0.494-0.502 on 2026, against placebo markets'
    0.48-0.51.
  - Volume adds nothing. Its calls come during the fall or late in the rise, as the box's do.
- **Better filters move along the lag-noise line, never off it** (`research/filter_frontier.mjs`).
  - It tests 104 turn detectors: EMA, Hull, zero-lag EMA, Super Smoother and alpha-beta at 4
    speeds and 4 hysteresis levels, and the MACD histogram's cross and turn at 3 scales.
  - Hysteresis cuts false turns and adds lag, and no smoother beats an EMA with hysteresis.
    Placebo markets reproduce every detector's lag and false-turn share.
  - One sliver held out of sample: the fastest, unfiltered MACD 6/13/5 histogram turn, +0.6
    points of win rate on an 18-point bracket in 2026 (z 2.0, beyond all 30 placebo picks). That
    is about +0.2 points a trade against 1.25 of costs, and any filtering removes it.
- **The `databox` study** (src/studies.mjs) is the box on the chart, a lane a row.
  - `lanes` are drawn by chart.js `_drawLanes`, a block a run or a pixel column.
  - The crosshair names each lane's state.
  - It gates and splits trades as a `trend` study.
  - test/mock.test.mjs holds its lanes equal to the indicator's states after the warm-up.
  - It uses the lab's EMAs, seeded on the first value; Tradovate seeds on the first n.
- **The Tradovate box reads the forming bar by default since 2026-11-23** (`updates`: `live` or
  `close`; it replaced `readFormingBar`, off).
  - It moves with each tick and sits in any `corner`. Indicators get no mouse input, so it can't
    be dragged.
  - The research reads `calc.st`, each bar's state once it has closed, which is what the live box
    ends on. A mid-bar flip that flips back by the close was never tested.
- **The idea loop** (`research/idea_lab.mjs`; ledger `research/idea_lab_ledger.md`) screened about 300
  ideas for the box's warnings on 2026 and confirmed two on 2025. Both say one thing: warnings calling the
  way the RTH VWAP moved over 15 minutes are the weaker kind.
  - The Tradovate box marks them "(weak)" (`vwapSlope`: mark, hide or off; since 2026-11-24). Its slope
    equals the research's on every 2026 RTH minute. test/mock.test.mjs checks the marking against a
    plain reference VWAP.
  - Over 17 years the rule reverses (NQ 2010-2018 unseen: -1.9, beyond all 100 placebo markets the other
    way; worse in 13 of 17 years, better only 2025-2026), so `vwapSlope` is off by default since 2026-11-25.
    `vwapSlope: "adaptive"` carries confirmed #4 instead (the side that lost over 60 sessions is weak; the box
    forms 5m bars itself on a 1m chart); research/verify_adapt_box.mjs: same weak side on 1,871 of 1,874 sessions.
    Since 2026-11-25 `adaptive` is the default (1m charts; elsewhere it reads as off), and a third row "Fast EMA 3/13"
    (`fastRow` auto = 1m charts) shows #3's slowing warning only; research/verify_fast_row.mjs: identical on all
    2,641,986 MNQ bars. The 12/26 rows are unchanged.
  - Confirmed #3 (2026-11-25): on 1-minute bars the EMA row at 3/13 with the "slowing" warning beats the
    default (NQ 2010-2018 +1.2, 0 of 100; better in 14 of 17 years). A setting, documented in the
    indicator README; defaults unchanged.
  - Unseen data for confirmations: data/nq_1m.bin (NQ 2010-2026) and data/es_1m.bin (ES 2010-2026), built
    by prepare.mjs from Desktop\Backtesting; research/light_check.mjs runs idea_lab's filters on them.
  - Forward test frozen in the ledger: `--batch 53 --from 2026-11-02` once 40 sessions of new bars are
    held, with a kill rule.
  - As a gate or exit on `donchian_1250` and `macd_fade_1250` the box helps neither. A Donchian breakout
    is a move the box already agrees with (the 5m box reads with all 128 of 2026's trades). On the fade
    every variant helped one half of 2026 and hurt the other.
  - Every other 2026 screen pass failed its unseen year, including outside data (FRED macro, Treasury
    auctions, mega-cap earnings, CFTC positioning; `research/event_data_build.py`).
- **No 30-second bars are held.** Getting them takes a working TopstepX key (second bars, recent
  only) or Databento 1-second data (paid). Add one to `TFS` to run the other four
  combinations.

## The VXN as a stand-in for dealer gamma

`research/vxn_regime.mjs` labels each RTH session by the VXN close before it and asks whether
moves carry on more on high-VXN days. Each measure is judged against 100 placebo markets:
- variance ratios;
- EMA 12/26 crosses and their next 30 minutes;
- the last half hour against the day.

The VXN comes from FRED's VXNCLS, saved to `data/raw/fred/` (git-ignored: it is Cboe's data).
- **Result: no.**
  - The test named first (15-minute variance ratio, high third less low, 2026) gives +0.088,
    z 1.5, p 0.13, and its sign is not steady inside 2026.
  - 10 of 160 gaps sit beyond 1.96 sd, where placebo markets get a median of 8.
- **The last half hour following the day** (Baltussen et al.) shows on 2020-2025 pooled only
  because the high-VXN days are 2020's and 2022's. Inside each year it runs from +12.4 to -13.1
  points, none significant.
- **The VIX term structure does no better** (VIX over VIX3M, FRED's VIXCLS and VXVCLS, saved beside
  the VXN).
  - Flattest third less steepest, 2026: +0.031, z 0.5.
  - Only 10 of 2026's sessions opened inverted.
- **Every free daily index left is another reading of implied volatility.** VVIX, SKEW and VIX9D
  are on Cboe's site only.
- **What the VXN does call is the session's size.**
  - In 2026 the VXN before the open explains 20% of the RTH range (% of price). The 10-session
    average range explains 10%, and adds nothing once the VXN is in. 2020-2025: 43% against 38%.
  - The VXN is a percentage, so compare years in % of the contract's real price, never in points.
    NQ's median price was 12,466 in 2022 and 29,126 in 2026.
  - Median range: 277 / 388 / 440 points by VXN third.
  - It is not a trend filter.
- **Nor does it call a choppy day over the whole session** (`research/vxn_chop_day.mjs`).
  - It measured the Choppiness Index over the RTH session, the share of the range the close kept,
    and trend days (the close keeps 70% of the range).
  - 2026 Choppiness Index: 49.2 / 49.1 / 49.5 by VXN third, placebo markets 49.0 / 49.2 / 49.4.
    The named test (high third less low): -0.07, z -0.1.
  - 2026 trend days: 21.6% against a placebo 21.7%.
  - The 2020-2025 pooled lean toward more trend days on high-VXN days is 2022's (34.4% trend days).
    Inside each year it flips sign.
- **As sizing on `donchian_1250` it does not help** (`research/vxn_sizing_1250.mjs`).
  - The rule: lots x the 60-close median VXN over the close before, held to 0.5-1.5.
  - 2026: calendar 59.4% against the shipped 74.5%. 35 of 40 shuffle twins (the same sizes on
    random days) do as well.
  - Sized by the dollar move instead (VXN x the real price, to a fixed 2026 target, at the
    shipped book's average size), it is level in 2026: 73.3% calendar against 74.5%, bootstrap
    65.2% against 71.1%. Forward it does better, 53.2% and +$3,518 against 44.2% and +$2,584, on
    77 days. Its shuffle twins are split by measure.
  - The stress test (`research/stress_2022_today.mjs`): 2022's percentage moves rebuilt at today's
    price.
    - The shipped 4 lots passes 26.9% on live equity, fails 73%, and hits the $600 line on 103
      days.
    - The dollar rule passes 45.8%.
    - Cut only (never above 4 lots, chosen after that run) matches the shipped book in 2026
      (74.5% calendar, 70.1% bootstrap) and in the real 2022, and gives 53.2% forward. It is a
      candidate, not shipped.
  - Every variant's pass rate follows its average size: 4 lots is the top of the 2026 curve. Keep
    4 lots.
- **So dealer gamma would have to carry something the VXN does not.**
  - Cboe's delayed quote pages forbid automated download.
  - Daily options open interest comes legitimately from Databento's statistics schema: OPRA for
    QQQ, NDX and SPX; GLBX for NQ options.

## Papers

- `papers/<id>.md` holds one summary per paper (front matter: title, authors,
  year, venue, url, pdf, tags, oneLine).
- `papers/README.md` is the index.
- PDFs live in `papers/pdf/`, git-ignored because they are copyrighted.
- Add a paper by writing its summary, then adding a row to the index.

## Hard rules

- `bot/.env` holds the live credentials (git-ignored).
  - Never print its values.
  - Never put the API key in a `.bat` launcher.
- Never stage `bot/mnq_donchian_bot.py` or `bot/mnq_donchian1250_bot.py`. Both
  carry the person's own uncommitted settings, including the 1250 bot's account name.
- The ProjectX API is read-only for Claude. Never place, modify or cancel an order
  without explicit permission.
- Commit MNQ work with simple messages and push to main. Stage files by name,
  never with `git add -A`.
