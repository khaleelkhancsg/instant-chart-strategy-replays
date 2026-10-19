// Anatomy of the 1-min MACD fade: every 2026 RTH cross, not just the ones the
// day rules let through. Each cross gets the setup's own entry (stop-entry
// 0.15 ATR beyond the next open, live 10 bars, refused stop -> limit) and its
// outcome is measured several ways from the fill: at the next cross (the
// setup's exit), at fixed horizons, and its best/worst excursion. Features are
// all known at the signal bar's close. 2026 ONLY.
//
// Theory being tested (see the session notes):
//   liquidity provision pays more when volatility is high (Nagel 2012)
//   high-volume moves reverse more than low-volume ones (Campbell-Grossman-Wang 1993)
//   impact of a burst of one-sided flow is partly transient (Bouchaud et al.)
//   intraday reversal peaks around 15-minute horizons (Baule-Schlie-Zhou 2025)
//   Nasdaq-100 futures reverse the overnight move intraday (Yu-Rentzler-Wolf 2005)
//
// RESULT (2026, 2,979 filled fades): the fade has no edge on average: -0.7
// pts a trade after costs at the next cross [-2.1, +0.9]; about -2 pts five
// minutes after the fill (the push keeps going first), ~0 by 45-60 minutes.
// The edge is the FIRST fade of the day: +10.6 pts [+2.1, +19.6] with the
// setup's exits; the 2nd to 5th are negative. With the MACD line already on
// the fade's side (fading a bounce against the short-term trend) +0.7, against
// it -3.0 [-5.8, -0.5], in both halves. Fading a pullback just short of VWAP
// +5.5; fading an opening-range break -2.0. Very high relative volume and
// volatility look better here, but on thin samples (n 45 / 224).
//
//   node --max-old-space-size=8192 research/macd_anatomy_2026.mjs [out.json]

import fs from "node:fs";
import { macd } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const E1 = S.engineFor(1), t = E1.tf, A = E1.atr;
const { open: O, high: H, low: L, close: C, volume: V, ctMin: CT, tday: TD } = t;
const n = C.length;
const { line: ML, hist: HS } = macd(C, 12, 26, 9);
const COST = 1.25;              // points a round trip: 1 tick slippage a side + $1.50 commission per lot
const TICK = 0.25;

// ---- per-session context (causal) ------------------------------------------
const rthOpen = new Map(), rthClose = new Map(), dayIdx = new Map();
const tdays = [];
for (let i = 0; i < n; i++) {
  if (CT[i] >= 510 && CT[i] < 900) {
    if (!rthOpen.has(TD[i])) { rthOpen.set(TD[i], i); tdays.push(TD[i]); }
    rthClose.set(TD[i], i);
  }
}
tdays.forEach((d, q) => dayIdx.set(d, q));
// volume by minute of day, for relative volume against the previous 10 sessions
const volByMin = new Map();
for (const d of tdays) {
  const a = new Float64Array(390);
  for (let i = rthOpen.get(d); i <= rthClose.get(d); i++) if (CT[i] >= 510 && CT[i] < 900) a[CT[i] - 510] = V[i];
  volByMin.set(d, a);
}
const atrRth = new Map();
for (const d of tdays) { let s = 0, c = 0; for (let i = rthOpen.get(d); i <= rthClose.get(d); i++) { s += A[i]; c++; } atrRth.set(d, s / c); }
const rangeRth = new Map();
for (const d of tdays) { let hi = -Infinity, lo = Infinity; for (let i = rthOpen.get(d); i <= rthClose.get(d); i++) { hi = Math.max(hi, H[i]); lo = Math.min(lo, L[i]); } rangeRth.set(d, hi - lo); }
const prev10 = (d, f) => { const q = dayIdx.get(d); const xs = []; for (let j = Math.max(0, q - 10); j < q; j++) xs.push(f(tdays[j])); return xs; };
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);

