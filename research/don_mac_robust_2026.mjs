// Donchian + MACD in one account, part 3. Part 2 left two candidates: (1) simply
// running the two indicators side by side, each with its own rules (only the
// firm's daily limit is shared) -- the easiest way to trade both; and (2) an
// account-state rule that kept showing up: add the MACD only on days the
// account is below its high (in a drawdown). Both tested against the Donchian
// alone the same way as part 2 (cross-validation on 40 random halves, stress),
// and every candidate under different simulations: eval lengths (21 trading
// days, 42, no time limit), bootstrap blocks (1, 5, 10 days), other seeds, and
// every real start day of 2026 run to the end of the data. 2026 ONLY.
//
// RESULT (2026 only):
// $1,250: adding the MACD does not pay in any form. Side by side 68.0% vs the
// Donchian alone 71.1%; none of 216 side-by-side settings beat it;
// cross-validated 56.6% vs 67.9% (both searched) and 65.0% vs 70.9% (fixed
// settings; the pair ahead in 14 of 40 halves). Adding the MACD only when the
// account is more than $100 below its high: 76.5% in-sample, but picked on one
// half it reads 69.1% vs 70.9% on the other. No time limit: the Donchian alone
// is still best (74.9%).
// $3,000: the two indicators side by side, each at its own best (Donchian 7
// lots, late 4, -$500/+$400; MACD 6 lots, no breaker/+$300; $1,000 limit),
// pass 70.5% (64.5 / 83.1) vs 59.3% (49.6 / 70.8). 78 of 216 settings beat the
// Donchian alone, 70 on both halves; cross-validated 66.9% vs 60.0% (ahead in
// 26 of 40 halves), 58.9% vs 51.6% when both are searched; 2 ticks 70.7%; one
// position at a time 67.2%; ahead on every seed, block length and real
// window; without each one's best 5 days 64.1% vs 47.0%. It passes twice as
// fast (median 7 vs 14 trading days from each 2026 start) with the same
// failures (34 vs 33 of 139 starts), so with no time limit they are level
// (71.1% vs 70.0%). One bar late both collapse (42.4% vs 45.2%): the MACD has
// to be entered on its bar. The MACD must be big enough that one win reaches
// its +$300 block (6 lots: grid average 64.8% vs 48-50% at 3-4 lots). The
// drawdown rule (73.5%) cross-validates below simply running both (63.6% vs
// 66.9%).
//
//   node --max-old-space-size=8192 research/don_mac_robust_2026.mjs

import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import { donTrades, macTrades, account, sampler, realSampler, pass, passPolicy, vecOf } from "./lib_combo.mjs";

