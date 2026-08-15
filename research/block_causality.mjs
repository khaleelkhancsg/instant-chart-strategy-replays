// How much does it matter that the daily rules are applied POST-HOC?
//
// challenge.mjs enforces the +$750 profit block and the -$500 circuit breaker by
// SKIPPING trades out of a fixed list (challenge.mjs:159-161). It does not re-run
// the strategy. That is not the same thing: in the real bot a blocked trade is
// never opened, so the bot is FLAT during what would have been that trade, and
// is therefore free to take a signal it would otherwise have missed while
// holding. Blocking changes which later trades exist, not just which are counted.
//
// The audit turned this up concretely. 2026-06-25 shows five engine trades:
//   +$939, +$1104, +$1695, +$2152, then -$6889
// The day passes +$750 after the FIRST trade, so under the real rules the other
// four never happen. Post-hoc skipping gets that day's P&L right, but only
// because nothing downstream depended on the bot's position state.
//
// Every headline pass rate in bot/README.md uses the post-hoc method, so the
// size of this gap decides whether those numbers need restating. Both sides are
// measured with the SAME estimator (sweepWindows, calendar windows, 1-day step)
// so the only difference is where the blocks are applied.
//
// Usage:  node research/block_causality.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules, sweepWindows } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const TOTAL = 8, Q1 = 2, ADD_TRIG = 0.15, ADD_WIN = 10, CAP = 1000;
const BREAKER = 500, PROFIT_BLOCK = 750;

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

// ── A: the current method — engine trades, blocks applied downstream ──
const engCfg = { contracts: TOTAL, slAtrMult: 5, tpAtrMult: 1.75, dayLossStopUsd: CAP,
  dayLossStopMode: "exact", slippageTicks: 1, scaleInFrac: Q1 / TOTAL,
  scaleInTrigger: ADD_TRIG, scaleInWindowBars: ADD_WIN };
const { trades: engTrades } = runBrackets(tf, sig, A, resolveExec({ ...S.execDefaults, ...engCfg }));

// ── B: blocks applied INSIDE the replay, so they gate entries ─────────
function causalReplay(useBlocks) {
  const { open: O, high: H, low: L, ctMin: CT, tday: TD, ts: TS } = tf;
  const n = O.length, pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const out = [];
  let pos = 0, ep = 0, entTime = 0, slD = 0, tpD = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  let curTday = -1e9, dayReal = 0, capHit = false;
  const avgFill = () => notional / qty;
  const close_ = (rawExit, i, exact, reason) => {
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact
              : (xp - avgFill()) * pos * pv * qty - perSide * 2 * qty;
    out.push({ tday: TD[i], entryTime: entTime, exitTime: TS[i], pnl: net, reason });
    dayReal += net;
    if (dayReal <= -CAP) capHit = true;
    pos = 0; pendQty = 0; addBy = -1; notional = 0;
  };
  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; capHit = false; }
    if (pos !== 0) {
      if (pendQty > 0 && i <= addBy && (pos === 1 ? H[i] >= addPx : L[i] <= addPx)) {
        notional += (pos === 1 ? addPx + slip : addPx - slip) * pendQty;
        qty += pendQty; pendQty = 0;
      }
      if (flatNow) { close_(O[i], i, undefined, "FLAT"); continue; }
      const dir = pos;
      const lossPx = avgFill() - dir * ((CAP + dayReal) / (pv * qty));
      const rawSl = ep - dir * slD;
      const sl = dir === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
      const isCap = dir === 1 ? (sl === lossPx && lossPx > rawSl)
                              : (sl === lossPx && lossPx < rawSl);
      const tp = ep + dir * tpD;
      const cut = isCap ? -CAP - dayReal : undefined;
      const rn = isCap ? "DAYLOSS" : "SL";
      let exited = false;
      if (dir === 1) {
        if (O[i] <= sl) { close_(O[i], i, cut, rn); exited = true; }
        else if (L[i] <= sl) { close_(sl, i, cut, rn); exited = true; }
        else if (H[i] >= tp) { close_(tp, i, undefined, "TP"); exited = true; }
      } else {
        if (O[i] >= sl) { close_(O[i], i, cut, rn); exited = true; }
        else if (H[i] >= sl) { close_(sl, i, cut, rn); exited = true; }
        else if (L[i] <= tp) { close_(tp, i, undefined, "TP"); exited = true; }
      }
      if (exited) continue;
      if (X.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], i, undefined, "FLIP");
      if (pos !== 0) continue;
    }
    const blocked = capHit ||
      (useBlocks && (dayReal <= -BREAKER || dayReal >= PROFIT_BLOCK));
    if (pos === 0 && s !== 0 && !flatNow && !blocked) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      ep = O[i]; entTime = TS[i]; pos = s;
      slD = Math.max(a * 5, tick); tpD = Math.max(a * 1.75, tick);
      qty = Q1; pendQty = TOTAL - Q1;
      addPx = ep + pos * Math.max(a * ADD_TRIG, tick);
      addBy = i + ADD_WIN;
      notional = (pos === 1 ? ep + slip : ep - slip) * qty;
    }
  }
  return out;
}

