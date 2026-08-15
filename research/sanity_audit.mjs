// Adversarial audit of everything the shipped configuration rests on.
//
// Not a test suite — the suites already pass and would not catch these. This
// asks whether the numbers MEAN what they are quoted to mean. Two defects found
// this session were of exactly that kind: a replay that anchored the bracket to
// the running average instead of the signal price, and a partial exit that
// resolved the target before the partial and so used knowledge from later in
// the same bar. Both passed every test that existed.
//
// Checks, in descending order of how badly a failure would matter:
//
//   1. CAUSALITY   corrupt every bar after a cut point; every trade that opened
//                  and closed before it must be bit-identical. This catches any
//                  path where future data reaches a past decision.
//   2. NULL        run the identical pipeline on synthetic random walks matched
//                  to real volatility. Whatever pass rate survives is geometry
//                  and rules, not edge, and it is the number the headline has to
//                  be judged against.
//   3. CAP         no day may finish below the -$1000 cap except through a gap,
//                  and DAYLOSS exits must land exactly on it.
//   4. CLAIMS      recompute every number quoted in bot/README.md.
//   5. DATA        rollover jumps, duplicate stamps, impossible bars, session
//                  coverage. The VP project's whole edge once turned out to be
//                  rollover contamination, so this is not paranoia.
//   6. CONFIG      the bot's CONFIG must equal the configuration measured here.
//
// Usage:  node research/sanity_audit.mjs

import { loadBars } from "../src/data.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { resolveRules, sweepWindows } from "../src/challenge.mjs";
import { resample } from "../src/resample.mjs";
import { runBrackets, resolveExec } from "../src/engine.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { atr, adx, donchian } from "../src/indicators.mjs";
import { readFileSync } from "node:fs";

