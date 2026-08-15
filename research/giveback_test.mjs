// !! REFUTED — see research/partial_order_check.mjs !!
//
// Every partial-exit result below is INVALID. The replay resolved the full
// target BEFORE the partial and then `continue`d, so on any bar that reached
// the target all 8 lots exited there and the partial never fired. That makes
// the simulated rule "sell 6 lots at 1.575xATR, but only when this bar will not
// reach 1.75xATR" — lookahead inside the bar, and not tradeable.
//
// A resting limit fills whenever price passes through it. With that correction
// the fire rate goes 22% -> 67%, because most trades that touch the partial
// level do so on a bar that also touches the target, and ALL 18 grid settings
// lose: best -3.4pp, worst -20.2pp, none inside the +-1.0pp noise floor.
//
// Kept for the record and because the diagnosis of the give-back pool, and the
// finding that every stop-MOVING rule loses, both still stand.

// Can anything be salvaged from trades that go deep into profit and then reverse
// into the stop?
//
// THE POOL (from giveback_diag.mjs): 304 trades reach >=70% of target and still
// lose, costing $250,560; 107 reach >=90%, costing $96,306. Real money, so the
// question is fair. But the same diagnostic shows 3,008 WINNERS worth $1.17M were
// underwater by >=10% of the target distance at some point. Any rule that reacts
// to a retracement fires on those too, and that is the bill.
//
// THE THEORY WORTH KNOWING FIRST. For a driftless random walk every stopping
// rule has the SAME expected value — the optional stopping theorem. Moving a
// stop cannot manufacture edge; it only reshapes the distribution. Concretely,
// from a peak x with target T and stop S, holding wins (x+S)/(T+S) of the time
// and a breakeven stop wins x/T of the time, and at 5xATR/1.75xATR those two
// come to +0.499T and +0.500T. Identical to three decimals.
//
// So the ONLY way any of this helps is through the combine's rules, not through
// P&L: smaller losers protect the $2,000 trailing drawdown. That is a real
// mechanism and worth measuring — but it is also why a fix can look good on
// "money saved" and still lose, since the money it costs comes out of winners.
//
// MODES (all armed at a BAR CLOSE once the favourable excursion reaches
// `trig` x the target distance, and live from the NEXT bar — which is exactly
// what the bot can do: see a closed bar, then modify the resting stop):
//   off       ship as-is
//   be        stop to entry + `p` x ATR (p=0 is true breakeven)
//   trail     stop trails `p` x ATR below the running peak, never below entry
//   giveback  stop locks in `p` of the peak excursion
//   partial   close `p` of the position at the trigger, rest runs to TP/SL
//   time      exit at market after `p` bars regardless
//
// Usage:  node research/giveback_test.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";

const DRAWS = 15000, BLOCK = 5, WIN = 21, CAP = 1000, TOTAL = 8;
const Q1 = 2, ADD_TRIG = 0.15, ADD_WIN = 10;   // the shipped scale-in

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

