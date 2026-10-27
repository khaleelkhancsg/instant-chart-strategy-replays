// Correctness test suite.  node test.mjs
//
// Philosophy: an optimised implementation is tested against a naive one that is
// obviously correct, and rule logic is tested against hand-traced numbers worked
// out on paper. Passing a test written from the same misunderstanding as the code
// proves nothing, so the references here are deliberately independent.

import fs from "node:fs";
import { ema, sma, wma, atr, adx, rsi, donchian, rollingMeanStd, trueRange, efficiencyRatio } from "./src/indicators.mjs";
import { buildFilterContext, applyFilters, countSurviving } from "./src/filters.mjs";
import { replayPortfolio } from "./src/portfolio.mjs";
import { resample, sliceBars, indexAtOrAfter, indexAtOrBefore } from "./src/resample.mjs";
import { runBrackets, tradeStats, EXIT, resolveExec, LEGACY_EXEC } from "./src/engine.mjs";
import { replayWindow, sweepWindows, simulateFunded, sweepFunded, hasOverlappingTrades, OUTCOME, resolveRules } from "./src/challenge.mjs";
import { loadBars, packBars } from "./src/data.mjs";
import { loadStrategies } from "./src/registry.mjs";
import { runStrategy, resolveParams } from "./src/run.mjs";
import { windowSpan } from "./src/window.mjs";
import { NO_FILTER } from "./src/filters.mjs";
import { flatten, fastWindow } from "./src/search.mjs";
import { evalDays } from "./src/dayeval.mjs";

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

// Deterministic PRNG so failures reproduce. FUZZ_SEED picks another sequence and
// FUZZ_SCALE multiplies the fuzz sections' case counts, for longer bug hunts:
//   FUZZ_SEED=7 FUZZ_SCALE=5 node test.mjs
let seed = Number(process.env.FUZZ_SEED) || 12345;
const SCALE = Math.max(1, Number(process.env.FUZZ_SCALE) || 1);
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

t("wma matches a brute-force weighted window", () => {
  const x = Array.from({ length: 60 }, () => rnd() * 100);
  const p = 7, div = (p * (p + 1)) / 2;
  const out = wma(x, p);
  for (let i = p - 1; i < x.length; i++) {
    // Newest bar carries weight p, oldest weight 1.
    let num = 0;
    for (let j = 0; j < p; j++) num += (p - j) * x[i - j];
    close(out[i], num / div, 1e-9, `i=${i}`);
  }
  if (!Number.isNaN(out[p - 2])) throw new Error("expected NaN before the window fills");
});

t("wma weights the newest bar hardest", () => {
  // A step from 0 to 1 must be picked up faster than a plain mean does.
  const x = new Array(40).fill(0); for (let i = 20; i < 40; i++) x[i] = 1;
  const w = wma(x, 10), m = sma(x, 10);
  for (let i = 20; i < 29; i++) {
    if (!(w[i] > m[i])) throw new Error(`wma should lead sma at i=${i}: ${w[i]} vs ${m[i]}`);
  }
  close(w[39], 1, 1e-12, "fully inside the step:");
});

t("ema seeds past a NaN prefix instead of returning an all-NaN series", () => {
  // ema() used to seed from arr[0] unconditionally, so any indicator with a
  // warm-up prefix produced nothing at all when smoothed. That is exactly what
  // an SMA oscillator feeding an EMA signal line does.
  const x = [NaN, NaN, 5, 5, 5, 5, 5, 5, 5, 5];
  const out = ema(x, 4);
  if (!Number.isNaN(out[0]) || !Number.isNaN(out[1])) throw new Error("prefix should stay NaN");
  close(out[2], 5, 1e-12, "seeds from the first finite value:");
  close(out[9], 5, 1e-12, "and converges normally after:");
  // A clean series must be untouched by the change.
  const clean = Array.from({ length: 40 }, () => rnd() * 10);
  const e = ema(clean, 6);
  let p = clean[0];
  for (let i = 1; i < clean.length; i++) { p = (2 / 7) * clean[i] + (5 / 7) * p; close(e[i], p, 1e-12, `i=${i}`); }
});

t("sma and wma resume after a NaN instead of being poisoned by it", () => {
  // The running accumulators used to add every element blindly, so one NaN
  // wrecked the whole remaining series — which made MA-over-MA all-NaN.
  const x = [1, 2, 3, NaN, 4, 5, 6, 7, 8, 9];
  for (const f of [sma, wma]) {
    const out = f(x, 3);
    if (!Number.isNaN(out[4]) || !Number.isNaN(out[5])) throw new Error("should still be warming up");
    if (!Number.isFinite(out[6])) throw new Error(`${f.name} never recovered after the NaN`);
  }
  close(sma(x, 3)[6], (4 + 5 + 6) / 3, 1e-12, "sma after the gap:");
  close(wma(x, 3)[6], (1 * 4 + 2 * 5 + 3 * 6) / 6, 1e-12, "wma after the gap:");
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
  // The stop fills on bar 2. Off, the next entry waits for bar 3; on, it is taken
  // on bar 2 itself. (This used to check on.length > off.length, which only held
  // because the engine also booked a phantom dir-0 trade on that bar.)
  eq(off.some((t2) => t2.entryIdx === 2), false, "off: nothing enters on the exit bar:");
  eq(on.some((t2) => t2.entryIdx === 2), true, "opting in allows the same-bar entry:");
  eq(on.every((t2) => t2.dir !== 0) && off.every((t2) => t2.dir !== 0), true, "no phantom trade with no direction:");
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

t("a hard unrealised day cap closes the position AT the threshold", () => {
  // Long from 100 at 1 lot, $2/pt, ATR 10. Bracket target is 5xATR = +50 (price
  // 150). The $50 cap is reached at +25 points (price 125), which is NEARER, so
  // the platform stop fires first and the day lands exactly on $50.
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 100, 100], [100, 200, 99, 200]]);
  const sig = new Int8Array(4); sig[1] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(4, 10), {
    ...NOFEE, contracts: 1, slAtrMult: 5, tpAtrMult: 5, dayProfitStopUsd: 50,
  });
  eq(trades[0].reason, EXIT.DAYCAP, "exit reason:");
  close(trades[0].exitPrice, 125, 1e-6, "exit exactly where day P&L hits $50:");
  close(trades[0].pnl, 50, 1e-6, "day capped AT the threshold, not past it:");
});

t("a hard day-LOSS stop caps the stop distance in dollars", () => {
  // 5xATR = 50 points at ATR 10, so a $30 cap must bite first and land the exit
  // exactly where realised+open P&L reaches -$30, not at the 5xATR stop.
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 100, 100], [100, 101, 60, 60]]);
  const sig = new Int8Array(4); sig[1] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(4, 10), {
    ...NOFEE, contracts: 1, slAtrMult: 5, tpAtrMult: 50, dayLossStopUsd: 30,
  });
  eq(trades[0].reason, EXIT.DAYLOSS, "exit reason:");
  close(trades[0].exitPrice, 85, 1e-6, "exit exactly where day P&L hits -$30:");
  close(trades[0].pnl, -30, 1e-6, "loss capped AT the threshold:");
});

t("the day-loss stop does nothing when the bracket stop is nearer", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 100, 100], [100, 101, 40, 40]]);
  const sig = new Int8Array(4); sig[1] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(4, 10), {
    ...NOFEE, contracts: 1, slAtrMult: 5, tpAtrMult: 50, dayLossStopUsd: 500,
  });
  eq(trades[0].reason, EXIT.SL, "a $500 cap is far away, so the 5xATR stop fires:");
  close(trades[0].exitPrice, 50, 1e-6);
});

t("the day-loss stop nets off profit already banked that session", () => {
  // Win +$20 first (10 points at $2/point); the remaining allowance is then
  // 30 + 20 = $50 of open loss, i.e. 25 points below the 120 entry.
  const b = bars([
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 130, 99, 130],   // +$20 at tp 110
    [120, 121, 119, 120], [120, 121, 119, 120], [120, 121, 40, 40],
  ]);
  const sig = new Int8Array(6); sig[1] = 1; sig[3] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(6, 10), {
    ...NOFEE, contracts: 1, slAtrMult: 5, tpAtrMult: 1, dayLossStopUsd: 30,
  });
  eq(trades.length, 2, "two trades:");
  close(trades[0].pnl, 20, 1e-6, "first banks +$20:");
  eq(trades[1].reason, EXIT.DAYLOSS, "second is cut by the cap:");
  close(trades[1].pnl, -50, 1e-6, "allowed to lose the banked $20 plus the $30 cap:");
});

t("no further entries once the day-loss stop fires, and it resets next session", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push([100, 101, 40, 40]);      // every bar can cap out
  const b = bars(rows);
  for (let i = 20; i < 40; i++) b.tday[i] += 1;
  const sig = new Int8Array(40).fill(1);
  const { trades } = runBrackets(b, sig, flatAtr(40, 10), {
    ...NOFEE, contracts: 1, slAtrMult: 5, tpAtrMult: 50, dayLossStopUsd: 30,
  });
  const day0 = trades.filter((t2) => b.tday[t2.entryIdx] === b.tday[0]);
  const day1 = trades.filter((t2) => b.tday[t2.entryIdx] !== b.tday[0]);
  eq(day0.length, 1, "one trade caps day one:");
  eq(day1.length, 1, "and the next session trades again:");
});

