// Cammy Capital's value levels (strategies/cammy_value_levels.mjs) through the house protocol.
//
//   node --max-old-space-size=8192 research/cammy_protocol.mjs        (about 40 minutes)
//
// 1. The defaults on 2026 at the $1,250 and $3,000 evals: both pass-rate methods, both
//    halves (Jan-Mar / Apr-Jul), and three controls.
//    - The coin-flip twin (lib_eval1250 nullCfg) is not a fair control for this book. A
//      buy limit flipped is a sell stop at the same price, and on the bar the two fill
//      the engine credits the limit's target where it charges the stop's stop.
//    - Placebo paths are the fair one (research/lib_levels.mjs placeboBars): every bar's
//      move turned up-for-down at random, its size, volume and clock kept. They hold no
//      level information, so what the book does on them is the method's own, and the
//      edge is what the real bars do beyond them.
//    - The fill-bar reading: a limit's target counted on its fill bar only when that bar
//      closed beyond it (exec.limitFillTp "close").
// 2. Size (params.sizeX): Cammy's risk, 10% of the drawdown on an A trade, and multiples
//    of it, on the real bars and the placebo paths, in 2026 and forward.
// 3. Each setting -- a call Cammy makes by eye -- in a few versions, one at a time from the
//    defaults, each against the same placebo paths, by half; then the rules the videos fix.
// 4. Selection as the house reads it, on the pass rate over placebo: the best version on
//    one half read on the other, the best by the worse half, how the halves rank them.
// 5. Forward: the defaults, the worse-half pick and every version no placebo path matched,
//    on everything after the lab's data (data/mnq_1m_beta.bin from 2026-07-15).
//
// Costs throughout: a tick a side of slippage (the strategy's default) and $0.75 a side a
// contract. Pass rates are calendar windows (the chart's sweep) unless named bootstrap.
//
// RESULT (run 2026-11-04, the $1,250 eval at 5x Cammy's risk): no edge, and one lead.
//   - 2026: passes 34.5% (40 / 28), bootstrap 33.6%; placebo paths pass 31.8% and 3 of 10
//     pass as often. Forward: 42.9% against 36.2%, 7 of 20 paths as often.
//   - Size: at 1x (Cammy's) no window ends; the pass rate climbs with size on the real bars
//     and the placebo paths alike, to about 48% for both at 8-10x.
//   - 76 of the 168 trades took their target on the bar they filled. With that target
//     counted only on a close, the book passes 0.6% and the placebo paths 3.7%.
//   - Across 41 versions the halves' edges over placebo rank at 0.12; 3 beat all 10 paths,
//     where chance alone gives about 4. The worse-half pick, an 80-tick stop where no node is
//     behind, passed 53.2% forward against 34.6% (4 of 20 as often) but netted less.
//   - A POC as an entry even when nothing stacks: 52.7% in 2026 against 29.2%, both halves
//     above; forward 80.5% against 44.9%, 2 of 20 paths as often. Not the pick: a lead.

import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { Y26, APR, configOf, trades2026, score, nullCfg, forwardScorer, lab as L } from "./lib_eval1250.mjs";

const ID = "cammy_value_levels", PATHS = 10, FWD_PATHS = 20, SEEDS = 20, DAY = 86400000;
const FWD = Date.UTC(2026, 6, 15), SIZES = [1, 2, 3, 4, 5, 6, 8, 10];

// One compute per configuration and bars: its twins and sizes re-run the engine, not the levels.
function memo(s) {
  let key = null, out = null;
  return { ...s, compute(b, p) {
    const k = `${b.ts[0]}|${b.ts[b.ts.length - 1]}|${b.ts.length}|${b.close[0]}|${b.close[b.close.length - 1]}|${JSON.stringify(p)}`;
    if (k !== key) { out = null; out = s.compute(b, p); key = k; }
    return out;
  } };
}
async function config(o, evalId = "1250") {
  const cfg = await configOf(ID, o, evalId);
  return { ...cfg, s: memo(cfg.s) };
}
const SX = (await config({})).params.sizeX;

