// Trades percentage levels, so any of them can be tried on the chart with sliders.
//
// Levels: a ladder of rungs in percent or ADRs from an anchor, the recent reach from
// settlement, the self-correcting band, the noise area, or the fan of the normal move.
// A level arms once a close is at least R from it, R being a share of the recent daily
// range, as in the level study (research/lib_levels.mjs). Then one of four rules:
//   fade     a bar trades through it and closes back on the side it came from. Go that way.
//   break    a bar closes more than R/4 beyond it. Go the way it broke.
//   retest   after a break, price comes back and closes away on the broken side. Go that way.
//   return   a fade of a rung, heading back to the anchor, with the anchor as the target
// Stop and target are multiples of R from the fill, or in `return` of the distance back.
//
// Research: no percentage level behaved differently from a price picked at random in 2026
// (research/pct_study.mjs), and research/pct_books.mjs measures these rules. This is here to
// look at, not because it is expected to win.

import { adrOf, sessionsOf, anchorOf, percentLadder, adrLadder, reachLevels, conformalLevels, noiseArea, moveFan, PCT_ANCHORS } from "../src/levels.mjs";
import { trig, verdict, inWindow, mark, px, num, COLOR } from "../src/explain.mjs";

export function linesOf(b, p) {
  const every = (r) => ({ lines: [...r.up.map((d) => [d, 1]), ...r.dn.map((d) => [d, -1])], anchor: r.anchor });
  const band = (r) => ({ lines: [[r.up, 1], [r.dn, -1]], anchor: anchorOf(b, "settle") });
  const rungs = Math.max(1, Math.trunc(p.rungs));
  let res;
  if (p.level === "reach") res = band(reachLevels(b, { sessions: 60, q: p.band }));
  else if (p.level === "conformal") res = band(conformalLevels(b, { miss: p.band }));
  else if (p.level === "noise") res = band(noiseArea(b, { mult: p.band }));
  else if (p.level === "fan") res = band(moveFan(b, { q: p.band }));
  else if (p.unit === "adr") res = every(adrLadder(b, { anchor: p.anchor, days: 10, mults: Array.from({ length: rungs }, (_, k) => p.step * (k + 1)) }));
  else res = every(percentLadder(b, { anchor: p.anchor, step: p.step, rungs }));
  let { lines } = res;
  if (p.level === "ladder" && Math.trunc(p.only) > 0) lines = lines.filter((_, q) => q % rungs === Math.trunc(p.only) - 1);
  if (p.side === "above") lines = lines.filter((x) => x[1] === 1);
  if (p.side === "below") lines = lines.filter((x) => x[1] === -1);
  return { lines, anchor: res.anchor };
}

