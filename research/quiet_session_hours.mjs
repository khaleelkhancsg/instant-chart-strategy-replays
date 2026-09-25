// Which hours does the quiet-gated book actually earn in?
//
// The hypothesis under test, from reading the chart: it does best in the first
// couple of hours of the Asia open and in the first few hours of NY, and the
// win rate is carried by low-volatility sessions.
//
// ── THE CONFOUND THAT HAS TO COME OUT FIRST ─────────────────────────────
// A CME trading day starts at 17:00 ET, which is 16:00 CT. So the Asia open sits
// two to four hours INTO the session, when the day has mechanically spent almost
// none of its average range, and the NY open sits about sixteen hours in, when
// it usually has. The ADR gate is therefore already a partial proxy for "early
// in the session", and any hourly profile measured with it switched on will
// favour Asia whether or not the hour itself is special.
//
// Every hour is therefore measured TWICE, gate on and gate off. If Asia only
// looks good with the gate on, the hour is not what is good.
//
// ── AND A RESULT THAT POINTS THE OTHER WAY ──────────────────────────────
// research/anticipate_gates.mjs measured the NY session as the worst slice of
// the ungated book: RTH-only -1.10 pts a trade, first-two-hours-of-RTH -2.20,
// against +0.49 overnight. That was the ungated anticipation held to the
// opposite cross, not the shipped book with its fade exit, so it does not
// settle this -- but if NY now looks good, the difference is the exit and that
// is worth knowing rather than glossing.
//
// Hours are America/Chicago and DST-aware, because ctMin is. Note that Tokyo
// does not observe DST and the US does, so the Asia open moves between 18:00 CT
// in winter and 19:00 CT in summer -- both windows are tested rather than
// picking one.
//
//   node research/quiet_session_hours.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { sweepWindows } from "../src/challenge.mjs";

const { bars } = loadBars();
const strategies = await loadStrategies({ force: true });
const S = strategies.get("macd_5m_quiet_anticipate");
const EXEC = S.execDefaults || {};
const RULES = S.rulesDefaults || {};
const T0 = bars.ts[0], T1 = bars.ts[bars.ts.length - 1];

