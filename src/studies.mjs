// Indicator studies. ISOMORPHIC.
//
// Indicators added beside the strategy's own, each on a timeframe of its choice,
// drawn on the price pane or in a pane of its own. Any of them can also GATE the
// strategy's entries, so a combination of indicators can be tested without
// writing a strategy:
//
//   { type: "ema", tf: 15, params: { length: 50 }, gate: "with" }
//
// means "only take longs while the close is above the 15-minute EMA 50, and
// shorts while it is below". A study that does not gate still reports how the
// strategy's trades did in each of its states (studyEdge), which is the cheap
// first look at whether a combination is worth gating on at all.
//
// Two rules make the gate trustworthy:
//   1. CAUSAL. A decision at the close of a signal bar sees the study as of the
//      last study bar that had CLOSED by then, never the bar still forming. A
//      15-minute EMA read at 10:04 is the 09:45 bar's. Clock-based, as a live bot
//      builds its bars: a study bar counts once its full span has passed.
//   2. ENTRIES ONLY. A gated signal opens nothing, but it still closes an
//      opposite position and still cancels a working order, so adding a gate never
//      changes how a trade exits. The $1,250 book's 10-minute EMA filter was
//      measured the same way (research/export_bot1250_fixture.mjs).
//
// What a gate compares depends on the study's kind:
//   price  a price level (EMA, SMA, VWAP): the signal bar's close against it.
//   trend  a direction (EMA cross, Supertrend): +1 / -1.
//   band   a channel (Bollinger, Keltner, Donchian, the prior day's range, the
//          opening range): where the signal bar's close sits in it, 0 at the
//          lower edge and 1 at the upper.
//   osc    an oscillator (RSI, stochastic, MACD, CCI, ...): its value against
//          its levels.
//   level  a magnitude with no direction (ADX, ATR, efficiency, choppiness,
//          relative volume): its value against its levels. ADX also carries the
//          direction of its +DI / -DI.

import { ema, sma, atr, adx, rsi, macd, stochastic, cci, roc, zscore, efficiencyRatio, choppiness,
         bollinger, keltner, donchian, supertrend } from "./indicators.mjs";
import { resample } from "./resample.mjs";

const RTH_OPEN = 510, RTH_CLOSE = 900;        // 08:30 and 15:00 CT
const SESSION_OPEN = 1020;                     // 17:00 CT
export const STUDY_TFS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 240];
export const Y2026 = Date.UTC(2026, 0, 1);

// ── param descriptors, in the shape strategies declare them ──
const int = (key, label, def, min, max, hint) => ({ key, label, type: "int", default: def, min, max, step: 1, ...(hint ? { hint } : {}) });
const num = (key, label, def, min, max, step, hint) => ({ key, label, type: "float", default: def, min, max, step, ...(hint ? { hint } : {}) });
const SOURCE = { key: "source", label: "Source", type: "select", default: "close",
                 options: [["close", "Close"], ["open", "Open"], ["hl2", "HL2"], ["hlc3", "HLC3"], ["ohlc4", "OHLC4"]] };
const LO = (def, min, max, step) => num("lo", "Lower level", def, min, max, step);
const HI = (def, min, max, step) => num("hi", "Upper level", def, min, max, step);

function source(b, s) {
  if (!s || s === "close") return b.close;
  const n = b.close.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = b.open[i], h = b.high[i], l = b.low[i], c = b.close[i];
    out[i] = s === "open" ? o : s === "hl2" ? (h + l) / 2 : s === "hlc3" ? (h + l + c) / 3 : (o + h + l + c) / 4;
  }
  return out;
}
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const nanArr = (n) => new Float64Array(n).fill(NaN);

// Session VWAP, reset at the 17:00 CT session open or, anchored to RTH, at 08:30
// CT and blank outside 08:30-15:00. Bands are +-k standard deviations of the
// typical price about it, volume-weighted.
function vwapStudy(b, p) {
  const n = b.close.length, v = nanArr(n), up = nanArr(n), dn = nanArr(n);
  const rth = p.anchor === "rth";
  let pv = 0, vv = 0, pv2 = 0, day = null, on = false;
  for (let i = 0; i < n; i++) {
    const ct = b.ctMin ? b.ctMin[i] : 0;
    if (b.tday[i] !== day) { day = b.tday[i]; on = false; if (!rth) { pv = vv = pv2 = 0; on = true; } }
    if (rth) {
      if (!(ct >= RTH_OPEN && ct < RTH_CLOSE)) continue;
      if (!on) { pv = vv = pv2 = 0; on = true; }
    }
    const tp = (b.high[i] + b.low[i] + b.close[i]) / 3, vol = b.volume[i] > 0 ? b.volume[i] : 0;
    pv += tp * vol; vv += vol; pv2 += tp * tp * vol;
    const m = vv > 0 ? pv / vv : tp;
    v[i] = m;
    if (p.bands > 0) {
      const sd = vv > 0 ? Math.sqrt(Math.max(0, pv2 / vv - m * m)) : 0;
      up[i] = m + p.bands * sd; dn[i] = m - p.bands * sd;
    }
  }
  const lines = [{ name: "VWAP", data: v }];
  if (p.bands > 0) lines.push({ name: `+${p.bands}σ`, data: up, dash: [4, 3] }, { name: `−${p.bands}σ`, data: dn, dash: [4, 3] });
  return { line: v, lines };
}

