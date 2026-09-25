// How many shrinking histogram bars should a fade exit wait for?
//
// The exit currently leaves on the FIRST bar that shrinks toward zero. One flat
// bar happens constantly inside a move that is still working, so the question
// is whether demanding a run of them keeps more of the winners.
//
// Win rate and pass rate are reported side by side because they routinely
// disagree: leaving later loses more of the losers' recoveries (win rate down)
// while keeping more of the winners (expectancy up), and this account is graded
// on pass rate, not on being right often.
//
// Picking the best N over the whole sample is exactly the overfit this project
// keeps catching itself in, so every row is also read on halves: chosen on the
// first, scored on the second.
//
//   node research/fade_bars_sweep.mjs

import { loadBars } from "../src/data.mjs";
import { runStrategy, resolveParams } from "../src/run.mjs";
import { resolveRules, sweepWindows } from "../src/challenge.mjs";
import fade1 from "../strategies/macd_1m_fade.mjs";
import fade5 from "../strategies/macd_5m_fade.mjs";
import flip1 from "../strategies/macd_1m_flip.mjs";
import flip5 from "../strategies/macd_5m_flip.mjs";

const { bars } = loadBars();
const MID = bars.ts[Math.floor(bars.count / 2)];

function score(s, over) {
  const p = { ...resolveParams(s), ...over };
  const r = runStrategy(bars, s, p, s.execDefaults, { filter: s.filterDefaults });
  const t = r.trades;
  if (!t.length) return null;
  const rules = resolveRules(s.rulesDefaults);
  const half = (first) => t.filter((x) => first ? x.entryTime < MID : x.entryTime >= MID);
  const pass = (arr, a, b) =>
    arr.length ? sweepWindows(arr, a, b, rules, 1).summary.passRate : 0;
  const win = (arr) => 100 * arr.filter((x) => x.pnl > 0).length / arr.length;
  const per = (arr) => arr.reduce((a, x) => a + x.pnl, 0) / arr.length;
  const h1 = half(true), h2 = half(false);
  return {
    n: t.length, win: win(t), per: per(t),
    gross: t.reduce((a, x) => a + x.gross, 0) / t.length,
    pass: pass(t, bars.ts[0], bars.ts[bars.count - 1]),
    win1: win(h1), win2: win(h2),
    pass1: pass(h1, bars.ts[0], MID), pass2: pass(h2, MID, bars.ts[bars.count - 1]),
    held: t.reduce((a, x) => a + x.bars, 0) / t.length,
  };
}

for (const [label, fade, flip] of [["1-MINUTE", fade1, flip1], ["5-MINUTE", fade5, flip5]]) {
  console.log("\n" + "=".repeat(98));
  console.log(label + " — shrinking bars required before the fade exit fires");
  console.log("=".repeat(98));
  console.log("\n  bars  trades   avg hold   win%   gross/tr   net/tr    pass    " +
              "win% 1st/2nd    pass 1st/2nd");
  const rows = [];
  for (const N of [1, 2, 3, 4, 5, 6, 8, 10]) {
    const r = score(fade, { fadeBars: N });
    if (!r) continue;
    rows.push({ N, ...r });
    console.log("  " + String(N).padStart(4) + r.n.toLocaleString().padStart(8) +
      r.held.toFixed(1).padStart(11) + r.win.toFixed(1).padStart(7) +
      ("$" + r.gross.toFixed(2)).padStart(11) + ("$" + r.per.toFixed(2)).padStart(9) +
      (r.pass.toFixed(1) + "%").padStart(8) +
      (r.win1.toFixed(1) + " / " + r.win2.toFixed(1)).padStart(15) +
      (r.pass1.toFixed(1) + " / " + r.pass2.toFixed(1)).padStart(16));
  }
  const f = score(flip, {});
  console.log("  " + "hold to cross".padEnd(4) + f.n.toLocaleString().padStart(8) +
    f.held.toFixed(1).padStart(11) + f.win.toFixed(1).padStart(7) +
    ("$" + f.gross.toFixed(2)).padStart(11) + ("$" + f.per.toFixed(2)).padStart(9) +
    (f.pass.toFixed(1) + "%").padStart(8) +
    (f.win1.toFixed(1) + " / " + f.win2.toFixed(1)).padStart(15) +
    (f.pass1.toFixed(1) + " / " + f.pass2.toFixed(1)).padStart(16));

  const bestWin = rows.slice().sort((a, b) => b.win - a.win)[0];
  const bestPass = rows.slice().sort((a, b) => b.pass - a.pass)[0];
  const pickedOn1 = rows.slice().sort((a, b) => b.pass1 - a.pass1)[0];
  console.log("\n  best WIN RATE   N=" + bestWin.N + "   " + bestWin.win.toFixed(1) +
              "%   (pass " + bestWin.pass.toFixed(1) + "%)");
  console.log("  best PASS RATE  N=" + bestPass.N + "   " + bestPass.pass.toFixed(1) +
              "%   (win " + bestPass.win.toFixed(1) + "%)");
  console.log("  chosen on the 1st half: N=" + pickedOn1.N +
              "  ->  2nd half pass " + pickedOn1.pass2.toFixed(1) +
              "%   vs hold-to-cross " + f.pass2.toFixed(1) + "%");
}
