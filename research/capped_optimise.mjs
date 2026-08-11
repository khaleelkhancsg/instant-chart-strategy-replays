// Re-optimise for the regime where the cap ALWAYS binds.
//
// At 8 lots the platform's -$1000 stop allows 1000/(2*8) = 62.5 points. The
// designed 5xATR stop exceeds that whenever ATR > 12.5, and 2026's median 2-min
// ATR is 23.7 — so in the current regime the stop is PINNED AT THE CAP on
// essentially every trade and slAtrMult is close to a dead parameter. What is
// left live is the TARGET, which nothing caps.
//
// That inverts the tuning problem. The book was designed around a 3.33:1
// stop:target ratio giving ~77% wins. Capped at 62.5 points against a 1.5xATR
// target, the ratio at ATR 23.7 is 1.76:1 and the implied win rate is 64%. To
// restore the ratio the TARGET has to come down with the cap, not the stop.
//
// Ranked on the WORSE of two time halves of the high-volatility regime, because
// ranking on the average is exactly how the 3.5/2.5 "optimum" got picked last
// time — it split 53.9% early against 35.8% late.
//
// Usage:  node research/capped_optimise.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec, tradeStats } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { flatten, fastSweep, windowStarts, DAY } from "./lib_search.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const CAP = 1000, TICKS = 1;
const { bars } = loadBars();
const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A = atr(tf.high, tf.low, tf.close, 14);
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const S = (await loadStrategies()).get("donchian_eff_rth");
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(tf.close.length);
for (let i = 30; i < raw.length; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1;
  else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });

// ── regime selection, as in regime_sizing.mjs ────────────────────────
const allStarts = windowStarts(bars, 30, 1);
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
const hi = withAtr.filter((s) => winAtr.get(s) > cut);
const mid = hi[Math.floor(hi.length / 2)];
const hiEarly = hi.filter((s) => s < mid), hiLate = hi.filter((s) => s >= mid);
const y2026 = withAtr.filter((s) => new Date(s).getUTCFullYear() === 2026);

function ev(contracts, sl, tp, rulesOver = {}) {
  const x = resolveExec({
    ...S.execDefaults, contracts, slAtrMult: sl, tpAtrMult: tp, tpMode: "atr",
    slippageTicks: TICKS, dayLossStopUsd: CAP,
  });
  const { trades } = runBrackets(tf, sig, A, x);
  if (trades.length < 300) return null;
  const rules = resolveRules({ circuitBreaker: 750, dailyProfitStop: 750, ...rulesOver });
  const T = flatten(trades);
  const e = fastSweep(T, hiEarly, rules, 1).pass;
  const l = fastSweep(T, hiLate, rules, 1).pass;
  const st = tradeStats(trades);
  return {
    contracts, sl, tp, e, l, worst: Math.min(e, l), avg: (e + l) / 2,
    all: fastSweep(T, withAtr, rules, 1).pass,
    y26: fastSweep(T, y2026, rules, 1).pass,
    st, capPct: (100 * trades.filter((t) => t.reason === "DAYLOSS").length) / st.n,
  };
}

console.log(`\n  Cap allows 1000/(2*lots) points. Designed stop is 5xATR.`);
console.log(`  lots   cap pts   binds above ATR`);
for (const q of [5, 6, 7, 8, 9, 10]) {
  const pts = CAP / (2 * q);
  console.log(`  ${String(q).padStart(4)}   ${pts.toFixed(1).padStart(7)}   ${(pts / 5).toFixed(1).padStart(15)}`);
}
console.log(`\n  2026 median 2-min ATR is 23.7, so at 7+ lots the cap binds on nearly every trade.\n`);

console.log("─".repeat(78));
console.log("  TARGET SWEEP — the only geometry lever the cap leaves alive");
console.log("  ranked on the WORSE half of the high-volatility regime\n");
const out = [];
for (const q of [5, 6, 7, 8, 9, 10]) {
  for (const tp of [0.6, 0.8, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5]) {
    for (const sl of [5, 7]) {
      const r = ev(q, sl, tp);
      if (r) out.push(r);
    }
  }
}
out.sort((a, b) => b.worst - a.worst);
console.log("  lots  sl/tp     early    late   WORSE     avg    2026    win%    pf      net$");
for (const r of out.slice(0, 15)) {
  console.log(
    `  ${String(r.contracts).padStart(4)}  ${r.sl}/${r.tp.toFixed(2)}  ${r.e.toFixed(1).padStart(6)}% ${r.l.toFixed(1).padStart(6)}% ` +
    `${r.worst.toFixed(1).padStart(6)}% ${r.avg.toFixed(1).padStart(6)}% ${r.y26.toFixed(1).padStart(6)}% ` +
    `${r.st.winRate.toFixed(1).padStart(6)}  ${r.st.profitFactor.toFixed(3)}  ${("$" + Math.round(r.st.pnl).toLocaleString()).padStart(9)}`
  );
}

// ── rules on the leader ──────────────────────────────────────────────
const B = out[0];
console.log(`\n─────────────────────────────────────────────────────────────`);
console.log(`  RULES GRID on the leader (${B.contracts} lots, ${B.sl}/${B.tp})\n`);
console.log("  breaker \\ block " + [0, 500, 750, 1000, 1250, 1500].map((v) => (v ? "$" + v : "off").padStart(8)).join(""));
let bestR = null;
for (const cb of [0, 300, 500, 750, 1000]) {
  const cells = [];
  for (const dps of [0, 500, 750, 1000, 1250, 1500]) {
    const r = ev(B.contracts, B.sl, B.tp, { circuitBreaker: cb, dailyProfitStop: dps });
    if (!bestR || r.worst > bestR.r.worst) bestR = { cb, dps, r };
    cells.push((r.worst.toFixed(1) + "%").padStart(8));
  }
  console.log(`  ${(cb ? "-$" + cb : "off").padStart(15)} ` + cells.join(""));
}
const F = bestR.r;
console.log(`\n  BEST OVERALL: ${F.contracts} lots, ${F.sl}xATR/${F.tp}xATR, breaker ${bestR.cb ? "-$" + bestR.cb : "off"}, block ${bestR.dps ? "$" + bestR.dps : "off"}`);
console.log(`    high-vol early ${F.e.toFixed(1)}%  late ${F.l.toFixed(1)}%  WORSE ${F.worst.toFixed(1)}%`);
console.log(`    2026 ${F.y26.toFixed(1)}%   all windows ${F.all.toFixed(1)}%`);
console.log(`    win ${F.st.winRate.toFixed(1)}%  pf ${F.st.profitFactor.toFixed(3)}  net $${Math.round(F.st.pnl).toLocaleString()}  cap fired ${F.capPct.toFixed(0)}%`);
console.log(`\n  CURRENT SHIPPED (8 lots, 5/1.5, -$750/$750) for comparison:`);
const cur = ev(8, 5, 1.5);
console.log(`    early ${cur.e.toFixed(1)}%  late ${cur.l.toFixed(1)}%  WORSE ${cur.worst.toFixed(1)}%  2026 ${cur.y26.toFixed(1)}%  all ${cur.all.toFixed(1)}%  pf ${cur.st.profitFactor.toFixed(3)}`);
