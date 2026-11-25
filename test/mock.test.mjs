// The mock of Tradovate's indicator runtime.   node test/mock.test.mjs
//
// Holds tradovate/mock/ to what Tradovate's own definitions say: coordinates, text
// alignment, what map() may return, what is refused. Then the conformance run: every
// built-in indicator and example Tradovate ships (tradovate/mock/vendor/) and every
// indicator of ours runs through it on a synthetic market without an error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { audit, defaultProps, loadIndicator, Problems, Run } from "../tradovate/mock/runtime.mjs";
import { boundPx, graphicsPrims, lengthPx, overlaps, paneAxes, plotPrims, textBox } from "../tradovate/mock/draw.mjs";
import { indicatorFile, listIndicators, loadTools, readIndicator } from "../tradovate/mock/library.mjs";
import { STUDIES, databoxRow } from "../src/studies.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "tradovate", "mock", "vendor");
let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
const eq = (a, b, m = "") => { if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const near = (a, b, m = "") => { if (Math.abs(a - b) > 1e-6) throw new Error(`${m} expected ${b}, got ${a}`); };

const tools = loadTools();
const req = (name) => new Function("require", "module", `module.exports = require("${name}");`);
const graphics = (() => { const m = {}; req("./tools/graphics")((n) => loadIndicator(`module.exports = { calculator: class {}, g: require("${n}") };`, tools).g, m); return m.exports; })();
const { du, px, op, min, max } = graphics;

// A market to run on: a seeded walk, three sessions a week's worth of minutes.
function market(n = 6000) {
  let seed = 1234, price = 20000;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const bars = [], t0 = Date.UTC(2026, 0, 5, 14);
  for (let i = 0; i < n; i++) {
    const o = price, c = o + (rand() - 0.5) * 8, h = Math.max(o, c) + rand() * 2, l = Math.min(o, c) - rand() * 2;
    const ts = t0 + i * 60000;
    bars.push({ ts, o, h, l, c, v: 50 + Math.floor(rand() * 500), td: 20460 + Math.floor((i + 480) / 1380), ct: (510 + i) % 1440 });
    price = c;
  }
  return bars;
}
const BARS = market();
const A = paneAxes({ left: 0, right: 1000, top: 0, bottom: 500, first: 100, barW: 10, lo: 100, hi: 200, tick: 0.25 });

// An indicator from a calculator body.
const indicator = (body, rest = "") => loadIndicator(`
const predef = require("./tools/predef");
const { du, px, op } = require("./tools/graphics");
class c { ${body} }
module.exports = { name: "x", calculator: c, ${rest} };`, tools);
const problemsOf = (mod, bars = BARS.slice(0, 40), props) => {
  const problems = new Problems();
  new Run(mod, { props, problems }).compute(bars);
  return problems.list();
};
const withOutput = (out) => indicator(`map(d, i) { return i === 5 ? ${out} : undefined; }`, `plots: { a: { title: "A" } },`);
const flags = (out, text) => {
  const list = problemsOf(withOutput(out));
  if (!list.some((p) => p.level === "error" && p.text.includes(text))) throw new Error(`no error about "${text}": ${JSON.stringify(list.map((p) => p.text))}`);
};

console.log("\ncoordinates (typescript/graphics/Scale.d.ts)");
t("a du is a bar index across and a price up the pane", () => {
  near(boundPx(du(100), A.x), 5);
  near(boundPx(du(101), A.x), 15);
  near(boundPx(du(200), A.y), 0);
  near(boundPx(du(100), A.y), 500);
});
t("op(du(price), '-', px(60)) is 60 pixels above the price", () => near(boundPx(op(du(150), "-", px(60)), A.y), 250 - 60));
t("px on the right of a bar index moves it across", () => near(boundPx(op(du(100), "+", px(8)), A.x), 13));
t("du on the right of a mix is a length, in that axis's scale", () => near(boundPx(op(du(100), "-", op(px(0), "+", du(0.5))), A.x), 0));
t("du with du is arithmetic in the domain", () => near(boundPx(op(du(150), "+", du(10)), A.y), A.y.pos(160)));
t("min and max pick by size: half a bar or 3 pixels, whichever is less", () => {
  near(lengthPx(min(px(3), du(0.5)), A.x), 3);
  near(lengthPx(max(px(3), du(0.5)), A.x), 5);
  const narrow = paneAxes({ left: 0, right: 100, top: 0, bottom: 100, first: 0, barW: 2, lo: 0, hi: 1 });
  near(lengthPx(min(px(3), du(0.5)), narrow.x), 1);
});
t("a raw number is a du", () => near(boundPx(150, A.y), 250));

console.log("\ngraphics items (typescript/graphics/*.d.ts)");
const prim = (it, bar = 150, rows = 300) => {
  const list = Array.from({ length: rows }, () => ({}));
  list[bar] = { graphics: { items: [it] } };
  return graphicsPrims(list, A, 100, 199);
};
const label = (al) => prim({ tag: "Text", key: "a", point: { x: du(150), y: du(150) }, text: "abc", style: { fontSize: 10 }, textAlignment: al })[0];
t("text alignment names the corner at the point: leftMiddle runs right of it", () => { const p = label("leftMiddle"); eq(p.h, "left"); eq(p.v, "middle"); });
t("rightMiddle runs left of it, centerAbove sits on it, centerBelow hangs from it", () => {
  eq(label("rightMiddle").h, "right"); eq(label("centerAbove").v, "bottom"); eq(label("centerBelow").v, "top");
});
t("the box a label takes follows its alignment", () => {
  const p = label("rightMiddle"), b = textBox(p, 30);
  near(b.x + b.w, p.x); near(b.y + b.h / 2, p.y);
});
t("a line's dash numbers are DashLineStyle", () => {
  const p = prim({ tag: "LineSegments", key: "a", lines: [{ tag: "Line", a: { x: du(110), y: du(120) }, b: { x: du(120), y: du(120) } }], lineStyle: { lineWidth: 2, color: "#f00", lineStyle: 3 } })[0];
  eq(p.t, "line"); eq(p.width, 2); eq(p.dash.join(), "3,3");
});
t("infiniteStart and infiniteEnd reach the plot's edges", () => {
  const p = prim({ tag: "LineSegments", key: "a", lines: [{ tag: "Line", a: { x: du(110), y: du(120) }, b: { x: du(120), y: du(120) }, infiniteStart: true, infiniteEnd: true }], lineStyle: { lineWidth: 1, color: "#f00" } })[0];
  near(p.a.x, 0); near(p.b.x, 1000); near(p.a.y, p.b.y);
});
t("a per-bar item draws only with its bar in view, a global one always", () => {
  const it = { tag: "Text", key: "a", point: { x: du(150), y: du(150) }, text: "abc", style: { fontSize: 10 }, textAlignment: "none" };
  eq(prim(it, 250).length, 0);
  eq(prim({ ...it, global: true }, 250).length, 1);
  eq(prim(it, 150).length, 1);
});
t("a global item's key keeps only its latest render", () => {
  const it = (text) => ({ tag: "Text", key: "k", global: true, point: { x: du(150), y: du(150) }, text, style: { fontSize: 10 }, textAlignment: "none" });
  const list = Array.from({ length: 300 }, () => ({}));
  list[120] = { graphics: { items: [it("old")] } }; list[130] = { graphics: { items: [it("new")] } };
  const out = graphicsPrims(list, A, 100, 199);
  eq(out.length, 1); eq(out[0].text, "new");
});
t("conditions: an item shows only inside its pixels-per-bar range", () => {
  const it = { tag: "Text", key: "a", point: { x: du(150), y: du(150) }, text: "abc", style: { fontSize: 10 }, textAlignment: "none" };
  eq(prim({ ...it, conditions: { scaleRangeX: { min: 20 } } }).length, 0);
  eq(prim({ ...it, conditions: { scaleRangeX: { min: 5 } } }).length, 1);
});
t("a Container moves its children, and origin moves px's zero to a corner, keeping its direction", () => {
  const txt = { tag: "Text", key: "t", point: { x: du(150), y: du(150) }, text: "abc", style: { fontSize: 10 }, textAlignment: "none" };
  const moved = prim({ tag: "Container", key: "c", children: [txt], transformOps: [{ tag: "Translate", vector: { x: px(7), y: px(0) } }] })[0];
  near(moved.x, A.x.pos(150) + 7);
  // from the bottom-right corner, into the chart is negative (Tradovate's guide, for the right edge)
  const corner = prim({ ...txt, point: { x: px(-20), y: px(-10) }, origin: { cs: "grid", h: "right", v: "bottom" } })[0];
  near(corner.x, 980); near(corner.y, 490);
  const outside = prim({ ...txt, point: { x: px(20), y: px(10) }, origin: { cs: "grid", h: "right", v: "bottom" } })[0];
  near(outside.x, 1020); near(outside.y, 510);
  const topLeft = prim({ ...txt, point: { x: px(20), y: px(10) }, origin: { cs: "grid", h: "left", v: "top" } })[0];
  near(topLeft.x, 20); near(topLeft.y, 10);
});
t("shapes, dots and instances become drawables", () => {
  const p = { x: du(150), y: du(150) };
  eq(prim({ tag: "Shapes", key: "a", primitives: [{ tag: "Circle", radius: 5, center: p }], fillStyle: { color: "#5c5" } })[0].t, "ellipse");
  eq(prim({ tag: "ContourShapes", key: "a", primitives: [{ tag: "Polygon", points: [p, p, p] }], lineStyle: { lineWidth: 1, color: "#5c5" } })[0].t, "poly");
  eq(prim({ tag: "Dots", key: "a", dots: [{ point: p, color: { r: 1, g: 0, b: 0 } }], style: { lineWidth: 3, color: "#f00" } })[0].fill, "rgb(255,0,0)");
  eq(prim({ tag: "Instancing", key: "a", instances: [{ position: p, size: { width: px(5), height: px(30) }, color: { r: 1, g: 0.5, b: 0.25 } }] })[0].t, "rect");
});
t("overlapping labels are found, separate ones are not", () => {
  const at = (x, y) => ({ t: "text", x, y, text: "a label", size: 10, weight: "normal", h: "left", v: "top" });
  eq(overlaps([at(0, 0), at(5, 2)]).length, 1);
  eq(overlaps([at(0, 0), at(5, 40)]).length, 0);
});

console.log("\nwhat the app hands an indicator, and takes back (typescript/calculator.d.ts, TimeSeries.d.ts)");
t("map may return a number, nothing or an object", () => {
  const r = new Run(indicator(`map(d, i) { return i === 0 ? 5 : i === 1 ? undefined : { value: 7 }; }`));
  r.compute(BARS.slice(0, 3));
  eq(r.rows[0].value, 5); eq(Object.keys(r.rows[1]).length, 0); eq(r.rows[2].value, 7);
});
t("props are the params' defaults with the settings over them, set before init()", () => {
  const mod = indicator(`init() { this.seen = this.props.period; } map() { return this.seen; }`, `params: { period: predef.paramSpecs.period(9), on: predef.paramSpecs.bool(true) },`);
  eq(defaultProps(mod).period, 9); eq(defaultProps(mod).on, true);
  const r = new Run(mod, { props: { period: 4 } });
  r.compute(BARS.slice(0, 2));
  eq(r.rows[1].value, 4);
});
t("the entity and the series answer as TimeSeries.d.ts says", () => {
  const mod = indicator(`map(d, i, s) { return { a: d.value() === d.close(), b: i > 2 ? s.back(2).close() : 0, c: i > 0 ? s.prior().close() : 0, n: s.size(), last: d.isLast(), idx: d.index(), ms: d.timestamp().getTime() }; }`);
  const r = new Run(mod), b = BARS.slice(0, 5);
  r.compute(b);
  eq(r.rows[4].a, true); near(r.rows[4].b, b[2].c); near(r.rows[4].c, b[3].c); eq(r.rows[1].n, 5);
  eq(r.rows[1].last, false); eq(r.rows[4].last, true); eq(r.rows[3].idx, 3); eq(r.rows[3].ms, b[3].ts);
});
t("contract and chart are on the instance", () => {
  const r = new Run(indicator(`map() { return this.contractInfo.tickSize * this.chartDescription.elementSize; }`), { minutes: 2 });
  r.compute(BARS.slice(0, 1));
  near(r.rows[0].value, 0.5);
});
t("filter() drops what it refuses from the plots", () => {
  const r = new Run(indicator(`map(d, i) { return { value: i }; } filter(o) { return o.value > 1; }`));
  r.compute(BARS.slice(0, 3));
  eq(r.rows[0].filtered, true); eq(r.rows[2].value, 2);
  const lines = plotPrims(r, [{ type: "multiline", fields: ["value"] }], A, 0, 2);
  eq(lines.length, 0);
});
t("filter() is given the bar's index too, as Tradovate's EMA and Bollinger Bands read it", () => {
  const r = new Run(loadIndicator(fs.readFileSync(path.join(VENDOR, "builtin", "ema.js"), "utf8"), tools), { props: { period: 3 } });
  r.compute(BARS.slice(0, 6));
  eq(r.rows[2].filtered, true, "bar 2, inside the period:");
  if (!Number.isFinite(r.rows[3].value)) throw new Error("bar 3, past the period, drew nothing");
});
t("a real tool runs: EMA as Tradovate wrote it", () => {
  const mod = loadIndicator(`const EMA = require("./tools/EMA"); class c { init() { this.e = EMA(3); } map(d) { return this.e(d.value()); } } module.exports = { name: "x", calculator: c };`, tools);
  const b = BARS.slice(0, 3), r = new Run(mod);
  r.compute(b);
  near(r.rows[2].value, (b[0].c + b[1].c + b[2].c) / 3);
});

console.log("\nwhat is caught before it reaches the platform");
t("map() throwing", () => { if (!problemsOf(indicator(`map() { throw new Error("boom"); }`))[0].text.includes("boom")) throw new Error("not reported"); });
t("a plot that is not a number, or infinite; NaN is only a gap, as Tradovate's own indicators use it", () => {
  flags(`{ a: "x" }`, "is a string");
  flags(`{ a: Infinity }`, "plot a is Infinity");
  const list = problemsOf(withOutput(`{ a: NaN }`));
  eq(list.length, 1); eq(list[0].level, "note");
});
t("a graphics item with no key, or a tag Tradovate does not know", () => { flags(`{ graphics: { items: [{ tag: "Text" }] } }`, "no key"); flags(`{ graphics: { items: [{ tag: "Nope", key: "a" }] } }`, "not a graphics type"); });
t("a point that is not a coordinate", () => flags(`{ graphics: { items: [{ tag: "Text", key: "a", text: "x", style: { fontSize: 9 }, textAlignment: "none", point: { x: du(NaN), y: du(1) } }] } }`, "bad point"));
t("text with no font size, an unknown alignment, or a colour with no #", () => {
  const item = (s, al) => `{ graphics: { items: [{ tag: "Text", key: "a", text: "x", point: { x: du(1), y: du(1) }, style: ${s}, textAlignment: "${al}" }] } }`;
  flags(item(`{ fill: "#fff" }`, "none"), "fontSize");
  flags(item(`{ fontSize: 9 }`, "middle"), "textAlignment");
  flags(item(`{ fontSize: 9, fill: "f3ff14" }`, "none"), "leading #");
});
t("an origin Tradovate does not know", () => {
  flags(`{ graphics: { items: [{ tag: "Text", key: "a", text: "x", style: { fontSize: 9 }, textAlignment: "leftMiddle", point: { x: px(-9), y: px(9) }, origin: { cs: "grid", h: "end", v: "top" } }] } }`, "an origin Tradovate does not know");
  flags(`{ graphics: { items: [{ tag: "Text", key: "a", text: "x", style: { fontSize: 9 }, textAlignment: "leftMiddle", point: { x: px(-9), y: px(9) }, origin: { h: "right", v: "top" } }] } }`, "an origin Tradovate does not know");
});
t("a line style with width where the graphics module reads lineWidth", () => flags(`{ graphics: { items: [{ tag: "LineSegments", key: "a", lines: [{ tag: "Line", a: { x: du(1), y: du(1) }, b: { x: du(2), y: du(1) } }], lineStyle: { width: 2, color: "#f00" } }] } }`, "reads lineWidth"));
t("two items sharing a key on one bar", () => {
  const it = `{ tag: "Text", key: "a", text: "x", point: { x: du(1), y: du(1) }, style: { fontSize: 9 }, textAlignment: "none" }`;
  const list = problemsOf(withOutput(`{ graphics: { items: [${it}, ${it}] } }`));
  if (!list.some((p) => p.level === "warn" && p.text.includes("share the key"))) throw new Error("not reported");
});
t("a well-formed item is not flagged", () => eq(problemsOf(withOutput(`{ a: 1, graphics: { items: [{ tag: "Text", key: "a", text: "x", point: { x: du(1), y: du(1) }, style: { fontSize: 9, fill: "#fff" }, textAlignment: "centerMiddle" }] } }`)).length, 0));
t("state that breaks when a bar forms is noted; derived state is not", () => {
  const b = BARS.slice(0, 50);
  const count = indicator(`init() { this.n = 0; } map() { return ++this.n; }`);
  if (!audit(count, "", b).problems.some((p) => p.code === "forming")) throw new Error("not noted");
  const pure = indicator(`init() { this.v = []; } map(d, i) { this.v[i] = (this.v[i - 1] || 0) + d.close(); return this.v[i]; }`);
  eq(audit(pure, "", b).problems.length, 0);
});
t("the page's quick paths: the forming check can run later, and a redraw can skip validation", () => {
  const b = BARS.slice(0, 50);
  const count = indicator(`init() { this.n = 0; } map() { return ++this.n; }`);
  eq(audit(count, "", b, { forming: false }).problems.length, 0);
  const bad = withOutput(`{ a: Infinity }`);
  const quick = new Run(bad, { check: false });
  quick.compute(b);
  eq(quick.problems.list().length, 0);
  if (quick.rows[5].a !== Infinity) throw new Error("the output itself changed");
});

console.log("\nconformance: Tradovate's own indicators, and ours");
console.log("\nthe EMA + MACD databox against Tradovate's own EMA and MACD");
{
  const vendor = (f) => loadIndicator(fs.readFileSync(path.join(VENDOR, "builtin", f), "utf8"), tools);
  const box = loadIndicator(readIndicator("emaMacdDatabox").source, tools);
  // Tradovate's EMA tool from the first bar (its built-in EMA hides the first `period`)
  const raw = loadIndicator(`const EMA = require("./tools/EMA"); class c { init() { this.f = EMA(12); this.s = EMA(26); }
    map(d) { return { f: this.f(d.value()), s: this.s(d.value()) }; } } module.exports = { name: "x", calculator: c };`, tools);
  const E = new Run(raw).compute(BARS), M = new Run(vendor("macd.js")).compute(BARS);
  const hEma = (i) => (i < 0 ? undefined : E[i].f - E[i].s);
  const hMacd = (i) => (i < 0 ? undefined : M[i].difference);
  // What a row should read on bar j, worked out again from a histogram series and the
  // row's rule: "shrink" (the bar nearer zero than the one before; the MACD row's) or
  // "speed" (the bar moved toward zero by more than the one before moved; the EMA row's).
  const expected = (h, j, ready, rule) => {
    const sides = [];
    let side = 0;
    for (let i = 0; i <= j; i++) {
      const x = h(i);
      sides[i] = x === undefined ? null : (side = x > 0 ? 1 : x < 0 ? -1 : side);
    }
    let bars = 0;
    for (let i = j; i >= 0 && sides[i] === sides[j]; i--) bars++;
    const s = sides[j], m = h(j) - h(j - 1), before = h(j - 1) - h(j - 2);
    const warn = rule === "shrink" ? h(j - 1) !== undefined && (s === 1 ? h(j) < h(j - 1) : s === -1 && h(j) > h(j - 1))
      : rule === "speed" ? h(j - 2) !== undefined && (s === 1 ? m < 0 && m < before : s === -1 && m > 0 && m > before)
      : rule === "slowing" ? h(j - 2) !== undefined && (s === 1 ? m < before : s === -1 && m > before) : false;
    if (!ready || !s) return { text: "Warming up", bars: "" };
    return { text: s === 1 ? (warn ? "Potentially short" : "Long") : warn ? "Potentially long" : "Short", bars: `${bars} bar${bars === 1 ? "" : "s"}` };
  };
  // The rows' arithmetic is checked with the VWAP-slope marking off (it changes only the text of a
  // warning, and has its own test below); a test that sets vwapSlope keeps its own.
  const boxAt = (k, props) => {
    const r = new Run(box, { props: { vwapSlope: "off", ...props } }).compute(BARS.slice(0, k + 1));
    return Object.fromEntries(r[k].graphics.items.map((it) => [it.key, it]));
  };

  t("its EMA lines are Tradovate's EMA, to the bit", () => {
    const mine = new Run(box, { props: { showEmas: true } }).compute(BARS);
    for (const [n, field] of [[12, "emaFast"], [26, "emaSlow"]]) {
      const theirs = new Run(vendor("ema.js"), { props: { period: n } }).compute(BARS);
      for (let i = 26; i < BARS.length; i++) eq(mine[i][field], theirs[i].value, `${field} on bar ${i}:`);
    }
  });
  t("at bar close, each row reads the last closed bar: its side, its warning and its count, from Tradovate's MACD", () => {
    let seen = new Set();
    for (let k = 40; k < BARS.length; k += 47) {
      const b = boxAt(k, { updates: "close" }), j = k - 1;
      const e = expected(hEma, j, j >= 26, "speed"), m = expected(hMacd, j, j >= 33, "shrink");
      eq(b.dbState0.text, e.text, `EMA row at bar ${j}:`); eq(b.dbBars0.text, e.bars, `EMA count at bar ${j}:`);
      eq(b.dbState1.text, m.text, `MACD row at bar ${j}:`); eq(b.dbBars1.text, m.bars, `MACD count at bar ${j}:`);
      seen.add(e.text); seen.add(m.text);
    }
    for (const s of ["Long", "Short", "Potentially short", "Potentially long"]) if (!seen.has(s)) throw new Error(`never saw "${s}"`);
  });
  t("live, the default, reads the forming bar, and a saved \"read forming bar: off\" no longer holds it at the close", () => {
    for (const k of [300, 1234, 5000]) {
      for (const props of [{}, { updates: "live" }, { readFormingBar: false }]) {
        const b = boxAt(k, props), m = expected(hMacd, k, true, "shrink"), e = expected(hEma, k, true, "speed");
        eq(b.dbState1.text, m.text, `MACD row at bar ${k}:`); eq(b.dbBars1.text, m.bars, `MACD count at bar ${k}:`);
        eq(b.dbState0.text, e.text, `EMA row at bar ${k}:`); eq(b.dbBars0.text, e.bars, `EMA count at bar ${k}:`);
        eq(b.dbHead.text, "EMA + MACD, live");
      }
      eq(boxAt(k, { updates: "close" }).dbHead.text, "EMA + MACD, at bar close");
    }
  });
  t("live, a bar read as it forms ends where the at-close box reads it, once the next bar starts", () => {
    // the forming bar k, mapped tick by tick: at each tick the live box reads that tick;
    // once bar k + 1 starts, the at-close box reads bar k as it finished
    for (const k of [400, 2222]) {
      const r = new Run(box, { props: {} }), base = BARS.slice(0, k), bar = BARS[k];
      const ticks = [bar.o, bar.h, bar.l, bar.c].map((c, n) => ({ ...bar, c, h: Math.max(bar.o, c), l: Math.min(bar.o, c), v: Math.round((bar.v * (n + 1)) / 4) }));
      let last = null;
      for (const tick of ticks) last = r.compute([...base, tick])[k];
      const atClose = new Run(box, { props: { updates: "close" } }).compute(BARS.slice(0, k + 2))[k + 1];
      const key = (out) => Object.fromEntries(out.graphics.items.map((it) => [it.key, it.text]));
      for (const f of ["dbState0", "dbState1", "dbBars0", "dbBars1"]) eq(key(last)[f], key(atClose)[f], `${f} at bar ${k}:`);
    }
  });
  t("the box sits in the corner asked for, boxX and boxY in from it, inside the chart", () => {
    const at = (props) => {
      const r = new Run(box, { props }).compute(BARS.slice(0, 501));
      const list = r.map((o) => ({ graphics: o.graphics }));
      const out = graphicsPrims(list, A, 400, 499);
      const box0 = out.find((q) => q.key === "dbBox"), xs = box0.pts.map((q) => q.x), ys = box0.pts.map((q) => q.y);
      for (const q of out) {
        const pts = q.pts || [{ x: q.x, y: q.y }];
        for (const z of pts) if (!(z.x >= A.left && z.x <= A.right && z.y >= A.top && z.y <= A.bottom)) throw new Error(`${q.key} at ${z.x},${z.y} is off the chart (${props.corner})`);
      }
      return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys), out };
    };
    const tl = at({ corner: "topLeft", boxX: 8, boxY: 30 }), w = tl.right - tl.left, h = tl.bottom - tl.top;
    near(tl.left, A.left + 8); near(tl.top, A.top + 30);
    const tr = at({ corner: "topRight", boxX: 8, boxY: 30 });
    near(tr.right, A.right - 8); near(tr.top, A.top + 30); near(tr.right - tr.left, w);
    const bl = at({ corner: "bottomLeft", boxX: 12, boxY: 20 });
    near(bl.left, A.left + 12); near(bl.bottom, A.bottom - 20); near(bl.bottom - bl.top, h);
    const br = at({ corner: "bottomRight", boxX: 12, boxY: 20 });
    near(br.right, A.right - 12); near(br.bottom, A.bottom - 20);
    // the text keeps its place inside the box, wherever the box is
    const rel = (b) => b.out.filter((q) => q.t === "text").map((q) => `${q.key}:${(q.x - b.left).toFixed(2)},${(q.y - b.top).toFixed(2)}`).sort().join(" ");
    eq(rel(tr), rel(tl)); eq(rel(br), rel(at({ corner: "topLeft", boxX: 12, boxY: 20 })));
    // the top-left box carries no origin, and the default corner is the top right
    const items = new Run(box, { props: { corner: "topLeft" } }).compute(BARS.slice(0, 301))[300].graphics.items;
    if (items.some((it) => it.origin)) throw new Error("the top-left box carries an origin");
    const dflt = at({});
    near(dflt.right, tr.right); near(dflt.top, tr.top);
  });
  t("every line of text is centred and sits inside the box, in every corner, even in a font 15% wider", () => {
    const WIDE = (p) => p.text.length * p.size * (p.weight === "bold" ? 0.58 : 0.52) * 1.15;
    let lines = 0;
    for (const corner of ["topLeft", "topRight", "bottomLeft", "bottomRight"]) for (const k of [300, 2500, 5000]) for (const showBars of [true, false]) for (const vwapSlope of ["off", "mark"]) {
      const r = new Run(box, { props: { corner, showBars, vwapSlope } }).compute(BARS.slice(0, k + 1));
      const out = graphicsPrims(r.map((o) => ({ graphics: o.graphics })), A, k - 99, k);
      const b0 = out.find((q) => q.key === "dbBox"), xs = b0.pts.map((q) => q.x), ys = b0.pts.map((q) => q.y);
      const L = Math.min(...xs), R = Math.max(...xs), T = Math.min(...ys), B = Math.max(...ys);
      for (const q of out.filter((q) => q.t === "text" && q.text)) {
        if (q.h !== "center" || q.v !== "middle") throw new Error(`${q.key} is aligned ${q.h} ${q.v}, not centred`);
        const tb = textBox(q, WIDE(q));
        if (tb.x < L || tb.x + tb.w > R || tb.y < T || tb.y + tb.h > B) throw new Error(`${q.key} "${q.text}" leaves the box (${corner})`);
        lines++;
      }
      eq(overlaps(out).length, 0, `overlapping text (${corner}):`);
      // the longest state the row can show with this setting, wherever it is not showing now, also fits
      for (const key of ["dbState0", "dbState1"]) {
        const q = { ...out.find((z) => z.key === key), text: vwapSlope === "mark" ? "Potentially short (weak)" : "Potentially short" }, tb = textBox(q, WIDE(q));
        if (tb.x < L || tb.x + tb.w > R) throw new Error(`"${q.text}" would leave the box (${corner}, bar counts ${showBars ? "on" : "off"}, vwapSlope ${vwapSlope})`);
      }
    }
    if (lines < 100) throw new Error(`only ${lines} lines checked`);
  });
  t("warnings can be switched off row by row, and a setting saved as on / off still reads", () => {
    for (let k = 40; k < 3000; k += 31) {
      for (const props of [{ emaWarning: "off", macdWarning: false }, { emaWarning: false, macdWarning: false }]) {
        const b = boxAt(k, props);
        for (const key of ["dbState0", "dbState1"]) if (/Potentially/.test(b[key].text)) throw new Error(`${key} warned at ${k}`);
      }
      eq(boxAt(k, { emaWarning: true }).dbState0.text, boxAt(k, {}).dbState0.text, `on reads as the default at ${k}:`);
    }
  });
  t("the EMA row's \"closing at all\" reads any closing gap, as the first version did", () => {
    let differs = 0;
    for (let k = 40; k < BARS.length; k += 47) {
      const j = k - 1, b = boxAt(k, { emaWarning: "closer", updates: "close" });
      eq(b.dbState0.text, expected(hEma, j, j >= 26, "shrink").text, `EMA row at bar ${j}:`);
      if (b.dbState0.text !== boxAt(k, { updates: "close" }).dbState0.text) differs++;
    }
    if (!differs) throw new Error("the two rules never differed");
  });
  t("hand-traced: a gap still closing, but more slowly, is no warning; closing faster is", () => {
    // a bounce in a drop: the gap closes by 2, 3, 2, 1, then 0.5 a bar
    const bounce = [-10, -8, -5, -3, -2, -1.5];
    eq([...databoxRow(bounce, "speed")].join(","), "3,3,4,3,3,3", "speed:");
    eq([...databoxRow(bounce, "shrink")].join(","), "3,4,4,4,4,4", "closing at all:");
    // its mirror, a pullback in a rise
    eq([...databoxRow(bounce.map((x) => -x), "speed")].join(","), "1,1,2,1,1,1", "the mirror:");
    // the gap turning: widening, then closing ever faster
    eq([...databoxRow([-4, -5, -4.5, -3.5, -2, -0.2], "speed")].join(","), "3,3,4,4,4,4", "a turn:");
    // closing at the same speed as the bar before is no warning
    eq([...databoxRow([-6, -5, -3.5, -2], "speed")].join(","), "3,3,4,3", "the same speed:");
  });
  t("hand-traced: momentum slowing warns while the gap still widens, as soon as it moves less than the bar before", () => {
    // the gap moves +3, +2, +1, -1, -2, -1.5 a bar
    const rise = [1, 4, 6, 7, 6, 4, 2.5];
    eq([...databoxRow(rise, "slowing")].join(","), "1,1,2,2,2,2,1", "slowing:");
    eq([...databoxRow(rise, "speed")].join(","), "1,1,1,1,2,2,1", "closing faster, for comparison:");
    eq([...databoxRow(rise.map((x) => -x), "slowing")].join(","), "3,3,4,4,4,4,3", "the mirror:");
    // moving its side's way by the same amount as the bar before is no warning
    eq([...databoxRow([1, 3, 5, 7], "slowing")].join(","), "1,1,1,1", "a steady rise:");
  });
  t("momentum slowing, the EMA row's third choice, reads Tradovate's EMA gap", () => {
    let differs = 0;
    for (let k = 40; k < BARS.length; k += 47) {
      const j = k - 1, b = boxAt(k, { emaWarning: "slowing", updates: "close" });
      eq(b.dbState0.text, expected(hEma, j, j >= 26, "slowing").text, `EMA row at bar ${j}:`);
      if (b.dbState0.text !== boxAt(k, { updates: "close" }).dbState0.text) differs++;
    }
    if (!differs) throw new Error("slowing never differed from the default");
  });
  t("the lab's databox study draws the indicator's states, bar for bar after its warm-up, under each EMA rule", () => {
    // the study on the same bars, as the chart computes it
    const T = { ts: Float64Array.from(BARS, (b) => b.ts), open: Float64Array.from(BARS, (b) => b.o), high: Float64Array.from(BARS, (b) => b.h),
                low: Float64Array.from(BARS, (b) => b.l), close: Float64Array.from(BARS, (b) => b.c), volume: Float64Array.from(BARS, (b) => b.v),
                tday: Int32Array.from(BARS, (b) => b.td), ctMin: Int16Array.from(BARS, (b) => b.ct) };
    const st = STUDIES.databox;
    for (const rule of ["speed", "closer", "slowing"]) {
      const p = { ...Object.fromEntries(st.params.map((d) => [d.key, d.default])), emaRule: rule };
      const lanes = st.compute(T, p).lanes, warm = st.warmup(p);
      // the indicator's own state on every bar
      const run = new Run(box, { props: { emaWarning: rule } }), map = run.calc.map.bind(run.calc), mine = [];
      const code = (r, ready) => (!ready || !r || r.side === 0 ? 0 : r.side === 1 ? (r.warn ? 2 : 1) : r.warn ? 4 : 3);
      run.calc.map = (d, i) => { const out = map(d, i), S = run.calc.st[i]; mine[i] = [code(S.ema, S.emaReady), code(S.macd, S.macdReady)]; return out; };
      run.compute(BARS);
      let seen = new Set();
      for (let i = warm; i < BARS.length; i++) {
        eq(lanes[0].codes[i], mine[i][0], `${rule}: EMA lane on bar ${i}:`);
        eq(lanes[1].codes[i], mine[i][1], `${rule}: MACD lane on bar ${i}:`);
        seen.add(mine[i][0]); seen.add(mine[i][1]);
      }
      eq([...seen].sort().join(","), "1,2,3,4", `${rule}: every state seen:`);
    }
  });
  t("a warning calling the way the RTH VWAP moved over 15 minutes reads \"(weak)\" in grey; hide shows the side; off leaves it", () => {
    // A plain reference RTH VWAP: typical price weighted by volume from 08:30 CT, nothing outside
    // 08:30-15:00. Chicago time comes from each bar's timestamp, as the indicator must work it out
    // in Tradovate (these bars' own `ct` field runs 30 minutes off their January timestamps, so the
    // lab's study, which reads `ct`, cannot be the reference here; on the real 2026 bars the
    // indicator's slope equals the lab's VWAP (RTH) slope on all 50,475 RTH minutes that have one).
    const vw = [];
    { let day = null, pv = 0, vv = 0;
      for (const b of BARS) {
        const local = b.ts - 6 * 3600000, ct = Math.floor(local / 60000) % 1440, d = Math.floor(local / 86400000);   // January: CST
        if (ct < 510 || ct >= 900) { vw.push(NaN); continue; }
        if (d !== day) { day = d; pv = 0; vv = 0; }
        pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v; vw.push(pv / vv);
      } }
    const slope = (j) => (j >= 15 && Number.isFinite(vw[j]) && Number.isFinite(vw[j - 15]) ? Math.sign(vw[j] - vw[j - 15]) : 0);
    const call = (text) => (text === "Potentially short" ? -1 : text === "Potentially long" ? 1 : 0);
    let weak = 0, strong = 0;
    for (let k = 60; k < BARS.length; k += 13) {
      const off = boxAt(k, { vwapSlope: "off" }), mark = boxAt(k, { vwapSlope: "mark" }), hide = boxAt(k, { vwapSlope: "hide" });
      eq(boxAt(k, {}).dbState0.text, off.dbState0.text, `the tests' helper reads off at ${k}:`);
      const dflt = Object.fromEntries(new Run(box, { props: {} }).compute(BARS.slice(0, k + 1))[k].graphics.items.map((it) => [it.key, it]));
      for (const key of ["dbState0", "dbState1"]) {
        eq(dflt[key].text, off[key].text, `off is the default (${key} at ${k}):`);
        const c = call(off[key].text), s = slope(k);
        if (c && s && c === s) {
          eq(mark[key].text, `${off[key].text} (weak)`, `${key} marked at ${k}:`); eq(mark[key].style.fill, "#898781", `${key} grey at ${k}:`);
          eq(hide[key].text, c === -1 ? "Long" : "Short", `${key} hidden at ${k}:`);
          weak++;
        } else {
          eq(mark[key].text, off[key].text, `${key} unmarked at ${k}:`); eq(hide[key].text, off[key].text, `${key} not hidden at ${k}:`);
          if (c) strong++;
        }
      }
    }
    if (weak < 20 || strong < 20) throw new Error(`too few cases: ${weak} weak, ${strong} other warnings`);
  });
  t("the box always draws the same keys, so the platform replaces it", () => {
    const keys = (props) => Object.keys(boxAt(500, props)).sort().join(",");
    eq(keys({ showBars: false }), keys({}));
    for (const corner of ["topRight", "bottomLeft", "bottomRight"]) eq(keys({ corner }), keys({}));
    eq(keys({ updates: "close" }), keys({}));
    eq(keys({}), "dbBars0,dbBars1,dbBox,dbEdge,dbHead,dbLabel0,dbLabel1,dbState0,dbState1");
  });
}

