// The level study's engine, on the lab's bars. Do levels hold, or break, more often
// than an arbitrary price would?
//
// The method is the original study's (tradovate_levels/research/s2_levels.py, after
// Osler 2003), rebuilt here so it can read any line a study in src/studies.mjs draws,
// moving ones included:
//
//   TOUCH    Price closes at least R from the level, then a later bar trades THRU
//            ticks past it.
//   BOUNCE   From the touch, price moves R back before it moves R through. A BREAK
//            is the reverse. Neither within HOLD minutes is unresolved, and left out.
//            R scales with volatility: a fraction of the mean RTH range of the prior
//            10 sessions. The touch bar's own range cannot score a bounce, because a
//            1-minute bar does not say which came first, and a bar that hits both
//            counts as the break. Both choices lean against the level, and fall on
//            its twins alike.
//   NULL     Every real level has `twins`: the same level moved 1.5-6 R, either way,
//            per level and per day. A moving level keeps its shape, so a twin moves
//            with price exactly as the real one does. Same day, same bars, same rule;
//            only the price is arbitrary. The edge is real bounce% - twin bounce%.
//
// What is causal: the level at bar i is the value known at the close of bar i - 1.
//
// Confidence comes from resampling whole days, so several touches on one day never
// count as independent evidence. BH below controls the false discovery rate across
// everything tested together.

import { loadBars } from "../src/data.mjs";
import { sliceBars, indexAtOrAfter } from "../src/resample.mjs";
import { computeStudy, closedIndexMap, resolveStudy } from "../src/studies.mjs";
import { sessionsOf, adrOf } from "../src/levels.mjs";
import { ema } from "../src/indicators.mjs";
import { mulberry32 } from "../src/dayeval.mjs";

export const TICK = 0.25;
export const Y26 = Date.UTC(2026, 0, 1), APR = Date.UTC(2026, 3, 1), DAY_MS = 86400000;
export const COST_PTS = 1;         // about $2 a contract, round trip: commission and a tick on the stop
const RTH_BARS_MIN = 300;          // leaves out the short sessions

// Bars from `warmDays` before `from` to `to`, and the full RTH sessions to score.
export function loadSample({ file, from = Y26, to = Infinity, warmDays = 200 } = {}) {
  const { bars, meta } = loadBars(file);
  const start = indexAtOrAfter(bars.ts, from - warmDays * DAY_MS), b = sliceBars(bars, start, bars.count);
  const sessions = sessionsOf(b), adr = adrOf(sessions), days = [];
  sessions.forEach((s, k) => {
    const ms = s.td * DAY_MS;
    if (ms < from || ms >= to || s.rthA < 0 || s.rthZ - s.rthA < RTH_BARS_MIN || !Number.isFinite(adr[k])) return;
    days.push({ k, td: s.td, ms, a: s.rthA, z: s.rthZ, sa: s.a, U: adr[k], half: ms < APR ? 0 : 1 });
  });
  return { b, meta, sessions, days, trend: emaTrend(b) };
}

// The 10-minute 9/21 EMA direction each 1-minute bar could see, the $1,250 book's filter.
function emaTrend(b) {
  const st = resolveStudy({ type: "emacross", tf: 10, params: { fast: 9, slow: 21 } }), { bars: sb, out } = computeStudy(b, st, 1, b);
  const map = closedIndexMap(b, sb), n = b.close.length, dir = new Int8Array(n);
  for (let i = 0; i < n; i++) if (map[i] >= 0) dir[i] = out.dir[map[i]];
  return dir;
}

// A study's lines on the 1-minute bars, each value as of that bar's close.
export function studyLines(sample, type, tf = 1, params = {}) {
  const { b } = sample, st = resolveStudy({ type, tf, params }), { bars: sb, out } = computeStudy(b, st, 1, b);
  const res = {};
  const map = sb === b ? null : closedIndexMap(b, sb), n = b.close.length;
  for (const ln of out.lines) {
    if (!map) { res[ln.name] = ln.data; continue; }
    const a = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (map[i] >= 0) a[i] = ln.data[map[i]];
    res[ln.name] = a;
  }
  return res;
}

// Back-adjusted price minus the contract's own price at a time, from the data's rolls.
export function rawOffset(meta, ms) {
  let off = 0;
  for (const r of meta.rollovers || []) if (r.ms > ms) off += r.gap;
  return off;
}

