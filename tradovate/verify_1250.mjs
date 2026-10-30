// Do the two $1,250-rule indicators trade what the research measured?
//
// Runs mnqDonchian1250.js (2-min) and mnqMacdFade1250.js (1-min) exactly as
// Tradovate would -- CommonJS module, `new calculator()`, props, init(), then
// map(d, i) once per bar in order -- on the mock of its runtime (tradovate/mock/),
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
//   6. what the chart says, on every 2026 bar: each reading printed under an
//      order and each refusal printed in grey, against this file's research
//      arrays and the chart lab's own explain() for that bar
//   7. a session that ends early with a trade open, and a scheduled early close
//   8. every 2026 trade against the chart lab's books (strategies/
//      donchian_1250.mjs, macd_fade_1250.mjs) on the $1,250 eval
//
// The indicators carry a test-only switch (props.__research) that swaps the
// live price conventions (orders from the signal close, on real ticks, no
// slippage) for the research model's (orders from the next open, 1 tick of
// slippage a side). Timing, direction, size and the exit and day rules are
// the same code in both, except a session that ends early: live, a trade still
// open goes out at that session's last close; the research ran it to the next
// open.
//
//   node --max-old-space-size=8192 tradovate/verify_1250.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { adx as adxOf, donchian, ema, macd } from "../src/indicators.mjs";
import { resample } from "../src/resample.mjs";
import { loadBars } from "../src/data.mjs";
import { resolveExec } from "../src/engine.mjs";
import { evalBase } from "../src/evals.mjs";
import { loadStrategies } from "../src/registry.mjs";
import { runStrategy } from "../src/run.mjs";
import { checkOutput as checkItems, loadIndicator as loadWith, Problems } from "./mock/runtime.mjs";
import { loadTools } from "./mock/library.mjs";
import * as S from "../research/lib_shipped.mjs";
import * as M from "../research/lib_donchian_mgmt.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const FILL = { slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: 600, profitBlock: 250, cancelOpposite: true };

// The chart lab's book on the $1,250 eval, with its per-bar explanations.
const { bars: B1 } = loadBars();
const STRATS = await loadStrategies();
function labRun(id) {
  const s = STRATS.get(id), b = evalBase(s, "1250");
  return runStrategy(B1, s, b.params, resolveExec(b.exec), { filter: b.filter, explain: true });
}

// ── load an indicator the way Tradovate does ─────────────────────────────
const TOOLS = loadTools();
const loadIndicator = (file) => loadWith(fs.readFileSync(path.join(HERE, file), "utf8"), TOOLS);
const defaults = (mod) => Object.fromEntries(Object.entries(mod.params).map(([k, s]) => [k, s.def]));
const mkD = (b, i) => ({ open: () => b.o, high: () => b.h, low: () => b.l, close: () => b.c,
                         volume: () => 0, timestamp: () => new Date(b.ts), index: () => i, value: () => b.c });
const barOf = (T, i) => ({ ts: T.ts[i], o: T.open[i], h: T.high[i], l: T.low[i], c: T.close[i] });

// Everything Tradovate will be handed must be what its definitions accept.
function checkOutput(mod, out, where) {
  const found = new Problems();
  checkItems(out, 0, mod, found);
  const bad = found.list().filter((p) => p.level === "error");
  if (bad.length) throw new Error(where + ": " + bad[0].text);
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "   " + detail : "")); };
const fmt = (n) => n.toLocaleString("en-US");

// Run an indicator over a bar set and return its trades in lib_shipped's terms.
function runIndicator(mod, T, minutesPerBar, props, onBar) {
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
    if (ev.fill) open = { entIdx: i, lots: ev.fill.lots, dir: ev.fill.dir };
    if (ev.exit) {
      const x = ev.exit;
      trades.push({ tday: T.tday[i], entCt: T.ctMin[open.entIdx], held: (i - open.entIdx) * minutesPerBar, lots: open.lots, pnl: x.pnl,
                    why: x.why === "SL" && x.capped ? "SLcap" : x.why === "TIME" ? "XSIG" : x.why,
                    entIdx: open.entIdx, exitIdx: i, dir: open.dir });
      open = null;
    }
  }
  return trades;
}

