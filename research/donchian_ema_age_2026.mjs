// Do the 2-min Donchian breakouts work better when an EMA trend already points
// the same way -- and does it matter how long ago that EMA trend formed?
// 2026 ONLY, the $1,250 Donchian (research/rules_1250_2026.mjs config D, as
// mnqDonchian1250.js trades it): 4 lots (2 late), -$300 / +$250, $600 limit,
// 40-min exit, honest fills, realistic costs.
//
// "The EMA formed in a direction" = a fast/slow EMA cross (9/21, and 20/50 as
// a check) on 1, 2, 3, 4, 5, 10, 15 and 30-minute bars. At each breakout --
// the moment its 2-min signal bar closes -- we read the last COMPLETED bar of
// that timeframe: does the EMA pair point the breakout's way (agree), and how
// many minutes since it crossed into its current direction (age)?
//
// Two samples:
//   trades   the strategy's own 2026 trades (148, day rules included)
//   signals  every 2026 breakout signal (767), each given the strategy's trade
//            as if it were the only one that day -- more samples, same rules
//
// RESULT (2026 only):
// 1-3 min EMAs agree with almost every breakout (the breakout itself turns
// them), so they carry no information, and the AGE of the EMA trend tells
// little: rho about -0.1 on 1-5 min, only in Apr-Jul; ~0 on 10-30 min. Winners
// and losers look alike on both. What matters is agreeing with the INTRADAY
// trend: with the slow EMA spanning ~2.5-10 hours (5m 20/50, 10m 9/21, 10m
// 20/50, 3m 50/200 ...) "only breakouts the EMA agrees with" passes 65.7-76.3%
// vs 61.3%; spans over ~10 hours (multi-session trends) make it worse (35-56%).
// 10m EMA 9/21: 71.1% (Jan-Mar 74.2, Apr-Jul 75.1), every real window 74.8%
// (vs 59.7), 29/30 random-skip nulls beaten, ahead under delay, costs and
// breaker changes, level with a +$350 profit block or 3 lots. 10m 20/50: 76.3%
// (90.5 / 70.0) but right next to the cliff. The effect lives in the day's
// FIRST breakout (agree +$60 vs against -$14 a trade, n 95, wide CI), which is
// what the strategy mostly trades; later breakouts show none. Picked in-sample
// from 21 timeframe x pair cells.
//
//   node --max-old-space-size=8192 research/donchian_ema_age_2026.mjs

import { ema } from "../src/indicators.mjs";
import { resample } from "../src/resample.mjs";
import { loadBars } from "../src/data.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const T0 = Date.now();
const { bars } = loadBars();
const tf2 = M.tf, A2 = S.engineFor(2).atr, SIG = M.RESC;
const { open: O, high: H, low: L, close: C, ctMin: CT, tday: TD, ts: TS } = tf2;
const n2 = C.length;
const in26 = (k) => S.yearOf.get(TD[k]) === 2026;
const month = (k) => new Date(TS[k] + 43200e3).getUTCMonth();

// ---- EMA state on each timeframe -------------------------------------------------
// dir: sign(fast - slow) on each completed bar; since: the close time of the bar
// on which the current direction began
function emaState(tfMin, fast, slow) {
  const T = resample(bars, tfMin);
  const ef = ema(T.close, fast), es = ema(T.close, slow);
  const n = T.close.length, dir = new Int8Array(n), since = new Float64Array(n);
  let cur = 0, at = NaN;
  for (let j = 0; j < n; j++) {
    const d = Math.sign(ef[j] - es[j]) || 0;
    if (d !== cur) { cur = d; at = T.ts[j] + tfMin * 60000; }
    dir[j] = d; since[j] = at;
  }
  return { tfMin, ts: T.ts, dir, since };
}
// the EMA reading at the close of 2-min bar k: last bar of the timeframe that has closed by then
function readAt(st, k) {
  const tClose = TS[k] + 120000, lim = tClose - st.tfMin * 60000;
  let lo = 0, hi = st.ts.length - 1, j = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (st.ts[m] <= lim) { j = m; lo = m + 1; } else hi = m - 1; }
  if (j < 0) return null;
  return { dir: st.dir[j], age: (tClose - st.since[j]) / 60000 };
}

