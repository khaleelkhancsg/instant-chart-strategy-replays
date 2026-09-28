// Do 1-min / 5-min EMAs, SMAs or MACD improve the Donchian's entries or exits?
//
// Tested on the bot's REAL entry model (research/lib_shipped.mjs: stop-entry
// 0.15xATR deferred one bar, refused stops re-placed as limits, 5xATR stop
// capped at the $1,000 day limit, 1.75xATR target, breaker and profit block).
// Baseline: 2,639 trades, 34.53% pass.
//
// For every Donchian signal, sixteen conditions are read at the moment it
// fired -- on 1-minute and on 5-minute bars:
//
//   EMA 9 > 21, EMA 21 > 50, EMA 50 > 200      the averages stacked the trade's way
//   price vs EMA 21, SMA 50, SMA 200           price on the trade's side of the line
//   MACD histogram, MACD line                  momentum the trade's way
//
// "Aligned" means the condition points the same way as the breakout.
//
// ── TWO TRAPS, DESIGNED OUT ──────────────────────────────────────────────
// LOOKAHEAD. The Donchian decides on 2-minute bars. A 1-minute reading is taken
// at the signal bar's last minute; a 5-minute reading from the last 5-minute
// bar that had CLOSED by then. Never the 5-minute bar still forming.
//
// FREQUENCY. Four times in this project a filter has improved dollars per
// trade and LOWERED the pass rate, because a 30-day window still has to reach
// $3,000 and removing trades makes that harder. So every entry filter is scored
// against a MATCHED NULL: skipping the same share of signals at random. A
// filter only helps if it beats throwing away the same number of trades by
// coin flip.
//
//   node research/donchian_ma_filters.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { ema, sma, donchian } from "../src/indicators.mjs";
import { run, passOf, days, H1, H2, RECENT, mul } from "./lib_shipped.mjs";

const { bars } = loadBars();
const tf = resample(bars, 2);                  // identical to lib_shipped's own
const tf5 = resample(bars, 5);
const n1 = bars.close.length, n2 = tf.close.length, n5 = tf5.close.length;

function pack(C) {
  const e9 = ema(C, 9), e21 = ema(C, 21), e50 = ema(C, 50), e200 = ema(C, 200);
  const s50 = sma(C, 50), s200 = sma(C, 200);
  const f = ema(C, 12), s = ema(C, 26);
  const line = new Float64Array(C.length);
  for (let i = 0; i < C.length; i++) line[i] = f[i] - s[i];
  const sig = ema(line, 9);
  const hist = new Float64Array(C.length);
  for (let i = 0; i < C.length; i++) hist[i] = line[i] - sig[i];
  return { e9, e21, e50, e200, s50, s200, line, hist };
}
const I1 = pack(bars.close), I5 = pack(tf5.close);

// Last CLOSED 5-minute bar at each 1-minute index.
const known5 = new Int32Array(n1).fill(-1);
{
  let k = 0, cur = -1;
  for (let i = 0; i < n1; i++) {
    while (k < n5 && tf5.srcLast[k] <= i) { cur = k; k++; }
    known5[i] = cur;
  }
}

const sgn = (x) => (Number.isFinite(x) ? (x > 0 ? 1 : x < 0 ? -1 : 0) : NaN);
// Each feature: 2-minute bar k -> the direction it points, read when k closed.
const F = [];
for (const [tfName, I, at] of [["1m", I1, (k) => tf.srcLast[k]], ["5m", I5, (k) => known5[tf.srcLast[k]]]]) {
  const px = (k) => tf.close[k];                              // the price the bot sees
  F.push({ name: tfName + " EMA 9>21", f: (k) => { const j = at(k); return j < 0 ? NaN : sgn(I.e9[j] - I.e21[j]); } });
  F.push({ name: tfName + " EMA 21>50", f: (k) => { const j = at(k); return j < 0 ? NaN : sgn(I.e21[j] - I.e50[j]); } });
  F.push({ name: tfName + " EMA 50>200", f: (k) => { const j = at(k); return j < 0 ? NaN : sgn(I.e50[j] - I.e200[j]); } });
  F.push({ name: tfName + " price>EMA21", f: (k) => { const j = at(k); return j < 0 ? NaN : sgn(px(k) - I.e21[j]); } });
  F.push({ name: tfName + " price>SMA50", f: (k) => { const j = at(k); return j < 0 ? NaN : sgn(px(k) - I.s50[j]); } });
  F.push({ name: tfName + " price>SMA200", f: (k) => { const j = at(k); return j < 0 ? NaN : sgn(px(k) - I.s200[j]); } });
  F.push({ name: tfName + " MACD hist", f: (k) => { const j = at(k); return j < 0 ? NaN : sgn(I.hist[j]); } });
  F.push({ name: tfName + " MACD line", f: (k) => { const j = at(k); return j < 0 ? NaN : sgn(I.line[j]); } });
}

