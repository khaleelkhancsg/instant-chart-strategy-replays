// Cammy Capital's value levels (strategies/cammy_value_levels.mjs) through the house protocol.
//
//   node --max-old-space-size=8192 research/cammy_protocol.mjs        (about 30 minutes)
//
// 1. Cammy's rules as the videos state them (the strategy's defaults), on 2026 at the
//    $1,250 and $3,000 evals: both pass-rate methods, both halves, then the controls.
//    - The coin-flip twin (lib_eval1250 nullCfg) is not a fair control for this book. A
//      buy limit flipped is a sell stop at the same price, and on the bar the two fill
//      the engine credits the limit's target where it charges the stop's stop.
//    - Placebo paths are (research/lib_levels.mjs placeboBars): every bar's move turned
//      up-for-down at random, its size, volume and clock kept. They hold no level
//      information, so what the book makes on them is the method's own, and the edge is
//      what the real bars make beyond them.
//    - The fill-bar reading: a limit's target counted on its fill bar only when that bar
//      closed beyond it (exec.limitFillTp "close").
// 2. Each setting -- a call Cammy makes by eye -- in a few versions, one at a time from the
//    defaults, each against the same placebo paths, by half; then the rules the videos fix.
// 3. Selection as the house reads it, on the edge over placebo: the best version on one
//    half read on the other, the best by the worse half, how the halves rank the versions.
// 4. Forward: the defaults and the worse-half pick on everything after the lab's data
//    (data/mnq_1m_beta.bin from 2026-07-15), against placebo paths and the twin.
//
// Costs throughout: a tick a side of slippage (the strategy's default) and $0.75 a side a
// contract.
//
// RESULT (run 2026-11-04): no edge, and no version holds.
//   - Cammy's rules pass 0% of 2026's windows by both methods, at both evals.
//   - They net +$772 in 2026 (168 trades, 60.1% won) and +$705 forward (92 trades, 63%),
//     and no coin-flip twin nets as much. But the placebo paths net +$621 and +$558 the
//     same way: 3 of 10 and 9 of 20 paths net as much.
//   - 76 of the 168 trades took their target on the bar they filled. With that target
//     counted only on a close, the real bars lose $1,710 and the placebo paths $1,715.
//   - Across 41 versions the halves' edges rank at -0.17. Two versions beat all 10 paths,
//     where chance alone gives about 4.
//   - The worse-half pick, an 80-tick stop where no node is behind (+$769 / +$1,026 over
//     placebo), lost to placebo forward: +$783 against +$870, 13 of 20 paths as much.
//   - A POC as an entry even when nothing stacks beat placebo forward: +$1,286 against
//     +$707, 2 of 20 paths as much. It was not the pick, so it is a lead at most.

import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { placeboBars } from "./lib_levels.mjs";
import { Y26, APR, configOf, trades2026, score, nullCfg, forwardScorer, lab as L } from "./lib_eval1250.mjs";

const ID = "cammy_value_levels", PATHS = 10, FWD_PATHS = 20, SEEDS = 20, DAY = 86400000;
const FWD = Date.UTC(2026, 6, 15);

// One compute per configuration and bars: its twins re-run the engine, not the levels.
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

// The bars every version is read on: 2026 with 40 days of warm-up (the strategy asks for
// 21), and the same placebo paths of them for every version.
const B = L.bars(), S26 = sliceBars(B, indexAtOrAfter(B.ts, Y26 - 40 * DAY), B.count);
const P26 = Array.from({ length: PATHS }, (_, k) => placeboBars(S26, k + 1));
const run = (cfg, bars, from, ex = {}) => runStrategy(bars, cfg.s, cfg.params, { ...cfg.exec, ...ex }, { fromMs: from }).trades;

const r1 = (x) => Math.round(x * 10) / 10;
function sums(tr, lo = -Infinity, hi = Infinity) {
  let n = 0, w = 0, net = 0, gw = 0, gl = 0;
  for (const t of tr) {
    if (t.entryTime < lo || t.entryTime >= hi) continue;
    n++; net += t.pnl;
    if (t.pnl > 0) { w++; gw += t.pnl; } else gl -= t.pnl;
  }
  return { n, won: n ? r1((100 * w) / n) : 0, net: Math.round(net), pf: gl > 0 ? Math.round((gw / gl) * 100) / 100 : null };
}
const halves = (tr) => ({ all: sums(tr), a: sums(tr, Y26, APR), b: sums(tr, APR) });
const mean = (xs) => Math.round(xs.reduce((s, x) => s + x, 0) / xs.length);

