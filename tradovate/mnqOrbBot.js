/*
 * MNQ ORB — LIVE BOT MIRROR for Tradovate.                  APPLY TO A 1-MINUTE CHART.
 *
 * Draws what bot/orb_strategy.py sees and does, the way the live bot arms it:
 *
 *   level lines (08:30-09:30 CT)   the two ORB levels. NOT the high and low of
 *                                  the pre-open: swing pivots from 06:30-08:30
 *                                  CT are clustered by price, and the densest
 *                                  cluster above the 08:29 close and the densest
 *                                  below become the levels ("where price keeps
 *                                  reacting"). Label shows the tap counts.
 *   gold lines                     the two resting stop-entries, one tick beyond
 *                                  each level, live until 09:30 CT
 *   grey level lines               a stand-down day: the levels are more than
 *                                  31 points apart, which the bot skips
 *   ▲ / ▼  (with lots)             the first break, filled at the trigger, or at
 *                                  the open if the bar gapped through it
 *   red / green lines              stop on the far level, target at 3R, both
 *                                  placed as ticks from the actual fill
 *   TP / SL / TIME                 exit; TIME is the 5-minute time stop
 *   ?                              a minute that broke BOTH levels. The bot's
 *                                  model skips it and keeps hunting; live, the
 *                                  resting order that printed first would fill.
 *
 * Once a day. No level at all on ~43% of days (nothing tapped often enough on
 * both sides), and then nothing is drawn but the label.
 *
 * Every number is copied from the bot. Verified in Node against the bot's own
 * golden fixture and seven years of data -- see tradovate/verify.mjs.
 */

const predef = require("./tools/predef");
const meta = require("./tools/meta");
// Markers use the graphics module. Guarded so that if it is missing or named
// differently, the LINES still load and only the markers are lost -- they
// have their own on/off switch (showMarkers).
let du = (v) => v;
try { du = require("./tools/graphics").du || du; } catch (e) { /* lines still work */ }

// ── bot/orb_strategy.py DEFAULT_CFG + CONFIG["orb_max_width_pts"] ─────────
const CFG = {
  openCt: 510, preWindowMin: 120, pivotK: 3, tolFrac: 0.08, minTouch: 3,
  giveUpCt: 570, bufTicks: 0, triggerTicks: 1, rMult: 3, maxHoldMin: 5,
  riskDollars: 500, maxLots: 50, pointValue: 2, maxWidthPts: 31,
  tick: 0.25, tfMs: 60000,
};

function nthSunday(y, m, n) {
  const dow = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return 1 + ((7 - dow) % 7) + 7 * (n - 1);
}
// CT minute-of-day and CT calendar date, US DST rules, no Intl dependency.
function ctOf(ms) {
  const y = new Date(ms).getUTCFullYear();
  const dstOn = Date.UTC(y, 2, nthSunday(y, 2, 2), 8);
  const dstOff = Date.UTC(y, 10, nthSunday(y, 10, 1), 7);
  const t = new Date(ms + (ms >= dstOn && ms < dstOff ? -5 : -6) * 3600000);
  return { min: t.getUTCHours() * 60 + t.getUTCMinutes(),
           day: t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate() };
}
function roundTick(px, tick) { return Math.floor(px / tick + 0.5) * tick; }

