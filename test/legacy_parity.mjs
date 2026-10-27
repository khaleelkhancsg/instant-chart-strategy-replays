// The one engine against the code it replaced.   node test/legacy_parity.mjs
//
// research/lib_shipped.mjs, lib_orb.mjs, lib_forward.mjs, lib_search.mjs and
// lib_combo.mjs used to carry their own execution engines and pass-rate
// evaluators. They are now thin adapters over src/. This proves each one
// reproduces its frozen original (test/oracles/*_v1.mjs) trade for trade, so
// every result recorded against the old code still stands -- and that the old
// src/engine.mjs is the new one run with LEGACY_EXEC.
//
// Real data, seeded randomness: PARITY_SEED picks another sequence, PARITY_SCALE
// multiplies the case counts.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { resample, sliceBars } from "../src/resample.mjs";
import { atr } from "../src/indicators.mjs";
import { runBrackets, resolveExec, LEGACY_EXEC } from "../src/engine.mjs";
import * as E1 from "./oracles/engine_v1.mjs";

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
function section(s) { console.log(`\n${s}\n${"-".repeat(s.length)}`); }

let seed = Number(process.env.PARITY_SEED) || 4711;
const SCALE = Math.max(1, Number(process.env.PARITY_SCALE) || 1);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const uni = (lo, hi) => lo + rnd() * (hi - lo);
const iuni = (lo, hi) => Math.floor(uni(lo, hi + 1));

// Two trade lists equal field by field. Prices and money to 1e-9: the same
// arithmetic in the same order is exact, and a reordered sum is not a bug.
function sameTrades(a, b, fields, where) {
  if (a.length !== b.length) throw new Error(`${a.length} trades vs ${b.length} -- ${where()}`);
  for (let k = 0; k < a.length; k++) {
    for (const f of fields) {
      const u = a[k][f], v = b[k][f];
      const ok = typeof u === "number" && typeof v === "number"
        ? (u === v || Math.abs(u - v) <= 1e-9 * Math.max(1, Math.abs(v)) || (Number.isNaN(u) && Number.isNaN(v)))
        : u === v;
      if (!ok) throw new Error(`trade ${k} of ${a.length}, ${f}: ${u} vs ${v} -- ${where()}`);
    }
  }
}

const { bars: B } = loadBars();

section("1. src/engine.mjs with LEGACY_EXEC = the engine before consolidation");
function randomExec() {
  return {
    contracts: iuni(1, 20), maxContracts: iuni(1, 20), sizingMode: pick(["fixed", "fixed", "risk"]), riskDollars: iuni(50, 1500),
    slAtrMult: pick([0.25, 0.5, 1, 1.5, 2, 3, 5, 8, 1000]), tpMode: pick(["atr", "atr", "rr"]),
    tpAtrMult: pick([0.25, 0.5, 1, 2, 4, 12, 40, 1000]), tpRR: pick([0.3, 1, 1.2, 2, 5]),
    commissionModel: pick(["per-contract", "per-contract", "flat"]), commissionPerSide: pick([0, 0.75, 1.5]), commissionFlat: pick([0, 5, 12]),
    slippageTicks: pick([0, 0, 1, 2]), flipOnOpposite: rnd() < 0.7, sameBarReentry: rnd() < 0.15,
    cooldownAfterStopMins: pick([0, 0, 15, 90]), maxBarsInTrade: pick([0, 0, 5, 40, 200]),
    intradayOnly: rnd() < 0.7, flattenCt: pick([15 * 60 + 5, 14 * 60, 12 * 60 + 30]), reopenCt: pick([17 * 60, 17 * 60, 8 * 60 + 30]),
    noEntryMinsBeforeFlat: pick([0, 0, 10, 60]),
    dayProfitStopUsd: pick([0, 0, 300, 1500]), dayLossStopUsd: pick([0, 0, 300, 1000]), dayLossStopMode: pick(["price", "exact"]),
    scaleInFrac: pick([0, 0, 0, 0.5, 0.25]), scaleInTrigger: pick([0, 0.25, 1]), scaleInWindowBars: pick([1, 10, 30]),
    scaleInOrder: pick(["before", "after"]), scaleInSlipTicks: pick([0, 1]), pointValue: pick([2, 2, 20]),
  };
}
const ENGINE_FIELDS = ["entryIdx", "exitIdx", "entryTime", "exitTime", "tday", "dir", "contracts", "reason", "entryPrice", "exitPrice",
                       "stop", "target", "pnl", "gross", "fees", "mae", "mfe", "bars"];
