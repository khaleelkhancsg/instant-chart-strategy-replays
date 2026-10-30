# Indicator mock

Runs an indicator written for Tradovate on the backtester's chart, so you can see how it looks and try its settings before it goes to the platform. Nothing external is involved: the code is the file on disk, the bars are the chart's own, and it all runs in the page.

## Using it

1. Run `node server.mjs` and open http://localhost:5178.
2. In the sidebar, under **Tradovate indicators**, add one. Yours are the files in `tradovate/` and `../TradingCustomIndicators/tradovate/`. Tradovate's own are there too, so you can put its MACD in a pane under a fade.
3. The chart opens on the window's first day at 08:15–15:15 CT, with candles the indicator's size. The day arrows walk it a day at a time, and the date box jumps.

| On the card | What it does |
|---|---|
| ↻ | Reads the file again and keeps your settings. Edit the `.js`, press it, and the chart shows the change |
| ● | Hides or shows it |
| Checks | What would go wrong on the platform. Click one to go to the first bar it happened on |
| `6.3 px a bar · 20 labels · 5 overlapping` | How it fits at this zoom. A real chart runs about 5–8 px a bar |
| Chart bars, and every setting | Built from the indicator's own `params`, and each change re-runs it |

**Chart shows** switches between the indicator alone, with the price pane to itself, and the indicator with the strategy's trades and equity. The address bar carries it all, so a link restores the view.

From the command line, the same checks with a link to the chart:

```bash
npm run mock -- mnqDonchian1250 --date 2026-03-10
```

## What is real, and what is a guess

Real:

- **The runtime** is built from Tradovate's public definitions: what `map()` receives and may return, the coordinate system, every graphics type and its fields. `vendor/NOTICE.md` says where they came from.
- **The tools** are Tradovate's own files, so an EMA here is its EMA.
- **Every one of its 42 built-in indicators** runs through this with no errors, and `test/mock.test.mjs` keeps it that way. That is also how the checks were corrected: its Bollinger Bands return NaN while warming up, so NaN is a gap, not a fault.
- **The checks** come from the definitions, plus what has failed for people on Tradovate's forum: text with no `fontSize` does not draw, and a colour needs its `#`.

Assumptions, because Tradovate does not document them:

- **Text alignment.** `leftMiddle` is read as the text's left edge at the point, so it runs to the right.
- **Which items draw.** A per-bar item draws while its bar is in view. A `global` one always draws, once per key.
- **A forming bar.** Its own indicators keep running state in tools like EMA, so it must rebuild or restore that state on a live bar. It does not say how. An indicator that passes the forming check is safe either way, and one that does not gets a note.
- **Rectangles** are centred on their position, as its docs say in one place. Its `Instancing` example reads as a corner.
- **Some plotters are simplified.** `cumulative`, `zigzag` and `pivotpoints` draw as plain lines, and `scatter` as dots.
- **Volume detail.** `d.profile()` returns nothing, and `offerVolume()` and `bidVolume()` split the bar's volume in half.

Fonts and exact spacing differ from the platform, so judge what collides and what reads, then take a last look on Tradovate itself.
