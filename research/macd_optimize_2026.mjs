// Optimal entries and exits for the 1-min MACD fade under the $1,250 rules.
// 2026 ONLY, honest fills, realistic costs, cancelOpposite, and (from step 1)
// honest exit ordering.
//
// What the anatomy (macd_anatomy_2026.mjs) found, and the reasons proposed:
//   * the fade has no edge on average (-0.7 pts a trade after costs); the edge
//     is the FIRST fade of the day (+10.6 pts [+2.1, +19.6]), at the open,
//     when volatility and one-sided order flow are highest -- liquidity
//     provision pays most then (Nagel 2012)
//   * fading WITH the larger MACD trend (a pullback) beats fading a push in the
//     trend's direction: +0.7 vs -3.0 pts, both halves -- trend pushes carry
//     information and continue, pullbacks are liquidity and revert
//   * fading a pullback just short of VWAP: +5.5; fading an opening-range
//     break: -2.0 (stop clusters run)
//   * right after the fill price keeps going against the fade ~5 min
//     (-2 pts), then comes back -- a limit further into the push may fill
//     better
// Each step below is a small grid; every row shows Jan-Mar and Apr-Jul, and
// each grid is checked by picking on one half and reading the other.
//
// RESULT (2026 only):
// Exits: nothing beats the next cross plus the wide bracket. With the honest
// order (the flip at the open first) the setup is 58.6% (Jan-Mar 48.6, Apr-Jul
// 72.8) at $58 a trade -- 13 "targets" were really flips. Targets, time exits,
// holding through the cross, tighter stops, break-even, a histogram-turn exit
// and a push-retracement exit all lose or fail the half-pick test.
// Entries: limits into the push are a disaster (31-38%: they fill when the
// push keeps going); bigger stop-entry offsets help Jan-Mar only (0.4 ATR's
// 65.5% is a spike, 37% one bar late); fading the opening drive without the
// MACD fails (<= 37%); high relative volume makes fades worse.
// Best: fade only "weak" crosses -- the MACD line already on the fade's side,
// a bounce against the short-term trend -- and only when the 1-min ATR is at
// least its 10-session average: 67.7% (Jan-Mar 64.8, Apr-Jul 73.8), every real
// window 57.1% (vs 47.1), $94 a trade, best 5 days removed 63.7% (vs 55.3), a
// threshold plateau at 0.8-1.1x (65.7-67.7), all 30 random-drop nulls beaten,
// and ahead under costs, breaker/profit-block changes and +/-1 lot. Weak spots:
// one bar late it is 45.0% (baseline 49.3); the pullback filter works only with
// the MACD line (VWAP side, EMA 50/200, 5-min MACD, opening drive all hurt);
// March lost money.
//
//   node --max-old-space-size=8192 research/macd_optimize_2026.mjs

