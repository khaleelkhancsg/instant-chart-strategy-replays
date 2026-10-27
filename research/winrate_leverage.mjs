// A strategy WITH an edge, its target shrunk to raise the win rate, and more lots
// to make each small win worth something? ($1,250 rules)
//
// Tested on the MACD fade (its edge is Jan-Jul 2026's; research/forward_macd_sizing.mjs
// found none since September) and on the Donchian: target 0.1 to 1 ATR from the fill,
// or as shipped, x 2 to 64 lots. Everything else as shipped: the 5 ATR stop cut at the
// $600 day limit, each strategy's day rules, 1 tick of slippage and $0.75 commission a
// side per lot ($2.50 a lot per round trip). The Donchian halves its size late in the
// day, as shipped. Costs and stop widths are 2026's.
//
// RESULT: no. With an edge, a smaller target raises the win rate but lowers the
// pass rate, and more lots make it worse ($1,250 rules, 2026, 4 lots):
//                     MACD fade                        Donchian
//   target        win%   pass   $/trade before costs   win%   pass   $/trade before costs
//   as shipped    69.2   67.7   +104                   66.4   71.1   +86
//   1 ATR         74.8   54.0    +49                   69.8   45.1   +33
//   0.5 ATR       82.3   41.3    +16                   84.5   28.6   +12
//   0.25 ATR      87.6   13.7     -7                   90.1    4.5    -3
//   0.1 ATR       91.4    0.2    -10                   88.4    0.0    -4
// The edge needs room: capped at a fraction of an ATR a trade gives up most of
// what it would have made, while its losers still run to the $600 line. More
// lots cannot make it up, because the $600 limit fixes the dollars at risk:
// each lot pulls the stop closer (median 3.1 ATR at 4 lots, 1.5 at 8, 0.6 at
// 16, 0.16 at 64), so the win rate falls back (MACD, 0.5 ATR: 82% at 4 lots,
// 39% at 16), and costs grow with the lots, not with the $1,250 target: $10 a
// trade at 4 lots, $40 at 16, $160 at 64. MACD at 0.5 ATR: 41.3 / 21.2 / 8.8 /
// 4.8 / 1.9 at 4 / 8 / 16 / 32 / 64 lots. Above ~8 lots the stop sits inside
// one bar's range, where the bars cannot say whether stop or target came first
// (the engine books the stop). Settled neutrally -- the target first with
// probability stop / (stop + target) -- every such cell stays under 17% (MACD)
// and 12% (Donchian); giving every tie to the target, under 28% and 13%.
// Before 2026 likewise: nothing beats 4 lots as shipped by more than 4 points.
//
//   node --max-old-space-size=8192 research/winrate_leverage.mjs

import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";
import { E1, t1, tf2, SIGA, ML, volRel, HTF, exit20 } from "./lib_combo.mjs";

const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const F = { slipMult: 1, feeMult: 1, limitFillTp: "close", cancelOpposite: true, exitFirst: true, dayCap: 600 };
const COST = 2.5;
const yr = (td) => S.yearOf.get(td);
const IX = (f) => S.days.map((d, k) => (f(d, k) ? k : -1)).filter((k) => k >= 0);
const Y26 = IX((d) => yr(d) === 2026), PRE = IX((d) => yr(d) < 2026);
const pass = (arr, ix) => S.passArr(ix.map((k) => arr[k]), RULES);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const macGate = (k) => SIGA[k] !== 0 && Math.sign(ML[k]) === SIGA[k] && !(volRel[k] < 1);
const donGate = (k) => M.RESC[k] !== 0 && HTF[k] === M.RESC[k];

