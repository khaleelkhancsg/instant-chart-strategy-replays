// The donchian_1250 idea loop: batches of rules that refuse some of the book's trades, each judged against the same
// book on 100 placebo markets, with 2025-2026 weighted first. Ledger: research/donchian_ledger.md.
//
//   node --max-old-space-size=16384 research/donchian_lab.mjs --batch 1 [--placebos 100]
//
// The person (2026-11-26): "do batch research with the donchian, just like how you did with the databox". Written
// before any batch ran:
// - The book: donchian_1250 as shipped, $1,250 settings, run by the lab's engine (runStrategy) over
//   data/mnq_1m_beta.bin (2019-05 to 2026-10-30), once on the real market and once on each placebo market (lib_levels
//   placeboBars, seeds 9100 + p: every bar's move flipped at random, its range kept; the book trades them about as
//   often as the real market, research/donchian_audit.mjs).
// - An idea is a rule on what the market showed when the trade's signal bar closed (the last 1-minute bar of the
//   2-minute signal bar, never later): keep the trade or refuse it. Each idea states who is on the other side.
// - A trade's result in ATR units: its P&L per contract over (2-minute ATR x $2), so years and markets compare.
//   An idea's lift in a period: the mean result of the trades it keeps less that of the trades it refuses.
// - Periods by entry: 2025 H1, 2025 H2, 2026 Jan-Mar, 2026 Apr 1 - Jul 14 (the screen: the person weights 2025-2026
//   first); forward Jul 15 - Oct 30 and 2019-2024 (the confirmation: no idea or the book's own tuning saw them;
//   2019-2024 did see the original breakout's choice, not these rules).
// - SCREEN PASS: the lift pooled over 2025 and 2026 beats 90 of 100 placebo markets, and is positive in 2025 and in
//   2026 separately, and the rule keeps at least 30% of the trades.
// - CONFIRMED (the person's 10% bar): a screen pass whose lift on 2019-2024 beats 90 of 100 placebo markets and is
//   positive forward (the forward bars hold about 70 trades: too few to require more; their placebo count is shown).
// - A confirmed rule then gets a full engine run (the refused trade changes what follows: flips, day blocks) for its
//   pass rate on live equity against the shipped book, 2025, 2026 and forward. Only that decides whether it ships.
// - Count every idea. A rule written after seeing a result is a lead.

import fs from "node:fs";
import { loadBars } from "../src/data.mjs";
import { runStrategy } from "../src/run.mjs";
import { resample } from "../src/resample.mjs";
import { atr } from "../src/indicators.mjs";
import { configOf } from "./lib_eval1250.mjs";
import { placeboBars, studyLines } from "./lib_levels.mjs";

const args = process.argv.slice(2), arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BATCH = Number(arg("--batch", 1)), PLACEBOS = Number(arg("--placebos", 100));
const D = (s) => Date.parse(s + "T00:00:00Z"), DAY = 86400000, MIN = 60000;
const PERIODS = [["2019-2024", "2019-01-01", "2025-01-01"], ["2025 H1", "2025-01-01", "2025-07-01"], ["2025 H2", "2025-07-01", "2026-01-01"],
  ["2026 Jan-Mar", "2026-01-01", "2026-04-01"], ["2026 Apr-Jul14", "2026-04-01", "2026-07-15"], ["forward", "2026-07-15", "2026-11-01"]].map(([l, a, b]) => ({ l, a: D(a), b: D(b) }));
const SCREEN = [1, 2, 3, 4], Y25 = [1, 2], Y26 = [3, 4], CONF = 0, FWD = 5;
const t0 = Date.now(), secs = () => ((Date.now() - t0) / 1000).toFixed(0);

// ── outside data: the VXN close dated before each session ──
const VXN = (() => { const m = new Map(); for (const line of fs.readFileSync("data/raw/fred/VXNCLS.csv", "utf8").split(/\r?\n/).slice(1)) { const [d, v] = line.split(","); if (d && v && v !== ".") m.set(d, Number(v)); } return m; })();
const vxnBefore = (() => { const keys = [...VXN.keys()].sort(); return (ms) => { const day = new Date(ms).toISOString().slice(0, 10); let lo = 0, hi = keys.length - 1, best = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (keys[mid] < day) { best = mid; lo = mid + 1; } else hi = mid - 1; } return best >= 0 ? VXN.get(keys[best]) : NaN; }; })();