// ── events ───────────────────────────────────────────────────────────────
export class Events {
  constructor(cap = 1 << 20) {
    this.n = 0; this.cap = cap;
    for (const [k, T] of Object.entries(Events.COLS)) this[k] = new T(cap);
  }
  push(tag, day, real, side, oc, pnl, ct, no, prev, speed, withTrend, boPnl) {
    if (this.n === this.cap) this._grow();
    const i = this.n++;
    this.tag[i] = tag; this.day[i] = day; this.real[i] = real; this.side[i] = side; this.oc[i] = oc;
    this.pnl[i] = pnl; this.ct[i] = ct; this.no[i] = no; this.prev[i] = prev; this.speed[i] = speed; this.withTrend[i] = withTrend; this.boPnl[i] = boPnl;
  }
  _grow() {
    this.cap *= 2;
    for (const [k, T] of Object.entries(Events.COLS)) { const a = new T(this.cap); a.set(this[k]); this[k] = a; }
  }
}
Events.COLS = { tag: Int16Array, day: Int16Array, real: Int8Array, side: Int8Array, oc: Int8Array, pnl: Float32Array, ct: Int16Array, no: Int8Array,
                prev: Int8Array, speed: Float32Array, withTrend: Int8Array, boPnl: Float32Array };

// Every touch of one level over bars [a, z). S is a series, or null with a constant P;
// `off` moves it (a twin). `prev` on each touch says how the last one on this level
// that day ended: 0 first touch, 1 bounced, 2 broke, 3 unresolved. With `chain`, it
// stops at the first break or unresolved touch, as the original study did.
export function scanLevel(sample, S, P, off, a, z, R, o, emit) {
  const { high: H, low: L, close: C, ctMin: CT } = sample.b;
  const trend = sample.trend, thru = (o.thru ?? 1) * TICK, hold = o.hold ?? 60, want = o.side ?? 0, maxT = o.maxTouches ?? 4;
  let i = Math.max(a, 1), no = 0, prev = 0;
  while (i < z && no < maxT) {
    // armed: a close at least R from the level
    let side = 0;
    for (; i < z; i++) {
      const p = (S ? S[i - 1] : P) + off;
      if (!(p === p)) continue;
      if (C[i] - p >= R) { side = 1; break; }
      if (p - C[i] >= R) { side = -1; break; }
    }
    if (!side) return;
    if (want && side !== want) { if (o.chain) return; i++; continue; }
    // the touch
    let k = i + 1, p = NaN;
    for (; k < z; k++) {
      p = (S ? S[k - 1] : P) + off;
      if (!(p === p)) continue;
      if (side === 1 ? L[k] <= p - thru : H[k] >= p + thru) break;
    }
    if (k >= z) return;
    // the outcome: R back before R through, in the HOLD minutes after it
    const e = Math.min(k + hold, z);
    let oc = 0, at = e - 1;
    for (let j = k; j < e; j++) {
      const through = side === 1 ? L[j] <= p - R : H[j] >= p + R;
      if (through) { oc = -1; at = j; break; }
      if (j > k && (side === 1 ? H[j] >= p + R : L[j] <= p - R)) { oc = 1; at = j; break; }
    }
    const pnl = oc === 1 ? R : oc === -1 ? -R - TICK : side * (C[e - 1] - p);
    // the same touch traded the other way: a stop two ticks through, with the move
    const en = p - side * 2 * TICK;
    let bo = NaN;
    for (let j = k + 1; j < e; j++) {
      const stop = side === 1 ? H[j] >= en + R : L[j] <= en - R, tgt = side === 1 ? L[j] <= en - R : H[j] >= en + R;
      if (stop) { bo = -R - TICK; break; }
      if (tgt) { bo = R; break; }
    }
    if (Number.isNaN(bo)) bo = -side * (C[e - 1] - en);
    const speed = k >= 5 ? (side * (C[k - 5] - C[k - 1])) / R : 0;
    emit(side, oc, pnl, CT[k], no, prev, speed, trend[k] === 0 ? 0 : trend[k] === side ? 1 : -1, bo, k);
    no++;
    if (oc === 1) { prev = 1; i = at; continue; }
    if (o.chain) return;
    prev = oc === -1 ? 2 : 3;
    i = oc === -1 ? at : e;
  }
}

function hash(a, b, c, d) { return (Math.imul(a + 1, 2654435761) ^ Math.imul(b + 1, 40503) ^ Math.imul(c + 1, 2246822519) ^ Math.imul(d + 1, 3266489917)) | 0; }
const roundTick = (x) => Math.round(x / TICK) * TICK;

