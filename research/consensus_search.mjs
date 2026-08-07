// Search the multi-speed consensus template under the real account rules.
//
// The design is inherited from MACD-Angle v4, whose published edge was an
// execution artefact — so the question is whether the SIGNAL IDEA (several
// speeds agreeing, abstaining on conflict) carries anything once trades are
// filled causally. Everything here runs with same-bar re-entry OFF.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import tpl from "../strategies/tpl_consensus.mjs";
import { resolveParams } from "../src/run.mjs";
import { resolveRules } from "../src/challenge.mjs";
import { bracketGrid, flatten, fastSweep, assertParity, windowStarts } from "./lib_search.mjs";

const { bars } = loadBars();
const RULES = resolveRules({});
const SPLIT = Date.UTC(2023, 5, 1);
const all = windowStarts(bars, RULES.windowDays, 1);
const IS = all.filter((t) => t < SPLIT);
const OOS = all.filter((t) => t >= SPLIT);
const worst = (r) => Math.min(r.is, r.oos);

const EXEC_BASE = { intradayOnly: true, flipOnOpposite: false, sameBarReentry: false, noEntryMinsBeforeFlat: 10 };
const SLS = [0.75, 1, 1.5, 2, 3];
const TPS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6];
const CONTRACTS = [2, 4, 6, 8, 10];

const FAMILIES = ["macd", "zscore", "roc", "emaslope", "rsi"];
const NSPEEDS = [1, 2, 4, 6];
const BASES = [3, 4, 6, 10];
const GROWTH = [1.3, 1.5, 2];
const MINAGREE = [1, 2, 3];
const ANGLES = [0, 0.01];
const DIRS = ["follow", "fade"];
const TFS = [2, 5];

let configs = 0, sims = 0, parity = 0;
const out = [];
const t0 = Date.now();

for (const tf of TFS) {
  for (const family of FAMILIES) {
    for (const nSpeeds of NSPEEDS) {
      for (const basePeriod of BASES) {
        for (const growth of (nSpeeds === 1 ? [1.5] : GROWTH)) {
          for (const minAgree of MINAGREE.filter((m) => m <= nSpeeds)) {
            for (const angleThr of ANGLES) {
              for (const direction of DIRS) {
                const params = resolveParams(tpl, {
                  timeframeMin: tf, family, nSpeeds, basePeriod, growth, minAgree, angleThr, direction,
                });
                let grid;
                try { grid = bracketGrid(bars, tpl, params, SLS, TPS, EXEC_BASE); }
                catch { continue; }

                for (const g of grid) {
                  if (g.trades.length < 200) continue;
                  const T = flatten(g.trades);
                  if (parity < 3) { assertParity(g.trades, IS.slice(0, 300), RULES, 4); parity++; }
                  for (const c of CONTRACTS) {
                    const is = fastSweep(T, IS, RULES, c);
                    configs++; sims += IS.length;
                    if (is.pass < 28) continue;
                    const oos = fastSweep(T, OOS, RULES, c);
                    sims += OOS.length;
                    out.push({ tf, family, nSpeeds, basePeriod, growth, minAgree, angleThr, direction,
                               sl: g.sl, tp: g.tp, c, is: is.pass, oos: oos.pass, trades: g.trades.length });
                  }
                }
              }
            }
          }
        }
      }
      process.stdout.write(`\r  tf${tf} ${family} n${nSpeeds} — ${configs.toLocaleString()} configs, ${(sims / 1e6).toFixed(1)}M sims, ${((Date.now() - t0) / 1000).toFixed(0)}s     `);
    }
  }
}

console.log(`\n\n  ${configs.toLocaleString()} configs, ${(sims / 1e6).toFixed(1)}M window sims in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`  parity verified on ${parity} sample configs\n`);

out.sort((a, b) => worst(b) - worst(a));
console.log("TOP 25 BY WORST HALF (causal fills throughout)\n");
console.log("  tf fam       spd base  gro agr ang dir      sl    tp lot     IS%    OOS%  worst   trades");
for (const r of out.slice(0, 25)) {
  console.log(
    `  ${String(r.tf).padStart(2)} ${r.family.padEnd(9)} ${String(r.nSpeeds).padStart(3)} ${String(r.basePeriod).padStart(4)} ` +
    `${String(r.growth).padStart(4)} ${String(r.minAgree).padStart(3)} ${String(r.angleThr).padStart(3)} ${r.direction.padEnd(7)} ` +
    `${String(r.sl).padStart(4)} ${String(r.tp).padStart(5)} ${String(r.c).padStart(3)} ${r.is.toFixed(1).padStart(6)} ${r.oos.toFixed(1).padStart(7)} ` +
    `${worst(r).toFixed(1).padStart(6)} ${String(r.trades).padStart(8)}`
  );
}

// Does adding speeds actually help, or is one speed just as good?
console.log("\n\nDOES MULTI-SPEED CONSENSUS EARN ITS KEEP?\n");
console.log("  speeds   best worst-half   configs qualifying");
for (const nS of NSPEEDS) {
  const sub = out.filter((r) => r.nSpeeds === nS);
  const best = sub.length ? Math.max(...sub.map(worst)) : 0;
  console.log(`  ${String(nS).padStart(6)}   ${best.toFixed(1).padStart(13)}%   ${String(sub.length).padStart(18)}`);
}
console.log("\n  minAgree   best worst-half");
for (const m of MINAGREE) {
  const sub = out.filter((r) => r.minAgree === m);
  const best = sub.length ? Math.max(...sub.map(worst)) : 0;
  console.log(`  ${String(m).padStart(8)}   ${best.toFixed(1).padStart(13)}%`);
}
console.log("\n  family     best worst-half");
for (const f of FAMILIES) {
  const sub = out.filter((r) => r.family === f);
  const best = sub.length ? Math.max(...sub.map(worst)) : 0;
  console.log(`  ${f.padEnd(10)} ${best.toFixed(1).padStart(13)}%`);
}

fs.writeFileSync("research/consensus_results.json", JSON.stringify({ meta: { configs, sims }, top: out.slice(0, 300) }, null, 1));
console.log(`\n  TOTAL: ${sims.toLocaleString()} window simulations`);
