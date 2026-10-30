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
t("a Container moves its children, and origin measures px from a corner", () => {
  const txt = { tag: "Text", key: "t", point: { x: du(150), y: du(150) }, text: "abc", style: { fontSize: 10 }, textAlignment: "none" };
  const moved = prim({ tag: "Container", key: "c", children: [txt], transformOps: [{ tag: "Translate", vector: { x: px(7), y: px(0) } }] })[0];
  near(moved.x, A.x.pos(150) + 7);
  const corner = prim({ ...txt, point: { x: px(20), y: px(10) }, origin: { cs: "grid", h: "right", v: "bottom" } })[0];
  near(corner.x, 980); near(corner.y, 490);
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
