// Do the two $1,250-rule indicators trade what the research measured?
//
// Runs mnqDonchian1250.js (2-min) and mnqMacdFade1250.js (1-min) exactly as
// Tradovate would -- CommonJS module, `new calculator()`, props, init(), then
// map(d, i) once per bar in order -- with the Tradovate tool modules stubbed,
// over the whole history, and checks each against research/rules_1250_2026.mjs:
//
//   1. the signal on every bar
//   2. EVERY trade against research/lib_shipped.mjs run with the options the
//      research measured -- day rules included (breaker -$300 Donchian / -$200
//      MACD, profit block +$250, $600 daily limit, a signal the other way
//      cancels a resting order, the causal exit order; the Donchian's 10-min
//      EMA filter and the MACD fade's weak-cross and volatility gate): entry,
//      size, exit reason, hold and dollars
//   3. the 2026 pass rate rebuilt from the indicator's own trades
//   4. the live convention: each order's lines start ON its signal candle
//   5. a still-forming bar: Tradovate re-calls map() on the live bar as ticks
//      arrive, so a slice is repeated with an extra half-built call per bar
//      and must come out identical
//
// The indicators carry a test-only switch (props.__research) that swaps the
// live price conventions (orders from the signal close, on real ticks, no
// slippage) for the research model's (orders from the next open, 1 tick of
// slippage a side). Timing, direction, size and the exit and day rules are
// the same code in both.
//
//   node --max-old-space-size=8192 tradovate/verify_1250.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { adx as adxOf, donchian, ema, macd } from "../src/indicators.mjs";
import { resample } from "../src/resample.mjs";
import { loadBars } from "../src/data.mjs";
import * as S from "../research/lib_shipped.mjs";
import * as M from "../research/lib_donchian_mgmt.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const FILL = { slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: 600, profitBlock: 250, cancelOpposite: true };

// ── load an indicator the way Tradovate does, with its tools stubbed ─────
function loadIndicator(file) {
  const src = fs.readFileSync(path.join(HERE, file), "utf8");
  const stubs = {
    "./tools/predef": { paramSpecs: {
      period: (v) => ({ kind: "int", def: v }),
      number: (v) => ({ kind: "number", def: v }),
      bool: (v) => ({ kind: "bool", def: v }) } },
    "./tools/meta": { InputType: { BARS: "BARS" }, AreaChoice: { OVERLAY: "OVERLAY" } },
    "./tools/graphics": { du: (v) => ({ du: v }), px: (v) => ({ px: v }), op: (a, o, b) => ({ op: [a, o, b] }) },
  };
  const module = { exports: {} };
  const req = (n) => { if (!(n in stubs)) throw new Error("unexpected require " + n); return stubs[n]; };
  new Function("require", "module", "exports", src)(req, module, module.exports);
  return module.exports;
}
const defaults = (mod) => Object.fromEntries(Object.entries(mod.params).map(([k, s]) => [k, s.def]));
const mkD = (b, i) => ({ open: () => b.o, high: () => b.h, low: () => b.l, close: () => b.c,
                         volume: () => 0, timestamp: () => new Date(b.ts), index: () => i, value: () => b.c });
const barOf = (T, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i] });

// Everything Tradovate will be handed must be a finite number or absent.
function checkOutput(mod, out, where) {
  for (const k of Object.keys(out)) {
    if (k === "graphics" || k === "_ev") continue;
    if (!(k in mod.plots)) throw new Error(where + ": undeclared plot " + k);
    if (out[k] !== undefined && !Number.isFinite(out[k])) throw new Error(where + ": plot " + k + " = " + out[k]);
  }
  const coordOk = (c) => !!c && (Number.isFinite(c.du) || Number.isFinite(c.px) ||
    (Array.isArray(c.op) && coordOk(c.op[0]) && typeof c.op[1] === "string" && coordOk(c.op[2])));
  for (const it of (out.graphics && out.graphics.items) || []) {
    if (!coordOk(it.point.x) || !coordOk(it.point.y)) throw new Error(where + ": bad graphics point " + JSON.stringify(it.point));
    if (typeof it.key !== "string" || typeof it.text !== "string") throw new Error(where + ": bad graphics item");
  }
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "   " + detail : "")); };
const fmt = (n) => n.toLocaleString("en-US");

