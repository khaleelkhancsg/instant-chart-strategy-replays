# Idea loop ledger

The person's request (2026-11-23): keep trying new ideas, novel variables included, until five new
things give significantly better results. Judged by CLAUDE.md "Verdict rules":
- **Screen:** on the year the idea came from (2026 to Oct 30), beat 90 of 100 placebo markets in both
  halves.
- **Confirm:** unchanged on 2025, one run, beat 95 of 100.

Only CONFIRMED counts toward the five.

Already known before the loop (not counted): the reverse-check short lead (databox_room.mjs), the
VWAP break lean (turn_context.mjs), the MACD row's own slight lean.

## Confirmed (count: 1 of 5)

1. **1m EMA Potentially warnings that agree with VWAP's slope are weaker: skip them.**
   - Source: vwap_nodes_confluence.mjs, "1m EMA Pot. / VWAP slope agrees". The warning's call is the
     way the RTH VWAP moved over the last 15 minutes.
   - 2026: those warnings win the 18-point race 4.5 points less often than the rest (46.8%; halves
     -3.9 and -5.3; beyond 95 of 100 placebo markets both halves).
   - 2025, unchanged: -1.8, worse than 98 of 100 (Jan-Jun -4.2; Jul-Oct +0.4, flat).
   - Use: keep 1m EMA warnings that call against VWAP's slope.

## Named for confirmation on 2025 (written before the 2025 runs)

From research/vwap_nodes_confluence.mjs, 2026, beyond 95 of 100 placebo markets in both halves (18-point
race). Judged on 2025 by the same tail:
1. 1m MACD Pot. / VWAP slope agrees: hurts
2. 1m MACD Pot. / session VWAP side: helps
3. 1m EMA Pot. / toward VWAP: helps
4. 1m EMA Pot. / stretched: helps
5. 1m EMA Pot. / VWAP slope agrees: hurts
6. 1m EMA Pot. / session VWAP side: helps
7. 1m EMA Pot. / node in the way: helps
8. lead short / VWAP slope agrees: hurts

Confluence confirmation on 2025 (the other 7 named): not confirmed. 1m MACD / slope agrees 17 of 100 as
low; 1m MACD / session VWAP side 62 as high; 1m EMA / toward VWAP 21; stretched 35; session VWAP side
37; node in the way 64; lead short / slope agrees 40 as low.

## Batches

### Batch 1 (research/idea_lab.mjs --batch 1): 14 signals, 10 filters

Opening drive, failed OR30 / overnight-range breakouts, volume climax, absorption, range expansion,
rejection wick, five bars one way, stretch from EMA21, an order-flow proxy, gap toward settlement, 15m box
flip, IB break, lunch-lull breakout. Filters on the box's signals: volume, 15m agreement, the morning,
ATR rising, order flow, session extreme, long move, fading volume, and the lead with the 15m and VWAP.
Screen (2026, 100 placebo markets, 18-point race): two pass.
- potM1 after a long move: +3.1 (halves beat 92 and 98 of 100).
- lead below VWAP: -8.8, so the reverse is the candidate (lead short only above VWAP); halves worse than 97 and 93.

Near misses: 15m box flip (+3.1; halves 84 and 96), five bars one way (H2 fails), potE1 with volume fading
(H2 fails).

Named for confirmation on 2025, judged by the same tail at 95 of 100:
- potM1 after a long move: helps
- lead below VWAP: hurts

Confirmation (2025): neither. potM1 after a long move -2.1 (the other way; 9 of 100 as low); lead below
VWAP +0.6 (62 of 100 as low).

### Batch 2 (--batch 2): 6 signals, 10 filters (VXN, red-folder news, divergence, overnight range, range used, options expiry, half-hour turns, prior day)

Screen (2026): one pass, half-hour turn (+0.6 points of win rate; beats 97 of 100, halves 93 and 94). Small.
The rest fail. Notable: flip1 when VXN is high hurt in Jan-Jun only; range exhausted helped in Jan-Jun only.

Named for confirmation on 2025: half-hour turn: helps.
Confirmation (2025): not confirmed on the judged 18-point race (-0.2, 21 of 100). The 37-point race beside
it shows +2.1 (5 of 100), but that was not the race named, so it cannot count; at most a lead for a
37-point version, which would have to restart at the screen.

### Batch 3 (--batch 3, screen 2025, confirm 2024): MES cross-market and session structure

Screen (2025): no pass. MES leads / MNQ lags beat every placebo market in Jan-Jun (+4.9) and lost to every
one in Jul-Dec (-7.2): a lean that reverses, not usable (and MES/MNQ roll stitching may play a part). MNQ
new high without MES: +1.2 overall (95 of 100), but Jan-Jun at 50.

### Batch 4 (--batch 4): London close fade, developing POC, value acceptance, close location, VWAP 1-sigma fade, quiet / chop / dried-up / month-start / outside-value flips

Screen (2026): no pass. Near misses: VWAP 1-sigma band fade (+2.1, overall 93 of 100, halves 82 and 83);
flip1 in the first 3 days of a month (+4.9, overall 95, halves 81 and 92); London close fade (+5.0, too
few events: 138).

### Batch 5 (--batch 5): stop runs, overnight inventory, narrow days, trend days, the VWAP-slope rule on the 5m rows

Screen (2026): no pass. The VWAP-slope rule leans the same way on the 5m rows, but not in both halves:
potM5 against VWAP slope +4.4 (overall 98 of 100, halves 84 and 98); potE5 +5.3 (Jul-Oct only). Half-hour
turn on the 37-point race in 2026: halves 99 and 80, so it fails the screen too.

### Batch 7 (--batch 7): published intraday momentum, time-of-day flows, the VWAP-slope rule pooled, weekly and Globex bias

Results: pending.