// A variant that keeps the strategy exactly as shipped but masks entries outside
// an arbitrary minute-of-day window. The strategy's own session gate is set to
// "any" so the two do not compound.
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
  const s = variant(inWindow);
  const p = resolveParams(S, { sessionGate: "any", ...over });
  return runStrategy(bars, s, p, EXEC).trades || [];
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
const avg = (a) => (a.length ? sum(a) / a.length : NaN);
function metrics(trades, withPass) {
  if (!trades.length) return null;
  const pnl = trades.map((t) => t.pnl);
  let eq = 0, peak = 0, dd = 0;
  for (const v of pnl) { eq += v; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  const t0 = trades[0].entryTime, t1 = trades[trades.length - 1].entryTime;
  const mid = t0 + (t1 - t0) / 2;
  let pass = null;
  if (withPass) {
    const sw = sweepWindows(trades, T0, T1, RULES, 1);
    pass = sw.passRate != null ? sw.passRate
      : (100 * sw.windows.filter((w) => w.outcome === "PASS").length) / sw.windows.length;
  }
  return {
    n: trades.length, total: sum(pnl), avg: avg(pnl),
    win: (100 * pnl.filter((x) => x > 0).length) / trades.length,
    dd,
    h1: avg(trades.filter((t) => t.entryTime < mid).map((t) => t.pnl)),
    h2: avg(trades.filter((t) => t.entryTime >= mid).map((t) => t.pnl)),
    pass,
  };
}

// ── PART 1: the hourly profile, gate on and gate off ────────────────────
console.log("");
console.log("=".repeat(104));
console.log("WHICH HOURS EARN?   macd_5m_quiet_anticipate, defaults, through the real engine");
console.log("=".repeat(104));
console.log("");
console.log("  A CME day starts 16:00 CT. Asia open is ~18:00-19:00 CT, NY RTH open is 08:30 CT.");
console.log("");
console.log("  hour CT    ---------- ADR gate ON ----------    --------- ADR gate OFF ---------");
console.log("             trades   avg $    win%     total $    trades   avg $    win%    total $");
console.log("  " + "-".repeat(94));

const onAll = run({}, null);
const offAll = run({ adrMax: 2 }, null);
const byHour = (trades) => {
  const m = new Map();
  for (const t of trades) {
    // Bucket on the CT hour the trade ENTERED, which is what a session gate
    // would actually key on.
    const h = Math.floor(t.ctMinEntry / 60);
    if (!m.has(h)) m.set(h, []);
    m.get(h).push(t);
  }
  return m;
};
// runStrategy does not carry ctMin onto the trade, so recover it from the bar.
const tfMin = S.timeframeMin || 5;
function tagCt(trades) {
  for (const t of trades) {
    const src = t.entrySrc != null ? t.entrySrc : 0;
    t.ctMinEntry = bars.ctMin ? bars.ctMin[Math.min(src, bars.ctMin.length - 1)] : 0;
  }
  return trades;
}
const HON = byHour(tagCt(onAll)), HOFF = byHour(tagCt(offAll));
const cell = (g) => g && g.length >= 40
  ? String(g.length).padStart(7) + ("$" + avg(g.map((t) => t.pnl)).toFixed(2)).padStart(9) +
    ((100 * g.filter((t) => t.pnl > 0).length) / g.length).toFixed(1).padStart(8) + "%" +
    ("$" + Math.round(sum(g.map((t) => t.pnl))).toLocaleString()).padStart(11)
  : "      -        -        -          -";
for (let h = 0; h < 24; h++) {
  const a = HON.get(h), b = HOFF.get(h);
  if (!a && !b) continue;
  const lab = String(h).padStart(2, "0") + ":00";
  const mark = (h >= 18 && h < 21) ? " A" : (h === 8 || h === 9 || h === 10) ? " N" : "  ";
  console.log("  " + lab + mark + "    " + cell(a) + "  " + cell(b));
}
console.log("");
console.log("  A = Asia open window, N = NY open window.");

// ── PART 2: the hypothesis as gates ─────────────────────────────────────
const W = {
  "current default (overnight)": (c) => c < 510 || c >= 900,
  "Asia 18:00-20:00": (c) => c >= 1080 && c < 1200,
  "Asia 19:00-21:00": (c) => c >= 1140 && c < 1260,
  "Asia 18:00-21:00": (c) => c >= 1080 && c < 1260,
  "NY 08:30-10:30": (c) => c >= 510 && c < 630,
  "NY 08:30-11:30": (c) => c >= 510 && c < 690,
  "Asia 18-21 + NY 0830-1130": (c) => (c >= 1080 && c < 1260) || (c >= 510 && c < 690),
  "Asia 18-20 + NY 0830-1030": (c) => (c >= 1080 && c < 1200) || (c >= 510 && c < 630),
};

console.log("");
console.log("PART 2 -- the hypothesis as an entry gate, ADR gate left ON (the shipped default)");
console.log("");
console.log("  window                        trades     total $     avg $   win%     max DD   pass%    1st / 2nd half");
console.log("  " + "-".repeat(102));
const rows = [];
for (const [lab, fn] of Object.entries(W)) {
  const m = metrics(run({}, fn), true);
  if (!m) { console.log("  " + lab.padEnd(28) + "  (no trades)"); continue; }
  rows.push({ lab, m });
  console.log("  " + lab.padEnd(28) + String(m.n).padStart(7) +
    ("$" + Math.round(m.total).toLocaleString()).padStart(12) +
    ("$" + m.avg.toFixed(2)).padStart(10) + m.win.toFixed(1).padStart(7) +
    ("$" + Math.round(m.dd).toLocaleString()).padStart(11) +
    (m.pass == null ? "     -" : m.pass.toFixed(1).padStart(6)) +
    ("$" + m.h1.toFixed(2) + " / $" + m.h2.toFixed(2)).padStart(20));
}

console.log("");
console.log("PART 3 -- the same windows with the ADR gate OFF, to see what the hour is worth alone");
console.log("");
console.log("  window                        trades     total $     avg $   win%     max DD   pass%    1st / 2nd half");
console.log("  " + "-".repeat(102));
for (const [lab, fn] of Object.entries(W)) {
  const m = metrics(run({ adrMax: 2 }, fn), true);
  if (!m) { console.log("  " + lab.padEnd(28) + "  (no trades)"); continue; }
  console.log("  " + lab.padEnd(28) + String(m.n).padStart(7) +
    ("$" + Math.round(m.total).toLocaleString()).padStart(12) +
    ("$" + m.avg.toFixed(2)).padStart(10) + m.win.toFixed(1).padStart(7) +
    ("$" + Math.round(m.dd).toLocaleString()).padStart(11) +
    (m.pass == null ? "     -" : m.pass.toFixed(1).padStart(6)) +
    ("$" + m.h1.toFixed(2) + " / $" + m.h2.toFixed(2)).padStart(20));
}

console.log("");
console.log("  pass% is over every 30-day window in the dataset, stepped daily -- the objective.");
console.log("  The shipped default reads 22.0%; the Donchian+ORB bot that is actually live reads ~51%.");
console.log("");
