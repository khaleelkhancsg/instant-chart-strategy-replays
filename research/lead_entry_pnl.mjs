// Does the 74.1% lead conversion actually pay?
//
// research/cross_lead_lag.mjs found that a 1-minute MACD cross, taken only when
// the 5-minute histogram is on the OPPOSITE side and already close to zero,
// is followed by a same-direction 5-minute cross 74.1% of the time against a
// 26.5% base rate -- a 2.79x lift on 8,841 events.
//
// That is a prediction, not a profit. This project has measured the two to be
// decoupled several times over, and where they correlated at all the sign was
// negative: the efficiency gate was the best arrival predictor tested and lost
// the most money, because whatever makes a cross arrive quickly is a sharp push
// and a sharp push resumes through the fade.
//
// So this is the real test. Entry is the 1-minute cross under those conditions.
// Several exits, because the exit decides as much as the entry, and the quiet
// gate on and off, since it is the only filter that has ever survived here.
//
// Note what the entry is: the 5-minute histogram being OPPOSITE the trade
// direction means this is still a fade at the 5-minute scale -- long while the
// 5-minute MACD is bearish -- but now with a 1-minute cross already turned in
// the trade's favour. That is the difference from the anticipation book, which
// entered with nothing turned at all.
//
//   node research/lead_entry_pnl.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resample } from "../src/resample.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { sweepWindows } from "../src/challenge.mjs";
import { atr } from "../src/indicators.mjs";
import flip from "../strategies/macd_1m_flip.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies({ force: true });
const REF = strategies.get("macd_5m_quiet_anticipate");
const RULES = { circuitBreaker: 0, dailyProfitStop: 0 };
const T0 = bars.ts[0], T1 = bars.ts[bars.ts.length - 1];
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const SCALE = 200;

// Everything the entry needs, built once.
const P = resolveParams(flip);
const o1 = flip.compute(bars, P);
const h1 = o1.overlays.find((o) => o.kind === "hist").data;
const cross1 = o1.sig;
const n = h1.length;
const tf5 = resample(bars, 5);
const h5 = flip.compute(tf5, P).overlays.find((o) => o.kind === "hist").data;
const n5 = h5.length;
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
// Last 5-minute bar CLOSED at or before each 1-minute index. Anything later
// would be reading a bar that has not finished.
const known5 = new Int32Array(n).fill(-1);
{
  let k = 0, cur = -1;
  for (let i = 0; i < n; i++) {
    while (k < n5 && tf5.srcLast[k] <= i) { cur = k; k++; }
    known5[i] = cur;
  }
}
// 5-minute histogram and scale, projected onto 1-minute indices by knowability.
const h5at = new Float64Array(n).fill(NaN), sc5at = new Float64Array(n).fill(NaN);
for (let i = 0; i < n; i++) {
  const k = known5[i];
  if (k >= 0) { h5at[i] = h5[k]; sc5at[i] = sc5[k]; }
}

// The quiet gate, as shipped.
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

const ATR1 = atr(bars.high, bars.low, bars.close, 14);

// exitMode: "cross1" flip on the opposite 1-minute cross (engine default),
// "cross5" hold until the 5-minute histogram flips to the trade's side,
// "bracket" let the ATR stop and target do it.
function build({ prox, useQuiet, exitMode }) {
  return {
    ...flip,
    id: "_lead_probe",
    timeframeMin: 1,
    warmupBars: 2000,
    compute(b, p) {
      const out = flip.compute(b, p);
      const sig = new Int8Array(n);
      for (let i = 1; i < n; i++) {
        const d = cross1[i];
        if (!d) continue;
        const hv = h5at[i], sv = sc5at[i];
        if (!Number.isFinite(hv) || !Number.isFinite(sv) || sv <= 0) continue;
        if ((hv >= 0 ? 1 : -1) === d) continue;          // 5m already crossed: skip
        if (!(Math.abs(hv) < prox * sv)) continue;       // 5m must be near zero
        if (useQuiet && !quiet(i)) continue;
        sig[i] = d;
      }
      let exitSig = null;
      if (exitMode === "cross5") {
        // Leave once the 5-minute histogram has come round to the trade's side:
        // the predicted event has happened and the reason to be in is spent.
        exitSig = new Int8Array(n);
        for (let i = 0; i < n; i++) {
          const hv = h5at[i];
          if (!Number.isFinite(hv)) continue;
          if (hv >= 0) exitSig[i] |= 1; else exitSig[i] |= 2;
        }
      }
      return { ...out, sig, exitSig, atr: ATR1 };
    },
  };
}