// Run an indicator over a bar set and return its trades in lib_shipped's terms.
function runIndicator(mod, T, props, onBar) {
  const calc = new mod.calculator();
  calc.props = props;
  calc.init();
  const n = T.close.length, trades = [];
  let open = null;
  for (let i = 0; i < n; i++) {
    const out = calc.map(mkD(barOf(T, i), i), i);
    if (i % 997 === 0) checkOutput(mod, out, "bar " + i);
    const { ev } = out._ev;
    if (onBar) onBar(i, out);
    if (ev.fill) open = { entIdx: i, lots: ev.fill.lots };
    if (ev.exit) {
      const x = ev.exit;
      trades.push({ tday: T.tday[i], entCt: T.ctMin[open.entIdx], held: (i - open.entIdx) * 2, lots: open.lots, pnl: x.pnl,
                    why: x.why === "SL" && x.capped ? "SLcap" : x.why === "TIME" ? "XSIG" : x.why });
      open = null;
    }
  }
  return trades;
}

// Every trade, in order, against lib_shipped's.
function compareTrades(label, mine, lib) {
  let same = 0, first = null;
  const n = Math.max(mine.length, lib.length);
  for (let k = 0; k < n; k++) {
    const a = mine[k], b = lib[k];
    const ok = a && b && a.tday === b.tday && a.entCt === b.entCt && a.why === b.why && a.held === b.held &&
               a.lots === b.lots && Math.abs(a.pnl - b.pnl) < 1e-6;
    if (ok) same++; else if (!first) first = { k, indicator: a || null, lib: b ? { tday: b.tday, entCt: b.entCt, why: b.why, held: b.held, lots: b.lots, pnl: b.pnl } : null };
  }
  check(label + ": every trade, all years -- entry, size, exit reason, hold, dollars",
        same === n && mine.length === lib.length,
        fmt(same) + " of " + fmt(lib.length) + " identical (indicator " + fmt(mine.length) + ")" + (first ? "; first difference " + JSON.stringify(first) : ""));
}

// The 2026 pass rate and trade stats from a trade list.
function score(trades) {
  const arr = S.dayArr(trades, S.days);
  const p = (ix) => S.passArr(ix.map((k) => arr[k]), RULES);
  const t26 = trades.filter((t) => S.yearOf.get(t.tday) === 2026);
  const by = {};
  for (const t of t26) by[t.why] = (by[t.why] || 0) + 1;
  return { y26: p(M.Y26), a26: p(M.Y26a), b26: p(M.Y26b), n: t26.length,
           win: (100 * t26.filter((t) => t.pnl > 0).length) / Math.max(1, t26.length),
           exp: t26.reduce((s, t) => s + t.pnl, 0) / Math.max(1, t26.length), by };
}
function report(label, mine, lib) {
  const a = score(mine), b = score(lib);
  check(label + ": 2026 pass rate from the indicator's own trades = the research's",
        a.y26 === b.y26 && a.a26 === b.a26 && a.b26 === b.b26,
        a.y26.toFixed(1) + "% (Jan-Mar " + a.a26.toFixed(1) + ", Apr-Jul " + a.b26.toFixed(1) + ") vs " +
        b.y26.toFixed(1) + "% (" + b.a26.toFixed(1) + ", " + b.b26.toFixed(1) + ")");
  console.log("        2026: " + fmt(a.n) + " trades, " + a.win.toFixed(1) + "% winners, $" + a.exp.toFixed(1) + " a trade after costs; exits " +
              Object.entries(a.by).sort((x, y) => y[1] - x[1]).map(([w, n]) => (w === "XSIG" ? "TIME" : w) + " " + n).join(", "));
}

