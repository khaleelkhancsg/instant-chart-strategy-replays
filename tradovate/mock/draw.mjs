// What an indicator's output looks like on a chart, as a list of things to draw in
// pixels. Pure, and isomorphic like runtime.mjs: public/chart.js paints this list on
// the backtester's chart, and the tests and the CLI read it without a browser.
//
// A coordinate is a `du` (a bar index on x, a price on y), a `px`, or an expression
// of them (typescript/graphics/Scale.d.ts). A du on the left of an expression is a
// position; on the right it is a length, so op(du(price), "-", px(60)) is 60 pixels
// above the price, and du(0.5) next to px(5) is half a bar's width.

// ── coordinates ──────────────────────────────────────────────────────────
const shorter = (a, b) => (Math.abs(a) <= Math.abs(b) ? a : b);
const longer = (a, b) => (Math.abs(a) >= Math.abs(b) ? a : b);
const APPLY = { "+": (a, b) => a + b, "-": (a, b) => a - b, "*": (a, b) => a * b, "/": (a, b) => a / b, min: shorter, max: longer };

// The value of a bound made only of du, else null.
function domain(b) {
  if (typeof b === "number") return b;
  if (b.unit === "du") return b.value;
  if (b.unit === "px") return null;
  const x = domain(b.a), y = domain(b.b);
  return x === null || y === null ? null : APPLY[b.op](x, y);
}
export function boundPx(b, ax) {
  const v = domain(b);
  if (v !== null) return ax.pos(v);
  if (b.unit === "px") return ax.base(b.value);
  return APPLY[b.op](boundPx(b.a, ax), lengthPx(b.b, ax));
}
export function lengthPx(b, ax) {
  const v = domain(b);
  if (v !== null) return v * ax.unit;
  if (b.unit === "px") return b.value;
  return APPLY[b.op](lengthPx(b.a, ax), lengthPx(b.b, ax));
}

// The axes of a pane. `first` is the bar at the left edge of the plot, barW the
// pixels per bar; price runs from `lo` at the bottom to `hi` at the top.
export function paneAxes({ left, right, top, bottom, first, barW, lo, hi, tick = 0.25 }) {
  const pxPerPrice = (bottom - top) / (hi - lo);
  return {
    left, right, top, bottom, barW, pxPerPrice, tick,
    x: { pos: (i) => left + (i - first + 0.5) * barW, unit: barW, base: (v) => left + v },
    y: { pos: (p) => bottom - (p - lo) * pxPerPrice, unit: -pxPerPrice, base: (v) => top + v },
  };
}

// An item's origin moves where a px counts from (GraphicsResponse.d.ts AxesOrigin).
function originAxes(A, o) {
  if (!o) return A;
  return {
    ...A,
    x: { ...A.x, base: o.h === "right" ? (v) => A.right - v : A.x.base },
    y: { ...A.y, base: o.v === "bottom" ? (v) => A.bottom - v : A.y.base },
  };
}

const visible = (c, A) => {
  if (!c) return true;
  const inside = (r, v) => !r || ((r.min === undefined || v >= r.min) && (r.max === undefined || v <= r.max));
  return inside(c.scaleRangeX, A.barW) && inside(c.scaleRangeY, A.pxPerPrice * A.tick);
};

// ── graphics items ───────────────────────────────────────────────────────
const point = (p, A) => ({ x: boundPx(p.x, A.x), y: boundPx(p.y, A.y) });
const rgb = (c) => (c ? `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})` : undefined);
const DASH = { 1: [], 2: [6, 2], 3: [3, 3], 4: [8, 3], 5: [6, 6] };
const dashOf = (s) => DASH[s] || [];
const ALIGN_H = { left: "left", center: "center", right: "right" };
const ALIGN_V = { Above: "bottom", Middle: "middle", Below: "top" };

function shapePrim(s, A, base) {
  switch (s.tag) {
    case "Circle": { const c = point(s.center, A); return { ...base, t: "ellipse", x: c.x, y: c.y, rx: s.radius, ry: s.radius }; }
    case "Ellipse": {
      const c = point(s.position, A);
      return { ...base, t: "ellipse", x: c.x, y: c.y, rx: Math.abs(lengthPx(s.size.width, A.x)) / 2, ry: Math.abs(lengthPx(s.size.height, A.y)) / 2 };
    }
    case "Rectangle": case "RoundedRectangle": {
      const c = point(s.position, A), w = Math.abs(lengthPx(s.size.width, A.x)), h = Math.abs(lengthPx(s.size.height, A.y));
      return { ...base, t: "rect", x: s.infiniteStart ? A.left : c.x - w / 2, y: c.y - h / 2, w: s.infiniteEnd ? A.right - (s.infiniteStart ? A.left : c.x - w / 2) : w, h, r: s.radius || 0 };
    }
    case "Polygon": return { ...base, t: "poly", pts: s.points.map((p) => point(p, A)) };
    default: return null;
  }
}