import { macd, ema } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const T0 = Date.now();
const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const E1 = S.engineFor(1), t = E1.tf, A = E1.atr;
const { open: O, high: H, low: L, close: C, volume: V, ctMin: CT, tday: TD } = t;
const n = C.length;
const { line: ML, hist: HS } = macd(C, 12, 26, 9);
const SIGA = new Int8Array(n);
for (let i = 1; i < n; i++) {
  if (!(CT[i] >= 510 && CT[i] < 900)) continue;
  SIGA[i] = -(HS[i] > 0 && HS[i - 1] <= 0 ? 1 : HS[i] < 0 && HS[i - 1] >= 0 ? -1 : 0);
}
// session VWAP and 15-min opening range, causal
const vwap = new Float64Array(n).fill(NaN), orHi = new Float64Array(n).fill(NaN), orLo = new Float64Array(n).fill(NaN);
{
  let cd = -1, pv = 0, vv = 0, oh = -Infinity, ol = Infinity;
  for (let i = 0; i < n; i++) {
    if (!(CT[i] >= 510 && CT[i] < 900)) continue;
    if (TD[i] !== cd) { cd = TD[i]; pv = 0; vv = 0; oh = -Infinity; ol = Infinity; }
    pv += ((H[i] + L[i] + C[i]) / 3) * V[i]; vv += V[i];
    vwap[i] = vv > 0 ? pv / vv : C[i];
    if (CT[i] < 525) { oh = Math.max(oh, H[i]); ol = Math.min(ol, L[i]); }
    orHi[i] = oh; orLo[i] = ol;
  }
}
// the "bigger trend" four other ways, to see whether the pullback effect depends
// on one definition: day's VWAP side, 1-min EMA 50/200, EMA 60/130 (the 5-min
// MACD's EMAs) and the opening drive (open to 08:45, or to now before then)
const E50 = ema(C, 50), E200 = ema(C, 200), E60 = ema(C, 60), E130 = ema(C, 130);
const odSign = new Int8Array(n);
{
  let cd = -1, o0 = 0, fixed = 0;
  for (let i = 0; i < n; i++) {
    if (!(CT[i] >= 510 && CT[i] < 900)) continue;
    if (TD[i] !== cd) { cd = TD[i]; o0 = O[i]; fixed = 0; }
    if (CT[i] === 544 && !fixed) fixed = Math.sign(C[i] - o0) || 0;
    odSign[i] = CT[i] < 545 || !fixed ? Math.sign(C[i] - o0) || 0 : fixed;
  }
}
// where the push being faded began: the extreme since the previous cross
const pushStart = new Float64Array(n).fill(NaN);
{
  let lc = -1;
  for (let i = 1; i < n; i++) {
    const cr = (HS[i] > 0 && HS[i - 1] <= 0) || (HS[i] < 0 && HS[i - 1] >= 0);
    if (cr && lc >= 0) {
      let x = HS[i] > 0 ? Infinity : -Infinity;          // up cross: the push began at the low
      for (let j = lc; j <= i; j++) x = HS[i] > 0 ? Math.min(x, L[j]) : Math.max(x, H[j]);
      pushStart[i] = x;
    }
    if (cr) lc = i;
  }
}
// relative volume of the last 5 minutes vs the same minutes of the previous 10 sessions,
// and ATR vs its 10-session RTH average (Campbell-Grossman-Wang; Nagel)
const rvol = new Float64Array(n).fill(NaN), volRel = new Float64Array(n).fill(NaN);
{
  const days = [], first = new Map(), last = new Map();
  for (let i = 0; i < n; i++) if (CT[i] >= 510 && CT[i] < 900) { if (!first.has(TD[i])) { first.set(TD[i], i); days.push(TD[i]); } last.set(TD[i], i); }
  const vm = new Map(), am = new Map();
  for (const d of days) { const a = new Float64Array(390); let s2 = 0, c2 = 0; for (let i = first.get(d); i <= last.get(d); i++) { a[CT[i] - 510] = V[i]; s2 += A[i]; c2++; } vm.set(d, a); am.set(d, s2 / c2); }
  days.forEach((d, q) => {
    if (q < 10 || S.yearOf.get(d) !== 2026) return;
    const prev = days.slice(q - 10, q);
    const aAvg = prev.reduce((x, p) => x + am.get(p), 0) / 10;
    for (let i = first.get(d); i <= last.get(d); i++) {
      let mine = 0, base = 0;
      for (let j = Math.max(first.get(d), i - 4); j <= i; j++) mine += V[j];
      for (const p of prev) { const a = vm.get(p); for (let m = CT[i] - 4; m <= CT[i]; m++) base += m >= 510 ? a[m - 510] : 0; }
      rvol[i] = base > 0 ? mine / (base / 10) : NaN;
      volRel[i] = A[i] / aAvg;
    }
  });
}
// two day-level volatility measures known by 08:30: the opening 1-min ATR vs its
// 10-session average at the same bar, and yesterday's RTH range vs its 10-session average
const openVol = new Float64Array(n).fill(NaN), prevRange = new Float64Array(n).fill(NaN);
{
  const days = [], first = new Map(), last = new Map();
  for (let i = 0; i < n; i++) if (CT[i] >= 510 && CT[i] < 900) { if (!first.has(TD[i])) { first.set(TD[i], i); days.push(TD[i]); } last.set(TD[i], i); }
  const rng = new Map();
  for (const d of days) { let hi = -Infinity, lo = Infinity; for (let i = first.get(d); i <= last.get(d); i++) { hi = Math.max(hi, H[i]); lo = Math.min(lo, L[i]); } rng.set(d, hi - lo); }
  days.forEach((d, q) => {
    if (q < 11) return;
    const prev = days.slice(q - 10, q);
    const o0 = A[first.get(d)], oAvg = prev.reduce((x, p) => x + A[first.get(p)], 0) / 10;
    const r1 = rng.get(days[q - 1]), rAvg = days.slice(q - 11, q - 1).reduce((x, p) => x + rng.get(p), 0) / 10;
    for (let i = first.get(d); i <= last.get(d); i++) { openVol[i] = o0 / oAvg; prevRange[i] = r1 / rAvg; }
  });
}
// a non-MACD entry, from the anatomy's main result: fade the OPENING DRIVE --
// at 08:30+m, if price has moved at least x ATR from the 08:30 open, fade it once
function openingDrive(m, x) {
  const o = new Int8Array(n);
  let cd = -1, o0 = 0;
  for (let i = 0; i < n; i++) {
    if (!(CT[i] >= 510 && CT[i] < 900)) continue;
    if (TD[i] !== cd) { cd = TD[i]; o0 = O[i]; }
    if (CT[i] === 510 + m - 1 && Math.abs(C[i] - o0) >= x * A[i]) o[i] = -Math.sign(C[i] - o0);
  }
  return o;
}
const GATES = {
  trendVwap: (k, s) => Math.sign(C[k] - vwap[k]) === s,
  trend50: (k, s) => Math.sign(E50[k] - E200[k]) === s,
  trend5m: (k, s) => Math.sign(E60[k] - E130[k]) === s,
  trendDrive: (k, s) => odSign[k] === s,
  withTrend: (k, s) => Math.sign(ML[k]) === s,
  vwapZone: (k, s) => { const z = (s * (vwap[k] - C[k])) / A[k]; return z > -1 && z < 0; },
  notOrBreak: (k, s) => !(CT[k] >= 525 && ((s === -1 && C[k] > orHi[k]) || (s === 1 && C[k] < orLo[k]))),
  wick: (k, s) => { const r = H[k] - L[k]; return r > 0 && (s === -1 ? H[k] - Math.max(O[k], C[k]) : Math.min(O[k], C[k]) - L[k]) / r >= 0.3; },
};

