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

## Engine conventions (src/engine.mjs)

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
- **`staleBars` / `staleMfeAtr`** leave a trade at the next open once it has run
  that many bars without being that many ATRs in favour. It is the $1,250 bot's
  40-minute exit, and the research's `exitFn` trade for trade.
- **A strategy's `sizeMult`** (from `compute()`, per bar, read at the signal)
  multiplies the size, rounded and at least 1. `0` refuses the entry the way a gate
  does, so the signal still flips. `donchian_1250` uses it for the 10-minute EMA
  filter and its late half size, and `macd_fade_1250` for its weak-cross and
  volatility gates, as the research's sizers did.
- **`tpMaxUsd`** caps the target at that many dollars for the size traded, as the
  MACD fade's `min(5.15 ATR, $600 / (2 x lots))`.
- **`onSignal(k, dir, what, info)`** reports what became of each signal: entered,
  armed then filled / replaced / cancelled / expired, flipped, held, ignored,
  dropped, refused (with `why`). It observes only; test.mjs section 17 holds the
  trades identical with it on. `runStrategy({ trace: true })` collects it as
  `signals`.
- **Day caps and overnight holds.** `dayLossStopUsd` and `dayProfitStopUsd` measure
  an open position from its fill, so use them with intraday-only books.
- **After any engine change:**
  - run `npm run check` and a few fuzz seeds;
  - re-measure every strategy's defaults;
  - say what moved.

## Tests

- `npm run check`: test.mjs (425), audit, legacy parity (15), MCP end to end (19),
  chart link (10), the indicator mock (90, `npm run test:mock`), the page's arithmetic
  (30, `npm run test:ui`), the $1,250 Tradovate indicators (41, `npm run
  verify:tradovate`, about 2 minutes).
- `FUZZ_SEED=<n> FUZZ_SCALE=<k> node test.mjs`: the randomised invariants.
- `PARITY_SEED`, `PARITY_SCALE`: the same for test/legacy_parity.mjs.

## The chart

- `node server.mjs` serves http://localhost:5178; the preview config is "chart-lab".
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
- **Time:** the axis and crosshair read Chicago time, worked out from each bar's
  `ctMin`. `chart_state` and the CSVs stay in UTC.
- **Frames** are under 7 ms on every strategy at the full window. Keep it so: a frame
  must not sort, and zoomed out each pixel draws one thing (`nthSmallest`, the
  histogram's columns, dots for dense trades).
- **A book that holds overnight loads all of history** (src/window.mjs), so its re-run
  takes up to 0.8 s and happens on a pause, not on every step. That cost is the price
  of matching the sweep. A slow Tradovate indicator gets the same treatment.
- Data: `node prepare.mjs` builds the binary cache in `data/` once.
- Strategy table for the README: `node --max-old-space-size=8192
  research/strategy_table.mjs`. The README's other figures come from
  `research/readme_figures.mjs`.

## The $1,250 books, and testing a new one

- **`donchian_1250` is the $1,250 bot whole and the book to beat.**
  - 2026: calendar 74.5%, bootstrap 71.1%.
  - Forward, Sep 10 - Oct 26 2026: +$2,532, every window passed.
- **`macd_fade_1250` reproduces the research's 67.7% exactly, but lost forward.**
- **`trend_pullback`, `orb_trend` and `macd_momentum` are the indicator
  combinations.** Each was tuned on 2026, and none held forward. Their headers
  carry the numbers.
- **The protocol** (`research/lib_eval1250.mjs` scores it, through `mcp/lab.mjs`):
  - score 2026 by both methods, and in both halves;
  - pick on one half and read the other;
  - choose by the worse half;
  - check the neighbours;
  - compare with the coin-flip twin (`nullCfg`);
  - then run `research/forward_1250.mjs` on the TopstepX bars
    (`data/topstepx_1m.bin`).
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
- test.mjs section 14 then checks it for lookahead and live = sweep
  automatically.
- A new kind of computation (not built on `src/indicators.mjs`) also gets a naive
  reference test there, as VWAP and the day levels have.

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
