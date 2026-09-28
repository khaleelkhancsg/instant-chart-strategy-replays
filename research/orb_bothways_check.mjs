// An independent check of the finding in orb_improve.mjs, written from scratch
// so it shares nothing with lib_orb's hunt or joint_account's resolver except
// the level itself (touchLevels, which the bot's own parity tests pin down).
//
// It trades the ORB the way the live bot does: both stops placed at the bell
// at the bot's own tick-rounded prices (level +/- 1 tick), a bracket on each,
// the first fill cancels the other side, a five-minute time stop. A minute
// that trades through BOTH triggers fills the side crossed first and hits that
// position's stop -- the other level -- inside the same minute.
//
// Also: a STRICT reading, in which a both-levels minute only counts as a stop
// when price went at least 2 ticks through the stop, so marginal touches are
// not charged as losses; and the size of the overshoot, to show whether these
// minutes are hairline crossings or genuinely violent bars.
//
// RESULT: 265 of 749 trades start on a both-levels minute and all 265 lose
// (-$532 each); the book nets -$18,584 against the backtest's +$165,151, and
// passes 10.9% alone against 34.8%. Not a rounding artefact: median overshoot
// past the stop is 26 ticks, 8 of 265 are within 2 ticks, and the STRICT
// reading still nets -$839. Even the best ordering 1-minute bars allow (3R
// target first whenever it is inside the minute) only reaches +$29/trade and
// 14.7%.
//
//   node --max-old-space-size=6144 research/orb_bothways_check.mjs

import * as B from "./lib_orb.mjs";
import * as J from "./joint_account.mjs";

const PV = 2, TICK = 0.25, SLIP = 0.25, FEE = 0.75;
const rt = (px) => Math.floor(px / TICK + 0.5) * TICK;              // half up, as the bot
const [WA, WB] = B.refBounds("PRE120");
const LEVEL = { pivotK: 3, tolFrac: 0.08, minTouch: 3 };

// best = the most favourable ordering 1-minute bars allow: on a both-levels
// minute, if either side's 3R target lies inside the minute's range, assume
// that side filled first and reached it before price turned. An upper bound.
function trade(strict, best = false) {
  const rows = [];
  for (const d of B.dayKeys) {
    const s0 = B.daySess.get(d), e0 = B.dayEnd.get(d);
    const t = B.touchLevels(s0, e0, WA, WB, LEVEL);
    if (!t || t.hi - t.lo > 31) continue;
    const L = { dir: 1, trig: rt(t.hi + TICK) }, S = { dir: -1, trig: rt(t.lo - TICK) };
    L.risk = L.trig - t.lo; S.risk = t.hi - S.trig;
    for (const x of [L, S]) {
      x.stop = rt(x.trig - x.dir * x.risk); x.tp = rt(x.trig + x.dir * 3 * x.risk);
      x.lots = Math.max(1, Math.min(50, Math.floor(500 / (x.risk * PV))));
    }
    let i = s0; while (i < e0 && B.CT[i] < 510) i++;
    for (; i < e0 && B.CT[i] < 570; i++) {
      const up = B.H[i] >= L.trig, dn = B.L[i] <= S.trig;
      if (!up && !dn) continue;
      const both = up && dn;
      let x;
      if (both) x = B.O[i] >= L.trig ? L : B.O[i] <= S.trig ? S
                  : (L.trig - B.O[i] <= B.O[i] - S.trig ? L : S);
      else x = up ? L : S;
      if (both && best) {
        const lt = B.H[i] >= L.tp, stt = B.L[i] <= S.tp;
        if (lt || stt) {
          x = lt ? L : S;
          const fill = x.dir === 1 ? Math.max(x.trig, B.O[i]) : Math.min(x.trig, B.O[i]);
          const net = ((x.tp - x.dir * SLIP) - (fill + x.dir * SLIP)) * x.dir * PV * x.lots - 2 * FEE * x.lots;
          rows.push({ tday: d, pnl: net, both, why: "TP", over: 0, lots: x.lots, width: t.hi - t.lo });
          break;
        }
      }
      const fill = x.dir === 1 ? Math.max(x.trig, B.O[i]) : Math.min(x.trig, B.O[i]);
      const book = (px, why, over) => {
        const net = ((px - x.dir * SLIP) - (fill + x.dir * SLIP)) * x.dir * PV * x.lots - 2 * FEE * x.lots;
        rows.push({ tday: d, pnl: Math.max(-1000, net), both, why, over, lots: x.lots, width: t.hi - t.lo });
      };
      // how far past the OTHER level this minute went, in ticks
      const over = both ? (x.dir === 1 ? (x.stop - B.L[i]) : (B.H[i] - x.stop)) / TICK : 0;
      const need = strict ? 2 * TICK : 0;
      // the entry minute: stop first (it is the level crossed second on a
      // both-levels minute), then the target
      if (x.dir === 1 ? B.L[i] <= x.stop - need : B.H[i] >= x.stop + need) { book(x.stop, "SL", over); break; }
      if (!both && (x.dir === 1 ? B.H[i] >= x.tp : B.L[i] <= x.tp)) { book(x.tp, "TP", over); break; }
      let done = false;
      for (let j = i + 1; j < e0 && !done; j++) {
        if (B.CT[j] >= 900 || j - i >= 5) { book(B.O[j], "TIME", over); done = true; break; }
        if (x.dir === 1 ? B.O[j] <= x.stop : B.O[j] >= x.stop) { book(B.O[j], "SL", over); done = true; break; }
        if (x.dir === 1 ? B.O[j] >= x.tp : B.O[j] <= x.tp) { book(B.O[j], "TP", over); done = true; break; }
        if (x.dir === 1 ? B.L[j] <= x.stop : B.H[j] >= x.stop) { book(x.stop, "SL", over); done = true; break; }
        if (x.dir === 1 ? B.H[j] >= x.tp : B.L[j] <= x.tp) { book(x.tp, "TP", over); done = true; break; }
      }
      break;                                        // one shot a day
    }
  }
  return rows;
}