function go(lab, opts, exec) {
  const s = build(opts);
  const base = {
    contracts: 8, sizingMode: "fixed", slAtrMult: 1000, tpMode: "atr", tpAtrMult: 1000,
    flipOnOpposite: opts.exitMode === "cross1", sameBarReentry: false, maxBarsInTrade: 0,
    intradayOnly: false, commissionModel: "per-contract", commissionPerSide: 0.75,
    slippageTicks: 0, dayProfitStopUsd: 0, dayLossStopUsd: 0,
    cooldownAfterStopMins: 0, noEntryMinsBeforeFlat: 0, scaleInFrac: 0,
  };
  const tr = runStrategy(bars, s, resolveParams(flip), { ...base, ...(exec || {}) }).trades || [];
  if (tr.length < 50) { console.log("  " + lab.padEnd(30) + "  (too few trades)"); return; }
  const pnl = tr.map((t) => t.pnl);
  let eq = 0, pk = 0, dd = 0;
  for (const v of pnl) { eq += v; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq; }
  const sw = sweepWindows(tr, T0, T1, RULES, 1);
  const pass = sw.passRate != null ? sw.passRate
    : (100 * sw.windows.filter((w) => w.outcome === "PASS").length) / sw.windows.length;
  const t0 = tr[0].entryTime, mid = t0 + (tr[tr.length - 1].entryTime - t0) / 2;
  console.log("  " + lab.padEnd(30) + String(tr.length).padStart(7) +
    ("$" + Math.round(pnl.reduce((a, b) => a + b, 0)).toLocaleString()).padStart(12) +
    ("$" + avg(pnl).toFixed(2)).padStart(10) +
    ((100 * pnl.filter((x) => x > 0).length) / tr.length).toFixed(1).padStart(7) +
    avg(tr.map((t) => t.bars)).toFixed(0).padStart(6) +
    ("$" + Math.round(dd).toLocaleString()).padStart(11) + pass.toFixed(1).padStart(7) +
    ("$" + avg(tr.filter((t) => t.entryTime < mid).map((t) => t.pnl)).toFixed(2) + " / $" +
      avg(tr.filter((t) => t.entryTime >= mid).map((t) => t.pnl)).toFixed(2)).padStart(20));
}

const HEAD = "  variant                        trades     total $     avg $   win%  hold     max DD   pass%    1st / 2nd half";
const SEP = "  " + "-".repeat(112);
console.log("");
console.log("=".repeat(116));
console.log("DOES THE LEAD CONVERT?   1-min cross taken only when the 5-min hist is opposite and near zero");
console.log("=".repeat(116));
console.log("");
console.log(HEAD);
console.log(SEP);

// Reference.
{
  const tr = runStrategy(bars, REF, resolveParams(REF), REF.execDefaults).trades || [];
  const pnl = tr.map((t) => t.pnl);
  let eq = 0, pk = 0, dd = 0;
  for (const v of pnl) { eq += v; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq; }
  const sw = sweepWindows(tr, T0, T1, REF.rulesDefaults || {}, 1);
  const pass = sw.passRate != null ? sw.passRate
    : (100 * sw.windows.filter((w) => w.outcome === "PASS").length) / sw.windows.length;
  const t0 = tr[0].entryTime, mid = t0 + (tr[tr.length - 1].entryTime - t0) / 2;
  console.log("  " + "REFERENCE: 5m quiet antic.".padEnd(30) + String(tr.length).padStart(7) +
    ("$" + Math.round(pnl.reduce((a, b) => a + b, 0)).toLocaleString()).padStart(12) +
    ("$" + avg(pnl).toFixed(2)).padStart(10) +
    ((100 * pnl.filter((x) => x > 0).length) / tr.length).toFixed(1).padStart(7) +
    avg(tr.map((t) => t.bars)).toFixed(0).padStart(6) +
    ("$" + Math.round(dd).toLocaleString()).padStart(11) + pass.toFixed(1).padStart(7) +
    ("$" + avg(tr.filter((t) => t.entryTime < mid).map((t) => t.pnl)).toFixed(2) + " / $" +
      avg(tr.filter((t) => t.entryTime >= mid).map((t) => t.pnl)).toFixed(2)).padStart(20));
}

console.log("");
console.log("  exit on the opposite 1-minute cross");
console.log(SEP);
for (const px of [0.10, 0.25]) {
  go("prox " + px + ", gate on", { prox: px, useQuiet: true, exitMode: "cross1" });
  go("prox " + px + ", gate off", { prox: px, useQuiet: false, exitMode: "cross1" });
}
console.log("");
console.log("  exit when the 5-minute histogram comes round (the predicted event)");
console.log(SEP);
for (const px of [0.10, 0.25]) {
  go("prox " + px + ", gate on", { prox: px, useQuiet: true, exitMode: "cross5" });
  go("prox " + px + ", gate off", { prox: px, useQuiet: false, exitMode: "cross5" });
}
console.log("");
console.log("  ATR bracket, gate on, prox 0.10");
console.log(SEP);
for (const [sl, tp] of [[1, 2], [2, 3], [2, 6], [3, 3], [4, 8]])
  go("sl " + sl + "x / tp " + tp + "x", { prox: 0.10, useQuiet: true, exitMode: "bracket" },
    { slAtrMult: sl, tpAtrMult: tp, flipOnOpposite: false });
console.log("");
console.log("  Reference passes 25.8%; the live Donchian+ORB bot about 51%.");
console.log("");
