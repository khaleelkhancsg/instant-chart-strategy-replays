// Donchian + MACD in one account, part 2: is any way of running them together
// really better than the Donchian alone, and do they work together in
// practice? 2026 ONLY. Same replay, grids and costs as don_mac_together_2026.mjs.
//
//   1. as the two indicators would actually run side by side: each applies its
//      own breaker / profit block to its own trades, only the firm's daily
//      limit is shared -- vs the trader enforcing the day rules on the account
//   2. do they get in each other's way: when each trades, overlapping
//      positions, opposite positions (one account nets them)
//   3. lot ratios: Donchian lots x MACD lots
//   4. cross-validation: 40 random halves of 2026 (5-day chunks); the whole
//      search is rerun on one half and the pick read on the other, for the
//      pair, the Donchian alone, and "add the MACD only if it wins the fit"
//   5. a plateau pick (best average with every one-step neighbour) instead of
//      the single best, under stress
//   6. using the MACD only while the account has room above its trailing floor
//
// RESULT (2026 only):
// Side by side (each indicator's own rules and own daily-limit stop, the
// firm's limit on the account): $1,250 68.0% vs the Donchian alone 71.1%;
// $3,000 70.5% (64.5 / 83.1) vs 59.3% (49.6 / 70.8) -- see part 3.
// Full-limit days in 2026 / back-to-back days losing 90%+ of the drawdown:
// $1,250 Donchian alone 17 / 3, pair (account rules) 38 / 15, side by side 38 / 15;
// $3,000 21 / 4, 41 / 13, 37 / 10.
// Together: they almost never hold opposite positions (once in 2026; the MACD
// only fades WEAK crosses, i.e. it buys pullbacks in the MACD line's
// direction, and the Donchian breaks out with the 10-min trend), overlap 12-17
// times in the same direction, and two-thirds to three-quarters of the MACD's
// trades come in the first 30 minutes.
// Lot ratios: the MACD's size works through its profit block, not its risk.
// Plain pair on $1,250: M 4 lots 65.5-67.8%, M 2 lots 39-43%; on $3,000: M 6
// lots 59.5-61.5%, M 3-4 lots 32-39%. A smaller MACD is WORSE: one win no
// longer completes its day, so it keeps trading and gives it back.
// Cross-validation, the 13,824-setting search on one half, read on the other:
// $1,250 48.6% vs the Donchian alone 67.9% (ahead in 6 of 40 splits);
// $3,000 44.4% vs 51.6% (18 of 40). The search's peaks are overfit.
// Plateau picks: $1,250 D 4 + M 3 until 09:00, M max loss $400, M stops at
// +$150, -$300/+$250: 74.0% but one bar late 49.5% (Donchian 61.9%); $3,000 D 7
// + M 6 until 09:00, M stops at +$300, -$500/+$500: 69.6%, worst neighbour 36.4%.
// Account-state rules: the pair only while the account is below its high
// looked best (part 3 tests it properly).
//
//   node --max-old-space-size=8192 research/don_mac_validate_2026.mjs

import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import { donTrades, macTrades, account, score, sampler, realSampler, pass, passPolicy, vecOf } from "./lib_combo.mjs";

