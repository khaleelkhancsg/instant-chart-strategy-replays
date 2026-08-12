// MACD-Angle v4 against the shipped Donchian book, both under the hard -$1000 cap.
//
// FAIRNESS MATTERS MORE THAN THE ANSWER HERE. macd_angle_v4 ships at ONE contract
// because its own research found sizing up overfit; against a fixed $3,000 target
// on a 30-day deadline that scores near zero, and quoting it would be a rigged
// comparison. So the MACD signal is given the same envelope the Donchian book
// gets — legal size, the same cap, the same rules grid — and the same freedom to
// re-tune geometry. If its signal is better, that is where it shows.
//
// And it gets the same DISCIPLINE, which matters just as much: every candidate is
// selected on high-volatility EARLY windows and reported on LATE, so a re-tuned
// MACD cannot win on a number the Donchian book was never allowed to quote.
//
// Background worth carrying: this strategy's ~85% headline in the other repo came
// from a non-causal evaluator that re-entered on the same bar as an exit. 91% of
// its trades were such re-entries, contributing $357,338 while every other trade
// summed to -$13,932. Run causally it was pf 0.939. The SIGNAL port into this repo
// was verified exact against that source, so what follows is the honest version of
// the same idea, not a different one.
//
// Usage:  node research/macd_vs_donchian.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts, DAY } from "./lib_search.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";
import { resolveParams } from "../src/run.mjs";

const CAP = 1000, TICKS = 1;
const SPLIT = Date.UTC(2023, 5, 1);
const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const strategies = await loadStrategies();
const DON = strategies.get("donchian_eff_rth");
const MACD = strategies.get("macd_angle_v4");

// ── window sets ──────────────────────────────────────────────────────
const allStarts = windowStarts(bars, 30, 1);
const IS = allStarts.filter((t) => t < SPLIT), OOS = allStarts.filter((t) => t >= SPLIT);
const dayAtr = new Map();
for (let i = 900; i < A.length; i++) {
  const c = tf.ctMin[i];
  if (c < 510 || c >= 900 || !(A[i] > 0)) continue;
  const d = Math.floor(tf.ts[i] / DAY);
  if (!dayAtr.has(d)) dayAtr.set(d, []);
  dayAtr.get(d).push(A[i]);
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
const cut = withAtr.map((s) => winAtr.get(s)).sort((a, b) => a - b)[Math.floor(withAtr.length * 0.7)];
const HI = withAtr.filter((s) => winAtr.get(s) > cut);
const HM = HI[Math.floor(HI.length / 2)];
const HE = HI.filter((s) => s < HM), HL = HI.filter((s) => s >= HM);
const Y26 = withAtr.filter((s) => new Date(s).getUTCFullYear() === 2026);

// ── signals ──────────────────────────────────────────────────────────
const macdOut = MACD.compute(tf, resolveParams(MACD, {}));
const macdSig = applyFilters(macdOut.sig, ctx, { ...NO_FILTER, ...(MACD.filterDefaults || {}) });
const macdSigDonGate = applyFilters(macdOut.sig, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });

const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const dRaw = new Int8Array(tf.close.length);
for (let i = 30; i < dRaw.length; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) dRaw[i] = 1; else if (tf.close[i] < dl[i]) dRaw[i] = -1;
}
const donSig = applyFilters(dRaw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });

