// Does any trade the backtester takes depend on bars after it? An end-to-end look-ahead audit.
//
//   node --max-old-space-size=8192 research/lookahead_audit.mjs [--all] [--quick]
//
// test.mjs section 7 checks each strategy's signals on data cut at two points. This goes further
// for the books the bots trade. The whole pipeline runs again on the data cut short at many
// points: resampling, the strategy, its higher-timeframe and day gates, and the engine's orders,
// fills, exits and day rules. Every trade a cut run could know must be the full run's to the cent.
//   entry cut    the data ends with the strategy bar a 2026 trade filled in. The trade must be
//                open, with the same entry, size, bracket and signal bar.
//   exit cut     the data ends with its exit bar. The trade must match whole: exit, P&L, and its
//                worst and best points. Every trade closed before must match too.
//   signal cut   the data ends with a 2026 signal bar, a gate's refusals included. The
//                strategy's outputs there must not change: signal, size, ATR and exits.
//   random cut   a random minute in 2026, usually mid-bar. Every trade closed before the cut's
//                bar must match.
// The full run and every cut run start on the same bar (2025-10-01), so the warm-up is the same.
// The bars are data/mnq_1m_beta.bin, to Oct 30 2026. The books: the $1,250 bot (donchian_1250 on
// the $1,250 eval), the $3,000 bot (donchian_shipped on the $3,000 eval) and the MACD fade
// (macd_fade_1250). --all adds every other strategy at its defaults, with signal and random cuts.
// --canary runs two copies of donchian_1250 that cheat, which the audit must catch.
//
// RESULT (run 2026-11-21, --all): no trade or signal changed when later bars were removed.
//   - $1,250 bot, 198 trades in 2026: entry cuts 198/198, exit cuts 198/198, trades closed before
//     198/198, signal cuts 400/400, random cuts 150/150. No exit bar reached both stop and target.
//   - $3,000 bot, 244 trades: all pass. One exit was booked as the data's end at the same bar and
//     price (an early close). One exit bar reached both its stop and its target; the stop is
//     assumed.
//   - MACD fade, 285 trades: all pass.
//   - The 35 other strategies: signal cuts 48/48 and random cuts 12/12 each.
//   - The canaries are caught:
//       - acting one bar early fails 40 of 40 signal cuts;
//       - the day's final range fails 91 of 241 entry cuts, 75 exit cuts and 13 of 40 signal cuts.
//     Random cuts caught neither.
//   - bot/test_donchian1250_parity.py, run the same day: 38 of 38 checks pass. The bot's own code,
//     fed one bar at a time through a simulated gateway, made the backtester's 128 trades of 2026
//     (to Jul 14). With orders on the tick grid it made the same 128 trades, +$28 over the year.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { sliceBars, indexAtOrAfter, resample } from "../src/resample.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { mulberry32 } from "../src/dayeval.mjs";
import { configOf } from "./lib_eval1250.mjs";

const args = process.argv.slice(2), ALL = args.includes("--all"), QUICK = args.includes("--quick");
const START = Date.UTC(2025, 9, 1), Y26 = Date.UTC(2026, 0, 1);
const RANDOM_CUTS = QUICK ? 20 : 150, SIGNAL_CUTS = QUICK ? 40 : 400, OTHER_CUTS = QUICK ? 4 : 12;
const t0 = Date.now();
const whole = loadBars("data/mnq_1m_beta.bin").bars, s0 = indexAtOrAfter(whole.ts, START);
const B = { ...sliceBars(whole, s0, whole.count), count: whole.count - s0 }, N = B.ts.length;
const cutAt = (k) => ({ ...sliceBars(B, 0, k), count: k });        // the 1-minute bars [0, k)

const ENTRY = ["entryTime", "dir", "entryPrice", "stop", "target", "contracts", "sigIdx", "entryType", "limitFill"];
const WHOLE = [...ENTRY, "exitTime", "exitPrice", "pnl", "mae", "mfe", "reason"];
const same = (a, b, keys) => keys.every((k) => a[k] === b[k] || (Number.isNaN(a[k]) && Number.isNaN(b[k])));
const diff = (a, b, keys) => keys.filter((k) => !(a[k] === b[k] || (Number.isNaN(a[k]) && Number.isNaN(b[k])))).map((k) => `${k} ${a[k]} vs ${b[k]}`).join(", ");
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

