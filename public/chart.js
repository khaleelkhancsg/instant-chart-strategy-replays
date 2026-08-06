// Canvas chart engine — four stacked panes sharing one x-axis in BAR INDEX
// space (not time), so weekend and holiday gaps don't leave dead air.
//
// Two canvases on purpose: the expensive one (candles, trades, equity) redraws
// only when the view or data changes, while the crosshair lives on a transparent
// overlay that redraws on mousemove. Repainting 30k candles at pointer rate is
// the classic way these things end up feeling sluggish.

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
  crosshair: "#5a6b7d",
};

const PANE_WEIGHTS = { price: 0.46, sub: 0.12, equity: 0.27, daily: 0.15 };
const PAD = { l: 8, r: 74, t: 8, b: 22 };
const AXIS_H = 20;

const fmtUsd = (v, dp = 0) =>
  (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtPx = (v) => v.toFixed(2);

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function fmtDay(ms) {
  const d = new Date(ms);
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${M[d.getUTCMonth()]}`;
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

  _layout() {
    const showSub = !!(this.data && this.data.subOverlays && this.data.subOverlays.length);
    const weights = { ...PANE_WEIGHTS };
    if (!showSub) { weights.price += weights.sub; weights.sub = 0; }

    const usable = this.h - PAD.t - PAD.b - AXIS_H;
    let y = PAD.t;
    this.panes = {};
    for (const k of ["price", "sub", "equity", "daily"]) {
      const ph = Math.round(usable * weights[k]);
      this.panes[k] = { top: y, height: ph, bottom: y + ph };
      y += ph + (ph > 0 ? 6 : 0);
    }
    this.plotL = PAD.l;
    this.plotR = this.w - PAD.r;
    this.plotW = Math.max(10, this.plotR - this.plotL);
    this.axisY = y;
  }

  setData(data) {
    const isNew = !this.data || this.data.token !== data.token;
    this.data = data;
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

  resetView() {
    if (!this.data) return;
    this.i0 = 0;
    this.i1 = this.data.bars.count;
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
    this._drawSessionBands(ctx);
    this._drawPricePane(ctx);
    this._drawSubPane(ctx);
    this._drawEquityPane(ctx);
    this._drawDailyPane(ctx);
    this._drawTimeAxis(ctx);
  }

  // Faint vertical separators at each CME session boundary (17:00 ET).
  _drawSessionBands(ctx) {
    const { bars } = this.data;
    const span = this.i1 - this.i0;
    if (span > 60000) return;
    ctx.strokeStyle = CSS.grid;
    ctx.lineWidth = 1;
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
  }

  // Bucket the visible range into pixel columns. Everything that needs candles
  // goes through this so the cost is bounded by width, not by bar count.
  _columns() {
    const { bars } = this.data;
    const s = Math.max(0, Math.floor(this.i0));
    const e = Math.min(bars.count, Math.ceil(this.i1));
    const n = e - s;
    if (n <= 0) return null;

    const maxCols = Math.min(n, Math.floor(this.plotW / 2));
    const cols = Math.max(1, maxCols);
    const per = n / cols;

    const o = new Float32Array(cols), h = new Float32Array(cols);
    const l = new Float32Array(cols), c = new Float32Array(cols);
    const idx = new Int32Array(cols);
    for (let k = 0; k < cols; k++) {
      const a = s + Math.floor(k * per);
      const b = Math.min(e, s + Math.floor((k + 1) * per));
      const end = Math.max(a + 1, b);
      let hi = -Infinity, lo = Infinity;
      for (let i = a; i < end; i++) {
        if (bars.high[i] > hi) hi = bars.high[i];
        if (bars.low[i] < lo) lo = bars.low[i];
      }
      o[k] = bars.open[a]; h[k] = hi; l[k] = lo; c[k] = bars.close[end - 1];
      idx[k] = a;
    }
    return { cols, o, h, l, c, idx, per, s, e };
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
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    const pad = (hi - lo) * 0.06 || 1;
    return [lo - pad, hi + pad];
  }

  _drawPricePane(ctx) {
    const P = this.panes.price;
    if (P.height <= 0) return;
    const col = this._columns();
    if (!col) return;

    const [lo, hi] = this._priceRange(col);
    this.priceLo = lo; this.priceHi = hi;
    const y = (p) => P.bottom - ((p - lo) / (hi - lo)) * P.height;
    this.priceY = y;

    this._grid(ctx, P, lo, hi, y, (v) => fmtPx(v));

    // Candles
    const cw = this.plotW / col.cols;
    const bodyW = Math.max(1, Math.min(cw * 0.72, 14));
    const thin = bodyW <= 1.5;
    ctx.lineWidth = 1;
    for (let k = 0; k < col.cols; k++) {
      const cx = this.plotL + (k + 0.5) * cw;
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

    // Trades
    this._drawTrades(ctx, P, y);

    this._paneLabel(ctx, P, this.data.title || "Price");
  }

  _drawOverlayLine(ctx, ov, P, y) {
    const map = this.data.tfToLocal;
    if (!map || !ov.data) return;
    ctx.strokeStyle = ov.color || "#888";
    ctx.lineWidth = 1;
    ctx.setLineDash(ov.dash || []);
    ctx.beginPath();
    let started = false;
    const step = Math.max(1, Math.floor((this.i1 - this.i0) / this.plotW / (map.stride || 1)));
    for (let k = 0; k < ov.data.length; k += step) {
      const li = map.localIdx[k];
      if (li < this.i0 - 10 || li > this.i1 + 10) { started = false; continue; }
      const v = ov.data[k];
      if (!Number.isFinite(v)) { started = false; continue; }
      const px = this.x(li), py = y(v);
      if (py < P.top - 50 || py > P.bottom + 50) { started = false; continue; }
      if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _drawTrades(ctx, P, y) {
    const trades = this.data.trades || [];
    for (const t of trades) {
      if (t.xEnd < this.i0 - 5 || t.xStart > this.i1 + 5) continue;
      const x0 = this.x(t.xStart), x1 = this.x(t.xEnd);
      const y0 = y(t.entryPrice), y1 = y(t.exitPrice);

      if (!t.taken) {
        // Signal fired, but a soft stop was in force — worth seeing, since it is
        // the rules layer (not the strategy) suppressing these.
        ctx.strokeStyle = CSS.skip;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.setLineDash([]);
        this._marker(ctx, x0, y0, t.dir, CSS.skip, 4);
        continue;
      }

      const win = t.pnl > 0;
      const color = win ? CSS.bull : CSS.bear;
      const isHover = this.hoverTrade === t;

      ctx.globalAlpha = isHover ? 1 : 0.85;
      ctx.strokeStyle = color;
      ctx.lineWidth = isHover ? 2.4 : 1.6;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.globalAlpha = 1;

      this._marker(ctx, x0, y0, t.dir, color, isHover ? 7 : 5.5);
      ctx.fillStyle = color;
      ctx.fillRect(x1 - 2, y1 - 2, 4, 4);

      if (isHover) {
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
  }

  _marker(ctx, x, y, dir, color, r) {
    ctx.fillStyle = color;
    ctx.beginPath();
    if (dir === 1) { ctx.moveTo(x, y - r); ctx.lineTo(x - r, y + r * 0.8); ctx.lineTo(x + r, y + r * 0.8); }
    else { ctx.moveTo(x, y + r); ctx.lineTo(x - r, y - r * 0.8); ctx.lineTo(x + r, y - r * 0.8); }
    ctx.closePath();
    ctx.fill();
  }

  _drawSubPane(ctx) {
    const P = this.panes.sub;
    const ovs = this.data.subOverlays || [];
    if (P.height <= 0 || !ovs.length) return;
    const ov = ovs[0];
    const [lo, hi] = ov.range || [0, 100];
    const y = (v) => P.bottom - ((v - lo) / (hi - lo)) * P.height;

    ctx.strokeStyle = CSS.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(this.plotL + 0.5, P.top + 0.5, this.plotW, P.height);

    if (ov.threshold != null) {
      ctx.strokeStyle = CSS.gridStrong;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(this.plotL, y(ov.threshold)); ctx.lineTo(this.plotR, y(ov.threshold));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = CSS.text;
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(String(ov.threshold), this.plotR + 4, y(ov.threshold) + 3);
    }
    this._drawOverlayLine(ctx, ov, P, y);
    this._paneLabel(ctx, P, ov.name);
  }

  _drawEquityPane(ctx) {
    const P = this.panes.equity;
    if (P.height <= 0) return;
    const R = this.data.replay;
    if (!R) return;

    const pts = this.data.equityPts;
    const rules = R.rules;

    let lo = Math.min(0, -rules.trailingDD * 1.05), hi = Math.max(rules.profitTarget * 1.1, 100);
    for (const p of pts) { if (p.cum < lo) lo = p.cum; if (p.cum > hi) hi = p.cum; if (p.floor < lo) lo = p.floor; }
    const pad = (hi - lo) * 0.08 || 100;
    lo -= pad; hi += pad;
    const y = (v) => P.bottom - ((v - lo) / (hi - lo)) * P.height;
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

    if (!pts.length) { this._paneLabel(ctx, P, "Equity vs trailing floor"); return; }

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

    // Dots at each realised trade
    for (const p of pts) {
      ctx.fillStyle = p.pnl > 0 ? CSS.bull : CSS.bear;
      ctx.beginPath();
      ctx.arc(this.x(p.x), y(p.cum), 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

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

    this._paneLabel(ctx, P, "Equity vs trailing floor");
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
    const y = (v) => P.top + P.height / 2 - (v / mag) * (P.height / 2 - 4);

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
    this._paneLabel(ctx, P, "Daily P&L (17:00 ET sessions)");
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

  _paneLabel(ctx, P, text) {
    ctx.fillStyle = CSS.text;
    ctx.font = "10px ui-sans-serif, system-ui";
    ctx.fillText(text, this.plotL + 4, P.top + 11);
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
      if (px > this.plotR) break;
      const label = span > 3000 ? fmtDay(bars.ts[i]) : fmtTime(bars.ts[i]).slice(5);
      ctx.fillText(label, px + 2, this.axisY + 12);
      ctx.beginPath(); ctx.moveTo(px + 0.5, this.axisY - 2); ctx.lineTo(px + 0.5, this.axisY + 2); ctx.stroke();
    }
  }

  // ── crosshair + hit testing ──
  _bindEvents() {
    const el = this.over;
    let dragging = false, lastX = 0;

    el.addEventListener("mousemove", (e) => {
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (dragging) {
        const span = this.i1 - this.i0;
        const d = ((lastX - mx) / this.plotW) * span;
        let a = this.i0 + d, b = this.i1 + d;
        const n = this.data ? this.data.bars.count : 0;
        if (a < 0) { b -= a; a = 0; }
        if (b > n) { a -= b - n; b = n; }
        this.i0 = Math.max(0, a); this.i1 = Math.min(n, b);
        lastX = mx;
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
      this._drawCrosshair();
    });

    el.addEventListener("mouseleave", () => {
      this.hover = null;
      this.octx.clearRect(0, 0, this.w, this.h);
    });

    el.addEventListener("mousedown", (e) => { dragging = true; lastX = e.clientX - el.getBoundingClientRect().left; el.style.cursor = "grabbing"; });
    window.addEventListener("mouseup", () => { dragging = false; el.style.cursor = "crosshair"; });

    el.addEventListener("wheel", (e) => {
      if (!this.data) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const anchor = this.iAt(mx);
      const k = e.deltaY > 0 ? 1.18 : 1 / 1.18;
      const n = this.data.bars.count;
      let a = anchor - (anchor - this.i0) * k;
      let b = anchor + (this.i1 - anchor) * k;
      if (b - a < 20) { const m = (a + b) / 2; a = m - 10; b = m + 10; }
      this.i0 = Math.max(0, a);
      this.i1 = Math.min(n, b);
      if (this.i1 - this.i0 < 20) this.i1 = Math.min(n, this.i0 + 20);
      this.requestDraw();
    }, { passive: false });

    el.addEventListener("dblclick", () => this.resetView());
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
    const label = fmtTime(b.ts[i]);
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
      // OHLC readout
      const txt = `O ${fmtPx(b.open[i])}  H ${fmtPx(b.high[i])}  L ${fmtPx(b.low[i])}  C ${fmtPx(b.close[i])}  V ${b.volume[i]}`;
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillStyle = CSS.textBright;
      ctx.fillText(txt, this.plotL + 4, P.top + 24);
    }
    const E = this.panes.equity;
    if (this.eqY && my >= E.top && my <= E.bottom) {
      const lo = this._invEq(E.bottom), hi = this._invEq(E.top);
      const v = lo + ((E.bottom - my) / E.height) * (hi - lo);
      this._gutter(ctx, my, fmtUsd(v));
    }
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

    canvas.addEventListener("click", (e) => {
      if (!this.range) return;
      const r = canvas.getBoundingClientRect();
      const f = (e.clientX - r.left) / r.width;
      this.onPick(this.range[0] + f * (this.range[1] - this.range[0]));
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

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.c.parentElement.clientWidth, h = 46;
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
      ctx.fillText("Run the full-history sweep to map every 30-day window …", 10, 27);
      return;
    }
    const [t0, t1] = this.range;
    const x = (ms) => ((ms - t0) / (t1 - t0)) * w;
    const bw = Math.max(1, w / this.windows.length + 0.5);

    for (const win of this.windows) {
      const px = x(win.startMs);
      ctx.fillStyle = win.outcome === "PASS" ? "rgba(38,166,154,0.85)"
        : win.outcome === "FAIL" ? "rgba(239,83,80,0.75)"
        : "rgba(90,107,125,0.45)";
      ctx.fillRect(px, 6, bw, h - 22);
    }

    // Year ticks
    ctx.fillStyle = CSS.text;
    ctx.font = "9px ui-monospace, monospace";
    const y0 = new Date(t0).getUTCFullYear(), y1 = new Date(t1).getUTCFullYear();
    for (let yr = y0; yr <= y1; yr++) {
      const ms = Date.UTC(yr, 0, 1);
      if (ms < t0 || ms > t1) continue;
      const px = x(ms);
      ctx.fillRect(px, 6, 1, h - 22);
      ctx.fillText(String(yr), px + 3, h - 6);
    }

    if (this.cursorMs != null) {
      const px = x(this.cursorMs);
      ctx.fillStyle = "#e8f0f8";
      ctx.fillRect(px - 1, 2, 2, h - 14);
    }
    if (this.hoverX != null) {
      ctx.strokeStyle = CSS.crosshair;
      ctx.beginPath(); ctx.moveTo(this.hoverX + 0.5, 2); ctx.lineTo(this.hoverX + 0.5, h - 12); ctx.stroke();
    }
  }
}

export { fmtUsd, fmtTime, fmtDay, CSS };
