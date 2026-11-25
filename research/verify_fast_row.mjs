// The Tradovate box's fast row (EMA 3/13, "momentum slowing") against the research reading it carries (confirmed #3):
// databox_lengths.mjs's "1m EMA 3/13 slowing", bar for bar on every 1-minute MNQ bar.
//
//   node --max-old-space-size=16384 research/verify_fast_row.mjs
//
// The research re-does the indicator's arithmetic (emaStep, rowStep); this runs the indicator itself and compares
// the warning state (+1 Potentially long, -1 Potentially short, 0 none) on every bar, the warm-up included.

import { loadBars } from "../src/data.mjs";
import { loadIndicator, Run } from "../tradovate/mock/runtime.mjs";
import { loadTools, readIndicator } from "../tradovate/mock/library.mjs";

// the research's arithmetic, exactly as databox_lengths.mjs / databox_eth.mjs
function emaSeries(x, n) {
  const N = x.length, v = new Float64Array(N);
  let count = 0, total = 0, prev = NaN;
  for (let i = 0; i < N; i++) { if (count < n) { count++; total += x[i]; prev = total / count; } else { count++; prev = prev + (2 / (n + 1)) * (x[i] - prev); } v[i] = prev; }
  return v;
}
function researchWarn(close, f, s) {
  const x = Float64Array.from(close), a = emaSeries(x, f), b = emaSeries(x, s), N = x.length, warn = new Int8Array(N);
  let ps = 0, pd = NaN, pm = NaN, has = false;
  for (let i = 0; i < N; i++) {
    const diff = a[i] - b[i], sd = diff > 0 ? 1 : diff < 0 ? -1 : has ? ps : 0, move = has ? diff - pd : NaN;
    let w = 0;
    if (has && sd !== 0 && Number.isFinite(pm)) w = sd === 1 ? (move < pm ? -1 : 0) : move > pm ? 1 : 0;
    if (i >= s) warn[i] = w;
    ps = sd; pd = diff; pm = move; has = true;
  }
  return warn;
}

const { bars: T } = loadBars("data/mnq_1m_beta.bin");
const n = T.close.length, ref = researchWarn(T.close, 3, 13), mine = new Int8Array(n);
const BOX = loadIndicator(readIndicator("emaMacdDatabox").source, loadTools());
const run = new Run(BOX, { minutes: 1, props: { vwapSlope: "off" }, check: false }), map = run.calc.map.bind(run.calc);
run.calc.map = (d, i) => { const out = map(d, i), S = run.calc.st[i]; mine[i] = S.fastReady ? S.fast.warn : 0; return out; };
run.compute(Array.from({ length: n }, (_, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i], v: T.volume[i], td: T.tday[i], ct: T.ctMin[i] })));
let same = 0, warned = 0, first = -1;
for (let i = 0; i < n; i++) { if (mine[i] === ref[i]) same++; else if (first < 0) first = i; if (ref[i]) warned++; }
console.log(`bars ${n.toLocaleString()}; the same warning state on ${same.toLocaleString()} (${((100 * same) / n).toFixed(4)}%); research warning bars ${warned.toLocaleString()}${first >= 0 ? `; first difference at bar ${first}` : ""}`);
if (same !== n) process.exit(1);
