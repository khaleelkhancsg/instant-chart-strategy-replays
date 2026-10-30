// The Tradovate custom-indicator runtime, emulated, so an indicator can be run and
// looked at before it goes anywhere near the platform.
//
// Built from Tradovate's public repo (vendor/NOTICE.md): the type definitions for
// what the app hands an indicator and what it accepts back, and the real ./tools/*
// modules. tradovate/mock/README.md lists what is an assumption.
//
// Isomorphic. Node runs this file for the CLI and the tests; the chart page imports
// the same file, so changing a setting there re-runs the real indicator code in the
// browser, on the chart's own bars. Import nothing from Node here.

const TEXT_ALIGN = new Set(["none", "centerAbove", "centerMiddle", "centerBelow", "leftAbove", "leftMiddle",
  "leftBelow", "rightAbove", "rightMiddle", "rightBelow"]);
const BOUND_OPS = new Set(["+", "-", "*", "/", "min", "max"]);
const RESERVED = new Set(["style", "candlestick", "graphics"]);

// ── the modules an indicator can require ─────────────────────────────────
// ./tools/graphics is not in the public repo: this is typescript/graphics/Scale.d.ts.
const GRAPHICS = {
  du: (value) => ({ value, unit: "du" }),
  px: (value) => ({ value, unit: "px" }),
  op: (a, op, b) => ({ a, op, b }),
  min: (a, b) => ({ a, op: "min", b }),
  max: (a, b) => ({ a, op: "max", b }),
};

// The platform gives indicators the whole of lodash. The tools use these two.
const LODASH = new Proxy({
  clone: (v) => (Array.isArray(v) ? v.slice() : v && typeof v === "object" ? { ...v } : v),
  toPairs: (o) => Object.entries(o),
}, { get(t, k) { if (k in t) return t[k]; throw new Error(`lodash.${String(k)} is not in the mock: add it to runtime.mjs`); } });

// require() as an indicator sees it. `tools` is { name: source }.
export function makeRequire(tools) {
  const loaded = new Map();
  const req = (path) => {
    if (path === "lodash") return LODASH;
    const m = /^(?:\.\.?\/)?(?:tools\/)?([A-Za-z0-9_]+)(?:\.js)?$/.exec(path);
    if (!m) throw new Error(`require("${path}"): not something the mock provides`);
    const name = m[1];
    if (name === "graphics") return GRAPHICS;
    if (loaded.has(name)) return loaded.get(name).exports;
    if (tools[name] === undefined) throw new Error(`require("${path}"): no such tool in the mock`);
    const module = { exports: {} };
    loaded.set(name, module);
    new Function("require", "module", "exports", tools[name])(req, module, module.exports);
    return module.exports;
  };
  return req;
}

// An indicator's source -> what it exports, the way the platform loads it.
export function loadIndicator(source, tools) {
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(makeRequire(tools), module, module.exports);
  const mod = module.exports;
  if (!mod || typeof mod.calculator !== "function") throw new Error("module.exports has no calculator class");
  return mod;
}

export function defaultProps(mod) {
  const out = {};
  for (const [k, s] of Object.entries(mod.params || {})) out[k] = s && typeof s === "object" && "def" in s ? s.def : s;
  return out;
}