const T0 = Date.now();
const COMBINES = {
  "$1,250": { rules: { target: 1250, dd: 1000, consistency: 0.5 }, cap: 600,
              dAlone: { lots: 4, brk: 300, pb: 250 }, pair: { brk: 300, pb: 250 },
              side: { D: { lots: 4, brk: 300, pb: 250 }, M: { lots: 4, brk: 200, pb: 250 } },
              G: { dLots: [3, 4, 5], mLots: [1, 2, 3, 4], mMax: [0, 150, 250, 400], mBrk: [0, 1], pb: [250, 350, 450], mPb: [0, 150, 250],
                   brk: [0, 300], mUntil: [540, 600, 895], dFrom: [510, 540, 600] },
              dGrid: { lots: [3, 4, 5], brk: [0, 200, 300, 400], pb: [150, 200, 250, 350, 450] } },
  "$3,000": { rules: { target: 3000, dd: 2000, consistency: 0.5 }, cap: 1000,
              dAlone: { lots: 7, brk: 500, pb: 400 }, pair: { brk: 0, pb: 500 },
              side: { D: { lots: 7, brk: 500, pb: 400 }, M: { lots: 6, brk: 0, pb: 300 } },
              G: { dLots: [5, 6, 7, 8], mLots: [2, 3, 4, 6], mMax: [0, 250, 400, 600], mBrk: [0, 1], pb: [400, 500, 750], mPb: [0, 300],
                   brk: [0, 500], mUntil: [540, 600, 895], dFrom: [510, 540, 600] },
              dGrid: { lots: [5, 6, 7, 8, 9], brk: [0, 300, 500, 700], pb: [300, 400, 500, 750, 1000] } },
};
const KEYS = ["dl", "ml", "mMax", "mBrk", "pb", "mPb", "brk", "mUntil", "dFrom"];
const GK = { dl: "dLots", ml: "mLots", mMax: "mMax", mBrk: "mBrk", pb: "pb", mPb: "mPb", brk: "brk", mUntil: "mUntil", dFrom: "dFrom" };
const f0 = (x, w = 6) => (Number.isFinite(x) ? Math.round(x).toString() : "-").padStart(w);
const f1 = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(w);
const hm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const N = M.Y26.length;
const POS_A = Int32Array.from(M.Y26a.map((k) => M.Y26.indexOf(k))), POS_B = Int32Array.from(M.Y26b.map((k) => M.Y26.indexOf(k)));
const ALL = Int32Array.from({ length: N }, (_, i) => i);
const monthOf = (k) => new Date(S.days[k] * 86400000).getUTCMonth();

const IDX_ALL = sampler(N), IDX_A = sampler(POS_A.length), IDX_B = sampler(POS_B.length), realIdx = realSampler(N);
const full = (vec, R) => ({ y: pass(vec, ALL, IDX_ALL, R), a: pass(vec, POS_A, IDX_A, R), b: pass(vec, POS_B, IDX_B, R), real: pass(vec, ALL, realIdx, R) });
const row = (r) => f1(r.y) + " (" + r.a.toFixed(1) + " / " + r.b.toFixed(1) + ")  real " + r.real.toFixed(1);

