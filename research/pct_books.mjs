// Can a percentage level be traded? Through the real engine, on the $1,250 eval.
//
//   node --max-old-space-size=8192 research/pct_books.mjs
//
// RESULT ($1,250 eval, calendar, costs in; donchian_1250 is 74.5%, 75.6 / 73.3): nothing
// competes. noise_area at its defaults: 30.9% (51.1 / 6.7), bootstrap 23.4%; none of 36
// settings gets near. 1,476 rules with 20+ trades, 429 net positive, none beats the Donchian
// in both halves. Picking on one half: 88.9% then 54.7%, and 84% then 0%. Best by the worse
// half, 0.25 ADR from the RTH open, retest, R 12%: 59.4% (62.2 / 56), bootstrap 44.8%, neighbours'
// median worse half 22.7%, coin-flip 27.5% (best 38.8), forward -$1,294.
//
// 1. THE NOISE AREA, the one published percentage strategy, as strategies/noise_area.mjs.
// 2. EVERY RULE, as strategies/pct_levels.mjs, so anything here can be opened on the chart:
//    ladders in percent and ADRs from settlement, the open, the week and the month, and the
//    reach, self-correcting, noise and fan bands, each faded, followed, retested and, for
//    a ladder, faded back to its anchor. On the $1,250 book's account, costs in.
//
// The project's protocol: pick on one half and read the other, rank by the worse half, both
// pass-rate methods, the neighbours, the coin-flip twin, and last the forward bars, Sep 11
// - Oct 30, which played no part in any of it.
//
// Writes research/pct_books_results.json.