// The prior RTH session's high, low and close, known once it has closed at 15:00
// CT, and the overnight high and low of the current trading day (17:00 to 08:30
// CT), running while the overnight is still trading.
function dayLevels(b) {
  const n = b.close.length;
  const pdh = nanArr(n), pdl = nanArr(n), pdc = nanArr(n), onh = nanArr(n), onl = nanArr(n);
  let day = null, inRth = false, rH = -Infinity, rL = Infinity, rC = NaN, ph = NaN, pl = NaN, pc = NaN, oh = -Infinity, ol = Infinity;
  for (let i = 0; i < n; i++) {
    const ct = b.ctMin ? b.ctMin[i] : 0;
    if (b.tday[i] !== day) {
      if (inRth) { ph = rH; pl = rL; pc = rC; inRth = false; }   // a session that closed early
      day = b.tday[i]; oh = -Infinity; ol = Infinity;
    }
    if (ct >= RTH_OPEN && ct < RTH_CLOSE) {
      if (!inRth) { inRth = true; rH = -Infinity; rL = Infinity; }
      if (b.high[i] > rH) rH = b.high[i];
      if (b.low[i] < rL) rL = b.low[i];
      rC = b.close[i];
    } else {
      if (inRth) { ph = rH; pl = rL; pc = rC; inRth = false; }
      if (ct >= SESSION_OPEN || ct < RTH_OPEN) {
        if (b.high[i] > oh) oh = b.high[i];
        if (b.low[i] < ol) ol = b.low[i];
      }
    }
    pdh[i] = ph; pdl[i] = pl; pdc[i] = pc;
    if (oh > -Infinity) { onh[i] = oh; onl[i] = ol; }
  }
  return {
    lo: pdl, hi: pdh,
    lines: [{ name: "PDH", data: pdh }, { name: "PDL", data: pdl }, { name: "PDC", data: pdc, dash: [2, 3] },
            { name: "ONH", data: onh, dash: [6, 3], alpha: 0.6 }, { name: "ONL", data: onl, dash: [6, 3], alpha: 0.6 }],
  };
}

// The high and low of the first `minutes` of RTH (bars whose start falls in
// 08:30 to 08:30 + minutes), known once that span is over, and held to 15:00 CT.
function openingRange(b, p) {
  const n = b.close.length, hi = nanArr(n), lo = nanArr(n), mid = nanArr(n);
  const end = RTH_OPEN + p.minutes;
  let day = null, h = -Infinity, l = Infinity;
  for (let i = 0; i < n; i++) {
    const ct = b.ctMin ? b.ctMin[i] : 0;
    if (b.tday[i] !== day) { day = b.tday[i]; h = -Infinity; l = Infinity; }
    if (ct >= RTH_OPEN && ct < end) {
      if (b.high[i] > h) h = b.high[i];
      if (b.low[i] < l) l = b.low[i];
    } else if (ct >= end && ct < RTH_CLOSE && h > -Infinity) {
      hi[i] = h; lo[i] = l; mid[i] = (h + l) / 2;
    }
  }
  return { lo, hi, lines: [{ name: "OR high", data: hi }, { name: "OR low", data: lo }, { name: "mid", data: mid, dash: [2, 3], alpha: 0.6 }] };
}

const valueOnly = (name, v, extra = {}) => ({ value: v, lines: [{ name, data: v }], ...extra });

// ── the catalog ──
// name, group (for the picker), pane, kind, params, label(p), warmup(p) in bars
// of the study's timeframe (and warmupSessions for session-anchored ones), the
// gates it offers, levels(p) for band/osc/level kinds, how its pane is scaled,
// and compute(bars, p).
const BAND_LEVELS = () => ({ lo: 0, hi: 1, mid: 0.5 });
const OSC_GATES = ["with", "against", "nochase", "fade", "above", "below", "inside", "outside"];
const BAND_GATES = ["with", "against", "nochase", "fade", "inside", "outside"];
const LEVEL_GATES = ["above", "below", "inside", "outside"];

