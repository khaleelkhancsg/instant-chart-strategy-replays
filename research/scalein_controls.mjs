// Adversarial controls for the scale-in result.
//
// The claim is that scale-in works because a favourable-follow-through condition
// identifies trades worth committing to. The obvious alternative explanation is
// that it works simply because it is SMALL on 20% of trades, in which case the
// condition carries no information and any rule that shrank a similar fraction
// would do as well.
//
// Controls, all at a matched add-rate so the amount of size reduction is the same:
//   real     add when price moves `trigger` x ATR in the trade's favour
//   random   add with a fixed probability, drawn at entry, matched to real's rate
//   coin     same as random but re-drawn per trade with a different stream
//   always   always add after one bar (no condition) — isolates the pure cost of
//            splitting the entry into two slipped fills
//   never    never add, i.e. simply trade the smaller size throughout
//   adverse  add on an ADVERSE move of the same size (the "buy the dip" version)
//
// If `real` beats `random` and `coin` by a clear margin, the condition is doing
// work. If it does not, the whole result is variance reduction wearing a costume.
//
// The replay is verified against engine.mjs on the real mode BEFORE any control
// is trusted, so the controls inherit the engine's correctness.
//
// Usage:  node research/scalein_controls.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules, replayWindow, OUTCOME } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { windowStarts } from "./lib_search.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const CAP = 1000, LOTS = 8, FIRST = 2, TRIG = 0.15, WINBARS = 20, TICKS = 1;
const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const S = (await loadStrategies()).get("donchian_eff_rth");
const X0 = resolveExec(S.execDefaults);
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(tf.close.length);
for (let i = 30; i < raw.length; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });
const W = windowStarts(bars, 30, 1);
const REC = bars.ts[bars.count - 1] - 365 * 86400000;
const SETS = { all: W, rec: W.filter((s) => s >= REC) };

function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Replay mirroring engine.mjs, with a pluggable add rule. Pessimistic ordering
// throughout: the add is attempted only AFTER the bracket failed to resolve.
function replay(mode, addProb, seed) {
  const rnd = mul(seed);
  const { open: O, high: H, low: L, close: C, ts: TS, ctMin: CT, tday: TD } = tf;
  const n = O.length, pv = 2, tick = 0.25;
  const slip = TICKS * tick;
  const cutoff = X0.flattenCt - X0.noEntryMinsBeforeFlat;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const trades = [];
  let pos = 0, ei = 0, qCur = 0, pend = 0, notional = 0, addPx = 0, addBy = -1;
  let slDist = 0, tpDist = 0, epSig = 0, willAdd = true;
  let curTday = -1e9, dayReal = 0, dayLossHit = false;

  const close_ = (rawExit, i, exact) => {
    const entryFill = notional / qCur;
    const fees = 0.75 * 2 * qCur;
    let exitPrice, gross;
    if (exact !== undefined) { gross = exact + fees; exitPrice = entryFill + gross / (pos * pv * qCur); }
    else { exitPrice = pos === 1 ? rawExit - slip : rawExit + slip;
           gross = (exitPrice - entryFill) * pos * pv * qCur; }
    trades.push({ entryTime: TS[ei], exitTime: TS[i], tday: TD[i], dir: pos,
                  pnl: gross - fees, gross, fees, contracts: qCur, mae: 0, mfe: 0 });
    dayReal += gross - fees;
    if (dayReal <= -CAP) dayLossHit = true;
    pos = 0; pend = 0; notional = 0; addBy = -1;
  };
  const tryAdd = (i) => {
    if (pend <= 0 || i > addBy) return;
    let go = false, px = addPx;
    if (mode === "real") go = pos === 1 ? H[i] >= addPx : L[i] <= addPx;
    else if (mode === "adverse") { const p2 = epSig - pos * (addPx - epSig) * pos * pos;
      const ad = epSig - pos * Math.abs(addPx - epSig);
      go = pos === 1 ? L[i] <= ad : H[i] >= ad; px = ad; }
    else if (mode === "always") go = true, px = O[i];
    else if (mode === "never") go = false;
    else go = willAdd, px = O[i];                    // random / coin: unconditional timing
    if (!go) return;
    notional += (pos === 1 ? px + slip : px - slip) * pend;
    qCur += pend; pend = 0;
  };

  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X0.flattenCt, X0.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; dayLossHit = false; }
    if (pos !== 0) {
      if (flatNow) { close_(O[i], i); continue; }
      const capPx = (notional / qCur) - pos * ((CAP + dayReal) / (pv * qCur));
      const rawSl = epSig - pos * slDist;
      const sl = pos === 1 ? Math.max(rawSl, capPx) : Math.min(rawSl, capPx);
      const isCap = pos === 1 ? sl === capPx && capPx > rawSl : sl === capPx && capPx < rawSl;
      const tp = epSig + pos * tpDist;
      let out = false;
      if (pos === 1) {
        if (O[i] <= sl) { close_(O[i], i, isCap ? -CAP - dayReal : undefined); out = true; }
        else if (L[i] <= sl) { close_(sl, i, isCap ? -CAP - dayReal : undefined); out = true; }
        else if (H[i] >= tp) { close_(tp, i); out = true; }
      } else {
        if (O[i] >= sl) { close_(O[i], i, isCap ? -CAP - dayReal : undefined); out = true; }
        else if (H[i] >= sl) { close_(sl, i, isCap ? -CAP - dayReal : undefined); out = true; }
        else if (L[i] <= tp) { close_(tp, i); out = true; }
      }
      if (out) continue;
      tryAdd(i);                                     // pessimistic: after the bracket
      if (X0.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], i);
      if (pos !== 0) continue;
    }
    if (pos === 0 && s !== 0 && !flatNow && !dayLossHit) {
      if (inFlat(CT[i], cutoff, X0.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      pos = s; ei = i; epSig = O[i];
      slDist = Math.max(a * 5, tick); tpDist = Math.max(a * 1.75, tick);
      if (mode === "base") { qCur = LOTS; pend = 0; addBy = -1; }
      else {
        qCur = FIRST; pend = LOTS - FIRST;
        addPx = epSig + pos * Math.max(a * TRIG, tick);
        addBy = i + WINBARS;
        willAdd = rnd() < addProb;                   // decided at entry, no lookahead
      }
      notional = (pos === 1 ? epSig + slip : epSig - slip) * qCur;
    }
  }
  const st = tradeStats(trades);
  const small = trades.filter((t) => t.contracts < LOTS).length;
  const pr = (set) => { let p = 0; for (const s2 of set) if (replayWindow(trades, s2, R).outcome === OUTCOME.PASS) p++;
                        return (100 * p) / set.length; };
  return { st, smallPct: (100 * small) / trades.length, all: pr(SETS.all), rec: pr(SETS.rec) };
}