t("scale-in is OFF by default and changes nothing", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 100, 100], [100, 130, 99, 130]]);
  const sig = new Int8Array(4); sig[1] = 1;
  const cfg = { ...NOFEE, contracts: 8, slAtrMult: 5, tpAtrMult: 2 };
  const a = runBrackets(b, sig, flatAtr(4, 10), cfg).trades[0];
  const c = runBrackets(b, sig, flatAtr(4, 10), { ...cfg, scaleInFrac: 0 }).trades[0];
  eq(a.contracts, 8, "full size:");
  close(a.pnl, c.pnl, 1e-9, "identical P&L:");
});

t("scale-in starts at a fraction and adds on favourable movement", () => {
  // ATR 10, trigger 0.5xATR = 5 points above the 100 entry. Bar 3 reaches 130.
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 100, 100], [100, 130, 99, 130]]);
  const sig = new Int8Array(4); sig[1] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(4, 10), {
    ...NOFEE, contracts: 8, slAtrMult: 5, tpAtrMult: 2,
    scaleInFrac: 0.5, scaleInTrigger: 0.5, scaleInWindowBars: 10,
  });
  eq(trades[0].contracts, 8, "ends at full size after the add:");
  // 4 lots at 100, 4 at 105 -> average 102.5; target 2xATR = 20 above the SIGNAL
  // entry of 100, so it exits at 120 for (120-102.5)*2*8 = $280.
  close(trades[0].pnl, 280, 1e-6, "P&L uses the weighted average entry:");
});

t("scale-in stays small when the trigger is never reached", () => {
  const rows = [[100, 101, 99, 100], [100, 101, 99, 100]];
  for (let i = 0; i < 30; i++) rows.push([100, 100.5, 99.5, 100]);   // never moves
  rows.push([100, 101, 40, 40]);                                     // then stops out
  const b = bars(rows);
  const sig = new Int8Array(rows.length); sig[1] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(rows.length, 10), {
    ...NOFEE, contracts: 8, slAtrMult: 5, tpAtrMult: 2,
    scaleInFrac: 0.5, scaleInTrigger: 0.5, scaleInWindowBars: 10,
  });
  eq(trades[0].contracts, 4, "never added, so the loss is taken at HALF size:");
  close(trades[0].pnl, (50 - 100) * 2 * 4, 1e-6, "loss is half what full size would cost:");
});

t("scale-in charges slippage on BOTH tranches", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 100, 100], [100, 130, 99, 130]]);
  const sig = new Int8Array(4); sig[1] = 1;
  const cfg = { ...NOFEE, contracts: 8, slAtrMult: 5, tpAtrMult: 2,
                scaleInFrac: 0.5, scaleInTrigger: 0.5, scaleInWindowBars: 10 };
  const clean = runBrackets(b, sig, flatAtr(4, 10), cfg).trades[0];
  const slipped = runBrackets(b, sig, flatAtr(4, 10), { ...cfg, slippageTicks: 1 }).trades[0];
  // 1 tick on each of two entry tranches and one exit = 3 tick-legs of 0.25 at
  // $2/point on 8 lots, but the entry legs are on 4 lots each: 2*(0.25*2*4) plus
  // the exit 0.25*2*8 = $4 + $4 = ... expressed as the difference in P&L.
  const expected = (0.25 * 2 * 4) + (0.25 * 2 * 4) + (0.25 * 2 * 8);
  close(clean.pnl - slipped.pnl, expected, 1e-6,
        "both entry tranches and the exit each pay slippage:");
});

t("scaleInOrder 'after' refuses the add on a bar that also stops out", () => {
  // Bar 3 spans from 40 (through the stop at 50) up to 130 (through the add at
  // 105). 'before' adds then stops; 'after' assumes the stop printed first.
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 100, 100], [100, 130, 40, 60]]);
  const sig = new Int8Array(4); sig[1] = 1;
  const cfg = { ...NOFEE, contracts: 8, slAtrMult: 5, tpAtrMult: 20,
                scaleInFrac: 0.5, scaleInTrigger: 0.5, scaleInWindowBars: 10 };
  const before = runBrackets(b, sig, flatAtr(4, 10), { ...cfg, scaleInOrder: "before" }).trades[0];
  const after = runBrackets(b, sig, flatAtr(4, 10), { ...cfg, scaleInOrder: "after" }).trades[0];
  eq(before.contracts, 8, "'before' adds then stops out at full size:");
  eq(after.contracts, 4, "'after' stops out at half size:");
  eq(after.pnl > before.pnl, true,
     `pessimistic ordering loses less here (${after.pnl.toFixed(0)} vs ${before.pnl.toFixed(0)}):`);
});

t("dayLossStopMode 'exact' caps the day AT the threshold even through a gap", () => {
  // Bar 3 opens at 40, far below the -$30 cap price of 85. Under 'price' the fill
  // is the open and the day loses far more than the cap; under 'exact' a
  // continuously-tracked platform liquidation lands the day on exactly -$30.
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 100, 100], [40, 41, 39, 40]]);
  const sig = new Int8Array(4); sig[1] = 1;
  const cfg = { ...NOFEE, contracts: 1, slAtrMult: 5, tpAtrMult: 50, dayLossStopUsd: 30 };
  const priced = runBrackets(b, sig, flatAtr(4, 10), cfg).trades[0];
  const exact = runBrackets(b, sig, flatAtr(4, 10), { ...cfg, dayLossStopMode: "exact" }).trades[0];
  eq(priced.reason, EXIT.DAYLOSS, "price mode still labels it a day-loss exit:");
  eq(priced.pnl < -30, true, `price mode gaps through (${priced.pnl.toFixed(2)} vs -30):`);
  eq(exact.reason, EXIT.DAYLOSS, "exact mode labels it a day-loss exit:");
  close(exact.pnl, -30, 1e-9, "exact mode lands the day ON the cap:");
});

t("dayLossStopMode 'exact' still nets off profit already banked that session", () => {
  const b = bars([
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 130, 99, 130],
    [120, 121, 119, 120], [120, 121, 119, 120], [40, 41, 39, 40],
  ]);
  const sig = new Int8Array(6); sig[1] = 1; sig[3] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(6, 10), {
    ...NOFEE, contracts: 1, slAtrMult: 5, tpAtrMult: 1, dayLossStopUsd: 30, dayLossStopMode: "exact",
  });
  eq(trades.length, 2, "two trades:");
  close(trades[0].pnl, 20, 1e-9, "first banks +$20:");
  close(trades[1].pnl, -50, 1e-9, "second loses the banked $20 plus the $30 cap:");
  close(trades[0].pnl + trades[1].pnl, -30, 1e-9, "day lands exactly on the cap:");
});

t("the day-loss stop is OFF by default and changes nothing at 0", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 100, 100], [100, 101, 40, 40]]);
  const sig = new Int8Array(4); sig[1] = 1;
  const cfg = { ...NOFEE, contracts: 1, slAtrMult: 5, tpAtrMult: 50 };
  const a = runBrackets(b, sig, flatAtr(4, 10), cfg).trades[0];
  const c = runBrackets(b, sig, flatAtr(4, 10), { ...cfg, dayLossStopUsd: 0 }).trades[0];
  eq(a.reason, c.reason, "same exit reason:");
  close(a.pnl, c.pnl, 1e-9, "same P&L:");
  eq(a.reason, EXIT.SL, "and it is the plain 5xATR stop:");
});

t("the bracket target still wins when it is nearer than the cap", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 100, 100], [100, 140, 99, 140]]);
  const sig = new Int8Array(4); sig[1] = 1;
  const { trades } = runBrackets(b, sig, flatAtr(4, 10), {
    ...NOFEE, contracts: 1, slAtrMult: 5, tpAtrMult: 1, dayProfitStopUsd: 500,
  });
  eq(trades[0].reason, EXIT.TP, "a $500 cap is far away, so the target fires:");
  close(trades[0].exitPrice, 110, 1e-6);
});

t("no further entries once the day cap is hit, and it resets next session", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push([100, 140, 99, 140]);   // every bar can hit a cap
  const b = bars(rows);
  for (let i = 20; i < 40; i++) b.tday[i] += 1;                  // second session
  const sig = new Int8Array(40).fill(1);
  const { trades } = runBrackets(b, sig, flatAtr(40, 10), {
    ...NOFEE, contracts: 1, slAtrMult: 5, tpAtrMult: 50, dayProfitStopUsd: 50,
  });
  const day0 = trades.filter((t2) => b.tday[t2.entryIdx] === b.tday[0]);
  const day1 = trades.filter((t2) => b.tday[t2.entryIdx] !== b.tday[0]);
  eq(day0.length, 1, "one trade caps day one:");
  eq(day1.length >= 1, true, "and trading resumes the next session:");
});

t("the cap scales with contracts — it is an absolute dollar amount", () => {
  const mk = (q) => {
    const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 100, 100], [100, 300, 99, 300]]);
    const sig = new Int8Array(4); sig[1] = 1;
    // Bracket target at 20xATR = +200 so the cap is always the nearer level.
    return runBrackets(b, sig, flatAtr(4, 10), { ...NOFEE, contracts: q, slAtrMult: 5, tpAtrMult: 20, dayProfitStopUsd: 100 }).trades[0];
  };
  // $100 at 1 lot needs +50 points; at 10 lots only +5.
  close(mk(1).exitPrice, 150, 1e-6, "1 lot:");
  close(mk(10).exitPrice, 105, 1e-6, "10 lots:");
  close(mk(1).pnl, 100, 1e-6);
  close(mk(10).pnl, 100, 1e-6);
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

