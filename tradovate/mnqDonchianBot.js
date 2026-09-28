/*
 * MNQ Donchian — BOT MIRROR for Tradovate, 2026 rules.     APPLY TO A 2-MINUTE CHART.
 *
 * ⚠ AHEAD OF THE BOT: the three 2026 rules below (7 lots, 4 lots late in an
 *   extended day, the 40-minute exit) come from research/donchian_2026_final.mjs
 *   and are NOT yet in bot/mnq_donchian_bot.py. Until the bot is updated it
 *   still trades 8 lots with no time exit, and this chart will differ from it
 *   on size and on some exits. Everything else is the live bot's rule.
 *
 * WHAT IS DRAWN
 *   thin green/red lines   the Donchian channel: highest high / lowest low of
 *                          the PREVIOUS 30 bars (the current bar is excluded)
 *   ▲ BUY 7 / ▼ SELL 7     a signal on this bar's close: close outside the
 *                          channel, ADX(14) >= 25, efficiency(20) >= 0.5, bar
 *                          opening 08:30 <= t < 15:00 CT. The label is the order
 *                          the bot places: side and size. A bare ▲ is a signal
 *                          the bot will NOT arm (already in that trade, or too
 *                          late in the session).
 *   · moves stop           a stop-entry from an earlier signal is still
 *                          resting: this one moves it to the new level. If the
 *                          old one fills on the very next candle, the new level
 *                          never goes in, and its lines stop after one candle.
 *   · flip                 the bot is in the opposite trade: this closes it at
 *                          the next open and arms the new side
 *   △ / ▽ ... · trend      let through by the SLOW-TREND RESCUE: efficiency
 *                          0.45-0.5, taken because the 2-min EMA 125 is on the
 *                          breakout's side of the EMA 500. Needs 1,500 bars of
 *                          chart behind it, as the bot needs in its fetch.
 *   · range 96%            4 lots instead of 7: the day's RTH range had already
 *                          covered 96% (>= 90%) of its average -- the mean RTH
 *                          range of the previous 10 sessions. Needs 11+ days
 *                          of chart.
 *   gold line + BUY STOP   the stop-entry: signal close +/- 0.15 x ATR. Starts
 *                          ON the signal candle, where the levels are fixed;
 *                          the bot places it one bar later and it can fill for
 *                          10 bars after that. If the stop would already be
 *                          through the market, the bot re-places it as a LIMIT
 *                          at the same price (it then needs a retrace).
 *   red line + SL          stop: signal close -/+ min(5 x ATR, the $1,000 day
 *                          cap at this size -- 71.4 pts at 7 lots, 125 at 4)
 *   green line + TP        target: signal close +/- 1.75 x ATR
 *                          Both drawn at the tick the bot's bracket rests on:
 *                          it sends them as whole ticks from the stop-entry.
 *   ● BOUGHT 7 @ price     the fill
 *   orange line            the 40-MINUTE CHECKPOINT: fill +/- 1 ATR. If price
 *                          has not reached it by the close of the 20th bar
 *                          after the entry bar, the bot closes at the next open.
 *   TP / SL / TIME 40m /   the exit, with the trade's P&L in dollars (after
 *   FLIP / FLAT  +$ -$     $0.75/side commission, no slippage)
 *   no fill                a stop-entry that expired unfilled
 *
 * NOT MODELLED (the indicator cannot see your account):
 *   - the $500 circuit breaker and $750 profit block, which stop NEW arms once
 *     the day's realised P&L crosses them
 *   - the platform's $1,000 day cap after a loss: the bot tightens the stop as
 *     the day goes red. Drawn stops assume a flat day.
 *   - the ORB book owning the account, if it is still enabled
 * So a signal the bot skipped is usually one of those three.
 *
 * Verified in Node against the bot's golden fixture and seven years of data,
 * including the 2026 rules against research/lib_shipped.mjs -- see
 * tradovate/verify.mjs.
 */

