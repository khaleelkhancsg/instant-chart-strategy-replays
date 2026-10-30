/*
 * MNQ Donchian — for a $1,250-target evaluation.          APPLY TO A 2-MINUTE CHART.
 *
 * Built for these account rules: $1,250 profit target, $1,000 trailing maximum
 * loss, $600 daily loss limit, 50% consistency. On 2026 data (honest fills,
 * realistic costs) this setup passed 71.1% of 21-day windows (Jan-Mar 74.3%,
 * Apr-Jul 75.1%), against 61.3% without its 10-minute EMA filter --
 * research/donchian_ema_age_2026.mjs in the backtesting project. Forward, on
 * TopstepX bars after that data ends (Sep 10 - Oct 26 2026): 23 trades, +$2,532,
 * all 17 calendar windows passed. bot/mnq_donchian1250_bot.py trades these rules;
 * this indicator draws them on the chart.
 *
 * THE SETUP
 *   signal    2-min close outside the PREVIOUS 30 bars' high/low, ADX(14) >= 25,
 *             efficiency(20) >= 0.5, bar opening 08:30 <= t < 15:00 CT. Or the
 *             slow-trend rescue: efficiency 0.45-0.5 when the 2-min EMA 125 is on
 *             the breakout's side of the EMA 500 (needs 1,500 bars of chart).
 *   filter    an order only if the 10-MINUTE EMA 9 is on the breakout's side of
 *             the 10-minute EMA 21: the breakout goes WITH the last few hours'
 *             trend. 10-minute bars are built from the chart's 2-min bars and
 *             count once they have closed. A breakout against it places no
 *             order, but still closes an opposite trade and cancels a resting
 *             order the other way. (It works on the day's first breakout, which
 *             is mostly what the day rules let through.)
 *   size      4 lots; 2 once the day's RTH range has covered 90% of its average
 *             (the mean RTH range of the previous 10 sessions)
 *   entry     a stop 0.15 x ATR beyond the signal close, placed one bar later,
 *             live for 10 bars; re-placed as a LIMIT at the same price if price
 *             is already through it
 *   bracket   stop 5 x ATR from the signal close, or nearer where the day would
 *             reach the $600 limit after commission (at 4 lots that is nearly
 *             always the stop: ~75 points); target 1.75 x ATR from the signal close
 *   exits     the bracket; out at the next open if the trade has not been 1 ATR
 *             in profit by the 20th bar after entry (40 minutes); an opposite
 *             signal (which also cancels a resting stop-entry); flat at 15:06 CT
 *             (the first bar opening at or after 15:05). On a scheduled early
 *             close (EARLY below): no new order from 15 minutes before Topstep's
 *             cutoff, flat from 5 before it. A session that ends early without
 *             being on that list: out at its last close. The 40-minute exit and the opposite signal are decided on a closed
 *             bar and happen at the next open -- before that bar can touch the
 *             stop or target; only a gap through the stop at the open is first
 *   day       stop for the day once it is -$300 (breaker), +$250 (profit block)
 *             or at the -$600 limit. The +$250 block is what keeps every day
 *             under the $625 the consistency rule allows at a $1,250 pass.
 *
 * WHAT IS DRAWN
 *   thin green/red lines   the Donchian channel (previous 30 bars)
 *   ▲ BUY 4 / ▼ SELL 4     a signal and the order it places. Qualifiers:
 *                          · trend (rescued), · range 93% (late-day 2 lots),
 *                          · moves stop if unfilled (a resting stop-entry the
 *                          same way keeps the next bar, then moves here),
 *                          · cancels sell stop (one resting the other way is
 *                          cancelled at the next open), · flip (reverses an
 *                          open trade). ▲ · closes trade: exits the open trade,
 *                          no new order. A bare ▲ (already in that trade) or
 *                          ▲ · too late places nothing. Not drawn once the day
 *                          is done
 *   ADX 39 · eff 0.53 ...  under the first order of a run: why it fired (showWhy). The readings
 *                          the rules used -- ADX (25 or more), efficiency (0.5
 *                          or more; "+ trend" when the slow trend rescued it),
 *                          the 10-minute EMA direction, and the share of its
 *                          usual range the day has covered. Rounded DOWN, so a
 *                          reading never prints on the wrong side of its rule
 *   30-bar high 29120.50   the level the close broke (showWhy): a short line
 *                          from the bar that set it to the signal bar
 *   × ADX 21 · eff 0.42    grey: a close outside the channel that is NOT a
 *                          signal, and the reading that refused it: ADX under
 *                          25, or efficiency under 0.5 ("vs trend": 0.45-0.5
 *                          with the slow trend against). First bar of a run
 *                          outside the channel only; nothing else happens
 *   ▲ vs 10m trend         grey: a breakout against the 10-minute EMA trend,
 *                          not traded (it can still close a trade or cancel an
 *                          order). showSkipped off hides the grey marks that
 *                          do neither
 *   blue / purple lines    the 10-minute EMA 9 and 21 (showEma)
 *   gold / red / green     stop-entry, stop, target -- starting ON the signal
 *                          candle, with price tags there; "· day limit" when
 *                          the $600 line sets the stop
 *   ● BOUGHT 4 @ price     the fill
 *   orange line            the 40-minute checkpoint: fill +/- 1 ATR
 *   TP / SL / TIME 40m /   the exit, with the trade's dollars ($0.75/side
 *   FLIP / FLAT            commission, no slippage)
 *   DAY DONE +$312         the day stopped: profit block, breaker or limit
 *   no fill / cancelled    a stop-entry that expired, or that a signal the
 *                          other way cancelled at the next open
 *
 * The day rules are modelled from THIS indicator's own trades, so it assumes
 * the account trades nothing else. Verified in Node against the research engine
 * on every trade, and every reading it prints against the chart lab's own
 * explanation of that bar -- tradovate/verify_1250.mjs in the backtesting project.
 */

