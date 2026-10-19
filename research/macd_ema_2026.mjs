// MACD and EMA signals on 2026 ONLY, with normal and high-win-rate targets,
// followed and faded -- the same questions the Donchian book was just asked.
//
// Every number comes from 2026 trades and from 21-day windows drawn from 2026
// days (2 Jan - 14 Jul, 139 sessions). Earlier history only warms the
// indicators up. Jan-Mar and Apr-Jul are the check inside 2026.
//
// SIGNALS, each on 1, 2 and 5-minute bars:
//   MACD cross          12/26/9 histogram changes sign
//   anticipation        the user's pattern: the histogram has moved toward zero
//                       3 bars in a row and is within 0.075x its own 200-bar
//                       average size -> trade toward the coming cross. Three
//                       gates: none, RTH, and the validated QUIET gate
//                       (overnight, day under half its 14-day average range)
//   momentum            the histogram has grown away from zero 3 bars in a row
//   EMA cross           9/21, 12/26, 20/50
//   MTF                 (1-min only) a 1-min MACD cross in the direction of the
//                       last completed 5-min MACD histogram
// Each followed and FADED (the opposite side), traded the way the bot trades:
// stop-entry one bar later, 5 ATR stop capped at the $1,000 day cap, 8 lots,
// -$500 breaker, +$750 profit block, flat 15:05 CT. RTH signals 08:30-15:00;
// overnight signals 17:00-08:30 with the account's 15:05-17:00 flat window.
// Targets: the live 1.75 ATR, and 0.1-1x the stop measured from the fill.
// Entry: the bot's 0.15 ATR stop-entry, and a near-market one (one tick).
//
// RESULT (2026 only, honest limit fills, 1,056 configs): a high win rate does
// not help here either. Configs winning 85-100% of trades average 9.4% passes
// (best 34.7%); pass rate peaks among 55-70% win rates. The best configs are
// 1-minute and lean AGAINST the short-term push: fading 1-min MACD crosses with
// a 1x-stop target passes 50.5-51.7% (Jan-Mar 52-53, Apr-Jul 54-55); the
// user's anticipation (RTH, no ADR gate) with a 1x target 49.9-50.0% (49 / 53)
// -- above the live Donchian's 34.5%. As a group they are selection, though:
// the best 10 picked on one half of 2026 average 26.7-34.6% on the other, no
// better than the live book there. The validated quiet-gated (overnight)
// anticipation is uneven: best 44% (Jan-Mar 29, Apr-Jul 51). A first run
// without honest limit fills put many tiny-target configs at 55-64%; that was
// the artifact.
//
//   node --max-old-space-size=8192 research/macd_ema_2026.mjs

import fs from "node:fs";
import { ema, macd } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const T0 = Date.now();
const days = S.days;
const at = (arr, ix) => S.passArr(ix.map((k) => arr[k]));
const PV = 2, LOTS = 8;
const stopDist = (a, lots) => Math.min(5.15 * a, 1000 / (PV * lots));
const in2026 = (t) => S.yearOf.get(t.tday) === 2026;

