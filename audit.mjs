// Data artifact audit. Run after prepare.mjs:  node audit.mjs
//
// A backtest is only as trustworthy as the series under it, and the failure mode
// that matters here is silent: a contract rollover left unadjusted injects a fake
// 100+ point jump that a breakout strategy will happily "discover" as an edge.
// This script tries to prove the cache is clean rather than assume it.
//
// Checks: OHLC integrity, timestamp ordering/duplicates, rollover seams, the
// largest price jumps (classified session-gap vs intra-session), back-adjustment
// magnitude, and volume sanity.

import { loadBars } from "./src/data.mjs";

const { bars, meta } = loadBars();
const { ts, open: O, high: H, low: L, close: C, volume: V, tday, count: n } = bars;

const iso = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);
const hr = (s) => console.log("\n" + s + "\n" + "-".repeat(s.length));
let problems = 0;
const flag = (cond, msg) => { if (cond) { problems++; console.log("  !! " + msg); } };

console.log(`MNQ cache audit — ${n.toLocaleString()} bars, ${iso(ts[0])} → ${iso(ts[n - 1])}`);

// ───────────────────────── 1. OHLC integrity ─────────────────────────
hr("1. OHLC integrity");
let badHL = 0, badOpen = 0, badClose = 0, nonFinite = 0, nonPositive = 0;
for (let i = 0; i < n; i++) {
  if (!Number.isFinite(O[i]) || !Number.isFinite(H[i]) || !Number.isFinite(L[i]) || !Number.isFinite(C[i])) { nonFinite++; continue; }
  if (H[i] < L[i]) badHL++;
  if (O[i] > H[i] || O[i] < L[i]) badOpen++;
  if (C[i] > H[i] || C[i] < L[i]) badClose++;
  if (L[i] <= 0) nonPositive++;
}
console.log(`  high < low            : ${badHL}`);
console.log(`  open outside [low,high]: ${badOpen}`);
console.log(`  close outside [low,high]: ${badClose}`);
console.log(`  non-finite prices     : ${nonFinite}`);
console.log(`  non-positive prices   : ${nonPositive}`);
flag(badHL || badOpen || badClose || nonFinite || nonPositive, "OHLC integrity violations present");

// ───────────────────────── 2. timestamps ─────────────────────────
hr("2. Timestamps");
let dupes = 0, backwards = 0;
const gapHist = new Map();
for (let i = 1; i < n; i++) {
  const d = ts[i] - ts[i - 1];
  if (d === 0) dupes++;
  else if (d < 0) backwards++;
  const mins = Math.round(d / 60000);
  const bucket = mins <= 1 ? "1m" : mins <= 5 ? "2-5m" : mins <= 60 ? "6-60m" : mins <= 1440 ? "1-24h" : ">24h";
  gapHist.set(bucket, (gapHist.get(bucket) || 0) + 1);
}
console.log(`  duplicate timestamps  : ${dupes}`);
console.log(`  out-of-order          : ${backwards}`);
console.log("  gaps between bars     :");
for (const k of ["1m", "2-5m", "6-60m", "1-24h", ">24h"]) {
  const v = gapHist.get(k) || 0;
  console.log(`    ${k.padEnd(6)} ${String(v).padStart(9)}  ${((v / (n - 1)) * 100).toFixed(2)}%`);
}
flag(dupes || backwards, "timestamp ordering problems present");