// ── the box's readings (the indicator's arithmetic, as databox_lengths.mjs) ──
function emaSeries(x, n) { const N = x.length, v = new Float64Array(N); let c = 0, t = 0, p = NaN; for (let i = 0; i < N; i++) { if (c < n) { c++; t += x[i]; p = t / c; } else { c++; p = p + (2 / (n + 1)) * (x[i] - p); } v[i] = p; } return v; }
function warnState(close, f, s, rule) {
  const x = Float64Array.from(close), a = emaSeries(x, f), b = emaSeries(x, s), N = x.length, w = new Int8Array(N);
  let ps = 0, pd = NaN, pm = NaN, has = false;
  for (let i = 0; i < N; i++) {
    const diff = a[i] - b[i], sd = diff > 0 ? 1 : diff < 0 ? -1 : has ? ps : 0, mv = has ? diff - pd : NaN;
    let z = 0;
    if (has && sd && Number.isFinite(pm)) z = rule === "slowing" ? (sd === 1 ? (mv < pm ? -1 : 0) : mv > pm ? 1 : 0) : sd === 1 ? (mv < 0 && mv < pm ? -1 : 0) : mv > 0 && mv > pm ? 1 : 0;
    if (i >= s) w[i] = z;
    ps = sd; pd = diff; pm = mv; has = true;
  }
  return w;
}

// ── everything an idea may read, per 1-minute bar, from bars up to and including it ──
function context(b) {
  const N = b.close.length, TS = b.ts, O = b.open, H = b.high, L = b.low, C = b.close, V = b.volume, TD = b.tday, CT = b.ctMin;
  const x = { N, TS, O, H, L, C, V, TD, CT };
  x.vw = studyLines({ b }, "vwap", 1, { anchor: "rth", bands: 1 }).VWAP;
  x.a1 = atr(H, L, C, 14);
  x.fast = warnState(C, 3, 13, "slowing");   // #3, the box's fast row
  const b5 = resample(b, 5), w5 = warnState(b5.close, 12, 26, "speed"), a5 = atr(b5.high, b5.low, b5.close, 14);
  x.e5 = new Int8Array(N); x.A5 = new Float64Array(N).fill(NaN);
  for (let i = 0, k = -1; i < N; i++) { while (k + 1 < b5.ts.length && b5.ts[k + 1] + 5 * MIN <= TS[i] + MIN) k++; if (k >= 0) { x.e5[i] = w5[k]; x.A5[i] = a5[k]; } }
  // the session's RTH open, high and low so far; the prior RTH day's high, low, close; the overnight high and low;
  // the 10-session average RTH range; cumulative RTH volume against the last 10 sessions' at the same minute
  const F = (n) => new Float64Array(n).fill(NaN);
  Object.assign(x, { rOpen: F(N), dHi: F(N), dLo: F(N), pdH: F(N), pdL: F(N), pdC: F(N), onH: F(N), onL: F(N), adr: F(N), relVol: F(N), vxn: F(N), wd: new Int8Array(N) });
  let td = -1, rOpen = NaN, hi = -Infinity, lo = Infinity, onH = -Infinity, onL = Infinity, last = null, cum = 0, cumArr = [], ranges = [], volHist = [];
  for (let i = 0; i < N; i++) {
    if (TD[i] !== td) {
      if (td >= 0 && hi > lo) { last = { h: hi, l: lo, c: C[i - 1] }; ranges.push(hi - lo); if (ranges.length > 10) ranges.shift(); volHist.push(cumArr); if (volHist.length > 10) volHist.shift(); }
      td = TD[i]; rOpen = NaN; hi = -Infinity; lo = Infinity; onH = -Infinity; onL = Infinity; cum = 0; cumArr = [];
    }
    const ct = CT[i], rth = ct >= 510 && ct < 900;
    if (rth) { if (!Number.isFinite(rOpen)) rOpen = O[i]; hi = Math.max(hi, H[i]); lo = Math.min(lo, L[i]); cum += V[i]; cumArr[ct - 510] = cum; }
    else if (!Number.isFinite(rOpen)) { onH = Math.max(onH, H[i]); onL = Math.min(onL, L[i]); }
    x.rOpen[i] = rOpen; if (rth) { x.dHi[i] = hi; x.dLo[i] = lo; }
    if (last) { x.pdH[i] = last.h; x.pdL[i] = last.l; x.pdC[i] = last.c; }
    if (onH > onL) { x.onH[i] = onH; x.onL[i] = onL; }
    if (ranges.length === 10) x.adr[i] = ranges.reduce((a, z) => a + z, 0) / 10;
    if (rth && volHist.length === 10) { let s = 0, n = 0; for (const h of volHist) { const v = h[ct - 510]; if (v > 0) { s += v; n++; } } if (n >= 5) x.relVol[i] = cum / (s / n); }
    x.wd[i] = new Date(TS[i]).getUTCDay();
  }
  return x;
}