// ── 1. verify the replay against the engine on the real mode ─────────
const engBase = (() => {
  const x = resolveExec({ ...S.execDefaults, contracts: LOTS, slAtrMult: 5, tpAtrMult: 1.75,
    slippageTicks: TICKS, dayLossStopUsd: CAP, dayLossStopMode: "exact" });
  return tradeStats(runBrackets(tf, sig, A, x).trades);
})();
const engScale = (() => {
  const x = resolveExec({ ...S.execDefaults, contracts: LOTS, slAtrMult: 5, tpAtrMult: 1.75,
    slippageTicks: TICKS, dayLossStopUsd: CAP, dayLossStopMode: "exact",
    scaleInFrac: FIRST / LOTS, scaleInTrigger: TRIG, scaleInWindowBars: WINBARS, scaleInOrder: "after" });
  return tradeStats(runBrackets(tf, sig, A, x).trades);
})();
const repBase = replay("base", 0, 1);
const repReal = replay("real", 0, 1);
console.log(`\n  REPLAY vs ENGINE (must agree before any control is trusted)`);
console.log(`   base      engine ${engBase.n} trades pf ${engBase.profitFactor.toFixed(3)} $${engBase.expectancy.toFixed(2)}   ` +
            `replay ${repBase.st.n} pf ${repBase.st.profitFactor.toFixed(3)} $${repBase.st.expectancy.toFixed(2)}`);
console.log(`   scale-in  engine ${engScale.n} trades pf ${engScale.profitFactor.toFixed(3)} $${engScale.expectancy.toFixed(2)}   ` +
            `replay ${repReal.st.n} pf ${repReal.st.profitFactor.toFixed(3)} $${repReal.st.expectancy.toFixed(2)}`);
const ok = Math.abs(engScale.profitFactor - repReal.st.profitFactor) < 0.02 &&
           Math.abs(engBase.profitFactor - repBase.st.profitFactor) < 0.02;
console.log(`   -> ${ok ? "AGREE. controls below are trustworthy." : "DISAGREE — do not trust the controls."}\n`);

// ── 2. matched-rate controls ─────────────────────────────────────────
const addRate = 1 - repReal.smallPct / 100;
console.log(`  CONTROLS, all matched to real's add rate of ${(100 * addRate).toFixed(0)}%`);
console.log("   mode         small%   win%    pf     $/trade    all     12m");
const rows = [["base", replay("base", 0, 1)], ["real", repReal]];
for (let k = 0; k < 5; k++) rows.push([`random#${k + 1}`, replay("random", addRate, 100 + k * 977)]);
rows.push(["always", replay("always", 1, 1)]);
rows.push(["never (2 lots)", replay("never", 0, 1)]);
rows.push(["adverse (dip)", replay("adverse", 0, 1)]);
for (const [n, r] of rows) {
  console.log(`   ${n.padEnd(13)} ${r.smallPct.toFixed(0).padStart(5)}%  ${r.st.winRate.toFixed(1).padStart(4)}  ` +
    `${r.st.profitFactor.toFixed(3)}  ${("$" + r.st.expectancy.toFixed(2)).padStart(8)}  ${r.all.toFixed(1).padStart(5)}%  ${r.rec.toFixed(1).padStart(5)}%`);
}
const rnds = rows.filter(([n]) => n.startsWith("random")).map(([, r]) => r.all);
const m = rnds.reduce((a, b) => a + b, 0) / rnds.length;
let sd = 0; for (const v of rnds) sd += (v - m) ** 2;
sd = Math.sqrt(sd / (rnds.length - 1));
console.log(`\n   random controls: mean ${m.toFixed(1)}% sd ${sd.toFixed(2)}   real ${repReal.all.toFixed(1)}%   ` +
            `-> real is ${((repReal.all - m) / sd).toFixed(1)} sd above the random ensemble`);