const predef = require("./tools/predef");
const meta = require("./tools/meta");
// Markers and labels use the graphics module. Guarded so that if it is missing
// or named differently, the LINES still load and only the text is lost -- it
// has its own on/off switches (showMarkers, showLineLabels).
let du = (v) => v, px = null, op = null;
try {
  const g = require("./tools/graphics");
  du = g.du || du; px = g.px || null; op = g.op || null;
} catch (e) { /* lines still work */ }
// x at a bar, nudged sideways by a few pixels when the graphics module allows
const xAt = (idx, dpx) => (op && px && dpx ? op(du(idx), "+", px(dpx)) : du(idx));

// ── the rules (bot CONFIG, plus the 2026 changes marked NEW) ─────────────
const CFG = {
  period: 30, adxMin: 25, adxPeriod: 14, atrPeriod: 14, cooldownBars: 1,
  effPeriod: 20, effMin: 0.5,
  rescueMin: 0.45,                 // slow-trend rescue: eff_rescue_min
  trendFast: 125, trendSlow: 500,  // 2-min EMAs: trend_ema_fast / trend_ema_slow
  trendMinBars: 1500,              // trend_min_bars_2m: history before a rescue counts
  startCt: 510, endCt: 900,        // signal bars opening 08:30 <= t < 15:00 CT; also the RTH range window
  noEntryCt: 895,                  // no new arm at/after 14:55 CT
  flattenCt: 904,                  // force flat 15:04 CT
  trigAtr: 0.15, armBars: 10,      // stop-entry offset and window
  slAtr: 5, tpAtr: 1.75,           // bracket, anchored to the signal close
  contracts: 7,                    // NEW: base size (was 8)
  lateContracts: 4,                // NEW: size once the day's range is extended
  lateRangeAdr: 0.9,               // NEW: ...at >= 90% of the 10-session average RTH range
  adrSessions: 10,
  timeExitBars: 20, timeExitAtr: 1,  // NEW: out if not +1 ATR by the 20th bar after entry
  dayCapUsd: 1000, pointValue: 2,  // platform day-loss cap
  commission: 0.75,                // $ per contract per side, for the P&L labels
  slip: 0.25,                      // one tick, used only by the research switch
  tick: 0.25, tfMs: 120000,
};

