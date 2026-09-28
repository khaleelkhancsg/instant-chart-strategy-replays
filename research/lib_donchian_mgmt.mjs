// Shared machinery for the Donchian trade-management searches: the live
// signal, the indicator readings the exits use, a config -> engine-options
// builder, and scoring weighted to 2025-26. donchian_joint_search.mjs carries
// its own copy of the same definitions (it produced its saved results before
// this file existed); donchian_robustness.mjs checks that the two agree.

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { ema, sma, adx, rsi, donchian, efficiencyRatio, macd, rollingMinMax, supertrend } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";

const { bars } = loadBars();
export const tf = resample(bars, 2);
const { open: O, high: H, low: L, close: C, volume: V, ctMin: CT, tday: TD } = tf;
const n2 = C.length;

const { adx: ax, pdi, ndi } = adx(H, L, C, 14);
const { high: dh, low: dl } = donchian(H, L, 30);
const raw = new Int8Array(n2);
for (let i = 30; i < n2; i++) {
  if (ax[i] < 25) continue;
  if (C[i] > dh[i]) raw[i] = 1; else if (C[i] < dl[i]) raw[i] = -1;
}
const fctx = buildFilterContext(tf);
const gated = (x) => applyFilters(raw, fctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: x });
const G05 = gated(0.5), G045 = gated(0.45);
const t125 = ema(C, 125), t500 = ema(C, 500);
export const RESC = Int8Array.from(G05);
for (let k = 0; k < n2; k++)
  if (G045[k] && !G05[k] && Math.sign(t125[k] - t500[k]) === raw[k]) RESC[k] = G045[k];

const E = {}; for (const p of [9, 20, 21, 50]) E[p] = ema(C, p);
const DC = {}; for (const n of [5, 10, 15, 20]) DC[n] = donchian(H, L, n);
const RM = {}; for (const n of [3, 5, 10, 20]) RM[n] = rollingMinMax(H, L, n);
const ER10 = efficiencyRatio(C, 10);
const ST2 = supertrend(H, L, C, 10, 2).trend, ST3 = supertrend(H, L, C, 10, 3).trend;
const RSI = rsi(C, 14);
const MH = macd(C, 12, 26, 9).hist;
const VA = sma(V, 20);
const VW = new Float64Array(n2).fill(NaN);
{
  let pv = 0, vv = 0, day = -1, on = false;
  for (let i = 0; i < n2; i++) {
    if (TD[i] !== day) { day = TD[i]; on = false; }
    if (CT[i] >= 510 && CT[i] < 960) {
      if (!on) { pv = 0; vv = 0; on = true; }
      const tp = (H[i] + L[i] + C[i]) / 3;
      pv += tp * V[i]; vv += V[i];
      VW[i] = vv > 0 ? pv / vv : tp;
    }
  }
}

