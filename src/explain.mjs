// Why a signal fired, and what became of it. ISOMORPHIC.
//
// A strategy's compute() may return `explain(k)`: the conditions of its rule at
// signal bar k, read at that bar's close the way its signal loop reads them,
// each with its reading and, where one helps, a mini-chart of the indicator --
// and marks that show them on the price chart: the level broken, the bars that
// set it, the close that broke it. The verdict is DERIVED from the conditions
// listed (the candidate direction when every trigger and gate passes, else
// none), and test.mjs holds it to the strategy's own `sig` and `sizeMult` on
// every bar, so an explanation cannot tell a different story from the signal
// that traded.
//
// runStrategy({ explain: true }) adds what lies outside the strategy -- the
// signal filters and the indicator studies -- and, with { trace: true }, the
// engine's account of each signal (src/engine.mjs onSignal): the order it
// placed, the fill, a refusal and its reason. `explainSignal` puts them
// together; `describeEntry` / `describeExit` turn a trade into sentences.

import { NO_FILTER, filterPeriods } from "./filters.mjs";
import { studyOnSignal, gatePasses, isGating, gateLabel, studyLabel } from "./studies.mjs";

// ── formatting ──
// A price to the cent with thousands separators ("21,034.25"). By hand, since
// toLocaleString costs more than the rest of an explanation together.
export function px(v) {
  if (!Number.isFinite(v)) return "n/a";
  const [i, d] = Math.abs(v).toFixed(2).split(".");
  return (v < 0 ? "-" : "") + i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + d;
}
// An indicator reading: prices to the cent, others to 2 decimals or 3 figures.
export function num(v) {
  if (!Number.isFinite(v)) return "n/a";
  const a = Math.abs(v);
  return a >= 1000 ? px(v) : a >= 1 ? String(+v.toFixed(2)) : String(+v.toPrecision(3));
}
export const pts = (v) => `${num(Math.abs(v))} pt${Math.abs(v) === 1 ? "" : "s"}`;
export const usd = (v) => (v < 0 ? "-$" : "$") + String(Math.abs(Math.round(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const clock = (m) => (Number.isFinite(m) ? `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}` : "");
// A bar by its Chicago clock: "10:20" for one minute, "10:20-10:22" for longer.
export function barClock(bars, k) {
  if (!bars.ctMin || k < 0 || k >= bars.ctMin.length) return "";
  const ct = bars.ctMin[k], tf = bars.tfMin || 1;
  return tf === 1 ? clock(ct) : `${clock(ct)}–${clock((ct + tf) % 1440)}`;
}
const tfName = (m) => (m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`);

// ── conditions ──
// `pass` is computed by the caller with the SAME expression as its signal loop,
// NaN handling included; the rest is for display.
//   role  "trigger" what fires the signal, "gate" what must also hold, "size"
//         what decides the entry's size (0 refuses it; the signal still flips),
//         "info" context only.
export function chk(label, pass, o = {}) {
  const c = { label, pass: pass == null ? null : !!pass, role: o.role || "gate", text: o.text || "" };
  if (o.note) c.note = o.note;
  if (o.spark) c.spark = o.spark;
  if (o.group) c.group = o.group;
  return c;
}
export const trig = (label, pass, o = {}) => chk(label, pass, { ...o, role: "trigger" });
export const sized = (label, pass, o = {}) => chk(label, pass, { ...o, role: "size" });
export const info = (label, text, o = {}) => chk(label, null, { ...o, role: "info", text });

// The candidate direction when every trigger and gate listed passes, else 0.
export function verdict(cand, checks) {
  if (!cand) return 0;
  for (const c of checks) if (c && (c.role === "trigger" || c.role === "gate") && c.pass === false) return 0;
  return cand;
}

// v >= min as a loop that skips `v < min` reads it (a reading not yet warm
// passes); `strict` as one that skips `!(v >= min)` (it fails).
export function atLeast(label, v, min, { strict = false, ...o } = {}) {
  const pass = strict ? v >= min : !(v < min);
  return chk(label, pass, { text: `${num(v)} ${pass ? "≥" : "<"} ${num(min)}`, ...o });
}
export function atMost(label, v, max, { strict = false, ...o } = {}) {
  const pass = strict ? v <= max : !(v > max);
  return chk(label, pass, { text: `${num(v)} ${pass ? "≤" : ">"} ${num(max)}`, ...o });
}
// A strategy's own session window, [start, end) in CT minutes.
export function inWindow(ct, start, end, label = "Signals") {
  return chk(`${label} ${clock(start)}–${clock(end)} CT`, ct >= start && ct < end, { text: `bar opens ${clock(ct)}` });
}

// A mini-chart for a condition: `lines` ([series, color, name, kind]) over the
// `n` bars up to and including k, `refs` horizontal levels (a threshold). The
// values travel as plain numbers (null where not yet known): an explanation is
// data, for the chart's card and the MCP alike.
export function spark(k, lines, { n = 40, refs = [] } = {}) {
  const a = Math.max(0, k - n + 1), out = [];
  for (const ln of lines) {
    if (!ln) continue;
    const [d, color, name, kind] = ln, v = new Array(k - a + 1);
    for (let i = a; i <= k; i++) { const x = d[i]; v[i - a] = Number.isFinite(x) ? +x : null; }
    out.push({ name, color, ...(kind ? { kind } : {}), v });
  }
  return { k0: a, k, lines: out, refs: refs.filter((r) => Number.isFinite(r)) };
}

// Marks on the chart, in the strategy's bar indexes (k), or in time (ms) for a
// bar of a longer timeframe. The chart draws them for the entry selected.
const vals = (d, a, b) => { const out = []; for (let i = Math.max(0, a); i <= b; i++) out.push(Number.isFinite(d[i]) ? +d[i] : null); return out; };
export const mark = {
  // a price level over bars k0..k1: a channel's high, the opening range
  level: (price, k0, k1, label, o = {}) => ({ type: "level", price, k0: Math.max(0, k0), k1, label, ...o }),
  // a shaded span of bars: the lookback a level came from, the opening range
  zone: (k0, k1, label, o = {}) => ({ type: "zone", k0: Math.max(0, k0), k1, label, ...o }),
  // one bar's price: the close that broke the level, the high that set it
  dot: (k, price, label, o = {}) => ({ type: "dot", k, price, label, ...o }),
  // a series the chart does not otherwise draw, over bars k0..k1
  line: (data, k0, k1, label, o = {}) => ({ type: "line", k0: Math.max(0, k0), k1, v: vals(data, k0, k1), label, ...o }),
  // a move from one bar's price to another's
  move: (k0, p0, k1, p1, label, o = {}) => ({ type: "move", k0: Math.max(0, k0), p0, k1, p1, label, ...o }),
  // a point on one of the strategy's sub-pane overlays, by its name
  sub: (overlay, k, value, label, o = {}) => ({ type: "sub", overlay, k, value, label, ...o }),
  // a time span [t0, t1): the bar of a longer timeframe a filter read
  span: (t0, t1, label, o = {}) => ({ type: "span", t0, t1, label, ...o }),
};
export const COLOR = { close: "#e8eef5", up: "#26a69a", down: "#ef5350", level: "#f0b429", adx: "#c9a227", line: "#4aa3ff", sig: "#e0894a", osc: "#c678dd" };

// ── shared pieces of the strategies' rules ──
// The first bar of bar k's session.
export function dayStart(tday, k) {
  let j = k;
  while (j > 0 && tday[j - 1] === tday[k]) j--;
  return j;
}
// The previous signal in the same session (-1 for none): what a cooldown that
// restarts each session measures from.
export function prevSignal(sig, tday, k) {
  for (let j = k - 1; j >= 0 && tday[j] === tday[k]; j--) if (sig[j]) return j;
  return -1;
}
// The loops' `if (i - last < cooldownBars) continue`, `last` the session's
// previous signal. Listed only when it can bite (more than one bar).
export function cooldown(sig, tday, k, bars) {
  if (!(bars > 1)) return null;
  const last = prevSignal(sig, tday, k), gap = last < 0 ? Infinity : k - last;
  return chk(`Cooldown ${bars} bars`, !(gap < bars), { text: last < 0 ? "first signal of the session" : `${gap} bar${gap === 1 ? "" : "s"} since the last` });
}

// A close beyond a channel -- above its upper line, else below its lower, as the
// loops test them. For a Donchian channel (src/indicators.mjs donchian: the
// `period` bars BEFORE k) the marks show the bars it was built from and the bar
// that set the level. Returns { side: +1 above / -1 below / 0, checks, marks }.
export function channelBreak(bars, k, up, dn, { period, name, donchian = true }) {
  const { high: H, low: L, close: C } = bars, c = C[k], hi = up[k], lo = dn[k];
  const side = c > hi ? 1 : c < lo ? -1 : 0;
  const nm = name || (donchian ? `${period}-bar` : "band");
  const sp = (lvl, color, nmL) => spark(k, [[C, COLOR.close, "close"], [lvl, color, nmL]]);
  const checks = [], marks = [];
  if (side) {
    const lvl = side === 1 ? hi : lo;
    checks.push(trig(`Close ${side === 1 ? "above" : "below"} the ${nm} ${side === 1 ? "high" : "low"}`, true,
                     { text: `${px(c)} ${side === 1 ? ">" : "<"} ${px(lvl)}`, note: `beyond it by ${pts(c - lvl)}`,
                       spark: sp(side === 1 ? up : dn, side === 1 ? COLOR.up : COLOR.down, side === 1 ? "high" : "low") }));
    if (donchian) {
      // the bar that set the level: the latest extreme of the lookback, as the deque keeps it
      let at = -1;
      for (let j = k - 1; j >= Math.max(0, k - period); j--) if ((side === 1 ? H[j] : L[j]) === lvl) { at = j; break; }
      marks.push(mark.zone(k - period, k - 1, `the ${period} bars before`),
                 mark.level(lvl, k - period, k, `${nm} ${side === 1 ? "high" : "low"} ${px(lvl)}`, { color: side === 1 ? COLOR.up : COLOR.down }));
      if (at >= 0) marks.push(mark.dot(at, lvl, "set it", { color: side === 1 ? COLOR.up : COLOR.down, small: true }));
    } else {
      marks.push(mark.level(lvl, k - 12, k, `${nm} ${px(lvl)}`, { color: side === 1 ? COLOR.up : COLOR.down }));
    }
    marks.push(mark.dot(k, c, `close ${px(c)}`, { color: COLOR.close }));
  } else {
    checks.push(trig(`Close beyond the ${nm} channel`, false,
                     { text: Number.isFinite(hi) && Number.isFinite(lo) ? `${px(c)} inside ${px(lo)} – ${px(hi)}` : "the channel is not formed yet" }));
  }
  return { side, checks, marks };
}

// The Donchian-and-ADX signal donchian_eff_rth, trend_neutev and
// trend_vol_adaptive share: from bar `period` on, a close beyond the channel
// while ADX is at least its floor and the session's cooldown has passed.
export function donchianAdxExplain(bars, k, { dh, dl, adxArr, sig, period, adxMin, adxPeriod, cooldownBars }) {
  if (k < period) return { dir: 0, checks: [trig("Enough bars for the channel", false, { text: `${k} of ${period}` })], marks: [] };
  const br = channelBreak(bars, k, dh, dl, { period });
  const checks = [...br.checks, adxAtLeast(adxArr, k, adxMin, adxPeriod), cooldown(sig, bars.tday, k, cooldownBars)].filter(Boolean);
  return { dir: verdict(br.side, checks), checks, marks: br.marks,
           title: br.side ? `Breakout ${br.side === 1 ? "above" : "below"} the ${period}-bar ${br.side === 1 ? "high" : "low"}` : "No breakout" };
}

// ADX at least `min` (the loops skip `adx < min`), with its mini-chart.
export function adxAtLeast(adxArr, k, min, period = 14, o = {}) {
  return atLeast(`ADX(${period}) at least ${num(min)}`, adxArr[k], min,
                 { spark: spark(k, [[adxArr, COLOR.adx, "ADX"]], { refs: [min] }), ...o });
}
export function adxAtMost(adxArr, k, max, period = 14, o = {}) {
  return atMost(`ADX(${period}) at most ${num(max)}`, adxArr[k], max,
                { spark: spark(k, [[adxArr, COLOR.adx, "ADX"]], { refs: [max] }), ...o });
}

// A histogram's zero cross at k: +1 up (h[k] > 0 >= h[k-1]), -1 down, 0 none.
export const crossOf = (h, k) => (k < 1 ? 0 : h[k] > 0 && h[k - 1] <= 0 ? 1 : h[k] < 0 && h[k - 1] >= 0 ? -1 : 0);
export function histSpark(k, hist, extra = [], o = {}) {
  return spark(k, [[hist, COLOR.line, "histogram", "hist"], ...extra], { refs: [0], ...o });
}

// The higher-timeframe EMA pair a filter read at k (src/studies.mjs
// htfEmaTrend), and a mark on the longer bar it came from: the last one closed
// by the signal bar's close.
export function htfTrend(bars, k, tr, fast, slow, want, label = "trend") {
  const d = tr.dir[k], f = tr.fast[k], s = tr.slow[k];
  const word = (x) => (x === 1 ? "above" : x === -1 ? "below" : "level with");
  const pass = d === want && want !== 0;
  const c = chk(`${tfName(tr.tf)} EMA ${fast} vs EMA ${slow} (${label})`, pass,
                { text: Number.isFinite(f) ? `${px(f)} ${word(d)} ${px(s)}` : "not formed yet",
                  note: `read from the last ${tfName(tr.tf)} bar closed by this bar's close` });
  const marks = [];
  const closeMs = bars.ts[k] + (bars.tfMin || 1) * 60000, htfMs = tr.tf * 60000;
  if (Number.isFinite(f)) {
    // the longer bar: the last whole one ending at or before the signal bar's close
    const end = Math.floor(closeMs / htfMs) * htfMs;
    marks.push(mark.span(end - htfMs, end, `${tfName(tr.tf)} bar read`));
  }
  return { check: c, marks, dir: d };
}

// The multi-speed consensus of macd_angle_v4 and tpl_consensus, as their loops
// read it: inside the session window and with an ATR, each member votes up
// when it is above zero and rising at least `thr` over `slopeBars` (in ATRs
// when priceScaled), down when below and falling; one vote against the rest
// stands the bar aside, and fewer than `minAgree` votes is no signal.
export function consensusExplain(bars, k, { members, names, atr, slopeBars, thr, priceScaled, start, end, minAgree, fade, adxChecks = null, consensus, overlay }) {
  const ct = bars.ctMin ? bars.ctMin[k] : 0, av = atr[k];
  const checks = [inWindow(ct, start, end)];
  if (k < slopeBars) return { dir: 0, checks: [...checks, trig("Enough bars for the slopes", false, { text: `${k} of ${slopeBars}` })], marks: [] };
  if (!(av > 0)) return { dir: 0, checks: [...checks, chk("ATR ready", false, { text: "not yet" })], marks: [] };
  if (adxChecks) checks.push(...adxChecks(k));
  let dir = 0, up = 0, down = 0;
  const votes = [];
  for (let m = 0; m < members.length; m++) {
    const arr = members[m], v = arr[k], prev = arr[k - slopeBars];
    if (!Number.isFinite(v) || !Number.isFinite(prev)) { votes.push(info(names[m], "not formed yet")); continue; }
    const raw = (v - prev) / slopeBars, slope = priceScaled ? raw / av : raw;
    const d = v > 0 && slope >= thr ? 1 : v < 0 && slope <= -thr ? -1 : 0;
    votes.push(info(names[m], `${d === 1 ? "▲ up" : d === -1 ? "▼ down" : "– no vote"}: ${num(v)}, slope ${num(slope)}`));
    if (d === 1) up++; else if (d === -1) down++;
    if (d && !dir) dir = d;
  }
  const conflict = up > 0 && down > 0, agreeing = up + down;
  checks.push(trig(`Members agree${minAgree > 1 ? `, at least ${minAgree} voting` : ""}`, !conflict && agreeing >= Math.max(1, minAgree),
                   { text: `${up} up, ${down} down of ${members.length}${conflict ? ": conflict, stand aside" : ""}`,
                     spark: consensus ? spark(k, [[consensus, COLOR.adx, "consensus"]], { refs: [0] }) : undefined }), ...votes);
  const cand = conflict || agreeing < minAgree ? 0 : fade ? -dir : dir;
  return { dir: verdict(cand, checks), checks, marks: cand && overlay ? [mark.sub(overlay, k, consensus[k], `${agreeing} agree`)] : [],
           title: cand ? `${agreeing} of ${members.length} agree ${dir === 1 ? "up" : "down"}${fade ? ": fade it" : ""}` : conflict ? "The members disagree" : "No consensus" };
}

// "ADR used": the day's 08:30-15:00 range so far against its average
// (src/indicators.mjs rthRangeUsed), with its mini-chart.
export const adrSpark = (k, used, ref) => spark(k, [[used, COLOR.level, "ADR used"]], { refs: [ref] });

// ── run-level: filters, studies, and the engine's account ──
function inBand(v, min, max) {
  if (min <= 0 && max <= 0) return true;
  if (!Number.isFinite(v)) return false;
  if (min > 0 && v < min) return false;
  if (max > 0 && v > max) return false;
  return true;
}
const bandText = (v, min, max) => `${num(v)}${min > 0 ? `, needs ≥ ${num(min)}` : ""}${max > 0 ? `${min > 0 ? " and" : ", needs"} ≤ ${num(max)}` : ""}`;

// The signal filters (src/filters.mjs), as barPasses reads them at bar k.
export function filterChecks(ctx, filter, k) {
  if (!ctx) return [];
  const F = { ...NO_FILTER, ...filter }, P = filterPeriods(filter), out = [];
  if (ctx.ctMin && (F.startCt !== NO_FILTER.startCt || F.endCt !== NO_FILTER.endCt)) {
    const ct = ctx.ctMin[k];
    const ok = F.endCt >= F.startCt ? ct >= F.startCt && ct < F.endCt : ct >= F.startCt || ct < F.endCt;
    out.push(chk(`Signal window ${clock(F.startCt)}–${clock(F.endCt)} CT`, ok,
                 { text: `bar opens ${clock(ct)}`, group: "filter" }));
  }
  const band = (label, arr, mn, mx, color) => {
    if (mn <= 0 && mx <= 0) return;
    out.push(chk(label, inBand(arr[k], mn, mx), { text: bandText(arr[k], mn, mx), group: "filter",
                 spark: spark(k, [[arr, color, label]], { refs: [mn > 0 ? mn : NaN, mx > 0 ? mx : NaN] }) }));
  };
  band(`ADX(${P.adxPeriod})`, ctx.adx, F.adxMin, F.adxMax, COLOR.adx);
  band(`ATR(${P.atrPeriod}) / its ${P.volMaPeriod}-bar average`, ctx.volRatio, F.volMin, F.volMax, COLOR.line);
  band(`Efficiency ratio(${P.effPeriod})`, ctx.eff, F.effMin, F.effMax, COLOR.osc);
  band(`Choppiness(${P.chopPeriod})`, ctx.chop, F.chopMin, F.chopMax, COLOR.sig);
  band(`Bollinger bandwidth(${P.bwPeriod})`, ctx.bw, F.bwMin, F.bwMax, COLOR.line);
  return out;
}

// An indicator study's reading at signal bar k, in words.
function studyReading(r, k, C) {
  const v = r.v[k], d = r.dir[k], kind = r.S.kind;
  if (kind === "price") return Number.isFinite(v) ? `close ${px(C[k])} ${d === 1 ? "above" : d === -1 ? "below" : "at"} ${px(v)}` : "not formed yet";
  if (kind === "band") return Number.isFinite(v) ? `close at ${Math.round(v * 100)}% of the band` : "not formed yet";
  if (kind === "trend") return d === 1 ? "up" : d === -1 ? "down" : "not formed yet";
  return Number.isFinite(v) ? num(v) + (r.hasDir && d ? (d === 1 ? ", +DI leads" : ", −DI leads") : "") : "not formed yet";
}

// Everything known about signal bar k: the strategy's reading, the filters that
// decide whether the engine sees the signal at all, the studies that may refuse
// its entry, and what the engine did with it.
//   env: { out (compute's result), tf (its bars), sig (after the filters), ctx
//          (the filters' context, or null), filter, studies, bars1m, trace }
export function explainSignal(env, k) {
  const { out, tf, sig, ctx, filter, studies, bars1m, trace } = env;
  const own = out.explain ? out.explain(k) : genericExplain(out, tf, k);
  const fc = filterChecks(ctx, filter, k);
  const dir = verdict(own.dir, fc);
  const checks = [...own.checks.filter(Boolean), ...fc];
  // studies, read as a gate reads them: for the direction the signal has
  if (studies && studies.length) {
    if (!env.readings) env.readings = studies.map((st) => studyOnSignal(bars1m, tf, st));
    for (const r of env.readings) {
      const name = studyLabel(r.st), text = studyReading(r, k, tf.close);
      checks.push(isGating(r.st) && dir
        ? chk(`${name}: ${gateLabel(r.st.type, r.st.gate, r.st.params)}`, gatePasses(r, k, dir), { role: "entry", text, group: "study" })
        : info(name, text, { group: "study" }));
    }
  }
  const size = own.size ?? 1;
  const entryOk = !!dir && size > 0 && checks.every((c) => c.role !== "entry" || c.pass !== false);
  return {
    k, ts: tf.ts[k], bar: barClock(tf, k), tfMin: tf.tfMin || 1,
    dir, strategyDir: own.dir, size, entryOk, generic: !!own.generic,
    title: own.title || "", checks, marks: own.marks || [], notes: own.notes || [],
    events: trace ? trace.get(k) || [] : null,
  };
}

// A strategy without its own explain(): the signal, and every overlay's value
// at the bar.
function genericExplain(out, tf, k) {
  const dir = out.sig[k] || 0;
  const checks = [trig("The strategy's signal", !!dir, { text: dir ? (dir === 1 ? "long" : "short") : "none" })];
  for (const o of out.overlays || []) if (o.data && Number.isFinite(o.data[k])) checks.push(info(o.name, num(o.data[k])));
  return { dir, checks, marks: [], generic: true, notes: ["This strategy has no explain() of its own, so only its overlays' readings are shown."] };
}

// ── the engine's account, in words (src/engine.mjs onSignal) ──
const BLOCK = { dayCap: "the platform's day profit cap had fired", dayLoss: "the platform's day loss limit had fired",
                breaker: "the day breaker had tripped", profitBlock: "the day profit block was on" };
const REFUSE = {
  flat: "the flat window (positions must be flat until the reopen)", session: "a new session never acts on the last session's final signal",
  lastMinutes: "no new entries in the last minutes before the flatten", cooldown: "cooling off after a stop-out the same way",
  gate: "an indicator study's gate refused the entry", atr: "the ATR was not ready", sizer: "the sizer gave less than one contract",
  size: "the strategy refused the entry (size 0)",
};
export function eventText(e, tf, x = {}) {
  const at = (b) => (b != null && tf.ctMin && b < tf.ctMin.length ? clock(tf.ctMin[b]) : "");
  const side = e.dir === 1 ? "Buy" : "Sell";
  const why = (w) => BLOCK[w] || REFUSE[w] || w;
  switch (e.what) {
    case "entered": return `Entered at the next open, ${at(e.bar)}: ${e.lots} at ${px(e.px)}`;
    case "armed": return `${side} ${e.limit ? "limit" : "stop"} at ${px(e.px)} placed at the ${at(e.bar)} open, working the ${e.window} bar${e.window === 1 ? "" : "s"} after it`;
    case "filled": return `Filled at ${at(e.bar)}, ${px(e.px)}${e.limit && x.entryType === "stop" ? " — as a limit: the stop was refused because the bar opened through its price" : ""}`;
    case "replaced": return `Replaced by the next signal's order at ${at(e.bar)}`;
    case "cancelled": return `Cancelled at ${at(e.bar)}: ${e.why === "opposite" ? "an opposite signal" : e.why === "session" ? "the session ended" : why(e.why)}`;
    case "expired": return `Expired unfilled after ${e.window} bar${e.window === 1 ? "" : "s"}${e.limit && x.entryType === "stop" ? " (refused as a stop, it rested as a limit)" : ""}`;
    case "flipped": return `Closed the open ${e.closed === 1 ? "long" : "short"} at the ${at(e.bar)} open`;
    case "held": return `Already ${e.dir === 1 ? "long" : "short"}: nothing to do`;
    case "ignored": return e.why === "fillBar"
      ? "A resting order filled on this bar, after the open the signal acts at, so the signal could not close it"
      : `In a ${e.dir === 1 ? "short" : "long"}, and opposite signals do not close it (flip off)`;
    case "dropped": return `The open trade left on this bar (${e.reason}), and a new entry never opens on the bar of an exit`;
    case "refused": return `No entry: ${why(e.why)}${e.realised != null ? ` (realised ${usd(e.realised)})` : ""}`;
    default: return e.what;
  }
}

// ── a trade, in words ──
const EXIT_TEXT = {
  SL: "the stop", TP: "the target", FLIP: "the opposite signal", EOD: "the end of the data", TIME: "the time stop",
  FLAT: "the session's flatten deadline", DAYCAP: "the platform's day profit cap", DAYLOSS: "the platform's day loss limit",
  SIGNAL: "the strategy's exit rule", TRAIL: "the trailing stop", STALE: "the stale exit",
};
// How the trade got in, and its bracket: from its signal's events and the exec.
export function describeEntry(t, tf, x, events = []) {
  const lines = [], d = t.dir, a = t.atr;
  const armed = events.find((e) => e.what === "armed"), filled = events.find((e) => e.what === "filled" || e.what === "entered");
  const ref = tf.open[t.sigIdx + 1];
  if (t.entryType === "market") {
    lines.push(`Market order at the next bar's open (${barClock(tf, t.sigIdx + 1)}), ${px(ref)}`);
  } else if (armed) {
    // the order as placed (a refused stop fills as a limit at the stop's price)
    const stop = x.entryType === "stop", dist = Math.abs(armed.px - ref);
    lines.push(`${d === 1 ? "Buy" : "Sell"} ${stop ? "stop" : "limit"} ${px(armed.px)}: the ${barClock(tf, t.sigIdx + 1)} open ${px(ref)} ${stop === (d === 1) ? "+" : "−"} ${num(stop ? x.entryTriggerAtr : x.entryLimitAtr)} × ATR ${num(a)} (${pts(dist)}), working ${armed.window} bars`);
    if (t.limitFill && stop) lines.push("Refused as a stop — the next bar opened through its price — so it rested as a limit at the same price");
  }
  if (filled) {
    const slip = (x.slippageTicks || 0) * (x.tickSize || 0.25);
    lines.push(`Filled ${barClock(tf, t.entryIdx)} at ${px(filled.px)}${slip ? `, ${px(t.entryPrice)} with ${x.slippageTicks} tick${x.slippageTicks === 1 ? "" : "s"} of slippage` : ""} · ${t.contracts} lot${t.contracts === 1 ? "" : "s"}`);
  }
  // the bracket as configured, and the platform's day line where it was nearer
  // both order types measure the bracket from the open of the bar after the signal
  const slD = Math.abs(ref - t.stop);
  lines.push(`Stop ${px(t.stop)}: ${num(x.slAtrMult)} × ATR ${num(a)} = ${pts(slD)} from the ${t.entryType === "market" ? "fill bar's open" : "order's reference open"}`);
  if (filled && filled.stopWhy && filled.stopWhy !== "SL" && Number.isFinite(filled.stop)) {
    lines.push(`… but ${filled.stopWhy === "DAYLOSS" ? `the ${usd(x.dayLossStopUsd)} day loss line` : "a nearer stop"} was nearer, at ${px(filled.stop)}`);
  }
  const tpTxt = x.tpMode === "rr" ? `${num(x.tpRR)} × the stop distance` : `${num(x.tpAtrMult)} × ATR`;
  lines.push(`Target ${px(t.target)}: ${tpTxt}${x.tpMaxUsd > 0 ? `, at most ${usd(x.tpMaxUsd)} on the position` : ""}${x.tpFromFill && t.entryType !== "market" ? " from the fill" : ""}`);
  if (filled && filled.targetWhy === "DAYCAP" && Number.isFinite(filled.target)) lines.push(`… but the ${usd(x.dayProfitStopUsd)} day profit cap was nearer, at ${px(filled.target)}`);
  return lines;
}
export function describeExit(t, tf, x, exitRule) {
  let why = EXIT_TEXT[t.reason] || t.reason;
  if (t.reason === "SIGNAL" && exitRule) why += `: ${exitRule}`;
  if (t.reason === "STALE") why += `: ${x.staleBars} bars without being ${num(x.staleMfeAtr)} ATR in favour`;
  if (t.reason === "TIME") why += ` (${x.maxBarsInTrade} bars)`;
  return `Out ${barClock(tf, t.exitIdx)} at ${px(t.exitPrice)} on ${why} · ${t.pnl >= 0 ? "+" : ""}${usd(t.pnl)} after ${usd(t.fees)} of fees`;
}

// The whole explanation as plain lines (the MCP, a tooltip).
export function explainLines(e) {
  const mark = (c) => (c.pass === true ? "✓" : c.pass === false ? "✗" : "·");
  const lines = [];
  if (e.title) lines.push(e.title);
  for (const c of e.checks) lines.push(`${mark(c)} ${c.label}${c.text ? `: ${c.text}` : ""}${c.note ? ` (${c.note})` : ""}`);
  if (e.size !== 1 && e.dir) lines.push(e.size > 0 ? `Size × ${num(e.size)}` : "Entry refused (size 0)");
  for (const n of e.notes) lines.push(`Note: ${n}`);
  return lines;
}
