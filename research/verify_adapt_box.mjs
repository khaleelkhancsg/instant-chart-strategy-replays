// The Tradovate box's "adaptive" VWAP-slope setting against the research rule it carries (light_check.mjs ADAPT, confirmed #4).
//
//   node --max-old-space-size=16384 research/light_check.mjs --file data/mnq_1m_beta.bin --from 2019-05-06 --to 2026-10-31 \
//        --ideas ADAPT --placebos 0 --r-adjusted --dump-modes <modes.json>
//   node --max-old-space-size=16384 research/verify_adapt_box.mjs <modes.json>
//
// Runs emaMacdDatabox.js with vwapSlope "adaptive" (its 1m rows and the 5m rows it forms) over every 1-minute MNQ bar and reads each session's weak side (its
// mode, set at the session's first warning) against the research's for the same session. The race is sized from the
// chart's price in both (--r-adjusted), since the lab's bars are back-adjusted and a live chart's are not.
// 2026-11-25: 1,871 of 1,874 sessions the same; the 3 others were ties of 0.014 points or less over 60 sessions.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

const ref = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const { bars: T } = loadBars("data/mnq_1m_beta.bin");
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const run = new Run(BOX, { minutes: 1, props: { vwapSlope: "adaptive" }, check: false }), map = run.calc.map.bind(run.calc);
const mine = {};
run.calc.map = (d, i) => {
  const out = map(d, i), S = run.calc.st[i];
  if (S && S.ad && S.ad.curDay >= 0 && !(S.ad.curDay in mine)) mine[S.ad.curDay] = S.ad.mode;
  return out;
};
const n = T.close.length;
run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
let both = 0, same = 0, onlyRef = 0, onlyMine = 0;
const diffs = [];
for (const k of new Set([...Object.keys(ref), ...Object.keys(mine)])) {
  if (!(k in mine)) { onlyRef++; continue; }
  if (!(k in ref)) { onlyMine++; continue; }
  both++;
  if (mine[k] === ref[k]) same++; else if (diffs.length < 10) diffs.push(`${new Date(Number(k) * 86400000).toISOString().slice(0, 10)}: box ${mine[k]}, research ${ref[k]}`);
}
console.log(`sessions in both ${both}; same weak side ${same} (${((100 * same) / both).toFixed(2)}%); only the research ${onlyRef}; only the box ${onlyMine}`);
for (const d of diffs) console.log("  " + d);
const modes = Object.values(mine), c = (m) => modes.filter((z) => z === m).length;
console.log(`box modes: against-slope side weak ${c(1)}, with-slope side weak ${c(-1)}, none yet ${c(0)}`);
