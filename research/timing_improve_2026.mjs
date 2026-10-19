// Entry-time limits for the two $1,250 setups -- with vs without. 2026 ONLY,
// honest fills, realistic costs, cancelOpposite.
//
// Where this came from: testing the level filters (levels_improve_2026.mjs)
// showed that ANY skipped entry hurts the MACD fade, because its money is made
// at the open: 08:30-09:00 CT entries averaged +$98 a trade in 2026, later ones
// about -$6, and the 3rd+ trade of a day -$52. That was found ON 2026, so the
// cutoff is tested with its neighbours, inside each half of 2026, by picking
// the cutoff on one half and reading it on the other, and under the usual
// stresses. Entries are gated through the sizer, so every signal still exits.
//
// RESULT (2026 only):
// MACD fade: no change. Every cutoff from 08:45 to 11:00 lands at 57-59%
// (none: 58.5%) -- the +$250 profit block already ends most days in the first
// half hour -- and a cutoff picked on one half does worse on the other than no
// cutoff (Apr-Jul's pick reads 35.3% on Jan-Mar vs 52.4%). "At most 2 entries
// a day" reads 62.5% but hurts with one bar of delay (52.7 -> 48.1) and at 5
// lots, and capping at 3 is worse than no cap (55.5%): noise.
// Donchian: no new breakouts after ~13:00 CT is the one change worth keeping
// an eye on. 61.3% -> 63.5% (every cutoff from 12:30 to 14:00: 62.4-64.4%),
// every real 21-day window 59.7 -> 63.0, and it helps under every stress here
// (+1.7 to +3.7: delay, costs, breaker tighter/looser/off, profit block +$350,
// 3 or 5 lots, no late-day size rule). But the gain is January-March (63.3 ->
// 71.7) -- really January (-$875 -> -$51) -- while April-July barely moves
// (63.0 -> 63.5) and April gets worse (+$248 -> -$471). The breakouts it
// drops, entered 13:00-15:00 CT, averaged -$19 a trade in 2026.
//
//   node --max-old-space-size=8192 research/timing_improve_2026.mjs

