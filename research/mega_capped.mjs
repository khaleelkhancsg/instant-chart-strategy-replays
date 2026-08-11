// Large random search for anything that beats the shipped config, with the hard
// -$1000 platform stop permanently in force.
//
// ── THE PROBLEM THIS SCRIPT IS DESIGNED AROUND ───────────────────────
// Searching 150,000 configurations and reporting the best one is guaranteed to
// produce a number that does not survive. A 30-day pass rate over 2,598 rolling
// windows has only ~87 independent samples, so its standard error is about 5
// points. The maximum of 150,000 draws from that noise sits roughly 4.5 standard
// errors above the truth — a config that genuinely scores 30% will show up at
// 52% somewhere in the search, purely by chance, and it will look like a
// discovery.
//
// So the search NEVER reports its own maximum as a result. It:
//   1. ranks candidates on IN-SAMPLE windows only (before 2023-06-01),
//   2. reports the OUT-OF-SAMPLE score of the in-sample winners,
//   3. prints the SHRINKAGE between the two, which is the direct measure of how
//      much of the in-sample result was noise,
//   4. and compares against the shipped configuration on the same out-of-sample
//      set, since beating the incumbent out-of-sample is the only claim worth
//      making.
//
// Sampling is random over the whole space rather than a grid, which covers
// high-dimensional spaces far better for the same budget. Samples are sorted by
// their signal/filter key so the expensive indicator work is computed once per
// distinct key and reused.
//
// Usage:  node research/mega_capped.mjs [N]

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts, DAY } from "./lib_search.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const N = Number(process.argv[2]) || 150_000;
const CAP = 1000, TICKS = 1;
const SPLIT = Date.UTC(2023, 5, 1);

const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const S = (await loadStrategies()).get("donchian_eff_rth");

// ── window sets ──────────────────────────────────────────────────────
const allStarts = windowStarts(bars, 30, 1);
const IS = allStarts.filter((t) => t < SPLIT);
const OOS = allStarts.filter((t) => t >= SPLIT);
// regime split, for the second ranking
const A14 = atr(tf.high, tf.low, tf.close, 14);
const dayAtr = new Map();
for (let i = 900; i < A14.length; i++) {
  const c = tf.ctMin[i];
  if (c < 510 || c >= 900 || !(A14[i] > 0)) continue;
  const d = Math.floor(tf.ts[i] / DAY);
  if (!dayAtr.has(d)) dayAtr.set(d, []);
  dayAtr.get(d).push(A14[i]);
}
const med = (v) => { v.sort((a, b) => a - b); return v[v.length >> 1]; };
const perDay = new Map([...dayAtr].map(([d, v]) => [d, med(v)]));
const winAtr = new Map();
for (const s of allStarts) {
  const d0 = Math.floor(s / DAY), v = [];
  for (let d = d0; d < d0 + 30; d++) if (perDay.has(d)) v.push(perDay.get(d));
  if (v.length >= 15) winAtr.set(s, med(v));
}
const withAtr = allStarts.filter((s) => winAtr.has(s));
const hiCut = withAtr.map((s) => winAtr.get(s)).sort((a, b) => a - b)[Math.floor(withAtr.length * 0.7)];
const HI = withAtr.filter((s) => winAtr.get(s) > hiCut);
const HI_MID = HI[Math.floor(HI.length / 2)];
const HI_EARLY = HI.filter((s) => s < HI_MID), HI_LATE = HI.filter((s) => s >= HI_MID);

console.log(`\n  ${allStarts.length} windows  |  IS ${IS.length} / OOS ${OOS.length}`);
console.log(`  high-vol ${HI.length} (ATR>${hiCut.toFixed(1)}), early ${HI_EARLY.length} / late ${HI_LATE.length}`);
console.log(`  noise floor on a pass rate: ~${(100 * Math.sqrt(0.35 * 0.65 / (allStarts.length / 30))).toFixed(1)}pp (1 se, all windows)\n`);