// ── levels: orb_strategy.orb_levels, line for line ───────────────────────
function pivotsIn(win, k) {
  const out = [];
  for (let i = k; i < win.length - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (!(win[i].h >= win[i - j].h && win[i].h >= win[i + j].h)) isH = false;
      if (!(win[i].l <= win[i - j].l && win[i].l <= win[i + j].l)) isL = false;
    }
    if (isH) out.push(win[i].h);
    if (isL) out.push(win[i].l);
  }
  return out;
}
// Greedy clustering: a cluster keeps absorbing pivots while they stay within
// tol of where it STARTED, so its width is bounded and it cannot drift.
function clusterPx(pivots, tol, minTouch) {
  if (!pivots.length) return [];
  const p = pivots.slice().sort((a, b) => a - b);
  const groups = [[p[0]]];
  for (let i = 1; i < p.length; i++) {
    const g = groups[groups.length - 1];
    if (p[i] - g[0] <= tol) g.push(p[i]); else groups.push([p[i]]);
  }
  return groups.filter((g) => g.length >= minTouch)
               .map((g) => ({ px: g.reduce((a, b) => a + b, 0) / g.length, n: g.length }));
}
function orbLevels(win, K) {
  if (win.length < 4 * K.pivotK + 6) return null;
  let whi = -Infinity, wlo = Infinity;
  for (const b of win) { if (b.h > whi) whi = b.h; if (b.l < wlo) wlo = b.l; }
  if (!(whi > wlo)) return null;
  const tol = Math.max(K.tick * 2, (whi - wlo) * K.tolFrac);
  const piv = pivotsIn(win, K.pivotK);
  if (piv.length < K.minTouch) return null;
  const cl = clusterPx(piv, tol, K.minTouch);
  if (!cl.length) return null;
  const ref = win[win.length - 1].c;
  // Most taps wins; ties go to the NEARER level. Array sort is stable, as
  // Python's is, so a full tie keeps the lower-priced cluster first in both.
  const pick = (side) => {
    const c = cl.filter((x) => (side > 0 ? x.px > ref : x.px < ref));
    if (!c.length) return null;
    c.sort((a, b) => (b.n - a.n) || (Math.abs(a.px - ref) - Math.abs(b.px - ref)));
    return c[0];
  };
  const up = pick(1), dn = pick(-1);
  if (!up || !dn) return null;
  return { hi: up.px, lo: dn.px, tHi: up.n, tLo: dn.n, whi, wlo, ref };
}

// ── the entry the bot would place on a break of `side` ───────────────────
function entryFor(lv, side, B, K) {
  const level = side === 1 ? lv.hi : lv.lo;
  const far = side === 1 ? lv.lo : lv.hi;
  if (K.research) {
    // research/lib_orb.mjs: unrounded trigger, risk to the far level from the fill.
    const trig = level + side * K.triggerTicks * K.tick;
    const fill = side === 1 ? Math.max(trig, B.o) : Math.min(trig, B.o);
    const risk = Math.abs(fill - far);
    return { trig, fill, risk, sl: fill - side * risk, tp: fill + side * risk * K.rMult };
  }
  // The live bot: tick-rounded trigger, bracket sent as TICKS, which the
  // platform measures from the actual fill -- so a gap-through shifts it.
  const trig = roundTick(level + side * K.triggerTicks * K.tick, K.tick);
  const risk = Math.abs(trig - far);
  const stop0 = roundTick(trig - side * risk, K.tick);
  const tgt0 = roundTick(trig + side * risk * K.rMult, K.tick);
  const slT = Math.max(1, Math.round(Math.abs(trig - stop0) / K.tick));
  const tpT = Math.max(1, Math.round(Math.abs(tgt0 - trig) / K.tick));
  const fill = side === 1 ? Math.max(trig, B.o) : Math.min(trig, B.o);
  return { trig, fill, risk, sl: fill - side * slT * K.tick, tp: fill + side * tpT * K.tick };
}

const NEWDAY = { day: 0, dayStart: 0, phase: 0, lv: null, stand: "", t: null };

