// Stage 6: the book's own gates, other bar sizes, and the overnight session,
// weighted to 2026 above everything else, as asked.
//
//   GATES       efficiency threshold and period, ADX threshold, channel length,
//               the rescue band, the entry window -- one at a time around live
//   BAR SIZE    the same rule on 1, 3, 4 and 5-minute bars, with the channel
//               held at 30 bars AND at the same 60 minutes, and the rescue's
//               EMAs held at the same time horizon
//   OVERNIGHT   the account may trade 17:00-15:05 CT; the book only trades
//               08:30-15:00. Globex entries added, alone or trend-gated.
//
// Every row shows 2026 (and Jan-Mar / Apr-Jul inside it), 2026 with its best
// three days put back to the live book's, then 2025 and the full history for
// context.
//
// RESULT (2026 change vs live 34.5%): no other bar size helps (1-min -7.4,
// 3-min -20.2, 4-min -5.2, 5-min -15.7) and neither does overnight trading
// (-6.2 to -13.7). Efficiency and ADX sweeps swing hard between Jan-Mar and
// Apr-Jul (ADX >= 30: +7.9, but it rests on three days). The one pattern that
// holds up inside 2026 is TIME: afternoon entries are bad in 2026 (13:00-15:00
// alone passes 7.7%), and stopping new entries at 10:00 CT gives +5.8 in 2026
// (both halves, survives its best 3 days put back) for -6.6 in 2025. Cutoffs
// at 12:00-13:00 give +3.4 to +4.9 while leaving 2025 unchanged, but rest on a
// few days.
//
//   node --max-old-space-size=8192 research/donchian_regimes.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { ema, adx, donchian } from "../src/indicators.mjs";
import * as S from "./lib_shipped.mjs";

const T0 = Date.now();
const days = S.days, yr = (d) => S.yearOf.get(d);
const { bars } = loadBars();
const tfm = resample(bars, 2);
const mo = new Map(); for (let i = 0; i < tfm.close.length; i++) if (!mo.has(tfm.tday[i])) mo.set(tfm.tday[i], new Date(tfm.ts[i] + 43200e3).getUTCMonth());
const yIdx = (f) => days.map((d, k) => (f(d) ? k : -1)).filter((k) => k >= 0);
const Y26 = yIdx((d) => yr(d) === 2026), Y25 = yIdx((d) => yr(d) === 2025);
const Y26a = yIdx((d) => yr(d) === 2026 && mo.get(d) < 3), Y26b = yIdx((d) => yr(d) === 2026 && mo.get(d) >= 3);
const at = (arr, ix) => S.passArr(ix.map((k) => arr[k]));
const sg = (x) => ((x >= 0 ? "+" : "") + x.toFixed(1)).padStart(6);