// ---- signals on one bar size ---------------------------------------------------
function buildSignals(tfMin) {
  const E = S.engineFor(tfMin);
  const { high: H, low: L, close: C, ctMin: CT, tday: TD } = E.tf;
  const n = C.length;
  const rth = (i) => CT[i] >= 510 && CT[i] < 900;
  const night = (i) => CT[i] >= 1020 || CT[i] < 510;
  const hist = macd(C, 12, 26, 9).hist;
  // the anticipation's own yardstick: trailing mean |hist| over 200 bars
  const scale = new Float64Array(n).fill(NaN);
  { let s = 0; for (let i = 0; i < n; i++) { s += Math.abs(hist[i]) || 0; if (i >= 200) s -= Math.abs(hist[i - 200]) || 0; if (i >= 199) scale[i] = s / 200; } }
  // the quiet gate's ADR: day's high-low so far over the mean of the previous 14 days' ranges
  const adrUsed = new Float64Array(n).fill(NaN);
  { const rg = []; let hi = -Infinity, lo = Infinity, adr = NaN, d = TD[0];
    for (let i = 0; i < n; i++) {
      if (TD[i] !== d) { d = TD[i]; if (hi > lo) { rg.push(hi - lo); if (rg.length > 14) rg.shift(); adr = rg.length === 14 ? rg.reduce((a, b) => a + b, 0) / 14 : NaN; } hi = -Infinity; lo = Infinity; }
      if (H[i] > hi) hi = H[i]; if (L[i] < lo) lo = L[i];
      if (adr > 0) adrUsed[i] = (hi - lo) / adr;
    } }
  const mk = (f) => { const s = new Int8Array(n); for (let i = 1; i < n; i++) s[i] = f(i) || 0; return s; };
  const out = {};
  out["MACD cross"] = mk((i) => (hist[i] > 0 && hist[i - 1] <= 0 ? 1 : hist[i] < 0 && hist[i - 1] >= 0 ? -1 : 0));
  // anticipation, as strategies/macd_5m_quiet_anticipate.mjs defines it
  const shrink = new Int16Array(n);
  for (let i = 1; i < n; i++) shrink[i] = Math.abs(hist[i]) < Math.abs(hist[i - 1]) ? shrink[i - 1] + 1 : 0;
  const antic = (i) => (shrink[i] >= 3 && Math.abs(hist[i]) < 0.075 * scale[i] ? (hist[i] >= 0 ? -1 : 1) : 0);
  out["anticipation, any time"] = mk(antic);
  out["anticipation, quiet gate"] = mk((i) => (night(i) && adrUsed[i] < 0.5 ? antic(i) : 0));
  const grow = new Int16Array(n);
  for (let i = 1; i < n; i++) grow[i] = Math.abs(hist[i]) > Math.abs(hist[i - 1]) && Math.sign(hist[i]) === Math.sign(hist[i - 1]) ? grow[i - 1] + 1 : 0;
  out["momentum (3 bars growing)"] = mk((i) => (grow[i] === 3 ? Math.sign(hist[i]) : 0));
  for (const [f, s] of [[9, 21], [12, 26], [20, 50]]) {
    const ef = ema(C, f), es = ema(C, s);
    out["EMA " + f + "/" + s + " cross"] = mk((i) => (ef[i] > es[i] && ef[i - 1] <= es[i - 1] ? 1 : ef[i] < es[i] && ef[i - 1] >= es[i - 1] ? -1 : 0));
  }
  if (tfMin === 1) {
    const t5 = S.engineFor(5).tf, h5 = macd(t5.close, 12, 26, 9).hist, n5 = t5.close.length;
    const k5 = new Int32Array(n).fill(-1);
    { let j = 0, cur = -1; for (let i = 0; i < n; i++) { while (j < n5 && t5.srcLast[j] <= E.tf.srcLast[i]) { cur = j; j++; } k5[i] = cur; } }
    const cross = out["MACD cross"];
    out["MTF: 1-min cross with 5-min MACD"] = mk((i) => (cross[i] && k5[i] >= 0 && Math.sign(h5[k5[i]]) === cross[i] ? cross[i] : 0));
  }
  // session versions: RTH, and overnight where the signal's validated gate is overnight
  const sess = {};
  for (const [k, s] of Object.entries(out)) {
    if (k.includes("quiet gate")) { sess[k] = { sig: s, overnight: true }; continue; }
    sess[k + " | RTH"] = { sig: mk((i) => (rth(i) ? s[i] : 0)), overnight: false };
  }
  return { E, sess };
}

// ---- scoring, 2026 only --------------------------------------------------------
// limitFillTp "close": on the bar a refused stop fills as a limit, the target only
// counts if that bar also CLOSED beyond it -- the bar's high may predate the fill.
function score(E, sig, opts) {
  const tr = E.run(() => LOTS, { signals: sig, limitFillTp: "close", ...opts }).filter(in2026);
  const arr = S.dayArr(tr, days);
  const w = tr.filter((t) => t.pnl > 0).length;
  return { n: tr.length, win: tr.length ? (100 * w) / tr.length : 0, exp: tr.length ? tr.reduce((s, t) => s + t.pnl, 0) / tr.length : 0,
           y26: at(arr, M.Y26), a26: at(arr, M.Y26a), b26: at(arr, M.Y26b) };
}
const TGT = [["live 1.75 ATR", null], ["RR 0.1", 0.1], ["RR 0.2", 0.2], ["RR 0.3", 0.3], ["RR 0.5", 0.5], ["RR 1", 1]];
const FILLS = [["realistic", { slipMult: 1, feeMult: 1 }], ["sim fills", { slipMult: 0, feeMult: 1 }]];
const TRIGS = [["stop-entry 0.15 ATR", 0.15], ["near-market (1 tick)", 0]];
const all = [];
const live = score(S.engineFor(2), M.RESC, {});
for (const tfMin of [1, 2, 5]) {
  const { E, sess } = buildSignals(tfMin);
  for (const [name, { sig, overnight }] of Object.entries(sess)) {
    for (const [side, s] of [["follow", sig], ["fade", Int8Array.from(sig, (v) => -v)]]) {
      for (const [fillName, fo] of FILLS) for (const [trigName, tg] of TRIGS) for (const [tName, rr] of TGT) {
        const r = score(E, s, { ...fo, trig: tg, overnight, ...(rr === null ? {} : { tpFromFill: true, tpFn: (a, q) => rr * stopDist(a, q) }) });
        all.push({ tf: tfMin, name, side, fill: fillName, trig: trigName, target: tName, ...r });
      }
    }
  }
  process.stderr.write(`  ${tfMin}-min done, ${all.length} configs, ${((Date.now() - T0) / 1000).toFixed(0)}s\n`);
}
fs.writeFileSync(new URL("./macd_ema_2026_results.json", import.meta.url), JSON.stringify(all));

