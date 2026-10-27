// Stage 2: new books combining EMA, MACD, RSI, ADR and ADX, tuned for the $1,250
// evaluation on 2026.
//
//   node --max-old-space-size=8192 research/combos_1250_new.mjs <trend_pullback|macd_momentum|orb_trend>
//
// Each book's grid is searched on the $1,250 rules, every configuration scored
// for both halves of 2026 (Jan-Mar, Apr-Jul) by both pass-rate methods (calendar
// windows and the bootstrap; research/lib_eval1250.mjs). A half's score is the
// mean of the two methods. Then, because the best of a grid flatters itself:
//   1. PICK ON ONE HALF, READ THE OTHER: the configuration best on Jan-Mar, scored
//      on Apr-Jul, and the reverse; and the same for the top 10 of each half.
//   2. THE CHOICE is the configuration with the best WORST half, and its
//      neighbours (one setting changed) are listed: a lone peak is luck, a
//      plateau is structure.
//   3. THE NULL: the chosen configuration trading coin-flip directions, 20 seeds.
//      A real edge beats every seed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "./lib_eval1250.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const id = process.argv[2];

// A dimension: a name and its values, each a partial {params, exec}.
const P = (k, vals) => [k, vals.map((v) => ({ label: `${k}=${v}`, params: { [k]: v } }))];
const X = (k, vals) => [k, vals.map((v) => ({ label: `${k}=${v}`, exec: { [k]: v } }))];
const C = (k, opts) => [k, opts];

const GRIDS = {
  trend_pullback: [
    P("trigger", ["macdDip", "rsiDip", "rsiTurn"]),
    C("trend", [{ label: "10m 9/21", params: { trendTf: 10, trendFast: 9, trendSlow: 21 } }, { label: "5m 9/21", params: { trendTf: 5, trendFast: 9, trendSlow: 21 } },
                { label: "30m 9/21", params: { trendTf: 30, trendFast: 9, trendSlow: 21 } }, { label: "1m 12/26", params: { trendTf: 1, trendFast: 12, trendSlow: 26 } }]),
    P("adxMin", [0, 20]),
    P("maxAdrUsed", [0, 0.9]),
    P("minVolRatio", [0, 1]),
    P("exitOn", ["macdCross", "bracket"]),
    C("bracket", [{ label: "5/5.15 cap $600", exec: { slAtrMult: 5, tpMode: "atr", tpAtrMult: 5.15, tpMaxUsd: 600 } },
                  { label: "3/1.5", exec: { slAtrMult: 3, tpMode: "atr", tpAtrMult: 1.5, tpMaxUsd: 0 } },
                  { label: "2/2", exec: { slAtrMult: 2, tpMode: "atr", tpAtrMult: 2, tpMaxUsd: 0 } }]),
    X("entryType", ["stop", "market"]),
    P("timeframeMin", [1, 2]),
  ],
  macd_momentum: [
    P("timeframeMin", [2, 5]),
    P("buildBars", [1, 2, 3]),
    P("fadeBars", [0, 3]),
    C("trend", [{ label: "10m 9/21", params: { trendTf: 10 } }, { label: "30m 9/21", params: { trendTf: 30 } }]),
    P("adxMin", [0, 25]),
    P("maxAdrUsed", [0, 0.9]),
    C("bracket", [{ label: "3/2", exec: { slAtrMult: 3, tpMode: "atr", tpAtrMult: 2 } }, { label: "2/1.5", exec: { slAtrMult: 2, tpMode: "atr", tpAtrMult: 1.5 } },
                  { label: "5/1.75", exec: { slAtrMult: 5, tpMode: "atr", tpAtrMult: 1.75 } }]),
    X("entryType", ["market", "stop"]),
  ],
  // The shipped books: every combination of stage 1's near misses
  // (research/combos_1250.mjs), base first.
  donchian_1250: [
    P("adxMin", [25, 20]),
    C("htf", [{ label: "10m 9/21", params: { htfFast: 9, htfSlow: 21 } }, { label: "10m 20/50", params: { htfFast: 20, htfSlow: 50 } }]),
    P("lateRangeUsed", [0.9, 1.1]),
    C("until", [{ label: "until 15:00", filter: { endCt: 900 } }, { label: "until 13:00", filter: { endCt: 780 } }]),
    C("adrCap", [{ label: "no ADR cap" }, { label: "ADR used <= 1.5", studies: [{ type: "adrused", tf: 0, params: { days: 10, hi: 1.5 }, gate: "below" }] }]),
  ],
  macd_fade_1250: [
    C("adrCap", [{ label: "no ADR cap" }, { label: "ADR used <= 0.9", studies: [{ type: "adrused", tf: 0, params: { days: 10, hi: 0.9 }, gate: "below" }] }]),
    P("endCt", [900, 600]),
    C("adx5", [{ label: "no ADX" }, { label: "ADX 5m >= 20", studies: [{ type: "adx", tf: 5, params: { period: 14, lo: 20 }, gate: "above" }] }]),
    X("slAtrMult", [5, 3]),
    P("minVolRatio", [1, 0.8]),
  ],
  orb_trend: [
    P("orMinutes", [5, 15, 30]),
    P("entryEndCt", [600, 720]),
    C("trend", [{ label: "no trend", params: { trendMode: "off" } }, { label: "10m 9/21", params: { trendMode: "with", trendTf: 10 } },
                { label: "30m 9/21", params: { trendMode: "with", trendTf: 30 } }]),
    P("maxOrAdr", [0, 0.4]),
    P("adxMin", [0, 20]),
    C("bracket", [{ label: "3/2", exec: { slAtrMult: 3, tpMode: "atr", tpAtrMult: 2 } }, { label: "2/2", exec: { slAtrMult: 2, tpMode: "atr", tpAtrMult: 2 } },
                  { label: "5/1.75", exec: { slAtrMult: 5, tpMode: "atr", tpAtrMult: 1.75 } }, { label: "1.5/3", exec: { slAtrMult: 1.5, tpMode: "atr", tpAtrMult: 3 } }]),
    P("once", ["first", "perSide"]),
    P("timeframeMin", [1, 2]),
  ],
};
// Settings every configuration of a book shares (on top of its file's defaults).
const FIXED = { orb_trend: { params: { unit: "atr" } } };