// The bars every version is read on: 2026 with 40 days of warm-up (the strategy asks for
// 21), and the same placebo paths of them for every version.
const B = L.bars(), S26 = sliceBars(B, indexAtOrAfter(B.ts, Y26 - 40 * DAY), B.count);
const P26 = Array.from({ length: PATHS }, (_, k) => placeboBars(S26, k + 1));
const FB = loadBars("data/mnq_1m_beta.bin").bars, F = forwardScorer(FB, FWD);
const SF = sliceBars(FB, indexAtOrAfter(FB.ts, FWD - 40 * DAY), FB.count);
const PF = Array.from({ length: FWD_PATHS }, (_, k) => placeboBars(SF, k + 1));
const run = (cfg, bars, from, ex = {}) => runStrategy(bars, cfg.s, cfg.params, { ...cfg.exec, ...ex }, { fromMs: from }).trades;

const r1 = (x) => Math.round(x * 10) / 10;
const mean = (xs) => r1(xs.reduce((s, x) => s + x, 0) / xs.length);
const sgn = (x) => (x >= 0 ? `+${x}` : `${x}`);
const ci = (c) => (c ? `[${c[0]}-${c[1]}]` : "");
let R = null, ST = null, STA = null, STB = null;
const grid = (rules) => { R = rules; ST = L.windowStarts(R, Y26, Infinity); STA = L.windowStarts(R, Y26, APR); STB = L.windowStarts(R, APR, Infinity); };
grid((await config({})).rules);

// One run in 2026: its net by half and its calendar windows by half.
function read26(tr) {
  let n = 0, w = 0, net = 0, a = 0, b = 0;
  for (const t of tr) { n++; net += t.pnl; if (t.pnl > 0) w++; if (t.entryTime < APR) a += t.pnl; else b += t.pnl; }
  const c = L.calendar(tr, R, ST);
  return { n, won: n ? r1((100 * w) / n) : 0, net: Math.round(net), a: Math.round(a), b: Math.round(b),
           pass: c.pass, fail: c.fail, open: c.open, passA: L.calendar(tr, R, STA).pass, passB: L.calendar(tr, R, STB).pass };
}
function againstPlacebo(cfg, ex = {}) {
  const real = read26(run(cfg, S26, Y26, ex)), pl = P26.map((pb) => read26(run(cfg, pb, Y26, ex)));
  const pm = { pass: mean(pl.map((p) => p.pass)), passA: mean(pl.map((p) => p.passA)), passB: mean(pl.map((p) => p.passB)),
               fail: mean(pl.map((p) => p.fail)), open: mean(pl.map((p) => p.open)), net: Math.round(mean(pl.map((p) => p.net))),
               won: mean(pl.map((p) => p.won)) };
  return { real, pm, edge: { all: r1(real.pass - pm.pass), a: r1(real.passA - pm.passA), b: r1(real.passB - pm.passB) },
           asOften: pl.filter((p) => p.pass >= real.pass).length };
}
const pline = (label, r) =>
  `${label.padEnd(42)} ${String(r.real.n).padStart(3)} tr ${r.real.won}% won net ${sgn(r.real.net)}  pass ${r.real.pass}% (${r.real.passA} / ${r.real.passB}), ` +
  `fail ${r.real.fail}%  | placebo ${r.pm.won}% won net ${sgn(r.pm.net)} pass ${r.pm.pass}% (${r.pm.passA} / ${r.pm.passB}), fail ${r.pm.fail}%` +
  `  | edge ${sgn(r.edge.all)} (${sgn(r.edge.a)} / ${sgn(r.edge.b)}), ${r.asOften}/${PATHS} paths pass as often`;

