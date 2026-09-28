// Can the ORB be rebuilt so the minute that crosses both levels stops costing
// a full stop-out? (orb_improve.mjs / orb_bothways_check.mjs: resting stops on
// both sides turn that minute into a certain -$532 loss on 35% of ORB days,
// and the book as traded is net negative.)
//
// Two redesigns, both judged under live mechanics on the ORB alone and on the
// shared account, against the account with the ORB switched off:
//
//   A  CLOSE-CONFIRMED. Nothing rests. When a 1-minute bar CLOSES beyond a
//      level, buy/sell at the next minute's open, stop on the other level.
//      A whipsaw minute that closes back inside never trades.
//   B  A SPREAD FLOOR relative to how violent the open has been: stand down
//      when the level spread is under k x the median 08:30-minute range of
//      the previous 20 sessions. Known before the bell.
//
// RESULT: neither works. Close-confirmed loses $11-17 a trade and the account
// passes 33.5-36.6%, below the 38.2% it passes with the ORB switched off. The
// relative floor turns the ORB positive only once it trades almost never
// (k = 1: 87 trades in seven years), and the account then sits at 37.2-39.2%,
// no clear improvement on switching it off (its second half is lower).
//
//   node --max-old-space-size=6144 research/orb_redesign.mjs

import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { ema, adx, donchian } from "../src/indicators.mjs";
import * as J from "./joint_account.mjs";
import * as B from "./lib_orb.mjs";

const { bars } = loadBars();
const tf = resample(bars, 2);
const n2 = tf.close.length;
const { adx: ax } = adx(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const raw = new Int8Array(n2);
for (let i = 30; i < n2; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const ctx = buildFilterContext(tf);
const gated = (x) => applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: x });
const G05 = gated(0.5), G045 = gated(0.45);
const t125 = ema(tf.close, 125), t500 = ema(tf.close, 500);
const RESC = Int8Array.from(G05);
for (let k = 0; k < n2; k++)
  if (G045[k] && !G05[k] && Math.sign(t125[k] - t500[k]) === raw[k]) RESC[k] = G045[k];

const days = J.days, NH = days.length >> 1, REC = 500;
const openIdx = new Map();
for (const d of B.dayKeys) {
  const e = B.dayEnd.get(d);
  let i = B.daySess.get(d);
  while (i < e && B.CT[i] < B.OPEN_CT) i++;
  if (i < e && B.CT[i] < B.FLAT_CT) openIdx.set(d, i);
}
const yearOf = (d) => new Date(B.TS[openIdx.get(d) ?? B.dayStart.get(d)]).getUTCFullYear();
const Y26 = days.map((d, k) => (yearOf(d) === 2026 ? k : -1)).filter((k) => k >= 0);
const slices = (arr) => ({ all: J.pass21(arr), h1: J.pass21(arr.slice(0, NH)), h2: J.pass21(arr.slice(NH)),
                           rec: J.pass21(arr.slice(-REC)), y26: J.pass21(Y26.map((k) => arr[k])) });
const sched = (list) => { const m = new Map(); for (const s of list) m.set(s.bar, s); return m; };
function score(list, orbCfg) {
  const m = sched(list);
  const o = J.simulate("orb", { orbCfg, orbSched: m });
  const b = J.simulate("both", { exclusive: true, orbCfg, orbSched: m, donLots: 8, donSig: RESC });
  return { n: o.oTr.length, st: J.st(o.oTr), orb: slices(o.arr), both: slices(b.arr) };
}
const f1 = (x) => x.toFixed(1).padStart(6);
const five = (s) => [s.all, s.h1, s.h2, s.rec, s.y26].map(f1).join("");
const COLS = ["all", "1stH", "2ndH", "rec", "2026"];
console.log("\n  " + "".padEnd(46) + "ORB".padStart(6) + "".padStart(13) +
  "   ORB book alone              " + "   live account (both books)");
