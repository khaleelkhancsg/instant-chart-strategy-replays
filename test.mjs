// Correctness test suite.  node test.mjs
//
// Philosophy: an optimised implementation is tested against a naive one that is
// obviously correct, and rule logic is tested against hand-traced numbers worked
// out on paper. Passing a test written from the same misunderstanding as the code
// proves nothing, so the references here are deliberately independent.

import fs from "node:fs";
import { ema, sma, atr, adx, rsi, donchian, rollingMeanStd, trueRange, efficiencyRatio } from "./src/indicators.mjs";
import { buildFilterContext, applyFilters, countSurviving } from "./src/filters.mjs";
import { resample, sliceBars, indexAtOrAfter, indexAtOrBefore } from "./src/resample.mjs";
import { runBrackets, tradeStats, EXIT } from "./src/engine.mjs";
import { replayWindow, sweepWindows, simulateFunded, sweepFunded, hasOverlappingTrades, OUTCOME } from "./src/challenge.mjs";
import { loadBars, packBars } from "./src/data.mjs";

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
function eq(a, b, msg = "") {
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}
function close(a, b, tol = 1e-9, msg = "") {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg} expected ${b} +-${tol}, got ${a} (diff ${Math.abs(a - b)})`);
}
function arrClose(a, b, tol = 1e-9, msg = "") {
  eq(a.length, b.length, `${msg} length:`);
  for (let i = 0; i < a.length; i++) {
    if (!(Math.abs(a[i] - b[i]) <= tol)) throw new Error(`${msg} index ${i}: expected ${b[i]}, got ${a[i]}`);
  }
}
function section(s) { console.log(`\n${s}\n${"-".repeat(s.length)}`); }

// Deterministic PRNG so failures reproduce.
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function synthBars(n, startMs = Date.UTC(2024, 0, 1), stepMs = 60000, px = 18000) {
  const ts = new Float64Array(n), O = new Float32Array(n), H = new Float32Array(n);
  const L = new Float32Array(n), C = new Float32Array(n), V = new Float32Array(n);
  const tday = new Int32Array(n);
  const ctMin = new Int16Array(n);
  let p = px;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = Math.round((p + (rnd() - 0.5) * 30) * 4) / 4;
    const h = Math.round((Math.max(o, c) + rnd() * 10) * 4) / 4;
    const l = Math.round((Math.min(o, c) - rnd() * 10) * 4) / 4;
    ts[i] = startMs + i * stepMs; O[i] = o; H[i] = h; L[i] = l; C[i] = c;
    V[i] = Math.floor(rnd() * 500) + 1;
    tday[i] = Math.floor(ts[i] / 86400000);
    ctMin[i] = Math.floor((ts[i] / 60000) % 1440);
    p = c;
  }
  return { ts, open: O, high: H, low: L, close: C, volume: V, tday, ctMin, count: n };
}

// ══════════════════════════════ 1. INDICATORS ══════════════════════════════
section("1. Indicators vs independent references");

t("ema matches the recurrence by hand", () => {
  const x = [10, 12, 14, 13, 15];
  const out = ema(x, 4);          // alpha = 2/5 = 0.4
  const ref = [10];
  for (let i = 1; i < x.length; i++) ref.push(0.4 * x[i] + 0.6 * ref[i - 1]);
  arrClose(out, ref, 1e-12);
});

t("ema seeds on x[0], not zero", () => {
  eq(ema([7, 7, 7], 10)[0], 7);
});

t("ema of a constant series is that constant", () => {
  const out = ema(new Array(50).fill(3.5), 14);
  for (const v of out) close(v, 3.5, 1e-12);
});

t("sma matches a brute-force window mean", () => {
  const x = Array.from({ length: 60 }, () => rnd() * 100);
  const out = sma(x, 7);
  for (let i = 6; i < x.length; i++) {
    let s = 0;
    for (let j = i - 6; j <= i; j++) s += x[j];
    close(out[i], s / 7, 1e-9, `i=${i}`);
  }
  if (!Number.isNaN(out[5])) throw new Error("expected NaN before the window fills");
});

t("trueRange matches the textbook 3-term max", () => {
  const b = synthBars(200);
  const tr = trueRange(b.high, b.low, b.close);
  close(tr[0], b.high[0] - b.low[0], 1e-6, "first bar:");
  for (let i = 1; i < 200; i++) {
    const ref = Math.max(
      b.high[i] - b.low[i],
      Math.abs(b.high[i] - b.close[i - 1]),
      Math.abs(b.low[i] - b.close[i - 1])
    );
    close(tr[i], ref, 1e-6, `i=${i}`);
  }
});

t("atr is exactly ema(trueRange)", () => {
  const b = synthBars(300);
  arrClose(atr(b.high, b.low, b.close, 14), ema(trueRange(b.high, b.low, b.close), 14), 1e-12);
});

t("donchian deque matches O(n*p) brute force (5 periods x 400 bars)", () => {
  const b = synthBars(400);
  for (const p of [2, 5, 14, 30, 97]) {
    const { high: dh, low: dl } = donchian(b.high, b.low, p);
    for (let i = p; i < 400; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - p; j < i; j++) {           // prior p bars, EXCLUDING i
        if (b.high[j] > hh) hh = b.high[j];
        if (b.low[j] < ll) ll = b.low[j];
      }
      close(dh[i], hh, 1e-9, `p=${p} i=${i} high:`);
      close(dl[i], ll, 1e-9, `p=${p} i=${i} low:`);
    }
  }
});

t("donchian excludes the current bar (no lookahead)", () => {
  // A spike on the final bar must NOT appear in that bar's own channel.
  const n = 40;
  const b = synthBars(n);
  b.high[n - 1] = 99999; b.low[n - 1] = -99999;
  const { high: dh, low: dl } = donchian(b.high, b.low, 10);
  if (dh[n - 1] >= 99999) throw new Error("current bar's high leaked into its own channel");
  if (dl[n - 1] <= -99999) throw new Error("current bar's low leaked into its own channel");
});

t("donchian is NaN before enough history", () => {
  const b = synthBars(50);
  const { high: dh } = donchian(b.high, b.low, 20);
  for (let i = 0; i < 20; i++) if (!Number.isNaN(dh[i])) throw new Error(`index ${i} should be NaN`);
  if (Number.isNaN(dh[20])) throw new Error("index 20 should be defined");
});

t("adx matches an independent naive implementation", () => {
  const b = synthBars(300);
  const { adx: got } = adx(b.high, b.low, b.close, 14);
  // Naive: build the series step by step with no shared helpers.
  const H = b.high, L = b.low, C = b.close, n = 300;
  const tr = [H[0] - L[0]], pdm = [0], ndm = [0];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
    const up = H[i] - H[i - 1], dn = L[i - 1] - L[i];
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
  }
  const E = (a, p) => { const k = 2 / (p + 1); const o = [a[0]]; for (let i = 1; i < a.length; i++) o.push(k * a[i] + (1 - k) * o[i - 1]); return o; };
  const te = E(tr, 14), pe = E(pdm, 14), ne = E(ndm, 14);
  const dx = [];
  for (let i = 0; i < n; i++) {
    const pdi = te[i] === 0 ? 0 : (100 * pe[i]) / te[i];
    const ndi = te[i] === 0 ? 0 : (100 * ne[i]) / te[i];
    const s = pdi + ndi;
    dx.push(s === 0 ? 0 : (100 * Math.abs(pdi - ndi)) / s);
  }
  arrClose(got, E(dx, 14), 1e-9);
});

t("adx stays within [0,100]", () => {
  const b = synthBars(500);
  for (const v of adx(b.high, b.low, b.close, 14).adx) {
    if (!(v >= -1e-9 && v <= 100 + 1e-9)) throw new Error(`out of range: ${v}`);
  }
});

t("rsi stays within [0,100] and is 100 on a pure uptrend", () => {
  const up = Array.from({ length: 100 }, (_, i) => 100 + i);
  const r = rsi(up, 14);
  close(r[99], 100, 1e-6);
  for (const v of rsi(synthBars(300).close, 14)) {
    if (!(v >= -1e-9 && v <= 100 + 1e-9)) throw new Error(`out of range: ${v}`);
  }
});

t("rollingMeanStd matches brute force (sample stddev)", () => {
  const x = Array.from({ length: 120 }, () => rnd() * 50);
  const { mean, std } = rollingMeanStd(x, 20);
  for (let i = 19; i < x.length; i++) {
    const w = x.slice(i - 19, i + 1);
    const m = w.reduce((a, v) => a + v, 0) / 20;
    const s = Math.sqrt(w.reduce((a, v) => a + (v - m) ** 2, 0) / 19);
    close(mean[i], m, 1e-9, `mean i=${i}`);
    close(std[i], s, 1e-7, `std i=${i}`);
  }
});

// ══════════════════════════════ 2. RESAMPLE ══════════════════════════════
section("2. Resampling");

t("resample(1) is the identity", () => {
  const b = synthBars(100);
  const r = resample(b, 1);
  arrClose(r.close, b.close, 0);
  arrClose(r.ts, b.ts, 0);
});

t("5-min buckets are clock-aligned to :00 :05 :10", () => {
  // Start deliberately off-grid (00:02) — a correct implementation still snaps.
  const b = synthBars(60, Date.UTC(2024, 0, 1, 0, 2));
  const r = resample(b, 5);
  for (let i = 0; i < r.ts.length; i++) {
    if (r.ts[i] % (5 * 60000) !== 0) throw new Error(`bucket ${i} at ${new Date(r.ts[i]).toISOString()} is not on a 5-min boundary`);
  }
});

t("resampled OHLCV aggregates correctly from its source bars", () => {
  const b = synthBars(500, Date.UTC(2024, 0, 1));
  const r = resample(b, 15);
  for (let k = 0; k < r.close.length; k++) {
    const s = r.srcFirst[k], e = r.srcLast[k];
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (let i = s; i <= e; i++) { hi = Math.max(hi, b.high[i]); lo = Math.min(lo, b.low[i]); vol += b.volume[i]; }
    close(r.open[k], b.open[s], 1e-6, `bucket ${k} open:`);
    close(r.close[k], b.close[e], 1e-6, `bucket ${k} close:`);
    close(r.high[k], hi, 1e-6, `bucket ${k} high:`);
    close(r.low[k], lo, 1e-6, `bucket ${k} low:`);
    close(r.volume[k], vol, 1e-3, `bucket ${k} volume:`);
  }
});

t("every source bar belongs to exactly one bucket (no loss, no double count)", () => {
  const b = synthBars(1000);
  const r = resample(b, 5);
  const seen = new Int32Array(1000);
  for (let k = 0; k < r.close.length; k++) for (let i = r.srcFirst[k]; i <= r.srcLast[k]; i++) seen[i]++;
  for (let i = 0; i < 1000; i++) eq(seen[i], 1, `source bar ${i} covered ${seen[i]} times:`);
});

t("resample survives session gaps without drifting out of phase", () => {
  // 30 bars, a 3-day hole, then 30 more. Index-chunking would smear across it.
  const a = synthBars(30, Date.UTC(2024, 0, 5, 12, 0));
  const c = synthBars(30, Date.UTC(2024, 0, 8, 12, 0));
  const j = {
    ts: Float64Array.from([...a.ts, ...c.ts]), open: Float32Array.from([...a.open, ...c.open]),
    high: Float32Array.from([...a.high, ...c.high]), low: Float32Array.from([...a.low, ...c.low]),
    close: Float32Array.from([...a.close, ...c.close]), volume: Float32Array.from([...a.volume, ...c.volume]),
    tday: Int32Array.from([...a.tday, ...c.tday]),
  };
  const r = resample(j, 5);
  for (let i = 0; i < r.ts.length; i++) {
    if (r.ts[i] % 300000 !== 0) throw new Error("bucket drifted off the clock grid across the gap");
  }
  // No bucket may straddle the hole.
  for (let k = 0; k < r.close.length; k++) {
    if (j.ts[r.srcLast[k]] - j.ts[r.srcFirst[k]] > 5 * 60000) throw new Error(`bucket ${k} spans the session gap`);
  }
});

t("indexAtOrAfter / indexAtOrBefore bracket a target correctly", () => {
  const b = synthBars(200);
  for (const probe of [0, 37, 199]) {
    eq(indexAtOrAfter(b.ts, b.ts[probe]), probe, "exact hit:");
    eq(indexAtOrBefore(b.ts, b.ts[probe]), probe, "exact hit:");
  }
  eq(indexAtOrAfter(b.ts, b.ts[50] + 1), 51);
  eq(indexAtOrBefore(b.ts, b.ts[50] + 1), 50);
  eq(indexAtOrAfter(b.ts, b.ts[0] - 1e9), 0);
  eq(indexAtOrAfter(b.ts, b.ts[199] + 1e9), 200);
});

// ══════════════════════════════ 3. ENGINE ══════════════════════════════
section("3. Execution engine");

// Build an exact bar series so outcomes can be computed on paper.
function bars(rows, stepMs = 60000) {
  const n = rows.length;
  const b = {
    ts: new Float64Array(n), open: new Float32Array(n), high: new Float32Array(n),
    low: new Float32Array(n), close: new Float32Array(n), volume: new Float32Array(n),
    tday: new Int32Array(n),
  };
  rows.forEach((r, i) => {
    b.ts[i] = Date.UTC(2024, 0, 1) + i * stepMs;
    b.open[i] = r[0]; b.high[i] = r[1]; b.low[i] = r[2]; b.close[i] = r[3];
    b.volume[i] = 1; b.tday[i] = Math.floor(b.ts[i] / 86400000);
  });
  return b;
}
const NOFEE = { contracts: 1, pointValue: 2, commissionModel: "flat", commissionFlat: 0, slippageTicks: 0 };
const flatAtr = (n, v) => new Float64Array(n).fill(v);

t("entry fills at the OPEN of the bar AFTER the signal", () => {
  const b = bars([
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [105, 106, 104, 105],   // <- signal set at index 1 must fill HERE at 105
    [105, 106, 104, 105],
  ]);
  const sig = new Int8Array(4); sig[1] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(4, 10), { ...NOFEE, slAtrMult: 10, tpAtrMult: 10 });
  eq(trades.length, 1);
  eq(trades[0].entryIdx, 2, "entry index:");
  close(trades[0].entryPrice, 105, 1e-6, "entry price:");
});

t("no lookahead: bar i's own OHLC cannot change whether it was entered", () => {
  // Same signal, wildly different bar-2 extremes. Entry price must be identical
  // because only the OPEN is knowable at fill time.
  const mk = (hi, lo) => {
    const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [105, hi, lo, 105], [105, 106, 104, 105]]);
    const sig = new Int8Array(4); sig[1] = 1;
    return runBrackets(b, sig, flatAtr(4, 100), { ...NOFEE, slAtrMult: 10, tpAtrMult: 10 }).trades[0];
  };
  const a = mk(106, 104), c = mk(9999, 104);
  close(a.entryPrice, c.entryPrice, 1e-9, "entry price changed with future data:");
  eq(a.entryIdx, c.entryIdx, "entry index changed with future data:");
});

t("stop takes priority when stop and target are both inside one bar", () => {
  // Long from 100, stop 90, target 110; bar 2 spans 85..115 (touches both).
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 115, 85, 100]]);
  const sig = new Int8Array(3); sig[0] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(3, 10), { ...NOFEE, slAtrMult: 1, tpAtrMult: 1 });
  eq(trades[0].reason, EXIT.SL, "must assume the loss:");
  close(trades[0].exitPrice, 90, 1e-6);
});

t("a gap through the stop fills at the OPEN, not the stop price", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [80, 82, 78, 80]]);
  const sig = new Int8Array(3); sig[0] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(3, 10), { ...NOFEE, slAtrMult: 1, tpAtrMult: 5 });
  close(trades[0].exitPrice, 80, 1e-6, "should fill at the gapped open:");
});

t("short-side stop/target mirror the long side", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 115, 99, 100]]);
  const sig = new Int8Array(3); sig[0] = -1;
  const { trades } = runBrackets(b, sig, flatAtr(3, 10), { ...NOFEE, slAtrMult: 1, tpAtrMult: 1 });
  eq(trades[0].dir, -1);
  eq(trades[0].reason, EXIT.SL);
  close(trades[0].exitPrice, 110, 1e-6, "short stop sits ABOVE entry:");
});

t("P&L arithmetic: points x pointValue x contracts, minus fees", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 110, 99, 100], [100, 110, 99, 100]]);
  const sig = new Int8Array(4); sig[0] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(4, 10), {
    contracts: 3, pointValue: 2, commissionModel: "per-contract", commissionPerSide: 0.75,
    slippageTicks: 0, slAtrMult: 5, tpAtrMult: 1,
  });
  // Entry 100, target +10 -> exit 110. 10pt x $2 x 3 = $60 gross.
  // Fees: 0.75 x 2 sides x 3 contracts = $4.50.
  close(trades[0].gross, 60, 1e-6, "gross:");
  close(trades[0].fees, 4.5, 1e-6, "fees:");
  close(trades[0].pnl, 55.5, 1e-6, "net:");
});

t("flat commission does not scale with contracts; per-contract does", () => {
  const run = (cfg) => {
    const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 110, 99, 100], [100, 110, 99, 100]]);
    const sig = new Int8Array(4); sig[0] = 1;
    return runBrackets(b, sig, flatAtr(4, 10), { pointValue: 2, slippageTicks: 0, slAtrMult: 5, tpAtrMult: 1, ...cfg }).trades[0];
  };
  close(run({ contracts: 8, commissionModel: "flat", commissionFlat: 5 }).fees, 5, 1e-9);
  close(run({ contracts: 8, commissionModel: "per-contract", commissionPerSide: 0.75 }).fees, 12, 1e-9);
});

t("slippage hurts both legs, never helps", () => {
  const mk = (ticks) => {
    const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 110, 99, 100], [100, 110, 99, 100]]);
    const sig = new Int8Array(4); sig[0] = 1;
    return runBrackets(b, sig, flatAtr(4, 10), { ...NOFEE, slippageTicks: ticks, tickSize: 0.25, slAtrMult: 5, tpAtrMult: 1 }).trades[0];
  };
  const a = mk(0), s = mk(2);          // 2 ticks = 0.5pt each side
  close(s.entryPrice, a.entryPrice + 0.5, 1e-6, "long entry should fill worse (higher):");
  close(s.exitPrice, a.exitPrice - 0.5, 1e-6, "long exit should fill worse (lower):");
  if (!(s.pnl < a.pnl)) throw new Error("slippage improved P&L");
});

t("flip closes at the open and re-enters on the SAME bar", () => {
  const b = bars([
    [100, 101, 99, 100], [100, 101, 99, 100],
    [102, 103, 101, 102], [102, 103, 101, 102], [102, 103, 101, 102],
  ]);
  const sig = new Int8Array(5); sig[0] = 1; sig[2] = -1;
  const { trades } = runBrackets(b, sig, flatAtr(5, 50), { ...NOFEE, slAtrMult: 10, tpAtrMult: 10 });
  eq(trades.length, 2, "expected a close and an immediate re-entry:");
  eq(trades[0].reason, EXIT.FLIP);
  eq(trades[0].exitIdx, 3, "flip exits at bar 3:");
  eq(trades[1].entryIdx, 3, "re-entry happens on the same bar:");
  eq(trades[1].dir, -1);
});

t("no re-entry on the bar a trade exited (causality)", () => {
  // Long stopped out mid-bar 2. A new signal on the same bar must NOT re-enter,
  // because the only available fill price is that bar's open — which occurred
  // BEFORE the stop-out.
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 85, 100], [100, 101, 99, 100]]);
  const sig = new Int8Array(4).fill(1);
  const { trades } = runBrackets(b, sig, flatAtr(4, 10), { ...NOFEE, slAtrMult: 1, tpAtrMult: 20 });
  const bar2Entries = trades.filter((t2) => t2.entryIdx === 2);
  eq(bar2Entries.length, 0, "must not enter on the bar it was stopped out:");
});

t("sameBarReentry:true opts into the non-causal fill", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 85, 100], [100, 101, 99, 100]]);
  const sig = new Int8Array(4).fill(1);
  const off = runBrackets(b, sig, flatAtr(4, 10), { ...NOFEE, slAtrMult: 1, tpAtrMult: 20 }).trades;
  const on = runBrackets(b, sig, flatAtr(4, 10), { ...NOFEE, slAtrMult: 1, tpAtrMult: 20, sameBarReentry: true }).trades;
  if (!(on.length > off.length)) throw new Error("flag had no effect");
  eq(on.some((t2) => t2.entryIdx === 2), true, "opting in allows the same-bar entry:");
});

t("tpMode:'rr' sets the target from the stop distance", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]]);
  const sig = new Int8Array(3); sig[0] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(3, 4), { ...NOFEE, slAtrMult: 1.5, tpMode: "rr", tpRR: 1.2 });
  const t2 = trades[0];
  close(t2.stop, 100 - 6, 1e-6, "stop = 1.5 x ATR(4):");
  close(t2.target, 100 + 7.2, 1e-6, "target = 1.2 x the 6pt stop distance:");
});

t("flipOnOpposite:false holds through an opposite signal", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]]);
  const sig = new Int8Array(4); sig[0] = 1; sig[1] = -1;
  const held = runBrackets(b, sig, flatAtr(4, 50), { ...NOFEE, slAtrMult: 10, tpAtrMult: 10, flipOnOpposite: false }).trades;
  eq(held.length, 1, "one trade, held to the end:");
  if (held[0].reason === EXIT.FLIP) throw new Error("flipped despite flipOnOpposite:false");
});

t("cooldownAfterStopMins blocks same-direction re-entry only", () => {
  const rows = Array.from({ length: 40 }, () => [100, 101, 99, 100]);
  rows[2] = [100, 101, 80, 100];               // stop out the long here
  const b = bars(rows);                        // 1-minute spacing
  const sig = new Int8Array(40).fill(1);
  const { trades } = runBrackets(b, sig, flatAtr(40, 10), { ...NOFEE, slAtrMult: 1, tpAtrMult: 50, cooldownAfterStopMins: 20 });
  const stop = trades.find((t2) => t2.reason === EXIT.SL);
  const after = trades.filter((t2) => t2.entryTime > stop.exitTime && t2.dir === 1);
  for (const t2 of after) {
    if (t2.entryTime - stop.exitTime < 20 * 60000) throw new Error("re-entered long inside the cooldown");
  }
});

t("MAE/MFE capture the worst and best excursion in dollars", () => {
  const b = bars([
    [100, 101, 99, 100], [100, 101, 99, 100],
    [100, 100, 100, 100],   // entry at 100
    [100, 108, 94, 100],    // +8 / -6 while open
    [100, 110, 99, 100],    // target hit
  ]);
  const sig = new Int8Array(5); sig[1] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(5, 10), { ...NOFEE, contracts: 2, slAtrMult: 5, tpAtrMult: 1 });
  const tr = trades[0];
  close(tr.mfe, 10 * 2 * 2, 1e-6, "MFE ($2/pt x 2 lots, best +10):");
  close(tr.mae, -6 * 2 * 2, 1e-6, "MAE (worst -6):");
  if (tr.mae > 0) throw new Error("MAE must be <= 0");
  if (tr.mfe < 0) throw new Error("MFE must be >= 0");
});

t("stop/target levels recorded on the trade match the ATR bracket", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]]);
  const sig = new Int8Array(4); sig[0] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(4, 4), { ...NOFEE, slAtrMult: 2, tpAtrMult: 6 });
  close(trades[0].stop, 100 - 8, 1e-6, "stop = entry - 2*ATR(4):");
  close(trades[0].target, 100 + 24, 1e-6, "target = entry + 6*ATR(4):");
});

t("only one position at a time", () => {
  const b = synthBars(400);
  const sig = new Int8Array(400);
  for (let i = 0; i < 400; i += 3) sig[i] = i % 2 ? 1 : -1;   // signal spam
  const { trades } = runBrackets(b, sig, atr(b.high, b.low, b.close, 14), { ...NOFEE, slAtrMult: 2, tpAtrMult: 4 });
  const sorted = trades.slice().sort((a, c) => a.entryIdx - c.entryIdx);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].entryIdx < sorted[i - 1].exitIdx) throw new Error(`trade ${i} opened before trade ${i - 1} closed`);
  }
});

// ── intraday-only session rules ──
// Bars carry a Chicago minute-of-day; build a series that walks across the
// 3:05 PM CT deadline so the rule can be checked at exact boundaries.
function ctBars(startCt, count, price = 100) {
  const b = bars(Array.from({ length: count }, () => [price, price + 1, price - 1, price]));
  b.ctMin = new Int16Array(count);
  for (let i = 0; i < count; i++) b.ctMin[i] = (startCt + i) % 1440;
  return b;
}
const INTRA = { ...NOFEE, intradayOnly: true, flattenCt: 15 * 60 + 5, reopenCt: 17 * 60 };

t("open position is flattened at the 3:05 PM CT deadline", () => {
  const b = ctBars(15 * 60, 12);              // 15:00 CT onward
  const sig = new Int8Array(12); sig[0] = 1;  // enter at 15:01
  const { trades } = runBrackets(b, sig, flatAtr(12, 50), { ...INTRA, slAtrMult: 10, tpAtrMult: 10 });
  eq(trades.length, 1);
  eq(trades[0].reason, EXIT.FLAT, "exit reason:");
  eq(b.ctMin[trades[0].exitIdx], 15 * 60 + 5, "flattened exactly at 15:05 CT:");
});

t("flatten outranks the bracket — it fires even when neither stop nor target hit", () => {
  const b = ctBars(15 * 60, 12);
  const sig = new Int8Array(12); sig[0] = 1;
  // Enormous bracket that can never be reached inside the run.
  const { trades } = runBrackets(b, sig, flatAtr(12, 1000), { ...INTRA, slAtrMult: 10, tpAtrMult: 10 });
  eq(trades[0].reason, EXIT.FLAT);
});

t("no new entries during the flat window", () => {
  const b = ctBars(15 * 60, 100);             // 15:00 -> 16:40 CT
  const sig = new Int8Array(100).fill(1);     // signal on every bar
  const { trades } = runBrackets(b, sig, flatAtr(100, 50), { ...INTRA, slAtrMult: 10, tpAtrMult: 10 });
  for (const t2 of trades) {
    const ct = b.ctMin[t2.entryIdx];
    if (ct >= 15 * 60 + 5 && ct < 17 * 60) throw new Error(`entered at ${Math.floor(ct / 60)}:${String(ct % 60).padStart(2, "0")} CT, inside the flat window`);
  }
});

t("trading resumes after the 5:00 PM CT reopen", () => {
  const b = ctBars(16 * 60 + 55, 30);         // 16:55 CT across the 17:00 reopen
  const sig = new Int8Array(30).fill(1);
  const { trades } = runBrackets(b, sig, flatAtr(30, 50), { ...INTRA, slAtrMult: 10, tpAtrMult: 10 });
  if (!trades.length) throw new Error("no trades taken after the reopen");
  eq(b.ctMin[trades[0].entryIdx] >= 17 * 60, true, "first entry is at or after 17:00 CT:");
});

t("no position survives the deadline across a long run", () => {
  const b = ctBars(0, 1440);                  // a whole day, minute by minute
  const sig = new Int8Array(1440);
  for (let i = 0; i < 1440; i += 7) sig[i] = i % 2 ? 1 : -1;
  const { trades } = runBrackets(b, sig, flatAtr(1440, 200), { ...INTRA, slAtrMult: 8, tpAtrMult: 8 });
  for (const t2 of trades) {
    for (let i = t2.entryIdx; i <= t2.exitIdx; i++) {
      const ct = b.ctMin[i];
      if (i !== t2.exitIdx && ct >= 15 * 60 + 5 && ct < 17 * 60) {
        throw new Error(`position open at ${Math.floor(ct / 60)}:${String(ct % 60).padStart(2, "0")} CT`);
      }
    }
  }
});

t("noEntryMinsBeforeFlat stands aside before the deadline", () => {
  const b = ctBars(14 * 60, 130);
  const sig = new Int8Array(130).fill(1);
  const { trades } = runBrackets(b, sig, flatAtr(130, 50), { ...INTRA, slAtrMult: 10, tpAtrMult: 10, noEntryMinsBeforeFlat: 30 });
  for (const t2 of trades) {
    const ct = b.ctMin[t2.entryIdx];
    if (ct >= 15 * 60 + 5 - 30 && ct < 17 * 60) throw new Error(`entered at ${ct} CT, inside the 30-min blackout`);
  }
});

t("intradayOnly:false restores overnight holding", () => {
  const b = ctBars(15 * 60, 12);
  const sig = new Int8Array(12); sig[0] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(12, 1000), { ...INTRA, intradayOnly: false, slAtrMult: 10, tpAtrMult: 10 });
  if (trades[0].reason === EXIT.FLAT) throw new Error("flattened despite intradayOnly being off");
});

t("zero signals produce zero trades", () => {
  const b = synthBars(200);
  eq(runBrackets(b, new Int8Array(200), flatAtr(200, 10), NOFEE).trades.length, 0);
});

t("tradeStats profit factor and expectancy are self-consistent", () => {
  const b = synthBars(2000);
  const sig = new Int8Array(2000);
  for (let i = 20; i < 2000; i += 17) sig[i] = i % 3 ? 1 : -1;
  const { trades } = runBrackets(b, sig, atr(b.high, b.low, b.close, 14), { ...NOFEE, slAtrMult: 2, tpAtrMult: 3 });
  const s = tradeStats(trades);
  close(s.pnl, trades.reduce((a, x) => a + x.pnl, 0), 1e-6, "total P&L:");
  close(s.expectancy, s.pnl / s.n, 1e-9, "expectancy = pnl/n:");
  close(s.profitFactor, s.grossWin / s.grossLoss, 1e-9, "PF = gross win / gross loss:");
  const wins = trades.filter((x) => x.pnl > 0).length;
  close(s.winRate, (wins / s.n) * 100, 1e-9, "win rate:");
});

// ══════════════════════════════ 4. CHALLENGE RULES ══════════════════════════════
section("4. Combine rules");

const DAY = 86400000;
// Trades on separate days so daily rules don't interfere unless a test wants them.
function tr(pnlList, { sameDay = false, mae = 0 } = {}) {
  const base = Date.UTC(2024, 0, 1, 12);
  return pnlList.map((pnl, i) => ({
    entryTime: base + (sameDay ? i * 3600000 : i * DAY),
    exitTime: base + (sameDay ? i * 3600000 : i * DAY) + 1800000,
    tday: Math.floor((base + (sameDay ? 0 : i * DAY)) / DAY),
    pnl, mae: mae || Math.min(0, pnl), mfe: Math.max(0, pnl),
    dir: 1, contracts: 1, fees: 0, entryPrice: 1, exitPrice: 1, reason: "TP",
    entrySrc: i, exitSrc: i,
  }));
}
const BASE = { profitTarget: 3000, trailingDD: 2000, trailingMode: "intraday",
               dailyLossLimit: 0, dailyProfitStop: 0, circuitBreaker: 0,
               consistencyPct: 100, minTradingDays: 0, windowDays: 30 };
const START = Date.UTC(2024, 0, 1);

t("hand-traced: floor trails the peak, then locks at breakeven", () => {
  // DD = 2000. +800 -> peak 800, floor -1200. +600 -> peak 1400, floor -600.
  // +700 -> peak 2100, which is >= the 2000 limit, so trailing STOPS and the
  // floor freezes at $0 for the rest of the account's life. Note it does not sit
  // at peak-2000 = 100: the lock caps the floor at breakeven, it never rises
  // above it. That is what "locks static at breakeven" means.
  const r = replayWindow(tr([800, 600, 700]), START, BASE);
  const f = r.events.map((e) => e.floor);
  close(f[0], -1200, 1e-9, "after +800:");
  close(f[1], -600, 1e-9, "after +1400:");
  close(f[2], 0, 1e-9, "peak crossed 2000 -> locked at breakeven:");
  eq(r.stats.locked, true);
});

t("once locked, the floor stays at breakeven and never rises with the peak", () => {
  const r = replayWindow(tr([2500, 1000, 1000, 1000]), START, BASE);
  for (const e of r.events) if (e.taken) close(e.floor, 0, 1e-9, "floor after lock:");
});

t("without lockAtBreakeven the floor keeps trailing above zero", () => {
  const r = replayWindow(tr([2500, 1000]), START, { ...BASE, lockAtBreakeven: false });
  const f = r.events.map((e) => e.floor);
  close(f[0], 500, 1e-9, "peak 2500 - 2000:");
  close(f[1], 1500, 1e-9, "peak 3500 - 2000:");
});

t("the floor never moves down", () => {
  const r = replayWindow(tr([900, -400, 700, -300, 1200, -600, 1500]), START, BASE);
  const f = r.events.filter((e) => e.taken).map((e) => e.floor);
  for (let i = 1; i < f.length; i++) {
    if (f[i] < f[i - 1] - 1e-9) throw new Error(`floor fell from ${f[i - 1]} to ${f[i]}`);
  }
});

t("breaching the trailing drawdown FAILS the account", () => {
  // Peak 1500 stays under the 2000 lock threshold, so the floor is trailing at
  // -500. Dropping to -600 goes through it.
  const r = replayWindow(tr([1500, -2100]), START, BASE);
  eq(r.outcome, OUTCOME.FAIL);
  eq(r.failMs !== null, true, "fail timestamp recorded:");
  eq(r.events[r.events.length - 1].breach, true, "breaching event flagged for the chart:");
});

t("surviving exactly ON the floor is a breach (<=, not <)", () => {
  // Peak 1500 -> floor -500. Landing precisely on -500 must fail: prop rules
  // treat touching the threshold as a breach.
  const r = replayWindow(tr([1500, -2000]), START, BASE);
  eq(r.outcome, OUTCOME.FAIL);
});

t("after the lock, going under $0 fails even while nominally up on the day", () => {
  const r = replayWindow(tr([2500, 300, -3000]), START, BASE);  // locks, then -200 total
  eq(r.outcome, OUTCOME.FAIL);
  close(r.stats.finalFloor, 0, 1e-9, "locked floor stays at breakeven:");
});

t("hitting the target PASSES and stops the replay", () => {
  const r = replayWindow(tr([1500, 1600, 5000]), START, BASE);
  eq(r.outcome, OUTCOME.PASS);
  eq(r.stats.trades, 2, "replay must stop the moment it passes:");
  close(r.stats.netPnl, 3100, 1e-9);
});

t("consistency blocks the pass only when configured to gate it", () => {
  // One +3200 day is 100% of profit, over a 50% cap.
  const gated = replayWindow(tr([3200]), START, { ...BASE, consistencyPct: 50, consistencyGatesPass: true });
  eq(gated.outcome, OUTCOME.OPEN, "gating on: must dilute before passing:");
  const ungated = replayWindow(tr([3200]), START, { ...BASE, consistencyPct: 50, consistencyGatesPass: false });
  eq(ungated.outcome, OUTCOME.PASS, "gating off: target alone passes:");
  eq(ungated.stats.consistencyBreached, true, "but the breach is still reported:");
});

t("with gating on, the pass waits until the best day is diluted", () => {
  const r = replayWindow(tr([3200, 1000, 1000, 1000, 1000]), START, { ...BASE, consistencyPct: 50, consistencyGatesPass: true });
  eq(r.outcome, OUTCOME.PASS);
  if (!(r.stats.maxDayPnl <= 0.5 * r.stats.netPnl + 1e-9)) throw new Error("passed while violating the cap");
});

t("the window ends the moment the target is reached (default)", () => {
  // Five winning days; the target falls on the second. Nothing after it counts.
  const r = replayWindow(tr([2000, 1500, 900, 900, 900]), START, BASE);
  eq(r.outcome, OUTCOME.PASS);
  eq(r.stats.trades, 2, "replay stops at the passing trade:");
  close(r.stats.netPnl, 3500, 1e-9, "equity frozen at the pass:");
  eq(r.passMs !== null, true, "pass timestamp recorded for the chart marker:");
  eq(r.events[r.events.length - 1].pass, true, "passing event flagged:");
});

t("pass and breach both end the window symmetrically", () => {
  const passed = replayWindow(tr([2000, 1500, 900, 900]), START, BASE);
  const failed = replayWindow(tr([1500, -2100, 900, 900]), START, BASE);
  eq(passed.stats.trades, 2, "pass stops after the resolving trade:");
  eq(failed.stats.trades, 2, "breach stops after the resolving trade:");
  eq(passed.passMs !== null && failed.failMs !== null, true, "both record a resolution time:");
});

t("daily loss limit is a SOFT lockout — skips trades, never fails", () => {
  const trades = tr([-600, -600, -600, -600], { sameDay: true });
  const r = replayWindow(trades, START, { ...BASE, dailyLossLimit: 1000, trailingDD: 999999 });
  if (r.outcome === OUTCOME.FAIL) throw new Error("a soft daily rule must not fail the account");
  eq(r.stats.trades, 2, "trades 1-2 taken (limit breached after #2), rest skipped:");
  eq(r.stats.skipped, 2);
  eq(r.events.find((e) => !e.taken).skip, "dailyLoss");
});

t("circuit breaker stops the day earlier than the firm's limit", () => {
  const trades = tr([-200, -200, -200], { sameDay: true });
  const r = replayWindow(trades, START, { ...BASE, dailyLossLimit: 1000, circuitBreaker: 150, trailingDD: 999999 });
  eq(r.stats.trades, 1, "one loss trips the -150 breaker:");
  eq(r.events.find((e) => !e.taken).skip, "breaker");
});

t("daily profit stop halts new entries once the day is up enough", () => {
  const trades = tr([1600, 500, 500], { sameDay: true });
  const r = replayWindow(trades, START, { ...BASE, dailyProfitStop: 1500 });
  eq(r.stats.trades, 1, "after +1600 the day is done:");
  eq(r.events.find((e) => !e.taken).skip, "profitStop");
});

t("lockouts reset at the next session", () => {
  const day1 = tr([-600, -600], { sameDay: true });
  const day2 = tr([800]).map((x) => ({ ...x, entryTime: x.entryTime + 2 * DAY, exitTime: x.exitTime + 2 * DAY, tday: x.tday + 2 }));
  const r = replayWindow([...day1, ...day2], START, { ...BASE, dailyLossLimit: 1000, trailingDD: 999999 });
  eq(r.stats.trades, 3, "the next day trades again:");
});

t("EOD trailing is more lenient than intraday trailing", () => {
  // DD 3000 so nothing locks. Same day: spike to +2500, then give back 3200.
  // Intraday ratchets the floor to 2500-3000 = -500, and closing at -700 goes
  // through it. EOD has no completed daily close yet, so its floor is still
  // 0-3000 = -3000 and the same path survives. This is precisely why firms
  // advertising "end-of-day trailing" are easier to pass.
  const trades = tr([2500, -3200], { sameDay: true });
  const intra = replayWindow(trades, START, { ...BASE, trailingDD: 3000, trailingMode: "intraday" });
  const eod = replayWindow(trades, START, { ...BASE, trailingDD: 3000, trailingMode: "eod" });
  eq(intra.outcome, OUTCOME.FAIL, "intraday peak tightens the floor:");
  if (eod.outcome === OUTCOME.FAIL) throw new Error("EOD trailing should not fail on an intraday giveback");
});

t("EOD floor ratchets only after a day actually closes", () => {
  // Day 1 closes at +2500, so day 2's floor becomes 2500-3000 = -500.
  const d1 = tr([2500], { sameDay: true });
  const d2 = tr([-3200]).map((x) => ({ ...x, entryTime: x.entryTime + DAY, exitTime: x.exitTime + DAY, tday: x.tday + 1 }));
  const r = replayWindow([...d1, ...d2], START, { ...BASE, trailingDD: 3000, trailingMode: "eod" });
  eq(r.outcome, OUTCOME.FAIL, "the prior day's close has now tightened the floor:");
});

t("intraday evaluation can breach on MAE even when the trade closes green", () => {
  // Peak 2500 -> floor 500. Next trade closes +100 but dipped -2200 first.
  const trades = tr([2500, 100]);
  trades[1].mae = -2200;
  const realized = replayWindow(trades, START, { ...BASE, evaluateOn: "realized" });
  const intraday = replayWindow(trades, START, { ...BASE, evaluateOn: "intraday" });
  if (realized.outcome === OUTCOME.FAIL) throw new Error("realised mode should not see the excursion");
  eq(intraday.outcome, OUTCOME.FAIL, "open equity dipped below the floor:");
});

t("minTradingDays blocks an otherwise-passing account", () => {
  const one = tr([3500], { sameDay: true });
  eq(replayWindow(one, START, { ...BASE, minTradingDays: 0 }).outcome, OUTCOME.PASS);
  eq(replayWindow(one, START, { ...BASE, minTradingDays: 5 }).outcome, OUTCOME.OPEN);
});

t("window membership is by ENTRY time and respects the window length", () => {
  const trades = tr([500, 500, 500, 500]);            // one per day
  const r = replayWindow(trades, START, { ...BASE, windowDays: 2 });
  eq(r.stats.trades, 2, "only trades entering inside the 2-day window count:");
  const before = tr([9999]).map((x) => ({ ...x, entryTime: START - DAY, exitTime: START + 3600000 }));
  const r2 = replayWindow([...before, ...trades], START, BASE);
  if (r2.events.some((e) => e.t.entryTime < START)) throw new Error("a trade entered before the window start was counted");
});

t("cumulative equity equals the sum of taken trades", () => {
  const trades = tr([300, -200, 450, -150, 600]);
  const r = replayWindow(trades, START, BASE);
  let sum = 0;
  for (const e of r.events) if (e.taken) { sum += e.t.pnl; close(e.cum, sum, 1e-9, "running equity:"); }
  close(r.stats.netPnl, sum, 1e-9, "final:");
});

t("minCushion equals the smallest observed equity-to-floor distance", () => {
  const trades = tr([1500, -900, 800]);
  const r = replayWindow(trades, START, BASE);
  let worst = Infinity;
  for (const e of r.events) if (e.taken) worst = Math.min(worst, e.cum - e.floor);
  close(r.stats.minCushion, worst, 1e-9);
});

t("overlapping trades are detected, because the replay cannot score them", () => {
  const seq = tr([100, 100, 100]);
  eq(hasOverlappingTrades(seq), false, "one-at-a-time trades do not overlap:");
  // Two books merged: the same trades duplicated, so every pair overlaps.
  eq(hasOverlappingTrades([...seq, ...seq]), true, "a pooled list does overlap:");
});

t("splitting one book into copies CHANGES the outcome — the reason pooling is unsafe", () => {
  // Documents the artefact rather than hiding it. Seven $700 losing days at
  // 1 unit versus the same days split into seven 1/7 pieces: the daily rules
  // truncate the split version, which is why a naive pool inflates pass rates.
  const big = tr([-700, -700, -700], { sameDay: true });
  const split = [];
  for (const t2 of big) for (let k = 0; k < 7; k++) split.push({ ...t2, pnl: t2.pnl / 7 });
  split.sort((a, b) => a.entryTime - b.entryTime);

  const R = { ...BASE, circuitBreaker: 150, trailingDD: 999999 };
  const whole = replayWindow(big, START, R);
  const pieces = replayWindow(split, START, R);
  if (Math.abs(whole.stats.netPnl - pieces.stats.netPnl) < 1e-9) {
    throw new Error("expected the split version to diverge — if it no longer does, the note in challenge.mjs is stale");
  }
  eq(hasOverlappingTrades(split), true, "and the split list is detectably overlapping:");
});

t("sweepWindows agrees with replayWindow at every start it reports", () => {
  const trades = tr(Array.from({ length: 60 }, () => (rnd() > 0.45 ? 900 : -700)));
  const end = trades[trades.length - 1].exitTime;
  const sw = sweepWindows(trades, START, end, { ...BASE, windowDays: 10 }, 3);
  for (const w of sw.windows) {
    const direct = replayWindow(trades, w.startMs, { ...BASE, windowDays: 10 });
    eq(w.outcome, direct.outcome, `outcome at ${new Date(w.startMs).toISOString()}:`);
    eq(w.netPnl, Math.round(direct.stats.netPnl), "net:");
    eq(w.trades, direct.stats.trades, "trade count:");
  }
});

t("sweep rates sum to 100%", () => {
  const trades = tr(Array.from({ length: 80 }, () => (rnd() > 0.5 ? 800 : -600)));
  const s = sweepWindows(trades, START, trades[trades.length - 1].exitTime, { ...BASE, windowDays: 10 }, 2).summary;
  close(s.passRate + s.failRate + s.openRate, 100, 1e-9);
});

// ══════════════════════════════ 4b. FUNDED STAGE ══════════════════════════════
section("4b. Funded stage payouts");

const FBASE = { ...BASE, trailingDD: 999999 };   // isolate payout logic from breaches
const FUND = { winDayThreshold: 150, winDaysRequired: 5, profitSplit: 100,
               maxPayout: 0, minBuffer: 0, horizonDays: 180 };

t("a payout unlocks after the required number of winning days", () => {
  const r = simulateFunded(tr([200, 200, 200, 200, 200]), START, FBASE, FUND);
  eq(r.payouts.length, 1, "five qualifying days = one payout:");
  close(r.payouts[0].gross, 1000, 1e-9, "the whole balance is withdrawn:");
});

t("days under the threshold do not count toward a payout", () => {
  // $149 is one dollar short on every day.
  const r = simulateFunded(tr([149, 149, 149, 149, 149]), START, FBASE, FUND);
  eq(r.payouts.length, 0, "no day qualifies:");
  const r2 = simulateFunded(tr([150, 150, 150, 150, 150]), START, FBASE, FUND);
  eq(r2.payouts.length, 1, "exactly at the threshold does qualify:");
});

t("losing days neither count nor reset the tally", () => {
  const r = simulateFunded(tr([200, -100, 200, -100, 200, 200, 200]), START, FBASE, FUND);
  eq(r.payouts.length, 1, "five winning days reached despite losses between:");
});

t("the win-day tally resets after a payout", () => {
  const r = simulateFunded(tr(Array(10).fill(200)), START, FBASE, FUND);
  eq(r.payouts.length, 2, "ten winning days = two payouts:");
});

t("profit split is applied to what the trader receives", () => {
  const r = simulateFunded(tr([200, 200, 200, 200, 200]), START, FBASE, { ...FUND, profitSplit: 90 });
  close(r.payouts[0].gross, 1000, 1e-9, "gross leaves the account:");
  close(r.payouts[0].net, 900, 1e-9, "trader keeps 90%:");
  close(r.netTotal, 900, 1e-9);
});

t("a payout cap limits the withdrawal and leaves the rest in", () => {
  const r = simulateFunded(tr([500, 500, 500, 500, 500]), START, FBASE, { ...FUND, maxPayout: 1000 });
  close(r.payouts[0].gross, 1000, 1e-9, "capped:");
  close(r.finalProfit, 1500, 1e-9, "remainder stays in the account:");
});

t("minBuffer keeps profit in the account", () => {
  const r = simulateFunded(tr([200, 200, 200, 200, 200]), START, FBASE, { ...FUND, minBuffer: 400 });
  close(r.payouts[0].gross, 600, 1e-9, "1000 profit minus a 400 buffer:");
  close(r.finalProfit, 400, 1e-9);
});

t("withdrawing does not put a still-trailing account into breach", () => {
  // Trailing DD $2000, un-locked. Five +200 days -> peak 1000, floor -1000.
  // Withdrawing all 1000 drops the balance to 0; if the floor did not come down
  // with it the account would breach on its own payout.
  const r = simulateFunded(tr([200, 200, 200, 200, 200, 100]), START,
    { ...BASE, trailingDD: 2000, lockAtBreakeven: false }, FUND);
  eq(r.payouts.length, 1);
  eq(r.blownMs, null, "must not be blown by its own withdrawal:");
});

t("the trailing drawdown still kills a funded account", () => {
  const r = simulateFunded(tr([1500, -2100, 500]), START, { ...BASE, trailingDD: 2000 }, FUND);
  eq(r.survived, false, "breach ends the run:");
  eq(r.payouts.length, 0);
});

t("the horizon bounds the run", () => {
  const long = Array(60).fill(200);          // one winning day each
  const short = simulateFunded(tr(long), START, FBASE, { ...FUND, horizonDays: 20 });
  const full = simulateFunded(tr(long), START, FBASE, { ...FUND, horizonDays: 60 });
  if (!(short.payouts.length < full.payouts.length)) throw new Error("horizon had no effect");
});

t("sweepFunded aggregates runs consistently", () => {
  const trades = tr(Array.from({ length: 200 }, () => (rnd() > 0.4 ? 400 : -250)));
  const end = trades[trades.length - 1].exitTime;
  const sw = sweepFunded(trades, START, end, FBASE, { ...FUND, horizonDays: 30 }, 5);
  if (!sw.runs.length) throw new Error("no runs produced");
  const direct = simulateFunded(trades, sw.runs[0].startMs, FBASE, { ...FUND, horizonDays: 30 });
  eq(sw.runs[0].payouts.length, direct.payouts.length, "run 0 matches a direct call:");
  close(sw.summary.meanTotalPaid, sw.runs.reduce((a, r) => a + r.netTotal, 0) / sw.runs.length, 1e-9);
  const paid = sw.runs.filter((r) => r.payouts.length).length;
  close(sw.summary.reachedPayout, (paid / sw.runs.length) * 100, 1e-9);
});

// ══════════════════════════════ 4c. SIGNAL FILTERS ══════════════════════════════
section("4c. Signal filters");

t("a filter with nothing set changes nothing", () => {
  const b = synthBars(3000);
  const ctx = buildFilterContext(b);
  const sig = new Int8Array(3000);
  for (let i = 0; i < 3000; i += 3) sig[i] = i % 2 ? 1 : -1;
  arrClose(applyFilters(sig, ctx, {}), sig, 0);
});

t("session window keeps only bars inside it", () => {
  const b = synthBars(3000);
  const ctx = buildFilterContext(b);
  const sig = new Int8Array(3000).fill(1);
  const out = applyFilters(sig, ctx, { startCt: 500, endCt: 700 });
  for (let i = 0; i < 3000; i++) {
    const inside = b.ctMin[i] >= 500 && b.ctMin[i] < 700;
    eq(out[i] !== 0, inside, `bar ${i} (ct ${b.ctMin[i]}):`);
  }
});

t("a session window that wraps past midnight works", () => {
  const b = synthBars(3000);
  const ctx = buildFilterContext(b);
  const sig = new Int8Array(3000).fill(1);
  const out = applyFilters(sig, ctx, { startCt: 1380, endCt: 120 });   // 23:00 -> 02:00
  for (let i = 0; i < 3000; i++) {
    const inside = b.ctMin[i] >= 1380 || b.ctMin[i] < 120;
    eq(out[i] !== 0, inside, `bar ${i} (ct ${b.ctMin[i]}):`);
  }
});

t("regime bands gate on the indicator value", () => {
  const b = synthBars(4000);
  const ctx = buildFilterContext(b);
  const sig = new Int8Array(4000).fill(1);
  const out = applyFilters(sig, ctx, { adxMin: 25 });
  let kept = 0;
  for (let i = 0; i < 4000; i++) {
    if (out[i]) { kept++; if (!(ctx.adx[i] >= 25)) throw new Error(`kept bar ${i} with adx ${ctx.adx[i]}`); }
  }
  if (kept === 0) throw new Error("gate removed everything");
});

t("an unwarmed indicator FAILS an active band rather than passing", () => {
  // The first bars have no efficiency-ratio reading. They must be excluded, not
  // waved through — a NaN silently passing a filter is a classic way to leak
  // untradeable bars into a backtest.
  const b = synthBars(500);
  const ctx = buildFilterContext(b);
  const sig = new Int8Array(500).fill(1);
  const out = applyFilters(sig, ctx, { effMin: 0.1 });
  for (let i = 0; i < 500; i++) {
    if (!Number.isFinite(ctx.eff[i]) && out[i] !== 0) throw new Error(`bar ${i} passed on a NaN reading`);
  }
});

t("filters compose — each one only ever removes signals", () => {
  const b = synthBars(4000);
  const ctx = buildFilterContext(b);
  const sig = new Int8Array(4000).fill(1);
  const a1 = applyFilters(sig, ctx, { adxMin: 20 });
  const a2 = applyFilters(sig, ctx, { adxMin: 20, startCt: 400, endCt: 900 });
  for (let i = 0; i < 4000; i++) {
    if (a2[i] !== 0 && a1[i] === 0) throw new Error(`adding a filter ADDED signal at ${i}`);
  }
  eq(countSurviving(sig, ctx, { adxMin: 20 }) >= countSurviving(sig, ctx, { adxMin: 20, startCt: 400, endCt: 900 }), true);
});

t("efficiency ratio is bounded 0..1 and 1 on a straight line", () => {
  const up = new Float64Array(200);
  for (let i = 0; i < 200; i++) up[i] = 100 + i;      // perfectly linear
  const e = efficiencyRatio(up, 20);
  close(e[100], 1, 1e-9, "straight line:");
  for (const v of efficiencyRatio(synthBars(1000).close, 20)) {
    if (Number.isFinite(v) && (v < -1e-9 || v > 1 + 1e-9)) throw new Error(`out of range: ${v}`);
  }
});

// ══════════════════════════════ 5. WIRE FORMAT ══════════════════════════════
section("5. Binary wire format");

t("packBars round-trips through the browser parser byte-for-byte", () => {
  const b = synthBars(500);
  const buf = packBars(b, 100, 400);
  // Mirror of parseWindowBlob() in public/app.js.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const dv = new DataView(ab);
  eq(String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)), "MNQW");
  const cnt = dv.getUint32(8, true);
  eq(cnt, 300, "bar count:");
  eq(dv.getUint32(12, true), 100, "start index:");
  let off = 16;
  const f64 = (c) => { const a = new Float64Array(ab, off, c); off += c * 8; return a; };
  const f32 = (c) => { const a = new Float32Array(ab, off, c); off += c * 4; return a; };
  const i32 = (c) => { const a = new Int32Array(ab, off, c); off += c * 4; return a; };
  const i16 = (c) => { const a = new Int16Array(ab, off, c); off += c * 2; return a; };
  const ts = f64(cnt), o = f32(cnt), h = f32(cnt), l = f32(cnt), c2 = f32(cnt), v = f32(cnt), td = i32(cnt), ct = i16(cnt);
  for (let i = 0; i < cnt; i++) {
    eq(ts[i], b.ts[100 + i], `ts[${i}]:`);
    eq(o[i], b.open[100 + i], `open[${i}]:`);
    eq(h[i], b.high[100 + i], `high[${i}]:`);
    eq(l[i], b.low[100 + i], `low[${i}]:`);
    eq(c2[i], b.close[100 + i], `close[${i}]:`);
    eq(v[i], b.volume[100 + i], `vol[${i}]:`);
    eq(td[i], b.tday[100 + i], `tday[${i}]:`);
    eq(ct[i], b.ctMin[100 + i], `ctMin[${i}]:`);
  }
  eq(off, buf.length, "no trailing bytes:");
});

// ══════════════════════════════ 6. REAL DATA ══════════════════════════════
section("6. Real cached data vs the original CSV");

let bars_ = null;
try { bars_ = loadBars(); } catch (e) { console.log(`  (skipped: ${e.message})`); }

if (bars_) {
  const { bars: B, meta } = bars_;

  t("cache is sorted, gap-free in ordering, and covers the stated range", () => {
    for (let i = 1; i < B.count; i++) if (B.ts[i] <= B.ts[i - 1]) throw new Error(`ts not increasing at ${i}`);
    eq(B.ts[0], meta.startMs, "start:");
    eq(B.ts[B.count - 1], meta.endMs, "end:");
    eq(B.count, meta.bars, "bar count:");
  });

  t("every bar satisfies low <= open,close <= high", () => {
    for (let i = 0; i < B.count; i++) {
      if (!(B.low[i] <= B.open[i] && B.open[i] <= B.high[i])) throw new Error(`open outside range at ${i}`);
      if (!(B.low[i] <= B.close[i] && B.close[i] <= B.high[i])) throw new Error(`close outside range at ${i}`);
    }
  });

  t("trading-day index is monotone and rolls at the 17:00 ET session boundary", () => {
    for (let i = 1; i < B.count; i++) if (B.tday[i] < B.tday[i - 1]) throw new Error(`tday went backwards at ${i}`);

    // CME halts 17:00-18:00 ET every weekday, so NO bar exists at 17:00 itself.
    // The correct invariant is that the last bar of a session is before 17:00 ET
    // and the first bar of the next is at or after it (in practice 18:00).
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit" });
    const H = (ms) => Number(fmt.format(new Date(ms)).replace("24", "0"));
    let checked = 0;
    const hist = new Map();
    for (let i = 1; i < B.count && checked < 600; i++) {
      if (B.tday[i] === B.tday[i - 1]) continue;
      checked++;
      const hNew = H(B.ts[i]), hPrev = H(B.ts[i - 1]);
      hist.set(hNew, (hist.get(hNew) || 0) + 1);
      if (hPrev >= 17) throw new Error(`bar before the boundary is ${hPrev}:00 ET — should be the prior session`);
      if (hNew < 17) throw new Error(`bar after the boundary is ${hNew}:00 ET — should be the new session`);
    }
    if (checked < 100) throw new Error(`only ${checked} boundaries checked`);
    console.log(`         (${checked} boundaries; first-bar-of-session ET hours: ${[...hist.entries()].map(([h, c]) => `${h}:00 x${c}`).join(", ")})`);
  });

  t("DST is handled: the boundary holds in both EST and EDT", () => {
    // A fixed UTC offset would drift by an hour across the March/November
    // changeovers. Sample boundaries from midsummer and midwinter separately.
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", month: "2-digit" });
    let summer = 0, winter = 0;
    for (let i = 1; i < B.count; i += 7) {
      if (B.tday[i] === B.tday[i - 1]) continue;
      const parts = fmt.formatToParts(new Date(B.ts[i]));
      const mo = Number(parts.find((p) => p.type === "month").value);
      const h = Number(parts.find((p) => p.type === "hour").value.replace("24", "0"));
      if (h < 17) throw new Error(`boundary at ${new Date(B.ts[i]).toISOString()} landed at ${h}:00 ET`);
      if (mo >= 6 && mo <= 8) summer++;
      if (mo === 12 || mo <= 2) winter++;
    }
    if (summer < 5 || winter < 5) throw new Error(`insufficient coverage (summer ${summer}, winter ${winter})`);
    console.log(`         (${summer} EDT and ${winter} EST boundaries all landed correctly)`);
  });

  t("final contract piece matches the raw CSV exactly (unadjusted)", () => {
    // Prices after the last roll get zero cumulative adjustment, so they must be
    // byte-identical to the source. This validates the whole parse+pack path.
    const CSV = meta.source;
    if (!fs.existsSync(CSV)) throw new Error(`source CSV missing: ${CSV}`);
    const lastRoll = meta.rollovers[meta.rollovers.length - 1];
    const wantSym = lastRoll.to;
    const raw = new Map();
    const buf = fs.readFileSync(CSV);
    let p = buf.indexOf(10) + 1;
    while (p < buf.length) {
      let nl = buf.indexOf(10, p);
      if (nl < 0) nl = buf.length;
      let f = 0, s = p, tsS = 0, tsE = 0, oS = 0, oE = 0, cS = 0, cE = 0, yS = 0, yE = 0;
      for (let i = p; i <= nl; i++) {
        if (i === nl || buf[i] === 44) {
          if (f === 0) { tsS = s; tsE = i; } else if (f === 4) { oS = s; oE = i; }
          else if (f === 7) { cS = s; cE = i; } else if (f === 9) { yS = s; yE = i; }
          f++; s = i + 1;
        }
      }
      p = nl + 1;
      if (f < 10) continue;
      if (buf.toString("latin1", yS, yE).trim() !== wantSym) continue;
      raw.set(Date.parse(buf.toString("latin1", tsS, tsE)), {
        o: parseFloat(buf.toString("latin1", oS, oE)),
        c: parseFloat(buf.toString("latin1", cS, cE)),
      });
    }
    if (raw.size < 1000) throw new Error(`only ${raw.size} raw rows found for ${wantSym}`);
    let checked = 0, mismatch = 0;
    for (let i = B.count - 1; i >= 0 && checked < 20000; i--) {
      const r = raw.get(B.ts[i]);
      if (!r) continue;
      checked++;
      if (Math.abs(B.close[i] - r.c) > 1e-6 || Math.abs(B.open[i] - r.o) > 1e-6) {
        mismatch++;
        if (mismatch < 4) console.log(`         ${new Date(B.ts[i]).toISOString()}: cache O${B.open[i]}/C${B.close[i]} vs csv O${r.o}/C${r.c}`);
      }
    }
    if (checked < 1000) throw new Error(`only ${checked} bars cross-checked`);
    if (mismatch) throw new Error(`${mismatch}/${checked} bars differ from the CSV`);
    console.log(`         (${checked.toLocaleString()} bars of ${wantSym} matched the CSV exactly)`);
  });

  t("adjustment preserved every price DIFFERENCE inside a contract piece", () => {
    // Additive shifts cancel in a difference. Verify on the second piece, whose
    // prices are shifted, that consecutive deltas still equal the raw deltas.
    const r0 = meta.rollovers[0], r1 = meta.rollovers[1];
    const i0 = indexAtOrAfter(B.ts, r0.ms), i1 = indexAtOrAfter(B.ts, r1.ms);
    if (i1 - i0 < 100) throw new Error("piece too short to test");
    let maxOffGrid = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const d = B.close[i] - B.close[i - 1];
      const q = d * 4;
      maxOffGrid = Math.max(maxOffGrid, Math.abs(q - Math.round(q)));
    }
    if (maxOffGrid > 1e-2) throw new Error(`differences drifted off the tick grid by ${maxOffGrid}`);
  });

  t("no unexplained discontinuity at any rollover", () => {
    for (const r of meta.rollovers) {
      const i = indexAtOrAfter(B.ts, r.ms);
      if (i <= 0 || i >= B.count) continue;
      const elapsedMin = (B.ts[i] - B.ts[i - 1]) / 60000;
      const seam = Math.abs(B.close[i] - B.close[i - 1]);
      if (elapsedMin <= 5 && seam > 30) {
        throw new Error(`${new Date(r.ms).toISOString()}: ${seam.toFixed(2)}pt jump across ${elapsedMin} minute(s)`);
      }
    }
  });

  t("Chicago minute-of-day is correct, including across DST", () => {
    // Verified against Intl on a sample, and specifically around both changeover
    // weekends where a fixed UTC offset would be an hour out.
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour12: false, hour: "2-digit", minute: "2-digit" });
    const ctOf = (ms) => {
      const p = fmt.formatToParts(new Date(ms));
      const h = Number(p.find((x) => x.type === "hour").value.replace("24", "0"));
      return h * 60 + Number(p.find((x) => x.type === "minute").value);
    };
    let checked = 0;
    for (let i = 0; i < B.count; i += 4001) {
      eq(B.ctMin[i], ctOf(B.ts[i]), `bar ${i} (${new Date(B.ts[i]).toISOString()}):`);
      checked++;
    }
    // DST changeovers specifically.
    for (const [y, mo, d] of [[2024, 2, 10], [2024, 10, 3], [2025, 2, 9], [2025, 10, 2]]) {
      const target = Date.UTC(y, mo, d, 12);
      const i = indexAtOrAfter(B.ts, target);
      if (i >= B.count) continue;
      eq(B.ctMin[i], ctOf(B.ts[i]), `DST boundary ${y}-${mo + 1}-${d}:`);
      checked++;
    }
    if (checked < 100) throw new Error(`only ${checked} samples checked`);
  });

  t("the 3:05 PM CT deadline sits inside a live session", () => {
    // The rule is only meaningful if bars actually exist at that time; the CME
    // halt runs 16:00-17:00 CT, so 15:05 must be tradeable.
    let atDeadline = 0, inHalt = 0;
    for (let i = 0; i < B.count; i += 97) {
      if (B.ctMin[i] === 15 * 60 + 5) atDeadline++;
      if (B.ctMin[i] >= 16 * 60 && B.ctMin[i] < 17 * 60) inHalt++;
    }
    if (atDeadline < 5) throw new Error(`only ${atDeadline} sampled bars at 15:05 CT`);
    if (inHalt > 0) throw new Error(`${inHalt} sampled bars fall inside the 16:00-17:00 CT halt`);
  });

  t("no duplicate timestamps across 1.77M bars", () => {
    let dupes = 0;
    for (let i = 1; i < B.count; i++) if (B.ts[i] === B.ts[i - 1]) dupes++;
    eq(dupes, 0);
  });

  t("resampling real data conserves total volume", () => {
    const s = 500000, e = 560000;
    const slice = sliceBars(B, s, e);
    const r5 = resample(slice, 5);
    let a = 0, b = 0;
    for (let i = 0; i < slice.volume.length; i++) a += slice.volume[i];
    for (let i = 0; i < r5.volume.length; i++) b += r5.volume[i];
    close(b, a, Math.max(1, a * 1e-6), "volume must be conserved:");
  });

  t("resampling real data conserves the true high and low", () => {
    const slice = sliceBars(B, 800000, 860000);
    for (const tf of [3, 5, 15, 60]) {
      const r = resample(slice, tf);
      let hiA = -Infinity, loA = Infinity, hiB = -Infinity, loB = Infinity;
      for (let i = 0; i < slice.high.length; i++) { hiA = Math.max(hiA, slice.high[i]); loA = Math.min(loA, slice.low[i]); }
      for (let i = 0; i < r.high.length; i++) { hiB = Math.max(hiB, r.high[i]); loB = Math.min(loB, r.low[i]); }
      close(hiB, hiA, 1e-4, `tf=${tf} high:`);
      close(loB, loA, 1e-4, `tf=${tf} low:`);
    }
  });
}

// ══════════════════════════════ RESULT ══════════════════════════════
console.log(`\n${"=".repeat(64)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:"); for (const f of failures) console.log("  - " + f); }
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
