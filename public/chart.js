// Canvas chart engine — four stacked panes sharing one x-axis in BAR INDEX
// space (not time), so weekend and holiday gaps don't leave dead air.
//
// Two canvases on purpose: the expensive one (candles, trades, equity) redraws
// only when the view or data changes, while the crosshair lives on a transparent
// overlay that redraws on mousemove. Repainting 30k candles at pointer rate is
// the classic way these things end up feeling sluggish.

import { graphicsPrims, plotPrims, paintPrim, overlaps, fontOf } from "/tradovate/mock/draw.mjs";
import { fmtCt, lowerBound, upperBound, nthSmallest, Y2026, autoCandle } from "/ui.mjs";

const CSS = {
  bg: "#0b0f14",
  grid: "#18202b",
  gridStrong: "#232e3d",
  text: "#7d8ea3",
  textBright: "#c9d6e3",
  bull: "#26a69a",
  bear: "#ef5350",
  equity: "#4aa3ff",
  floor: "#ef5350",
  target: "#26a69a",
  skip: "#4a5666",
  lock: "#c9a227",
  session: "#d8b13a",
  crosshair: "#5a6b7d",
};

// How each kind of trade is drawn on the price pane.
const TRADE_KINDS = [
  { is: (t) => !t.taken, color: CSS.skip, width: 1, alpha: 1, dash: [2, 3], r: 4, end: false },
  { is: (t) => t.taken && t.pnl > 0, color: CSS.bull, width: 1.6, alpha: 0.85, dash: [], r: 5.5, end: true },
  { is: (t) => t.taken && !(t.pnl > 0), color: CSS.bear, width: 1.6, alpha: 0.85, dash: [], r: 5.5, end: true },
];

const PANE_WEIGHTS = { price: 0.46, sub: 0.12, equity: 0.27, daily: 0.15 };
// Each oscillator study added beside the strategy gets a pane of its own.
const STUDY_PANE_WEIGHT = 0.11;
const PAD = { l: 8, r: 74, t: 8, b: 22 };
const AXIS_H = 20;