function stepOrb(O0, B, prevB, bars, i, K) {
  let O = Object.assign({}, O0);
  const ev = {};
  if (!prevB || B.day !== prevB.day) O = Object.assign({}, NEWDAY, { day: B.day, dayStart: i });

  // 0 -> the first bar at/after the open: draw the levels from the window
  if (O.phase === 0 && B.ct >= K.openCt) {
    const lo = K.openCt - K.preWindowMin;
    const win = [];
    for (let j = O.dayStart; j < i; j++) if (bars[j].ct >= lo && bars[j].ct < K.openCt) win.push(bars[j]);
    O.lv = orbLevels(win, K);
    ev.levels = true;
    if (!O.lv) { O.stand = "no qualifying level"; O.phase = 3; }
    else if (K.maxWidthPts > 0 && O.lv.hi - O.lv.lo > K.maxWidthPts) {
      O.stand = "levels " + (O.lv.hi - O.lv.lo).toFixed(1) + " pts apart (> " + K.maxWidthPts + ")";
      O.phase = 3;
    } else O.phase = 1;
  }

  // 1 -> hunting for the first break, once a day, until 09:30 CT
  if (O.phase === 1) {
    if (B.ct >= K.giveUpCt) { O.phase = 3; ev.giveUp = true; }
    else {
      const buf = K.bufTicks * K.tick;
      const up = B.h > O.lv.hi + buf, dn = B.l < O.lv.lo - buf;
      if (up && dn) ev.ambig = true;
      else if (up || dn) {
        const side = up ? 1 : -1;
        const e = entryFor(O.lv, side, B, K);
        if (e.risk < K.tick) { O.phase = 3; ev.badStop = true; }
        else {
          const lots = Math.max(1, Math.min(K.maxLots, Math.floor(K.riskDollars / (e.risk * K.pointValue))));
          O.t = Object.assign({ dir: side, entIdx: i, lots, gapped: e.fill !== e.trig }, e);
          O.phase = 2;
          ev.entry = O.t;
        }
      }
    }
  }

  // 2 -> in the trade: research/lib_orb.mjs resolve(), from the entry bar on
  if (O.phase === 2) {
    const t = O.t, d = t.dir, held = i - t.entIdx;
    let why = null, xp = 0;
    if (held >= K.maxHoldMin) { why = "TIME"; xp = B.o; }
    else {
      if (held > 0) {
        if (d === 1 ? B.o <= t.sl : B.o >= t.sl) { why = "SL"; xp = B.o; }
        else if (d === 1 ? B.o >= t.tp : B.o <= t.tp) { why = "TP"; xp = B.o; }
      }
      if (!why) {
        const hitS = d === 1 ? B.l <= t.sl : B.h >= t.sl;
        const hitT = d === 1 ? B.h >= t.tp : B.l <= t.tp;
        if (hitS) { why = "SL"; xp = t.sl; }          // both in one bar: stop first
        else if (hitT) { why = "TP"; xp = t.tp; }
      }
    }
    if (why) { ev.exit = { why, px: xp, held }; O.phase = 3; }
  }
  return { O, ev };
}

class mnqOrbBot {
  init() {
    this.bars = [];
    this.orb = [];
  }