const noBlocks = causalReplay(false);
const withBlocks = causalReplay(true);

// Parity guard: with blocks OFF the replay must reproduce the engine, or the
// comparison below is measuring my replay rather than the method.
const engNet = engTrades.reduce((s, t) => s + t.pnl, 0);
const repNet = noBlocks.reduce((s, t) => s + t.pnl, 0);
console.log(`\nparity (blocks off): engine ${engTrades.length} trades $${engNet.toFixed(0)}  ` +
            `vs replay ${noBlocks.length} trades $${repNet.toFixed(0)}`);
const parityOk = engTrades.length === noBlocks.length && Math.abs(engNet - repNet) < 1;
console.log(parityOk ? "  OK — same book, so any difference below is the METHOD\n"
                     : "  !! MISMATCH — do not trust the comparison below\n");

const T0 = bars.ts[0], T1 = bars.ts[bars.count - 1];
const withRules = resolveRules({ circuitBreaker: BREAKER, dailyProfitStop: PROFIT_BLOCK });
// For the causal book the blocks are ALREADY applied, so they must be switched
// off here or they would be applied twice.
const noRules = resolveRules({ circuitBreaker: 0, dailyProfitStop: 0, dailyLossLimit: 0 });

const A1 = sweepWindows(engTrades, T0, T1, withRules, 1);
const B1 = sweepWindows(withBlocks, T0, T1, noRules, 1);

console.log("method                                   trades    pass rate");
console.log(`  post-hoc skip (what README quotes)      ${String(engTrades.length).padStart(6)}    ` +
            `${A1.summary.passRate.toFixed(2)}%`);
console.log(`  causal entry block (what the bot does)  ${String(withBlocks.length).padStart(6)}    ` +
            `${B1.summary.passRate.toFixed(2)}%`);
console.log(`  difference                              ${String(withBlocks.length - engTrades.length).padStart(6)}    ` +
            `${(B1.summary.passRate - A1.summary.passRate >= 0 ? "+" : "")}` +
            `${(B1.summary.passRate - A1.summary.passRate).toFixed(2)}pp`);

// How many trades does post-hoc skipping actually discard?
{
  let skipped = 0, acc = 0, day = null;
  for (const t of engTrades) {
    if (t.tday !== day) { day = t.tday; acc = 0; }
    if (acc >= PROFIT_BLOCK || acc <= -BREAKER) { skipped++; continue; }
    acc += t.pnl;
  }
  console.log(`\n  post-hoc discards ${skipped} of ${engTrades.length} engine trades ` +
              `(${(100 * skipped / engTrades.length).toFixed(1)}%), leaving ` +
              `${engTrades.length - skipped}`);
  console.log(`  causal blocking yields ${withBlocks.length} — a gap of ` +
              `${withBlocks.length - (engTrades.length - skipped)} trades that only exist because`);
  console.log("  the bot was flat when a blocked trade would have held it.");
}

// Net and profit factor both ways
const pf = a => { let gw = 0, gl = 0; for (const t of a) { if (t.pnl > 0) gw += t.pnl; else gl -= t.pnl; } return gw / gl; };
{
  let acc = 0, day = null, kept = [];
  for (const t of engTrades) {
    if (t.tday !== day) { day = t.tday; acc = 0; }
    if (acc >= PROFIT_BLOCK || acc <= -BREAKER) continue;
    acc += t.pnl; kept.push(t);
  }
  console.log(`\n  post-hoc kept book : ${kept.length} trades, pf ${pf(kept).toFixed(3)}, ` +
              `net $${(kept.reduce((s, t) => s + t.pnl, 0) / 1000).toFixed(0)}k`);
  console.log(`  causal book        : ${withBlocks.length} trades, pf ${pf(withBlocks).toFixed(3)}, ` +
              `net $${(withBlocks.reduce((s, t) => s + t.pnl, 0) / 1000).toFixed(0)}k`);
}

// Regime slices, since a method difference could be concentrated somewhere.
console.log("\n  by slice (same estimator both sides):");
const MID = T0 + (T1 - T0) / 2, Y12 = T1 - 365 * 86400000, Y26 = Date.UTC(2026, 0, 1);
for (const [nm, lo, hi] of [["early half", T0, MID], ["late half", MID, T1],
                            ["last 12m", Y12, T1], ["2026", Y26, T1]]) {
  const a = sweepWindows(engTrades.filter(t => t.entryTime >= lo && t.entryTime < hi), lo, hi, withRules, 1);
  const b = sweepWindows(withBlocks.filter(t => t.entryTime >= lo && t.entryTime < hi), lo, hi, noRules, 1);
  const d = b.summary.passRate - a.summary.passRate;
  console.log(`    ${nm.padEnd(12)}post-hoc ${a.summary.passRate.toFixed(1).padStart(5)}%   ` +
              `causal ${b.summary.passRate.toFixed(1).padStart(5)}%   ` +
              `${(d >= 0 ? "+" : "") + d.toFixed(1)}pp`);
}
