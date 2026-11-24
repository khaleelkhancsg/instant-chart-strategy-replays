# Idea loop ledger

The person's request (2026-11-23): keep trying new ideas, novel variables included, until five new
things give significantly better results. Judged by CLAUDE.md "Verdict rules":
- **Screen:** on the year the idea came from (2026 to Oct 30), beat 90 of 100 placebo markets in both
  halves.
- **Confirm:** unchanged on 2025, one run, beat 95 of 100.

Only CONFIRMED counts toward the five.

Already known before the loop (not counted): the reverse-check short lead (databox_room.mjs), the
VWAP break lean (turn_context.mjs), the MACD row's own slight lean.

## Paused 2026-11-24: resume here

About 220 ideas tried (batches 1-27 screened). Runs stopped part-way, to restart as they were:
1. Confirm toward the session VWAP on 2025 (batch 26, named, not yet run to the end):
   `node --max-old-space-size=16384 research/idea_lab.mjs --batch 26 --year 2025 --only "any warning calling toward the session VWAP"`
2. Its independence check against #2, on 2026 then 2025 (rule written under batch 26): `--batch 28`,
   then `--batch 28 --year 2025`. The IB rows in batch 28 are moot (the IB midpoint failed 2025).
3. Batch 29 (balance filters split at VXN 21): screen `--batch 29`, confirm passes with `--year 2024`.
4. Batch 30 (VIX curve, VXN premium, range broken, 5m inside bar, 15m warning): screen `--batch 30`.
Pattern so far: the "toward balance" filters pass 2026 and 2025 Jan-Jun, then reverse in 2025 Jul-Dec.

## Confirmed (count: 2 of 5; #2 extends #1)

1. **1m EMA Potentially warnings that agree with VWAP's slope are weaker: skip them.**
   - Source: vwap_nodes_confluence.mjs, "1m EMA Pot. / VWAP slope agrees". The warning's call is the
     way the RTH VWAP moved over the last 15 minutes.
   - 2026: those warnings win the 18-point race 4.5 points less often than the rest (46.8%; halves
     -3.9 and -5.3; beyond 95 of 100 placebo markets both halves).
   - 2025, unchanged: -1.8, worse than 98 of 100 (Jan-Jun -4.2; Jul-Oct +0.4, flat).
   - Use: keep 1m EMA warnings that call against VWAP's slope.
2. **Any box warning (1m/5m, EMA/MACD rows pooled) against VWAP's 15-minute slope does better.**
   - Source: batch 7, "any box warning against VWAP slope" (from #1 and batch 5's 5m leans, so it
     passed both stages afresh).
   - 2026: +3.9 points of win rate over the same warnings without the filter (17,563 warnings;
     halves beat 100 and 93 of 100).
   - 2025, unchanged: +2.2 (beats 97 of 100; Jan-Jun +4.4, Jul-Dec +0.1, flat).
   - Same mechanism as #1, now across every row: an extension, not an independent discovery.

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

Screen (2026): one pass, any box warning against VWAP slope (+3.9; halves beat 100 and 93 of 100). It
contains confirmed #1 (the 1m EMA row), so it counts as new only if it holds beyond that row. The 2025
run reports it as named. The published first-half-hour / last-half-hour momentum: -1.7, nothing.
Named for confirmation on 2025: any box warning against VWAP slope: helps.

### Batch 6 (--batch 6): the flip or warning minute itself

Screen (2026): one pass, potM1 at VWAP's 2-sigma band (+2.3; halves beat 91 and 99 of 100). Near misses:
potE1 with the 5m row warning too (+1.5, overall 96, Jan-Jun 71); flip1 on a strong-bodied bar hurts
(-2.4, Jan-Jun only).
Named for confirmation on 2025: potM1 at VWAP's 2-sigma band: helps.

### Batch 8 (--batch 8): settlement (the prior day's RTH close)

Screen (2026): no pass. Settlement cross -2.0, rejection -2.1, into the settlement toward VWAP +3.1 (85 of
100), potM1 at settlement +3.2 (96 overall, halves 84 and 86). Two reversed strongly in both halves but
had too few events (once-a-day signals, under 100 a half):
- far from settlement at 10:00, fade: -10.0 (worse than 92 and 90 of 100). The reverse, continuing away
  from settlement, is batch 9's lead.
- settle-to-settle momentum: -12.1. Its reverse is the regime study's known next-session reversal, not new.