// ── 1. the defaults ──
console.log(`${ID}: 2026 (windows from Jan 1; halves Jan-Mar / Apr-Jul), ${PATHS} placebo paths, costs included\n`);
console.log(`1. The defaults: Cammy's rules at ${SX} x Cammy's risk`);
for (const [evalId, label] of [["1250", "$1,250 eval"], ["3000", "$3,000 eval"]]) {
  const cfg = await config({}, evalId), tr = trades2026(cfg), r = score(tr, cfg.rules), c = L.calendar(tr, cfg.rules, L.windowStarts(cfg.rules, Y26, Infinity));
  const tw = Array.from({ length: SEEDS }, (_, k) => score(trades2026(nullCfg(cfg, k + 1)), cfg.rules));
  console.log(`   ${label}: pass ${r.cal}% (${r.calA} / ${r.calB}) ci95 ${ci(r.ci)}, fail ${c.fail}%, out of time ${c.open}%; bootstrap ${r.boot}% (${r.bootA} / ${r.bootB});` +
              ` ${r.trades} trades, ${r.winRate}% won, $${r.perTrade}/trade, PF ${r.pf}, net $${r.net}`);
  console.log(`     coin-flip twin, ${SEEDS} seeds: pass ${mean(tw.map((t) => t.cal))}%, net ${Math.round(mean(tw.map((t) => t.net)))}; seeds passing as often: ${tw.filter((t) => t.cal >= r.cal).length}/${SEEDS}`);
}
const base = await config({});
const b0 = againstPlacebo(base), bClose = againstPlacebo(base, { limitFillTp: "close" });
console.log(`\n   against placebo paths ($1,250 eval)          trades, won, net, pass (Jan-Mar / Apr-Jul), fail | placebo mean | edge = real - placebo, points`);
console.log(pline("   the engine's reading", b0));
console.log(pline("   a limit's fill-bar target only on a close", bClose));
const fb = run(base, S26, Y26).filter((t) => t.exitIdx === t.entryIdx && t.reason === "TP").length;
console.log(`   targets credited on the bar the order filled: ${fb} of ${b0.real.n} trades`);

// ── 2. size ──
console.log(`\n2. Size: multiples of Cammy's risk ($1,250 eval: $100 on an A trade, $50 on B, $25 on C; 20 contracts at most)`);
async function sizes(bars, paths, from, starts) {
  const cfg = await config({ params: { sizeX: 1 } }), risk = cfg.exec.riskDollars;
  // a run of each path at every size; under risk sizing a size multiple is the risk's
  const at = (b) => SIZES.map((k) => { const tr = run(cfg, b, from, { riskDollars: risk * k }); return { c: L.calendar(tr, R, starts), lots: tr.length ? tr.reduce((s, t) => s + t.contracts, 0) / tr.length : 0 }; });
  const real = at(bars), pl = paths.map((pb) => at(pb));
  SIZES.forEach((k, j) => {
    const c = real[j].c, ps = pl.map((p) => p[j].c);
    console.log(`   x${String(k).padEnd(3)} ${r1(real[j].lots).toString().padStart(4)} lots/trade | real pass ${c.pass}%, fail ${c.fail}%, out of time ${c.open}%` +
                ` | placebo pass ${mean(ps.map((p) => p.pass))}%, fail ${mean(ps.map((p) => p.fail))}%, out of time ${mean(ps.map((p) => p.open))}%;` +
                ` ${ps.filter((p) => p.pass >= c.pass).length}/${paths.length} paths pass as often`);
  });
}
console.log(`   2026, ${ST.length} calendar windows`);
await sizes(S26, P26, Y26, ST);
console.log(`   forward, Jul 15 - Oct 30, ${F.starts.length} calendar windows`);
await sizes(SF, PF, FWD, F.starts);

