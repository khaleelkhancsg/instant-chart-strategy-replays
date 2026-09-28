// Does the 1-min EMA 12/26 turning against a Donchian trade in its first four
// bars mark the failures -- and is it worth acting on?
//
// The observation, from the chart: trades that fail tend to see the 1-minute EMA
// 12/26 start moving the other way within about four bars of entry; trades that
// work see it keep going their way.
//
// Two different questions, with opposite track records in this project:
//
//   1. IS IT TRUE?  Probably, and partly by construction: a trade that fails is
//      one where price went against it, and an EMA follows price.
//   2. CAN YOU ACT ON IT IN TIME?  The Donchian wins ~73% of the time BECAUSE its
//      stop is far (5xATR, capped) and its target near (1.75xATR): plenty of
//      winners dip first. Cutting on an early wobble also cuts those. Every
//      "exit when the indicator turns against" rule tried so far LOWERED the
//      pass rate -- but those fired at any point in the trade. This one looks
//      only at the first few bars after entry, which is genuinely untested.
//
// On the live configuration: shipped gate plus the slow-trend rescue, the bot's
// stop-entry model (research/lib_shipped.mjs). Tested on 1-minute EMAs as
// described, and on the 2-minute MACD the backtester draws under donchian_shipped
// (four of ITS histogram bars are eight minutes).
//
//   node research/donchian_early_ema_exit.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { ema, adx, donchian, atr } from "../src/indicators.mjs";
import { run, passOf, days, H1, H2, RECENT, mul } from "./lib_shipped.mjs";

const SLIP = 0.25, TICK = 0.25, PV = 2, QTY = 8, PERSIDE = 0.75;

const { bars } = loadBars();
const tf = resample(bars, 2);
const n = tf.close.length, O = tf.open;

// ── the live signal: efficiency >= 0.5, plus the slow-trend rescue ────────
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(n);
for (let i = 30; i < n; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const ctx = buildFilterContext(tf);
const plain = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const low = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.45 });
const tF = ema(tf.close, 125), tS = ema(tf.close, 500);
const RESC = Int8Array.from(plain);
for (let k = 1499; k < n; k++) if (!plain[k] && low[k] && (Math.sign(tF[k] - tS[k]) || 0) === raw[k]) RESC[k] = low[k];
const A = atr(tf.high, tf.low, tf.close, 14);         // the ATR lib_shipped arms with

// ── EMA 12/26 and its MACD on both frames ────────────────────────────────
function pack(C) {
  const e12 = ema(C, 12), e26 = ema(C, 26);
  const line = new Float64Array(C.length);
  for (let i = 0; i < C.length; i++) line[i] = e12[i] - e26[i];
  const s9 = ema(line, 9);
  const hist = new Float64Array(C.length);
  for (let i = 0; i < C.length; i++) hist[i] = line[i] - s9[i];
  return { e12, e26, line, hist };
}
const M1 = pack(bars.close), M2 = pack(tf.close);
const sg = (x) => (Number.isFinite(x) ? Math.sign(x) || 0 : 0);
// Direction a series moved from just BEFORE the fill bar to the close of 2-min
// bar k -- on the 1-minute frame (its last minute in each bar), or the 2-minute.
const d1 = (arr, ent, k) => sg(arr[tf.srcLast[k]] - arr[tf.srcLast[ent - 1]]);
const d2 = (arr, ent, k) => sg(arr[k] - arr[ent - 1]);
const FEAT = {
  "1m EMA12 slope": (e, k) => d1(M1.e12, e, k),
  "1m EMA26 slope": (e, k) => d1(M1.e26, e, k),
  "1m both EMAs": (e, k) => { const a = d1(M1.e12, e, k), b = d1(M1.e26, e, k); return a === b ? a : 0; },
  "1m MACD line": (e, k) => d1(M1.line, e, k),
  "1m MACD hist": (e, k) => d1(M1.hist, e, k),
  "2m EMA12 slope": (e, k) => d2(M2.e12, e, k),
  "2m MACD hist": (e, k) => d2(M2.hist, e, k),
};

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = avg(a); return Math.sqrt(avg(a.map((x) => (x - m) ** 2))); };
const win = (a) => (100 * a.filter((x) => x > 0).length) / a.length;