// ---- report --------------------------------------------------------------------
const f1 = (x, w = 6) => x.toFixed(1).padStart(w);
const label = (r) => (r.tf + "m " + r.name + ", " + r.side + ", " + r.target + ", " + (r.trig.startsWith("stop") ? "stop-entry" : "near-mkt")).slice(0, 78);
const line = (r) => "  " + label(r).padEnd(80) + String(r.n).padStart(6) + f1(r.win, 7) + f1(r.exp, 8) + f1(r.y26, 8) + f1(r.a26, 8) + f1(r.b26, 8);
const HD = "  " + "config (2026 only, 8 lots)".padEnd(80) + "trades".padStart(6) + "win%".padStart(7) + "$/tr".padStart(8) + "2026".padStart(8) + "JanMar".padStart(8) + "AprJul".padStart(8);
console.log("\n  Live Donchian book, same scoring: 2026 " + live.y26.toFixed(1) + "% (Jan-Mar " + live.a26.toFixed(1) + ", Apr-Jul " + live.b26.toFixed(1) +
  "), " + live.win.toFixed(1) + "% wins, $" + live.exp.toFixed(0) + "/trade");
for (const fillName of ["realistic", "sim fills"]) {
  const rs = all.filter((r) => r.fill === fillName);
  console.log("\n" + "=".repeat(128) + "\n" + fillName.toUpperCase() + ": the best target per signal family and side, by 2026 pass rate\n" + "=".repeat(128) + "\n" + HD);
  const groups = new Map();
  for (const r of rs) { const k = r.tf + "|" + r.name + "|" + r.side; if (!groups.has(k) || groups.get(k).y26 < r.y26) groups.set(k, r); }
  for (const r of [...groups.values()].sort((a, b) => b.y26 - a.y26)) console.log(line(r));
  // How well does picking on one half of 2026 carry to the other?
  for (const [fit, test, fl, tl, base] of [["a26", "b26", "Jan-Mar", "Apr-Jul", live.b26], ["b26", "a26", "Apr-Jul", "Jan-Mar", live.a26]]) {
    const top = rs.slice().sort((a, b) => b[fit] - a[fit]).slice(0, 10);
    const m = (k) => top.reduce((s, r) => s + r[k], 0) / top.length;
    console.log("\n  picked on " + fl + " (best 10 of " + rs.length + "): " + m(fit).toFixed(1) + "% there, " + m(test).toFixed(1) + "% on " + tl +
      " (live book on " + tl + ": " + base.toFixed(1) + "%). Best single: " + label(top[0]) + " -> " + top[0][test].toFixed(1) + "%");
  }
}
// the high-win-rate question directly: win rate vs pass rate across everything
console.log("\n  HIGH WIN RATE vs PASS RATE (sim fills, all " + all.filter((r) => r.fill === "sim fills").length + " configs)");
for (const [lo, hi] of [[0, 40], [40, 55], [55, 70], [70, 85], [85, 101]]) {
  const rs = all.filter((r) => r.fill === "sim fills" && r.n >= 20 && r.win >= lo && r.win < hi);
  if (!rs.length) continue;
  const m = (k) => rs.reduce((s, r) => s + r[k], 0) / rs.length;
  console.log("    win rate " + (lo + "-" + Math.min(hi, 100) + "%").padEnd(9) + String(rs.length).padStart(5) + " configs   mean $/trade " + f1(m("exp"), 7) +
    "   mean 2026 pass " + f1(m("y26")) + "%   best " + f1(Math.max(...rs.map((r) => r.y26))) + "%");
}
console.log("\n  (" + all.length + " configs, " + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