section("3b. Execution engine: order model, intrabar order, day blocks, hooks");
// Each new behaviour against its hand-worked numbers, and against its old reading
// (LEGACY_EXEC), so the difference the default makes is pinned down too.
const W = { ...NOFEE, intradayOnly: false };

t("a market fill at the open can be stopped out inside its own bar (old: only from the next bar)", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 94, 100], [100, 101, 99, 100]]);
  const sig = new Int8Array(3); sig[0] = 1;
  const now = runBrackets(b, sig, flatAtr(3, 10), { ...W, slAtrMult: 0.5, tpAtrMult: 5 }).trades[0];
  eq(now.reason, EXIT.SL); eq(now.exitIdx, 1, "stopped on the entry bar:"); close(now.exitPrice, 95, 1e-9);
  const old = runBrackets(b, sig, flatAtr(3, 10), { ...W, ...LEGACY_EXEC, slAtrMult: 0.5, tpAtrMult: 5 }).trades[0];
  eq(old.reason, EXIT.EOD, "old engine never tested the entry bar:");
});

t("an exit decided at the close fills at the next open, before that bar can reach the target", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [102, 115, 101, 103], [103, 104, 102, 103]]);
  const sig = new Int8Array(4); sig[0] = 1; sig[1] = -1;
  const now = runBrackets(b, sig, flatAtr(4, 10), { ...W, slAtrMult: 2, tpAtrMult: 1 }).trades;
  eq(now[0].reason, EXIT.FLIP); close(now[0].exitPrice, 102, 1e-9, "flip at the open:");
  eq(now[1].dir, -1, "and the short taken at that open:"); close(now[1].entryPrice, 102, 1e-9);
  const old = runBrackets(b, sig, flatAtr(4, 10), { ...W, ...LEGACY_EXEC, slAtrMult: 2, tpAtrMult: 1 }).trades;
  eq(old[0].reason, EXIT.TP, "old engine credited the target hit after the flip:"); close(old[0].exitPrice, 110, 1e-9);
});

t("a bar opening through the target fills at that open, the better price (old: at the target)", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [113, 114, 112, 113]]);
  const sig = new Int8Array(3); sig[0] = 1;
  close(runBrackets(b, sig, flatAtr(3, 10), { ...W, slAtrMult: 2, tpAtrMult: 1 }).trades[0].exitPrice, 113, 1e-9);
  close(runBrackets(b, sig, flatAtr(3, 10), { ...W, ...LEGACY_EXEC, slAtrMult: 2, tpAtrMult: 1 }).trades[0].exitPrice, 110, 1e-9);
});

t("an early close flattens at the session's last bar, not in the next session", () => {
  // 11:00-11:59 CT on an early-close day, then the 17:00 CT reopen of the next session
  const b = bars(Array.from({ length: 80 }, () => [100, 101, 99, 100]));
  b.ctMin = new Int16Array(80);
  for (let i = 0; i < 80; i++) { b.ctMin[i] = i < 60 ? 660 + i : 1020 + (i - 60); b.tday[i] = i < 60 ? 100 : 101; }
  const sig = new Int8Array(80); sig[0] = 1;
  const now = runBrackets(b, sig, flatAtr(80, 50), { ...INTRA, slAtrMult: 10, tpAtrMult: 10 }).trades[0];
  eq(now.reason, EXIT.FLAT); eq(now.exitIdx, 59, "out at the session's last bar:"); eq(b.tday[now.exitIdx], 100);
  const old = runBrackets(b, sig, flatAtr(80, 50), { ...INTRA, ...LEGACY_EXEC, slAtrMult: 10, tpAtrMult: 10 }).trades[0];
  eq(old.reason, EXIT.EOD, "old engine carried it into the next session:");
});

t("a new session does not act on the last signal of the one before (found on Memorial Day 2023)", () => {
  // a signal on the early close's last bar (11:59 CT), then the 17:00 CT reopen
  const b = bars(Array.from({ length: 80 }, (_, i) => (i < 60 ? [100, 101, 99, 100] : [100, 104, 99, 103])));
  b.ctMin = new Int16Array(80);
  for (let i = 0; i < 80; i++) { b.ctMin[i] = i < 60 ? 660 + i : 1020 + (i - 60); b.tday[i] = i < 60 ? 100 : 101; }
  const sig = new Int8Array(80); sig[59] = 1;
  for (const entryType of ["market", "stop"]) {
    const o = { ...INTRA, entryType, entryTriggerAtr: 0.05, entryWindowBars: 10, slAtrMult: 10, tpAtrMult: 10 };
    eq(runBrackets(b, sig, flatAtr(80, 50), o).trades.length, 0, `${entryType}: traded the old session's signal:`);
    eq(runBrackets(b, sig, flatAtr(80, 50), { ...o, ...LEGACY_EXEC }).trades.length, 1, `${entryType}: the old engine took it at the reopen:`);
  }
  sig[59] = 0; sig[60] = 1;   // the new session's own first signal trades as usual
  eq(runBrackets(b, sig, flatAtr(80, 50), { ...INTRA, slAtrMult: 10, tpAtrMult: 10 }).trades[0].entryIdx, 61);
});

