// Enter AT the 5-minute cross and sweep the exit. The momentum read, done right.
//
// research/forward_profile.mjs relocated the edge. From the anticipated entry
// there is nothing -- mean within a quarter point of zero at every horizon out
// to eight hours, MFE and MAE symmetric to a tenth of a point. From the CROSS
// there is a real asymmetry: mean +0.8 to +1.3 points for two hours, win rate
// above 50, MFE beating |MAE| through the first 90 minutes.
//
// Entry-to-cross is worth about -1.3 points. Sniping in front of the cross is
// paying to sit through a coin flip before the part that pays starts.
//
// So: enter at the cross, and find the exit. Three families, because the MFE/MAE
// gap says different things to each:
//
//   TIME      hold a fixed span. The profile peaks near 90 minutes.
//   BRACKET   a target and a stop. MFE 10.9 against MAE -9.0 at 30 minutes is a
//             1.21 ratio, so a bracket has something to harvest but not much.
//   TRAIL     give the move room and follow it, which is what a momentum read
//             wants if the continuation is real but ragged.
//
// The lead FILTER is tested against no filter throughout, because the whole
// point is whether "a 1-minute cross led this, with the 5-minute histogram still
// opposite and near zero" picks out crosses that continue better. The filtered
// subset is 5,778 of 39,468 crosses.
//
//   node research/momentum_exit_sweep.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { sweepWindows } from "../src/challenge.mjs";
import { atr } from "../src/indicators.mjs";
import flip from "../strategies/macd_1m_flip.mjs";

const { bars } = loadBars();
const n = bars.close.length;
const RULES = { circuitBreaker: 0, dailyProfitStop: 0 };
const T0 = bars.ts[0], T1 = bars.ts[bars.ts.length - 1];
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const SCALE = 200;

const P = resolveParams(flip);
const cross1 = flip.compute(bars, P).sig;
const tf5 = resample(bars, 5);
const h5 = flip.compute(tf5, P).overlays.find((o) => o.kind === "hist").data;
const n5 = h5.length;
const sgn = (v) => (v >= 0 ? 1 : -1);

const sc5 = new Float64Array(n5).fill(NaN);
{
  let s = 0;
  for (let i = 0; i < n5; i++) {
    const a = Math.abs(h5[i]);
    if (Number.isFinite(a)) s += a;
    if (i >= SCALE) s -= Math.abs(h5[i - SCALE]) || 0;
    if (i >= SCALE - 1) sc5[i] = s / SCALE;
  }
}
const known5 = new Int32Array(n).fill(-1);
{
  let k = 0, cur = -1;
  for (let i = 0; i < n; i++) {
    while (k < n5 && tf5.srcLast[k] <= i) { cur = k; k++; }
    known5[i] = cur;
  }
}
const h5at = new Float64Array(n).fill(NaN), sc5at = new Float64Array(n).fill(NaN);
for (let i = 0; i < n; i++) {
  const k = known5[i];
  if (k >= 0) { h5at[i] = h5[k]; sc5at[i] = sc5[k]; }
}

const adrUsed = new Float64Array(n).fill(NaN);
{
  const R = [], D = 14;
  let dHi = -Infinity, dLo = Infinity, adr = NaN, cur = bars.tday[0];
  for (let i = 0; i < n; i++) {
    if (bars.tday[i] !== cur) {
      cur = bars.tday[i];
      if (Number.isFinite(dHi - dLo)) {
        R.push(dHi - dLo);
        if (R.length > D) R.shift();
        adr = R.length === D ? R.reduce((a, b) => a + b, 0) / D : NaN;
      }
      dHi = -Infinity; dLo = Infinity;
    }
    if (bars.high[i] > dHi) dHi = bars.high[i];
    if (bars.low[i] < dLo) dLo = bars.low[i];
    if (Number.isFinite(adr) && adr > 0) adrUsed[i] = (dHi - dLo) / adr;
  }
}
const quiet = (i) => {
  const c = bars.ctMin[i];
  return (c < 510 || c >= 900) && Number.isFinite(adrUsed[i]) && adrUsed[i] < 0.5;
};

