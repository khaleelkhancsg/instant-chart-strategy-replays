# donchian_1250 idea loop ledger

The person's request (2026-11-26): batch research on the Donchian book, as the databox idea loop did. Harness:
`research/donchian_lab.mjs --batch N` (its header has the rules in full, written before batch 1 ran).

- **The book:** donchian_1250 as shipped, $1,250 settings, the lab's engine, data/mnq_1m_beta.bin (2019-05 to 2026-10-30).
- **An idea** refuses some of the book's trades, by what the market showed when the signal bar closed. Each states
  who is on the other side.
- **Lift:** the mean ATR-unit result of the trades kept less that of the trades refused; against the same book on 100
  placebo markets (each bar's move flipped, its range kept; seeds 9100 + p).
- **Screen** (2025-2026 weighted first, the person's rule): the lift pooled over 2025 H1, 2025 H2, 2026 Jan-Mar and
  2026 Apr - Jul 14 beats 90 of 100 placebo markets, is positive in 2025 and in 2026, and keeps 30% of trades or more.
- **Confirm** (the person's 10% bar): 2019-2024 beats 90 of 100 and the forward bars (Jul 15 - Oct 30, about 70 trades)
  are positive.
- **Ship test:** a confirmed rule's full engine run, pass rate on live equity against the shipped book (2025, 2026,
  forward). The audit's baseline (research/donchian_audit.mjs): 2025 45.1% every day / 50.6% back to back; forward
  44.2% / 45.4%; coin-flip twins about 25-37% on closed trades.

Trial count: batches 1-3, 25 ideas.

## Batch 1 (written before it ran): VWAP side, VWAP slope, not stretched, room in the day's range, beyond the prior
day's extreme, not at lunch, the fast row not warning against it, heavy relative volume, VXN above its median

A 1-placebo smoke run (counts only checked: 2,049 / 137 / 139 / 58 / 70 / 70 trades by period) printed the real
numbers of the last two ideas (relative volume, VXN) before the full run. Their verdicts follow the rules as written.

Results (168 s): nothing confirmed. lift (placebo markets beaten) pooled 2025-26 | 2025 | 2026 | kept | 2019-24 | forward
- VXN above its 60-session median: +0.345 (98) | +0.383 | +0.236 | 49% | +0.148 (87) | +0.678 (92): SCREEN PASS,
  not confirmed (2019-24 at 87, needs 90). The nearest miss.
- not stretched (within 2 five-minute ATRs of VWAP): +0.381 (91), both years positive, but keeps 28% (< 30%); 2019-24
  +0.110 (73), forward +0.462 (86). Fails on the kept floor.
- the others fail the screen: with VWAP +0.911 (65; 2026 -1.232; keeps 99%), VWAP slope -0.091 (35), room in the day's
  range -0.016 (56), beyond the prior day's extreme +0.070 (64), not at lunch -0.113 (28), the fast row not against it
  +0.151 (76; 2026 -0.463), heavy relative volume -0.175 (15).

## Batch 2 (written before it ran): a wide signal bar, no losing trade earlier today, beyond the 30-minute opening
range, the gap its way, beyond the overnight extreme, a trend day (half an ADR from the open), the 5m EMA row not
warning toward the trade (#5), volatility expanding

Results (189 s): nothing confirmed.
- a wide signal bar: +0.413 (96), 2025 +0.646, 2026 +0.056, keeps 75%: SCREEN PASS; 2019-24 -0.116 (12), forward
  -0.106 (36): not confirmed.
- the gap its way +0.179 (80) and beyond the overnight extreme +0.149 (67) fail the screen, though 2019-24 is strong
  (+0.229 at 98, +0.234 at 97); both are negative forward (6, 7).
- no losing trade earlier today -0.454 (11): refusing after a loser refuses better trades. Beyond the opening range
  -0.011 (50), trend day +0.137 (63; keeps 37%), the 5m EMA row not toward it +1.272 (82; keeps 99%, 2026 no refusals),
  volatility expanding -0.140 (19).

## Batch 3 (written before it ran): with the 20-session average, yesterday closed strong its way, at a new session
extreme, through a round 100, the first or last two hours, the day already 1 ADR wide, on the trade's side of the
RTH open, VXN at 25 or above

Results (191 s): nothing confirmed.
- through a round 100: +0.364 (91), both years positive, keeps 61%: SCREEN PASS; 2019-24 +0.030 (33): not confirmed
  (forward +1.101 at 98).
- VXN at 25 or above: +0.336 (91), both years positive, but keeps 25%; 2019-24 +0.235 (96), forward +0.215 (69). With
  batch 1's VXN-above-median (screen 98, 2019-24 87, forward 92) the VXN family is the loop's most consistent lead.
- yesterday closed strong its way +0.399 (98) but keeps 23% and is -1.336 forward; at a new session extreme +0.238
  (80); price on the trade's side of the RTH open +0.797 (83; keeps 97%); with the 20-session average -0.100 (29; 2019-24
  90); the first / last two hours -0.116 (31); the day already 1 ADR wide -0.026 (41).

Trial count after batch 3: 25.

## Batch 4 (written before it ran): momentum and compression. The last hour moved its way by 2 five-minute ATRs, the
last 5 sessions its way, yesterday an inside day, yesterday NR7, beyond the 5-session high / low, the signal bar closing
in its top / bottom fifth, 1m RSI not stretched, the day's first breakout its way

Results (309 s): nothing passes the screen. Last hour its way -0.305 (17; forward +0.928 at 92), last 5 sessions +0.012
(49), inside day -0.064 (33; keeps 10%), NR7 -0.432 (6; keeps 19%), beyond the 5-session range +0.035 (56), bar closing
at its extreme +0.020 (46), RSI not stretched +0.058 (65), the day's first breakout its way +0.158 (71; 2026 -0.556).

## Batch 5 (written before it ran): calendar and events. No red-folder release in the last 30 minutes, not a release
day, not Monday, not Friday, not an options-expiry Friday, not the month's last two sessions, not the session before
mega-cap earnings, a mega-cap earnings session

Results (341 s): nothing confirmed.
- not a Monday: +0.665 (100), 2025 +0.716, 2026 +0.555, keeps 81%: SCREEN PASS; 2019-24 -0.030 (33), forward -1.035 (6):
  not confirmed.
- no release in the last 30 minutes +3.778 (97) refuses almost nothing (no 2026 trade within 30 minutes of a release).
- not an options-expiry Friday -0.980 (1): refusing expiry Fridays HURTS in 2025 and 2026 (-1.004, -0.920; forward -1.356).
  The reverse (expiry Fridays are good breakout days) is a lead, found after looking.
- release day -0.142 (24), Friday -0.073 (36), month-end -0.308 (26; 2019-24 +0.341 at 96), before earnings -0.153 (31),
  an earnings session -0.046 (37; keeps 12%).

Trial count after batch 5: 41.

## Batch 6 (written before it ran): macro, each read before the session. With yesterday's 10-year yield move, with the
dollar's week, with credit's week, VIX below VIX3M, VXN up over 5 sessions, VXN above 1.25 x VIX, with leveraged funds'
net NQ position, with its weekly change

Results (310 s): nothing passes the screen. Credit's week +0.201 (84), yields +0.003 (59), VIX curve calm +0.056 (62),
VXN 5-day rise -0.018 (46), VXN / VIX -0.054 (42; keeps 29%), the dollar -0.305 (7), leveraged funds' position -0.272
(8), their weekly change -0.028 (45; 2019-24 +0.162 at 94, but 2026 -0.797).

## Batch 7 (written before it ran): breakout structure. A narrow channel, a tested level, a fresh push after a 1-ATR
pullback, breakout volume twice the hour's, the hour's efficiency 0.3+, under 1 ADR from the day's opposite extreme, no
losing trade in the last 30 minutes, the 15-minute EMA 20 agrees

Results (316 s): nothing passes the screen. Tested level +0.200 (78; 2025 -0.037), not extended +0.061 (64), efficiency
-0.098 (26), breakout volume -0.273 (12), narrow channel -0.159 (24; keeps 17%). DESIGN SLIPS (they refuse no 2025-26
trade, so they tested nothing): a fresh push (a 1-ATR pullback happens in almost every hour), no loser in the last 30
minutes (the day rules make it rare), the 15-minute EMA agrees (the book's own 10-minute EMA filter already enforces it).

Trial count after batch 7: 57 (3 of them slips).

## Batch 8 (written before it ran): session structure. With the opening drive, after a narrow first hour, the first
hour not broken the other way first, on the trade's side of yesterday's final VWAP, of yesterday's midpoint, a narrow
overnight, with a 3-session close streak, fewer than 2 losers earlier today

Results (322 s): nothing confirmed.
- with the opening drive: +0.373 (94), 2025 +0.483, 2026 +0.174, keeps 50%: SCREEN PASS; 2019-24 -0.090 (21), forward
  -0.036 (35): not confirmed.
- narrow first hour -0.324 (7; keeps 28%), first hour not broken the other way -0.002 (49), yesterday's VWAP +0.009 (51),
  yesterday's midpoint -0.073 (32), narrow overnight +0.041 (60; keeps 10%), 3-session streak +0.099 (61; keeps 14%).
  Fewer than 2 losers earlier today refuses no 2025-26 trade (a slip: the day blocks stop the day first).

Trial count after batch 8: 65 (4 slips). Screen passes so far, all failing 2019-2024: VXN above its median (87; forward
92), a wide signal bar (12), through a round 100 (33; forward 98), not a Monday (33), the opening drive (21).

## The confirmation rule changes from batch 9 (the person's choice, 2026-11-26, asked after batch 8)

RECENCY-WEIGHTED: a screen pass is CONFIRMED when its forward lift (Jul 15 - Oct 30) beats 90 of 100 placebo markets with
20 or more forward trades kept, and 2019-2024 does not go the other way (its lift beats at least 10 of 100). Chosen after
seeing batches 1-8, so it applies from batch 9 only. Two of the earlier screen passes would meet it, and are LEADS for
the next forward bars, not results: VXN above its 60-session median (forward +0.678, 92; 2019-24 87) and through a round
100 in the last 10 minutes (forward +1.101, 98; 2019-24 33).

## Batch 9 (written before it ran; recency-weighted confirmation): the breakout bar. A strong body, the last 3 closes
its way, volume rising into the break, no rejection wick, within 1 ATR of the 1m EMA 21, the 1m MACD histogram growing
its way, the close beyond the bar before's extreme, the last 5-minute bar closed its way

Results (517 s): nothing passes the screen. Strong body -0.204 (15), 3 closes its way -0.140 (34), volume rising -0.471
(0: refusing these HURTS), no rejection wick +0.045 (43), MACD histogram growing +0.113 (73; 2019-24 -0.255 at 1), 5-minute
bar its way +0.113 (72). SLIPS: within 1 ATR of the EMA 21 keeps 0% (a breakout is always beyond it); closing beyond the
bar before's extreme refuses nothing (the breakout already does).

## Batch 10 (written before it ran; recency-weighted): levels and room. Room to the next round 100, the overnight
midpoint, the week's open, the month's open, inside the VWAP 1-sigma bands, beyond the band its way, room to the
20-session extreme, a new 20-session extreme

Results (518 s): nothing confirmed under the recency rule.
- on the trade's side of the overnight midpoint: +0.954 (96), 2025 +0.623, 2026 +1.539, keeps 95%: SCREEN PASS; forward
  +0.755 (75): NOT CONFIRMED (needs 90); 2019-24 +0.409 (91). Under batches 1-8's rule (2019-24 beats 90, forward
  positive) it would have confirmed. Positive in every period: the loop's best candidate, a LEAD for the next forward bars.
  It refuses only 5% of trades.
- the week's open -0.488 (0: refusing trades against it HURTS in 2025-26; 2019-24 +0.100), inside the VWAP bands +0.469
  (85; keeps 3%), beyond the band -0.128 (31), the month's open -0.056 (35), room to round 100 -0.052 (31), room to the
  20-session extreme -0.121 (33), a new 20-session extreme -0.061 (41; keeps 19%).

Trial count after batch 10: 81 (6 slips).

## Batch 11 (written before it ran; recency-weighted): day activity. 1m ATR above its 20-session average, an active
night, a gap of 0.3 ADR+, yesterday 1.2 ADR+, VXN up 5% yesterday, VXN in its year's top third, the day's high made in
the last hour (longs), today's range over half an ADR

Results (three batches at once: 2.6 hours): nothing confirmed.
- VXN in the top third of its last year: +0.222 (91), 2025 +0.089, 2026 +0.380, keeps 44%: SCREEN PASS; forward +0.275
  (77): not confirmed (2019-24 +0.109, 65). The third VXN rule to pass the screen (with batch 1's median and batch 3's 25+).
- yesterday 1.2 ADR+ +0.400 (94) but keeps 27%; the day's high made in the last hour +0.277 (85; 2019-24 +0.398 at 98,
  forward -1.581 at 0); VXN up 5% yesterday +0.108 (59; forward +1.199 at 100, keeps 17%); active day -0.011 (34; forward
  98); active night -0.116 (29); gap 0.3 ADR -0.086 (39); range over half an ADR +0.050 (57).

## Batch 12 (written before it ran; recency-weighted): the bigger trend. With the 200- and 50-session averages, last
week, the month so far, yesterday's candle, today's VWAP over yesterday's, opened beyond yesterday's range, 50 over 200

Results: nothing passes the screen. The longer trends split by era: 2019-24 mostly positive (opened beyond yesterday's
range +0.201 at 98; 50 over 200 +0.145 at 76; 200-session +0.119 at 70), 2025 negative for every one (-0.19 to -0.64),
2026 positive. Pooled 2025-26: 200-session -0.003 (56), 50-session -0.159 (19), last week -0.120 (35), month +0.004 (45),
yesterday's candle -0.190 (15), VWAP over yesterday's +0.097 (70), opened beyond -0.212 (9), 50 over 200 -0.076 (37).

## Batch 13 (written before it ran; recency-weighted): the book's own record (regime-following, as ADAPT). Its last 60
sessions made money, its last 20 trades won 60%+, its last 5 made money, the previous trade today won, the day's P&L not
negative, the same direction as the previous trade, 20 minutes since the last exit, the side that paid more lately

Results: nothing passes the screen.
- the book's last 20 trades won 60%+: +0.389 (96), 2025 +0.460, but 2026 -0.052 (fails "positive in 2026"); 2019-24
  +0.236 (100); forward -0.329 (36). Regime-following works on the book over 2019-2025, not since.
- the side that paid more lately -0.095 (35; 2019-24 +0.201 at 98); previous trade today won -0.287 (11; keeps 19%);
  20 minutes since the last exit +0.279 (85; 2026 -0.520); same direction as the last trade +0.250 (60; keeps 98%); last
  60 sessions made money -0.097 (59); last 5 trades +0.001 (56); day P&L not negative -0.190 (41).

Trial count after batch 13: 105 (6 slips). Screen passes: 7, none confirmed. Leads for the next forward bars: the
overnight midpoint (every period positive), the VXN family (3 screen passes; forward 77-92), through a round 100.

## Batch 14 (written before it ran; recency-weighted): MANAGEMENT, each a whole re-run of the book (lift = the variant's
total ATR-unit result less the book's, per book trade). Flat by 14:30, 30 minutes' rest after a stop, hold through an
opposite signal, out after 30 minutes, a market entry on the signal, no entries after 14:00

Results (966 s): nothing passes the screen. Flat by 14:30 +0.031 (82; 2026 -0.026), market entry +0.089 (87; 2026 -0.189,
forward -0.161), out after 30 minutes -0.099 (11), hold through an opposite signal +0.002 (68; it almost never happens),
no entries after 14:00 -0.001 (35). SLIP: 30 minutes' rest after a stop changes no trade (the day blocks end the day
first).