const predef = require("./tools/predef");
const meta = require("./tools/meta");
// Markers and labels use the graphics module. Guarded so that if it is missing
// or named differently, the LINES still load and only the text is lost.
let du = (v) => v, px = null, op = null;
try {
  const g = require("./tools/graphics");
  du = g.du || du; px = g.px || null; op = g.op || null;
} catch (e) { /* lines still work */ }
const xAt = (idx, dpx) => (op && px && dpx ? op(du(idx), "+", px(dpx)) : du(idx));

const CFG = {
  period: 30, adxMin: 25, adxPeriod: 14, atrPeriod: 14, cooldownBars: 1,
  effPeriod: 20, effMin: 0.5,
  rescueMin: 0.45, trendFast: 125, trendSlow: 500, trendMinBars: 1500,
  startCt: 510, endCt: 900,        // signal bars opening 08:30 <= t < 15:00 CT; also the RTH range window
  noEntryCt: 895,                  // no new order at/after 14:55 CT
  flattenCt: 905,                  // force flat on the first bar opening at/after 15:05 CT: 15:06 here
  trigAtr: 0.15, armBars: 10,      // stop-entry offset and window
  slAtr: 5, tpAtr: 1.75,           // bracket, anchored to the signal close
  contracts: 4, lateContracts: 2, lateRangeAdr: 0.9, adrSessions: 10,
  timeExitBars: 20, timeExitAtr: 1,
  emaFilter: true, emaTf: 10, emaFast: 9, emaSlow: 21,   // trade only WITH the 10-min EMA 9/21
  dayLossLimit: 600, breaker: 300, profitBlock: 250,
  pointValue: 2, commission: 0.75, slip: 0.25, tick: 0.25, tfMs: 120000,
};

// Early closes: Topstep's close-positions-by time (CT minutes) by session, as the
// bot has them (EARLY_CUTOFF in bot/donchian1250_core.py). Add each year's dates.
const EARLY = [["2026-11-26", 705], ["2026-11-27", 720], ["2026-12-24", 720]]
  .reduce((m, e) => { m[Date.parse(e[0]) / 86400000] = e[1]; return m; }, {});