// ── the two entry sets, both firing AT the cross ────────────────────────
// A 5-minute cross at bar k becomes known at srcLast[k], so the signal is
// written there and the engine fills at the next 1-minute open.
function crossSignals({ filtered, useQuiet, leadWindow = 30, prox = 0.10 }) {
  // Which 5-minute crosses were preceded by a qualifying 1-minute lead?
  const ok = new Uint8Array(n5);
  if (filtered) {
    for (let i = 1; i < n; i++) {
      const d = cross1[i];
      if (!d) continue;
      const hv = h5at[i], sv = sc5at[i];
      if (!Number.isFinite(hv) || !Number.isFinite(sv) || sv <= 0) continue;
      if (sgn(hv) === d) continue;                      // 5m already crossed
      if (!(Math.abs(hv) < prox * sv)) continue;         // must be near zero
      if (useQuiet && !quiet(i)) continue;
      // Mark the next 5-minute cross the same way, if it lands inside the window.
      for (let k = known5[i] + 1; k < n5 && tf5.srcLast[k] - i <= leadWindow; k++) {
        if (!Number.isFinite(h5[k]) || !Number.isFinite(h5[k - 1])) continue;
        if (sgn(h5[k]) !== sgn(h5[k - 1]) && sgn(h5[k]) === d) { ok[k] = 1; break; }
      }
    }
  }
  const sig = new Int8Array(n);
  for (let k = 1; k < n5; k++) {
    if (!Number.isFinite(h5[k]) || !Number.isFinite(h5[k - 1])) continue;
    if (sgn(h5[k]) === sgn(h5[k - 1])) continue;
    if (filtered && !ok[k]) continue;
    const i = tf5.srcLast[k];
    if (i < 1 || i >= n - 1) continue;
    if (!filtered && useQuiet && !quiet(i)) continue;
    sig[k] = 0;
    sig[i] = sgn(h5[k]);
  }
  return sig;
}

// 5-minute ATR mapped onto 1-minute indices, known only after its bar closes.
const a5 = atr(tf5.high, tf5.low, tf5.close, 14);
const ATR5 = new Float64Array(n).fill(NaN);
{
  let prev = NaN;
  for (let i = 0; i < n; i++) {
    const k = known5[i];
    if (k >= 0 && Number.isFinite(a5[k])) prev = a5[k];
    ATR5[i] = prev;
  }
}

function probe(sig) {
  return {
    ...flip, id: "_mom_probe", timeframeMin: 1, warmupBars: 2000,
    compute(b, p) { return { ...flip.compute(b, p), sig, atr: ATR5 }; },
  };
}

function go(lab, sig, exec) {
  const base = {
    contracts: 8, sizingMode: "fixed", slAtrMult: 1000, tpMode: "atr", tpAtrMult: 1000,
    flipOnOpposite: false, sameBarReentry: false, maxBarsInTrade: 0, intradayOnly: false,
    commissionModel: "per-contract", commissionPerSide: 0.75, slippageTicks: 0,
    dayProfitStopUsd: 0, dayLossStopUsd: 0, cooldownAfterStopMins: 0,
    noEntryMinsBeforeFlat: 0, scaleInFrac: 0,
  };
  const tr = runStrategy(bars, probe(sig), P, { ...base, ...exec }).trades || [];
  if (tr.length < 50) { console.log("  " + lab.padEnd(26) + "  (too few)"); return null; }
  const pnl = tr.map((t) => t.pnl);
  let eq = 0, pk = 0, dd = 0;
  for (const v of pnl) { eq += v; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq; }
  const sw = sweepWindows(tr, T0, T1, RULES, 1);
  const pass = sw.passRate != null ? sw.passRate
    : (100 * sw.windows.filter((w) => w.outcome === "PASS").length) / sw.windows.length;
  const t0 = tr[0].entryTime, mid = t0 + (tr[tr.length - 1].entryTime - t0) / 2;
  console.log("  " + lab.padEnd(26) + String(tr.length).padStart(7) +
    ("$" + Math.round(pnl.reduce((a, b) => a + b, 0)).toLocaleString()).padStart(12) +
    ("$" + avg(pnl).toFixed(2)).padStart(10) +
    ((100 * pnl.filter((x) => x > 0).length) / tr.length).toFixed(1).padStart(7) +
    avg(tr.map((t) => t.bars)).toFixed(0).padStart(6) +
    ("$" + Math.round(dd).toLocaleString()).padStart(11) + pass.toFixed(1).padStart(7) +
    ("$" + avg(tr.filter((t) => t.entryTime < mid).map((t) => t.pnl)).toFixed(2) + " / $" +
      avg(tr.filter((t) => t.entryTime >= mid).map((t) => t.pnl)).toFixed(2)).padStart(20));
  return { pass, avg: avg(pnl) };
}

