// Price levels. ISOMORPHIC.
//
// What a trader draws on a chart, as series: volume profiles, a period's range,
// pivots, the opening balance, session opens, swings. Each builder takes a bar set
// and returns arrays aligned with it, NaN where the level does not exist yet.
//
// One rule for all of them: out[i] uses bars up to and including i, never a later
// one. Two shapes follow from it:
//   FIXED       set when the period that defines it is over, then held: the prior
//               day's POC, the initial balance, a pivot.
//   DEVELOPING  moves as bars arrive: today's POC so far, the day's high so far.
//
// Sessions are bars.tday, which turns over between sessions, and RTH is 08:30-15:00
// CT (bars.ctMin). src/studies.mjs draws and gates on these and research/lib_levels.mjs
// measures them, so a level on the chart is the level the research tested.

const RTH_OPEN = 510, RTH_CLOSE = 900;
const inRth = (ct) => ct >= RTH_OPEN && ct < RTH_CLOSE;
const nanArr = (n) => new Float64Array(n).fill(NaN);
const DAY_MS = 86400000;

// ── calendars ────────────────────────────────────────────────────────────
// Monday-based: the Sunday evening session is already Monday's trading day.
export const weekOf = (tday) => Math.floor((tday + 3) / 7);
const monthOf = (tday) => { const d = new Date(tday * DAY_MS); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

// A key per bar that changes exactly where the period turns over.
export function periodKey(b, period) {
  const n = b.tday.length, out = new Int32Array(n);
  let td = null, k = 0;
  for (let i = 0; i < n; i++) {
    if (b.tday[i] !== td) {
      td = b.tday[i];
      k = period === "week" ? weekOf(td) : period === "month" ? monthOf(td) : period === "quarter" ? Math.floor(monthOf(td) / 3) : td;
    }
    out[i] = k;
  }
  return out;
}

// One record per trading day: where its bars are, and its RTH high, low and close.
export function sessionsOf(b) {
  const out = [], n = b.tday.length;
  let s = null;
  for (let i = 0; i < n; i++) {
    if (!s || b.tday[i] !== s.td) { s = { td: b.tday[i], a: i, z: i + 1, rthA: -1, rthZ: -1, hi: -Infinity, lo: Infinity, close: NaN }; out.push(s); }
    s.z = i + 1;
    if (inRth(b.ctMin[i])) {
      if (s.rthA < 0) s.rthA = i;
      s.rthZ = i + 1;
      if (b.high[i] > s.hi) s.hi = b.high[i];
      if (b.low[i] < s.lo) s.lo = b.low[i];
      s.close = b.close[i];
    }
  }
  return out;
}

// The mean RTH range of the `days` sessions before each session in `sessions`, or
// NaN with fewer than `least` of them.
export function adrOf(sessions, days = 10, least = 5) {
  const out = new Float64Array(sessions.length).fill(NaN);
  for (let k = 0; k < sessions.length; k++) {
    let sum = 0, c = 0;
    for (let q = Math.max(0, k - days); q < k; q++) if (sessions[q].rthA >= 0) { sum += sessions[q].hi - sessions[q].lo; c++; }
    if (c >= least) out[k] = sum / c;
  }
  return out;
}

// ── the volume profile ───────────────────────────────────────────────────
// Volume at price from bars: each bar's volume spread evenly over its high-low
// range, in bins of `bin` points. On 1-minute bars that is close to the real thing
// (the even spread only degrades on coarse bars). With a tie, the lowest bin is the POC.
export class Profile {
  constructor(bin = 1) { this.bin = bin; this.v = new Float64Array(4096); this.clear(); }

  clear() {
    if (this.hi >= this.lo) this.v.fill(0, this.lo - this.base, this.hi - this.base + 1);
    this.base = 0; this.lo = Infinity; this.hi = -Infinity; this.total = 0; this.max = 0; this.pocK = 0;
  }

  _grow(s, e) {
    const lo = Math.min(s, this.lo), hi = Math.max(e, this.hi), width = hi - lo + 1;
    const size = Math.max(width * 2, this.v.length), v = new Float64Array(size), base = lo - ((size - width) >> 1);
    if (this.hi >= this.lo) v.set(this.v.subarray(this.lo - this.base, this.hi - this.base + 1), this.lo - base);
    this.v = v; this.base = base;
  }

  // Volume spread over the bins from `low` to `high`, both included.
  add(low, high, vol) {
    if (!(vol > 0)) return;
    const s = Math.floor(low / this.bin), e = Math.floor(high / this.bin);
    if (s < this.base || e - this.base >= this.v.length || this.hi < this.lo) this._grow(s, e);
    const v = this.v, base = this.base, w = vol / (e - s + 1);
    let max = this.max, poc = this.pocK;
    for (let k = s; k <= e; k++) {
      const x = (v[k - base] += w);
      if (x > max || (x === max && k < poc)) { max = x; poc = k; }
    }
    this.max = max; this.pocK = poc; this.total += vol;
    if (s < this.lo) this.lo = s;
    if (e > this.hi) this.hi = e;
  }

  addBins(lo, bins) {
    const e = lo + bins.length - 1;
    if (lo < this.base || e - this.base >= this.v.length || this.hi < this.lo) this._grow(lo, e);
    for (let j = 0; j < bins.length; j++) {
      const k = lo + j, x = (this.v[k - this.base] += bins[j]);
      if (x > this.max || (x === this.max && k < this.pocK)) { this.max = x; this.pocK = k; }
      this.total += bins[j];
    }
    if (lo < this.lo) this.lo = lo;
    if (e > this.hi) this.hi = e;
  }

  bins() { return this.hi >= this.lo ? this.v.slice(this.lo - this.base, this.hi - this.base + 1) : new Float64Array(0); }
  price(k) { return (k + 0.5) * this.bin; }
  poc() { return this.price(this.pocK); }

  // The value area: out from the POC, always to the heavier neighbouring bin, until
  // `frac` of the volume is inside. A tie goes up. Returns [low bin, high bin].
  valueArea(frac = 0.7) {
    const v = this.v, base = this.base, target = frac * this.total, lo0 = this.lo, hi0 = this.hi;
    let lo = this.pocK, hi = lo, acc = v[lo - base];
    while (acc < target) {
      const up = hi < hi0 ? v[hi + 1 - base] : -1, dn = lo > lo0 ? v[lo - 1 - base] : -1;
      if (up < 0 && dn < 0) break;
      if (up >= dn) { hi++; acc += up; } else { lo--; acc += dn; }
    }
    return [lo, hi];
  }
}

// The profile of this session (from 17:00 CT), of RTH alone, or of the week or month
// so far, as it stood at each bar. RTH is blank outside RTH. `weight: "time"` counts
// each bar as one, which is a TPO profile: where the market spent its time.
export function developingProfile(b, { anchor = "session", bin = 1, valueArea = 0.7, weight = "volume" } = {}) {
  const n = b.close.length, poc = nanArr(n), vah = nanArr(n), val = nanArr(n);
  const rth = anchor === "rth", key = periodKey(b, rth ? "session" : anchor), P = new Profile(bin), time = weight === "time";
  let cur = null;
  for (let i = 0; i < n; i++) {
    if (key[i] !== cur) { cur = key[i]; P.clear(); }
    if (rth && !inRth(b.ctMin[i])) continue;
    P.add(b.low[i], b.high[i], time ? 1 : b.volume[i]);
    if (!(P.total > 0)) continue;
    const [lo, hi] = P.valueArea(valueArea);
    poc[i] = P.poc(); val[i] = P.price(lo); vah[i] = P.price(hi);
  }
  return { poc, vah, val };
}

// Each profile's final reading, held from the bar after its period ended until the
// next one has ended. An RTH profile is final at 15:00 CT.
export function priorProfile(b, opts = {}) {
  const anchor = opts.anchor || "session", d = developingProfile(b, opts);
  const n = b.close.length, poc = nanArr(n), vah = nanArr(n), val = nanArr(n);
  const rth = anchor === "rth", key = periodKey(b, rth ? "session" : anchor);
  let last = -1, held = -1;
  for (let i = 0; i < n; i++) {
    if (last >= 0 && (key[i] !== key[last] || (rth && !inRth(b.ctMin[i])))) { held = last; last = -1; }
    if (Number.isFinite(d.poc[i])) last = i;
    if (held >= 0) { poc[i] = d.poc[held]; vah[i] = d.vah[held]; val[i] = d.val[held]; }
  }
  return { poc, vah, val };
}

// A Gaussian filter over bins, truncated at 4 sigma, reflected at the ends.
export function gaussianSmooth(v, sigma) {
  const n = v.length, r = Math.ceil(4 * sigma), w = new Float64Array(2 * r + 1), out = new Float64Array(n);
  let sum = 0;
  for (let k = -r; k <= r; k++) { w[k + r] = Math.exp(-0.5 * (k / sigma) ** 2); sum += w[k + r]; }
  const at = (i) => { const m = 2 * n; let j = ((i % m) + m) % m; if (j >= n) j = m - 1 - j; return v[j]; };
  for (let i = 0; i < n; i++) { let s = 0; for (let k = -r; k <= r; k++) s += w[k + r] * at(i + k); out[i] = s / sum; }
  return out;
}

// Peaks of y: local maxima kept tallest-first at least `distance` apart, each with its
// prominence (how far it stands above the higher of the two lows around it).
export function findPeaks(y, distance = 1, minProminence = 0) {
  const n = y.length, peaks = [];
  for (let i = 1; i < n - 1; i++) {
    if (!(y[i] > y[i - 1])) continue;
    let j = i;
    while (j + 1 < n && y[j + 1] === y[i]) j++;
    if (j + 1 < n && y[j + 1] < y[i]) peaks.push((i + j) >> 1);
    i = j;
  }
  const order = peaks.slice().sort((a, b) => y[b] - y[a]), keep = new Set(peaks), out = [];
  for (const p of order) {
    if (!keep.has(p)) continue;
    for (const q of peaks) if (q !== p && Math.abs(q - p) < distance) keep.delete(q);
  }
  for (const p of peaks) {
    if (!keep.has(p)) continue;
    let l = y[p], r = y[p];
    for (let i = p - 1; i >= 0 && y[i] <= y[p]; i--) if (y[i] < l) l = y[i];
    for (let i = p + 1; i < n && y[i] <= y[p]; i++) if (y[i] < r) r = y[i];
    const prom = y[p] - Math.max(l, r);
    if (prom >= minProminence) out.push({ i: p, prom });
  }
  return out;
}

// The composite profile of the `sessions` whole sessions before each one, held all
// session: its POC and value area on the smoothed profile, its `nodes` most prominent
// high-volume nodes and the low-volume nodes between them. The smoothing and spacing
// scale with the recent daily range, as the level study set them.
export function compositeLevels(b, { sessions = 5, bin = 1, valueArea = 0.7, nodes = 6 } = {}) {
  const n = b.close.length, S = sessionsOf(b), adr = adrOf(S);
  const poc = nanArr(n), vah = nanArr(n), val = nanArr(n);
  const hvn = Array.from({ length: nodes }, () => nanArr(n)), lvn = Array.from({ length: Math.max(0, nodes - 1) }, () => nanArr(n));
  const done = [];             // finished sessions' profiles, oldest first
  const P = new Profile(bin), one = new Profile(bin);
  S.forEach((s, k) => {
    if (done.length >= sessions && Number.isFinite(adr[k])) {
      P.clear();
      for (const d of done.slice(-sessions)) P.addBins(d.lo, d.bins);
      const raw = P.bins(), U = adr[k] / bin;
      const sm = gaussianSmooth(raw, Math.max(1, 0.015 * U));
      const Q = new Profile(bin);
      Q.addBins(P.lo, sm);
      const [lo, hi] = Q.valueArea(valueArea);
      const hPoc = Q.poc(), hVah = Q.price(hi), hVal = Q.price(lo);
      const top = findPeaks(sm, Math.max(2, Math.floor(0.08 * U)), 0.1 * Math.max(...sm)).sort((x, y) => y.prom - x.prom).slice(0, nodes);
      const at = top.map((t) => t.i).sort((x, y) => x - y);
      for (let i = s.a; i < s.z; i++) { poc[i] = hPoc; vah[i] = hVah; val[i] = hVal; }
      top.forEach((t, q) => { const p = P.price(P.lo + t.i); for (let i = s.a; i < s.z; i++) hvn[q][i] = p; });
      for (let q = 0; q + 1 < at.length; q++) {
        let m = at[q];
        for (let j = at[q]; j <= at[q + 1]; j++) if (sm[j] < sm[m]) m = j;
        const p = P.price(P.lo + m);
        for (let i = s.a; i < s.z; i++) lvn[q][i] = p;
      }
    }
    one.clear();
    for (let i = s.a; i < s.z; i++) one.add(b.low[i], b.high[i], b.volume[i]);
    if (one.total > 0) done.push({ lo: one.lo, bins: one.bins() });
    if (done.length > sessions) done.shift();
  });
  return { poc, vah, val, hvn, lvn };
}

// The nearest RTH POCs above and below the last close that no bar has traded through
// since their session ended: "naked" POCs, kept for `maxAge` sessions.
export function nakedPocs(b, { maxAge = 20, bin = 1 } = {}) {
  const n = b.close.length, above = nanArr(n), below = nanArr(n), P = new Profile(bin), open = [];
  let day = null, age = 0, on = false;
  for (let i = 0; i < n; i++) {
    const rth = inRth(b.ctMin[i]);
    if (on && (!rth || b.tday[i] !== day)) { if (P.total > 0) open.push({ p: P.poc(), age }); P.clear(); on = false; }
    if (b.tday[i] !== day) { day = b.tday[i]; age++; }
    if (rth) { on = true; P.add(b.low[i], b.high[i], b.volume[i]); }
    let up = Infinity, dn = -Infinity;
    for (let k = open.length - 1; k >= 0; k--) {
      const q = open[k];
      if (age - q.age > maxAge || (b.low[i] <= q.p && b.high[i] >= q.p)) { open.splice(k, 1); continue; }
      if (q.p > b.close[i] && q.p < up) up = q.p;
      if (q.p < b.close[i] && q.p > dn) dn = q.p;
    }
    if (up < Infinity) above[i] = up;
    if (dn > -Infinity) below[i] = dn;
  }
  return { above, below };
}

// ── a period's range ─────────────────────────────────────────────────────
// The last finished RTH session's high, low and close, from the bar after its close.
function priorRth(b) {
  const n = b.close.length, H = nanArr(n), L = nanArr(n), C = nanArr(n);
  let day = null, on = false, rH = -Infinity, rL = Infinity, rC = NaN, ph = NaN, pl = NaN, pc = NaN;
  for (let i = 0; i < n; i++) {
    const rth = inRth(b.ctMin[i]);
    if ((b.tday[i] !== day || !rth) && on) { ph = rH; pl = rL; pc = rC; on = false; }
    day = b.tday[i];
    if (rth) {
      if (!on) { on = true; rH = -Infinity; rL = Infinity; }
      if (b.high[i] > rH) rH = b.high[i];
      if (b.low[i] < rL) rL = b.low[i];
      rC = b.close[i];
    }
    H[i] = ph; L[i] = pl; C[i] = pc;
  }
  return { H, L, C };
}

// The week's, month's or quarter's open, its high and low so far, and the last whole
// period's high, low and close. Full sessions, overnight included.
export function periodLevels(b, { period = "week" } = {}) {
  const n = b.close.length, key = periodKey(b, period);
  const open = nanArr(n), high = nanArr(n), low = nanArr(n), pHigh = nanArr(n), pLow = nanArr(n), pClose = nanArr(n);
  let cur = null, o = NaN, h = -Infinity, l = Infinity, ph = NaN, pl = NaN, pc = NaN;
  for (let i = 0; i < n; i++) {
    if (key[i] !== cur) {
      if (cur !== null) { ph = h; pl = l; pc = b.close[i - 1]; }
      cur = key[i]; o = b.open[i]; h = -Infinity; l = Infinity;
    }
    if (b.high[i] > h) h = b.high[i];
    if (b.low[i] < l) l = b.low[i];
    open[i] = o; high[i] = h; low[i] = l; pHigh[i] = ph; pLow[i] = pl; pClose[i] = pc;
  }
  return { open, high, low, pHigh, pLow, pClose };
}

// Floor, Camarilla or Fibonacci pivots from the prior day's RTH, or the prior week's
// or month's whole range.
export function pivotLevels(b, { style = "floor", period = "day" } = {}) {
  const n = b.close.length;
  let H, L, C;
  if (period === "day") ({ H, L, C } = priorRth(b));
  else { const r = periodLevels(b, { period }); H = r.pHigh; L = r.pLow; C = r.pClose; }
  const names = style === "camarilla" ? ["C", "H3", "H4", "L3", "L4"] : ["P", "R1", "R2", "R3", "S1", "S2", "S3"];
  const out = Object.fromEntries(names.map((k) => [k, nanArr(n)]));
  for (let i = 0; i < n; i++) {
    const h = H[i], l = L[i], c = C[i], r = h - l;
    if (!Number.isFinite(r)) continue;
    if (style === "camarilla") {
      out.C[i] = c; out.H3[i] = c + (r * 1.1) / 4; out.H4[i] = c + (r * 1.1) / 2; out.L3[i] = c - (r * 1.1) / 4; out.L4[i] = c - (r * 1.1) / 2;
      continue;
    }
    const p = (h + l + c) / 3;
    out.P[i] = p;
    if (style === "fib") {
      out.R1[i] = p + 0.382 * r; out.R2[i] = p + 0.618 * r; out.R3[i] = p + r;
      out.S1[i] = p - 0.382 * r; out.S2[i] = p - 0.618 * r; out.S3[i] = p - r;
    } else {
      out.R1[i] = 2 * p - l; out.S1[i] = 2 * p - h; out.R2[i] = p + r; out.S2[i] = p - r;
      out.R3[i] = h + 2 * (p - l); out.S3[i] = l - 2 * (h - p);
    }
  }
  return out;
}

// The range so far of RTH today, of the week or of the month, with its midpoint and
// golden-ratio retracements: levels that move only when a new extreme is made.
export function rangeLevels(b, { period = "day" } = {}) {
  const n = b.close.length, rth = period === "day", key = periodKey(b, rth ? "session" : period);
  const high = nanArr(n), low = nanArr(n), mid = nanArr(n), f38 = nanArr(n), f62 = nanArr(n);
  let cur = null, h = -Infinity, l = Infinity;
  for (let i = 0; i < n; i++) {
    if (key[i] !== cur) { cur = key[i]; h = -Infinity; l = Infinity; }
    if (rth && !inRth(b.ctMin[i])) continue;
    if (b.high[i] > h) h = b.high[i];
    if (b.low[i] < l) l = b.low[i];
    const r = h - l;
    high[i] = h; low[i] = l; mid[i] = l + 0.5 * r; f38[i] = l + 0.382 * r; f62[i] = l + 0.618 * r;
  }
  return { high, low, mid, f38, f62 };
}

// The high and low of a period's first `sessions` sessions, such as Monday's range,
// from the bar after they end until the period does.
export function firstRange(b, { period = "week", sessions = 1 } = {}) {
  const n = b.close.length, key = periodKey(b, period), hi = nanArr(n), lo = nanArr(n);
  let cur = null, day = null, count = 0, h = -Infinity, l = Infinity;
  for (let i = 0; i < n; i++) {
    if (key[i] !== cur) { cur = key[i]; count = 0; day = null; h = -Infinity; l = Infinity; }
    if (b.tday[i] !== day) { day = b.tday[i]; count++; }
    if (count <= sessions) {
      if (b.high[i] > h) h = b.high[i];
      if (b.low[i] < l) l = b.low[i];
    } else { hi[i] = h; lo[i] = l; }
  }
  return { hi, lo };
}

// The initial balance: the high and low of the first `minutes` of RTH, known once that
// span is over and held to the close, with its extensions, multiples of its own range
// beyond each side.
export const IB_EXTENSIONS = [0.5, 1, 1.5, 2];
export function initialBalance(b, { minutes = 60 } = {}) {
  const n = b.close.length, end = RTH_OPEN + minutes, hi = nanArr(n), lo = nanArr(n), mid = nanArr(n);
  const up = IB_EXTENSIONS.map(() => nanArr(n)), dn = IB_EXTENSIONS.map(() => nanArr(n));
  let day = null, h = -Infinity, l = Infinity;
  for (let i = 0; i < n; i++) {
    const ct = b.ctMin[i];
    if (b.tday[i] !== day) { day = b.tday[i]; h = -Infinity; l = Infinity; }
    if (ct >= RTH_OPEN && ct < end) {
      if (b.high[i] > h) h = b.high[i];
      if (b.low[i] < l) l = b.low[i];
    } else if (ct >= end && ct < RTH_CLOSE && h > -Infinity) {
      hi[i] = h; lo[i] = l; mid[i] = (h + l) / 2;
      IB_EXTENSIONS.forEach((m, q) => { up[q][i] = h + m * (h - l); dn[q][i] = l - m * (h - l); });
    }
  }
  return { hi, lo, mid, up, dn };
}

// Minutes since the 17:00 CT session open, so a span can cross midnight.
const sinceOpen = (ct) => (ct - 1020 + 1440) % 1440;
export const CLOCK_SPANS = {
  asia: { from: 19 * 60, to: 23 * 60, label: "Asia, 19:00-23:00 CT" },
  london: { from: 60, to: 4 * 60, label: "London, 01:00-04:00 CT" },
  premarket: { from: 7 * 60, to: 8 * 60 + 30, label: "Pre-market, 07:00-08:30 CT" },
  overnight: { from: 17 * 60, to: 8 * 60 + 30, label: "Overnight, 17:00-08:30 CT" },
  midday: { from: 10 * 60 + 30, to: 12 * 60 + 30, label: "Midday, 10:30-12:30 CT" },
};

// The high and low of a clock span of each session, from its end to the session's.
export function clockRange(b, { span = "asia" } = {}) {
  const n = b.close.length, S = CLOCK_SPANS[span], from = sinceOpen(S.from), to = sinceOpen(S.to);
  const hi = nanArr(n), lo = nanArr(n);
  let day = null, h = -Infinity, l = Infinity;
  for (let i = 0; i < n; i++) {
    const t = sinceOpen(b.ctMin[i]);
    if (b.tday[i] !== day) { day = b.tday[i]; h = -Infinity; l = Infinity; }
    if (t >= from && t < to) {
      if (b.high[i] > h) h = b.high[i];
      if (b.low[i] < l) l = b.low[i];
    } else if (t >= to && h > -Infinity) { hi[i] = h; lo[i] = l; }
  }
  return { hi, lo };
}

// Opening prices: the 17:00 CT session open, midnight in New York (23:00 CT), the RTH
// open, and the week's and month's. Each is held from its bar to the session's end.
export function clockOpens(b) {
  const n = b.close.length, session = nanArr(n), midnight = nanArr(n), rth = nanArr(n);
  const week = periodLevels(b, { period: "week" }).open, month = periodLevels(b, { period: "month" }).open;
  let day = null, so = NaN, mo = NaN, ro = NaN;
  for (let i = 0; i < n; i++) {
    const t = sinceOpen(b.ctMin[i]);
    if (b.tday[i] !== day) { day = b.tday[i]; so = b.open[i]; mo = NaN; ro = NaN; }
    if (Number.isNaN(mo) && t >= sinceOpen(23 * 60)) mo = b.open[i];
    if (Number.isNaN(ro) && t >= sinceOpen(RTH_OPEN)) ro = b.open[i];
    session[i] = so; midnight[i] = mo; rth[i] = ro;
  }
  return { session, midnight, rth, week, month };
}

// Where the average day would reach: the RTH open plus and minus `mult` ADRs and half
// that, fixed at the open, and the two that move with the day: today's low so far plus
// the ADR, and today's high so far minus it.
export function adrProjections(b, { days = 10, mult = 1 } = {}) {
  const n = b.close.length, S = sessionsOf(b), adr = adrOf(S, days);
  const up = nanArr(n), up2 = nanArr(n), dn = nanArr(n), dn2 = nanArr(n), lowUp = nanArr(n), highDn = nanArr(n);
  S.forEach((s, k) => {
    const a = adr[k];
    if (s.rthA < 0 || !Number.isFinite(a)) return;
    const o = b.open[s.rthA], d = mult * a;
    let h = -Infinity, l = Infinity;
    for (let i = s.rthA; i < s.rthZ; i++) {
      if (b.high[i] > h) h = b.high[i];
      if (b.low[i] < l) l = b.low[i];
      up[i] = o + d; up2[i] = o + d / 2; dn[i] = o - d; dn2[i] = o - d / 2; lowUp[i] = l + d; highDn[i] = h - d;
    }
  });
  return { up, up2, dn, dn2, lowUp, highDn };
}

// ── structure ────────────────────────────────────────────────────────────
// Pivots: a bar whose high tops the `left` bars before it and is not topped by the
// `right` bars after it (and the mirror for a low), known `right` bars later.
function pivots(b, left, right, onHigh, onLow) {
  const n = b.close.length, { high: H, low: L } = b;
  for (let c = left + right; c < n; c++) {
    const j = c - right;
    let isH = true, isL = true;
    for (let q = j - left; q <= c && (isH || isL); q++) {
      if (q === j) continue;
      if (q < j ? H[q] >= H[j] : H[q] > H[j]) isH = false;
      if (q < j ? L[q] <= L[j] : L[q] < L[j]) isL = false;
    }
    if (isH) onHigh(j, c);
    if (isL) onLow(j, c);
  }
}

// The latest confirmed swing high and low, and the one before each.
export function swingLevels(b, { left = 5, right = 5 } = {}) {
  const n = b.close.length, high = nanArr(n), low = nanArr(n), high2 = nanArr(n), low2 = nanArr(n);
  const hs = [], ls = [];
  pivots(b, left, right, (j, c) => hs.push([c, b.high[j]]), (j, c) => ls.push([c, b.low[j]]));
  const fill = (ev, a, a2) => {
    let k = 0, cur = NaN, prev = NaN;
    for (let i = 0; i < n; i++) {
      while (k < ev.length && ev[k][0] <= i) { prev = cur; cur = ev[k++][1]; }
      a[i] = cur; a2[i] = prev;
    }
  };
  fill(hs, high, high2); fill(ls, low, low2);
  return { high, low, high2, low2 };
}

// VWAP anchored at the latest confirmed swing high and at the latest swing low, from
// the swing's own bar, shown from when the swing is confirmed.
export function swingVwap(b, { left = 10, right = 10 } = {}) {
  const n = b.close.length, pv = new Float64Array(n + 1), vv = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    pv[i + 1] = pv[i] + ((b.high[i] + b.low[i] + b.close[i]) / 3) * b.volume[i];
    vv[i + 1] = vv[i] + b.volume[i];
  }
  const up = nanArr(n), dn = nanArr(n), hs = [], ls = [];
  pivots(b, left, right, (j, c) => hs.push([c, j]), (j, c) => ls.push([c, j]));
  const fill = (ev, a) => {
    let k = 0, from = -1;
    for (let i = 0; i < n; i++) {
      while (k < ev.length && ev[k][0] <= i) from = ev[k++][1];
      if (from < 0) continue;
      const v = vv[i + 1] - vv[from];
      if (v > 0) a[i] = (pv[i + 1] - pv[from]) / v;
    }
  };
  fill(hs, up); fill(ls, dn);
  return { up, dn };
}

// The midpoint of the latest bar whose volume reached `mult` times the average of the
// `length` bars before it, held until the next such bar.
export function volumeShelf(b, { length = 60, mult = 4 } = {}) {
  const n = b.close.length, out = nanArr(n);
  let sum = 0, cur = NaN;
  for (let i = 0; i < n; i++) {
    if (i >= length && b.volume[i] >= (mult * sum) / length) cur = (b.high[i] + b.low[i]) / 2;
    out[i] = cur;
    sum += b.volume[i];
    if (i >= length) sum -= b.volume[i - length];
  }
  return out;
}
