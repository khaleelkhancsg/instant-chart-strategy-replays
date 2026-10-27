// Several strategies in ONE account. Shared by combos_2026.mjs and
// don_mac_together_2026.mjs. The account replay is src/portfolio.mjs
// (accountDays) and the pass rates src/dayeval.mjs; this file builds their
// inputs from the research books.
//
// Each strategy is run alone with no day rules (breaker, profit block and the
// daily-limit stop all off), recording every trade's entry and exit time and
// its worst-point P&L bar by bar. account() then replays any mix of them
// through one account in time order: the breaker, profit block and daily limit
// apply to the COMBINED realised P&L, and each trade's stop is cut at the
// account's remaining daily budget -- the engine's own daily-limit stop, which
// books exactly that budget. Replaying one strategy alone reproduces the
// engine with its day rules exactly (combos_2026.mjs checks it).
//
//   A  strategies trade independently (positions can overlap; P&L adds)
//   B  one position at a time, first come first served
// per[id] adds a strategy's OWN limits inside the account: brk / pb (its own
// breaker / profit block on its own P&L that day), maxLoss (a per-trade stop
// in dollars), from / until (entry window, CT minutes), own (its daily-limit
// stop counts only its own P&L, as its indicator does when it runs beside
// another one -- the account's limit still applies, as the firm enforces it).

import fs from "node:fs";
import { macd, ema } from "../src/indicators.mjs";
import { resample } from "../src/resample.mjs";
import { loadBars } from "../src/data.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import * as ORB from "./lib_orb.mjs";
import { accountDays } from "../src/portfolio.mjs";
import { blockSampler, consecutiveSampler, passRate, passRatePolicy } from "../src/dayeval.mjs";

export const PV = 2;
export const in26 = (td) => S.yearOf.get(td) === 2026;
const { bars } = loadBars();

// ---- shared inputs ------------------------------------------------------------------------
export const tf2 = M.tf;
const n2 = tf2.close.length;
export const E1 = S.engineFor(1);
export const t1 = E1.tf;
const A1 = E1.atr, n1 = t1.close.length;
// Donchian: the 10-min EMA 9/21 direction at each 2-min bar's close
export const HTF = new Int8Array(n2);
{
  const T10 = resample(bars, 10), f10 = ema(T10.close, 9), s10 = ema(T10.close, 21);
  for (let k = 0, j = -1; k < n2; k++) { const lim = tf2.ts[k] + 120000 - 600000; while (j + 1 < T10.ts.length && T10.ts[j + 1] <= lim) j++; HTF[k] = j >= 0 ? Math.sign(f10[j] - s10[j]) || 0 : 0; }
}
// MACD fade: signals, the weak-cross test and the volatility gate
const { line: ML, hist: HS } = macd(t1.close, 12, 26, 9);
export const SIGA = new Int8Array(n1);
for (let i = 1; i < n1; i++) if (t1.ctMin[i] >= 510 && t1.ctMin[i] < 900) SIGA[i] = -(HS[i] > 0 && HS[i - 1] <= 0 ? 1 : HS[i] < 0 && HS[i - 1] >= 0 ? -1 : 0);
const volRel = new Float64Array(n1).fill(NaN);
{
  const days = [], first = new Map(), last = new Map();
  for (let i = 0; i < n1; i++) if (t1.ctMin[i] >= 510 && t1.ctMin[i] < 900) { if (!first.has(t1.tday[i])) { first.set(t1.tday[i], i); days.push(t1.tday[i]); } last.set(t1.tday[i], i); }
  const am = new Map();
  for (const d of days) { let s = 0, c = 0; for (let i = first.get(d); i <= last.get(d); i++) { s += A1[i]; c++; } am.set(d, s / c); }
  days.forEach((d, q) => { if (q < 10) return; const avg = days.slice(q - 10, q).reduce((x, p) => x + am.get(p), 0) / 10; for (let i = first.get(d); i <= last.get(d); i++) volRel[i] = A1[i] / avg; });
}
// Levels: break-prone levels per 2026 session, in this lab's prices (levels_2026.json)
const LV = JSON.parse(fs.readFileSync(new URL("./levels_2026.json", import.meta.url), "utf8"));
const dateOf = (td) => new Date(td * 86400000).toISOString().slice(0, 10);
const lvCache = new Map();
function brkLevels(td) {
  if (lvCache.has(td)) return lvCache.get(td);
  const e = LV[dateOf(td)];
  let out = null;
  if (e && e.off != null) out = { off: e.off, p: e.levels.filter(([, t]) => /^(prior_day_high|prior_day_low|overnight_high|overnight_low)$/.test(t)).map(([, , p]) => p + e.off) };
  lvCache.set(td, out);
  return out;
}
// a break-prone level (or a raw-price round 100) crossed going from `from` to `to`
function crossedBrk(td, from, to) {
  const L = brkLevels(td);
  if (!L) return null;
  const lo = Math.min(from, to), hi = Math.max(from, to);
  if (L.p.some((p) => p > lo && p <= hi)) return true;
  return Math.floor((hi - L.off) / 100) * 100 > lo - L.off;
}
// did the move into bar k go through one in the last W bars? (null = no data: allowed)
function brokeThrough(T, k, W, dir, px) {
  let ext = dir === 1 ? Infinity : -Infinity;
  for (let j = Math.max(0, k - W + 1); j <= k; j++) ext = dir === 1 ? Math.min(ext, T.low[j]) : Math.max(ext, T.high[j]);
  return crossedBrk(T.tday[k], ext, px);
}

