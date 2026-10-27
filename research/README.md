# research/

Over 250 one-off studies, kept as the record of how each result was reached. Since
the engine consolidation (October 2026) they all run on **one execution engine**,
`src/engine.mjs`, and **two pass-rate evaluators**, `src/challenge.mjs` (calendar
windows) and `src/dayeval.mjs` (day-sequence bootstrap).

## The libraries are adapters now

| library | what it was | what it is now |
| --- | --- | --- |
| `lib_shipped.mjs` | the live Donchian bot's own engine and evaluator | the bot's signal and numbers bound to `src/engine.mjs`; pass rates from `src/dayeval.mjs` |
| `lib_orb.mjs` | ORB setups plus its own exit engine and evaluator | setups unchanged; each trade resolved by `src/engine.mjs`; `src/dayeval.mjs` |
| `lib_forward.mjs` | a per-entry bracket simulator | one `src/engine.mjs` call per entry, with the engine's scale-out |
| `lib_search.mjs` | the fast window replay | a re-export of `src/search.mjs` |
| `lib_combo.mjs` | one-account replay and samplers | `accountDays` in `src/portfolio.mjs`, samplers in `src/dayeval.mjs` |
| `lib_donchian_mgmt.mjs` | the rescue signal, built by hand | the signal from `strategies/donchian_shipped.mjs` itself |

`test/legacy_parity.mjs` proves each adapter reproduces the code it replaced
(frozen in `test/oracles/`) trade for trade, so every number recorded against
the old libraries still stands. Run it with `npm run parity`.

## Old conventions are options, not code

The adapters keep the conventions their results were measured under, as engine
options. The engine's own defaults are now the physically consistent reading
(exits decided at a close fill at the next open, the entry bar can stop a market
fill, gaps through resting orders fill at the open, an early close flattens, a
fired platform cap ends the day). To reproduce a pre-consolidation result from a
script that calls `src/engine.mjs` or `src/run.mjs` directly, pass `LEGACY_EXEC`:

```js
import { LEGACY_EXEC } from "../src/engine.mjs";
runStrategy(bars, strategy, params, { ...strategy.execDefaults, ...LEGACY_EXEC });
```

## New work

New research goes through the MCP tools (`mcp/`), which run `src/` directly and
quote which evaluator a pass rate came from. A new study that needs something the
engine cannot express adds it to `src/engine.mjs` as an option, with a test in
`test.mjs` -- not a private copy of the bar loop here.