// A configuration on the real bars and on the placebo paths, by half.
function againstPlacebo(cfg, ex = {}) {
  const real = halves(run(cfg, S26, Y26, ex)), pl = P26.map((pb) => halves(run(cfg, pb, Y26, ex)));
  const pm = { net: mean(pl.map((p) => p.all.net)), a: mean(pl.map((p) => p.a.net)), b: mean(pl.map((p) => p.b.net)),
               won: r1(pl.reduce((s, p) => s + p.all.won, 0) / pl.length) };
  return { real, pm, edge: { all: real.all.net - pm.net, a: real.a.net - pm.a, b: real.b.net - pm.b },
           asMuch: pl.filter((p) => p.all.net >= real.all.net).length };
}
const sgn = (x) => (x >= 0 ? `+${x}` : `${x}`);
const pline = (label, r) =>
  `${label.padEnd(42)} ${String(r.real.all.n).padStart(3)} tr ${r.real.all.won}% won PF ${r.real.all.pf} net ${sgn(r.real.all.net)} (${sgn(r.real.a.net)} / ${sgn(r.real.b.net)})` +
  `  | placebo ${r.pm.won}% won net ${sgn(r.pm.net)} (${sgn(r.pm.a)} / ${sgn(r.pm.b)})  | edge ${sgn(r.edge.all)} (${sgn(r.edge.a)} / ${sgn(r.edge.b)}), ${r.asMuch}/${PATHS} paths as much`;

function twin2026(cfg) {
  const rows = [];
  for (let k = 1; k <= SEEDS; k++) rows.push(score(trades2026(nullCfg(cfg, k)), cfg.rules));
  return rows;
}
const ci = (c) => (c ? `[${c[0]}-${c[1]}]` : "");

// ── 1. the rules as stated ──
console.log(`${ID}: 2026 (trades from Jan 1; halves Jan-Mar / Apr-Jul), ${PATHS} placebo paths, costs included\n`);
console.log("1. Cammy's rules as stated");
for (const [evalId, label] of [["1250", "$1,250 eval, $100 on an A trade"], ["3000", "$3,000 eval, $200 on an A trade"]]) {
  const cfg = await config({}, evalId), r = score(trades2026(cfg), cfg.rules), tw = twin2026(cfg);
  console.log(`   ${label}: pass rate calendar ${r.cal}% (${r.calA} / ${r.calB}) ci95 ${ci(r.ci)}, bootstrap ${r.boot}% (${r.bootA} / ${r.bootB});` +
              ` ${r.trades} trades, ${r.winRate}% won, $${r.perTrade}/trade, PF ${r.pf}, net $${r.net}`);
  console.log(`     coin-flip twin, ${SEEDS} seeds: net ${mean(tw.map((t) => t.net))}, ${r1(tw.reduce((s, t) => s + t.winRate, 0) / SEEDS)}% won,` +
              ` calendar ${r1(tw.reduce((s, t) => s + t.cal, 0) / SEEDS)}%; seeds netting as much: ${tw.filter((t) => t.net >= r.net).length}/${SEEDS}`);
}
const base = await config({});
const b0 = againstPlacebo(base), bClose = againstPlacebo(base, { limitFillTp: "close" });
console.log(`\n   against placebo paths ($1,250 eval)          trades, won, PF, net (Jan-Mar / Apr-Jul)  | placebo mean  | edge = real - placebo`);
console.log(pline("   the engine's reading", b0));
console.log(pline("   a limit's fill-bar target only on a close", bClose));
const fb = run(base, S26, Y26).filter((t) => t.exitIdx === t.entryIdx && t.reason === "TP").length;
console.log(`   targets credited on the bar the order filled: ${fb} of ${b0.real.all.n} trades`);

// ── 2. each setting in a few versions ──
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
console.log(`\n2. Each setting, one at a time from the defaults ($1,250 eval, the engine's reading)`);
const rows = [{ key: "defaults", label: "Cammy's rules", o: {}, ...b0 }];
console.log(pline("Cammy's rules", b0));
for (const [key, label, o] of VERSIONS) {
  const r = againstPlacebo(await config(o));
  rows.push({ key, label, o, ...r });
  console.log(pline(label, r));
}
console.log("\n   The rules the videos fix, for scale");
for (const [, label, o] of FIXED) console.log(pline(label, againstPlacebo(await config(o))));