// ---- each strategy alone, no day rules: candidate trades with their paths ---------------------
// 2026 only, unless `all` asks for every year
// path[q] = worst P&L so far (raw, before exit costs) by bar q of the trade -- what the
// daily-limit stop compares with the remaining budget
export const exit20 = (k, d, st) => k - st.entBar >= 20 && (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) < st.atr;
export const NODAY = { slipMult: 1, feeMult: 1, limitFillTp: "close", cancelOpposite: true, exitFirst: true, breaker: 0, profitBlock: 0, dayCap: 1e9, detail: true };
function fromEngine(id, pri, t, T) {
  const openExit = t.why === "FLIP" || t.why === "XSIG" || t.why === "FLAT";
  const path = [], ts = [];
  let w = Infinity;
  for (let j = t.entBar; j <= t.xBar; j++) {
    const adv = j === t.xBar && openExit ? T.open[j] : (t.dir === 1 ? Math.min(T.open[j], T.low[j]) : Math.max(T.open[j], T.high[j]));
    w = Math.min(w, (adv - t.avg) * t.dir * PV * t.lots);
    path.push(w); ts.push(T.ts[j]);
  }
  return { id, pri, tday: t.tday, t0: T.ts[t.entBar], t1: T.ts[t.xBar], ct0: T.ctMin[t.entBar], dir: t.dir, pnl: t.pnl, lots: t.lots, why: t.why, path, ts };
}
const shift1 = (a) => { const o = new Int8Array(a.length); for (let i = 1; i < a.length; i++) o[i] = a[i - 1]; return o; };
const RESC1 = shift1(M.RESC), SIGA1 = shift1(SIGA);
// late: lots once the day's range reaches 0.9x its average (default round(lots x 4/7), as tested)
export function donTrades(cap, lots, levels, { late: delay = false, slip = 1, lateLots = null, all = false } = {}) {
  const late = lateLots ?? Math.max(1, Math.round((lots * 4) / 7));
  const sizer = (a, c, s, arm) => {
    const k = arm - 1 - (delay ? 1 : 0);                       // the bar the signal really came from
    if (HTF[k] !== M.RESC[k]) return 0;
    if (levels && brokeThrough(tf2, k, 5, M.RESC[k], tf2.close[k]) === false) return 0;
    return M.adrUsed(k) >= 0.9 ? late : lots;
  };
  return S.run(sizer, { signals: delay ? RESC1 : M.RESC, ...NODAY, slipMult: slip, exitFn: exit20 }).filter((t) => all || in26(t.tday)).map((t) => fromEngine("Donchian", 0, t, tf2));
}
// tpCap: the dollar distance the MACD's target is capped at (its stop on a flat day) -- the
// daily limit by default, as tested
export function macTrades(cap, lots, levels, { late: delay = false, slip = 1, tpCap = cap, all = false } = {}) {
  const sizer = (a, c, s, arm) => {
    const k = arm - 1 - (delay ? 1 : 0), sg = SIGA[k];
    if (!(Math.sign(ML[k]) === sg && !(volRel[k] < 1))) return 0;
    if (levels && brokeThrough(t1, k, 10, -sg, t1.close[k]) === true) return 0;       // the push went the other way
    return lots;
  };
  return E1.run(sizer, { signals: delay ? SIGA1 : SIGA, ...NODAY, slipMult: slip, trig: 0.15, tpFromFill: true, tpFn: (a, q) => Math.min(5.15 * a, tpCap / (2 * q)) })
    .filter((t) => all || in26(t.tday)).map((t) => fromEngine("MACD", 1, t, t1));
}
export const ORB_CFG = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3, mode: "plain", stopAt: "opposite",
                         rMult: 3, maxHoldMin: 5, retraceFrac: 0.33, giveUpCt: 570, maxLots: 50, maxPerDay: 1, bothWays: "fill", maxWidthPts: 31 };