// Build the book's signal on any bar size, with every gate as a parameter.
const engines = new Map();
function eng(tfMin) {
  if (!engines.has(tfMin)) {
    const e = S.engineFor(tfMin);
    const { high: H, low: L, close: C } = e.tf;
    engines.set(tfMin, { ...e, adx: adx(H, L, C, 14).adx, ema: new Map(), dc: new Map(), fctx: new Map() });
  }
  return engines.get(tfMin);
}
function signal({ tfMin = 2, n = 30, adxMin = 25, effMin = 0.5, effP = 20, resc = 0.45, fast = 125 * 2, slow = 500 * 2,
                  startCt = 510, endCt = 900 } = {}) {
  const e = eng(tfMin), { high: H, low: L, close: C } = e.tf, nB = C.length;
  if (!e.dc.has(n)) e.dc.set(n, donchian(H, L, n));
  if (!e.fctx.has(effP)) e.fctx.set(effP, effP === 20 ? e.ctx : buildFilterContext(e.tf, { effPeriod: effP }));
  const { high: dh, low: dl } = e.dc.get(n), fc = e.fctx.get(effP);
  const raw = new Int8Array(nB);
  for (let i = n; i < nB; i++) { if (e.adx[i] < adxMin) continue; if (C[i] > dh[i]) raw[i] = 1; else if (C[i] < dl[i]) raw[i] = -1; }
  const g = (x) => applyFilters(raw, fc, { ...NO_FILTER, startCt, endCt, effMin: x });
  const sig = g(effMin);
  if (resc > 0 && resc < effMin) {
    // fast/slow are in MINUTES so the trend horizon is the same on any bar size
    const fb = Math.max(2, Math.round(fast / tfMin)), sb = Math.max(3, Math.round(slow / tfMin));
    const key = fb + ":" + sb;
    if (!e.ema.has(key)) e.ema.set(key, [ema(C, fb), ema(C, sb)]);
    const [ef, es] = e.ema.get(key), gr = g(resc);
    for (let k = 0; k < nB; k++) if (gr[k] && !sig[k] && Math.sign(ef[k] - es[k]) === raw[k]) sig[k] = gr[k];
  }
  return sig;
}
function evalSig(sig, tfMin = 2, opts = {}, lots = 8) {
  const tr = eng(tfMin).run(() => lots, { signals: sig, ...opts });
  const arr = S.dayArr(tr, days);
  return { arr, n26: tr.filter((t) => yr(t.tday) === 2026).length, y26: at(arr, Y26), a26: at(arr, Y26a), b26: at(arr, Y26b),
           y25: at(arr, Y25), all: S.passArr(arr) };
}
const LIVE = evalSig(signal());
function jack3(r) {
  const best = Y26.map((k) => [k, r.arr[k] - LIVE.arr[k]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const a = Float64Array.from(r.arr); for (const [k] of best) a[k] = LIVE.arr[k];
  return at(a, Y26) - LIVE.y26;
}
const all = [];
function row(label, r) {
  r.j3 = jack3(r); all.push({ label, ...r, arr: undefined });
  const ok = r.y26 > LIVE.y26 && r.a26 >= LIVE.a26 && r.b26 >= LIVE.b26 && r.j3 > 0 ? "  <- holds up inside 2026" : "";
  console.log("  " + label.padEnd(62) + String(r.n26).padStart(6) + (r.y26.toFixed(1)).padStart(7) + sg(r.y26 - LIVE.y26) +
    sg(r.a26 - LIVE.a26) + sg(r.b26 - LIVE.b26) + sg(r.j3).padStart(10) + sg(r.y25 - LIVE.y25).padStart(8) + sg(r.all - LIVE.all).padStart(7) + ok);
}
const HDR = "  " + "".padEnd(62) + "2026tr".padStart(6) + "   2026  d2026 JanMar AprJul best3back   d2025   dAll";
function bar(t) { console.log("\n" + "=".repeat(124) + "\n" + t + "\n" + "=".repeat(124)); }

bar("6. GATES, BAR SIZES AND THE OVERNIGHT SESSION -- weighted to 2026.  Live 2026: " + LIVE.y26.toFixed(1) + "% (Jan-Mar " +
  LIVE.a26.toFixed(1) + ", Apr-Jul " + LIVE.b26.toFixed(1) + ")");
console.log("\n" + HDR);
row("live book", LIVE);

console.log("\n  efficiency threshold (rescue band kept 0.05 below it, with the trend)");
for (const x of [0.35, 0.4, 0.45, 0.55, 0.6, 0.65]) row("   efficiency >= " + x + ", rescue from " + (x - 0.05).toFixed(2), evalSig(signal({ effMin: x, resc: +(x - 0.05).toFixed(2) })));
row("   efficiency >= 0.5, NO rescue (the bot before the rescue)", evalSig(signal({ resc: 0 })));
for (const r of [0.35, 0.4, 0.425, 0.475]) row("   efficiency >= 0.5, rescue from " + r, evalSig(signal({ resc: r })));
console.log("\n  efficiency period (bars)");
for (const p of [10, 14, 30, 40]) row("   efficiency over " + p + " bars", evalSig(signal({ effP: p })));
console.log("\n  ADX threshold");
for (const a of [15, 20, 22.5, 27.5, 30, 35]) row("   ADX >= " + a, evalSig(signal({ adxMin: a })));
console.log("\n  channel length (bars of 2 minutes)");
for (const n of [15, 20, 25, 35, 40, 50, 60]) row("   Donchian " + n, evalSig(signal({ n })));
console.log("\n  the rescue's trend horizon (EMA pair, in minutes)");
for (const [f, s] of [[60, 240], [120, 480], [500, 2000], [1000, 4000]]) row("   trend EMA " + f + "/" + s + " minutes", evalSig(signal({ fast: f, slow: s })));
console.log("\n  entry window (CT)");
const hm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
for (const [a, b] of [[510, 600], [510, 660], [510, 720], [510, 780], [510, 840], [540, 900], [570, 900], [600, 900], [660, 900], [510, 690], [780, 900]])
  row("   entries " + hm(a) + "-" + hm(b), evalSig(signal({ startCt: a, endCt: b })));

console.log("\n  BAR SIZE -- same rule; channel 30 bars or 60 minutes; rescue trend at the same time horizon");
for (const tfMin of [1, 3, 4, 5]) {
  row("   " + tfMin + "-min bars, Donchian 30 bars", evalSig(signal({ tfMin }), tfMin));
  const n60 = Math.max(5, Math.round(60 / tfMin));
  if (n60 !== 30) row("   " + tfMin + "-min bars, Donchian " + n60 + " bars (60 minutes)", evalSig(signal({ tfMin, n: n60 }), tfMin));
}

console.log("\n  OVERNIGHT -- entries also 17:00-08:30 CT (flat 15:05-17:00 as the account requires)");
{
  const rth = signal();
  const on = (opts) => {
    const g = signal({ startCt: 1020, endCt: 510, ...opts });                     // Globex only, wraps midnight
    const s = Int8Array.from(rth); for (let k = 0; k < s.length; k++) if (g[k] && !s[k]) s[k] = g[k];
    return s;
  };
  row("   + overnight signals, same gates", evalSig(on({}), 2, { overnight: true }));
  row("   + overnight signals, efficiency >= 0.6", evalSig(on({ effMin: 0.6, resc: 0.55 }), 2, { overnight: true }));
  row("   + overnight signals, ADX >= 30, efficiency >= 0.6", evalSig(on({ effMin: 0.6, adxMin: 30, resc: 0.55 }), 2, { overnight: true }));
  row("   + only 06:30-08:30 CT (the pre-open run-up)", evalSig((() => { const g = signal({ startCt: 390, endCt: 510 });
    const s = Int8Array.from(rth); for (let k = 0; k < s.length; k++) if (g[k] && !s[k]) s[k] = g[k]; return s; })(), 2, { overnight: true }));
  row("   overnight ONLY (no RTH trades), same gates", evalSig(signal({ startCt: 1020, endCt: 510 }), 2, { overnight: true }));
}

bar("6B. EVERYTHING ABOVE THAT HOLDS UP INSIDE 2026, best first (by 2026 with its best 3 days put back)");
const keep = all.filter((r) => r.y26 > LIVE.y26 && r.a26 >= LIVE.a26 && r.b26 >= LIVE.b26 && r.j3 > 0).sort((a, b) => b.j3 - a.j3);
console.log("\n  " + keep.length + " of " + (all.length - 1) + "\n" + HDR);
for (const r of keep) console.log("  " + r.label.trim().padEnd(62) + String(r.n26).padStart(6) + r.y26.toFixed(1).padStart(7) + sg(r.y26 - LIVE.y26) +
  sg(r.a26 - LIVE.a26) + sg(r.b26 - LIVE.b26) + sg(r.j3).padStart(10) + sg(r.y25 - LIVE.y25).padStart(8) + sg(r.all - LIVE.all).padStart(7));
console.log("\n  (" + ((Date.now() - T0) / 1000).toFixed(0) + "s)");