const T0 = Date.now();
const COMBINES = {
  "$1,250": { rules: { target: 1250, dd: 1000, consistency: 0.5 }, cap: 600,
              dAlone: { lots: 4, brk: 300, pb: 250 },
              plain: { dl: 4, ml: 4, brk: 300, pb: 250 },
              side: { dl: 4, dBrk: 300, dPb: 250, ml: 4, mBrk: 200, mPb: 250 },
              plateau: { dl: 4, ml: 3, mMax: 400, mBrk: 0, pb: 250, mPb: 150, brk: 300, mUntil: 540, dFrom: 510 },
              sideGrid: { dl: [3, 4, 5], dBrk: [0, 300, 400], dPb: [250, 350], ml: [2, 3, 4], mBrk: [0, 200], mPb: [150, 250] },
              plainGrid: { dl: [3, 4, 5], ml: [1, 2, 3, 4], pb: [250, 350, 450], brk: [0, 300] },
              dGrid: { lots: [3, 4, 5], brk: [0, 200, 300, 400], pb: [150, 200, 250, 350, 450] },
              behind: [50, 100, 200, 300, 400, 500] },
  "$3,000": { rules: { target: 3000, dd: 2000, consistency: 0.5 }, cap: 1000,
              dAlone: { lots: 7, brk: 500, pb: 400 },
              plain: { dl: 7, ml: 6, brk: 0, pb: 500 },
              side: { dl: 7, dBrk: 500, dPb: 400, ml: 6, mBrk: 0, mPb: 300 },
              plateau: { dl: 7, ml: 6, mMax: 0, mBrk: 0, pb: 500, mPb: 300, brk: 500, mUntil: 540, dFrom: 510 },
              sideGrid: { dl: [6, 7, 8], dBrk: [0, 500], dPb: [400, 500, 750], ml: [3, 4, 6], mBrk: [0, 300], mPb: [300, 500] },
              plainGrid: { dl: [5, 6, 7, 8], ml: [2, 3, 4, 6], pb: [400, 500, 750], brk: [0, 500] },
              dGrid: { lots: [5, 6, 7, 8, 9], brk: [0, 300, 500, 700], pb: [300, 400, 500, 750, 1000] },
              behind: [100, 200, 400, 600, 800, 1000] },
};
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const N = M.Y26.length;
const POS_A = Int32Array.from(M.Y26a.map((k) => M.Y26.indexOf(k))), POS_B = Int32Array.from(M.Y26b.map((k) => M.Y26.indexOf(k)));
const ALL = Int32Array.from({ length: N }, (_, i) => i);
const SM = { all: sampler(N), a: sampler(POS_A.length), b: sampler(POS_B.length), real: realSampler(N) };
const monthOf = (q) => new Date(S.days[M.Y26[q]] * 86400000).getUTCMonth();
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const cart = (g) => Object.entries(g).reduce((acc, [k, vals]) => acc.flatMap((o) => vals.map((v) => ({ ...o, [k]: v }))), [{}]);

// a candidate = one day vector, or a policy choosing each morning between the Donchian alone
// (dV) and the pair (pV) from the account's state
const evalOn = (cand, sub, smp, R) => (cand.useP ? passPolicy(cand.dV, cand.pV, sub, smp, R, cand.useP) : pass(cand.v, sub, smp, R));
const full = (cand, R) => ({ y: evalOn(cand, ALL, SM.all, R), a: evalOn(cand, POS_A, SM.a, R), b: evalOn(cand, POS_B, SM.b, R), real: evalOn(cand, ALL, SM.real, R) });
const row = (r) => f1(r.y) + " (" + r.a.toFixed(1) + " / " + r.b.toFixed(1) + ")  real " + r.real.toFixed(1);
// every 2026 start day, run to the end of the data: passed / failed / still open
function toEnd(cand, { target, dd, consistency: cons }) {
  let ps = 0, fl = 0;
  const took = [];
  for (let q = 0; q < N; q++) {
    let c = 0, pk = 0, lk = false, md = -1e18;
    for (let k = q; k < N; k++) {
      const v = cand.useP ? (cand.useP(c, pk, c - (lk ? 0 : pk - dd)) ? cand.pV[k] : cand.dV[k]) : cand.v[k];
      c += v; if (v > md) md = v;
      if (c <= (lk ? 0 : pk - dd)) { fl++; break; }
      if (c > pk) pk = c;
      if (!lk && pk >= dd) lk = true;
      if (c >= target && (cons <= 0 || md <= cons * c)) { ps++; took.push(k - q + 1); break; }
    }
  }
  took.sort((x, y) => x - y);
  return { ps, fl, open: N - ps - fl, med: took.length ? took[Math.floor(took.length / 2)] : NaN };
}

