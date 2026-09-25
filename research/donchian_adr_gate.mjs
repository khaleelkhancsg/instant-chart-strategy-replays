// Does anything from the MACD work transfer to the Donchian?
//
// Most of it does not, and the reasons are worth stating before the numbers:
//
//   ADX and EFFICIENCY are already in the Donchian, in the OPPOSITE direction.
//     It wants eff > 0.5 and ADX >= 25 -- price genuinely travelling. The MACD
//     anticipation wanted eff < 0.25 and ADX < 20, and eff > 0.45 was the worst
//     gate tested on it. Same indicators, opposite signs, each correct for its
//     own book: one is a breakout, the other a fade. That consistency is a point
//     in favour of both rather than a contradiction.
//
//   PEAK HEIGHT, STEEPNESS, the LEAD-LAG ordering are all properties of a MACD
//     histogram and have no Donchian analogue.
//
//   SESSION HOURS transfer in principle, but the Donchian is already pinned to
//     RTH 08:30-15:00, so the question is narrower: which RTH hours.
//
// That leaves ONE thing: the ADR gate -- how much of its average daily range the
// day has already spent. It is the only filter in the MACD line that survived a
// matched null, a split half and a change of configuration, it is not in the
// engine's filter context at all, and it has never been tried here.
//
// ── DO NOT EXPECT ADR < 0.5 TO TRANSFER ─────────────────────────────────
// 96% of the low-ADR signals in the MACD work were OVERNIGHT. By 08:30 CT a day
// has usually spent well over half its range, so the gate as tuned would delete
// most of an RTH book. And the direction may invert anyway: an unspent range
// means room to run for a breakout, but it can equally mean no expansion yet and
// therefore nothing to break out of. Bands are swept in both directions.
//
// ── AND EXPECT FILTERING TO COST ────────────────────────────────────────
// The Donchian trades 2.03 times a day. Three times in this project a filter has
// improved dollars per trade and LOWERED the pass rate, because a 30-day window
// still has to reach $3,000. A filter has to beat that, not just improve
// quality.
//
//   node research/donchian_adr_gate.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resample } from "../src/resample.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { sweepWindows } from "../src/challenge.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies({ force: true });
const S = strategies.get("donchian_shipped");
if (!S) { console.error("donchian_shipped missing"); process.exit(1); }
const EXEC = S.execDefaults || {}, FILT = S.filterDefaults || {}, RULES = S.rulesDefaults || {};
const T0 = bars.ts[0], T1 = bars.ts[bars.ts.length - 1];
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// ADR on the strategy's own bar size, causal: previous COMPLETED days only for
// the average, and the running day's range only up to the bar being tested.
function adrOf(b, days = 14) {
  const n = b.close.length;
  const out = new Float64Array(n).fill(NaN);
  const R = [];
  let dHi = -Infinity, dLo = Infinity, adr = NaN, cur = b.tday[0];
  for (let i = 0; i < n; i++) {
    if (b.tday[i] !== cur) {
      cur = b.tday[i];
      if (Number.isFinite(dHi - dLo)) {
        R.push(dHi - dLo);
        if (R.length > days) R.shift();
        adr = R.length === days ? R.reduce((x, y) => x + y, 0) / days : NaN;
      }
      dHi = -Infinity; dLo = Infinity;
    }
    if (b.high[i] > dHi) dHi = b.high[i];
    if (b.low[i] < dLo) dLo = b.low[i];
    if (Number.isFinite(adr) && adr > 0) out[i] = (dHi - dLo) / adr;
  }
  return out;
}

function variant(keep) {
  return {
    ...S,
    compute(b, p) {
      const out = S.compute(b, p);
      if (!keep) return out;
      const used = adrOf(b);
      const sig = Int8Array.from(out.sig);
      for (let i = 0; i < sig.length; i++) {
        if (sig[i] && !keep(used[i], b.ctMin ? b.ctMin[i] : 0)) sig[i] = 0;
      }
      return { ...out, sig };
    },
  };
}