// ── the ideas: keep(x, j, t) with j the signal's last 1-minute bar and t the trade (dir, contracts, earlier trades) ──
const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0), closeCt = (x, j) => (x.CT[j] + 1) % 1440;
const BATCHES = {
  1: [
    { name: "with VWAP: long above, short below", why: "a breakout on the side of the day's average price has the session's buyers (sellers) in profit behind it; across VWAP it runs into the other side's average", keep: (x, j, t) => Number.isFinite(x.vw[j]) && t.dir * (x.C[j] - x.vw[j]) > 0 },
    { name: "VWAP's 15-minute slope agrees", why: "the volume-weighted flow already leans the breakout's way; against it, the break is into flow", keep: (x, j, t) => Number.isFinite(x.vw[j - 15]) && t.dir * (x.vw[j] - x.vw[j - 15]) > 0 },
    { name: "not stretched: within 2 five-minute ATRs of VWAP", why: "far from VWAP the breakout is late; mean-reverting liquidity providers lean against it", keep: (x, j) => Number.isFinite(x.vw[j]) && Math.abs(x.C[j] - x.vw[j]) < 2 * x.A5[j] },
    { name: "the day has used under 75% of its average range", why: "room to run: a breakout late in a full day has the day's range against it (the book halves size at 0.9)", keep: (x, j) => Number.isFinite(x.adr[j]) && x.dHi[j] - x.dLo[j] < 0.75 * x.adr[j] },
    { name: "beyond the prior day's high (long) / low (short)", why: "a break of yesterday's extreme triggers the stops and breakout orders resting there: forced flow its way", keep: (x, j, t) => Number.isFinite(x.pdH[j]) && (t.dir === 1 ? x.C[j] > x.pdH[j] : x.C[j] < x.pdL[j]) },
    { name: "not at lunch (11:30-13:00 CT)", why: "lunch is thin; breakouts then lack the participation to follow through", keep: (x, j) => { const c = closeCt(x, j); return c < 690 || c >= 780; } },
    { name: "the fast row (3/13) not warning against it", why: "confirmed #3: a fast-row warning calls a turn; a breakout into one starts as the move fades", keep: (x, j, t) => x.fast[j] !== -t.dir },
    { name: "volume above the last 10 sessions' at this minute", why: "a breakout on heavy participation is real buying (selling); on light volume it is a few orders", keep: (x, j) => x.relVol[j] > 1 },
    { name: "VXN above its 60-session median", why: "in volatile markets dealers are shorter gamma and hedge with the move, so breakouts extend", keep: (x, j) => x.vxnHi[j] === 1 },
  ],
};

function tradesOn(b, cfg) {
  const r = runStrategy(b, cfg.s, cfg.params, cfg.exec, { filter: cfg.filter, studies: cfg.studies });
  const out = r.trades.map((t) => ({ dir: t.dir, R: t.pnl / (t.contracts * 2 * t.atr), pnl: t.pnl, j: r.tf.srcLast[t.sigIdx], entry: t.entryTime, exit: t.exitTime, tday: t.tday, contracts: t.contracts }));
  // what each trade could know of the day's earlier trades: those closed before its signal bar closed
  const byDay = new Map();
  for (const t of out) { const a = byDay.get(t.tday) || []; t.before = a.filter((z) => z.exit <= b.ts[t.j] + MIN); a.push(t); byDay.set(t.tday, a); }
  return out;
}
function measure(b, cfg, ideas) {
  const x = context(b);
  // VXN's 60-session median, dated before the session
  x.vxnHi = new Int8Array(x.N); { let td = -1, v = NaN, hist = [], med = NaN; for (let i = 0; i < x.N; i++) { if (x.TD[i] !== td) { td = x.TD[i]; v = vxnBefore(x.TS[i]); if (Number.isFinite(v)) { const z = [...hist].sort((p, q) => p - q); med = z.length >= 60 ? z[z.length >> 1] : NaN; hist.push(v); if (hist.length > 60) hist.shift(); } } x.vxnHi[i] = Number.isFinite(med) && v > med ? 1 : 0; } }
  const tr = tradesOn(b, cfg), P = PERIODS.length;
  return ideas.map((idea) => {
    const k = new Float64Array(P * 3), r = new Float64Array(P * 3);   // n, sum R, sum $
    for (const t of tr) {
      const p = PERIODS.findIndex((q) => t.entry >= q.a && t.entry < q.b);
      if (p < 0) continue;
      let ok = false; try { ok = !!idea.keep(x, t.j, t); } catch { ok = false; }
      const a = ok ? k : r; a[p * 3]++; a[p * 3 + 1] += t.R; a[p * 3 + 2] += t.pnl;
    }
    return { k: Array.from(k), r: Array.from(r) };
  });
}
const liftOf = (m, ps) => { let kn = 0, ks = 0, rn = 0, rs = 0; for (const p of ps) { kn += m.k[p * 3]; ks += m.k[p * 3 + 1]; rn += m.r[p * 3]; rs += m.r[p * 3 + 1]; } return { lift: kn && rn ? ks / kn - rs / rn : NaN, kept: kn / (kn + rn), kn }; };