function audit(name, cfg, { perTrade = true, randomCuts = RANDOM_CUTS, signalCuts = SIGNAL_CUTS } = {}) {
  const tf = cfg.params.timeframeMin || cfg.s.timeframeMin || 1, TFMS = tf * 60000;
  const run = (bars) => runStrategy(bars, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies: cfg.studies, fromMs: Y26 }).trades;
  const through = (t) => indexAtOrAfter(B.ts, (Math.floor(t / TFMS) + 1) * TFMS);   // the cut that ends with t's strategy bar
  const full = run(B), t26 = full.filter((t) => t.entryTime >= Y26);
  const res = { trades: t26.length, entry: [0, 0], exit: [0, 0], endBooked: 0, prefix: [0, 0], signal: [0, 0], random: [0, 0], ambiguous: t26.filter((t) => t.ambiguous).length, bad: [] };
  const note = (kind, msg) => { if (res.bad.length < 12) res.bad.push(`${kind}: ${msg}`); };
  // every trade the full run closed before `before` must be the cut run's, in order
  const prefixOk = (cut, before) => {
    const a = full.filter((t) => t.exitTime < before), b = cut.filter((t) => t.exitTime < before);
    if (a.length !== b.length) return `${b.length} trades closed before ${iso(before)} against ${a.length}`;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i], WHOLE)) return `trade entered ${iso(a[i].entryTime)}: ${diff(a[i], b[i], WHOLE)}`;
    return null;
  };
  if (perTrade) for (const T of t26) {
    // entry cut
    let cut = run(cutAt(through(T.entryTime)));
    let u = cut.find((x) => x.entryTime === T.entryTime && x.dir === T.dir);
    res.entry[1]++;
    if (u && same(T, u, ENTRY)) res.entry[0]++; else note("entry", `${iso(T.entryTime)} ${u ? diff(T, u, ENTRY) : "missing from the cut run"}`);
    // exit cut
    cut = run(cutAt(through(T.exitTime)));
    u = cut.find((x) => x.entryTime === T.entryTime && x.dir === T.dir);
    res.exit[1]++;
    if (u && same(T, u, WHOLE)) res.exit[0]++;
    else if (u && same(T, u, WHOLE.filter((k) => k !== "reason")) && u.reason === "EOD") { res.exit[0]++; res.endBooked++; }   // the same exit, booked as the data's end
    else note("exit", `${iso(T.entryTime)} ${u ? diff(T, u, WHOLE) : "missing from the cut run"}`);
    const p = prefixOk(cut, Math.floor(T.exitTime / TFMS) * TFMS);
    res.prefix[1]++;
    if (!p) res.prefix[0]++; else note("prefix", `cut at ${iso(T.exitTime)}: ${p}`);
  }
  // signal cuts: the strategy's own outputs at its last bar
  const keys = ["sig", "atr", "exitSig", "sizeMult", "orderPx", "stopPts", "targetPts"];
  const tfFull = resample(B, tf), oF = cfg.s.compute(tfFull, cfg.params);
  const sigBars = [];
  for (let k = 1; k < tfFull.ts.length - 1; k++) if (oF.sig[k] && tfFull.ts[k] >= Y26) sigBars.push(k);
  const r = mulberry32(99);
  const pickN = (xs, n) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };
  for (const k of pickN(sigBars, signalCuts)) {
    const tfCut = resample(cutAt(indexAtOrAfter(B.ts, tfFull.ts[k] + TFMS)), tf), oP = cfg.s.compute(tfCut, cfg.params);
    const m = tfCut.ts.length - 1;
    res.signal[1]++;
    if (tfCut.ts[m] !== tfFull.ts[k]) { note("signal", `cut at ${iso(tfFull.ts[k])} ends on ${iso(tfCut.ts[m])}`); continue; }
    const bad = keys.filter((key) => (oF[key] || oP[key]) && !(oF[key][k] === oP[key][m] || (Number.isNaN(oF[key][k]) && Number.isNaN(oP[key][m]))));
    if (!bad.length) res.signal[0]++; else note("signal", `${iso(tfFull.ts[k])}: ${bad.map((key) => `${key} ${oF[key][k]} vs ${oP[key][m]}`).join(", ")}`);
  }
  // random cuts, usually mid-bar
  const lo = indexAtOrAfter(B.ts, Y26);
  for (let c = 0; c < randomCuts; c++) {
    const k = lo + 1 + Math.floor(r() * (N - lo - 2)), cut = run(cutAt(k));
    const p = prefixOk(cut, Math.floor(B.ts[k - 1] / TFMS) * TFMS);
    res.random[1]++;
    if (!p) res.random[0]++; else note("random", `cut at ${iso(B.ts[k - 1])}: ${p}`);
  }
  const f = (x) => `${x[0]}/${x[1]}`;
  console.log(`${name.padEnd(34)} trades ${String(res.trades).padStart(4)} | entry cuts ${f(res.entry).padStart(9)} | exit cuts ${f(res.exit).padStart(9)} (end-booked ${res.endBooked}) | ` +
              `closed before ${f(res.prefix).padStart(9)} | signal cuts ${f(res.signal).padStart(9)} | random ${f(res.random).padStart(9)} | stop+target bars ${res.ambiguous} | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  for (const b of res.bad) console.log(`    MISMATCH ${b}`);
  return res;
}

// --canary: the audit must catch a book that peeks. Two copies of donchian_1250 that cheat:
//   one bar early   each signal is acted on a bar before it happened (sig[k] = sig[k + 1]);
//   the day's range the late size reads the day's final RTH range, not the range so far.
if (args.includes("--canary")) {
  const { rthRangeUsed } = await import("../src/indicators.mjs");
  const base = await configOf("donchian_1250", {}, "1250");
  const cheat = (label, f) => ({ ...base, s: { ...base.s, id: `${base.s.id}~${label}`, compute(b, p) { return f(base.s.compute(b, p), b, p); } } });
  const early = cheat("early", (o) => { const sig = Int8Array.from(o.sig, (_, k) => (k + 1 < o.sig.length ? o.sig[k + 1] : 0)); return { ...o, sig }; });
  const dayEnd = cheat("dayend", (o, b, p) => {
    const used = rthRangeUsed(b, Math.max(2, Math.trunc(p.adrDays) || 10)), last = new Map();
    for (let k = 0; k < used.length; k++) if (Number.isFinite(used[k])) last.set(b.tday[k], used[k]);   // the day's final reading
    const sizeMult = Float64Array.from(o.sizeMult, (m, k) => (o.sig[k] && m > 0 ? ((last.get(b.tday[k]) ?? 0) >= p.lateRangeUsed ? p.lateFrac : 1) : m));
    return { ...o, sizeMult };
  });
  for (const [name, cfg] of [["canary: one bar early", early], ["canary: the day's final range", dayEnd]])
    audit(name, cfg, { randomCuts: 20, signalCuts: 40 });
  process.exit(0);
}

const out = {};
const BOOKS = [["$1,250 bot: donchian_1250, $1,250", "donchian_1250", "1250"], ["$3,000 bot: donchian_shipped, $3,000", "donchian_shipped", "3000"], ["MACD fade: macd_fade_1250, $1,250", "macd_fade_1250", "1250"]];
for (const [name, id, ev] of BOOKS) out[name] = audit(name, await configOf(id, {}, ev));
if (ALL) {
  const strategies = await loadStrategies();
  for (const [id, s] of [...strategies].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (s.chartOnly || BOOKS.some((b) => b[1] === id)) continue;
    out[id] = audit(id, await configOf(id, {}, "3000"), { perTrade: false, randomCuts: OTHER_CUTS, signalCuts: OTHER_CUTS * 4 });
  }
}
const bad = Object.values(out).reduce((s, r) => s + r.bad.length, 0);
console.log(`\n${bad ? `${bad} MISMATCHES` : "No trade or signal changed when later bars were removed."} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
fs.writeFileSync(`research/lookahead_audit${ALL ? "_all" : ""}_results.json`, JSON.stringify({ run: new Date().toISOString(), quick: QUICK, results: out }, null, 1));
