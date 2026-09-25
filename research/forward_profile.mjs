// Where does the move actually peak after the entry? Stop guessing exits.
//
// Fair criticism of everything measured so far: every exit tried either cut the
// trade AT the 5-minute cross (research/lead_entry_pnl.mjs "comes round") or
// bracketed it with 1-minute ATR. Both assume the move ends when the MACD turns.
// If it keeps running, those exits measure the wrong thing and the conclusion
// "the prediction does not convert" is about the exit, not the signal.
//
// So this measures no exit at all. It takes the entry -- a 1-minute MACD cross
// where the 5-minute histogram is still OPPOSITE and near zero, which converts
// to a 5-minute cross 74.1% of the time -- and follows the price forward for
// eight hours, reporting:
//
//   MEAN and MEDIAN return at each horizon, so the peak is visible
//   MFE / MAE, the best and worst the trade ever gets to, which is what a
//       target or a trailing stop would actually be able to capture
//   the path measured FROM THE CROSS rather than from entry, which is the
//       specific claim: that the move continues after the MACD turns
//
// Overlapping independent signals, not a tradeable sequence. Points are gross;
// at 8 lots a point is $16 and the round trip is $12, so subtract 0.75 points
// from anything before believing it.
//
//   node research/forward_profile.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { resolveParams } from "../src/run.mjs";
import flip from "../strategies/macd_1m_flip.mjs";

const { bars } = loadBars();
const O = bars.open, H = bars.high, L = bars.low, C = bars.close;
const n = C.length;
const MID = Math.floor(n / 2);
const SCALE = 200;

const P = resolveParams(flip);
const o1 = flip.compute(bars, P);
const h1 = o1.overlays.find((o) => o.kind === "hist").data;
const cross1 = o1.sig;
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
// 1-minute index at which the 5-minute histogram next reaches side d.
const nextSide = { 1: new Int32Array(n).fill(-1), "-1": new Int32Array(n).fill(-1) };
{
  let up = -1, dn = -1;
  for (let i = n - 1; i >= 0; i--) {
    const v = h5at[i];
    if (Number.isFinite(v)) { if (v >= 0) up = i; else dn = i; }
    nextSide[1][i] = up; nextSide["-1"][i] = dn;
  }
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
    if (H[i] > dHi) dHi = H[i];
    if (L[i] < dLo) dLo = L[i];
    if (Number.isFinite(adr) && adr > 0) adrUsed[i] = (dHi - dLo) / adr;
  }
}
const quiet = (i) => {
  const c = bars.ctMin[i];
  return (c < 510 || c >= 900) && Number.isFinite(adrUsed[i]) && adrUsed[i] < 0.5;
};

function entries(prox, useQuiet) {
  const out = [];
  for (let i = 1; i < n - 500; i++) {
    const d = cross1[i];
    if (!d) continue;
    const hv = h5at[i], sv = sc5at[i];
    if (!Number.isFinite(hv) || !Number.isFinite(sv) || sv <= 0) continue;
    if ((hv >= 0 ? 1 : -1) === d) continue;
    if (!(Math.abs(hv) < prox * sv)) continue;
    if (useQuiet && !quiet(i)) continue;
    out.push({ i: i + 1, d, crossAt: nextSide[d][i] });   // fill at O[i+1]
  }
  return out;
}

const HOR = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 360, 480];
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

function profile(es) {
  const res = HOR.map(() => ({ r: [], mfe: [], mae: [], h1: [], h2: [] }));
  for (const e of es) {
    const p0 = O[e.i];
    if (!Number.isFinite(p0)) continue;
    let best = -Infinity, worst = Infinity;
    let hi = 0;
    for (let k = 0; k < HOR.length; k++) {
      const end = e.i + HOR[k];
      if (end >= n) break;
      for (; hi < HOR[k]; hi++) {
        const j = e.i + hi;
        const up = (H[j] - p0) * e.d, dn = (L[j] - p0) * e.d;
        if (up > best) best = up;
        if (dn < worst) worst = dn;
      }
      const r = (C[end] - p0) * e.d;
      res[k].r.push(r); res[k].mfe.push(best); res[k].mae.push(worst);
      (e.i < MID ? res[k].h1 : res[k].h2).push(r);
    }
  }
  return res;
}