// ── time: UTC -> America/Chicago with US DST rules, no Intl dependency ───
function nthSunday(y, m, n) {
  const dow = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return 1 + ((7 - dow) % 7) + 7 * (n - 1);
}
function ctOffsetH(ms) {
  const y = new Date(ms).getUTCFullYear();
  const dstOn = Date.UTC(y, 2, nthSunday(y, 2, 2), 8);   // 02:00 CST = 08:00 UTC
  const dstOff = Date.UTC(y, 10, nthSunday(y, 10, 1), 7); // 02:00 CDT = 07:00 UTC
  return ms >= dstOn && ms < dstOff ? -5 : -6;
}
function ctOf(ms) {
  const t = new Date(ms + ctOffsetH(ms) * 3600000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}
// The CME session a bar belongs to, as a day number: sessions roll over at
// 16:00 CT (17:00 New York), inside the daily halt, so a Sunday-evening bar
// belongs to Monday's session. Same numbering as the research data's tday.
function sessionOf(ms) {
  return Math.floor((ms + (ctOffsetH(ms) + 8) * 3600000) / 86400000);
}
function roundTick(p) { return Math.floor(p / CFG.tick + 0.5) * CFG.tick; }
// Python's round(): halves go to the even neighbour. The bot sizes its bracket
// with it, so the drawn stop and target land on the same tick the bot's do.
function roundHalfEven(x) {
  const f = Math.floor(x), r = x - f;
  return r > 0.5 ? f + 1 : r < 0.5 ? f : (f % 2 === 0 ? f : f + 1);
}
const NO_HIST = [];

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
  const plain = raw !== 0 && inWin && effOk ? raw : 0;

  // The slow trend: the bot's trend_series, the same first-value-seeded EMA.
  // Seeded at the chart's first bar, so it only counts once `trendMinBars` bars
  // sit behind it -- the chart's version of the bot refusing a short fetch.
  const aF = 2 / (K.trendFast + 1), aS = 2 / (K.trendSlow + 1);
  const tF = prev ? aF * c + (1 - aF) * prev.tF : c;
  const tS = prev ? aS * c + (1 - aS) * prev.tS : c;
  const trend = Math.sign(tF - tS) || 0;
  const settled = i + 1 >= K.trendMinBars;
  // A breakout just under the efficiency floor still counts when the slow
  // trend points the way it broke. It can only ADD to the plain gate.
  const rescued = plain === 0 && raw !== 0 && inWin && K.rescueMin > 0 && settled &&
                  Number.isFinite(eff) && eff >= K.rescueMin && trend === raw;
  const sig = plain !== 0 ? plain : rescued ? raw : 0;

  // NEW -- how much of its usual range the day has already covered: the RTH
  // range so far (this bar included) against the mean full RTH range of the
  // previous `adrSessions` sessions that had one.
  const sk = sessionOf(ms);
  let hist = prev ? prev.hist : NO_HIST, rHi = NaN, rLo = NaN;
  if (prev && prev.sk === sk) { rHi = prev.rHi; rLo = prev.rLo; }
  else if (prev) hist = hist.concat([prev.rHi > prev.rLo ? prev.rHi - prev.rLo : NaN]).slice(-K.adrSessions);
  if (inWin) { rHi = Number.isNaN(rHi) ? h : Math.max(rHi, h); rLo = Number.isNaN(rLo) ? l : Math.min(rLo, l); }
  let sum = 0, cnt = 0;
  for (const r of hist) if (r > 0) { sum += r; cnt++; }
  const adrPts = cnt ? sum / cnt : NaN;
  const used = adrPts > 0 && Number.isFinite(rHi) ? (rHi - rLo) / adrPts : 0;
  const lots = K.lateRangeAdr > 0 && used >= K.lateRangeAdr ? K.lateContracts : K.contracts;

  return { o, h, l, c, ms, ct, tr, atr, trX, pdmX, ndmX, adx, path, eff, dh, dl,
           raw, lastRaw: raw ? i : lastRaw, plain, tF, tS, trend, settled, rescued, sig,
           sk, hist, rHi, rLo, adrPts, used, lots };
}

// The order a signal on bar `sb` arms, in the live bot's price convention:
// stop-entry off the signal close, rounded to a real price; stop capped at
// the $1,000 day cap for this size. The bot sends the stop and target as whole
// TICKS from the stop-entry price, so these are the prices they actually rest
// at once it fills there.
function armLevels(sb, dir, K) {
  const a = sb.atr, lots = sb.lots, ref = sb.c;
  const capPts = K.dayCapUsd / (K.pointValue * lots);
  const slD = Math.min(Math.max(a * K.slAtr, K.tick), capPts);
  const tpD = Math.max(a * K.tpAtr, K.tick);
  const px = roundTick(ref + dir * Math.max(a * K.trigAtr, K.tick));
  const slT = Math.max(1, roundHalfEven(Math.abs(px - (ref - dir * slD)) / K.tick));
  const tpT = Math.max(1, roundHalfEven(Math.abs(ref + dir * tpD - px) / K.tick));
  return { px, ref, lots, slD, tpD, sl: px - dir * slT * K.tick, tp: px + dir * tpT * K.tick };
}

// ── the bot's order lifecycle, one bar at a time (research/lib_shipped.mjs) ──
const FLAT0 = { pos: 0, dir: 0, ep: 0, sl: 0, tp: 0, fill: 0, posSet: 0, lots: 0,
                entBar: -1, entAtr: 0, mx: 0, mn: 0,
                armDir: 0, armPx: 0, armBar: -1, armBy: -1, armEp: 0, armLots: 0, armAtr: 0,
                armSlPx: 0, armTpPx: 0,
                armSlD: 0, armTpD: 0, isLimit: false, armSet: 0, armCount: 0 };