const files = (d) => fs.readdirSync(path.join(VENDOR, d)).filter((f) => f.endsWith(".js"));
const NEEDS = { "07-FourierMA.js": "a DLL the mock has not" };
function runsClean(name, source) {
  const mod = loadIndicator(source, tools);
  const { problems } = audit(mod, source, BARS, { minutes: 1, formingFrom: BARS.length - 300 });
  const bad = problems.filter((p) => p.level === "error");
  if (bad.length) throw new Error(`${name}: ${bad[0].text}`);
}
for (const f of files("builtin")) t(`builtin ${f}`, () => runsClean(f, fs.readFileSync(path.join(VENDOR, "builtin", f), "utf8")));
for (const f of files("examples")) {
  const source = fs.readFileSync(path.join(VENDOR, "examples", f), "utf8");
  if (NEEDS[f]) { console.log(`  --   example ${f}: skipped, ${NEEDS[f]}`); continue; }
  if (!/\bcalculator\b/.test(source)) { console.log(`  --   example ${f}: a drawing tool, not an indicator`); continue; }
  t(`example ${f}`, () => runsClean(f, source));
}
for (const x of listIndicators().mine) t(`ours: ${x.name}`, () => runsClean(x.name, readIndicator(x.name).source));

console.log("\nthe files the chart page needs");
t("every indicator is listed with the chart it is for", () => {
  const { mine, builtin } = listIndicators();
  eq(mine.find((x) => x.name === "mnqDonchian1250").minutes, 2);
  eq(mine.find((x) => x.name === "mnqMacdFade1250").minutes, 1);
  if (!builtin.some((x) => x.name === "builtin:macd")) throw new Error("no builtin:macd");
});
t("a name cannot walk out of the indicator folders", () => {
  for (const bad of ["../../bot/.env", "..\\x", "a/b", ""]) {
    let threw = false;
    try { indicatorFile(bad); } catch { threw = true; }
    if (!threw) throw new Error(`"${bad}" was accepted`);
  }
});
t("the runtime and the drawing imports nothing from Node, so the page can load them", () => {
  for (const f of ["runtime.mjs", "draw.mjs"]) {
    const src = fs.readFileSync(path.join(ROOT, "tradovate", "mock", f), "utf8");
    if (/^import\s/m.test(src) || /\brequire\(["']node:/.test(src)) throw new Error(`${f} imports something`);
  }
});

console.log(`\n${"=".repeat(64)}\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:"); for (const f of failures) console.log("  - " + f); }
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