// Live convention: an arm's levels must be drawn on the signal candle first.
// A flip books the open trade at the arm bar's OPEN before the order goes in,
// and the candle can only estimate that result at its CLOSE. So for a flip:
// entry, target and size must match exactly; the stop may move, but only by
// what the open's distance from the close does to the day's $600 budget; and
// a flip whose estimate ended the day (no order drawn) but whose real result
// did not is counted, not failed.
function liveLines(label, mod, T, extraProps = {}) {
  const calc = new mod.calculator();
  const props = { ...defaults(mod), ...extraProps, __research: false };
  calc.props = props;
  calc.init();
  const n = T.close.length;
  let prevPre = null, prevOut = null, prevS = null, prevB = null, arms = 0, plain = 0, plainPre = 0, plainSame = 0, plainJoined = 0;
  let flips = 0, flipPre = 0, flipCore = 0, flipSame = 0, flipExplained = 0, flipWorst = 0, flipNoPre = 0, flipNoPreEst = 0;
  let stubs = 0, previews = 0;
  const eg = [];
  for (let i = 0; i < n; i++) {
    const out = calc.map(mkD(barOf(T, i), i), i);
    if (i % 1499 === 0) checkOutput(mod, out, "live bar " + i);
    const { ev, pre, S: st, B } = out._ev;
    if (ev.arm) {
      arms++;
      const flip = !!(ev.exit && ev.exit.why === "FLIP");
      const a = ev.arm, p = prevPre;
      const k = ["A", "B", "C"][st.armSet];
      if (flip) {
        flips++;
        const est = prevS.dayReal + (prevB.c - prevS.fill) * prevS.pos * 2 * prevS.lots - 1.5 * prevS.lots;
        if (p) {
          flipPre++;
          if (a.px === p.px && a.tp === p.tp && a.lots === p.lots) flipCore++;
          if (a.sl === p.sl) flipSame++;
          // the real flip result differs from the estimate by (open - close) x position
          const moved = Math.abs((B.o - prevB.c) * prevS.pos * 2 * prevS.lots) / (2 * a.lots);
          if (Math.abs(a.sl - p.sl) <= moved + 0.25 + 1e-9) flipExplained++;
          flipWorst = Math.max(flipWorst, Math.abs(a.sl - p.sl) / 0.25);
        } else {
          flipNoPre++;
          const blk = est <= -props.dayLossLimit || (props.breaker > 0 && est <= -props.breaker) || (props.profitBlock > 0 && est >= props.profitBlock);
          if (blk) flipNoPreEst++;
        }
      } else {
        plain++;
        if (p) {
          plainPre++;
          if (a.px === p.px && a.sl === p.sl && a.tp === p.tp && a.lots === p.lots) plainSame++;
          else if (eg.length < 2) eg.push({ i, arm: a, preview: p });
          if (prevOut && prevOut["trig" + k] === out["trig" + k] && prevOut["stop" + k] === out["stop" + k] &&
              prevOut["target" + k] === out["target" + k]) plainJoined++;
        }
      }
    } else if (prevPre) stubs++;
    if (pre) previews++;
    prevPre = pre; prevOut = out; prevS = st; prevB = B;
  }
  check(label + ": every order (not a flip) was drawn on its signal candle first", plainPre === plain,
        fmt(plainPre) + " of " + fmt(plain));
  check(label + ": ...at exactly the prices the order then rests at, the line running on unbroken",
        plainSame === plainPre && plainJoined === plainPre,
        fmt(plainSame) + " identical, " + fmt(plainJoined) + " joined" + (eg.length ? "; e.g. " + JSON.stringify(eg[0]) : ""));
  check(label + ": flips drawn on the signal candle: same entry, target and size", flipCore === flipPre,
        fmt(flipCore) + " of " + fmt(flipPre));
  check(label + ": ...and the stop moves only by what the open's gap from the close explains", flipExplained === flipPre,
        "identical on " + fmt(flipSame) + ", explained on " + fmt(flipExplained) + " of " + fmt(flipPre) + ", largest move " + flipWorst + " ticks");
  check(label + ": flips with no order drawn are exactly those the close said would end the day", flipNoPreEst === flipNoPre,
        fmt(flipNoPre) + " of " + fmt(flips) + " flips (" + (100 * flipNoPre / Math.max(1, flips)).toFixed(2) + "%): their lines start one candle later");
  console.log("        " + fmt(stubs) + " of " + fmt(previews) + " signal-candle previews (" + (100 * stubs / Math.max(1, previews)).toFixed(1) +
              "%) were not followed by an order: the next bar stopped out or");
  console.log("        filled the open trade first, or a missing next minute pushed it past 14:55. Those leave a one-candle stub.");
}