### Batch 9 (--batch 9): settlement distance as a trend-day sign (from batch 8's reversed result)

Daily signals: minimum 60 events a half, stated before the run.
Screen (2026): no pass by the rules.
- far from settlement at 10:00, continue: +8.6 on the 18-point race (beats 99 of 100; halves 93 and 94;
  37-point +14.3). But Jul-Oct had 54 events, under the 60 minimum, so it fails the screen.
- first time 0.3 range from settlement: -10.9 (Jul-Oct only).
- flip1 far from settlement its way: +1.1, nothing.

Next, the same idea unchanged on fresh years, a stricter two-stage test: screen on 2025 (both halves, 90 of
100, minimum 60 a half), then confirm on 2024 (95 of 100).
Screen (2025): fails. Far from settlement at 10:00, continue +2.6 overall, but Jan-Jun -2.1 (45 of 100) and
Jul-Dec +7.0 (91). Not confirmed: its 2026 strength looks like 2026's trending market. The first-time
version +3.2 (Jan-Jun 84, Jul-Dec 94) misses Jan-Jun too.

Batch 6 confirmation (2025): potM1 at VWAP's 2-sigma band -0.8, not confirmed. Batch 7 confirmation
(2025): any box warning against VWAP slope +2.2, CONFIRMED (#2).

### Batch 10 (--batch 10): 3m box, Heikin-Ashi box, 1m/5m/15m stack, 60-min momentum, VXN jump, turn of the month, month VWAP

Screen (2026): no pass. All near zero. The turn of the month (34 days) and the VXN jump (54) are too rare to
judge.

### Batch 11 (--batch 11): what kind of day it is (VWAP crosses, initial balance width, settlement distance) as context

Screen (2026): no pass. Any warning on a balance day +2.1 (halves 68 and 84); flip1 its way on a trend day
+7.4 (only 153 events; Jan-Jun 72); narrow initial balance break -4.6 (Jan-Jun 87 as high, Jul-Oct 74).

### Batch 12 (--batch 12): the day's participation (volume vs normal) and efficiency, the opening auction, the overnight box

Screen (2026): no pass. Volume regime (light / heavy days) about 0. Warnings in chop -0.9 (halves 84 and
78 as high). Warnings in the opening auction -1.6, but placebo markets lose more there (beats 98 overall,
halves 94 and 87).

### Batch 13 (--batch 13): the box's own readings (the side's age, repeat warnings, histogram depth, long sides ending, afternoon)

Screen (2026): one pass, potM1 repeated within 10 bars (+2.5; beats 100 of 100, halves 94 and 99). Near
misses that fail Jan-Jun: deep histogram fall +2.5 (88), potE1 after a mature side +1.9 (82), potM1 in a
young side -2.2 (a clear hurt in Jan-Jun only).
Named for confirmation on 2025: potM1 repeated within 10 bars: helps.
Confirmation (2025): not confirmed, -1.0 (84 of 100 as high; Jul-Dec -2.1, the other way).

### Batch 14 (--batch 14): repeat warnings on other rows, both rows together, sustained easing, warnings that clear (trend resumes), price stalled

Screen (2026): one pass, both 1m rows warning together (+3.3; beats 100 of 100, halves 100 and 99). The
rest fail: potE1 repeated +1.2 (Jan-Jun 56); three bars of easing hurts in Jul-Oct only; warnings that
clear (trend resumes) about 0.
Named for confirmation on 2025: both 1m rows warning together: helps.
Confirmation (2025): not confirmed, +1.1, the same direction but beats only 92 of 100 (needs 95; Jan-Jun
+1.8 at 96, Jul-Dec +0.5). A failed confirmation is final.

### Batch 15 (--batch 15): the 1m MACD warning beside the 5m rows, trend strength, a stretched EMA gap

Screen (2026): no pass. potM1 with the 5m box already turned its way -2.1 (as low: 12 and 10 by half,
just over); potM1 in a strong trend -3.4 (Jul-Oct only).

### Batch 16 (--batch 16): value migration, the open's type, 5m ADX as context, big-gap days, warnings through VWAP

Screen (2026): no pass. Every idea fails a half: value migration +0.8, ADX over 25 +0.3, warnings
calling through VWAP +0.9 (Jul-Oct 54).

### Batch 17 (--batch 17): is confirmed #1/#2 about the session's drift in general? Warnings against other measures of it

Screen (2026): one pass, any warning against the day's direction (price vs the RTH open): +2.5, beats 98
of 100 (halves 95 and 94). Near: against the 5m EMA's slope +2.2 (Jul-Oct 78); against the last hour's
slope +1.0; against a steep VWAP slope +1.3 (Jul-Oct 65).
Named for confirmation on 2025: any warning against the day's direction: helps.
Confirmation (2025): not confirmed, +0.2 (48 of 100; Jan-Jun +1.9, 95 as high; Jul-Dec -1.4). The
counter-drift lean holds for VWAP's slope (#1, #2) but not for price against the RTH open.

### Batch 18 (--batch 18): the box's flips (with the day's direction, after a 5m flip, held a bar, breaking the 30-min range, both rows crossing together)

Screen (2026): none pass. With the day's direction -0.7 (63 of 100); after a 5m flip -2.1 (205 events,
64); held a second bar -0.8 (78); breaking the 30-minute range -1.5 but the halves disagree (Jan-Jun -5.9,
96; Jul-Oct +4.7, 6 as high); both rows within 3 bars +1.0 (84 as high; Jul-Oct -1.4). The mirror of #3
does not hold for flips: the counter-drift lean belongs to the warnings.

