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

**The window ends when it resolves.** 30 days is a maximum, not a duration — the
evaluation is over the moment you hit the target or breach. A dashed marker shows
where, everything after it is dimmed, and trades in the dead region are drawn
faded because they never happened.

Related and easy to miss: the **consistency rule can block a pass**. If it gates
the evaluation, one oversized winning day forces you to keep trading to dilute it
below the cap — measured here, 95% of passing windows reach the target *first* and
then trade ~10 more times, which both delays the pass and re-exposes the account.
The `Consistency blocks the pass` control chooses; the default is off (pass on
target), and a pass that would violate the cap is flagged with ⚠ rather than
silently accepted. Turning it on drops pass rate 78.8% → 71.9% and doubles the
median time to pass from 6 days to 13.

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
| No overnight positions | on | Flat by **3:05 PM CT**, no re-entry until the **5:00 PM CT** reopen |

### The no-overnight rule changes everything

Most funded accounts forbid holding through the close. This is enforced in the
engine (Session rules panel), and it is not a minor filter — it invalidates the
entire wide-reward:risk family of strategies this project has been built around:

| | overnight allowed | intraday-only |
|---|---|---|
| `trend_neutev` (6:1) | 71.9% pass | **13.7%** |
| `trend_vol_adaptive` (18:1) | 80.7% pass | **3.7%** |

The reason is a timing asymmetry that the rule attacks directly. With overnight
holds allowed, the incumbent's **winners take a median 6.5 hours** (90th
percentile 18.3h) while its **losers resolve in a median 1.0 hour** — a tight
2×ATR stop is hit quickly, but a 12×ATR target needs most of a day to develop.

So a 3:05 PM CT deadline truncates **36.9% of winners but only 5.1% of losers**,
and **$1.70M of the $3.97M gross profit sits in exactly those truncated winners**.
The rule removes ~43% of gross profit and leaves the losses untouched.

**If your account has this rule, both shipped strategies are unusable as tuned.**
A viable intraday book needs a reward:risk that can resolve inside the hours
actually available, not 6:1 or 18:1 — see `research/intraday_only.mjs`.

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

`prepare.mjs` turns the Databento CSV batches into `data/mnq_1m.bin`:

- **Multiple source files merged.** Databento delivers overlapping batches; list
  them all and they are combined into one series, deduplicated on
  (timestamp, symbol) by a linear merge of the sorted runs. Overlapping rows are
  compared field-by-field and the build **aborts** if any disagree, rather than
  silently picking a winner. Across the current two files, 2,624,027 overlapping
  rows agreed exactly.
- Parsed straight from a `Buffer` — no giant intermediate string, no per-row objects
- Calendar-spread rows (`MNQU1-MNQZ1`) dropped
- Dominant contract per day chosen by volume → single continuous front-month
- Panama Canal back-adjustment removes the rollover jump (a fake 120pt gap is
  exactly the kind of artifact that manufactures a phantom edge)
- CME trading-day index (17:00 ET, DST-aware) precomputed per bar

Result: **2,534,706 bars**, 2019-05-05 → 2026-07-14 — MNQ's entire history, since
the contract launched in May 2019.

```bash
node prepare.mjs                       # uses the default source list
node prepare.mjs --in a.csv --in b.csv # or name them explicitly
```

> Early MNQ is complete but thin: 2019 averages 1,335 bars/session (the same
> coverage as today) at **137 contracts/bar versus 1,148 in 2025**. The bars are
> real and the session coverage is full, but fills in 2019 would have been harder
> than the backtest's slippage setting assumes.

### How the roll spread is measured (this part is subtle)

The obvious way to size a rollover gap — *(first bar of the new contract)* minus
*(last bar of the old one)* — is wrong, and wrong in a way that hides itself.
It measures the contract spread **plus whatever the market moved in between**.

That is harmless when the handover lands mid-session (one minute apart), but
**4 of the 20 MNQ rolls land at the Sunday 22:00 UTC reopen**, where "in between"
is a 49-hour weekend. Adjusting by that combined number removes the spread *and
erases a real weekend move from history*:

| Roll | Naive gap | True spread | Move erased |
|---|---|---|---|
| 2026-06-14 (Sun) | 654pt | **294.75pt** | 359pt |
| 2022-06-12 (Sun) | −118pt | **+28.75pt** | −147pt (*wrong sign*) |
| 2022-03-13 (Sun) | 43.25pt | **−4.5pt** | 48pt |

So the spread is measured from **both contracts quoted at the same minute**,
which has no time-passage component at all. Every roll has 6,000–9,000
overlapping bars available, and all 20 are measured at the exact handover minute.
294.75pt is textbook cost-of-carry at 29,888 with ~4% rates; 654pt was not.