// ── search space ─────────────────────────────────────────────────────
const SPACE = {
  period:      [10, 15, 20, 25, 30, 40, 50, 60, 80],
  adxPeriod:   [7, 14, 21],
  adxMin:      [0, 15, 20, 25, 30, 35],
  effMin:      [0, 0.3, 0.4, 0.5, 0.6],
  startCt:     [8 * 60 + 30, 9 * 60, 9 * 60 + 30, 10 * 60],
  endCt:       [13 * 60, 14 * 60, 14 * 60 + 30, 15 * 60],
  contracts:   [6, 7, 8, 9, 10],
  slAtrMult:   [3, 4, 5, 6, 7],
  tpAtrMult:   [1.0, 1.25, 1.5, 1.75, 2.0, 2.5],
  maxBarsInTrade: [0, 30, 60, 120],
  flipOnOpposite: [true, false],
  noEntryMinsBeforeFlat: [0, 10, 20],
  circuitBreaker: [0, 300, 500, 750, 1000],
  dailyProfitStop: [500, 750, 1000, 1250],
};
const totalSpace = Object.values(SPACE).reduce((a, v) => a * v.length, 1);
console.log(`  space ${totalSpace.toLocaleString()} configurations, sampling ${N.toLocaleString()}\n`);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260811);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const samples = [];
const seen = new Set();
while (samples.length < N) {
  const c = {};
  for (const k of Object.keys(SPACE)) c[k] = pick(SPACE[k]);
  const key = Object.values(c).join("|");
  if (seen.has(key)) continue;
  seen.add(key);
  c._sig = `${c.period}|${c.adxPeriod}|${c.adxMin}`;
  c._flt = `${c._sig}|${c.effMin}|${c.startCt}|${c.endCt}`;
  samples.push(c);
}
// sort so indicator work is done once per distinct key
samples.sort((a, b) => (a._flt < b._flt ? -1 : a._flt > b._flt ? 1 : 0));

// ── evaluate ─────────────────────────────────────────────────────────
const atrCache = new Map();
const getAtr = (p) => { if (!atrCache.has(p)) atrCache.set(p, atr(tf.high, tf.low, tf.close, p)); return atrCache.get(p); };
const A = getAtr(14);

let curSigKey = null, rawSig = null;
let curFltKey = null, mask = null;
const results = [];
const t0 = Date.now();

for (let i = 0; i < samples.length; i++) {
  const c = samples[i];
  if (c._sig !== curSigKey) {
    const { adx: ax } = adx(tf.high, tf.low, tf.close, c.adxPeriod);
    const { high: dh, low: dl } = donchian(tf.high, tf.low, c.period);
    rawSig = new Int8Array(tf.close.length);
    for (let j = c.period; j < rawSig.length; j++) {
      if (ax[j] < c.adxMin) continue;
      if (tf.close[j] > dh[j]) rawSig[j] = 1;
      else if (tf.close[j] < dl[j]) rawSig[j] = -1;
    }
    curSigKey = c._sig; curFltKey = null;
  }
  if (c._flt !== curFltKey) {
    mask = applyFilters(rawSig, ctx, { ...NO_FILTER, startCt: c.startCt, endCt: c.endCt, effMin: c.effMin });
    curFltKey = c._flt;
  }
  const x = resolveExec({
    ...S.execDefaults, contracts: c.contracts, slAtrMult: c.slAtrMult, tpAtrMult: c.tpAtrMult,
    tpMode: "atr", maxBarsInTrade: c.maxBarsInTrade, flipOnOpposite: c.flipOnOpposite,
    noEntryMinsBeforeFlat: c.noEntryMinsBeforeFlat, slippageTicks: TICKS, dayLossStopUsd: CAP,
  });
  const { trades } = runBrackets(tf, mask, A, x);
  if (trades.length < 400) continue;                 // too thin to sweep meaningfully
  const rules = resolveRules({ circuitBreaker: c.circuitBreaker, dailyProfitStop: c.dailyProfitStop });
  const T = flatten(trades);
  const is = fastSweep(T, IS, rules, 1).pass;
  const st = tradeStats(trades);
  if (st.profitFactor <= 1.0) continue;              // must at least make money
  results.push({ c, is, st, T, rules });
  if (i % 20000 === 0 && i) {
    const pct = ((100 * i) / samples.length).toFixed(0);
    const eta = ((Date.now() - t0) / i) * (samples.length - i) / 1000;
    console.log(`  ${pct}%  ${results.length.toLocaleString()} viable, eta ${(eta / 60).toFixed(1)} min`);
  }
}
console.log(`\n  evaluated ${samples.length.toLocaleString()} in ${((Date.now() - t0) / 60000).toFixed(1)} min, ` +
            `${results.length.toLocaleString()} viable (pf>1, >=400 trades)\n`);