// A forming bar must change nothing (live and research conventions).
function forming(label, mod, T, from, to) {
  const sub = { length: to - from };
  const bar = (i) => barOf(T, from + i);
  for (const research of [false, true]) {
    const trace = [[], []];
    for (const pass of [0, 1]) {
      const calc = new mod.calculator();
      calc.props = { ...defaults(mod), __research: research };
      calc.init();
      for (let i = 0; i < sub.length; i++) {
        const b = bar(i);
        if (pass === 1) calc.map(mkD({ ts: b.ts, o: b.o, h: b.o, l: b.o, c: b.o }, i), i);
        const out = calc.map(mkD(b, i), i);
        checkOutput(mod, out, "forming bar " + i);
        trace[pass].push(JSON.stringify(out, (k, v) => (k === "_ev" ? undefined : v)) + JSON.stringify(out._ev.ev));
      }
    }
    let diff = 0;
    for (let i = 0; i < sub.length; i++) if (trace[0][i] !== trace[1][i]) diff++;
    check(label + ": re-calling map() on a forming bar changes nothing (" + (research ? "research" : "live") + ")", diff === 0,
          fmt(sub.length) + " bars, " + diff + " differ");
  }
}

console.log("");
console.log("=".repeat(100));
console.log("THE $1,250-RULE INDICATORS vs research/rules_1250_2026.mjs");
console.log("=".repeat(100));