// ── 3. selection, on the edge over placebo ──
const by = (f) => rows.reduce((b, r) => (f(r) > f(b) ? r : b));
const rank = (v) => { const ix = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]), out = new Array(v.length); ix.forEach(([, i], k) => (out[i] = k)); return out; };
const spearman = (a, b) => { const ra = rank(a), rb = rank(b), n = a.length; let d = 0; for (let i = 0; i < n; i++) d += (ra[i] - rb[i]) ** 2; return 1 - (6 * d) / (n * (n * n - 1)); };
const bestA = by((r) => r.edge.a), bestB = by((r) => r.edge.b), bestW = by((r) => Math.min(r.edge.a, r.edge.b));
const clear = rows.filter((r) => r.asMuch === 0);
console.log(`\n3. Selection over the defaults and ${VERSIONS.length} versions, on the edge over placebo ($)`);
console.log(`   best on Jan-Mar: ${bestA.label}: ${sgn(bestA.edge.a)}, then Apr-Jul ${sgn(bestA.edge.b)} (the defaults ${sgn(b0.edge.b)})`);
console.log(`   best on Apr-Jul: ${bestB.label}: ${sgn(bestB.edge.b)}, then Jan-Mar ${sgn(bestB.edge.a)} (the defaults ${sgn(b0.edge.a)})`);
console.log(`   best by the worse half: ${bestW.label}: ${sgn(bestW.edge.a)} / ${sgn(bestW.edge.b)}`);
for (const r of rows.filter((x) => x.key === bestW.key && x !== bestW)) console.log(`     its neighbour ${r.label}: ${sgn(r.edge.a)} / ${sgn(r.edge.b)}`);
console.log(`   the halves' rank correlation across versions: ${spearman(rows.map((r) => r.edge.a), rows.map((r) => r.edge.b)).toFixed(2)}`);
console.log(`   versions no placebo path matched: ${clear.length} of ${rows.length} (chance alone gives about ${r1(rows.length / (PATHS + 1))})` +
            `${clear.length ? `: ${clear.map((r) => r.label).join("; ")}` : ""}`);

// ── 4. forward ──
const FB = loadBars("data/mnq_1m_beta.bin").bars, F = forwardScorer(FB, FWD);
const SF = sliceBars(FB, indexAtOrAfter(FB.ts, FWD - 40 * DAY), FB.count);
const PF = Array.from({ length: FWD_PATHS }, (_, k) => placeboBars(SF, k + 1));
console.log(`\n4. Forward, ${new Date(FWD).toISOString().slice(0, 10)} to ${new Date(F.last).toISOString().slice(0, 10)}: ${F.days.length} trading days,` +
            ` ${F.starts.length} calendar windows, ${FWD_PATHS} placebo paths`);
const fwd = [["Cammy's rules, $1,250 eval", {}, "1250"], ["Cammy's rules, $3,000 eval", {}, "3000"]];
if (bestW !== rows[0]) fwd.push([`the worse-half pick: ${bestW.label}`, bestW.o, "1250"]);
for (const r of clear) if (r !== bestW && r !== rows[0]) fwd.push([`no placebo path matched it: ${r.label}`, r.o, "1250"]);
for (const [label, o, evalId] of fwd) {
  const cfg = await config(o, evalId), trades = run(cfg, SF, FWD), r = F.score(trades, cfg.rules);
  const pl = PF.map((pb) => sums(run(cfg, pb, FWD)));
  const tw = Array.from({ length: SEEDS }, (_, k) => sums(run(nullCfg(cfg, k + 1), SF, FWD)));
  console.log(`${label.padEnd(42)} ${r.trades} tr  ${r.winRate}% won  PF ${r.pf}  net ${sgn(r.net)}  | pass rate calendar ${r.cal}%, real ${r.real}%, bootstrap ${r.boot}%`);
  console.log(`${"".padEnd(42)} placebo: ${r1(pl.reduce((s, p) => s + p.won, 0) / FWD_PATHS)}% won, net ${sgn(mean(pl.map((p) => p.net)))};` +
              ` paths netting as much ${pl.filter((p) => p.net >= r.net).length}/${FWD_PATHS}  | twin net ${sgn(mean(tw.map((t) => t.net)))}`);
}
