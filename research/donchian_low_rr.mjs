// Very low reward:risk on the Donchian book -- targets of 0.02x to 1x the stop.
// 2026 ONLY: every number below comes from 2026 trades and from 21-day windows
// drawn from 2026 days (2 Jan - 14 Jul, 139 sessions). Earlier history only
// warms the indicators up. Jan-Mar and Apr-Jul are shown as the check inside
// 2026.
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
//
// RESULT (2026 only, honest limit fills): low RR buys win rate, not passes. At
// RR 0.1 the book still wins 87% of trades but loses $65-70 a trade (sim fills /
// realistic) -- a loss costs ~$1,090 against a ~$80 win -- and passes under 1%
// of 2026 windows, against 34.5-36.9% for the live target. Tick-sized targets
// lose money even with no costs. Random direction does no better (RR 0.2: 22%).
// Fading the breakout peaks at RR 0.5 (+$30-36 a trade, 29.8-30.5%), below the
// live book. An earlier version of this file showed the fade at 31-38%: it
// booked targets on the bar a refused stop filled as a LIMIT using a high that
// may have printed before the fill (now limitFillTp "close").
//
//   node --max-old-space-size=8192 research/donchian_low_rr.mjs

import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const days = S.days;
const at = (arr, ix) => S.passArr(ix.map((k) => arr[k]));
const LOTS = 8, PV = 2, CAPPTS = 1000 / (PV * LOTS);
// the stop's distance from the fill on a flat day: 5 ATR from the signal
// reference plus the 0.15 ATR stop-entry offset, or the day cap if nearer
const stopDist = (a) => Math.min(5.15 * a, CAPPTS);
const in2026 = (t) => S.yearOf.get(t.tday) === 2026;

const MODELS = [["realistic", { slipMult: 1, feeMult: 1 }], ["sim fills", { slipMult: 0, feeMult: 1 }],
                ["no costs", { slipMult: 0, feeMult: 0 }]];
function score(opts, signals = M.RESC) {
  const tr = S.run(() => LOTS, { signals, limitFillTp: "close", ...opts }).filter(in2026);
  const arr = S.dayArr(tr, days);
  const w = tr.filter((t) => t.pnl > 0), l = tr.filter((t) => t.pnl <= 0);
  const aw = w.reduce((s, t) => s + t.pnl, 0) / Math.max(1, w.length), al = -l.reduce((s, t) => s + t.pnl, 0) / Math.max(1, l.length);
  return { n: tr.length, win: (100 * w.length) / tr.length, aw, al, exp: tr.reduce((s, t) => s + t.pnl, 0) / tr.length,
           be: (100 * al) / (aw + al), y26: at(arr, M.Y26), a26: at(arr, M.Y26a), b26: at(arr, M.Y26b) };
}
const f1 = (x, w = 6) => x.toFixed(1).padStart(w);
const usd = (x, w = 7) => ((x < 0 ? "-$" : "$") + Math.abs(x).toFixed(0)).padStart(w);
const HDR = "  " + "target".padEnd(30) + "trades".padStart(7) + "win%".padStart(7) + "avg win".padStart(9) +
  "avg loss".padStart(9) + "b/e win%".padStart(10) + "$/trade".padStart(9) + "   pass 2026  Jan-Mar  Apr-Jul";
const row = (label, r) => "  " + label.padEnd(30) + String(Math.round(r.n)).padStart(7) + f1(r.win, 7) +
  usd(r.aw, 9) + usd(-r.al, 9) + f1(r.be, 10) + usd(r.exp, 9) + "   " + f1(r.y26, 9) + f1(r.a26, 9) + f1(r.b26, 9);

const RRS = [0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1.0];
const TICKS = [2, 4, 8, 16];
console.log("\n  2026 ONLY -- trades, win rates, dollars and 21-day pass rates from 2 Jan - 14 Jul 2026 (139 sessions), 8 lots");
for (const [mName, m] of MODELS) {
  console.log("\n" + "=".repeat(124) + "\n" + "FILL MODEL: " + mName.toUpperCase() + "\n" + "=".repeat(124) + "\n" + HDR);
  console.log(row("live target (1.75 ATR)", score({ ...m })));
  for (const rr of RRS)
    console.log(row("RR " + rr + " (target " + rr + "x stop)", score({ ...m, tpFromFill: true, tpFn: (a) => rr * stopDist(a) })));
  for (const t of TICKS)
    console.log(row(t + " ticks (" + (t * 0.25) + " pts)", score({ ...m, tpFromFill: true, tpFn: () => t * 0.25 })));
}

// The same brackets on random-direction entries, at the live signals' moments.
console.log("\n" + "=".repeat(124) + "\nRANDOM DIRECTION at the same moments, sim fills (no slippage, commission kept), mean of 10 coin seeds\n" + "=".repeat(124) + "\n" + HDR);
const coin = (k, s) => { let x = (k * 2654435761 + s * 97531) >>> 0; x ^= x >>> 16; x = Math.imul(x, 2246822507) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };
for (const rr of [0.05, 0.1, 0.2, 0.5, 1.0, null]) {
  const rs = [];
  for (let s = 1; s <= 10; s++) {
    const R = Int8Array.from(M.RESC);
    for (let k = 0; k < R.length; k++) if (R[k]) R[k] = coin(k, s) < 0.5 ? 1 : -1;
    rs.push(score({ slipMult: 0, feeMult: 1, ...(rr === null ? {} : { tpFromFill: true, tpFn: (a) => rr * stopDist(a) }) }, R));
  }
  const m = {}; for (const k of Object.keys(rs[0])) m[k] = rs.reduce((a, r) => a + r[k], 0) / rs.length;
  console.log(row(rr === null ? "random dir, live target" : "random dir, RR " + rr, m));
}

// Prompted by the random-direction rows: if random direction at a small target
// does as well as the live book in 2026, does the OPPOSITE of the breakout do
// better still? Same moments, same bracket, direction reversed. Selected on 2026
// by construction, so read its two halves before anything else.
const FADE = Int8Array.from(M.RESC, (v) => -v);
for (const [mName, m] of MODELS.slice(0, 2)) {
  console.log("\n" + "=".repeat(124) + "\nFADE THE BREAKOUT (opposite side, same moments and bracket), " + mName + "\n" + "=".repeat(124) + "\n" + HDR);
  for (const rr of [0.1, 0.15, 0.2, 0.3, 0.5, 1.0, null])
    console.log(row(rr === null ? "fade, live target" : "fade, RR " + rr, score({ ...m, ...(rr === null ? {} : { tpFromFill: true, tpFn: (a) => rr * stopDist(a) }) }, FADE)));
}