function stepOrders(S0, B, prevB, i, K) {
  const S = Object.assign({}, S0);
  const ev = {};
  const s2 = prevB ? prevB.sig : 0;
  const flatNow = B.ct >= K.flattenCt || B.ct < K.startCt;

  // 1. a parked or working arm
  if (S.pos === 0 && S.armDir !== 0) {
    if (flatNow || i > S.armBy) {
      ev.expire = { dir: S.armDir, px: S.armPx };
      S.armDir = 0;
    } else if (i > S.armBar) {
      const a = S.armDir, p = S.armPx;
      let hit;
      if (i === S.armBar + 1 && !S.isLimit && (a === 1 ? B.o >= p : B.o <= p)) {
        // The stop would be refused: price is already through it. The bot
        // re-places the SAME price as a limit, which now needs a retrace.
        S.isLimit = true;
        hit = a === 1 ? B.l <= p : B.h >= p;
      } else {
        hit = S.isLimit ? (a === 1 ? B.l <= p : B.h >= p)
                        : (a === 1 ? B.h >= p : B.l <= p);
      }
      if (hit) {
        S.pos = a; S.dir = a; S.fill = p; S.posSet = S.armSet; S.armDir = 0;
        S.lots = S.armLots; S.entBar = i; S.entAtr = S.armAtr; S.mx = p; S.mn = p;
        if (K.research) {
          // lib_shipped: stop is the nearer of 5xATR from the reference and the
          // $1,000 cap measured from the slipped fill (first trade of a day).
          const avg = p + a * K.slip;
          const lossPx = avg - a * (K.dayCapUsd / (K.pointValue * S.lots));
          const rawSl = S.armEp - a * S.armSlD;
          S.sl = a === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
          S.capped = a === 1 ? (S.sl === lossPx && lossPx > rawSl) : (S.sl === lossPx && lossPx < rawSl);
          S.tp = S.armEp + a * S.armTpD;
        } else {
          S.sl = S.armSlPx;                 // the prices the bot's bracket rests at
          S.tp = S.armTpPx;
          S.capped = false;
        }
        ev.fill = { dir: a, px: p, limit: S.isLimit, lots: S.lots };
      }
    }
  }

  // 2. an open position
  if (S.pos !== 0) {
    if (flatNow) { ev.exit = { why: "FLAT", px: B.o }; S.pos = 0; return { S, ev }; }
    const d = S.pos, sl = S.sl, tp = S.tp;
    // Best and worst price since the fill, as of the last CLOSED bar: the
    // entry bar counts by its close only, since its range may predate the fill.
    if (prevB && i - 1 >= S.entBar) {
      if (i - 1 === S.entBar) { S.mx = Math.max(S.mx, prevB.c); S.mn = Math.min(S.mn, prevB.c); }
      else { S.mx = Math.max(S.mx, prevB.h); S.mn = Math.min(S.mn, prevB.l); }
    }
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
    // NEW -- the 40-minute exit: 20 bars closed after the entry bar and price
    // never reached 1 ATR (the signal bar's) in the trade's favour.
    if (K.timeExitBars > 0 && i - 1 - S.entBar >= K.timeExitBars) {
      const avg = K.research ? S.fill + d * K.slip : S.fill;
      const fav = d === 1 ? S.mx - avg : avg - S.mn;
      if (fav < K.timeExitAtr * S.entAtr) { ev.exit = { why: "TIME", px: B.o }; S.pos = 0; return { S, ev }; }
    }
    if (s2 !== 0 && s2 !== S.pos) { ev.exit = { why: "FLIP", px: B.o }; S.pos = 0; }
    if (S.pos !== 0) return { S, ev };
  }

  // 3. the previous bar's signal arms a stop-entry (a newer one replaces it)
  if (S.pos === 0 && s2 !== 0 && !flatNow && B.ct < K.noEntryCt) {
    const a = prevB.atr;
    if (a > 0) {
      const lots = prevB.lots;                      // sized on the signal bar
      let ref, pxA, slD, tpD, slPx, tpPx;
      if (K.research) {
        ref = B.o;
        pxA = ref + s2 * Math.max(a * K.trigAtr, K.tick);
        slD = Math.max(a * K.slAtr, K.tick);
        tpD = Math.max(a * K.tpAtr, K.tick);
        slPx = ref - s2 * slD; tpPx = ref + s2 * tpD;
      } else {
        const L = armLevels(prevB, s2, K);
        ref = L.ref; pxA = L.px; slD = L.slD; tpD = L.tpD; slPx = L.sl; tpPx = L.tp;
      }
      S.isLimit = false;
      S.armDir = s2; S.armBar = i; S.armBy = i + K.armBars; S.armEp = ref; S.armPx = pxA;
      S.armSlD = slD; S.armTpD = tpD; S.armSlPx = slPx; S.armTpPx = tpPx; S.armLots = lots; S.armAtr = a;
      S.armSet = S.armCount % NSETS; S.armCount = S.armCount + 1;
      ev.arm = { dir: s2, px: pxA, ref, lots, sl: slPx, tp: tpPx };
    }
  }
  return { S, ev };
}

