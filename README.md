# MNQ Chart Lab

A visual backtester for 30-day prop-firm combines on MNQ 1-minute data. You pick
a 30-day window, see every trade on the chart, watch the equity curve run against
the trailing drawdown floor, and drag strategy parameters around while the trades
redraw underneath your cursor.

Built to answer *why* a window passed or died — not just whether it did.

```bash
node prepare.mjs      # once: CSV -> binary cache (~3s)
node server.mjs       # then: http://localhost:5178
```

---

## What you're looking at

**Price pane** — candles, with every trade drawn as an entry marker → exit marker
joined by a line, green for a winner and red for a loser. Hover a trade for its
P&L, exit reason, stop/target levels, and worst excursion; hovering also draws the
bracket that was live for it.

Trades the *rules* suppressed are drawn faded and dashed. This matters more than
it sounds: with the shipped -$150 circuit breaker, roughly half the strategy's
signals never become trades, and seeing which ones is how you tell a signal
problem from a risk-overlay problem.

**Equity pane** — cumulative P&L as a step line, the trailing drawdown floor
stepping up beneath it, and the profit target above. The shaded band between
equity and floor is your actual survivable room. A gold marker shows where the
floor locks at breakeven.

**Daily P&L pane** — one bar per CME session (17:00 ET boundaries), with the daily
profit stop, your circuit breaker, and the firm's daily limit drawn as reference
lines. Sessions that hit a lockout get a gold underline.

**Navigator** — every possible 30-day start across the 5 years, coloured by
outcome. Click to jump. This is the difference between "this window passed" and
"this passes 75% of the time".

**Sidebar** — two panels answering two different questions. *This window* is the
anecdote in front of you, recomputed live as you drag sliders. *All windows* is
the distribution it was drawn from: pass/breach/ran-out-of-time split across all
1,796 windows, median days to pass, best and worst window, and a **pass rate by
year** breakdown. That last one matters more than the headline number — the
reference strategy ranges from 53% to 95% depending on the year, so which regime
you happen to attempt in dominates your actual outcome. The panel dims and
re-sweeps automatically ~700ms after you stop changing parameters.

---

## Why it feels instant

The strategy files and the rules engine are **isomorphic ES modules** — the same
`.mjs` files run in Node and are imported directly by the browser. So:

- Moving a slider re-runs the *real* backtest over the visible window **in the
  page**, in 2–12ms. No request, no server round trip, nothing to debounce.
- The 5-year sweep still runs server-side (96ms backtest + 18ms for 1,796
  windows) because it needs all 1.77M bars in RAM.

Both paths execute identical code, so the fast preview can't drift from the
authoritative numbers. That's verified: at ADX 40 the in-browser window shows
-$3,652 / 8 trades / -$1,652 cushion, and the server's independent full-history
sweep reports exactly the same figures for that window.

Supporting choices: the CSV is preprocessed once into packed typed arrays (54MB,
loads in 41ms vs ~12s of parsing); a window ships as one binary blob so zoom and
pan do zero I/O; candles bucket into pixel columns so cost is bounded by chart
width, not bar count; and the crosshair lives on its own canvas so pointer moves
never repaint 30,000 candles.

---

## Adding a strategy

Drop a file in `strategies/`, click **Reload strategies**. No registration.

`strategies/_TEMPLATE.mjs` is a working annotated example. The contract:

```js
export default {
  id: "my_strategy",
  name: "Shown in the dropdown",
  timeframeMin: 5,        // clock-aligned bars built from the 1-min source
  warmupBars: 400,        // history prefetched so left-edge indicators are correct

  // Each entry becomes a live slider in the sidebar.
  params: [
    { key: "lookback", label: "Lookback", type: "int", min: 5, max: 200, step: 1, default: 30, group: "Signal" },
  ],

  compute(bars, p) {
    return {
      sig,          // Int8Array: 1 long / -1 short / 0 flat
      atr,          // Float64Array driving stop/target width
      overlays: [], // optional lines; pane 'price' or 'sub'
    };
  },
};
```

**The one hard rule:** import only from `../src/*.mjs`. A `node:fs` import here
breaks the browser preview, because the browser loads this exact file.

Stops, targets, sizing, and costs are *not* per-strategy — they live in the
shared Execution panel so any strategy can be tested under any risk envelope.

---

## The rules being simulated

Modelled on `lib_challenge_v2.mjs` from the lite backtester, so pass rates are
comparable to that work. Everything is adjustable in the sidebar.