// ---- the strategy's own trades ------------------------------------------------------
const exit20 = (k, d, st) => k - st.entBar >= 20 && (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) < st.atr;
const sizer = (a, c, s, arm) => (M.adrUsed(arm - 1) >= 0.9 ? 2 : 4);
const FILL = { slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: 600, cancelOpposite: true, breaker: 300, profitBlock: 250 };
const strat = S.run(sizer, { signals: SIG, ...FILL, exitFn: exit20 }).filter((t) => S.yearOf.get(t.tday) === 2026)
  .map((t) => ({ k: t.sigBar, d: t.tday, s: SIG[t.sigBar], pnl: t.pnl, m: month(t.sigBar) }));

// ---- every 2026 signal, traded alone on a flat day by the same rules --------------------
const TICK = 0.25, SLIP = 0.25, FEE = 0.75, PV = 2, CAP = 600;
function simTrade(k) {
  const s = SIG[k], i0 = k + 1;
  if (!s || i0 >= n2 || TD[i0] !== TD[k] || CT[i0] >= 895 || CT[i0] < 510) return null;
  const a = A2[k];
  if (!(a > 0)) return null;
  const lots = M.adrUsed(k) >= 0.9 ? 2 : 4;
  const ref = O[i0], px = ref + s * Math.max(a * 0.15, TICK);
  let f = -1, lim = false;
  for (let i = i0 + 1; i <= i0 + 10 && i < n2; i++) {
    if (CT[i] >= 905 || CT[i] < 510 || TD[i] !== TD[k]) break;          // flat time ends the order
    if (SIG[i - 1] !== 0 && SIG[i - 1] !== s) break;                    // a signal the other way cancels it
    if (i === i0 + 1 && (s === 1 ? O[i] >= px : O[i] <= px)) { lim = true; if (s === 1 ? L[i] <= px : H[i] >= px) { f = i; break; } continue; }
    if (lim ? (s === 1 ? L[i] <= px : H[i] >= px) : (s === 1 ? H[i] >= px : L[i] <= px)) { f = i; break; }
  }
  if (f < 0) return null;
  const avg = px + s * SLIP, lossPx = avg - s * (CAP / (PV * lots)), rawSl = ref - s * Math.max(a * 5, TICK);
  const sl = s === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
  const isCap = s === 1 ? sl === lossPx && lossPx > rawSl : sl === lossPx && lossPx < rawSl;
  const tp = ref + s * Math.max(a * 1.75, TICK);
  const out = (x) => ((s === 1 ? x - SLIP : x + SLIP) - avg) * s * PV * lots - FEE * 2 * lots;
  let mx = px, mn = px;
  for (let i = f; i < n2; i++) {
    if (i > f && (CT[i] >= 905 || CT[i] < 510)) return out(O[i]);
    if (i - 1 >= f) { if (i - 1 === f) { mx = Math.max(mx, C[f]); mn = Math.min(mn, C[f]); } else { mx = Math.max(mx, H[i - 1]); mn = Math.min(mn, L[i - 1]); } }
    if (s === 1) {
      if (O[i] <= sl && i > f) return isCap ? -CAP : out(O[i]);
      if (L[i] <= sl) return isCap ? -CAP : out(sl);
      if (H[i] >= tp && !(lim && i === f && C[i] < tp)) return out(tp);
    } else {
      if (O[i] >= sl && i > f) return isCap ? -CAP : out(O[i]);
      if (H[i] >= sl) return isCap ? -CAP : out(sl);
      if (L[i] <= tp && !(lim && i === f && C[i] > tp)) return out(tp);
    }
    if (i > f && i - 1 - f >= 20 && (s === 1 ? mx - avg : avg - mn) < a) return out(O[i]);   // the 40-min exit
    if (i > f && SIG[i - 1] !== 0 && SIG[i - 1] !== s) return out(O[i]);                   // flip
  }
  return null;
}
const sigs = [];
for (let k = 1; k < n2; k++) if (SIG[k] && in26(k)) { const p = simTrade(k); if (p !== null) sigs.push({ k, d: TD[k], s: SIG[k], pnl: p, m: month(k) }); }

