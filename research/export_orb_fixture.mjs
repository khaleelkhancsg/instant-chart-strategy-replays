// Golden fixture for bot/orb_strategy.py.
//
// The Python ORB module reimplements level detection and entry selection that
// were measured in JavaScript. "It looks the same" is not evidence, so this
// exports the JS answers for a slice of real days and the Python side asserts
// against them stage by stage -- levels first, then entries -- so a mismatch
// names the stage rather than just moving a trade count.
//
// Usage:  node research/export_orb_fixture.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBars } from "../src/data.mjs";
import { touchLevels, setups, dayStart, dayEnd, daySess, CT, OPEN_CT,
         dayKeys } from "./lib_orb.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "bot", "fixture_orb.json");

const CFG = {
  levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
  mode: "plain", stopAt: "opposite", rMult: 3.0, maxHoldMin: 5,
  retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500, maxLots: 50, maxPerDay: 1,
};

const { bars } = loadBars();
// A recent slice, long enough to contain days with a level, days without, and
// days where one bar breaks both sides.
const DAYS = dayKeys.slice(-260);
const out = { generated: new Date().toISOString(), cfg: CFG, days: [] };

// entries keyed by 1-minute bar index, so a day can be matched to its entry
const entryAt = new Map();
for (const s of setups(CFG).out) entryAt.set(s.bar, s);

for (const day of DAYS) {
  const s0 = daySess.get(day), e0 = dayEnd.get(day), dS = dayStart.get(day);
  const t = touchLevels(s0, e0, OPEN_CT - 120, OPEN_CT, CFG);

  // every 1-minute bar of the day from the pre-open window to the give-up time
  const rows = [];
  for (let i = dS; i < e0; i++) {
    if (CT[i] < OPEN_CT - 130 || CT[i] > 600) continue;
    rows.push([bars.ts[i], +bars.open[i].toFixed(4), +bars.high[i].toFixed(4),
               +bars.low[i].toFixed(4), +bars.close[i].toFixed(4), CT[i]]);
  }
  let entry = null;
  for (let i = dS; i < e0; i++) {
    if (entryAt.has(i)) {
      const s = entryAt.get(i);
      entry = { bar_ct: CT[i], dir: s.dir, entryPx: +s.entryPx.toFixed(4),
                risk: +s.risk.toFixed(6), trig: +(s.trig ?? s.entryPx).toFixed(4),
                gapped: !!s.gapped };
      break;
    }
  }
  out.days.push({
    tday: day,
    bars: rows,
    levels: t ? { hi: +t.hi.toFixed(6), lo: +t.lo.toFixed(6), tHi: t.tHi, tLo: t.tLo,
                  whi: +t.whi.toFixed(4), wlo: +t.wlo.toFixed(4), ref: +t.ref.toFixed(4) }
              : null,
    entry,
  });
}

fs.writeFileSync(OUT, JSON.stringify(out));
const withLv = out.days.filter(d => d.levels).length;
const withEn = out.days.filter(d => d.entry).length;
console.log("wrote " + OUT);
console.log("  days " + out.days.length + ", with a level " + withLv + ", with an entry " + withEn);
