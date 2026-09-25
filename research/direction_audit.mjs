// Is the anticipation pointing the right way at all?
//
// The observation from the chart: the book is long through sections that are
// obviously bearish on the MACD, and short through bullish ones.
//
// That is by construction. The entry fires while the histogram is still on the
// OPPOSITE side, betting it is about to cross, so a long is always opened under
// a bearish histogram -- `sig[i] = v >= 0 ? -1 : 1`. It is a fade of the running
// push, taken in anticipation of the trend book's own signal.
//
// By construction is not the same as correct, and there are two different things
// the chart could be showing:
//
//   a) the ENTRY is under a bearish histogram, near zero, and the cross arrives
//      shortly after -- that is the design working
//   b) the POSITION is held for a long stretch under a deepening bearish
//      histogram -- that is the design failing, and it is the expensive case
//      already measured at -19.25 points when the cross takes 11+ bars
//
// This file measures which, puts a number on how much time the book spends
// offside, and then tests the obvious alternatives head to head on pass rate:
//
//   FADE       what ships -- enter toward the side the histogram is heading to
//   MOMENTUM   the sign flipped -- enter on the side it is currently on
//   CONFIRM    wait for the cross to actually happen, same gate, no anticipation
//   ABANDON    fade, but leave when the histogram re-expands the wrong way
//
//   node research/direction_audit.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { sweepWindows } from "../src/challenge.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies({ force: true });
const S = strategies.get("macd_5m_quiet_anticipate");
const EXEC = S.execDefaults || {}, RULES = S.rulesDefaults || {};
const T0 = bars.ts[0], T1 = bars.ts[bars.ts.length - 1];
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// Every variant rebuilds from the shipped strategy's own histogram, so the only
// thing that changes between them is the rule being tested.
function build(mode, abandonN) {
  return {
    ...S,
    compute(b, p) {
      const out = S.compute(b, p);
      const h = out.overlays.find((o) => o.kind === "hist").data;
      const N = h.length;
      let sig = out.sig;

      if (mode === "momentum") {
        const s2 = new Int8Array(N);
        for (let i = 0; i < N; i++) if (sig[i]) s2[i] = -sig[i];   // same bars, opposite side
        sig = s2;
      } else if (mode === "confirm") {
        // The gate the shipped strategy applied is already baked into sig, so
        // reuse its bars: arm when an anticipation fires, then take the actual
        // crossover when it arrives, in the direction it actually crossed.
        const s2 = new Int8Array(N);
        let armed = 0;
        for (let i = 1; i < N; i++) {
          if (sig[i]) armed = sig[i];
          if (!armed) continue;
          const a = h[i - 1], c = h[i];
          if (!Number.isFinite(a) || !Number.isFinite(c)) continue;
          if (c > 0 && a <= 0) { s2[i] = 1; armed = 0; }
          else if (c < 0 && a >= 0) { s2[i] = -1; armed = 0; }
        }
        sig = s2;
      }

      let exitSig = out.exitSig;
      if (abandonN > 0) {
        // Leave when the histogram is still on the WRONG side for the position
        // and actively getting worse -- the anticipation is being refuted rather
        // than merely slow. Distinct from the bar-count bail already tested.
        const ex = exitSig ? Int8Array.from(exitSig) : new Int8Array(N);
        let grow = 0;
        for (let i = 1; i < N; i++) {
          const v = h[i], u = h[i - 1];
          if (!Number.isFinite(v) || !Number.isFinite(u)) { grow = 0; continue; }
          grow = Math.abs(v) > Math.abs(u) && (v >= 0) === (u >= 0) ? grow + 1 : 0;
          if (grow < abandonN) continue;
          // hist negative and growing => a LONG here is offside and losing.
          if (v < 0) ex[i] |= 1;
          else ex[i] |= 2;
        }
        exitSig = ex;
      }
      return { ...out, sig, exitSig, _hist: h };
    },
  };
}

function measure(strategy, over) {
  const p = resolveParams(S, over || {});
  const res = runStrategy(bars, strategy, p, EXEC);
  const tr = res.trades || [];
  if (!tr.length) return null;
  const pnl = tr.map((t) => t.pnl);
  let eq = 0, pk = 0, dd = 0;
  for (const v of pnl) { eq += v; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq; }
  const sw = sweepWindows(tr, T0, T1, RULES, 1);
  const pass = sw.passRate != null ? sw.passRate
    : (100 * sw.windows.filter((w) => w.outcome === "PASS").length) / sw.windows.length;
  const t0 = tr[0].entryTime, mid = t0 + (tr[tr.length - 1].entryTime - t0) / 2;
  return {
    n: tr.length, total: pnl.reduce((a, b) => a + b, 0), avg: avg(pnl),
    win: (100 * pnl.filter((x) => x > 0).length) / tr.length,
    hold: avg(tr.map((t) => t.bars)), dd, pass,
    h1: avg(tr.filter((t) => t.entryTime < mid).map((t) => t.pnl)),
    h2: avg(tr.filter((t) => t.entryTime >= mid).map((t) => t.pnl)),
    trades: tr, res,
  };
}

