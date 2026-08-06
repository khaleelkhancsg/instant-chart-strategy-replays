// Indicator library. ISOMORPHIC — no Node imports, so the browser loads this
// exact file and gets bit-identical numbers to the server.
//
// Smoothing convention: standard EMA, alpha = 2/(n+1), seeded with x[0].
// NOT Wilder's alpha = 1/n. Every strategy tuned in this project assumes EMA;
// swapping in Wilder silently changes every signal, so don't "fix" it.

export function ema(arr, span) {
  const n = arr.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const a = 2 / (span + 1), b = 1 - a;
  out[0] = arr[0];
  for (let i = 1; i < n; i++) out[i] = a * arr[i] + b * out[i - 1];
  return out;
}

export function sma(arr, p) {
  const n = arr.length;
  const out = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += arr[i];
    if (i >= p) sum -= arr[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

export function trueRange(H, L, C) {
  const n = C.length;
  const tr = new Float64Array(n);
  if (n === 0) return tr;
  tr[0] = H[0] - L[0];
  for (let i = 1; i < n; i++) {
    const pc = C[i - 1];
    const a = H[i] - L[i];
    const b = Math.abs(H[i] - pc);
    const c = Math.abs(L[i] - pc);
    tr[i] = a > b ? (a > c ? a : c) : (b > c ? b : c);
  }
  return tr;
}

export function atr(H, L, C, p = 14) {
  return ema(trueRange(H, L, C), p);
}

export function adx(H, L, C, p = 14) {
  const n = C.length;
  const tr = new Float64Array(n), pdm = new Float64Array(n), ndm = new Float64Array(n);
  if (n === 0) return { adx: new Float64Array(0), pdi: new Float64Array(0), ndi: new Float64Array(0) };
  tr[0] = H[0] - L[0];
  for (let i = 1; i < n; i++) {
    const pc = C[i - 1];
    tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - pc), Math.abs(L[i] - pc));
    const up = H[i] - H[i - 1], dn = L[i - 1] - L[i];
    pdm[i] = up > dn && up > 0 ? up : 0;
    ndm[i] = dn > up && dn > 0 ? dn : 0;
  }
  const atrE = ema(tr, p), pdiE = ema(pdm, p), ndiE = ema(ndm, p);
  const pdi = new Float64Array(n), ndi = new Float64Array(n), dx = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = atrE[i];
    pdi[i] = a === 0 ? 0 : (100 * pdiE[i]) / a;
    ndi[i] = a === 0 ? 0 : (100 * ndiE[i]) / a;
    const s = pdi[i] + ndi[i];
    dx[i] = s === 0 ? 0 : (100 * Math.abs(pdi[i] - ndi[i])) / s;
  }
  return { adx: ema(dx, p), pdi, ndi };
}

export function rsi(C, p = 14) {
  const n = C.length;
  const up = new Float64Array(n), dn = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const d = C[i] - C[i - 1];
    if (d > 0) up[i] = d; else dn[i] = -d;
  }
  const eu = ema(up, p * 2 - 1), ed = ema(dn, p * 2 - 1);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Zero average loss is the degenerate case. Substituting rs = 100 (as the
    // original engine did) yields 99.01 on an unbroken uptrend instead of the
    // correct 100 — small, but it silently caps the indicator below its own
    // range and would skew any "RSI > 99" style condition.
    if (ed[i] === 0) { out[i] = eu[i] === 0 ? 50 : 100; continue; }
    const rs = eu[i] / ed[i];
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

// Donchian channel over the `p` bars BEFORE i (exclusive of the current bar).
// Implemented with monotonic deques so it stays O(n) — a naive rescan is O(n*p)
// and is the difference between a 3ms and a 400ms re-run when a slider moves.
export function donchian(H, L, p) {
  const n = H.length;
  const hh = new Float64Array(n).fill(NaN);
  const ll = new Float64Array(n).fill(NaN);
  const qh = new Int32Array(n), ql = new Int32Array(n);
  let hs = 0, he = 0, ls = 0, le = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const j = i - 1;
      while (he > hs && H[qh[he - 1]] <= H[j]) he--;
      qh[he++] = j;
      while (le > ls && L[ql[le - 1]] >= L[j]) le--;
      ql[le++] = j;
      while (qh[hs] < i - p) hs++;
      while (ql[ls] < i - p) ls++;
    }
    if (i >= p) { hh[i] = H[qh[hs]]; ll[i] = L[ql[ls]]; }
  }
  return { high: hh, low: ll };
}

// Rolling mean/std (sample, ddof=1) over a trailing window of length p.
export function rollingMeanStd(arr, p) {
  const n = arr.length;
  const mean = new Float64Array(n).fill(NaN);
  const std = new Float64Array(n).fill(NaN);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += arr[i]; sumSq += arr[i] * arr[i];
    if (i >= p) { sum -= arr[i - p]; sumSq -= arr[i - p] * arr[i - p]; }
    if (i >= p - 1) {
      const m = sum / p;
      mean[i] = m;
      std[i] = Math.sqrt(Math.max(0, (sumSq - p * m * m) / (p - 1)));
    }
  }
  return { mean, std };
}

// Z-score of close vs its own trailing window.
export function zscore(C, p) {
  const { mean, std } = rollingMeanStd(C, p);
  const out = new Float64Array(C.length).fill(NaN);
  for (let i = 0; i < C.length; i++) {
    if (std[i] > 0) out[i] = (C[i] - mean[i]) / std[i];
  }
  return out;
}

// Session VWAP, resetting whenever `dayIdx` changes.
export function vwap(H, L, C, V, dayIdx) {
  const n = C.length;
  const out = new Float64Array(n);
  let ct = 0, cv = 0, prev = -1;
  for (let i = 0; i < n; i++) {
    if (dayIdx[i] !== prev) { ct = 0; cv = 0; prev = dayIdx[i]; }
    const tp = (H[i] + L[i] + C[i]) / 3;
    ct += tp * V[i]; cv += V[i];
    out[i] = cv === 0 ? tp : ct / cv;
  }
  return out;
}

export function macd(C, fast = 12, slow = 26, signal = 9) {
  const ef = ema(C, fast), es = ema(C, slow);
  const line = new Float64Array(C.length);
  for (let i = 0; i < C.length; i++) line[i] = ef[i] - es[i];
  const sig = ema(line, signal);
  const hist = new Float64Array(C.length);
  for (let i = 0; i < C.length; i++) hist[i] = line[i] - sig[i];
  return { line, signal: sig, hist };
}

export function bollinger(C, p = 20, mult = 2) {
  const { mean, std } = rollingMeanStd(C, p);
  const upper = new Float64Array(C.length).fill(NaN);
  const lower = new Float64Array(C.length).fill(NaN);
  for (let i = 0; i < C.length; i++) {
    upper[i] = mean[i] + mult * std[i];
    lower[i] = mean[i] - mult * std[i];
  }
  return { mid: mean, upper, lower, std };
}
