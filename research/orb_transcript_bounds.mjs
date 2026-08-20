// Two ways the faithful build could be under-selling the transcript.
//
// 1. "Your stop loss wants to go BASICALLY at this level" -- basically, not
//    exactly. A stop sitting precisely on the level sits inside the noise the
//    retrace just made, which is a good way to lose 63% of trades. Give it room.
//
// 2. RESOLUTION. The stop here is ~20 points on 1-minute bars whose range is
//    often larger, so a bar containing both barriers is common -- and resolve()
//    assumes the STOP printed first every time. That is the pessimistic bound.
//    barFirst:"target" is the optimistic one. The truth is between, and the gap
//    is exactly what second-by-second data would settle. He trades off seconds.
//
//   node research/orb_transcript_bounds.mjs

import { setups, resolve, dayStart, TS } from "./lib_orb.mjs";

const L = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08,
            minTouch: 3, giveUpCt: 570, riskDollars: 500, maxLots: 50,
            maxPerDay: 1, abandon: "reset", retraceFrac: 0.2 };
const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const sum = (a) => a.reduce((x, y) => x + y, 0);

function go(cfg, opt) {
  const { out } = setups(cfg);
  const t = out.map((s) => resolve(s, { rMult: cfg.rMult ?? 3,
    maxHoldMin: cfg.maxHoldMin ?? 5, riskDollars: cfg.riskDollars,
    maxLots: cfg.maxLots, ...opt }));
  const mod = t.filter((x) => yearOf(x.tday) >= 2024);
  return { n: t.length, per: sum(t.map((x) => x.pnl)) / t.length,
           net: sum(t.map((x) => x.pnl)),
           win: 100 * t.filter((x) => x.pnl > 0).length / t.length,
           ambig: 100 * t.filter((x) => x.ambig).length / t.length,
           mod: mod.length ? sum(mod.map((x) => x.pnl)) / mod.length : 0 };
}

console.log("\n" + "=".repeat(104));
console.log("1. GIVING THE STOP ROOM BEYOND THE LEVEL");
console.log("=".repeat(104));
console.log("\n  stop placement                    trades   win%   $/trade         net   2024-26 $/tr");
const TR = { ...L, mode: "confirmed", stopAt: "level", rMult: 3, maxHoldMin: 5 };
for (const [lbl, cfg] of [
  ["exactly at the level", TR],
  ["half-way to the opposite", { ...TR, stopAt: "range", stopK: 0.5 }],
  ["a quarter of the range",   { ...TR, stopAt: "range", stopK: 0.25 }],
  ["beyond the retrace extreme", { ...TR, stopAt: "retrace" }],
  ["at the opposite level",    { ...TR, stopAt: "opposite" }],
]) {
  const r = go(cfg, {});
  console.log("  " + lbl.padEnd(32) + String(r.n).padStart(7) + r.win.toFixed(1).padStart(7) +
    ("$" + r.per.toFixed(0)).padStart(10) +
    ("$" + Math.round(r.net).toLocaleString()).padStart(12) +
    ("$" + r.mod.toFixed(0)).padStart(16));
}

console.log("\n" + "=".repeat(104));
console.log("2. THE RESOLUTION BRACKET — what second-by-second data could be hiding");
console.log("=".repeat(104));
console.log("\n  book                        ambiguous bars   pessimistic   optimistic      spread");
for (const [lbl, cfg] of [
  ["TRANSCRIPT confirm+level", TR],
  ["SHIPPED plain+opposite",
   { ...L, mode: "plain", stopAt: "opposite", rMult: 3, maxHoldMin: 5, abandon: undefined }],
]) {
  const p = go(cfg, { barFirst: "stop" }), o = go(cfg, { barFirst: "target" });
  console.log("  " + lbl.padEnd(28) + (p.ambig.toFixed(1) + "%").padStart(14) +
    ("$" + p.per.toFixed(0) + "/tr").padStart(14) +
    ("$" + o.per.toFixed(0) + "/tr").padStart(13) +
    ("$" + (o.per - p.per).toFixed(0)).padStart(12));
}
console.log("\n  If the transcript book is still negative at its OPTIMISTIC bound, no");
console.log("  amount of finer data rescues it — the losses are not a resolution");
console.log("  artifact, they are the strategy.");