export const STUDIES = {
  ema: {
    name: "EMA", group: "Price", pane: "price", kind: "price",
    params: [int("length", "Length", 50, 2, 2000), SOURCE],
    label: (p) => `EMA ${p.length}`, warmup: (p) => 10 * p.length, gates: ["with", "against"],
    compute: (b, p) => { const v = ema(source(b, p.source), p.length); return { line: v, lines: [{ name: `EMA ${p.length}`, data: v }] }; },
  },
  sma: {
    name: "SMA", group: "Price", pane: "price", kind: "price",
    params: [int("length", "Length", 50, 2, 2000), SOURCE],
    label: (p) => `SMA ${p.length}`, warmup: (p) => p.length + 2, gates: ["with", "against"],
    compute: (b, p) => { const v = sma(source(b, p.source), p.length); return { line: v, lines: [{ name: `SMA ${p.length}`, data: v }] }; },
  },
  emacross: {
    name: "EMA cross (fast / slow)", group: "Price", pane: "price", kind: "trend",
    params: [int("fast", "Fast length", 9, 1, 1000), int("slow", "Slow length", 21, 2, 2000)],
    label: (p) => `EMA ${p.fast}/${p.slow}`, warmup: (p) => 10 * Math.max(p.fast, p.slow), gates: ["with", "against"],
    terms: { with: "Longs while fast > slow, shorts while fast < slow", against: "Longs while fast < slow, shorts while fast > slow" },
    compute: (b, p) => {
      const f = ema(b.close, p.fast), s = ema(b.close, p.slow), n = f.length, dir = new Int8Array(n), d = new Float64Array(n);
      for (let i = 0; i < n; i++) { d[i] = f[i] - s[i]; dir[i] = sign(d[i]); }
      return { dir, value: d, lines: [{ name: `EMA ${p.fast}`, data: f }, { name: `EMA ${p.slow}`, data: s, dash: [5, 3] }] };
    },
  },
  vwap: {
    name: "VWAP", group: "Price", pane: "price", kind: "price",
    params: [{ key: "anchor", label: "Resets", type: "select", default: "session", options: [["session", "At the 17:00 CT session open"], ["rth", "At 08:30 CT (RTH only)"]] },
             num("bands", "Bands (± std devs, 0 = off)", 0, 0, 4, 0.5)],
    label: (p) => `VWAP${p.anchor === "rth" ? " RTH" : ""}`, warmup: () => 0, warmupSessions: () => 2, gates: ["with", "against"],
    compute: vwapStudy,
  },
  bollinger: {
    name: "Bollinger Bands", group: "Bands & levels", pane: "price", kind: "band",
    params: [int("length", "Length", 20, 2, 500), num("mult", "Std devs", 2, 0.5, 5, 0.1)],
    label: (p) => `BB ${p.length}, ${p.mult}`, warmup: (p) => p.length + 2, gates: BAND_GATES, levels: BAND_LEVELS,
    terms: { mid: "the middle", hi: "the upper band", lo: "the lower band" },
    compute: (b, p) => {
      const r = bollinger(b.close, p.length, p.mult);
      return { lo: r.lower, hi: r.upper, lines: [{ name: "mid", data: r.mid }, { name: "upper", data: r.upper, dash: [4, 3] }, { name: "lower", data: r.lower, dash: [4, 3] }] };
    },
  },
  keltner: {
    name: "Keltner Channel", group: "Bands & levels", pane: "price", kind: "band",
    params: [int("length", "EMA length", 20, 2, 500), num("mult", "ATR multiple", 2, 0.25, 6, 0.25), int("atrLength", "ATR length", 14, 2, 200)],
    label: (p) => `KC ${p.length}, ${p.mult}`, warmup: (p) => 10 * Math.max(p.length, p.atrLength), gates: BAND_GATES, levels: BAND_LEVELS,
    terms: { mid: "the middle", hi: "the upper band", lo: "the lower band" },
    compute: (b, p) => {
      const r = keltner(b.high, b.low, b.close, p.length, p.mult, p.atrLength);
      return { lo: r.lower, hi: r.upper, lines: [{ name: "mid", data: r.mid }, { name: "upper", data: r.upper, dash: [4, 3] }, { name: "lower", data: r.lower, dash: [4, 3] }] };
    },
  },
  donchian: {
    name: "Donchian Channel", group: "Bands & levels", pane: "price", kind: "band",
    params: [int("length", "Length", 20, 2, 1000)],
    label: (p) => `DC ${p.length}`, warmup: (p) => p.length + 2, gates: BAND_GATES, levels: BAND_LEVELS,
    terms: { mid: "the channel's middle", hi: "the channel high", lo: "the channel low" },
    compute: (b, p) => {
      // the bars BEFORE each one, as the breakout books use it
      const { high, low } = donchian(b.high, b.low, p.length), n = high.length, mid = new Float64Array(n);
      for (let i = 0; i < n; i++) mid[i] = (high[i] + low[i]) / 2;
      return { lo: low, hi: high, lines: [{ name: "high", data: high }, { name: "low", data: low }, { name: "mid", data: mid, dash: [2, 3], alpha: 0.6 }] };
    },
  },
  supertrend: {
    name: "Supertrend", group: "Price", pane: "price", kind: "trend",
    params: [int("period", "ATR period", 10, 2, 200), num("mult", "ATR multiple", 3, 0.5, 10, 0.25)],
    label: (p) => `Supertrend ${p.period}, ${p.mult}`, warmup: (p) => 10 * p.period, gates: ["with", "against"],
    terms: { with: "Longs in its uptrend, shorts in its downtrend", against: "Longs in its downtrend, shorts in its uptrend" },
    compute: (b, p) => {
      const r = supertrend(b.high, b.low, b.close, p.period, p.mult), n = r.trend.length, up = nanArr(n), dn = nanArr(n);
      for (let i = 0; i < n; i++) { if (r.trend[i] === 1) up[i] = r.lower[i]; else dn[i] = r.upper[i]; }
      return { dir: r.trend, lines: [{ name: "up", data: up, color: "#26a69a" }, { name: "down", data: dn, color: "#ef5350" }] };
    },
  },
  daylevels: {
    name: "Prior day & overnight levels", group: "Bands & levels", pane: "price", kind: "band",
    params: [],
    label: () => "Day levels", warmup: () => 0, warmupSessions: () => 3, gates: BAND_GATES, levels: BAND_LEVELS,
    terms: { mid: "the prior day's midpoint", hi: "the prior day's high", lo: "the prior day's low" },
    hint: "Prior RTH session (08:30-15:00 CT) high, low and close; overnight high and low (17:00-08:30 CT). Gates and edge read where the close sits in the prior day's range.",
    compute: dayLevels,
  },
  openrange: {
    name: "Opening range", group: "Bands & levels", pane: "price", kind: "band",
    params: [int("minutes", "Minutes from 08:30 CT", 15, 1, 240)],
    label: (p) => `OR ${p.minutes}m`, warmup: () => 0, warmupSessions: () => 2, gates: BAND_GATES, levels: BAND_LEVELS,
    terms: { mid: "the range's middle", hi: "the opening-range high", lo: "the opening-range low" },
    hint: "Built from the study's bars that start in the opening span, so a span that is not a multiple of the timeframe takes the whole last bar.",
    compute: openingRange,
  },
  rsi: {
    name: "RSI", group: "Oscillators", pane: "sub", kind: "osc",
    params: [int("length", "Length", 14, 2, 200), LO(30, 0, 100, 1), HI(70, 0, 100, 1)],
    label: (p) => `RSI ${p.length}`, warmup: (p) => 20 * p.length, gates: OSC_GATES,
    levels: (p) => ({ lo: p.lo, hi: p.hi, mid: 50 }), range: [0, 100],
    compute: (b, p) => valueOnly(`RSI ${p.length}`, rsi(b.close, p.length)),
  },
  stoch: {
    name: "Stochastic", group: "Oscillators", pane: "sub", kind: "osc",
    params: [int("k", "%K length", 14, 2, 200), int("d", "%D smoothing", 3, 1, 50), LO(20, 0, 100, 1), HI(80, 0, 100, 1)],
    label: (p) => `Stoch ${p.k}, ${p.d}`, warmup: (p) => p.k + p.d + 2, gates: OSC_GATES,
    levels: (p) => ({ lo: p.lo, hi: p.hi, mid: 50 }), range: [0, 100],
    compute: (b, p) => { const r = stochastic(b.high, b.low, b.close, p.k, p.d); return { value: r.k, lines: [{ name: "%K", data: r.k }, { name: "%D", data: r.d, dash: [4, 3] }] }; },
  },
  macd: {
    name: "MACD", group: "Oscillators", pane: "sub", kind: "osc",
    params: [int("fast", "Fast", 12, 2, 500), int("slow", "Slow", 26, 3, 1000), int("signal", "Signal", 9, 2, 200)],
    label: (p) => `MACD ${p.fast}, ${p.slow}, ${p.signal}`, warmup: (p) => 10 * (Math.max(p.fast, p.slow) + p.signal), gates: ["with", "against"],
    levels: () => ({ lo: 0, hi: 0, mid: 0 }), auto: "sym",
    terms: { with: "Longs while the histogram is above 0, shorts while below", against: "Longs while the histogram is below 0, shorts while above" },
    compute: (b, p) => {
      const r = macd(b.close, p.fast, p.slow, p.signal);
      return { value: r.hist, lines: [{ name: "hist", data: r.hist, kind: "hist" }, { name: "MACD", data: r.line }, { name: "signal", data: r.signal, dash: [4, 3] }] };
    },
  },
  cci: {
    name: "CCI", group: "Oscillators", pane: "sub", kind: "osc",
    params: [int("length", "Length", 20, 2, 200), LO(-100, -500, 500, 5), HI(100, -500, 500, 5)],
    label: (p) => `CCI ${p.length}`, warmup: (p) => p.length + 2, gates: OSC_GATES,
    levels: (p) => ({ lo: p.lo, hi: p.hi, mid: 0 }), auto: "sym",
    compute: (b, p) => valueOnly(`CCI ${p.length}`, cci(b.high, b.low, b.close, p.length)),
  },
  roc: {
    name: "Rate of change (%)", group: "Oscillators", pane: "sub", kind: "osc",
    params: [int("length", "Length", 10, 1, 500), LO(-0.2, -10, 10, 0.05), HI(0.2, -10, 10, 0.05)],
    label: (p) => `ROC ${p.length}`, warmup: (p) => p.length + 2, gates: OSC_GATES,
    levels: (p) => ({ lo: p.lo, hi: p.hi, mid: 0 }), auto: "sym",
    compute: (b, p) => valueOnly(`ROC ${p.length}`, roc(b.close, p.length)),
  },
  zscore: {
    name: "Z-score of close", group: "Oscillators", pane: "sub", kind: "osc",
    params: [int("length", "Length", 20, 2, 1000), LO(-2, -6, 6, 0.1), HI(2, -6, 6, 0.1)],
    label: (p) => `Z ${p.length}`, warmup: (p) => p.length + 2, gates: OSC_GATES,
    levels: (p) => ({ lo: p.lo, hi: p.hi, mid: 0 }), auto: "sym",
    compute: (b, p) => valueOnly(`Z ${p.length}`, zscore(b.close, p.length)),
  },
  adx: {
    name: "ADX / DMI", group: "Regime & volatility", pane: "sub", kind: "level",
    params: [int("period", "Period", 14, 2, 200), LO(25, 0, 100, 1), HI(50, 0, 100, 1)],
    label: (p) => `ADX ${p.period}`, warmup: (p) => 10 * p.period, gates: [...LEVEL_GATES, "with", "against"],
    levels: (p) => ({ lo: p.lo, hi: p.hi }), auto: "minmax",
    terms: { with: "Longs while +DI > −DI, shorts while −DI > +DI", against: "Longs while −DI > +DI, shorts while +DI > −DI" },
    compute: (b, p) => {
      const r = adx(b.high, b.low, b.close, p.period), n = r.adx.length, dir = new Int8Array(n);
      for (let i = 0; i < n; i++) dir[i] = sign(r.pdi[i] - r.ndi[i]);
      return { value: r.adx, dir, lines: [{ name: "ADX", data: r.adx }, { name: "+DI", data: r.pdi, dash: [3, 3], color: "#26a69a" }, { name: "−DI", data: r.ndi, dash: [3, 3], color: "#ef5350" }] };
    },
  },
  atr: {
    name: "ATR (points)", group: "Regime & volatility", pane: "sub", kind: "level",
    params: [int("period", "Period", 14, 2, 500), LO(5, 0, 500, 0.5), HI(40, 0, 500, 0.5)],
    label: (p) => `ATR ${p.period}`, warmup: (p) => 10 * p.period, gates: LEVEL_GATES,
    levels: (p) => ({ lo: p.lo, hi: p.hi }), auto: "minmax",
    compute: (b, p) => valueOnly(`ATR ${p.period}`, atr(b.high, b.low, b.close, p.period)),
  },
  efficiency: {
    name: "Efficiency ratio", group: "Regime & volatility", pane: "sub", kind: "level",
    params: [int("length", "Length", 20, 2, 500), LO(0.3, 0, 1, 0.05), HI(0.6, 0, 1, 0.05)],
    label: (p) => `Efficiency ${p.length}`, warmup: (p) => p.length + 2, gates: LEVEL_GATES,
    levels: (p) => ({ lo: p.lo, hi: p.hi }), range: [0, 1],
    hint: "Kaufman: net move over the path travelled. 1 is a straight line, 0 pure chop.",
    compute: (b, p) => valueOnly(`ER ${p.length}`, efficiencyRatio(b.close, p.length)),
  },
  chop: {
    name: "Choppiness", group: "Regime & volatility", pane: "sub", kind: "level",
    params: [int("length", "Length", 14, 2, 200), LO(38.2, 0, 100, 0.5), HI(61.8, 0, 100, 0.5)],
    label: (p) => `Chop ${p.length}`, warmup: (p) => p.length + 2, gates: LEVEL_GATES,
    levels: (p) => ({ lo: p.lo, hi: p.hi }), range: [0, 100],
    compute: (b, p) => valueOnly(`Chop ${p.length}`, choppiness(b.high, b.low, b.close, p.length)),
  },
  relvol: {
    name: "Relative volume", group: "Regime & volatility", pane: "sub", kind: "level",
    params: [int("length", "Average over (bars)", 20, 2, 2000), LO(1.5, 0, 20, 0.1), HI(3, 0, 20, 0.1)],
    label: (p) => `RelVol ${p.length}`, warmup: (p) => p.length + 2, gates: LEVEL_GATES,
    levels: (p) => ({ lo: p.lo, hi: p.hi }), auto: "minmax",
    hint: "The bar's volume over its average, the bar itself included.",
    compute: (b, p) => {
      const avg = sma(b.volume, p.length), n = avg.length, v = nanArr(n);
      for (let i = 0; i < n; i++) if (avg[i] > 0) v[i] = b.volume[i] / avg[i];
      return valueOnly(`RelVol ${p.length}`, v);
    },
  },
};

