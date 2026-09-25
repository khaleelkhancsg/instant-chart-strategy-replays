// Sweep the multi-timeframe book: arm window, confirmation mode, ATR frame,
// target and stop multiples, EMA lengths, and the quiet gate.
//
// Reported on PASS RATE first, because that is the objective and because this
// project has now watched per-trade quality and pass rate move in opposite
// directions three times in a row.
//
// Reference points: the 5-minute quiet anticipation reads 25.8% pass at $8.85 a
// trade, and the live Donchian+ORB bot reads about 51%.
//
//   node research/mtf_sweep.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { sweepWindows } from "../src/challenge.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies({ force: true });
const S = strategies.get("macd_mtf_confirm");
if (!S) { console.error("macd_mtf_confirm missing from the registry"); process.exit(1); }
const REF = strategies.get("macd_5m_quiet_anticipate");
const RULES = S.rulesDefaults || {};
const T0 = bars.ts[0], T1 = bars.ts[bars.ts.length - 1];
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function go(strategy, over, execOver) {
  const p = resolveParams(strategy, over || {});
  const exec = { ...(strategy.execDefaults || {}), ...(execOver || {}) };
  const tr = runStrategy(bars, strategy, p, exec).trades || [];
  if (tr.length < 50) return null;
  const pnl = tr.map((t) => t.pnl);
  let eq = 0, pk = 0, dd = 0;
  for (const v of pnl) { eq += v; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq; }
  const sw = sweepWindows(tr, T0, T1, RULES, 1);
  const pass = sw.passRate != null ? sw.passRate
    : (100 * sw.windows.filter((w) => w.outcome === "PASS").length) / sw.windows.length;
  const t0 = tr[0].entryTime, mid = t0 + (tr[tr.length - 1].entryTime - t0) / 2;
  const byR = {};
  for (const t of tr) byR[t.reason] = (byR[t.reason] || 0) + 1;
  return {
    n: tr.length, total: pnl.reduce((a, b) => a + b, 0), avg: avg(pnl),
    win: (100 * pnl.filter((x) => x > 0).length) / tr.length,
    hold: avg(tr.map((t) => t.bars)), dd, pass,
    h1: avg(tr.filter((t) => t.entryTime < mid).map((t) => t.pnl)),
    h2: avg(tr.filter((t) => t.entryTime >= mid).map((t) => t.pnl)),
    exits: Object.entries(byR).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => k + " " + Math.round((100 * v) / tr.length) + "%").join(" "),
  };
}
const HEAD = "  variant                       trades     total $     avg $   win%  hold     max DD   pass%    1st / 2nd half";
const SEP = "  " + "-".repeat(110);
function row(lab, m) {
  if (!m) return "  " + lab.padEnd(28) + "   (too few trades)";
  return "  " + lab.padEnd(28) + String(m.n).padStart(7) +
    ("$" + Math.round(m.total).toLocaleString()).padStart(12) +
    ("$" + m.avg.toFixed(2)).padStart(10) + m.win.toFixed(1).padStart(7) +
    m.hold.toFixed(0).padStart(6) +
    ("$" + Math.round(m.dd).toLocaleString()).padStart(11) + m.pass.toFixed(1).padStart(7) +
    ("$" + m.h1.toFixed(2) + " / $" + m.h2.toFixed(2)).padStart(20);
}

console.log("");
console.log("=".repeat(114));
console.log("MULTI-TIMEFRAME SWEEP -- 5-min arms, 1-min triggers, 1-min EMA confirms, 3x ATR target");
console.log("=".repeat(114));
console.log("");
console.log(HEAD);
console.log(SEP);
console.log(row("REFERENCE: 5m quiet antic.", go(REF, {}, null)));
const D = go(S, {}, null);
console.log(row("MTF at the defaults", D));
if (D) console.log("    exits: " + D.exits);

console.log("");
console.log("  confirmation mode");
console.log(SEP);
for (const m of ["hold", "entry", "off"]) console.log(row("confirm = " + m, go(S, { confirmMode: m }, null)));

console.log("");
console.log("  arm window (1-min bars the 5-min arm stays live)");
console.log(SEP);
for (const a of [5, 10, 15, 30, 60, 90]) console.log(row("armBars = " + a, go(S, { armBars: a }, null)));

console.log("");
console.log("  ATR frame and target multiple");
console.log(SEP);
for (const tfx of ["1m", "5m"])
  for (const tp of [1.5, 3, 5])
    console.log(row("atr " + tfx + ", tp " + tp + "x", go(S, { atrTf: tfx }, { tpAtrMult: tp })));