t(`${300 * SCALE} random configurations, real bars, 1-15 minute: identical trades`, () => {
  let n = 0;
  for (let c = 0; c < 300 * SCALE; c++) {
    const tfMin = pick([1, 1, 2, 3, 5, 15]);
    const s0 = iuni(0, B.count - 40000), tf = resample(sliceBars(B, s0, s0 + 30000), tfMin), nb = tf.close.length;
    const a = atr(tf.high, tf.low, tf.close, 14);
    const sig = new Int8Array(nb), dens = pick([0.005, 0.02, 0.08]);
    for (let i = 0; i < nb; i++) if (rnd() < dens) sig[i] = rnd() < 0.5 ? 1 : -1;
    const x = randomExec();
    if (rnd() < 0.3) { x.exitSig = new Int8Array(nb); for (let i = 0; i < nb; i++) if (rnd() < 0.03) x.exitSig[i] = iuni(1, 3); }
    const old = E1.runBrackets(tf, sig, a, E1.resolveExec(x)).trades;
    const now = runBrackets(tf, sig, a, resolveExec({ ...x, ...LEGACY_EXEC })).trades;
    sameTrades(now, old, ENGINE_FIELDS, () => `case ${c} tf ${tfMin} ${JSON.stringify({ ...x, exitSig: x.exitSig ? "mask" : undefined })}`);
    n += old.length;
  }
  console.log(`         (${n.toLocaleString()} trades compared)`);
});

// The research libraries, new against old. Both load the same 5 years of bars.
const S1 = await import("./oracles/lib_shipped_v1.mjs"), S2 = await import("../research/lib_shipped.mjs");