### Batch 19 (--batch 19): the day's last warning worked, round hundreds, volatility bursts, volume flow against price, the week's direction, the 5m bar's closing minute

Screen (2026): one pass, the other way round from its hypothesis. Warnings after the day's last resolved
warning reached its target first are worse: -1.5 (15,262 warnings; 99 of 100 as low; halves 97 and 92;
37-point -1.9, 100). So warnings after a failed one, or before any has resolved, do better. A likely
mechanism: after a warning works, the next one usually calls back the earlier way, with the drift #1-#3
say to skip. Near: the 5m closing minute -1.0 but the halves disagree (Jan-Jun +1.1, 95 as high; Jul-Oct
-4.1, 100 as low); round 100 -1.0 (76); burst -2.3 (67 as high); flow +0.2; week -0.2.
Named for confirmation on 2025: any warning after the day's last warning worked: hurts.
Confirmation (2025): not confirmed; the sign flips, +1.2 (89 of 100 as high, the wrong tail; halves +1.5
and +0.9).

### Batch 21 (--batch 21): between the two VWAPs, the forming 5m bar its way, Fridays, toward the overnight midpoint, VWAP flat

Screen (2026): one pass, any warning calling toward the overnight midpoint: +2.6 (17,046 warnings; 100 of
100; halves 99 and 96; 37-point +1.3, 78). Near: between the two VWAPs -1.4 (Jan-Jun +0.5; Jul-Oct -3.6,
99 as low); VWAP flat +0.1; forming 5m bar +0.1; Friday +0.3.
Named for confirmation on 2025: any warning calling toward the overnight midpoint: helps.
Confirmation (2025): not confirmed, +0.7 (80 of 100; Jan-Jun +3.0, 99; Jul-Dec -1.4, the other way).

### Batch 23 (--batch 23): other balance points: toward the prior day's midpoint, its POC, the 17:00 open, the OR30 midpoint, the IB midpoint

Screen (2026): two passes, both the day's own early balance. Toward the IB midpoint (after 09:30) +3.3
(14,509 warnings; 100 of 100; halves 97 and 91); toward the OR30 midpoint (after 09:00) +2.8 (98; halves 93
and 95). The 37-point race is weaker (+1.0, +0.9). Near: toward the 17:00 open +1.6 (96; Jul-Oct -0.2);
toward the prior day's midpoint and POC +0.9 (84; Jul-Oct flat).
Named for confirmation on 2025: any warning calling toward the IB midpoint: helps; any warning calling
toward the OR30 midpoint: helps. Written before the run: OR30 is the IB's first half, so the two count as
ONE finding if both confirm.
Confirmation (2025): not confirmed. IB midpoint +1.2 (80 of 100; Jan-Jun +3.4, 100; Jul-Dec -1.0); OR30
midpoint +1.0 (81; Jan-Jun +2.8, 98; Jul-Dec -0.7). The same shape as the overnight midpoint (batch 21):
the balance filters work in 2026 and in 2025's volatile first half, and fail in 2025's quiet grind
higher (Jul-Dec).

### Batch 25 (--batch 25): a narrow warning bar, the 1m rows split, the way yesterday closed strong, after a heavy overnight

Screen (2026): none pass. Narrow bar +2.0 but only 768 warnings (80); rows split +0.0; the way yesterday
closed strong -0.9 (87 as low); heavy overnight -0.7.