export const upnl = (k, st) => (C[k] - st.fill) * st.dir;
export const mfe = (st) => (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn);
export const CONDS = [
  ["always", () => true],
  ["under water", (k, st) => upnl(k, st) < 0],
  ["1 ATR down", (k, st) => upnl(k, st) <= -st.atr],
  ["never green", (k, st) => mfe(st) < 0.5 * st.atr],
];
export const SIGS = [
  ["back inside channel", (k, d, st) => (d === 1 ? C[k] < dh[st.sigBar] : C[k] > dl[st.sigBar])],
  ["back inside by 0.5 ATR", (k, d, st) => (d === 1 ? C[k] < dh[st.sigBar] - 0.5 * st.atr : C[k] > dl[st.sigBar] + 0.5 * st.atr)],
  ["30-bar midline", (k, d) => (C[k] - (dh[k] + dl[k]) / 2) * d < 0],
  ["Turtle 5", (k, d) => (d === 1 ? C[k] < DC[5].low[k] : C[k] > DC[5].high[k])],
  ["Turtle 10", (k, d) => (d === 1 ? C[k] < DC[10].low[k] : C[k] > DC[10].high[k])],
  ["Turtle 20", (k, d) => (d === 1 ? C[k] < DC[20].low[k] : C[k] > DC[20].high[k])],
  ["EMA 9", (k, d) => (C[k] - E[9][k]) * d < 0],
  ["EMA 20", (k, d) => (C[k] - E[20][k]) * d < 0],
  ["EMA 50", (k, d) => (C[k] - E[50][k]) * d < 0],
  ["EMA 9/21 cross", (k, d) => (E[9][k] - E[21][k]) * d < 0],
  ["DI cross", (k, d) => (d === 1 ? ndi[k] > pdi[k] : pdi[k] > ndi[k])],
  ["ADX < 20", (k) => ax[k] < 20],
  ["efficiency collapse", (k, d) => ER10[k] < 0.2 && (C[k] - C[k - 10]) * d < 0],
  ["Supertrend 2", (k, d) => ST2[k] === -d],
  ["Supertrend 3", (k, d) => ST3[k] === -d],
  ["VWAP", (k, d) => (C[k] - VW[k]) * d < 0],
  ["RSI 50", (k, d) => (RSI[k] - 50) * d < 0],
  ["RSI 40/60", (k, d) => (d === 1 ? RSI[k] < 40 : RSI[k] > 60)],
  ["MACD hist", (k, d) => MH[k] * d < 0],
  ["ROC 10", (k, d) => (C[k] - C[k - 10]) * d < 0],
  ["volume rejection", (k, d, st) => V[k] >= 2 * VA[k] && (C[k] - O[k]) * d <= -0.5 * st.atr],
];

// c = { ex?: [sigIdx, condIdx, grace], st?: ["be"|"ch"|"sb"|"tt", a, b],
//       tx?: ["uw"|"nr"|"mx", a, b], sl, tp, trig, lots, br, pb }
export const LIVE = { sl: 5, tp: 1.75, trig: 0.15, lots: 8, br: 500, pb: 750 };
export function name(c) {
  const p = [];
  if (c.ex) p.push("exit " + SIGS[c.ex[0]][0] + " (" + CONDS[c.ex[1]][0] + (c.ex[2] ? ", 3-bar grace" : "") + ")");
  if (c.st) p.push({ be: `BE +${c.st[1]}->${c.st[2]}`, ch: `trail ${c.st[2]} ATR${c.st[1] ? " once +" + c.st[1] : ""}`,
                     sb: `${c.st[1]}-bar low${c.st[2] ? " once +" + c.st[2] : ""}`, tt: `after ${c.st[1]} bars stop ${c.st[2]} ATR` }[c.st[0]]);
  if (c.tx) p.push({ uw: `out if under water at ${c.tx[1]} bars`, nr: `out if not +${c.tx[2]} ATR by ${c.tx[1]} bars`,
                     mx: `max hold ${c.tx[1]} bars` }[c.tx[0]]);
  p.push(`${c.sl}/${c.tp} ATR, trig ${c.trig}, ${c.lots} lots, br ${c.br || "off"}, pb ${c.pb || "off"}`);
  return p.join("; ");
}
export function build(c) {
  const o = { slMult: c.sl, tpMult: c.tp, trig: c.trig, breaker: c.br, profitBlock: c.pb };
  let ex = null, tx = null;
  if (c.ex) { const [si, ci, g] = c.ex, sf = SIGS[si][1], cf = CONDS[ci][1];
    ex = (k, d, st) => k >= st.entBar + g && cf(k, st) && sf(k, d, st); }
  if (c.tx) {
    const [t, a, b] = c.tx;
    tx = t === "uw" ? (k, d, st) => k - st.entBar >= a && upnl(k, st) <= 0
       : t === "nr" ? (k, d, st) => k - st.entBar >= a && mfe(st) < b * st.atr
       : (k, d, st) => k - st.entBar >= a;
  }
  if (ex || tx) o.exitFn = (k, d, st) => (ex !== null && ex(k, d, st)) || (tx !== null && tx(k, d, st));
  if (c.st) {
    const [t, a, b] = c.st;
    o.stopFn = t === "be" ? (k, st) => (mfe(st) >= a * st.atr ? st.fill + st.dir * b * st.atr : null)
             : t === "ch" ? (k, st) => (mfe(st) >= a * st.atr ? (st.dir === 1 ? st.mx - b * st.atr : st.mn + b * st.atr) : null)
             : t === "sb" ? (k, st) => (mfe(st) >= b * st.atr ? (st.dir === 1 ? RM[a].low[k] : RM[a].high[k]) : null)
             : (k, st) => (k - st.entBar >= a ? st.fill - st.dir * b * st.atr : null);
  }
  return o;
}

