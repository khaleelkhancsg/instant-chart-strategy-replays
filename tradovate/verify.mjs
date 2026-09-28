// Does the Tradovate code do what the live bot does?
//
// Runs both indicator files exactly as Tradovate would -- CommonJS module,
// `new calculator()`, props, init(), then map(d, i) once per bar in order --
// with the three Tradovate tool modules stubbed, and checks them against:
//
//   1. the clock: CT minute for all 2.5M bars against the dataset's own ctMin
//   2. bot/fixture_donchian.json -- the golden file bot/test_donchian_parity.py
//      holds the PYTHON bot to. Every indicator value and every signal.
//   3. seven years of 2-minute bars against the lab's gated signal
//   4. the order lifecycle against research/lib_shipped.mjs, the validated
//      model of the bot's stop-entry, bracket and cap
//   5. bot/fixture_orb.json -- 260 days of the bot's ORB levels and entries
//   6. seven years of ORB entries and exits against research/lib_orb.mjs
//   7. a still-forming bar: Tradovate re-calls map() on the live bar as ticks
//      arrive, so every run is repeated with an extra call per bar on a partial
//      bar first, and must come out identical
//
// The indicators carry a test-only switch (props.__research) that swaps the
// live bot's price conventions for the research model's, so the order logic
// can be matched exactly against lib_shipped / lib_orb. Only prices differ
// between the two conventions -- timing, direction and exit rules are shared.
//
//   node tradovate/verify.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBars } from "../src/data.mjs";
import { resample } from "../src/resample.mjs";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { adx as adxOf, donchian } from "../src/indicators.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

// ── load an indicator the way Tradovate does, with its tools stubbed ─────
function loadIndicator(file, append = "") {
  const src = fs.readFileSync(path.join(HERE, file), "utf8") + "\n" + append;
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

// Feed bars in order. With `forming`, each bar is first presented half-built
// (open only), then complete -- what Tradovate does to the live bar.
function feed(mod, bars, props, collect, forming = false) {
  const calc = new mod.calculator();
  calc.props = props;
  calc.init();
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (forming) calc.map(mkD({ ts: b.ts, o: b.o, h: b.o, l: b.o, c: b.o }, i), i);
    collect(i, calc.map(mkD(b, i), i), b);
  }
}

// Everything Tradovate will be handed must be a finite number or absent.
function checkOutput(mod, out, where) {
  for (const k of Object.keys(out)) {
    if (k === "graphics" || k === "_ev") continue;
    if (!(k in mod.plots)) throw new Error(where + ": undeclared plot " + k);
    if (out[k] !== undefined && !Number.isFinite(out[k])) throw new Error(where + ": plot " + k + " = " + out[k]);
  }
  for (const it of (out.graphics && out.graphics.items) || []) {
    if (!Number.isFinite(it.point.x.du) || !Number.isFinite(it.point.y.du)) throw new Error(where + ": bad graphics point " + JSON.stringify(it.point));
    if (typeof it.key !== "string" || typeof it.text !== "string") throw new Error(where + ": bad graphics item");
  }
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "   " + detail : "")); };
const near = (a, b, tol) => (a == null || Number.isNaN(a)) ? (b == null || Number.isNaN(b)) : (b != null && Math.abs(a - b) <= tol);

const DON = loadIndicator("mnqDonchianBot.js", "module.exports.__ctOf = ctOf;");
const ORB = loadIndicator("mnqOrbBot.js", "module.exports.__ctOf = ctOf;");
const { bars } = loadBars();
const N = bars.close.length;

console.log("");
console.log("=".repeat(96));
console.log("TRADOVATE INDICATORS vs THE LIVE BOT");
console.log("=".repeat(96));