for (const [cname, C] of Object.entries(COMBINES)) {
  const R = C.rules;
  console.log("\n" + "=".repeat(124) + `\n${cname} COMBINE: target $${R.target}, trailing $${R.dd}, daily limit $${C.cap}, 50% consistency -- 2026\n` + "=".repeat(124));
  const cache = new Map();
  const dT = (lots, o = {}) => { const k = "D" + lots + JSON.stringify(o); if (!cache.has(k)) cache.set(k, donTrades(C.cap, lots, false, o)); return cache.get(k); };
  const mT = (lots, o = {}) => { const k = "M" + lots + JSON.stringify(o); if (!cache.has(k)) cache.set(k, macTrades(C.cap, lots, false, o)); return cache.get(k); };
  const dAcct = (c, o = {}) => account(dT(c.lots, o), { cap: C.cap, brk: c.brk, pb: c.pb });
  const plainAcct = (c, o = {}, model = "A") => account([...dT(c.dl, o), ...mT(c.ml, o)], { cap: C.cap, brk: c.brk, pb: c.pb, model });
  const sideAcct = (c, o = {}, model = "A") => account([...dT(c.dl, o), ...mT(c.ml, o)], { cap: C.cap, model,
                                                       per: { Donchian: { brk: c.dBrk, pb: c.dPb, own: true }, MACD: { brk: c.mBrk, pb: c.mPb, own: true } } });
  const platAcct = (c, o = {}, model = "A") => account([...dT(c.dl, o), ...mT(c.ml, o)], { cap: C.cap, brk: c.brk, pb: c.pb, model,
                                                       per: { MACD: { maxLoss: c.mMax, brk: c.mBrk ? 1 : 0, pb: c.mPb, until: c.mUntil }, Donchian: { from: c.dFrom } } });
  const sideTxt = (c) => `D ${c.dl} lots ${c.dBrk ? "-$" + c.dBrk : "no breaker"}/+$${c.dPb},  M ${c.ml} lots ${c.mBrk ? "-$" + c.mBrk : "no breaker"}/+$${c.mPb}`;
  const dRef = { v: vecOf(dAcct(C.dAlone)) }, dRefR = full(dRef, R);

  // ---- 1. side by side ----------------------------------------------------------------------------
  console.log(`\n1. THE TWO INDICATORS SIDE BY SIDE, EACH WITH ITS OWN RULES (only the $${C.cap} daily limit shared)`);
  const sideCfgs = cart(C.sideGrid), sideV = sideCfgs.map((c) => vecOf(sideAcct(c)));
  const sideY = sideV.map((v) => pass(v, ALL, SM.all, R)), sideA = sideV.map((v) => pass(v, POS_A, SM.a, R)), sideB = sideV.map((v) => pass(v, POS_B, SM.b, R));
  const di = sideCfgs.findIndex((c) => Object.keys(C.side).every((k) => c[k] === C.side[k]));
  console.log(`   Donchian alone (${C.dAlone.lots} lots, -$${C.dAlone.brk} / +$${C.dAlone.pb})`.padEnd(64) + row(dRefR));
  console.log(`   each indicator at its own best (${sideTxt(C.side)})`.padEnd(64) + row(full({ v: sideV[di] }, R)));
  const order = sideY.map((_, i) => i).sort((x, y) => sideY[y] - sideY[x]);
  console.log("   the grid's best 6:");
  for (const i of order.slice(0, 6)) console.log("     " + sideTxt(sideCfgs[i]).padEnd(59) + row(full({ v: sideV[i] }, R)));
  const both = sideCfgs.filter((_, i) => sideA[i] > dRefR.a && sideB[i] > dRefR.b).length;
  console.log(`   ${sideY.filter((y) => y > dRefR.y).length} of ${sideCfgs.length} side-by-side settings beat the Donchian alone on 2026; ${both} beat it on BOTH halves`);
  // which way do the settings push it?
  for (const k of Object.keys(C.sideGrid)) {
    const parts = C.sideGrid[k].map((v) => { const ys = sideY.filter((_, i) => sideCfgs[i][k] === v); return `${v}: ${mean(ys).toFixed(1)}`; });
    console.log(`     average over the grid by ${k.padEnd(5)} ${parts.join("   ")}`);
  }

  // ---- 2. cross-validation -------------------------------------------------------------------------
  const dCfgs = cart(C.dGrid), dV = dCfgs.map((c) => vecOf(dAcct(c)));
  const plainCfgs = cart(C.plainGrid), plainV = plainCfgs.map((c) => vecOf(plainAcct(c)));
  const SPLITS = 40, chunks = [];
  for (let s = 0; s < N; s += 5) chunks.push(Array.from({ length: Math.min(5, N - s) }, (_, j) => s + j));
  const splits = [];
  for (let s = 0; s < SPLITS; s++) {
    const rnd = S.mul(9000 + s), ord = chunks.map((_, i) => i);
    for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ord[i], ord[j]] = [ord[j], ord[i]]; }
    const half = Math.floor(ord.length / 2);
    const fit = Int32Array.from(ord.slice(0, half).flatMap((i) => chunks[i]).sort((x, y) => x - y));
    const test = Int32Array.from(ord.slice(half).flatMap((i) => chunks[i]).sort((x, y) => x - y));
    splits.push({ fit, test, fS: sampler(fit.length, { draws: 2000, seed: 777 }), tS: sampler(test.length) });
  }
  const pickRead = (vs) => splits.map((sp) => { let b = -1, bi = 0; vs.forEach((v, i) => { const y = pass(v, sp.fit, sp.fS, R); if (y > b) { b = y; bi = i; } }); return pass(vs[bi], sp.test, sp.tS, R); });
  const fixedRead = (cand) => splits.map((sp) => evalOn(cand, sp.test, sp.tS, R));
  const cvD = pickRead(dV), cvPlain = pickRead(plainV), cvSide = pickRead(sideV), fxD = fixedRead(dRef), fxSide = fixedRead({ v: sideV[di] });
  const beats = (a, b) => a.filter((x, i) => x > b[i] + 1e-9).length;
  console.log(`\n2. CROSS-VALIDATION: ${SPLITS} random halves -- each search rerun on one half, its pick read on the unseen half`);
  console.log(`   Donchian alone, best of ${dCfgs.length}`.padEnd(56) + `${mean(cvD).toFixed(1)}%`);
  console.log(`   both, day rules on the account, best of ${plainCfgs.length}`.padEnd(56) + `${mean(cvPlain).toFixed(1)}%   beat the Donchian alone in ${beats(cvPlain, cvD)} of ${SPLITS}`);
  console.log(`   both side by side, best of ${sideCfgs.length}`.padEnd(56) + `${mean(cvSide).toFixed(1)}%   beat the Donchian alone in ${beats(cvSide, cvD)} of ${SPLITS}`);
  console.log(`   no search -- fixed settings, read on the same unseen halves:`);
  console.log(`     Donchian alone (${C.dAlone.lots} lots, -$${C.dAlone.brk} / +$${C.dAlone.pb})`.padEnd(56) + `${mean(fxD).toFixed(1)}%`);
  console.log(`     side by side, each at its own best`.padEnd(56) + `${mean(fxSide).toFixed(1)}%   beat the Donchian alone in ${beats(fxSide, fxD)} of ${SPLITS}`);

  // ---- 3. the MACD only while the account is below its high ------------------------------------------
  console.log(`\n3. ADD THE MACD ONLY ON DAYS THE ACCOUNT IS MORE THAN $X BELOW ITS HIGH (otherwise the Donchian alone)`);
  const pairs = { "side by side": { v: sideV[di] }, "day rules on the account": { v: vecOf(plainAcct(C.plain)) } };
  const rules = [["never (the Donchian alone)", () => false], ["always", () => true], ...C.behind.map((x) => [`more than $${x} below its high`, (c, pk) => pk - c > x + 1e-9])];
  console.log("   " + "".padEnd(34) + Object.keys(pairs).map((k) => ("with the pair " + k).padEnd(44)).join(""));
  for (const [lbl, useP] of rules) console.log("   " + lbl.padEnd(34) + Object.values(pairs).map((p) => row(full({ dV: dRef.v, pV: p.v, useP }, R)).padEnd(44)).join(""));
  for (const [pn, p] of Object.entries(pairs)) {
    const cands = rules.map(([, useP]) => ({ dV: dRef.v, pV: p.v, useP }));
    const cv = splits.map((sp) => { let b = -1, bi = 0; cands.forEach((cd, i) => { const y = evalOn(cd, sp.fit, sp.fS, R); if (y > b) { b = y; bi = i; } }); return { y: evalOn(cands[bi], sp.test, sp.tS, R), bi }; });
    const cnt = new Map(); for (const x of cv) cnt.set(x.bi, (cnt.get(x.bi) || 0) + 1);
    console.log(`   cross-validated, pair ${pn}: the rule picked on one half reads ${mean(cv.map((x) => x.y)).toFixed(1)}% on the unseen half vs ${mean(fxD).toFixed(1)}% for the Donchian alone;` +
                ` beats it in ${beats(cv.map((x) => x.y), fxD)} of ${SPLITS}  (picked: ${[...cnt.entries()].sort((a, b) => b[1] - a[1]).map(([i, n]) => rules[i][0].replace(" below its high", "").replace("more than ", ">") + " x" + n).join(", ")})`);
  }

  // ---- 4 + 5. stress and different simulations ------------------------------------------------------------
  const X = C.behind[1];
  const candsFor = (o, model) => {
    const d = { v: vecOf(dAcct(C.dAlone, o)) };
    const side = { v: vecOf(sideAcct(C.side, o, model)) };
    return [
      ["Donchian alone", d],
      ["both, day rules on the account", { v: vecOf(plainAcct(C.plain, o, model)) }],
      ["both side by side, own rules", side],
      [`side by side, MACD only >$${X} below the high`, { dV: d.v, pV: side.v, useP: (c, pk) => pk - c > X + 1e-9 }],
      ["part 2's plateau pair", { v: vecOf(platAcct(C.plateau, o, model)) }],
    ];
  };
  const base = candsFor({}, "A");
  console.log(`\n4. STRESS   (2026 (Jan-Mar / Apr-Jul), real 21-day windows)`);
  console.log("   " + "".padEnd(42) + ["as tested", "2 ticks slippage", "one bar later", "one position at a time"].map((s) => s.padEnd(34)).join(""));
  const stress = [[{}, "A"], [{ slip: 2 }, "A"], [{ late: true }, "A"], [{}, "B"]].map(([o, m]) => candsFor(o, m));
  for (let i = 0; i < base.length; i++) console.log("   " + base[i][0].padEnd(42) + stress.map((cs) => row(full(cs[i][1], R)).padEnd(34)).join(""));

  console.log(`\n5. DIFFERENT SIMULATIONS (as tested; pass rate %)`);
  const sims = [
    ["21 days (standard)", sampler(N)],
    ["seed 1", sampler(N, { seed: 1 })], ["seed 2", sampler(N, { seed: 2 })], ["seed 3", sampler(N, { seed: 3 })],
    ["1-day blocks", sampler(N, { block: 1 })], ["10-day blocks", sampler(N, { block: 10 })],
    ["42 days", sampler(N, { window: 42 })], ["no time limit", sampler(N, { window: 300 })],
    ["real 21-day", realSampler(N, 21)], ["real 42-day", realSampler(N, 42)],
  ];
  console.log("   " + "".padEnd(42) + sims.map(([l]) => l.padStart(11)).join("") + "   every start day to the end of the data");
  for (const [lbl, cd] of base) {
    const e = toEnd(cd, R);
    console.log("   " + lbl.padEnd(42) + sims.map(([, sm]) => f1(evalOn(cd, ALL, sm, R), 11)).join("") + `   passed ${e.ps} (median ${e.med} days), failed ${e.fl}, open ${e.open}`);
  }
  {
    const mo = (v) => { const m = new Array(7).fill(0); v.forEach((x, q) => { m[monthOf(q)] += x; }); return m.map((x) => Math.round(x)).join(" "); };
    console.log(`\n   $ by month Jan..Jul   Donchian alone: ${mo(base[0][1].v)}   side by side: ${mo(base[2][1].v)}`);
    for (const drop of [3, 5]) {
      const r = base.filter(([, cd]) => cd.v).map(([lbl, cd]) => {
        const top = Array.from(cd.v.keys()).sort((a, b) => cd.v[b] - cd.v[a]).slice(0, drop), keep = Int32Array.from(ALL.filter((q) => !top.includes(q)));
        return `${lbl} ${pass(cd.v, keep, sampler(keep.length), R).toFixed(1)}`;
      });
      console.log(`   without each one's best ${drop} days: ${r.join(",  ")}`);
    }
  }
  process.stderr.write(`  ${cname} done ${((Date.now() - T0) / 1000).toFixed(0)}s\n`);
}
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
