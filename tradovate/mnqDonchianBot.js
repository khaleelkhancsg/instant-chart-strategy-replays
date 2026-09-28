/*
 * MNQ Donchian — LIVE BOT MIRROR for Tradovate.            APPLY TO A 2-MINUTE CHART.
 *
 * Draws what bot/mnq_donchian_bot.py sees and does, on the chart you trade from:
 *
 *   thin green/red lines   the Donchian channel: highest high / lowest low of
 *                          the PREVIOUS 30 bars (the current bar is excluded)
 *   ▲ / ▼                  a signal the bot acts on: close outside the channel,
 *                          ADX(14) >= 25, efficiency ratio(20) >= 0.5, and the
 *                          bar opening 08:30 <= t < 15:00 CT
 *   gold line              the STOP-ENTRY the signal arms: signal close +/-
 *                          0.15 x ATR. Parked on the next bar, live on the bar
 *                          after that, for 10 bars. If the stop would already
 *                          be through the market when it goes live, the bot
 *                          re-places it as a LIMIT at the same price (it then
 *                          needs a retrace to fill) -- drawn the same way.
 *   red / green lines      the bracket: stop at signal close -/+ min(5 x ATR,
 *                          62.5 pts), target at signal close +/- 1.75 x ATR.
 *   ●                      where the arm would fill
 *   TP / SL / FLIP / FLAT  where the position would end
 *
 * Every number here is copied from the bot's CONFIG. Change the bot first,
 * then this -- the point of the indicator is that the two agree.
 *
 * NOT MODELLED (the indicator cannot see your account):
 *   - the $500 circuit breaker and $750 profit block, which stop NEW arms once
 *     the day's realised P&L crosses them
 *   - the platform's $1,000 day cap after a loss: the bot tightens the stop as
 *     the day goes red. Drawn stops assume a flat day (62.5 pts at 8 lots).
 *   - the ORB book owning the account (the two never hold at once)
 * So a ▲ that the bot skipped is usually one of those three.
 *
 * Verified in Node against the bot's own golden fixture and seven years of
 * data -- see tradovate/verify.mjs.
 */

const predef = require("./tools/predef");
const meta = require("./tools/meta");
// Markers use the graphics module. Guarded so that if it is missing or named
// differently, the LINES still load and only the markers are lost -- they
// have their own on/off switch (showMarkers).
let du = (v) => v;
try { du = require("./tools/graphics").du || du; } catch (e) { /* lines still work */ }

// ── the live bot's CONFIG (bot/mnq_donchian_bot.py) ──────────────────────
const CFG = {
  period: 30, adxMin: 25, adxPeriod: 14, atrPeriod: 14, cooldownBars: 1,
  effPeriod: 20, effMin: 0.5,
  startCt: 510, endCt: 900,        // signal bars opening 08:30 <= t < 15:00 CT
  noEntryCt: 895,                  // no new arm at/after 14:55 CT
  flattenCt: 904,                  // force flat 15:04 CT
  trigAtr: 0.15, armBars: 10,      // stop-entry offset and window
  slAtr: 5, tpAtr: 1.75,           // bracket, anchored to the signal close
  dayCapUsd: 1000, pointValue: 2,  // platform day-loss cap
  slip: 0.25,                      // one tick, used only by the research switch
  tick: 0.25, tfMs: 120000,
};