for (const [cname, C] of Object.entries(COMBINES)) {
  const R = C.rules;
  console.log("\n" + "=".repeat(124) + `\n${cname} COMBINE: target $${R.target}, trailing $${R.dd}, daily limit $${C.cap}, 50% consistency -- 2026\n` + "=".repeat(124));
  const dCache = new Map(), mCache = new Map();
  const dT = (lots, o = {}) => { const k = lots + JSON.stringify(o); if (!dCache.has(k)) dCache.set(k, donTrades(C.cap, lots, false, o)); return dCache.get(k); };
  const mT = (lots, o = {}) => { const k = lots + JSON.stringify(o); if (!mCache.has(k)) mCache.set(k, macTrades(C.cap, lots, false, o)); return mCache.get(k); };
  const perOf = (c) => ({ MACD: { maxLoss: c.mMax, brk: c.mBrk ? 1 : 0, pb: c.mPb, until: c.mUntil }, Donchian: { from: c.dFrom } });
  const runCfg = (c, o = {}, model = "A", log = false) => account([...dT(c.dl, o), ...mT(c.ml, o)], { cap: C.cap, brk: c.brk, pb: c.pb, per: perOf(c), model, log });
  const txt = (c) => `D ${c.dl} lots${c.dFrom > 510 ? " from " + hm(c.dFrom) : ""} + M ${c.ml} lots${c.mUntil < 895 ? " until " + hm(c.mUntil) : ""}` +
                     `${c.mMax ? ", M max loss $" + c.mMax : ""}${c.mBrk ? ", M stops after its loss" : ""}${c.mPb ? ", M stops at +$" + c.mPb : ""}` +
                     `, ${c.brk ? "breaker -$" + c.brk : "no breaker"}, block +$${c.pb}`;

  // check: the fast pass rate = score()
  {
    const a = account(dT(C.dAlone.lots), { cap: C.cap, brk: C.dAlone.brk, pb: C.dAlone.pb }), s = score(a, R), f = full(vecOf(a), R);
    if ([s.y - f.y, s.a - f.a, s.b - f.b, s.real - f.real].some((x) => Math.abs(x) > 1e-9)) throw new Error("fast pass rate != score()");
  }
  const dAloneAcct = account(dT(C.dAlone.lots), { cap: C.cap, brk: C.dAlone.brk, pb: C.dAlone.pb, log: true });
  const dAloneV = vecOf(dAloneAcct), dAloneR = full(dAloneV, R);

  // ---- 1. side by side, as the indicators would run -------------------------------------------
  console.log("\n1. THE TWO INDICATORS SIDE BY SIDE IN ONE ACCOUNT");
  const nat = account([...dT(C.side.D.lots), ...mT(C.side.M.lots)], { cap: C.cap, brk: C.pair.brk, pb: C.pair.pb, log: true });
  const side = account([...dT(C.side.D.lots), ...mT(C.side.M.lots)], { cap: C.cap, log: true,
                       per: { Donchian: { brk: C.side.D.brk, pb: C.side.D.pb, own: true }, MACD: { brk: C.side.M.brk, pb: C.side.M.pb, own: true } } });
  const sideR = full(vecOf(side), R), natR = full(vecOf(nat), R);
  console.log(`   Donchian alone (${C.dAlone.lots} lots, -$${C.dAlone.brk} / +$${C.dAlone.pb})`.padEnd(78) + row(dAloneR));
  console.log(`   both, the day rules on the ACCOUNT (${C.pair.brk ? "-$" + C.pair.brk : "no breaker"} / +$${C.pair.pb} on the combined P&L)`.padEnd(78) + row(natR));
  console.log(`   both, each indicator's OWN rules (D -$${C.side.D.brk}/+$${C.side.D.pb}, M ${C.side.M.brk ? "-$" + C.side.M.brk : "none"}/+$${C.side.M.pb}; only the $${C.cap} limit shared)`.padEnd(78) + row(sideR));
  {
    const st = (a) => { const v = vecOf(a); let worst = 0, n2 = 0; for (const x of v) { if (x <= -C.cap + 1e-6) worst++; } for (let i = 1; i < v.length; i++) if (v[i] + v[i - 1] <= -R.dd * 0.9) n2++; return { worst, n2, tot: v.reduce((s, x) => s + x, 0) }; };
    for (const [lbl, a] of [["Donchian alone", dAloneAcct], ["account rules", nat], ["own rules", side]]) {
      const s = st(a);
      console.log(`     ${lbl.padEnd(16)} days at the full $${C.cap} limit: ${String(s.worst).padStart(3)}   back-to-back days losing 90%+ of the drawdown: ${String(s.n2).padStart(2)}   2026 total ${f0(s.tot, 7)}`);
    }
  }

  // ---- 2. do they get in each other's way? ------------------------------------------------------
  console.log("\n2. DO THEY GET IN EACH OTHER'S WAY?");
  const togetherness = (lbl, a) => {
    let ov = 0, opp = 0, same = 0, nD = 0, nM = 0;
    const bucket = { MACD: [0, 0, 0, 0], Donchian: [0, 0, 0, 0] }, edges = [540, 600, 720];
    for (const lg of a.logs.values()) {
      const tk = lg.filter((x) => x.pnl !== undefined);
      for (const t of tk) { if (t.id === "MACD") nM++; else nD++; let b = 0; while (b < 3 && t.ct0 >= edges[b]) b++; bucket[t.id][b]++; }
      for (let i = 0; i < tk.length; i++) for (let j = i + 1; j < tk.length; j++) {
        const x = tk[i], y = tk[j];
        if (x.id === y.id || !(x.t0 < y.t1 && y.t0 < x.t1)) continue;
        ov++; if (x.dir === y.dir) same++; else opp++;
      }
    }
    console.log(`   ${lbl.padEnd(28)} trades: Donchian ${nD}, MACD ${nM};  positions open at the same time ${ov} times (${same} same way, ${opp} opposite ways)`);
    console.log(`   ${"".padEnd(28)} entries 08:30-09:00 / 09:00-10:00 / 10:00-12:00 / 12:00-15:00   Donchian ${bucket.Donchian.join(" / ")}   MACD ${bucket.MACD.join(" / ")}`);
  };
  togetherness("account rules", nat);
  togetherness("own rules", side);

  // ---- the whole grid: every pair setting's 2026 day results ------------------------------------
  const G = C.G, cfgs = [];
  for (const dl of G.dLots) for (const ml of G.mLots) for (const mMax of G.mMax) for (const mBrk of G.mBrk) for (const pb of G.pb) for (const mPb of G.mPb)
    for (const brk of G.brk) for (const mUntil of G.mUntil) for (const dFrom of G.dFrom) { if (mPb && mPb >= pb) continue; cfgs.push({ dl, ml, mMax, mBrk, pb, mPb, brk, mUntil, dFrom }); }
  const vecs = cfgs.map((c) => vecOf(runCfg(c)));
  const yAll = vecs.map((v) => pass(v, ALL, IDX_ALL, R));
  const dCfgs = [];
  for (const lots of C.dGrid.lots) for (const brk of C.dGrid.brk) for (const pb of C.dGrid.pb) dCfgs.push({ lots, brk, pb });
  const dVecs = dCfgs.map((c) => vecOf(account(dT(c.lots), { cap: C.cap, brk: c.brk, pb: c.pb })));
  const dY = dVecs.map((v) => pass(v, ALL, IDX_ALL, R));
  const dBest = dY.indexOf(Math.max(...dY));
  process.stderr.write(`  ${cname}: grid scored ${((Date.now() - T0) / 1000).toFixed(0)}s\n`);

  // ---- 3. lot ratios ------------------------------------------------------------------------------
  console.log("\n3. LOT RATIOS: pass rate by Donchian lots x MACD lots");
  console.log("   (a) the best of every other setting      (b) plain: the day rules on the account, no MACD limits or windows");
  console.log("   " + "".padEnd(10) + G.mLots.map((m) => ("M " + m).padStart(8)).join("") + "     |" + G.mLots.map((m) => ("M " + m).padStart(8)).join(""));
  for (const dl of G.dLots) {
    const a = G.mLots.map((ml) => Math.max(...cfgs.map((c, i) => (c.dl === dl && c.ml === ml ? yAll[i] : -1))));
    const b = G.mLots.map((ml) => { const i = cfgs.findIndex((c) => c.dl === dl && c.ml === ml && !c.mMax && !c.mBrk && !c.mPb && c.mUntil === 895 && c.dFrom === 510 && c.pb === C.pair.pb && c.brk === (C.pair.brk || 0)); return i >= 0 ? yAll[i] : NaN; });
    console.log("   " + ("D " + dl).padEnd(10) + a.map((x) => f1(x, 8)).join("") + "     |" + b.map((x) => f1(x, 8)).join(""));
  }
  console.log(`   Donchian alone, best of ${dCfgs.length}: ${dY[dBest].toFixed(1)}  (${dCfgs[dBest].lots} lots, ${dCfgs[dBest].brk ? "-$" + dCfgs[dBest].brk : "no breaker"} / +$${dCfgs[dBest].pb})`);

  // ---- 4. cross-validation ------------------------------------------------------------------------
  const SPLITS = 40, chunks = [];
  for (let s = 0; s < N; s += 5) chunks.push(Array.from({ length: Math.min(5, N - s) }, (_, j) => s + j));
  const cv = { pair: [], don: [], union: [], wins: 0, ties: 0, addM: 0 };
  for (let s = 0; s < SPLITS; s++) {
    const rnd = S.mul(9000 + s), ord = chunks.map((_, i) => i);
    for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ord[i], ord[j]] = [ord[j], ord[i]]; }
    const half = Math.floor(ord.length / 2);
    const fit = Int32Array.from(ord.slice(0, half).flatMap((i) => chunks[i]).sort((x, y) => x - y));
    const test = Int32Array.from(ord.slice(half).flatMap((i) => chunks[i]).sort((x, y) => x - y));
    const fIdx = sampler(fit.length, { draws: 2000, seed: 777 }), tIdx = sampler(test.length);
    let bp = -1, bpi = -1, bd = -1, bdi = -1;
    for (let i = 0; i < vecs.length; i++) { const y = pass(vecs[i], fit, fIdx, R); if (y > bp) { bp = y; bpi = i; } }
    for (let i = 0; i < dVecs.length; i++) { const y = pass(dVecs[i], fit, fIdx, R); if (y > bd) { bd = y; bdi = i; } }
    const tp = pass(vecs[bpi], test, tIdx, R), td = pass(dVecs[bdi], test, tIdx, R);
    cv.pair.push(tp); cv.don.push(td); cv.union.push(bp > bd ? tp : td);
    if (bp > bd) cv.addM++;
    if (tp > td + 1e-9) cv.wins++; else if (Math.abs(tp - td) <= 1e-9) cv.ties++;
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  console.log(`\n4. CROSS-VALIDATION: ${SPLITS} random halves of 2026 -- the search rerun on one half, its pick read on the other`);
  console.log(`   pair (best of ${cfgs.length.toLocaleString()} on the fit half)         unseen half: ${mean(cv.pair).toFixed(1)}%  (sd ${sd(cv.pair).toFixed(1)})`);
  console.log(`   Donchian alone (best of ${dCfgs.length})${"".padEnd(17)}unseen half: ${mean(cv.don).toFixed(1)}%  (sd ${sd(cv.don).toFixed(1)})`);
  console.log(`   add the MACD only if the pair wins the fit   unseen half: ${mean(cv.union).toFixed(1)}%   (the pair won the fit ${cv.addM} of ${SPLITS} times)`);
  console.log(`   the pair beat the Donchian alone on the unseen half in ${cv.wins} of ${SPLITS} splits${cv.ties ? " (" + cv.ties + " ties)" : ""}`);

  // ---- 5. plateau pick -------------------------------------------------------------------------------
  const ix = new Map(cfgs.map((c, i) => [KEYS.map((k) => c[k]).join(","), i]));
  const nbrs = (c) => {
    const out = [];
    for (const k of KEYS) { const vals = G[GK[k]], q = vals.indexOf(c[k]); for (const j of [q - 1, q + 1]) if (j >= 0 && j < vals.length) { const i = ix.get(KEYS.map((kk) => (kk === k ? vals[j] : c[kk])).join(",")); if (i !== undefined) out.push(i); } }
    return out;
  };
  const smooth = cfgs.map((c, i) => { const nb = nbrs(c); return { avg: (yAll[i] + nb.reduce((s, j) => s + yAll[j], 0)) / (1 + nb.length), min: Math.min(...nb.map((j) => yAll[j])), nb }; });
  const pi = smooth.map((s, i) => i).sort((a, b) => smooth[b].avg - smooth[a].avg)[0];
  const P = cfgs[pi];
  const dNb = (j) => { const c = dCfgs[j], out = []; for (const [k, vals] of Object.entries(C.dGrid)) { const q = vals.indexOf(c[k]); for (const t of [q - 1, q + 1]) if (t >= 0 && t < vals.length) { const o = dCfgs.findIndex((x) => Object.keys(C.dGrid).every((kk) => x[kk] === (kk === k ? vals[t] : c[kk]))); if (o >= 0) out.push(o); } } return out; };
  const dSm = dCfgs.map((c, j) => { const nb = dNb(j); return { avg: (dY[j] + nb.reduce((s, o) => s + dY[o], 0)) / (1 + nb.length), min: Math.min(...nb.map((o) => dY[o])) }; });
  const dpi = dSm.map((s, j) => j).sort((a, b) => dSm[b].avg - dSm[a].avg)[0], DP = dCfgs[dpi];
  console.log(`\n5. PLATEAU PICK: the setting whose own score AND its one-step neighbours' are best on average`);
  console.log(`   pair:           ${txt(P)}`);
  console.log(`                   itself ${yAll[pi].toFixed(1)}, neighbours' average ${smooth[pi].avg.toFixed(1)}, worst neighbour ${smooth[pi].min.toFixed(1)} (${smooth[pi].nb.length} neighbours)`);
  console.log(`   Donchian alone: ${DP.lots} lots, ${DP.brk ? "-$" + DP.brk : "no breaker"} / +$${DP.pb}  -- itself ${dY[dpi].toFixed(1)}, neighbours' average ${dSm[dpi].avg.toFixed(1)}, worst neighbour ${dSm[dpi].min.toFixed(1)}`);
  const pAcct = runCfg(P, {}, "A", true);
  const runDP = (o) => account(dT(DP.lots, o), { cap: C.cap, brk: DP.brk, pb: DP.pb });
  console.log("   " + "".padEnd(26) + "the plateau pair".padEnd(44) + "the plateau Donchian alone");
  for (const [lbl, o, model] of [["as tested", {}, "A"], ["2 ticks slippage", { slip: 2 }, "A"], ["one bar later", { late: true }, "A"], ["one position at a time", {}, "B"]]) {
    const p = full(vecOf(runCfg(P, o, model)), R), d = full(vecOf(runDP(model === "B" ? {} : o)), R);
    console.log("   " + lbl.padEnd(26) + row(p).padEnd(44) + row(d));
  }
  {
    const mo = (v) => { const m = new Array(7).fill(0); M.Y26.forEach((k, q) => { m[monthOf(k)] += v[q]; }); return m.map((x) => Math.round(x)).join(" "); };
    console.log(`   $ by month Jan..Jul:  pair ${mo(vecOf(pAcct))}   Donchian alone ${mo(vecOf(runDP({})))}`);
    const pv = vecOf(pAcct), dv = vecOf(runDP({}));
    const top = (v) => Array.from(v.keys()).sort((a, b) => v[b] - v[a]);
    for (const drop of [3, 5]) {
      const keepP = Int32Array.from(ALL.filter((q) => !top(pv).slice(0, drop).includes(q))), keepD = Int32Array.from(ALL.filter((q) => !top(dv).slice(0, drop).includes(q)));
      console.log(`   without each one's best ${drop} days: pair ${pass(pv, keepP, sampler(keepP.length), R).toFixed(1)}%, Donchian alone ${pass(dv, keepD, sampler(keepD.length), R).toFixed(1)}%`);
    }
  }
  togetherness("plateau pair", pAcct);

  // ---- 6. MACD only while there is room above the trailing floor -------------------------------
  console.log(`\n6. THE MACD ONLY SOME DAYS: each morning run the pair or the Donchian alone, by the account's state`);
  console.log("   " + "".padEnd(52) + "with the plain pair (b)".padEnd(34) + "with the plateau pair");
  const plainI = cfgs.findIndex((c) => c.dl === C.side.D.lots && c.ml === Math.min(C.side.M.lots, Math.max(...G.mLots)) && !c.mMax && !c.mBrk && !c.mPb && c.mUntil === 895 && c.dFrom === 510 && c.pb === C.pair.pb && c.brk === (C.pair.brk || 0));
  const plainV = plainI >= 0 ? vecs[plainI] : vecOf(nat), platV = vecs[pi];
  const pol = [["always the Donchian alone", () => false], ["always the pair", () => true]];
  for (const f of [0.5, 0.7, 0.9, 1.0]) pol.push([`the pair only with ${Math.round(f * R.dd)}+ above the floor`, (c, pk, room) => room >= f * R.dd - 1e-9]);
  for (const f of [0.5, 0.7, 0.9]) pol.push([`the pair only with LESS than ${Math.round(f * R.dd)} above the floor`, (c, pk, room) => room < f * R.dd - 1e-9]);
  for (const g of [0.2, 0.4, 0.6]) pol.push([`the pair only once up $${Math.round(g * R.target)}`, (c) => c >= g * R.target - 1e-9]);
  const polRow = (pV, useP) => { const r = { y: passPolicy(dAloneV, pV, ALL, IDX_ALL, R, useP), a: passPolicy(dAloneV, pV, POS_A, IDX_A, R, useP), b: passPolicy(dAloneV, pV, POS_B, IDX_B, R, useP), real: passPolicy(dAloneV, pV, ALL, realIdx, R, useP) }; return row(r); };
  for (const [lbl, useP] of pol) console.log("   " + lbl.padEnd(52) + polRow(plainV, useP).padEnd(34) + polRow(platV, useP));
  process.stderr.write(`  ${cname} done ${((Date.now() - T0) / 1000).toFixed(0)}s\n`);
}
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
