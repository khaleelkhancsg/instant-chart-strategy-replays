// Shared machinery for the opening-range "one 5-minute candle" tests.
// Setup detection and trade resolution are separate steps on purpose: a control
// can replay the exact same schedule with one thing changed and nothing else.

import { loadBars } from "../src/data.mjs";

export const PV = 2, TICK = 0.25, SLIP = 0.25, PERSIDE = 0.75;
export const CAP = 1000, LOTS = 8;
export const OPEN_CT = 510, FLAT_CT = 900;

const { bars } = loadBars();
export const { open: O, high: H, low: L, close: C, tday: TD, ts: TS, count: N } = bars;

// A futures day OPENS at 17:00 CT (ctMin 1020) and runs through midnight, so raw
// ctMin is not monotone within a tday: 1020..1439, then 0..960. Map the evening
// block to negative minutes so session minute increases all day.
export const CT = new Int16Array(N);
for (let i = 0; i < N; i++) CT[i] = bars.ctMin[i] >= 960 ? bars.ctMin[i] - 1440 : bars.ctMin[i];

const dayStart = new Map();
for (let i = 0; i < N; i++) if (!dayStart.has(TD[i])) dayStart.set(TD[i], i);
export const dayKeys = [...dayStart.keys()].sort((a, b) => a - b);
const dayEnd = new Map();
for (const d of dayKeys) { let e = dayStart.get(d); while (e < N && TD[e] === d) e++; dayEnd.set(d, e); }

// Every scan below only cares about the block from an hour and a half before
// the open onward, but a tday starts at 17:00 the previous evening -- about 900
// bars earlier. Skipping straight to the relevant block cuts a parameter sweep
// from ~2.6M bar visits per config to ~450k.
const daySess = new Map();
for (const d of dayKeys) {
  let i = dayStart.get(d); const e = dayEnd.get(d);
  while (i < e && CT[i] < OPEN_CT - 90) i++;
  daySess.set(d, i);
}
export { dayStart, dayEnd, daySess };

export function refBounds(refWin) {
  if (refWin === "OR5")   return [OPEN_CT, OPEN_CT + 5];
  if (refWin === "OR15")  return [OPEN_CT, OPEN_CT + 15];
  if (refWin === "OR30")  return [OPEN_CT, OPEN_CT + 30];
  if (refWin === "OR60")  return [OPEN_CT, OPEN_CT + 60];
  if (refWin === "PRE30") return [OPEN_CT - 30, OPEN_CT];
  if (refWin === "PRE60") return [OPEN_CT - 60, OPEN_CT];
  throw new Error("refWin? " + refWin);
}