// ── time: UTC -> America/Chicago with US DST rules, no Intl dependency ───
function nthSunday(y, m, n) {
  const dow = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return 1 + ((7 - dow) % 7) + 7 * (n - 1);
}
function ctOf(ms) {
  const y = new Date(ms).getUTCFullYear();
  const dstOn = Date.UTC(y, 2, nthSunday(y, 2, 2), 8);   // 02:00 CST = 08:00 UTC
  const dstOff = Date.UTC(y, 10, nthSunday(y, 10, 1), 7); // 02:00 CDT = 07:00 UTC
  const t = new Date(ms + (ms >= dstOn && ms < dstOff ? -5 : -6) * 3600000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}
function roundTick(px) { return Math.floor(px / CFG.tick + 0.5) * CFG.tick; }

// ── indicators for bar i, from bar i-1's state only ──────────────────────
// Every EMA is seeded on the first value (NOT Wilder), exactly like the bot's
// ema(). Each bar's state depends only on the previous bar's, so Tradovate
// re-calling map() on the live bar recomputes it rather than advancing twice.
function barState(bars, i, prev, o, h, l, c, ms, K) {
  const aA = 2 / (K.atrPeriod + 1), aX = 2 / (K.adxPeriod + 1);
  const tr = prev ? Math.max(h - l, Math.abs(h - prev.c), Math.abs(l - prev.c)) : h - l;
  const up = prev ? h - prev.h : 0, dn = prev ? prev.l - l : 0;
  const pdm = prev && up > dn && up > 0 ? up : 0;
  const ndm = prev && dn > up && dn > 0 ? dn : 0;
  const atr = prev ? aA * tr + (1 - aA) * prev.atr : tr;
  const trX = prev ? aX * tr + (1 - aX) * prev.trX : tr;
  const pdmX = prev ? aX * pdm + (1 - aX) * prev.pdmX : pdm;
  const ndmX = prev ? aX * ndm + (1 - aX) * prev.ndmX : ndm;
  const pdi = trX === 0 ? 0 : (100 * pdmX) / trX;
  const ndi = trX === 0 ? 0 : (100 * ndmX) / trX;
  const s = pdi + ndi;
  const dx = s === 0 ? 0 : (100 * Math.abs(pdi - ndi)) / s;
  const adx = prev ? aX * dx + (1 - aX) * prev.adx : dx;

  // Efficiency ratio, as a running path sum in the bot's order of operations.
  let path = prev ? prev.path + Math.abs(c - prev.c) : 0;
  if (i > K.effPeriod) path -= Math.abs(bars[i - K.effPeriod].c - bars[i - K.effPeriod - 1].c);
  const eff = i >= K.effPeriod
    ? (path === 0 ? 0 : Math.abs(c - bars[i - K.effPeriod].c) / path) : NaN;

  // Channel of the PREVIOUS `period` bars.
  let dh = NaN, dl = NaN;
  if (i >= K.period) {
    dh = -Infinity; dl = Infinity;
    for (let j = i - K.period; j < i; j++) {
      if (bars[j].h > dh) dh = bars[j].h;
      if (bars[j].l < dl) dl = bars[j].l;
    }
  }

  // Raw breakout + ADX floor, then the session and efficiency gate.
  const lastRaw = prev ? prev.lastRaw : -1e9;
  let raw = 0;
  if (i >= K.period && !(i - lastRaw < K.cooldownBars) && !(adx < K.adxMin)) {
    if (c > dh) raw = 1; else if (c < dl) raw = -1;
  }
  const ct = ctOf(ms);
  const inWin = K.startCt <= ct && ct < K.endCt;
  const effOk = !(K.effMin > 0) || (Number.isFinite(eff) && eff >= K.effMin);
  const sig = raw !== 0 && inWin && effOk ? raw : 0;

  return { o, h, l, c, ms, ct, tr, atr, trX, pdmX, ndmX, adx, path, eff, dh, dl,
           raw, lastRaw: raw ? i : lastRaw, sig };
}

// ── the bot's order lifecycle, one bar at a time (research/lib_shipped.mjs) ──
const FLAT0 = { pos: 0, ep: 0, sl: 0, tp: 0, fill: 0, posSet: 0,
                armDir: 0, armPx: 0, armBar: -1, armBy: -1, armEp: 0,
                armSlD: 0, armTpD: 0, isLimit: false, armSet: 0, armCount: 0 };

function stepOrders(S0, B, prevB, i, K) {
  const S = Object.assign({}, S0);
  const ev = {};
  const s2 = prevB ? prevB.sig : 0;
  const flatNow = B.ct >= K.flattenCt || B.ct < K.startCt;

  // 1. a parked or working arm
  if (S.pos === 0 && S.armDir !== 0) {
    if (flatNow || i > S.armBy) {
      S.armDir = 0;
    } else if (i > S.armBar) {
      const a = S.armDir, px = S.armPx;
      let hit;
      if (i === S.armBar + 1 && !S.isLimit && (a === 1 ? B.o >= px : B.o <= px)) {
        // The stop would be refused: price is already through it. The bot
        // re-places the SAME price as a limit, which now needs a retrace.
        S.isLimit = true;
        hit = a === 1 ? B.l <= px : B.h >= px;
      } else {
        hit = S.isLimit ? (a === 1 ? B.l <= px : B.h >= px)
                        : (a === 1 ? B.h >= px : B.l <= px);
      }
      if (hit) {
        S.pos = a; S.fill = px; S.posSet = S.armSet; S.armDir = 0;
        if (K.research) {
          // lib_shipped: stop is the nearer of 5xATR from the reference and the
          // $1,000 cap measured from the slipped fill (first trade of a day).
          const avg = px + a * K.slip;
          const lossPx = avg - a * (K.dayCapUsd / (K.pointValue * K.contracts));
          const rawSl = S.armEp - a * S.armSlD;
          S.sl = a === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
          S.capped = a === 1 ? (S.sl === lossPx && lossPx > rawSl) : (S.sl === lossPx && lossPx < rawSl);
        } else {
          S.sl = S.armEp - a * S.armSlD;
          S.capped = false;
        }
        S.tp = S.armEp + a * S.armTpD;
        ev.fill = { dir: a, px, limit: S.isLimit };
      }
    }
  }

  // 2. an open position
  if (S.pos !== 0) {
    if (flatNow) { ev.exit = { why: "FLAT", px: B.o }; S.pos = 0; return { S, ev }; }
    const d = S.pos, sl = S.sl, tp = S.tp;
    let why = null, xp = 0;
    if (d === 1) {
      if (B.o <= sl) { why = "SL"; xp = B.o; }
      else if (B.l <= sl) { why = "SL"; xp = sl; }
      else if (B.h >= tp) { why = "TP"; xp = tp; }
    } else {
      if (B.o >= sl) { why = "SL"; xp = B.o; }
      else if (B.h >= sl) { why = "SL"; xp = sl; }
      else if (B.l <= tp) { why = "TP"; xp = tp; }
    }
    if (why) { ev.exit = { why, px: xp, capped: why === "SL" && S.capped }; S.pos = 0; return { S, ev }; }
    if (s2 !== 0 && s2 !== S.pos) { ev.exit = { why: "FLIP", px: B.o }; S.pos = 0; }
    if (S.pos !== 0) return { S, ev };
  }

  // 3. the previous bar's signal arms a stop-entry (a newer one replaces it)
  if (S.pos === 0 && s2 !== 0 && !flatNow && B.ct < K.noEntryCt) {
    const a = prevB.atr;
    if (a > 0) {
      const ref = K.research ? B.o : prevB.c;
      let px = ref + s2 * Math.max(a * K.trigAtr, K.tick);
      if (!K.research) px = roundTick(px);
      const capPts = K.dayCapUsd / (K.pointValue * K.contracts);
      const slRaw = Math.max(a * K.slAtr, K.tick);
      S.isLimit = false;
      S.armDir = s2; S.armBar = i; S.armBy = i + K.armBars; S.armEp = ref; S.armPx = px;
      S.armSlD = K.research ? slRaw : Math.min(slRaw, capPts);
      S.armTpD = Math.max(a * K.tpAtr, K.tick);
      S.armSet = S.armCount % 2; S.armCount = S.armCount + 1;
      ev.arm = { dir: s2, px, ref };
    }
  }
  return { S, ev };
}

// ── Tradovate calculator ─────────────────────────────────────────────────
class mnqDonchianBot {
  init() {
    this.bars = [];
    this.orders = [];
  }

  map(d, i) {
    const P = this.props || {};
    const K = Object.assign({}, CFG, {
      contracts: Math.max(1, Number(P.contracts) || 8),
      research: !!P.__research,
    });
    if (K.research) K.flattenCt = 905;
    const idx = typeof i === "number" ? i : d.index();
    const t = d.timestamp();
    let ms = t instanceof Date ? t.getTime() : Number(t);
    if (P.barTimeIsClose) ms -= K.tfMs;

    const prev = idx > 0 ? this.bars[idx - 1] : undefined;
    const B = barState(this.bars, idx, prev, d.open(), d.high(), d.low(), d.close(), ms, K);
    // The bar size, from the smallest gap seen: anything but 2 minutes means
    // every signal on this chart is wrong, so draw nothing but a warning.
    const gap = prev ? ms - prev.ms : Infinity;
    B.minGap = Math.min(prev ? prev.minGap : Infinity, gap > 0 ? gap : Infinity);
    this.bars[idx] = B;
    // Only a short trailing window is ever read back, so drop the rest: a
    // long chart stays light, and a live-bar recompute still finds idx-1.
    if (idx >= 256) { this.bars[idx - 256] = undefined; this.orders[idx - 256] = undefined; }

    const prevS = idx > 0 && this.orders[idx - 1] ? this.orders[idx - 1] : FLAT0;
    const { S, ev } = stepOrders(prevS, B, prev, idx, K);
    this.orders[idx] = S;

    const out = {};
    const items = [];
    const wrongTf = idx >= 20 && B.minGap !== K.tfMs;
    if (wrongTf) {
      if (B.ct === K.startCt || idx === 20) {
        items.push({ tag: "Text", key: "tf" + idx, point: { x: du(idx), y: du(B.h) },
                     text: "mnqDonchianBot needs a 2-MINUTE chart",
                     style: { fontSize: 13, fontWeight: "bold", fill: "#e0c341" },
                     textAlignment: "centerMiddle" });
      }
      if (P.showMarkers !== false && items.length) out.graphics = { items };
      return out;
    }

    if (P.showChannel !== false && Number.isFinite(B.dh)) { out.dcHigh = B.dh; out.dcLow = B.dl; }

    // Lines alternate between two plot sets so consecutive arms are never
    // joined by a diagonal: a plot connects every value it is given.
    const put = (set, key, v) => { out[key + (set ? "B" : "A")] = v; };
    if (S.armDir !== 0) {
      put(S.armSet, "trig", S.armPx);
      put(S.armSet, "stop", S.armEp - S.armDir * S.armSlD);
      put(S.armSet, "target", S.armEp + S.armDir * S.armTpD);
    }
    if (S.pos !== 0 || ev.exit) {
      // On an exit bar the state still carries that trade's bracket (only pos
      // is cleared), including a trade that filled and exited on the same bar.
      put(S.posSet, "stop", S.sl);
      put(S.posSet, "target", S.tp);
    }

    if (P.showMarkers !== false) {
      const off = Math.max(B.atr * 0.35, K.tick * 4);
      if (B.sig !== 0) {
        items.push({ tag: "Text", key: "s" + idx,
                     point: { x: du(idx), y: du(B.sig === 1 ? B.l - off : B.h + off) },
                     text: B.sig === 1 ? "▲" : "▼",
                     style: { fontSize: 16, fontWeight: "bold", fill: B.sig === 1 ? "#26a65b" : "#d1566e" },
                     textAlignment: "centerMiddle" });
      }
      if (ev.fill) {
        items.push({ tag: "Text", key: "f" + idx, point: { x: du(idx), y: du(ev.fill.px) },
                     text: ev.fill.limit ? "● lim" : "●",
                     style: { fontSize: 12, fill: "#e0c341" }, textAlignment: "centerMiddle" });
      }
      if (ev.exit) {
        items.push({ tag: "Text", key: "x" + idx, point: { x: du(idx), y: du(ev.exit.px) },
                     text: ev.exit.why,
                     style: { fontSize: 11, fontWeight: "bold",
                              fill: ev.exit.why === "TP" ? "#26a65b" : ev.exit.why === "SL" ? "#d1566e" : "#9aa4b2" },
                     textAlignment: "centerMiddle" });
      }
      if (items.length) out.graphics = { items };
    }
    // Harness-only: the events behind the drawing, so tradovate/verify.mjs can
    // check them. Tradovate ignores keys that are not declared plots.
    if (P.__research !== undefined) out._ev = { sig: B.sig, raw: B.raw, ev, S, B };
    return out;
  }
}

module.exports = {
  name: "mnqDonchianBot",
  description: "MNQ Donchian — live bot mirror (2-min chart)",
  calculator: mnqDonchianBot,
  params: {
    contracts: predef.paramSpecs.period(8),
    showChannel: predef.paramSpecs.bool(true),
    showMarkers: predef.paramSpecs.bool(true),
    barTimeIsClose: predef.paramSpecs.bool(false),
  },
  inputType: meta.InputType.BARS,
  areaChoice: (meta.AreaChoice || {}).OVERLAY,
  plots: {
    dcHigh: { title: "Donchian high" },
    dcLow: { title: "Donchian low" },
    trigA: { title: "Stop-entry" }, stopA: { title: "Stop" }, targetA: { title: "Target" },
    trigB: { title: "Stop-entry (alt)" }, stopB: { title: "Stop (alt)" }, targetB: { title: "Target (alt)" },
  },
  tags: ["MNQ bot"],
  schemeStyles: {
    dark: {
      dcHigh: { color: "#3d7a5a" }, dcLow: { color: "#7a3d3d" },
      trigA: { color: "#e0c341" }, stopA: { color: "#d1566e" }, targetA: { color: "#26a65b" },
      trigB: { color: "#e0c341" }, stopB: { color: "#d1566e" }, targetB: { color: "#26a65b" },
    },
  },
};