function addItem(out, it, A0, bar, dx = 0, dy = 0, zIn = 0) {
  if (!it || !visible(it.conditions, A0)) return;
  const A = originAxes(A0, it.origin);
  const tag = { key: it.key, bar, z: zIn };
  const shift = (p) => ({ ...p, x: p.x + dx, y: p.y + dy });
  switch (it.tag) {
    case "Text": {
      const m = /^(left|center|right)(Above|Middle|Below)$/.exec(it.textAlignment || "") || [null, "left", "Below"];
      const p = shift(point(it.point, A)), s = it.style || {};
      out.push({ ...tag, t: "text", x: p.x, y: p.y, text: it.text, size: s.fontSize || 11, weight: s.fontWeight || "normal", style: s.fontStyle || "normal",
                 family: s.fontFamily, fill: s.fill || "#e8e8e8", h: ALIGN_H[m[1]], v: ALIGN_V[m[2]] });
      break;
    }
    case "LineSegments": {
      const st = it.lineStyle || {};
      for (const l of it.lines) {
        let a = shift(point(l.a, A)), b = shift(point(l.b, A));
        const dxl = b.x - a.x, slope = dxl ? (b.y - a.y) / dxl : 0;
        if (l.infiniteStart) a = { x: A.left, y: a.y + (A.left - a.x) * slope };
        if (l.infiniteEnd) b = { x: A.right, y: b.y + (A.right - b.x) * slope };
        out.push({ ...tag, t: "line", a, b, color: st.color, width: st.lineWidth || 1, dash: dashOf(st.lineStyle), alpha: st.opacity ?? 1 });
      }
      break;
    }
    case "Shapes": case "ContourShapes": {
      const fill = it.tag === "Shapes", st = fill ? it.fillStyle || {} : it.lineStyle || {};
      const base = { ...tag, fill: fill ? st.color : undefined, stroke: fill ? undefined : st.color, width: st.lineWidth || 1, alpha: st.opacity ?? 1 };
      for (const s of it.primitives) {
        const p = shapePrim(s, A, base);
        if (!p) continue;
        if (p.pts) p.pts = p.pts.map(shift);
        else { p.x += dx; p.y += dy; }
        out.push(p);
      }
      break;
    }
    case "Dots":
      for (const d of it.dots) {
        const p = shift(point(d.point, A));
        out.push({ ...tag, t: "ellipse", x: p.x, y: p.y, rx: ((it.style && it.style.lineWidth) || 2) / 2, ry: ((it.style && it.style.lineWidth) || 2) / 2,
                   fill: rgb(d.color) || (it.style && it.style.color), alpha: 1 });
      }
      break;
    case "Instancing":
      for (const n of it.instances) {
        const p = shift(point(n.position, A)), w = Math.abs(lengthPx(n.size.width, A.x)), h = Math.abs(lengthPx(n.size.height, A.y));
        out.push({ ...tag, t: "rect", x: p.x, y: p.y - h, w, h, r: 0, fill: rgb(n.color), alpha: 1 });
      }
      break;
    case "Container": {
      let tx = dx, ty = dy, z = zIn;
      for (const o of it.transformOps || []) {
        if (o.tag === "Translate") { tx += lengthPx(o.vector.x, A.x); ty += lengthPx(o.vector.y, A.y); }
        if (o.tag === "ZIndex") z = o.zIndex;
      }
      for (const c of it.children) addItem(out, c, A, bar, tx, ty, z);
      break;
    }
    default:
  }
}

// Every item a run has on bars [from, to]: per-bar items with their own bar in
// view, and global ones whichever bar returned them last.
export function graphicsPrims(rows, A, from, to) {
  const out = [], globals = new Map();
  for (let i = 0; i < rows.length; i++) {
    const g = rows[i] && rows[i].graphics;
    if (!g || !g.items) continue;
    const inView = i >= from && i <= to;
    for (const it of g.items) {
      if (!it) continue;
      if (it.global) globals.set(it.key, [it, i]);
      else if (inView) addItem(out, it, A, i);
    }
  }
  for (const [it, i] of globals.values()) addItem(out, it, A, i);
  return out.sort((a, b) => a.z - b.z);
}

