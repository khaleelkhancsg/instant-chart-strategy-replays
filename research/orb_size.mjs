// Round 12 -- redo the sizing with the real allocation: up to 50 MNQ lots.
//
// Everything above sized to $500 of risk with a 40-lot ceiling, so trades ran
// around 8 lots. The velocity trade then failed for one reason only: pf 2.99 and
// $115 a trade cannot reach $3,000 inside 21 days at 0.41 trades a day. Six
// times the size attacks exactly that.
//
// But size does not scale linearly here, because the $1,000 platform cap is a
// DOLLAR limit, not a point limit. At 50 lots on MNQ ($2/point) $1,000 is ten
// points, so above a certain size the cap becomes the real stop no matter what
// stop you set, and mean adverse excursion in the first minute after a break is
// about 17 points. There is an optimum, and it has to be measured.
//
// The day cap is also modelled properly here for the first time: trades are
// walked in order, a liquidation truncates the trade that caused it, and the
// rest of that day is dropped rather than silently traded. That matters little
// at 8 lots and a great deal at 50.
//
// Usage:  node research/orb_size.mjs

import { setups, resolve, stat, passOfArr, dayKeys, CAP, PV,
         ALL, H1, H2, RECENT } from "./lib_orb.mjs";

// Walk each day in order; once the day is down $1,000 the platform is flat and
// nothing else trades that day.
function applyDayCap(trades) {
  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.tday)) byDay.set(t.tday, []);
    byDay.get(t.tday).push(t);
  }
  const out = [];
  for (const ts of byDay.values()) {
    let run = 0;
    for (const t of ts) {
      if (run <= -CAP + 1e-9) break;
      let p = t.raw;
      if (run + p < -CAP) p = -CAP - run;
      out.push({ ...t, pnl: p });
      run += p;
    }
  }
  return out;
}
function passOn(trades, keys) {
  const m = new Map(); for (const d of keys) m.set(d, 0);
  for (const t of trades) if (m.has(t.tday)) m.set(t.tday, m.get(t.tday) + t.pnl);
  return passOfArr(keys.map(k => m.get(k)));
}

const BASE = { levelMode: "touch", refWin: "PRE120", pivotK: 3, tolFrac: 0.08, minTouch: 3,
               retraceFrac: 0.33, giveUpCt: 570, mode: "plain", stopAt: "opposite",
               tpMode: "R", rMult: 2, maxLots: 50 };

const HDR = "  risk/trade  hold  n/day   lots   win%     pf   $/trade      net   liq%    pass   1stH   2ndH recent";
function row(lbl, cfg) {
  const { out } = setups(cfg);
  if (out.length < 100) return null;
  const raw = out.map(s => resolve(s, cfg));
  const t = applyDayCap(raw);
  if (!t.length) return null;
  const st = stat(t);
  const lots = t.reduce((a, b) => a + b.lots, 0) / t.length;
  const liq = 100 * t.filter(x => x.pnl <= -CAP + 1e-9).length / t.length;
  const p = passOn(t, ALL), p1 = passOn(t, H1), p2 = passOn(t, H2), pr = passOn(t, RECENT);
  console.log("  " + lbl.padEnd(20) + (t.length / 1861).toFixed(2).padStart(6) +
    lots.toFixed(1).padStart(7) + st.win.toFixed(1).padStart(7) + st.pf.toFixed(3).padStart(7) +
    ("$" + st.exp.toFixed(2)).padStart(10) + ("$" + Math.round(st.net / 1000) + "k").padStart(9) +
    liq.toFixed(1).padStart(6) + "%" + p.toFixed(1).padStart(8) + "%" +
    p1.toFixed(1).padStart(6) + "%" + p2.toFixed(1).padStart(6) + "%" + pr.toFixed(1).padStart(6) + "%");
  return { p, p1, p2, worse: Math.min(p1, p2) };
}

console.log("\n" + "=".repeat(120));
console.log("ROUND 12 -- THE VELOCITY TRADE AT UP TO 50 LOTS");
console.log("=".repeat(120));
console.log("  note: at 50 lots the $1,000 cap is a TEN POINT move, and mean adverse excursion");
console.log("  in the first minute after a break is ~17 points. Size cannot simply be turned up.");

console.log("\n-- (1) one trade a day: risk per trade x hold --");
console.log(HDR);
for (const rd of [250, 500, 750, 1000, 1500])
  for (const h of [1, 2, 3, 5, 15, 60])
    row("$" + rd + "  " + h + "m", { ...BASE, riskDollars: rd, maxHoldMin: h, maxPerDay: 1 });

console.log("\n-- (2) the same with re-arming, which was flat at 8 lots --");
console.log(HDR);
for (const rd of [500, 750, 1000])
  for (const n of [1, 2, 3, 5])
    row("$" + rd + "  3m  " + n + "/day", { ...BASE, riskDollars: rd, maxHoldMin: 3, maxPerDay: n });

console.log("\n-- (3) tight stop + max size, the configuration 50 lots actually unlocks --");
console.log(HDR);
for (const [sl, sk] of [["range", 0.25], ["range", 0.5], ["level", 0]])
  for (const rd of [500, 1000])
    for (const h of [1, 3, 15])
      row("$" + rd + " " + sl + sk + " " + h + "m",
          { ...BASE, stopAt: sl, stopK: sk, riskDollars: rd, maxHoldMin: h, maxPerDay: 1 });

console.log("\n-- (4) best-of scan, ranked on the worse half --");
const res = [];
for (const rd of [250, 400, 500, 650, 800, 1000, 1250, 1500])
for (const h of [1, 2, 3, 5, 8, 15, 30, 60])
for (const n of [1, 2, 3])
for (const [sl, sk] of [["opposite", 0], ["range", 0.5], ["range", 1.0]])
for (const rM of [1.5, 2, 3]) {
  const cfg = { ...BASE, riskDollars: rd, maxHoldMin: h, maxPerDay: n, stopAt: sl, stopK: sk, rMult: rM };
  const { out } = setups(cfg);
  if (out.length < 200) continue;
  const t = applyDayCap(out.map(s => resolve(s, cfg)));
  const p1 = passOn(t, H1), p2 = passOn(t, H2);
  res.push({ lbl: "$" + rd + " " + h + "m " + n + "/d " + sl + sk + " " + rM + "R",
             worse: Math.min(p1, p2), p1, p2, all: passOn(t, ALL), rec: passOn(t, RECENT),
             st: stat(t), lots: t.reduce((a, b) => a + b.lots, 0) / t.length });
}
res.sort((a, b) => b.worse - a.worse);
console.log("  #  config                          lots   n   win%     pf  $/trade   worse    1stH    2ndH  recent");
for (let i = 0; i < 12; i++) { const r = res[i];
  console.log("  " + String(i + 1).padStart(2) + " " + r.lbl.padEnd(30) + r.lots.toFixed(1).padStart(6) +
    String(r.st.n).padStart(6) + r.st.win.toFixed(1).padStart(7) + r.st.pf.toFixed(3).padStart(7) +
    ("$" + r.st.exp.toFixed(2)).padStart(9) + r.worse.toFixed(1).padStart(8) + "%" +
    r.p1.toFixed(1).padStart(7) + "%" + r.p2.toFixed(1).padStart(7) + "%" + r.rec.toFixed(1).padStart(7) + "%");
}
console.log("\n  shipped bot at 8 lots, same harness, same days: 49.8%");
