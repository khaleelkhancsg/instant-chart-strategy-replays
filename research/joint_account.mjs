// One account, both bots, the platform cap enforced on RUNNING equity.
//
// Every combined figure before this summed DAY P&L and clipped the total at
// -$1,000 afterwards. That is wrong twice over: the platform liquidates the
// moment realised PLUS unrealised touches -$1,000, and when it fires it kills
// the rest of the session for BOTH books, not just the one that was losing.
//
// THE DISCIPLINE THIS FILE IS BUILT AROUND: a joint engine is only worth
// reading if it reproduces the validated standalone engines when run with one
// book. The first attempt did not -- 88% win rate against 72.6% -- because it
// resolved the donchian on 1-minute bars instead of its native 2-minute ones,
// skipped the gap-through-at-open check, dropped the FLIP exit, and never
// booked a liquidation as a trade. Parity is asserted below and the combined
// numbers are not printed unless it holds.
//
// Structure:
//   - 1-minute outer loop, the finest common clock
//   - the donchian is processed ONLY when a 2-minute bar completes, running
//     lib_shipped's exact sequence on the 2-minute OHLC: arm fill, exits, entry
//   - the ORB is processed every minute against its precomputed schedule
//   - the shared cap is checked every minute against both marks together
//
// The shared cap replaces lib_shipped's per-position dynamic stop. With one
// book the two are identical by construction: that stop triggers exactly when
// realised plus unrealised reaches -$1,000, which is what the shared check
// tests. With two books it expresses what the day-sum approximation could not.
//
// Usage:  node research/joint_account.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";
import { setups as orbSetups } from "./lib_orb.mjs";

const CAP = 1000, BREAKER = 500, PROFIT_BLOCK = 750;
const PV = 2, TICK = 0.25, SLIP = 0.25, PERSIDE = 0.75;
const TRIG = 0.15, ADD_WIN = 10;
const FLAT_CT = 905, NOENTRY_CT = 895, OPEN_CT = 510;
const ORB_FLAT_CT = 900;     // lib_orb flattens at 900, not 905
const DON_LOTS = 8;

const { bars } = loadBars();
const O1 = bars.open, H1 = bars.high, L1 = bars.low, C1 = bars.close;
const TD1 = bars.tday, N1 = bars.count;
const CT1 = new Int16Array(N1);
for (let i = 0; i < N1; i++) CT1[i] = bars.ctMin[i] >= 960 ? bars.ctMin[i] - 1440 : bars.ctMin[i];