// last cross (any session) before each bar, and running RTH session state
const lastCross = new Int32Array(n).fill(-1);
for (let i = 1, lc = -1; i < n; i++) {
  lastCross[i] = lc;
  if ((HS[i] > 0 && HS[i - 1] <= 0) || (HS[i] < 0 && HS[i - 1] >= 0)) lc = i;
}
const vwap = new Float64Array(n).fill(NaN), rHi = new Float64Array(n).fill(NaN), rLo = new Float64Array(n).fill(NaN);
const orHi = new Float64Array(n).fill(NaN), orLo = new Float64Array(n).fill(NaN), crossNo = new Int16Array(n);
{
  let cd = -1, pv = 0, vv = 0, hi = -Infinity, lo = Infinity, oh = -Infinity, ol = Infinity, cn = 0;
  for (let i = 0; i < n; i++) {
    if (!(CT[i] >= 510 && CT[i] < 900)) continue;
    if (TD[i] !== cd) { cd = TD[i]; pv = 0; vv = 0; hi = -Infinity; lo = Infinity; oh = -Infinity; ol = Infinity; cn = 0; }
    const tp = (H[i] + L[i] + C[i]) / 3;
    pv += tp * V[i]; vv += V[i];
    vwap[i] = vv > 0 ? pv / vv : C[i];
    hi = Math.max(hi, H[i]); lo = Math.min(lo, L[i]);
    rHi[i] = hi; rLo[i] = lo;
    if (CT[i] < 525) { oh = Math.max(oh, H[i]); ol = Math.min(ol, L[i]); }
    orHi[i] = oh; orLo[i] = ol;
    const cr = (HS[i] > 0 && HS[i - 1] <= 0) || (HS[i] < 0 && HS[i - 1] >= 0);
    if (cr) cn++;
    crossNo[i] = cn;
  }
}