// ── time: UTC -> America/Chicago with US DST rules, no Intl dependency ───
function nthSunday(y, m, n) {
  const dow = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return 1 + ((7 - dow) % 7) + 7 * (n - 1);
}
function ctOffsetH(ms) {
  const y = new Date(ms).getUTCFullYear();
  const dstOn = Date.UTC(y, 2, nthSunday(y, 2, 2), 8);
  const dstOff = Date.UTC(y, 10, nthSunday(y, 10, 1), 7);
  return ms >= dstOn && ms < dstOff ? -5 : -6;
}
function ctOf(ms) {
  const t = new Date(ms + ctOffsetH(ms) * 3600000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}
// The CME session as a day number: rolls over at 16:00 CT, inside the halt.
function sessionOf(ms) { return Math.floor((ms + (ctOffsetH(ms) + 8) * 3600000) / 86400000); }
function roundTick(p) { return Math.floor(p / CFG.tick + 0.5) * CFG.tick; }
const NO_HIST = [];

// ── indicators for bar i, from bar i-1's state only (idempotent on re-calls) ──
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
  let path = prev ? prev.path + Math.abs(c - prev.c) : 0;
  if (i > K.effPeriod) path -= Math.abs(bars[i - K.effPeriod].c - bars[i - K.effPeriod - 1].c);
  const eff = i >= K.effPeriod ? (path === 0 ? 0 : Math.abs(c - bars[i - K.effPeriod].c) / path) : NaN;
  let dh = NaN, dl = NaN, dhAt = -1, dlAt = -1;                 // the channel, and the latest bars that set it
  if (i >= K.period) {
    dh = -Infinity; dl = Infinity;
    for (let j = i - K.period; j < i; j++) {
      if (bars[j].h >= dh) { dh = bars[j].h; dhAt = j; }
      if (bars[j].l <= dl) { dl = bars[j].l; dlAt = j; }
    }
  }
  const side = i >= K.period ? (c > dh ? 1 : c < dl ? -1 : 0) : 0;   // which side of the channel this close is
  const lastRaw = prev ? prev.lastRaw : -1e9;
  const raw = side !== 0 && !(i - lastRaw < K.cooldownBars) && !(adx < K.adxMin) ? side : 0;
  const ct = ctOf(ms);
  const inWin = K.startCt <= ct && ct < K.endCt;
  const effOk = !(K.effMin > 0) || (Number.isFinite(eff) && eff >= K.effMin);
  const plain = raw !== 0 && inWin && effOk ? raw : 0;
  const aF = 2 / (K.trendFast + 1), aS = 2 / (K.trendSlow + 1);
  const tF = prev ? aF * c + (1 - aF) * prev.tF : c;
  const tS = prev ? aS * c + (1 - aS) * prev.tS : c;
  const trend = Math.sign(tF - tS) || 0;
  const settled = i + 1 >= K.trendMinBars;
  const rescued = plain === 0 && raw !== 0 && inWin && K.rescueMin > 0 && settled &&
                  Number.isFinite(eff) && eff >= K.rescueMin && trend === raw;
  const sig = plain !== 0 ? plain : rescued ? raw : 0;
  // how much of its usual range the day has covered
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
  // The last few hours' trend: EMA fast/slow on clock-aligned emaTf-minute bars
  // built from these 2-min bars (a bucket's close is its last 2-min close). A
  // bucket counts once it has closed -- at the close of its last 2-min slot, or
  // when the next bucket's first bar arrives -- so the reading is always from a
  // finished bar. EMAs seeded with the first close, alpha 2/(n+1).
  const bMs = K.emaTf * 60000, bkt = Math.floor(ms / bMs);
  let hF = prev ? prev.hF : NaN, hS = prev ? prev.hS : NaN, hLast = prev ? prev.hLast : NaN;
  const aHF = 2 / (K.emaFast + 1), aHS = 2 / (K.emaSlow + 1);
  const close10 = (x) => { hF = Number.isFinite(hF) ? aHF * x + (1 - aHF) * hF : x; hS = Number.isFinite(hS) ? aHS * x + (1 - aHS) * hS : x; };
  if (prev && prev.bkt !== bkt && hLast !== prev.bkt) { close10(prev.c); hLast = prev.bkt; }
  if (ms - bkt * bMs === bMs - K.tfMs) { close10(c); hLast = bkt; }
  const htf = Number.isFinite(hF) ? Math.sign(hF - hS) || 0 : 0;
  const enter = sig !== 0 && (!K.emaFilter || htf === sig);
  const cut = EARLY[sk];                                     // today's times: an early close moves them
  const flatCt = cut ? Math.min(K.flattenCt, cut - 5) : K.flattenCt, noEntryCt = cut ? Math.min(K.noEntryCt, cut - 15) : K.noEntryCt;
  return { o, h, l, c, ms, ct, tr, atr, trX, pdmX, ndmX, adx, path, eff, dh, dl, dhAt, dlAt, side,
           raw, lastRaw: raw ? i : lastRaw, inWin, effOk, plain, tF, tS, trend, settled, rescued, sig,
           sk, hist, rHi, rLo, adrPts, used, lots, bkt, hF, hS, hLast, htf, enter, flatCt, noEntryCt };
}

// ── the order a signal arms, in the live price convention ─────────────────
// From the signal close (known at its close): stop-entry rounded to a real
// price; stop 5 ATR away, or nearer where the day would reach the loss limit
// after this trade's commission (rounded toward the entry); target 1.75 ATR.
// null when the day has no room left for a 1-tick stop.
function armLevels(sb, dir, K, dayReal) {
  const a = sb.atr, lots = sb.lots, ref = sb.c, T = K.tick;
  const p = roundTick(ref + dir * Math.max(a * K.trigAtr, T));
  const budget = K.dayLossLimit + dayReal - 2 * K.commission * lots;
  if (!(budget >= K.pointValue * lots * T)) return null;
  const capPx = p - dir * (budget / (K.pointValue * lots));
  const cap = dir === 1 ? Math.ceil(capPx / T - 1e-9) * T : Math.floor(capPx / T + 1e-9) * T;
  const raw = roundTick(ref - dir * Math.max(a * K.slAtr, T));
  const capped = dir === 1 ? cap > raw : cap < raw;
  return { px: p, ref, lots, sl: capped ? cap : raw, capped, tp: roundTick(ref + dir * Math.max(a * K.tpAtr, T)) };
}