section("2. research/lib_shipped.mjs: run(), engineFor(), episode()");
const SHIPPED_FIELDS = ["tday", "pnl", "why", "entCt", "lots", "atr", "held", "sigBar", "entBar", "xBar", "dir", "avg"];
// Hooks of the kinds the research scripts pass: fixed and volatility sizers, a
// sizer that reads the trades booked so far, exits and stops from the trade state.
function randomRunOpts(nBars) {
  const o = {
    costMult: pick([1, 1, 0.5, 2]), breaker: pick([500, 0, 150]), profitBlock: pick([750, 0, 300]),
    entryModel: pick(["limit", "limit", "optimistic"]), slMult: pick([5, 5, 2, 8]), tpMult: pick([1.75, 1.75, 1, 3]),
    trig: pick([0.15, 0.15, 0.05, 0.4]), addWin: pick([10, 10, 1, 30]), overnight: rnd() < 0.2,
    slipMult: pick([null, null, 0, 2]), feeMult: pick([null, null, 0, 1.5]), tpFromFill: rnd() < 0.3,
    limitFillTp: pick(["high", "close"]), dayCap: pick([1000, 1000, 600, 1e9]), cancelOpposite: rnd() < 0.5,
    exitFirst: rnd() < 0.5, entryLimitAtr: pick([null, null, null, 0.1, 0.3]), noFlip: rnd() < 0.15, flipAll: rnd() < 0.1,
    detail: true, fillBarStop: pick(["touch", "touch", "close"]), sameBarTie: pick(["stop", "stop", "target"]),
  };
  const k = iuni(0, 4);
  if (k === 1) o.exitFn = (b, d, st) => b - st.entBar >= 20 && (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) < st.atr;
  if (k === 2) o.exitFn = (b, d, st) => b >= st.entBar + 3 && (st.dir === 1 ? st.mn < st.fill - st.atr : st.mx > st.fill + st.atr);
  if (rnd() < 0.3) {
    const be = pick([0.5, 1, 2]);
    o.stopFn = pick([
      (b, st) => ((st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) >= be * st.atr ? st.fill + st.dir * 0.1 * st.atr : null),
      (b, st) => (st.dir === 1 ? st.mx - 2 * st.atr : st.mn + 2 * st.atr),
      (b, st) => (b - st.entBar >= 15 ? st.fill - st.dir * 0.5 * st.atr : null),
    ]);
  }
  if (rnd() < 0.3) o.tpFn = (a, q) => Math.min(5.15 * a, 600 / (2 * q));
  if (rnd() < 0.4) {
    // an alternative signal array: sparse random, so flips, re-arms and cancels all happen
    const sg = new Int8Array(nBars), dens = pick([0.003, 0.02]);
    for (let i = 0; i < nBars; i++) if (rnd() < dens) sg[i] = rnd() < 0.5 ? 1 : -1;
    o.signals = sg;
  }
  return o;
}
// A sizer kind, as a factory: a stateful sizer needs a fresh copy for each run.
function randomSizer() {
  const kind = iuni(0, 4), lots = iuni(1, 10);
  if (kind === 0) return { tag: `fixed ${lots}`, make: () => ({ sizer: () => lots }) };
  if (kind === 1) return { tag: "1/ATR", make: () => ({ sizer: (a) => Math.max(1, Math.min(20, Math.round(120 / a))) }) };
  if (kind === 2) return { tag: `skip every 3rd, ${lots}`, make: () => ({ sizer: (a, ct, seq) => (seq % 3 === 2 ? 0 : lots) }) };
  if (kind === 3) return { tag: "fractional after noon", make: () => ({ sizer: (a, ct) => (ct >= 720 ? 2.5 : lots) }) };
  // reads what has been booked so far: 1 lot after a losing trade
  return { tag: "1 lot after a loss", make: () => { let last = 0; return { sizer: () => (last < 0 ? 1 : lots), onTrade: (tr) => { last = tr.pnl; } }; } };
}
const nB2 = S1.engineFor(2).tf.close.length;
t(`${40 * SCALE} random option sets on the 2-minute shipped engine: identical trades`, () => {
  let n = 0;
  for (let c = 0; c < 40 * SCALE; c++) {
    const o = randomRunOpts(nB2), z = randomSizer(), z1 = z.make(), z2 = z.make();
    const a = S1.run(z1.sizer, { ...o, onTrade: z1.onTrade });
    const b = S2.run(z2.sizer, { ...o, onTrade: z2.onTrade });
    sameTrades(b, a, SHIPPED_FIELDS, () => `case ${c} sizer ${z.tag} ${JSON.stringify({ ...o, signals: o.signals ? "random" : undefined, exitFn: !!o.exitFn, stopFn: !!o.stopFn, tpFn: !!o.tpFn })}`);
    n += a.length;
  }
  console.log(`         (${n.toLocaleString()} trades compared)`);
});
t("the shipped defaults, and the research's no-day-rules set, trade for trade", () => {
  sameTrades(S2.run(() => 8), S1.run(() => 8), SHIPPED_FIELDS.slice(0, 8), () => "defaults, 8 lots");
  const NODAY = { slipMult: 1, feeMult: 1, limitFillTp: "close", cancelOpposite: true, exitFirst: true, breaker: 0, profitBlock: 0, dayCap: 1e9, detail: true };
  sameTrades(S2.run(() => 4, NODAY), S1.run(() => 4, NODAY), SHIPPED_FIELDS, () => "NODAY, 4 lots");
});
for (const tfMin of [1, 5]) {
  t(`engineFor(${tfMin}): random signals and options, identical trades (hold in real minutes now)`, () => {
    const e1 = S1.engineFor(tfMin), e2 = S2.engineFor(tfMin), nb = e1.tf.close.length;
    let n = 0;
    for (let c = 0; c < 12 * SCALE; c++) {
      const o = randomRunOpts(nb);
      if (!o.signals) { o.signals = new Int8Array(nb); for (let i = 0; i < nb; i++) if (rnd() < 0.01) o.signals[i] = rnd() < 0.5 ? 1 : -1; }
      const lots = iuni(1, 8);
      const a = e1.run(() => lots, o), b = e2.run(() => lots, o);
      try { sameTrades(b, a, SHIPPED_FIELDS.filter((f) => f !== "held"), () => `tf ${tfMin} case ${c}`); }
      catch (err) {
        // PARITY_DUMP=<file> writes the failing case out, so it can be replayed alone
        if (process.env.PARITY_DUMP) {
          fs.writeFileSync(process.env.PARITY_DUMP, JSON.stringify({ tfMin, lots, o: { ...o, signals: Array.from(o.signals), exitFn: o.exitFn && o.exitFn.toString(), stopFn: o.stopFn && o.stopFn.toString(), tpFn: o.tpFn && o.tpFn.toString() } }));
        }
        throw err;
      }
      for (let k = 0; k < a.length; k++) if (b[k].held !== (a[k].held / 2) * tfMin) throw new Error(`held: ${b[k].held} vs ${a[k].held} (x${tfMin}/2)`);
      n += a.length;
    }
    console.log(`         (${n.toLocaleString()} trades compared)`);
  });
}
t(`${150 * SCALE} random episodes: the account-aware runner agrees`, () => {
  for (let c = 0; c < 150 * SCALE; c++) {
    const start = iuni(0, S1.days.length - 5), nDays = pick([5, 21, 42, 100]);
    const big = iuni(4, 12), small = iuni(1, 4), roomy = pick([500, 1000, 1500]);
    // trade smaller near the floor, and nothing on the floor
    const sizer = (a, ct, st) => (st.room > roomy ? big : st.room > 0 ? small : 0);
    const opt = { breaker: pick([500, 0]), profitBlock: pick([750, 0]), dd: pick([2000, 1500, 3000]), costMult: pick([1, 2]),
                  ddMode: pick(["lock", "eod", "always"]) };
    const a = S1.episode(start, nDays, sizer, opt), b = S2.episode(start, nDays, sizer, opt);
    for (const f of ["dead", "trades", "days"]) if (a[f] !== b[f]) throw new Error(`episode ${c} ${f}: ${b[f]} vs ${a[f]} (${JSON.stringify({ start, nDays, ...opt })})`);
    if (Math.abs(a.acct - b.acct) > 1e-6) throw new Error(`episode ${c} acct: ${b.acct} vs ${a.acct}`);
  }
});
t("the day-sequence evaluator: evWith, dayArr, passArr and passOf agree", () => {
  for (let c = 0; c < 400 * SCALE; c++) {
    const len = iuni(5, 80), d = Array.from({ length: len }, () => (rnd() < 0.1 ? uni(-2500, 4000) : uni(-700, 900)));
    const r = { target: pick([1250, 3000, 9000]), dd: pick([1000, 2000]), consistency: pick([0, 0.3, 0.5]) };
    if (S1.evWith(d, r) !== S2.evWith(d, r)) throw new Error(`evWith case ${c}`);
    if (S1.evWith(d) !== S2.evWith(d)) throw new Error(`evWith defaults case ${c}`);
  }
  const keys = S1.days.slice(-300), tr = [];
  for (let k = 0; k < 900; k++) tr.push({ tday: pick(keys), pnl: uni(-900, 1100) });
  const a1 = S1.dayArr(tr, keys), a2 = S2.dayArr(tr, keys);
  for (let k = 0; k < keys.length; k++) if (a1[k] !== a2[k]) throw new Error(`dayArr day ${k}`);
  for (const opt of [{}, { draws: 3000, seed: 7 }, { window: 42, target: 1250, dd: 2000 }, { consistency: 0 }]) {
    const p1 = S1.passArr(a1, opt), p2 = S2.passArr(a2, opt);
    if (p1 !== p2) throw new Error(`passArr ${JSON.stringify(opt)}: ${p2} vs ${p1}`);
  }
  if (S1.passOf(tr, keys) !== S2.passOf(tr, keys)) throw new Error("passOf");
});