let orbSetups = null;
export function orbTrades(cap, risk, levels) {
  if (!orbSetups) orbSetups = ORB.setups(ORB_CFG).out.filter((s) => in26(s.day));
  const out = [];
  for (const s of orbSetups) {
    if (levels && brokeThrough(t1, s.bar, 10, s.dir, s.entryPx) === false) continue;
    const r = ORB.resolve(s, { ...ORB_CFG, riskDollars: risk });
    const i = s.bar, x = i + r.held, fill = s.entryPx + s.dir * ORB.SLIP;
    const openExit = r.why === "FLAT" || r.why === "TIME" || (x > i && (s.dir === 1 ? ORB.O[x] <= s.entryPx - s.dir * s.risk || ORB.O[x] >= s.entryPx + s.dir * s.risk * ORB_CFG.rMult
                                                                                 : ORB.O[x] >= s.entryPx - s.dir * s.risk || ORB.O[x] <= s.entryPx + s.dir * s.risk * ORB_CFG.rMult));
    const path = [], ts = [];
    let w = Infinity;
    for (let j = i; j <= x; j++) {
      const adv = j === x && openExit ? ORB.O[j] : (s.dir === 1 ? Math.min(ORB.O[j], ORB.L[j]) : Math.max(ORB.O[j], ORB.H[j]));
      w = Math.min(w, (adv - fill) * s.dir * PV * r.lots);
      path.push(w); ts.push(ORB.TS[j]);
    }
    out.push({ id: "ORB", pri: 2, tday: s.day, t0: ORB.TS[i], t1: ORB.TS[x], ct0: t1.ctMin[i], dir: s.dir, pnl: r.raw, lots: r.lots, why: r.why, path, ts });
  }
  return out;
}

// ---- one account (src/portfolio.mjs) ----------------------------------------------------------
export const account = accountDays;
export function score(acct, rules) {
  const arr = S.days.map((d) => acct.day.get(d) || 0);
  const p = (ix) => S.passArr(ix.map((k) => arr[k]), rules);
  const d26 = M.Y26.map((k) => arr[k]);
  let cp = 0, cn = 0;
  for (let q = 0; q + 21 <= d26.length; q++) { cp += S.evWith(d26.slice(q, q + 21), rules); cn++; }
  const tot = d26.reduce((s, v) => s + v, 0);
  return { y: p(M.Y26), a: p(M.Y26a), b: p(M.Y26b), real: (100 * cp) / cn, n: acct.nTaken, perDay: acct.nTaken / M.Y26.length, exp: tot / Math.max(1, acct.nTaken), arr };
}
// ---- pass rates on 2026 day vectors, fast (src/dayeval.mjs) ---------------------------------
// sampler() draws exactly as S.passArr does (blocks of 5 consecutive days, seed 4242), but on
// any subset of 2026 and with any eval length / block length; pass() then scores many day
// vectors on the same draws. passPolicy() lets each day choose between two day vectors from
// the account's state (P&L so far, its high, room above the trailing floor).
export const sampler = blockSampler;
// every run of `window` consecutive days (a real calendar start on each day)
export const realSampler = consecutiveSampler;
export const pass = passRate;
export const passPolicy = passRatePolicy;
// an account's 2026 day results, in M.Y26 order
export const vecOf = (acct) => Float64Array.from(M.Y26, (k) => acct.day.get(S.days[k]) || 0);
export { ML, volRel };
