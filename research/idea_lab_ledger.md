# Idea loop ledger

The person's request (2026-11-23): keep trying new ideas, novel variables included, until five new
things give significantly better results. Judged by CLAUDE.md "Verdict rules":
- **Screen:** on the year the idea came from (2026 to Oct 30), beat 90 of 100 placebo markets in both
  halves.
- **Confirm:** unchanged on 2025, one run, beat 95 of 100.

Only CONFIRMED counts toward the five.

Already known before the loop (not counted): the reverse-check short lead (databox_room.mjs), the
VWAP break lean (turn_context.mjs), the MACD row's own slight lean.

## The base readings redefined (research/databox_base.mjs, written 2026-11-25)

The person's point: the combinations are built from the rows' base readings, so a cleaner base lifts
everything built on it. This changes how each row reads its line (the settings study changes the lengths).
Written before the run (the script's header has it in full): per row (1m/5m x EMA/MACD), 5 side definitions
(cross, hysteresis at 0.05 / 0.10 / 0.25 ATR, a cross held 2 bars) and 9 warning definitions (shrink, speed,
slowing, back 25% / 50% from the peak, a 0.1-ATR fade, two fading bars, projected to cross within 3 / 6
bars); 56 readings, each scored alone by the 18-point race against 100 placebo markets. Verdict: per row and
kind, the best on 2019-2025 read on 2026 less the current definition; the mean gain over the 8 cells must
beat 95 of 100 placebo markets making the same picks. Check: the current definitions must give the
indicator's own onsets. If a better base passes, it becomes extra settings in databox_tune.mjs.

Results (2026-11-25, 612 s, research/databox_base_results.json). Check passed: the current definitions gave
the indicator's own onsets exactly (1m EMA 511,838; 1m MACD 434,805; 5m EMA 102,688; 5m MACD 84,965).
VERDICT: not a better base. Mean gain over the 8 cells +0.4 points; 21 of 100 placebo markets as high.
  Picks (2019-25 best, gain on 2026 vs current): 1m EMA side hyst25 +0.0; 1m EMA warn shrink +0.4 (12);
  1m MACD side cross +0.0; 1m MACD warn slowing +0.3 (21); 5m EMA side hyst25 +0.5 (37); 5m EMA warn fade50
  -1.0 (71); 5m MACD side hold2 +2.6 (10); 5m MACD warn slowing +0.2 (34). None beats 90 alone.
What the table says (every definition, 2019-25 and 2026, each against placebo markets):
- No side definition has an edge: every cross, held cross and hysteresis cross is at or below zero (they
  are late by construction). Hysteresis halves the flips undone in 5 bars, but placebo markets drop the same.
- The 1m warnings (shrink, speed, slowing) beat all 100 placebo markets on 2019-2025 (+0.4 to +0.9) and stay
  positive in 2026 (+0.3 to +1.2, 2 to 30 placebo as high). Small and real, already in the box; the
  alternatives (fades from the peak, two fading bars, projected crosses) are no better and mostly worse.
- The 5m EMA warnings are negative on 2019-2025 (shrink -1.6, 100 of 100 placebo as high) but positive in
  2026: the sign is not stable. 5m EMA twofade 2026 +3.5 (0 as high, both halves) but 2019-25 -1.0: a lead
  for nothing (it fails the older years).
- Warnings are followed by a cross no more often than on placebo markets: that share is arithmetic, not foresight.
Not added to databox_tune (no passing base).

## The person's call (2026-11-25): confirmation at 10%, full control, keep going with novel ideas

From here a confirmation needs to beat 90 of 100 placebo markets (was 95). About 43 confirmation tests so far:
at 10% about 4 would pass by chance, so every pass is also checked over the long history. Passing at 10%
before this: #1, #2, #3 (and two "less wrong" 5m lengths, and L5 = #2 again), plus batch 14's "both 1m rows
warning together" (2025 +1.1, 92 of 100).

### A second unseen market: ES 2010-2026, and the long-history checks (written before any of these runs)

data/es_1m.bin, built from Desktop\Backtesting\ES CSV (2010-06-06 to 2026-03-23, 64 rolls adjusted, worst
seam 4.5 points). No idea or study has read ES (MES 2019 on fed only batches 3 and 40's cross-market ideas).
research/light_check.mjs: idea_lab's own definitions (checked equal: F1, F2 to batch 53 on 2026, B14 to batch
14 on 2026, 2,690 warnings +3.3). Placebo seeds 5100 + p. Each run once:
1. B14 (both 1m rows warning together) over the long history: NQ 2010-2018 and ES 2010-2026. Holds = the
   expected sign beating 90 of 100 on each; the other way beyond 90 = a regime finding like #1 / #2.
2. NOVEL, ADAPT: #1 / #2 flip with the regime, so follow the side of VWAP's slope that won over the last 60
   sessions (only past sessions; the window chosen as one quarter, not tuned). Base: any box warning; the
   filter keeps the warnings on that side; the edge is against the rest (idea_lab's convention). Built after
   seeing #1 / #2's year table, so: screen on NQ 2010-2018 and on MNQ 2019-2026 (each beating 90), then
   confirm on ES 2010-2026 (beating 90). Counts as one of the five if it passes all three.
3. #3 on ES 2010-2026 (databox_lengths.mjs --es): the 1m EMA 3/13 slowing pick against the default; holds =
   gain and its own edge each positive and beating 90 of 100 (the other 7 cells' picks are shown beside it).
4. F1 / F2 on ES 2010-2026: description (does ES show the same regime turn?).
Results so far (2026-11-25; research/light_check_{nq,mnq}_results.json):
- B14 on NQ 2010-2018: -0.6 on 27,863 (halves -0.2 / -1.1), only 10 of 100 placebo markets as bad the expected
  way: REVERSED. Like #1 / #2 it describes recent years; it does not hold.
- ADAPT screen: NQ 2010-2018 +1.1 on 124,010 (beats 100; halves 89 / 100; 2,134 days); MNQ 2019-2026 +1.6 on
  123,040 (beats 100; halves 98 / 100). SCREEN PASS on both. Added before the ES runs, stricter: ADAPT counts
  only if ES confirms (beats 90) with races from the close AND from the next bar's open (bid-ask bounce).
6. NOVEL, ADAPTW (written before any run): the same regime idea for the warnings themselves. Each session, the
   trailing 60 sessions' box warnings (any row) are scored as wins less that session's every-minute win rate
   the same way; if the sum is above 0 the warnings are taken as called, otherwise faded. A signal: its edge
   is its win rate less every counted minute's the same way (idea_lab's signal convention). Screen on NQ
   2010-2018 and MNQ 2019-2026 (each beating 90), confirm on ES 2010-2026 from the close AND the next open
   (each beating 90). Counts as one of the five if all pass.
   ADAPTW screen: NQ 2010-2018 -0.1 on 302,220 (33 of 100); MNQ 2019-2026 +0.1 (96; halves 100 / 33). FAILS (NQ).
7. NOVEL, VOLHI (written before any run): any box warning when the 1m ATR(14) is above the median of the previous
   20 RTH sessions' median 1m ATR (known before the session). Why: reversal warnings need someone leaning against
   the move; in fast markets liquidity providers fade pushes. Expect helps. Same protocol: screen NQ 2010-2018 and
   MNQ 2019-2026 (each beating 90), confirm ES 2010-2026 from the close and the next open (each beating 90).
   VOLHI screen: MNQ 2019-2026 -1.2 on 142,838 (wrong sign; placebo markets pull the same way, 87 of 100 lower):
   FAILS.
ES results (2026-11-25; research/light_check_es_results.json, _es_open_results.json):
- F1 +0.8 (3 of 100 the expected way), F2 -1.2 (0), B14 -0.8 (0): all REVERSED on ES, as on NQ.
- ADAPT from the close +0.4 on 241,697 (beats 92; halves 80 / 82; 3,997 days); from the next open +0.5 on
  247,828 (beats 98; halves 87 / 88). CONFIRMED by the rule written before the runs (90 of 100, both entries).
  Counted: #4. It supersedes #1 / #2: the VWAP-slope effect is real but its sign follows the regime, and
  following the side that won the last quarter works across 17 years and three markets. Small: +0.4 to +1.6
  points of win rate.
5. NOVEL, written while run 3 was going and before its output existed: a 5m warning as a CONTINUATION call.
   The default 5m warnings called the wrong way on MNQ 2019-2025 (EMA -1.4, MACD -1.1; worse than 100 and 97
   of 100 placebo markets) and on NQ 2010-2018 (EMA -1.7, MACD -1.4; worse than all 100), so price tends to
   keep going the side's way. Seen on both, so ES decides: CONFIRMED when the default 5m EMA (and, separately,
   5m MACD) warning's edge on ES 2010-2026 is negative beyond 90 of 100 placebo markets (read from run 3's
   "default" column: placebo markets as high of 90 or more). 2026 MNQ went the other way (EMA +0.4, MACD
   -0.3), so a pass is a long-run tendency, not this year's.