// ── gates ──
// The wording follows the study: "the upper band" for Bollinger, "the prior
// day's high" for the day levels, the numbers themselves for an oscillator.
export function gateLabel(type, mode, p = {}) {
  const S = STUDIES[type];
  if (!S || mode === "off") return "Off — draw only";
  if (S.terms && S.terms[mode]) return S.terms[mode];
  const lv = S.levels ? S.levels(p) : {};
  if (S.kind === "price") return mode === "with" ? "Longs above it, shorts below" : "Longs below it, shorts above";
  if (S.kind === "band") {
    const t = S.terms;
    return {
      with: `Longs above ${t.mid}, shorts below`, against: `Longs below ${t.mid}, shorts above`,
      nochase: `Longs only under ${t.hi}, shorts only over ${t.lo}`, fade: `Longs only under ${t.lo}, shorts only over ${t.hi}`,
      inside: `Either side, only between ${t.lo} and ${t.hi}`, outside: `Either side, only beyond ${t.lo} or ${t.hi}`,
    }[mode];
  }
  return {
    with: `Longs above ${lv.mid}, shorts below`, against: `Longs below ${lv.mid}, shorts above`,
    nochase: `Longs only under ${lv.hi}, shorts only over ${lv.lo}`, fade: `Longs only under ${lv.lo}, shorts only over ${lv.hi}`,
    above: `Either side, only at ${lv.lo} or more`, below: `Either side, only at ${lv.hi} or less`,
    inside: `Either side, only from ${lv.lo} to ${lv.hi}`, outside: `Either side, only under ${lv.lo} or over ${lv.hi}`,
  }[mode] || mode;
}