// tpOf(trade, t) -> the target price: from the fill (avg less the tick of slippage), or
// for the shipped Donchian from the arm bar's open (the fill less 0.15 ATR)
const STRATS = [
  { name: "MACD FADE ($1,250: -$200 breaker, +$250 block)", shipped: "5.15 ATR, at most the $600 line", bars: t1,
    tpOf: (x, t) => x.avg - x.dir * 0.25 + x.dir * (t === null ? Math.min(5.15 * x.atr, 600 / (2 * x.lots)) : t * x.atr),
    run: (lots, t) => E1.run((a, c, s, arm) => (macGate(arm - 1) ? lots : 0),
      { signals: SIGA, ...F, breaker: 200, profitBlock: 250, trig: 0.15, tpFromFill: true, detail: true,
        tpFn: t === null ? (a, q) => Math.min(5.15 * a, 600 / (2 * q)) : (a) => t * a }) },
  { name: "DONCHIAN ($1,250: -$300 breaker, +$250 block, 40-minute exit; half size late)", shipped: "1.75 ATR from the arm (1.6 from the fill)", bars: tf2,
    tpOf: (x, t) => x.avg - x.dir * 0.25 + x.dir * (t === null ? 1.6 * x.atr : t * x.atr),
    run: (lots, t) => { const late = Math.max(1, Math.round(lots / 2));
      return S.run((a, c, s, arm) => (donGate(arm - 1) ? (M.adrUsed(arm - 1) >= 0.9 ? late : lots) : 0),
        { signals: M.RESC, ...F, breaker: 300, profitBlock: 250, exitFn: exit20, detail: true, ...(t === null ? {} : { tpFromFill: true, tpFn: (a) => t * a }) }); } },
];
// The engine reads 1- / 2-minute bars, so when the bar that hit the stop ALSO reached
// the target it cannot know which came first and books the stop. bestCase gives every
// such tie to the target; neutral settles each the way a market with no edge inside
// the bar would: the target first with probability stop / (stop + target), the
// distances from the fill (seeded; the day's later trades left as they were).
function resolveTies(tr, t, st, mode, seed = 1) {
  const B = st.bars, rnd = S.mul(seed), out = [];
  let day = -1, real = 0;
  for (const x of tr) {
    if (x.tday !== day) { day = x.tday; real = 0; }
    let y = x;
    if (x.why === "SL" || x.why === "SLcap") {
      const tp = st.tpOf(x, t), fill = x.avg - x.dir * 0.25;
      const sl = x.why === "SLcap" ? x.avg - x.dir * ((600 + real) / (2 * x.lots)) : fill - x.dir * 5.15 * x.atr;
      const gap = x.dir === 1 ? B.open[x.xBar] <= sl : B.open[x.xBar] >= sl;
      if (!gap && (x.dir === 1 ? B.high[x.xBar] >= tp : B.low[x.xBar] <= tp)) {
        const s = Math.abs(fill - sl), g = Math.abs(tp - fill);
        if (mode === "best" || rnd() < s / (s + g)) y = { ...x, pnl: (tp - x.dir * 0.25 - x.avg) * x.dir * 2 * x.lots - 1.5 * x.lots, tie: true };
        else y = { ...x, tie: true };
      }
    }
    out.push(y);
    real += x.pnl;
  }
  return out;
}
const TGT = [0.1, 0.25, 0.5, 1, null], LOTS = [2, 4, 8, 16, 32, 64];
const tl = (t, s) => (t === null ? "as shipped" : `${t} ATR`);

console.log("=".repeat(132));
console.log("SMALLER TARGETS, MORE LOTS -- the $1,250 MACD fade and Donchian; only the target and the lot size change");
console.log("=".repeat(132));
for (const st of STRATS) {
  const cell = new Map();
  for (const t of TGT) for (const L of LOTS) {
    const tr = st.run(L, t), arr = S.dayArr(tr, S.days), T = tr.filter((x) => yr(x.tday) === 2026);
    let day = -1, real = 0;
    const stops = [];
    for (const x of T) { if (x.tday !== day) { day = x.tday; real = 0; } stops.push(Math.min((600 + real) / (2 * x.lots), 5.15 * x.atr + 0.25) / x.atr); real += x.pnl; }
    const n = T.length, net = T.reduce((s, x) => s + x.pnl, 0), cost = T.reduce((s, x) => s + COST * x.lots, 0);
    const best = resolveTies(tr, t, st, "best");
    const neutral = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => resolveTies(tr, t, st, "neutral", seed));
    const n26 = neutral.map((nt) => nt.filter((x) => yr(x.tday) === 2026));
    cell.set(`${t}|${L}`, { p26: pass(arr, Y26), pre: pass(arr, PRE), win: (100 * T.filter((x) => x.pnl > 0).length) / n,
                            net: net / n, gross: (net + cost) / n, cost: cost / n, stop: med(stops), n,
                            ties: (100 * best.filter((x) => x.tie && yr(x.tday) === 2026).length) / n,
                            b26: pass(S.dayArr(best, S.days), Y26),
                            n26: neutral.reduce((s, nt) => s + pass(S.dayArr(nt, S.days), Y26), 0) / neutral.length,
                            nwin: n26.reduce((s, T2) => s + (100 * T2.filter((x) => x.pnl > 0).length) / T2.length, 0) / n26.length,
                            nnet: n26.reduce((s, T2) => s + T2.reduce((u, x) => u + x.pnl, 0) / T2.length, 0) / n26.length });
  }
  console.log(`\n${st.name}; "as shipped" = ${st.shipped}`);
  const grid = (title, f) => {
    console.log(`   ${title.padEnd(34)}` + LOTS.map((L) => `${L} lots`.padStart(15)).join(""));
    for (const t of TGT) console.log(`   ${("target " + tl(t)).padEnd(34)}` + LOTS.map((L) => f(cell.get(`${t}|${L}`)).padStart(15)).join(""));
  };
  grid("PASS RATE, 2026", (c) => c.p26.toFixed(1));
  grid("PASS RATE, May 2019-Dec 2025", (c) => c.pre.toFixed(1));
  grid("WIN RATE, 2026", (c) => c.win.toFixed(1));
  grid("2026 $/TRADE: before costs / costs", (c) => `${Math.round(c.gross)} / ${Math.round(c.cost)}`);
  grid("STOP DISTANCE, ATR (2026 median)", (c) => c.stop.toFixed(2));
  grid("2026 STOP/TARGET TIES IN ONE BAR, %", (c) => c.ties.toFixed(1));
  grid("NEUTRAL TIES: PASS 2026", (c) => c.n26.toFixed(1));
  grid("NEUTRAL TIES: WIN RATE 2026", (c) => c.nwin.toFixed(1));
  grid("NEUTRAL TIES: $/TRADE AFTER COSTS", (c) => String(Math.round(c.nnet)));
  grid("BEST CASE, EVERY TIE A WIN: PASS 2026", (c) => c.b26.toFixed(1));
}