const tf = resample(bars, 2);
const ctx = buildFilterContext(tf);
const A2 = atr(tf.high, tf.low, tf.close, 14);
const { adx: ax2 } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh2, low: dl2 } = donchian(tf.high, tf.low, 30);
const n2 = tf.close.length;
const raw2 = new Int8Array(n2);
for (let i = 30; i < n2; i++) {
  if (ax2[i] < 25) continue;
  if (tf.close[i] > dh2[i]) raw2[i] = 1; else if (tf.close[i] < dl2[i]) raw2[i] = -1;
}
const sig2 = applyFilters(raw2, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const O2 = tf.open, HH2 = tf.high, LL2 = tf.low, CT2 = tf.ctMin;
const closesBar = new Int32Array(N1).fill(-1);
for (let k = 1; k < n2; k++) closesBar[tf.srcLast[k]] = k;

const ORB_CFG = {
  levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
  mode: "plain", stopAt: "opposite", rMult: 3.0, maxHoldMin: 5,
  retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500, maxLots: 50, maxPerDay: 1,
};
const _schedCache = new Map();
function orbSchedule(cfg) {
  const key = JSON.stringify(cfg);
  if (!_schedCache.has(key)) {
    const m = new Map();
    for (const s of orbSetups(cfg).out) m.set(s.bar, s);
    _schedCache.set(key, m);
  }
  return _schedCache.get(key);
}

const days = [...new Set(TD1)].sort((a, b) => a - b);

function simulate(books, opts = {}) {
  const { exclusive = false, orbCfg = ORB_CFG, donLots = DON_LOTS,
          costMult = 1 } = opts;
  const orbAt = orbSchedule(orbCfg);
  const SLIPc = SLIP * costMult, FEEc = PERSIDE * costMult;
  const useDon = books !== "orb", useOrb = books !== "don";
  const dayPnl = new Map(); for (const d of days) dayPnl.set(d, 0);
  const dTr = [], oTr = [];
  let curDay = -1e9, realised = 0, capHit = false, liqDays = 0;
  let coMin = 0, coSame = 0, coOpp = 0, dMin = 0, oMin = 0;

  let dPos = 0, dEp = 0, dSlD = 0, dTpD = 0, dQty = 0, dNotional = 0;
  let armDir = 0, armPx = 0, armBy = -1, armBar = -1, armEp = 0, armSl = 0, armTp = 0;
  let isLimit = false;
  let oPos = 0, oFill = 0, oSl = 0, oTp = 0, oQty = 0, oEntryBar = -1;

  const dFill = () => dNotional / dQty;
  const blocked = () => capHit || realised <= -BREAKER || realised >= PROFIT_BLOCK;
  const bookD = (px, exact) => {
    const xp = dPos === 1 ? px - SLIPc : px + SLIPc;
    const net = exact !== undefined ? exact
              : (xp - dFill()) * dPos * PV * dQty - FEEc * 2 * dQty;
    realised += net; dTr.push(net);
    if (realised <= -CAP) capHit = true;
    dPos = 0; dNotional = 0;
  };
  const bookO = (px, exact) => {
    const xp = oPos === 1 ? px - SLIPc : px + SLIPc;
    const net = exact !== undefined ? exact
              : (xp - oFill) * oPos * PV * oQty - FEEc * 2 * oQty;
    realised += net; oTr.push(net);
    if (realised <= -CAP) capHit = true;
    oPos = 0;
  };

  for (let i = 1; i < N1; i++) {
    if (TD1[i] !== curDay) {
      if (curDay !== -1e9) dayPnl.set(curDay, realised);
      curDay = TD1[i]; realised = 0; capHit = false;
      dPos = 0; oPos = 0; armDir = 0; isLimit = false; dNotional = 0;
    }
    const ct = CT1[i];
    if (dPos !== 0) dMin++;
    if (oPos !== 0) oMin++;
    if (dPos !== 0 && oPos !== 0) { coMin++; if (dPos === oPos) coSame++; else coOpp++; }

    // ---- THE SHARED CAP, on running equity, every minute ------------------
    if (!capHit && (dPos !== 0 || oPos !== 0)) {
      // Mark BOTH books at the SAME price, then take the worse of the bar's two
      // extremes. Marking each at its own worst point -- the low for a long, the
      // high for a short -- sums two moments that never coexisted, and would
      // liquidate on a combined loss that never happened. Combined P&L is linear
      // in price, so its minimum over the bar's range is exactly at an endpoint:
      // min of (value at the high, value at the low) is right, not merely safe.
      const mark = (px) =>
        (dPos === 0 ? 0 : (px - dFill()) * dPos * PV * dQty - FEEc * 2 * dQty) +
        (oPos === 0 ? 0 : (px - oFill) * oPos * PV * oQty - FEEc * 2 * oQty);
      const atLow = mark(L1[i]), atHigh = mark(H1[i]);
      const worst = Math.min(atLow, atHigh);
      const dU = dPos === 0 ? 0
        : ((atLow <= atHigh ? L1[i] - dFill() : H1[i] - dFill()) * dPos * PV * dQty
           - FEEc * 2 * dQty);
      const oU = worst - dU;
      if (realised + worst <= -CAP) {
        // Liquidated. Split the shortfall between whatever is open so the day
        // lands on exactly -$1,000, and book it as a trade so the trade-level
        // parity check can still see it.
        const short = -CAP - realised;
        if (dPos !== 0 && oPos !== 0) {
          const tot = (dU + oU) || -1;
          const dShare = short * (dU / tot);
          bookD(0, dShare); bookO(0, short - dShare);
        } else if (dPos !== 0) bookD(0, short);
        else bookO(0, short);
        realised = -CAP; capHit = true; armDir = 0; liqDays++;
        continue;
      }
    }

    // ---- ORB, every minute -----------------------------------------------
    if (useOrb) {
      // Mirrors lib_orb's resolve() exactly, in ITS order: flatten, then the
      // time stop at the bar OPEN, then gap-through at the open, then the
      // bracket. Checking the bracket first and exiting at the close instead
      // cost $29/trade and broke parity.
      const resolveOrb = () => {
        if (oPos === 0) return;
        if (ct >= ORB_FLAT_CT) { bookO(O1[i]); return; }
        if (i - oEntryBar >= orbCfg.maxHoldMin) { bookO(O1[i]); return; }
        if (i > oEntryBar) {
          if (oPos === 1 ? O1[i] <= oSl : O1[i] >= oSl) { bookO(O1[i]); return; }
          if (oPos === 1 ? O1[i] >= oTp : O1[i] <= oTp) { bookO(O1[i]); return; }
        }
        const hitS = oPos === 1 ? L1[i] <= oSl : H1[i] >= oSl;
        const hitT = oPos === 1 ? H1[i] >= oTp : L1[i] <= oTp;
        if (hitS) bookO(oSl);
        else if (hitT) bookO(oTp);
      };
      resolveOrb();
      if (oPos === 0 && !(exclusive && dPos !== 0) && !blocked() && orbAt.has(i) && ct >= OPEN_CT && ct < ORB_FLAT_CT) {
        const s = orbAt.get(i);
        oQty = Math.max(1, Math.min(orbCfg.maxLots, Math.floor(orbCfg.riskDollars / (s.risk * PV))));
        oPos = s.dir; oEntryBar = i;
        oFill = s.dir === 1 ? s.entryPx + SLIPc : s.entryPx - SLIPc;
        oSl = s.entryPx - s.dir * s.risk;
        oTp = s.tpPx != null ? s.tpPx : s.entryPx + s.dir * s.risk * orbCfg.rMult;
        resolveOrb();          // lib_orb resolves the ENTRY bar too
      }
    }

    // ---- DONCHIAN, only when a 2-minute bar completes ---------------------
    const k = closesBar[i];
    if (!useDon || k < 1) continue;
    const s2 = sig2[k - 1];
    const flatNow = CT2[k] >= FLAT_CT || CT2[k] < OPEN_CT;

    if (dPos === 0 && armDir !== 0) {
      if (flatNow || k > armBy || blocked() || (exclusive && oPos !== 0)) armDir = 0;
      else if (k > armBar) {
        let doFill = false;
        if (k === armBar + 1 && !isLimit &&
            (armDir === 1 ? O2[k] >= armPx : O2[k] <= armPx)) {
          isLimit = true;                     // stop refused; same price as a limit
          doFill = armDir === 1 ? LL2[k] <= armPx : HH2[k] >= armPx;
        } else {
          doFill = isLimit ? (armDir === 1 ? LL2[k] <= armPx : HH2[k] >= armPx)
                           : (armDir === 1 ? HH2[k] >= armPx : LL2[k] <= armPx);
        }
        if (doFill) {
          dPos = armDir; dQty = donLots; dEp = armEp; dSlD = armSl; dTpD = armTp;
          dNotional = (dPos === 1 ? armPx + SLIPc : armPx - SLIPc) * dQty;
          armDir = 0;
        }
      }
    }
    if (dPos !== 0) {
      if (flatNow) bookD(O2[k]);
      else {
        const dir = dPos, sl = dEp - dir * dSlD, tp = dEp + dir * dTpD;
        let done = false;
        if (dir === 1) {
          if (O2[k] <= sl) { bookD(O2[k]); done = true; }
          else if (LL2[k] <= sl) { bookD(sl); done = true; }
          else if (HH2[k] >= tp) { bookD(tp); done = true; }
        } else {
          if (O2[k] >= sl) { bookD(O2[k]); done = true; }
          else if (HH2[k] >= sl) { bookD(sl); done = true; }
          else if (LL2[k] <= tp) { bookD(tp); done = true; }
        }
        if (!done && s2 !== 0 && s2 !== dPos) bookD(O2[k]);
      }
    }
    if (dPos === 0 && s2 !== 0 && !flatNow && !blocked() && CT2[k] < NOENTRY_CT) {
      const a = A2[k - 1];
      if (a > 0) {
        armDir = s2; armBar = k; armBy = k + ADD_WIN; armEp = O2[k];
        armPx = O2[k] + s2 * Math.max(a * TRIG, TICK);
        armSl = Math.max(a * 5, TICK); armTp = Math.max(a * 1.75, TICK);
        isLimit = false;
      }
    }
  }
  dayPnl.set(curDay, realised);
  return { arr: days.map(d => dayPnl.get(d)), dTr, oTr, liqDays,
           coMin, coSame, coOpp, dMin, oMin };
}

// ---- evaluation ----------------------------------------------------------
const TARGET = 3000, DD = 2000, CONSIST = 0.5;
function ev(d) {
  let c = 0, pk = 0, lk = false, md = -1e18;
  for (const v of d) {
    c += v; if (v > md) md = v;
    if (c <= (lk ? 0 : pk - DD)) return 0;
    if (c > pk) pk = c;
    if (!lk && pk >= DD) lk = true;
    if (c >= TARGET && md <= CONSIST * c) return 1;
  }
  return 0;
}
function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function pass21(arr, seed = 4242) {
  const rnd = mul(seed), idx = new Array(21), buf = new Array(21);
  let w = 0;
  for (let d = 0; d < 12000; d++) {
    let mm = 0;
    while (mm < 21) { const st = Math.floor(rnd() * Math.max(1, arr.length - 5));
      for (let j = 0; j < 5 && mm < 21; j++) idx[mm++] = (st + j) % arr.length; }
    for (let kk = 0; kk < 21; kk++) buf[kk] = arr[idx[kk]];
    w += ev(buf);
  }
  return 100 * w / 12000;
}
function forward(arr, maxDays = 600, trials = 20000, seed = 31337) {
  const rnd = mul(seed); let pass = 0;
  for (let t = 0; t < trials; t++) {
    const s = Math.floor(rnd() * arr.length);
    let c = 0, pk = 0, lk = false, best = -1e18;
    for (let d = 0; d < maxDays; d++) {
      const v = arr[(s + d) % arr.length];
      c += v; if (v > best) best = v;
      if (c <= (lk ? 0 : pk - DD)) break;
      if (c > pk) pk = c;
      if (!lk && pk >= DD) lk = true;
      if (c >= TARGET && best <= CONSIST * c) { pass++; break; }
    }
  }
  return 100 * pass / trials;
}
const st = (t) => {
  let gw = 0, gl = 0, w = 0;
  for (const x of t) { if (x > 0) { w++; gw += x; } else gl -= x; }
  return { n: t.length, win: 100 * w / t.length, pf: gw / gl, exp: (gw - gl) / t.length };
};

export { simulate, days, pass21, forward, st, ORB_CFG };
const IS_MAIN = process.argv[1] && process.argv[1].endsWith("joint_account.mjs");
if (!IS_MAIN) { /* imported for sweeps; skip the report */ }
else {
const don = simulate("don"), orb = simulate("orb"), both = simulate("both");
const dS = st(don.dTr), oS = st(orb.oTr);
const REF = { don: { n: 2639, pf: 1.156, exp: 36.57, win: 72.6 },
              orb: { n: 1045, pf: 1.988, exp: 173.27 } };

console.log("\n" + "=".repeat(100));
console.log("PARITY GATE -- the joint engine must reproduce the validated standalone engines");
console.log("=".repeat(100));
console.log("\n  book       joint                                        reference");
console.log("  donchian   " + (dS.n + " tr, win " + dS.win.toFixed(1) + "%, pf " + dS.pf.toFixed(3) +
  ", $" + dS.exp.toFixed(2)).padEnd(45) + REF.don.n + " tr, win " + REF.don.win + "%, pf " +
  REF.don.pf + ", $" + REF.don.exp);
console.log("  orb        " + (oS.n + " tr, win " + oS.win.toFixed(1) + "%, pf " + oS.pf.toFixed(3) +
  ", $" + oS.exp.toFixed(2)).padEnd(45) + REF.orb.n + " tr, pf " + REF.orb.pf + ", $" + REF.orb.exp);
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const dOk = rel(dS.n, REF.don.n) < 0.03 && rel(dS.exp, REF.don.exp) < 0.12 && rel(dS.pf, REF.don.pf) < 0.10;
const oOk = rel(oS.n, REF.orb.n) < 0.03 && rel(oS.exp, REF.orb.exp) < 0.12 && rel(oS.pf, REF.orb.pf) < 0.10;
console.log("\n  donchian parity: " + (dOk ? "OK" : "FAIL") + "    orb parity: " + (oOk ? "OK" : "FAIL"));
if (!dOk || !oOk) {
  console.log("\n  PARITY FAILED -- combined numbers withheld, they would not be trustworthy.");
  process.exit(1);
}

console.log("\n" + "=".repeat(100));
console.log("JOINT ACCOUNT RESULTS");
console.log("=".repeat(100));
console.log("\n  book       $/day   liquidated days   21-day   no deadline   1stH   2ndH");
const H = days.length >> 1;
for (const [lbl, r] of [["donchian", don], ["orb", orb], ["both", both]]) {
  const mean = r.arr.reduce((a, x) => a + x, 0) / r.arr.length;
  console.log("  " + lbl.padEnd(11) + ("$" + mean.toFixed(2)).padStart(7) +
    (r.liqDays + " (" + (100 * r.liqDays / days.length).toFixed(1) + "%)").padStart(18) +
    pass21(r.arr).toFixed(1).padStart(9) + "%" + forward(r.arr).toFixed(1).padStart(12) + "%" +
    pass21(r.arr.slice(0, H)).toFixed(1).padStart(7) + "%" +
    pass21(r.arr.slice(H)).toFixed(1).padStart(6) + "%");
}
const naive = don.arr.map((v, i) => Math.max(-CAP, v + orb.arr[i]));
console.log("\n-- what the day-sum approximation was worth --");
console.log("  day-sum then clip   " + pass21(naive).toFixed(1) + "%   no deadline " + forward(naive).toFixed(1) + "%");
console.log("  true joint account  " + pass21(both.arr).toFixed(1) + "%   no deadline " + forward(both.arr).toFixed(1) + "%");
console.log("  approximation was optimistic by " + (pass21(naive) - pass21(both.arr)).toFixed(1) + "pp");

console.log("");
console.log("-- how often are BOTH books actually holding at once? --");
console.log("  donchian in a position     " + both.dMin.toLocaleString() + " minutes");
console.log("  orb in a position          " + both.oMin.toLocaleString() + " minutes");
console.log("  BOTH at once               " + both.coMin.toLocaleString() + " minutes  (" +
  (100 * both.coMin / Math.min(both.dMin, both.oMin)).toFixed(1) + "% of the ORB's exposure)");
console.log("    same direction           " + both.coSame.toLocaleString());
console.log("    OPPOSITE directions      " + both.coOpp.toLocaleString() +
  "  <- the only case the marking bug could bite");

console.log("");
console.log("-- do the two books suppress each other through the SHARED daily blocks? --");
console.log("  book run alone   donchian " + don.dTr.length + " trades, orb " + orb.oTr.length);
console.log("  book run together donchian " + both.dTr.length + " trades, orb " + both.oTr.length);
console.log("  donchian trades lost to sharing: " + (don.dTr.length - both.dTr.length) +
  "  (" + (100 * (don.dTr.length - both.dTr.length) / don.dTr.length).toFixed(1) + "%)");
console.log("  orb trades lost to sharing:      " + (orb.oTr.length - both.oTr.length) +
  "  (" + (100 * (orb.oTr.length - both.oTr.length) / orb.oTr.length).toFixed(1) + "%)");
console.log("");
console.log("  The circuit breaker (-$500) and profit block (+$750) are ACCOUNT-level, so one");
console.log("  book's P&L can shut the other out. That is a real cost of sharing an account,");
console.log("  and it is why simultaneous holding is rarer than chance would suggest.");

{
  const ex = simulate("both", true);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log("");
  console.log("-- DESIGN CHECK: forbid the two books from ever holding at once --");
  console.log("  both, overlap allowed    $" + mean(both.arr).toFixed(2) + "/day   21-day " +
    pass21(both.arr).toFixed(1) + "%   no deadline " + forward(both.arr).toFixed(1) + "%");
  console.log("  both, EXCLUSIVE          $" + mean(ex.arr).toFixed(2) + "/day   21-day " +
    pass21(ex.arr).toFixed(1) + "%   no deadline " + forward(ex.arr).toFixed(1) + "%");
  console.log("  trades: donchian " + both.dTr.length + " -> " + ex.dTr.length +
    ",  orb " + both.oTr.length + " -> " + ex.oTr.length);
  console.log("");
  console.log("  If this costs nothing, the live bot never needs to hold two positions on one");
  console.log("  account -- which removes net-position bookkeeping and overlapping brackets,");
  console.log("  the two things most likely to go wrong with real money.");
}
}