// A stop entry: signal at bar 0, armed off bar 1's open (100) at 100 + 0.15 x 10 = 101.5,
// working from bar 2. The bracket is measured from that open: stop 80, target 110.
const STOP = { ...W, entryType: "stop", entryTriggerAtr: 0.15, entryWindowBars: 10, slAtrMult: 2, tpAtrMult: 1 };
t("stop entry: priced off the arm bar's open, works from the bar after it, fills at the trigger", () => {
  const b = bars([[100, 101, 99, 100], [100, 105, 99, 100], [100.5, 102, 100, 101.75], [101.75, 103, 101, 102]]);
  const sig = new Int8Array(4); sig[0] = 1;
  const tr = runBrackets(b, sig, flatAtr(4, 10), STOP).trades[0];
  eq(tr.entryIdx, 2, "not on the arm bar, though it traded through the trigger:"); close(tr.entryPrice, 101.5, 1e-9);
  eq(tr.entryType, "stop"); eq(tr.sigIdx, 0); close(tr.stop, 80, 1e-9, "stop from the arm bar's open:"); close(tr.target, 110, 1e-9);
});
t("stop entry: a later bar opening through the trigger fills at that open (old: at the trigger)", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100.5, 101, 100, 100.5], [103, 104, 102.5, 103]]);
  const sig = new Int8Array(4); sig[0] = 1;
  close(runBrackets(b, sig, flatAtr(4, 10), STOP).trades[0].entryPrice, 103, 1e-9);
  close(runBrackets(b, sig, flatAtr(4, 10), { ...STOP, entryGapFill: "level" }).trades[0].entryPrice, 101.5, 1e-9);
});
t("stop entry: refused on a first bar that opens through it, it rests as a limit at the same price", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [102, 103, 101.75, 102.5], [102.5, 103, 101, 101.5]]);
  const sig = new Int8Array(4); sig[0] = 1;
  const tr = runBrackets(b, sig, flatAtr(4, 10), STOP).trades[0];
  eq(tr.entryIdx, 3, "fills on the retrace:"); close(tr.entryPrice, 101.5, 1e-9); eq(tr.limitFill, true);
  // 'optimistic' assumes the platform took the stop: it triggers at once, at the open...
  const opt = runBrackets(b, sig, flatAtr(4, 10), { ...STOP, entryRefused: "optimistic" }).trades[0];
  eq(opt.entryIdx, 2); close(opt.entryPrice, 102, 1e-9);
  // ...or, as old research had it, at the trigger -- a price the market had already left
  close(runBrackets(b, sig, flatAtr(4, 10), { ...STOP, entryRefused: "optimistic", entryGapFill: "level" }).trades[0].entryPrice, 101.5, 1e-9);
});
t("stop entry: expires after its window; an opposite signal cancels it", () => {
  const rows = [[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 103, 99, 102]];
  const sig = new Int8Array(5); sig[0] = 1;
  eq(runBrackets(bars(rows), sig, flatAtr(5, 10), { ...STOP, entryWindowBars: 2 }).trades.length, 0, "expired before bar 4:");
  eq(runBrackets(bars(rows), sig, flatAtr(5, 10), { ...STOP, entryWindowBars: 5 }).trades.length, 1, "still working at bar 4:");
  const s2 = new Int8Array(5); s2[0] = 1; s2[2] = -1;
  const tr = runBrackets(bars(rows), s2, flatAtr(5, 10), { ...STOP, entryWindowBars: 5 }).trades;
  eq(tr.length, 0, "cancelled by the opposite signal, and the short's trigger (98.5) never traded:");
});
t("stop entry: a repeated signal re-prices the working order off the new bar's open", () => {
  // armed at 101.5 off bar 1; bar 2 misses it and re-arms off its own open, 101 -> 102.5
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [101, 101.4, 100.5, 101], [101, 103, 100.5, 102.5]]);
  const sig = new Int8Array(4); sig[0] = 1; sig[1] = 1;
  const tr = runBrackets(b, sig, flatAtr(4, 10), STOP).trades[0];
  eq(tr.entryIdx, 3); close(tr.entryPrice, 102.5, 1e-9, "the re-priced trigger:"); eq(tr.sigIdx, 1);
});
t("limit entry: rests back inside the move and fills on the retrace", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 98, 99], [99, 100, 97, 98]]);
  const sig = new Int8Array(4); sig[0] = 1;
  const tr = runBrackets(b, sig, flatAtr(4, 10), { ...STOP, entryType: "limit", entryLimitAtr: 0.25 }).trades[0];
  eq(tr.entryIdx, 3); close(tr.entryPrice, 97.5, 1e-9); eq(tr.entryType, "limit");
});
t("day blocks: no new entries once the day's realised P&L crosses the breaker or the profit block", () => {
  // three long signals on one day; the first trade loses $20 (stop at 90 x 1 lot x $2)
  const rows = [[100, 101, 99, 100], [100, 101, 89, 90], [90, 91, 89, 90], [90, 91, 89, 90], [90, 91, 89, 90], [90, 91, 89, 90]];
  const sig = new Int8Array(6); sig[0] = 1; sig[2] = 1; sig[3] = 1;
  const go = (x) => runBrackets(bars(rows), sig, flatAtr(6, 10), { ...W, slAtrMult: 1, tpAtrMult: 5, ...x }).trades;
  eq(go({}).length, 2, "without a block the next signal trades:");
  eq(go({ dayBreakerUsd: 20 }).length, 1, "a $20 breaker stops the day:");
  eq(go({ dayBreakerUsd: 21 }).length, 2, "a $21 breaker does not:");
});
t("scale-out: half banked at the first target, the rest run to the second", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 106, 99, 105], [105, 111, 104, 110]]);
  const sig = new Int8Array(4); sig[0] = 1;
  const tr = runBrackets(b, sig, flatAtr(4, 10), { ...W, contracts: 2, slAtrMult: 2, tpAtrMult: 1, scaleOutFrac: 0.5, scaleOutAtr: 0.5 }).trades[0];
  // 1 lot banked at 105 (+5 x $2) and 1 lot out at 110 (+10 x $2)
  eq(tr.reason, EXIT.TP); close(tr.gross, 30, 1e-9); eq(tr.contracts, 2);
});
t("research hooks: sizer, tpFn, exitFn, a stopFn that only tightens, onTrade and haltFn", () => {
  const rows = Array.from({ length: 30 }, (_, i) => [100 + i, 101.5 + i, 99.5 + i, 101 + i]);   // a steady climb
  const sig = new Int8Array(30); sig[0] = 1; sig[12] = 1;
  const seen = [];
  const tr = runBrackets(bars(rows), sig, flatAtr(30, 10), { ...W, slAtrMult: 1, tpAtrMult: 50, flipOnOpposite: false,
    sizer: (a, ct, seq) => (seq === 0 ? 3 : 0),                     // 3 lots, then skip
    tpFn: (a, q) => 4 * a,                                          // target 40 points
    exitFn: (k, d, st) => k - st.entBar >= 8,                       // out 8 bars after the fill
    stopFn: (k, st) => st.fill - 100,                               // a looser stop: never applies
    onTrade: (x) => seen.push(x.reason) }).trades;
  eq(tr.length, 1, "the second signal sized to 0 lots:"); eq(tr[0].contracts, 3); close(tr[0].target, 141, 1e-9);
  eq(tr[0].reason, EXIT.SIGNAL); eq(tr[0].exitIdx, 10, "exit at the open after bar 9 (8 bars past the fill):");
  eq(seen.join(), "SIGNAL", "onTrade saw it:");
  const trail = runBrackets(bars(rows), sig, flatAtr(30, 10), { ...W, slAtrMult: 1, tpAtrMult: 50, flipOnOpposite: false,
    stopFn: (k, st) => (st.dir === 1 ? st.mx - 0.5 : st.mn + 0.5) }).trades[0];
  eq(trail.reason, EXIT.TRAIL, "a trailing stop half a point under the best price is hit:");
  let calls = 0;
  const halted = runBrackets(bars(rows), sig, flatAtr(30, 10), { ...W, slAtrMult: 1, tpAtrMult: 2, haltFn: () => ++calls > 5 }).trades;
  eq(halted.length, 0, "halted before anything closed:");
});
t("exogenous entries: managed by the same exits; untilFlat stops after the last one", () => {
  const b = bars([[100, 101, 99, 100], [100, 101, 99, 100], [100.5, 104, 100, 103], [103, 106, 102, 105], [105, 109, 104, 108]]);
  const tr = runBrackets(b, new Int8Array(5), new Float64Array(0), { ...W, untilFlat: true,
    entries: [{ bar: 2, dir: 1, price: 101, slPts: 2, tpPts: 4, lots: 2 }] }).trades;
  eq(tr.length, 1); eq(tr[0].entryIdx, 2); close(tr[0].entryPrice, 101, 1e-9);
  eq(tr[0].reason, EXIT.TP); eq(tr[0].exitIdx, 3); close(tr[0].exitPrice, 105, 1e-9); eq(tr[0].contracts, 2);
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
  if (!(r.stats.bestDay <= 0.5 * r.stats.netPnl + 1e-9)) throw new Error("passed while violating the cap");
});

// Several trades a session: [[day 1 pnls], [day 2 pnls], ...], in time order.
function trDays(days) {
  const base = Date.UTC(2024, 0, 1, 12), out = [];
  days.forEach((list, d) => list.forEach((pnl, j) => {
    const entryTime = base + d * DAY + j * 3600000;
    out.push({ entryTime, exitTime: entryTime + 1800000, tday: Math.floor((base + d * DAY) / DAY),
               pnl, mae: Math.min(0, pnl), mfe: Math.max(0, pnl), dir: 1, contracts: 1, fees: 0,
               entryPrice: 1, exitPrice: 1, reason: "TP", entrySrc: out.length, exitSrc: out.length });
  }));
  return out;
}
const GATED = { ...BASE, consistencyPct: 50, consistencyGatesPass: true };

t("hand-traced: consistency counts a day at its net, not at its intraday peak", () => {
  // Day 1 runs to +1700, gives back 1200 and closes +500. Days 2 and 3 close
  // +1250 each. At 3000 the best DAY is 1250, under half of 3000, so it passes
  // there. Counting day 1 at its 1700 peak (the old bug) would have held it.
  const r = replayWindow(trDays([[1700, -1200], [1250], [1250]]), START, GATED);
  eq(r.outcome, OUTCOME.PASS, "passes at the target:");
  close(r.stats.netPnl, 3000, 1e-9, "net at the pass:");
  close(r.stats.bestDay, 1250, 1e-9, "best day:");
  close(r.stats.maxDayPnl, 1700, 1e-9, "the intraday peak is still reported:");
});

t("hand-traced: one oversized day raises what the window needs to best day / cap", () => {
  // +2500 on day 1 at a 50% cap: the window needs 5000 before it can pass. 3500
  // after day 2 is over the target but not enough; 5100 after day 3 passes.
  const r = replayWindow(trDays([[2500], [1000], [1600]]), START, GATED);
  const need = r.events.filter((e) => e.taken).map((e) => e.need);
  close(need[0], 5000, 1e-9, "after the +2500 day:");
  close(need[1], 5000, 1e-9, "still, after day 2:");
  eq(r.outcome, OUTCOME.PASS, "passes on day 3:");
  close(r.stats.netPnl, 5100, 1e-9, "net at the pass:");
  // and with no big day, the need is just the target
  close(replayWindow(trDays([[1000], [1000]]), START, GATED).stats.profitNeeded, 3000, 1e-9, "no big day:");
});

t("a consistency cap of 0% switches the rule off instead of making the pass impossible", () => {
  eq(replayWindow(trDays([[3200]]), START, { ...GATED, consistencyPct: 0 }).outcome, OUTCOME.PASS);
});