// ── 1. the clock ─────────────────────────────────────────────────────────
console.log("");
console.log("1. clock -- CT minute for every 1-minute bar in the dataset");
{
  let badD = 0, badO = 0;
  const dayToTday = new Map(), tdayToDay = new Map();
  let clash = 0;
  for (let i = 0; i < N; i++) {
    if (DON.__ctOf(bars.ts[i]) !== bars.ctMin[i]) badD++;
    const c = ORB.__ctOf(bars.ts[i]);
    if (c.min !== bars.ctMin[i]) badO++;
    // Inside the ORB's hours a CT calendar date must be one CME trading day.
    if (c.min >= 390 && c.min < 600) {
      const t = bars.tday[i];
      if (dayToTday.has(c.day) && dayToTday.get(c.day) !== t) clash++;
      if (tdayToDay.has(t) && tdayToDay.get(t) !== c.day) clash++;
      dayToTday.set(c.day, t); tdayToDay.set(t, c.day);
    }
  }
  check("Donchian clock matches ctMin on " + N.toLocaleString() + " bars", badD === 0, badD + " mismatches");
  check("ORB clock matches ctMin on " + N.toLocaleString() + " bars", badO === 0, badO + " mismatches");
  check("ORB day key is one CME session through 06:30-10:00 CT", clash === 0, dayToTday.size + " days, " + clash + " clashes");
}

// ── 2. Donchian vs the bot's golden fixture ──────────────────────────────
console.log("");
console.log("2. Donchian vs bot/fixture_donchian.json (the Python bot's golden file)");
const fx = JSON.parse(fs.readFileSync(path.join(ROOT, "bot", "fixture_donchian.json"), "utf8"));
const fxBars = fx.bars2m.map((r) => ({ ts: r[0], o: r[1], h: r[2], l: r[3], c: r[4], ct: r[5] }));
function runDonFixture(forming) {
  const rows = [];
  feed(DON, fxBars, { ...defaults(DON), __research: false }, (i, out) => {
    checkOutput(DON, out, "fixture bar " + i);
    const { B } = out._ev;
    rows.push({ atr: B.atr, adx: B.adx, eff: B.eff, dh: B.dh, dl: B.dl, raw: B.raw, sig: B.sig, ct: B.ct,
                ev: JSON.stringify(out._ev.ev), plots: JSON.stringify(out, (k, v) => (k === "_ev" ? undefined : v)) });
  }, forming);
  return rows;
}
{
  const rows = runDonFixture(false);
  const I = fx.indicators;
  const fields = [["atr", "atr"], ["adx", "adx"], ["eff", "eff"], ["dh", "donHigh"], ["dl", "donLow"]];
  for (const [mine, theirs] of fields) {
    let bad = 0, worst = 0;
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i][mine], b = I[theirs][i];
      if (!near(a, b, 1e-6)) bad++;
      else if (b != null && Number.isFinite(a)) worst = Math.max(worst, Math.abs(a - b));
    }
    check(theirs.padEnd(8) + " on " + rows.length.toLocaleString() + " bars", bad === 0,
          bad + " off; worst |diff| " + worst.toExponential(1) + " (fixture is rounded to 6 dp)");
  }
  let badRaw = 0, badSig = 0, badCt = 0, nSig = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].raw !== fx.sigRaw[i]) badRaw++;
    if (rows[i].sig !== fx.sigMasked[i]) badSig++;
    if (rows[i].ct !== fxBars[i].ct) badCt++;
    if (fx.sigMasked[i]) nSig++;
  }
  check("raw signals exact", badRaw === 0, badRaw + " off");
  check("gated signals exact (the ones the bot trades)", badSig === 0, badSig + " off of " + nSig + " signals");
  check("bar CT minute exact", badCt === 0, badCt + " off");

  // 7a. the live bar: an extra half-built call per bar must change nothing
  const again = runDonFixture(true);
  let diff = 0;
  for (let i = 0; i < rows.length; i++) {
    if (JSON.stringify(rows[i]) !== JSON.stringify(again[i])) diff++;
  }
  check("re-calling map() on a forming bar changes nothing", diff === 0, diff + " bars differ");
}