// ── what the app hands an indicator ──────────────────────────────────────
const tradeDateOf = (td) => {
  const d = new Date(td * 86400000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};

class Entity {
  constructor(bar, index, feed) { this.b = bar; this.i = index; this.f = feed; }
  open() { return this.b.o; }
  high() { return this.b.h; }
  low() { return this.b.l; }
  close() { return this.b.c; }
  value() { return this.b.c; }
  volume() { return this.b.v; }
  offerVolume() { return this.b.v / 2; }
  bidVolume() { return this.b.v / 2; }
  profile() { return undefined; }
  timestamp() { return new Date(this.b.ts); }
  tradeDate() { return tradeDateOf(this.b.td); }
  index() { return this.i; }
  isLast() { return this.i === this.f.lastIndex; }
}

class Series {
  constructor() { this.data = []; this.at = -1; this.lastIndex = -1; }
  get(i) { return this.data[i]; }
  size() { return this.data.length; }
  first() { return this.data[0]; }
  last() { return this.data[this.data.length - 1]; }
  prior() { return this.data[this.at - 1]; }
  back(n) { return this.data[this.at - n]; }
}

// A bar part-way through forming: its open, then the range so far.
export const formingBar = (b, stage) => (stage === 0 ? { ...b, h: b.o, l: b.o, c: b.o, v: 0 }
  : { ...b, h: Math.max(b.o, (b.o + b.h) / 2), l: Math.min(b.o, (b.o + b.l) / 2), c: (b.o + b.c) / 2, v: b.v / 2 });

// ── problems: what would go wrong on the platform, found here first ──────
export class Problems {
  constructor() { this.seen = new Map(); }
  add(level, code, text, bar) {
    const k = code + "|" + text, p = this.seen.get(k);
    if (p) p.count++;
    else this.seen.set(k, { level, code, text, bar, count: 1 });
  }
  list() {
    const rank = { error: 0, warn: 1, note: 2 };
    return [...this.seen.values()].sort((a, b) => rank[a.level] - rank[b.level] || a.bar - b.bar);
  }
}

const boundOk = (b) => (typeof b === "number" ? Number.isFinite(b)
  : !!b && typeof b === "object" && ("unit" in b ? (b.unit === "du" || b.unit === "px") && Number.isFinite(b.value)
    : BOUND_OPS.has(b.op) && boundOk(b.a) && boundOk(b.b)));
const pointOk = (p) => !!p && boundOk(p.x) && boundOk(p.y);
const sizeOk = (s) => !!s && boundOk(s.width) && boundOk(s.height);

function checkShape(s) {
  switch (s && s.tag) {
    case "Rectangle": case "Ellipse": return pointOk(s.position) && sizeOk(s.size);
    case "RoundedRectangle": return pointOk(s.position) && sizeOk(s.size) && Number.isFinite(s.radius);
    case "Circle": return pointOk(s.center) && Number.isFinite(s.radius);
    case "Polygon": return Array.isArray(s.points) && s.points.length >= 3 && s.points.every(pointOk);
    default: return false;
  }
}

// One graphics item against typescript/graphics/*.d.ts.
function checkItem(it, bar, problems) {
  const bad = (text) => problems.add("error", "graphics", `${(it && it.tag) || "item"} ${text}`, bar);
  if (!it || typeof it !== "object") return bad("is not an object");
  if (typeof it.key !== "string" || !it.key) bad("has no key");
  const lineStyle = (s) => {
    if (!s || s.color === undefined) bad("has no line color");
    else if (s.lineWidth === undefined) bad(s.width === undefined ? "has no lineWidth" : "sets width, but the graphics LineStyle reads lineWidth");
  };
  switch (it.tag) {
    case "Text":
      if (!pointOk(it.point)) bad("has a bad point: " + JSON.stringify(it.point));
      if (typeof it.text !== "string") bad("has no text string");
      if (!it.style || !Number.isFinite(it.style.fontSize)) bad("has no style.fontSize: such labels have not drawn on the platform");
      if (it.style && typeof it.style.fill === "string" && /^[0-9a-f]{3,8}$/i.test(it.style.fill)) bad(`fill "${it.style.fill}" needs a leading #`);
      if (!TEXT_ALIGN.has(it.textAlignment)) bad(`has an unknown textAlignment "${it.textAlignment}"`);
      break;
    case "LineSegments":
      if (!Array.isArray(it.lines) || !it.lines.length) bad("has no lines");
      else if (!it.lines.every((l) => l && l.tag === "Line" && pointOk(l.a) && pointOk(l.b))) bad("has a bad line");
      lineStyle(it.lineStyle);
      break;
    case "Shapes":
      if (!Array.isArray(it.primitives) || !it.primitives.every(checkShape)) bad("has a bad primitive");
      if (!it.fillStyle || it.fillStyle.color === undefined) bad("has no fillStyle.color");
      break;
    case "ContourShapes":
      if (!Array.isArray(it.primitives) || !it.primitives.every(checkShape)) bad("has a bad primitive");
      lineStyle(it.lineStyle);
      break;
    case "Dots":
      if (!Array.isArray(it.dots) || !it.dots.every((d) => d && pointOk(d.point))) bad("has a bad dot");
      break;
    case "Instancing":
      if (!Array.isArray(it.instances) || !it.instances.every((d) => d && pointOk(d.position) && sizeOk(d.size))) bad("has a bad instance");
      break;
    case "Container":
      if (!Array.isArray(it.children)) bad("has no children");
      else for (const c of it.children) checkItem(c, bar, problems);
      break;
    default:
      bad("is not a graphics type Tradovate knows");
  }
}

export function checkOutput(out, bar, mod, problems) {
  const declared = mod.plots ? new Set(Object.keys(mod.plots)) : null;
  for (const k of Object.keys(out)) {
    if (RESERVED.has(k)) continue;
    const v = out[k];
    if (declared && !declared.has(k) && !fieldsOf(mod).includes(k)) continue;           // returned but not plotted: harmless
    if (v === undefined || v === null) continue;
    if (typeof v !== "number") problems.add("error", "plot", `plot ${k} is a ${typeof v}, not a number`, bar);
    else if (Number.isNaN(v)) problems.add("note", "plot", `plot ${k} is NaN on some bars, which draws as a gap: Tradovate's own indicators do this while they warm up`, bar);
    else if (!Number.isFinite(v)) problems.add("error", "plot", `plot ${k} is ${v}`, bar);
  }
  const g = out.graphics;
  if (g && g.items) {
    const keys = new Set();
    for (const it of g.items) {
      checkItem(it, bar, problems);
      if (it && keys.has(it.key)) problems.add("warn", "graphics", `two items on one bar share the key "${it.key}": one may replace the other`, bar);
      if (it) keys.add(it.key);
    }
  }
}

// The fields the indicator's plotters read.
export function plotters(mod) {
  if (!mod.plotter) return [{ type: "multiline", fields: mod.plots ? Object.keys(mod.plots) : ["value"] }];
  return Array.isArray(mod.plotter) ? mod.plotter : [mod.plotter];
}
export function fieldsOf(mod) {
  const out = [];
  for (const p of plotters(mod)) {
    if (p.fields) out.push(...p.fields);
    if (p.field) out.push(p.field === "_" ? "value" : p.field);
    if (p.type === "macd") out.push("macd", "signal", "difference", "zero");
    if (p.type === "histogram" || p.type === "cumulative" || p.type === "line" || p.type === "scatter") out.push("value");
  }
  return [...new Set(out)];
}

// ── a run: one indicator instance fed bars, as the app feeds it ──────────
const MNQ = { contract: "MNQZ6", product: "MNQ", tickSize: 0.25 };
const MAX_THROWN = 200;

export class Run {
  constructor(mod, { props, minutes = 1, contract = MNQ, problems = new Problems(), check = true } = {}) {
    this.mod = mod;
    this.props = { ...defaultProps(mod), ...props };
    this.rows = [];
    this.problems = problems;
    this.check = check;          // validate what map() returns (`false` for a quick redraw)
    this.series = new Series();
    this.minutes = minutes;
    this.contract = contract;
    this.thrown = 0;
    this.calc = new mod.calculator();
    this.calc.props = this.props;
    this.calc.contractInfo = contract;
    this.calc.chartDescription = { underlyingType: "MinuteBar", elementSize: minutes, elementSizeUnit: "UnderlyingUnits", withHistogram: false };
    this.calc.dlls = {};
    if (this.calc.init) this.calc.init();
  }

  map(i) {
    const s = this.series, e = s.data[i];
    s.at = i;
    let out;
    try {
      out = this.calc.map(e, i, s);
    } catch (err) {
      if (this.thrown++ < MAX_THROWN) this.problems.add("error", "throw", `map() threw: ${err && err.message}`, i);
      out = undefined;
    }
    out = out === undefined || out === null ? {} : typeof out === "number" ? { value: out } : out;
    if (typeof out !== "object") {
      this.problems.add("error", "map", `map() returned a ${typeof out}`, i);
      out = {};
    }
    if (this.check) checkOutput(out, i, this.mod, this.problems);
    if (this.calc.filter) {
      let keep = true;
      try { keep = this.calc.filter(out); } catch (err) { this.problems.add("error", "throw", `filter() threw: ${err && err.message}`, i); }
      if (!keep) out = { graphics: out.graphics, filtered: true };
    }
    this.rows[i] = out;
    return out;
  }

  // History, as a chart loads it: every bar there at once, isLast() on the last.
  // With `forming`, each bar is first seen part-built, as a live bar is.
  compute(bars, { forming = false } = {}) {
    const s = this.series;
    s.data = bars.map((b, i) => new Entity(b, i, s));
    s.lastIndex = bars.length - 1;
    for (let i = 0; i < bars.length; i++) {
      if (forming) {
        const whole = s.data[i];
        for (const stage of [0, 1]) {
          s.data[i] = new Entity(formingBar(bars[i], stage), i, s);
          this.map(i);
        }
        s.data[i] = whole;
      }
      this.map(i);
    }
    return this.rows;
  }
}

const quiet = (k, v) => (k === "calc" ? undefined : v);

// Whether the finished bars survive map() being re-called as a bar forms. Tradovate's
// own indicators keep running state in tools like EMA, so the platform must rebuild
// or restore that state on a live bar, and it does not say how. An indicator that
// passes here is safe however it does that; one that does not is only a note.
export function formingProblems(mod, bars, { props, minutes, problems }) {
  const a = new Run(mod, { props, minutes, problems: new Problems() }).compute(bars);
  const b = new Run(mod, { props, minutes, problems: new Problems() }).compute(bars, { forming: true });
  let diff = 0, first = -1;
  for (let i = 0; i < bars.length; i++) {
    if (JSON.stringify(a[i], quiet) !== JSON.stringify(b[i], quiet)) { diff++; if (first < 0) first = i; }
  }
  if (diff) problems.add("note", "forming", `keeps running state: ${diff} of ${bars.length} bars change if map() is re-called on a forming bar. Tradovate's own indicators do too, so compare a live chart with a reload`, first);
  return diff;
}

// What can be told from the source and exports alone.
export function staticProblems(mod, source, problems) {
  if (/\bDate\.now\(|\bnew Date\(\)|\bMath\.random\(/.test(source)) problems.add("note", "source", "reads the clock or random numbers: a reload can differ from what was drawn live", 0);
  if (mod.requirements && mod.requirements.volumeProfiles) problems.add("note", "profile", "asks for volume profiles: d.profile() returns nothing here, so this shows its fallback", 0);
}

// Every problem an indicator has on these bars. `forming: false` leaves out the
// forming check, by far the slowest part, for a caller that runs it separately.
export function audit(mod, source, bars, { props, minutes, formingFrom = 0, forming = true } = {}) {
  const problems = new Problems();
  staticProblems(mod, source, problems);
  const run = new Run(mod, { props, minutes, problems });
  run.compute(bars);
  if (forming) formingProblems(mod, bars.slice(formingFrom), { props, minutes, problems });
  return { run, problems: problems.list() };
}