| Rule | Default | Behaviour |
|---|---|---|
| Profit target | $3,000 | Cumulative → PASS |
| Trailing drawdown | $2,000 | **The only hard fail.** Locks static at breakeven once peak ≥ $2,000 |
| Trails on | Daily closes | EOD trailing: an intraday spike given back before the close doesn't tighten your floor |
| Firm daily loss limit | $1,000 | **Soft lockout** — stop for the session, resume next day. Not a breach |
| Daily profit stop | $1,500 | Stop trading once the day is up this much (consistency) |
| Your daily breaker | $150 | Your own tighter stop. The biggest pass-rate lever in this project's testing |
| Consistency cap | 50% | No single day may exceed this share of total profit at payout |
| Contract cap | 10 | Real firm limit |

Two deliberate deviations from `lib_challenge_v2`, both toward realism:

1. **Window membership is by entry time.** You start a combine flat, so a trade
   opened before day 1 can't count. (v2 filtered on exit time.) Affects at most
   one trade per window.
2. **`Breach measured on: Open equity`** checks each trade's worst excursion
   (MAE), not just its realised close — real firms breach on live equity. Because
   we can't know whether MFE or MAE printed first inside a trade, the peak is
   ratcheted *before* the breach test: the pessimistic ordering. Default is
   `Realised P&L only`, which matches v2.

### Commission

Defaults to **$0.75/side/contract** (= $12 round trip on 8 lots), which is what a
broker actually charges. Legacy lite_backtester runs used a **flat $5/trade**,
understating cost by 2–3× at 8–10 lots. Switch the model in the Execution panel if
you're reconciling against those numbers. Total commission paid is shown in the
stats so it's never invisible.

---

## Data pipeline

`prepare.mjs` turns the 317MB / 2.87M-row Databento CSV into `data/mnq_1m.bin`:

- Parsed straight from a `Buffer` — no giant intermediate string, no per-row objects
- Calendar-spread rows (`MNQU1-MNQZ1`) dropped
- Dominant contract per day chosen by volume → single continuous front-month
- Panama Canal back-adjustment removes the rollover jump (a fake 120pt gap is
  exactly the kind of artifact that manufactures a phantom edge)
- CME trading-day index (17:00 ET, DST-aware) precomputed per bar

Result: **1,770,275 bars**, 2021-07-15 → 2026-07-14, and a self-check confirming
**0.0000 points residual seam** at all 20 rollovers.

> That check earns its keep. The first build reported a 233,233,920-point seam —
> gaps were being measured against already-adjusted prices, compounding the
> correction at every rollover. Silently wrong data is the worst failure mode
> here, so `prepare.mjs` verifies its own output and prints the result.

---

## Reference strategy

`strategies/trend_neutev.mjs` — the shipped neutral-EV trend book from
`CHALLENGE_STRATEGY_SPEC.md`: 5-min Donchian-30 breakout, ADX ≥ 25, 2×ATR stop,
12×ATR target (6:1), 8 contracts.

Measured here across 1,796 windows, against what the spec documents:

| ADX min | Profit factor | Pass rate | Spec says |
|---|---|---|---|
| 25 (neutral EV) | 1.005 | **75.6%** | PF ~1.01, ~73% |
| 32 (positive EV) | 1.058 | **67.3%** | PF ~1.06, ~69% |

Close agreement on *both* variants — and it independently reproduces the central
trade-off, that loosening the ADX gate raises pass rate while lowering per-trade
edge. Reassuring given this build uses stricter per-contract commission,
clock-aligned bars, and entry-time window membership.

Its profit factor is ~1.0 by design. It passes because of the challenge
*structure* (short window, stop-on-pass, lenient EOD trailing, tight breaker), not
a strong edge.

One mechanic the tool surfaces that's easy to miss: median net per passing window
is ~$6,600, not ~$3,000. The consistency rule is why. A single 12×ATR winner on 8
lots is ~$3,300, which is more than 50% of a $3,000 target — so hitting the target
on one big day doesn't pass, and you must keep grinding until the best day is
diluted to half the total. The daily profit stop can't prevent this, since it only
blocks *new* entries and a single trade can blow straight through it.

---

## Keyboard

| Key | Action |
|---|---|
| `←` / `→` | Step window ±1 day |
| `Shift` + `←`/`→` | Step ±7 days |
| `r` | Reset zoom |
| Wheel / drag | Zoom / pan |
| Double-click | Fit window |

The full sweep runs on demand (**Run full sweep**); after the first run it
re-sweeps automatically ~700ms after you stop adjusting parameters.
