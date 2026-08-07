// Why does banning overnight holds destroy these books, and what survives it?
//
// The session runs 5:00 PM CT to 3:05 PM CT next day — 22 hours — so this is not
// a short window. The damage must therefore come from HOW LONG the winners need,
// not from the window being small. Part 1 measures that directly. Part 2 searches
// for a configuration that can actually finish inside the time available.

import { loadBars } from "../src/data.mjs";
import neutev from "../strategies/trend_neutev.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { resolveExec, EXIT } from "../src/engine.mjs";
import { replayWindow, resolveRules, OUTCOME } from "../src/challenge.mjs";

const { bars } = loadBars();
const DAY = 86400000;
const starts = [];
for (let s = bars.ts[0]; s <= bars.ts[bars.count - 1] - 30 * DAY; s += DAY) starts.push(s);
const rules = resolveRules({});

function rateFor(trades) {
  let p = 0, f = 0;
  for (const s of starts) {
    const o = replayWindow(trades, s, rules).outcome;
    if (o === OUTCOME.PASS) p++; else if (o === OUTCOME.FAIL) f++;
  }
  return { pass: (p / starts.length) * 100, fail: (f / starts.length) * 100 };
}

// ─────────── Part 1: how long do winners actually need? ───────────
const base = runStrategy(bars, neutev, resolveParams(neutev, {}),
  resolveExec({ intradayOnly: false, contracts: 8, slAtrMult: 2, tpAtrMult: 12 }));

const hrs = (t) => (t.exitTime - t.entryTime) / 3600000;
const wins = base.trades.filter((t) => t.pnl > 0);
const losses = base.trades.filter((t) => t.pnl <= 0);
const pct = (a, q) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length * q)]; };

console.log("HOLDING TIME with overnight holds allowed (incumbent, 6:1 target)\n");
console.log(`  winners : n=${wins.length}   median ${pct(wins.map(hrs), 0.5).toFixed(1)}h   75th ${pct(wins.map(hrs), 0.75).toFixed(1)}h   90th ${pct(wins.map(hrs), 0.9).toFixed(1)}h`);
console.log(`  losers  : n=${losses.length}   median ${pct(losses.map(hrs), 0.5).toFixed(1)}h   75th ${pct(losses.map(hrs), 0.75).toFixed(1)}h   90th ${pct(losses.map(hrs), 0.9).toFixed(1)}h`);

// Available time is whatever remains until the next 3:05 PM CT deadline.
const untilFlat = (t) => {
  const ct = t.entryCt;
  const dl = 15 * 60 + 5;
  return ((ct < dl ? dl - ct : 1440 - ct + dl) / 60);
};
for (const t of base.trades) {
  // Recover entry CT from the bar the trade opened on.
  t.entryCt = 0;
}
// Cheaper: recompute from the 1-min series via the stored entrySrc is not valid
// across resample, so approximate using the trade's own timestamp in CT terms.
const CT_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour12: false, hour: "2-digit", minute: "2-digit" });
const ctOf = (ms) => { const p = CT_FMT.formatToParts(ms); const h = Number(p.find(x => x.type === "hour").value.replace("24", "0")); return h * 60 + Number(p.find(x => x.type === "minute").value); };
for (const t of base.trades) t.entryCt = ctOf(t.entryTime);

let winTrunc = 0, lossTrunc = 0;
for (const t of wins) if (hrs(t) > untilFlat(t)) winTrunc++;
for (const t of losses) if (hrs(t) > untilFlat(t)) lossTrunc++;
console.log(`\n  winners that would be CUT SHORT by the deadline : ${winTrunc}/${wins.length} (${((winTrunc / wins.length) * 100).toFixed(1)}%)`);
console.log(`  losers  that would be cut short                  : ${lossTrunc}/${losses.length} (${((lossTrunc / losses.length) * 100).toFixed(1)}%)`);
console.log(`\n  Gross profit sitting in the truncated winners: $${wins.filter((t) => hrs(t) > untilFlat(t)).reduce((a, t) => a + t.pnl, 0).toFixed(0)}`);
console.log(`  Total gross profit from all winners          : $${wins.reduce((a, t) => a + t.pnl, 0).toFixed(0)}`);

// ─────────── Part 2: what reward:risk can finish in time? ───────────
console.log("\n\nSEARCH — configurations that respect the 3:05 PM CT deadline\n");

const SIGNALS = [];
for (const timeframeMin of [1, 3, 5, 15])
  for (const donchian of [20, 30, 50])
    for (const adxMin of [20, 25, 32])
      SIGNALS.push({ timeframeMin, donchian, adxMin, adxPeriod: 14, cooldownBars: 1, atrPeriod: 14 });

const EXECS = [];
for (const slAtrMult of [1, 1.5, 2, 3])
  for (const tpAtrMult of [1, 1.5, 2, 3, 4, 6])          // deliberately TIGHT
    for (const sz of [{ sizingMode: "fixed", contracts: 8 }, { sizingMode: "fixed", contracts: 10 },
                      { sizingMode: "risk", riskDollars: 250, maxContracts: 10 },
                      { sizingMode: "risk", riskDollars: 400, maxContracts: 10 }])
      EXECS.push({ ...sz, slAtrMult, tpAtrMult });

console.log(`  ${SIGNALS.length} signals x ${EXECS.length} execs = ${(SIGNALS.length * EXECS.length).toLocaleString()} configs`);

const out = [];
let done = 0;
const t0 = Date.now();
for (const sig of SIGNALS) {
  const params = resolveParams(neutev, sig);
  for (const ex of EXECS) {
    const exec = resolveExec({ ...ex, intradayOnly: true, noEntryMinsBeforeFlat: 30 });
    const run = runStrategy(bars, neutev, params, exec);
    done++;
    if (run.trades.length < 300) continue;
    const r = rateFor(run.trades);
    out.push({ sig, ex, ...r, pf: run.stats.profitFactor, exp: run.stats.expectancy, n: run.trades.length });
  }
  process.stdout.write(`\r  ${done}/${SIGNALS.length * EXECS.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
console.log(`\n  done in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

out.sort((a, b) => b.pass - a.pass);
console.log("  pass%  fail%     PF   exp$/tr   trades   config");
for (const r of out.slice(0, 20)) {
  const sz = r.ex.sizingMode === "risk" ? `risk$${r.ex.riskDollars}` : `${r.ex.contracts}lot`;
  console.log(
    `  ${r.pass.toFixed(1).padStart(5)}  ${r.fail.toFixed(1).padStart(5)}  ${r.pf.toFixed(3).padStart(5)}  ` +
    `${r.exp.toFixed(2).padStart(8)}  ${String(r.n).padStart(7)}   tf${r.sig.timeframeMin} don${r.sig.donchian} adx${r.sig.adxMin} ${sz} sl${r.ex.slAtrMult} tp${r.ex.tpAtrMult}`
  );
}

if (out.length) {
  const best = out[0];
  const rr = (best.ex.tpAtrMult / best.ex.slAtrMult).toFixed(2);
  console.log(`\n  best reward:risk found = ${rr}:1  (the overnight books used 6:1 and 18:1)`);
}