const BASE = { exitFirst: false, tpAtr: 5.15, slAtr: 5, timeExit: 0, noFlip: false, trig: 0.15, limitAtr: null, addWin: 10,
               maxPerDay: 99, lastEntryCt: 895, gate: null, lots: 4, breaker: 200, pb: 250, be: 0, histExit: false };
const pass = (arr, ix) => S.passArr(ix.map((k) => arr[k]), RULES);
function run(over = {}) {
  const c = { ...BASE, ...over };
  let day = -1, count = 0;
  const sizer = (a, ct, sq, arm) => {
    if (TD[arm] !== day) { day = TD[arm]; count = 0; }
    if (ct >= c.lastEntryCt || count >= c.maxPerDay) return 0;
    if (c.gate && S.yearOf.get(TD[arm]) === 2026 && !c.gate(arm - 1, (c.sig || SIGA)[arm - 1])) return 0;
    count++;
    return c.lots;
  };
  const exitFn = c.timeExit || c.histExit || c.retrace || c.macdExit ? (k, d, st) => {
    if (c.timeExit && k - st.entBar >= c.timeExit) return true;
    if (c.macdExit && SIGA[k] === -d) return true;                // the MACD cross that would flip it
    if (c.retrace) {
      // out once the close has taken back `retrace` of the push that was faded
      const sb = st.sigBar, p0 = pushStart[sb], tgt = C[sb] + (p0 - C[sb]) * c.retrace;
      if (Number.isFinite(p0) && d * (C[k] - tgt) >= 0) return true;
    }
    // the move in the trade's favour has stopped accelerating: the histogram, on
    // the trade's side of zero, shrank for 2 bars after the entry
    if (c.histExit && k - st.entBar >= 2 && Math.sign(HS[k]) === d && Math.abs(HS[k]) < Math.abs(HS[k - 1]) && Math.abs(HS[k - 1]) < Math.abs(HS[k - 2])) return true;
    return false;
  } : null;
  const stopFn = c.be ? (k, st) => ((st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) >= c.be * st.atr ? st.fill + st.dir * 0.5 : null) : null;
  const tr = E1.run(sizer, {
    signals: c.sig || SIGA, slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: 600, cancelOpposite: true,
    exitFirst: c.exitFirst, noFlip: c.noFlip, entryLimitAtr: c.limitAtr, trig: c.trig, addWin: c.addWin, slMult: c.slAtr,
    tpFromFill: true, tpFn: (a, q) => Math.min(c.tpAtr * a, 600 / (2 * q)), exitFn, stopFn,
    breaker: c.breaker, profitBlock: c.pb, ...(c.extra || {}),
  }).filter((x) => S.yearOf.get(x.tday) === 2026);
  const arr = S.dayArr(tr, S.days), d = M.Y26.map((k) => arr[k]);
  let cp = 0, cn = 0;
  for (let s = 0; s + 21 <= d.length; s++) { cp += S.evWith(d.slice(s, s + 21), RULES); cn++; }
  const by = {};
  for (const x of tr) by[x.why] = (by[x.why] || 0) + 1;
  return { n: tr.length, exp: tr.reduce((s, x) => s + x.pnl, 0) / Math.max(1, tr.length),
           win: (100 * tr.filter((x) => x.pnl > 0).length) / Math.max(1, tr.length),
           y: pass(arr, M.Y26), a: pass(arr, M.Y26a), b: pass(arr, M.Y26b), real: (100 * cp) / cn, by };
}
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const HD = "  " + "".padEnd(52) + "  2026 JanMar AprJul  real trades  win%   $/tr";
const line = (lbl, r) => "  " + lbl.padEnd(52) + f1(r.y) + f1(r.a, 7) + f1(r.b, 7) + f1(r.real) + String(r.n).padStart(7) + f1(r.win) + f1(r.exp, 7);
function grid(title, rows, ref) {
  console.log("\n" + title + "\n" + HD);
  const res = rows.map(([lbl, over]) => { const r = run(over); console.log(line(lbl, r)); return { lbl, over, r }; });
  for (const [fit, test, fl, tl] of [["a", "b", "Jan-Mar", "Apr-Jul"], ["b", "a", "Apr-Jul", "Jan-Mar"]]) {
    const top = res.slice().sort((x, y) => y.r[fit] - x.r[fit])[0];
    console.log(`    picked on ${fl}: ${top.lbl.trim()} -> ${top.r[test].toFixed(1)}% on ${tl} (reference ${ref[test].toFixed(1)}%)`);
  }
  return res;
}