// Will the bot arm a signal on bar B at the next bar? Everything that decides
// it is known at B's close except an exit the NEXT bar could trigger first
// (a resting arm filling, or the open position stopping out), which is rare.
function previewArm(S, B, K) {
  if (B.sig === 0 || S.pos === B.sig || !(B.atr > 0)) return null;
  const nct = ctOf(B.ms + K.tfMs);
  if (nct < K.startCt || nct >= K.noEntryCt || nct >= K.flattenCt) return null;
  return armLevels(B, B.sig, K);
}

// Lines rotate through three plot sets, so an exiting position, the order that
// replaces it and the next signal's preview never share one (a plot joins every
// value it is given, so sharing would draw a diagonal between them).
const NSETS = 3, SETS = ["A", "B", "C"];

const usd = (v) => (v >= 0 ? "+$" : "-$") + String(Math.round(Math.abs(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const COL = { up: "#26a65b", dn: "#d1566e", gold: "#e0c341", time: "#e0893a", grey: "#9aa4b2" };

// ── Tradovate calculator ─────────────────────────────────────────────────
class mnqDonchianBot {
  init() {
    this.bars = [];
    this.orders = [];
  }

  map(d, i) {
    const P = this.props || {};
    const K = Object.assign({}, CFG, {
      contracts: Math.max(1, Number(P.contracts) || CFG.contracts),
      lateContracts: Math.max(1, Number(P.lateContracts) || CFG.lateContracts),
      lateRangeAdr: Number.isFinite(Number(P.lateRangeAdr)) && P.lateRangeAdr !== undefined
        ? Number(P.lateRangeAdr) : CFG.lateRangeAdr,
      timeExitBars: Number.isFinite(Number(P.timeExitBars)) && P.timeExitBars !== undefined
        ? Number(P.timeExitBars) : CFG.timeExitBars,
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
    const text = (key, x, y, str, fill, align, size, bold) => items.push({
      tag: "Text", key: key + idx, point: { x, y: du(y) }, text: str,
      style: { fontSize: size || 11, fontWeight: bold ? "bold" : "normal", fill },
      textAlignment: align || "centerMiddle" });
    const wrongTf = idx >= 20 && B.minGap !== K.tfMs;
    if (wrongTf) {
      if (B.ct === K.startCt || idx === 20) {
        text("tf", du(idx), B.h, "mnqDonchianBot needs a 2-MINUTE chart", COL.gold, "centerMiddle", 13, true);
      }
      if (P.showMarkers !== false && items.length) out.graphics = { items };
      return out;
    }

    if (P.showChannel !== false && Number.isFinite(B.dh)) { out.dcHigh = B.dh; out.dcLow = B.dl; }
    // The trend EMAs, drawn only once settled: before that they are the bot's
    // "not enough history" case and would show a trend the bot would not use.
    if (P.showTrend !== false && B.settled) { out.trendFast = B.tF; out.trendSlow = B.tS; }

    // Lines alternate between two plot sets so consecutive arms are never
    // joined by a diagonal: a plot connects every value it is given.
    const put = (set, key, v) => { out[key + SETS[set]] = v; };
    // (a) The signal candle itself carries the levels its order will rest at,
    // so every line starts exactly where the signal fires. They are fixed by
    // this bar's close and ATR; the bot places the order one bar later.
    const pre = K.research ? null : previewArm(S, B, K);
    if (pre) {
      const set = S.armCount % NSETS;              // the set the arm will take
      put(set, "trig", pre.px); put(set, "stop", pre.sl); put(set, "target", pre.tp);
    }
    // (b) the working stop-entry
    if (S.armDir !== 0) {
      put(S.armSet, "trig", S.armPx);
      put(S.armSet, "stop", S.armSlPx);
      put(S.armSet, "target", S.armTpPx);
    }
    // (c) the position. On an exit bar the state still carries that trade's
    // bracket (only pos is cleared), including a fill and exit on one bar.
    if (S.pos !== 0 || ev.exit) {
      put(S.posSet, "stop", S.sl);
      put(S.posSet, "target", S.tp);
    }
    // (d) the 40-minute checkpoint, until it is reached or the clock runs out
    let checkPx = NaN;
    if (S.pos !== 0 && K.timeExitBars > 0 && idx - S.entBar <= K.timeExitBars) {
      // Measured the way the exit rule measures it: the entry bar by its
      // close only, every later bar by its high (long) or low (short).
      const need = K.timeExitAtr * S.entAtr;
      const hi = idx === S.entBar ? B.c : B.h, lo = idx === S.entBar ? B.c : B.l;
      const best = S.dir === 1 ? Math.max(S.mx, hi) - S.fill : S.fill - Math.min(S.mn, lo);
      if (best < need) { checkPx = S.fill + S.dir * need; if (P.showCheckpoint !== false) put(S.posSet, "check", checkPx); }
    }

    if (P.showMarkers !== false) {
      const off = Math.max(B.atr * 0.35, K.tick * 4);
      const labels = P.showLineLabels !== false;
      if (B.sig !== 0) {
        const long = B.sig === 1;
        const mark = B.rescued ? (long ? "△" : "▽") : (long ? "▲" : "▼");
        let str = mark;
        if (pre) {
          const why = [];
          if (B.rescued) why.push("trend");
          if (pre.lots < K.contracts) why.push("range " + Math.round(100 * B.used) + "%");
          // what the order does to what is already there
          if (S.pos === -B.sig) why.push("flip");
          else if (S.armDir !== 0) why.push("moves stop");
          str = mark + " " + (long ? "BUY " : "SELL ") + pre.lots + (why.length ? " · " + why.join(" · ") : "");
        }
        text("s", du(idx), long ? B.l - off : B.h + off, str, long ? COL.up : COL.dn, "centerMiddle", 13, true);
        if (pre && labels) {
          // price tags ending at the signal candle, on the line they name
          text("lt", xAt(idx, -6), pre.px, (long ? "BUY STOP " : "SELL STOP ") + pre.px.toFixed(2), COL.gold, "rightMiddle", 10);
          text("ls", xAt(idx, -6), pre.sl, "SL " + pre.sl.toFixed(2), COL.dn, "rightMiddle", 10);
          text("lp", xAt(idx, -6), pre.tp, "TP " + pre.tp.toFixed(2), COL.up, "rightMiddle", 10);
        }
      }
      if (ev.fill) {
        const f = ev.fill;
        text("f", du(idx), f.px, "●", COL.gold, "centerMiddle", 12, true);
        text("fl", xAt(idx, 8), f.px, (f.dir === 1 ? "BOUGHT " : "SOLD ") + f.lots + " @ " + f.px.toFixed(2) +
             (f.limit ? " (limit)" : ""), COL.gold, "leftMiddle", 10);
        if (labels && K.timeExitBars > 0 && P.showCheckpoint !== false && Number.isFinite(checkPx)) {
          text("fc", xAt(idx, 8), checkPx, "+1 ATR by " + (2 * K.timeExitBars) + "m", COL.time, "leftMiddle", 9);
        }
      }
      if (ev.exit) {
        const x = ev.exit;
        const pnl = (x.px - S.fill) * S.dir * K.pointValue * S.lots - 2 * K.commission * S.lots;
        const name = x.why === "TIME" ? "TIME " + (2 * K.timeExitBars) + "m" : x.why;
        const fill = x.why === "TP" ? COL.up : x.why === "SL" ? COL.dn : x.why === "TIME" ? COL.time : COL.grey;
        text("x", xAt(idx, 8), x.px, name + " " + usd(pnl), fill, "leftMiddle", 11, true);
      }
      if (ev.expire) text("e", xAt(idx - 1, 6), ev.expire.px, "no fill", COL.grey, "leftMiddle", 9);
      if (items.length) out.graphics = { items };
    }
    // Harness-only: the events behind the drawing, so tradovate/verify.mjs can
    // check them. Tradovate ignores keys that are not declared plots.
    if (P.__research !== undefined) out._ev = { sig: B.sig, raw: B.raw, ev, S, B, pre };
    return out;
  }
}

module.exports = {
  name: "mnqDonchianBot",
  description: "MNQ Donchian — bot mirror, 2026 rules (2-min chart)",
  calculator: mnqDonchianBot,
  params: {
    contracts: predef.paramSpecs.period(7),
    lateContracts: predef.paramSpecs.period(4),
    lateRangeAdr: predef.paramSpecs.number(0.9, 0.05, 0),
    timeExitBars: predef.paramSpecs.period(20),
    showChannel: predef.paramSpecs.bool(true),
    showTrend: predef.paramSpecs.bool(true),
    showMarkers: predef.paramSpecs.bool(true),
    showLineLabels: predef.paramSpecs.bool(true),
    showCheckpoint: predef.paramSpecs.bool(true),
    barTimeIsClose: predef.paramSpecs.bool(false),
  },
  inputType: meta.InputType.BARS,
  areaChoice: (meta.AreaChoice || {}).OVERLAY,
  plots: {
    dcHigh: { title: "Donchian high" },
    dcLow: { title: "Donchian low" },
    trendFast: { title: "Trend EMA 125" },
    trendSlow: { title: "Trend EMA 500" },
    trigA: { title: "Stop-entry" }, stopA: { title: "Stop" }, targetA: { title: "Target" },
    checkA: { title: "40-min checkpoint" },
    trigB: { title: "Stop-entry (2)" }, stopB: { title: "Stop (2)" }, targetB: { title: "Target (2)" },
    checkB: { title: "40-min checkpoint (2)" },
    trigC: { title: "Stop-entry (3)" }, stopC: { title: "Stop (3)" }, targetC: { title: "Target (3)" },
    checkC: { title: "40-min checkpoint (3)" },
  },
  tags: ["MNQ bot"],
  schemeStyles: {
    dark: {
      dcHigh: { color: "#3d7a5a" }, dcLow: { color: "#7a3d3d" },
      trendFast: { color: "#4a6f99" }, trendSlow: { color: "#6f5a99" },
      trigA: { color: "#e0c341" }, stopA: { color: "#d1566e" }, targetA: { color: "#26a65b" },
      checkA: { color: "#e0893a" },
      trigB: { color: "#e0c341" }, stopB: { color: "#d1566e" }, targetB: { color: "#26a65b" },
      checkB: { color: "#e0893a" },
      trigC: { color: "#e0c341" }, stopC: { color: "#d1566e" }, targetC: { color: "#26a65b" },
      checkC: { color: "#e0893a" },
    },
  },
};
