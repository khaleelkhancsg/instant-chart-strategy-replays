// The scalp's slow signals on 5 years of 1-minute bars: EMA 9/21, EMA 20/50 and MACD(12,26,9)
// crosses on 2- and 5-minute bars -- the only places bot/scalp_check_seconds.py found cells above
// break-even, on 10 sessions with 10-90 crosses each. Entered at market at the next minute's open
// + 1 tick, with the cross (momentum) or against it (fade); +t points at a limit, filled only if
// price trades through it by a tick; stop where the $600 limit sits for the size (74 points at 4
// lots, 29 at 10, 14 at 20); $0.75 a side. Each cross on its own, as in the 1-second check. A
// 1-minute bar that reaches both the stop and the target cannot be ordered: a TIE, counted as a
// loss (worst) and as a win (best). At 4 and 10 lots ties are rare, so those cells are nearly exact.
//
// RESULT: every slow signal loses, with the cross and against it. Counting every cross (a trade
// still open at 15:05 closed there at market), 190 of 192 cells (3 signals x 2 bar sizes x 2
// periods x momentum / fade x 8 size-target cells) lose money even with every tie given to the
// target. The two exceptions are EMA momentum on 5-minute bars at 20 lots +8 in 2026 (+$7 and
// +$21 a trade at best, -$94 and -$122 at worst), cells where 11-16% of trades are ties: the
// assumption, not an edge. At 4 lots, where ties are almost nil, every cell loses $8-$40 a
// trade, and momentum and fade differ by a few dollars. (Counting only the crosses that reached
// stop or target, a first version showed 4-lot +8 cells slightly above break-even before 2026,
// for momentum AND the fade: ~8% of those trades were still open at the close, and dropping
// them dropped mostly losers.)
//
//   node --max-old-space-size=8192 research/scalp_slow_signals.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { ema, macd } from "../src/indicators.mjs";

const { bars } = loadBars();
const { open: O, high: H, low: L, ctMin: CT, tday: TD } = bars;
const n = bars.close.length;
const TICK = 0.25, FEE = 0.75;
const CELLS = [[4, 2], [4, 4], [4, 8], [10, 2], [10, 4], [10, 8], [20, 4], [20, 8]];
const stopOf = (lots) => (600 - 2 * FEE * lots) / (2 * lots) - TICK;
const winOf = (lots, t) => lots * (2 * t - 2 * FEE) - 2 * TICK * lots;
const needOf = (lots, t) => (100 * 600) / (600 + winOf(lots, t));
const yearOf = (td) => new Date(td * 86400000).getUTCFullYear();

function signalsFor(tfMin, kind) {
  const t = resample(bars, tfMin);
  let h;
  if (kind === "macd") h = macd(t.close, 12, 26, 9).hist;
  else {
    const [f, s] = kind.slice(3).split("/").map(Number), ef = ema(t.close, f), es = ema(t.close, s);
    h = Float64Array.from(ef, (x, i) => x - es[i]);
  }
  const out = [];
  for (let j = 1; j < t.close.length; j++) {
    if (!(t.ctMin[j] >= 510 && t.ctMin[j] < 900)) continue;
    const up = h[j] > 0 && h[j - 1] <= 0, dn = h[j] < 0 && h[j - 1] >= 0;
    if (!up && !dn) continue;
    const e = t.srcLast[j] + 1;                       // the first 1-minute bar after the signal bar
    if (e >= n || TD[e] !== t.tday[j] || CT[e] >= 905) continue;
    out.push([e, up ? 1 : -1]);
  }
  return out;
}
// per cell, every cross counted: wins counting ties as losses (w) and as wins (wb); $ per trade
// the same two ways (a target is +win, a stop -$600, a trade still open at 15:05 is closed there
// at market); ties; crosses still open at the close
function walk(sigs, sign, keep) {
  const res = CELLS.map(() => ({ w: 0, wb: 0, n: 0, ties: 0, open: 0, pnl: 0, pnlb: 0 }));
  for (const [e, dr] of sigs) {
    if (!keep(TD[e])) continue;
    const s = sign * dr, fill = O[e] + s * TICK;
    let open = CELLS.map((_, k) => k), i = e;
    for (; i < n && TD[i] === TD[e] && CT[i] < 905 && open.length; i++) {
      const adverse = s === 1 ? fill - L[i] : H[i] - fill, favour = s === 1 ? H[i] - fill : fill - L[i];
      const still = [];
      for (const k of open) {
        const [lots, t] = CELLS[k], r = res[k], win = winOf(lots, t);
        const hs = adverse >= stopOf(lots), ht = favour >= t + TICK;
        if (hs && ht) { r.n++; r.ties++; r.wb++; r.pnl -= 600; r.pnlb += win; }
        else if (hs) { r.n++; r.pnl -= 600; r.pnlb -= 600; }
        else if (ht) { r.n++; r.w++; r.wb++; r.pnl += win; r.pnlb += win; }
        else still.push(k);
      }
      open = still;
    }
    const xp = i < n && TD[i] === TD[e] ? O[i] : bars.close[i - 1];      // the 15:05 open, or the day's last close
    for (const k of open) {
      const [lots] = CELLS[k], r = res[k];
      const p = (xp - s * TICK - fill) * s * 2 * lots - 2 * FEE * lots;
      r.n++; r.open++; r.pnl += p; r.pnlb += p;
      if (p > 0) { r.w++; r.wb++; }
    }
  }
  return res;
}

console.log("=".repeat(150));
console.log("THE SCALP'S SLOW SIGNALS ON 5 YEARS OF 1-MINUTE BARS -- $ per trade after costs, worst / best (a stop-and-target tie as a loss / a win)");
console.log("=".repeat(150));
console.log("   lots (stop pts) +target:      " + CELLS.map(([l, t]) => `${l} (${stopOf(l).toFixed(0)}) +${t}`.padStart(14)).join(""));
console.log("   a win pays:                   " + CELLS.map(([l, t]) => `+$${winOf(l, t).toFixed(0)}`.padStart(14)).join(""));
let pos = 0, cells = 0;
for (const kind of ["ema9/21", "ema20/50", "macd"]) {
  for (const tf of [2, 5]) {
    const sigs = signalsFor(tf, kind);
    for (const [label, keep] of [["2026", (d) => yearOf(d) === 2026], ["2019-2025", (d) => yearOf(d) < 2026]]) {
      const m = walk(sigs, 1, keep), f = walk(sigs, -1, keep), cnt = sigs.filter(([e]) => keep(TD[e])).length;
      const fmt = (r) => { cells++; if (r.pnlb / r.n > 0) pos++; return `${(r.pnl / r.n).toFixed(0)}/${(r.pnlb / r.n).toFixed(0)}`.padStart(14); };
      const k8 = (l) => CELLS.findIndex(([a, b]) => a === l && b === 8);
      console.log(`\n   ${kind.toUpperCase()} on ${tf}-minute bars, ${label}: ${cnt.toLocaleString()} crosses` +
                  `   (at +8 with 4 / 10 / 20 lots: ties ${[4, 10, 20].map((l) => ((100 * m[k8(l)].ties) / m[k8(l)].n).toFixed(1) + "%").join(" / ")},` +
                  ` still open at 15:05 ${[4, 10, 20].map((l) => ((100 * m[k8(l)].open) / m[k8(l)].n).toFixed(1) + "%").join(" / ")})`);
      console.log("     momentum                    " + m.map(fmt).join(""));
      console.log("     fade                        " + f.map(fmt).join(""));
    }
  }
}
console.log(`\n   cells above zero even in the best case: ${pos} of ${cells}`);