// ---- 1. honest exit ordering --------------------------------------------------
console.log("1. EXIT ORDERING: a flip decided on the closed bar happens at the next open, before that bar's target/stop");
console.log(HD);
const r0 = run();
console.log(line("as built (stop/target checked before the flip)", r0) + "   exits " + JSON.stringify(r0.by));
const ref = run({ exitFirst: true });
console.log(line("flip first (causal)", ref) + "   exits " + JSON.stringify(ref.by));
BASE.exitFirst = true;

// ---- 2. exits ------------------------------------------------------------------
grid("2a. TARGET from the stop-entry (ATR; capped at the flat-day stop, 75 pts)",
     [1, 1.5, 2, 2.5, 3, 4, 5.15].map((x) => [`target ${x} ATR`, { tpAtr: x }]), ref);
grid("2b. TIME EXIT: out at the next open N minutes after the fill (still flips at the next cross)",
     [3, 5, 10, 15, 20, 30, 45, 0].map((x) => [x ? `out after ${x} min` : "no time exit", { timeExit: x }]), ref);
grid("2c. HOLD THROUGH THE NEXT CROSS (no flip exit): bracket and time only",
     [[2, 0], [3, 0], [5.15, 0], [3, 15], [3, 30], [5.15, 30], [5.15, 60], [5.15, 0]].map(([tp, te]) => [`no flip, target ${tp} ATR${te ? ", out after " + te + " min" : ""}`, { noFlip: true, tpAtr: tp, timeExit: te }]), ref);
grid("2d. STOP from the signal (ATR; the $600 line still caps it)",
     [1.5, 2, 2.5, 3, 4, 5].map((x) => [`stop ${x} ATR`, { slAtr: x }]), ref);
grid("2e. BREAK-EVEN: stop to entry + 2 ticks once the trade is +X ATR",
     [0.5, 1, 1.5, 2, 3, 0].map((x) => [x ? `break-even after +${x} ATR` : "no break-even", { be: x }]), ref);
grid("2f. HISTOGRAM TURN: out when the histogram on the trade's side shrinks 2 bars running",
     [["histogram-turn exit", { histExit: true }], ["histogram-turn exit, no flip", { histExit: true, noFlip: true }], ["neither", {}]], ref);

// ---- 3. entries ------------------------------------------------------------------
grid("3a. STOP-ENTRY OFFSET beyond the next open (ATR; 0 = one tick)",
     [0, 0.05, 0.1, 0.15, 0.25, 0.4, 0.6].map((x) => [`stop-entry ${x} ATR`, { trig: x }]), ref);
grid("3b. LIMIT INTO THE PUSH instead (ATR from the next open; better price, but only if price keeps going)",
     [0, 0.1, 0.25, 0.5, 0.75, 1].map((x) => [`limit ${x} ATR into the push`, { limitAtr: x }]), ref);
grid("3c. HOW LONG THE ORDER RESTS (bars)",
     [2, 3, 5, 10, 20].map((x) => [`order live ${x} bars`, { addWin: x }]), ref);
grid("3d. HOW MANY FADES A DAY, and until when",
     [[1, 895], [2, 895], [1, 600], [2, 600], [1, 540], [2, 540], [99, 895]].map(([m, c]) => [`at most ${m === 99 ? "any" : m} a day, entries until ${Math.floor(c / 60)}:${String(c % 60).padStart(2, "0")}`, { maxPerDay: m, lastEntryCt: c }]), ref);
