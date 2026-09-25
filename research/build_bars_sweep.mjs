// The entry-side mirror of fade_bars_sweep: how many bars should the histogram
// GROW after a crossover before the trade is taken?
//
// A cross only says the two lines swapped. Waiting for the histogram to build
// first is the same evidence the fade exit waits for, read forwards — and
// unlike the exit count it changes the trade COUNT, because a cross that never
// develops is abandoned rather than traded. That makes it the first lever in
// this family that can touch throughput, which is what pass rate actually
// responds to in this project.
//
// Same discipline as the exit sweep: halves alongside every row, because
// picking the best N over the whole sample is the overfit this keeps finding.
//
//   node research/build_bars_sweep.mjs

import { loadBars } from "../src/data.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { resolveRules, sweepWindows } from "../src/challenge.mjs";
import fade1 from "../strategies/macd_1m_fade.mjs";
import fade5 from "../strategies/macd_5m_fade.mjs";

const { bars } = loadBars();
const MID = bars.ts[Math.floor(bars.count / 2)];
const LAST = bars.ts[bars.count - 1];

function score(s, over) {
  const p = { ...resolveParams(s), ...over };
  const r = runStrategy(bars, s, p, s.execDefaults, { filter: s.filterDefaults });
  const t = r.trades;
  if (!t.length) return null;
  const rules = resolveRules(s.rulesDefaults);
  const pass = (arr, a, b) => arr.length ? sweepWindows(arr, a, b, rules, 1).summary.passRate : 0;
  const win = (arr) => arr.length ? 100 * arr.filter((x) => x.pnl > 0).length / arr.length : 0;
  const h1 = t.filter((x) => x.entryTime < MID), h2 = t.filter((x) => x.entryTime >= MID);
  return {
    n: t.length, win: win(t),
    gross: t.reduce((a, x) => a + x.gross, 0) / t.length,
    per: t.reduce((a, x) => a + x.pnl, 0) / t.length,
    pass: pass(t, bars.ts[0], LAST),
    win1: win(h1), win2: win(h2),
    pass1: pass(h1, bars.ts[0], MID), pass2: pass(h2, MID, LAST),
  };
}

for (const [label, s] of [["1-MINUTE", fade1], ["5-MINUTE", fade5]]) {
  console.log("\n" + "=".repeat(100));
  console.log(label + " — growing bars required after the cross before entering");
  console.log("  (exit held at its default of 3 shrinking bars)");
  console.log("=".repeat(100));
  console.log("\n  bars   trades   win%   gross/tr   net/tr    pass   win 1st/2nd   pass 1st/2nd");
  const rows = [];
  for (const N of [0, 1, 2, 3, 4, 5, 6, 8]) {
    const r = score(s, { buildBars: N });
    if (!r) continue;
    rows.push({ N, ...r });
    console.log("  " + String(N).padStart(4) + r.n.toLocaleString().padStart(9) +
      r.win.toFixed(1).padStart(7) + ("$" + r.gross.toFixed(2)).padStart(11) +
      ("$" + r.per.toFixed(2)).padStart(9) + (r.pass.toFixed(1) + "%").padStart(8) +
      (r.win1.toFixed(1) + " / " + r.win2.toFixed(1)).padStart(14) +
      (r.pass1.toFixed(1) + " / " + r.pass2.toFixed(1)).padStart(15) +
      (N === 0 ? "   <- enter on the cross" : ""));
  }
  const base = rows.find((r) => r.N === 0);
  const bw = rows.slice().sort((a, b) => b.win - a.win)[0];
  const bp = rows.slice().sort((a, b) => b.pass - a.pass)[0];
  const bg = rows.slice().sort((a, b) => b.gross - a.gross)[0];
  const on1 = rows.slice().sort((a, b) => b.pass1 - a.pass1)[0];
  console.log("\n  best WIN RATE   N=" + bw.N + "  " + bw.win.toFixed(1) + "%   (pass " + bw.pass.toFixed(1) + "%)");
  console.log("  best GROSS      N=" + bg.N + "  $" + bg.gross.toFixed(2) + "/trade");
  console.log("  best PASS RATE  N=" + bp.N + "  " + bp.pass.toFixed(1) + "%   (win " + bp.win.toFixed(1) + "%)");
  console.log("  chosen on the 1st half: N=" + on1.N + "  ->  2nd half pass " +
              on1.pass2.toFixed(1) + "%   vs N=0 " + base.pass2.toFixed(1) + "%");
}

// Do the two settings interact, or are they independent?
console.log("\n" + "=".repeat(100));
console.log("5-MINUTE JOINT GRID — pass rate, entry delay against exit patience");
console.log("=".repeat(100));
console.log("\n  build \ fade" + [1, 2, 3, 4, 6, 10].map((f) => String(f).padStart(9)).join(""));
for (const b of [0, 1, 2, 3, 4]) {
  let line = "  " + String(b).padStart(11);
  for (const f of [1, 2, 3, 4, 6, 10]) {
    const r = score(fade5, { buildBars: b, fadeBars: f });
    line += (r ? r.pass.toFixed(1) + "%" : "-").padStart(9);
  }
  console.log(line);
}
