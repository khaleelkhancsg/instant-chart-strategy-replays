// The ORB's best 50-lot configuration scored 48.1% on its worse half, out of a
// 1,728-config search with no control attached. Attach the controls.
//
// Shuffling the LEVELS between days is the sharp one: same days, same entry
// times, same distances, same sizing, same day-cap behaviour -- only "this
// particular price is where price kept turning" destroyed.
//
// Usage:  node research/orb_size_control.mjs

import { setups, resolve, stat, passOfArr, CAP, ALL, H1, H2, RECENT } from "./lib_orb.mjs";

function applyDayCap(trades) {
  const byDay = new Map();
  for (const t of trades) { if (!byDay.has(t.tday)) byDay.set(t.tday, []); byDay.get(t.tday).push(t); }
  const out = [];
  for (const ts of byDay.values()) {
    let run = 0;
    for (const t of ts) {
      if (run <= -CAP + 1e-9) break;
      let p = t.raw;
      if (run + p < -CAP) p = -CAP - run;
      out.push({ ...t, pnl: p }); run += p;
    }
  }
  return out;
}
function passOn(trades, keys) {
  const m = new Map(); for (const d of keys) m.set(d, 0);
  for (const t of trades) if (m.has(t.tday)) m.set(t.tday, m.get(t.tday) + t.pnl);
  return passOfArr(keys.map(k => m.get(k)));
}

const WIN = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
              retraceFrac: 0.33, giveUpCt: 570, mode: "plain", stopAt: "opposite",
              tpMode: "R", rMult: 1.5, maxLots: 50, riskDollars: 1500,
              maxHoldMin: 60, maxPerDay: 1 };

const HDR = "  variant                       n   lots   win%     pf   $/trade    liq%    pass   1stH   2ndH recent";
function row(lbl, cfg) {
  const { out } = setups(cfg);
  // resolve() takes flipDir, not flipSeed -- passing a seed straight through
  // silently produces an UNSHUFFLED control that matches the real run exactly.
  let rnd = (cfg.flipSeed || 0) >>> 0;
  const coin = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd > 2147483648 ? 1 : -1; };
  const t = applyDayCap(out.map(s => resolve(s, cfg.flipSeed ? { ...cfg, flipDir: coin() } : cfg)));
  const st = stat(t);
  const lots = t.reduce((a, b) => a + b.lots, 0) / t.length;
  const liq = 100 * t.filter(x => x.pnl <= -CAP + 1e-9).length / t.length;
  const p1 = passOn(t, H1), p2 = passOn(t, H2);
  console.log("  " + lbl.padEnd(26) + String(st.n).padStart(6) + lots.toFixed(1).padStart(7) +
    st.win.toFixed(1).padStart(7) + st.pf.toFixed(3).padStart(7) + ("$" + st.exp.toFixed(2)).padStart(10) +
    liq.toFixed(1).padStart(7) + "%" + passOn(t, ALL).toFixed(1).padStart(8) + "%" +
    p1.toFixed(1).padStart(6) + "%" + p2.toFixed(1).padStart(6) + "%" +
    passOn(t, RECENT).toFixed(1).padStart(6) + "%");
  return Math.min(p1, p2);
}

console.log("\n" + "=".repeat(112));
console.log("CONTROLS ON THE ORB'S BEST 50-LOT CONFIGURATION");
console.log("=".repeat(112));
console.log("\n" + HDR);
const real = row("real levels", WIN);
const sh = [];
for (const s of [5, 11, 23, 42, 77])
  sh.push(row("  levels shuffled s" + s, { ...WIN, levelMode: "touchShuffled", levelSeed: s }));
row("  direction shuffled", { ...WIN, flipSeed: 99 });
console.log("\n  real worse-half " + real.toFixed(1) + "%  vs  level-shuffled mean " +
            (sh.reduce((a, b) => a + b, 0) / sh.length).toFixed(1) + "%  (range " +
            Math.min(...sh).toFixed(1) + "-" + Math.max(...sh).toFixed(1) + "%)");

console.log("\n-- cost sensitivity: 31 lots is a real position, thin books punish it --");
console.log(HDR);
for (const cm of [1, 1.5, 2, 3]) row("costs x" + cm, { ...WIN, costMult: cm });

console.log("\n-- walk-forward: pick the size/hold on the FIRST half, read the second --");
const G = [];
for (const rd of [250, 400, 500, 650, 800, 1000, 1250, 1500])
for (const h of [1, 2, 3, 5, 8, 15, 30, 60])
for (const rM of [1.5, 2, 3])
for (const [sl, sk] of [["opposite", 0], ["range", 0.5], ["range", 1.0]]) {
  const cfg = { ...WIN, riskDollars: rd, maxHoldMin: h, rMult: rM, stopAt: sl, stopK: sk };
  const { out } = setups(cfg);
  if (out.length < 200) continue;
  const t = applyDayCap(out.map(s => resolve(s, cfg)));
  const ts = applyDayCap(setups({ ...cfg, levelMode: "touchShuffled" }).out
                          .map(s => resolve(s, { ...cfg, levelMode: "touchShuffled" })));
  G.push({ p1: passOn(t, H1), p2: passOn(t, H2), s1: passOn(ts, H1), s2: passOn(ts, H2) });
}
const top = G.slice().sort((a, b) => b.p1 - a.p1).slice(0, 10);
const tops = G.slice().sort((a, b) => b.s1 - a.s1).slice(0, 10);
const av = (a, k) => a.reduce((x, y) => x + y[k], 0) / a.length;
console.log("  configs: " + G.length);
console.log("  REAL     top-10 on 1st half: " + av(top, "p1").toFixed(1) + "%  ->  held-out " + av(top, "p2").toFixed(1) + "%");
console.log("  SHUFFLED top-10 on 1st half: " + av(tops, "s1").toFixed(1) + "%  ->  held-out " + av(tops, "s2").toFixed(1) + "%");
console.log("  gap on the held-out half:    " + (av(top, "p2") - av(tops, "s2")).toFixed(1) + "pp");
console.log("\n  shipped bot at 8 lots: 49.8% all-history, 48.6% on its worse half");