grid("3e. THE ANATOMY'S FILTERS (entries only; every cross still exits)",
     [["only fades WITH the MACD trend (pullbacks)", { gate: GATES.withTrend }], ["only fades AGAINST it", { gate: (k, s) => !GATES.withTrend(k, s) }],
      ["only pullbacks just short of VWAP", { gate: GATES.vwapZone }], ["no fades of an opening-range break", { gate: GATES.notOrBreak }],
      ["only with a 30% rejection wick", { gate: GATES.wick }], ["with the trend AND no opening-range break", { gate: (k, s) => GATES.withTrend(k, s) && GATES.notOrBreak(k, s) }],
      ["no filter", {}]], ref);

// ---- 4. are the two entry findings plateaus, and do they combine? -------------
const stopEntryRows = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.8].map((x) => [`stop-entry ${x} ATR`, { trig: x }]);
grid("4a. STOP-ENTRY OFFSET, fine grid", stopEntryRows, ref);
grid("4b. THE PULLBACK FILTER, five definitions of the bigger trend (stop-entry 0.15 ATR)",
     [["MACD line (EMA 12/26) on the fade's side", { gate: GATES.withTrend }], ["price on the fade's side of VWAP", { gate: GATES.trendVwap }],
      ["EMA 50 vs 200 on the fade's side", { gate: GATES.trend50 }], ["EMA 60 vs 130 (5-min MACD) on the fade's side", { gate: GATES.trend5m }],
      ["the opening drive on the fade's side", { gate: GATES.trendDrive }], ["no filter", {}]], ref);
grid("4c. THE SAME FIVE, with the 0.4 ATR stop-entry",
     [["MACD line", { gate: GATES.withTrend, trig: 0.4 }], ["VWAP side", { gate: GATES.trendVwap, trig: 0.4 }], ["EMA 50/200", { gate: GATES.trend50, trig: 0.4 }],
      ["EMA 60/130", { gate: GATES.trend5m, trig: 0.4 }], ["opening drive", { gate: GATES.trendDrive, trig: 0.4 }], ["no filter, 0.4 ATR", { trig: 0.4 }]], ref);
const combos = [];
for (const trig of [0.15, 0.25, 0.4]) for (const g of [null, "withTrend"]) for (const sl of [5, 3]) for (const mx of [99, 2])
  combos.push([`stop-entry ${trig}, ${g ? "pullbacks only" : "all fades"}, stop ${sl} ATR, ${mx === 99 ? "any" : "max " + mx}/day`, { trig, gate: g ? GATES[g] : null, slAtr: sl, maxPerDay: mx }]);
const cres = grid("4d. COMBINATIONS (stop-entry x pullback filter x stop x fades a day)", combos, ref);

// random-filter null for the pullback filter: gate the same share of 2026
// entries at random (the fade is hurt by ANY skipped entry, so this is the bar)
{
  let tot = 0, kept = 0;
  for (let k = 0; k < n; k++) if (SIGA[k] && S.yearOf.get(TD[k]) === 2026) { tot++; if (GATES.withTrend(k, SIGA[k])) kept++; }
  const share = kept / tot;
  for (const trig of [0.15, 0.4]) {
    const ys = [];
    for (let w = 1; w <= 30; w++) {
      const rnd = S.mul(500 + w), keep = new Uint8Array(n);
      for (let k = 0; k < n; k++) if (SIGA[k]) keep[k] = rnd() < share ? 1 : 0;
      ys.push(run({ trig, gate: (k) => keep[k] === 1 }).y);
    }
    ys.sort((x, y) => x - y);
    const real = run({ trig, gate: GATES.withTrend }).y;
    console.log(`\n  null for the pullback filter (stop-entry ${trig}): keep ${(100 * share).toFixed(0)}% of entries at random, 30 runs: median ${ys[15].toFixed(1)}%, max ${ys[29].toFixed(1)}%  vs real ${real.toFixed(1)}% (beats ${ys.filter((v) => real > v).length}/30)`);
  }
}

// ---- 5. stress the leading candidates ---------------------------------------------
const shift1 = (a) => { const o = new Int8Array(a.length); for (let i = 1; i < a.length; i++) o[i] = a[i - 1]; return o; };
const CANDS = [["baseline (causal exits)", {}], ["stop-entry 0.4 ATR", { trig: 0.4 }], ["pullbacks only", { gate: GATES.withTrend }],
               ["stop-entry 0.4 + pullbacks only", { trig: 0.4, gate: GATES.withTrend }]];
console.log("\n5. STRESS (2026 / Jan-Mar / Apr-Jul)");
const STR = [["as tested", {}], ["one bar later", { sigShift: true }], ["2 ticks slippage", { extra: { slipMult: 2 } }],
             ["breaker -$100", { breaker: 100 }], ["breaker -$300", { breaker: 300 }], ["profit block +$150", { pb: 150 }], ["profit block +$350", { pb: 350 }],
             ["3 lots", { lots: 3 }], ["5 lots", { lots: 5 }]];