// ── the order lifecycle with the day rules (research/lib_shipped.mjs) ─────
const FLAT0 = { pos: 0, dir: 0, sl: 0, tp: 0, fill: 0, posSet: 0, lots: 0, entBar: -1, entAtr: 0, mx: 0, mn: 0,
                capped: false, limFill: false,
                armDir: 0, armPx: 0, armBar: -1, armBy: -1, armEp: 0, armLots: 0, armAtr: 0, armSlD: 0, armTpD: 0,
                armSlPx: 0, armTpPx: 0, armCapped: false, isLimit: false, armSet: 0, armCount: 0,
                dayReal: 0, capHit: false };
const NSETS = 3, SETS = ["A", "B", "C"];
const blockedOf = (S, K) => S.capHit || (K.breaker > 0 && S.dayReal <= -K.breaker) || (K.profitBlock > 0 && S.dayReal >= K.profitBlock);
const blockReason = (S, K) => (S.capHit ? "daily limit" : K.profitBlock > 0 && S.dayReal >= K.profitBlock ? "profit block" : "breaker");

function stepOrders(S0, B, prevB, i, K) {
  const S = Object.assign({}, S0);
  const ev = {};
  const s2 = prevB ? prevB.sig : 0;
  const flatNow = B.ct >= B.flatCt || B.ct < K.startCt;
  const book = (xp, why, exact) => {
    const d = S.pos, slip = K.research ? K.slip : 0;
    const avg = S.fill + d * slip, x = d === 1 ? xp - slip : xp + slip;
    const net = exact !== undefined ? exact : (x - avg) * d * K.pointValue * S.lots - 2 * K.commission * S.lots;
    S.dayReal += net;
    if (S.dayReal <= -K.dayLossLimit) S.capHit = true;
    ev.exit = { why, px: xp, pnl: net, capped: why === "SL" && S.capped };
    if (blockedOf(S, K)) ev.dayDone = { reason: blockReason(S, K), day: S.dayReal };
    S.pos = 0;
  };
  // A new session. A trade still open came through a session that ended before
  // the flat time: it is out at that session's last close, on that day's books.
  // (The research ran these to the next open, on the next day's books.)
  if (!prevB || B.sk !== prevB.sk) {
    if (prevB && S.pos !== 0 && !K.research) { book(prevB.c, "FLAT"); ev.exit.early = true; }
    S.dayReal = 0; S.capHit = false;
  }

  // 1. a parked or working stop-entry. A signal the other way cancels it at
  // this open, before it can fill.
  if (S.pos === 0 && S.armDir !== 0) {
    const opposite = s2 !== 0 && s2 !== S.armDir;
    if (flatNow || i > S.armBy || blockedOf(S, K) || opposite) {
      ev.expire = { dir: S.armDir, px: S.armPx, why: opposite ? "cancelled" : "no fill" };
      S.armDir = 0;
    } else if (i > S.armBar) {
      const a = S.armDir, p = S.armPx;
      let hit;
      if (i === S.armBar + 1 && !S.isLimit && (a === 1 ? B.o >= p : B.o <= p)) {
        S.isLimit = true;                         // refused stop: same price as a limit
        hit = a === 1 ? B.l <= p : B.h >= p;
      } else {
        hit = S.isLimit ? (a === 1 ? B.l <= p : B.h >= p) : (a === 1 ? B.h >= p : B.l <= p);
      }
      if (hit) {
        S.pos = a; S.dir = a; S.fill = p; S.posSet = S.armSet; S.armDir = 0; S.limFill = S.isLimit;
        S.lots = S.armLots; S.entBar = i; S.entAtr = S.armAtr; S.mx = p; S.mn = p;
        if (K.research) {
          const avg = p + a * K.slip;
          const lossPx = avg - a * ((K.dayLossLimit + S.dayReal) / (K.pointValue * S.lots));
          const rawSl = S.armEp - a * S.armSlD;
          S.sl = a === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
          S.capped = a === 1 ? (S.sl === lossPx && lossPx > rawSl) : (S.sl === lossPx && lossPx < rawSl);
          S.tp = S.armEp + a * S.armTpD;
        } else {
          S.sl = S.armSlPx; S.tp = S.armTpPx; S.capped = S.armCapped;
        }
        ev.fill = { dir: a, px: p, limit: S.isLimit, lots: S.lots };
      }
    }
  }

  // 2. an open position. In time order: a gap through the stop at this open;
  // then the exits decided on the closed bar -- the 40-minute exit, an opposite
  // signal -- at this open; only then can this bar's range touch the stop or
  // target.
  if (S.pos !== 0) {
    if (flatNow) { book(B.o, "FLAT"); return { S, ev }; }
    const d = S.pos, sl = S.sl, tp = S.tp;
    if (prevB && i - 1 >= S.entBar) {
      if (i - 1 === S.entBar) { S.mx = Math.max(S.mx, prevB.c); S.mn = Math.min(S.mn, prevB.c); }
      else { S.mx = Math.max(S.mx, prevB.h); S.mn = Math.min(S.mn, prevB.l); }
    }
    const capCut = K.research && S.capped ? -K.dayLossLimit - S.dayReal : undefined;
    if (d === 1 ? B.o <= sl : B.o >= sl) { book(B.o, "SL", capCut); return { S, ev }; }
    if (K.timeExitBars > 0 && i - 1 - S.entBar >= K.timeExitBars) {
      const avg = K.research ? S.fill + d * K.slip : S.fill;
      const fav = d === 1 ? S.mx - avg : avg - S.mn;
      if (fav < K.timeExitAtr * S.entAtr) { book(B.o, "TIME"); return { S, ev }; }
    }
    if (s2 !== 0 && s2 !== S.pos) book(B.o, "FLIP");
    else {
      // On the bar a limit filled, the bar's extreme may have printed BEFORE the
      // fill, so the target only counts if the bar also closed beyond it.
      const tpOk = (hit) => hit && !(S.limFill && S.entBar === i && (d === 1 ? B.c < tp : B.c > tp));
      if (d === 1) {
        if (B.l <= sl) { book(sl, "SL", capCut); return { S, ev }; }
        if (tpOk(B.h >= tp)) { book(tp, "TP"); return { S, ev }; }
      } else {
        if (B.h >= sl) { book(sl, "SL", capCut); return { S, ev }; }
        if (tpOk(B.l <= tp)) { book(tp, "TP"); return { S, ev }; }
      }
      return { S, ev };
    }
  }

  // 3. the previous bar's signal arms a stop-entry (a newer one replaces it) --
  // if the 10-minute EMA filter lets it through
  if (S.pos === 0 && s2 !== 0 && prevB.enter && !flatNow && !blockedOf(S, K) && B.ct < B.noEntryCt) {
    const a = prevB.atr, lots = prevB.lots;
    let L = null;
    if (!(a > 0)) L = null;
    else if (K.research) {
      const ref = B.o, slD = Math.max(a * K.slAtr, K.tick), tpD = Math.max(a * K.tpAtr, K.tick);
      L = { px: ref + s2 * Math.max(a * K.trigAtr, K.tick), ref, lots, sl: ref - s2 * slD, tp: ref + s2 * tpD, capped: false, slD, tpD };
    } else {
      L = armLevels(prevB, s2, K, S.dayReal);
      if (L) { L.slD = Math.abs(L.ref - L.sl); L.tpD = Math.abs(L.tp - L.ref); }
    }
    if (L) {
      S.isLimit = false;
      S.armDir = s2; S.armBar = i; S.armBy = i + K.armBars; S.armEp = L.ref; S.armPx = L.px;
      S.armSlD = L.slD; S.armTpD = L.tpD; S.armSlPx = L.sl; S.armTpPx = L.tp; S.armCapped = L.capped;
      S.armLots = lots; S.armAtr = a;
      S.armSet = S.armCount % NSETS; S.armCount = S.armCount + 1;
      ev.arm = { dir: s2, px: L.px, ref: L.ref, lots, sl: L.sl, tp: L.tp };
    }
  }
  return { S, ev };
}

