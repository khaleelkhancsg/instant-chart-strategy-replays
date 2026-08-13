// Scale out at the target and leave a runner that cannot lose.
//
// THE PROPOSAL. Enter 8 lots. When price reaches the normal target T, close 7
// lots there and let 1 run, moving that lot's stop UP to +0.25T so it is locked
// profitable, with a new target at +2T.
//
// THE ARITHMETIC FIRST. From +T, a driftless walk reaches 2T before falling back
// to 0.25T with probability (1 - 0.25) / (2 - 0.25) = 42.9%, so the runner is
// worth 0.429*2T + 0.571*0.25T = 1.0T — exactly what closing the lot at T would
// have paid. The idea is EV-NEUTRAL by construction and cannot add expectancy on
// a random walk. What it does is reshape the winner distribution: instead of
// every winner paying 8T, 42.9% pay 9T and 57.1% pay 7.25T.
//
// So the only question worth asking is whether that reshaping helps against a
// FIXED $3,000 target on a deadline. More upside variance on winners could reach
// the target sooner; equally, shaving 0.75T off 57% of winners could slow the
// grind. Not answerable from theory, hence this.
//
// Prior: a scale-out variant measured earlier in this project scored 30-34%
// against 38.6% for taking the whole position at the target. That was a different
// scheme (no locked-profit runner stop), so it is a warning rather than an answer.
//
// The engine has no partial exits, so this is a standalone replay mirroring it:
// same causality, same stop-before-target ordering, same flatten priority, same
// exact-liquidation day cap.
//
// Usage:  node research/runner_scaleout.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 40000, BLOCK = 5, WIN = 21;
const CAP = 1000, TICKS = 1, LOTS = 8;
const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const S = (await loadStrategies()).get("donchian_eff_rth");
const X = resolveExec(S.execDefaults);
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(tf.close.length);
for (let i = 30; i < raw.length; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const R = resolveRules({ circuitBreaker: 500, dailyProfitStop: 750 });

// runner = lots left running; rMult = runner target as a multiple of T;
// rLock = runner stop as a fraction of T (0.25 = lock in a quarter of the target)
function replay(runner, rMult, rLock, fromMs) {
  const { open: O, high: H, low: L, close: C, ctMin: CT, tday: TD, ts: TS } = tf;
  const n = O.length, pv = 2, tick = 0.25;
  const slip = TICKS * tick, perSide = 0.75;
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const fills = [];
  let pos = 0, ep = 0, qty = 0, slD = 0, tpD = 0, scaled = false;
  let curTday = -1e9, dayReal = 0, dayLossHit = false;

  // one partial or full exit
  const fill = (px, q, i, exact) => {
    const exitPx = pos === 1 ? px - slip : px + slip;
    const entryFill = pos === 1 ? ep + slip : ep - slip;
    const fees = perSide * 2 * q;
    let net = exact !== undefined ? exact : (exitPx - entryFill) * pos * pv * q - fees;
    fills.push({ tday: TD[i], entryTime: TS[i], net });
    dayReal += net;
    if (dayReal <= -CAP) dayLossHit = true;
  };

  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; dayLossHit = false; }

    if (pos !== 0) {
      if (flatNow) { fill(O[i], qty, i); pos = 0; continue; }
      const dir = pos;
      const tpPx = ep + dir * tpD;
      const rStop = ep + dir * rLock * tpD;      // locked-profit stop for the runner
      const rTgt = ep + dir * rMult * tpD;

      if (!scaled) {
        // exact-liquidation day cap, on the full position
        const capPx = ep - dir * ((CAP + dayReal) / (pv * qty));
        const rawSl = ep - dir * slD;
        const sl = dir === 1 ? Math.max(rawSl, capPx) : Math.min(rawSl, capPx);
        const isCap = dir === 1 ? sl === capPx && capPx > rawSl : sl === capPx && capPx < rawSl;
        const hitSl = dir === 1 ? (O[i] <= sl || L[i] <= sl) : (O[i] >= sl || H[i] >= sl);
        const hitTp = dir === 1 ? H[i] >= tpPx : L[i] <= tpPx;
        if (hitSl) {                                  // stop before target, as the engine does
          const px = (dir === 1 ? O[i] <= sl : O[i] >= sl) ? O[i] : sl;
          fill(px, qty, i, isCap ? -CAP - dayReal : undefined);
          pos = 0; continue;
        }
        if (hitTp) {
          if (runner <= 0 || runner >= qty) { fill(tpPx, qty, i); pos = 0; continue; }
          fill(tpPx, qty - runner, i);                // bank the main tranche
          qty = runner; scaled = true;
          // Pessimistic same-bar resolution for the runner: assume the adverse
          // side printed first, exactly as the engine assumes stop before target.
          if (dir === 1 ? L[i] <= rStop : H[i] >= rStop) { fill(rStop, qty, i); pos = 0; }
          else if (dir === 1 ? H[i] >= rTgt : L[i] <= rTgt) { fill(rTgt, qty, i); pos = 0; }
          continue;
        }
      } else {
        if (dir === 1 ? (O[i] <= rStop || L[i] <= rStop) : (O[i] >= rStop || H[i] >= rStop)) {
          const px = (dir === 1 ? O[i] <= rStop : O[i] >= rStop) ? O[i] : rStop;
          fill(px, qty, i); pos = 0; continue;
        }
        if (dir === 1 ? H[i] >= rTgt : L[i] <= rTgt) { fill(rTgt, qty, i); pos = 0; continue; }
      }
      if (X.flipOnOpposite && s !== 0 && s !== pos) { fill(O[i], qty, i); pos = 0; }
      if (pos !== 0) continue;
    }

    if (pos === 0 && s !== 0 && !flatNow && !dayLossHit) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      ep = O[i]; pos = s; qty = LOTS; scaled = false;
      slD = Math.max(a * 5, tick);
      tpD = Math.max(a * 1.75, tick);
    }
  }

  // daily P&L with the daily rules applied
  const days = [];
  let day = null, p = 0;
  for (const f of fills) {
    if (f.entryTime < fromMs) continue;
    if (f.tday !== day) { if (day !== null) days.push(p); day = f.tday; p = 0; }
    if (R.dailyProfitStop > 0 && p >= R.dailyProfitStop) continue;
    if (R.circuitBreaker > 0 && p <= -R.circuitBreaker) continue;
    p += f.net;
  }
  if (day !== null) days.push(p);
  let gw = 0, gl = 0, tot = 0;
  for (const f of fills) { if (f.entryTime < fromMs) continue; tot += f.net; if (f.net > 0) gw += f.net; else gl -= f.net; }
  return { days, pf: gl ? gw / gl : Infinity, total: tot, nFills: fills.length };
}