console.log("");
console.log("  stop multiple (at the default 3x target)");
console.log(SEP);
for (const sl of [1, 1.5, 2, 3, 5]) console.log(row("sl " + sl + "x ATR", go(S, {}, { slAtrMult: sl })));

console.log("");
console.log("  1-minute EMA pair");
console.log(SEP);
for (const [f, s] of [[5, 13], [9, 21], [12, 26], [21, 55], [50, 200]])
  console.log(row("EMA " + f + "/" + s, go(S, { emaFast: f, emaSlow: s }, null)));

console.log("");
console.log("  the quiet gate, and the 5-min arm's own proximity");
console.log(SEP);
console.log(row("gate off", go(S, { sessionGate: "any", adrMax: 2 }, null)));
console.log(row("session only, ADR off", go(S, { adrMax: 2 }, null)));
console.log(row("ADR only, any session", go(S, { sessionGate: "any" }, null)));
for (const px of [0.05, 0.075, 0.15, 0.25]) console.log(row("prox " + px, go(S, { prox: px }, null)));

// ── why it fails, measured rather than asserted ─────────────────────────
// The arm fires AGAINST the running push -- that is what anticipation means.
// The 1-minute MACD cross and the 1-minute EMA both FOLLOW that push. So the
// two layers may be structurally opposed, and requiring them to agree would
// mean waiting until the anticipation is no longer an anticipation. That is a
// checkable claim.
import { resample } from "../src/resample.mjs";
import { ema } from "../src/indicators.mjs";
import flip from "../strategies/macd_1m_flip.mjs";

const p = resolveParams(S, {});
const tf5 = resample(bars, 5);
const h5 = flip.compute(tf5, p).overlays.find((o) => o.kind === "hist").data;
const o1 = flip.compute(bars, p);
const h1 = o1.overlays.find((o) => o.kind === "hist").data;
const cross1 = o1.sig;
const n = h1.length, n5 = h5.length;

const win = 200;
const sc5 = new Float64Array(n5).fill(NaN);
{
  let s = 0;
  for (let i = 0; i < n5; i++) {
    const a = Math.abs(h5[i]);
    if (Number.isFinite(a)) s += a;
    if (i >= win) s -= Math.abs(h5[i - win]) || 0;
    if (i >= win - 1) sc5[i] = s / win;
  }
}
// The arm, and the 5-minute index each 1-minute bar belongs to.
const owner = new Int32Array(n).fill(-1);
for (let k = 0; k < n5; k++)
  for (let i = tf5.srcFirst[k]; i <= tf5.srcLast[k] && i < n; i++) owner[i] = k;

const ef = ema(bars.close, 9), es = ema(bars.close, 21);
let run = 0, arms = 0, triggered = 0;
const delays = [], emaAgreeAtTrigger = [], alreadyCrossed = [];
for (let k = 1; k < n5; k++) {
  const v = h5[k], u = h5[k - 1];
  if (!Number.isFinite(v) || !Number.isFinite(u) || !Number.isFinite(sc5[k])) { run = 0; continue; }
  run = Math.abs(v) < Math.abs(u) ? run + 1 : 0;
  if (run < 3 || !(Math.abs(v) < 0.075 * sc5[k])) continue;
  const d = v >= 0 ? -1 : 1;
  arms++;
  const from = tf5.srcLast[k] + 1, to = Math.min(n - 1, from + 29);
  for (let i = from; i <= to; i++) {
    if (cross1[i] !== d) continue;
    triggered++;
    delays.push(i - from + 1);
    emaAgreeAtTrigger.push((ef[i] > es[i] ? 1 : -1) === d ? 1 : 0);
    const kk = owner[i];
    // Has the 5-minute histogram already crossed to the armed side by then?
    alreadyCrossed.push(kk >= 0 && Number.isFinite(h5[kk]) && (h5[kk] >= 0 ? 1 : -1) === d ? 1 : 0);
    break;
  }
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
console.log("");
console.log("WHY IT FAILS -- what the tape looks like when the 1-minute trigger finally fires");
console.log("");
console.log("  5-minute arms raised                         " + arms.toLocaleString());
console.log("  of those, a 1-min cross arrived in 30 bars   " + triggered.toLocaleString() +
  "  (" + (100 * triggered / arms).toFixed(1) + "%)");
console.log("  median wait from arm to trigger              " + med(delays) + " 1-min bars");
console.log("  the 5-min histogram had ALREADY crossed      " +
  (100 * mean(alreadyCrossed)).toFixed(1) + "% of the time");
console.log("  the 1-min EMA agreed with the arm            " +
  (100 * mean(emaAgreeAtTrigger)).toFixed(1) + "% of the time");
console.log("");
console.log("  Reference: the 5-min quiet anticipation passes 25.8%; the live bot about 51%.");
console.log("");
