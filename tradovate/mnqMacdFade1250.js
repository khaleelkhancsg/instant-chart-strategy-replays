/*
 * MNQ MACD fade — for a $1,250-target evaluation.          APPLY TO A 1-MINUTE CHART.
 *
 * Built for these account rules: $1,250 profit target, $1,000 trailing maximum
 * loss, $600 daily loss limit, 50% consistency. On 2026 data (honest fills,
 * realistic costs) this setup passed 67.7% of 21-day windows (Jan-Mar 64.8%,
 * Apr-Jul 73.8%), against 58.6% for fading every cross --
 * research/macd_optimize_2026.mjs in the backtesting project.
 *
 * WHY IT WORKS (research/macd_anatomy_2026.mjs)
 *   A fade is paid for absorbing a burst of one-sided orders, and that pays
 *   most when the market is moving: fades in a quiet market lose, and the
 *   first fade of the day carries most of the edge. A cross that RESUMES the
 *   short-term trend is persistent buying or selling and keeps going; a cross
 *   AGAINST it is a bounce, and bounces revert. So only bounces are faded,
 *   and only when the market is moving.
 *
 * THE SETUP
 *   signal    the 1-min MACD(12, 26, 9) histogram crosses zero on a bar opening
 *             08:30 <= t < 15:00 CT; the trade goes the OTHER way (a cross up
 *             is a SELL) -- but only if the cross is weak and the market moving:
 *               weak    the MACD line is already on the fade's side of zero:
 *                       the cross is a bounce against the short-term trend. A
 *                       STRONG cross (the trend resuming) is not faded
 *               moving  the 1-min ATR(14) is at least the average ATR of the
 *                       previous 10 sessions' 08:30-15:00 bars
 *   size      4 lots
 *   entry     a stop 0.15 x ATR beyond the signal close, placed one bar later,
 *             live for 10 bars; re-placed as a LIMIT at the same price if price
 *             is already through it
 *   bracket   stop 5 x ATR from the signal close, or nearer where the day would
 *             reach the $600 limit after commission; target from the stop-entry,
 *             as far as the stop on a flat day: 5.15 x ATR, at most
 *             $600 / (lots x $2) -- 75 points at 4 lots
 *   exits     the next cross -- weak or strong, moving or not -- closes the
 *             trade at the next open, before that bar can touch the stop or
 *             target (and places the next fade if that cross qualifies); the
 *             bracket; flat 15:05 CT. Every cross also cancels a resting order
 *             the other way
 *   day       stop for the day once it is -$200 (breaker), +$250 (profit block)
 *             or at the -$600 limit. The +$250 block is what keeps every day
 *             under the $625 the consistency rule allows at a $1,250 pass.
 *
 * WHAT IS DRAWN
 *   ▲ BUY 4 / ▼ SELL 4     a cross and the order it places (▲ BUY fades a cross
 *                          down). Qualifiers: · flip (reverses the open trade),
 *                          · cancels sell stop (the resting order the other way
 *                          is cancelled at the next open)
 *   ▲ strong / ▼ quiet     grey: a cross that is NOT faded -- it resumes the
 *                          short-term trend, or the market is quieter than
 *                          normal. It still closes an open trade (· closes
 *                          trade) and cancels a resting order the other way.
 *                          showSkipped off hides the ones that do neither
 *   ▲ · closes trade       a qualifying cross too late in the day: it only exits
 *   gold / red / green     stop-entry, stop, target -- starting ON the signal
 *                          candle, with price tags there; "· day limit" when
 *                          the $600 line sets the stop
 *   ● SOLD 4 @ price       the fill
 *   TP / SL / FLIP / FLAT  the exit, with the trade's dollars ($0.75/side
 *                          commission, no slippage); · day limit when the stop
 *                          was the $600 line
 *   DAY DONE +$262         the day stopped: profit block, breaker or limit.
 *                          Later crosses that day are not drawn
 *   no fill / cancelled    a stop-entry that expired, or that a cross the other
 *                          way cancelled at the next open
 *
 * Load at least 11 sessions: the volatility check needs the previous 10, and
 * until it has them it lets every weak cross through. Add Tradovate's own MACD
 * (12, 26, 9) in a pane below to see the crosses. The day rules are modelled
 * from THIS indicator's own trades, so it assumes the account trades nothing
 * else. Verified in Node against the research engine on every trade --
 * tradovate/verify_1250.mjs in the backtesting project.
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
  macdFast: 12, macdSlow: 26, macdSignal: 9, atrPeriod: 14,
  startCt: 510, endCt: 900,        // signal bars opening 08:30 <= t < 15:00 CT; also the volatility window
  noEntryCt: 895,                  // no new order at/after 14:55 CT
  flattenCt: 905,                  // force flat 15:05 CT
  trigAtr: 0.15, armBars: 10,      // stop-entry offset and window
  slAtr: 5,                        // stop, from the signal close
  tpAtr: 5.15,                     // target, from the stop-entry (capped at the flat-day stop)
  contracts: 4,
  onlyWeak: true,                  // fade only crosses against the MACD line's side of zero
  minVolRatio: 1,                  // ...and only when ATR >= this x its 10-session average (0 = off)
  volSessions: 10,
  dayLossLimit: 600, breaker: 200, profitBlock: 250,
  pointValue: 2, commission: 0.75, slip: 0.25, tick: 0.25, tfMs: 60000,
};

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

// ── indicators for a bar, from the previous bar's state only ─────────────
// EMAs seeded with the first close, alpha 2/(n+1) -- the research library's.
function barState(prev, o, h, l, c, ms, K) {
  const aA = 2 / (K.atrPeriod + 1);
  const tr = prev ? Math.max(h - l, Math.abs(h - prev.c), Math.abs(l - prev.c)) : h - l;
  const atr = prev ? aA * tr + (1 - aA) * prev.atr : tr;
  const aF = 2 / (K.macdFast + 1), aS = 2 / (K.macdSlow + 1), aG = 2 / (K.macdSignal + 1);
  const eF = prev ? aF * c + (1 - aF) * prev.eF : c;
  const eS = prev ? aS * c + (1 - aS) * prev.eS : c;
  const line = eF - eS;
  const sigLine = prev ? aG * line + (1 - aG) * prev.sigLine : line;
  const hist = line - sigLine;
  const cross = !prev ? 0 : hist > 0 && prev.hist <= 0 ? 1 : hist < 0 && prev.hist >= 0 ? -1 : 0;
  const ct = ctOf(ms);
  const inWin = K.startCt <= ct && ct < K.endCt;
  const sig = inWin ? -cross : 0;                              // the fade
  // How much the market is moving: this bar's ATR against the mean ATR of the
  // 08:30-15:00 bars of the previous `volSessions` sessions that had any.
  const sk = sessionOf(ms);
  let atrHist = prev ? prev.atrHist : NO_HIST, atrSum = 0, atrCnt = 0;
  if (prev && prev.sk === sk) { atrSum = prev.atrSum; atrCnt = prev.atrCnt; }
  else if (prev && prev.atrCnt > 0) atrHist = atrHist.concat([prev.atrSum / prev.atrCnt]).slice(-K.volSessions);
  if (inWin) { atrSum += atr; atrCnt++; }
  let volRel = NaN;
  if (atrHist.length === K.volSessions) { let s = 0; for (const m of atrHist) s += m; volRel = atr / (s / K.volSessions); }
  // Which crosses are faded: a WEAK one (the MACD line already on the fade's
  // side of zero -- a bounce against the short-term trend) in a moving market.
  const weakOk = !K.onlyWeak || (sig !== 0 && Math.sign(line) === sig);
  const moving = !(K.minVolRatio > 0) || !(volRel < K.minVolRatio);
  const enter = sig !== 0 && weakOk && moving;
  return { o, h, l, c, ms, ct, tr, atr, eF, eS, line, sigLine, hist, cross, sig, sk, lots: K.contracts,
           atrHist, atrSum, atrCnt, volRel, weakOk, moving, enter };
}

// ── the order a signal arms, in the live price convention ─────────────────
// From the signal close (known at its close): stop-entry rounded to a real
// price; stop 5 ATR away, or nearer where the day would reach the loss limit
// after this trade's commission (rounded toward the entry); target from the
// stop-entry. null when the day has no room left for a 1-tick stop.
function armLevels(sb, dir, K, dayReal) {
  const a = sb.atr, lots = sb.lots, ref = sb.c, T = K.tick;
  const p = roundTick(ref + dir * Math.max(a * K.trigAtr, T));
  const budget = K.dayLossLimit + dayReal - 2 * K.commission * lots;
  if (!(budget >= K.pointValue * lots * T)) return null;
  const capPx = p - dir * (budget / (K.pointValue * lots));
  const cap = dir === 1 ? Math.ceil(capPx / T - 1e-9) * T : Math.floor(capPx / T + 1e-9) * T;
  const raw = roundTick(ref - dir * Math.max(a * K.slAtr, T));
  const capped = dir === 1 ? cap > raw : cap < raw;
  const tpD = Math.max(Math.min(a * K.tpAtr, K.dayLossLimit / (K.pointValue * lots)), T);
  return { px: p, ref, lots, sl: capped ? cap : raw, capped, tp: roundTick(p + dir * tpD) };
}

// ── the order lifecycle with the day rules (research/lib_shipped.mjs) ─────
const FLAT0 = { pos: 0, dir: 0, sl: 0, tp: 0, fill: 0, posSet: 0, lots: 0, entBar: -1, capped: false, limFill: false,
                armDir: 0, armPx: 0, armBar: -1, armBy: -1, armEp: 0, armLots: 0, armSlD: 0, armTpD: 0,
                armSlPx: 0, armTpPx: 0, armCapped: false, isLimit: false, armSet: 0, armCount: 0,
                dayReal: 0, capHit: false };
const NSETS = 3, SETS = ["A", "B", "C"];
const blockedOf = (S, K) => S.capHit || (K.breaker > 0 && S.dayReal <= -K.breaker) || (K.profitBlock > 0 && S.dayReal >= K.profitBlock);
const blockReason = (S, K) => (S.capHit ? "daily limit" : K.profitBlock > 0 && S.dayReal >= K.profitBlock ? "profit block" : "breaker");

function stepOrders(S0, B, prevB, i, K) {
  const S = Object.assign({}, S0);
  const ev = {};
  const s2 = prevB ? prevB.sig : 0;                      // every cross exits and cancels...
  const go = !!(prevB && prevB.enter);                   // ...only a qualifying one places an order
  const flatNow = B.ct >= K.flattenCt || B.ct < K.startCt;
  if (!prevB || B.sk !== prevB.sk) { S.dayReal = 0; S.capHit = false; }      // a new session
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

  // 1. a parked or working stop-entry. A cross the other way cancels it at
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
        S.lots = S.armLots; S.entBar = i;
        if (K.research) {
          const avg = p + a * K.slip;
          const lossPx = avg - a * ((K.dayLossLimit + S.dayReal) / (K.pointValue * S.lots));
          const rawSl = S.armEp - a * S.armSlD;
          S.sl = a === 1 ? Math.max(rawSl, lossPx) : Math.min(rawSl, lossPx);
          S.capped = a === 1 ? (S.sl === lossPx && lossPx > rawSl) : (S.sl === lossPx && lossPx < rawSl);
          S.tp = p + a * S.armTpD;
        } else {
          S.sl = S.armSlPx; S.tp = S.armTpPx; S.capped = S.armCapped;
        }
        ev.fill = { dir: a, px: p, limit: S.isLimit, lots: S.lots };
      }
    }
  }

  // 2. an open position. A cross on the closed bar closes it at this open --
  // before this bar can touch the stop or target. Only a gap through the stop
  // at the open comes first.
  if (S.pos !== 0) {
    if (flatNow) { book(B.o, "FLAT"); return { S, ev }; }
    const d = S.pos, sl = S.sl, tp = S.tp;
    const capCut = K.research && S.capped ? -K.dayLossLimit - S.dayReal : undefined;
    if (d === 1 ? B.o <= sl : B.o >= sl) { book(B.o, "SL", capCut); return { S, ev }; }
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

  // 3. a qualifying cross on the previous bar arms a stop-entry (a newer one replaces it)
  if (S.pos === 0 && s2 !== 0 && go && !flatNow && !blockedOf(S, K) && B.ct < K.noEntryCt) {
    const a = prevB.atr, lots = prevB.lots;
    let L = null;
    if (!(a > 0)) L = null;
    else if (K.research) {
      const ref = B.o, slD = Math.max(a * K.slAtr, K.tick);
      const tpD = Math.max(Math.min(a * K.tpAtr, K.dayLossLimit / (K.pointValue * lots)), K.tick);
      const p = ref + s2 * Math.max(a * K.trigAtr, K.tick);
      L = { px: p, ref, lots, sl: ref - s2 * slD, tp: p + s2 * tpD, capped: false, slD, tpD };
    } else {
      L = armLevels(prevB, s2, K, S.dayReal);
      if (L) { L.slD = Math.abs(L.ref - L.sl); L.tpD = Math.abs(L.tp - L.px); }
    }
    if (L) {
      S.isLimit = false;
      S.armDir = s2; S.armBar = i; S.armBy = i + K.armBars; S.armEp = L.ref; S.armPx = L.px;
      S.armSlD = L.slD; S.armTpD = L.tpD; S.armSlPx = L.sl; S.armTpPx = L.tp; S.armCapped = L.capped; S.armLots = lots;
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
  if (nct < K.startCt || nct >= K.noEntryCt || nct >= K.flattenCt) return null;
  let day = S.dayReal;
  if (S.pos !== 0) {
    day += (B.c - S.fill) * S.pos * K.pointValue * S.lots - 2 * K.commission * S.lots;
    if (blockedOf({ capHit: day <= -K.dayLossLimit, dayReal: day }, K)) return null;
  }
  return armLevels(B, B.sig, K, day);
}

const usd = (v) => (v >= 0 ? "+$" : "-$") + String(Math.round(Math.abs(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const COL = { up: "#26a65b", dn: "#d1566e", gold: "#e0c341", grey: "#9aa4b2", day: "#c9a0ff" };
const num = (v, d) => (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

class mnqMacdFade1250 {
  init() { this.bars = []; this.orders = []; }

  map(d, i) {
    const P = this.props || {};
    const K = Object.assign({}, CFG, {
      contracts: Math.max(1, num(P.contracts, CFG.contracts)),
      onlyWeak: P.onlyWeakCrosses !== false,
      minVolRatio: Math.max(0, num(P.minVolRatio, CFG.minVolRatio)),
      dayLossLimit: num(P.dayLossLimit, CFG.dayLossLimit),
      breaker: num(P.breaker, CFG.breaker),
      profitBlock: num(P.profitBlock, CFG.profitBlock),
      research: !!P.__research,
    });
    const idx = typeof i === "number" ? i : d.index();
    const t = d.timestamp();
    let ms = t instanceof Date ? t.getTime() : Number(t);
    if (P.barTimeIsClose) ms -= K.tfMs;

    const prev = idx > 0 ? this.bars[idx - 1] : undefined;
    const B = barState(prev, d.open(), d.high(), d.low(), d.close(), ms, K);
    const gap = prev ? ms - prev.ms : Infinity;
    B.minGap = Math.min(prev ? prev.minGap : Infinity, gap > 0 ? gap : Infinity);
    this.bars[idx] = B;
    if (idx >= 256) { this.bars[idx - 256] = undefined; this.orders[idx - 256] = undefined; }

    const prevS = idx > 0 && this.orders[idx - 1] ? this.orders[idx - 1] : FLAT0;
    const { S, ev } = stepOrders(prevS, B, prev, idx, K);
    this.orders[idx] = S;

    const out = {};
    const items = [];
    const text = (key, x, y, str, fill, align, size, bold) => items.push({
      tag: "Text", key: key + idx, point: { x, y: du(y) }, text: str,
      style: { fontSize: size || 11, fontWeight: bold ? "bold" : "normal", fill }, textAlignment: align || "centerMiddle" });
    if (idx >= 20 && B.minGap !== K.tfMs) {
      if (B.ct === K.startCt || idx === 20) text("tf", du(idx), B.h, "mnqMacdFade1250 needs a 1-MINUTE chart", COL.gold, "centerMiddle", 13, true);
      if (P.showMarkers !== false && items.length) out.graphics = { items };
      return out;
    }

    // Lines rotate through three plot sets so consecutive orders never join.
    const put = (set, key, v) => { out[key + SETS[set]] = v; };
    const pre = K.research ? null : previewArm(S, B, K);
    if (pre) { const set = S.armCount % NSETS; put(set, "trig", pre.px); put(set, "stop", pre.sl); put(set, "target", pre.tp); }
    if (S.armDir !== 0) { put(S.armSet, "trig", S.armPx); put(S.armSet, "stop", S.armSlPx); put(S.armSet, "target", S.armTpPx); }
    if (S.pos !== 0 || ev.exit) { put(S.posSet, "stop", S.sl); put(S.posSet, "target", S.tp); }

    if (P.showMarkers !== false) {
      const off = Math.max(B.atr * 0.6, K.tick * 4);
      const labels = P.showLineLabels !== false;
      // once the day is done, its later signals are not drawn
      if (B.sig !== 0 && (pre || !blockedOf(S, K))) {
        const long = B.sig === 1;
        const mark = long ? "▲" : "▼";
        const y = long ? B.l - off : B.h + off;
        const closes = S.pos === -B.sig;
        const cancels = S.pos === 0 && S.armDir !== 0 && S.armDir !== B.sig;
        const cancelTxt = "cancels " + (S.armDir === 1 ? "buy" : "sell") + " stop";
        if (pre) {
          const why = [];
          if (closes) why.push("flip");
          else if (S.armDir !== 0) why.push(S.armDir === B.sig ? "moves stop if unfilled" : cancelTxt);
          text("s", du(idx), y, mark + " " + (long ? "BUY " : "SELL ") + pre.lots + (why.length ? " · " + why.join(" · ") : ""), long ? COL.up : COL.dn, "centerMiddle", 12, true);
          if (labels) {
            text("lt", xAt(idx, -6), pre.px, (long ? "BUY STOP " : "SELL STOP ") + pre.px.toFixed(2), COL.gold, "rightMiddle", 10);
            text("ls", xAt(idx, -6), pre.sl, "SL " + pre.sl.toFixed(2) + (pre.capped ? " · day limit" : ""), COL.dn, "rightMiddle", 10);
            text("lp", xAt(idx, -6), pre.tp, "TP " + pre.tp.toFixed(2), COL.up, "rightMiddle", 10);
          }
        } else if (!B.enter) {
          // a cross that is not faded: it still exits an open trade and cancels a resting order
          if (P.showSkipped !== false || closes || cancels) {
            const str = mark + " " + (B.weakOk ? "quiet" : "strong") + (closes ? " · closes trade" : cancels ? " · " + cancelTxt : "");
            text("s", du(idx), y, str, COL.grey, "centerMiddle", 10, false);
          }
        } else if (closes) {
          text("s", du(idx), y, mark + " · closes trade", long ? COL.up : COL.dn, "centerMiddle", 12, true);
        } else {
          text("s", du(idx), y, mark, long ? COL.up : COL.dn, "centerMiddle", 12, true);
        }
      }
      if (ev.fill) {
        const f = ev.fill;
        text("f", du(idx), f.px, "●", COL.gold, "centerMiddle", 12, true);
        text("fl", xAt(idx, 8), f.px, (f.dir === 1 ? "BOUGHT " : "SOLD ") + f.lots + " @ " + f.px.toFixed(2) + (f.limit ? " (limit)" : ""), COL.gold, "leftMiddle", 10);
      }
      if (ev.exit) {
        const x = ev.exit;
        const fill = x.why === "TP" ? COL.up : x.why === "SL" ? COL.dn : COL.grey;
        text("x", xAt(idx, 8), x.px, x.why + " " + usd(x.pnl) + (x.capped ? " · day limit" : ""), fill, "leftMiddle", 11, true);
      }
      if (ev.dayDone) {
        const y = ev.exit ? ev.exit.px : B.c;
        text("dd", xAt(idx, 8), y - (B.atr || 1) * 1.2 * (S.dir || 1), "DAY DONE " + usd(ev.dayDone.day) + " (" + ev.dayDone.reason + ")", COL.day, "leftMiddle", 10, true);
      }
      if (ev.expire) text("e", xAt(idx - 1, 6), ev.expire.px, ev.expire.why, COL.grey, "leftMiddle", 9);
      if (items.length) out.graphics = { items };
    }
    if (P.__research !== undefined) out._ev = { sig: B.sig, ev, S, B, pre };
    return out;
  }
}

module.exports = {
  name: "mnqMacdFade1250",
  description: "MNQ MACD fade — $1,250-target evaluation (1-min chart)",
  calculator: mnqMacdFade1250,
  params: {
    contracts: predef.paramSpecs.period(4),
    onlyWeakCrosses: predef.paramSpecs.bool(true),
    minVolRatio: predef.paramSpecs.number(1, 0.1, 0),
    dayLossLimit: predef.paramSpecs.number(600, 50, 0),
    breaker: predef.paramSpecs.number(200, 50, 0),
    profitBlock: predef.paramSpecs.number(250, 50, 0),
    showMarkers: predef.paramSpecs.bool(true),
    showSkipped: predef.paramSpecs.bool(true),
    showLineLabels: predef.paramSpecs.bool(true),
    barTimeIsClose: predef.paramSpecs.bool(false),
  },
  inputType: meta.InputType.BARS,
  areaChoice: (meta.AreaChoice || {}).OVERLAY,
  plots: {
    trigA: { title: "Stop-entry" }, stopA: { title: "Stop" }, targetA: { title: "Target" },
    trigB: { title: "Stop-entry (2)" }, stopB: { title: "Stop (2)" }, targetB: { title: "Target (2)" },
    trigC: { title: "Stop-entry (3)" }, stopC: { title: "Stop (3)" }, targetC: { title: "Target (3)" },
  },
  tags: ["MNQ bot"],
  schemeStyles: {
    dark: {
      trigA: { color: "#e0c341" }, stopA: { color: "#d1566e" }, targetA: { color: "#26a65b" },
      trigB: { color: "#e0c341" }, stopB: { color: "#d1566e" }, targetB: { color: "#26a65b" },
      trigC: { color: "#e0c341" }, stopC: { color: "#d1566e" }, targetC: { color: "#26a65b" },
    },
  },
};
