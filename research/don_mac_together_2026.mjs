// Why does Donchian + MACD in one account pass LESS than the Donchian alone,
// and can different sizes, limits or schedules make them work together?
// 2026 ONLY, both combines, honest fills, realistic costs, causal exit order,
// the shared-account replay of lib_combo.mjs.
//
//   1. diagnosis: day by day, where does the pair differ from the Donchian alone?
//   2. search: lot ratio, a per-trade dollar cap on the MACD, the MACD standing
//      down after its own loss, its own profit block, the shared profit block
//      and breaker, and time windows (MACD only early, Donchian only later)
//   3. validation: the best mix picked on one half of 2026 and read on the
//      other -- against the Donchian alone picked the same way -- its
//      neighbouring settings, and stress
//
// RESULT (2026 only):
// WHY the pair passes less on $1,250 (Donchian alone 71.1% -> 65.5% with the
// MACD, day rules on the account): the MACD trades first (its edge is the
// opening fade) and its result ends the day for both -- a win reaches the
// +$250 block, a loss trips the breaker. On 69 days the MACD's first trade
// ended the day before the Donchian traded: 47 wins (+$15.3k against what the
// Donchian made those days), 22 losses (-$12.5k). So it REPLACES the Donchian
// more than it adds to it. And its losses are full-limit losses (its stop is
// ~5 ATR, about the whole $600: average red day -$578 vs the Donchian's
// -$401): 38 days at the full limit instead of 17. The pair makes more money
// ($17.8k vs $9.9k in 2026) but two full-limit days in a row end an eval.
// Day results correlate +0.30.
// SEARCH (13,824 settings: lots, a MACD max loss, its own breaker / block, the
// shared block / breaker, MACD only early, Donchian only later): best 75.4%
// (D 4 from 10:00 + M 3 until 10:00, M max loss $400, M stops at +$150,
// -$300/+$250), but only 20 settings beat the Donchian alone, the peak is
// narrow (5 of 12 neighbours beat it; a $250 MACD max loss: 39.2%), picked on
// Jan-Mar it reads 25.8% on Apr-Jul, and one bar late 38.9% (Donchian 59.3%).
// $3,000: the plain pair 61.5% vs the Donchian alone 59.3% (MACD alone 56.3%);
// the search's best 70.5% (D 7 + M 3 until 09:00, M stops at +$300,
// -$500/+$500), 436 settings beat the Donchian alone, but picked on one half
// it is +1.8 / -2.2 points against the Donchian alone on the other.
// Continued in don_mac_validate_2026.mjs and don_mac_robust_2026.mjs.
//
//   node --max-old-space-size=8192 research/don_mac_together_2026.mjs

import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import { donTrades, macTrades, account, score } from "./lib_combo.mjs";

const T0 = Date.now();
const COMBINES = {
  "$1,250": { rules: { target: 1250, dd: 1000, consistency: 0.5 }, cap: 600,
              dAlone: { lots: 4, brk: 300, pb: 250 }, mAlone: { lots: 4, brk: 0, pb: 250 }, pair: { brk: 300, pb: 250 },
              G: { dLots: [3, 4, 5], mLots: [1, 2, 3, 4], mMax: [0, 150, 250, 400], mBrk: [0, 1], pb: [250, 350, 450], mPb: [0, 150, 250],
                   brk: [0, 300], mUntil: [540, 600, 895], dFrom: [510, 540, 600] },
              dGrid: { lots: [3, 4, 5], brk: [0, 200, 300, 400], pb: [150, 200, 250, 350, 450] } },
  "$3,000": { rules: { target: 3000, dd: 2000, consistency: 0.5 }, cap: 1000,
              dAlone: { lots: 7, brk: 500, pb: 400 }, mAlone: { lots: 6, brk: 0, pb: 300 }, pair: { brk: 0, pb: 500 },
              G: { dLots: [5, 6, 7, 8], mLots: [2, 3, 4, 6], mMax: [0, 250, 400, 600], mBrk: [0, 1], pb: [400, 500, 750], mPb: [0, 300],
                   brk: [0, 500], mUntil: [540, 600, 895], dFrom: [510, 540, 600] },
              dGrid: { lots: [5, 6, 7, 8, 9], brk: [0, 300, 500, 700], pb: [300, 400, 500, 750, 1000] } },
};
const f0 = (x, w = 6) => (Number.isFinite(x) ? Math.round(x).toString() : "-").padStart(w);
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const f2 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(2) : "-").padStart(w);
const hm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const D26 = M.Y26.map((k) => S.days[k]);
const monthOf = (d) => new Date(d * 86400000).getUTCMonth();