console.log("  " + "".padEnd(30) + CANDS.map(([l]) => l.slice(0, 24).padStart(26)).join(""));
for (const [sl, so] of STR) {
  const cells = CANDS.map(([, co]) => {
    const over = { ...co, ...so };
    if (so.sigShift) { over.sig = shift1(SIGA); delete over.sigShift; if (co.gate) { const g = co.gate; over.gate = (k, s) => g(k - 1, s); } }
    const r = run(over);
    return (f1(r.y, 5) + " " + f1(r.a, 4) + "/" + f1(r.b, 4).trim()).padStart(26);
  });
  console.log("  " + sl.padEnd(30) + cells.join(""));
}
for (const [cl, co] of CANDS) {
  const r = run(co);
  console.log("  " + cl.padEnd(34) + "real windows " + f1(r.real) + "%,  " + r.n + " trades, $" + r.exp.toFixed(0) + "/trade, exits " + JSON.stringify(r.by));
}

// ---- 6. the pullback filter with the first-fade structure, and its null -----
grid("6a. PULLBACKS ONLY, by fades a day and last entry time",
     [[1, 895], [2, 895], [3, 895], [99, 895], [1, 600], [2, 600], [99, 600]].map(([m, c]) => [`pullbacks only, ${m === 99 ? "any" : "max " + m}/day, until ${Math.floor(c / 60)}:${String(c % 60).padStart(2, "0")}`,
       { gate: GATES.withTrend, maxPerDay: m, lastEntryCt: c }]), ref);
{
  let tot = 0, kept = 0;
  for (let k = 0; k < n; k++) if (SIGA[k] && S.yearOf.get(TD[k]) === 2026) { tot++; if (GATES.withTrend(k, SIGA[k])) kept++; }
  const ys = [];
  for (let w = 1; w <= 30; w++) {
    const rnd = S.mul(900 + w), keep = new Uint8Array(n);
    for (let k = 0; k < n; k++) if (SIGA[k]) keep[k] = rnd() < kept / tot ? 1 : 0;
    ys.push(run({ gate: (k) => keep[k] === 1, maxPerDay: 2 }).y);
  }
  ys.sort((x, y) => x - y);
  const real = run({ gate: GATES.withTrend, maxPerDay: 2 }).y;
  console.log(`  null, max 2/day: random ${(100 * kept / tot).toFixed(0)}% of entries kept, 30 runs: median ${ys[15].toFixed(1)}%, max ${ys[29].toFixed(1)}%  vs real ${real.toFixed(1)}% (beats ${ys.filter((v) => real > v).length}/30)`);
}

// ---- 7. exits from impact decay: take back a share of the push ----------------
grid("7. PUSH-RETRACEMENT EXIT: out at the next open once the close has taken back X of the push (flip still on)",
     [0.25, 0.5, 0.75, 1, 1.5, 0].map((x) => [x ? `retrace ${x} of the push` : "no retrace exit", { retrace: x }]), ref);
grid("7b. ... with pullbacks only",
     [0.5, 0.75, 1, 1.5, 0].map((x) => [x ? `pullbacks only, retrace ${x}` : "pullbacks only", { retrace: x, gate: GATES.withTrend }]), ref);

// ---- 8. volume and volatility gates (on top of pullbacks only) -----------------
grid("8. VOLUME (CGW) AND VOLATILITY (Nagel) GATES, pullbacks only",
     [["pullbacks only", { gate: GATES.withTrend }],
      ["+ last-5-min volume >= 1x normal", { gate: (k, s) => GATES.withTrend(k, s) && !(rvol[k] < 1) }],
      ["+ last-5-min volume >= 1.5x normal", { gate: (k, s) => GATES.withTrend(k, s) && !(rvol[k] < 1.5) }],
      ["+ ATR >= 1x its 10-day average", { gate: (k, s) => GATES.withTrend(k, s) && !(volRel[k] < 1) }],
      ["+ ATR >= 1.2x its 10-day average", { gate: (k, s) => GATES.withTrend(k, s) && !(volRel[k] < 1.2) }],
      ["+ ATR < 1x (quiet only, the opposite)", { gate: (k, s) => GATES.withTrend(k, s) && volRel[k] < 1 }]], ref);

// ---- 9. a non-MACD entry: fade the opening drive once, exit at the next MACD cross
console.log("\n9. OPENING-DRIVE FADE (one trade a day; out at the next MACD cross, the bracket or 15:05)\n" + HD);
for (const m of [5, 10, 15]) for (const x of [0.5, 1, 2, 3]) {
  const r = run({ sig: openingDrive(m, x), macdExit: true, noFlip: true });
  console.log(line(`at 08:${String(30 + m).padStart(2, "0")}, fade a drive of ${x} ATR+`, r));
}
console.log(line("reference: MACD fade, causal exits", ref));