// ---- statistics -----------------------------------------------------------------------
const rnd = S.mul(2026);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const winp = (xs) => (100 * xs.filter((x) => x.pnl > 0).length) / Math.max(1, xs.length);
function bootDiff(a, b) {                                  // mean pnl of a minus b, resampling whole days
  const days = [...new Set([...a, ...b].map((x) => x.d))];
  const ga = new Map(), gb = new Map();
  for (const x of a) { const v = ga.get(x.d) || []; v.push(x.pnl); ga.set(x.d, v); }
  for (const x of b) { const v = gb.get(x.d) || []; v.push(x.pnl); gb.set(x.d, v); }
  const out = [];
  for (let r = 0; r < 400; r++) {
    let sa = 0, na = 0, sb = 0, nb = 0;
    for (let j = 0; j < days.length; j++) {
      const d = days[Math.floor(rnd() * days.length)];
      for (const v of ga.get(d) || []) { sa += v; na++; }
      for (const v of gb.get(d) || []) { sb += v; nb++; }
    }
    if (na && nb) out.push(sa / na - sb / nb);
  }
  out.sort((x, y) => x - y);
  return [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]];
}
function spearman(xs, ys) {
  const rank = (v) => { const ix = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); ix.forEach(([, i], q) => { r[i] = q; }); return r; };
  const rx = rank(xs), ry = rank(ys), mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}
function bootRho(xs) {                                      // xs: [{d, age, pnl}] -> rho and a day-clustered CI
  const days = [...new Set(xs.map((x) => x.d))], g = new Map();
  for (const x of xs) { const v = g.get(x.d) || []; v.push(x); g.set(x.d, v); }
  const out = [];
  for (let r = 0; r < 200; r++) {
    const smp = [];
    for (let j = 0; j < days.length; j++) for (const x of g.get(days[Math.floor(rnd() * days.length)])) smp.push(x);
    out.push(spearman(smp.map((x) => x.age), smp.map((x) => x.pnl)));
  }
  out.sort((a, b) => a - b);
  return { rho: spearman(xs.map((x) => x.age), xs.map((x) => x.pnl)), lo: out[5], hi: out[194] };
}
const f0 = (x, w = 6) => (Number.isFinite(x) ? Math.round(x).toString() : "-").padStart(w);
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const f2 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(2) : "-").padStart(w);
const med = (v) => { const b = v.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };

const TFS = [1, 2, 3, 4, 5, 10, 15, 30];
console.log(`2026: ${strat.length} strategy trades (${winp(strat).toFixed(0)}% winners, $${mean(strat.map((x) => x.pnl)).toFixed(0)} a trade); ${sigs.length} breakout signals traded alone (${winp(sigs).toFixed(0)}% winners, $${mean(sigs.map((x) => x.pnl)).toFixed(0)} a trade)`);
const AGEB = [[0, 5], [5, 15], [15, 30], [30, 60], [60, 120], [120, 240], [240, 1e9]];
const summary = [];
for (const [fast, slow] of [[9, 21], [20, 50]]) {
  console.log("\n" + "=".repeat(118) + `\nEMA ${fast}/${slow}\n` + "=".repeat(118));
  console.log("\n  A. does the EMA point the breakout's way? (signals = every breakout traded alone; trades = the strategy's)");
  console.log("     TF    signals: agree%  $/tr agree  $/tr against   diff [95% CI]     win% agree/against | trades: agree% of winners / losers   $/tr agree (n) / against (n)");
  const st = {};
  for (const tfMin of TFS) {
    const E = emaState(tfMin, fast, slow);
    st[tfMin] = E;
    for (const x of sigs) { const r = readAt(E, x.k); x["a" + tfMin] = r ? r.dir === x.s : null; x["g" + tfMin] = r ? r.age : NaN; }
    for (const x of strat) { const r = readAt(E, x.k); x["a" + tfMin] = r ? r.dir === x.s : null; x["g" + tfMin] = r ? r.age : NaN; }
    const ag = sigs.filter((x) => x["a" + tfMin] === true), ng = sigs.filter((x) => x["a" + tfMin] === false);
    const [lo, hi] = ng.length >= 10 ? bootDiff(ag, ng) : [NaN, NaN];
    const sw = strat.filter((x) => x.pnl > 0), sl = strat.filter((x) => x.pnl <= 0);
    const tA = strat.filter((x) => x["a" + tfMin] === true), tN = strat.filter((x) => x["a" + tfMin] === false);
    const pctA = (xs) => (100 * xs.filter((x) => x["a" + tfMin] === true).length) / Math.max(1, xs.length);
    console.log("   " + String(tfMin).padStart(3) + "m  " + f1(100 * ag.length / sigs.length, 13) + f0(mean(ag.map((x) => x.pnl)), 12) + f0(mean(ng.map((x) => x.pnl)), 14) +
                f0(mean(ag.map((x) => x.pnl)) - mean(ng.map((x) => x.pnl)), 8) + " [" + f0(lo, 4) + "," + f0(hi, 4) + "]" + f1(winp(ag), 10) + " /" + f1(winp(ng), 5) +
                " |" + f1(pctA(sw), 22) + " /" + f1(pctA(sl), 5) + f0(mean(tA.map((x) => x.pnl)), 14) + " (" + tA.length + ") /" + f0(mean(tN.map((x) => x.pnl)), 5) + " (" + tN.length + ")");
    summary.push({ pair: fast + "/" + slow, tfMin, agreePct: 100 * ag.length / sigs.length, diff: mean(ag.map((x) => x.pnl)) - mean(ng.map((x) => x.pnl)), lo, hi,
                   h1: mean(ag.filter((x) => x.m < 3).map((x) => x.pnl)) - mean(ng.filter((x) => x.m < 3).map((x) => x.pnl)),
                   h2: mean(ag.filter((x) => x.m >= 3).map((x) => x.pnl)) - mean(ng.filter((x) => x.m >= 3).map((x) => x.pnl)) });
  }
  console.log("\n  B. how long since the EMA crossed into the breakout's direction (agreeing breakouts only; signals)");
  console.log("     TF   age (min):" + AGEB.map(([a, b]) => (b > 1e8 ? a + "+" : a + "-" + b).padStart(16)).join("") + "   | rho(age, $) [95% CI]   Jan-Mar / Apr-Jul | trades: median age winners / losers");
  for (const tfMin of TFS) {
    const ag = sigs.filter((x) => x["a" + tfMin] === true);
    const cells = AGEB.map(([a, b]) => { const xs = ag.filter((x) => x["g" + tfMin] >= a && x["g" + tfMin] < b); return xs.length >= 8 ? (f0(mean(xs.map((x) => x.pnl)), 5) + " " + f0(winp(xs), 3) + "% n" + String(xs.length).padEnd(3)).padStart(16) : "".padStart(16); });
    const rr = bootRho(ag.map((x) => ({ d: x.d, age: x["g" + tfMin], pnl: x.pnl })));
    const r1 = spearman(ag.filter((x) => x.m < 3).map((x) => x["g" + tfMin]), ag.filter((x) => x.m < 3).map((x) => x.pnl));
    const r2 = spearman(ag.filter((x) => x.m >= 3).map((x) => x["g" + tfMin]), ag.filter((x) => x.m >= 3).map((x) => x.pnl));
    const tw = strat.filter((x) => x.pnl > 0 && x["a" + tfMin] === true).map((x) => x["g" + tfMin]);
    const tl = strat.filter((x) => x.pnl <= 0 && x["a" + tfMin] === true).map((x) => x["g" + tfMin]);
    console.log("   " + String(tfMin).padStart(3) + "m          " + cells.join("") + "   |" + f2(rr.rho, 7) + " [" + f2(rr.lo, 5) + "," + f2(rr.hi, 5) + "]" + f2(r1, 9) + " /" + f2(r2, 6) +
                " |" + f0(med(tw), 14) + " /" + f0(med(tl), 5));
  }
  console.log("     (each age cell: $ a trade, win%, n)");
}
console.log("\n  agreeing minus against, $ a trade by half of 2026 (signals)");
for (const r of summary) if (Number.isFinite(r.lo)) console.log("   EMA " + r.pair.padEnd(6) + String(r.tfMin).padStart(3) + "m   all " + f0(r.diff, 5) + "  [" + f0(r.lo, 4) + "," + f0(r.hi, 4) + "]   Jan-Mar " + f0(r.h1, 5) + "   Apr-Jul " + f0(r.h2, 5) + "   (" + f1(r.agreePct, 5) + "% agree)");