function ev(d) {
  let cum = 0, peak = 0, lk = false, md = -1e18;
  for (const v of d) {
    cum += v; if (v > md) md = v;
    const fl = lk ? 0 : peak - R.trailingDD;
    if (cum <= fl) return 0;
    if (cum > peak) peak = cum;
    if (R.lockAtBreakeven && !lk && peak >= R.trailingDD) lk = true;
    if (cum >= R.profitTarget && md <= 0.5 * cum) return 1;
  }
  return 0;
}
function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const Y26 = Date.UTC(2026, 0, 1);
const VARIANTS = [
  ["baseline: all 8 at T", 0, 0, 0],
  ["1 runner, 2T, lock 0.25T", 1, 2, 0.25],
  ["1 runner, 2T, lock 0.50T", 1, 2, 0.50],
  ["1 runner, 2T, lock 0",     1, 2, 0.0],
  ["1 runner, 1.5T, lock 0.25T", 1, 1.5, 0.25],
  ["1 runner, 3T, lock 0.25T", 1, 3, 0.25],
  ["2 runners, 2T, lock 0.25T", 2, 2, 0.25],
];
for (const [lbl, fromMs] of [["ALL HISTORY", 0], ["2026 ONLY", Y26]]) {
  const RS = VARIANTS.map(([, r, m, k]) => replay(r, m, k, fromMs));
  const n = Math.min(...RS.map((r) => r.days.length));
  console.log(`\n  ${lbl} — ${LOTS} lots, exact -$${CAP} cap, ${n} sessions, ${DRAWS.toLocaleString()} draws`);
  console.log("   variant                        PASS%   vs base    z      pf      total$");
  const rnd = mul(7777), idx = new Array(WIN);
  const w = VARIANTS.map(() => 0), dif = VARIANTS.map(() => []);
  for (let k = 0; k < DRAWS; k++) {
    let m = 0;
    while (m < WIN) { const st = Math.floor(rnd() * Math.max(1, n - BLOCK));
      for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = (st + j) % n; }
    const b = ev(idx.map((z) => RS[0].days[z]));
    VARIANTS.forEach((v, i) => { const q = ev(idx.map((z) => RS[i].days[z])); w[i] += q; dif[i].push(q - b); });
  }
  VARIANTS.forEach((v, i) => {
    const d = dif[i], m = d.reduce((a, b) => a + b, 0) / d.length;
    let s2 = 0; for (const q of d) s2 += (q - m) ** 2;
    const se = Math.sqrt(s2 / (d.length - 1)) / Math.sqrt(d.length);
    console.log(`   ${v[0].padEnd(30)} ${(100 * w[i] / DRAWS).toFixed(1).padStart(5)}%  ` +
      `${((m >= 0 ? "+" : "") + (100 * m).toFixed(2)).padStart(7)}pp ${(se ? (m / se).toFixed(1) : "-").padStart(6)}  ` +
      `${RS[i].pf.toFixed(3)}  ${("$" + Math.round(RS[i].total).toLocaleString()).padStart(10)}`);
  });
}