// ── 3. Donchian over seven years vs the lab's gated signal ───────────────
console.log("");
console.log("3. Donchian over the full history vs the lab (built as research/lib_shipped.mjs builds it)");
const tf = resample(bars, 2);
const nT = tf.close.length;
const labSig = (() => {
  const ctx = buildFilterContext(tf);
  const { adx: ax } = adxOf(tf.high, tf.low, tf.close, 14);
  const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
  const raw = new Int8Array(nT);
  for (let i = 30; i < nT; i++) {
    if (ax[i] < 25) continue;
    if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
  }
  return applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
})();
const tfBars = { length: nT };
const tfBar = (i) => ({ ts: tf.ts[i], o: tf.open[i], h: tf.high[i], l: tf.low[i], c: tf.close[i] });
const donEvents = [];          // research-mode orders, for section 4
{
  let bad = 0, badCt = 0, labLabel = 0, nSig = 0, arms = 0, fills = 0, limitFills = 0;
  const calc = new DON.calculator();
  calc.props = { ...defaults(DON), __research: true };
  calc.init();
  let open = null;
  for (let i = 0; i < nT; i++) {
    const b = tfBar(i);
    const out = calc.map(mkD(b, i), i);
    if (i % 997 === 0) checkOutput(DON, out, "history bar " + i);
    const { B, ev, S } = out._ev;
    if (B.sig !== labSig[i]) bad++;
    // The bot labels a 2-minute bar by its bucket START (Bar2m.ts), as does
    // Tradovate. The lab labels it by the first minute that traded, which is
    // different when that minute printed nothing -- never across a session
    // boundary, since every one of them is an even minute.
    if (B.ct !== DON.__ctOf(tf.ts[i])) badCt++;
    if (tf.ctMin[i] !== B.ct) labLabel++;
    if (labSig[i]) nSig++;
    if (ev.arm) arms++;
    if (ev.exit && open) {
      donEvents.push({ ...open, exitIdx: i, why: ev.exit.why, capped: !!ev.exit.capped, xp: ev.exit.px });
      open = null;
    }
    if (ev.fill) {
      fills++; if (ev.fill.limit) limitFills++;
      open = { entIdx: i, dir: ev.fill.dir, fill: ev.fill.px };
      // a fill and an exit on the same bar
      if (ev.exit) { donEvents.push({ ...open, exitIdx: i, why: ev.exit.why, capped: !!ev.exit.capped, xp: ev.exit.px }); open = null; }
    }
  }
  check("gated signal on " + nT.toLocaleString() + " two-minute bars", bad === 0, bad + " off of " + nSig.toLocaleString() + " signals");
  check("bar CT minute on every 2-minute bar (bucket start, as the bot)", badCt === 0, badCt + " off");
  console.log("        " + labLabel.toLocaleString() + " bars whose first minute never traded: the lab labels those by the next");
  console.log("        minute instead. No session rule sits on an odd minute, so the signals above still match.");
  console.log("        " + arms.toLocaleString() + " arms, " + fills.toLocaleString() + " fills (" +
              (100 * limitFills / fills).toFixed(1) + "% as refused-stop limits)");
}