import fs from "node:fs";
import * as E from "./lib_eval1250.mjs";
import * as P from "./lib_pct.mjs";
import pct from "../strategies/pct_levels.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { loadBars } from "../src/data.mjs";
import { sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { replayWindow, OUTCOME } from "../src/challenge.mjs";

const t0 = Date.now(), DAY = 86400000, L = E.lab, all = L.bars(), from = indexAtOrAfter(all.ts, E.Y26 - 160 * DAY), slice = sliceBars(all, from, all.count);
const base = await E.configOf("donchian_1250"), rules = base.rules;
const fwdBars = loadBars(P.FWD_FILE).bars, FROM = P.FWD_FROM, last = fwdBars.ts[fwdBars.count - 1], starts = [];
for (let s = fwdBars.ts[0] + Math.ceil((FROM - fwdBars.ts[0]) / DAY) * DAY; s + 30 * DAY <= last; s += DAY) starts.push(s);
const calOf = (tr, lo, hi) => L.calendar(tr, rules, L.windowStarts(rules, lo, hi)).pass;
function forward(s, params, exec, filter, studies) {
  const t = runStrategy(fwdBars, s, params, exec, { filter, studies, fromMs: FROM }).trades;
  let net = 0, wins = 0;
  for (const x of t) { net += x.pnl; if (x.pnl > 0) wins++; }
  const passed = starts.filter((w) => replayWindow(t, w, rules).outcome === OUTCOME.PASS).length;
  return { trades: t.length, net: Math.round(net), won: t.length ? Math.round((100 * wins) / t.length) : 0, cal: starts.length ? Math.round((1000 * passed) / starts.length) / 10 : 0, windows: starts.length };
}
const fmtF = (f) => `${f.trades} trades, $${f.net}, ${f.won}% won, ${f.cal}% of ${f.windows} windows`;
const out = {};

// ── what has to be beaten, on the same forward bars ──
{
  const out0 = {};
  for (const id of ["donchian_1250", "macd_fade_1250"]) {
    const r = await E.evaluate(id), f = forward(r.cfg.s, r.cfg.params, r.cfg.exec, r.cfg.filter, r.cfg.studies);
    out0[id] = { cal: r.cal, calA: r.calA, calB: r.calB, ci: r.ci, boot: r.boot, bootA: r.bootA, bootB: r.bootB, trades: r.trades, fwd: f };
    console.log(`${id.padEnd(22)} ${E.fmt(r)}\n${"".padEnd(22)} forward ${fmtF(f)}`);
  }
  out.bases = out0;
}

// ── 1. the noise area ──
console.log(`\nTHE NOISE AREA, $1,250 eval then $3,000 eval, 2026 and forward:`);
const noise = [];
for (const contracts of [1, 2, 3, 4]) for (const mult of [1, 1.5, 2]) for (const every of [15, 30, 60]) {
  const a = await E.evaluate("noise_area", { params: { mult, every }, exec: { contracts } }, "1250"), b = await E.evaluate("noise_area", { params: { mult, every }, exec: { contracts } }, "3000");
  const f = forward(a.cfg.s, a.cfg.params, a.cfg.exec, a.cfg.filter, a.cfg.studies);
  noise.push({ contracts, mult, every, cal: a.cal, calA: a.calA, calB: a.calB, ci: a.ci, boot: a.boot, bootA: a.bootA, bootB: a.bootB, trades: a.trades, net: a.net, pf: a.pf, cal3k: b.cal, boot3k: b.boot, fwd: f });
}
noise.sort((a, b) => Math.min(b.calA, b.calB) - Math.min(a.calA, a.calB));
for (const r of noise.slice(0, 8)) console.log(`  ${r.contracts} lots, ${r.mult}x, every ${String(r.every).padStart(2)}m  cal ${r.cal} (${r.calA} / ${r.calB}) boot ${r.boot}  ${r.trades} tr, $${r.net}, PF ${r.pf}  $3k ${r.cal3k} / ${r.boot3k}  forward ${fmtF(r.fwd)}`);
const netPos = noise.filter((r) => r.net > 0).length;
console.log(`  ${netPos} of ${noise.length} settings made money in 2026; ${noise.filter((r) => r.fwd.net > 0).length} forward.`);
out.noise = noise;

// ── 2. every rule ──
const account = (sl, tp) => ({ ...base.exec, entryType: "market", slAtrMult: sl, tpMode: "atr", tpAtrMult: tp, staleBars: 0, flipOnOpposite: false, flipOnAnySignal: false, tpFromFill: true, atrPeriod: 14 });
const noFilter = { ...base.filter, startCt: 0, endCt: 1440 };
const LADDERS = [["settle", "pct", 0.25, 8], ["settle", "pct", 0.5, 6], ["settle", "pct", 1, 3], ["rth", "pct", 0.25, 6], ["rth", "pct", 0.5, 4], ["rth", "pct", 1, 2],
                 ["week", "pct", 1, 4], ["pweek", "pct", 1, 4], ["month", "pct", 1, 5], ["pmonth", "pct", 1, 5], ["settle", "adr", 0.25, 6], ["settle", "adr", 0.5, 3], ["rth", "adr", 0.25, 6], ["rth", "adr", 0.5, 3]];
const BANDS = [["reach", 0.5], ["reach", 0.75], ["reach", 0.9], ["conformal", 0.5], ["conformal", 0.25], ["conformal", 0.1], ["noise", 1], ["noise", 1.5], ["noise", 2], ["fan", 0.75], ["fan", 0.9]];
const SPECS = [...LADDERS.map(([anchor, unit, step, rungs]) => ({ name: `${step}${unit === "adr" ? "x" : "%"} from ${anchor}`, level: "ladder", anchor, unit, step, rungs })),
               ...BANDS.map(([level, band]) => ({ name: `${level} ${band}`, level, band }))];
const BRACKETS = [[1, 1], [1, 1.5], [1, 2], [0.75, 1.5], [1.5, 1.5], [1.5, 3]], BACK = [[0.5, 1], [1, 1], [1.5, 1]], RS = [0.05, 0.08, 0.12];
const paramsOf = (sp, mode, rFrac) => resolveParams(pct, { ...sp, name: undefined, mode, rFrac, timeframeMin: 1 });
const runIt = (p, sl, tp) => runStrategy(slice, pct, p, account(sl, tp), { filter: noFilter, fromMs: E.Y26 }).trades;
const rows = [];
for (const sp of SPECS) {
  for (const mode of sp.level === "ladder" ? ["fade", "break", "retest", "return"] : ["fade", "break", "retest"]) for (const rFrac of RS) {
    const p = paramsOf(sp, mode, rFrac);
    for (const [sl, tp] of mode === "return" ? BACK : BRACKETS) {
      const tr = runIt(p, sl, tp);
      if (tr.length < 20) continue;
      let net = 0; for (const t of tr) net += t.pnl;
      rows.push({ level: sp.name, mode, rFrac, sl, tp, trades: tr.length, net: Math.round(net), calA: calOf(tr, E.Y26, E.APR), calB: calOf(tr, E.APR, Infinity) });
    }
  }
  console.log(`  ${sp.name}: ${rows.length} so far, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
const worse = (r) => Math.min(r.calA, r.calB), pos = rows.filter((r) => r.net > 0).length;
const name = (r) => `${r.level} ${r.mode} R${Math.round(r.rFrac * 100)}% ${r.sl}/${r.tp}`;
console.log(`\n${rows.length} rules with 20+ trades, ${pos} net positive.`);
const pickA = rows.slice().sort((a, b) => b.calA - a.calA)[0], pickB = rows.slice().sort((a, b) => b.calB - a.calB)[0];
console.log(`Best on Jan-Mar: ${name(pickA)}: ${pickA.calA}% then Apr-Jul ${pickA.calB}%`);
console.log(`Best on Apr-Jul: ${name(pickB)}: ${pickB.calB}% then Jan-Mar ${pickB.calA}%`);
const beat = rows.filter((r) => r.calA > out.bases.donchian_1250.calA && r.calB > out.bases.donchian_1250.calB).length;
console.log(`Beat donchian_1250 in both halves: ${beat}.`);
const top = rows.slice().sort((a, b) => worse(b) - worse(a) || b.net - a.net).slice(0, 12), final = [];
console.log(`\nTop 12 by the worse half:`);
for (const r of top) {
  const sp = SPECS.find((x) => x.name === r.level), p = paramsOf(sp, r.mode, r.rFrac), tr = runIt(p, r.sl, r.tp), sc = E.score(tr, rules);
  const near = rows.filter((x) => x.level === r.level && x.mode === r.mode && x !== r), medianNear = near.length ? near.map(worse).sort((a, b) => a - b)[near.length >> 1] : null;
  const like = { ...base, s: pct, params: p, exec: account(r.sl, r.tp), filter: noFilter }, coins = [];
  for (let k = 1; k <= 12; k++) coins.push(calOf(runStrategy(slice, E.nullCfg(like, k).s, p, account(r.sl, r.tp), { filter: noFilter, fromMs: E.Y26 }).trades, E.Y26, Infinity));
  const f = forward(pct, p, account(r.sl, r.tp), noFilter), coin = P.mean(coins);
  final.push({ ...r, ...sc, medianNear, coin, coinTop: Math.max(...coins), fwd: f });
  console.log(`${name(r).padEnd(38)} ${E.fmt(sc)}\n${"".padEnd(38)} neighbours' median worse half ${medianNear}  coin-flip ${coin.toFixed(1)}% (best ${Math.max(...coins).toFixed(1)})  forward ${fmtF(f)}`);
}
fs.writeFileSync(new URL("./pct_books_results.json", import.meta.url), JSON.stringify({ ...out, rules: rows.length, netPositive: pos, beat, pickA, pickB, final, rows }));
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
