// Where the hours actually point, and whether it holds up.
//
// research/quiet_session_hours.mjs killed both halves of the chart-reading
// hypothesis: Asia 18:00-20:00 CT is break-even to negative and the NY open is
// the worst block of the day. What it found instead is that 01:00 and 05:00 CT
// carry more than the entire book's profit.
//
// That is exactly the shape that is usually noise, so this file tries to break
// it rather than bank it:
//
//   1. halves and 2026 per hour -- a real hour earns in both
//   2. the European band as a gate, with pass rate
//   3. a matched null on the two peak hours: if you pick the best 2 of 20 hours,
//      how good does the best pair look by luck alone?
//
//   node research/quiet_session_followup.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { sweepWindows } from "../src/challenge.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies({ force: true });
const S = strategies.get("macd_5m_quiet_anticipate");
const EXEC = S.execDefaults || {}, RULES = S.rulesDefaults || {};
const T0 = bars.ts[0], T1 = bars.ts[bars.ts.length - 1];

function variant(inWindow) {
  return {
    ...S,
    compute(b, p) {
      const out = S.compute(b, p);
      if (!inWindow || !b.ctMin) return out;
      const sig = Int8Array.from(out.sig);
      for (let i = 0; i < sig.length; i++) if (sig[i] && !inWindow(b.ctMin[i])) sig[i] = 0;
      return { ...out, sig };
    },
  };
}
function run(over, inWindow) {
  const p = resolveParams(S, { sessionGate: "any", ...over });
  const tr = runStrategy(bars, variant(inWindow), p, EXEC).trades || [];
  for (const t of tr) {
    const src = t.entrySrc != null ? t.entrySrc : 0;
    t.ctMinEntry = bars.ctMin[Math.min(src, bars.ctMin.length - 1)];
    t.yr = new Date(t.entryTime).getUTCFullYear();
  }
  return tr;
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
const avg = (a) => (a.length ? sum(a) / a.length : NaN);

const ALL = run({}, null);
const MID = ALL.length ? ALL[0].entryTime + (ALL[ALL.length - 1].entryTime - ALL[0].entryTime) / 2 : 0;

console.log("");
console.log("=".repeat(100));
console.log("DOES THE HOURLY EDGE HOLD UP?   macd_5m_quiet_anticipate, defaults, ADR gate on");
console.log("=".repeat(100));

// ── 1. per hour, split ──────────────────────────────────────────────────
console.log("");
console.log("PART 1 -- every hour split in half. An hour that only earns in one half is noise.");
console.log("");
console.log("  hour CT   trades    avg $    win%      total $      1st half /  2nd half      2026");
console.log("  " + "-".repeat(88));
const byH = new Map();
for (const t of ALL) {
  const h = Math.floor(t.ctMinEntry / 60);
  if (!byH.has(h)) byH.set(h, []);
  byH.get(h).push(t);
}
const hourRows = [];
for (const h of [...byH.keys()].sort((a, b) => a - b)) {
  const g = byH.get(h);
  if (g.length < 40) continue;
  const a1 = avg(g.filter((t) => t.entryTime < MID).map((t) => t.pnl));
  const a2 = avg(g.filter((t) => t.entryTime >= MID).map((t) => t.pnl));
  const y26 = g.filter((t) => t.yr >= 2026).map((t) => t.pnl);
  const both = a1 > 0 && a2 > 0;
  hourRows.push({ h, n: g.length, avg: avg(g.map((t) => t.pnl)), a1, a2, both });
  console.log("  " + String(h).padStart(2, "0") + ":00 " + (both ? "++" : "  ") +
    String(g.length).padStart(8) +
    ("$" + avg(g.map((t) => t.pnl)).toFixed(2)).padStart(10) +
    ((100 * g.filter((t) => t.pnl > 0).length) / g.length).toFixed(1).padStart(8) + "%" +
    ("$" + Math.round(sum(g.map((t) => t.pnl))).toLocaleString()).padStart(12) +
    ("$" + a1.toFixed(2) + " / $" + a2.toFixed(2)).padStart(24) +
    (y26.length > 30 ? ("$" + avg(y26).toFixed(0)).padStart(10) : "         -"));
}
console.log("");
console.log("  ++ marks an hour positive in BOTH halves.");

// ── 2. candidate bands ──────────────────────────────────────────────────
const W = {
  "current default (overnight)": (c) => c < 510 || c >= 900,
  "01:00 only": (c) => c >= 60 && c < 120,
  "05:00 only": (c) => c >= 300 && c < 360,
  "01:00 + 05:00 (the peaks)": (c) => (c >= 60 && c < 120) || (c >= 300 && c < 360),
  "Europe 00:00-08:00": (c) => c >= 0 && c < 480,
  "Europe 01:00-07:00": (c) => c >= 60 && c < 420,
  "quiet band 04:00-07:00": (c) => c >= 240 && c < 420,
  "all ++ hours": null,
};
const plusHours = new Set(hourRows.filter((r) => r.both).map((r) => r.h));
W["all ++ hours"] = (c) => plusHours.has(Math.floor(c / 60));

function metrics(tr) {
  if (!tr.length) return null;
  const pnl = tr.map((t) => t.pnl);
  let eq = 0, peak = 0, dd = 0;
  for (const v of pnl) { eq += v; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  const sw = sweepWindows(tr, T0, T1, RULES, 1);
  const pass = sw.passRate != null ? sw.passRate
    : (100 * sw.windows.filter((w) => w.outcome === "PASS").length) / sw.windows.length;
  return {
    n: tr.length, total: sum(pnl), avg: avg(pnl),
    win: (100 * pnl.filter((x) => x > 0).length) / tr.length, dd, pass,
    h1: avg(tr.filter((t) => t.entryTime < MID).map((t) => t.pnl)),
    h2: avg(tr.filter((t) => t.entryTime >= MID).map((t) => t.pnl)),
  };
}

console.log("");
console.log("PART 2 -- as gates, with the pass rate that is the actual objective");
console.log("");
console.log("  window                        trades     total $     avg $   win%     max DD   pass%    1st / 2nd half");
console.log("  " + "-".repeat(102));
for (const [lab, fn] of Object.entries(W)) {
  const m = metrics(run({}, fn));
  if (!m) { console.log("  " + lab.padEnd(28) + "  (no trades)"); continue; }
  console.log("  " + lab.padEnd(28) + String(m.n).padStart(7) +
    ("$" + Math.round(m.total).toLocaleString()).padStart(12) +
    ("$" + m.avg.toFixed(2)).padStart(10) + m.win.toFixed(1).padStart(7) +
    ("$" + Math.round(m.dd).toLocaleString()).padStart(11) +
    m.pass.toFixed(1).padStart(6) +
    ("$" + m.h1.toFixed(2) + " / $" + m.h2.toFixed(2)).padStart(20));
}
console.log("");
console.log("  ++ hours used: " + [...plusHours].sort((a, b) => a - b)
  .map((h) => String(h).padStart(2, "0")).join(" "));

// ── 3. the matched null on picking the best hours ───────────────────────
// Shuffle which HOUR each trade is labelled with, keeping the hour sizes fixed,
// then take the best pair. Repeating that says how good the best pair looks
// when the hour means nothing at all.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sizes = hourRows.map((r) => r.n);
const pool = ALL.map((t) => t.pnl);
const rnd = mulberry32(4242);
const bestPairs = [];
for (let d = 0; d < 500; d++) {
  const idx = Int32Array.from(pool.keys());
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  let at = 0;
  const means = [];
  for (const sz of sizes) {
    let s = 0;
    for (let k = 0; k < sz; k++) s += pool[idx[at + k]];
    means.push(s / sz); at += sz;
  }
  means.sort((a, b) => b - a);
  bestPairs.push((means[0] + means[1]) / 2);
}
bestPairs.sort((a, b) => a - b);
const realTop = hourRows.map((r) => r.avg).sort((a, b) => b - a);
const realPair = (realTop[0] + realTop[1]) / 2;
const p95 = bestPairs[Math.floor(0.95 * bestPairs.length)];
console.log("");
console.log("PART 3 -- how good does the best pair of hours look when the hour means nothing?");
console.log("");
console.log("  real best pair          $" + realPair.toFixed(2) + " a trade");
console.log("  shuffled best pair      median $" + bestPairs[bestPairs.length >> 1].toFixed(2) +
  ",  95th pct $" + p95.toFixed(2) + "   (" + bestPairs.length + " shuffles)");
console.log("  " + (realPair > p95
  ? "REAL beats the 95th percentile of pure chance."
  : "REAL is INSIDE what chance produces -- picking the best two hours of twenty proves nothing."));
console.log("");