// ---- 10. delay check for the gated candidates (the earlier one-bar-later row was a bug)
console.log("\n10. ONE BAR LATER, corrected\n" + HD);
for (const [lbl, co] of [["baseline", {}], ["pullbacks only", { gate: GATES.withTrend }], ["pullbacks only, max 2/day", { gate: GATES.withTrend, maxPerDay: 2 }]]) {
  const r = run(co);
  const g = co.gate;
  const rl = run({ ...co, sig: shift1(SIGA), gate: g ? (k, s2) => g(k - 1, s2) : null });
  console.log(line(lbl + "  (as tested)", r));
  console.log(line(lbl + "  (one bar later)", rl));
}

// ---- 11. the volatility gate: neighbours, other measures, null, stress ---------
const PB = GATES.withTrend;
const volGate = (th, base) => (k, s) => (!base || base(k, s)) && !(volRel[k] < th);
grid("11a. ATR vs its 10-day average >= X -- WITHOUT the pullback filter",
     [0.8, 0.9, 1, 1.1, 1.2, 1.4].map((x) => [`ATR >= ${x}x average`, { gate: volGate(x, null) }]).concat([["no gate", {}]]), ref);
const pbRef = run({ gate: PB });
grid("11b. ... WITH the pullback filter",
     [0.8, 0.9, 1, 1.1, 1.2, 1.4].map((x) => [`pullbacks, ATR >= ${x}x average`, { gate: volGate(x, PB) }]).concat([["pullbacks, no vol gate", { gate: PB }]]), pbRef);
grid("11c. OTHER WAYS TO MEASURE 'A VOLATILE DAY' (with the pullback filter)",
     [["the 08:30 bar's ATR >= its 10-day average", { gate: (k, s) => PB(k, s) && !(openVol[k] < 1) }],
      ["yesterday's range >= its 10-day average", { gate: (k, s) => PB(k, s) && !(prevRange[k] < 1) }],
      ["current ATR >= average (as 11b)", { gate: volGate(1, PB) }],
      ["the 08:30 bar's ATR < average (quiet open, opposite)", { gate: (k, s) => PB(k, s) && openVol[k] < 1 }]], pbRef);
for (const [lbl, base] of [["vol gate alone", null], ["vol gate + pullbacks", PB]]) {
  let tot = 0, kept = 0;
  for (let k = 0; k < n; k++) if (SIGA[k] && S.yearOf.get(TD[k]) === 2026 && (!base || base(k, SIGA[k]))) { tot++; if (!(volRel[k] < 1)) kept++; }
  const ys = [];
  for (let w = 1; w <= 30; w++) {
    const rnd = S.mul(1700 + w), keep = new Uint8Array(n);
    for (let k = 0; k < n; k++) if (SIGA[k]) keep[k] = rnd() < kept / tot ? 1 : 0;
    ys.push(run({ gate: (k, s) => (!base || base(k, s)) && keep[k] === 1 }).y);
  }
  ys.sort((x, y) => x - y);
  const real = run({ gate: volGate(1, base) }).y;
  console.log(`  null for the ${lbl}: drop the same ${(100 - 100 * kept / tot).toFixed(0)}% of ${base ? "pullback " : ""}entries at random, 30 runs: median ${ys[15].toFixed(1)}%, max ${ys[29].toFixed(1)}%  vs real ${real.toFixed(1)}% (beats ${ys.filter((v) => real > v).length}/30)`);
}
console.log("\n11d. STRESS (2026 / Jan-Mar / Apr-Jul)");
const C2 = [["baseline", {}], ["vol gate alone", { gate: volGate(1, null) }], ["pullbacks only", { gate: PB }], ["pullbacks + vol gate", { gate: volGate(1, PB) }]];
console.log("  " + "".padEnd(24) + C2.map(([l]) => l.padStart(22)).join(""));
for (const [sl, so] of STR) {
  const cells = C2.map(([, co]) => {
    const over = { ...co, ...so };
    if (so.sigShift) { over.sig = shift1(SIGA); delete over.sigShift; if (co.gate) { const g = co.gate; over.gate = (k, s2) => g(k - 1, s2); } }
    const r = run(over);
    return (f1(r.y, 5) + " " + f1(r.a, 4) + "/" + f1(r.b, 4).trim()).padStart(22);
  });
  console.log("  " + sl.padEnd(24) + cells.join(""));
}
const M7 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"];
for (const [cl, co] of C2) {
  const r = run(co);
  const tr = E1.run(() => 4, {}).length;   // (unused; keeps the engine warm)
  void tr;
  console.log("  " + cl.padEnd(24) + "real windows " + f1(r.real) + "%,  " + r.n + " trades, " + f1(r.win).trim() + "% win, $" + r.exp.toFixed(0) + "/trade");
}

