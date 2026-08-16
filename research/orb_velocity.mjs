// Round 10 -- the velocity thesis, tested as mechanism rather than as an exit rule.
//
// Fair criticism of rounds 1-9: every search drifted to targets held for hours,
// and the shortest time stop in the grid was 15 minutes. His trade was 2m13s.
// The whole idea is to catch the burst right after the break and leave.
//
// Testing that by grid-searching exit rules is the wrong instrument -- it
// confounds the claim with the target, the stop and the sizing. The claim
// itself is simply: AFTER THE BREAK, PRICE MOVES IN THE BREAK'S DIRECTION,
// FASTEST AT THE START. That is measurable directly, with no exit rule at all.
//
// So: for every entry, record the signed excursion at +1, +2, +3, +5, +10, +20,
// +40, +80 minutes, in points and in units of the trade's own risk. If velocity
// is real, drift per minute is steepest at the start and decays. If the first
// minutes are flat or negative, the thesis is dead regardless of exit rule.
//
// Controls, on the identical entry schedule:
//   levels shuffled   the level borrowed from another day (kills "this price")
//   direction shuffled a coin flip (kills the break's directional claim)
//
// And separately: does the SECOND PUSH buy steeper early drift? That is his
// stated reason for waiting, and it is a clean per-horizon comparison.
//
// Usage:  node research/orb_velocity.mjs

import { setups, resolve, stat, passOf, CT, O, H, L, C, FLAT_CT, PV,
         ALL, H1, H2, RECENT, inSet } from "./lib_orb.mjs";

const HOR = [1, 2, 3, 5, 10, 20, 40, 80];
const TOUCH = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
                retraceFrac: 0.33, giveUpCt: 570, riskDollars: 500 };
const PLAIN = { ...TOUCH, mode: "plain", stopAt: "opposite" };
const CONF  = { ...TOUCH, mode: "confirmed", stopAt: "opposite" };

// Signed excursion after entry, with NO stop and NO target -- pure drift.
function profile(cfg, flipSeed = 0) {
  const { out } = setups(cfg);
  let rnd = (flipSeed || 1) >>> 0;
  const coin = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd > 2147483648; };
  const acc = HOR.map(() => ({ sum: 0, sumR: 0, n: 0, up: 0, mfe: 0, mae: 0 }));
  for (const s of out) {
    const dir = flipSeed ? (coin() ? 1 : -1) : s.dir;
    let mfe = 0, mae = 0;
    for (let k = 0; k < HOR.length; k++) {
      const j = s.bar + HOR[k];
      if (j >= s.e0 || CT[j] >= FLAT_CT) break;
      for (let m = s.bar + (k ? HOR[k - 1] + 1 : 0); m <= j; m++) {
        const f = (dir === 1 ? H[m] - s.entryPx : s.entryPx - L[m]);
        const a = (dir === 1 ? s.entryPx - L[m] : H[m] - s.entryPx);
        if (f > mfe) mfe = f; if (a > mae) mae = a;
      }
      const d = (C[j] - s.entryPx) * dir;
      const A = acc[k];
      A.sum += d; A.sumR += d / s.risk; A.n++; if (d > 0) A.up++;
      A.mfe += mfe; A.mae += mae;
    }
  }
  return acc.map((A) => ({
    n: A.n, pts: A.sum / A.n, R: A.sumR / A.n, up: 100 * A.up / A.n,
    mfe: A.mfe / A.n, mae: A.mae / A.n,
  }));
}

const show = (lbl, p) => {
  console.log("  " + lbl.padEnd(26) +
    p.map(x => (x ? x.pts.toFixed(2) : "-").padStart(8)).join(""));
};
const showR = (lbl, p) => {
  console.log("  " + lbl.padEnd(26) +
    p.map(x => (x ? (100 * x.R).toFixed(1) : "-").padStart(8)).join(""));
};

console.log("\n" + "=".repeat(112));
console.log("ROUND 10 -- IS THERE ACTUALLY VELOCITY AFTER THE BREAK?");
console.log("=".repeat(112));
console.log("\n  Mean signed drift after entry, in POINTS. No stop, no target -- just where price goes.");
console.log("  minutes after entry:      " + HOR.map(h => ("+" + h).padStart(8)).join(""));