// ── the baseline, and each trade's entry bar and fill, reconstructed ──────
const BASE = run(() => 8, { signals: RESC });
const idxOf = new Map();
for (let k = 0; k < n; k++) idxOf.set(tf.tday[k] * 10000 + tf.ctMin[k], k);
const T = [];
let tpChecked = 0, tpBad = 0, carried = 0;
for (const t of BASE) {
  // A position carried over an early close is filed under the NEXT day, so its
  // entry cannot be looked up by day and minute. Its tell: a FLAT exit held
  // longer than entry-to-15:06 allows. Set aside, and counted.
  if (t.why === "FLAT" && t.entCt + t.held < 905) { carried++; continue; }
  const ent = idxOf.get(t.tday * 10000 + t.entCt);
  if (ent === undefined || t.sigBar < 1) { carried++; continue; }
  const dir = RESC[t.sigBar], arm = t.sigBar + 1, a = A[t.sigBar];
  const armPx = O[arm] + dir * Math.max(a * 0.15, TICK);
  const fill = armPx + dir * SLIP;
  const tp = O[arm] + dir * Math.max(a * 1.75, TICK);
  if (t.why === "TP") {                                     // prove the reconstruction
    tpChecked++;
    const want = ((tp - dir * SLIP) - fill) * dir * PV * QTY - PERSIDE * 2 * QTY;
    if (Math.abs(want - t.pnl) > 1e-6) tpBad++;
  }
  T.push({ ...t, ent, dir, fill, exitBar: ent + t.held / 2 });
}
const cutPnl = (t, i) => ((O[i] - t.dir * SLIP) - t.fill) * t.dir * PV * QTY - PERSIDE * 2 * QTY;

console.log("");
console.log("=".repeat(106));
console.log("DONCHIAN: THE 1-MIN EMA 12/26 IN THE FIRST BARS AFTER ENTRY   (live config: shipped + slow-trend rescue)");
console.log("=".repeat(106));
const B = { n: BASE.length, win: win(BASE.map((t) => t.pnl)), avg: avg(BASE.map((t) => t.pnl)),
            pass: passOf(BASE, days), h1: passOf(BASE, H1), h2: passOf(BASE, H2), rec: passOf(BASE, RECENT) };
console.log("");
console.log("  baseline: " + B.n.toLocaleString() + " trades, win " + B.win.toFixed(1) + "%, $" + B.avg.toFixed(2) +
            ", pass " + B.pass.toFixed(2) + "% (H1 " + B.h1.toFixed(2) + " / H2 " + B.h2.toFixed(2) + " / recent " + B.rec.toFixed(2) + ")");
console.log("  reconstruction: " + T.length.toLocaleString() + " trades located; fill and target re-derived and checked on " +
            tpChecked.toLocaleString() + " target exits -- " + (tpBad === 0 ? "all exact" : tpBad + " WRONG"));
if (tpBad) process.exit(1);

// ── PART 1: is it true, and would cutting have paid? ─────────────────────
console.log("");
console.log("PART 1 -- trades still open 4 minutes after the fill, split by where the 1-min EMA went");
console.log("");
console.log("  indicator         ---- went WITH the trade ----    ---------- went AGAINST it ----------    of losers  of winners");
console.log("                        n    win%   held $/trade        n    win%   held $     if cut $     against     against");
console.log("  " + "-".repeat(114));
const MIN4 = 2;                                             // bars after the fill bar: close of ent+1
for (const [name, f] of Object.entries(FEAT)) {
  const w = [], ag = [], cut = [], losers = [], winners = [];
  for (const t of T) {
    const k = t.ent + MIN4 - 1;
    const cuttable = t.exitBar > k + 1 || (t.exitBar === k + 1 && t.why === "FLIP");
    if (!cuttable) continue;
    const s = f(t.ent, k);
    const against = s === -t.dir;
    (against ? ag : w).push(t.pnl);
    if (against) cut.push(cutPnl(t, k + 1));
    (t.pnl > 0 ? winners : losers).push(against ? 1 : 0);
  }
  console.log("  " + name.padEnd(16) + String(w.length).padStart(7) + win(w).toFixed(1).padStart(8) + ("$" + avg(w).toFixed(2)).padStart(13) +
    String(ag.length).padStart(11) + win(ag).toFixed(1).padStart(8) + ("$" + avg(ag).toFixed(2)).padStart(10) +
    ("$" + avg(cut).toFixed(2)).padStart(13) + (100 * avg(losers)).toFixed(0).padStart(11) + "%" + (100 * avg(winners)).toFixed(0).padStart(11) + "%");
}
console.log("");
console.log("  'if cut' is what the SAME trades pay if closed at the next open instead. When it is below");
console.log("  'held', cutting them loses money even though they are the weaker group.");