// ── resolution: a study as given (by the page, a URL or a tool) -> a whole one ──
export function resolveStudy(st, { strict = false } = {}) {
  if (!st || typeof st !== "object" || Array.isArray(st)) throw new Error("a study must be an object like {type, tf, params, gate}");
  const S = STUDIES[st.type];
  if (!S) throw new Error(`unknown study type "${st.type}"; one of ${Object.keys(STUDIES).join(", ")}`);
  if (strict) {
    // label and gateText are what the chart reports a study as; passing one back is fine
    const bad = Object.keys(st).filter((k) => !["id", "type", "tf", "params", "gate", "color", "hidden", "label", "gateText"].includes(k));
    if (bad.length) throw new Error(`unknown study key${bad.length > 1 ? "s" : ""} ${bad.join(", ")}; a study takes type, tf, params, gate`);
  }
  const tf = st.tf == null || st.tf === "" ? 0 : Math.trunc(Number(st.tf));
  if (!(tf === 0 || STUDY_TFS.includes(tf))) throw new Error(`${st.type}: timeframe ${st.tf} is not one of 0 (the signal's), ${STUDY_TFS.join(", ")}`);
  const params = {};
  for (const d of S.params) params[d.key] = d.default;
  for (const [k, raw] of Object.entries(st.params || {})) {
    const d = S.params.find((x) => x.key === k);
    if (!d) {
      if (strict) throw new Error(`unknown ${st.type} param "${k}"; valid: ${S.params.map((x) => x.key).join(", ") || "none"}`);
      continue;
    }
    if (d.type === "select") {
      if (!d.options.some((o) => o[0] === raw)) throw new Error(`${st.type}.${k}: "${raw}" is not one of ${d.options.map((o) => o[0]).join(", ")}`);
      params[k] = raw;
      continue;
    }
    const x = Number(raw);
    if (!Number.isFinite(x)) throw new Error(`${st.type}.${k} must be a number`);
    if (strict && (x < d.min || x > d.max)) throw new Error(`${st.type}.${k} = ${x} is outside ${d.min}..${d.max}`);
    params[k] = Math.min(d.max, Math.max(d.min, d.type === "int" ? Math.round(x) : x));
  }
  const gate = st.gate == null || st.gate === "" ? "off" : String(st.gate);
  if (gate !== "off" && !S.gates.includes(gate)) throw new Error(`${st.type} gate "${gate}" is not one of off, ${S.gates.join(", ")}`);
  const out = { type: st.type, tf, params, gate };
  if (st.id != null) out.id = String(st.id);
  if (typeof st.color === "string" && /^#[0-9a-f]{6}$/i.test(st.color)) out.color = st.color;
  if (st.hidden) out.hidden = true;
  return out;
}
export const resolveStudies = (list, opts) => {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error("studies must be an array");
  return list.map((s) => resolveStudy(s, opts));
};
export const studyLabel = (st) => `${STUDIES[st.type].label(st.params)}${st.tf ? ` · ${st.tf}m` : ""}`;
export const isGating = (st) => !!st && !!st.gate && st.gate !== "off";
// What changes the trades: only gating studies, and only these fields of them.
export const gateKey = (studies) => (studies || []).filter(isGating).map((s) => [s.type, s.tf, s.params, s.gate]);

// How far back a study needs data before the window, in minutes, on the signal
// timeframe `sigTf` -- src/window.mjs's rule: bars padded 1.5x for gaps, plus 3
// days; sessions as calendar days, 7/5 for weekends plus 4 for holidays.
export function studyWarmupMin(st, sigTf = 1) {
  const S = STUDIES[st.type], p = st.params, tf = st.tf || sigTf;
  const bars = S.warmup ? S.warmup(p) : 0, sessions = S.warmupSessions ? S.warmupSessions(p) : 0;
  const byBars = bars > 0 ? Math.ceil(bars * tf * 1.5) + 3 * 1440 : 0;
  const bySessions = sessions > 0 ? Math.ceil((sessions * 7) / 5 + 4) * 1440 : 0;
  return Math.max(byBars, bySessions);
}

// ── computing, cached per bar set ──
// A bar set (the full history on the server, the window blob in the page) keys
// a small cache of its resamples and of the studies computed on them.
const CACHE = new WeakMap();
function memo(bars, key, make) {
  let m = CACHE.get(bars);
  if (!m) CACHE.set(bars, (m = new Map()));
  if (m.has(key)) { const v = m.get(key); m.delete(key); m.set(key, v); return v; }
  const v = make();
  m.set(key, v);
  while (m.size > 32) m.delete(m.keys().next().value);
  return v;
}
export const studyBars = (bars1m, tf) => memo(bars1m, `bars:${tf}`, () => resample(bars1m, tf));

// One study on its own bars: { bars, out }. `sigBars` are reused as the study's
// bars when the timeframes match, so a same-timeframe study is read bar for bar.
export function computeStudy(bars1m, st, sigTf = 1, sigBars = null) {
  const tf = st.tf || sigTf;
  const b = sigBars && (sigBars.tfMin || 1) === tf ? sigBars : studyBars(bars1m, tf);
  const out = memo(b, `study:${st.type}:${JSON.stringify(st.params)}`, () => STUDIES[st.type].compute(b, st.params));
  return { bars: b, out, tf };
}

// For each signal bar, the last study bar that had closed by the time it did
// (-1 before the first). A bar opening at ts with timeframe T closes at ts + T.
export function closedIndexMap(sigBars, stBars) {
  const sMs = (sigBars.tfMin || 1) * 60000, tMs = (stBars.tfMin || 1) * 60000;
  const n = sigBars.ts.length, m = stBars.ts.length, out = new Int32Array(n);
  let j = -1;
  for (let k = 0; k < n; k++) {
    const closeK = sigBars.ts[k] + sMs;
    while (j + 1 < m && stBars.ts[j + 1] + tMs <= closeK) j++;
    out[k] = j;
  }
  return out;
}

// A study's reading at every signal bar -- what a decision at that bar's close
// could know. `v` is the value the gate compares (an oscillator's value, a
// position in a band, a price level), `dir` a direction where the kind has one.
export function studyOnSignal(bars1m, sigBars, st) {
  const S = STUDIES[st.type];
  const { bars: b, out } = computeStudy(bars1m, st, sigBars.tfMin || 1, sigBars);
  const n = sigBars.close.length, C = sigBars.close;
  const map = b === sigBars ? null : closedIndexMap(sigBars, b);
  const v = new Float64Array(n).fill(NaN), dir = new Int8Array(n);
  for (let k = 0; k < n; k++) {
    const j = map ? map[k] : k;
    if (j < 0) continue;
    if (S.kind === "price") {
      const x = out.line[j];
      v[k] = x;
      if (Number.isFinite(x)) dir[k] = sign(C[k] - x);
    } else if (S.kind === "band") {
      const lo = out.lo[j], hi = out.hi[j];
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) v[k] = (C[k] - lo) / (hi - lo);
    } else {
      if (out.value) v[k] = out.value[j];
      if (out.dir) { dir[k] = out.dir[j]; if (!out.value) v[k] = out.dir[j]; }
    }
  }
  return { st, S, v, dir, hasDir: S.kind === "price" || !!out.dir, levels: S.levels ? S.levels(st.params) : null };
}