// Will the signal on bar B arm at the next bar? Known at B's close, except an
// exit the next bar could trigger first (a resting stop filling, a stop-out).
// A flip closes the open trade at the next open first; its result is estimated
// at this close, which moves the stop only when the $600 line sets it.
function previewArm(S, B, K) {
  if (B.sig === 0 || !B.enter || S.pos === B.sig || !(B.atr > 0) || blockedOf(S, K)) return null;
  const nct = ctOf(B.ms + K.tfMs);
  if (nct < K.startCt || nct >= B.noEntryCt || nct >= B.flatCt) return null;
  let day = S.dayReal;
  if (S.pos !== 0) {
    day += (B.c - S.fill) * S.pos * K.pointValue * S.lots - 2 * K.commission * S.lots;
    if (blockedOf({ capHit: day <= -K.dayLossLimit, dayReal: day }, K)) return null;
  }
  return armLevels(B, B.sig, K, day);
}

// ── what fired, and what refused, in the readings the rules used ─────────
// Rounded down, so a reading never prints on the wrong side of its rule.
const down = (v, dp) => { const m = Math.pow(10, dp); return (Math.floor(v * m) / m).toFixed(dp); };
function readings(B, K) {
  const r = ["ADX " + down(B.adx, 0), "eff " + down(B.eff, 2) + (B.rescued ? " + trend" : "")];
  if (K.emaFilter) r.push(K.emaTf + "m " + (B.htf === 1 ? "up" : B.htf === -1 ? "down" : "flat"));
  if (B.used > 0) r.push("range " + down(100 * B.used, 0) + "%");
  return r.join(" · ");
}
function refusal(B, K) {
  const r = [];
  if (B.adx < K.adxMin) r.push("ADX " + down(B.adx, 0));
  if (!B.effOk) r.push("eff " + down(B.eff, 2) + (B.raw !== 0 && B.eff >= K.rescueMin ? (B.settled ? " vs trend" : ", no trend yet") : ""));
  return "× " + r.join(" · ");
}

