// The level study's engine (research/lib_levels.mjs).   node test/levels.test.mjs
//
// Hand-traced touches on bars built for the purpose, and the check that caught this
// engine's worst bug: a line that jumps over price must show no edge on a market with
// nothing in it. Before the fix a 5-minute Supertrend showed +19 on placebo paths and
// read as the best level in the study.

import * as Lab from "../research/lib_levels.mjs";
import { loadBars } from "../src/data.mjs";

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const near = (a, b, tol, m = "") => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${m} expected ${b} +-${tol}, got ${a}`); };

// rows of [high, low, close]; the open does not matter to the scan
function sampleOf(rows) {
  const n = rows.length, f = (k) => Float64Array.from(rows, (r) => r[k]);
  return { b: { high: f(0), low: f(1), close: f(2), ctMin: new Int16Array(n).fill(600) }, trend: new Int8Array(n) };
}
function scan(rows, level, o = {}, R = 10) {
  const s = sampleOf(rows), out = [], series = Array.isArray(level) ? Float64Array.from(level) : null;
  Lab.scanLevel(s, series, series ? 0 : level, o.off ?? 0, 0, rows.length, R, { hold: 60, maxTouches: 4, ...o }, (side, oc, pnl, ct, no, prev, speed, wt, bo, k) => out.push({ side, oc, pnl, no, prev, k, bo }));
  return out;
}
const far = [121, 119, 120];   // well above a level at 100

console.log("\ntouches");
console.log("-------");
t("a bounce: armed far away, traded a tick through, then R back first", () => {
  const e = scan([far, far, [115, 110, 112], [105, 99.5, 101], [108, 100, 107], [111, 104, 110]], 100, { chain: true });
  eq(e.length, 1); eq([e[0].side, e[0].oc, e[0].k], [1, 1, 3]); eq(e[0].pnl, 10);
});
t("a break: R through first, with the cost of a tick", () => {
  const e = scan([far, far, [105, 99.5, 101], [100, 89, 90]], 100, { chain: true });
  eq([e[0].oc, e[0].pnl], [-1, -10.25]);
});
t("a level approached from below is resistance, and the mirror of support", () => {
  const up = [[81, 79, 80], [81, 79, 80], [100.5, 95, 99], [99, 91, 92], [91, 89, 90]];
  const e = scan(up, 100, { chain: true });
  eq([e[0].side, e[0].oc], [-1, 1]);
});
t("the touch bar cannot score a bounce, because one bar cannot say which came first", () => {
  const e = scan([far, far, [112, 99, 111], [109, 105, 106]], 100, { chain: true });
  eq(e[0].oc, 0, "its own high reached the target:");
});
t("but the touch bar can score a break, and a later bar hitting both is a break", () => {
  eq(scan([far, far, [112, 88, 95]], 100, { chain: true })[0].oc, -1);
  eq(scan([far, far, [105, 99, 104], [112, 88, 95]], 100, { chain: true })[0].oc, -1);
});
t("neither inside the hold is unresolved, marked at the last close", () => {
  const e = scan([far, far, [105, 99.5, 102], [103, 96, 97]], 100, { chain: true, hold: 2 });
  eq([e[0].oc, e[0].pnl], [0, -3]);
});
t("price has to come R away before it can touch again", () => {
  const rows = [far, far, [105, 99.5, 101], [111, 104, 110], [111, 104, 108], [105, 99.5, 102], [112, 101, 111]];
  const e = scan(rows, 100);
  eq(e.map((x) => [x.oc, x.no, x.prev]), [[1, 0, 0], [1, 1, 1]]);
});
t("chain stops at the first break; without it the next touch says what came before", () => {
  const rows = [far, far, [105, 99.5, 101], [100, 88, 89], [89, 80, 85], [101, 84, 100.5], [100, 80, 85]];
  eq(scan(rows, 100, { chain: true }).length, 1);
  const e = scan(rows, 100);
  eq(e.map((x) => x.prev), [0, 2]);
  eq(e[1].side, -1, "the broken level, met again from below:");
});
t("the level on a bar is what was known at the close of the bar before", () => {
  const s = [100, 100, 100, 100, 50, 50];
  const e = scan([far, far, [115, 110, 112], [105, 99.5, 101], [108, 100, 107], [111, 104, 110]], s, { chain: true });
  eq(e[0].k, 3, "the level changing on bar 4 cannot change a touch on bar 3:");
});
t("a level that jumps over price is not a touch: nothing traded there", () => {
  const s = [100, 100, 100, 200, 200, 200, 200];
  eq(scan([far, far, far, far, far, far, far], s, { chain: true }), []);
});
t("the same line, jumping, can still be touched once it is armed again from its new side", () => {
  const s = [100, 100, 100, 150, 150, 150, 150];
  const e = scan([far, far, far, far, far, [150.5, 130, 131], [131, 125, 126], [126, 120, 121]], s.concat([150]), { chain: true });
  eq(e.length, 1); eq(e[0].side, -1);
});
t("a side filter, and a twin's offset, do what they say", () => {
  const rows = [far, far, [115, 110, 112], [105, 99.5, 101], [108, 100, 107], [111, 104, 110]];
  eq(scan(rows, 100, { chain: true, side: -1 }), []);
  eq(scan(rows, 95, { chain: true, off: 5 })[0].k, 3);
});

console.log("\nstatistics");
console.log("----------");
t("BH q values, worked by hand", () => {
  const q = Lab.bh([0.01, 0.04, 0.03, 0.2]);
  near(q[0], 0.04, 1e-9); near(q[1], 0.16 / 3, 1e-9); near(q[2], 0.16 / 3, 1e-9); near(q[3], 0.2, 1e-9);
});
t("the normal tail", () => { near(Lab.zToP(1.96), 0.05, 0.001); near(Lab.zToP(2.576), 0.01, 0.001); near(Lab.zToP(-1.96), 0.05, 0.001); near(Lab.zToP(0), 1, 0.001); });
t("calibrating takes out a level's bias, and needs a real distribution to do it", () => {
  const c = Lab.calibrate(10, { mean: 4, sd: 3, paths: 100 });
  near(c.adj, 6, 1e-9); near(c.z, 2, 1e-9);
  eq(Lab.calibrate(10, { mean: 4, sd: 0, paths: 100 }), null); eq(Lab.calibrate(10, null), null); eq(Lab.calibrate(10, { mean: 4, sd: 3, paths: 3 }), null);
});
t("the matched edge compares inside strata, so a mix of sides cannot pass for an edge", () => {
  // Resistance bounces 80% and support 20%, for real levels and twins alike. The real
  // level is all resistance and its twins half each: plainly a +30 edge, matched none.
  const ev = new Lab.Events(), add = (real, side, oc) => ev.push(0, 0, real, side, oc, 0, 600, 0, 0, 0, 0, 0);
  for (let i = 0; i < 100; i++) add(1, -1, i < 80 ? 1 : -1);
  for (let i = 0; i < 100; i++) { add(0, -1, i < 80 ? 1 : -1); add(0, 1, i < 20 ? 1 : -1); }
  const ids = Int32Array.from({ length: ev.n }, (_, i) => i), boot = Lab.bootDays(1, 10);
  near(Lab.edgeOf(ev, ids, 1, boot, 10).edge, 30, 1e-9, "plain:");
  near(Lab.quickEdge(ev, ids).edge, 0, 1e-9, "matched:");
  near(Lab.matchedEdgeOf(ev, ids, 1, boot, 10).edge, 0, 1e-9, "matched, with its interval:");
});

const { bars, meta } = loadBars();
console.log("\nreal bars");
console.log("---------");
t("raw prices: each contract's offset is the rolls still to come", () => {
  eq(Lab.rawOffset(meta, Date.UTC(2026, 1, 2)), 503.5, "on MNQH6:");
  eq(Lab.rawOffset(meta, Date.UTC(2026, 3, 1)), 294.75, "on MNQM6:");
  eq(Lab.rawOffset(meta, Date.UTC(2026, 6, 1)), 0, "on MNQU6:");
});
const sample = Lab.loadSample({ to: Date.UTC(2026, 6, 15) });
t("a placebo path keeps every bar's size and volume, and is its seed's", () => {
  const a = Lab.placeboBars(sample.b, 1), c = Lab.placeboBars(sample.b, 1), d = Lab.placeboBars(sample.b, 2), b = sample.b;
  for (let i = 0; i < 2000; i += 37) {
    near(a.high[i] - a.low[i], b.high[i] - b.low[i], 0.02, "range:");
    near(Math.abs(a.close[i] - a.open[i]), Math.abs(b.close[i] - b.open[i]), 0.02, "body:");
    eq(a.volume[i], b.volume[i]);
    eq(a.close[i], c.close[i], "same seed:");
  }
  if (a.close[5000] === d.close[5000]) throw new Error("two seeds gave one path");
});
t("on a market with nothing in it, a line that flips shows no edge", () => {
  const edges = [];
  for (let p = 0; p < 4; p++) {
    const s = { ...sample, b: Lab.placeboBars(sample.b, 700 + p) };
    const r = Lab.studyLines(s, "supertrend", 5, {}), n = r.up.length, line = new Float64Array(n);
    for (let i = 0; i < n; i++) line[i] = Number.isFinite(r.up[i]) ? r.up[i] : r.down[i];
    const ev = Lab.runLevels(s, [{ tag: "x", series: [line] }], { rFrac: 0.05, twins: 8 });
    edges.push(Lab.quickEdge(ev, Lab.byTag(ev, 1)[0]).edge);
  }
  const mean = edges.reduce((a, x) => a + x, 0) / edges.length;
  if (Math.abs(mean) > 7) throw new Error(`mean edge ${mean.toFixed(1)} on placebo paths (${edges.map((x) => x.toFixed(0))}): a method artifact`);
});

console.log(`\n${"=".repeat(64)}\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:"); for (const f of failures) console.log("  - " + f); }
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