// Returns {out: schedule[], diag}. Each entry: {bar, dir, entryPx, risk, day, e0, width}.
export function setups(cfg) {
  const {
    refWin = "OR5", mode = "confirmed",
    buf = 0.0, buf2 = 1.0, retraceFrac = 0.33,
    stopAt = "range", stopK = 0.5, giveUpCt = 570,
    // Legs normally must land on strictly LATER bars, because 1-minute data
    // cannot say what order a high and a low happened in. Setting sameBar drops
    // that guard and lets the pattern complete inside a single bar, resolving
    // the ambiguity in the strategy's favour. It is not realistic -- it is an
    // OPTIMISTIC BOUND on what 5-second data could possibly be hiding.
    sameBar = false,
  } = cfg;

  const out = [];
  const diag = { days: 0, ranged: 0, push1: 0, retraced: 0, entered: 0, bothWays: 0, badStop: 0 };
  const [a, b] = refBounds(refWin);

  for (const day of dayKeys) {
    const s0 = daySess.get(day), e0 = dayEnd.get(day);
    let hi = -Infinity, lo = Infinity, nRef = 0;
    for (let i = s0; i < e0 && CT[i] < b; i++) if (CT[i] >= a) {
      if (H[i] > hi) hi = H[i]; if (L[i] < lo) lo = L[i]; nRef++;
    }
    diag.days++;
    if (nRef < Math.min(5, b - a) || !(hi > lo)) continue;
    diag.ranged++;
    const width = hi - lo;

    const riskFor = (dir, entryPx, lvl, retExt) => {
      if (stopAt === "range")    return Math.max(width * stopK, TICK);
      if (stopAt === "opposite") return Math.abs(entryPx - (dir === 1 ? lo : hi));
      if (stopAt === "retrace")  return Math.abs(entryPx - retExt);
      return Math.abs(entryPx - lvl);
    };

    const huntFrom = Math.max(b, OPEN_CT);
    let st = 0, dir = 0, p1 = 0, lvl = 0, stateBar = -1, retExt = 0, done = false;

    for (let i = s0; i < e0 && !done; i++) {
      if (CT[i] < huntFrom) continue;
      if (CT[i] >= giveUpCt) break;

      // Each block falls through to the next ONLY when sameBar is set, so the
      // strict path still advances at most one state per bar.
      if (st === 0) {
        const up = H[i] > hi + buf * TICK, dn = L[i] < lo - buf * TICK;
        if (up && dn) { diag.bothWays++; break; }
        if (!up && !dn) continue;
        dir = up ? 1 : -1; lvl = up ? hi : lo; p1 = up ? H[i] : L[i];
        st = 1; stateBar = i; diag.push1++;
        if (mode === "plain") {
          const entryPx = lvl + dir * buf2 * TICK;
          const risk = riskFor(dir, entryPx, lvl, entryPx);
          if (risk < TICK) { diag.badStop++; break; }
          out.push({ bar: i, dir, entryPx, risk, day, e0, width });
          diag.entered++; done = true;
          break;
        }
        if (!sameBar) continue;
      }

      if (st === 1) {
        if (i > stateBar || sameBar) {
          if (dir === 1 && H[i] > p1) p1 = H[i];
          if (dir === -1 && L[i] < p1) p1 = L[i];
          const ext = Math.abs(p1 - lvl);
          const need = p1 - dir * Math.max(ext * retraceFrac, TICK);
          if (dir === 1 ? L[i] <= need : H[i] >= need) {
            st = 2; stateBar = i; retExt = dir === 1 ? L[i] : H[i]; diag.retraced++;
          }
        }
        if (st !== 2 || !sameBar) continue;
      }

      if (st === 2) {
        if (i <= stateBar && !sameBar) continue;
        const trig = p1 + dir * buf2 * TICK;
        if (dir === 1 ? H[i] >= trig : L[i] <= trig) {
          const risk = riskFor(dir, trig, lvl, retExt);
          if (risk < TICK) { diag.badStop++; break; }
          out.push({ bar: i, dir, entryPx: trig, risk, day, e0, width });
          diag.entered++; done = true;
        } else if (i > stateBar && (dir === 1 ? L[i] < lvl : H[i] > lvl)) break;
        // ^ only abandon on a LATER bar. The breakout bar's own low sits below
        // the level almost by definition, so checking it on the same bar kills
        // the setup instantly. No-op on the strict path, where i > stateBar is
        // already guaranteed here.
      }
    }
  }
  return { out, diag };
}

// Stop-before-target inside a bar, gap-through at the open, hard flat at close.
// The stop is ALWAYS `risk` on the protective side, so an inverted bracket --
// which books an instant fake profit -- is impossible by construction.
export function resolve(s, opt = {}) {
  const { rMult = 2.0, maxHoldMin = 120, flipDir, riskDollars = 0, maxLots = 40 } = opt;
  const dir = flipDir ?? s.dir;
  const { bar: i, e0, entryPx, risk, day } = s;
  const lots = riskDollars
    ? Math.max(1, Math.min(maxLots, Math.floor(riskDollars / (risk * PV))))
    : LOTS;
  const sl = entryPx - dir * risk, tp = entryPx + dir * risk * rMult;
  const fill = dir === 1 ? entryPx + SLIP : entryPx - SLIP;
  const fees = PERSIDE * 2 * lots;
  const out = (px, why, held) => {
    const xp = dir === 1 ? px - SLIP : px + SLIP;
    const gross = (xp - fill) * dir * PV * lots - fees;
    return { tday: day, pnl: Math.max(-CAP, gross), raw: gross, why, risk, held, dir, lots,
             riskUsd: risk * PV * lots, capped: gross < -CAP };
  };
  for (let j = i; j < e0; j++) {
    if (CT[j] >= FLAT_CT) return out(O[j], "FLAT", j - i);
    if ((j - i) >= maxHoldMin) return out(O[j], "TIME", j - i);
    if (j > i) {
      if (dir === 1 ? O[j] <= sl : O[j] >= sl) return out(O[j], "SL", j - i);
      if (dir === 1 ? O[j] >= tp : O[j] <= tp) return out(O[j], "TP", j - i);
    }
    if (dir === 1 ? L[j] <= sl : H[j] >= sl) return out(sl, "SL", j - i);
    if (dir === 1 ? H[j] >= tp : L[j] <= tp) return out(tp, "TP", j - i);
  }
  return out(C[e0 - 1], "EOD", e0 - 1 - i);
}