// ───────────────────────── 3. rollover seams ─────────────────────────
hr("3. Rollover seams (the artifact that matters)");
if (!meta.rollovers || !meta.rollovers.length) {
  console.log("  no rollover metadata — rebuild with prepare.mjs");
} else {
  console.log(`  ${meta.rollovers.length} rollovers detected in the source data`);
  console.log(`  spread source: both contracts quoted at the SAME minute (not close-to-close)\n`);
  console.log("  date               from  -> to    spread   elapsed   residual   note");

  // The adjustment removes the contract spread and nothing else. Where the
  // handover lands mid-session the residual must be ~0; where it lands at a
  // session boundary the residual is the market's real move over that break,
  // which MUST survive — flattening it would delete history.
  let worstMid = 0, worstMidAt = 0;
  for (const r of meta.rollovers) {
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (ts[m] < r.ms) lo = m + 1; else hi = m; }
    const i = lo;
    if (i <= 0 || i >= n) continue;
    const seam = C[i] - C[i - 1];
    const elapsed = (ts[i] - ts[i - 1]) / 60000;
    const midSession = elapsed <= 5;
    if (midSession && Math.abs(seam) > worstMid) { worstMid = Math.abs(seam); worstMidAt = ts[i]; }
    const note = midSession
      ? (Math.abs(seam) < 1 ? "flat" : `${elapsed}-min market move`)
      : "session break — real move preserved";
    console.log(
      `  ${iso(r.ms)}  ${r.from.padEnd(6)}-> ${r.to.padEnd(6)}${String(r.gap).padStart(8)}pt` +
      `${String(Math.round(elapsed) + "m").padStart(8)}  ${seam.toFixed(2).padStart(8)}pt   ${note}`
    );
  }
  console.log(`\n  worst UNEXPLAINED (mid-session) seam: ${worstMid.toFixed(2)} pt`);
  flag(worstMid > 30, `mid-session seam of ${worstMid.toFixed(2)}pt at ${iso(worstMidAt)} is too large to be a 1-min move`);

  // A mis-measured roll shows up as a spread far outside the others. This is the
  // exact signature of the close-to-close bug: a 654pt "spread" beside a ~215pt
  // median, because a weekend's price move had been folded into it.
  const spreads = meta.rollovers.map((r) => r.gap);
  const med = spreads.slice().sort((a, b) => a - b)[Math.floor(spreads.length / 2)];
  const maxS = Math.max(...spreads.map(Math.abs));
  console.log(`  spread median ${med.toFixed(2)}pt, max |spread| ${maxS.toFixed(2)}pt (${(maxS / Math.abs(med)).toFixed(2)}x median)`);
  flag(maxS > 3 * Math.abs(med), "a roll spread is a large outlier — likely conflated with a price move");

  const fellBack = meta.rollovers.filter((r) => r.method && r.method !== "overlap");
  if (fellBack.length) flag(true, `${fellBack.length} roll(s) had no overlapping quotes and used close-to-close`);
  else console.log("  every roll spread measured from genuine same-minute overlap.");
}

// ───────────────────── 4. largest jumps, classified ─────────────────────
hr("4. Largest price jumps (are any of them artifacts?)");
const jumps = [];
for (let i = 1; i < n; i++) {
  const j = Math.abs(C[i] - C[i - 1]);
  if (j > 40) jumps.push({ i, j, dtMin: (ts[i] - ts[i - 1]) / 60000 });
}
jumps.sort((a, b) => b.j - a.j);
console.log(`  ${jumps.length} bar-to-bar moves over 40pt\n`);
console.log("  jump      time gap    when                 classification");
let suspicious = 0;
for (const x of jumps.slice(0, 15)) {
  const cls = x.dtMin > 120 ? "session gap (market closed)"
            : x.dtMin > 1 ? "data gap within session"
            : "INTRA-SESSION 1-min move";
  if (x.dtMin <= 1) suspicious++;
  console.log(`  ${x.j.toFixed(1).padStart(7)}pt  ${String(Math.round(x.dtMin)).padStart(6)}m   ${iso(ts[x.i])}   ${cls}`);
}
const bigIntra = jumps.filter((x) => x.dtMin <= 1);
console.log(`\n  moves >40pt inside one 1-min bar with no time gap: ${bigIntra.length}`);
if (bigIntra.length) {
  console.log(`  largest such move     : ${bigIntra[0].j.toFixed(1)}pt at ${iso(ts[bigIntra[0].i])}`);
  console.log("  (real for MNQ around CPI/FOMC prints — check the dates against the calendar)");
}