function show(title, es) {
  const pr = profile(es);
  console.log("");
  console.log("  " + title + "   (" + es.length.toLocaleString() + " signals)");
  console.log("    mins   trades   mean pts   median   win%     MFE     MAE    1st / 2nd half");
  console.log("    " + "-".repeat(80));
  for (let k = 0; k < HOR.length; k++) {
    const g = pr[k];
    if (g.r.length < 200) continue;
    console.log("    " + String(HOR[k]).padStart(4) + g.r.length.toLocaleString().padStart(9) +
      avg(g.r).toFixed(2).padStart(11) + med(g.r).toFixed(2).padStart(9) +
      ((100 * g.r.filter((x) => x > 0).length) / g.r.length).toFixed(1).padStart(7) +
      avg(g.mfe).toFixed(1).padStart(8) + avg(g.mae).toFixed(1).padStart(8) +
      (avg(g.h1).toFixed(2) + " / " + avg(g.h2).toFixed(2)).padStart(18));
  }
}

console.log("");
console.log("=".repeat(96));
console.log("FORWARD PROFILE -- no exit at all, just where the move goes after the entry");
console.log("=".repeat(96));
console.log("");
console.log("  Entry: 1-min MACD cross while the 5-min histogram is still OPPOSITE and near zero.");
console.log("  Gross points. At 8 lots a point is $16 and the round trip is 0.75 points.");

show("prox 0.10, quiet gate ON", entries(0.10, true));
show("prox 0.10, gate off", entries(0.10, false));
show("prox 0.25, quiet gate ON", entries(0.25, true));

// ── the specific claim: does the move continue AFTER the cross? ─────────
console.log("");
console.log("=".repeat(96));
console.log("DOES THE MOVE CONTINUE AFTER THE 5-MINUTE CROSS?");
console.log("=".repeat(96));
const es = entries(0.10, true);
const withCross = es.filter((e) => e.crossAt >= 0 && e.crossAt > e.i && e.crossAt + 480 < n);
console.log("");
console.log("  " + withCross.length.toLocaleString() + " of " + es.length.toLocaleString() +
  " signals saw the 5-minute histogram come round; measured from THAT bar onward.");
console.log("");
console.log("    mins    mean pts   median   win%     MFE     MAE     (from the cross, not entry)");
console.log("    " + "-".repeat(78));
for (const hz of HOR) {
  const r = [], mfe = [], mae = [];
  for (const e of withCross) {
    // FILL AT crossAt + 1, NOT crossAt. crossAt is the last 1-minute bar of the
    // 5-minute bar whose CLOSE produced the cross, so its OPEN is a price from
    // before the signal existed. Measuring from it was a one-bar lookahead worth
    // a flat ~0.95 points at every horizon -- which was the entire apparent
    // post-cross momentum. The first tradeable fill is the next bar's open.
    const s = e.crossAt + 1, end = s + hz;
    if (end >= n) continue;
    const p0 = O[s];
    if (!Number.isFinite(p0)) continue;
    let best = -Infinity, worst = Infinity;
    for (let j = s; j <= end; j++) {
      const up = (H[j] - p0) * e.d, dn = (L[j] - p0) * e.d;
      if (up > best) best = up;
      if (dn < worst) worst = dn;
    }
    r.push((C[end] - p0) * e.d); mfe.push(best); mae.push(worst);
  }
  if (r.length < 200) continue;
  console.log("    " + String(hz).padStart(4) + avg(r).toFixed(2).padStart(12) +
    med(r).toFixed(2).padStart(9) +
    ((100 * r.filter((x) => x > 0).length) / r.length).toFixed(1).padStart(7) +
    avg(mfe).toFixed(1).padStart(8) + avg(mae).toFixed(1).padStart(8));
}
console.log("");
console.log("  Measured at the first tradeable fill, the post-cross mean is flat: between -0.22");
console.log("  and +0.12 out to two hours, then negative. There is no continuation to hold for.");
console.log("  research/momentum_exit_sweep.mjs confirms it independently -- every exit loses.");
console.log("");