// Whether an entry of direction d may open on signal bar k. An indicator that is
// not yet warm (NaN, or no direction) fails every gate.
export function gatePasses(r, k, d) {
  const mode = r.st.gate, kind = r.S.kind, v = r.v[k], L = r.levels;
  if (mode === "off") return true;
  if (mode === "with" || mode === "against") {
    const want = mode === "with" ? d : -d;
    if (kind === "osc" || kind === "band") return Number.isFinite(v) && (want === 1 ? v > L.mid : v < L.mid);
    return r.dir[k] === want;
  }
  if (!Number.isFinite(v)) return false;
  switch (mode) {
    case "nochase": return d === 1 ? v < L.hi : v > L.lo;
    case "fade": return d === 1 ? v < L.lo : v > L.hi;
    case "above": return v >= L.lo;
    case "below": return v <= L.hi;
    case "inside": return v >= L.lo && v <= L.hi;
    case "outside": return v < L.lo || v > L.hi;
    default: return false;
  }
}

// Every gating study at once, over the signal bars: (k, d) -> true to allow.
export function buildEntryGate(bars1m, sigBars, studies) {
  const rs = (studies || []).filter(isGating).map((st) => studyOnSignal(bars1m, sigBars, st));
  if (!rs.length) return null;
  return (k, d) => { for (const r of rs) if (!gatePasses(r, k, d)) return false; return true; };
}

