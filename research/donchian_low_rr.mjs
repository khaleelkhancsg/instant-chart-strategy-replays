// Very low reward:risk on the Donchian book -- targets of 0.02x to 1x the stop.
//
// The idea being tested: a target far smaller than the stop wins most trades,
// and a sim evaluation might reward a high win rate. So the bracket is kept
// (5 x ATR stop, capped at the $1,000 day cap: 62.5 pts at 8 lots) and only
// the target moves, measured from the FILL as a multiple of that stop. Every
// row is run under three fill models:
//
//   realistic   1 tick of slippage on every entry and exit, $0.75/side commission
//   sim fills   no slippage at all, commission kept
//   no costs    no slippage, no commission -- an upper bound no account gives
//
// Plus the same brackets on RANDOM-direction entries at the same moments, which
// shows how much of the win rate is the bracket and how much is the signal.
// Weighted to 2026 as asked; 2025 and the full history for context.
//
// RESULT: low RR buys win rate, not passes. At RR 0.1 the book wins 92-93% of
// trades under every fill model, but a loss still costs ~$830 against a ~$70-90
// win, so the breakeven win rate is 90-92% and the trade nets $3 (realistic),
// $11 (sim fills) or $23 (no costs). 2026 pass rate at RR 0.1: 3.9% / 6.2% /
// 12.1%, against 34.5% / 36.9% / 38.0% for the live 1.75 ATR target under the
// same fills. Tick-sized targets (2-8 ticks) lose money even with sim fills:
// commission alone is $12 a round trip at 8 lots. Random-direction entries get
// 88-91% win rates at RR 0.1 too -- the win rate comes from the bracket, not the
// signal. Pass rate rises with RR across the whole grid; the live target is the
// best of it in 2026.
//
//   node --max-old-space-size=8192 research/donchian_low_rr.mjs

import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const days = S.days;
const yIx = (y) => days.map((d, k) => (S.yearOf.get(d) === y ? k : -1)).filter((k) => k >= 0);
const Y26 = yIx(2026), Y25 = yIx(2025);
const at = (arr, ix) => S.passArr(ix.map((k) => arr[k]));
const LOTS = 8, PV = 2, CAPPTS = 1000 / (PV * LOTS);
// the stop's distance from the fill on a flat day: 5 ATR from the signal
// reference plus the 0.15 ATR stop-entry offset, or the day cap if nearer
const stopDist = (a) => Math.min(5.15 * a, CAPPTS);

const MODELS = [["realistic", { slipMult: 1, feeMult: 1 }], ["sim fills", { slipMult: 0, feeMult: 1 }],
                ["no costs", { slipMult: 0, feeMult: 0 }]];
function score(opts, signals = M.RESC) {
  const tr = S.run(() => LOTS, { signals, ...opts });
  const arr = S.dayArr(tr, days);
  const w = tr.filter((t) => t.pnl > 0), l = tr.filter((t) => t.pnl <= 0);
  const aw = w.reduce((s, t) => s + t.pnl, 0) / Math.max(1, w.length), al = -l.reduce((s, t) => s + t.pnl, 0) / Math.max(1, l.length);
  const t26 = tr.filter((t) => S.yearOf.get(t.tday) === 2026);
  return { n: tr.length, win: (100 * w.length) / tr.length, aw, al, exp: tr.reduce((s, t) => s + t.pnl, 0) / tr.length,
           be: (100 * al) / (aw + al), win26: (100 * t26.filter((t) => t.pnl > 0).length) / t26.length,
           y26: at(arr, Y26), y25: at(arr, Y25), all: S.passArr(arr) };
}
const f1 = (x, w = 6) => x.toFixed(1).padStart(w);
const usd = (x, w = 7) => ((x < 0 ? "-$" : "$") + Math.abs(x).toFixed(0)).padStart(w);
const HDR = "  " + "target".padEnd(30) + "trades".padStart(7) + "win%".padStart(7) + "2026win%".padStart(9) +
  "avg win".padStart(8) + "avg loss".padStart(9) + "  b/e win%".padStart(10) + "$/trade".padStart(8) +
  "   pass 2026  2025   all";
const row = (label, r) => "  " + label.padEnd(30) + String(r.n).padStart(7) + f1(r.win, 7) + f1(r.win26, 9) +
  usd(r.aw, 8) + usd(-r.al, 9) + f1(r.be, 10) + usd(r.exp, 8) + "   " + f1(r.y26, 9) + f1(r.y25) + f1(r.all);

const RRS = [0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1.0];
const TICKS = [2, 4, 8, 16];
const live = (m) => score({ ...m });
for (const [mName, m] of MODELS) {
  console.log("\n" + "=".repeat(124) + "\n" + "FILL MODEL: " + mName.toUpperCase() + "\n" + "=".repeat(124) + "\n" + HDR);
  console.log(row("live target (1.75 ATR)", live(m)));
  for (const rr of RRS)
    console.log(row("RR " + rr + " (target " + rr + "x stop)", score({ ...m, tpFromFill: true, tpFn: (a) => rr * stopDist(a) })));
  for (const t of TICKS)
    console.log(row(t + " ticks (" + (t * 0.25) + " pts)", score({ ...m, tpFromFill: true, tpFn: () => t * 0.25 })));
}

// The same brackets on random-direction entries, at the live signals' moments.
console.log("\n" + "=".repeat(124) + "\nRANDOM DIRECTION at the same moments, sim fills (no slippage, commission kept), mean of 5 coin seeds\n" + "=".repeat(124) + "\n" + HDR);
const coin = (k, s) => { let x = (k * 2654435761 + s * 97531) >>> 0; x ^= x >>> 16; x = Math.imul(x, 2246822507) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };
for (const rr of [0.05, 0.1, 0.2, 0.5, 1.0]) {
  const rs = [];
  for (let s = 1; s <= 5; s++) {
    const R = Int8Array.from(M.RESC);
    for (let k = 0; k < R.length; k++) if (R[k]) R[k] = coin(k, s) < 0.5 ? 1 : -1;
    rs.push(score({ slipMult: 0, feeMult: 1, tpFromFill: true, tpFn: (a) => rr * stopDist(a) }, R));
  }
  const m = {}; for (const k of Object.keys(rs[0])) m[k] = rs.reduce((a, r) => a + r[k], 0) / rs.length;
  console.log(row("random dir, RR " + rr, m));
}