// The direction of the Donchian signal on bar k: which side of the channel of
// the previous 30 bars it closed. The sizer is only ever asked about bars that
// ARE signals (lib_shipped arms from sig[k]), so this is that signal's side.
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const dirAt = (k) => (tf.close[k] > dh[k] ? 1 : tf.close[k] < dl[k] ? -1 : 0);

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = avg(a); return Math.sqrt(avg(a.map((x) => (x - m) ** 2))); };
function stats(tr) {
  const p = tr.map((t) => t.pnl);
  return { n: tr.length, win: (100 * p.filter((x) => x > 0).length) / p.length, avg: avg(p),
           net: p.reduce((a, b) => a + b, 0),
           pass: passOf(tr, days), h1: passOf(tr, H1), h2: passOf(tr, H2), rec: passOf(tr, RECENT) };
}

const BASE = run(() => 8);
const B = stats(BASE);

console.log("");
console.log("=".repeat(112));
console.log("DONCHIAN vs 1-MIN / 5-MIN EMA, SMA, MACD   (the bot's real entry model, research/lib_shipped.mjs)");
console.log("=".repeat(112));
console.log("");
console.log("  baseline: " + B.n.toLocaleString() + " trades, win " + B.win.toFixed(1) + "%, $" + B.avg.toFixed(2) +
            " a trade, pass " + B.pass.toFixed(2) + "%  (H1 " + B.h1.toFixed(2) + " / H2 " + B.h2.toFixed(2) +
            " / recent " + B.rec.toFixed(2) + ")");

// ── PART 1: how the bot's actual trades split on each condition ──────────
console.log("");
console.log("PART 1 -- the " + B.n.toLocaleString() + " trades the bot takes, split by each condition at the signal");
console.log("");
console.log("  condition          aligned   ---- aligned ----           ---- against ----          difference");
console.log("                        %        n    win%    avg $          n    win%    avg $        $/trade     t");
console.log("  " + "-".repeat(104));
const part1 = [];
for (const ft of F) {
  const al = [], ag = [];
  for (const t of BASE) {
    const d = dirAt(t.sigBar), v = ft.f(t.sigBar);
    if (!d || !Number.isFinite(v) || v === 0) continue;
    (v === d ? al : ag).push(t.pnl);
  }
  const t = (avg(al) - avg(ag)) / Math.sqrt(sd(al) ** 2 / al.length + sd(ag) ** 2 / ag.length);
  part1.push({ name: ft.name, share: al.length / (al.length + ag.length), t, diff: avg(al) - avg(ag) });
  const w = (a) => (100 * a.filter((x) => x > 0).length) / a.length;
  console.log("  " + ft.name.padEnd(17) + (100 * al.length / (al.length + ag.length)).toFixed(1).padStart(8) +
    String(al.length).padStart(9) + w(al).toFixed(1).padStart(8) + ("$" + avg(al).toFixed(2)).padStart(10) +
    String(ag.length).padStart(11) + w(ag).toFixed(1).padStart(8) + ("$" + avg(ag).toFixed(2)).padStart(10) +
    ((avg(al) - avg(ag) >= 0 ? "+$" : "-$") + Math.abs(avg(al) - avg(ag)).toFixed(2)).padStart(14) +
    t.toFixed(2).padStart(7));
}
console.log("");
console.log("  t is Welch's t on dollars per trade; |t| > 2 is roughly a 5% coincidence, and with 16");
console.log("  conditions about one would clear it by chance alone.");

// ── PART 2: as an entry filter, against a matched null ───────────────────
// The null: skip each signal at random with the same probability the filter
// skips. Its pass rate depends only on that probability, so it is measured on
// a grid and interpolated.
const GRID = [];
for (let k = 5; k <= 100; k += 5) GRID.push(k / 100);
const NULL = new Map();
for (const keep of GRID) {
  const ps = [];
  for (let d = 0; d < 80; d++) {
    const rnd = mul(1000 + d * 7919 + Math.round(keep * 100));
    const tr = run(() => (rnd() < keep ? 8 : 0));
    ps.push(passOf(tr, days));
  }
  NULL.set(keep, { m: avg(ps), s: sd(ps) });
}
function nullAt(keep) {
  const lo = Math.max(0.05, Math.min(1, Math.floor(keep * 20) / 20));
  const hi = Math.max(0.05, Math.min(1, Math.ceil(keep * 20) / 20));
  const a = NULL.get(+lo.toFixed(2)), b = NULL.get(+hi.toFixed(2));
  if (!a || !b || lo === hi) return a || b;
  const w = (keep - lo) / (hi - lo);
  return { m: a.m + w * (b.m - a.m), s: a.s + w * (b.s - a.s) };
}