const isCross = (i) => i >= 1 && ((HS[i] > 0 && HS[i - 1] <= 0) || (HS[i] < 0 && HS[i - 1] >= 0));
// ---- the events --------------------------------------------------------------
const HZ = [3, 5, 10, 15, 20, 30, 45, 60];
const ev = [];
for (let k = 1; k < n - 2; k++) {
  if (S.yearOf.get(TD[k]) !== 2026 || !(CT[k] >= 510 && CT[k] < 900)) continue;
  const cross = HS[k] > 0 && HS[k - 1] <= 0 ? 1 : HS[k] < 0 && HS[k - 1] >= 0 ? -1 : 0;
  if (!cross) continue;
  const s = -cross;                                   // the fade's direction
  const d = TD[k], a = A[k];
  // entry exactly as the setup: arm at k+1 from its open; live 10 bars; refused stop -> limit
  const arm = k + 1;
  if (TD[arm] !== d || CT[arm] >= 895) continue;
  const px = O[arm] + s * Math.max(0.15 * A[k], TICK);
  let f = -1, isLimit = false;
  for (let i = arm + 1; i <= arm + 10 && i < n && TD[i] === d && CT[i] < 905; i++) {
    if (isCross(i - 1) && CT[i - 1] >= 510 && CT[i - 1] < 900) break;     // the next cross cancels the order (cancelOpposite)
    if (i === arm + 1 && (s === 1 ? O[i] >= px : O[i] <= px)) { isLimit = true; if (s === 1 ? L[i] <= px : H[i] >= px) { f = i; break; } continue; }
    const hit = isLimit ? (s === 1 ? L[i] <= px : H[i] >= px) : (s === 1 ? H[i] >= px : L[i] <= px);
    if (hit) { f = i; break; }
  }
  // features
  const pc = lastCross[k];
  let ext = s === -1 ? Infinity : -Infinity, hpk = 0, pvol = 0;
  for (let j = Math.max(pc, k - 120); j <= k; j++) {
    ext = s === -1 ? Math.min(ext, L[j]) : Math.max(ext, H[j]);
    hpk = Math.max(hpk, Math.abs(HS[j]));
  }
  for (let j = k - 4; j <= k; j++) pvol += V[j];
  const vm = prev10(d, (x) => { const a2 = volByMin.get(x); let s2 = 0; for (let m = CT[k] - 4; m <= CT[k]; m++) s2 += a2[m - 510] || 0; return s2; });
  const prevD = tdays[dayIdx.get(d) - 1];
  const gap = prevD !== undefined ? O[rthOpen.get(d)] - C[rthClose.get(prevD)] : NaN;
  const adr = mean(prev10(d, (x) => rangeRth.get(x)));
  const e = {
    k, d, s, ct: CT[k], m: new Date(t.ts[k]).getUTCMonth(),
    tmin: CT[k] - 510, order: crossNo[k], atr: a,
    volRel: a / mean(prev10(d, (x) => atrRth.get(x))),
    push: s === -1 ? (C[k] - ext) / a : (ext - C[k]) / a,            // the move being faded, in ATR
    pushBars: k - pc, histPeak: hpk / a,
    withTrend: Math.sign(ML[k]) === s ? 1 : 0,                       // the bigger MACD trend is on the fade's side
    toVwap: (s * (vwap[k] - C[k])) / a,                              // > 0: VWAP lies in the fade's direction
    gapFill: Number.isFinite(gap) && gap !== 0 ? (s === -Math.sign(gap) ? 1 : 0) : -1,
    gapAtr: Number.isFinite(gap) ? Math.abs(gap) / a : NaN,
    orBreak: CT[k] >= 525 ? ((s === -1 && C[k] > orHi[k]) || (s === 1 && C[k] < orLo[k]) ? 1 : 0) : -1,
    rvol: mean(vm) > 0 ? pvol / mean(vm) : NaN,
    wick: H[k] > L[k] ? (s === -1 ? H[k] - Math.max(O[k], C[k]) : Math.min(O[k], C[k]) - L[k]) / (H[k] - L[k]) : 0,
    rangeUsed: adr > 0 ? (rHi[k] - rLo[k]) / adr : NaN,
    histSlope: Math.abs(HS[k] - HS[k - 1]) / a,
    filled: f >= 0, limit: isLimit, wait: f >= 0 ? f - arm : -1,
  };
  if (f >= 0) {
    // the setup's exit: the open after the next opposite cross (or the 15:05 flat)
    let x = -1, xp = NaN;
    for (let i = f + 1; i < n; i++) {
      if (TD[i] !== d || CT[i] >= 905) { x = i; xp = TD[i] === d ? O[i] : C[i - 1]; break; }
      const c2 = HS[i - 1] > 0 && HS[i - 2] <= 0 ? 1 : HS[i - 1] < 0 && HS[i - 2] >= 0 ? -1 : 0;
      if (i - 1 > f && c2 === -s * -1 && CT[i - 1] >= 510 && CT[i - 1] < 900) { x = i; xp = O[i]; break; }   // next cross the other way
    }
    e.flip = s * (xp - px) - COST;
    e.flipBars = x - f;
    for (const h of HZ) {
      let j = f + h;
      while (j > f && (TD[j] !== d || CT[j] >= 905)) j--;
      e["h" + h] = s * (C[j] - px) - COST;
    }
    let mfe = s * (C[f] - px), mae = mfe;
    for (let j = f + 1; j <= f + 30 && j < n && TD[j] === d && CT[j] < 905; j++) {
      mfe = Math.max(mfe, s * ((s === 1 ? H[j] : L[j]) - px));
      mae = Math.min(mae, s * ((s === 1 ? L[j] : H[j]) - px));
    }
    e.mfe30 = mfe / a; e.mae30 = mae / a;
    // the setup's full exit on a flat day at 4 lots: stop at the $600 line (75 pts from the
    // average fill) or 5 ATR from the reference, target min(5.15 ATR, 75) from the trigger,
    // the next cross, or the 15:05 flat -- bar by bar as the engine checks them
    const avg = px + s * TICK, ref = O[arm];
    const sl = s === 1 ? Math.max(ref - 5 * a, avg - 75) : Math.min(ref + 5 * a, avg + 75);
    const tp = px + s * Math.max(Math.min(5.15 * a, 75), TICK);
    let sp = NaN;
    for (let i = f; i < n; i++) {
      if (i > f && (TD[i] !== d || CT[i] >= 905)) { sp = s * ((TD[i] === d ? O[i] : C[i - 1]) - avg) - TICK - 0.75; break; }
      const o = i === f ? NaN : O[i];
      if (s === 1) {
        if (o <= sl) { sp = s * (o - avg) - TICK - 0.75; break; }
        if (L[i] <= sl) { sp = s * (sl - avg) - TICK - 0.75; break; }
        if (H[i] >= tp && !(isLimit && i === f && C[i] < tp)) { sp = s * (tp - avg) - TICK - 0.75; break; }
      } else {
        if (o >= sl) { sp = s * (o - avg) - TICK - 0.75; break; }
        if (H[i] >= sl) { sp = s * (sl - avg) - TICK - 0.75; break; }
        if (L[i] <= tp && !(isLimit && i === f && C[i] > tp)) { sp = s * (tp - avg) - TICK - 0.75; break; }
      }
      if (i + 1 < n && i >= f && isCross(i) && CT[i] >= 510 && CT[i] < 900 && i > f - 1 && (HS[i] > 0 ? 1 : -1) === s && i >= f) {
        sp = s * (O[i + 1] - avg) - TICK - 0.75; break;                    // flip at the next open
      }
    }
    e.strat = sp;
  }
  ev.push(e);
}
const fl = ev.filter((e) => e.filled);
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(ev));