// ── edge: the strategy's trades split by the study's state at their signal ──
// The state is read at the signal bar (the bar whose close decided the entry),
// exactly as a gate would read it, so a bucket's numbers are what gating on it
// would have kept, before any knock-on effect on the trades that follow.
function acc() { return { trades: 0, net: 0, wins: 0, gw: 0, gl: 0 }; }
function add(a, pnl) { a.trades++; a.net += pnl; if (pnl > 0) { a.wins++; a.gw += pnl; } else a.gl -= pnl; }
const fin = (a) => ({ trades: a.trades, net: Math.round(a.net), winRate: a.trades ? Math.round((a.wins / a.trades) * 1000) / 10 : null,
                      profitFactor: a.gl > 0 ? Math.round((a.gw / a.gl) * 1000) / 1000 : a.gw > 0 ? null : 0 });
const fmt = (x) => (Number.isInteger(x) || Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : +x.toPrecision(3) + "");

export function studyEdge(trades, reading, { split = Y2026 } = {}) {
  const r = reading, kind = r.S.kind, L = r.levels;
  const tables = [];
  const table = (title, keys, labels, keyOf) => {
    const all = keys.map(() => acc()), y = keys.map(() => acc());
    let unread = 0;
    for (const t of trades) {
      const k = t.sigIdx;
      const b = k == null || k < 0 ? -1 : keyOf(k, t.dir);
      if (b < 0) { unread++; continue; }
      add(all[b], t.pnl);
      if (t.entryTime >= split) add(y[b], t.pnl);
    }
    tables.push({ title, rows: keys.map((key, i) => ({ key, label: labels[i], all: fin(all[i]), y2026: fin(y[i]) })), unread });
  };
  const withAgainst = (title, fn) => table(title, ["with", "against"], ["with", "against"], (k, d) => { const s = fn(k); return s === d ? 0 : s === -d ? 1 : -1; });

  if (kind === "price") withAgainst("Close vs the line at the signal (with = long above, short below)", (k) => r.dir[k]);
  if (kind === "trend" || (kind === "level" && r.hasDir)) {
    withAgainst(kind === "trend" ? "Its direction at the signal" : "+DI vs −DI at the signal", (k) => r.dir[k]);
  }
  if ((kind === "osc" && L.lo !== L.hi) || kind === "band") {
    // Four zones, by side: a short mirrors a long (over the upper level is to a
    // short what under the lower is to a long).
    const t = r.S.terms;
    const lo = kind === "band" ? t.lo : fmt(L.lo), hi = kind === "band" ? t.hi : fmt(L.hi), mid = kind === "band" ? t.mid : fmt(L.mid);
    const labels = kind === "band"
      ? [`long under ${lo} · short over ${hi}`, `long between ${lo} and ${mid} · short between ${mid} and ${hi}`,
         `long between ${mid} and ${hi} · short between ${lo} and ${mid}`, `long over ${hi} · short under ${lo}`]
      : [`long < ${lo} · short > ${hi}`, `long ${lo}–${mid} · short ${mid}–${hi}`, `long ${mid}–${hi} · short ${lo}–${mid}`, `long > ${hi} · short < ${lo}`];
    table("By zone at the signal: fading an extreme → chasing one", ["fade", "against", "with", "chase"], labels, (k, d) => {
      const v = r.v[k];
      if (!Number.isFinite(v)) return -1;
      if (d === 1) return v < L.lo ? 0 : v < L.mid ? 1 : v <= L.hi ? 2 : 3;
      return v > L.hi ? 0 : v > L.mid ? 1 : v >= L.lo ? 2 : 3;
    });
  } else if (kind === "osc") {
    table("Side of zero at the signal", ["with", "against"], ["with (long above 0, short below)", "against"], (k, d) => {
      const v = r.v[k];
      if (!Number.isFinite(v) || v === L.mid) return -1;
      return (v > L.mid) === (d === 1) ? 0 : 1;
    });
  }
  if (kind === "level") {
    // Quintiles of the value over these trades' signals.
    const vals = [];
    for (const t of trades) { const v = t.sigIdx >= 0 ? r.v[t.sigIdx] : NaN; if (Number.isFinite(v)) vals.push(v); }
    vals.sort((a, b) => a - b);
    if (vals.length >= 10) {
      const cut = [0.2, 0.4, 0.6, 0.8].map((q) => vals[Math.floor(q * (vals.length - 1))]);
      const edges = [vals[0], ...cut, vals[vals.length - 1]];
      const labels = [0, 1, 2, 3, 4].map((i) => `Q${i + 1}  ${fmt(edges[i])}–${fmt(edges[i + 1])}`);
      table("Quintiles of its value at the signal (Q1 lowest)", ["q1", "q2", "q3", "q4", "q5"], labels, (k) => {
        const v = r.v[k];
        if (!Number.isFinite(v)) return -1;
        let q = 0;
        while (q < 4 && v > cut[q]) q++;
        return q;
      });
    }
  }
  return { label: studyLabel(r.st), type: r.st.type, gate: r.st.gate, tables };
}