### Batch 27 (--batch 27): the warned trend's volume and size, an inside bar, a 5m row warning the other way

Screen (2026): none pass. Inside bar +1.6 (99 overall; Jan-Jun 72, Jul-Oct 98); light-volume side +0.5
(halves +2.1 / -1.5); small move -0.2; a 5m row warning the other way -0.7.

### Batch 20 (--batch 20): against the opening gap, both extremes an hour old, the warning bar closing its way, 3+ fresh extremes, inside the prior day's range

Screen (2026): one pass, any warning inside the prior day's range: +1.3 (12,024 warnings; 99 of 100;
halves 95 and 91; 37-point +0.9, 88). Near: both extremes an hour old +1.2 (Jul-Oct -0.1); 3+ fresh
extremes +0.8 (Jan-Jun -0.4); against the gap -0.9 (82 as low; Jan-Jun +0.1); bar closing its way -0.6.
Named for confirmation on 2025: any warning inside the prior day's range: helps.
Confirmation (2025): not confirmed, +0.6, the same direction but beats only 85 of 100 (halves +0.3 and
+0.9).

### Batch 22 (--batch 22): the day after a wide day, after the day's last flip failed, after a wide overnight, against a multi-day stretch, on a heavy-volume bar

Screen (2026): none pass. Day after a wide day +1.0 (95 of 100, but Jan-Jun 82); after the last flip
failed -1.0 (89 as low); wide overnight +1.0 (74); multi-day stretch -1.0 (88 as low; 37-point -2.7, 95);
heavy-volume bar -1.2 (1,574 warnings, 59).

### Batch 24 (--batch 24): inside other ranges: the overnight range, the IB, OR30, the prior day's value area; against a 3-day streak

Screen (2026): none pass. Inside the prior day's value area +1.3 (96; Jan-Jun 84); inside the overnight
range +0.3; inside the IB +0.3 (halves +1.8 / -1.6); inside OR30 +0.4; against a 3-day streak -0.3. Where
price sits does not matter; batch 23 says the warning's direction toward the day's balance does.

### Batch 26 (--batch 26): siblings of batch 23 (toward the developing POC, the day's midpoint, the session VWAP); before a release; a day full of warnings

Screen (2026): one pass, any warning calling toward the session VWAP (17:00 onward): +3.2 (17,684
warnings; 100 of 100; halves 99 and 99; 37-point +2.5, 86). Near: toward the day's midpoint +3.5 (99;
Jan-Jun 100, Jul-Oct 86); toward the developing POC +1.8 (89); a day full of warnings +2.3 (77); before a
release 223 warnings, too few to read.
Named for confirmation on 2025: any warning calling toward the session VWAP: helps.

Written before the 2025 runs: toward the session VWAP and toward the IB midpoint may be #2 again (a
warning against VWAP's slope often calls back toward VWAP). Each counts as a new finding only if it
confirms AND, in batch 28, it lifts warnings on both sides of #2's split (with VWAP's slope, against
it) in the same direction, beating 90 of 100 on 2026 and on 2025 in each. Toward the session VWAP is
judged as its own finding; the IB midpoint (batch 23) as another; if both pass they still need to show
they are not the same warnings (overlap reported).

### Batch 30 (--batch 30): VIX above VXV, VXN's premium over VIX above its median, yesterday's range broken today, a 5m inside bar, a 15m row warning the same way

Changed before the full run (seen on one placebo market only): the VXN premium was "VXN 1.25x VIX or
more", true every day of 2026 Jul-Oct, so it could not split that half; now against its 60-day median.
VIX above VXV happened on no day of 2026 Jul-Oct, so it cannot pass the both-halves rule; kept as read.

Results: pending.

### Batch 29 (--batch 29, screen 2026, confirm 2024): do the balance filters need a volatile market? (toward the IB midpoint and the session VWAP, split at VXN 21)

Why: the balance filters (overnight, OR30 and IB midpoints) worked in 2026 (VXN median about 24) and 2025
Jan-Jun (22) and failed in 2025 Jul-Dec (20). 2025's halves have been seen, so the confirmation is 2024
(VXN medians 17 and 21), unused by these filters. One threshold, 21, fixed before the run, near the
long-run median. Finding = a high-VXN row passing both stages.

Results: pending.

### Batch 28 (--batch 28): independence checks for batch 23 and 26 against confirmed #2

Results: pending.