for (const [cname, C] of Object.entries(COMBINES)) {
  console.log("\n" + "=".repeat(124) + `\n${cname} COMBINE: target $${C.rules.target}, trailing $${C.rules.dd}, daily limit $${C.cap}, 50% consistency -- 2026\n` + "=".repeat(124));
  const dCache = new Map(), mCache = new Map();
  const dT = (lots, o = {}) => { const k = lots + JSON.stringify(o); if (!dCache.has(k)) dCache.set(k, donTrades(C.cap, lots, false, o)); return dCache.get(k); };
  const mT = (lots, o = {}) => { const k = lots + JSON.stringify(o); if (!mCache.has(k)) mCache.set(k, macTrades(C.cap, lots, false, o)); return mCache.get(k); };

  // ---- 1. diagnosis ------------------------------------------------------------------------
  const dA = account(dT(C.dAlone.lots), { cap: C.cap, brk: C.dAlone.brk, pb: C.dAlone.pb, log: true });
  const mA = account(mT(C.mAlone.lots), { cap: C.cap, brk: C.mAlone.brk, pb: C.mAlone.pb, log: true });
  const dm = account([...dT(C.dAlone.lots), ...mT(C.mAlone.lots)], { cap: C.cap, brk: C.pair.brk, pb: C.pair.pb, log: true });
  const sD = score(dA, C.rules), sM = score(mA, C.rules), sDM = score(dm, C.rules);
  console.log("\n1. WHY THE PAIR PASSES LESS (each at its own best settings from combos_2026.mjs)");
  const dayStats = (acct) => {
    const v = D26.map((d) => acct.day.get(d) || 0), g = v.filter((x) => x > 0), r = v.filter((x) => x < 0);
    return { green: g.length, red: r.length, flat: v.length - g.length - r.length, avgG: g.reduce((a, b) => a + b, 0) / Math.max(1, g.length),
             avgR: r.reduce((a, b) => a + b, 0) / Math.max(1, r.length), full: r.filter((x) => x <= -C.cap + 1e-6).length, best: Math.max(...v), tot: v.reduce((a, b) => a + b, 0) };
  };
  console.log("   " + "".padEnd(22) + "  pass  JanMar AprJul | days: green red none | avg green  avg red  full-limit days  best day  2026 total");
  for (const [lbl, a, s] of [["Donchian alone", dA, sD], ["MACD alone", mA, sM], ["Donchian + MACD", dm, sDM]]) {
    const st = dayStats(a);
    console.log("   " + lbl.padEnd(22) + f1(s.y) + f1(s.a, 7) + f1(s.b, 7) + " |" + String(st.green).padStart(12) + String(st.red).padStart(4) + String(st.flat).padStart(5) +
                " |" + f0(st.avgG, 10) + f0(st.avgR, 9) + String(st.full).padStart(17) + f0(st.best, 10) + f0(st.tot, 12));
  }
  {
    const xs = D26.map((d) => dA.day.get(d) || 0), ys = D26.map((d) => mA.day.get(d) || 0);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    console.log(`   correlation of the two strategies' day results: ${(sxy / Math.sqrt(sxx * syy)).toFixed(2)}`);
  }
  // day by day: what the pair did differently from the Donchian alone
  const cats = new Map();
  const add = (k, delta) => { const c = cats.get(k) || { n: 0, sum: 0, worse: 0, better: 0 }; c.n++; c.sum += delta; if (delta < 0) c.worse++; if (delta > 0) c.better++; cats.set(k, c); };
  for (const d of D26) {
    const a = dA.day.get(d) || 0, b = dm.day.get(d) || 0;
    const lg = (dm.logs.get(d) || []).filter((x) => x.pnl !== undefined);
    const dDid = (dA.logs.get(d) || []).some((x) => x.pnl !== undefined);
    if (Math.abs(a - b) < 1e-6) { add("unchanged", 0); continue; }
    const first = lg[0];
    const pairD = lg.some((x) => x.id === "Donchian");
    let k;
    if (!dDid) k = "MACD traded on a day the Donchian did not";
    else if (first && first.id === "MACD" && !pairD) k = first.pnl > 0 ? "MACD won first -> the day ended before the Donchian" : "MACD lost first -> the day ended before the Donchian";
    else if (first && first.id === "MACD") k = "MACD first, then the Donchian (a different day)";
    else k = "Donchian first, then the MACD changed the day";
    add(k, b - a);
  }
  console.log("\n   days where the pair's result differs from the Donchian alone's   (delta = pair - Donchian alone)");
  for (const [k, c] of [...cats.entries()].sort((x, y) => x[1].sum - y[1].sum))
    console.log("   " + k.padEnd(58) + String(c.n).padStart(4) + " days   total " + f0(c.sum, 7) + "   worse on " + c.worse + ", better on " + c.better);

  // ---- 2. the search -------------------------------------------------------------------------
  const G = C.G;
  const res = [];
  for (const dl of G.dLots) for (const ml of G.mLots) {
    const trades = [...dT(dl), ...mT(ml)];
    for (const mMax of G.mMax) for (const mBrk of G.mBrk) for (const pb of G.pb) for (const mPb of G.mPb) for (const brk of G.brk)
      for (const mUntil of G.mUntil) for (const dFrom of G.dFrom) {
        if (mPb && mPb >= pb) continue;                      // the shared block would end the day first anyway
        const cfg = { dl, ml, mMax, mBrk, pb, mPb, brk, mUntil, dFrom };
        const per = { MACD: { maxLoss: mMax, brk: mBrk ? 1 : 0, pb: mPb, until: mUntil }, Donchian: { from: dFrom } };
        const r = score(account(trades, { cap: C.cap, brk, pb, per }), C.rules);
        res.push({ cfg, r });
      }
  }
  const txt = (c) => `D ${c.dl} lots${c.dFrom > 510 ? " from " + hm(c.dFrom) : ""} + M ${c.ml} lots${c.mUntil < 895 ? " until " + hm(c.mUntil) : ""}` +
                     `${c.mMax ? ", M max loss $" + c.mMax : ""}${c.mBrk ? ", M stops after its loss" : ""}${c.mPb ? ", M stops at +$" + c.mPb : ""}` +
                     `, ${c.brk ? "breaker -$" + c.brk : "no breaker"}, block +$${c.pb}`;
  res.sort((x, y) => y.r.y - x.r.y);
  // the Donchian alone, searched the same way, for a fair comparison
  const dRes = [];
  for (const lots of C.dGrid.lots) for (const brk of C.dGrid.brk) for (const pb of C.dGrid.pb) dRes.push({ lots, brk, pb, r: score(account(dT(lots), { cap: C.cap, brk, pb }), C.rules) });
  dRes.sort((x, y) => y.r.y - x.r.y);
  console.log(`\n2. SEARCH: ${res.length.toLocaleString()} ways to run the pair (2026 / Jan-Mar / Apr-Jul, real windows, trades a day)`);
  console.log(`   Donchian alone, best of ${dRes.length}: ${f1(dRes[0].r.y)} (${dRes[0].r.a.toFixed(1)} / ${dRes[0].r.b.toFixed(1)})  real ${dRes[0].r.real.toFixed(1)}  -- ${dRes[0].lots} lots, ${dRes[0].brk ? "-$" + dRes[0].brk : "no breaker"} / +$${dRes[0].pb}`);
  console.log("   the pair's top 12:");
  for (const x of res.slice(0, 12)) console.log("   " + f1(x.r.y) + f1(x.r.a, 7) + f1(x.r.b, 7) + f1(x.r.real) + f2(x.r.perDay, 6) + "   " + txt(x.cfg));
  const beat = res.filter((x) => x.r.y > dRes[0].r.y).length;
  console.log(`   ${beat} of ${res.length.toLocaleString()} pair settings beat the best Donchian alone on 2026 as a whole`);
  // what the top settings have in common
  const top = res.slice(0, 50);
  for (const key of ["dl", "ml", "mMax", "mBrk", "mPb", "pb", "brk", "mUntil", "dFrom"]) {
    const cnt = new Map();
    for (const x of top) cnt.set(x.cfg[key], (cnt.get(x.cfg[key]) || 0) + 1);
    console.log("     top 50, " + key.padEnd(7) + [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => (key === "mUntil" || key === "dFrom" ? hm(v) : v) + ": " + n).join("   "));
  }

  // ---- 3. validation ---------------------------------------------------------------------------
  console.log("\n3. VALIDATION");
  for (const [fit, test, fl, tl] of [["a", "b", "Jan-Mar", "Apr-Jul"], ["b", "a", "Apr-Jul", "Jan-Mar"]]) {
    const pTop = res.slice().sort((x, y) => y.r[fit] - x.r[fit])[0];
    const dTop = dRes.slice().sort((x, y) => y.r[fit] - x.r[fit])[0];
    console.log(`   picked on ${fl}:  pair -> ${pTop.r[test].toFixed(1)}% on ${tl}   (${txt(pTop.cfg)})`);
    console.log(`   ${"".padEnd(18)}Donchian alone -> ${dTop.r[test].toFixed(1)}% on ${tl}   (${dTop.lots} lots, ${dTop.brk ? "-$" + dTop.brk : "no breaker"} / +$${dTop.pb})`);
  }
  // neighbours of the best pair setting: every single-parameter step
  const best = res[0];
  const key = (c) => JSON.stringify(c);
  const byCfg = new Map(res.map((x) => [key(x.cfg), x.r]));
  const nb = [];
  for (const p of Object.keys(G)) {
    const name = { dLots: "dl", mLots: "ml", mMax: "mMax", mBrk: "mBrk", pb: "pb", mPb: "mPb", brk: "brk", mUntil: "mUntil", dFrom: "dFrom" }[p];
    const vals = G[p], i = vals.indexOf(best.cfg[name]);
    for (const j of [i - 1, i + 1]) if (j >= 0 && j < vals.length) {
      const r = byCfg.get(key({ ...best.cfg, [name]: vals[j] }));
      if (r) nb.push({ lbl: name + " " + vals[j], y: r.y });
    }
  }
  console.log(`   the best pair setting's neighbours (one setting moved one step): ${nb.map((x) => x.lbl + " " + x.y.toFixed(1)).join(",  ")}`);
  console.log(`     -> ${nb.filter((x) => x.y > dRes[0].r.y).length} of ${nb.length} still beat the best Donchian alone (${dRes[0].r.y.toFixed(1)})`);
  // stress: the best pair vs the best Donchian alone
  const runPair = (o, model = "A") => {
    const c = best.cfg;
    const per = { MACD: { maxLoss: c.mMax, brk: c.mBrk ? 1 : 0, pb: c.mPb, until: c.mUntil }, Donchian: { from: c.dFrom } };
    return score(account([...dT(c.dl, o), ...mT(c.ml, o)], { cap: C.cap, brk: c.brk, pb: c.pb, per, model }), C.rules);
  };
  const runD = (o) => score(account(dT(dRes[0].lots, o), { cap: C.cap, brk: dRes[0].brk, pb: dRes[0].pb }), C.rules);
  console.log("   stress:                          the best pair                 the best Donchian alone");
  for (const [lbl, o, model] of [["as tested", {}, "A"], ["2 ticks slippage", { slip: 2 }, "A"], ["one bar later", { late: true }, "A"], ["one position at a time", {}, "B"]]) {
    const p = runPair(o, model), d = model === "B" ? runD({}) : runD(o);
    console.log("     " + lbl.padEnd(26) + (f1(p.y) + " (" + p.a.toFixed(1) + " / " + p.b.toFixed(1) + ")").padEnd(30) + f1(d.y) + " (" + d.a.toFixed(1) + " / " + d.b.toFixed(1) + ")");
  }
  {
    const p = runPair({}), d = runD({});
    const mo = (arr) => { const m = new Array(7).fill(0); M.Y26.forEach((k) => { m[monthOf(S.days[k])] += arr[k]; }); return m.map((x) => Math.round(x)).join(" "); };
    console.log(`     every real 21-day window: pair ${p.real.toFixed(1)}%, Donchian alone ${d.real.toFixed(1)}%`);
    console.log(`     $ by month Jan..Jul   pair: ${mo(p.arr)}   Donchian alone: ${mo(d.arr)}`);
  }
  process.stderr.write(`  ${cname} done ${((Date.now() - T0) / 1000).toFixed(0)}s\n`);
}
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