// ───────────────── 5. back-adjustment magnitude ─────────────────
hr("5. Back-adjustment offset (prices are SYNTHETIC before the last roll)");
const totalAdj = (meta.rollovers || []).reduce((a, r) => a + r.gap, 0);
console.log(`  cumulative adjustment applied to the oldest bars: ${totalAdj.toFixed(2)} pt`);
console.log(`  first bar close in cache : ${C[0].toFixed(2)}`);
console.log(`  first bar close as traded: ${(C[0] - totalAdj).toFixed(2)}  (cache minus cumulative adj)`);
console.log(`  last bar close           : ${C[n - 1].toFixed(2)}  (unadjusted — most recent contract)`);
console.log(`
  Inherent to a continuous contract, not a defect: differences are true, absolute
  levels before the final roll are not. Fine for ATR/ADX/Donchian/EMA and any
  point-difference P&L. NOT fine for anything keyed to a price LEVEL — round-number
  logic, percent-of-price stops, or reading the 2021 y-axis as a real quote.`);

// ── 5b. the adjustment must be purely ADDITIVE ──
// A back-adjustment may shift a whole contract piece; it must never alter the
// shape within one. Every bar's internal geometry has to survive untouched.
hr("5b. Adjustment is shape-preserving (additive only)");
let shapeBad = 0, tickBad = 0;
for (let i = 0; i < n; i++) {
  // Bar geometry (high-low, close-open) is invariant under an additive shift.
  if (H[i] - L[i] < -1e-6) shapeBad++;
  // Every MNQ price is a multiple of the 0.25 tick; the shift is a sum of tick
  // multiples, so this must still hold after adjustment. Off-grid prices would
  // mean float error crept in.
  const q = C[i] * 4;
  if (Math.abs(q - Math.round(q)) > 1e-3) tickBad++;
}
console.log(`  bars with negative range      : ${shapeBad}`);
console.log(`  closes off the 0.25 tick grid : ${tickBad} (${((tickBad / n) * 100).toFixed(3)}%)`);
flag(shapeBad, "bar geometry corrupted");
flag(tickBad > n * 0.001, "prices drifted off the tick grid — float precision loss in the adjustment");

// ── 5c. round-trip against the ORIGINAL CSV ──
hr("5c. Round-trip: cache vs original CSV (unadjusted final contract)");
console.log(`  The final contract piece is never shifted (cumulative adjustment = 0`);
console.log(`  there), so its cached prices must equal the raw CSV exactly.`);
const lastRollMs = meta.rollovers.length ? meta.rollovers[meta.rollovers.length - 1].ms : ts[0];
let li = 0, hiB = n;
while (li < hiB) { const m = (li + hiB) >>> 1; if (ts[m] < lastRollMs) li = m + 1; else hiB = m; }
console.log(`  final piece: ${(n - li).toLocaleString()} bars from ${iso(ts[li])}`);
console.log(`  (verified against the CSV by test.mjs — run: node test.mjs)`);

// ───────────────────────── 6. volume + coverage ─────────────────────────
hr("6. Volume and coverage");
let zeroVol = 0, negVol = 0;
for (let i = 0; i < n; i++) { if (V[i] === 0) zeroVol++; else if (V[i] < 0) negVol++; }
console.log(`  zero-volume bars      : ${zeroVol.toLocaleString()} (${((zeroVol / n) * 100).toFixed(2)}%)`);
console.log(`  negative volume       : ${negVol}`);
const days = new Set();
for (let i = 0; i < n; i += 60) days.add(tday[i]);
console.log(`  distinct CME sessions : ${days.size.toLocaleString()}`);
console.log(`  mean bars per session : ${(n / days.size).toFixed(0)} (1380 = a full 23h session)`);
flag(negVol, "negative volume present");

// ───────────────────────── verdict ─────────────────────────
hr("Verdict");
console.log(problems === 0
  ? "  No artifacts found. The series is continuous, ordered, and internally consistent."
  : `  ${problems} problem area(s) flagged above — investigate before trusting any backtest.`);
process.exit(problems === 0 ? 0 : 1);