  map(d, i) {
    const P = this.props || {};
    const K = Object.assign({}, CFG, { research: !!P.__research });
    const w = Number(P.maxWidthPts);
    if (Number.isFinite(w)) K.maxWidthPts = w;
    const idx = typeof i === "number" ? i : d.index();
    const t = d.timestamp();
    let ms = t instanceof Date ? t.getTime() : Number(t);
    if (P.barTimeIsClose) ms -= K.tfMs;
    const ct = ctOf(ms);
    const prevB = idx > 0 ? this.bars[idx - 1] : undefined;
    const B = { o: d.open(), h: d.high(), l: d.low(), c: d.close(), ms, ct: ct.min, day: ct.day };
    const gap = prevB ? ms - prevB.ms : Infinity;
    B.minGap = Math.min(prevB ? prevB.minGap : Infinity, gap > 0 ? gap : Infinity);
    this.bars[idx] = B;
    // Only a short trailing window is ever read back, so drop the rest: a
    // long chart stays light, and a live-bar recompute still finds idx-1.
    if (idx >= 3000) { this.bars[idx - 3000] = undefined; this.orb[idx - 3000] = undefined; }

    const prevO = idx > 0 && this.orb[idx - 1] ? this.orb[idx - 1] : NEWDAY;
    const { O, ev } = stepOrb(prevO, B, prevB, this.bars, idx, K);
    this.orb[idx] = O;

    const out = {};
    const items = [];
    const label = (key, y, text, fill, size) => items.push({
      tag: "Text", key: key + idx, point: { x: du(idx), y: du(y) }, text,
      style: { fontSize: size || 11, fontWeight: "bold", fill }, textAlignment: "centerMiddle" });

    if (idx >= 20 && B.minGap !== K.tfMs) {
      if (B.ct === K.openCt || idx === 20) label("tf", B.h, "mnqOrbBot needs a 1-MINUTE chart", "#e0c341", 13);
      if (P.showMarkers !== false && items.length) out.graphics = { items };
      return out;
    }

    const lv = O.lv;
    const live = O.phase === 1 || O.phase === 2 || ev.exit || ev.entry;
    if (lv && live) { out.levelHi = lv.hi; out.levelLo = lv.lo; }
    if (lv && O.phase === 3 && O.stand && B.ct < K.giveUpCt) { out.standHi = lv.hi; out.standLo = lv.lo; }
    if (O.phase === 1 && P.showTriggers !== false) {
      out.trigHi = roundTick(lv.hi + K.triggerTicks * K.tick, K.tick);
      out.trigLo = roundTick(lv.lo - K.triggerTicks * K.tick, K.tick);
    }
    if (O.t && (O.phase === 2 || ev.exit)) { out.stop = O.t.sl; out.target = O.t.tp; }

    if (P.showMarkers !== false) {
      const off = K.tick * 12;
      if (ev.levels) {
        const txt = !lv ? "ORB: no level today"
          : "ORB " + lv.hi.toFixed(2) + " (" + lv.tHi + ") / " + lv.lo.toFixed(2) + " (" + lv.tLo + ")"
            + "  ·  " + (lv.hi - lv.lo).toFixed(1) + " pts" + (O.stand ? "  ·  STAND DOWN" : "");
        label("lv", lv ? lv.hi + off * 2 : B.h + off, txt, O.stand ? "#9aa4b2" : "#e0c341");
      }
      if (ev.ambig) label("amb", B.h + off, "?", "#9aa4b2", 14);
      if (ev.entry) {
        const e = ev.entry;
        label("en", e.dir === 1 ? B.l - off : B.h + off,
              (e.dir === 1 ? "▲ " : "▼ ") + e.lots + (e.gapped ? " gap" : ""),
              e.dir === 1 ? "#26a65b" : "#d1566e", 14);
      }
      if (ev.exit) {
        label("ex", ev.exit.px, ev.exit.why,
              ev.exit.why === "TP" ? "#26a65b" : ev.exit.why === "SL" ? "#d1566e" : "#9aa4b2");
      }
      if (items.length) out.graphics = { items };
    }
    if (P.__research !== undefined) out._ev = { ev, O, B };
    return out;
  }
}

module.exports = {
  name: "mnqOrbBot",
  description: "MNQ ORB — live bot mirror (1-min chart)",
  calculator: mnqOrbBot,
  params: {
    maxWidthPts: predef.paramSpecs.number(31, 1, 0),
    showTriggers: predef.paramSpecs.bool(true),
    showMarkers: predef.paramSpecs.bool(true),
    barTimeIsClose: predef.paramSpecs.bool(false),
  },
  inputType: meta.InputType.BARS,
  areaChoice: (meta.AreaChoice || {}).OVERLAY,
  plots: {
    levelHi: { title: "ORB level high" }, levelLo: { title: "ORB level low" },
    trigHi: { title: "Buy stop" }, trigLo: { title: "Sell stop" },
    stop: { title: "Stop" }, target: { title: "Target" },
    standHi: { title: "Level (stand-down)" }, standLo: { title: "Level (stand-down)" },
  },
  tags: ["MNQ bot"],
  schemeStyles: {
    dark: {
      levelHi: { color: "#4aa3ff" }, levelLo: { color: "#4aa3ff" },
      trigHi: { color: "#e0c341" }, trigLo: { color: "#e0c341" },
      stop: { color: "#d1566e" }, target: { color: "#26a65b" },
      standHi: { color: "#5b6573" }, standLo: { color: "#5b6573" },
    },
  },
};