// ---- C. the strongest-looking EMA rules as entry filters on the full strategy ------------
// (entries only, so every signal still flips/exits; null: skip the same share of
// 2026 entries at random, 30 runs)
const pass = (arr, ix) => S.passArr(ix.map((k) => arr[k]), { target: 1250, dd: 1000, consistency: 0.5 });
function runGate(keep) {
  const sz = (a, c, s2, arm) => (in26(arm - 1) && keep && !keep(arm - 1) ? 0 : sizer(a, c, s2, arm));
  const tr = S.run(sz, { signals: SIG, ...FILL, exitFn: exit20 }).filter((t) => S.yearOf.get(t.tday) === 2026);
  const arr = S.dayArr(tr, S.days);
  return { n: tr.length, exp: mean(tr.map((t) => t.pnl)), y: pass(arr, M.Y26), a: pass(arr, M.Y26a), b: pass(arr, M.Y26b) };
}
const E15 = emaState(15, 9, 21), E5 = emaState(5, 9, 21), E3 = emaState(3, 9, 21), E10b = emaState(10, 20, 50);
const at = (E, k) => readAt(E, k) || { dir: 0, age: NaN };
const GATES = [
  ["15m EMA 9/21 points the breakout's way", (k) => at(E15, k).dir === SIG[k]],
  ["15m EMA 9/21 points AGAINST it", (k) => at(E15, k).dir === -SIG[k]],
  ["10m EMA 20/50 points the breakout's way", (k) => at(E10b, k).dir === SIG[k]],
  ["5m EMA 9/21 cross under 30 min old", (k) => at(E5, k).dir === SIG[k] && at(E5, k).age < 30],
  ["3m EMA 9/21 cross under 30 min old", (k) => at(E3, k).dir === SIG[k] && at(E3, k).age < 30],
  ["skip 5m EMA 9/21 trends 30-60 min old", (k) => !(at(E5, k).dir === SIG[k] && at(E5, k).age >= 30 && at(E5, k).age < 60)],
];
console.log("\n  C. AS FILTERS ON THE STRATEGY (pass rate 2026, Jan-Mar / Apr-Jul; null = skip as many entries at random)");
const base = runGate(null);
console.log("     " + "without (the strategy as built)".padEnd(44) + f1(base.y) + f1(base.a, 7) + " /" + f1(base.b, 5) + String(base.n).padStart(6) + " trades  $" + base.exp.toFixed(0) + "/trade");
for (const [lbl, keep] of GATES) {
  const r = runGate(keep);
  let tot = 0, kept = 0;
  for (let k = 1; k < n2; k++) if (SIG[k] && in26(k)) { tot++; if (keep(k)) kept++; }
  const ys = [];
  for (let w = 1; w <= 30; w++) { const rr = S.mul(4400 + w), ok = new Uint8Array(n2); for (let k = 0; k < n2; k++) if (SIG[k]) ok[k] = rr() < kept / tot ? 1 : 0; ys.push(runGate((k) => ok[k] === 1).y); }
  ys.sort((x, y) => x - y);
  console.log("     " + ("only: " + lbl).padEnd(44) + f1(r.y) + f1(r.a, 7) + " /" + f1(r.b, 5) + String(r.n).padStart(6) + " trades  $" + r.exp.toFixed(0) + "/trade   " +
              (100 * kept / tot).toFixed(0) + "% kept; random: median " + ys[15].toFixed(1) + ", max " + ys[29].toFixed(1) + " (beats " + ys.filter((v) => r.y > v).length + "/30)");
}