Trial count after batch 14: 111 (7 slips).

## Batch 15 (written before it ran; recency-weighted): order flow and structure. Signed volume its way over 15 minutes,
higher highs and lows over the hour, a squeeze before the break, accelerating, beyond the developing value area, on the
trade's side of the developing POC, the hour's net move its way, not after a spike bar

Results (616 s): nothing passes the screen. Signed volume its way +0.794 (82; keeps 99%, 2026 refuses none), not after a
spike +0.306 (88; 2026 -0.199), higher highs and lows +0.163 (85), beyond the value area +0.201 (65; forward -0.821), a
squeeze +0.180 (68; keeps 7%), accelerating -0.195 (24), the developing POC -1.303 (6; keeps 100% in 2026). SLIP: the
hour's net move its way refuses nothing (a 60-bar breakout always has it).

Trial count after batch 15: 119 (8 slips). Screen passes 7, confirmed 0.

## Forward test of the three leads (written 2026-11-26, before any bar after 2026-10-30 is read)

The leads, frozen exactly as their batches wrote them: L1 on the trade's side of the overnight midpoint (batch 10);
L2 VXN above its 60-session median (batch 1); L3 through a round 100 in the last 10 minutes (batch 3). (Batches 3 and
11's other VXN rules are near-duplicates of L2 and are not tested separately.)
- When: once data/mnq_1m_beta.bin holds 40 or more RTH sessions after 2026-10-30 (needs the TopstepX key regenerated,
  then npm run data:pull and data:build), and again at 80 if undecided. Run with the harness's periods extended to a
  "forward 2" period starting 2026-10-31, 100 placebo markets, nothing else changed.
- HOLDS: lift positive and beating 90 of 100 placebo markets, with 20 or more trades kept. Then the ship test (full
  engine, live equity) against the shipped book on all bars from 2026-07-15.
- KILL: lift negative, or beating fewer than 50 of 100: dropped. Between: undecided, read again at 80 sessions.