export const days = S.days;
export const NH = days.length >> 1;
export const yIdx = (f) => days.map((d, k) => (f(S.yearOf.get(d)) ? k : -1)).filter((k) => k >= 0);
export const Y25 = yIdx((y) => y === 2025), Y26 = yIdx((y) => y === 2026), Y2526 = yIdx((y) => y >= 2025);
// 2026 split in two -- January-March and April-July -- so a 2026 result can
// be checked inside 2026 itself
const monthOf = new Map();
for (let i = 0; i < n2; i++) if (!monthOf.has(TD[i])) monthOf.set(TD[i], new Date(tf.ts[i] + 43200e3).getUTCMonth());
export const Y26a = Y26.filter((k) => monthOf.get(days[k]) < 3), Y26b = Y26.filter((k) => monthOf.get(days[k]) >= 3);
// "ADR used": the day's RTH range so far (08:30-15:00 CT, up to and including
// bar k) against the average full RTH range of the previous 10 sessions (those
// that had one). 0 when there is no history yet. Read at the SIGNAL bar.
const rthHi = new Float64Array(n2).fill(NaN), rthLo = new Float64Array(n2).fill(NaN);
const dayRange = new Map();
{
  let day = -1, h = -Infinity, l = Infinity;
  for (let i = 0; i < n2; i++) {
    if (TD[i] !== day) { if (day !== -1 && h > l) dayRange.set(day, h - l); day = TD[i]; h = -Infinity; l = Infinity; }
    if (CT[i] >= 510 && CT[i] < 900) { if (H[i] > h) h = H[i]; if (L[i] < l) l = L[i]; rthHi[i] = h; rthLo[i] = l; }
  }
  if (h > l) dayRange.set(day, h - l);
}
const tdays = [...new Set(TD)], adrOf = new Map();
for (let j = 1; j < tdays.length; j++) {
  const r = tdays.slice(Math.max(0, j - 10), j).map((d) => dayRange.get(d)).filter((x) => x > 0);
  if (r.length) adrOf.set(tdays[j], r.reduce((a, b) => a + b, 0) / r.length);
}
export const adrUsed = (k) => { const a = adrOf.get(TD[k]); return a ? (rthHi[k] - rthLo[k]) / a : 0; };

// lots: a number, or a sizer (atrAtSignal, ctMin, seq, armBar) -> lots
export function evalOpts(opts, lots = 8, signals = RESC) {
  const tr = S.run(typeof lots === "function" ? lots : () => lots, { signals, ...opts });
  const arr = S.dayArr(tr, days);
  const at = (ix) => S.passArr(ix.map((k) => arr[k]));
  return { tr, arr, n: tr.length, all: S.passArr(arr), h1: S.passArr(arr.slice(0, NH)), h2: S.passArr(arr.slice(NH)),
           y25: at(Y25), y26: at(Y26), r2: at(Y2526), a26: at(Y26a), b26: at(Y26b),
           exp: tr.reduce((a, t) => a + t.pnl, 0) / tr.length };
}
export const evalCfg = (c, signals = RESC) => evalOpts(build(c), c.lots, signals);