// ── 4. the order lifecycle vs research/lib_shipped.mjs ───────────────────
console.log("");
console.log("4. stop-entry, bracket, cap and exits vs research/lib_shipped.mjs");
{
  const { run } = await import("../research/lib_shipped.mjs");
  // Daily blocks off, so the only day-dependent rule left is the $1,000 cap,
  // and on the FIRST trade of each day that cap is exact for both.
  const lib = run(() => 8, { breaker: 0, profitBlock: 0 });
  const PV = 2, QTY = 8, SLIP = 0.25, PERSIDE = 0.75;
  const mine = donEvents.map((t) => {
    const avg = t.fill + t.dir * SLIP;
    const pnl = t.why === "SL" && t.capped ? -1000
      : ((t.dir === 1 ? t.xp - SLIP : t.xp + SLIP) - avg) * t.dir * PV * QTY - PERSIDE * 2 * QTY;
    return { tday: tf.tday[t.exitIdx], entCt: tf.ctMin[t.entIdx], why: t.why === "SL" && t.capped ? "SLcap" : t.why,
             held: (t.exitIdx - t.entIdx) * 2, pnl, crosses: tf.tday[t.entIdx] !== tf.tday[t.exitIdx] };
  });
  // lib_shipped's own day accounting: it zeroes the day at a new session's
  // first bar and adds every exit, including a position carried over an early
  // close and flattened on that first bar. A trade it takes while the day is
  // still at exactly $0 runs under the same flat-day $1,000 cap the indicator
  // assumes -- so every one of those must be reproduced exactly. After any
  // realised P&L the cap moves (and, at -$1,000, stops new arms), which the
  // indicator cannot see; those are reported below, not asserted.
  const key = (t) => t.tday + "|" + t.entCt + "|" + t.why + "|" + t.held;
  const mineBy = new Map(mine.map((t) => [key(t), t]));
  let cur = null, acc = 0, strict = 0, same = 0, diff = 0;
  const eg = [];
  for (const t of lib) {
    if (t.tday !== cur) { cur = t.tday; acc = 0; }
    const carried = t.why === "FLAT" && t.entCt + t.held < 905;   // over an early close
    if (acc === 0 && !carried) {
      strict++;
      const u = mineBy.get(key(t));
      if (u && Math.abs(u.pnl - t.pnl) < 1e-6) same++;
      else { diff++; if (eg.length < 3) eg.push({ lib: t, ind: u || null }); }
    }
    acc += t.pnl;
  }
  check("every trade taken on a flat day: entry, exit reason, hold, P&L", diff === 0,
        same.toLocaleString() + " of " + strict.toLocaleString() + " identical, " + diff + " differ");
  if (eg.length) console.log("        e.g. " + JSON.stringify(eg[0]));
  // Later trades in a day depend on the account's realised P&L (the cap moves
  // with it, and lib_shipped stops arming once the cap is hit), which the
  // indicator cannot see. Reported, not asserted.
  const libKeys = new Set(lib.map(key));
  const agree = mine.filter((t) => libKeys.has(key(t))).length;
  console.log("        all trades: indicator " + mine.length.toLocaleString() + ", lib_shipped " + lib.length.toLocaleString() +
              ", " + (100 * agree / lib.length).toFixed(1) + "% of lib_shipped's matched on entry, exit and hold.");
  console.log("        The rest follow a loss earlier the same day: the cap tightens the stop and, once hit,");
  console.log("        stops new arms. The indicator draws flat-day stops, so it keeps trading those sessions.");
}

