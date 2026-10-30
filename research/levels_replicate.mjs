// Does the rebuilt engine (research/lib_levels.mjs) reproduce the original level study?
// The same levels, the same rule, on 2026, against the figures in
// ../tradovate_levels/research/s10_2026.txt. The data differs a little (these bars are
// back-adjusted, that study's were raw, and its twins were 4 per level with its own
// seed), so what has to agree is the counts, and the edges to within their noise.
//
//   node --max-old-space-size=8192 research/levels_replicate.mjs

import * as Lab from "./lib_levels.mjs";
import { compositeLevels, nakedPocs } from "../src/levels.mjs";

const sample = Lab.loadSample({ to: Date.UTC(2026, 6, 15) });
const { b, days, meta } = sample;
console.log(`${days.length} sessions, ${new Date(days[0].ms).toISOString().slice(0, 10)} to ${new Date(days[days.length - 1].ms).toISOString().slice(0, 10)}`);

const vp5 = compositeLevels(b, { sessions: 5, nodes: 6 }), vp20 = compositeLevels(b, { sessions: 20, nodes: 6 });
const dl = Lab.studyLines(sample, "daylevels", 1), pv = Lab.studyLines(sample, "vprofile", 1, { anchor: "rth", mode: "prior" });
const on = Lab.studyLines(sample, "clockrange", 1, { span: "overnight" });
const round = (step, skip) => (d) => {
  const off = Lab.rawOffset(meta, d.ms + 12 * 3600000), o = b.open[d.a] - off, out = [];
  for (let p = Math.floor((o - 1.5 * d.U) / step) * step; p < o + 1.5 * d.U; p += step) if (!(skip && p % skip === 0)) out.push(p + off);
  return out;
};
const levels = [
  { tag: "prior_day_high", series: [dl.PDH] }, { tag: "prior_day_low", series: [dl.PDL] }, { tag: "prior_day_close", series: [dl.PDC] },
  { tag: "pd_poc", series: [pv.POC] }, { tag: "pd_vah", series: [pv.VAH] }, { tag: "pd_val", series: [pv.VAL] },
  { tag: "overnight_high", series: [on.high] }, { tag: "overnight_low", series: [on.low] },
  { tag: "round_100", list: round(100), maxTouches: 1 }, { tag: "round_50_only", list: round(50, 100), maxTouches: 1 }, { tag: "round_25_only", list: round(25, 50), maxTouches: 1 },
  { tag: "vp5_poc", series: [vp5.poc] }, { tag: "vp5_vah", series: [vp5.vah] }, { tag: "vp5_val", series: [vp5.val] }, { tag: "vp5_hvn", series: vp5.hvn }, { tag: "vp5_lvn", series: vp5.lvn },
  { tag: "vp20_poc", series: [vp20.poc] }, { tag: "vp20_hvn", series: vp20.hvn }, { tag: "vp20_lvn", series: vp20.lvn },
];

// edge [lo, hi] n at R5 t1, first touch, from s10_2026.txt
const OLD = {
  prior_day_high: [-12.7, -24.4, 0.4, 62], prior_day_low: [-2.6, -19.4, 12.8, 46], prior_day_close: [4.3, -9.0, 17.9, 63], pd_poc: [-5.4, -17.8, 7.7, 62], pd_vah: [9.5, -3.6, 22.5, 60], pd_val: [5.3, -9.2, 20.2, 58],
  overnight_high: [-17.0, -29.7, -4.3, 70], overnight_low: [8.1, -5.5, 21.8, 68], round_100: [-6.1, -10.7, -1.7, 492], round_50_only: [0.4, -4.2, 5.2, 480], round_25_only: [0.4, -2.5, 3.3, 983],
  vp5_poc: [11.3, -8.0, 30.5, 38], vp5_vah: [-1.4, -20.2, 18.3, 37], vp5_val: [16.4, -3.3, 35.7, 26], vp5_hvn: [-3.0, -11.4, 5.2, 180], vp5_lvn: [5.0, -3.2, 13.2, 144],
  vp20_poc: [0.7, -21.5, 23.4, 26], vp20_hvn: [-2.7, -14.9, 9.2, 72], vp20_lvn: [-5.2, -20.9, 11.7, 52],
};

const t0 = Date.now();
const ev = Lab.runLevels(sample, levels, { rFrac: 0.05, thru: 1, twins: 8 });
const ids = Lab.byTag(ev, levels.length), boot = Lab.bootDays(days.length), D = days.length;
console.log(`${ev.n.toLocaleString()} touches in ${Date.now() - t0} ms\n`);
console.log("level".padEnd(18), "new: edge [95% CI] n".padEnd(32), "original: edge [95% CI] n".padEnd(34), "gap in its CI?");
levels.forEach((lv, t) => {
  // first touches, as the original's table counts them
  const e = Lab.edgeOf(ev, ids[t], D, boot, 2000, (i) => ev.no[i] === 0), o = OLD[lv.tag];
  const inside = o && e && o[0] >= e.lo && o[0] <= e.hi;
  console.log(lv.tag.padEnd(18), Lab.fmtEdge(e).padEnd(32), o ? `${o[0] >= 0 ? "+" : ""}${o[0]} [${o[1]}, ${o[2]}] n${o[3]}`.padEnd(34) : "", inside ? "yes" : "NO");
});