// ── 3. each setting in a few versions ──
const P = (params) => ({ params }), X = (exec) => ({ exec });
const VERSIONS = [
  ["sideRule", "side: where the developing POC moved", P({ sideRule: "migration" })],
  ["sideRule", "side: both, neither against it", P({ sideRule: "both" })],
  ["sideRule", "side: off, both sides", P({ sideRule: "off" })],
  ["acceptMin", "held / failed: 15 minutes", P({ acceptMin: 15 })],
  ["acceptMin", "held / failed: 60 minutes", P({ acceptMin: 60 })],
  ["migTicks", "developing POC moved, 8 ticks", P({ sideRule: "migration", migTicks: 8 })],
  ["migTicks", "developing POC moved, 32 ticks", P({ sideRule: "migration", migTicks: 32 })],
  ["nodeVeto", "no node veto", P({ nodeVeto: "off" })],
  ["vetoTicks", "node in front within 20 ticks", P({ vetoTicks: 20 })],
  ["vetoTicks", "node in front within 80 ticks", P({ vetoTicks: 80 })],
  ["nodeSmooth", "nodes smoothed 2 ticks either side", P({ nodeSmooth: 2 })],
  ["nodeSmooth", "nodes smoothed 8 ticks either side", P({ nodeSmooth: 8 })],
  ["nodeLevel", "a node at 40% of the POC's volume", P({ nodeLevel: 0.4 })],
  ["nodeLevel", "a node at 80% of the POC's volume", P({ nodeLevel: 0.8 })],
  ["stopRule", "stop: fixed, behind the stack", P({ stopRule: "fixed" })],
  ["stopTicks", "stop with no node: 32 ticks", P({ stopTicks: 32 })],
  ["stopTicks", "stop with no node: 80 ticks", P({ stopTicks: 80 })],
  ["stopBuffer", "stop 0 ticks beyond the node", P({ stopBuffer: 0 })],
  ["stopBuffer", "stop 6 ticks beyond the node", P({ stopBuffer: 6 })],
  ["minStopTicks", "stop at least 16 ticks", P({ minStopTicks: 16 })],
  ["minStopTicks", "stop at least 40 ticks", P({ minStopTicks: 40 })],
  ["maxStopTicks", "stop at most 100 ticks", P({ maxStopTicks: 100 })],
  ["maxStopTicks", "stop at most 240 ticks", P({ maxStopTicks: 240 })],
  ["pocEntry", "a POC always an entry", P({ pocEntry: "always" })],
  ["pocEntry", "a POC never an entry", P({ pocEntry: "never" })],
  ["devEdges", "developing edges always levels", P({ devEdges: "always" })],
  ["devEdges", "developing edges never levels", P({ devEdges: "off" })],
  ["balancePct", "balanced: value area 50% of the range", P({ balancePct: 50 })],
  ["balancePct", "balanced: value area 70% of the range", P({ balancePct: 70 })],
  ["countNodes", "a node at the level does not grade", P({ countNodes: "off" })],
  ["countContext", "the side agreeing does not grade", P({ countContext: "off" })],
  ["minGrade", "grade B and up", P({ minGrade: "B" })],
  ["minGrade", "grade A only", P({ minGrade: "A" })],
  ["stackTicks", "stacked within 8 ticks", P({ stackTicks: 8 })],
  ["stackTicks", "stacked within 32 ticks", P({ stackTicks: 32 })],
  ["rrCheck", "no R:R check", P({ rrCheck: "off" })],
  ["target", "target: the opposing level", P({ target: "opposing" })],
  ["formingWait", "first 30 minutes: nothing trades", P({ formingWait: "all" })],
  ["sessions", "overnight only", P({ sessions: "overnight" })],
  ["sessions", "New York only", P({ sessions: "ny" })],
  ["overnightStart", "overnight profile from 16:00", P({ overnightStart: "close" })],
];
const FIXED = [
  ["rows", "rows: 500", P({ rows: 500 })],
  ["rows", "rows: 2000", P({ rows: 2000 })],
  ["day", "no one-win / two-loss day rule", X({ dayMaxWins: 0, dayMaxLosses: 0 })],
];
console.log(`\n3. Each setting, one at a time from the defaults ($1,250 eval, ${SX} x Cammy's risk, the engine's reading)`);
const rows = [{ key: "defaults", label: "the defaults", o: {}, ...b0 }];
console.log(pline("the defaults", b0));
for (const [key, label, o] of VERSIONS) {
  const r = againstPlacebo(await config(o));
  rows.push({ key, label, o, ...r });
  console.log(pline(label, r));
}
console.log("\n   The rules the videos fix, for scale");
for (const [, label, o] of FIXED) console.log(pline(label, againstPlacebo(await config(o))));