// ── PART 2: as an actual exit, with the day rules and re-arming ───────────
// The exit rule finds each trade's fill bar itself: lib_shipped first asks about
// a new position with the bar BEFORE its fill, and a new trade is either a gap in
// the bars asked about or a change of side (a flip re-arms on the same bar).
function rule(feat, minutes, mode, rnd) {
  let lastK = -10, lastPos = 0, ent = -1, done = false;
  const stats = { eligible: 0, fired: 0 };
  const last = minutes / 2 - 1;                             // bars after the fill bar
  const fn = (k, pos) => {
    if (k !== lastK + 1 || pos !== lastPos) { ent = k + 1; done = false; }
    lastK = k; lastPos = pos;
    if (done) return false;
    const since = k - ent;
    if (since < 0) return false;
    if (mode === "at") {
      if (since !== last) return false;
      done = true; stats.eligible++;
      const cut = rnd ? rnd.draw() < rnd.p : feat(ent, k) === -pos;
      if (cut) stats.fired++;
      return cut;
    }
    if (since > last) { done = true; return false; }        // "within": first wobble
    if (feat(ent, k) === -pos) { done = true; stats.fired++; return true; }
    return false;
  };
  fn.stats = stats;
  return fn;
}
function score(exitFn) {
  const tr = run(() => 8, { signals: RESC, exitFn });
  const p = tr.map((t) => t.pnl);
  return { n: tr.length, win: win(p), avg: avg(p), pass: passOf(tr, days), h1: passOf(tr, H1), h2: passOf(tr, H2), rec: passOf(tr, RECENT) };
}

// The detector must find exactly the trades that survive their fill bar.
{
  const seen = new Set();
  let lastK = -10, lastPos = 0;
  run(() => 8, { signals: RESC, exitFn: (k, pos) => {
    if (k !== lastK + 1 || pos !== lastPos) seen.add(k + 1);
    lastK = k; lastPos = pos; return false; } });
  const want = new Set(T.filter((t) => t.exitBar > t.ent).map((t) => t.ent));
  // Carry-overs always outlive their fill bar, so the detector finds them too.
  const ok = seen.size === want.size + carried && [...want].every((e) => seen.has(e));
  console.log("");
  console.log("  entry detector: " + seen.size.toLocaleString() + " entries found vs " + want.size.toLocaleString() +
              " expected + " + carried + " early-close carry-overs -- " + (ok ? "exact" : "MISMATCH, results below are not trustworthy"));
  if (!ok) process.exit(1);
}

console.log("");
console.log("PART 2 -- as an EXIT: close the trade at the next open if the indicator has turned against it");
console.log("");
console.log("  rule                                   trades   win%     avg $    pass     H1      H2   recent   cut / checked");
console.log("  " + "-".repeat(110));
const row = (lab, s, st) => console.log("  " + lab.padEnd(38) + String(s.n).padStart(7) + s.win.toFixed(1).padStart(7) +
  ("$" + s.avg.toFixed(2)).padStart(10) + s.pass.toFixed(2).padStart(8) + s.h1.toFixed(2).padStart(8) + s.h2.toFixed(2).padStart(8) +
  s.rec.toFixed(2).padStart(8) + (st ? (st.fired + " / " + (st.eligible || "-")).padStart(16) : ""));
row("(no early exit)", B, null);
const RES = [];
for (const [name, minutes, mode] of [
  ["1m EMA12 slope", 2, "at"], ["1m EMA12 slope", 4, "at"], ["1m EMA12 slope", 6, "at"], ["1m EMA12 slope", 8, "at"],
  ["1m EMA12 slope", 4, "within"], ["1m both EMAs", 4, "at"], ["1m both EMAs", 4, "within"],
  ["1m MACD line", 4, "at"], ["1m MACD hist", 4, "at"],
  ["2m EMA12 slope", 4, "at"], ["2m EMA12 slope", 8, "at"], ["2m MACD hist", 8, "at"]]) {
  const fn = rule(FEAT[name], minutes, mode, null);
  const s = score(fn);
  RES.push({ name, minutes, mode, s, st: fn.stats });
  row(name + (mode === "at" ? " at " : " within ") + minutes + " min", s, fn.stats);
}

// ── the control: cut the same share of trades at the same moment, at random ─
console.log("");
console.log("  the control -- cut the SAME share of trades at the SAME moment, chosen at random (40 draws)");
console.log("  " + "-".repeat(110));
for (const r of RES.filter((x) => x.mode === "at" && [4, 8].includes(x.minutes)).slice(0, 5)) {
  const p = r.st.fired / r.st.eligible;
  const ps = [];
  for (let d = 0; d < 40; d++) {
    const g = mul(9001 + d * 7919);
    ps.push(score(rule(null, r.minutes, "at", { p, draw: g })).pass);
  }
  const z = (r.s.pass - avg(ps)) / sd(ps);
  console.log("  " + (r.name + " at " + r.minutes + " min").padEnd(38) + ("pass " + r.s.pass.toFixed(2)).padStart(12) +
    ("random cuts " + avg(ps).toFixed(2) + " +/- " + sd(ps).toFixed(2)).padStart(30) + ("z " + (z >= 0 ? "+" : "") + z.toFixed(1)).padStart(8) +
    ("  (cuts " + (100 * p).toFixed(0) + "% of trades)"));
}
console.log("");
console.log("  Baseline pass " + B.pass.toFixed(2) + "%. A rule helps only if it beats BOTH the baseline and random cutting.");
console.log("");