const dims = GRIDS[id];
if (!dims) { console.error(`usage: ${Object.keys(GRIDS).join(" | ")}`); process.exit(1); }
const merge = (parts) => {
  const o = { params: { ...(FIXED[id]?.params || {}) }, exec: { ...(FIXED[id]?.exec || {}) }, filter: {}, studies: [] };
  for (const p of parts) {
    Object.assign(o.params, p.params || {}); Object.assign(o.exec, p.exec || {}); Object.assign(o.filter, p.filter || {});
    o.studies.push(...(p.studies || []));
  }
  return o;
};
const combos = dims.reduce((acc, [, vals]) => acc.flatMap((c) => vals.map((v, j) => [...c, j])), [[]]);
console.log(`${id}: ${combos.length} configurations on the $1,250 rules, 2026`);

const half = (r, h) => (h === "A" ? (r.calA + r.bootA) / 2 : (r.calB + r.bootB) / 2);
const worst = (r) => Math.min(half(r, "A"), half(r, "B"));
const t0 = Date.now();
const rows = [];
for (const [k, c] of combos.entries()) {
  const o = merge(c.map((j, d) => dims[d][1][j]));
  const r = await E.evaluate(id, o);
  delete r.cfg;
  rows.push({ idx: c, label: c.map((j, d) => dims[d][1][j].label).join(", "), o, ...r });
  if ((k + 1) % 100 === 0) process.stderr.write(`  ${k + 1}/${combos.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}

const r1 = (x) => Math.round(x * 10) / 10;
const line = (r) => `${r.label}\n        ${E.fmt(r)}  | A ${r1(half(r, "A"))}  B ${r1(half(r, "B"))}`;
const byA = [...rows].sort((p, q) => half(q, "A") - half(p, "A")), byB = [...rows].sort((p, q) => half(q, "B") - half(p, "B"));
const mean = (xs) => r1(xs.reduce((s, x) => s + x, 0) / xs.length);
console.log(`\n1. PICK ON ONE HALF, READ THE OTHER (score = mean of calendar and bootstrap)`);
console.log(`   best on Jan-Mar: ${r1(half(byA[0], "A"))} there -> Apr-Jul ${r1(half(byA[0], "B"))}   (${byA[0].label})`);
console.log(`   best on Apr-Jul: ${r1(half(byB[0], "B"))} there -> Jan-Mar ${r1(half(byB[0], "A"))}   (${byB[0].label})`);
console.log(`   top 10 on Jan-Mar average ${mean(byA.slice(0, 10).map((r) => half(r, "B")))} on Apr-Jul; top 10 on Apr-Jul average ${mean(byB.slice(0, 10).map((r) => half(r, "A")))} on Jan-Mar`);
console.log(`   every configuration: median Jan-Mar ${r1(byA[byA.length >> 1] ? half(byA[byA.length >> 1], "A") : 0)}, median Apr-Jul ${r1(half(byB[byB.length >> 1], "B"))}`);

const byWorst = [...rows].sort((p, q) => worst(q) - worst(p) || (q.cal + q.boot) - (p.cal + p.boot));
console.log(`\n2. BEST WORST HALF (top 8)`);
for (const r of byWorst.slice(0, 8)) console.log(`   ${r1(worst(r))}  ${line(r)}`);
const pick = byWorst[0];
const nb = rows.filter((r) => r.idx.filter((j, d) => j !== pick.idx[d]).length === 1);
console.log(`\n   neighbours of the choice (one setting changed): ${nb.length}, worst-half median ${mean([...nb.map(worst)].sort((p, q) => p - q).slice(nb.length >> 1, (nb.length >> 1) + 1))}, ` +
            `min ${r1(Math.min(...nb.map(worst)))}, max ${r1(Math.max(...nb.map(worst)))}`);
for (const r of [...nb].sort((p, q) => worst(q) - worst(p))) {
  const d = r.idx.findIndex((j, d2) => j !== pick.idx[d2]);
  console.log(`     ${dims[d][0].padEnd(12)} ${dims[d][1][r.idx[d]].label.padEnd(22)} worst half ${r1(worst(r))}  cal ${r.cal}  boot ${r.boot}`);
}

console.log(`\n3. THE NULL: the choice with coin-flip directions`);
const cfg = await E.configOf(id, pick.o);
const nul = E.nullScore(cfg, pick, 20);
console.log(`   real: cal ${pick.cal}% boot ${pick.boot}%   null mean: cal ${nul.cal}% (${nul.calA} / ${nul.calB}) boot ${nul.boot}%   ` +
            `null seeds at or above the real calendar rate: ${nul.atLeastReal} of ${nul.seeds} (best ${nul.best}%)`);

fs.writeFileSync(path.join(HERE, `combos_1250_${id}.json`), JSON.stringify({ id, dims: dims.map(([k, v]) => [k, v.map((x) => x.label)]), pick, null: nul,
  rows: rows.map(({ o, ...r }) => r) }, null, 1));
console.log(`\n(${rows.length} configurations, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