console.log("  " + "variant".padEnd(46) + "trades".padStart(6) + "win%".padStart(6) + "$/tr".padStart(7) +
  "   " + COLS.map((s) => s.padStart(6)).join("") + "   " + COLS.map((s) => s.padStart(6)).join(""));
function line(label, r) {
  console.log("  " + label.padEnd(46) + String(r.n).padStart(6) + (r.n ? r.st.win : 0).toFixed(1).padStart(6) +
    ("$" + (r.n ? r.st.exp : 0).toFixed(0)).padStart(7) + "   " + five(r.orb) + "   " + five(r.both));
}

const LIVE_CFG = { ...J.ORB_CFG, maxWidthPts: 31, bothWays: "fill" };
const LIVE = B.setups(LIVE_CFG).out;
line("live ORB as the bot trades it (both stops rest)", score(LIVE, LIVE_CFG));
{
  const don = J.simulate("don", { donSig: RESC });
  console.log("  " + "ORB switched off".padEnd(46) + " ".repeat(19) + "   " + " ".repeat(30) + "   " + five(slices(don.arr)));
}

// ---- A. close-confirmed ------------------------------------------------------
// The levels are exactly the live ones (touchLevels over 06:30-08:29).
const [WA, WB] = B.refBounds("PRE120");
const LEVELS = new Map();
for (const d of B.dayKeys) {
  const t = B.touchLevels(B.daySess.get(d), B.dayEnd.get(d), WA, WB, { pivotK: 3, tolFrac: 0.08, minTouch: 3 });
  if (t) LEVELS.set(d, t);
}
function closeConfirmed({ maxW = Infinity, minW = 0, lastCt = 570 } = {}) {
  const out = [];
  for (const [d, t] of LEVELS) {
    const w = t.hi - t.lo;
    if (w > maxW || w < minW) continue;
    const i0 = openIdx.get(d); if (i0 == null) continue;
    const e0 = B.dayEnd.get(d);
    for (let i = i0; i + 1 < e0 && B.CT[i] < lastCt; i++) {
      const dir = B.C[i] > t.hi ? 1 : B.C[i] < t.lo ? -1 : 0;
      if (!dir) continue;
      const entryPx = B.O[i + 1], far = dir === 1 ? t.lo : t.hi;
      const risk = (entryPx - far) * dir;
      if (risk >= B.TICK) out.push({ bar: i + 1, dir, entryPx, risk, day: d, width: w });
      break;
    }
  }
  return out;
}
console.log("\n  A) close-confirmed: a 1-min CLOSE beyond a level, enter at the next open, stop on the other level");
for (const hold of [5, 10, 15]) {
  const cfg = { ...J.ORB_CFG, maxHoldMin: hold };
  line("   levels <= 31 pts, " + hold + "-min hold", score(closeConfirmed({ maxW: 31 }), cfg));
  line("   any spread,       " + hold + "-min hold", score(closeConfirmed(), cfg));
}

// ---- B. spread floor relative to recent opening violence -----------------------
// Median range of the 08:30 minute over the previous 20 sessions: known before
// today's bell.
const firstRange = new Map(), keys = [...openIdx.keys()];
for (const d of keys) { const i = openIdx.get(d); firstRange.set(d, B.H[i] - B.L[i]); }
const expect = new Map();
for (let k = 20; k < keys.length; k++) {
  const v = keys.slice(k - 20, k).map((d) => firstRange.get(d)).sort((a, b) => a - b);
  expect.set(keys[k], v[10]);
}
console.log("\n  B) resting stops, but stand down when spread < k x the median 08:30-minute range of the last 20 sessions");
const ALLW = B.setups({ ...LIVE_CFG, maxWidthPts: Infinity }).out;
for (const [cap, lbl] of [[31, "levels <= 31"], [Infinity, "any spread"]]) {
  for (const k of [0.5, 0.75, 1, 1.5, 2]) {
    const keep = ALLW.filter((s) => s.width <= cap && expect.has(s.day) && s.width >= k * expect.get(s.day));
    line("   " + lbl + ", k = " + k, score(keep, LIVE_CFG));
  }
}