// Every 2026 trade against the chart lab's book: entry bar, side, exit bar, size,
// dollars. The lab's exact-loss floor and gap fills only ever differ by cents on
// a stop or a fill price, and 2026 has none: the check is to the cent.
function compareLab(label, mine, lab, from) {
  const key = (t) => t.entIdx + ":" + t.dir;
  const a = mine.filter((t) => t.entIdx >= from);
  const b = lab.filter((t) => t.entryIdx >= from).map((t) => ({ entIdx: t.entryIdx, exitIdx: t.exitIdx, lots: t.contracts, dir: t.dir, pnl: t.pnl }));
  const byKey = new Map(b.map((t) => [key(t), t]));
  let same = 0, first = null;
  for (const t of a) {
    const u = byKey.get(key(t));
    if (u && u.exitIdx === t.exitIdx && u.lots === t.lots && Math.abs(u.pnl - t.pnl) < 0.01) same++;
    else if (!first) first = { indicator: t, lab: u || null };
  }
  const usd = (l) => "$" + l.reduce((s, t) => s + t.pnl, 0).toFixed(0);
  check(label + ": every 2026 trade = the chart lab's book", same === a.length && a.length === b.length,
        fmt(same) + " of " + fmt(b.length) + " identical (indicator " + fmt(a.length) + ", " + usd(a) + "; lab " + usd(b) + ")" +
        (first ? "; first difference " + JSON.stringify(first) : ""));
}