// ── plots ────────────────────────────────────────────────────────────────
export function plotStyle(mod, field, scheme = "dark") {
  const styles = mod.schemeStyles || {};
  const set = styles[scheme] || styles.dark || {};
  const s = set[field] || set._ || {};
  return { color: s.color || "#8f98a3", width: s.lineWidth || 1, dash: dashOf(s.lineStyle), alpha: s.opacity > 1 ? s.opacity / 100 : s.opacity ?? 1 };
}

const fieldValue = (row, f) => {
  const v = row && !row.filtered ? row[f] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

function linePrims(out, rows, f, st, A, from, to, shift) {
  let pts = null, color = null;
  const flush = () => { if (pts && pts.length > 1) out.push({ t: "path", pts, color, width: st.width, dash: st.dash, alpha: st.alpha }); pts = null; };
  for (let i = Math.max(0, from - 1); i <= Math.min(rows.length - 1, to + 1); i++) {
    const v = fieldValue(rows[i], f), c = (rows[i] && rows[i].style && rows[i].style[f] && rows[i].style[f].color) || st.color;
    if (v === undefined) { flush(); continue; }
    const p = { x: A.x.pos(i + shift), y: A.y.pos(v) };
    if (pts && c !== color) { pts.push(p); flush(); }
    if (!pts) { pts = []; color = c; }
    pts.push(p);
  }
  flush();
}

function columnPrims(out, rows, f, st, A, from, to, shift) {
  const zero = A.y.pos(0), w = Math.max(1, A.barW * 0.7);
  for (let i = from; i <= Math.min(rows.length - 1, to); i++) {
    const v = fieldValue(rows[i], f);
    if (v === undefined) continue;
    const y = A.y.pos(v), c = (rows[i].style && rows[i].style[f] && rows[i].style[f].color) || st.color;
    out.push({ t: "rect", x: A.x.pos(i + shift) - w / 2, y: Math.min(y, zero), w, h: Math.max(1, Math.abs(y - zero)), r: 0, fill: c, alpha: st.alpha });
  }
}

function dotPrims(out, rows, f, st, A, from, to, shift) {
  for (let i = from; i <= Math.min(rows.length - 1, to); i++) {
    const v = fieldValue(rows[i], f);
    if (v !== undefined) out.push({ t: "ellipse", x: A.x.pos(i + shift), y: A.y.pos(v), rx: 1.5, ry: 1.5, fill: st.color, alpha: st.alpha });
  }
}

// `custom` plotters draw on a canvas of their own (typescript/canvas.d.ts).
function customPrims(out, fn, run, A, from, to) {
  const place = (p) => {
    const x = p.x, d = x && typeof x === "object" ? x : { i: x };
    const i = d.i !== undefined ? d.i : d.x !== undefined ? d.x.i ?? 0 : (d.x1.i + (d.x2.i - d.x1.i) * d.k);
    return { x: A.x.pos(i) + (d.dx || 0), y: A.y.pos(p.y) };
  };
  const stroke = (s = {}) => ({ color: s.color || "#8f98a3", width: s.relativeWidth ? Math.max(1, s.relativeWidth * A.barW) : s.width || 1, alpha: s.opacity ?? 1, dash: [] });
  const canvas = {
    drawLine: (a, b, s) => out.push({ t: "line", a: place(a), b: place(b), ...stroke(s) }),
    drawPath: (path, s) => {
      let pts = [];
      for (const it of path.items) {
        if (it.t === "M" && pts.length > 1) { out.push({ t: "path", pts, ...stroke(s) }); pts = []; }
        if (it.t === "M") pts = [];
        pts.push(place({ x: it.x, y: it.y }));
      }
      if (pts.length > 1) out.push({ t: "path", pts, ...stroke(s) });
    },
    drawHeatmap: () => {},
  };
  const data = run.rows.map((r, i) => ({ ...r, date: { i } }));
  const series = { data, get: (i) => data[i], size: () => data.length, first: () => data[0], last: () => data[data.length - 1] };
  try { fn(canvas, run.calc, series); } catch (err) { run.problems.add("error", "throw", `custom plotter threw: ${err && err.message}`, 0); }
}

// Every plotter of a run, on bars [from, to].
export function plotPrims(run, plotters, A, from, to, scheme = "dark") {
  const out = [], mod = run.mod, rows = run.rows, shifts = mod.shifts || {};
  const st = (f) => plotStyle(mod, f, scheme), sh = (f) => shifts[f] || 0;
  for (const p of plotters) {
    switch (p.type) {
      case "multiline": case "pivotpoints": case "zigzag":
        for (const f of p.fields || []) linePrims(out, rows, f, st(f), A, from, to, sh(f));
        break;
      case "line": case "cumulative": linePrims(out, rows, "value", st("value"), A, from, to, sh("value")); break;
      case "histogram": columnPrims(out, rows, "value", st("value"), A, from, to, sh("value")); break;
      case "columns": columnPrims(out, rows, p.field, st(p.field), A, from, to, sh(p.field)); break;
      case "dots": case "scatter": { const f = !p.field || p.field === "_" ? "value" : p.field; dotPrims(out, rows, f, st(f), A, from, to, sh(f)); break; }
      case "macd":
        columnPrims(out, rows, "difference", st("difference"), A, from, to, 0);
        for (const f of ["macd", "signal", "zero"]) linePrims(out, rows, f, st(f), A, from, to, 0);
        break;
      case "range": {
        const [lo, hi] = p.fields;
        for (let i = from; i <= Math.min(rows.length - 1, to); i++) {
          const a = fieldValue(rows[i], lo), b = fieldValue(rows[i], hi);
          if (a !== undefined && b !== undefined) out.push({ t: "line", a: { x: A.x.pos(i), y: A.y.pos(a) }, b: { x: A.x.pos(i), y: A.y.pos(b) }, ...st(lo) });
        }
        break;
      }
      case "custom": customPrims(out, p.function, run, A, from, to); break;
      default: for (const f of p.fields || []) linePrims(out, rows, f, st(f), A, from, to, sh(f));
    }
  }
  return out;
}

// The price range of bars [from, to] in a pane: the fields an indicator asks to be
// scaled by (its scaler, else every plotted field).
export function fieldRange(rows, fields, from, to, lo = Infinity, hi = -Infinity) {
  for (let i = Math.max(0, from); i <= Math.min(rows.length - 1, to); i++) {
    for (const f of fields) {
      const v = fieldValue(rows[i], f);
      if (v === undefined) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return [lo, hi];
}

// ── painting one primitive on a 2D canvas ────────────────────────────────
const pathOf = (ctx, pts, close) => {
  ctx.beginPath();
  pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
  if (close) ctx.closePath();
};
const fillAndStroke = (ctx, p) => {
  if (p.fill) { ctx.fillStyle = p.fill; ctx.fill(); }
  if (p.stroke) { ctx.strokeStyle = p.stroke; ctx.lineWidth = p.width; ctx.setLineDash([]); ctx.stroke(); }
};
export const fontOf = (p) => `${p.style} ${p.weight} ${p.size}px ${p.family || "ui-sans-serif, system-ui, sans-serif"}`;

export function paintPrim(ctx, p) {
  ctx.globalAlpha = p.alpha ?? 1;
  switch (p.t) {
    case "path":
      ctx.strokeStyle = p.color; ctx.lineWidth = p.width; ctx.setLineDash(p.dash || []);
      pathOf(ctx, p.pts);
      ctx.stroke();
      break;
    case "line":
      ctx.strokeStyle = p.color; ctx.lineWidth = p.width; ctx.setLineDash(p.dash || []);
      pathOf(ctx, [p.a, p.b]);
      ctx.stroke();
      break;
    case "rect":
      ctx.beginPath();
      if (p.r && ctx.roundRect) ctx.roundRect(p.x, p.y, p.w, p.h, p.r); else ctx.rect(p.x, p.y, p.w, p.h);
      fillAndStroke(ctx, p);
      break;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.rx, p.ry, 0, 0, 7);
      fillAndStroke(ctx, p);
      break;
    case "poly":
      pathOf(ctx, p.pts, true);
      fillAndStroke(ctx, p);
      break;
    case "text":
      ctx.font = fontOf(p); ctx.fillStyle = p.fill; ctx.textAlign = p.h; ctx.textBaseline = p.v;
      p.text.split(String.fromCharCode(10)).forEach((line, k) => ctx.fillText(line, p.x, p.y + k * (p.size + 2)));
      break;
    default:
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}

// ── text boxes: can a label be read? ─────────────────────────────────────
const WIDTH = (p) => p.text.length * p.size * (p.weight === "bold" ? 0.58 : 0.52);

export function textBox(p, width = WIDTH(p)) {
  const x = p.h === "left" ? p.x : p.h === "right" ? p.x - width : p.x - width / 2;
  const y = p.v === "top" ? p.y : p.v === "bottom" ? p.y - p.size : p.y - p.size / 2;
  return { x, y, w: width, h: p.size };
}

// Pairs of labels that print over each other.
export function overlaps(prims, widthOf = WIDTH) {
  const texts = prims.filter((p) => p.t === "text" && p.text.trim().length > 1).map((p) => ({ p, b: textBox(p, widthOf(p)) }));
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i].b, b = texts[j].b;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 2 && oy > 2) out.push([texts[i].p, texts[j].p]);
    }
  }
  return out;
}