// ---- 12. the leading candidate in detail --------------------------------------
const CAND = { gate: volGate(1, PB) };
grid("12a. THE CANDIDATE (pullbacks + volatility gate) WITH OTHER CHANGES ON TOP",
     [["pullbacks + vol gate", CAND], ["... + max 2 fades a day", { ...CAND, maxPerDay: 2 }], ["... + stop 3 ATR", { ...CAND, slAtr: 3 }],
      ["... + target 3 ATR", { ...CAND, tpAtr: 3 }], ["... + stop-entry 0.25 ATR", { ...CAND, trig: 0.25 }], ["... + entries until 10:00", { ...CAND, lastEntryCt: 600 }]], run(CAND));
{
  const dayTotals = (over) => {
    const c = { ...BASE, ...over };
    let day = -1, count = 0;
    const sizer = (a, ct, sq, arm) => { if (TD[arm] !== day) { day = TD[arm]; count = 0; } if (ct >= c.lastEntryCt || count >= c.maxPerDay) return 0;
      if (c.gate && S.yearOf.get(TD[arm]) === 2026 && !c.gate(arm - 1, SIGA[arm - 1])) return 0; count++; return c.lots; };
    const tr = E1.run(sizer, { signals: SIGA, slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: 600, cancelOpposite: true, exitFirst: true,
      trig: c.trig, addWin: c.addWin, slMult: c.slAtr, tpFromFill: true, tpFn: (a, q) => Math.min(c.tpAtr * a, 600 / (2 * q)), breaker: c.breaker, profitBlock: c.pb })
      .filter((x) => S.yearOf.get(x.tday) === 2026);
    const arr = S.dayArr(tr, S.days);
    const mo = new Array(7).fill(0);
    for (const x of tr) mo[new Date(M.tf.ts[S.dayFirstBar.get(x.tday)] + 43200e3).getUTCMonth()] += x.pnl;
    const jack = (K) => { const best = M.Y26.map((k) => [k, arr[k]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, K);
      const a = Float64Array.from(arr); for (const [k] of best) a[k] = 0; return S.passArr(M.Y26.map((k) => a[k]), RULES); };
    const d = M.Y26.map((k) => arr[k]);
    return { mo, j: [1, 3, 5].map(jack), green: d.filter((v) => v > 0).length, red: d.filter((v) => v < 0).length, best: Math.max(...d), worst: Math.min(...d) };
  };
  console.log("\n12b. MONEY BY MONTH AND THE BEST DAYS REMOVED");
  for (const [lbl, over] of [["baseline (causal exits)", {}], ["pullbacks only", { gate: PB }], ["pullbacks + vol gate", CAND]]) {
    const r = dayTotals(over);
    console.log("  " + lbl.padEnd(26) + M7.map((m, i) => m + " " + (r.mo[i] >= 0 ? "+" : "") + Math.round(r.mo[i])).join("  "));
    console.log("  " + "".padEnd(26) + "best 1/3/5 days removed: " + r.j.map((x) => x.toFixed(1)).join(" / ") + "%;  green days " + r.green + ", red " + r.red + ", best $" + Math.round(r.best) + ", worst $" + Math.round(r.worst));
  }
}
// the exit-ordering fix on the Donchian (its indicator has the same ordering)
{
  const exit20 = (k, d, st) => k - st.entBar >= 20 && (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) < st.atr;
  for (const ef of [false, true]) {
    const tr = S.run((a, c, sq, arm) => (M.adrUsed(arm - 1) >= 0.9 ? 2 : 4), { signals: M.RESC, slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: 600,
      cancelOpposite: true, exitFirst: ef, exitFn: exit20, breaker: 300, profitBlock: 250 }).filter((x) => S.yearOf.get(x.tday) === 2026);
    const arr = S.dayArr(tr, S.days);
    const by = {}; for (const x of tr) by[x.why] = (by[x.why] || 0) + 1;
    console.log(`\n  Donchian, exits ${ef ? "first (causal)" : "as built"}: ${S.passArr(M.Y26.map((k) => arr[k]), RULES).toFixed(1)}% (Jan-Mar ${S.passArr(M.Y26a.map((k) => arr[k]), RULES).toFixed(1)}, Apr-Jul ${S.passArr(M.Y26b.map((k) => arr[k]), RULES).toFixed(1)}), ${tr.length} trades, $${(tr.reduce((s2, x) => s2 + x.pnl, 0) / tr.length).toFixed(1)}/trade, exits ${JSON.stringify(by)}`);
  }
}
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