section("3. research/lib_orb.mjs: setups resolved by the engine");
const O1 = await import("./oracles/lib_orb_v1.mjs"), O2 = await import("../research/lib_orb.mjs");
const ORB_FIELDS = ["tday", "pnl", "raw", "why", "risk", "held", "dir", "lots", "riskUsd", "capped", "ambig"];
const ORB_CFGS = [
  {},
  { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3, mode: "plain", stopAt: "opposite",
    rMult: 3, maxHoldMin: 5, retraceFrac: 0.33, giveUpCt: 570, maxLots: 50, maxPerDay: 1, bothWays: "fill", maxWidthPts: 31, riskDollars: 500 },
  { refWin: "OR15", mode: "confirmed", stopAt: "retrace", rMult: 2, maxHoldMin: 60, riskDollars: 400, barFirst: "target" },
  { refWin: "PRE60", mode: "plain", stopAt: "range", stopK: 0.5, rMult: 1.5, maxHoldMin: 30, maxPerDay: 3, costMult: 2 },
  { refWin: "OR5", tpMode: "liqNear", stopAt: "level", rMult: 2, maxHoldMin: 120, flipSeed: 9, stopUsd: 300 },
  { refWin: "PRE90", levelMode: "touch", levelFallback: true, mode: "plain", stopAt: "fixed", stopPts: 12, tpCapPts: 20, maxHoldMin: 15, riskDollars: 300 },
  { refWin: "OR30", tpMode: "prevDay", tpFallback: "R", mode: "confirmed", sameBar: true, maxHoldMin: 90, giveUpCt: 600 },
];
t(`${ORB_CFGS.length} ORB configurations: identical setups and identical trades`, () => {
  let n = 0;
  ORB_CFGS.forEach((cfg, c) => {
    const a = O1.run(cfg), b = O2.run(cfg);
    if (JSON.stringify(a.diag) !== JSON.stringify(b.diag)) throw new Error(`cfg ${c}: setups differ`);
    sameTrades(b.trades, a.trades, ORB_FIELDS, () => `cfg ${c} ${JSON.stringify(cfg)}`);
    n += a.trades.length;
  });
  console.log(`         (${n.toLocaleString()} trades compared)`);
});
t("ORB pass rates: ev, dayArr (floored at the daily limit) and passOf agree", () => {
  const r = O1.run(ORB_CFGS[1]);
  for (const keys of [O1.ALL, O1.H1, O1.RECENT]) {
    const a1 = O1.dayArr(r.trades, keys), a2 = O2.dayArr(r.trades, keys);
    for (let k = 0; k < keys.length; k++) if (a1[k] !== a2[k]) throw new Error(`dayArr day ${k}`);
    if (O1.passOf(r.trades, keys) !== O2.passOf(r.trades, keys)) throw new Error("passOf");
    if (O1.passOfArr(a1, 4000, 11) !== O2.passOfArr(a2, 4000, 11)) throw new Error("passOfArr");
  }
});

