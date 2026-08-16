// Round 9 -- isolate the liquidity target, and answer the 1-second question
// where it actually bites.
//
// Round 8 section 2b was diluted: with a fallback to a fixed R, only 4% of the
// "liqNear" trades used a liquidity target at all, so the row was 96% the same
// strategy it was being compared with. The clean test is PAIRED -- take only the
// setups where a liquidity target exists, then resolve that identical schedule
// twice: once to the liquidity target, once to a fixed R. Same entries, same
// stops, same days. The only difference is where profit is taken.
//
// The 1-second question also needs re-asking. Round 8 measured intrabar
// ambiguity at 0.1-0.4% -- but that was on a WIDE opposite-side stop with a far
// target. Ambiguity is a function of how close the two barriers are, so it
// should be measured on the tight-stop configuration, which is his actual rule
// and the worst case for 1-minute data.
//
// Usage:  node research/orb_liq_paired.mjs

import { setups, resolve, stat, passOf, ALL, H1, H2, RECENT, inSet } from "./lib_orb.mjs";

const TOUCH = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
                retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500, maxHoldMin: 1000 };
const GEO = { ...TOUCH, mode: "plain", stopAt: "opposite" };
const HIS = { ...TOUCH, mode: "confirmed", stopAt: "level", maxHoldMin: 120 };
const MODES = ["windowExt", "liqNear", "liqFar", "liqBest", "prevDay", "sessExt"];

console.log("\n" + "=".repeat(120));
console.log("ROUND 9 -- THE LIQUIDITY TARGET, ISOLATED");
console.log("=".repeat(120));

// ---- 1. unfiltered target distances --------------------------------------
console.log("\n-- (1) how far is liquidity, in units of the trade's own risk? (no min/max filter) --");
console.log("  target        setups w/ a target    <0.5R   <1R    1-3R   >3R    median R");
for (const tpMode of MODES) {
  const { out } = setups({ ...GEO, tpMode, tpFallback: "skip", tpMinR: 0, tpMaxR: 1e9 });
  const base = setups({ ...GEO, tpMode: "R" }).out.length;
  if (!out.length) { console.log("  " + tpMode.padEnd(14) + "  none"); continue; }
  const rs = out.map(s => (s.tpPx - s.entryPx) * s.dir / s.risk).sort((a, b) => a - b);
  const pc = (f) => (100 * rs.filter(f).length / rs.length).toFixed(0).padStart(6) + "%";
  console.log("  " + tpMode.padEnd(14) + (out.length + "/" + base).padStart(18) +
    pc(r => r < 0.5) + pc(r => r < 1) + pc(r => r >= 1 && r <= 3) + pc(r => r > 3) +
    rs[rs.length >> 1].toFixed(2).padStart(12));
}

// ---- 2. paired: same trades, liquidity target vs fixed R -----------------
const HDR2 = "  target        n   win%     pf   $/trade      pass  |  vs 2R: pf   $/trade    pass  |  vs 3R: pf   $/trade    pass";
function line(tpMode, cfg) {
  const { out } = setups({ ...cfg, tpMode, tpFallback: "skip", tpMinR: 0.2, tpMaxR: 20 });
  if (out.length < 60) { console.log("  " + tpMode.padEnd(12) + String(out.length).padStart(5) + "   too few to evaluate"); return; }
  const L = out.map(s => resolve(s, cfg));
  const R2 = out.map(s => resolve({ ...s, tpPx: null }, { ...cfg, rMult: 2 }));
  const R3 = out.map(s => resolve({ ...s, tpPx: null }, { ...cfg, rMult: 3 }));
  const f = (t) => { const st = stat(t); return [st.pf, st.exp, passOf(t, ALL)]; };
  const [pf, ex, pa] = f(L), [p2, e2, a2] = f(R2), [p3, e3, a3] = f(R3);
  console.log("  " + tpMode.padEnd(12) + String(out.length).padStart(5) +
    stat(L).win.toFixed(1).padStart(7) + pf.toFixed(3).padStart(7) +
    ("$" + ex.toFixed(2)).padStart(10) + pa.toFixed(1).padStart(10) + "%  |" +
    p2.toFixed(3).padStart(11) + ("$" + e2.toFixed(2)).padStart(10) + a2.toFixed(1).padStart(8) + "%  |" +
    p3.toFixed(3).padStart(11) + ("$" + e3.toFixed(2)).padStart(10) + a3.toFixed(1).padStart(8) + "%");
}
console.log("\n-- (2) PAIRED on the strong geometry: identical trades, only the exit differs --");
console.log(HDR2);
for (const m of MODES) line(m, GEO);
console.log("\n-- (2b) PAIRED on his full rule (push/retrace/push, stop at the level) --");
console.log(HDR2);
for (const m of MODES) line(m, HIS);

// ---- 3. the 1-second question, on the config where it bites -------------
console.log("\n-- (3) what 1-second resolution is worth, measured where the barriers are CLOSEST --");
console.log("   ambiguity is a function of how near the stop and target are to each other, so the");
console.log("   tight-stop rule is the worst case for 1-minute bars, not the wide-stop one.");
console.log("\n  config                       target       ambiguous   pass(stop 1st)  pass(tgt 1st)   spread");
for (const [lbl, cfg] of [["his rule (stop at level)", HIS], ["strong geo (wide stop)", GEO]])
for (const tpMode of ["R", "windowExt", "liqBest"]) {
  const c = { ...cfg, tpMode, tpFallback: "R", rMult: tpMode === "R" ? 2 : 2 };
  const { out } = setups(c);
  const P = out.map(s => resolve(s, { ...c, barFirst: "stop" }));
  const Q = out.map(s => resolve(s, { ...c, barFirst: "target" }));
  const amb = 100 * P.filter(t => t.ambig).length / P.length;
  const a = passOf(P, ALL), b = passOf(Q, ALL);
  console.log("  " + lbl.padEnd(29) + tpMode.padEnd(12) + amb.toFixed(1).padStart(9) + "%" +
    a.toFixed(1).padStart(15) + "%" + b.toFixed(1).padStart(14) + "%" + (b - a).toFixed(1).padStart(9) + "pp");
}

// ---- 4. and the same question for the ENTRY, which is where sub-bar timing
//         actually cost money in the live bot -----------------------------
console.log("\n-- (4) for contrast: the shipped bot's entry timing was worth 21.8pp (research/fill_mechanism.mjs).");
console.log("   That is what a real sub-bar sensitivity looks like. Exit timing here is not one.");