const pPlain = profile(PLAIN);
const pConf  = profile(CONF);
show("plain break", pPlain);
show("  levels shuffled", profile({ ...PLAIN, levelMode: "touchShuffled" }));
show("  direction shuffled", profile(PLAIN, 99));
show("confirmed (2nd push)", pConf);
show("  levels shuffled", profile({ ...CONF, levelMode: "touchShuffled" }));
show("  direction shuffled", profile(CONF, 99));

console.log("\n  Same thing as a % of the trade's own risk (so it is comparable across days):");
console.log("  minutes after entry:      " + HOR.map(h => ("+" + h).padStart(8)).join(""));
showR("plain break", pPlain);
showR("  levels shuffled", profile({ ...PLAIN, levelMode: "touchShuffled" }));
showR("confirmed (2nd push)", pConf);
showR("  levels shuffled", profile({ ...CONF, levelMode: "touchShuffled" }));

console.log("\n  Drift per minute (points), which is what 'velocity' actually means:");
console.log("  window:                   " + ["0-1", "1-2", "2-3", "3-5", "5-10", "10-20", "20-40", "40-80"]
  .map(s => s.padStart(8)).join(""));
const perMin = (p) => p.map((x, k) => {
  if (!x) return null;
  const prev = k ? p[k - 1] : { pts: 0 };
  return (x.pts - prev.pts) / (HOR[k] - (k ? HOR[k - 1] : 0));
});
const showPM = (lbl, p) => console.log("  " + lbl.padEnd(26) +
  perMin(p).map(v => (v == null ? "-" : v.toFixed(3)).padStart(8)).join(""));
showPM("plain break", pPlain);
showPM("  levels shuffled", profile({ ...PLAIN, levelMode: "touchShuffled" }));
showPM("confirmed (2nd push)", pConf);

console.log("\n  Favourable vs adverse excursion (points), plain break:");
console.log("  minutes:                  " + HOR.map(h => ("+" + h).padStart(8)).join(""));
console.log("  " + "MFE (best seen)".padEnd(26) + pPlain.map(x => x.mfe.toFixed(2).padStart(8)).join(""));
console.log("  " + "MAE (worst seen)".padEnd(26) + pPlain.map(x => x.mae.toFixed(2).padStart(8)).join(""));
console.log("  " + "MFE - MAE".padEnd(26) + pPlain.map(x => (x.mfe - x.mae).toFixed(2).padStart(8)).join(""));

// ---- the velocity regime as an actual strategy ---------------------------
console.log("\n-- velocity regime: hard time stop measured in MINUTES, tight stop, near target --");
console.log("  hold  stop        target       n   win%     pf   $/trade         net    pass   1stH   2ndH");
for (const maxHoldMin of [1, 2, 3, 5, 8, 15, 30])
for (const [sLbl, stopAt, stopK] of [["level", "level", 0], ["0.5xrange", "range", 0.5], ["opposite", "opposite", 0]])
for (const [tLbl, tpMode, rMult] of [["1R", "R", 1], ["2R", "R", 2], ["liqBest", "liqBest", 2]]) {
  const c = { ...TOUCH, mode: "plain", stopAt, stopK, maxHoldMin, tpMode, rMult, tpFallback: "R" };
  const { out } = setups(c);
  if (out.length < 200) continue;
  const t = out.map(s => resolve(s, c));
  const st = stat(t);
  if (st.exp <= 0) continue;                    // only show what is at least profitable
  console.log("  " + String(maxHoldMin).padStart(4) + "m " + sLbl.padEnd(11) + tLbl.padEnd(10) +
    String(st.n).padStart(6) + st.win.toFixed(1).padStart(7) + st.pf.toFixed(3).padStart(7) +
    ("$" + st.exp.toFixed(2)).padStart(10) + ("$" + Math.round(st.net).toLocaleString()).padStart(12) +
    passOf(t, ALL).toFixed(1).padStart(8) + "%" +
    passOf(inSet(t, H1), H1).toFixed(1).padStart(6) + "%" +
    passOf(inSet(t, H2), H2).toFixed(1).padStart(6) + "%");
}