export default {
  id: "pct_levels",
  name: "Percent levels (fade, break, retest, return)",
  description: "Any percentage level as a trade: rungs from settlement, the open, the week or month, in percent or ADRs, or the reach, self-correcting and noise bands. For trying ideas on the chart.",

  timeframeMin: 1,
  warmupBars: 300,
  warmupSessions: (p) => ({ ladder: { week: 9, pweek: 10, month: 27, pmonth: 28 }[p.anchor] || 14, reach: 66, conformal: 74, noise: 18, fan: 64 }[p.level] ?? 14),
  execDefaults: { slAtrMult: 1, tpAtrMult: 1.5, contracts: 2, sizingMode: "fixed", entryType: "market", tpFromFill: true, flipOnOpposite: false },

  params: [
    { key: "level", label: "Levels", type: "select", default: "ladder", group: "Level",
      options: [["ladder", "Ladder from an anchor"], ["reach", "Recent reach from settlement"], ["conformal", "Self-correcting band"], ["noise", "Noise area"], ["fan", "Fan of the normal move"]] },
    { key: "anchor", label: "Ladder from", type: "select", default: "settle", options: Object.entries(PCT_ANCHORS), group: "Level" },
    { key: "unit", label: "Rungs in", type: "select", default: "pct", options: [["pct", "Percent of price"], ["adr", "ADRs"]], group: "Level" },
    { key: "step", label: "Step", type: "float", min: 0.05, max: 5, step: 0.05, default: 0.5, group: "Level" },
    { key: "rungs", label: "Rungs each way", type: "int", min: 1, max: 12, step: 1, default: 4, group: "Level" },
    { key: "only", label: "Only rung (0 = all)", type: "int", min: 0, max: 12, step: 1, default: 0, group: "Level" },
    { key: "band", label: "Band setting", type: "float", min: 0.05, max: 4, step: 0.05, default: 0.75, group: "Level",
      hint: "Quantile for the reach and the fan, share of days to break it for the self-correcting band, multiple for the noise area." },
    { key: "side", label: "Sides", type: "select", default: "both", options: [["both", "Both"], ["above", "Above only"], ["below", "Below only"]], group: "Level" },
    { key: "mode", label: "Rule", type: "select", default: "fade", options: [["fade", "Fade it"], ["break", "Follow the break"], ["retest", "Retest after a break"], ["return", "Fade a rung back to the anchor"]], group: "Rule" },
    { key: "rFrac", label: "R (share of the ADR)", type: "float", min: 0.02, max: 0.3, step: 0.01, default: 0.08, group: "Rule" },
    { key: "startCt", label: "No entries before (CT)", type: "time", min: 0, max: 1439, step: 5, default: 8 * 60 + 35, group: "Rule" },
    { key: "endCt", label: "No entries after (CT)", type: "time", min: 0, max: 1439, step: 5, default: 14 * 60 + 40, group: "Rule" },
  ],

  compute(bars, p) {
    const { high: H, low: Lo, close: C, tday: TD, ctMin: CT } = bars, n = C.length;
    const { lines, anchor } = linesOf(bars, p), U = new Float64Array(n).fill(NaN), S = sessionsOf(bars), adr = adrOf(S);
    S.forEach((s, k) => { if (s.rthA >= 0 && Number.isFinite(adr[k])) U.fill(adr[k], s.rthA, s.rthZ); });
    const m = lines.length, sig = new Int8Array(n), atrArr = new Float64Array(n).fill(NaN), side = new Int8Array(m), broke = new Int8Array(m), firedAt = new Int16Array(n).fill(-1);
    const fades = p.mode === "fade" || p.mode === "return", back = p.mode === "return";
    let day = null;
    for (let i = 1; i < n; i++) {
      const R = p.rFrac * U[i];
      if (R > 0) atrArr[i] = R;
      if (TD[i] !== day) { day = TD[i]; side.fill(0); broke.fill(0); }
      if (!(R > 0) || CT[i] < p.startCt || CT[i] >= p.endCt) continue;
      for (let q = 0; q < m; q++) {
        const v = lines[q][0][i - 1];
        if (!(v === v)) continue;
        if (!side[q] && !broke[q]) { if (C[i] - v >= R) side[q] = 1; else if (v - C[i] >= R) side[q] = -1; continue; }
        let d = 0;
        if (fades) {
          if (side[q] === 1 ? Lo[i] <= v - 0.25 && C[i] > v : H[i] >= v + 0.25 && C[i] < v) {
            if (!back || side[q] === -lines[q][1]) d = side[q];
            side[q] = 0;
          } else if (side[q] === 1 ? C[i] < v : C[i] > v) side[q] = 0;
        } else if (p.mode === "break") {
          if (side[q] === 1 ? C[i] <= v - R / 4 : C[i] >= v + R / 4) { d = -side[q]; side[q] = 0; }
        } else if (broke[q]) {
          if (broke[q] === 1 ? Lo[i] <= v + 0.25 && C[i] > v : H[i] >= v - 0.25 && C[i] < v) { d = broke[q]; broke[q] = 0; }
          else if (broke[q] === 1 ? C[i] < v - R / 4 : C[i] > v + R / 4) broke[q] = 0;
        } else if (side[q] === 1 ? C[i] <= v - R / 4 : C[i] >= v + R / 4) { broke[q] = -side[q]; side[q] = 0; }
        if (d && !sig[i]) {
          sig[i] = d; firedAt[i] = q;
          if (back) atrArr[i] = Math.max(R, Math.abs(C[i] - anchor[i]));
        }
      }
    }
    const NAME = { fade: "Fade", break: "Break", retest: "Retest", return: "Back to the anchor" };
    const explain = (k) => {
      const q = firedAt[k], d = sig[k], v = q >= 0 ? lines[q][0][k - 1] : NaN;
      const checks = [inWindow(CT[k], p.startCt, p.endCt, "Entries"),
                      trig(d ? `${NAME[p.mode]} at ${px(v)}` : `A ${NAME[p.mode].toLowerCase()} at a level`, !!d, { text: d ? `close ${px(C[k])}, R ${num(p.rFrac * U[k])}` : "no level triggered on this bar" })];
      const marks = d ? [mark.level(v, Math.max(0, k - 30), k, `level ${px(v)}`, { color: d === 1 ? COLOR.up : COLOR.down }), mark.dot(k, C[k], `close ${px(C[k])}`, { color: COLOR.close })] : [];
      return { dir: verdict(d, checks), checks, marks, title: d ? `${NAME[p.mode]} → ${d === 1 ? "long" : "short"}` : "No level triggered" };
    };
    return {
      sig, atr: atrArr,
      overlays: [{ name: "anchor", pane: "price", color: "#8fa3b5", data: anchor }, ...lines.slice(0, 16).map(([data], q) => ({ name: `level ${q + 1}`, pane: "price", color: "#5a7a95", data, dash: [4, 3] }))],
      explain,
    };
  },
};
