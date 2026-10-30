// A check of a Tradovate indicator, from the command line.
//
//   npm run mock -- <indicator> [--date YYYY-MM-DD] [--tf M] [--set k=v]
//
//   npm run mock -- mnqDonchian1250 --date 2026-03-10
//   npm run mock -- mnqOrbBot --set showLabels=false
//   npm run mock -- builtin:macd
//
// Runs it on real bars with the same runtime the chart uses, and prints what it
// drew, what would go wrong on the platform, how its labels fit on a day at screen
// width, and the link that opens it on the backtester's chart (node server.mjs).
//
//   --date     the day to look at (default: the busiest of the last ten)
//   --tf       chart minutes (default: read from the indicator's header)
//   --warmup   sessions of history before that day (default 14)
//   --set      a setting, repeatable
//   --bin      another bar file (data/topstepx_1m.bin: Aug-Oct 2026)
//   --json     the report as JSON

import { pathToFileURL } from "node:url";
import { resample } from "../../src/resample.mjs";
import { audit, loadIndicator, Run, defaultProps, fieldsOf } from "./runtime.mjs";
import { graphicsPrims, overlaps, paneAxes, fieldRange } from "./draw.mjs";
import { listIndicators, loadTools, readIndicator } from "./library.mjs";

const DAY = 86400000, RTH_FROM = 495, RTH_TO = 915;

function daysOf(T) {
  const out = [];
  for (let i = 0; i < T.close.length; i++) if (!i || T.tday[i] !== T.tday[i - 1]) out.push({ td: T.tday[i], first: i });
  return out;
}

function barRows(T, a, b) {
  const out = new Array(b - a);
  for (let i = a; i < b; i++) out[i - a] = { ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] };
  return out;
}

// The day with the most drawn on it, among the last ten of `rows`.
function busiestDay(rows, run) {
  const count = new Map();
  rows.forEach((b, i) => {
    const g = run.rows[i] && run.rows[i].graphics;
    if (b.ct >= 510 && b.ct < 900) count.set(b.td, (count.get(b.td) || 0) + (g && g.items ? g.items.length : 0) + 0.001);
  });
  const days = [...count.keys()].slice(-10);
  return days.reduce((a, d) => (count.get(d) > count.get(a) ? d : a), days[days.length - 1]);
}

// How a day reads at screen width: the labels, and which print over each other.
function legibility(mod, run, rows, td, width = 1300) {
  const inDay = (b) => b && b.td === td && b.ct >= RTH_FROM && b.ct <= RTH_TO;
  const a = rows.findIndex(inDay);
  let b = a;
  while (inDay(rows[b + 1])) b++;
  let lo = Infinity, hi = -Infinity;
  for (let i = a; i <= b; i++) { lo = Math.min(lo, rows[i].l); hi = Math.max(hi, rows[i].h); }
  [lo, hi] = fieldRange(run.rows, fieldsOf(mod), a, b, lo, hi);
  const barW = width / (b - a + 8);
  const A = paneAxes({ left: 0, right: width, top: 0, bottom: 640, first: a - 4, barW, lo: lo - (hi - lo) * 0.06, hi: hi + (hi - lo) * 0.06 });
  const prims = graphicsPrims(run.rows, A, a, b), clash = overlaps(prims);
  return { barW: Math.round(barW * 10) / 10, labels: prims.filter((p) => p.t === "text").length, overlapping: clash.length,
           examples: clash.slice(0, 4).map(([x, y]) => [x.text, y.text]) };
}

function census(run, a, b) {
  const items = {};
  const walk = (it) => { items[it.tag] = (items[it.tag] || 0) + 1; for (const c of it.children || []) walk(c); };
  for (let i = a; i <= b; i++) { const g = run.rows[i] && run.rows[i].graphics; if (g && g.items) g.items.forEach(walk); }
  return items;
}