const row = (lab, m) => "  " + lab.padEnd(26) + String(m.n).padStart(7) +
  ("$" + Math.round(m.total).toLocaleString()).padStart(12) +
  ("$" + m.avg.toFixed(2)).padStart(10) + m.win.toFixed(1).padStart(7) +
  m.hold.toFixed(0).padStart(6) +
  ("$" + Math.round(m.dd).toLocaleString()).padStart(11) + m.pass.toFixed(1).padStart(7) +
  ("$" + m.h1.toFixed(2) + " / $" + m.h2.toFixed(2)).padStart(20);
const HEAD = "  rule                      trades     total $     avg $   win%  hold     max DD   pass%    1st / 2nd half";

console.log("");
console.log("=".repeat(108));
console.log("IS THE ANTICIPATION POINTING THE RIGHT WAY?   macd_5m_quiet_anticipate, shipped defaults");
console.log("=".repeat(108));

// ── PART 1: how much time is actually spent offside ─────────────────────
// Re-derive the 5-minute histogram the strategy saw, then walk each trade bar by
// bar and count how long the position sat on the opposite side of zero.
const base = measure(build("fade", 0), {});
const tfMin = S.timeframeMin || 5;
const { resample } = await import("../src/resample.mjs");
const tf5 = resample(bars, tfMin);
const hist5 = S.compute(tf5, resolveParams(S, {})).overlays.find((o) => o.kind === "hist").data;

let offBars = 0, totBars = 0, crossArrived = 0;
const offShare = [], arrivedPnl = [], neverPnl = [];
for (const t of base.trades) {
  const a = t.entryIdx, b = t.exitIdx;
  if (a == null || b == null || b <= a) continue;
  let off = 0, tot = 0, hit = false;
  for (let i = a; i <= b && i < hist5.length; i++) {
    const v = hist5[i];
    if (!Number.isFinite(v)) continue;
    tot++;
    const sameSide = (v >= 0 ? 1 : -1) === t.dir;
    if (sameSide) hit = true; else off++;
  }
  if (!tot) continue;
  offBars += off; totBars += tot;
  offShare.push(off / tot);
  if (hit) { crossArrived++; arrivedPnl.push(t.pnl); } else neverPnl.push(t.pnl);
}
console.log("");
console.log("PART 1 -- how much of the time is the position on the wrong side of zero?");
console.log("");
console.log("  share of all bars-in-trade spent offside        " +
  (100 * offBars / totBars).toFixed(1) + "%");
console.log("  median trade's share spent offside              " +
  (100 * offShare.sort((x, y) => x - y)[offShare.length >> 1]).toFixed(1) + "%");
console.log("  trades where the histogram NEVER reached the position's side  " +
  neverPnl.length.toLocaleString() + " of " + base.trades.length.toLocaleString() +
  " (" + (100 * neverPnl.length / base.trades.length).toFixed(1) + "%)");
console.log("");
console.log("  the cross ARRIVED during the trade    " + crossArrived.toLocaleString().padStart(6) +
  " trades   avg $" + avg(arrivedPnl).toFixed(2));
console.log("  it NEVER did                          " + neverPnl.length.toLocaleString().padStart(6) +
  " trades   avg $" + avg(neverPnl).toFixed(2));
console.log("");
console.log("  So the chart is reading a real thing. The question is whether the rule is wrong");
console.log("  or whether this is the cost of a design that still nets out ahead.");

// ── PART 2: the alternatives, head to head ──────────────────────────────
console.log("");
console.log("PART 2 -- flip it, confirm it, or abandon it");
console.log("");
console.log(HEAD);
console.log("  " + "-".repeat(106));
console.log(row("FADE (what ships)", base));
const mom = measure(build("momentum", 0), {});
if (mom) console.log(row("MOMENTUM (sign flipped)", mom));
const con = measure(build("confirm", 0), {});
if (con) console.log(row("CONFIRM (wait for cross)", con));
for (const k of [1, 2, 3]) {
  const m = measure(build("fade", k), {});
  if (m) console.log(row("ABANDON on " + k + " wrong-way", m));
}

// ── PART 3: does the same hold without the fade exit muddying it? ───────
console.log("");
console.log("PART 3 -- the same four with the fade exit off, so only the ENTRY rule differs");
console.log("");
console.log(HEAD);
console.log("  " + "-".repeat(106));
for (const [lab, mode, ab] of [["FADE", "fade", 0], ["MOMENTUM", "momentum", 0],
                               ["CONFIRM", "confirm", 0], ["ABANDON on 2", "fade", 2]]) {
  const m = measure(build(mode, ab), { fadeBars: 0 });
  if (m) console.log(row(lab + ", no fade exit", m));
}
console.log("");
console.log("  The shipped book reads 25.8% here; the live Donchian+ORB bot reads about 51%.");
console.log("");