import { macd } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const T0 = Date.now();
const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const FILL = { slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: 600, profitBlock: 250, cancelOpposite: true };
const E2 = S.engineFor(2), E1 = S.engineFor(1);
const t1 = E1.tf, n1 = t1.close.length;
const hist = macd(t1.close, 12, 26, 9).hist;
const SIGA = new Int8Array(n1);
for (let i = 1; i < n1; i++) {
  if (!(t1.ctMin[i] >= 510 && t1.ctMin[i] < 900)) continue;
  SIGA[i] = -(hist[i] > 0 && hist[i - 1] <= 0 ? 1 : hist[i] < 0 && hist[i - 1] >= 0 ? -1 : 0);
}
const exit20 = (k, d, st) => k - st.entBar >= 20 && (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) < st.atr;
const SET = {
  A: { name: "MACD fade (1-min, 4 lots, -$200 / +$250)", E: E1, sig: SIGA, lots: () => 4,
       opts: { breaker: 200, trig: 0.15, tpFromFill: true, tpFn: (a, q) => Math.min(5.15 * a, 600 / (2 * q)) } },
  D: { name: "Donchian (2-min, 4/2 lots, -$300 / +$250)", E: E2, sig: M.RESC, lots: (k) => (M.adrUsed(k) >= 0.9 ? 2 : 4),
       opts: { exitFn: exit20, breaker: 300 } },
};
const pass = (arr, ix) => S.passArr(ix.map((k) => arr[k]), RULES);
// cutoff: no new entry on an arm bar at/after this CT minute; maxPer: entries per day
function run(c, { cutoff = 9999, maxPer = 99, sig = c.sig, extra = {} } = {}) {
  let day = -1, count = 0;
  const sizer = (a, ct, s, arm) => {
    const td = c.E.tf.tday[arm];
    if (td !== day) { day = td; count = 0; }
    if (ct >= cutoff || count >= maxPer) return 0;
    count++;
    return c.lots(arm - 1);
  };
  const tr = c.E.run(sizer, { signals: sig, ...FILL, ...c.opts, ...extra }).filter((t) => S.yearOf.get(t.tday) === 2026);
  const arr = S.dayArr(tr, S.days);
  const d = M.Y26.map((k) => arr[k]);
  let cp = 0, cn = 0;
  for (let s = 0; s + 21 <= d.length; s++) { cp += S.evWith(d.slice(s, s + 21), RULES); cn++; }
  const jack = (K) => { const best = M.Y26.map((k) => [k, arr[k]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, K);
    const a = Float64Array.from(arr); for (const [k] of best) a[k] = 0; return pass(a, M.Y26); };
  const mo = new Array(7).fill(0);
  for (const t of tr) mo[new Date(M.tf.ts[S.dayFirstBar.get(t.tday)] + 43200e3).getUTCMonth()] += t.pnl;
  return { n: tr.length, exp: tr.reduce((s, t) => s + t.pnl, 0) / Math.max(1, tr.length),
           win: (100 * tr.filter((t) => t.pnl > 0).length) / Math.max(1, tr.length),
           y: pass(arr, M.Y26), a: pass(arr, M.Y26a), b: pass(arr, M.Y26b), real: (100 * cp) / cn, j3: jack(3), j5: jack(5), mo };
}
const f1 = (x, w = 6) => x.toFixed(1).padStart(w);
const hm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const HD = "  " + "".padEnd(44) + "  2026 JanMar AprJul  real -3best -5best trades  win%   $/tr";
const line = (lbl, r) => "  " + lbl.padEnd(44) + f1(r.y) + f1(r.a, 7) + f1(r.b, 7) + f1(r.real) + f1(r.j3, 6) + f1(r.j5, 7) + String(r.n).padStart(7) + f1(r.win) + f1(r.exp, 7);
const shift1 = (s) => { const o = new Int8Array(s.length); for (let i = 1; i < s.length; i++) o[i] = s[i - 1]; return o; };

const CUTS = { A: [525, 540, 555, 570, 600, 660, 9999], D: [570, 600, 660, 690, 720, 750, 765, 780, 795, 810, 840, 870, 9999] };
for (const [id, c] of Object.entries(SET)) {
  console.log("\n" + "=".repeat(112) + "\n" + c.name + "\n" + "=".repeat(112));
  console.log("\n  no new entries after ... (exits unchanged)\n" + HD);
  const res = {};
  for (const cut of CUTS[id]) { res[cut] = run(c, { cutoff: cut }); console.log(line(cut === 9999 ? "WITHOUT (entries until 14:55)" : "entries only until " + hm(cut), res[cut])); }
  console.log("\n  at most N entries a day\n" + HD);
  for (const N of [1, 2, 3, 99]) console.log(line(N === 99 ? "WITHOUT (no limit)" : "at most " + N + " entr" + (N === 1 ? "y" : "ies") + " a day", run(c, { maxPer: N })));
  for (const [fit, test, fl, tl] of [["a", "b", "Jan-Mar", "Apr-Jul"], ["b", "a", "Apr-Jul", "Jan-Mar"]]) {
    const top = CUTS[id].slice().sort((x, y) => res[y][fit] - res[x][fit])[0];
    console.log("  cutoff picked on " + fl + ": " + (top === 9999 ? "none" : hm(top)) + " -> " + res[top][test].toFixed(1) + "% on " + tl + " (no cutoff: " + res[9999][test].toFixed(1) + "%)");
  }
  // the base's own trades by entry time
  {
    let day = -1;
    const tr = c.E.run(c.lots === undefined ? () => 4 : (a, ct, s, arm) => c.lots(arm - 1), { signals: c.sig, ...FILL, ...c.opts })
      .filter((t) => S.yearOf.get(t.tday) === 2026);
    const buckets = id === "A" ? [[510, 540], [540, 600], [600, 720], [720, 905]] : [[510, 600], [600, 720], [720, 780], [780, 905]];
    console.log("\n  the setup's own 2026 trades by entry time: " + buckets.map(([a, b]) => {
      const x = tr.filter((t) => t.entCt >= a && t.entCt < b);
      return hm(a) + "-" + hm(Math.min(b, 900)) + " " + x.length + " trades $" + (x.reduce((s, t) => s + t.pnl, 0) / Math.max(1, x.length)).toFixed(0);
    }).join("  |  "));
    void day;
  }
  const pick = id === "A" ? 540 : 780;
  if (pick) {
    console.log("\n  stress, WITHOUT -> WITH (entries only until " + hm(pick) + ")");
    const pairs = [
      ["as tested", {}, {}],
      ["enter one bar later", { sig: shift1(c.sig) }, { sig: shift1(c.sig) }],
      ["2 ticks slippage each way", { extra: { slipMult: 2 } }, { extra: { slipMult: 2 } }],
      ["commission $1.25/side", { extra: { feeMult: 1.25 / 0.75 } }, { extra: { feeMult: 1.25 / 0.75 } }],
      ["breaker one step tighter (-$100)", { extra: { breaker: c.opts.breaker - 100 } }, { extra: { breaker: c.opts.breaker - 100 } }],
      ["breaker one step looser (+$100)", { extra: { breaker: c.opts.breaker + 100 } }, { extra: { breaker: c.opts.breaker + 100 } }],
      ["breaker off", { extra: { breaker: 0 } }, { extra: { breaker: 0 } }],
      ["profit block +$350", { extra: { profitBlock: 350 } }, { extra: { profitBlock: 350 } }],
      ["profit block off", { extra: { profitBlock: 0 } }, { extra: { profitBlock: 0 } }],
    ];
    for (const [lbl, o0, o1] of pairs) {
      const r0 = run(c, o0), r1 = run(c, { ...o1, cutoff: pick });
      console.log("    " + lbl.padEnd(30) + f1(r0.y) + " ->" + f1(r1.y) + "   (Jan-Mar" + f1(r0.a) + " ->" + f1(r1.a) + ",  Apr-Jul" + f1(r0.b) + " ->" + f1(r1.b) +
                  ")   $/tr" + f1(r0.exp, 7) + " ->" + f1(r1.exp, 7));
    }
    for (const L of [3, 5]) {
      const c2 = { ...c, lots: id === "A" ? () => L : (k) => (M.adrUsed(k) >= 0.9 ? (L === 3 ? 2 : 3) : L) };
      const r0 = run(c2), r1 = run(c2, { cutoff: pick });
      console.log("    " + (L + " lots").padEnd(30) + f1(r0.y) + " ->" + f1(r1.y) + "   (Jan-Mar" + f1(r0.a) + " ->" + f1(r1.a) + ",  Apr-Jul" + f1(r0.b) + " ->" + f1(r1.b) + ")");
    }
    if (id === "D") {
      const c2 = { ...c, lots: () => 4 };
      const r0 = run(c2), r1 = run(c2, { cutoff: pick });
      console.log("    " + "no late-day half size".padEnd(30) + f1(r0.y) + " ->" + f1(r1.y) + "   (Jan-Mar" + f1(r0.a) + " ->" + f1(r1.a) + ",  Apr-Jul" + f1(r0.b) + " ->" + f1(r1.b) + ")");
    } else {
      for (const [lbl, o] of [["at most 2 entries a day", {}], ["  ... one bar later", { sig: shift1(c.sig) }], ["  ... 5 lots", {}]]) {
        const c2 = lbl.includes("5 lots") ? { ...c, lots: () => 5 } : c;
        const r0 = run(c2, o), r1 = run(c2, { ...o, maxPer: 2 });
        console.log("    " + lbl.padEnd(30) + f1(r0.y) + " ->" + f1(r1.y) + "   (Jan-Mar" + f1(r0.a) + " ->" + f1(r1.a) + ",  Apr-Jul" + f1(r0.b) + " ->" + f1(r1.b) + ")");
      }
    }
    const r0 = res[9999], r1 = res[pick];
    const M7 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"];
    console.log("\n  dollars by month WITHOUT: " + M7.map((m, i) => m + " " + (r0.mo[i] >= 0 ? "+" : "") + Math.round(r0.mo[i])).join("  "));
    console.log("  dollars by month WITH:    " + M7.map((m, i) => m + " " + (r1.mo[i] >= 0 ? "+" : "") + Math.round(r1.mo[i])).join("  "));
  }
}
console.log("\n  real = every real 21-day window in 2026; -3best / -5best = with the 3 / 5 best days removed");
console.log("  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