// ── the shipped incumbent, on identical footing ──────────────────────
function evalCfg(c) {
  const { adx: ax } = adx(tf.high, tf.low, tf.close, c.adxPeriod);
  const { high: dh, low: dl } = donchian(tf.high, tf.low, c.period);
  const rs = new Int8Array(tf.close.length);
  for (let j = c.period; j < rs.length; j++) {
    if (ax[j] < c.adxMin) continue;
    if (tf.close[j] > dh[j]) rs[j] = 1; else if (tf.close[j] < dl[j]) rs[j] = -1;
  }
  const m = applyFilters(rs, ctx, { ...NO_FILTER, startCt: c.startCt, endCt: c.endCt, effMin: c.effMin });
  const x = resolveExec({ ...S.execDefaults, contracts: c.contracts, slAtrMult: c.slAtrMult,
    tpAtrMult: c.tpAtrMult, tpMode: "atr", maxBarsInTrade: c.maxBarsInTrade,
    flipOnOpposite: c.flipOnOpposite, noEntryMinsBeforeFlat: c.noEntryMinsBeforeFlat,
    slippageTicks: TICKS, dayLossStopUsd: CAP });
  const { trades } = runBrackets(tf, m, A, x);
  const rules = resolveRules({ circuitBreaker: c.circuitBreaker, dailyProfitStop: c.dailyProfitStop });
  const T = flatten(trades);
  return { T, rules, st: tradeStats(trades) };
}
const SHIPPED = { period: 30, adxPeriod: 14, adxMin: 25, effMin: 0.5, startCt: 510, endCt: 900,
  contracts: 8, slAtrMult: 5, tpAtrMult: 1.75, maxBarsInTrade: 0, flipOnOpposite: true,
  noEntryMinsBeforeFlat: 10, circuitBreaker: 500, dailyProfitStop: 750 };
const inc = evalCfg(SHIPPED);
const incIS = fastSweep(inc.T, IS, inc.rules, 1).pass;
const incOOS = fastSweep(inc.T, OOS, inc.rules, 1).pass;
const incHiE = fastSweep(inc.T, HI_EARLY, inc.rules, 1).pass;
const incHiL = fastSweep(inc.T, HI_LATE, inc.rules, 1).pass;
console.log(`  INCUMBENT (shipped)   IS ${incIS.toFixed(1)}%  OOS ${incOOS.toFixed(1)}%  ` +
            `hiEarly ${incHiE.toFixed(1)}%  hiLate ${incHiL.toFixed(1)}%  pf ${inc.st.profitFactor.toFixed(3)}\n`);

