// Volume profiles as Cammy Capital draws them, for a strategy. ISOMORPHIC.
//
// The arithmetic of TradingCustomIndicators/tradovate/cammyValueLevels.js, the
// Tradovate indicator that draws the same levels: each bar's volume spread evenly
// across its high-low range, rows 1/1000 of a profile's range but never finer than a
// tick, the POC the row with the most volume (the middle of the lowest run of exact
// ties), the value area grown from it a row at a time toward the larger neighbour (up
// on a tie) until it holds 70%. test.mjs holds the strategy's levels to the indicator's.

export const VALUE_AREA = 0.7;

// A profile over ticks: a dense histogram that grows when price reaches a new tick.
export class Profile {
  constructor() { this.base = 0; this.v = null; this.lo = Infinity; this.hi = -Infinity; this.first = null; }
  add(loT, hiT, vol) {
    if (!(vol > 0)) return;
    if (!this.v) { this.base = loT - 64; this.v = new Float64Array(hiT - loT + 129); }
    if (loT < this.base || hiT >= this.base + this.v.length) {
      const lo = Math.min(loT, this.base) - 256, hi = Math.max(hiT + 1, this.base + this.v.length) + 256;
      const v = new Float64Array(hi - lo);
      v.set(this.v, this.base - lo);
      this.v = v; this.base = lo;
    }
    const w = vol / (hiT - loT + 1), v = this.v, b = this.base;
    for (let k = loT; k <= hiT; k++) v[k - b] += w;
    if (loT < this.lo) this.lo = loT;
    if (hiT > this.hi) this.hi = hiT;
  }
}

let scratch = new Float64Array(4096);

// The levels of the profile made of `list` (Profiles, summed), in ticks, or null.
// `rows`: TradingView's row count (0 = one row a tick). `out` receives the result.
export function levels(list, rows, out = {}) {
  let loT = Infinity, hiT = -Infinity;
  for (const p of list) {
    if (!p || !p.v) continue;
    // ticks a bar reached carry volume; a profile's lo/hi are its extremes
    if (p.lo < loT) loT = p.lo;
    if (p.hi > hiT) hiT = p.hi;
  }
  if (!(hiT >= loT)) return null;
  const span = hiT - loT + 1;
  const per = rows > 0 ? Math.max(1, span / rows) : 1;
  const n = Math.max(1, Math.ceil(span / per - 1e-9));
  let vol, total = 0;
  const single = list.filter((p) => p && p.v);
  if (single.length === 1 && per === 1) {
    // one profile, a row a tick: its own histogram, read in place
    const p = single[0];
    vol = p.v.subarray(loT - p.base, hiT - p.base + 1);
    for (let k = 0; k < n; k++) { const x = vol[k]; if (x > 1e-9) total += x; }
  } else {
    if (scratch.length < n) scratch = new Float64Array(n * 2);
    vol = scratch;
    vol.fill(0, 0, n);
    for (const p of single) {
      const v = p.v, b = p.base;
      for (let k = p.lo; k <= p.hi; k++) {
        const x = v[k - b];
        if (!(x > 1e-9)) continue;
        total += x;
        vol[per === 1 ? k - loT : Math.min(n - 1, Math.floor((k - loT) / per + 1e-9))] += x;
      }
    }
  }
  if (!(total > 0)) return null;
  let poc = 0;
  for (let r = 1; r < n; r++) if (vol[r] > vol[poc]) poc = r;
  let run = poc;
  while (run + 1 < n && vol[run + 1] === vol[poc]) run++;
  poc = (poc + run) >> 1;
  let a = poc, b = poc, acc = vol[poc];
  while (acc < VALUE_AREA * total - 1e-9 && (a > 0 || b < n - 1)) {
    const up = b < n - 1 ? vol[b + 1] : -1, dn = a > 0 ? vol[a - 1] : -1;
    if (up >= dn) acc += vol[++b];
    else acc += vol[--a];
  }
  const bottom = (r) => loT + Math.ceil(r * per - 1e-9), top = (r) => loT + Math.ceil((r + 1) * per - 1e-9) - 1;
  out.loT = loT; out.hiT = hiT; out.per = per; out.n = n; out.poc = poc; out.a = a; out.b = b; out.total = total;
  out.vahT = top(b); out.valT = bottom(a); out.pocT = Math.round((bottom(poc) + top(poc)) / 2);
  out.vol = vol;                    // the rows: valid until the next call
  return out;
}

// Whether the developing profile is balanced, as Cammy reads a D shape: its POC in the
// middle third of its range, and its value area across at least `pct`% of it.
export function balanced(L, pct) {
  if (!L || L.n < 3) return false;
  return L.poc >= L.n / 3 && L.poc <= (2 * L.n) / 3 && (L.b - L.a + 1) >= (pct / 100) * L.n;
}
