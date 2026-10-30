// What is the Supertrend line's edge? It cleared every test in the level study, which
// is reason to look harder. This takes it apart on 2026, and on the forward bars.
//
//   node --max-old-space-size=8192 research/levels_supertrend.mjs
//
// RESULT: there is none. It read +19.6 (45 of 45 definitions, forward +22.9) because a
// flip moves the line across price in one bar, and the engine scored that as its shifted
// twins being touched and instantly broken: real 44.2%, twins 28.1%, where an arbitrary
// price gives 47%. The same +18.6 showed on placebo markets, which is what caught it. With
// a touch required to be price reaching the level, it is 44.2% against 46.1% in 2026, and
// 51.0% against 51.7% forward.
//
//   SETTINGS  the same line at other ATR lengths, multiples and timeframes. A real
//             effect of "a line this far from price" changes smoothly. One setting
//             alone standing out is selection.
//   LAG       the line as it stood some bars earlier. Delay kills something tied to the
//             exact price of the line, and leaves something tied to the extension.
//   TOUCHES   the bounce rate itself, by side, hour, speed, and with the trend or not.

import { fileURLToPath } from "node:url";
import * as Lab from "./lib_levels.mjs";

const NBOOT = 1000;
const real = Lab.loadSample({ to: Date.UTC(2026, 6, 15) }), D = real.days.length, boot = Lab.bootDays(D, NBOOT);
const fwd = Lab.loadSample({ file: fileURLToPath(new URL("../data/topstepx_1m.bin", import.meta.url)), from: Date.UTC(2026, 8, 11), warmDays: 20 });
const FD = fwd.days.length, fboot = Lab.bootDays(FD, NBOOT);
const f = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`, fe = (e) => (e ? `${f(e.edge)} [${f(e.lo)}, ${f(e.hi)}] n${e.n}` : "-");

function line(sample, tf, period, mult) {
  const r = Lab.studyLines(sample, "supertrend", tf, { period, mult }), n = r.up.length, a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = Number.isFinite(r.up[i]) ? r.up[i] : r.down[i];
  return a;
}
function test(sample, days, bt, series, rFrac = 0.05, keep = null, extra = {}) {
  const ev = Lab.runLevels(sample, [{ tag: "x", series: [series] }], { rFrac, thru: 1, twins: 8, ...extra }), ids = Lab.byTag(ev, 1)[0];
  return { m: Lab.matchedEdgeOf(ev, ids, days, bt, NBOOT, keep && ((i) => keep(ev, i))), p: Lab.edgeOf(ev, ids, days, bt, NBOOT, keep && ((i) => keep(ev, i))) };
}

console.log(`Bounce rates, R 5%: 2026 ${D} sessions, forward ${FD} sessions.`);
const a0 = test(real, D, boot, line(real, 5, 10, 3)), b0 = test(fwd, FD, fboot, line(fwd, 5, 10, 3));
console.log(`  2026     real ${a0.p.real.toFixed(1)}%  twins ${a0.p.twin.toFixed(1)}%   net per touch ${a0.p.evReal.toFixed(2)} pts, twins ${a0.p.evTwin.toFixed(2)}`);
console.log(`  forward  real ${b0.p.real.toFixed(1)}%  twins ${b0.p.twin.toFixed(1)}%   net per touch ${b0.p.evReal.toFixed(2)} pts, twins ${b0.p.evTwin.toFixed(2)}`);

console.log(`\nSETTINGS on 5-minute bars, period 10:`);
for (const mult of [1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6]) console.log(`  mult ${String(mult).padEnd(4)} 2026 ${fe(test(real, D, boot, line(real, 5, 10, mult)).m).padEnd(30)} forward ${fe(test(fwd, FD, fboot, line(fwd, 5, 10, mult)).m)}`);
console.log(`\nOther ATR periods, mult 3:`);
for (const period of [5, 7, 10, 14, 20, 30]) console.log(`  period ${String(period).padEnd(3)} 2026 ${fe(test(real, D, boot, line(real, 5, period, 3)).m).padEnd(30)} forward ${fe(test(fwd, FD, fboot, line(fwd, 5, period, 3)).m)}`);
console.log(`\nOther timeframes, 10 / 3:`);
for (const tf of [1, 2, 3, 5, 10, 15, 30]) console.log(`  ${String(tf).padEnd(3)} min  2026 ${fe(test(real, D, boot, line(real, tf, 10, 3)).m).padEnd(30)} forward ${fe(test(fwd, FD, fboot, line(fwd, tf, 10, 3)).m)}`);

console.log(`\nLAG, the 5-minute line delayed:`);
for (const lag of [0, 1, 2, 3, 5, 10, 20, 40]) {
  const s = line(real, 5, 10, 3), n = s.length, a = new Float64Array(n).fill(NaN);
  for (let i = lag; i < n; i++) a[i] = s[i - lag];
  console.log(`  ${String(lag).padEnd(3)} bars  ${fe(test(real, D, boot, a).m)}`);
}

console.log(`\nTOUCHES, 2026 then forward:`);
const cuts = {
  support: (e, i) => e.side[i] === 1, resistance: (e, i) => e.side[i] === -1, "08:30-09:30": (e, i) => e.ct[i] < 570, "09:30-11:00": (e, i) => e.ct[i] >= 570 && e.ct[i] < 660,
  "11:00-13:00": (e, i) => e.ct[i] >= 660 && e.ct[i] < 780, "13:00-15:00": (e, i) => e.ct[i] >= 780, "fast approach": (e, i) => e.speed[i] >= 1, "slow approach": (e, i) => e.speed[i] < 1,
  "first touch": (e, i) => e.no[i] === 0, "later touch": (e, i) => e.no[i] > 0, "bounce with the 10m trend": (e, i) => e.withTrend[i] === 1, "bounce against it": (e, i) => e.withTrend[i] === -1,
};
for (const [name, keep] of Object.entries(cuts)) console.log(`  ${name.padEnd(28)} ${fe(test(real, D, boot, line(real, 5, 10, 3), 0.05, keep).m).padEnd(30)} ${fe(test(fwd, FD, fboot, line(fwd, 5, 10, 3), 0.05, keep).m)}`);

console.log(`\nThe first ten touches of 2026, to read by eye:`);
{
  const s = line(real, 5, 10, 3), { high: H, low: L, close: C, ts, ctMin } = real.b;
  let shown = 0;
  for (const d of real.days) {
    const R = Math.max(1, Lab.TICK * Math.round((0.05 * d.U) / Lab.TICK));
    Lab.scanLevel(real, s, 0, 0, d.a, d.z, R, { chain: true }, (side, oc, pnl, ct, no, prev, speed, wt, bo, k) => {
      if (shown++ >= 10) return;
      const before = [k - 3, k - 2, k - 1, k, k + 1, k + 2].map((j) => s[j].toFixed(2)).join(" ");
      console.log(`  ${new Date(ts[k]).toISOString().slice(0, 16)} ${side === 1 ? "support" : "resist "} R ${R} line ${before}  bar ${L[k]}-${H[k]} close ${C[k]} -> ${oc === 1 ? "bounce" : oc === -1 ? "break" : "open"}`);
    });
    if (shown >= 10) break;
  }
}