const IDEAS = BATCHES[BATCH];
if (!IDEAS) throw new Error(`no batch ${BATCH}`);
const { bars } = loadBars("data/mnq_1m_beta.bin");
const cfg = await configOf("donchian_1250", {}, "1250");
const real = measure(bars, cfg, IDEAS);
process.stderr.write(`  batch ${BATCH}: real market ${secs()}s\n`);
const pl = [];
for (let p = 0; p < PLACEBOS; p++) { pl.push(measure(placeboBars(bars, 9100 + p), cfg, IDEAS)); if ((p + 1) % 10 === 0) process.stderr.write(`  ${p + 1}/${PLACEBOS} placebo markets, ${secs()}s\n`); }

const pt = (v) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(3) : "—"), pc = (v) => (100 * v).toFixed(0) + "%";
const beats = (v, vals) => vals.filter((z) => Number.isFinite(z) && z < v).length;
console.log(`donchian_1250 idea loop, batch ${BATCH}; ${PLACEBOS} placebo markets; ${secs()}s`);
console.log(`lift = mean ATR-result of kept trades less refused ones; (n) = placebo markets beaten; kept = share of trades kept`);
console.log(`${"idea".padEnd(54)}${"2025+26".padStart(13)}${"2025".padStart(8)}${"2026".padStart(8)}${"kept".padStart(6)} |${"2019-24".padStart(13)}${"forward".padStart(13)}  verdict`);
const out = IDEAS.map((idea, q) => {
  const S = liftOf(real[q], SCREEN), A = liftOf(real[q], Y25), B = liftOf(real[q], Y26), C = liftOf(real[q], [CONF]), F = liftOf(real[q], [FWD]);
  const bS = beats(S.lift, pl.map((m) => liftOf(m[q], SCREEN).lift)), bC = beats(C.lift, pl.map((m) => liftOf(m[q], [CONF]).lift)), bF = beats(F.lift, pl.map((m) => liftOf(m[q], [FWD]).lift));
  const screen = bS >= 0.9 * PLACEBOS && A.lift > 0 && B.lift > 0 && S.kept >= 0.3, conf = screen && bC >= 0.9 * PLACEBOS && F.lift > 0;
  const v = conf ? "CONFIRMED" : screen ? "screen pass, not confirmed" : "fails the screen";
  console.log(`${idea.name.padEnd(54)}${`${pt(S.lift)} (${bS})`.padStart(13)}${pt(A.lift).padStart(8)}${pt(B.lift).padStart(8)}${pc(S.kept).padStart(6)} |${`${pt(C.lift)} (${bC})`.padStart(13)}${`${pt(F.lift)} (${bF})`.padStart(13)}  ${v}`);
  return { name: idea.name, why: idea.why, screen: S, y2025: A, y2026: B, conf: C, fwd: F, beats: { screen: bS, conf: bC, fwd: bF }, verdict: v };
});
fs.writeFileSync(`research/donchian_lab_b${BATCH}_results.json`, JSON.stringify({ run: new Date().toISOString(), batch: BATCH, placebos: PLACEBOS, ideas: out, real, placebo: pl }));
console.log(`\n(${secs()}s) wrote research/donchian_lab_b${BATCH}_results.json`);