// ── A. mnqDonchian1250 on 2-minute bars ──────────────────────────────────
console.log("");
console.log("A. mnqDonchian1250 -- Donchian 30 + ADX + efficiency + rescue, 10-min EMA 9/21 filter, 4 lots (2 late), 40-min exit, causal exit order");
{
  const DON = loadIndicator("mnqDonchian1250.js");
  const tf = M.tf, nT = tf.close.length;
  // The gated signal as lib_shipped builds it plus the slow-trend rescue, with
  // the 1,500-bar floor the indicator enforces (research/lib_donchian_mgmt.mjs's
  // RESC has no floor; the two differ only in the first 1,500 bars of 2019).
  const ctx = buildFilterContext(tf);
  const { adx: ax } = adxOf(tf.high, tf.low, tf.close, 14);
  const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
  const raw = new Int8Array(nT);
  for (let i = 30; i < nT; i++) {
    if (ax[i] < 25) continue;
    if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
  }
  const plain = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
  const low = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.45 });
  const ef = ema(tf.close, 125), es = ema(tf.close, 500);
  const SIG = Int8Array.from(plain);
  for (let k = 1499; k < nT; k++) if (!plain[k] && low[k] && (Math.sign(ef[k] - es[k]) || 0) === raw[k]) SIG[k] = low[k];
  let resDiff = 0;
  for (let k = 1499; k < nT; k++) if (SIG[k] !== M.RESC[k]) resDiff++;
  check("signal built here = the research's RESC after the 1,500-bar floor", resDiff === 0, resDiff + " off");

  // the 10-min EMA 9/21 as research/donchian_ema_age_2026.mjs reads it: built
  // from the 1-MINUTE bars, the last 10-min bar that has closed by the time the
  // 2-min bar closes
  const HTF = new Int8Array(nT);
  {
    const { bars: b1 } = loadBars();
    const T10 = resample(b1, 10), f10 = ema(T10.close, 9), s10 = ema(T10.close, 21);
    let j = -1;
    for (let k = 0; k < nT; k++) {
      const lim = tf.ts[k] + 120000 - 600000;
      while (j + 1 < T10.ts.length && T10.ts[j + 1] <= lim) j++;
      HTF[k] = j >= 0 ? Math.sign(f10[j] - s10[j]) || 0 : 0;
    }
  }
  const gate = (k) => SIG[k] !== 0 && HTF[k] === SIG[k];
  let badSig = 0, badLots = 0, nSig = 0, nLate = 0, badHtf = 0, badGate = 0, nGate = 0;
  const mine = runIndicator(DON, tf, { ...defaults(DON), __research: true }, (i, out) => {
    const B = out._ev.B;
    if (B.sig !== SIG[i]) badSig++;
    if (B.htf !== HTF[i]) badHtf++;
    if (B.sig !== 0) {
      nSig++;
      if (B.lots !== (M.adrUsed(i) >= 0.9 ? 2 : 4)) badLots++;
      if (B.lots === 2) nLate++;
      if (B.enter !== gate(i)) badGate++;
      if (B.enter) nGate++;
    }
  });
  check("signal on every one of " + fmt(nT) + " two-minute bars", badSig === 0, badSig + " off; " + fmt(nSig) + " signals");
  check("size at every signal: 4 lots, 2 once the day's range reaches 0.9x its 10-session average", badLots === 0,
        badLots + " off; " + fmt(nLate) + " at 2 lots");
  check("10-min EMA 9/21 direction on every 2-minute bar = research (built from 1-min bars)", badHtf === 0, badHtf + " off");
  check("which breakouts are traded (the EMA agrees) at every signal = research", badGate === 0,
        badGate + " off; " + fmt(nGate) + " of " + fmt(nSig) + " traded");
  const exit20 = (k, d, st) => k - st.entBar >= 20 && (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) < st.atr;
  const lib = S.run((a, c, s, arm) => (gate(arm - 1) ? (M.adrUsed(arm - 1) >= 0.9 ? 2 : 4) : 0),
                    { signals: SIG, ...FILL, breaker: 300, exitFn: exit20, exitFirst: true });
  compareTrades("Donchian", mine, lib);
  report("Donchian", mine, lib);
  liveLines("Donchian", DON, tf);
  const d0 = S.dayFirstBar.get(S.days[M.Y26[0]]);
  forming("Donchian", DON, tf, d0 - 3000, Math.min(nT, d0 + 25000));
}