// ---- reporting ------------------------------------------------------------------
const rnd = S.mul(99);
const daysOf = [...new Set(fl.map((e) => e.d))];
function stat(xs, key) {
  const v = xs.map((e) => e[key]).filter(Number.isFinite);
  const m = mean(v);
  // day-clustered bootstrap of the mean
  const by = new Map();
  for (const e of xs) if (Number.isFinite(e[key])) { const a = by.get(e.d) || []; a.push(e[key]); by.set(e.d, a); }
  const ks = [...by.keys()], bs = [];
  for (let b = 0; b < 400; b++) { let s = 0, c = 0; for (let j = 0; j < ks.length; j++) { const a = by.get(ks[Math.floor(rnd() * ks.length)]); for (const x of a) { s += x; c++; } } bs.push(s / Math.max(1, c)); }
  bs.sort((x, y) => x - y);
  return { n: v.length, m, lo: bs[10], hi: bs[389] };
}
const f2 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(2) : "-").padStart(w);
const cell = (xs, key) => { const r = stat(xs, key); return f2(r.m, 7) + " [" + f2(r.lo, 5) + "," + f2(r.hi, 5) + "]"; };
console.log(`2026 RTH MACD crosses: ${ev.length}, filled ${fl.length} (${(100 * fl.length / ev.length).toFixed(0)}%), ${daysOf.length} days. Outcomes in points after ${COST} pts of costs.`);
console.log("\n  all filled fades, by exit horizon (mean points, 95% day-clustered CI)");
for (const key of ["flip", ...HZ.map((h) => "h" + h)]) console.log("    " + (key === "flip" ? "at the next cross" : key.slice(1) + " min").padEnd(20) + cell(fl, key) + "   Jan-Mar" + f2(stat(fl.filter((e) => e.m < 3), key).m, 7) + "  Apr-Jul" + f2(stat(fl.filter((e) => e.m >= 3), key).m, 7));