const HEAD = "  variant                    trades     total $     avg $   win%  hold     max DD   pass%    1st / 2nd half";
const SEP = "  " + "-".repeat(108);
const SIG_F = crossSignals({ filtered: true, useQuiet: true });
const SIG_FQ = crossSignals({ filtered: true, useQuiet: false });
const SIG_Q = crossSignals({ filtered: false, useQuiet: true });
const SIG_A = crossSignals({ filtered: false, useQuiet: false });
const count = (s) => { let c = 0; for (const v of s) if (v) c++; return c; };

console.log("");
console.log("=".repeat(112));
console.log("ENTER AT THE 5-MINUTE CROSS, SWEEP THE EXIT   (momentum continuation, not anticipation)");
console.log("=".repeat(112));
console.log("");
console.log("  entry sets:  lead-filtered + quiet " + count(SIG_F).toLocaleString() +
  "    lead-filtered " + count(SIG_FQ).toLocaleString() +
  "    quiet only " + count(SIG_Q).toLocaleString() +
  "    all crosses " + count(SIG_A).toLocaleString());
console.log("");
console.log(HEAD);

console.log("");
console.log("  TIME STOP -- hold a fixed span (lead-filtered + quiet)");
console.log(SEP);
for (const m of [15, 30, 60, 90, 120, 180]) go("hold " + m + " min", SIG_F, { maxBarsInTrade: m });

console.log("");
console.log("  BRACKET on 5-minute ATR (lead-filtered + quiet)");
console.log(SEP);
for (const [sl, tp] of [[1, 1], [1, 2], [1.5, 2], [2, 2], [2, 4], [3, 3], [2, 6], [4, 4]])
  go("sl " + sl + "x / tp " + tp + "x", SIG_F, { slAtrMult: sl, tpAtrMult: tp });

console.log("");
console.log("  BRACKET plus a 90-minute cap (lead-filtered + quiet)");
console.log(SEP);
for (const [sl, tp] of [[1, 2], [2, 2], [2, 4], [3, 3]])
  go("sl " + sl + " tp " + tp + " cap 90", SIG_F, { slAtrMult: sl, tpAtrMult: tp, maxBarsInTrade: 90 });

console.log("");
console.log("  DOES THE LEAD FILTER EARN ITS PLACE? -- same exit, four entry sets");
console.log(SEP);
for (const [lab, s] of [["lead-filtered + quiet", SIG_F], ["lead-filtered only", SIG_FQ],
                        ["quiet only", SIG_Q], ["every 5-min cross", SIG_A]])
  go(lab, s, { slAtrMult: 2, tpAtrMult: 4, maxBarsInTrade: 90 });
for (const [lab, s] of [["lead+quiet, hold 90", SIG_F], ["quiet only, hold 90", SIG_Q],
                        ["every cross, hold 90", SIG_A]])
  go(lab, s, { maxBarsInTrade: 90 });

console.log("");
console.log("  Reference: the 5-min quiet anticipation passes 25.8%; the live bot about 51%.");
console.log("");