export function checkIndicator({ name, bars1m, date, tf, warmup = 14, set = {} }) {
  const { source, minutes: own } = readIndicator(name);
  const minutes = tf || own, T = resample(bars1m, minutes), days = daysOf(T);
  const mod = loadIndicator(source, loadTools()), props = { ...defaultProps(mod), ...set };

  let at;
  if (date) {
    const want = Math.floor(Date.parse(date) / DAY);
    at = days.findLastIndex((d) => d.td <= want);
    if (at < 0) throw new Error(`no data on or before ${date}`);
  } else {
    const rows = barRows(T, days[Math.max(0, days.length - warmup - 10)].first, T.close.length);
    const run = new Run(mod, { props, minutes });
    run.compute(rows);
    at = days.findIndex((d) => d.td === busiestDay(rows, run));
  }
  const a = days[Math.max(0, at - warmup)].first, b = at + 2 < days.length ? days[at + 2].first : T.close.length;
  const rows = barRows(T, a, b), td = days[at].td;
  const { run, problems } = audit(mod, source, rows, { props, minutes, formingFrom: Math.max(0, rows.length - 4000) });
  const first = rows.findIndex((r) => r.td === td), last = rows.findLastIndex((r) => r.td === td);
  const declared = mod.plots ? Object.keys(mod.plots) : ["value"];
  const isoDay = new Date(td * DAY).toISOString().slice(0, 10);
  return {
    indicator: name, date: isoDay, minutes, bars: rows.length,
    plots: { declared: declared.length, drew: declared.filter((f) => run.rows.some((r) => typeof r[f] === "number")).length },
    items: census(run, first, last),
    legibility: mod.areaChoice === "new" ? null : legibility(mod, run, rows, td),
    problems,
    chart: `http://localhost:5178/#s=donchian_1250&d=${isoDay}&e=1250&tv=${encodeURIComponent(`${name}!${minutes}!${Object.entries(set).map(([k, v]) => `${k}=${v}`).join(",")}`)}`,
  };
}

export function printReport(r, out = console.log) {
  out(`\n${r.indicator}, ${r.minutes}-minute MNQ, ${r.date} (${r.bars.toLocaleString("en-US")} bars including warm-up)`);
  out(`  plots   ${r.plots.drew} of ${r.plots.declared} drew something`);
  out(`  day     ${Object.entries(r.items).map(([k, v]) => `${v} ${k}`).join(", ") || "no graphics"}`);
  if (r.legibility) {
    const l = r.legibility;
    out(`  labels  ${l.labels} at ${l.barW} px a bar, ${l.overlapping} pairs overlapping`);
    for (const [a, b] of l.examples) out(`          "${a}" on "${b}"`);
  }
  if (!r.problems.length) out("  checks  pass: well formed, and a forming bar changes nothing");
  for (const p of r.problems) out(`  ${p.level.padEnd(7)} ${p.text}${p.count > 1 ? ` (${p.count} times, first at bar ${p.bar})` : ""}`);
  out(`  chart   ${r.chart}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), names = [], o = { set: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--date") o.date = args[++i];
    else if (a === "--tf") o.tf = Number(args[++i]);
    else if (a === "--warmup") o.warmup = Number(args[++i]);
    else if (a === "--bin") o.bin = args[++i];
    else if (a === "--json") o.json = true;
    else if (a === "--set") {
      const [k, v] = args[++i].split("=");
      o.set[k] = v === "true" ? true : v === "false" ? false : Number.isNaN(Number(v)) ? v : Number(v);
    } else names.push(a);
  }
  if (!names.length) {
    const { mine } = listIndicators();
    console.log("usage: npm run mock -- <indicator> [--date YYYY-MM-DD] [--tf M] [--set k=v]");
    console.log("yours: " + mine.map((x) => x.name).join(", ") + "\nTradovate's own: builtin:<name>");
    process.exit(1);
  }
  const { loadBars } = await import("../../src/data.mjs");
  const { bars } = loadBars(o.bin);
  let errors = 0;
  for (const name of names) {
    const r = checkIndicator({ ...o, name, bars1m: bars });
    errors += r.problems.filter((p) => p.level === "error").length;
    if (o.json) console.log(JSON.stringify(r, null, 1)); else printReport(r);
  }
  process.exit(errors ? 1 : 0);
}