function ev(sig, atrArr, exec, ruleOver, capOn = true) {
  const x = resolveExec({ ...exec, slippageTicks: TICKS, dayLossStopUsd: capOn ? CAP : 0 });
  const { trades } = runBrackets(tf, sig, atrArr, x);
  if (trades.length < 200) return null;
  const rules = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750, ...ruleOver });
  const T = flatten(trades);
  return {
    is: fastSweep(T, IS, rules, 1).pass, oos: fastSweep(T, OOS, rules, 1).pass,
    he: fastSweep(T, HE, rules, 1).pass, hl: fastSweep(T, HL, rules, 1).pass,
    all: fastSweep(T, withAtr, rules, 1).pass, y26: fastSweep(T, Y26, rules, 1).pass,
    st: tradeStats(trades), exec: x, ruleOver,
  };
}
const row = (n, r) => console.log(
  `  ${n.padEnd(34)} ${r.all.toFixed(1).padStart(5)}% ${r.he.toFixed(1).padStart(6)}% ${r.hl.toFixed(1).padStart(6)}% ` +
  `${r.y26.toFixed(1).padStart(6)}% ${r.st.winRate.toFixed(1).padStart(5)} ${r.st.profitFactor.toFixed(3)} ` +
  `${("$" + Math.round(r.st.pnl).toLocaleString()).padStart(10)} ${String(r.st.n).padStart(6)}`);

console.log(`\n  All rows: hard -$${CAP} cap ON, ${TICKS} tick, breaker -$500 / block $750 unless noted.`);
console.log(`  hiLate is the load-bearing column — out-of-sample for every tuning decision.\n`);
console.log("  configuration                        all   hiEarly hiLate   2026   win%    pf      net$   trades");
console.log("  " + "-".repeat(104));

const donShipped = ev(donSig, A, { ...DON.execDefaults, contracts: 8, slAtrMult: 5, tpAtrMult: 1.75 }, {});
row("DONCHIAN shipped (8L, 5/1.75)", donShipped);

// MACD exactly as it ships — 1 contract, its own geometry and gate.
const macdShipped = ev(macdSig, macdOut.atr, { ...MACD.execDefaults }, {});
if (macdShipped) row("MACD as shipped (1 lot)", macdShipped);
console.log();

// MACD at legal size, own geometry.
for (const c of [4, 6, 8, 10]) {
  const r = ev(macdSig, macdOut.atr, { ...MACD.execDefaults, contracts: c }, {});
  if (r) row(`MACD own geometry, ${c} lots`, r);
}
console.log();

// MACD re-tuned: same freedom the Donchian book got. Selected on hi-vol EARLY.
console.log("  MACD re-tuned — sweeping size, geometry, gate and rules, SELECTED ON hiEarly:\n");
let best = null, tried = 0;
for (const gate of [0, 1]) {
  const sg = gate ? macdSigDonGate : macdSig;
  for (const c of [5, 6, 7, 8, 9, 10]) {
    for (const sl of [1.5, 2.5, 3.5, 5, 7]) {
      for (const tp of [0.8, 1.2, 1.75, 2.5]) {
        for (const mode of ["atr", "rr"]) {
          for (const brk of [300, 500, 750]) {
            for (const blk of [750, 1000]) {
              const r = ev(sg, macdOut.atr, {
                ...MACD.execDefaults, contracts: c, slAtrMult: sl,
                tpMode: mode, tpAtrMult: tp, tpRR: tp,
              }, { circuitBreaker: brk, dailyProfitStop: blk });
              tried++;
              if (r && r.st.profitFactor > 1.0 && (!best || r.he > best.he)) { best = r; best._g = gate; }
            }
          }
        }
      }
    }
  }
}
console.log(`  (${tried.toLocaleString()} MACD configurations evaluated)\n`);
if (best) {
  row(`MACD best-on-hiEarly, ${best.exec.contracts}L ${best.exec.slAtrMult}/${best.exec.tpMode === "rr" ? best.exec.tpRR + "R" : best.exec.tpAtrMult}`, best);
  console.log(`    gate: ${best._g ? "Donchian's RTH+eff gate" : "its own"}, ` +
              `breaker -$${best.ruleOver.circuitBreaker} / block $${best.ruleOver.dailyProfitStop}`);
  console.log(`    selected on hiEarly ${best.he.toFixed(1)}% -> delivers hiLate ${best.hl.toFixed(1)}%  ` +
              `(shrinkage ${(best.hl - best.he).toFixed(1)}pp)`);
}