// ── B. mnqMacdFade1250 on 1-minute bars ──────────────────────────────────
console.log("");
console.log("B. mnqMacdFade1250 -- fade WEAK 1-min MACD(12,26,9) crosses in a moving market, 4 lots, causal exit order");
{
  const MAC = loadIndicator("mnqMacdFade1250.js");
  const E1 = S.engineFor(1), t1 = E1.tf, n1 = t1.close.length, A1 = E1.atr;
  // the signal exactly as research/rules_1250_2026.mjs builds config A
  const { line: ML, hist } = macd(t1.close, 12, 26, 9);
  const SIG = new Int8Array(n1);
  for (let i = 1; i < n1; i++) {
    if (!(t1.ctMin[i] >= 510 && t1.ctMin[i] < 900)) continue;
    const c = hist[i] > 0 && hist[i - 1] <= 0 ? 1 : hist[i] < 0 && hist[i - 1] >= 0 ? -1 : 0;
    SIG[i] = -c;
  }
  // the entry gate exactly as research/macd_optimize_2026.mjs and
  // macd_weak_strong_2026.mjs build it: a weak cross (the MACD line on the
  // fade's side of zero) and ATR >= the mean ATR of the previous 10 sessions'
  // 08:30-15:00 bars (no gate before 10 sessions of history)
  const volRel = new Float64Array(n1).fill(NaN);
  {
    const days = [], first = new Map(), last = new Map();
    for (let i = 0; i < n1; i++) if (t1.ctMin[i] >= 510 && t1.ctMin[i] < 900) { if (!first.has(t1.tday[i])) { first.set(t1.tday[i], i); days.push(t1.tday[i]); } last.set(t1.tday[i], i); }
    const am = new Map();
    for (const d of days) { let s2 = 0, c2 = 0; for (let i = first.get(d); i <= last.get(d); i++) { s2 += A1[i]; c2++; } am.set(d, s2 / c2); }
    days.forEach((d, q) => { if (q < 10) return; const avg = days.slice(q - 10, q).reduce((x, p2) => x + am.get(p2), 0) / 10;
      for (let i = first.get(d); i <= last.get(d); i++) volRel[i] = A1[i] / avg; });
  }
  const gate = (k) => SIG[k] !== 0 && Math.sign(ML[k]) === SIG[k] && !(volRel[k] < 1);
  let badSig = 0, nSig = 0, badCt = 0, badSk = 0, badGate = 0, badVol = 0, nGate = 0, nStrong = 0;
  const mine = runIndicator(MAC, t1, { ...defaults(MAC), __research: true }, (i, out) => {
    const B = out._ev.B;
    if (B.sig !== SIG[i]) badSig++;
    if (B.ct !== t1.ctMin[i]) badCt++;
    if (B.sk !== t1.tday[i]) badSk++;
    if (B.sig !== 0) {
      nSig++;
      if (B.enter !== gate(i)) badGate++;
      if (!((Number.isNaN(B.volRel) && Number.isNaN(volRel[i])) || Math.abs(B.volRel - volRel[i]) < 1e-12)) badVol++;
      if (B.enter) nGate++;
      if (!B.weakOk) nStrong++;
    }
  });
  check("bar CT minute on every one of " + fmt(n1) + " one-minute bars", badCt === 0, badCt + " off");
  check("session on every bar is the research data's trading day", badSk === 0, badSk + " off");
  check("signal on every bar (the fade of each RTH cross)", badSig === 0, badSig + " off; " + fmt(nSig) + " signals");
  check("volatility vs its 10-session average at every signal = research", badVol === 0, badVol + " off");
  check("which crosses are faded (weak and moving) at every signal = research", badGate === 0,
        badGate + " off; " + fmt(nGate) + " of " + fmt(nSig) + " faded, " + fmt(nStrong) + " strong");
  const lib = E1.run((a, ct, sq, arm) => (gate(arm - 1) ? 4 : 0), { signals: SIG, ...FILL, breaker: 200, trig: 0.15, tpFromFill: true,
                                tpFn: (a, q) => Math.min(5.15 * a, 600 / (2 * q)), exitFirst: true });
  compareTrades("MACD fade", mine, lib);
  report("MACD fade", mine, lib);
  liveLines("MACD fade", MAC, t1);
  let d0 = 0;
  const first26 = S.days[M.Y26[0]];
  while (d0 < n1 && t1.tday[d0] !== first26) d0++;
  forming("MACD fade", MAC, t1, d0 - 5000, Math.min(n1, d0 + 40000));
}

// ── summary ──────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log("");
console.log("=".repeat(100));
console.log(failed.length ? "  " + failed.length + " CHECK(S) FAILED" : "  ALL " + results.length + " CHECKS PASS");
console.log("=".repeat(100));
console.log("");
process.exit(failed.length ? 1 : 0);