// ── 5. ORB vs the bot's golden fixture ───────────────────────────────────
console.log("");
console.log("5. ORB vs bot/fixture_orb.json (260 days of the Python bot's levels and entries)");
const ofx = JSON.parse(fs.readFileSync(path.join(ROOT, "bot", "fixture_orb.json"), "utf8"));
function runOrbFixture(research, forming) {
  const seq = [], owner = [];
  ofx.days.forEach((d, k) => { for (const r of d.bars) { seq.push({ ts: r[0], o: r[1], h: r[2], l: r[3], c: r[4], ct: r[5] }); owner.push(k); } });
  const byDay = ofx.days.map(() => ({ lv: undefined, entry: null, exit: null, entCt: null }));
  const trace = [];
  feed(ORB, seq, { ...defaults(ORB), maxWidthPts: 0, __research: research }, (i, out, b) => {
    checkOutput(ORB, out, "orb fixture bar " + i);
    const { ev, O, B } = out._ev;
    const D = byDay[owner[i]];
    if (B.ct !== b.ct) D.badCt = (D.badCt || 0) + 1;
    if (ev.levels) D.lv = O.lv;
    if (ev.entry) { D.entry = ev.entry; D.entCt = B.ct; }
    if (ev.exit) D.exit = ev.exit;
    trace.push(JSON.stringify(out, (k, v) => (k === "_ev" ? undefined : v)) + JSON.stringify(ev));
  }, forming);
  return { byDay, trace };
}
{
  const { byDay, trace } = runOrbFixture(true, false);
  let lvBad = 0, enBad = 0, ctBad = 0, withLv = 0, withEn = 0, neverOpened = 0;
  const eg = [];
  // research/export_orb_fixture.mjs writes levels and risk with toFixed(6) and
  // prices with toFixed(4), so each is matched at its own precision. Section 6
  // repeats the comparison at full precision over the whole history.
  const dp6 = (a, b) => Math.abs(a - b) <= 5.1e-7;     // hi, lo, risk: toFixed(6)
  const dp4 = (a, b) => Math.abs(a - b) <= 5.1e-5;     // prices: toFixed(4)
  ofx.days.forEach((d, k) => {
    const m = byDay[k];
    ctBad += m.badCt || 0;
    const L = d.levels, M = m.lv;
    // A session that closed before 08:30 (Good Friday 2026 ended at 08:15)
    // has a pre-open window, so the research model still reports levels, but
    // there is no open to draw them at or trade them from. The indicator must
    // draw nothing and enter nothing there.
    if (!d.bars.some((b) => b[5] >= 510)) {
      neverOpened++;
      if (M != null || m.entry || d.entry) { lvBad++; eg.push({ tday: d.tday, neverOpened: true, indicator: M }); }
      if (L) withLv++;
      return;
    }
    const lvOk = (L == null && M == null) || (L != null && M != null &&
      dp6(L.hi, M.hi) && dp6(L.lo, M.lo) && L.tHi === M.tHi && L.tLo === M.tLo &&
      dp4(L.whi, M.whi) && dp4(L.wlo, M.wlo) && dp4(L.ref, M.ref));
    if (!lvOk) { lvBad++; if (eg.length < 2) eg.push({ tday: d.tday, fixture: L, indicator: M }); }
    if (L) withLv++;
    const E = d.entry, e = m.entry;
    const enOk = (E == null && e == null) || (E != null && e != null &&
      E.bar_ct === m.entCt && E.dir === e.dir && dp4(E.entryPx, e.fill) && dp6(E.risk, e.risk) &&
      dp4(E.trig, e.trig) && E.gapped === e.gapped);
    if (!enOk) { enBad++; if (eg.length < 2) eg.push({ tday: d.tday, fixture: E, indicator: e && { ...e, ct: m.entCt } }); }
    if (E) withEn++;
  });
  check("levels on all 260 days (hi, lo, taps, window, ref)", lvBad === 0,
        withLv + " days with a level, " + lvBad + " differ; " + neverOpened + " sessions closed before the open, correctly left blank");
  check("entries: minute, side, fill, risk, trigger, gap", enBad === 0, withEn + " entries, " + enBad + " differ");
  check("bar CT minute", ctBad === 0, ctBad + " off");
  if (eg.length) console.log("        e.g. " + JSON.stringify(eg[0]));

  // The live convention: same levels, same minute and side; the trigger is the
  // level plus a tick ROUNDED to a real price, as the bot sends it.
  const live = runOrbFixture(false, false).byDay;
  let liveBad = 0;
  const rt = (p) => Math.floor(p / 0.25 + 0.5) * 0.25;
  ofx.days.forEach((d, k) => {
    const E = d.entry, e = live[k].entry;
    if ((E == null) !== (e == null)) { liveBad++; return; }
    if (!E) return;
    const lvl = E.dir === 1 ? d.levels.hi : d.levels.lo;
    if (E.bar_ct !== live[k].entCt || E.dir !== e.dir || e.trig !== rt(lvl + E.dir * 0.25)) liveBad++;
  });
  check("live convention: same minute and side, tick-rounded trigger", liveBad === 0, liveBad + " differ");

  const again = runOrbFixture(true, true).trace;
  let diff = 0;
  for (let i = 0; i < trace.length; i++) if (trace[i] !== again[i]) diff++;
  check("re-calling map() on a forming bar changes nothing", diff === 0, diff + " bars differ");
}