console.log("");
console.log("PART 2 -- as an ENTRY FILTER: arm only when the condition agrees, scored against a matched null");
console.log("");
console.log("  filter                 kept   trades   win%    avg $    pass   null (random skip)     z      H1      H2  recent");
console.log("  " + "-".repeat(112));
console.log("  " + "(no filter)".padEnd(21) + "100%".padStart(6) + String(B.n).padStart(9) + B.win.toFixed(1).padStart(7) +
  ("$" + B.avg.toFixed(2)).padStart(9) + B.pass.toFixed(2).padStart(8) + "".padStart(23) + "     -" +
  B.h1.toFixed(2).padStart(8) + B.h2.toFixed(2).padStart(8) + B.rec.toFixed(2).padStart(8));
const part2 = [];
for (const inverse of [false, true]) {
  if (inverse) { console.log(""); console.log("  inverse -- arm only when the condition DISAGREES, to see which way the effect runs"); }
  for (const ft of F) {
    let calls = 0, kept = 0;
    const tr = run((a, ct, seq, armBar) => {
      calls++;
      const k = armBar - 1, d = dirAt(k), v = ft.f(k);
      const ok = d !== 0 && Number.isFinite(v) && (inverse ? v === -d : v === d);
      if (ok) kept++;
      return ok ? 8 : 0;
    });
    const s = stats(tr), keep = kept / calls, nl = nullAt(keep);
    const z = (s.pass - nl.m) / nl.s;
    if (!inverse) part2.push({ name: ft.name, s, keep, z });
    console.log("  " + ((inverse ? "NOT " : "") + ft.name).padEnd(21) + ((100 * keep).toFixed(0) + "%").padStart(6) +
      String(s.n).padStart(9) + s.win.toFixed(1).padStart(7) + ("$" + s.avg.toFixed(2)).padStart(9) +
      s.pass.toFixed(2).padStart(8) + (nl.m.toFixed(2) + " +/- " + nl.s.toFixed(2)).padStart(23) +
      ((z >= 0 ? "+" : "") + z.toFixed(1)).padStart(6) +
      s.h1.toFixed(2).padStart(8) + s.h2.toFixed(2).padStart(8) + s.rec.toFixed(2).padStart(8));
  }
}

// ── PART 3: as an EXIT -- leave when the condition turns against ──────────
console.log("");
console.log("PART 3 -- as an EXIT: close when the condition turns AGAINST the position (read on a closed bar,");
console.log("          filled at the next open). The stop, target, flip and flatten all still apply.");
console.log("");
console.log("  exit when against        trades   win%    avg $       net     pass      H1      H2  recent   exits by it");
console.log("  " + "-".repeat(104));
console.log("  " + "(no extra exit)".padEnd(24) + String(B.n).padStart(7) + B.win.toFixed(1).padStart(7) +
  ("$" + B.avg.toFixed(2)).padStart(9) + ("$" + Math.round(B.net).toLocaleString()).padStart(10) +
  B.pass.toFixed(2).padStart(9) + B.h1.toFixed(2).padStart(8) + B.h2.toFixed(2).padStart(8) + B.rec.toFixed(2).padStart(8) + "          -");
const part3 = [];
for (const ft of F) {
  const tr = run(() => 8, { exitFn: (k, pos) => ft.f(k) === -pos });
  const s = stats(tr);
  const by = tr.filter((t) => t.why === "XSIG").length;
  part3.push({ name: ft.name, s });
  console.log("  " + ft.name.padEnd(24) + String(s.n).padStart(7) + s.win.toFixed(1).padStart(7) +
    ("$" + s.avg.toFixed(2)).padStart(9) + ("$" + Math.round(s.net).toLocaleString()).padStart(10) +
    s.pass.toFixed(2).padStart(9) + s.h1.toFixed(2).padStart(8) + s.h2.toFixed(2).padStart(8) + s.rec.toFixed(2).padStart(8) +
    ((100 * by / s.n).toFixed(0) + "%").padStart(11));
}

// ── summary ──────────────────────────────────────────────────────────────
console.log("");
console.log("SUMMARY");
const bestF = part2.slice().sort((a, b) => b.z - a.z).slice(0, 3);
console.log("  best entry filters by z vs the null:  " + bestF.map((r) => r.name + " (z " + r.z.toFixed(1) + ", pass " + r.s.pass.toFixed(2) + ")").join(";  "));
const bestX = part3.slice().sort((a, b) => b.s.pass - a.s.pass).slice(0, 3);
console.log("  best exits by pass rate:              " + bestX.map((r) => r.name + " (" + r.s.pass.toFixed(2) + ")").join(";  "));
console.log("  baseline pass " + B.pass.toFixed(2) + "%. Donchian ALONE -- the live bot also runs the ORB, which is a separate test.");
console.log("");