const fmtUsd = (v, dp = 0) =>
  (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtPx = (v) => v.toFixed(2);
// An indicator reading: prices to the tick, small numbers to 3 significant figures.
const fmtVal = (v) => (Math.abs(v) >= 1000 ? v.toFixed(2) : Math.abs(v) >= 10 ? v.toFixed(1) : String(+v.toPrecision(3)));

const TF_NAME = { 1: "1m", 60: "1h", 120: "2h", 240: "4h", 1440: "1d" };
// Says what the candles ARE, and flags the case where the requested size could
// not be drawn -- silently showing a different aggregation than the one picked
// is the sort of thing that gets read off a chart and quoted later.
// The candle size and the SIGNAL timeframe are different things and the chart
// has to say so. Drawing 15-minute candles under a MACD still computed on
// 2-minute bars looks exactly like an indicator that failed to follow the
// dropdown, so whenever the two diverge the label names both.
function tfNote(want, applied, signalTf, auto) {
  const sig = signalTf > 1 ? signalTf : 0;
  let s = "";
  if (want && (want !== 1 || auto)) {
    const nm = TF_NAME[want] || want + "m";
    s = applied === want ? "  ·  " + nm + " candles" + (auto ? " (auto)" : "")
                         : "  ·  " + nm + " too dense here — zoom in";
  }
  // Only worth saying when they actually differ; when they match, the candle
  // note already covers it.
  if (sig && sig !== (applied || want || 1)) {
    const sn = TF_NAME[sig] || sig + "m";
    s += (s ? "  ·  " : "  ·  ") + "signals & indicators on " + sn;
  }
  return s;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export class ChartView {
  constructor(container) {
    this.el = container;
    this.base = document.createElement("canvas");
    this.over = document.createElement("canvas");
    this.base.className = "chart-canvas";
    this.over.className = "chart-canvas chart-overlay";
    container.appendChild(this.base);
    container.appendChild(this.over);
    this.bctx = this.base.getContext("2d");
    this.octx = this.over.getContext("2d");

    this.data = null;
    this.i0 = 0;
    this.i1 = 1;
    this.hover = null;
    this.hoverTrade = null;
    this.onHoverTrade = null;
    this.hoverSignal = null;     // a signal marker under the pointer (its bar k)
    this.onHoverSignal = null;
    // A click on a trade, a signal marker, or nothing: ({trade} | {signal} | null)
    this.onClick = null;
    this._raf = 0;

    this._bindEvents();
    this.resize();
    new ResizeObserver(() => { this.resize(); this.requestDraw(); }).observe(container);
  }

  // ── layout ──
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    for (const c of [this.base, this.over]) {
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      c.style.width = w + "px";
      c.style.height = h + "px";
    }
    this.bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
    this._layout();
  }

  // ── per-pane vertical zoom ──
  // Each pane keeps its own {z, c}: z is the zoom factor and c is where the
  // centre of the view sits as a fraction of the pane's NATURAL range. Storing
  // it that way rather than as absolute prices means a pane stays where you put
  // it when the data underneath changes — move the window slider and a zoomed
  // indicator keeps its magnification instead of jumping.
  _yState(key) {
    if (!this._yv) this._yv = {};
    if (!this._yv[key]) this._yv[key] = { z: 1, c: 0.5 };
    return this._yv[key];
  }

  // Natural range in, effective range and mapper out. Every pane goes through
  // this, so they all zoom by the same rule and none can drift apart.
  _yFor(key, lo, hi, P) {
    if (!this._yNat) this._yNat = {};
    this._yNat[key] = [lo, hi];
    const v = this._yState(key);
    const span = (hi - lo) || 1;
    const half = span / (2 * v.z);
    const mid = lo + v.c * span;
    const a = mid - half, b = mid + half;
    return { lo: a, hi: b, y: (t) => P.bottom - ((t - a) / (b - a)) * P.height };
  }

  yZoomed(key) { const v = this._yState(key); return v.z !== 1 || v.c !== 0.5; }

  resetY(key) {
    if (key) this._yv[key] = { z: 1, c: 0.5 };
    else this._yv = {};
    this.requestDraw();
  }

  // Which pane a pixel row belongs to.
  _paneAt(my) {
    if (!this.panes) return null;
    for (const k of this.paneOrder || ["price", "sub", "equity", "daily"]) {
      const P = this.panes[k];
      if (P && P.height > 0 && my >= P.top && my <= P.bottom) return k;
    }
    return null;
  }

  // Zoom a pane's vertical axis about the value currently under the cursor, so
  // whatever you point at stays put.
  zoomY(key, my, k) {
    const P = this.panes[key];
    const nat = this._yNat && this._yNat[key];
    if (!P || !nat || P.height <= 0) return;
    const [lo, hi] = nat;
    const span = (hi - lo) || 1;
    const v = this._yState(key);
    const half = span / (2 * v.z);
    const mid = lo + v.c * span;
    const a = mid - half, b = mid + half;
    const frac = (P.bottom - my) / P.height;          // 0 at the bottom edge
    const val = a + frac * (b - a);                   // value under the cursor
    const z2 = Math.max(1, Math.min(200, v.z / k));   // never below natural fit
    const half2 = span / (2 * z2);
    const mid2 = val + (0.5 - frac) * 2 * half2;      // keep `val` at `frac`
    v.z = z2;
    v.c = (mid2 - lo) / span;
    this.requestDraw();
  }

  panY(key, dy) {
    const P = this.panes[key];
    const nat = this._yNat && this._yNat[key];
    if (!P || !nat || P.height <= 0) return;
    const v = this._yState(key);
    // dy is in pixels; one pane height is one full effective range.
    v.c += (dy / P.height) / v.z;
    this.requestDraw();
  }

  // Panes top to bottom: price, the strategy's own indicator pane when it has
  // one, a pane per oscillator study, equity, daily. Weights are shares of the
  // height, renormalised when studies add panes.
  _studyPanes() {
    const d = this.data;
    return d && d.studyOverlays ? d.studyOverlays.filter((o) => o.pane === "sub" && !o.hidden) : [];
  }
  _layout() {
    const showSub = !!(this.data && this.data.subOverlays && this.data.subOverlays.length);
    const weights = { ...PANE_WEIGHTS };
    if (!showSub) { weights.price += weights.sub; weights.sub = 0; }
    const studies = this._studyPanes();
    for (const o of studies) weights[o.key] = STUDY_PANE_WEIGHT;
    // With `focus` the chart is the price and an indicator's panes, nothing else.
    const book = this.data && this.data.focus ? [] : ["equity", "daily"];
    const order = ["price", ...(showSub ? ["sub"] : []), ...studies.map((o) => o.key), ...book];
    const total = order.reduce((s, k) => s + weights[k], 0);

    const usable = this.h - PAD.t - PAD.b - AXIS_H;
    let y = PAD.t;
    this.panes = {};
    for (const k of order) {
      const ph = Math.round((usable * weights[k]) / total);
      this.panes[k] = { top: y, height: ph, bottom: y + ph };
      y += ph + (ph > 0 ? 6 : 0);
    }
    for (const k of ["sub", "equity", "daily"]) if (!this.panes[k]) this.panes[k] = { top: y, height: 0, bottom: y };
    this.paneOrder = order;
    this.plotL = PAD.l;
    this.plotR = this.w - PAD.r;
    this.plotW = Math.max(10, this.plotR - this.plotL);
    this.axisY = y;
  }

  setData(data) {
    const isNew = !this.data || this.data.token !== data.token;
    this.data = data;
    // What was under the pointer belonged to the old data: forget it, so no
    // tooltip outlives the trades it described.
    if (this.hoverTrade || this.hoverSignal) {
      this.hoverTrade = null; this.hoverSignal = null;
      if (this.onHoverTrade) this.onHoverTrade(null);
      if (this.onHoverSignal) this.onHoverSignal(null);
    }
    if (isNew) {
      // Default to the combine window itself, leaving the warm-up prefix off to
      // the left for anyone who wants to pan into it.
      const iv = data.initialView;
      this.i0 = iv ? Math.max(0, iv[0]) : 0;
      this.i1 = iv ? Math.min(data.bars.count, iv[1]) : Math.max(2, data.bars.count);
      if (this.i1 - this.i0 < 2) { this.i0 = 0; this.i1 = Math.max(2, data.bars.count); }
    } else {
      this.i1 = Math.min(this.i1, data.bars.count);
      this.i0 = Math.max(0, Math.min(this.i0, this.i1 - 2));
    }
    this._layout();
    this.requestDraw();
  }

  // Candle aggregation for DISPLAY only. It does not touch the strategy, which
  // keeps computing on its own timeframe — you can watch a 1-minute book on
  // hourly candles and the entries stay exactly where they were.
  // 0 is Auto: the size that fits the zoom.
  setTimeframe(min) {
    this.tfMin = Math.max(0, Math.round(min) || 0);
    this.requestDraw();
  }

  // The candles as they are drawn right now.
  candleMin() {
    return this.tfMin || autoCandle(this.plotW / Math.max(1, this.i1 - this.i0));
  }

  // Back to the view the data opened on: the window, not the warm-up behind it,
  // which for a book that holds overnight is all of history.
  resetView() {
    if (!this.data) return;
    const iv = this.data.initialView, n = this.data.bars.count;
    this.i0 = iv ? Math.max(0, iv[0]) : 0;
    this.i1 = iv ? Math.min(n, iv[1]) : n;
    this.requestDraw();
  }

  // Show bars a..b (local 1-minute indexes), e.g. one trade from the trade list.
  zoomTo(a, b) {
    if (!this.data) return;
    const n = this.data.bars.count;
    this.i0 = Math.max(0, Math.min(n - 20, Math.floor(a)));
    this.i1 = Math.min(n, Math.max(this.i0 + 20, Math.ceil(b)));
    this.requestDraw();
  }

  requestDraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }

  // ── coordinate helpers ──
  x(i) { return this.plotL + ((i - this.i0) / (this.i1 - this.i0)) * this.plotW; }
  iAt(px) { return this.i0 + ((px - this.plotL) / this.plotW) * (this.i1 - this.i0); }

  // ── main draw ──
  draw() {
    const ctx = this.bctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = CSS.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    if (!this.data || !this.data.bars.count) {
      ctx.fillStyle = CSS.text;
      ctx.font = "13px ui-sans-serif, system-ui";
      ctx.fillText("No data in this window.", 20, 40);
      return;
    }
    // Dimming goes UNDER the panes; the session and resolution markers go OVER
    // them. At full zoom-out the candle wicks tile every pixel column, so an
    // annotation drawn first is simply painted out by the price series.
    // Each pane draws inside its own vertical band. Without this a pane zoomed
    // in on its y-axis paints straight over its neighbours — a magnified MACD
    // histogram runs off the bottom and lands in the equity chart. Clipping the
    // full width rather than just the plot keeps the right-hand axis labels.
    const clipped = (key, fn) => {
      const P = this.panes[key];
      if (!P || P.height <= 0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, P.top - 1, this.w, P.height + 2);
      ctx.clip();
      fn.call(this, ctx);
      ctx.restore();
    };
    const DRAW = { price: this._drawPricePane, sub: this._drawSubPane, equity: this._drawEquityPane, daily: this._drawDailyPane };
    for (const k of this.paneOrder) clipped(k, DRAW[k] || ((c) => this._drawStudyPane(c, k)));
    this._drawWhyBand(ctx);
    this._drawDimAfterResolution(ctx);
    this._drawSessionBands(ctx);
    this._drawResolutionMarker(ctx);
    this._drawTimeAxis(ctx);
  }

  // Faint vertical separators at each CME session boundary (17:00 ET).
  _drawSessionBands(ctx) {
    const { bars } = this.data;
    const span = this.i1 - this.i0;
    if (span > 60000) return;
    ctx.strokeStyle = CSS.session;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(span / 4000));
    let prev = bars.tday[Math.max(0, Math.floor(this.i0))];
    for (let i = Math.max(1, Math.floor(this.i0)); i < Math.min(bars.count, this.i1); i += step) {
      if (bars.tday[i] !== prev) {
        prev = bars.tday[i];
        const px = Math.round(this.x(i)) + 0.5;
        ctx.moveTo(px, PAD.t);
        ctx.lineTo(px, this.axisY);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // A 30-day window is a maximum, not a duration: it ends the moment the account
  // passes or breaches. Everything after that never happened, so it is dimmed and
  // marked rather than drawn as if it were still part of the evaluation.
  _drawDimAfterResolution(ctx) {
    if (!this.data.replay || this.data.resolveX == null) return;
    const rx = this.x(this.data.resolveX);
    if (rx > this.plotR) return;
    const x0 = Math.max(this.plotL, rx);
    if (x0 >= this.plotR) return;
    ctx.fillStyle = "rgba(6,9,13,0.62)";
    ctx.fillRect(x0, PAD.t, this.plotR - x0, this.axisY - PAD.t);
  }

  _drawResolutionMarker(ctx) {
    const R = this.data.replay;
    if (!R || this.data.resolveX == null) return;
    const rx = this.x(this.data.resolveX);
    if (rx > this.plotR || rx < this.plotL) return;

    const passed = R.outcome === "PASS";
    const color = passed ? CSS.bull : CSS.bear;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(rx) + 0.5, PAD.t);
    ctx.lineTo(Math.round(rx) + 0.5, this.axisY);
    ctx.stroke();
    ctx.setLineDash([]);

    const label = passed ? "PASSED — window ends" : "BREACHED — window ends";
    ctx.font = "bold 10px ui-sans-serif, system-ui";
    const w = ctx.measureText(label).width + 10;
    const lx = Math.min(rx + 4, this.plotR - w);
    ctx.fillStyle = color;
    ctx.fillRect(lx, PAD.t + 1, w, 14);
    ctx.fillStyle = "#08111a";
    ctx.fillText(label, lx + 5, PAD.t + 11);
  }

  // Bucket the visible range into pixel columns. Everything that needs candles
  // goes through this so the cost is bounded by width, not by bar count.
  // Candle columns. Two bucketings, and the distinction matters:
  //
  //   tfMin = 1   slice [i0,i1) evenly so there is never more than one candle
  //               per two pixels. Purely a drawing optimisation.
  //   tfMin > 1   group by the CLOCK — bars sharing a 5/10/15/30/60-minute slot,
  //               or a trading day. Not by counting bars in fives, because the
  //               series has holes: CME halts 17:00-18:00 ET and closes at
  //               weekends, so a fixed stride would straddle those gaps and
  //               build candles out of bars hours apart.
  //
  // Either way idx/idxEnd stay in ONE-MINUTE index space, which is the space
  // trades, overlays and session markers are positioned in. Nothing downstream
  // has to know the candles were aggregated.
  _columns() {
    const { bars } = this.data;
    const s = Math.max(0, Math.floor(this.i0));
    const e = Math.min(bars.count, Math.ceil(this.i1));
    const n = e - s;
    if (n <= 0) return null;

    const maxCols = Math.max(1, Math.min(n, Math.floor(this.plotW / 2)));
    const tf = this.candleMin();
    // A drawing budget, not the 2px rule. Honouring the chosen timeframe
    // matters more than candle width — a sub-pixel candle still aggregates the
    // right bars, and the alternative is silently showing something else.
    const MAX_TF_COLS = 4000;

    let starts = null;
    if (tf > 1) {
      const ms = tf * 60000;
      // Daily uses the trading-day index the dataset already carries, so the
      // session boundary is the firm's 17:00 ET one rather than midnight UTC.
      const keyOf = tf >= 1440 ? (i) => bars.tday[i] : (i) => Math.floor(bars.ts[i] / ms);
      starts = [];
      let prev = null;
      for (let i = s; i < e; i++) {
        const k = keyOf(i);
        if (k !== prev) { starts.push(i); prev = k; }
        if (starts.length > MAX_TF_COLS) break;
      }
      // Past the budget the request is meaningless anyway: thousands of candles
      // in a few hundred pixels are indistinguishable from the pixel slicing
      // they fall back to.
      if (starts.length > MAX_TF_COLS) starts = null;
    }
    // Recorded so the pane can admit when it is not showing what was asked for.
    this.tfApplied = tf === 1 ? 1 : (starts ? tf : 0);

    const cols = starts ? starts.length : maxCols;
    const per = n / cols;
    const o = new Float32Array(cols), h = new Float32Array(cols);
    const l = new Float32Array(cols), c = new Float32Array(cols);
    const idx = new Int32Array(cols), idxEnd = new Int32Array(cols);
    for (let k = 0; k < cols; k++) {
      const a = starts ? starts[k] : s + Math.floor(k * per);
      const b = starts ? (k + 1 < cols ? starts[k + 1] : e)
                       : Math.min(e, s + Math.floor((k + 1) * per));
      const end = Math.max(a + 1, b);
      let hi = -Infinity, lo = Infinity;
      for (let i = a; i < end; i++) {
        if (bars.high[i] > hi) hi = bars.high[i];
        if (bars.low[i] < lo) lo = bars.low[i];
      }
      o[k] = bars.open[a]; h[k] = hi; l[k] = lo; c[k] = bars.close[end - 1];
      idx[k] = a; idxEnd[k] = end;
    }
    return (this._col = { cols, o, h, l, c, idx, idxEnd, per, s, e });
  }

  _priceRange(col) {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < col.cols; k++) {
      if (col.h[k] > hi) hi = col.h[k];
      if (col.l[k] < lo) lo = col.l[k];
    }
    // Keep visible trade levels in frame — a trade whose stop sits off-screen is
    // exactly the one you want to look at.
    for (const t of this.data.trades || []) {
      if (t.xEnd < this.i0 || t.xStart > this.i1) continue;
      lo = Math.min(lo, t.entryPrice, t.exitPrice);
      hi = Math.max(hi, t.entryPrice, t.exitPrice);
    }
    // A Tradovate indicator's plots count too, as they do on the platform.
    for (const st of this.data.studyOverlays || []) {
      if (!st.tv || st.pane !== "price" || st.hidden) continue;
      for (const v of this._visibleValues(st.lines, st.map)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    const pad = (hi - lo) * 0.06 || 1;
    return [lo - pad, hi + pad];
  }

  _drawPricePane(ctx) {
    const P = this.panes.price;
    if (P.height <= 0) return;
    const col = this._columns();
    if (!col) return;

    const nat = this._priceRange(col);
    const V = this._yFor("price", nat[0], nat[1], P);
    const lo = V.lo, hi = V.hi, y = V.y;
    this.priceLo = lo; this.priceHi = hi;
    this.priceY = y;

    this._grid(ctx, P, lo, hi, y, (v) => fmtPx(v));

    // Candles. Positioned from the BAR INDEX they cover, not from the column
    // number — clock-aligned buckets hold different numbers of bars, so even
    // column spacing would slide them out of line with the trade markers and
    // overlays, which are placed by index.
    ctx.lineWidth = 1;
    for (let k = 0; k < col.cols; k++) {
      const xa = this.x(col.idx[k]), xb = this.x(col.idxEnd[k]);
      const cw = Math.max(1, xb - xa);
      const bodyW = Math.max(1, Math.min(cw * 0.72, 14));
      const thin = bodyW <= 1.5;
      const cx = (xa + xb) / 2;
      const up = col.c[k] >= col.o[k];
      const color = up ? CSS.bull : CSS.bear;
      const yh = y(col.h[k]), yl = y(col.l[k]);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, yh);
      ctx.lineTo(Math.round(cx) + 0.5, yl);
      ctx.stroke();
      if (!thin) {
        const yo = y(col.o[k]), yc = y(col.c[k]);
        ctx.fillStyle = color;
        ctx.fillRect(cx - bodyW / 2, Math.min(yo, yc), bodyW, Math.max(1, Math.abs(yc - yo)));
      }
    }

    // Strategy overlays (Donchian bands, moving averages, …)
    for (const ov of this.data.priceOverlays || []) this._drawOverlayLine(ctx, ov, P, y);
    // Indicator studies added beside the strategy, each on its own bars.
    for (const st of this.data.studyOverlays || []) {
      if (st.pane !== "price" || st.hidden) continue;
      if (st.tv) { this._drawTradovate(ctx, P, y, st); continue; }
      for (const ln of st.lines) this._drawOverlayLine(ctx, { ...ln, color: ln.color || st.color, width: 1.3 }, P, y, st.map);
    }

    // Every signal the engine saw, when asked for, then the trades over them
    if (this.data.signalMarks) this._drawSignals(ctx, P, y);
    this._drawTrades(ctx, P, y);
    // What triggered the selected entry: the level, the bars that set it, the order
    this._drawWhy(ctx, P, y);

    const stride = (this.data.tfToLocal && this.data.tfToLocal.stride) || 1;
    this._paneLabel(ctx, P,
                    (this.data.title || "Price") + tfNote(this.candleMin(), this.tfApplied, stride, !this.tfMin),
                    "price");
  }

  // A Tradovate indicator: its plots and graphics, resolved by tradovate/mock/draw.mjs.
  // Its x axis is its own bar index, which map places on this chart's 1-minute axis.
  _drawTradovate(ctx, P, y, st) {
    const xs = st.map.localIdx, n = xs.length, stride = st.map.stride || 1;
    if (!n) return;
    const onAxis = (k) => {
      const i = Math.floor(k);
      if (i < 0) return xs[0] + k * stride;
      if (i >= n - 1) return xs[n - 1] + (k - n + 1) * stride;
      return xs[i] + (k - i) * (xs[i + 1] - xs[i]);
    };
    const barW = (this.plotW / (this.i1 - this.i0)) * stride;
    const A = {
      left: this.plotL, right: this.plotR, top: P.top, bottom: P.bottom, barW, pxPerPrice: Math.abs(y(1) - y(0)), tick: 0.25,
      x: { pos: (k) => this.x(onAxis(k)), unit: barW, base: (v) => this.plotL + v },
      y: { pos: y, unit: y(1) - y(0), base: (v) => P.top + v },
    };
    let from = 0, to = n - 1;
    while (from < to && xs[from] < this.i0) from++;
    while (to > from && xs[to] > this.i1) to--;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.plotL, P.top, this.plotW, P.height);
    ctx.clip();
    for (const p of plotPrims(st.tv.run, st.tv.plot, A, from, to)) paintPrim(ctx, p);
    const items = graphicsPrims(st.tv.run.rows, A, from, to);
    for (const p of items) paintPrim(ctx, p);
    ctx.restore();
    if (this.onTradovateDrawn) {
      const clash = items.length > 400 ? null : overlaps(items, (p) => { ctx.font = fontOf(p); return ctx.measureText(p.text).width; });
      this.onTradovateDrawn(st.tv, { barW, labels: items.filter((p) => p.t === "text").length, clash });
    }
  }

  // `map` places point k on the 1-minute axis: at its bar's centre, or -- for a
  // study on a longer timeframe than the signal (map.step) -- as a step from its
  // bar's close to the next one's, which is when the value became known and so
  // what a gate reading it saw.
  _drawOverlayLine(ctx, ov, P, y, map = this.data.tfToLocal) {
    if (!map || !ov.data) return;
    ctx.strokeStyle = ov.color || "#888";
    ctx.lineWidth = ov.width || 1;
    ctx.globalAlpha = ov.alpha || 1;
    ctx.setLineDash(ov.dash || []);
    ctx.beginPath();
    let started = false;
    const n = ov.data.length, stride = map.stride || 1, margin = Math.max(10, 2 * stride);
    const step = Math.max(1, Math.floor((this.i1 - this.i0) / this.plotW / stride));
    for (let k = 0; k < n; k += step) {
      const li = map.localIdx[k];
      const lEnd = map.step ? (k + step < n ? map.localIdx[k + step] : li + stride) : li;
      if (lEnd < this.i0 - margin || li > this.i1 + margin) { started = false; continue; }
      const v = ov.data[k];
      if (!Number.isFinite(v)) { started = false; continue; }
      const px = this.x(li), py = y(v);
      if (py < P.top - 50 || py > P.bottom + 50) { started = false; continue; }
      if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; }
      if (map.step) ctx.lineTo(this.x(lEnd), py);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  _drawTrades(ctx, P, y) {
    const trades = (this.data.trades || []).filter((t) => t.xEnd >= this.i0 - 5 && t.xStart <= this.i1 + 5);
    // the selected trade keeps its bracket drawn, as a hovered one shows it
    const lit = (t) => t.taken && (this.hoverTrade === t || (!!this.data.why && this.data.why.entryTime === t.entryTime));
    // Skipped signals are worth seeing: the rules layer, not the strategy, suppressed
    // them. Each kind is one path, drawn once. When there are more trades than a third
    // of the pixels, a 1-minute book at full width, a dot at each entry is all that
    // could show, and the dots are far cheaper than thousands of shapes.
    const dense = trades.length > this.plotW / 3;
    for (const K of TRADE_KINDS) {
      if (dense) {
        ctx.fillStyle = K.color;
        for (const t of trades) if (K.is(t) && !lit(t)) ctx.fillRect(this.x(t.xStart) - 1.5, y(t.entryPrice) - 1.5, 3, 3);
        continue;
      }
      const lines = new Path2D(), marks = new Path2D();
      for (const t of trades) {
        if (!K.is(t) || lit(t)) continue;
        const x0 = this.x(t.xStart), x1 = this.x(t.xEnd), y0 = y(t.entryPrice), y1 = y(t.exitPrice);
        lines.moveTo(x0, y0); lines.lineTo(x1, y1);
        this._marker(marks, x0, y0, t.dir, K.r);
        if (K.end) marks.rect(x1 - 2, y1 - 2, 4, 4);
      }
      ctx.strokeStyle = K.color; ctx.lineWidth = K.width; ctx.globalAlpha = K.alpha; ctx.setLineDash(K.dash);
      ctx.stroke(lines);
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.fillStyle = K.color;
      ctx.fill(marks);
    }

    for (const t of trades) {
      if (!lit(t)) continue;
      const x0 = this.x(t.xStart), x1 = this.x(t.xEnd), y0 = y(t.entryPrice), y1 = y(t.exitPrice);
      const color = t.pnl > 0 ? CSS.bull : CSS.bear;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();

      ctx.fillStyle = color;
      ctx.beginPath(); this._marker(ctx, x0, y0, t.dir, 7); ctx.fill();
      ctx.fillRect(x1 - 2, y1 - 2, 4, 4);

      // Show the bracket that was live for this trade.
      const slY = y(t.stop), tpY = y(t.target);
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = CSS.bear;
      ctx.beginPath(); ctx.moveTo(x0, slY); ctx.lineTo(x1, slY); ctx.stroke();
      ctx.strokeStyle = CSS.bull;
      ctx.beginPath(); ctx.moveTo(x0, tpY); ctx.lineTo(x1, tpY); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Every signal bar the engine saw, at its bar, by what became of it: an entry
  // (solid), an order that never filled (hollow), a refusal (a cross), or a
  // position already held (a dot). Below the bar for longs, above for shorts.
  _drawSignals(ctx, P, y) {
    const marks = this.data.signalMarks, span = this.i1 - this.i0;
    const r = span > 20000 ? 2.2 : span > 6000 ? 3 : 4;
    for (const m of marks) {
      if (m.x < this.i0 - 2 || m.x > this.i1 + 2) continue;
      if (m.cls === "held" && span > 20000) continue;
      const px = this.x(m.x), py = y(m.price) + (m.dir === 1 ? 7 : -7);
      const col = m.dir === 1 ? CSS.bull : CSS.bear;
      ctx.lineWidth = 1.3;
      if (m.cls === "held") { ctx.fillStyle = "#4a5666"; ctx.beginPath(); ctx.arc(px, py, 1.6, 0, Math.PI * 2); ctx.fill(); continue; }
      if (m.cls === "refused") {
        ctx.strokeStyle = "#e0894a";
        ctx.beginPath(); ctx.moveTo(px - r, py - r); ctx.lineTo(px + r, py + r); ctx.moveTo(px + r, py - r); ctx.lineTo(px - r, py + r); ctx.stroke();
        continue;
      }
      ctx.beginPath(); ctx.moveTo(px, py - r); ctx.lineTo(px + r, py); ctx.lineTo(px, py + r); ctx.lineTo(px - r, py); ctx.closePath();
      if (m.cls === "entry") { ctx.fillStyle = col; ctx.fill(); } else { ctx.strokeStyle = col; ctx.stroke(); }
    }
  }

  _hitSignal(mx, my) {
    const P = this.panes && this.panes.price, marks = this.data && this.data.signalMarks;
    if (!P || !marks || my < P.top || my > P.bottom || !this.priceY) return null;
    let best = null, bestD = 8;
    for (const m of marks) {
      if (m.x < this.i0 || m.x > this.i1) continue;
      const d = Math.hypot(mx - this.x(m.x), my - (this.priceY(m.price) + (m.dir === 1 ? 7 : -7)));
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  // ── what triggered the selected entry ──
  // `data.why` holds marks already placed on the 1-minute axis (x, x0/x1 in
  // local bar indexes) by the page from the strategy's explain(): zones,
  // levels, dots, lines, moves and spans on the price pane, the order and its
  // fill, and the signal bar itself, highlighted through the indicator panes.
  _drawWhy(ctx, P, y) {
    const W = this.data.why;
    if (!W) return;
    const placed = [];
    const label = (text, lx, ly, color, align = "left") => {
      if (!text) return;
      ctx.font = "10px ui-sans-serif, system-ui";
      const w = ctx.measureText(text).width + 8, h = 14;
      let x0 = align === "right" ? lx - w : lx, y0 = ly - h / 2;
      x0 = Math.max(this.plotL + 2, Math.min(this.plotR - w - 2, x0));
      for (let tries = 0; tries < 8 && placed.some((b) => x0 < b.x + b.w && x0 + w > b.x && y0 < b.y + b.h && y0 + h > b.y); tries++) y0 += h + 1;
      placed.push({ x: x0, y: y0, w, h });
      ctx.fillStyle = "rgba(8,12,18,0.86)";
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.globalAlpha = 0.7;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.fillText(text, x0 + 4, y0 + 10.5);
    };
    const vis = (a, b) => b >= this.i0 - 1 && a <= this.i1 + 1;
    // shaded spans first, under everything else
    for (const m of W.marks) {
      if ((m.type !== "zone" && m.type !== "span") || !vis(m.x0, m.x1)) continue;
      const xa = Math.max(this.plotL, this.x(m.x0)), xb = Math.min(this.plotR, this.x(m.x1));
      if (xb <= xa) continue;
      ctx.fillStyle = m.type === "span" ? "rgba(198,120,221,0.10)" : "rgba(240,180,41,0.07)";
      ctx.fillRect(xa, P.top, xb - xa, P.height);
      ctx.strokeStyle = m.type === "span" ? "rgba(198,120,221,0.45)" : "rgba(240,180,41,0.35)";
      ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xa + 0.5, P.top); ctx.lineTo(xa + 0.5, P.bottom); ctx.moveTo(xb - 0.5, P.top); ctx.lineTo(xb - 0.5, P.bottom); ctx.stroke();
      ctx.setLineDash([]);
      label(m.label, xa + 2, m.type === "span" ? P.bottom - 12 : P.top + 50, m.type === "span" ? "#c678dd" : "#f0b429");
    }
    for (const m of W.marks) {
      const color = m.color || "#f0b429";
      if (m.type === "level" && vis(m.x0, m.x1)) {
        const py = y(m.price);
        ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.setLineDash(m.dash || []);
        ctx.beginPath(); ctx.moveTo(this.x(m.x0), py); ctx.lineTo(this.x(m.x1), py); ctx.stroke();
        ctx.setLineDash([]);
        label(m.label, this.x(m.x0) + 2, py - 9, color);
      } else if (m.type === "line" && vis(m.xs[0], m.xs[m.xs.length - 1])) {
        ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.setLineDash(m.dash || []);
        ctx.beginPath();
        let on = false;
        for (let j = 0; j < m.v.length; j++) {
          if (m.v[j] == null) { on = false; continue; }
          const px = this.x(m.xs[j]), py = y(m.v[j]);
          if (on) ctx.lineTo(px, py); else { ctx.moveTo(px, py); on = true; }
        }
        ctx.stroke(); ctx.setLineDash([]);
        const last = m.v.length - 1;
        if (m.v[last] != null) label(m.label, this.x(m.xs[last]) + 6, y(m.v[last]), color);
      } else if (m.type === "move" && vis(m.x0, m.x1)) {
        const xa = this.x(m.x0), ya = y(m.p0), xb = this.x(m.x1), yb = y(m.p1);
        ctx.strokeStyle = color; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.stroke();
        const ang = Math.atan2(yb - ya, xb - xa);
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(xb, yb);
        ctx.lineTo(xb - 8 * Math.cos(ang - 0.4), yb - 8 * Math.sin(ang - 0.4));
        ctx.lineTo(xb - 8 * Math.cos(ang + 0.4), yb - 8 * Math.sin(ang + 0.4));
        ctx.closePath(); ctx.fill();
        label(m.label, (xa + xb) / 2 + 4, (ya + yb) / 2, color);
      }
    }
    // the order: its price from where it was placed to its fill or its end
    if (W.order && vis(W.order.x0, W.order.x1)) {
      const o = W.order, py = y(o.price);
      ctx.strokeStyle = "#e8eef5"; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(this.x(o.x0), py); ctx.lineTo(this.x(o.x1), py); ctx.stroke();
      ctx.setLineDash([]);
      label(o.label, this.x(o.x1) + 6, py, "#e8eef5");
    }
    for (const m of W.marks) {
      if (m.type !== "dot" || !vis(m.x, m.x)) continue;
      const color = m.color || "#f0b429", px = this.x(m.x), py = y(m.price), r = m.small ? 3 : 4.5;
      ctx.fillStyle = color; ctx.strokeStyle = "#0b0f14"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      label(m.label, px + 7, py, color);
    }
  }

  // The selected signal's bar through the price and indicator panes, and its
  // marks on the strategy's own sub-pane overlays.
  _drawWhyBand(ctx) {
    const W = this.data.why;
    if (!W || !W.bar || !vis2(this, W.bar[0], W.bar[1])) return;
    const top = this.panes.price.top, last = this.paneOrder.filter((k) => k !== "equity" && k !== "daily").pop();
    const bottom = this.panes[last].bottom;
    const xa = this.x(W.bar[0]), xb = Math.max(xa + 2, this.x(W.bar[1]));
    ctx.fillStyle = "rgba(232,238,245,0.07)";
    ctx.fillRect(xa, top, xb - xa, bottom - top);
    ctx.strokeStyle = "rgba(232,238,245,0.35)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(xa + 0.5, top); ctx.lineTo(xa + 0.5, bottom); ctx.moveTo(xb - 0.5, top); ctx.lineTo(xb - 0.5, bottom); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "bold 9px ui-sans-serif, system-ui";
    ctx.fillStyle = "#e8eef5";
    ctx.fillText("signal", xa + 2, top + 9);
  }

  _drawWhySub(ctx, P) {
    const W = this.data.why;
    if (!W || !this._subY) return;
    for (const m of W.marks) {
      if (m.type !== "sub" || !vis2(this, m.x, m.x)) continue;
      const yf = this._subY.get(m.overlay);
      if (!yf || m.value == null || !Number.isFinite(m.value)) continue;
      const px = this.x(m.x), py = Math.max(P.top + 4, Math.min(P.bottom - 4, yf(m.value)));
      ctx.fillStyle = "#f0b429"; ctx.strokeStyle = "#0b0f14"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.font = "10px ui-sans-serif, system-ui";
      const w = ctx.measureText(m.label).width + 8;
      const lx = Math.min(this.plotR - w - 2, px + 7), ly = Math.max(P.top + 2, Math.min(P.bottom - 15, py - 7));
      ctx.fillStyle = "rgba(8,12,18,0.86)"; ctx.fillRect(lx, ly, w, 14);
      ctx.fillStyle = "#f0b429"; ctx.fillText(m.label, lx + 4, ly + 10.5);
    }
  }

  // Adds the triangle to a context's path or a Path2D. Both ways up wind the same
  // way, as a rect does, so overlapping marks in one path do not cut holes.
  _marker(path, x, y, dir, r) {
    if (dir === 1) { path.moveTo(x, y - r); path.lineTo(x + r, y + r * 0.8); path.lineTo(x - r, y + r * 0.8); }
    else { path.moveTo(x, y + r); path.lineTo(x - r, y - r * 0.8); path.lineTo(x + r, y - r * 0.8); }
    path.closePath();
  }

  _drawSubPane(ctx) {
    const P = this.panes.sub;
    const ovs = this.data.subOverlays || [];
    if (P.height <= 0 || !ovs.length) return;
    const ov = ovs[0];
    // An unbounded oscillator cannot use a fixed range. MACD scales with price,
    // so a span taken over the whole series is set by the most recent years and
    // squashes anything older into a flat line at zero — the crossings the book
    // trades on become invisible. Overlays marked autoRange are scaled to what
    // is actually on screen instead, and share one scale so they stay aligned.
    let [lo, hi] = ov.range || [0, 100];
    if (ovs.some((o) => o.autoRange)) {
      const s = this._visibleSpan(ovs.filter((o) => o.autoRange));
      if (s) { lo = s[0]; hi = s[1]; }
    }
    const V = this._yFor("sub", lo, hi, P);
    lo = V.lo; hi = V.hi;
    const y = V.y;

    ctx.strokeStyle = CSS.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(this.plotL + 0.5, P.top + 0.5, this.plotW, P.height);

    if (ov.threshold != null) {
      // The threshold belongs to ovs[0], so it has to be placed on THAT
      // overlay's scale. Using the shared auto-ranged y would put an ADX
      // threshold of 25 wherever 25 happens to fall on a MACD's axis, which is
      // only harmless while every overlay in the pane shares one range.
      const [tl, th] = ov.autoRange ? [lo, hi] : (ov.range || [lo, hi]);
      const ty = (tl === lo && th === hi) ? y
               : (v) => P.bottom - ((v - tl) / (th - tl)) * P.height;
      ctx.strokeStyle = CSS.gridStrong;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(this.plotL, ty(ov.threshold)); ctx.lineTo(this.plotR, ty(ov.threshold));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = CSS.text;
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(String(ov.threshold), this.plotR + 4, ty(ov.threshold) + 3);
    }
    // Draw EVERY sub overlay, not just the first. This used to render ovs[0]
    // and silently drop the rest, which is why a MACD pane could never show its
    // signal line and the crossover the strategy trades on was invisible.
    //
    // Each overlay maps through its OWN range, so a pane can hold series on
    // different scales (a MACD in points beside an ADX in 0-60) without either
    // being squashed into the other's axis.
    // Histograms first so the lines whose crossing they represent sit on top.
    const ordered = [...ovs].sort((a, b) =>
      (a.kind === "hist" ? 0 : 1) - (b.kind === "hist" ? 0 : 1));
    this._subY = new Map();   // each overlay's scale, for the selected entry's marks
    for (const o of ordered) {
      const [l, h] = o.autoRange ? [lo, hi] : (o.range || [lo, hi]);
      const oy = (l === lo && h === hi) ? y
               : (v) => P.bottom - ((v - l) / (h - l)) * P.height;
      this._subY.set(o.name, oy);
      if (o.kind === "hist") this._drawOverlayHist(ctx, o, P, oy);
      else this._drawOverlayLine(ctx, o, P, oy);
    }
    this._drawWhySub(ctx, P);
    this._paneLabel(ctx, P, ovs.map((o) => o.name).join("  ·  "), "sub");
  }

  // Min/max of the given overlays across the visible bars only, padded, and
  // always symmetric about zero so the zero line a crossover happens on sits
  // in the middle of the pane rather than drifting with the data.
  _visibleSpan(ovs, map = this.data.tfToLocal) {
    if (!map) return null;
    const vals = this._visibleValues(ovs, map, true);
    if (!vals.length) return null;
    // A PERCENTILE, not the maximum. One news bar can throw a MACD several
    // times its usual amplitude, and scaling to that leaves every ordinary
    // crossing compressed into a couple of pixels — which is how this pane
    // ended up using a fifth of its height. The rare spike clips at the pane
    // edge instead; the line renderer already drops points that fall outside.
    const m = nthSmallest(vals, Math.min(vals.length - 1, Math.floor(vals.length * 0.98)));
    if (!(m > 0)) return null;
    return [-m * 1.15, m * 1.15];
  }

  // The values of these series on screen (absolute values when `abs`), in a buffer
  // kept between frames: a 1-minute book has 80,000 of them on every frame of a pan.
  _visibleValues(ovs, map, abs = false) {
    const xs = map.localIdx, from = lowerBound(xs, this.i0), to = upperBound(xs, this.i1);
    const need = ovs.length * (to - from);
    if (!this._vals || this._vals.length < need) this._vals = new Float64Array(need * 2);
    const vals = this._vals;
    let n = 0;
    for (const o of ovs) {
      if (!o.data) continue;
      const end = Math.min(to, o.data.length);
      for (let k = from; k < end; k++) {
        const v = abs ? Math.abs(o.data[k]) : o.data[k];
        if (Number.isFinite(v)) vals[n++] = v;
      }
    }
    return vals.subarray(0, n);
  }

  // An unsigned series (ATR, ADX, relative volume): from its 2nd to its 98th
  // percentile on screen, padded, and from zero when it never goes below.
  _visibleMinMax(ovs, map) {
    const vals = this._visibleValues(ovs, map), n = vals.length;
    if (!n) return null;
    let least = Infinity;
    for (let k = 0; k < n; k++) if (vals[k] < least) least = vals[k];
    let lo = nthSmallest(vals, Math.floor(n * 0.02)), hi = nthSmallest(vals, Math.min(n - 1, Math.floor(n * 0.98)));
    if (!(hi > lo)) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.12;
    return [least >= 0 ? Math.max(0, lo - pad) : lo - pad, hi + pad];
  }

  // One indicator study in a pane of its own: its lines and histogram, its
  // levels as dashed guides, its name, and the gate it applies.
  _drawStudyPane(ctx, key) {
    const P = this.panes[key];
    const st = (this.data.studyOverlays || []).find((o) => o.key === key);
    if (!st || P.height <= 0) return;
    let nat = st.range;
    if (!nat) nat = (st.auto === "sym" ? this._visibleSpan(st.lines, st.map) : this._visibleMinMax(st.lines, st.map)) || [0, 1];
    if (st.auto === "minmax" && st.guides && st.guides.length) {
      // keep the gate's levels in view, as long as they are near the data
      const span = nat[1] - nat[0];
      for (const g of st.guides) if (g > nat[1] && g < nat[1] + span) nat = [nat[0], g + span * 0.08]; else if (g < nat[0] && g > nat[0] - span) nat = [g - span * 0.08, nat[1]];
    }
    const V = this._yFor(key, nat[0], nat[1], P), y = V.y;
    st.y = y;   // for the crosshair readout

    ctx.strokeStyle = CSS.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(this.plotL + 0.5, P.top + 0.5, this.plotW, P.height);
    ctx.font = "10px ui-monospace, monospace";
    for (const g of st.guides || []) {
      const gy = y(g);
      if (gy < P.top || gy > P.bottom) continue;
      ctx.strokeStyle = CSS.gridStrong;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(this.plotL, gy); ctx.lineTo(this.plotR, gy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = CSS.text;
      ctx.fillText(String(+g.toFixed(4)), this.plotR + 4, gy + 3);
    }
    if (st.tv) this._drawTradovate(ctx, P, y, st);
    const ordered = st.tv ? [] : [...st.lines].sort((a, b) => (a.kind === "hist" ? 0 : 1) - (b.kind === "hist" ? 0 : 1));
    for (const ln of ordered) {
      if (ln.kind === "hist") this._drawOverlayHist(ctx, { ...ln, colorUp: "rgba(38,166,154,0.55)", colorDown: "rgba(239,83,80,0.55)" }, P, y, st.map);
      else this._drawOverlayLine(ctx, { ...ln, color: ln.color || st.color, width: 1.2 }, P, y, st.map);
    }
    this._paneLabel(ctx, P, st.name + (st.gateText ? `  ·  gate: ${st.gateText}` : ""), key);
  }

  // The value of a series under 1-minute index i: the point whose bar holds it
  // (nearest centre), or for a step map the last one known by then.
  _valueAt(map, data, i) {
    const xs = map.localIdx, at = map.step ? i + 1 : i + 0.5;
    let lo = 0, hi = xs.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (xs[m] <= at) lo = m + 1; else hi = m; }
    let k = lo - 1;
    if (!map.step && lo < xs.length && (k < 0 || Math.abs(xs[lo] - at) < Math.abs(xs[k] - at))) k = lo;
    return k >= 0 && k < data.length ? data[k] : NaN;
  }

  // Vertical bars from the zero line, coloured by sign — a MACD histogram.
  // Bars are clamped to at least one pixel so a near-zero reading still shows
  // where the crossover actually happened.
  // Four-tone when the fade colours are supplied: the sign picks green or red,
  // and whether the bar moved DOWN from the one before it picks the lighter
  // shade of that colour. The comparison is against the previous bar in the
  // series, not the previous bar drawn, so it stays correct at the left edge of
  // the view where the predecessor is off screen.
  _drawOverlayHist(ctx, ov, P, y, map = this.data.tfToLocal) {
    if (!map || !ov.data) return;
    const zero = y(0);
    const bw = Math.max(1, Math.min(6, (this.plotW / Math.max(1, this.i1 - this.i0)) *
                                       (map.stride || 1) * 0.7));
    const up = ov.colorUp || "#3fb27f", dn = ov.colorDown || "#d1566e";
    const upF = ov.colorUpFade || up, dnF = ov.colorDownFade || dn;
    // a step map's bar belongs to the span after its close, where it is known
    const off = map.step ? (map.stride || 1) / 2 : 0;
    const xs = map.localIdx, data = ov.data;
    const bar = (k) => {
      const v = data[k], py = y(v);
      if (!Number.isFinite(py)) return;
      // "Lower than the last bar" means CLOSER TO THE BASELINE, not smaller as
      // a signed number. Below zero those are opposites: a histogram going from
      // -3 to -5 is a bigger bar, not a smaller one, and shading it as the fade
      // would mark a strengthening move as a weakening one.
      const prev = k > 0 ? data[k - 1] : NaN;
      const fading = Number.isFinite(prev) && Math.abs(v) < Math.abs(prev);
      ctx.fillStyle = v >= 0 ? (fading ? upF : up) : (fading ? dnF : dn);
      const top = Math.min(py, zero), hgt = Math.max(1, Math.abs(py - zero));
      ctx.fillRect(this.x(xs[k] + off) - bw / 2, top, bw, hgt);
    };
    // Zoomed out there are many bars to a pixel, and only the tallest either side
    // of zero can show, so each pixel column draws those two and no more.
    const from = lowerBound(xs, this.i0 - off), to = Math.min(data.length, upperBound(xs, this.i1 - off));
    let col = NaN, top = -1, bottom = -1;
    const flush = () => { if (top >= 0) bar(top); if (bottom >= 0) bar(bottom); top = bottom = -1; };
    for (let k = from; k < to; k++) {
      const v = data[k];
      if (!Number.isFinite(v)) continue;
      const c = Math.round(this.x(xs[k] + off));
      if (c !== col) { flush(); col = c; }
      if (v >= 0) { if (top < 0 || v > data[top]) top = k; }
      else if (bottom < 0 || v < data[bottom]) bottom = k;
    }
    flush();
  }

  _drawEquityPane(ctx) {
    const P = this.panes.equity;
    if (P.height <= 0) return;
    const R = this.data.replay;
    if (!R) return;

    const pts = this.data.equityPts;
    const rules = R.rules;

    let lo = Math.min(0, -rules.trailingDD * 1.05), hi = Math.max(rules.profitTarget * 1.1, 100);
    for (const p of pts) {
      if (p.cum < lo) lo = p.cum; if (p.cum > hi) hi = p.cum; if (p.floor < lo) lo = p.floor;
      if (p.need > hi) hi = p.need;
    }
    const pad = (hi - lo) * 0.08 || 100;
    lo -= pad; hi += pad;
    const V = this._yFor("equity", lo, hi, P);
    lo = V.lo; hi = V.hi;
    const y = V.y;
    this.eqY = y; this.eqPane = P;

    this._grid(ctx, P, lo, hi, y, (v) => fmtUsd(v));

    // Target and breakeven references
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = CSS.target;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(this.plotL, y(rules.profitTarget)); ctx.lineTo(this.plotR, y(rules.profitTarget)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = CSS.gridStrong;
    ctx.beginPath(); ctx.moveTo(this.plotL, y(0)); ctx.lineTo(this.plotR, y(0)); ctx.stroke();

    ctx.fillStyle = CSS.target;
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(`target ${fmtUsd(rules.profitTarget)}`, this.plotL + 4, y(rules.profitTarget) - 4);

    if (!pts.length) { this._paneLabel(ctx, P, "Equity vs trailing floor", "equity"); return; }

    // The survivable band: between the equity line and the floor beneath it.
    ctx.beginPath();
    ctx.moveTo(this.x(pts[0].x), y(pts[0].cum));
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(this.x(pts[i].x), y(pts[i - 1].cum));
      ctx.lineTo(this.x(pts[i].x), y(pts[i].cum));
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      ctx.lineTo(this.x(pts[i].x), y(pts[i].floor));
      if (i > 0) ctx.lineTo(this.x(pts[i].x), y(pts[i - 1].floor));
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(74,163,255,0.07)";
    ctx.fill();

    // Trailing drawdown floor (steps up, then locks flat at breakeven)
    ctx.strokeStyle = CSS.floor;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(this.x(pts[0].x), y(pts[0].floor));
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(this.x(pts[i].x), y(pts[i - 1].floor));
      ctx.lineTo(this.x(pts[i].x), y(pts[i].floor));
    }
    ctx.lineTo(this.plotR, y(pts[pts.length - 1].floor));
    ctx.stroke();
    ctx.setLineDash([]);

    // What the window actually has to reach: the consistency rule raises the
    // target to best day / cap once one day is too big a share of the profit.
    // Drawn only where it sits above the target, so a window it never bites
    // looks as before.
    if (pts.some((p) => p.need > rules.profitTarget + 0.5)) {
      ctx.strokeStyle = CSS.target;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(this.x(pts[0].x), y(pts[0].need));
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(this.x(pts[i].x), y(pts[i - 1].need));
        ctx.lineTo(this.x(pts[i].x), y(pts[i].need));
      }
      ctx.lineTo(this.plotR, y(pts[pts.length - 1].need));
      ctx.stroke();
      ctx.setLineDash([]);
      const top = pts[pts.length - 1].need;
      ctx.fillStyle = CSS.target;
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(`consistency: needs ${fmtUsd(top)}`, this.plotL + 4, y(top) - 4);
    }

    // Equity step line
    ctx.strokeStyle = CSS.equity;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(this.x(pts[0].x), y(0));
    for (let i = 0; i < pts.length; i++) {
      ctx.lineTo(this.x(pts[i].x), y(i > 0 ? pts[i - 1].cum : 0));
      ctx.lineTo(this.x(pts[i].x), y(pts[i].cum));
    }
    ctx.lineTo(this.plotR, y(pts[pts.length - 1].cum));
    ctx.stroke();

    // Dots at each realised trade, one path per colour
    const won = new Path2D(), lost = new Path2D();
    for (const p of pts) {
      const dots = p.pnl > 0 ? won : lost, px = this.x(p.x), py = y(p.cum);
      dots.moveTo(px + 2.2, py);
      dots.arc(px, py, 2.2, 0, Math.PI * 2);
    }
    ctx.fillStyle = CSS.bull; ctx.fill(won);
    ctx.fillStyle = CSS.bear; ctx.fill(lost);

    // Outcome flag
    const last = pts[pts.length - 1];
    if (R.outcome === "PASS") this._flag(ctx, this.x(last.x), y(last.cum), CSS.bull, "PASS");
    else if (R.outcome === "FAIL") this._flag(ctx, this.x(last.x), y(last.cum), CSS.bear, "BREACH");

    if (this.data.lockX != null) {
      const lx = this.x(this.data.lockX);
      ctx.strokeStyle = CSS.lock;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(lx, P.top); ctx.lineTo(lx, P.bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = CSS.lock;
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText("floor locks at B/E", lx + 4, P.top + 11);
    }

    this._paneLabel(ctx, P, "Equity vs trailing floor", "equity");
  }

  _flag(ctx, x, y, color, text) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.font = "bold 11px ui-sans-serif, system-ui";
    const w = ctx.measureText(text).width;
    ctx.fillRect(x + 7, y - 9, w + 8, 16);
    ctx.fillStyle = "#08111a";
    ctx.fillText(text, x + 11, y + 3);
  }

  _drawDailyPane(ctx) {
    const P = this.panes.daily;
    if (P.height <= 0) return;
    const days = this.data.dayBars || [];
    const rules = this.data.replay ? this.data.replay.rules : null;

    let mag = 200;
    for (const d of days) mag = Math.max(mag, Math.abs(d.pnl));
    if (rules) mag = Math.max(mag, rules.dailyProfitStop, rules.dailyLossLimit);
    // Symmetric about zero, so the natural range is [-mag, +mag]; feeding that
    // through the shared transform keeps the daily bars zooming like everything
    // else while preserving the 4px inset the bars are drawn with.
    const V = this._yFor("daily", -mag, mag, P);
    const magZ = (V.hi - V.lo) / 2, ctr = (V.hi + V.lo) / 2;
    const y = (v) => P.top + P.height / 2 - ((v - ctr) / magZ) * (P.height / 2 - 4);

    ctx.strokeStyle = CSS.grid;
    ctx.beginPath(); ctx.moveTo(this.plotL, y(0)); ctx.lineTo(this.plotR, y(0)); ctx.stroke();

    if (rules) {
      const lines = [
        [rules.dailyProfitStop, CSS.target, "profit stop"],
        [-rules.circuitBreaker, CSS.lock, "breaker"],
        [-rules.dailyLossLimit, CSS.floor, "daily limit"],
      ];
      ctx.setLineDash([3, 4]);
      ctx.font = "9px ui-monospace, monospace";
      for (const [v, c, label] of lines) {
        if (!v) continue;
        const py = y(v);
        if (py < P.top || py > P.bottom) continue;
        ctx.strokeStyle = c;
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.moveTo(this.plotL, py); ctx.lineTo(this.plotR, py); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = c;
        ctx.fillText(label, this.plotR + 4, py + 3);
      }
      ctx.setLineDash([]);
    }

    for (const d of days) {
      if (d.xEnd < this.i0 || d.xStart > this.i1) continue;
      const x0 = this.x(d.xStart), x1 = this.x(d.xEnd);
      const w = Math.max(2, x1 - x0 - 1);
      const yv = y(d.pnl), y0 = y(0);
      ctx.fillStyle = d.pnl >= 0 ? CSS.bull : CSS.bear;
      ctx.globalAlpha = 0.75;
      ctx.fillRect(x0, Math.min(yv, y0), w, Math.max(1, Math.abs(yv - y0)));
      ctx.globalAlpha = 1;
      if (d.lockout) {
        ctx.fillStyle = CSS.lock;
        ctx.fillRect(x0, P.bottom - 3, w, 3);
      }
    }
    this._paneLabel(ctx, P, "Daily P&L (17:00 ET sessions)", "daily");
  }

  _grid(ctx, P, lo, hi, y, fmt) {
    const ticks = 4;
    ctx.strokeStyle = CSS.grid;
    ctx.fillStyle = CSS.text;
    ctx.font = "10px ui-monospace, monospace";
    ctx.lineWidth = 1;
    for (let k = 0; k <= ticks; k++) {
      const v = lo + ((hi - lo) * k) / ticks;
      const py = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(this.plotL, py); ctx.lineTo(this.plotR, py); ctx.stroke();
      ctx.fillText(fmt(v), this.plotR + 4, py + 3);
    }
  }

  _paneLabel(ctx, P, text, key) {
    ctx.fillStyle = CSS.text;
    ctx.font = "10px ui-sans-serif, system-ui";
    ctx.fillText(text, this.plotL + 4, P.top + 11);
    // A pane showing a magnified slice looks like ordinary data unless it says
    // so, and the reader has no way to know the scale is no longer the natural
    // fit. The badge doubles as the hint for how to undo it.
    if (key && this.yZoomed(key)) {
      const v = this._yState(key);
      const tag = "⇕ " + (v.z < 10 ? v.z.toFixed(1) : Math.round(v.z)) +
                  "×  dbl-click axis to reset";
      ctx.font = "9px ui-monospace, monospace";
      const w = ctx.measureText(tag).width;
      ctx.fillStyle = CSS.lock;
      ctx.globalAlpha = 0.85;
      ctx.fillText(tag, this.plotR - w - 4, P.top + 11);
      ctx.globalAlpha = 1;
    }
  }

  _drawTimeAxis(ctx) {
    const { bars } = this.data;
    ctx.fillStyle = CSS.text;
    ctx.font = "10px ui-monospace, monospace";
    ctx.strokeStyle = CSS.grid;

    const span = this.i1 - this.i0;
    const targetTicks = Math.max(3, Math.floor(this.plotW / 110));
    const step = Math.max(1, Math.floor(span / targetTicks));
    for (let k = 0; k <= targetTicks; k++) {
      const i = Math.floor(this.i0 + k * step);
      if (i < 0 || i >= bars.count) continue;
      const px = this.x(i);
      // Chicago's clock when it shows hours, as the rules and the trade list read;
      // zoomed out, the trading day, as the date box does.
      const label = span > 3000 ? fmtDay(bars.tday[i] * 86400000) : fmtCt(bars.ts[i], bars.ctMin[i]).slice(5);
      if (px + 2 + ctx.measureText(label).width > this.plotR) break;
      ctx.fillText(label, px + 2, this.axisY + 12);
      ctx.beginPath(); ctx.moveTo(px + 0.5, this.axisY - 2); ctx.lineTo(px + 0.5, this.axisY + 2); ctx.stroke();
    }
    ctx.fillText("CT", this.plotR + 4, this.axisY + 12);
  }

  // ── crosshair + hit testing ──
  _bindEvents() {
    const el = this.over;
    let dragging = false, lastX = 0, lastY = 0, dragPane = null, homePane = null;
    // A drag that starts in the right-hand axis gutter, or with shift held,
    // moves that pane's VERTICAL axis and nothing else.
    const wantsY = (mx, e) => mx > this.plotR || e.shiftKey;

    el.addEventListener("mousemove", (e) => {
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (dragging && dragPane) {
        this.panY(dragPane, my - lastY);
        lastY = my;
        return;
      }
      if (dragging) {
        const span = this.i1 - this.i0;
        const d = ((lastX - mx) / this.plotW) * span;
        let a = this.i0 + d, b = this.i1 + d;
        const n = this.data ? this.data.bars.count : 0;
        if (a < 0) { b -= a; a = 0; }
        if (b > n) { a -= b - n; b = n; }
        this.i0 = Math.max(0, a); this.i1 = Math.min(n, b);
        lastX = mx;
        // An ordinary drag moves BOTH axes once the pane it started in has been
        // zoomed vertically — having magnified something, the obvious next move
        // is to drag it around, and discarding the vertical component makes the
        // zoom feel broken. A pane still at its natural fit is left alone: it
        // already shows everything, so dragging it would only push data off
        // screen with nothing gained.
        if (homePane && this.yZoomed(homePane)) this.panY(homePane, my - lastY);
        lastY = my;
        this.requestDraw();
        return;
      }
      this.hover = { x: mx, y: my };
      const t = this._hitTrade(mx, my);
      if (t !== this.hoverTrade) {
        this.hoverTrade = t;
        this.requestDraw();
        if (this.onHoverTrade) this.onHoverTrade(t);
      }
      const sg = t ? null : this._hitSignal(mx, my);
      if (sg !== this.hoverSignal) {
        this.hoverSignal = sg;
        if (this.onHoverSignal) this.onHoverSignal(sg);
      }
      el.style.cursor = mx > this.plotR ? "ns-resize" : t || sg ? "pointer" : "crosshair";
      this._drawCrosshair();
    });

    // A click that did not drag: a trade, a signal marker, or empty chart.
    let downAt = null;
    el.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
    el.addEventListener("click", (e) => {
      if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || !this.onClick) return;
      const r = el.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      if (mx > this.plotR) return;
      const t = this._hitTrade(mx, my), sg = t ? null : this._hitSignal(mx, my);
      this.onClick(t ? { trade: t } : sg ? { signal: sg } : null);
    });

    el.addEventListener("mouseleave", () => {
      this.hover = null;
      this.octx.clearRect(0, 0, this.w, this.h);
    });

    el.addEventListener("mousedown", (e) => {
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      dragging = true; lastX = mx; lastY = my;
      dragPane = wantsY(mx, e) ? this._paneAt(my) : null;
      homePane = dragPane ? null : this._paneAt(my);
      el.style.cursor = dragPane ? "ns-resize"
                      : (homePane && this.yZoomed(homePane)) ? "move" : "grabbing";
    });
    window.addEventListener("mouseup", () => {
      dragging = false; dragPane = null; homePane = null;
      el.style.cursor = "crosshair";
    });

    el.addEventListener("wheel", (e) => {
      if (!this.data) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k = e.deltaY > 0 ? 1.18 : 1 / 1.18;

      // Vertical zoom when the pointer is over the axis gutter or shift is
      // held, and it applies ONLY to the pane under the pointer — the whole
      // point is being able to magnify the indicator without disturbing the
      // candles, or the trailing floor without disturbing either.
      if (wantsY(mx, e)) {
        const pane = this._paneAt(my);
        if (pane) this.zoomY(pane, my, k);
        return;
      }

      const anchor = this.iAt(mx);
      const n = this.data.bars.count;
      let a = anchor - (anchor - this.i0) * k;
      let b = anchor + (this.i1 - anchor) * k;
      if (b - a < 20) { const m = (a + b) / 2; a = m - 10; b = m + 10; }
      this.i0 = Math.max(0, a);
      this.i1 = Math.min(n, b);
      if (this.i1 - this.i0 < 20) this.i1 = Math.min(n, this.i0 + 20);
      this.requestDraw();
    }, { passive: false });

    // Double-click in the gutter resets just that pane's vertical zoom; in the
    // plot it resets the horizontal view and every pane at once.
    el.addEventListener("dblclick", (e) => {
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (mx > this.plotR) {
        const pane = this._paneAt(my);
        if (pane) { this.resetY(pane); return; }
      }
      this.resetY();
      this.resetView();
    });
  }

  _hitTrade(mx, my) {
    const P = this.panes && this.panes.price;
    if (!P || my < P.top || my > P.bottom || !this.data) return null;
    const trades = this.data.trades || [];
    let best = null, bestD = 12;
    for (const t of trades) {
      if (t.xEnd < this.i0 || t.xStart > this.i1) continue;
      const x0 = this.x(t.xStart), y0 = this.priceY(t.entryPrice);
      const x1 = this.x(t.xEnd), y1 = this.priceY(t.exitPrice);
      const d = Math.min(Math.hypot(mx - x0, my - y0), pointToSeg(mx, my, x0, y0, x1, y1));
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  _drawCrosshair() {
    const ctx = this.octx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.hover || !this.data) return;
    const { x: mx, y: my } = this.hover;
    if (mx < this.plotL || mx > this.plotR) return;

    ctx.strokeStyle = CSS.crosshair;
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(mx) + 0.5, PAD.t); ctx.lineTo(Math.round(mx) + 0.5, this.axisY);
    ctx.moveTo(this.plotL, Math.round(my) + 0.5); ctx.lineTo(this.plotR, Math.round(my) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    const i = Math.round(this.iAt(mx));
    const b = this.data.bars;
    if (i < 0 || i >= b.count) return;

    // Time label on the axis
    const label = `${fmtCt(b.ts[i], b.ctMin[i])} CT`;
    ctx.font = "10px ui-monospace, monospace";
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = "#1c2530";
    ctx.fillRect(mx - w / 2, this.axisY, w, 15);
    ctx.fillStyle = CSS.textBright;
    ctx.fillText(label, mx - w / 2 + 5, this.axisY + 11);

    // Value label on the right gutter
    const P = this.panes.price;
    if (my >= P.top && my <= P.bottom && this.priceY) {
      const v = this.priceHi - ((my - P.top) / P.height) * (this.priceHi - this.priceLo);
      this._gutter(ctx, my, fmtPx(v));
      // OHLC readout, of the candle under the pointer rather than the minute in it
      const col = this._col, k = col ? upperBound(col.idx, i) - 1 : -1, one = k < 0 || i >= col.idxEnd[k];
      let vol = 0;
      for (let q = one ? i : col.idx[k], e = one ? i + 1 : col.idxEnd[k]; q < e; q++) vol += b.volume[q];
      const txt = one ? `O ${fmtPx(b.open[i])}  H ${fmtPx(b.high[i])}  L ${fmtPx(b.low[i])}  C ${fmtPx(b.close[i])}  V ${vol}`
                      : `O ${fmtPx(col.o[k])}  H ${fmtPx(col.h[k])}  L ${fmtPx(col.l[k])}  C ${fmtPx(col.c[k])}  V ${vol}`;
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillStyle = CSS.textBright;
      ctx.fillText(txt, this.plotL + 4, P.top + 24);
    }
    // Every study's value at the bar under the cursor: price-pane ones under the
    // OHLC line, the rest in their own panes. A step-drawn study shows the value
    // known by the end of that minute -- the one a gate there would read.
    let row = 0;
    ctx.font = "10px ui-monospace, monospace";
    for (const st of this.data.studyOverlays || []) {
      if (st.hidden) continue;
      const vals = st.lines.map((ln) => [ln.name, this._valueAt(st.map, ln.data, i)]).filter(([, v]) => Number.isFinite(v));
      const text = vals.map(([nm, v]) => `${nm} ${fmtVal(v)}`).join("  ");
      if (st.pane === "price") {
        if (!text) continue;
        ctx.fillStyle = st.color;
        ctx.fillText(`${st.name}: ${text}`, this.plotL + 4, P.top + 37 + 12 * row++);
      } else {
        const SP = this.panes[st.key];
        if (!SP || SP.height <= 0 || !text) continue;
        const lw = ctx.measureText(st.name + (st.gateText ? `  ·  gate: ${st.gateText}` : "")).width;
        ctx.fillStyle = "#0b0f14";
        ctx.fillRect(this.plotL + 8 + lw, SP.top + 2, ctx.measureText(text).width + 8, 12);
        ctx.fillStyle = st.color;
        ctx.fillText(text, this.plotL + 12 + lw, SP.top + 11);
      }
    }
    for (const st of this.data.studyOverlays || []) {
      const SP = this.panes[st.key];
      if (st.pane === "sub" && SP && st.y && my >= SP.top && my <= SP.bottom) {
        // the value at the cursor's height, from the pane's own scale
        const lo = this._invY(st.y, SP.bottom), hi = this._invY(st.y, SP.top);
        this._gutter(ctx, my, fmtVal(lo + ((SP.bottom - my) / SP.height) * (hi - lo)));
      }
    }
    const E = this.panes.equity;
    if (this.eqY && my >= E.top && my <= E.bottom) {
      const lo = this._invEq(E.bottom), hi = this._invEq(E.top);
      const v = lo + ((E.bottom - my) / E.height) * (hi - lo);
      this._gutter(ctx, my, fmtUsd(v));
    }
  }

  // Invert an affine y-mapping at a pixel row.
  _invY(y, py) {
    const y0 = y(0), y1 = y(1);
    return (py - y0) / (y1 - y0);
  }

  _invEq(py) {
    // Solve the equity y-mapping back to a dollar value at a pixel.
    const E = this.panes.equity;
    const y = this.eqY;
    // y(v) is affine; recover it from two probes.
    const v0 = 0, v1 = 1000;
    const y0 = y(v0), y1 = y(v1);
    return v0 + ((py - y0) * (v1 - v0)) / (y1 - y0);
  }

  _gutter(ctx, py, text) {
    ctx.font = "10px ui-monospace, monospace";
    const w = Math.max(this.w - this.plotR - 2, ctx.measureText(text).width + 8);
    ctx.fillStyle = "#1c2530";
    ctx.fillRect(this.plotR + 1, py - 8, w, 15);
    ctx.fillStyle = CSS.textBright;
    ctx.fillText(text, this.plotR + 5, py + 3);
  }
}

// Whether local bars a..b overlap the view.
const vis2 = (c, a, b) => b >= c.i0 - 1 && a <= c.i1 + 1;

function pointToSeg(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = dx * dx + dy * dy;
  if (len === 0) return Math.hypot(px - x0, py - y0);
  let t = ((px - x0) * dx + (py - y0) * dy) / len;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

// ───────────────────── window navigator (the 5-year strip) ─────────────────────
export class Navigator {
  constructor(canvas, onPick) {
    this.c = canvas;
    this.ctx = canvas.getContext("2d");
    this.onPick = onPick;
    this.windows = null;
    this.range = null;
    this.cursorMs = null;
    this.span = "2026";   // what the strip covers: "2026" or "all"
    this.flips = null;    // start dates this run and the baseline disagree on

    canvas.addEventListener("click", (e) => {
      if (!this.range) return;
      const r = canvas.getBoundingClientRect();
      const f = (e.clientX - r.left) / r.width, [t0, t1] = this.shown();
      this.onPick(t0 + f * (t1 - t0));
    });
    canvas.addEventListener("mousemove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.draw();
    });
    canvas.addEventListener("mouseleave", () => { this.hoverX = null; this.draw(); });
    new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
  }

  set(windows, range, cursorMs) {
    this.windows = windows;
    this.range = range;
    this.cursorMs = cursorMs;
    this.draw();
  }

  setFlips(list) {
    this.flips = list;
    this.draw();
  }

  // The dates across the strip. 2026 runs to its last window's start, since the
  // final 30 days have no window of their own.
  shown() {
    const [a, b] = this.range, w = this.windows;
    if (this.span !== "2026" || b <= Y2026 || !w || !w.length) return this.range;
    return [Math.max(a, Y2026), Math.min(b, w[w.length - 1].startMs + 86400000)];
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    // inside the padding: past it the strip's last dates would be cut off
    const box = this.c.parentElement, pad = getComputedStyle(box);
    const w = box.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight), h = 46;
    this.c.width = w * dpr; this.c.height = h * dpr;
    this.c.style.width = w + "px"; this.c.style.height = h + "px";
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(0, 0, w, h);

    if (!this.windows || !this.range) {
      ctx.fillStyle = CSS.text;
      ctx.font = "11px ui-sans-serif, system-ui";
      ctx.fillText("Sweeping every window …", 10, 27);
      return;
    }
    const [t0, t1] = this.shown();
    const x = (ms) => ((ms - t0) / (t1 - t0)) * w;
    const bw = Math.max(1, (86400000 / (t1 - t0)) * w + 0.5);

    for (const win of this.windows) {
      if (win.startMs < t0 || win.startMs >= t1) continue;
      const px = x(win.startMs);
      ctx.fillStyle = win.outcome === "PASS" ? "rgba(38,166,154,0.85)"
        : win.outcome === "FAIL" ? "rgba(239,83,80,0.75)"
        : "rgba(90,107,125,0.45)";
      ctx.fillRect(px, 6, bw, h - 22);
    }

    // A tick over each date the baseline and this run disagree on: green passes
    // now and did not, red passed and no longer does.
    for (const f of this.flips || []) {
      if (f.ms < t0 || f.ms >= t1) continue;
      ctx.fillStyle = f.gained ? "#5fe0a0" : "#ff7a78";
      ctx.fillRect(x(f.ms), 1, bw, 4);
    }

    // Year ticks, or months across a single year
    ctx.fillStyle = CSS.text;
    ctx.font = "9px ui-monospace, monospace";
    const tick = (ms, text) => {
      if (ms < t0 || ms > t1) return;
      const px = x(ms);
      ctx.fillRect(px, 6, 1, h - 22);
      ctx.fillText(text, px + 3, h - 6);
    };
    const y0 = new Date(t0).getUTCFullYear(), y1 = new Date(t1).getUTCFullYear();
    if (t1 - t0 < 400 * 86400000) {
      for (let m = 0; m < 24; m++) { const ms = Date.UTC(y0, m, 1); tick(ms, MONTHS[new Date(ms).getUTCMonth()]); }
    } else {
      for (let yr = y0; yr <= y1; yr++) tick(Date.UTC(yr, 0, 1), String(yr));
    }

    if (this.cursorMs != null) {
      const px = x(this.cursorMs);
      ctx.fillStyle = "#e8f0f8";
      ctx.fillRect(px - 1, 2, 2, h - 14);
    }
    if (this.hoverX != null) {
      ctx.strokeStyle = CSS.crosshair;
      ctx.beginPath(); ctx.moveTo(this.hoverX + 0.5, 2); ctx.lineTo(this.hoverX + 0.5, h - 12); ctx.stroke();
      this._drawHover(ctx, w, t0, t1);
    }
  }

  // What the window under the pointer did.
  _drawHover(ctx, w, t0, t1) {
    const first = this.windows[0], k = Math.floor((t0 + (this.hoverX / w) * (t1 - t0) - first.startMs) / 86400000);
    const win = this.windows[k];
    if (!win) return;
    const text = `${new Date(win.startMs).toISOString().slice(0, 10)}  ${win.outcome === "IN_PROGRESS" ? "UNRESOLVED" : win.outcome}  ${fmtUsd(win.netPnl)}  ${win.daysUsed}d`;
    ctx.font = "10px ui-monospace, monospace";
    const tw = ctx.measureText(text).width + 10, lx = Math.max(0, Math.min(w - tw, this.hoverX + 8));
    ctx.fillStyle = "rgba(11,15,20,0.92)";
    ctx.fillRect(lx, 8, tw, 15);
    ctx.fillStyle = win.outcome === "PASS" ? CSS.bull : win.outcome === "FAIL" ? CSS.bear : CSS.textBright;
    ctx.fillText(text, lx + 5, 19);
  }
}

export { fmtUsd, fmtDay, CSS };