// ── 4. selection, on the pass rate over placebo ──
const by = (f) => rows.reduce((b, r) => (f(r) > f(b) ? r : b));
const rank = (v) => { const ix = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]), out = new Array(v.length); ix.forEach(([, i], k) => (out[i] = k)); return out; };
const spearman = (a, b) => { const ra = rank(a), rb = rank(b), n = a.length; let d = 0; for (let i = 0; i < n; i++) d += (ra[i] - rb[i]) ** 2; return 1 - (6 * d) / (n * (n * n - 1)); };
const bestA = by((r) => r.edge.a), bestB = by((r) => r.edge.b), bestW = by((r) => Math.min(r.edge.a, r.edge.b));
const clear = rows.filter((r) => r.asOften === 0);
console.log(`\n4. Selection over the defaults and ${VERSIONS.length} versions, on the pass rate over placebo (points)`);
console.log(`   best on Jan-Mar: ${bestA.label}: ${sgn(bestA.edge.a)}, then Apr-Jul ${sgn(bestA.edge.b)} (the defaults ${sgn(b0.edge.b)})`);
console.log(`   best on Apr-Jul: ${bestB.label}: ${sgn(bestB.edge.b)}, then Jan-Mar ${sgn(bestB.edge.a)} (the defaults ${sgn(b0.edge.a)})`);
console.log(`   best by the worse half: ${bestW.label}: ${sgn(bestW.edge.a)} / ${sgn(bestW.edge.b)}`);
for (const r of rows.filter((x) => x.key === bestW.key && x !== bestW)) console.log(`     its neighbour ${r.label}: ${sgn(r.edge.a)} / ${sgn(r.edge.b)}`);
console.log(`   the halves' rank correlation across versions: ${spearman(rows.map((r) => r.edge.a), rows.map((r) => r.edge.b)).toFixed(2)}`);
console.log(`   versions no placebo path passed as often as: ${clear.length} of ${rows.length} (chance alone gives about ${r1(rows.length / (PATHS + 1))})` +
            `${clear.length ? `: ${clear.map((r) => r.label).join("; ")}` : ""}`);

// ── 5. forward ──
console.log(`\n5. Forward, ${new Date(FWD).toISOString().slice(0, 10)} to ${new Date(F.last).toISOString().slice(0, 10)}: ${F.days.length} trading days,` +
            ` ${F.starts.length} calendar windows, ${FWD_PATHS} placebo paths`);
const fwd = [["the defaults, $1,250 eval", {}, "1250"], ["the defaults, $3,000 eval", {}, "3000"]];
if (bestW !== rows[0]) fwd.push([`the worse-half pick: ${bestW.label}`, bestW.o, "1250"]);
for (const r of clear) if (r !== bestW && r !== rows[0]) fwd.push([`no placebo path matched it: ${r.label}`, r.o, "1250"]);
for (const [label, o, evalId] of fwd) {
  const cfg = await config(o, evalId), tr = run(cfg, SF, FWD), r = F.score(tr, cfg.rules), c = L.calendar(tr, cfg.rules, F.starts);
  const pl = PF.map((pb) => { const t = run(cfg, pb, FWD); return { ...F.score(t, cfg.rules), fail: L.calendar(t, cfg.rules, F.starts).fail }; });
  const tw = Array.from({ length: SEEDS }, (_, k) => F.score(run(nullCfg(cfg, k + 1), SF, FWD), cfg.rules));
  console.log(`${label.padEnd(42)} ${r.trades} tr  ${r.winRate}% won  PF ${r.pf}  net ${sgn(r.net)}  | pass ${r.cal}%, fail ${c.fail}%, out of time ${c.open}%;` +
              ` consecutive ${r.real}%, bootstrap ${r.boot}%`);
  console.log(`${"".padEnd(42)} placebo: pass ${mean(pl.map((p) => p.cal))}%, fail ${mean(pl.map((p) => p.fail))}%, net ${sgn(Math.round(mean(pl.map((p) => p.net))))};` +
              ` paths passing as often ${pl.filter((p) => p.cal >= r.cal).length}/${FWD_PATHS}  | twin pass ${mean(tw.map((t) => t.cal))}%, net ${sgn(Math.round(mean(tw.map((t) => t.net))))}`);
}