const sum = (a) => a.reduce((s, x) => s + x.pnl, 0);
const dayArr = (rows) => { const m = new Map(J.days.map((d) => [d, 0])); for (const r of rows) m.set(r.tday, m.get(r.tday) + r.pnl); return J.days.map((d) => m.get(d)); };
console.log("\n  independent re-implementation of the live ORB (levels <= 31 pts, $500 risk, 3R, 5-min hold)\n");
console.log("  " + "".padEnd(44) + "trades".padStart(7) + "   win%" + "     $/tr" + "        net" + "   ORB-alone 21-day pass");
for (const [strict, best] of [[false, false], [true, false], [false, true]]) {
  const rows = trade(strict, best);
  const cl = rows.filter((r) => !r.both), bw = rows.filter((r) => r.both);
  const tag = best ? "BEST CASE (3R target first if in range)" : strict ? "STRICT (stop needs 2 ticks through)" : "as the bot trades it";
  for (const [lbl, set] of [[tag + ", all", rows], ["   clean first break", cl], ["   first minute crossed both levels", bw]]) {
    console.log("  " + lbl.padEnd(44) + String(set.length).padStart(7) +
      (100 * set.filter((r) => r.pnl > 0).length / set.length).toFixed(1).padStart(7) +
      ("$" + (sum(set) / set.length).toFixed(0)).padStart(9) + ("$" + Math.round(sum(set)).toLocaleString()).padStart(11) +
      (set === rows ? J.pass21(dayArr(rows)).toFixed(1).padStart(12) + "%" : ""));
  }
  if (!strict && !best) {
    const ov = bw.map((r) => r.over).sort((a, b) => a - b);
    const pc = (p) => ov[Math.min(ov.length - 1, Math.floor(p * ov.length))];
    console.log("\n  how far past the stop the both-levels minutes went, in ticks: 10th pct " + pc(0.1) +
      ", median " + pc(0.5) + ", 90th " + pc(0.9) + "; within 2 ticks: " +
      ov.filter((x) => x < 2).length + " of " + ov.length);
    const w = bw.map((r) => r.width).sort((a, b) => a - b), wc = cl.map((r) => r.width).sort((a, b) => a - b);
    console.log("  level spread on those days: median " + w[w.length >> 1].toFixed(1) + " pts (clean days " +
      wc[wc.length >> 1].toFixed(1) + " pts)\n");
  }
}
// And what the backtest has been booking on the same schedule, for scale.
const bt = J.simulate("orb", { orbCfg: { ...J.ORB_CFG, maxWidthPts: 31 } });
console.log("\n  lib_orb backtest (skips the both-levels minute): " + bt.oTr.length + " trades, $" +
  (bt.oTr.reduce((a, b) => a + b, 0) / bt.oTr.length).toFixed(0) + "/tr, net $" +
  Math.round(bt.oTr.reduce((a, b) => a + b, 0)).toLocaleString() + ", ORB-alone pass " + J.pass21(bt.arr).toFixed(1) + "%");
