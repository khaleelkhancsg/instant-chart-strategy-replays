// The strategy as the transcript actually describes it, assembled as ONE thing.
//
// The shipped book keeps the transcript's LEVELS and drops the rest. Re-reading
// the source, three rules were dropped, and they are coupled:
//
//   ENTRY  "push past the level, a retrace, and a second push past the FIRST
//          push -- that's where we're going to be entering."
//   STOP   "Your stop loss wants to go basically at this level, because if it
//          starts getting back to that level it's probably cooked anyway."
//   TARGET "take profit's going to be just off liquidity and places that it
//          wants to be. It can even be off another level."
//
// Each was tested on its own and lost, but on its own is the wrong test. The
// confirmation is what puts the entry a real distance ABOVE the level, which is
// what makes a stop AT the level a small stop -- and a small stop is a big
// position, because size is $500 / stop. Bolting the confirmation onto a book
// whose stop is the FAR level just buys a worse entry with the same huge risk,
// which is guaranteed to lose. That is what the old test measured.
//
//   node research/orb_transcript_faithful.mjs

import { setups, resolve, dayStart, TS } from "./lib_orb.mjs";

const LEVELS = { levelMode: "touch", refWin: "PRE120", pivotK: 3,
                 tolFrac: 0.08, minTouch: 3, giveUpCt: 570,
                 riskDollars: 500, maxLots: 50, maxPerDay: 1 };

const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const sum = (a) => a.reduce((x, y) => x + y, 0);
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * a.length)];

function build(cfg) {
  const { out, diag } = setups(cfg);
  const t = out.map((s) => resolve(s, {
    rMult: cfg.rMult ?? 3, maxHoldMin: cfg.maxHoldMin ?? 5,
    riskDollars: cfg.riskDollars, maxLots: cfg.maxLots }));
  return { t, diag, out };
}

function line(label, cfg) {
  const { t } = build(cfg);
  const mod = t.filter((x) => yearOf(x.tday) >= 2024);
  const risks = t.map((x) => x.risk), lots = t.map((x) => x.lots);
  const p = (rows) => (rows.length ? sum(rows.map((r) => r.pnl)) / rows.length : 0);
  console.log("  " + label.padEnd(34) + String(t.length).padStart(7) +
    q(risks, .5).toFixed(1).padStart(10) + q(lots, .5).toString().padStart(9) +
    (100 * lots.filter((l) => l === 1).length / lots.length).toFixed(1).padStart(8) + "%" +
    ("$" + p(t).toFixed(0)).padStart(10) +
    ("$" + Math.round(sum(t.map((r) => r.pnl))).toLocaleString()).padStart(12) +
    ("$" + p(mod).toFixed(0) + " (" + mod.length + ")").padStart(15));
  return t;
}

console.log("\n" + "=".repeat(116));
console.log("THE TRANSCRIPT'S RULES, ADDED BACK ONE AT A TIME AND THEN TOGETHER");
console.log("=".repeat(116));
console.log("\n  variant                            trades  med stop  med lots   1-lot%   $/trade" +
            "         net    2024-26 $/tr");

line("SHIPPED  plain, stop=opposite, 3R",
     { ...LEVELS, mode: "plain", stopAt: "opposite", rMult: 3, maxHoldMin: 5 });
line("  + confirmation only",
     { ...LEVELS, mode: "confirmed", stopAt: "opposite", rMult: 3, maxHoldMin: 5 });
line("  + level stop only (no confirm)",
     { ...LEVELS, mode: "plain", stopAt: "level", rMult: 3, maxHoldMin: 5 });
console.log("");
line("TRANSCRIPT confirm + level stop, 2R",
     { ...LEVELS, mode: "confirmed", stopAt: "level", rMult: 2, maxHoldMin: 5 });
line("TRANSCRIPT confirm + level stop, 3R",
     { ...LEVELS, mode: "confirmed", stopAt: "level", rMult: 3, maxHoldMin: 5 });
line("TRANSCRIPT + liquidity target (near)",
     { ...LEVELS, mode: "confirmed", stopAt: "level", tpMode: "liqNear", maxHoldMin: 5 });
line("TRANSCRIPT + liquidity target (best)",
     { ...LEVELS, mode: "confirmed", stopAt: "level", tpMode: "liqBest", maxHoldMin: 5 });
line("TRANSCRIPT + opposite level as target",
     { ...LEVELS, mode: "confirmed", stopAt: "level", tpMode: "windowExt", maxHoldMin: 5 });

console.log("\n  The transcript's own trade was 2m13s, so hold time is swept separately.");
console.log("\n  hold sweep on confirm + level stop, 3R");
console.log("  hold      trades   med lots    $/trade          net    2024-26 $/tr");
for (const maxHoldMin of [2, 3, 5, 10, 20]) {
  const { t } = build({ ...LEVELS, mode: "confirmed", stopAt: "level",
                        rMult: 3, maxHoldMin });
  const mod = t.filter((x) => yearOf(x.tday) >= 2024);
  console.log("  " + (maxHoldMin + " min").padEnd(10) + String(t.length).padStart(7) +
    q(t.map((x) => x.lots), .5).toString().padStart(11) +
    ("$" + (sum(t.map((r) => r.pnl)) / t.length).toFixed(0)).padStart(11) +
    ("$" + Math.round(sum(t.map((r) => r.pnl))).toLocaleString()).padStart(13) +
    ("$" + (sum(mod.map((r) => r.pnl)) / mod.length).toFixed(0) +
     " (" + mod.length + ")").padStart(16));
}
