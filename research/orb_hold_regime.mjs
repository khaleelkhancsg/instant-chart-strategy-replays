// The one change that survived: hold time.
//
// A further target earns more per trade and passes LESS -- more variance, fewer
// passes -- so it does not translate. A longer hold improved pass rate in every
// recent window while costing nothing pooled, which is the signature of a
// regime effect rather than a lucky config.
//
// Before believing it: check the optimum is smooth rather than a spike, check
// the mechanism (is price still moving at minute 5 in 2026?), and check a
// shuffled-level book does not prefer the same number -- if it does, the
// preference is about the clock, not about the level.
//
//   node research/orb_hold_regime.mjs

import { simulate, days, pass21, ORB_CFG } from "./joint_account.mjs";
import { setups, resolve, dayStart, dayEnd, TS, H, L } from "./lib_orb.mjs";

const yearOf = (t) => new Date(TS[dayStart.get(t)]).getUTCFullYear();
const firstIdx = (y) => days.findIndex((d) => yearOf(d) >= y);
const WINDOWS = [[2019, "all years"], [2024, "2024-26"], [2025, "2025-26"], [2026, "2026"]];

console.log("\n" + "=".repeat(96));
console.log("1. HOLD TIME SWEEP ON PASS RATE — is the optimum smooth?");
console.log("=".repeat(96));
console.log("\n  hold          " + WINDOWS.map(([, l]) => l.padStart(13)).join("") + "        $/day");
for (const maxHoldMin of [3, 5, 8, 10, 12, 15, 20, 30]) {
  const r = simulate("both", { exclusive: true, donLots: 8,
                               orbCfg: { ...ORB_CFG, maxHoldMin } });
  console.log("  " + ((maxHoldMin === 5 ? "SHIPPED " : "        ") + maxHoldMin + " min").padEnd(14) +
    WINDOWS.map(([y]) => (pass21(r.arr.slice(firstIdx(y))).toFixed(1) + "%").padStart(13)).join("") +
    ("$" + (r.arr.reduce((a, b) => a + b, 0) / r.arr.length).toFixed(2)).padStart(13));
}

console.log("\n" + "=".repeat(96));
console.log("2. MECHANISM — is price still travelling at minute 5?");
console.log("=".repeat(96));
const CFG = { ...ORB_CFG };
const { out } = setups(CFG);
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * a.length)];
console.log("\n  median favourable excursion reached by minute N, in points");
console.log("  window          m1     m2     m3     m5     m8    m10    m15    m20");
for (const [fy, label] of WINDOWS) {
  const rows = out.filter((s) => yearOf(s.day) >= fy);
  const line = [1, 2, 3, 5, 8, 10, 15, 20].map((mm) => {
    const v = rows.map((s) => {
      const e0 = dayEnd.get(s.day);
      let best = 0;
      for (let j = s.bar; j < Math.min(s.bar + mm, e0); j++) {
        const up = (s.dir === 1 ? H[j] - s.entryPx : s.entryPx - L[j]);
        if (up > best) best = up;
      }
      return best;
    });
    return q(v, 0.5).toFixed(1).padStart(7);
  }).join("");
  console.log("  " + label.padEnd(14) + line);
}
console.log("\n  If the median is still climbing between m5 and m10, the five-minute");
console.log("  stop is cutting trades that are still going.");

console.log("\n" + "=".repeat(96));
console.log("3. MATCHED NULL — does a shuffled-level book prefer 10 minutes too?");
console.log("=".repeat(96));
console.log("\n  hold            real 2024-26     shuffled 2024-26        gap");
for (const maxHoldMin of [3, 5, 10, 15, 20]) {
  const real = simulate("both", { exclusive: true, donLots: 8,
                                  orbCfg: { ...ORB_CFG, maxHoldMin } });
  const nul = simulate("both", { exclusive: true, donLots: 8,
                                 orbCfg: { ...ORB_CFG, maxHoldMin,
                                           levelMode: "touchShuffled", levelSeed: 23 } });
  const i = firstIdx(2024);
  const a = pass21(real.arr.slice(i)), b = pass21(nul.arr.slice(i));
  console.log("  " + ((maxHoldMin === 5 ? "SHIPPED " : "        ") + maxHoldMin + " min").padEnd(16) +
    (a.toFixed(1) + "%").padStart(13) + (b.toFixed(1) + "%").padStart(21) +
    ((a - b >= 0 ? "+" : "") + (a - b).toFixed(1) + "pp").padStart(11));
}