Results 3 and 5 (ES 2010-2026, 4,028 s, research/databox_lengths_es_results.json):
- #3 on ES: 1m EMA 3/13 slowing +0.2 on its own (0 of 100 as high), the default -1.7; gain +1.9 (0 of 100); halves
  +2.7 / +1.1. CONFIRMED on a third market.
- 5m warnings as continuation calls: the default 5m EMA warning -2.2 (all 100 placebo markets higher), 5m MACD -1.6
  (all 100 higher). CONFIRMED by rule 5. Year by year (EMA / MACD edge, points; description):
    NQ  2010 -1.9/0.0, 2011 -2.5/-2.7, 2012 -3.0/-1.5, 2013 -0.7/-1.9, 2014 -2.4/-1.5, 2015 -1.7/-0.6, 2016 -0.8/-0.1,
        2017 -1.2/-1.7, 2018 -1.5/-2.4
    MNQ 2019 -3.4/-1.8, 2020 -2.9/-3.4, 2021 -1.0/-0.6, 2022 -1.3/-1.0, 2023 +0.5/+1.0, 2024 -1.6/-1.5, 2025 -0.6/-0.3,
        2026 +0.4/-0.3
    ES  2010 -3.8/-4.2 ... 2022 -1.4/-1.9, 2023 -0.0/+0.5, 2024 -0.8/-1.4, 2025 +0.8/-0.3, 2026 +0.5/+0.7
  The EMA warning called the wrong way in 15 of 17 years on NQ/MNQ and 15 of 17 on ES; since 2023 it is near zero.
  Counted: #5, a long-run tendency that has faded in the last few years. A bounce check is not needed: bid-ask
  bounce flatters reversal calls, and this is a reversal call that loses.

### NOVEL: the box overnight (research/databox_eth.mjs, written before the runs)

