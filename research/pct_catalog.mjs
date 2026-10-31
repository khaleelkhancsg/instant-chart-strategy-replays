// Every percentage level the study tests. Each comes from src/levels.mjs, so anything
// worth keeping is already what the chart draws.
//
// Families:
//   from settlement   fixed percentages either side of the prior settlement
//   from the open     the same from the RTH open
//   week, month       wider steps from the week's and month's open and last settlement
//   off-grid          percentages nobody would pick, as a control for the round ones
//   ADR               multiples of the average day from settlement and from the open
//   reach             the quantiles of how far recent days reached from settlement
//   conformal         self-correcting bands from settlement
//   noise             the noise area, and the fan of what is normal by this time of day

import { percentLadder, adrLadder, reachLevels, conformalLevels, noiseArea, moveFan } from "../src/levels.mjs";

const FROM = {
  settle: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3],
  rth: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5],
  week: [0.5, 1, 1.5, 2, 2.5, 3, 4, 5], pweek: [0.5, 1, 1.5, 2, 2.5, 3, 4, 5],
  month: [1, 2, 3, 4, 5, 7.5, 10], pmonth: [1, 2, 3, 4, 5, 7.5, 10],
};
const NAME = { settle: "settle", rth: "RTH open", week: "week open", pweek: "last week", month: "month open", pmonth: "last month" };
const OFF_GRID = [0.37, 0.62, 0.87, 1.12, 1.37, 1.62, 1.87];
const both = (name, list, unit = "%") => list.flatMap((p) => [`${name} +${p}${unit}`, `${name} -${p}${unit}`]);

export const PCT_POOLS = {
  "Settlement: half-percent rungs": both("settle", [0.5, 1, 1.5, 2, 2.5, 3]),
  "Settlement: whole percents": both("settle", [1, 2, 3]),
  "Settlement: quarter rungs": both("settle", [0.25, 0.75, 1.25, 1.75]),
  "Settlement: inner, to 0.75%": both("settle", [0.25, 0.5, 0.75]),
  "Settlement: outer, 1.5% on": both("settle", [1.5, 1.75, 2, 2.5, 3]),
  "Settlement: above": FROM.settle.map((p) => `settle +${p}%`),
  "Settlement: below": FROM.settle.map((p) => `settle -${p}%`),
  "Off-grid control": both("off-grid", OFF_GRID),
  "RTH open: half-percent rungs": both("RTH open", [0.5, 1, 1.5, 2, 2.5]),
  "RTH open: quarter rungs": both("RTH open", [0.25, 0.75, 1.25]),
  "Week open: whole percents": both("week open", [1, 2, 3, 4, 5]),
  "Last week: whole percents": both("last week", [1, 2, 3, 4, 5]),
  "Month open: whole percents": both("month open", [1, 2, 3, 4, 5]),
  "Last month: whole percents": both("last month", [1, 2, 3, 4, 5]),
  "ADR from settlement": both("ADR settle", [0.25, 0.5, 0.75, 1, 1.25, 1.5], "x"),
  "ADR from the open": both("ADR open", [0.25, 0.5, 0.75, 1, 1.25, 1.5], "x"),
  "Reach quantiles": [20, 60].flatMap((w) => [50, 75, 90].flatMap((q) => [`reach ${q}% of ${w} up`, `reach ${q}% of ${w} down`])),
  "Conformal bands": [50, 25, 10].flatMap((c) => [`conformal ${c}% up`, `conformal ${c}% down`]),
  "Noise area": [1, 1.5, 2].flatMap((m) => [`noise ${m}x up`, `noise ${m}x down`]),
  "Fan of the normal": [75, 90].flatMap((q) => [`fan ${q}% up`, `fan ${q}% down`]),
};

export function buildPctCatalog(sample) {
  const { b } = sample, out = [];
  const add = (family, tag, s, extra = {}) => out.push({ family, tag, series: [s], ...extra });
  for (const [anchor, list] of Object.entries(FROM)) {
    const step = Math.min(...list) === 0.25 ? 0.25 : 0.5, r = percentLadder(b, { anchor, step, rungs: Math.round(Math.max(...list) / step) });
    for (const p of list) { const k = Math.round(p / step) - 1; add(anchor.includes("settle") ? "from settlement" : anchor === "rth" ? "from the open" : anchor.includes("week") ? "week" : "month", `${NAME[anchor]} +${p}%`, r.up[k]); add(anchor.includes("settle") ? "from settlement" : anchor === "rth" ? "from the open" : anchor.includes("week") ? "week" : "month", `${NAME[anchor]} -${p}%`, r.dn[k]); }
  }
  {
    const r = percentLadder(b, { anchor: "settle", step: 0.01, rungs: 190 });
    for (const p of OFF_GRID) { const k = Math.round(p * 100) - 1; add("off-grid", `off-grid +${p}%`, r.up[k]); add("off-grid", `off-grid -${p}%`, r.dn[k]); }
  }
  const mults = [0.25, 0.5, 0.75, 1, 1.25, 1.5];
  for (const [anchor, name] of [["settle", "ADR settle"], ["rth", "ADR open"]]) {
    const r = adrLadder(b, { anchor, mults });
    mults.forEach((m, k) => { add("ADR", `${name} +${m}x`, r.up[k]); add("ADR", `${name} -${m}x`, r.dn[k]); });
  }
  for (const sessions of [20, 60]) for (const q of [0.5, 0.75, 0.9]) {
    const r = reachLevels(b, { sessions, q, least: Math.min(20, sessions) });
    add("reach", `reach ${q * 100}% of ${sessions} up`, r.up); add("reach", `reach ${q * 100}% of ${sessions} down`, r.dn);
  }
  for (const [miss, name] of [[0.5, 50], [0.25, 25], [0.1, 10]]) {
    const r = conformalLevels(b, { miss });
    add("conformal", `conformal ${name}% up`, r.up); add("conformal", `conformal ${name}% down`, r.dn);
  }
  for (const mult of [1, 1.5, 2]) { const r = noiseArea(b, { mult }); add("noise", `noise ${mult}x up`, r.up); add("noise", `noise ${mult}x down`, r.dn); }
  for (const q of [0.75, 0.9]) { const r = moveFan(b, { q }); add("noise", `fan ${q * 100}% up`, r.up); add("noise", `fan ${q * 100}% down`, r.dn); }
  return out;
}
