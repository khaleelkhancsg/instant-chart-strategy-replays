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

Results: pending.

## Batch 3 (written before it ran): with the 20-session average, yesterday closed strong its way, at a new session
extreme, through a round 100, the first or last two hours, the day already 1 ADR wide, on the trade's side of the
RTH open, VXN at 25 or above

Results: pending.