const usd = (v) => (v >= 0 ? "+$" : "-$") + String(Math.round(Math.abs(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const COL = { up: "#26a65b", dn: "#d1566e", gold: "#e0c341", time: "#e0893a", grey: "#9aa4b2", day: "#c9a0ff" };
const num = (v, d) => (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

class mnqDonchian1250 {
  init() { this.bars = []; this.orders = []; }

  map(d, i) {
    const P = this.props || {};
    const K = Object.assign({}, CFG, {
      contracts: Math.max(1, num(P.contracts, CFG.contracts)),
      lateContracts: Math.max(1, num(P.lateContracts, CFG.lateContracts)),
      dayLossLimit: num(P.dayLossLimit, CFG.dayLossLimit),
      breaker: num(P.breaker, CFG.breaker),
      profitBlock: num(P.profitBlock, CFG.profitBlock),
      emaFilter: P.emaFilter !== false,
      emaTf: Math.max(2, 2 * Math.round(num(P.emaTf, CFG.emaTf) / 2)),     // whole 2-min bars only
      emaFast: Math.max(1, num(P.emaFast, CFG.emaFast)),
      emaSlow: Math.max(1, num(P.emaSlow, CFG.emaSlow)),
      research: !!P.__research,
    });
    const idx = typeof i === "number" ? i : d.index();
    const t = d.timestamp();
    let ms = t instanceof Date ? t.getTime() : Number(t);
    if (P.barTimeIsClose) ms -= K.tfMs;

    const prev = idx > 0 ? this.bars[idx - 1] : undefined;
    const B = barState(this.bars, idx, prev, d.open(), d.high(), d.low(), d.close(), ms, K);
    const gap = prev ? ms - prev.ms : Infinity;
    B.minGap = Math.min(prev ? prev.minGap : Infinity, gap > 0 ? gap : Infinity);
    this.bars[idx] = B;
    if (idx >= 256) { this.bars[idx - 256] = undefined; this.orders[idx - 256] = undefined; }

    const prevS = idx > 0 && this.orders[idx - 1] ? this.orders[idx - 1] : FLAT0;
    const { S, ev } = stepOrders(prevS, B, prev, idx, K);
    this.orders[idx] = S;

    const out = {};
    const items = [];
    // dy: pixels below (+) or above (-) the price
    const text = (key, x, y, str, fill, align, size, bold, dy) => items.push({
      tag: "Text", key: key + idx, text: str,
      point: { x, y: dy && op && px ? op(du(y), dy > 0 ? "+" : "-", px(Math.abs(dy))) : du(y) },
      style: { fontSize: size || 11, fontWeight: bold ? "bold" : "normal", fill }, textAlignment: align || "centerMiddle" });
    if (idx >= 20 && B.minGap !== K.tfMs) {
      if (B.ct === K.startCt || idx === 20) text("tf", du(idx), B.h, "mnqDonchian1250 needs a 2-MINUTE chart", COL.gold, "centerMiddle", 13, true);
      if (P.showMarkers !== false && items.length) out.graphics = { items };
      return out;
    }
    if (P.showChannel !== false && Number.isFinite(B.dh)) { out.dcHigh = B.dh; out.dcLow = B.dl; }
    if (P.showTrend !== false && B.settled) { out.trendFast = B.tF; out.trendSlow = B.tS; }
    if (P.showEma !== false && Number.isFinite(B.hF)) { out.htfFast = B.hF; out.htfSlow = B.hS; }

    // Lines rotate through three plot sets so consecutive orders never join.
    const put = (set, key, v) => { out[key + SETS[set]] = v; };
    const pre = K.research ? null : previewArm(S, B, K);
    if (pre) { const set = S.armCount % NSETS; put(set, "trig", pre.px); put(set, "stop", pre.sl); put(set, "target", pre.tp); }
    if (S.armDir !== 0) { put(S.armSet, "trig", S.armPx); put(S.armSet, "stop", S.armSlPx); put(S.armSet, "target", S.armTpPx); }
    if (S.pos !== 0 || ev.exit) { put(S.posSet, "stop", S.sl); put(S.posSet, "target", S.tp); }
    let checkPx = NaN;
    if (S.pos !== 0 && K.timeExitBars > 0 && idx - S.entBar <= K.timeExitBars) {
      const need = K.timeExitAtr * S.entAtr;
      const hi = idx === S.entBar ? B.c : B.h, lo = idx === S.entBar ? B.c : B.l;
      const best = S.dir === 1 ? Math.max(S.mx, hi) - S.fill : S.fill - Math.min(S.mn, lo);
      if (best < need) { checkPx = S.fill + S.dir * need; if (P.showCheckpoint !== false) put(S.posSet, "check", checkPx); }
    }

    if (P.showMarkers !== false) {
      const off = Math.max(B.atr * 0.35, K.tick * 4);
      const labels = P.showLineLabels !== false, why = P.showWhy !== false;
      // once the day is done, its later signals are not drawn
      if (B.sig !== 0 && !B.enter && !blockedOf(S, K)) {
        // a breakout against the 10-minute trend: no order, but it still exits and cancels
        const long = B.sig === 1;
        const closes = S.pos === -B.sig, cancels = S.pos === 0 && S.armDir !== 0 && S.armDir !== B.sig;
        if (P.showSkipped !== false || closes || cancels) {
          const str = (B.rescued ? (long ? "△" : "▽") : (long ? "▲" : "▼")) + " vs " + K.emaTf + "m trend" +
                      (closes ? " · closes trade" : cancels ? " · cancels " + (S.armDir === 1 ? "buy" : "sell") + " stop" : "");
          text("s", du(idx), long ? B.l - off : B.h + off, str, COL.grey, "centerMiddle", 11, false);
        }
      } else if (B.sig !== 0 && (pre || !blockedOf(S, K))) {
        const long = B.sig === 1;
        const mark = B.rescued ? (long ? "△" : "▽") : (long ? "▲" : "▼");
        const col = long ? COL.up : COL.dn, y = long ? B.l - off : B.h + off;
        let str = mark;
        if (pre) {
          const q = [];
          if (B.rescued) q.push("trend");
          if (pre.lots < K.contracts) q.push("range " + Math.round(100 * B.used) + "%");
          if (S.pos === -B.sig) q.push("flip");
          else if (S.armDir !== 0) q.push(S.armDir === B.sig ? "moves stop if unfilled" : "cancels " + (S.armDir === 1 ? "buy" : "sell") + " stop");
          str = mark + " " + (long ? "BUY " : "SELL ") + pre.lots + (q.length ? " · " + q.join(" · ") : "");
        } else if (S.pos === -B.sig) str = mark + " · closes trade";
        else if (S.pos !== B.sig) str = mark + " · too late";
        text("s", du(idx), y, str, col, "centerMiddle", 13, true);
        // a run of breakouts is one story: only its first bar says why
        if (pre && why && !(prev && prev.sig === B.sig)) {
          text("w", du(idx), y, readings(B, K), col, "centerMiddle", 10, false, long ? 15 : -15);
          // the level the close broke, from the bar that set it to the signal bar
          const lvl = long ? B.dh : B.dl, at = long ? B.dhAt : B.dlAt;
          items.push({ tag: "LineSegments", key: "lvl" + idx, lineStyle: { lineWidth: 2, color: col },
                       lines: [{ tag: "Line", a: { x: du(at), y: du(lvl) }, b: { x: du(idx), y: du(lvl) }, infiniteStart: false, infiniteEnd: false }] });
          text("ll", xAt(at, -4), lvl, K.period + "-bar " + (long ? "high " : "low ") + lvl.toFixed(2), col, "rightMiddle", 9, false, long ? 6 : -6);
        }
        if (pre && labels) {
          text("lt", xAt(idx, -6), pre.px, (long ? "BUY STOP " : "SELL STOP ") + pre.px.toFixed(2), COL.gold, "rightMiddle", 10);
          text("ls", xAt(idx, -6), pre.sl, "SL " + pre.sl.toFixed(2) + (pre.capped ? " · day limit" : ""), COL.dn, "rightMiddle", 10);
          text("lp", xAt(idx, -6), pre.tp, "TP " + pre.tp.toFixed(2), COL.up, "rightMiddle", 10);
        }
      } else if (B.sig === 0 && B.side !== 0 && B.inWin && P.showSkipped !== false && S.pos !== B.side &&
                 !blockedOf(S, K) && !(prev && prev.side === B.side)) {
        // a close outside the channel the gates refused: it does nothing, this says why
        text("r", du(idx), B.side === 1 ? B.l - off : B.h + off, refusal(B, K), COL.grey, "centerMiddle", 9, false);
      }
      if (ev.fill) {
        const f = ev.fill;
        text("f", du(idx), f.px, "●", COL.gold, "centerMiddle", 12, true);
        text("fl", xAt(idx, 8), f.px, (f.dir === 1 ? "BOUGHT " : "SOLD ") + f.lots + " @ " + f.px.toFixed(2) + (f.limit ? " (limit)" : ""), COL.gold, "leftMiddle", 10);
        if (labels && P.showCheckpoint !== false && Number.isFinite(checkPx)) text("fc", xAt(idx, 8), checkPx, "+1 ATR by " + (2 * K.timeExitBars) + "m", COL.time, "leftMiddle", 9);
      }
      if (ev.exit) {
        const x = ev.exit;
        const name = x.why === "TIME" ? "TIME " + (2 * K.timeExitBars) + "m" : x.early ? "FLAT early close" : x.why;
        const fill = x.why === "TP" ? COL.up : x.why === "SL" ? COL.dn : x.why === "TIME" ? COL.time : COL.grey;
        text("x", xAt(x.early ? idx - 1 : idx, 8), x.px, name + " " + usd(x.pnl) + (x.capped ? " · day limit" : ""), fill, "leftMiddle", 11, true);
      }
      if (ev.dayDone) {
        const y = ev.exit ? ev.exit.px : B.c;
        text("dd", xAt(idx, 8), y - (B.atr || 1) * 0.6 * (S.dir || 1), "DAY DONE " + usd(ev.dayDone.day) + " (" + ev.dayDone.reason + ")", COL.day, "leftMiddle", 10, true);
      }
      if (ev.expire) text("e", xAt(idx - 1, 6), ev.expire.px, ev.expire.why, COL.grey, "leftMiddle", 9);
      if (items.length) out.graphics = { items };
    }
    if (P.__research !== undefined) out._ev = { sig: B.sig, ev, S, B, pre };
    return out;
  }
}

module.exports = {
  name: "mnqDonchian1250",
  description: "MNQ Donchian — $1,250-target evaluation (2-min chart)",
  calculator: mnqDonchian1250,
  params: {
    contracts: predef.paramSpecs.period(4),
    lateContracts: predef.paramSpecs.period(2),
    dayLossLimit: predef.paramSpecs.number(600, 50, 0),
    breaker: predef.paramSpecs.number(300, 50, 0),
    profitBlock: predef.paramSpecs.number(250, 50, 0),
    emaFilter: predef.paramSpecs.bool(true),
    emaTf: predef.paramSpecs.period(10),
    emaFast: predef.paramSpecs.period(9),
    emaSlow: predef.paramSpecs.period(21),
    showChannel: predef.paramSpecs.bool(true),
    showTrend: predef.paramSpecs.bool(true),
    showEma: predef.paramSpecs.bool(true),
    showMarkers: predef.paramSpecs.bool(true),
    showWhy: predef.paramSpecs.bool(true),
    showSkipped: predef.paramSpecs.bool(true),
    showLineLabels: predef.paramSpecs.bool(true),
    showCheckpoint: predef.paramSpecs.bool(true),
    barTimeIsClose: predef.paramSpecs.bool(false),
  },
  inputType: meta.InputType.BARS,
  areaChoice: (meta.AreaChoice || {}).OVERLAY,
  plots: {
    dcHigh: { title: "Donchian high" }, dcLow: { title: "Donchian low" },
    trendFast: { title: "Trend EMA 125" }, trendSlow: { title: "Trend EMA 500" },
    htfFast: { title: "10-min EMA fast" }, htfSlow: { title: "10-min EMA slow" },
    trigA: { title: "Stop-entry" }, stopA: { title: "Stop" }, targetA: { title: "Target" }, checkA: { title: "40-min checkpoint" },
    trigB: { title: "Stop-entry (2)" }, stopB: { title: "Stop (2)" }, targetB: { title: "Target (2)" }, checkB: { title: "40-min checkpoint (2)" },
    trigC: { title: "Stop-entry (3)" }, stopC: { title: "Stop (3)" }, targetC: { title: "Target (3)" }, checkC: { title: "40-min checkpoint (3)" },
  },
  tags: ["MNQ bot"],
  schemeStyles: {
    dark: {
      dcHigh: { color: "#3d7a5a" }, dcLow: { color: "#7a3d3d" }, trendFast: { color: "#4a6f99" }, trendSlow: { color: "#6f5a99" },
      htfFast: { color: "#5aa9e6" }, htfSlow: { color: "#b07fe0" },
      trigA: { color: "#e0c341" }, stopA: { color: "#d1566e" }, targetA: { color: "#26a65b" }, checkA: { color: "#e0893a" },
      trigB: { color: "#e0c341" }, stopB: { color: "#d1566e" }, targetB: { color: "#26a65b" }, checkB: { color: "#e0893a" },
      trigC: { color: "#e0c341" }, stopC: { color: "#d1566e" }, targetC: { color: "#26a65b" }, checkC: { color: "#e0893a" },
    },
  },
};