// ── 6. ORB over seven years vs research/lib_orb.mjs ──────────────────────
console.log("");
console.log("6. ORB over the full history vs research/lib_orb.mjs, entry and exit");
{
  const lib = await import("../research/lib_orb.mjs");
  const cfg = { ...ofx.cfg };
  const { out } = lib.setups(cfg);
  const { trades } = lib.run(cfg);
  const libBy = new Map(out.map((s, k) => [s.bar, { s, t: trades[k] }]));

  // Only the hours the ORB can touch, fed as one continuous chart would be.
  const idxMap = [];
  for (let i = 0; i < N; i++) if (bars.ctMin[i] >= 360 && bars.ctMin[i] < 630) idxMap.push(i);
  const seq = idxMap.map((i) => ({ ts: bars.ts[i], o: bars.open[i], h: bars.high[i], l: bars.low[i], c: bars.close[i] }));
  const mine = new Map();
  let openAt = -1, days = 0, stand = 0;
  const widthDays = { in: 0, out: 0 };
  feed(ORB, seq, { ...defaults(ORB), maxWidthPts: 0, __research: true }, (k, o) => {
    if (k % 1009 === 0) checkOutput(ORB, o, "orb history bar " + k);
    const { ev, O } = o._ev;
    if (ev.levels) { days++; if (O.lv) (O.lv.hi - O.lv.lo > 31 ? widthDays.out++ : widthDays.in++); }
    if (ev.entry) { openAt = idxMap[k]; mine.set(openAt, { e: ev.entry }); }
    if (ev.exit && openAt >= 0) { mine.get(openAt).x = ev.exit; openAt = -1; }
  });

  let enSame = 0, enDiff = 0, onlyOne = 0, exSame = 0, exDiff = 0;
  const eg = [];
  for (const [bar, { s, t }] of libBy) {
    const m = mine.get(bar);
    if (!m) { onlyOne++; continue; }
    const e = m.e;
    if (e.dir === s.dir && Math.abs(e.fill - s.entryPx) < 1e-9 && Math.abs(e.risk - s.risk) < 1e-9) enSame++;
    else { enDiff++; if (eg.length < 2) eg.push({ bar, lib: s, ind: e }); }
    if (m.x && m.x.why === t.why && m.x.held === t.held) exSame++;
    else { exDiff++; if (eg.length < 2) eg.push({ bar, libExit: { why: t.why, held: t.held }, indExit: m.x }); }
  }
  for (const bar of mine.keys()) if (!libBy.has(bar)) onlyOne++;
  check("entries: same minute, side, fill and risk", enDiff === 0 && onlyOne === 0,
        enSame.toLocaleString() + " identical, " + enDiff + " differ, " + onlyOne + " on one side only");
  check("exits: same reason and hold", exDiff === 0, exSame.toLocaleString() + " identical, " + exDiff + " differ");
  if (eg.length) console.log("        e.g. " + JSON.stringify(eg[0]));
  console.log("        " + days.toLocaleString() + " sessions, " + (widthDays.in + widthDays.out).toLocaleString() +
              " with a level; the live 31-point guard stands down on " + widthDays.out.toLocaleString() + " of them");
}

// ── summary ──────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log("");
console.log("=".repeat(96));
console.log(failed.length ? "  " + failed.length + " CHECK(S) FAILED" : "  ALL " + results.length + " CHECKS PASS");
console.log("=".repeat(96));
console.log("");
process.exit(failed.length ? 1 : 0);