console.log(`\n  Donchian for the same comparison: hiEarly ${donShipped.he.toFixed(1)}% -> hiLate ${donShipped.hl.toFixed(1)}% ` +
            `(shrinkage ${(donShipped.hl - donShipped.he).toFixed(1)}pp)`);
console.log(`\n  VERDICT on hiLate, the only column neither book was tuned on:`);
console.log(`    Donchian ${donShipped.hl.toFixed(1)}%   MACD ${best ? best.hl.toFixed(1) + "%" : "n/a"}`);

// ── the ACTUAL live bot config, not the 2-min v4 port ────────────────
// Desktop\EMA bot\mnq_macd_bot_v2.py runs something different from v4: 1-MINUTE
// bars, period sets (8,21,5)(12,26,9)(19,39,9)(26,52,18), invert_signal TRUE so it
// trades the OPPOSITE of the burst, SL 1.8xATR / TP 1.0R, no flips, a 60-minute
// same-direction block after a losing exit, entries from 10:30 ET.
//
// This reconstructs that in this repo's framework. It is NOT a verified port the
// way the v4 signal was — the slope definition, the union/conflict rule and the
// separate signal-vs-entry windows could differ in detail. Treat it as strong
// convergent evidence rather than proof, and note the v4 port that WAS verified
// exact reaches the same conclusion.
console.log("

  THE ACTUAL LIVE BOT CONFIG (1-min, live period sets, inverted)
");
const tf1 = resample(bars, 1);
const ctx1 = buildFilterContext(tf1);
const A1 = atr(tf1.high, tf1.low, tf1.close, 14);
const liveParams = resolveParams(MACD, {
  fast1: 8, slow1: 21, sig1: 5, fast2: 12, slow2: 26, sig2: 9,
  fast3: 19, slow3: 39, sig3: 9, fast4: 26, slow4: 52, sig4: 18,
  angleThr: 0.008, slopeBars: 1, rthStartCt: 9 * 60 + 30, rthEndCt: 15 * 60, atrPeriod: 14 });
const liveOut = MACD.compute(tf1, liveParams);
const inverted = new Int8Array(liveOut.sig.length);
for (let i = 0; i < inverted.length; i++) inverted[i] = -liveOut.sig[i];
const liveBase = { contracts: 2, sizingMode: "fixed", slAtrMult: 1.8, tpMode: "rr", tpRR: 1.0,
  flipOnOpposite: false, cooldownAfterStopMins: 60, intradayOnly: true,
  flattenCt: 15 * 60 + 5, reopenCt: 17 * 60, noEntryMinsBeforeFlat: 10,
  commissionModel: "per-contract", commissionPerSide: 0.75 };
function evLive(sig, exec) {
  const x = resolveExec({ ...exec, slippageTicks: TICKS, dayLossStopUsd: CAP });
  const { trades } = runBrackets(tf1, sig, A1, x);
  if (trades.length < 200) return null;
  const rules = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });
  const T = flatten(trades);
  return { is: 0, oos: 0, all: fastSweep(T, withAtr, rules, 1).pass,
           he: fastSweep(T, HE, rules, 1).pass, hl: fastSweep(T, HL, rules, 1).pass,
           y26: fastSweep(T, Y26, rules, 1).pass, st: tradeStats(trades) };
}
const g1 = (sg) => applyFilters(sg, ctx1, { ...NO_FILTER, startCt: 9 * 60 + 30, endCt: 15 * 60 });
for (const [label, sg, over] of [
  ["live bot exactly (2 lots, inverted)", inverted, {}],
  ["live bot at 8 lots", inverted, { contracts: 8 }],
  ["live bot at 10 lots", inverted, { contracts: 10 }],
  ["live bot NOT inverted, 8 lots", liveOut.sig, { contracts: 8 }],
]) {
  const r = evLive(g1(sg), { ...liveBase, ...over });
  if (r) row(label, r);
}
row("DONCHIAN shipped, for reference", donShipped);