t("the portfolio replay counts the best day the same way", () => {
  const r = replayPortfolio([{ trades: trDays([[1700, -1200], [1250], [1250]]), contracts: 1 }], START, GATED);
  eq(r.outcome, OUTCOME.PASS);
  close(r.bestDay, 1250, 1e-9, "best day:");
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

// ══════════════════════════════ 4d. PORTFOLIO REPLAY ══════════════════════════════
section("4d. Multi-book portfolio replay");

t("one book reproduces replayWindow exactly", () => {
  // The event-driven path must agree with the shipped sequential replay whenever
  // trades do not overlap, or it is not measuring the same rules.
  const cases = [[900, 900, 900, 900], [1500, -2100, 900], [2000, 1500, 900, 900], [-300, 400, -200, 3000]];
  for (const pnls of cases) {
    const trades = tr(pnls);
    for (const c of [1, 3, 8]) {
      const scaled = trades.map((x) => ({ ...x, pnl: x.pnl * c, mae: x.mae * c, mfe: x.mfe * c }));
      const seq = replayWindow(scaled, START, BASE);
      const pf = replayPortfolio([{ trades, contracts: c }], START, BASE, { maxContracts: 99 });
      eq(pf.outcome, seq.outcome, `pnls=${pnls} c=${c} outcome:`);
      close(pf.netPnl, seq.stats.netPnl, 1e-6, `pnls=${pnls} c=${c} net:`);
    }
  }
});

t("splitting one book into copies does NOT change the result", () => {
  // This is the exact failure that invalidated the old pooling attempt: there,
  // the same trades relabelled turned 32% into 81%. Here the account-wide
  // contract cap and realised-P&L accounting must make it a no-op.
  const trades = tr([-700, -700, 800, 900, 900]);
  const whole = replayPortfolio([{ trades, contracts: 8 }], START, BASE, { maxContracts: 99 });
  const split = replayPortfolio(
    [{ trades, contracts: 4 }, { trades, contracts: 4 }], START, BASE, { maxContracts: 99 });
  eq(split.outcome, whole.outcome, "outcome must match:");
  close(split.netPnl, whole.netPnl, 1e-6, "and so must the P&L:");
});

t("the contract cap applies to the ACCOUNT, not per book", () => {
  // Two books wanting 8 lots each cannot both be on under a 10-lot cap.
  const a = tr([500, 500, 500]);
  const b = a.map((x) => ({ ...x, entryTime: x.entryTime + 60000, exitTime: x.exitTime + 60000 }));
  const r = replayPortfolio([{ trades: a, contracts: 8 }, { trades: b, contracts: 8 }], START, BASE, { maxContracts: 10 });
  if (r.skippedCap === 0) throw new Error("cap never bound despite 16 lots requested");
});

t("shrink mode takes the remaining size instead of skipping", () => {
  const a = tr([500, 500]);
  const b = a.map((x) => ({ ...x, entryTime: x.entryTime + 60000, exitTime: x.exitTime + 60000 }));
  const books = [{ trades: a, contracts: 7 }, { trades: b, contracts: 7 }];
  const skip = replayPortfolio(books, START, BASE, { maxContracts: 10, onCapBreach: "skip" });
  const shrunk = replayPortfolio(books, START, BASE, { maxContracts: 10, onCapBreach: "shrink" });
  eq(shrunk.taken >= skip.taken, true, "shrink takes at least as many trades:");
});

t("a daily stop is judged on REALISED P&L, not on open positions", () => {
  // A trade still open cannot have contributed to the day's loss yet, so it must
  // not trip the breaker for a trade entered while it is running.
  const base = Date.UTC(2024, 0, 1, 12);
  const long = [{ entryTime: base, exitTime: base + 6 * 3600000, pnl: -900, mae: -900, mfe: 0,
                  tday: Math.floor(base / 86400000), dir: 1, contracts: 1, fees: 0, entryPrice: 1, exitPrice: 1, reason: "SL", entrySrc: 0, exitSrc: 0 }];
  const later = [{ entryTime: base + 3600000, exitTime: base + 2 * 3600000, pnl: 500, mae: 0, mfe: 500,
                   tday: Math.floor(base / 86400000), dir: 1, contracts: 1, fees: 0, entryPrice: 1, exitPrice: 1, reason: "TP", entrySrc: 0, exitSrc: 0 }];
  const r = replayPortfolio([{ trades: long, contracts: 1 }, { trades: later, contracts: 1 }],
    START, { ...BASE, circuitBreaker: 150, trailingDD: 999999 }, { maxContracts: 99 });
  eq(r.taken, 2, "the second trade opens because the first has not settled yet:");
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

// ══════════════════════════════ 7. STRATEGIES ══════════════════════════════
// Every strategy, on the last 300,000 real bars. Two properties the whole tool
// rests on, checked generically so a new strategy file is covered the day it is
// dropped in:
//   no lookahead   -- signals, ATR and exit signals computed on data cut short
//                     equal the full run's for every completed bar;
//   live = sweep   -- the browser's path (the window plus the warm-up and tail
//                     src/window.mjs sets, the tail grown 10x while its last trade
//                     ran out of bars, as public/app.js does) gives the same
//                     window result as the server's full-history run.
section("7. Strategies: no lookahead, and the live window matches the sweep");

// One window's trades the way the browser gets them.
function liveWindow(H, s, p, exec, filter, start, endMs) {
  const n = H.ts.length;
  for (let tailMin = 0; ;) {
    const span = windowSpan(s, p, tailMin ? { tailMin, filter, exec } : { filter, exec });
    const si = indexAtOrAfter(H.ts, start - span.warmupMin * 60000);
    const ei = Math.min(indexAtOrAfter(H.ts, endMs + span.tailMin * 60000) + 1, n);
    const lt = runStrategy(sliceBars(H, si, ei), s, p, exec, { fromMs: start, filter }).trades.filter((x) => x.entryTime < endMs);
    if (!(lt.length && lt[lt.length - 1].reason === "EOD" && ei < n)) return lt;
    tailMin = span.tailMin * 10;
  }
}

if (bars_) {
  const { bars: B } = bars_;
  const N = 300000, H = sliceBars(B, B.count - N, B.count);
  const strategies = await loadStrategies();
  const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

  for (const [id, s] of strategies) {
    t(`${id}: no lookahead`, () => {
      const p = resolveParams(s, {});
      const oF = s.compute(resample(H, p.timeframeMin), p);
      for (const frac of [0.5, 0.85]) {
        const tfP = resample(sliceBars(H, 0, Math.floor(N * frac)), p.timeframeMin);
        const oP = s.compute(tfP, p);
        const m = tfP.close.length - 1;             // its last bar may be a partial bucket
        for (const k of ["sig", "atr", "exitSig"]) {
          if (!oF[k] && !oP[k]) continue;
          for (let i = 0; i < m; i++) {
            if (!same(oF[k][i], oP[k][i])) throw new Error(`${k} at bar ${i} of ${m} changes when later bars exist (cut ${frac})`);
          }
        }
      }
    });
  }

  for (const [id, s] of strategies) {
    t(`${id}: the live window gives the sweep's result, overnight holds off and on`, () => {
      const p = resolveParams(s, {});
      for (const overnight of [false, true]) {
        const exec = resolveExec({ ...(s.execDefaults || {}), ...(overnight ? { intradayOnly: false } : {}) });
        const rules = resolveRules({ ...(s.rulesDefaults || {}) });
        const filter = { ...NO_FILTER, ...(s.filterDefaults || {}) };
        const full = runStrategy(H, s, p, exec, { filter });
        // the sweep's start time of day, and a date-picker start mid-session
        for (const [k, offMin] of [[50, 0], [93, 6 * 60], [136, 0], [179, 13 * 60]]) {
          const start = H.ts[0] + k * DAY + offMin * 60000, endMs = start + rules.windowDays * DAY;
          const lt = liveWindow(H, s, p, exec, filter, start, endMs);
          const a = replayWindow(full.trades, start, rules), b = replayWindow(lt, start, rules);
          if (a.outcome !== b.outcome || Math.abs(a.stats.netPnl - b.stats.netPnl) > 0.01 || a.stats.trades !== b.stats.trades) {
            throw new Error(`${overnight ? "overnight, " : ""}window ${new Date(start).toISOString().slice(0, 16)}: sweep ${a.outcome} ` +
                            `${a.stats.netPnl.toFixed(2)} (${a.stats.trades} trades), live ${b.outcome} ${b.stats.netPnl.toFixed(2)} (${b.stats.trades})`);
          }
        }
      }
    });
  }
}

// ══════════════════════════════ 8-11. FUZZ ══════════════════════════════
// Random configurations, checked against the rules the code promises. Every
// failure prints the case so it can be replayed; the PRNG is seeded, so a run
// reproduces exactly.
const pick = (a) => a[Math.floor(rnd() * a.length)];
const uni = (lo, hi) => lo + rnd() * (hi - lo);
const iuni = (lo, hi) => Math.floor(uni(lo, hi + 1));
const inFlatCt = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);

function randomExec() {
  return {
    contracts: iuni(1, 20), maxContracts: iuni(1, 20), sizingMode: pick(["fixed", "fixed", "risk"]), riskDollars: iuni(50, 1500),
    slAtrMult: pick([0.25, 0.5, 1, 1.5, 2, 3, 5, 8, 1000]), tpMode: pick(["atr", "atr", "rr"]),
    tpAtrMult: pick([0.25, 0.5, 1, 2, 4, 12, 40, 1000]), tpRR: pick([0.3, 1, 1.2, 2, 5]),
    commissionModel: pick(["per-contract", "per-contract", "flat"]), commissionPerSide: pick([0, 0.75, 1.5]), commissionFlat: pick([0, 5, 12]),
    slippageTicks: pick([0, 0, 1, 2]), flipOnOpposite: rnd() < 0.7, sameBarReentry: rnd() < 0.15,
    cooldownAfterStopMins: pick([0, 0, 15, 90]), maxBarsInTrade: pick([0, 0, 5, 40, 200]),
    intradayOnly: rnd() < 0.7, flattenCt: pick([15 * 60 + 5, 14 * 60, 12 * 60 + 30]), reopenCt: 17 * 60, noEntryMinsBeforeFlat: pick([0, 0, 10, 60]),
    dayProfitStopUsd: pick([0, 0, 300, 1500]), dayLossStopUsd: pick([0, 0, 300, 1000]), dayLossStopMode: pick(["price", "exact"]),
    scaleInFrac: pick([0, 0, 0, 0.5, 0.25]), scaleInTrigger: pick([0, 0.25, 1]), scaleInWindowBars: pick([1, 10, 30]),
    scaleInOrder: pick(["before", "after"]), scaleInSlipTicks: pick([0, 1]), pointValue: pick([2, 2, 20]),
    entryType: pick(["market", "market", "stop", "limit"]), entryTriggerAtr: pick([0.05, 0.15, 0.5]), entryLimitAtr: pick([0.1, 0.25, 1]),
    entryWindowBars: pick([1, 5, 10, 30]), entryRefused: pick(["limit", "limit", "optimistic"]), cancelOpposite: rnd() < 0.6,
    tpFromFill: rnd() < 0.3, exitFirst: rnd() < 0.7, entryBarExits: rnd() < 0.7, fillBarStop: pick(["touch", "close"]),
    limitFillTp: pick(["high", "close"]), fillBarOpen: rnd() < 0.2, sameBarTie: pick(["stop", "stop", "target"]),
    tpGapFill: pick(["open", "level"]), entryGapFill: pick(["open", "level"]), sessionEndFlat: pick(["close", "close", "none"]),
    dayBreakerUsd: pick([0, 0, 200, 600]), dayProfitBlockUsd: pick([0, 0, 300, 900]), scaleOutFrac: pick([0, 0, 0, 0.5]),
    scaleOutAtr: pick([0.5, 1, 2]), flipOnAnySignal: rnd() < 0.1, capEndsDay: rnd() < 0.85,
  };
}

section("8. Fuzz: engine invariants over random configurations, on real bars");
if (bars_) {
  const { bars: B } = bars_;
  const CASES = 400 * SCALE;
  let checked = 0;
  t(`${CASES} random configurations: every trade obeys the engine's rules`, () => {
    for (let c = 0; c < CASES; c++) {
      const tfMin = pick([1, 1, 2, 5, 15]);
      const s0 = iuni(0, B.count - 40000), slice = sliceBars(B, s0, s0 + 30000);
      const tf = resample(slice, tfMin), n = tf.close.length;
      const a = atr(tf.high, tf.low, tf.close, 14);
      const sig = new Int8Array(n), dens = pick([0.005, 0.02, 0.08]);
      for (let i = 0; i < n; i++) if (rnd() < dens) sig[i] = rnd() < 0.5 ? 1 : -1;
      const x = randomExec();
      if (rnd() < 0.3) { x.exitSig = new Int8Array(n); for (let i = 0; i < n; i++) if (rnd() < 0.03) x.exitSig[i] = iuni(1, 3); }
      const cfg = resolveExec(x);
      const { trades } = runBrackets(tf, sig, a, cfg);
      const again = runBrackets(tf, sig, a, cfg).trades;
      const where = () => `case ${c} (tf ${tfMin}, ${JSON.stringify({ ...x, exitSig: x.exitSig ? "mask" : undefined })})`;
      if (again.length !== trades.length || again.some((t2, k) => t2.pnl !== trades[k].pnl)) throw new Error(`not deterministic: ${where()}`);
      const cap = Math.max(1, Math.trunc(cfg.maxContracts));
      const slip = cfg.slippageTicks * cfg.tickSize;
      const day = new Map(), blockDay = new Map(), capDays = new Set();
      const atOpenOf = (k, px) => Math.abs(px - tf.open[k]) < 1e-6;
      let prev = null, lastStop = null;
      for (const tr of trades) {
        checked++;
        const fail = (m) => { throw new Error(`${m} -- trade ${JSON.stringify({ e: tr.entryIdx, x: tr.exitIdx, dir: tr.dir, q: tr.contracts, why: tr.reason, pnl: tr.pnl })}, ${where()}`); };
        if (!(tr.exitIdx >= tr.entryIdx) || tr.exitTime < tr.entryTime) fail("exit before entry");
        if (prev) {
          const flipped = prev.reason === "FLIP" || cfg.sameBarReentry;
          if (tr.entryIdx < prev.exitIdx || (tr.entryIdx === prev.exitIdx && !flipped)) fail("overlaps the previous trade");
        }
        if (!(tr.contracts >= 1 && tr.contracts <= cap)) fail(`contracts outside 1..${cap}`);
        if (cfg.sizingMode === "fixed" && !(cfg.scaleInFrac > 0) && tr.contracts !== Math.min(cap, Math.max(1, Math.trunc(cfg.contracts)))) fail("fixed size not the configured size");
        const fees = cfg.commissionModel === "flat" ? cfg.commissionFlat : cfg.commissionPerSide * 2 * tr.contracts;
        if (Math.abs(tr.fees - fees) > 1e-9) fail(`fees ${tr.fees} != ${fees}`);
        if (Math.abs(tr.pnl - (tr.gross - tr.fees)) > 1e-6) fail("pnl != gross - fees");
        if (!(tr.mae <= 1e-9 && tr.mfe >= -1e-9)) fail("MAE above zero or MFE below");
        // a target fills at the target -- or at an open that gapped through it, the better price
        const atOpen = (px) => Math.abs(px - tf.open[tr.exitIdx]) < 1e-6;
        const raw = tr.exitPrice + tr.dir * slip;
        if (tr.reason === "TP" && !(cfg.scaleInFrac > 0) && Math.abs(raw - tr.target) > 1e-6 &&
            !(cfg.tpGapFill === "open" && atOpen(raw) && tr.dir * (raw - tr.target) > 0)) fail("target exit not at the target");
        if (tr.reason === "SL" && (tr.dir === 1 ? tr.exitPrice > tr.stop - slip + 1e-6 : tr.exitPrice < tr.stop + slip - 1e-6)) fail("stop exit better than the stop");
        if (cfg.maxBarsInTrade > 0 && tr.bars > cfg.maxBarsInTrade) fail("held past the time stop");
        if (cfg.intradayOnly && tf.ctMin) {
          for (let k = tr.entryIdx; k < tr.exitIdx; k++) if (inFlatCt(tf.ctMin[k], cfg.flattenCt, cfg.reopenCt)) fail("held through the flat window");
          if (inFlatCt(tf.ctMin[tr.entryIdx], cfg.flattenCt, cfg.reopenCt)) fail("entered in the flat window");
        }
        if (cfg.cooldownAfterStopMins > 0 && lastStop && tr.dir === lastStop.dir && tr.entryTime - lastStop.at < cfg.cooldownAfterStopMins * 60000) fail("re-entered during the stop cooldown");
        if (tr.reason === "SL") lastStop = { dir: tr.dir, at: tr.exitTime };
        const d = tr.tday;
        day.set(d, (day.get(d) || 0) + tr.pnl);
        if (cfg.dayProfitStopUsd > 0 && day.get(d) > cfg.dayProfitStopUsd + 1e-6 && tr.reason !== "FLAT" && tr.reason !== "EOD") {
          // the cap is a resting take-profit at the threshold; only an exit the cap does not police may pass it
          // ...unless the bar opened beyond it: there was no price at the cap to sell at
          if ((tr.reason === "DAYCAP" || tr.reason === "TP") && !(cfg.tpGapFill === "open" && atOpen(raw))) fail(`day ${d} realised ${day.get(d).toFixed(2)} above the ${cfg.dayProfitStopUsd} cap`);
        }
        if (cfg.dayLossStopUsd > 0 && cfg.dayLossStopMode === "exact" && day.get(d) < -cfg.dayLossStopUsd - 1e-6) fail(`day ${d} realised ${day.get(d).toFixed(2)} below the exact -${cfg.dayLossStopUsd} cap`);
        // the order it came in on: off the arm bar's open, inside its window, at its trigger or a better-for-the-market open
        if (cfg.entryType !== "market") {
          if (tr.entryType !== cfg.entryType && !(tr.limitFill && cfg.entryType === "stop")) fail(`filled as ${tr.entryType}`);
          const arm = tr.sigIdx + 1, ref = tf.open[arm], a0 = tr.atr, px = tr.entryPrice - tr.dir * slip;
          if (!(tr.entryIdx > arm && tr.entryIdx <= arm + cfg.entryWindowBars)) fail(`filled ${tr.entryIdx - arm} bars after the arm bar`);
          const trig = cfg.entryType === "limit" ? Math.round((ref - tr.dir * a0 * cfg.entryLimitAtr) / cfg.tickSize) * cfg.tickSize
                                                 : ref + tr.dir * Math.max(a0 * cfg.entryTriggerAtr, cfg.tickSize);
          const worse = tr.dir * (px - trig);    // > 0: paid more than the trigger
          if (!(cfg.scaleInFrac > 0)) {
            if (cfg.entryType === "stop" && !tr.limitFill && cfg.entryRefused === "limit" && worse < -1e-6) fail("a stop filled better than its trigger");
            if ((cfg.entryType === "limit" || tr.limitFill) && worse > 1e-6) fail("a limit filled worse than its price");
            if (Math.abs(worse) > 1e-6 && !(cfg.entryGapFill === "open" && atOpenOf(tr.entryIdx, px))) fail("filled away from its price without a gap");
          }
        }
        // the day blocks: nothing enters once the day's realised P&L has crossed them
        // (summed in the engine's own order, so the comparison is exact)
        const realisedBefore = blockDay.get(tf.tday[tr.entryIdx]) || 0;
        if (cfg.dayBreakerUsd > 0 && realisedBefore <= -cfg.dayBreakerUsd) fail(`entered with the day at ${realisedBefore.toFixed(2)}, past the breaker`);
        if (cfg.dayProfitBlockUsd > 0 && realisedBefore >= cfg.dayProfitBlockUsd) fail(`entered with the day at ${realisedBefore.toFixed(2)}, past the profit block`);
        // and a platform cap that fired ended the day
        if (cfg.capEndsDay && capDays.has(tf.tday[tr.entryIdx])) fail("entered after a platform cap ended the day");
        if (tr.reason === "DAYCAP" || tr.reason === "DAYLOSS") capDays.add(tf.tday[tr.exitIdx]);
        blockDay.set(tf.tday[tr.exitIdx], (blockDay.get(tf.tday[tr.exitIdx]) || 0) + tr.pnl);
        // intraday with session-end flattening: never across a session boundary
        if (cfg.intradayOnly && tf.ctMin && cfg.sessionEndFlat === "close" && tf.tday[tr.entryIdx] !== tf.tday[tr.exitIdx]) fail("held across a session boundary");
        // ...nor entered on the previous session's signal
        if (cfg.intradayOnly && tf.ctMin && cfg.sessionEndFlat === "close" && tf.tday[tr.sigIdx] !== tf.tday[tr.entryIdx]) fail("entered on the previous session's signal");
        prev = tr;
      }
    }
  });
  t("P&L is linear in contracts when nothing depends on the dollar size", () => {
    for (let c = 0; c < 60 * SCALE; c++) {
      const tfMin = pick([1, 2, 5]);
      const s0 = iuni(0, B.count - 40000), tf = resample(sliceBars(B, s0, s0 + 30000), tfMin), n = tf.close.length;
      const a = atr(tf.high, tf.low, tf.close, 14), sig = new Int8Array(n);
      for (let i = 0; i < n; i++) if (rnd() < 0.03) sig[i] = rnd() < 0.5 ? 1 : -1;
      const x = { ...randomExec(), sizingMode: "fixed", dayProfitStopUsd: 0, dayLossStopUsd: 0, dayBreakerUsd: 0, dayProfitBlockUsd: 0,
                  scaleInFrac: 0, commissionModel: "per-contract", maxContracts: 20 };
      const one = runBrackets(tf, sig, a, { ...x, contracts: 1 }).trades;
      for (const q of [3, 13, 20]) {
        const many = runBrackets(tf, sig, a, { ...x, contracts: q }).trades;
        eq(many.length, one.length, `trade count at ${q} lots:`);
        for (let k = 0; k < one.length; k++) close(many[k].pnl, one[k].pnl * q, 1e-6, `trade ${k} at ${q} lots:`);
      }
    }
  });
  console.log(`         (${checked.toLocaleString()} trades checked)`);
}

section("9. Fuzz: the combine rules against a plain reference implementation");
// Written from the rules as stated, not from replayWindow: one pass, no event or
// day bookkeeping. Realised evaluation; an independent check of the bookkeeping.
function refReplay(trades, start, R) {
  const end = start + R.windowDays * DAY, cap = R.consistencyPct / 100, eod = R.trailingMode === "eod";
  let cum = 0, peak = 0, eodPeak = 0, locked = false, best = 0, dayP = 0, day = null, traded = false, tdays = 0, n = 0;
  for (const t of trades) {
    if (t.entryTime < start) continue;
    if (t.entryTime >= end) break;
    if (t.tday !== day) {
      if (day !== null) {
        best = Math.max(best, dayP);
        if (eod) { eodPeak = Math.max(eodPeak, cum); if (R.lockAtBreakeven && eodPeak >= R.trailingDD) locked = true; }
      }
      day = t.tday; dayP = 0; traded = false;
    }
    if ((R.dailyProfitStop > 0 && dayP >= R.dailyProfitStop) || (R.circuitBreaker > 0 && dayP <= -R.circuitBreaker) ||
        (R.dailyLossLimit > 0 && dayP <= -R.dailyLossLimit)) continue;
    if (!traded) { traded = true; tdays++; }
    n++;
    cum += t.pnl; dayP += t.pnl;
    if (!eod) { peak = Math.max(peak, cum); if (R.lockAtBreakeven && peak >= R.trailingDD) locked = true; }
    const floor = locked ? 0 : (eod ? eodPeak : peak) - R.trailingDD;
    if (cum <= floor) return { outcome: OUTCOME.FAIL, net: cum, n };
    const ok = !R.consistencyGatesPass || !(cap > 0) || Math.max(best, dayP) <= cap * cum;
    if (cum >= R.profitTarget && ok && tdays >= R.minTradingDays) return { outcome: OUTCOME.PASS, net: cum, n };
  }
  return { outcome: OUTCOME.OPEN, net: cum, n };
}
t(`${(2000 * SCALE).toLocaleString()} random trade lists and rule sets: replayWindow agrees with the reference`, () => {
  for (let c = 0; c < 2000 * SCALE; c++) {
    const R = resolveRules({
      profitTarget: pick([500, 1250, 3000, 9000]), trailingDD: pick([250, 1000, 2000, 5000]), trailingMode: pick(["eod", "intraday"]),
      lockAtBreakeven: rnd() < 0.8, dailyLossLimit: pick([0, 500, 1000]), dailyProfitStop: pick([0, 0, 750, 1500]), circuitBreaker: pick([0, 0, 150, 500]),
      consistencyPct: pick([0, 30, 50, 50, 100]), consistencyGatesPass: rnd() < 0.8, minTradingDays: pick([0, 0, 3, 8]), windowDays: pick([5, 21, 30, 60]),
    });
    const trades = [], base0 = Date.UTC(2024, 0, 1, 14);
    let ms = base0;
    for (let d = 0; d < 70; d++) {
      const k = iuni(0, 5);
      for (let j = 0; j < k; j++) {
        const pnl = Math.round((rnd() < 0.08 ? uni(-4000, 6000) : uni(-600, 700)) * 4) / 4;
        const entryTime = base0 + d * DAY + j * 3600000;
        trades.push({ entryTime, exitTime: entryTime + 1800000, tday: Math.floor((base0 + d * DAY) / DAY), pnl,
                      mae: Math.min(0, pnl) - rnd() * 200, mfe: Math.max(0, pnl) + rnd() * 200, fees: 0 });
      }
      ms = base0 + d * DAY;
    }
    const start = base0 + iuni(0, 20) * DAY - 3600000;
    const a = replayWindow(trades, start, R), b = refReplay(trades, start, R);
    if (a.outcome !== b.outcome || Math.abs(a.stats.netPnl - b.net) > 1e-6 || a.stats.trades !== b.n) {
      throw new Error(`case ${c}: replayWindow ${a.outcome} ${a.stats.netPnl} (${a.stats.trades}) vs reference ${b.outcome} ${b.net} (${b.n}); rules ${JSON.stringify(R)}`);
    }
    // what the events say must hold on their own
    const ev = a.events.filter((e) => e.taken);
    for (let k = 1; k < ev.length; k++) if (ev[k].floor < ev[k - 1].floor - 1e-9) throw new Error(`case ${c}: the trailing floor moved down`);
    for (const e of a.events) if (e.need < R.profitTarget - 1e-9) throw new Error(`case ${c}: needed less than the target`);
    if (a.outcome === OUTCOME.PASS && R.consistencyGatesPass && R.consistencyPct > 0 && a.stats.bestDay > (R.consistencyPct / 100) * a.stats.netPnl + 1e-6) {
      throw new Error(`case ${c}: passed with the best day over the cap`);
    }
  }
});
// The same random accounts through the two faster evaluators.
const randomAccount = () => {
  const trades = [], base0 = Date.UTC(2024, 0, 1, 14);
  for (let d = 0; d < 70; d++) {
    const k = iuni(0, 5);
    for (let j = 0; j < k; j++) {
      const pnl = Math.round((rnd() < 0.08 ? uni(-4000, 6000) : uni(-600, 700)) * 4) / 4;
      const entryTime = base0 + d * DAY + j * 3600000;
      trades.push({ entryTime, exitTime: entryTime + 1800000, tday: Math.floor((base0 + d * DAY) / DAY), pnl,
                    mae: Math.min(0, pnl) - rnd() * 200, mfe: Math.max(0, pnl) + rnd() * 200, fees: 0, contracts: 1 });
    }
  }
  return { trades, start: base0 + iuni(0, 20) * DAY - 3600000 };
};
t(`${(2000 * SCALE).toLocaleString()} random accounts: the fast search replay (src/search.mjs) agrees with replayWindow at any size`, () => {
  for (let c = 0; c < 2000 * SCALE; c++) {
    const R = resolveRules({
      profitTarget: pick([500, 1250, 3000, 9000]), trailingDD: pick([250, 1000, 2000, 5000]), trailingMode: pick(["eod", "intraday"]),
      lockAtBreakeven: rnd() < 0.8, dailyLossLimit: pick([0, 500, 1000]), dailyProfitStop: pick([0, 0, 750, 1500]), circuitBreaker: pick([0, 0, 150, 500]),
      consistencyPct: pick([0, 30, 50, 50, 100]), consistencyGatesPass: rnd() < 0.8, minTradingDays: pick([0, 0, 3, 8]), windowDays: pick([5, 21, 30, 60]),
    });
    const { trades, start } = randomAccount(), mult = pick([1, 3, 7.5]);
    const scaled = trades.map((x) => ({ ...x, pnl: x.pnl * mult, mae: x.mae * mult, mfe: x.mfe * mult }));
    const real = replayWindow(scaled, start, R).outcome, fast = fastWindow(flatten(trades), start, R, mult);
    if (fast !== (real === OUTCOME.PASS ? 1 : real === OUTCOME.FAIL ? -1 : 0)) throw new Error(`case ${c} x${mult}: fast ${fast}, replayWindow ${real}; ${JSON.stringify(R)}`);
  }
});
t(`${(1000 * SCALE).toLocaleString()} random day runs: the day-sequence evaluator (src/dayeval.mjs) agrees with replayWindow where their rules coincide`, () => {
  // one trade a day, end-of-day trailing, no daily rules: the two methods' common ground
  for (let c = 0; c < 1000 * SCALE; c++) {
    const len = iuni(3, 45), target = pick([1250, 3000]), dd = pick([1000, 2000]), cons = pick([0, 0.3, 0.5]);
    const vals = Array.from({ length: len }, () => Math.round((rnd() < 0.1 ? uni(-2500, 4000) : uni(-700, 900)) * 4) / 4);
    const base0 = Date.UTC(2024, 0, 1, 14);
    const trades = vals.map((pnl, d) => ({ entryTime: base0 + d * DAY, exitTime: base0 + d * DAY + 60000, tday: d, pnl, mae: 0, mfe: 0, fees: 0 }));
    const R = resolveRules({ profitTarget: target, trailingDD: dd, trailingMode: "eod", lockAtBreakeven: true, dailyLossLimit: 0, dailyProfitStop: 0,
                             circuitBreaker: 0, consistencyPct: cons * 100, consistencyGatesPass: true, minTradingDays: 0, windowDays: len });
    const viaReplay = replayWindow(trades, base0 - 60000, R).outcome === OUTCOME.PASS ? 1 : 0;
    const viaDays = evalDays(vals, { target, dd, consistency: cons });
    if (viaReplay !== viaDays) throw new Error(`case ${c}: replayWindow ${viaReplay}, evalDays ${viaDays}: ${JSON.stringify({ vals, target, dd, cons })}`);
  }
});

section("10. Fuzz: every strategy with random settings -- no lookahead, live window = sweep");
if (bars_) {
  const { bars: B } = bars_;
  const N = 200000, H = sliceBars(B, B.count - N, B.count);
  const strategies = await loadStrategies();
  const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));
  const randomParams = (s) => {
    const p = resolveParams(s, {});
    for (const d of s.params || []) {
      if (rnd() < 0.35) continue;                    // keep some defaults, so mixtures are tried too
      if (d.type === "select") p[d.key] = pick(d.options)[0];
      else if (d.type === "int" || d.type === "time") p[d.key] = Math.round(uni(d.min, d.max) / (d.step || 1)) * (d.step || 1);
      else if (d.type === "float") p[d.key] = Math.round(uni(d.min, d.max) / (d.step || 0.01)) * (d.step || 0.01);
    }
    if (rnd() < 0.25) p.timeframeMin = pick([1, 2, 3, 5, 10, 15]);
    return p;
  };
  const randomFilter = () => (rnd() < 0.6 ? {} : {
    adxMin: pick([0, 20]), effMin: pick([0, 0.3]), volMax: pick([0, 1.5]), chopMax: pick([0, 60]),
    adxPeriod: pick([14, 30]), effPeriod: pick([20, 50]), volMaPeriod: pick([60, 120]),
  });
  for (const [id, s] of strategies) {
    t(`${id}: ${3 * SCALE} random settings`, () => {
      for (let c = 0; c < 3 * SCALE; c++) {
        const p = randomParams(s);
        // an empty flat window (flatten time = resume time) holds overnight as well
        const ct = iuni(0, 1439), flat = rnd() < 0.1 ? { flattenCt: ct, reopenCt: ct } : {};
        const exec = resolveExec({ ...(s.execDefaults || {}), contracts: iuni(1, 20), intradayOnly: rnd() < 0.6, ...flat });
        const rules = resolveRules({ ...(s.rulesDefaults || {}) });
        const filter = { ...NO_FILTER, ...(s.filterDefaults || {}), ...randomFilter() };
        const tag = () => `settings ${JSON.stringify(p)} filter ${JSON.stringify(filter)} contracts ${exec.contracts} intraday ${exec.intradayOnly}` +
                          ` flat ${exec.flattenCt}-${exec.reopenCt}`;
        // no lookahead
        const oF = s.compute(resample(H, p.timeframeMin), p);
        const tfP = resample(sliceBars(H, 0, Math.floor(N * 0.7)), p.timeframeMin), oP = s.compute(tfP, p);
        for (const k of ["sig", "atr", "exitSig"]) {
          if (!oF[k] && !oP[k]) continue;
          for (let i = 0; i < tfP.close.length - 1; i++) if (!same(oF[k][i], oP[k][i])) throw new Error(`${k} at bar ${i} reads ahead -- ${tag()}`);
        }
        // live window = sweep
        const full = runStrategy(H, s, p, exec, { filter });
        for (const [k, offMin] of [[60, 0], [101, 8 * 60]]) {
          const start = H.ts[0] + k * DAY + offMin * 60000, endMs = start + rules.windowDays * DAY;
          const lt = liveWindow(H, s, p, exec, filter, start, endMs);
          const a = replayWindow(full.trades, start, rules), b = replayWindow(lt, start, rules);
          if (a.outcome !== b.outcome || Math.abs(a.stats.netPnl - b.stats.netPnl) > 0.01 || a.stats.trades !== b.stats.trades) {
            throw new Error(`window ${new Date(start).toISOString().slice(0, 16)}: sweep ${a.outcome} ${a.stats.netPnl.toFixed(2)} (${a.stats.trades}), ` +
                            `live ${b.outcome} ${b.stats.netPnl.toFixed(2)} (${b.stats.trades}) -- ${tag()}`);
          }
        }
      }
    });
  }
}

section("11. Contract cap");
{
  const tf = synthBars(4000), a = atr(tf.high, tf.low, tf.close, 14), sig = new Int8Array(4000);
  for (let i = 50; i < 4000; i += 37) sig[i] = (i / 37) % 2 ? 1 : -1;
  t("20 contracts trade 20; a fixed size over the firm cap trades the cap", () => {
    eq(runBrackets(tf, sig, a, { contracts: 20, intradayOnly: false }).trades[0].contracts, 20, "20 lots:");
    eq(runBrackets(tf, sig, a, { contracts: 20, maxContracts: 10, intradayOnly: false }).trades[0].contracts, 10, "capped at 10:");
  });
  t("risk sizing never exceeds the cap, at the default 20 or a lower one", () => {
    for (const cap of [20, 7]) {
      const tr = runBrackets(tf, sig, a, { sizingMode: "risk", riskDollars: 1e6, maxContracts: cap, intradayOnly: false }).trades;
      for (const x of tr) if (x.contracts !== cap) throw new Error(`risk size ${x.contracts} with cap ${cap}`);
    }
  });
}

section("12. Live window span");
t("overnight holds load all the history before the window; intraday-only runs keep a bounded warm-up", () => {
  const years = (x) => windowSpan({ params: [], warmupBars: 300 }, {}, { exec: x }).warmupMin / (365 * 1440);
  if (!(years(resolveExec({ intradayOnly: false })) >= 20)) throw new Error("overnight holds: the warm-up stops short of the data");
  if (!(years(resolveExec({ flattenCt: 600, reopenCt: 600, sessionEndFlat: "none" })) >= 20)) throw new Error("an empty flat window that carries over: the warm-up stops short of the data");
  if (!(years(resolveExec({ flattenCt: 600, reopenCt: 600 })) < 1)) throw new Error("an empty flat window still flattens at the session's end: the warm-up should stay bounded");
  if (!(years(resolveExec({})) < 1)) throw new Error("intraday-only: the warm-up should stay bounded");
});
if (bars_) {
  const { bars: B } = bars_;
  const s = (await loadStrategies()).get("macd_5m_quiet_anticipate");
  t("a position held months into a window, and one closing months after it, match the sweep", () => {
    // fuzz seed 55: overnight, and no exit but the opposite signal, so holds run for months
    const p = { ...resolveParams(s, {}), fast: 35, slow: 31, signal: 9, source: "open", oscMaType: "wma", sigMaType: "ema", shrinkBars: 3, prox: 0.075,
                scaleBars: 200, trigger: "prox", etaBars: 2, slopeBars: 3, sessionGate: "rth", adrMax: 0.4, adrDays: 15, fadeBars: 0, timeframeMin: 5 };
    const exec = resolveExec({ ...(s.execDefaults || {}), contracts: 5, intradayOnly: false });
    const rules = resolveRules({ ...(s.rulesDefaults || {}) }), filter = { ...NO_FILTER, ...(s.filterDefaults || {}) };
    const full = runStrategy(B, s, p, exec, { filter });
    const cases = [["2025-08-09T22:03:00Z", (t, start) => t.entryTime < start - 60 * DAY && t.exitTime > start],
                   ["2026-03-29T22:03:00Z", (t, start, end) => t.entryTime < end && t.exitTime > end + 30 * DAY]];
    for (const [iso, shape] of cases) {
      const start = Date.parse(iso), endMs = start + rules.windowDays * DAY;
      if (!full.trades.some((t) => shape(t, start, endMs))) throw new Error(`window ${iso} no longer has the long hold it tests`);
      const a = replayWindow(full.trades, start, rules), b = replayWindow(liveWindow(B, s, p, exec, filter, start, endMs), start, rules);
      if (a.outcome !== b.outcome || Math.abs(a.stats.netPnl - b.stats.netPnl) > 0.01 || a.stats.trades !== b.stats.trades) {
        throw new Error(`window ${iso}: sweep ${a.outcome} ${a.stats.netPnl.toFixed(2)} (${a.stats.trades}), live ${b.outcome} ${b.stats.netPnl.toFixed(2)} (${b.stats.trades})`);
      }
    }
  });
}

// ══════════════════════════════ RESULT ══════════════════════════════
console.log(`\n${"=".repeat(64)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:"); for (const f of failures) console.log("  - " + f); }
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