// The whole catalog over the sample's days, with `twins` per level per day.
// `levels` is [{ tag, series?: [arrays], list?: (day) => [prices], maxTouches?, side? }].
export function runLevels(sample, levels, { rFrac = 0.05, thru = 1, hold = 60, twins = 8, chain = true, range = "rth", days = sample.days, seed = 7 } = {}) {
  const ev = new Events();
  levels.forEach((lv, tag) => {
    days.forEach((d) => {
      const dayIdx = sample.days.indexOf(d), R = Math.max(4 * TICK, roundTick(rFrac * d.U));
      const a = range === "on" ? d.sa : d.a, z = range === "on" ? d.a : d.z;
      const tracks = lv.list ? lv.list(d).map((P) => ({ P })) : lv.series.map((S) => ({ S }));
      tracks.forEach((tr, q) => {
        for (let tw = 0; tw <= twins; tw++) {
          let off = 0;
          if (tw) {
            const r = mulberry32(hash(tag, d.td, q, tw + seed * 1000));
            off = roundTick((r() < 0.5 ? -1 : 1) * (1.5 + 4.5 * r()) * R);
          }
          const o = { thru, hold, chain, maxTouches: lv.maxTouches ?? 4, side: lv.side ?? 0 };
          scanLevel(sample, tr.S || null, tr.P, off, a, z, R, o, (side, oc, pnl, ct, no, prev, speed, wt, bo) =>
            ev.push(tag, dayIdx, tw ? 0 : 1, side, oc, pnl, ct, no, prev, speed, wt, bo));
        }
      });
    });
  });
  return ev;
}

// ── statistics ───────────────────────────────────────────────────────────
// Resamples of the day indexes, shared so that tests compare on the same draws.
export function bootDays(nDays, nBoot = 2000, seed = 2026) {
  const r = mulberry32(seed), out = new Int32Array(nBoot * nDays);
  for (let i = 0; i < out.length; i++) out[i] = Math.floor(r() * nDays);
  return out;
}

// By tag, the event ids, so a tag's filters do not rescan everything.
export function byTag(ev, nTags) {
  const count = new Int32Array(nTags);
  for (let i = 0; i < ev.n; i++) count[ev.tag[i]]++;
  const out = Array.from({ length: nTags }, (_, t) => new Int32Array(count[t])), at = new Int32Array(nTags);
  for (let i = 0; i < ev.n; i++) out[ev.tag[i]][at[ev.tag[i]]++] = i;
  return out;
}

// Real bounce% minus twin bounce% over the events `ids` passing `keep`.
export function edgeOf(ev, ids, nDays, boot, nBoot, keep = null) {
  const rb = new Float64Array(nDays), rn = new Float64Array(nDays), tb = new Float64Array(nDays), tn = new Float64Array(nDays);
  let evR = 0, evT = 0, nR = 0, nT = 0, boR = 0, boT = 0;
  for (const i of ids) {
    if (keep && !keep(i)) continue;
    const d = ev.day[i], net = ev.pnl[i] - COST_PTS, bo = ev.boPnl[i] - COST_PTS;
    if (ev.real[i]) { nR++; evR += net; boR += bo; } else { nT++; evT += net; boT += bo; }
    if (ev.oc[i] === 0) continue;
    if (ev.real[i]) { rn[d]++; if (ev.oc[i] === 1) rb[d]++; } else { tn[d]++; if (ev.oc[i] === 1) tb[d]++; }
  }
  const sum = (a) => { let s = 0; for (let i = 0; i < nDays; i++) s += a[i]; return s; };
  const RB = sum(rb), RN = sum(rn), TB = sum(tb), TN = sum(tn);
  if (!RN || !TN) return null;
  const real = RB / RN, twin = TB / TN, edge = real - twin, bs = new Float64Array(nBoot);
  let m = 0, below = 0, above = 0;
  for (let k = 0; k < nBoot; k++) {
    let a = 0, b = 0, c = 0, e = 0;
    const off = k * nDays;
    for (let q = 0; q < nDays; q++) { const d = boot[off + q]; a += rb[d]; b += rn[d]; c += tb[d]; e += tn[d]; }
    if (!b || !e) continue;
    const x = a / b - c / e;
    bs[m++] = x;
    if (x <= 0) below++;
    if (x >= 0) above++;
  }
  const s = bs.subarray(0, m).sort();
  return {
    n: RN, real: real * 100, twin: twin * 100, edge: edge * 100, lo: s[Math.floor(0.025 * m)] * 100, hi: s[Math.floor(0.975 * m)] * 100,
    p: Math.max(1 / m, (2 * Math.min(below, above)) / m), evReal: nR ? evR / nR : 0, evTwin: nT ? evT / nT : 0, boReal: nR ? boR / nR : 0, boTwin: nT ? boT / nT : 0,
  };
}

// Benjamini-Hochberg: the q-value of each p in a list.
export function bh(ps) {
  const m = ps.length, order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]), q = new Array(m);
  let best = 1;
  for (let r = m - 1; r >= 0; r--) { best = Math.min(best, (order[r][0] * m) / (r + 1)); q[order[r][1]] = best; }
  return q;
}

export const fmtEdge = (e) => (e ? `${e.edge >= 0 ? "+" : ""}${e.edge.toFixed(1)} [${e.lo.toFixed(1)}, ${e.hi.toFixed(1)}] n${e.n}` : "—");
export { ema };