// ---- D. is "the higher-timeframe EMA agrees" a broad effect or one lucky cell? -----------
function runFull(keep, { sig = SIG, extra = {}, lots = null } = {}) {
  const sz = (a, c, s2, arm) => (in26(arm - 1) && keep && !keep(arm - 1) ? 0 : (lots ? lots(arm - 1) : sizer(a, c, s2, arm)));
  const tr = S.run(sz, { signals: sig, ...FILL, exitFn: exit20, ...extra }).filter((t) => S.yearOf.get(t.tday) === 2026);
  const arr = S.dayArr(tr, S.days), d = M.Y26.map((k) => arr[k]);
  let cp = 0, cn = 0;
  for (let q = 0; q + 21 <= d.length; q++) { cp += S.evWith(d.slice(q, q + 21), { target: 1250, dd: 1000, consistency: 0.5 }); cn++; }
  const jack = (K) => { const best = M.Y26.map((k) => [k, arr[k]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, K);
    const a = Float64Array.from(arr); for (const [k] of best) a[k] = 0; return pass(a, M.Y26); };
  const mo = new Array(7).fill(0);
  for (const t of tr) mo[new Date(TS[S.dayFirstBar.get(t.tday)] + 43200e3).getUTCMonth()] += t.pnl;
  return { n: tr.length, exp: mean(tr.map((t) => t.pnl)), y: pass(arr, M.Y26), a: pass(arr, M.Y26a), b: pass(arr, M.Y26b), real: (100 * cp) / cn, j5: jack(5), mo };
}
console.log("\n  D1. ONLY BREAKOUTS THE EMA AGREES WITH -- every timeframe x pair (2026 / Jan-Mar / Apr-Jul, trades, $/trade)");
const grid = [];
const PAIRS = [[9, 21], [20, 50], [50, 200]];
console.log("     " + "".padEnd(8) + PAIRS.map(([a, b]) => ("EMA " + a + "/" + b).padStart(34)).join(""));
for (const tfMin of [2, 3, 5, 10, 15, 30, 60]) {
  const cells = [];
  for (const [fa, sl2] of PAIRS) {
    const E = emaState(tfMin, fa, sl2);
    const r = runFull((k) => (readAt(E, k) || { dir: 0 }).dir === SIG[k]);
    grid.push({ lbl: tfMin + "m " + fa + "/" + sl2, r });
    cells.push((f1(r.y, 5) + f1(r.a, 6) + "/" + f1(r.b, 5).trim() + String(r.n).padStart(5) + " $" + String(Math.round(r.exp)).padEnd(4)).padStart(34));
  }
  console.log("     " + (tfMin + "m").padEnd(8) + cells.join(""));
}
console.log("     without: " + base.y.toFixed(1) + " (" + base.a.toFixed(1) + " / " + base.b.toFixed(1) + ")");
const better = grid.filter((g) => g.r.y > base.y).length, both = grid.filter((g) => g.r.a > base.a && g.r.b > base.b).length;
console.log(`     ${better} of ${grid.length} cells beat the strategy as built; ${both} beat it in BOTH halves`);
for (const [fit, test, fl, tl] of [["a", "b", "Jan-Mar", "Apr-Jul"], ["b", "a", "Apr-Jul", "Jan-Mar"]]) {
  const top = grid.slice().sort((x, y) => y.r[fit] - x.r[fit])[0];
  console.log(`     picked on ${fl}: ${top.lbl} -> ${top.r[test].toFixed(1)}% on ${tl} (without: ${base[test].toFixed(1)}%)`);
}

// D2. stress the leading cell against the strategy as built
const E10 = emaState(10, 20, 50);
const agree10 = (k) => (readAt(E10, k) || { dir: 0 }).dir === SIG[k];
const shift1 = (a) => { const o = new Int8Array(a.length); for (let i2 = 1; i2 < a.length; i2++) o[i2] = a[i2 - 1]; return o; };
console.log("\n  D2. STRESS: without -> only when the 10m EMA 20/50 agrees   (2026, Jan-Mar / Apr-Jul)");
for (const [lbl, o0, o1] of [
  ["as tested", {}, {}],
  ["one bar later", { sig: shift1(SIG) }, { sig: shift1(SIG), shiftGate: true }],
  ["2 ticks slippage", { extra: { slipMult: 2 } }, { extra: { slipMult: 2 } }],
  ["breaker -$200", { extra: { breaker: 200 } }, { extra: { breaker: 200 } }],
  ["breaker -$400", { extra: { breaker: 400 } }, { extra: { breaker: 400 } }],
  ["profit block +$150", { extra: { profitBlock: 150 } }, { extra: { profitBlock: 150 } }],
  ["profit block +$350", { extra: { profitBlock: 350 } }, { extra: { profitBlock: 350 } }],
  ["3 lots (2 late)", { lots: (k) => (M.adrUsed(k) >= 0.9 ? 2 : 3) }, { lots: (k) => (M.adrUsed(k) >= 0.9 ? 2 : 3) }],
  ["5 lots (3 late)", { lots: (k) => (M.adrUsed(k) >= 0.9 ? 3 : 5) }, { lots: (k) => (M.adrUsed(k) >= 0.9 ? 3 : 5) }],
]) {
  const r0 = runFull(null, o0);
  const g = o1.shiftGate ? (k) => agree10(k - 1) : agree10;
  const { shiftGate, ...o1b } = o1;
  const r1 = runFull(g, o1b);
  console.log("     " + lbl.padEnd(22) + f1(r0.y) + " ->" + f1(r1.y) + "   (" + f1(r0.a, 5) + " ->" + f1(r1.a, 5) + ",  " + f1(r0.b, 5) + " ->" + f1(r1.b, 5) + ")");
}
{
  const r0 = runFull(null), r1 = runFull(agree10);
  const M7 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"];
  console.log("     every real 21-day window: " + r0.real.toFixed(1) + " -> " + r1.real.toFixed(1) + ";  best 5 days removed: " + r0.j5.toFixed(1) + " -> " + r1.j5.toFixed(1));
  console.log("     $ by month without: " + M7.map((m, i2) => m + " " + Math.round(r0.mo[i2])).join("  "));
  console.log("     $ by month with:    " + M7.map((m, i2) => m + " " + Math.round(r1.mo[i2])).join("  "));
}

// D3. why do the two samples disagree? the first breakout of the day vs the rest
{
  const firstOfDay = new Set();
  let cd = -1;
  for (let k = 1; k < n2; k++) if (SIG[k] && in26(k) && TD[k] !== cd) { cd = TD[k]; firstOfDay.add(k); }
  for (const x of sigs) { const r = readAt(E10, x.k); x.ag10 = r ? r.dir === x.s : null; }
  console.log("\n  D3. every breakout traded alone, split by the 10m EMA 20/50 -- first breakout of the day vs later ones");
  for (const [lbl, test] of [["first breakout of the day", (x) => firstOfDay.has(x.k)], ["later breakouts", (x) => !firstOfDay.has(x.k)], ["all", () => true]]) {
    const xs = sigs.filter(test), a = xs.filter((x) => x.ag10 === true), b = xs.filter((x) => x.ag10 === false);
    const [lo, hi] = bootDiff(a, b);
    console.log("     " + lbl.padEnd(28) + "agree $" + f0(mean(a.map((x) => x.pnl)), 4) + " (n " + a.length + ", " + winp(a).toFixed(0) + "% win)   against $" + f0(mean(b.map((x) => x.pnl)), 4) +
                " (n " + b.length + ", " + winp(b).toFixed(0) + "% win)   diff " + f0(mean(a.map((x) => x.pnl)) - mean(b.map((x) => x.pnl)), 4) + " [" + f0(lo, 4) + "," + f0(hi, 4) + "]");
  }
}

// ---- D4. the middle of the plateau: 10m EMA 9/21 -- stress and a random-skip null ---------
{
  const E10f = emaState(10, 9, 21);
  const ag = (k) => (readAt(E10f, k) || { dir: 0 }).dir === SIG[k];
  console.log("\n  D4. STRESS: without -> only when the 10m EMA 9/21 agrees   (2026, Jan-Mar / Apr-Jul)");
  for (const [lbl, o0, o1] of [["as tested", {}, {}], ["one bar later", { sig: shift1(SIG) }, { sig: shift1(SIG), shiftGate: true }],
                               ["2 ticks slippage", { extra: { slipMult: 2 } }, { extra: { slipMult: 2 } }],
                               ["breaker -$200", { extra: { breaker: 200 } }, { extra: { breaker: 200 } }], ["breaker -$400", { extra: { breaker: 400 } }, { extra: { breaker: 400 } }],
                               ["profit block +$150", { extra: { profitBlock: 150 } }, { extra: { profitBlock: 150 } }], ["profit block +$350", { extra: { profitBlock: 350 } }, { extra: { profitBlock: 350 } }],
                               ["3 lots (2 late)", { lots: (k) => (M.adrUsed(k) >= 0.9 ? 2 : 3) }, { lots: (k) => (M.adrUsed(k) >= 0.9 ? 2 : 3) }],
                               ["5 lots (3 late)", { lots: (k) => (M.adrUsed(k) >= 0.9 ? 3 : 5) }, { lots: (k) => (M.adrUsed(k) >= 0.9 ? 3 : 5) }]]) {
    const r0 = runFull(null, o0);
    const g = o1.shiftGate ? (k) => ag(k - 1) : ag;
    const { shiftGate, ...o1b } = o1;
    const r1 = runFull(g, o1b);
    console.log("     " + lbl.padEnd(22) + f1(r0.y) + " ->" + f1(r1.y) + "   (" + f1(r0.a, 5) + " ->" + f1(r1.a, 5) + ",  " + f1(r0.b, 5) + " ->" + f1(r1.b, 5) + ")");
  }
  const r0 = runFull(null), r1 = runFull(ag);
  const M7 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"];
  console.log("     every real 21-day window: " + r0.real.toFixed(1) + " -> " + r1.real.toFixed(1) + ";  best 5 days removed: " + r0.j5.toFixed(1) + " -> " + r1.j5.toFixed(1));
  console.log("     $ by month with:    " + M7.map((m, i2) => m + " " + Math.round(r1.mo[i2])).join("  "));
  let tot = 0, kept = 0;
  for (let k = 1; k < n2; k++) if (SIG[k] && in26(k)) { tot++; if (ag(k)) kept++; }
  const ys = [];
  for (let w = 1; w <= 30; w++) { const rr = S.mul(5500 + w), ok = new Uint8Array(n2); for (let k = 0; k < n2; k++) if (SIG[k]) ok[k] = rr() < kept / tot ? 1 : 0; ys.push(runFull((k) => ok[k] === 1).y); }
  ys.sort((x, y) => x - y);
  console.log("     random-skip null (" + (100 * kept / tot).toFixed(0) + "% kept, 30 runs): median " + ys[15].toFixed(1) + ", max " + ys[29].toFixed(1) + "  vs " + r1.y.toFixed(1) + " (beats " + ys.filter((v) => r1.y > v).length + "/30)");
}
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