section("4. research/lib_forward.mjs: per-entry outcome tables");
const F1 = await import("./oracles/lib_forward_v1.mjs"), F2 = await import("../research/lib_forward.mjs");
t("random signals, five geometries with and without a partial target, sessions on and off", () => {
  for (let c = 0; c < 6 * SCALE; c++) {
    const tfMin = pick([1, 2, 5]), s0 = iuni(0, B.count - 60000), tf = resample(sliceBars(B, s0, s0 + 50000), tfMin), nb = tf.close.length;
    const a = atr(tf.high, tf.low, tf.close, 14), sg = new Int8Array(nb);
    for (let i = 0; i < nb; i++) if (rnd() < 0.02) sg[i] = rnd() < 0.5 ? 1 : -1;
    const plans = [{ sl: 2, tp: 4 }, { sl: 1, tp: 2, t1: 1, t1Frac: 0.5 }, { sl: 0.5, tp: 0.5 }, { sl: 3, tp: 12, t1: 2, t1Frac: 0.25 }, { sl: 1, tp: 1, t1: 0.5, t1Frac: 0 }];
    const session = pick([null, { flattenCt: 905, reopenCt: 1020 }, { flattenCt: 905, reopenCt: 510 }]);
    const pv = pick([2, 20]);
    const x = F1.buildOutcomeTable(tf, sg, a, plans, session, pv), y = F2.buildOutcomeTable(tf, sg, a, plans, session, pv);
    if (x.count !== y.count) throw new Error("count");
    for (let p = 0; p < plans.length; p++) for (let k = 0; k < x.count; k++) {
      if (x.outcomes[p].exitIdx[k] !== y.outcomes[p].exitIdx[k]) throw new Error(`case ${c} plan ${p} entry ${k}: exit ${y.outcomes[p].exitIdx[k]} vs ${x.outcomes[p].exitIdx[k]}`);
      if (Math.abs(x.outcomes[p].pnl[k] - y.outcomes[p].pnl[k]) > 1e-9 * Math.max(1, Math.abs(x.outcomes[p].pnl[k]))) throw new Error(`case ${c} plan ${p} entry ${k}: pnl ${y.outcomes[p].pnl[k]} vs ${x.outcomes[p].pnl[k]}`);
    }
    for (let k = 0; k < Math.min(x.count, 400); k++) {
      const r1 = F1.simulateEntry(tf, x.entryBar[k], x.dir[k], a[x.entryBar[k] - 1], plans[1], session, pv);
      const r2 = F2.simulateEntry(tf, x.entryBar[k], x.dir[k], a[x.entryBar[k] - 1], plans[1], session, pv);
      if (r1.reason !== r2.reason) throw new Error(`case ${c} entry ${k}: reason ${r2.reason} vs ${r1.reason}`);
    }
  }
});