// A reading printed rounded down: `shown` must be v, floored to `step`.
const floored = (shown, v, step) => shown <= v + 1e-9 && v < shown + step + 1e-9;
const itemOf = (out, i, k) => ((out.graphics && out.graphics.items) || []).find((x) => x.key === k + i);

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
function liveLines(label, mod, T, extraProps = {}, onBar = null) {
  const calc = new mod.calculator();
  const props = { ...defaults(mod), ...extraProps, __research: false };
  calc.props = props;
  calc.init();
  const n = T.close.length;
  let prevPre = null, prevOut = null, prevS = null, prevB = null, arms = 0, plain = 0, plainPre = 0, plainSame = 0, plainJoined = 0;
  let flips = 0, flipPre = 0, flipCore = 0, flipSame = 0, flipExplained = 0, flipWorst = 0, flipNoPre = 0, flipNoPreEst = 0;
  let stubs = 0, previews = 0, early = 0, earlyOk = 0;
  const eg = [];
  for (let i = 0; i < n; i++) {
    const out = calc.map(mkD(barOf(T, i), i), i);
    if (i % 1499 === 0) checkOutput(mod, out, "live bar " + i);
    const { ev, pre, S: st, B } = out._ev;
    if (onBar) onBar(i, out);
    // A session that ended with a trade still open: out at its last close, the
    // dollars on that day's books, and the new day starting from nothing.
    if (ev.exit && B.sk !== prevB.sk) {
      early++;
      const net = (prevB.c - prevS.fill) * prevS.pos * 2 * prevS.lots - 1.5 * prevS.lots;
      if (ev.exit.early && ev.exit.px === prevB.c && Math.abs(ev.exit.pnl - net) < 1e-6 && st.dayReal === 0 && !st.capHit) earlyOk++;
    }
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
  check(label + ": a session ending with a trade open: out at its last close, on its own books", earlyOk === early && early > 0,
        fmt(earlyOk) + " of " + fmt(early) + " such trades");
  console.log("        " + fmt(stubs) + " of " + fmt(previews) + " signal-candle previews (" + (100 * stubs / Math.max(1, previews)).toFixed(1) +
              "%) were not followed by an order: the next bar stopped out or");
  console.log("        filled the open trade first, or a missing next minute pushed it past 14:55. Those leave a one-candle stub.");
}

// A scheduled early close. No data has one yet, so a real winter day with a trade
// open across the flat time is replayed as Thanksgiving 2026 or the day after --
// the same bars, moved a whole number of weeks, both dates on Central Standard Time
// -- and against itself unmoved: the same until the no-order time, then out at the
// flat time, with nothing new after it.
function earlyClose(label, mod, T, mine) {
  const DAY = 86400000, dates = { 4: [Date.UTC(2026, 10, 26), 690, 700], 5: [Date.UTC(2026, 10, 27), 705, 715] };
  const ok = mine.filter((t) => {
    const d = new Date(T.ts[t.entIdx]), s = dates[d.getUTCDay()];
    return s && [11, 0, 1].includes(d.getUTCMonth()) && T.tday[t.entIdx] === T.tday[t.exitIdx] && T.ctMin[t.entIdx] < s[1] && T.ctMin[t.exitIdx] > s[2];
  });
  let cases = 0, good = 0;
  const eg = [];
  for (const t of ok) {
    const s = dates[new Date(T.ts[t.entIdx]).getUTCDay()], shift = s[0] - T.tday[t.entIdx] * DAY;
    const i0 = t.entIdx - 12 * 1380 / (T.tfMin || 1), runs = [0, shift].map((dt) => {
      const calc = new mod.calculator();
      calc.props = { ...defaults(mod), __research: false };
      calc.init();
      const out = [];
      for (let i = Math.max(0, i0), k = 0; i <= t.exitIdx + 3; i++, k++) {
        const b = barOf(T, i);
        out.push({ ct: T.ctMin[i], i, ...calc.map(mkD({ ...b, ts: b.ts + dt }, k), k)._ev });
      }
      return out;
    });
    const [plain, moved] = runs;
    const same = moved.every((r, k) => r.i < t.entIdx || r.ct >= s[1] || (r.S.pos === plain[k].S.pos && r.S.fill === plain[k].S.fill));
    const after = moved.filter((r) => r.i > t.entIdx && r.ct >= s[2] && T.tday[r.i] === T.tday[t.entIdx]);
    const out = after[0] && after[0].ev.exit && after[0].ev.exit.why === "FLAT" && after.every((r) => r.S.pos === 0 && r.S.armDir === 0);
    const noArm = moved.every((r) => T.tday[r.i] !== T.tday[t.entIdx] || r.ct < s[1] || !r.ev.arm);
    if (!after.length || !plain.some((r) => r.i > t.entIdx && r.ct === after[0].ct && r.S.pos !== 0)) continue;   // live, this trade ended sooner
    cases++;
    if (same && out && noArm) good++;
    else if (eg.length < 1) eg.push({ day: new Date(T.ts[t.entIdx]).toISOString().slice(0, 10), same, out: !!out, noArm });
  }
  check(label + ": a scheduled early close: nothing new from 15 minutes before the cutoff, out 5 before it", cases > 0 && good === cases,
        fmt(good) + " of " + fmt(cases) + " real days replayed as Thanksgiving week" + (eg.length ? "; " + JSON.stringify(eg[0]) : ""));
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
  const mine = runIndicator(DON, tf, 2, { ...defaults(DON), __research: true }, (i, out) => {
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
  const d0 = S.dayFirstBar.get(S.days[M.Y26[0]]);
  const LAB = labRun("donchian_1250");
  check("the lab's 2-minute bars are this file's", LAB.tf.close.length === nT && LAB.tf.ts[nT - 1] === tf.ts[nT - 1] && LAB.tf.close[d0] === tf.close[d0]);
  compareLab("Donchian", mine, LAB.trades, d0);

  // What the chart says about each 2026 bar: under an order, the readings its
  // rules used and the level it broke; in grey, why a close outside the channel
  // is no signal. Against the research arrays above and the lab's explain().
  const eff = ctx.eff, W = { orders: 0, ordersBad: 0, levelsBad: 0, refused: 0, refusedBad: 0, refusedMissing: 0, eg: null };
  const word = (d) => (d === 1 ? "up" : d === -1 ? "down" : "flat");
  const blocked = (st) => st.capHit || st.dayReal <= -300 || st.dayReal >= 250;
  let lastSide = 0;
  const seeWhy = (i, out) => {
    const c = tf.close[i], side = i >= 30 ? (c > dh[i] ? 1 : c < dl[i] ? -1 : 0) : 0;
    const fresh = side !== 0 && side !== lastSide;
    lastSide = side;
    if (i < d0) return;
    const { S: st, pre, B } = out._ev;
    const w = itemOf(out, i, "w"), r = itemOf(out, i, "r");
    if (pre && !w && SIG[i - 1] !== SIG[i]) W.ordersBad++;      // a run of breakouts says why on its first bar
    if (w) {
      W.orders++;
      const e = LAB.explain(i);
      const m = /^ADX (\d+) · eff (\d\.\d\d)( \+ trend)? · 10m (up|down|flat)(?: · range (\d+)%)?$/.exec(w.text);
      const u = M.adrUsed(i);
      const ok = m && pre && e.dir === SIG[i] && e.dir !== 0 && e.size === (B.lots === 2 ? 0.5 : 1) && floored(+m[1], ax[i], 1) && floored(+m[2], eff[i], 0.01) &&
                 !!m[3] === (plain[i] === 0) && m[4] === word(HTF[i]) && (m[5] === undefined ? !(u > 0) : floored(+m[5], 100 * u, 1));
      if (!ok) { W.ordersBad++; W.eg = W.eg || { i, text: w.text }; }
      const seg = itemOf(out, i, "lvl").lines[0], lvl = SIG[i] === 1 ? dh[i] : dl[i], at = seg.a.x.value;
      const lab = itemOf(out, i, "ll");
      const setBy = SIG[i] === 1 ? tf.high[at] : tf.low[at];
      if (!(seg.a.y.value === lvl && seg.b.y.value === lvl && seg.b.x.value === i && setBy === lvl && at >= i - 30 && at < i &&
            lab.text === "30-bar " + (SIG[i] === 1 ? "high " : "low ") + lvl.toFixed(2))) { W.levelsBad++; W.eg = W.eg || { i, seg, lvl }; }
    }
    const due = fresh && SIG[i] === 0 && tf.ctMin[i] >= 510 && tf.ctMin[i] < 900 && st.pos !== side && !blocked(st);
    if (r) {
      W.refused++;
      const e = LAB.explain(i);
      const adxC = e.checks.find((x) => x.label.startsWith("ADX")), effC = e.checks.find((x) => x.label.startsWith("Efficiency"));
      const m = /^× (?:ADX (\d+))?(?: · )?(?:eff (\d\.\d\d)( vs trend)?)?$/.exec(r.text);
      const ok = m && due && e.dir === 0 && e.checks.some((x) => x.role === "trigger" && x.pass && x.label.startsWith("Close ")) &&
                 adxC.pass === (m[1] === undefined) && (m[1] === undefined || floored(+m[1], ax[i], 1)) &&
                 (m[2] === undefined ? !(eff[i] < 0.5) : floored(+m[2], eff[i], 0.01) && eff[i] < 0.5) &&
                 (!effC || (effC.pass === false && !!m[3] === /other way/.test(effC.note)));
      if (!ok) { W.refusedBad++; W.eg = W.eg || { i, text: r.text, checks: e.checks.map((x) => [x.label, x.pass, x.text]) }; }
    } else if (due) { W.refusedMissing++; W.eg = W.eg || { i, missing: true }; }
  };
  liveLines("Donchian", DON, tf, {}, seeWhy);
  check("every 2026 order's readings = the research's and the lab's explanation of that bar", W.orders > 0 && W.ordersBad === 0,
        W.ordersBad + " off of " + fmt(W.orders) + (W.eg ? "; e.g. " + JSON.stringify(W.eg) : ""));
  check("...and the level drawn is the close's breakout, from the bar that set it", W.orders > 0 && W.levelsBad === 0, W.levelsBad + " off");
  check("every refused breakout in 2026 is marked, for the reason the lab gives", W.refused > 0 && W.refusedBad === 0 && W.refusedMissing === 0,
        fmt(W.refused) + " marks (" + (W.refused / M.Y26.length).toFixed(1) + " a session), " + W.refusedBad + " wrong, " + W.refusedMissing + " missing");
  earlyClose("Donchian", DON, tf, mine);
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
  const mine = runIndicator(MAC, t1, 1, { ...defaults(MAC), __research: true }, (i, out) => {
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
  let d0 = 0;
  const first26 = S.days[M.Y26[0]];
  while (d0 < n1 && t1.tday[d0] !== first26) d0++;
  const LAB = labRun("macd_fade_1250");
  check("the lab's 1-minute bars are this file's", LAB.tf.close.length === n1 && LAB.tf.ts[n1 - 1] === t1.ts[n1 - 1] && LAB.tf.close[d0] === t1.close[d0]);
  compareLab("MACD fade", mine, LAB.trades, d0);

  // What the chart says about each 2026 cross: under an order, the cross and the
  // readings its gates used; in grey, the word and the reading that refused it.
  // Against the research arrays above and the lab's explain().
  const W = { orders: 0, ordersBad: 0, skipped: 0, skippedBad: 0, eg: null };
  const near = (shown, v) => Math.abs(shown - v) <= 0.005 + 1e-9;
  const seeWhy = (i, out) => {
    if (i < d0) return;
    const { pre } = out._ev;
    const s = itemOf(out, i, "s"), w = itemOf(out, i, "w");
    if (pre && !w) W.ordersBad++;
    if (w) {
      W.orders++;
      const e = LAB.explain(i);
      const m = /^cross (up|down) · line ([+-]\d+\.\d\d) · ATR (\d+\.\d\d)×$/.exec(w.text);
      const ok = m && pre && e.dir === SIG[i] && e.dir !== 0 && e.size === 1 && (m[1] === "up") === (SIG[i] === -1) &&
                 near(+m[2], ML[i]) && Math.sign(ML[i]) === SIG[i] && floored(+m[3], volRel[i], 0.01) && volRel[i] >= 1;
      if (!ok) { W.ordersBad++; W.eg = W.eg || { i, text: w.text }; }
    }
    const g = s && /(?:▲|▼) (strong|quiet)/.exec(s.text);
    if (g) {
      W.skipped++;
      const e = LAB.explain(i);
      const weak = e.checks.find((x) => x.label.startsWith("Weak cross")), busy = e.checks.find((x) => x.label.startsWith("ATR at least"));
      const line = / · line ([+-]\d+\.\d\d)/.exec(s.text), atr = / · ATR (\d+\.\d\d)×/.exec(s.text);
      const ok = e.dir === SIG[i] && e.size === 0 && !gate(i) && (g[1] === "strong") === !weak.pass &&
                 !!line === !weak.pass && !!atr === !busy.pass &&
                 (!line || (near(+line[1], ML[i]) && Math.sign(ML[i]) !== SIG[i])) && (!atr || (floored(+atr[1], volRel[i], 0.01) && volRel[i] < 1));
      if (!ok) { W.skippedBad++; W.eg = W.eg || { i, text: s.text, checks: e.checks.map((x) => [x.label, x.pass, x.text]) }; }
    }
  };
  liveLines("MACD fade", MAC, t1, {}, seeWhy);
  check("every 2026 order's readings = the research's and the lab's explanation of that bar", W.orders > 0 && W.ordersBad === 0,
        W.ordersBad + " off of " + fmt(W.orders) + (W.eg ? "; e.g. " + JSON.stringify(W.eg) : ""));
  check("every grey cross in 2026 gives the reason the lab gives", W.skipped > 0 && W.skippedBad === 0, fmt(W.skipped) + " marks, " + W.skippedBad + " wrong");
  earlyClose("MACD fade", MAC, t1, mine);
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