export function run(cfg) {
  const { out, diag } = setups(cfg);
  let rnd = (cfg.flipSeed || 1) >>> 0;
  const coin = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd > 2147483648; };
  const trades = out.map(s => resolve(s, { ...cfg, flipDir: cfg.flipSeed ? (coin() ? 1 : -1) : undefined }));
  return { trades, diag };
}

// ---- combine evaluator (identical to the one used on the shipped bot) ------
export function ev(d) {
  let c = 0, pk = 0, lk = false, md = -1e18;
  for (const v of d) {
    c += v; if (v > md) md = v;
    if (c <= (lk ? 0 : pk - 2000)) return 0;
    if (c > pk) pk = c;
    if (!lk && pk >= 2000) lk = true;
    if (c >= 3000 && md <= 0.5 * c) return 1;
  }
  return 0;
}
export function mul(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function dayArr(trades, keys) {
  const m = new Map(); for (const d of keys) m.set(d, 0);
  for (const t of trades) if (m.has(t.tday)) m.set(t.tday, Math.max(-CAP, m.get(t.tday) + t.pnl));
  return keys.map(k => m.get(k));
}
export function passOfArr(arr, draws = 12000, s = 4242) {
  const rnd = mul(s), idx = new Array(21), buf = new Array(21);
  let w = 0;
  for (let d = 0; d < draws; d++) {
    let mm = 0;
    while (mm < 21) { const st = Math.floor(rnd() * Math.max(1, arr.length - 5));
      for (let j = 0; j < 5 && mm < 21; j++) idx[mm++] = (st + j) % arr.length; }
    for (let k = 0; k < 21; k++) buf[k] = arr[idx[k]];
    w += ev(buf);
  }
  return 100 * w / draws;
}
export const passOf = (trades, keys, draws, s) => passOfArr(dayArr(trades, keys), draws, s);

export function stat(t) {
  if (!t.length) return { n: 0, win: 0, pf: 0, exp: 0, net: 0, med: 0, capped: 0 };
  let gw = 0, gl = 0, tot = 0, w = 0, cp = 0; const hs = [];
  for (const x of t) { tot += x.pnl; hs.push(x.held); if (x.capped) cp++;
    if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; }
  hs.sort((a, b) => a - b);
  return { n: t.length, win: 100 * w / t.length, pf: gl > 0 ? gw / gl : Infinity,
           exp: tot / t.length, net: tot, med: hs[hs.length >> 1], capped: 100 * cp / t.length };
}

export const ALL = dayKeys;
export const H1 = ALL.slice(0, Math.floor(ALL.length / 2));
export const H2 = ALL.slice(Math.floor(ALL.length / 2));
export const RECENT = ALL.slice(-500);
export const inSet = (t, set) => { const s = new Set(set); return t.filter(x => s.has(x.tday)); };

export const HDR =
  "  variant                            n   win%     pf   $/trade         net   hold  cap%    pass   1stH   2ndH recent";
export function row(label, r) {
  const st = stat(r.trades);
  const p = passOf(r.trades, ALL), p1 = passOf(inSet(r.trades, H1), H1);
  const p2 = passOf(inSet(r.trades, H2), H2), pr = passOf(inSet(r.trades, RECENT), RECENT);
  console.log("  " + label.padEnd(30) + String(st.n).padStart(6) +
    st.win.toFixed(1).padStart(7) + (st.pf === Infinity ? "    inf" : st.pf.toFixed(3).padStart(7)) +
    ("$" + st.exp.toFixed(2)).padStart(10) + ("$" + Math.round(st.net).toLocaleString()).padStart(12) +
    String(st.med).padStart(6) + "m" + st.capped.toFixed(0).padStart(5) + "%" +
    p.toFixed(1).padStart(8) + "%" + p1.toFixed(1).padStart(7) + "%" +
    p2.toFixed(1).padStart(7) + "%" + pr.toFixed(1).padStart(7) + "%");
  return { p, p1, p2, pr, st };
}