Every study counted 08:30-14:55 CT only. This counts Globex bars closing 18:00-07:30 CT with a 60-minute race
(0.064%, stopped at 08:25 CT; unresolved = a loss both ways). Readings: 1m EMA 12/26 speed, 1m EMA 3/13
slowing (#3), 1m MACD shrink, 5m EMA speed, 5m MACD shrink, 1m EMA and MACD flips. Discovery on MNQ
2019-05 to 2026-10 (halves split 2023-01-01): a reading passes when its edge beats 90 of 100 placebo
markets overall and in both halves, same sign (negative = a continuation call). Confirm each pass once on NQ
2010-2018 and on ES 2010-2026, the same sign beating 90 of 100 on each. One finding however many pass.
(A no-placebo smoke run showed one MNQ number, 1m EMA 12/26 speed -0.3: discovery data only.)
Discovery (MNQ 2019-05 to 2026-10, 117 s, research/databox_eth_mnq_results.json): one pass, the 1m MACD 12/26/9
flip the other way: -0.2 (beats 100; halves -0.3 at 97, -0.2 at 96). For a flip, the other way is fading the
cross (a warning's other way is continuation). Tiny. Near: 5m EMA speed -1.0 (100; halves 77 / 100), 1m EMA
speed -0.3 (99; 86 / 98), 5m MACD -0.2 (96; 86 / 85), 1m EMA flip -0.2 (92; 63 / 98), 1m MACD warning (93;
97 / 54). #3 overnight +0.1 (63): it is a day-session reading. Confirming the pass on NQ 2010-2018 and ES.
Confirmation (NQ 2010-2018 128 s; ES 2010-2026 222 s; research/databox_eth_{nq,es}_results.json): the pass, 1m
MACD flip faded, -1.1 on NQ (beats 100; halves 100 / 100) and -2.2 on ES (100; 100 / 100): confirmed by the
rule. Every other reading also passes on ES the reversal way, and #3 passes as called on ES (+0.7).
SUSPECTED ARTEFACT, written before the check: bid-ask bounce. A 1-minute close prints at the bid or the ask
and bounces back, which favours any reversal call measured from the close, most when the race is a few
ticks: ES in 2010 (0.064% about 3 ticks) -3.3 in its first half, -1.0 in its second; NQ (about 5 ticks) -1.1;
MNQ 2019-2026 (18 points, 74 ticks in 2026) -0.2. #3 is a reversal call too, so its NQ confirmation is
exposed the same way.
The check (databox_eth.mjs and databox_lengths.mjs --entry-open): the race starts at the next bar's open, a
fill one could get, with the every-minute baseline moved the same way. Rule: a reading whose edge loses its
sign or falls under 90 of 100 with next-open entry is bounce, not counted; one that keeps both stands.
Bounce check, overnight (next-open races; research/databox_eth_{mnq,nq,es}_open_results.json): the 1m MACD flip
faded keeps its sign and beats 100 on NQ (-0.3, from -1.1; halves 98 / 100) and ES (-0.9, from -2.2; 100 / 100),
but on MNQ, where it was found, it is -0.0 (79 of 100). Most of it was bounce, and what is left lives only where
the race is a few ticks (NQ / ES before about 2019); on MNQ's fine ticks there is nothing. NOT COUNTED: a coarse-
tick effect, not usable on MNQ. Same shape for the 1m EMA flip faded (NQ -1.0, ES -1.1, MNQ -0.0).
Beside it: #3 overnight with next-open races: ES +0.7 (100; halves 100 / 100), NQ +0.5 (100; 100 / 83), MNQ +0.1
(65).
Bounce check, #3 in the day session (databox_lengths.mjs --nq --entry-open, 1,891 s,
research/databox_lengths_nq_open_results.json): STANDS. 1m EMA 3/13 slowing +0.4 on its own (0 of 100 as
high), the default -0.6; gain +0.9 (0 of 100); halves +1.3 / +0.5. (From the close it was +0.3 / +1.2.)

## New unseen data: NQ 2010-2018 (found 2026-11-25)

Desktop\Backtesting\NQ CSV holds NQ (full-size, same index) 1-minute bars from 2010-06-06. Every idea and
study so far read MNQ from 2019 on, so NQ 2010-2018 is nine unseen years: a confirmation set for leads that
have no unused MNQ year left. 2019 on is excluded (the same index's moves as MNQ).

### Confirming the in-between timeframe leads on NQ 2010-2018 (research/databox_mid_confirm.mjs, written before the NQ file was built)

The 7 leads of databox_mid (each beat 90 in both periods there), frozen: L1 1m EMA warning against the 2m
MACD line's last move; L2 1m MACD flip against it; L3 1m MACD warning with the 3m MACD line's last move; L4
1m MACD warning with the 3m MACD row warning the same way; L5 5m EMA warning against the 2m MACD line's
last move; L6 5m MACD flip with the 2m MACD side; L7 5m MACD warning against the 4m EMA side. One run on
NQ 2010-2018: CONFIRMED = lift beats 95 of 100 placebo markets (7 at 5%: about 0.35 false expected). NEW
(not #2 again) = also positive and beating 90 inside the calls WITH VWAP's 15-minute slope. Check: on MNQ
2019-2026 the script gives databox_mid's lifts exactly (passed: L1 +0.7 on 38,634 ... L7 +0.4 on 16,607).

Results (2026-11-25, 878 s, NQ 2010-06 to 2018-12, 2.8 million bars; research/databox_mid_confirm_results.json).
1 of 7 confirmed, and it is #2 again; nothing new counts.
  L1 +0.0 (33 of 100 as high); L2 +0.4 (14); L3 -1.0 (98: reversed); L4 -0.6 (86); L6 -0.1 (68); L7 -0.4 (100: reversed).
  L5 (5m EMA warning against the 2m MACD line's last move) +1.1 (5 of 100 as high: confirmed at the line),
  halves +0.8 / +1.6; inside calls with VWAP's slope +0.8 (21 of 100: not 90), against +1.1 (12): by the
  rule written before the run it is #2 again, not a new finding.
The true confluence leads (the in-between row agreeing: L3, L4, L6) all failed, two of them reversed.

### Confirmed #1 and #2 re-checked on NQ 2010-2018 (idea_lab.mjs --batch 53 --file data/nq_1m.bin; written before the NQ file was built)

Not counted toward the five (they are already confirmed); a robustness check of what the indicator ships.
Batch 53's F1 and F2 unchanged, run in three spans (2010-06-07 to 2013, 2013 to 2016, 2016 to 2019: one
whole span does not fit in memory), pooled n-weighted per placebo index. Holds = the expected sign (F1
hurts, F2 helps) beating 95 of 100 pooled placebo markets.
Changed before any result was read (2026-11-25): the full harness needs 6-7 GB and about 130 s a placebo
market per 3-year span (over 7 hours), so the spans were stopped at 10 placebo markets, unread. Replaced by
research/confirm_vwap_slope.mjs, a light copy computing only F1 and F2, one run over 2010-06-07 to 2018-12-31,
same rules and seeds; checked to give idea_lab batch 53's numbers exactly on MNQ 2026 (F1 4,278 warnings
-4.5; F2 17,563 +3.9, the confirmed figures).

Results (2026-11-25, 842 s, research/confirm_vwap_slope_nq_results.json): NEITHER HOLDS; BOTH REVERSE.
  F1 (1m EMA warnings with VWAP's slope, expected to hurt): +1.5 on 43,510 (halves +1.2 / +1.8), beyond all
  100 placebo markets the other way. F2 (any warning against VWAP's slope, expected to help): -1.9 on 183,561
  (halves -1.9 / -1.8), beyond all 100 the other way.
Data check: NQ and MNQ over the same span (2019-06 to 2025) agree (F1 +0.8 / +0.5, F2 -0.2 / -0.0), so the
NQ file is not the cause. Year by year (NQ to 2018, MNQ from 2019; description, no placebo markets), F2:
  2010 -1.1, 2011 -2.1, 2012 -2.3, 2013 -0.8, 2014 -3.3, 2015 -2.5, 2016 +0.8, 2017 -2.6, 2018 -2.8,
  2019 +0.3, 2020 -2.1, 2021 -1.3, 2022 +0.1, 2023 +0.3, 2024 +0.8, 2025 +2.2, 2026 +3.9.
  F1 mirrors it (positive in 13 of 17 years; -1.8 in 2025, -4.5 in 2026).
Reading: #1 / #2 are a 2025-2026 regime. For most of 17 years a box warning WITH VWAP's slope did better and
one against it worse; the loop found and confirmed the rule inside the same recent regime (2026 screen, 2025
confirm). The "(weak)" mark in the Tradovate box (vwapSlope "mark", the default) follows the recent regime;
over the long run it marks the better warnings. Kept as confirmed by the rules they passed; now flagged as
regime-dependent. The forward test (batch 53) still decides whether the regime holds.

#3 year by year (1m EMA 3/13 slowing against the default 12/26 speed; edge points, description):
  2010 +1.1/-1.2, 2011 +0.9/-1.1, 2012 +0.4/-0.8, 2013 +0.6/-0.5, 2014 +0.1/-1.6, 2015 -0.5/-0.8,
  2016 +0.2/-0.9, 2017 -0.2/-0.7, 2018 +0.1/-1.0, 2019 +0.4/-0.1, 2020 +1.7/+0.6, 2021 +1.7/+0.8,
  2022 +1.5/+1.2, 2023 -0.1/+0.0, 2024 +0.2/+0.3, 2025 -0.2/+0.1, 2026 +1.3/+0.8.
  Better than the default in 14 of 17 years, its own edge positive in 13: not a regime artefact like #1 / #2.

## A wide grid of lengths, each row reading alone (research/databox_lengths.mjs, written 2026-11-25)

Written before the run (the script's header has it in full): the indicator's arithmetic re-done exactly on
1m and 5m closes; EMA pairs fast {3..26} x slow {13..100} (51) x warning rule speed / shrink / slowing, MACD
sets (8 fast/slow pairs x signal 3/5/9/13/18 = 40) with shrink; 568 readings. Per cell (1m/5m x EMA/MACD x
flip/warning) the best on 2019-2025 read on 2026 less the default; the mean gain over 8 must beat 95 of 100
placebo markets making the same picks. Check: the defaults equal databox_base's rows (passed in a 1-placebo
trial whose verdict line is not counted).

Results (2026-11-25, 1,842 s, research/databox_lengths_results.json). VERDICT: no better lengths. Mean gain
over the 8 cells +0.5 points; 9 of 100 placebo markets as high (needed 5 or fewer). Picks (2026 gain over the
default, placebo as high): 1m EMA flip 15/89 -0.4 (63); 1m EMA warning 3/13 slowing +0.5 (16); 1m MACD flip
5/13/3 +0.3 (27); 1m MACD warning 5/13/9 shrink -0.0 (57); 5m EMA flip 15/50 +2.5 (15); 5m EMA warning 12/13
slowing -0.7 (75); 5m MACD flip 16/35/18 +1.6 (11); 5m MACD warning 19/39/3 +0.3 (34).
- Faster 1m warnings are the strongest base readings measured: 1m EMA 3/13 slowing +0.7 (0 of 100 as high)
  on 2019-2025 and +1.3 (0) in 2026, both halves +1.3 / +1.4; 3/13 shrink +0.7 (0) / +1.5 (0); 5/13 slowing
  +0.7 (0) / +1.4 (0). 1m MACD 8/17/3 +0.9 (0) / +0.9 (0); 6/13/3 +0.9 (0) / +0.7 (2). The defaults:
  EMA 12/26 speed +0.4 (1) / +0.8 (11); MACD 12/26/9 +0.5 (0) / +0.5 (9).
- Flips have no edge at any length on 1m; on 5m most lengths are negative on 2019-2025.

### Second grid: MACD rows with every warning rule, and the 2m / 3m / 4m rows (research/databox_lengths2.mjs, written before either run)

The method that gave #3, on the cells it did not cover: 1m MACD, 2m EMA, 2m MACD, 3m EMA, 3m MACD, 4m EMA,
4m MACD, 5m MACD warnings; EMA 51 pairs and MACD 40 sets, each x speed / shrink / slowing (1,059 readings).
Screen (MNQ): the 2019-2025 pick's 2026 edge positive and beating 90 of 100 placebo markets' own picks.
Confirm (NQ 2010-2018, the screened picks frozen): gain over the default beating 95 of 100 AND the pick's own
edge positive and beating 95 of 100. A confirmed cell counts as one of the five. Check: the 80 readings
shared with databox_lengths.mjs must give its numbers exactly.

Results, MNQ screen (2026-11-25, 2,302 s; research/databox_lengths2_results.json; check passed, the 80 shared readings
exact): 1 of 8 cells passes.
  1m MACD warning  pick 1m MACD 5/13/9 slowing     2019-25   +1.1 | 2026   +0.6 (12 of 100 as high; halves +0.0 / +1.3) | default +0.5 / +0.5  fails the screen
  2m EMA warning   pick 2m EMA 3/13 slowing        2019-25   -0.2 | 2026   +1.1 (4 of 100 as high; halves +0.9 / +1.4) | default -0.4 / +0.4  SCREEN PASS
  2m MACD warning  pick 2m MACD 5/13/3 slowing     2019-25   +0.4 | 2026   +0.4 (25 of 100 as high; halves +0.2 / +0.7) | default -0.4 / -0.2  fails the screen
  3m EMA warning   pick 3m EMA 8/13 slowing        2019-25   -0.0 | 2026   +0.7 (14 of 100 as high; halves +0.7 / +0.9) | default -0.4 / +0.3  fails the screen
  3m MACD warning  pick 3m MACD 24/52/5 shrink     2019-25   +0.2 | 2026   -0.7 (83 of 100 as high; halves -0.4 / -1.0) | default -0.3 / +0.3  fails the screen
  4m EMA warning   pick 4m EMA 15/21 speed         2019-25   -0.0 | 2026   -0.3 (59 of 100 as high; halves -0.9 / +0.6) | default -0.1 / -0.1  fails the screen
  4m MACD warning  pick 4m MACD 12/26/9 speed      2019-25   +0.1 | 2026   -1.1 (91 of 100 as high; halves -2.0 / +0.0) | default -0.1 / -1.0  fails the screen
  5m MACD warning  pick 5m MACD 6/13/3 slowing     2019-25   +0.1 | 2026   -1.1 (78 of 100 as high; halves -0.7 / -1.5) | default -1.1 / -0.3  fails the screen
The pass is the 2m EMA row at 3/13 "slowing", #3's setting one timeframe up; its 2019-2025 edge is -0.2, so the
NQ stage's own-edge test decides.
NQ (2,520 s, research/databox_lengths2_nq_results.json): NOT CONFIRMED. Gain over the default +1.3 (0 of 100 as
high; halves +1.7 / +0.9), but the pick's own edge is -0.1 (72 of 100 as high): it only dilutes a negative
default (-1.4). Fails the own-edge test at 5% and at the person's new 10% bar alike.

### The lengths picks confirmed on NQ 2010-2018 (databox_lengths.mjs --nq; written before the NQ file was built)

The 8 picks above, frozen (read from databox_lengths_results.json), against the defaults, one run on NQ
2010-2018 with 100 placebo markets: a cell is CONFIRMED better than the default when its gain (pick edge
less default edge, 2010-2018) is positive and beats 95 of 100 placebo markets. 8 cells at 5%: about 0.4
false confirmations expected. The 2010-2014 and 2015-2018 halves are described. A confirmed 1m warning
setting would be a new default for the indicator, counted as one of the five.

Results (2026-11-25, 2,010 s, research/databox_lengths_nq_results.json): 3 of 8 cells CONFIRMED better than the
default (about 0.4 expected by chance).
  1m EMA warning 3/13 slowing: gain +1.2 (0 of 100 as high); the pick +0.3 (2 as high), the default -0.9
    (100 as high: worse than every placebo market); halves +1.6 / +0.7. COUNTED: confirmed #3.
  5m EMA warning 12/13 slowing: gain +0.8 (0); but the pick is still -0.9 (100 as high) against the default's
    -1.7. 5m MACD warning 19/39/3: gain +0.5 (4); the pick -1.0 against -1.4. Confirmed by the rule, not
    counted: both are less wrong, not right (5m warnings call the wrong way on NQ 2010-2018 at any length).
  Not confirmed: 1m EMA flip (-0.2, 59), 1m MACD flip (-0.2, 95), 1m MACD warning 5/13/9 (+0.0, 38), 5m EMA
    flip (+0.1, 44), 5m MACD flip (+0.7, 12).
Checked for dilution (a reading firing more often drifts toward 0 and beats a negative default without
foresight): the 3/13 slowing warning is positive on its own in all three periods, each beating 98+ of 100
placebo markets (MNQ 2019-2025 +0.7, 2026 +1.3, NQ 2010-2018 +0.3). Its MNQ neighbours (5/13 slowing, 3/13
shrink, 3/21 slowing) are as good: not a knife-edge.

## In-between timeframes (research/databox_mid.mjs, written 2026-11-25)

The person's question: do 2m, 3m and 4m rows add confluence and edge to the box's 1m and 5m readings?
Written before the run (the script's header has it in full): the indicator's EMA and MACD rows on clock-aligned
2m / 3m / 4m bars. Bases: the box's 8 readings (1m and 5m x EMA and MACD x flip and warning onset). 46 mid
filters per base: the call agreeing / not with each mid row's side, slope or warning (36), and the three mid
timeframes stacked (10). Verdict: per base, the best mid filter on 2019-2025 read on 2026 as lift over the
base; the mean of the 8 must beat 95 of 100 placebo markets making the same picks. Each mid row alone is
described beside it. Check: the 1m and 5m rows alone equal databox_base's counts and edges exactly (passed in
a 2-placebo trial run, whose verdict line is not counted).

Results (2026-11-25, 907 s, research/databox_mid_results.json). VERDICT: no added edge. Mean 2026 lift over the 8
picks +0.6 points; 23 of 100 placebo markets as high. Picks (2026 lift, placebo as high): 1m EMA flip 3m MACD
slope against -0.3 (67); 1m EMA warning 2m+3m+4m EMA sides all agree -0.9 (81); 1m MACD flip 2m MACD slope
against +1.8 (8); 1m MACD warning 4m MACD warning agrees +0.8 (31); 5m EMA flip mid MACD slopes not all agree
-2.8 (95); 5m EMA warning 3m MACD slope against +0.2 (46); 5m MACD flip 2m MACD slope against +4.2 (3); 5m MACD
warning 2m EMA slope against +1.6 (23).
- Each mid row alone: no 2m / 3m / 4m flip or warning beats 90 placebo markets on 2019-2025 except the 3m MACD
  flip (+0.4, 2), which is -0.6 in 2026. The only base edge anywhere is still the 1m warnings.
- Leads (beat 90 in both periods; 7 of 368 mid cells; chance gives about 4 at 10% x 10%,
  and these are picked after looking): the call against the 2m MACD line's last move, on the 1m EMA warning (+0.7 | +0.8),
  the 1m MACD flip (+1.8 | +1.8) and the 5m EMA warning (+1.3 | +2.8); the 1m MACD warning with the 3m MACD
  slope or warning agreeing (+1.2 | +3.3; +1.7 | +4.2); the 5m MACD flip with the 2m MACD side agreeing; the
  5m MACD warning against the 4m EMA side. "Against the 2m MACD's last move" is a call against the last few
  minutes' push: the same fade-the-push shape as confirmed #2 (against VWAP's slope), likely not new.
  Not counted toward the 5; it would need unused data (the forward bars) to confirm.

## Box settings tuned over every entry and exit (research/databox_tune.mjs, started 2026-11-25)

The person's question: build on the room study's billions of trades; change the EMA and MACD lengths, some
rows faster (noisier) and others slower; which entry and exit combinations add edge, which to ignore.
Written before the run (the script's header has it in full): 16 settings (EMA 5/13, 9/21, 12/26, 20/50 x
MACD 6/13/5, 12/26/9, 24/52/18 on both timeframes, plus fast-1m/slow-5m, slow-1m/fast-5m, fast-1m/default-
5m, default-1m/slow-5m); the room study's 179,712 strategies each (2.9 million in all); picked as one
search, against 100 placebo markets each running the same search; readings all, room, inside, reverse,
persist, and new "avoid" (the 10 worst on 2019-2025 read on 2026). A pass is a pooled all / room / inside
pick beating 95 of 100. Per-setting cells are leads (about 10 of 96 beat 90 of 100 by chance).
Check before the run: at the default setting alone it reproduced databox_room.mjs to ten decimals on the
real market and on placebo markets 0 and 1.

Results (2026-11-25, 4 shards of about 90 minutes; research/databox_tune_results.json, _ranked.csv).
VERDICT: no setting or combination passes. As one search over all 16 settings (2.9 million strategies):
- ALL: the 10 best on 2019-2025 lost in 2026: -3.63 net points a trade against -1.06 for every minute with
  the same exits, t -2.0; 97 of 100 placebo markets' picks did as well. ROOM (stops 2 ATR+, held 40 min+):
  t -1.3, 88 of 100. INSIDE 2026 (Jan-Jun picks on Jul-Oct): t 0.1, 45 of 100. None near the 95 needed.
- AVOID: the 10 worst on 2019-2025 did not keep losing; in 2026 they made +0.36 against -1.40 (t 1.9).
- PERSIST: a strategy's t on 2019-2025 against its t on 2026, all 1.46 million: r -0.04 (59 of 100 placebo
  as high); Jan-Jun against Jul-Oct r -0.08. What worked before says nothing about what works next.
- REVERSE: 2026's 10 best read on 2019-2025: mean t 0.60, 20 of 100 as high; years positive 4.8 of 7, 8 of 100.
- Per setting, 13 of 96 cells beat 90 of 100 (about 10 by chance). 20/50 EMA + 6/13/5 MACD beats 90 in four
  of six cells (all t 1.69, room 1.73, inside 2.90, reverse 1.63): a lead only, picked after looking.
The lengths and combinations people tune do not carry an edge from one period to the next.

## Forward test of the two confirmed findings (written 2026-11-24, before any forward bar is read)

Built into the Tradovate databox the same day (TradingCustomIndicators/tradovate/emaMacdDatabox.js,
`vwapSlope`, default "mark": a warning calling the way the RTH VWAP moved over the last 15 minutes reads
"(weak)" in grey). Its slope equals the research's VWAP (RTH) slope on all 50,475 RTH minutes of 2026 that
have one.

The test, frozen:
- Bars: MNQ 1-minute from 2026-11-02 on, which no run has read. They need a TopstepX pull (the API key was
  refused on Nov 20 and again today; the person must regenerate it) or Databento, then `npm run data:build`.
  TopstepX 1-minute bars from Oct 30 roll off from 2026-12-29.
- Command: `node --max-old-space-size=16384 research/idea_lab.mjs --batch 53 --from 2026-11-02 --placebos 100`
  (F1 = #1 exactly, F2 = #2 exactly; the 18-point race; 100 placebo markets).
- When: once at least 40 RTH sessions after 2026-11-02 are held (about 3,500 warnings for F2, 900 for F1,
  going by Sep-Oct 2026). If both read "undecided", once more at 80 sessions, and that run is final.
- Holds: the lift has the confirmed sign and beats at least 90 of 100 placebo markets (F1 as low, F2 as
  high). Then the default stays "mark".
- Kill rule: F2 with the wrong sign, or beating fewer than 50 of 100. Then the indicator's default goes to
  "off", the README says why, and nothing is re-tuned or re-tested on these bars.
- F1 alone failing while F2 holds keeps the marking (F2 covers every row, F1 is its 1m EMA part); it is
  reported.
- A dry run on already-tested bars (Sep-Oct 2026, one placebo market) checked the machinery only.

## Changed question (2026-11-24, the person's choice): the box as a gate or an exit on a book

After about 300 ideas filtering warnings, the person chose to stop and test the box where it might pay:
as an entry gate or an exit on donchian_1250 ($1,250 eval, the live bot's book). Written before any run:
- Variants (6): the databox study (defaults: EMA 12/26, MACD 12/26/9, warnings both, gateOn both) on 1m,
  5m and 15m bars, each as gate "with" (entries only while the box reads the trade's way) and as exit
  "against" (close at the next open once the box reads against the trade). Costs as the book ships.
- Screen: the MCP compare tool, paired with the shipped book, calendar method, 2026 Jan-Mar and Apr-Jul.
  A variant passes if it beats the shipped book in both halves and wins more calendar months than it loses.
- Confirm: each pass, unchanged, on 2025 windows by the same comparison, run once.
- Placebo markets are not available through these tools; the paired comparison against the same book on
  the same windows is the control, and 2026 holds about 5.5 independent windows, so a pass is a lead
  until 2025 agrees.

Screen (2026, calendar, $1,250, against the shipped 74.5%; Jan-Mar 76.4, Apr-Jul 73.3): none pass.
| variant | 2026 | Jan-Mar | Apr-Jul | months won (variant / book) |
| --- | --- | --- | --- | --- |
| gate with, 1m | 73.9 | 74.2 | 74.7 | 1 / 1 |
| gate with, 5m | 74.5 | 76.4 | 73.3 | identical |
| gate with, 15m | 63.0 | 64.0 | 62.7 | 0 / 3 |
| exit against, 1m | 44.8 | 29.2 | 64.0 | 0 / 4 |
| exit against, 5m | 74.5 | 76.4 | 73.3 | identical |
| exit against, 15m | 74.5 | 76.4 | 73.3 | 0 / 0 (net $962 vs $989) |
Why (backtest byStudy, 2026's 128 trades): at the signal the 5m box reads "with" on all 128, the 1m box
on 115 (13 split), the 15m box on 90 (3 against, 35 split). A Donchian breakout is a move the box already
agrees with, so a gate has nothing to refuse; the 15m gate refuses the 35 split trades, which were good.
Over the 23-minute average hold the 5m box never turns fully against; the 1m box does, and exiting on it
cuts the winners before their target. The box carries nothing the Donchian book does not already have.

The same six on macd_fade_1250 (shipped 55.8%; Jan-Mar 59.6, Apr-Jul 50.7): none pass.
| variant | 2026 | Jan-Mar | Apr-Jul |
| --- | --- | --- | --- |
| gate with, 1m | 0 | 0 | 0 (the fade always trades against the 1m box) |
| gate with, 5m | 55.2 | 41.6 | 70.7 |
| gate with, 15m | 49.7 | 49.4 | 49.3 |
| exit against, 1m | 52.7 | 39.3 | 69.3 |
| exit against, 5m | 51.5 | 47.2 | 56.0 |
| exit against, 15m | 51.5 | 56.2 | 45.3 |
Added after looking (a fade's natural gate is "against"; leads only): gate against 5m 10.9 (0 / 24.0);
gate against 15m 50.3 (19.1 / 88.0). Every variant that helps one half of 2026 hurts the other: the
fade's regime, not the box.

## Status 2026-11-24 (after batch 52): 2 of 5 confirmed, about 300 ideas tried

Outside data (FRED yields, dollar, credit, Fed liquidity; Treasury auctions; mega-cap earnings; CFTC
positioning; index days) added 26 ideas in batches 45-52 and nothing confirmed. The strongest screen in the
loop (batch 47: toward the session VWAP with leveraged funds not crowded, +5.9, 100 of 100, both halves
99) failed on 2023. Every 2026 screen pass since #2 has failed its unseen year.

## Status 2026-11-24 (after batch 44): 2 of 5 confirmed, about 272 ideas tried

The lab's own data is close to used up: price, volume, time, levels, VWAP, the box's history, VXN/VIX/VXV
and MES have all been tried in several forms. A recurring pattern: mean-reversion readings work in 2026
and 2025 Jan-Jun and turn in 2025 Jul-Dec (balance filters, MES confirmation), and nothing tried (VXN,
the 20-day trend) says which regime is on. Next source proposed: daily rates, dollar and credit series
from FRED (needs the person's OK to download).

## Paused 2026-11-24, resumed the same day (runs 1-4 below done; see each batch)

About 220 ideas tried (batches 1-27 screened). Runs stopped part-way, to restart as they were:
1. Confirm toward the session VWAP on 2025 (batch 26, named, not yet run to the end):
   `node --max-old-space-size=16384 research/idea_lab.mjs --batch 26 --year 2025 --only "any warning calling toward the session VWAP"`
2. Its independence check against #2, on 2026 then 2025 (rule written under batch 26): `--batch 28`,
   then `--batch 28 --year 2025`. The IB rows in batch 28 are moot (the IB midpoint failed 2025).
3. Batch 29 (balance filters split at VXN 21): screen `--batch 29`, confirm passes with `--year 2024`.
4. Batch 30 (VIX curve, VXN premium, range broken, 5m inside bar, 15m warning): screen `--batch 30`.
Pattern so far: the "toward balance" filters pass 2026 and 2025 Jan-Jun, then reverse in 2025 Jul-Dec.

## Confirmed (count: 5 of 5; #2 extends #1; #4 supersedes #1 / #2)

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
3. **The 1m EMA row warns better at EMA 3/13 with the "Momentum slowing" rule than at the default 12/26 "speed".**
   - Source: databox_lengths.mjs (2026-11-25), the 1m EMA warning cell's pick on 2019-2025 among 153 lengths
     and rules; the cell-level verdict there did not pass (9 of 100), the pick was a lead.
   - MNQ 2019-2025 +0.7 points over every minute (0 of 100 placebo markets as high); 2026 +1.3 (0), halves +1.3
     / +1.4; the default +0.4 and +0.8.
   - NQ 2010-2018, unseen, frozen: +1.2 over the default (0 of 100 as high), halves +1.6 / +0.7; the default is
     -0.9 there.
   - Use: on the 1m chart's box, Fast EMA 3, Slow EMA 13, EMA warning "Momentum slowing". No code change: these
     are the indicator's own settings. #1 / #2 (the VWAP-slope marks) were measured on the default warning and
     are untested on this one.
4. **Follow the side of VWAP's slope that won over the last 60 sessions (ADAPT).** #1 / #2 reverse over 17 years
   (NQ, ES); their sign follows the regime. Each session, compare the trailing 60 sessions' box warnings against
   VWAP's 15-minute slope with those along it, and keep the warnings on the side that won.
   - Screen: NQ 2010-2018 +1.1 (beats 100), MNQ 2019-2026 +1.6 (100). Confirmed on ES 2010-2026, unseen: +0.4
     from the close (92), +0.5 from the next open (98). light_check.mjs, idea ADAPT.
   - To build it into the Tradovate box, which on a 1-minute chart sees only that chart's rows: ADAPT1, the same rule
     on the 1m rows' warnings only, is a new trial (written before its runs): screen NQ 2010-2018 and MNQ 2019-2026
     (each beating 90), confirm on ES 2010-2026 from the close and the next open (each beating 90). Built only if
     it passes.
   - ADAPT1 screen: MNQ 2019-2026 +1.5 on 109,981 (beats 100; halves 90 / 100); NQ 2010-2018 +1.0 on 113,785 (100;
     90 / 97). SCREEN PASS. ES next.
5. **A 5-minute warning is a continuation sign, not a turn.** The default 5m EMA and MACD warnings ("Potentially
   short" on the long side) call the wrong way: price keeps going the side's way more often than chance.
   - MNQ 2019-2025 EMA -1.4, MACD -1.1 (worse than 100 and 97 of 100 placebo markets); NQ 2010-2018 -1.7, -1.4
     (all 100); confirmed on ES 2010-2026, unseen: -2.2, -1.6 (all 100).
   - Wrong way in 15 of 17 years on NQ/MNQ and on ES, but near zero since 2023 (2026: +0.4 / -0.3). Use: do not
     treat a 5m warning as a turn; on the long run it means the trend is still on.

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
Confirmation (2025): not confirmed, +0.3 (61 of 100; Jan-Jun +2.8, 100; Jul-Dec -2.2). The fourth balance
filter with the same shape: every "toward balance" reading works in 2026 and 2025 Jan-Jun and turns in
2025 Jul-Dec, and VXN does not explain it (batch 29).

Written before the 2025 runs: toward the session VWAP and toward the IB midpoint may be #2 again (a
warning against VWAP's slope often calls back toward VWAP). Each counts as a new finding only if it
confirms AND, in batch 28, it lifts warnings on both sides of #2's split (with VWAP's slope, against
it) in the same direction, beating 90 of 100 on 2026 and on 2025 in each. Toward the session VWAP is
judged as its own finding; the IB midpoint (batch 23) as another; if both pass they still need to show
they are not the same warnings (overlap reported).

### Batch 33 (--batch 33, screen 2026, confirm 2024): the balance filters split by the 20-day trend (warnings with or against price's side of the 20-settlement average)

Why: every balance filter turned in 2025 Jul-Dec, a steady multi-week rise, and VXN does not explain it.
Hypothesis: a turn back to the day's balance that is against the multi-day trend gets bought (sold).
Written before the run: a "with the 20-day trend" row passing on 2026 is confirmed on 2024 (unseen by
these filters), and counts as new only if it also holds inside both sides of #2's split (batch 28's
rule), because batch 28 showed the IB midpoint's lift sits mostly with #2 (88 and 50 of 100).

Screen (2026): toward the session VWAP passes on both sides of the split: with the 20-day trend +3.8 (99;
halves 98 and 99), against it +3.1 (98; 94 and 94). IB midpoint: with +3.7 (100; Jul-Oct 80), against
+3.0. In 2026 the split barely separates them, so 2026 cannot show the hypothesis; 2024 decides.
Named for confirmation on 2024: toward the session VWAP, with the 20-day trend: helps.
Confirmation (2024): not confirmed, +0.3 (57 of 100; halves +0.1 and +0.5). The balance family is closed:
its lift is 2026's and 2025 Jan-Jun's, not the market's, and neither VXN (batch 29) nor the 20-day trend
picks out where it works.

### Batch 32 (--batch 32): the session before a holiday, release days, the first hour against yesterday's last hour, Monday mornings

Screen (2026): none pass. Release day -0.9 (83 as low); first hour against yesterday's last hour -2.0
(2,378 warnings, 51; halves -3.7 / +0.5); Monday morning -0.6. The holiday filter found no sessions: Globex
trades a short session on most holidays, so a missing weekday almost never marks one. It would need the
exchange's holiday list; not re-run.

### Batch 51 (--batch 51, run on 2026 and 2023): independence check for batch 47 against #2

The not-crowded session VWAP filter inside warnings with VWAP's slope and inside warnings against it.
Written before batch 47's 2023 result: it counts as new only if both rows lift beyond 90 of 100 on 2026
and on 2023.

2026: both rows pass the rule. With VWAP's slope +4.1 (834 warnings; 96 of 100; halves 90 and 92);
against it +5.8 (6,639; 98; halves 79 and 99). 2023: pending.

### Batch 48 (--batch 48): Fed net liquidity (balance sheet less Treasury cash less reverse repo): calling with its 4-week change; liquidity draining fast

Readings lagged to publication (WALCL and WTREGEN 2 days, RRP 1 day). Qualifying weeks per half (2025
H1/H2, 2026 H1/H2): |4-week change| >= $50bn 25/22/19/10 of 26/27/25/21 (so it works as a direction);
drain <= -$100bn 7/10/2/3.

Screen (2026): none pass. Calling with net liquidity's month -0.0 (halves -0.9 / +1.3); liquidity draining
fast -1.6 (100 as low overall; Jan-Jun 91, Jul-Oct 79).

### Batch 49 (--batch 49): earnings timing: the session before mega-cap earnings; earnings season (a report in the last 10 days)

Screen (2026): none pass. Session before earnings +0.5 (halves -0.4 / +1.6); earnings season -1.1 (83 as
low).

### Batch 50 (--batch 50): positioning shifts: NQ open interest up 5%+ in the last report (weeks per half 7/5/4/3); dealers' net position in the year's bottom fifth

Screen (2026): none pass. Open interest jumped +1.6 (95; Jan-Jun 100, Jul-Oct 47); dealers crowded short
-0.6.

### Batch 52 (--batch 52): asset managers crowded long (top fifth of the year); the week after leveraged funds flipped their net side

Screen (2026): none pass. Asset managers crowded long +0.6 (78). Leveraged funds never flipped their net
side in 2026, so the second idea had no events.

### Batch 47 (--batch 47, screen 2026, confirm 2023): does trend followers' positioning (CFTC leveraged funds crowded either way) say when turns back to the session VWAP work?

Written before the run: the finding would be the "crowded" row passing on 2026 and on 2023 (unused by
every balance filter; 2025 and 2024 have been used). Because batch 28 ruled the session VWAP filter #2
again, a pass counts as new only if, in addition, the crowded row lifts both sides of #2's split.

Screen (2026): the opposite of the hypothesis. Not crowded +5.9 (7,808 warnings; 100 of 100; halves 99
and 99; 37-point +6.1, 99), the largest and steadiest screen in the loop; crowded +1.1 (81). The reason
given was wrong, so as with batch 19 it is a screen pass named the way it came out, and the unseen year
decides. A possible reason, after the fact: with trend followers not crowded, no side is forced to
unwind, and intraday swings come back to the session's balance; crowded markets get squeezed through it.
Named for confirmation on 2023: toward the session VWAP, leveraged funds not crowded: helps. The same
rule as written above applies: to count as new it must also lift both sides of #2's split.
Confirmation (2023): not confirmed, -0.4 (44 of 100; halves -1.4 / +1.2). Final. Batch 51's 2023 run was
stopped part-way: it mattered only if this confirmed.

### Batch 46 (--batch 46): outside events: the hour after a coupon auction, after an auction calling its way, mega-cap earnings sessions, quarterly expiry days, against leveraged funds' crowded side, the way asset managers are adding

Data (downloaded 2026-11-24 with the person's OK; built by research/event_data_build.py into
data/raw/events): Treasury auction results (fiscaldata.treasury.gov), SEC EDGAR 8-K item 2.02 dates for
AAPL MSFT NVDA AMZN META GOOGL AVGO TSLA, CFTC Traders in Financial Futures (NASDAQ-100 Consolidated,
usable the Monday after each Friday release), third Fridays. Also saved, not yet used: FRED RRPONTSYD,
WTREGEN, WALCL (Fed liquidity).

Screen (2026): none pass on the judged 18-point race. Against leveraged funds' crowded side -2.3 (99 as
low; Jan-Jun 58, Jul-Oct 100); after an auction calling its way +2.8 (972; halves +6.6 / -1.8); quarterly
expiry -2.7 (353); the way asset managers add -0.5 (halves +0.9 / -2.6); earnings sessions +0.7; the hour
after an auction +0.6. Leads on the 37-point race only (not judged): the hour after an auction +4.8 (98;
halves 96 and 84), earnings sessions +3.4 (98; halves 98 and 76).

### Batch 45 (--batch 45): outside information from FRED: a 2-year yield shock, against yesterday's 10-year move, against the dollar's week, credit spreads widening

Data downloaded 2026-11-24 with the person's OK (DGS2, DGS10, DTWEXBGS, BAMLH0A0HYM2 into data/raw/fred).
Each reading is lagged to when it was public: yields a day, the HY spread two days, the dollar (weekly
release) a week. Qualifying days per half (2025 H1/H2, 2026 H1/H2): 2y shock 23/10/14/8; 10y 5bp
43/20/26/22; dollar 0.5% 52/48/59/32; HY +15bp 24/12/10/12.

Screen (2026): none pass. After a 2-year yield shock +2.3 (100 of 100 overall, but Jan-Jun +3.5 and Jul-Oct
+0.2; the opposite of its stated reason: turns did better after shocks, not worse); against yesterday's
10-year move +1.3 (85); against the dollar's week +0.3 (halves +1.8 / -2.1); credit spreads widened +0.7.

### Batch 44 (--batch 44): the box's first warning in 10 minutes (batch 43 with a cut that occurs)

The cut is the gaps' rough 90th percentile if warnings came at random every 4.6 minutes, chosen from that and
not from any result; counted as a new trial.

Screen (2026): 81 warnings, too few (-5.0, 81 of 100). Warnings cluster far more than at random, so even
10 quiet minutes are rare. Dropped.

### Batch 43 (--batch 43): the box's first warning in 30 minutes

Screen (2026): no events. With four rows the box never goes 30 minutes without a warning (one about every
4.6 minutes in RTH): a design slip.

### Batch 42 (--batch 42): an acceleration into the warning, a warning soon after an opposite one, against a trend running since the open

Screen (2026): none pass. Soon after an opposite warning -1.8 (100 as low overall; Jan-Jun 89, one short;
Jul-Oct 96); acceleration +0.9 (86); against a trend since the open 96 warnings, too few.

### Batch 41 (--batch 41): the 5m ATR rising, a 1m EMA warning with the MACD histogram still growing, after 11:00 on a narrow day

Screen (2026): none pass. 5m ATR rising -0.4 (halves -1.1 / +0.6); after 11:00 on a narrow day +1.2 (1,372;
Jan-Jun 96, Jul-Oct -1.8). The MACD-still-growing filter has no events, by construction: the EMA row warns
when its gap (the MACD line) closes faster each bar, which always pulls the histogram the same way.

### Batch 40 (--batch 40 --year 2025, confirm 2024): MES on the warnings: MES's box warning the same way, MES failing to confirm MNQ's extreme, against NQ's 15-minute outperformance

MES ends 2026-03-23, so this screens on 2025 (both halves) and confirms on 2024, as batch 3 did.

Screen (2025): none pass. MES's box warning the same way +0.2; against NQ's outperformance +0.4 (Jul-Dec
-0.1; 37-point +1.5, 99); MES failing to confirm the extreme -0.3 overall, but +7.3 in Jan-Jun (beyond
all 100) and -5.8 in Jul-Dec (beyond all 100 the other way): a regime that flipped mid-year, the same
Jul-Dec 2025 turn the balance filters showed.

### Batch 39 (--batch 39): the multi-week trend: a day that set a 20-day extreme, calling with the 20-day trend, calling with yesterday's direction

Screen (2026): none pass. A day that set a 20-day extreme -1.8 (99 as low; Jan-Jun 89, one short of the
rule; Jul-Oct 100): a miss, not rounded up. With the 20-day trend +0.7 (Jan-Jun -0.0); with yesterday's
direction -0.8.

### Batch 37 (--batch 37): jumps (3 bars, 40%), a fake flip in the last half hour, 3+ VWAP crosses in the hour, the 1m rows split 10 of 15 bars

Screen (2026): none pass. Jumps -5.5 (516 warnings, 95 as low; halves 88 and 79); 3+ VWAP crosses +1.4
(95; Jan-Jun 100, Jul-Oct -0.1); rows split 10+ bars +0.8 (82); fake flip +0.6.

### Batch 35 (--batch 35): the tape's memory (lag-1 autocorrelation, the 5-minute variance ratio), a move made of jumps, the hour's range edge

Screen (2026): none pass. Hour's range edge calling inside +2.3 (99; Jan-Jun 100, Jul-Oct 79); mean-reverting
tape +1.0 (92; Jan-Jun 69); variance ratio under 0.8 +0.6 (halves -0.3 / +1.9). Jumps: the cut (one bar
over a third of the path) caught 4 warnings, a design slip; batch 37 re-runs it with a cut that occurs,
counted as a new trial.

### Batch 38 (--batch 38): the near misses pooled (built after looking; only 2025 counts)

Changing approach after about 25 ideas in a row without a countable pass. Four leads lifted warnings in
both halves of 2026 and beat 95+ of 100 overall: the hour's range edge calling inside (batch 35, +2.3),
volume rising over the hour (36, +1.0), an inside bar (27, +1.6), the day after a wide day (22, +1.0).
Each rule is used exactly as its batch wrote it. Written before any run: the judged row is "2+ of the
four"; its 2026 screen is biased by construction, so it goes to 2025 (unseen by all four) whatever 2026
says, and must beat 95 of 100 there. "1+" is read beside it. If it confirms, it still needs batch 28's
independence check against #2 (the range edge is a balance reading).

2025: not confirmed. 2+ of the four -0.3 (72 of 100 as high, the wrong way; halves -2.4 / +1.6); 1+ -0.7.
The near misses were noise; pooling them does not change that.

### Batch 36 (--batch 36): the two VWAPs sloping apart, volume rising over the hour, off a round 25 calling away, Friday afternoon toward the nearest round 100

Screen (2026): none pass. Volume rising over the hour +1.0 (98; halves 87 and 93); two VWAPs sloping apart
-0.5 (halves +1.4 / -2.7); round 25 +0.0; Friday toward round 100 +0.3 (1,319).

### Batch 34 (--batch 34): the 15m rows' own warnings as calls, a thin market (volume per point), a day outrunning yesterday

Screen (2026): none pass. Day outrunning yesterday -1.7 (98 as low; Jul-Oct 81); 15m EMA warning -2.3
(1,053, signal, 80 as low); 15m MACD -1.3; thin market -1.4 (1,817).

### Batch 31 (--batch 31): the structure already turned, a warning confirmed by the next bar, a trending overnight, quiet for the time of day

Screen (2026): none pass. Trending overnight +1.0 (91; Jan-Jun 98, Jul-Oct 51); quiet for the time of day
+0.9 (69); confirmed by the next bar -0.2 (signal); structure turned +0.0.

### Batch 30 (--batch 30): VIX above VXV, VXN's premium over VIX above its median, yesterday's range broken today, a 5m inside bar, a 15m row warning the same way

Changed before the full run (seen on one placebo market only): the VXN premium was "VXN 1.25x VIX or
more", true every day of 2026 Jul-Oct, so it could not split that half; now against its 60-day median.
VIX above VXV happened on no day of 2026 Jul-Oct, so it cannot pass the both-halves rule; kept as read.

Screen (2026): none pass. VIX above VXV +3.2 (1,346 warnings, Jan-Jun only, 97); VXN premium -0.8 (halves
-1.9 / +0.5); yesterday's range broken -0.8 (93 as low; Jan-Jun +0.1); 5m inside bar +1.3 (89); a 15m row
warning the same way +1.1 (Jul-Oct -0.9).

### Batch 29 (--batch 29, screen 2026, confirm 2024): do the balance filters need a volatile market? (toward the IB midpoint and the session VWAP, split at VXN 21)

Why: the balance filters (overnight, OR30 and IB midpoints) worked in 2026 (VXN median about 24) and 2025
Jan-Jun (22) and failed in 2025 Jul-Dec (20). 2025's halves have been seen, so the confirmation is 2024
(VXN medians 17 and 21), unused by these filters. One threshold, 21, fixed before the run, near the
long-run median. Finding = a high-VXN row passing both stages.

Screen (2026): the regime idea fails. The low-VXN rows lift as much as the high ones (IB midpoint +4.0
under 21 vs +3.1 at 21+; session VWAP +2.4 vs +3.4), so volatility does not explain 2025 Jul-Dec. The
one pass, toward the session VWAP at VXN 21+ (+3.4, 100; halves 98 and 96), is the session VWAP filter
again, ruled #2 by batch 28; its 2024 run was not made.

### Batch 28 (--batch 28): independence checks for batch 23 and 26 against confirmed #2

2026: toward the session VWAP lifts both sides of #2's split but beats only 77 (with the slope, +1.2,
1,840 warnings) and 88 (against it, +2.0; Jan-Jun -0.3) of 100, short of the 90 the rule asks. So by the
rule written before the runs, toward the session VWAP is #2 again, not a new finding, whatever 2025
says. The IB rows: +2.5 (88) and +0.7 (50); moot, the IB midpoint failed 2025.