function split(lbl, fn, buckets) {
  console.log("\n  " + lbl + "  (mean points at the next cross | at 15 min | n | Jan-Mar / Apr-Jul at the next cross)");
  for (const [bl, test] of buckets) {
    const xs = fl.filter((e) => test(fn(e)));
    if (xs.length < 15) continue;
    const a1 = stat(xs.filter((e) => e.m < 3), "flip").m, a2 = stat(xs.filter((e) => e.m >= 3), "flip").m;
    console.log("    " + bl.padEnd(26) + cell(xs, "flip") + "  " + f2(stat(xs, "h15").m, 7) + String(xs.length).padStart(6) + "   " + f2(a1) + " /" + f2(a2));
  }
}
const rng = (lo, hi) => (x) => x >= lo && x < hi;
{
  // the nth FILLED fade of each day -- what the day rules mostly keep is the first one or two
  const byDay = new Map();
  for (const e of fl) { const a = byDay.get(e.d) || []; a.push(e); byDay.set(e.d, a); }
  for (const a of byDay.values()) a.forEach((e, q) => { e.nth = q + 1; });
  console.log("\n  the nth filled fade of the day (each cross's own trade, no day rules)");
  console.log("    " + "".padEnd(26) + "  next cross [95% CI]      setup's exit [95% CI]     n   Jan-Mar / Apr-Jul (setup's exit)");
  for (const [bl, test] of [["1st", (x) => x === 1], ["2nd", (x) => x === 2], ["3rd", (x) => x === 3], ["4th-5th", (x) => x >= 4 && x <= 5], ["6th+", (x) => x >= 6]]) {
    const xs = fl.filter((e) => test(e.nth));
    console.log("    " + bl.padEnd(26) + cell(xs, "flip") + "   " + cell(xs, "strat") + String(xs.length).padStart(6) + "   " +
                f2(stat(xs.filter((e) => e.m < 3), "strat").m) + " /" + f2(stat(xs.filter((e) => e.m >= 3), "strat").m));
  }
}
split("minutes since 08:30 CT", (e) => e.tmin, [["0-5", rng(0, 5)], ["5-15", rng(5, 15)], ["15-30", rng(15, 30)], ["30-60", rng(30, 60)], ["60-120", rng(60, 120)], ["120-270", rng(120, 270)], ["270-390", rng(270, 391)]]);
split("RTH cross number of the day", (e) => e.order, [["1st", (x) => x === 1], ["2nd", (x) => x === 2], ["3rd", (x) => x === 3], ["4th-5th", rng(4, 6)], ["6th+", rng(6, 999)]]);
const early = (fn) => (e) => (e.tmin < 30 ? fn(e) : NaN);
split("push being faded (ATR), first 30 min", early((e) => e.push), [["< 1", rng(-9, 1)], ["1-2", rng(1, 2)], ["2-3", rng(2, 3)], ["3-5", rng(3, 5)], ["5+", rng(5, 999)]]);
split("push being faded (ATR), after 09:00", (e) => (e.tmin >= 30 ? e.push : NaN), [["< 1", rng(-9, 1)], ["1-2", rng(1, 2)], ["2-3", rng(2, 3)], ["3-5", rng(3, 5)], ["5+", rng(5, 999)]]);
split("ATR vs its 10-day average", (e) => e.volRel, [["< 0.8", rng(0, 0.8)], ["0.8-1.2", rng(0.8, 1.2)], ["1.2-2", rng(1.2, 2)], ["2+", rng(2, 99)]]);
split("volume, last 5 min vs same minutes of 10 days", (e) => e.rvol, [["< 0.7", rng(0, 0.7)], ["0.7-1", rng(0.7, 1)], ["1-1.5", rng(1, 1.5)], ["1.5-2.5", rng(1.5, 2.5)], ["2.5+", rng(2.5, 999)]]);
split("bigger MACD trend vs the fade", (e) => e.withTrend, [["fade WITH the MACD trend", (x) => x === 1], ["fade AGAINST it", (x) => x === 0]]);
split("first 30 min: MACD trend vs the fade", early((e) => e.withTrend), [["with", (x) => x === 1], ["against", (x) => x === 0]]);
split("VWAP in the fade's direction (ATR)", (e) => e.toVwap, [["VWAP behind (< -1)", rng(-99, -1)], ["-1 to 0", rng(-1, 0)], ["0 to 1", rng(0, 1)], ["1 to 3", rng(1, 3)], ["3+ (far, ahead)", rng(3, 99)]]);
split("overnight gap: fade toward the prior close?", (e) => e.gapFill, [["toward the close (gap fill)", (x) => x === 1], ["away from it", (x) => x === 0]]);
split("first 30 min: fade toward the prior close?", early((e) => e.gapFill), [["toward the close", (x) => x === 1], ["away", (x) => x === 0]]);
split("price beyond the 15-min opening range (fading a break)", (e) => e.orBreak, [["beyond the opening range", (x) => x === 1], ["inside it", (x) => x === 0]]);
split("rejection wick on the signal bar (share of range)", (e) => e.wick, [["< 0.1", rng(0, 0.1)], ["0.1-0.3", rng(0.1, 0.3)], ["0.3-0.5", rng(0.3, 0.5)], ["0.5+", rng(0.5, 1.01)]]);
split("day's range so far vs 10-day average", (e) => e.rangeUsed, [["< 0.3", rng(0, 0.3)], ["0.3-0.6", rng(0.3, 0.6)], ["0.6-0.9", rng(0.6, 0.9)], ["0.9+", rng(0.9, 99)]]);
split("bars since the previous cross", (e) => e.pushBars, [["1-5", rng(1, 6)], ["6-10", rng(6, 11)], ["11-20", rng(11, 21)], ["21+", rng(21, 9999)]]);
split("fill: stop vs refused-stop limit", (e) => (e.limit ? 1 : 0), [["stop fill", (x) => x === 0], ["limit fill", (x) => x === 1]]);

// excursions: how far do fades go for and against, first 30 minutes after the fill?
console.log("\n  excursion in the 30 minutes after the fill (ATR): first 30 min of RTH vs later");
for (const [lbl, xs] of [["fills before 09:00", fl.filter((e) => e.tmin < 30)], ["fills after 09:00", fl.filter((e) => e.tmin >= 30)]]) {
  const q = (arr, p) => { const b = arr.slice().sort((x, y) => x - y); return b[Math.floor(p * (b.length - 1))]; };
  const mf = xs.map((e) => e.mfe30), ma = xs.map((e) => e.mae30);
  console.log("    " + lbl.padEnd(20) + "best excursion median " + f2(q(mf, 0.5)) + " (75%: " + f2(q(mf, 0.75)) + ")   worst median " + f2(q(ma, 0.5)) + " (25%: " + f2(q(ma, 0.25)) + ")   hold to next cross median " +
              q(xs.map((e) => e.flipBars), 0.5) + " bars");
}