function go(lab, keep) {
  const p = resolveParams(S);
  const tr = runStrategy(bars, variant(keep), p, EXEC, { filter: FILT }).trades || [];
  if (tr.length < 50) { console.log("  " + lab.padEnd(26) + "  (too few trades)"); return null; }
  const pnl = tr.map((t) => t.pnl);
  let eq = 0, pk = 0, dd = 0;
  for (const v of pnl) { eq += v; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq; }
  const sw = sweepWindows(tr, T0, T1, RULES, 1);
  const pass = sw.passRate != null ? sw.passRate
    : (100 * sw.windows.filter((w) => w.outcome === "PASS").length) / sw.windows.length;
  const t0 = tr[0].entryTime, mid = t0 + (tr[tr.length - 1].entryTime - t0) / 2;
  const days = new Set(tr.map((t) => t.tday)).size;
  console.log("  " + lab.padEnd(26) + String(tr.length).padStart(7) +
    (tr.length / days).toFixed(2).padStart(7) +
    ("$" + Math.round(pnl.reduce((a, b) => a + b, 0)).toLocaleString()).padStart(12) +
    ("$" + avg(pnl).toFixed(2)).padStart(9) +
    ((100 * pnl.filter((x) => x > 0).length) / tr.length).toFixed(1).padStart(7) +
    ("$" + Math.round(dd).toLocaleString()).padStart(10) + pass.toFixed(1).padStart(7) +
    ("$" + avg(tr.filter((t) => t.entryTime < mid).map((t) => t.pnl)).toFixed(2) + " / $" +
      avg(tr.filter((t) => t.entryTime >= mid).map((t) => t.pnl)).toFixed(2)).padStart(20));
  return { pass, tr };
}

const HEAD = "  variant                    trades  /day     total $    avg $   win%    max DD   pass%    1st / 2nd half";
const SEP = "  " + "-".repeat(108);

console.log("");
console.log("=".repeat(112));
console.log("THE ADR GATE ON THE DONCHIAN   donchian_shipped, live config, RTH + eff>0.5 filters on");
console.log("=".repeat(112));
console.log("");
console.log(HEAD);
console.log(SEP);
const base = go("SHIPPED (no ADR gate)", null);

console.log("");
console.log("  ADR already spent -- one-sided cuts");
console.log(SEP);
for (const t of [0.3, 0.5, 0.7, 0.9]) go("ADR used < " + t.toFixed(1), (u) => Number.isFinite(u) && u < t);
for (const t of [0.3, 0.5, 0.7, 0.9]) go("ADR used > " + t.toFixed(1), (u) => Number.isFinite(u) && u > t);

console.log("");
console.log("  ADR already spent -- bands");
console.log(SEP);
for (const [a, b] of [[0.3, 0.7], [0.4, 0.8], [0.5, 0.9], [0.5, 1.1], [0.6, 1.2], [0.7, 1.3]])
  go("ADR " + a.toFixed(1) + "-" + b.toFixed(1), (u) => Number.isFinite(u) && u >= a && u < b);

// ── where inside RTH does it earn? ──────────────────────────────────────
console.log("");
console.log("=".repeat(112));
console.log("WHICH RTH HOURS?   same book, split by the hour the trade entered");
console.log("=".repeat(112));
if (base) {
  const tf = resample(bars, S.timeframeMin || 2);
  const used = adrOf(tf);
  const byH = new Map();
  for (const t of base.tr) {
    const i = t.entryIdx;
    const ct = tf.ctMin[Math.min(i, tf.ctMin.length - 1)];
    const h = Math.floor(ct / 60);
    if (!byH.has(h)) byH.set(h, []);
    byH.get(h).push({ ...t, adr: used[Math.min(i, used.length - 1)] });
  }
  const t0 = base.tr[0].entryTime;
  const mid = t0 + (base.tr[base.tr.length - 1].entryTime - t0) / 2;
  console.log("");
  console.log("  hour CT   trades    avg $   win%      total $    mean ADR used    1st / 2nd half");
  console.log("  " + "-".repeat(88));
  for (const h of [...byH.keys()].sort((a, b) => a - b)) {
    const g = byH.get(h);
    if (g.length < 40) continue;
    console.log("  " + String(h).padStart(2, "0") + ":00" +
      String(g.length).padStart(10) +
      ("$" + avg(g.map((t) => t.pnl)).toFixed(2)).padStart(9) +
      ((100 * g.filter((t) => t.pnl > 0).length) / g.length).toFixed(1).padStart(7) +
      ("$" + Math.round(g.reduce((a, t) => a + t.pnl, 0)).toLocaleString()).padStart(13) +
      avg(g.map((t) => t.adr).filter(Number.isFinite)).toFixed(2).padStart(14) +
      ("$" + avg(g.filter((t) => t.entryTime < mid).map((t) => t.pnl)).toFixed(2) + " / $" +
        avg(g.filter((t) => t.entryTime >= mid).map((t) => t.pnl)).toFixed(2)).padStart(22));
  }
  console.log("");
  console.log("  The mean-ADR column is the point: by the RTH open the day has usually spent");
  console.log("  most of its range, which is why the gate as tuned overnight cannot transfer.");
}