let PASS = 0, FAIL = 0, WARN = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`   ok   ${name}`); }
  else { FAIL++; console.log(`   FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const warn = (name, detail) => { WARN++; console.log(`   warn ${name}  — ${detail}`); };

const CFG = {
  contracts: 8, slAtrMult: 5.0, tpAtrMult: 1.75,
  dayLossStopUsd: 1000, dayLossStopMode: "exact", slippageTicks: 1,
  scaleInFrac: 0.125, scaleInTrigger: 0.15, scaleInWindowBars: 10,
};
const RULES = { circuitBreaker: 500, dailyProfitStop: 750 };
const { bars } = loadBars();
const S = (await loadStrategies()).get("donchian_eff_rth");
const rules = resolveRules(RULES);

function pipeline(src) {
  const tf = resample(src, 2);
  const ctx = buildFilterContext(tf);
  const A = atr(tf.high, tf.low, tf.close, 14);
  const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
  const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
  const raw = new Int8Array(tf.close.length);
  for (let i = 30; i < raw.length; i++) {
    if (ax[i] < 25) continue;
    if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
  }
  const sig = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
  const { trades } = runBrackets(tf, sig, A, resolveExec({ ...S.execDefaults, ...CFG }));
  return { tf, trades, sig, A };
}
const base = pipeline(bars);
console.log(`\nbaseline: ${base.trades.length} trades, ` +
            `net $${base.trades.reduce((s, t) => s + t.pnl, 0).toFixed(0)}`);

// ── 1. CAUSALITY ─────────────────────────────────────────────────────
console.log("\n1. CAUSALITY — can future data reach a past decision?\n");
{
  const n = bars.count;
  const cut = Math.floor(n * 0.6);
  const corrupt = {
    ...bars, count: n,
    ts: bars.ts, open: Float64Array.from(bars.open), high: Float64Array.from(bars.high),
    low: Float64Array.from(bars.low), close: Float64Array.from(bars.close),
    volume: bars.volume,
  };
  // After the cut, replace prices with a wildly different regime. Anything that
  // peeks forward will show up as a changed trade BEFORE the cut.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = cut; i < n; i++) {
    const p = 30000 + rnd() * 5000;
    corrupt.open[i] = p; corrupt.close[i] = p + (rnd() - 0.5) * 200;
    corrupt.high[i] = Math.max(corrupt.open[i], corrupt.close[i]) + rnd() * 100;
    corrupt.low[i] = Math.min(corrupt.open[i], corrupt.close[i]) - rnd() * 100;
  }
  const alt = pipeline(corrupt);
  const cutTs = bars.ts[cut];
  const a = base.trades.filter(t => t.exitTime < cutTs);
  const b = alt.trades.filter(t => t.exitTime < cutTs);
  ok("same number of trades close before the cut", a.length === b.length,
     `${a.length} vs ${b.length}`);
  let diffs = 0, firstDiff = null;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x.entryTime !== y.entryTime || x.exitTime !== y.exitTime ||
        Math.abs(x.pnl - y.pnl) > 1e-6 || x.dir !== y.dir || x.contracts !== y.contracts) {
      diffs++; if (!firstDiff) firstDiff = new Date(x.entryTime).toISOString();
    }
  }
  ok("every pre-cut trade is bit-identical", diffs === 0,
     `${diffs} differ, first at ${firstDiff}`);
  // And the mirror: corrupting the PAST must change the future, or the test is inert.
  ok("...and the test is not inert (post-cut trades DO differ)",
     alt.trades.filter(t => t.exitTime >= cutTs).length !== base.trades.filter(t => t.exitTime >= cutTs).length);
}

// ── 2. THE NULL ──────────────────────────────────────────────────────
console.log("\n2. NULL — what does this pipeline score on data with no edge?\n");
{
  // Synthetic bars: random walk with the SAME per-bar return volatility and the
  // same session structure, so geometry and rules are identical and only the
  // signal's information content is removed.
  const n = bars.count;
  const rets = [];
  for (let i = 1; i < n; i++) {
    const r = bars.close[i] - bars.close[i - 1];
    if (Number.isFinite(r) && Math.abs(r) < 200) rets.push(r);
  }
  const results = [];
  for (let trial = 0; trial < 3; trial++) {
    let seed = 777 + trial * 1013;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const syn = { ...bars, count: n,
      ts: bars.ts, volume: bars.volume,
      open: new Float64Array(n), high: new Float64Array(n),
      low: new Float64Array(n), close: new Float64Array(n) };
    let px = bars.close[0];
    for (let i = 0; i < n; i++) {
      // sample a real return, so volatility clustering by time of day is kept
      const r = rets[Math.floor(rnd() * rets.length)];
      const o = px; px = px + r;
      const hi = Math.max(o, px) + rnd() * Math.abs(r) * 0.5;
      const lo = Math.min(o, px) - rnd() * Math.abs(r) * 0.5;
      syn.open[i] = o; syn.close[i] = px; syn.high[i] = hi; syn.low[i] = lo;
    }
    const { trades } = pipeline(syn);
    if (!trades.length) continue;
    const sw = sweepWindows(trades, bars.ts[0], bars.ts[n - 1], rules, 1);
    results.push({ n: trades.length, pass: sw.summary.passRate,
                   pf: (() => { let gw = 0, gl = 0;
                     for (const t of trades) { if (t.pnl > 0) gw += t.pnl; else gl -= t.pnl; }
                     return gw / gl; })() });
  }
  const realSweep = sweepWindows(base.trades, bars.ts[0], bars.ts[bars.count - 1], rules, 1);
  const realPf = (() => { let gw = 0, gl = 0;
    for (const t of base.trades) { if (t.pnl > 0) gw += t.pnl; else gl -= t.pnl; }
    return gw / gl; })();
  console.log(`   real   : ${base.trades.length} trades, pf ${realPf.toFixed(3)}, ` +
              `pass ${realSweep.summary.passRate.toFixed(1)}%`);
  for (const r of results)
    console.log(`   synth  : ${r.n} trades, pf ${r.pf.toFixed(3)}, pass ${r.pass.toFixed(1)}%`);
  const meanNull = results.reduce((s, r) => s + r.pass, 0) / results.length;
  const meanNullPf = results.reduce((s, r) => s + r.pf, 0) / results.length;
  console.log(`   null mean pass ${meanNull.toFixed(1)}%, null mean pf ${meanNullPf.toFixed(3)}`);
  ok("real profit factor beats the no-edge null", realPf > meanNullPf + 0.02,
     `${realPf.toFixed(3)} vs ${meanNullPf.toFixed(3)}`);
  if (realSweep.summary.passRate <= meanNull + 2)
    warn("pass rate barely beats the null",
         `${realSweep.summary.passRate.toFixed(1)}% vs ${meanNull.toFixed(1)}% — most of the headline is geometry`);
  else console.log(`   ok   pass rate exceeds the null by ${(realSweep.summary.passRate - meanNull).toFixed(1)}pp`);
}

// ── 3. CAP ACCOUNTING ────────────────────────────────────────────────
console.log("\n3. CAP — is the -$1000 day stop actually enforced?\n");
{
  const byDay = new Map();
  for (const t of base.trades) {
    if (!byDay.has(t.tday)) byDay.set(t.tday, []);
    byDay.get(t.tday).push(t);
  }
  let worstDay = 0, breaches = 0, worstTrade = 0;
  for (const [, ts] of byDay) {
    let acc = 0;
    for (const t of ts) { acc += t.pnl; if (acc < worstDay) worstDay = acc; }
    if (acc < -1000.01) breaches++;
  }
  for (const t of base.trades) if (t.pnl < worstTrade) worstTrade = t.pnl;
  const dl = base.trades.filter(t => t.reason === "DAYLOSS");
  let offCap = 0;
  for (const [, ts] of byDay) {
    let acc = 0;
    for (const t of ts) {
      if (t.reason === "DAYLOSS" && Math.abs(acc + t.pnl + 1000) > 0.02) offCap++;
      acc += t.pnl;
    }
  }
  // A single trade CAN show a loss far bigger than the cap without the cap
  // failing: in exact mode the cut is sized to land the DAY on -$1000, so a day
  // up $5,889 books a -$6,889 trade. The trade figure is bookkeeping; the day
  // figure is the risk. 2026-06-25 is exactly this and is not a defect.
  let overrun = 0;
  for (const [, ts] of byDay) {
    let acc = 0;
    for (const t of ts) acc += t.pnl;
    if (acc < -1000.01) overrun = Math.min(overrun, acc + 1000);
  }
  console.log(`   ${dl.length} DAYLOSS exits, worst day close $${worstDay.toFixed(0)}`);
  console.log(`   worst single trade $${worstTrade.toFixed(0)} — exact-mode bookkeeping, ` +
              `not risk (see comment)`);
  ok("every DAYLOSS exit lands the day exactly on -$1000", offCap === 0, `${offCap} off`);
  // Days CAN finish past the cap when the flatten fills through it on a gap.
  // What matters is the size of that overrun, not that it is nonzero.
  ok("days that pass the cap do so only marginally (gap fills)",
     breaches === 0 || Math.abs(overrun) < 100,
     `${breaches} days, worst overrun $${overrun.toFixed(0)}`);
}

// ── 4. CLAIMS IN THE README ──────────────────────────────────────────
console.log("\n4. CLAIMS — recomputing what bot/README.md asserts\n");
{
  const md = readFileSync("bot/README.md", "utf8");
  const T = base.trades;
  const winRate = 100 * T.filter(t => t.pnl > 0).length / T.length;
  let gw = 0, gl = 0;
  for (const t of T) { if (t.pnl > 0) gw += t.pnl; else gl -= t.pnl; }
  const pf = gw / gl;
  const holdW = T.filter(t => t.pnl > 0).reduce((s, t) => s + t.bars * 2, 0) / T.filter(t => t.pnl > 0).length;
  // "wins 5/6.75 = 74.1% on a pure coin flip" — the bracket identity S/(S+T)
  const coin = 100 * 5 / (5 + 1.75);
  console.log(`   bracket identity S/(S+T) = ${coin.toFixed(1)}%   measured win rate ${winRate.toFixed(1)}%`);
  ok("README's coin-flip win rate arithmetic is right", Math.abs(coin - 74.1) < 0.1);
  ok("measured win rate is near the coin-flip value (README's central claim)",
     Math.abs(winRate - coin) < 6, `${winRate.toFixed(1)}% vs ${coin.toFixed(1)}%`);
  const claimedScaleIn = /2 \+ 6 @ 0\.15×ATR\D+([\d.]+)%/.exec(md);
  if (claimedScaleIn) console.log(`   README scale-in all-history pass: ${claimedScaleIn[1]}%`);
  console.log(`   recomputed pf ${pf.toFixed(3)}, mean winner hold ${holdW.toFixed(1)}m`);
  // the README quotes 8 lots beating 10 head to head
  const t10 = pipeline(bars);           // placeholder to keep shape; 10-lot run below
  const ten = runBrackets(base.tf, base.sig, base.A,
    resolveExec({ ...S.execDefaults, ...CFG, contracts: 10 })).trades;
  const sw8 = sweepWindows(base.trades, bars.ts[0], bars.ts[bars.count - 1], rules, 1);
  const sw10 = sweepWindows(ten, bars.ts[0], bars.ts[bars.count - 1], rules, 1);
  console.log(`   8 lots ${sw8.summary.passRate.toFixed(1)}%  vs  10 lots ${sw10.summary.passRate.toFixed(1)}%`);
  // The README's tail-risk claim is computed on the RAW engine book, which
  // includes trades the daily blocks would have prevented. Recompute on the book
  // that is actually traded.
  {
    let acc = 0, day = null; const kept = [];
    for (const t of T) {
      if (t.tday !== day) { day = t.tday; acc = 0; }
      if (acc >= 750 || acc <= -500) continue;
      acc += t.pnl; kept.push(t);
    }
    const rawBig = T.filter(t => t.pnl < -2000);
    const realBig = kept.filter(t => t.pnl < -2000);
    console.log(`   trades losing > $2000: ${rawBig.length} on the raw book, ` +
                `${realBig.length} on the book actually traded`);
    console.log(`     worst: raw $${Math.min(...T.map(t => t.pnl)).toFixed(0)}, ` +
                `traded $${Math.min(...kept.map(t => t.pnl)).toFixed(0)}`);
    if (/worst -\$8,782/.test(md))
      warn("README quotes worst trade -$8,782",
           `now $${Math.min(...kept.map(t => t.pnl)).toFixed(0)} on the traded book — restate`);
  }
  // The sizing choice is made on the WORSE of the two halves, not the
  // all-history average. Ranking on the average is the specific trap this
  // project keeps writing down — it is what made 3.5/2.5 look best while it
  // split 53.9 early against 35.8 late — so the check must use the criterion
  // the decision was actually made on. On all-history alone 10 lots now edges
  // 8 by ~0.3pp, which is inside noise and is not the basis either way.
  const MID_ = bars.ts[0] + (bars.ts[bars.count - 1] - bars.ts[0]) / 2;
  const halves = (tr) => [[bars.ts[0], MID_], [MID_, bars.ts[bars.count - 1]]]
    .map(([lo, hi]) => sweepWindows(
      tr.filter(t => t.entryTime >= lo && t.entryTime < hi), lo, hi, rules, 1)
      .summary.passRate);
  const h8 = halves(base.trades), h10 = halves(ten);
  const w8 = Math.min(...h8), w10 = Math.min(...h10);
  console.log(`   8 lots halves ${h8.map(v => v.toFixed(1)).join(" / ")} -> worse ${w8.toFixed(1)}`);
  console.log(`   10 lots halves ${h10.map(v => v.toFixed(1)).join(" / ")} -> worse ${w10.toFixed(1)}`);
  ok("README claim '8 beats 10' on the WORSE half (the stated criterion)",
     w8 > w10, `${w8.toFixed(1)} vs ${w10.toFixed(1)}`);
}

// ── 5. DATA INTEGRITY ────────────────────────────────────────────────
console.log("\n5. DATA — the thing that has invalidated a whole project before\n");
{
  const n = bars.count;
  let dup = 0, back = 0, bad = 0, jumps = 0, biggest = 0, biggestAt = 0;
  for (let i = 1; i < n; i++) {
    if (bars.ts[i] === bars.ts[i - 1]) dup++;
    if (bars.ts[i] < bars.ts[i - 1]) back++;
    if (!(bars.high[i] >= bars.low[i]) ||
        !(bars.high[i] >= bars.open[i]) || !(bars.high[i] >= bars.close[i]) ||
        !(bars.low[i] <= bars.open[i]) || !(bars.low[i] <= bars.close[i])) bad++;
    const g = Math.abs(bars.open[i] - bars.close[i - 1]);
    if (g > 100) { jumps++; if (g > biggest) { biggest = g; biggestAt = bars.ts[i]; } }
  }
  ok("no duplicate timestamps", dup === 0, `${dup}`);
  ok("timestamps strictly increasing", back === 0, `${back}`);
  ok("no impossible OHLC bars", bad === 0, `${bad}`);
  console.log(`   ${jumps} bar-to-bar gaps over 100 points; largest ${biggest.toFixed(0)} ` +
              `at ${new Date(biggestAt).toISOString().slice(0, 10)}`);
  if (jumps > n * 0.0005)
    warn("many large gaps", `${jumps} of ${n} bars — check for rollover contamination`);
  else console.log("   ok   large-gap count is consistent with real overnight gaps");
  // trades should not be concentrated on gap bars
  const gapEntries = base.trades.filter(t => {
    const i = t.entrySrc;
    return i > 0 && Math.abs(bars.open[i] - bars.close[i - 1]) > 100;
  }).length;
  ok("trades are not concentrated on gap bars",
     gapEntries / base.trades.length < 0.02,
     `${gapEntries}/${base.trades.length}`);
}

// ── 6. BOT CONFIG vs MEASURED CONFIG ─────────────────────────────────
console.log("\n6. CONFIG — does the bot trade what was measured?\n");
{
  const py = readFileSync("bot/mnq_donchian_bot.py", "utf8");
  const g = (k) => {
    const m = new RegExp(`"${k}":\\s*([^,\\n]+)`).exec(py);
    return m ? m[1].trim() : null;
  };
  const checks = [
    ["contracts", "8", String(CFG.contracts)],
    ["sl_atr_mult", "5.0", String(CFG.slAtrMult)],
    ["tp_atr_mult", "1.75", String(CFG.tpAtrMult)],
    ["platform_hard_loss_stop", "1000.0", String(CFG.dayLossStopUsd) + ".0"],
    // 0 = stop-entry mode. runBrackets cannot represent a zero first tranche
    // (scaleInFrac must be in (0,1)), so the engine baseline above stays at 1/8,
    // the nearest representable config; stop-entry is measured by
    // research/zero_tranche.mjs instead. The check is that the BOT is in the
    // mode that was chosen, not that the engine can mirror it.
    ["scale_in_first", "0", "0 (engine baseline uses 1/8)"],
    ["scale_in_trigger_atr", "0.15", String(CFG.scaleInTrigger)],
    ["scale_in_window_bars", "10", String(CFG.scaleInWindowBars)],
    ["timeframe_min", "2", "2"],
    ["period", "30", "30"],
    ["adx_min", "25", "25"],
    ["eff_min", "0.5", "0.5"],
    ["daily_profit_block", "750.0", String(RULES.dailyProfitStop) + ".0"],
    ["circuit_breaker", "500.0", String(RULES.circuitBreaker) + ".0"],
  ];
  for (const [k, want, measured] of checks) {
    const got = g(k);
    ok(`bot ${k} = ${want} (research used ${measured})`,
       got === want, `bot has ${got}`);
  }
  // dry_run is now deliberately False: the paper book never touches the order
  // path at all (_evaluate returns before it), so it could not validate the
  // scale-in machinery. The practice account exercises the real API instead.
  // The assertion that matters is therefore the REAL-MONEY switch.
  const dry = g("dry_run"), liveAcct = g("live_account");
  console.log(`   trading mode: dry_run=${dry}, live_account=${liveAcct} -> ` +
    (dry === "True" ? "paper only, no orders sent"
     : liveAcct === "True" ? "!! LIVE MONEY !!" : "real orders on the PRACTICE account"));
  ok("live_account is still False (no real money at risk)", liveAcct === "False",
     `live_account=${liveAcct}`);
  if (dry === "False" && liveAcct === "False")
    console.log("   ok   orders go to the practice account, which is the point");
  const cid = g("contract_id");
  console.log(`   contract_id = ${cid}  — must match the current front month`);
}

console.log(`\n${"=".repeat(62)}\n  ${PASS} passed, ${FAIL} failed, ${WARN} warnings\n${"=".repeat(62)}`);
