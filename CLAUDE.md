# MNQ Chart Lab — notes for Claude

A 30-day prop-firm combine backtester on 7 years of MNQ 1-minute bars. One engine
(`src/`) runs in Node, in the browser chart and behind the MCP tools, so a number
from any of them agrees with the others.

## Research through the MCP tools, not one-off scripts

`.mcp.json` registers the `mnq-chart-lab` server (`node mcp/server.mjs`). Its tools:

| tool | answers |
| --- | --- |
| `list_strategies`, `describe_strategy` | what exists, every parameter, the notes at the top of each file |
| `backtest` | trade stats; by year, exit, entry hour, weekday, direction and volatility; daily Sharpe, PSR and MinTRL |
| `pass_rate` | combine pass rate by period, `calendar` and/or `bootstrap`, each with a ci95 |
| `compare` | two configurations on the same windows, paired, with months won |
| `search` | a grid ranked in-sample only, with out-of-sample, purge, rank correlation and PBO |
| `walk_forward` | whether re-choosing from a grid month by month beats holding the base configuration |
| `sensitivity` | how far the pass rate moves when each setting is nudged (knife-edge check) |
| `window`, `bars` | one 30-day window in detail; raw bars |
| `chart_state`, `chart_apply` | read and drive the chart page the person has open |
| `papers` | the methodology library in `papers/` |

When a question needs something the tools cannot do, write the script against
`src/` (`runStrategy`, `replayWindow`, `src/dayeval.mjs`). Never copy engine or
rule logic into a script: that is a second engine, and it drifts.

## House rules for any number reported

- **Judge on 2026, and check inside 2026**: Jan–Mar vs Apr–Jul. The tools' default
  periods do this; all history is context.
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
- **Day caps and overnight holds.** `dayLossStopUsd` and `dayProfitStopUsd` measure
  an open position from its fill, so use them with intraday-only books.
- **After any engine change:**
  - run `npm run check` and a few fuzz seeds;
  - re-measure every strategy's defaults;
  - say what moved.

## Tests

- `npm run check`: test.mjs, audit, legacy parity, MCP end to end, chart link.
- `FUZZ_SEED=<n> FUZZ_SCALE=<k> node test.mjs`: the randomised invariants.
- `PARITY_SEED`, `PARITY_SCALE`: the same for test/legacy_parity.mjs.

## The chart

- `node server.mjs` serves http://localhost:5178; the preview config is "chart-lab".
- The page posts what it shows to `/api/chart/state`, and `chart_apply` pushes
  changes it applies.
- The address bar carries the strategy, the window and every changed setting
  (`#s=donchian_shipped&d=2026-03-09&x.slippageTicks=1`), so a view can be shared
  or restored.
- Data: `node prepare.mjs` builds the binary cache in `data/` once.

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