section("5. research/lib_combo.mjs and lib_donchian_mgmt.mjs: books in one account");
const C1 = await import("./oracles/lib_combo_v1.mjs"), C2 = await import("../research/lib_combo.mjs");
const M1 = await import("./oracles/lib_donchian_mgmt_v1.mjs"), M2 = await import("../research/lib_donchian_mgmt.mjs");
const COMBO_FIELDS = ["id", "pri", "tday", "t0", "t1", "ct0", "dir", "pnl", "lots", "why"];
function samePaths(a, b, where) {
  for (let k = 0; k < a.length; k++) {
    if (a[k].path.length !== b[k].path.length) throw new Error(`trade ${k} path length -- ${where}`);
    for (let q = 0; q < a[k].path.length; q++) if (Math.abs(a[k].path[q] - b[k].path[q]) > 1e-9 * Math.max(1, Math.abs(a[k].path[q])) || a[k].ts[q] !== b[k].ts[q]) throw new Error(`trade ${k} path ${q} -- ${where}`);
  }
}
let books1 = null, books2 = null;
t("the Donchian, MACD and ORB books' candidate trades and their worst-point paths", () => {
  books1 = [...C1.donTrades(1000, 4, false), ...C1.macTrades(1000, 4, false), ...C1.orbTrades(1000, 500, false)];
  books2 = [...C2.donTrades(1000, 4, false), ...C2.macTrades(1000, 4, false), ...C2.orbTrades(1000, 500, false)];
  sameTrades(books2, books1, COMBO_FIELDS, () => "books");
  samePaths(books2, books1, "books");
  const d1 = C1.donTrades(1000, 7, true, { late: true, lateLots: 3 }), d2 = C2.donTrades(1000, 7, true, { late: true, lateLots: 3 });
  sameTrades(d2, d1, COMBO_FIELDS, () => "Donchian with levels, late sizing, delayed");
  const m1 = C1.macTrades(1250, 5, true, { tpCap: 600 }), m2 = C2.macTrades(1250, 5, true, { tpCap: 600 });
  sameTrades(m2, m1, COMBO_FIELDS, () => "MACD with levels, $600 target cap");
  console.log(`         (${books1.length.toLocaleString()} candidate trades compared)`);
});
t(`${60 * SCALE} random account rules: day results and pass rates agree`, () => {
  for (let c = 0; c < 60 * SCALE; c++) {
    const opt = { cap: pick([600, 1000, 1250]), brk: pick([0, 0, 300, 500]), pb: pick([0, 0, 750]), model: pick(["A", "B"]),
                  per: rnd() < 0.4 ? { MACD: { brk: pick([0, 200]), maxLoss: pick([0, 300]), from: pick([null, 540]), own: rnd() < 0.5 }, ORB: { until: pick([null, 600]) } } : null };
    const sub = books1.filter((x) => rnd() < 0.9 || x.id !== "ORB");
    const a = C1.account(sub, opt), b = C2.account(sub, opt);
    if (a.nTaken !== b.nTaken || a.day.size !== b.day.size) throw new Error(`case ${c}: taken ${b.nTaken} vs ${a.nTaken}`);
    for (const [d, v] of a.day) if (Math.abs(v - b.day.get(d)) > 1e-9 * Math.max(1, Math.abs(v))) throw new Error(`case ${c} day ${d}: ${b.day.get(d)} vs ${v}`);
    const rules = { target: pick([1250, 3000]), dd: 2000, consistency: pick([0, 0.5]) };
    const s1 = C1.score(a, rules), s2 = C2.score(b, rules);
    for (const f of ["y", "a", "b", "real", "n"]) if (s1[f] !== s2[f]) throw new Error(`case ${c} score.${f}: ${s2[f]} vs ${s1[f]}`);
  }
});
t("samplers and the policy pass rate agree", () => {
  const vec = Float64Array.from({ length: 140 }, () => uni(-800, 1000)), sub = Int32Array.from({ length: 140 }, (_, k) => k);
  for (const so of [{}, { draws: 2000, seed: 3, window: 42, block: 3 }]) {
    const s1 = C1.sampler(140, so), s2 = C2.sampler(140, so);
    for (let k = 0; k < s1.idx.length; k++) if (s1.idx[k] !== s2.idx[k]) throw new Error("sampler draws");
    const r = { target: 3000, dd: 2000, consistency: 0.5 };
    if (C1.pass(vec, sub, s1, r) !== C2.pass(vec, sub, s2, r)) throw new Error("pass");
    const pol = (cum, pk, room) => room > 1000;
    if (C1.passPolicy(vec, vec.map((v) => v * 1.5), sub, s1, r, pol) !== C2.passPolicy(vec, vec.map((v) => v * 1.5), sub, s2, r, pol)) throw new Error("passPolicy");
  }
  const r1 = C1.realSampler(140, 21), r2 = C2.realSampler(140, 21);
  if (r1.idx.length !== r2.idx.length || r1.idx.some((v, k) => v !== r2.idx[k])) throw new Error("realSampler");
});
t("lib_donchian_mgmt: exit/stop management configurations score the same", () => {
  const cfgs = [M1.LIVE, { ...M1.LIVE, ex: [0, 1, 0] }, { ...M1.LIVE, st: ["be", 1, 0.1] }, { ...M1.LIVE, st: ["ch", 1, 2], tx: ["nr", 20, 1] },
                { ...M1.LIVE, ex: [6, 0, 3], st: ["sb", 5, 0.5], tx: ["mx", 60] }, { ...M1.LIVE, sl: 3, tp: 2.5, trig: 0.25, lots: 6, br: 0, pb: 0 }];
  for (const cfg of cfgs) {
    const a = M1.evalCfg(cfg), b = M2.evalCfg(cfg);
    sameTrades(b.tr, a.tr, SHIPPED_FIELDS.slice(0, 8), () => M1.name(cfg));
    for (const f of ["all", "h1", "h2", "y25", "y26", "r2", "a26", "b26"]) if (a[f] !== b[f]) throw new Error(`${M1.name(cfg)} ${f}: ${b[f]} vs ${a[f]}`);
  }
});