// ── selection on IS, honest reporting on OOS ─────────────────────────
results.sort((a, b) => b.is - a.is);
const TOPN = 25;
console.log(`  TOP ${TOPN} BY IN-SAMPLE, with their OUT-OF-SAMPLE beside it`);
console.log(`  (the IS column is the number the search "found"; the OOS column is what it is worth)\n`);
console.log("   IS%    OOS%   shrink   hiLate%   pf     trades  per adx eff  sess       lots sl/tp   flip tstop  brk/blk");
let sumIS = 0, sumOOS = 0, beat = 0;
for (const r of results.slice(0, TOPN)) {
  const oos = fastSweep(r.T, OOS, r.rules, 1).pass;
  const hl = fastSweep(r.T, HI_LATE, r.rules, 1).pass;
  sumIS += r.is; sumOOS += oos;
  if (oos > incOOS) beat++;
  const c = r.c;
  console.log(
    `  ${r.is.toFixed(1).padStart(5)}  ${oos.toFixed(1).padStart(5)}  ${(oos - r.is).toFixed(1).padStart(6)}  ` +
    `${hl.toFixed(1).padStart(7)}  ${r.st.profitFactor.toFixed(3)}  ${String(r.st.n).padStart(6)}  ` +
    `${String(c.period).padStart(3)} ${String(c.adxMin).padStart(3)} ${c.effMin.toFixed(1)} ` +
    `${String(c.startCt).padStart(4)}-${c.endCt} ${String(c.contracts).padStart(4)} ${c.slAtrMult}/${c.tpAtrMult} ` +
    `${(c.flipOnOpposite ? "Y" : "n").padStart(5)} ${String(c.maxBarsInTrade).padStart(5)}  ${c.circuitBreaker}/${c.dailyProfitStop}`
  );
}
console.log(`\n  mean IS of the top ${TOPN}: ${(sumIS / TOPN).toFixed(1)}%`);
console.log(`  mean OOS of the same:      ${(sumOOS / TOPN).toFixed(1)}%   SHRINKAGE ${((sumOOS - sumIS) / TOPN).toFixed(1)}pp`);
console.log(`  that shrinkage IS the overfitting, measured directly.`);
// Binomial check, because "more than half" is not a result. Under the null that
// these configs are interchangeable with the incumbent, `beat` is Binomial(N, 0.5):
// mean N/2, sd sqrt(N)/2. Anything inside about 2 sd is chance.
const bMean = TOPN / 2, bSd = Math.sqrt(TOPN) / 2;
const bZ = (beat - bMean) / bSd;
console.log(`  ${beat} of ${TOPN} beat the incumbent's ${incOOS.toFixed(1)}% out-of-sample ` +
            `— ${bZ.toFixed(1)} sd above the ${bMean} chance would give ` +
            `(${Math.abs(bZ) < 2 ? "NOT significant" : "significant"}).`);

// ── second ranking: select on high-vol EARLY, report high-vol LATE ───
console.log(`\n\n  SAME DISCIPLINE ON THE REGIME SPLIT: select on high-vol EARLY, report LATE\n`);
for (const r of results) r.hiE = fastSweep(r.T, HI_EARLY, r.rules, 1).pass;
results.sort((a, b) => b.hiE - a.hiE);
console.log("   early%  late%   shrink   pf     trades   per adx eff  sess       lots sl/tp");
let sE = 0, sL = 0, beatL = 0;
for (const r of results.slice(0, TOPN)) {
  const late = fastSweep(r.T, HI_LATE, r.rules, 1).pass;
  sE += r.hiE; sL += late;
  if (late > incHiL) beatL++;
  const c = r.c;
  console.log(
    `  ${r.hiE.toFixed(1).padStart(6)}  ${late.toFixed(1).padStart(5)}  ${(late - r.hiE).toFixed(1).padStart(6)}  ` +
    `${r.st.profitFactor.toFixed(3)}  ${String(r.st.n).padStart(6)}   ${String(c.period).padStart(3)} ` +
    `${String(c.adxMin).padStart(3)} ${c.effMin.toFixed(1)} ${String(c.startCt).padStart(4)}-${c.endCt} ` +
    `${String(c.contracts).padStart(4)} ${c.slAtrMult}/${c.tpAtrMult}`
  );
}
console.log(`\n  mean early ${(sE / TOPN).toFixed(1)}%  ->  mean late ${(sL / TOPN).toFixed(1)}%   ` +
            `SHRINKAGE ${((sL - sE) / TOPN).toFixed(1)}pp`);
console.log(`  ${beatL} of ${TOPN} beat the incumbent's ${incHiL.toFixed(1)}% on the late half.`);