// ── the hours that lose, tested as a gate and against a shuffle null ────
console.log("");
console.log("=".repeat(112));
console.log("EXCLUDING THE LOSING HOURS");
console.log("=".repeat(112));
console.log("");
console.log(HEAD);
console.log(SEP);
go("SHIPPED (baseline)", null);
const hr = (c) => Math.floor(c / 60);
go("skip 13:00", (u, c) => hr(c) !== 13);
go("skip 11:00", (u, c) => hr(c) !== 11);
go("skip 11:00 and 13:00", (u, c) => hr(c) !== 11 && hr(c) !== 13);
go("skip 11,13 + ADR > 0.5", (u, c) => hr(c) !== 11 && hr(c) !== 13 && Number.isFinite(u) && u > 0.5);
go("ADR > 0.5 only", (u) => Number.isFinite(u) && u > 0.5);
go("08:00 hour only", (u, c) => hr(c) === 8);
go("skip 11,13, keep 08-14", (u, c) => hr(c) !== 11 && hr(c) !== 13 && hr(c) >= 8 && hr(c) <= 14);

// Picking the two worst of seven hours will always look good. The half-split is
// the real test and both losing hours pass it, but a shuffle says how much of
// the gain is just the picking.
if (base) {
  const tf2 = resample(bars, S.timeframeMin || 2);
  const rows = new Map();
  for (const t of base.tr) {
    const h = Math.floor(tf2.ctMin[Math.min(t.entryIdx, tf2.ctMin.length - 1)] / 60);
    if (!rows.has(h)) rows.set(h, []);
    rows.get(h).push(t.pnl);
  }
  const sizes = [...rows.values()].map((a) => a.length).filter((x) => x >= 40);
  const pool = base.tr.map((t) => t.pnl);
  let seed = 7777;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gains = [];
  const total = pool.reduce((a, b) => a + b, 0);
  for (let d = 0; d < 500; d++) {
    const idx = Int32Array.from(pool.keys());
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    let at = 0;
    const sums = [];
    for (const sz of sizes) {
      let s2 = 0;
      for (let k = 0; k < sz; k++) s2 += pool[idx[at + k]];
      sums.push(s2); at += sz;
    }
    sums.sort((a, b) => a - b);
    gains.push(-(sums[0] + sums[1]));          // what dropping the 2 worst buys
  }
  gains.sort((a, b) => a - b);
  const realByHour = [...rows.entries()].filter(([, a]) => a.length >= 40)
    .map(([h, a]) => ({ h, s: a.reduce((x, y) => x + y, 0) })).sort((a, b) => a.s - b.s);
  const realGain = -(realByHour[0].s + realByHour[1].s);
  console.log("");
  console.log("  dropping the two worst hours is worth $" + Math.round(realGain).toLocaleString() +
    " on a $" + Math.round(total).toLocaleString() + " book");
  console.log("  shuffled, dropping the two worst is worth   median $" +
    Math.round(gains[gains.length >> 1]).toLocaleString() +
    "   95th pct $" + Math.round(gains[Math.floor(0.95 * gains.length)]).toLocaleString());
  console.log("  " + (realGain > gains[Math.floor(0.95 * gains.length)]
    ? "REAL beats the 95th percentile of chance -- the hours are doing something."
    : "REAL is inside what chance produces -- this is just picking the worst two of seven."));
}

console.log("");
console.log("  Donchian ALONE here. The ~51% figure for the live bot is Donchian PLUS ORB,");
console.log("  so these pass rates are not directly comparable to it -- only to each other.");
console.log("");