section("6. research/lib_search.mjs: the fast replay and the legacy bracket grid");
const L1 = await import("./oracles/lib_search_v1.mjs"), L2 = await import("../research/lib_search.mjs");
{
  const { loadStrategies } = await import("../src/registry.mjs");
  const { resolveParams } = await import("../src/run.mjs");
  const { resolveRules } = await import("../src/challenge.mjs");
  const strategies = await loadStrategies();
  t("bracketGrid reproduces the pre-consolidation search, and the fast replay agrees", () => {
    const H = sliceBars(B, B.count - 300000, B.count);
    for (const id of ["trend_neutev", "momentum_roc", "orb"]) {
      const s = strategies.get(id), p = resolveParams(s, {});
      const g1 = L1.bracketGrid(H, s, p, [1, 3], [1.5, 6], { contracts: 1 }), g2 = L2.bracketGrid(H, s, p, [1, 3], [1.5, 6], { contracts: 1 });
      g1.forEach((r, k) => sameTrades(g2[k].trades, r.trades, ENGINE_FIELDS, () => `${id} sl ${r.sl} tp ${r.tp}`));
      const starts = L2.windowStarts(H, 30, 3), R = resolveRules({ profitTarget: 3000, trailingDD: 2000 });
      for (const mult of [1, 4]) {
        const f1 = L1.fastSweep(L1.flatten(g1[1].trades), starts, R, mult), f2 = L2.fastSweep(L2.flatten(g2[1].trades), starts, R, mult);
        if (f1.pass !== f2.pass || f1.fail !== f2.fail) throw new Error(`${id} fastSweep x${mult}: ${f2.pass}/${f2.fail} vs ${f1.pass}/${f1.fail}`);
        L2.assertParity(g2[1].trades, starts, R, mult);
      }
    }
  });
}

// ══════════════════════════════ RESULT ══════════════════════════════
console.log(`\n${"=".repeat(64)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:"); for (const f of failures) console.log("  - " + f); }
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