`verify_rolls.mjs` proves the result independently: across every seam, the move
the continuous series shows is confirmed by the **incoming** contract to within
6.25pt worst case (typically <1pt). The residual moves are real market moves,
correctly preserved rather than adjusted away.

> Both halves of this were bugs at some point. The first build reported a
> 233,233,920-point seam — gaps were measured against already-adjusted prices,
> compounding at every rollover. Silently wrong data is the worst failure mode
> here, which is why `prepare.mjs` verifies its own output and why `audit.mjs`
> exists at all.

Practical impact of the same-minute fix on the reference strategy: pass rate
75.6% → 75.7%, net P&L $15,319 → $18,157. Small, because it touches one bar at
4 of 20 rolls — but it is the difference between a series that reflects what
happened and one that doesn't.

---

## Verification

```bash
npm run check          # test.mjs + audit.mjs
npm run verify-rolls   # seam coherence against the incoming contract
```

**`test.mjs` — 67 tests, all passing.** The approach is to test optimised code
against a naive reference that is obviously correct, and rule logic against
numbers hand-traced on paper:

- Indicators cross-checked against independent implementations — the O(n)
  Donchian deque against O(n·p) brute force at 5 periods × 400 bars, ADX against
  a from-scratch reimplementation, rolling stats against literal window means.
- Engine invariants: entry fills at the *open* of the bar after the signal;
  bar *i*'s own high/low provably cannot change whether it was entered;
  stop-before-target inside one bar; gap-through-stop fills at the open; flip
  closes and re-enters same-bar; P&L, fees, slippage, and MAE/MFE arithmetic.
- Rules traced by hand: floor trailing, the breakeven lock, `<=` boundary
  behaviour, soft lockouts that skip trades without failing, consistency, EOD vs
  intraday trailing, and `sweepWindows` agreeing with `replayWindow` at every
  start it reports.
- Real data: the final contract piece matches the source CSV **exactly** across
  20,000 bars (it takes zero adjustment, so any parse or pack error would show);
  prices stay on the 0.25 tick grid; resampling conserves volume and true
  extremes.

**`audit.mjs` — data artifact sweep.** OHLC integrity, timestamp ordering and
duplicates, rollover seams, the largest jumps classified session-gap vs
intra-session, tick-grid adherence, and volume sanity. Current verdict: *no
artifacts found*.

**Chart rendering** (browser console, `window.lab`): trade markers land on the
exact bar of their entry time (0ms offset over 123 trades); pixel-column
bucketing preserves the true high and low exactly; indicator overlays align to
their own timeframe bucket (0 misaligned of 6,877); skipped trades are excluded
from the equity curve.

**Browser/server equivalence:** 12 randomised configs — timeframes 1/3/5/15m,
ADX 10–42, 1–10 contracts, both trailing modes, window starts across 4 years,
trade counts from 2 to 144 — produced **identical** outcome, net P&L, and trade
count from the in-page preview and the server's independent full-history sweep.

### Two things the data legitimately contains

Neither is a defect, both will look like one if you don't expect them:

1. **3,752 moves over 40pt inside a single 1-minute bar.** Real — they cluster on
   CPI and FOMC print times. The largest, 438.5pt, is 2025-04-09 17:19 UTC.
2. **No bar exists at 17:00 ET.** CME halts 17:00–18:00 ET daily, so the first
   bar of every session is 18:00 ET — verified across 600/600 boundaries, holding
   through both EDT and EST.

---

## Reference strategy

`strategies/trend_neutev.mjs` — the shipped neutral-EV trend book from
`CHALLENGE_STRATEGY_SPEC.md`: 5-min Donchian-30 breakout, ADX ≥ 25, 2×ATR stop,
12×ATR target (6:1), 8 contracts.

Measured across **2,598 windows / 7.2 years**: **71.9% pass**, 20.4% breach,
7.7% unresolved, median 13 days to pass. The spec documents ~73% — close, and
that agreement now holds over 2.2 years the strategy was never tuned on.

Its per-trade edge over the full history is **profit factor 0.9917, −$3.22/trade**
— slightly negative. That is not a contradiction: this book is explicitly a
neutral-EV design, and 0.99 versus the spec's ~1.01 is noise around zero. It
passes because of the challenge *structure* (short window, stop-on-pass, lenient
EOD trailing, tight breaker), not because of an edge. Set ADX minimum to 32 for
the positive-EV variant.

**The 5-year figure was optimistic.** On 2021-07 → 2026-07 alone the same config
showed 75.7% pass and +$18,157; adding MNQ's first two years takes it to 71.9%
and −$33,127. More history did not flatter it, which is the point of having it.

Pass rate by year — the widest spread in the project, and the strongest argument
that regime dominates everything else:

| 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|
| 48.5% | 63.4% | **89.9%** | 70.4% | 73.4% | 82.8% | 75.9% | 52.1% |

(2019 and 2026 are partial years.)

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