function replay(mode, trig, p, fromMs) {
  // A LINE-BY-LINE mirror of runBrackets, extended with the protective-exit
  // modes. Two things the first draft got wrong and that parity caught:
  //   - the bracket is anchored to `ep`, the SIGNAL price, so the scale-in add
  //     does NOT drag the stop and target along with the average;
  //   - slippage is charged on BOTH legs and on EACH tranche, via entryNotional.
  // Both are asserted against the engine below before any result is read.
  const { open: O, high: H, low: L, close: C, ctMin: CT, tday: TD, ts: TS } = tf;
  const n = O.length, pv = 2, tick = 0.25, slip = 0.25, perSide = 0.75;
  const inFlat = (ct, f, r) => (r > f ? ct >= f && ct < r : ct >= f || ct < r);
  const cutoff = X.flattenCt - X.noEntryMinsBeforeFlat;
  const fills = [];
  let pos = 0, ep = 0, entBar = 0, entTime = 0, slD = 0, tpD = 0, aATR = 0;
  let qty = 0, pendQty = 0, addPx = 0, addBy = -1, notional = 0;
  let curTday = -1e9, dayReal = 0, hit = false;
  let peakPx = 0, protect = null, tookPartial = false;
  let nProtect = 0;

  const avgFill = () => notional / qty;
  const bank = (rawExit, i, exact, q) => {
    const af = avgFill();
    const fees = perSide * 2 * q;
    const xp = pos === 1 ? rawExit - slip : rawExit + slip;
    const net = exact !== undefined ? exact : (xp - af) * pos * pv * q - fees;
    fills.push({ tday: TD[i], entryTime: entTime, net });
    dayReal += net;
    if (dayReal <= -CAP) hit = true;
    return net;
  };
  const close_ = (rawExit, i, exact) => {
    bank(rawExit, i, exact, qty);
    pos = 0; pendQty = 0; addBy = -1; notional = 0; protect = null; tookPartial = false;
  };
  const tryAdd = (bar) => {
    if (pendQty <= 0 || bar > addBy) return;
    if (!(pos === 1 ? H[bar] >= addPx : L[bar] <= addPx)) return;
    notional += (pos === 1 ? addPx + slip : addPx - slip) * pendQty;
    qty += pendQty; pendQty = 0;
  };

  for (let i = 1; i < n; i++) {
    const s = sig[i - 1];
    const flatNow = inFlat(CT[i], X.flattenCt, X.reopenCt);
    if (TD[i] !== curTday) { curTday = TD[i]; dayReal = 0; hit = false; }

    if (pos !== 0) {
      tryAdd(i);
      if (flatNow) { close_(O[i], i); continue; }
      const dir = pos, af = avgFill();
      const lossPx = af - dir * ((CAP + dayReal) / (pv * qty));
      const rawSl = ep - dir * slD;
      let sl = dir === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
      let isCap = dir === 1 ? (sl === lossPx && lossPx > rawSl)
                            : (sl === lossPx && lossPx < rawSl);
      // The protective stop armed on a PREVIOUS bar. It only ever tightens, and
      // when it is what fires the exit is a normal fill, not a cap liquidation.
      if (protect !== null && (dir === 1 ? protect > sl : protect < sl)) {
        sl = protect; isCap = false;
      }
      const tp = ep + dir * tpD;

      if (mode === "time" && i - entBar >= p) {
        const wouldSl = dir === 1 ? (O[i] <= sl || L[i] <= sl) : (O[i] >= sl || H[i] >= sl);
        const wouldTp = dir === 1 ? H[i] >= tp : L[i] <= tp;
        if (!wouldSl && !wouldTp) { close_(O[i], i); continue; }
      }
      let exited = false;
      if (dir === 1) {
        if (O[i] <= sl) { if (sl === protect) nProtect++; close_(O[i], i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (L[i] <= sl) { if (sl === protect) nProtect++; close_(sl, i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (H[i] >= tp) { close_(tp, i); exited = true; }
      } else {
        if (O[i] >= sl) { if (sl === protect) nProtect++; close_(O[i], i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (H[i] >= sl) { if (sl === protect) nProtect++; close_(sl, i, isCap ? -CAP - dayReal : undefined); exited = true; }
        else if (L[i] <= tp) { close_(tp, i); exited = true; }
      }
      if (exited) continue;

      // ── partial exit at the trigger (a resting limit, so no extra slip beyond
      //    the standard one charged in bank()) ──
      if (mode === "partial" && !tookPartial) {
        const tgPx = ep + dir * trig * tpD;
        if (dir === 1 ? H[i] >= tgPx : L[i] <= tgPx) {
          const qOut = Math.max(1, Math.round(qty * p));
          if (qOut < qty) {
            bank(tgPx, i, undefined, qOut);
            // Shrink size and notional together so the average entry is
            // unchanged and the cap distance widens for the remainder.
            notional -= avgFill() * qOut; qty -= qOut; tookPartial = true;
          }
        }
      }

      if (X.flipOnOpposite && s !== 0 && s !== pos) close_(O[i], i);
      if (pos !== 0) {
        peakPx = dir === 1 ? Math.max(peakPx, H[i]) : Math.min(peakPx, L[i]);
        const exc = dir * (peakPx - avgFill());
        if ((mode === "be" || mode === "trail" || mode === "giveback") && exc >= trig * tpD) {
          const base = avgFill();
          let lvl;
          if (mode === "be") lvl = base + dir * p * aATR;
          else if (mode === "trail") lvl = peakPx - dir * p * aATR;
          else lvl = base + dir * p * exc;
          lvl = dir === 1 ? Math.max(lvl, base) : Math.min(lvl, base);
          protect = protect === null ? lvl
                  : (dir === 1 ? Math.max(protect, lvl) : Math.min(protect, lvl));
        }
        continue;
      }
    }

    if (pos === 0 && s !== 0 && !flatNow && !hit) {
      if (inFlat(CT[i], cutoff, X.reopenCt)) continue;
      const a = A[i - 1];
      if (!(a > 0)) continue;
      ep = O[i]; entBar = i; entTime = TS[i]; pos = s; aATR = a;
      slD = Math.max(a * 5, tick); tpD = Math.max(a * 1.75, tick);
      qty = Math.max(1, Math.round(TOTAL * (Q1 / TOTAL)));
      pendQty = TOTAL - qty;
      addPx = ep + pos * Math.max(a * ADD_TRIG, tick);
      addBy = i + ADD_WIN;
      notional = (pos === 1 ? ep + slip : ep - slip) * qty;
      peakPx = pos === 1 ? H[i] : L[i];
      protect = null; tookPartial = false;
    }
  }
  if (pos !== 0) close_(C[n - 1], n - 1);

  const days = [];
  let day = null, acc = 0;
  for (const f of fills) {
    if (f.entryTime < fromMs) continue;
    if (f.tday !== day) { if (day !== null) days.push(acc); day = f.tday; acc = 0; }
    if (acc >= R.dailyProfitStop || acc <= -R.circuitBreaker) continue;
    acc += f.net;
  }
  if (day !== null) days.push(acc);
  const sel = fills.filter(f => f.entryTime >= fromMs);
  let gw = 0, gl = 0, tot = 0, w = 0;
  for (const f of sel) { tot += f.net; if (f.net > 0) { w++; gw += f.net; } else gl -= f.net; }
  return { days, n: sel.length, win: (100 * w) / sel.length, pf: gl ? gw / gl : Infinity,
           exp: tot / sel.length, net: tot, fired: nProtect };
}

function ev(d) {
  let c = 0, pk = 0, lk = false, md = -1e18;
  for (const v of d) {
    c += v; if (v > md) md = v;
    const fl = lk ? 0 : pk - R.trailingDD;
    if (c <= fl) return 0;
    if (c > pk) pk = c;
    if (R.lockAtBreakeven && !lk && pk >= R.trailingDD) lk = true;
    if (c >= R.profitTarget && md <= 0.5 * c) return 1;
  }
  return 0;
}
function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function pass(dd, seed) {
  const rnd = mul(seed), idx = new Array(WIN), n = dd.length;
  let w = 0;
  for (let k = 0; k < DRAWS; k++) {
    let m = 0;
    while (m < WIN) { const st = Math.floor(rnd() * Math.max(1, n - BLOCK));
      for (let j = 0; j < BLOCK && m < WIN; j++) idx[m++] = dd[(st + j) % n]; }
    w += ev(idx);
  }
  return (100 * w) / DRAWS;
}

// ── parity: mode 'off' must reproduce the engine ─────────────────────
const engCfg = { contracts: TOTAL, slAtrMult: 5, tpAtrMult: 1.75, dayLossStopUsd: CAP,
  dayLossStopMode: "exact", slippageTicks: 1, scaleInFrac: Q1 / TOTAL,
  scaleInTrigger: ADD_TRIG, scaleInWindowBars: ADD_WIN };
const { trades: engT } = runBrackets(tf, sig, A, resolveExec({ ...S.execDefaults, ...engCfg }));
const engNet = engT.reduce((s, t) => s + t.pnl, 0);
const off = replay("off", 0, 0, 0);
const dNet = Math.abs(off.net - engNet) / Math.abs(engNet);
console.log(`\nparity vs engine: ${engT.length} vs ${off.n} trades, ` +
  `net $${engNet.toFixed(0)} vs $${off.net.toFixed(0)} (${(100 * dNet).toFixed(2)}% apart)`);
if (dNet > 0.02) console.log("  !! baseline does NOT match the engine — results below are not trustworthy");

const FROM = bars.ts[bars.count - 1] - 365 * 86400000;
const GRID = [
  ...[0.4, 0.5, 0.6, 0.7, 0.8].flatMap(t => [0, 0.25, 0.5].map(p => ["be", t, p])),
  ...[0.4, 0.5, 0.6, 0.7, 0.8].flatMap(t => [0.5, 1.0, 1.5].map(p => ["trail", t, p])),
  ...[0.4, 0.5, 0.6, 0.7, 0.8].flatMap(t => [0.25, 0.5, 0.75].map(p => ["giveback", t, p])),
  ...[0.4, 0.5, 0.6, 0.7, 0.8].flatMap(t => [0.25, 0.5].map(p => ["partial", t, p])),
  ...[10, 20, 30, 45].map(p => ["time", 0, p]),
];

for (const [lbl, from] of [["LAST 12 MONTHS", FROM], ["ALL HISTORY", 0]]) {
  const b = replay("off", 0, 0, from);
  const bp = pass(b.days, 33);
  console.log(`\n  ${lbl}  —  8 lots as ${Q1}+${TOTAL - Q1}, exact -$${CAP} cap, 50% consistency\n`);
  console.log("   mode       trig   param     n     win%    pf     $/trade     net      PASS%     vs base");
  console.log(`   off           -       -  ${String(b.n).padStart(5)}  ${b.win.toFixed(1).padStart(5)}  ` +
    `${b.pf.toFixed(3)}  ${("$" + b.exp.toFixed(2)).padStart(8)}  ${("$" + (b.net / 1000).toFixed(0) + "k").padStart(8)}  ` +
    `${bp.toFixed(1).padStart(6)}%        -`);
  for (const [mode, trig, p] of GRID) {
    const r = replay(mode, trig, p, from);
    const pr = pass(r.days, 33);
    const d = pr - bp;
    console.log(`   ${mode.padEnd(9)}  ${trig ? trig.toFixed(2) : "   -"}  ${String(p).padStart(6)}  ` +
      `${String(r.n).padStart(5)}  ${r.win.toFixed(1).padStart(5)}  ${r.pf.toFixed(3)}  ` +
      `${("$" + r.exp.toFixed(2)).padStart(8)}  ${("$" + (r.net / 1000).toFixed(0) + "k").padStart(8)}  ` +
      `${pr.toFixed(1).padStart(6)}%  ${(d >= 0 ? "+" : "") + d.toFixed(1)}pp`);
  }
}
