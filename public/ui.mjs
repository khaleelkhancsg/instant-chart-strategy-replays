// The page's arithmetic, with no DOM in it, so test/ui.test.mjs can run it in Node.

// ── Chicago's clock ──────────────────────────────────────────────────────
// A bar's ctMin is already its minute of the day in Chicago, DST included
// (prepare.mjs). How far that sits from the UTC clock is the offset that day, and
// the offset gives the date, with no time-zone table in the page.
export function ctWall(ms, ctMin) {
  let off = ctMin - (Math.floor(ms / 60000) % 1440);
  if (off > 720) off -= 1440;
  else if (off < -720) off += 1440;
  return new Date(ms + off * 60000);    // read it with the getUTC* methods
}
const p2 = (x) => String(x).padStart(2, "0");
export function fmtCt(ms, ctMin) {
  const d = ctWall(ms, ctMin);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

// ── sorted arrays ────────────────────────────────────────────────────────
// First index holding a value >= v, and first holding a value > v.
export function lowerBound(xs, v) {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (xs[m] < v) lo = m + 1; else hi = m; }
  return lo;
}
export function upperBound(xs, v) {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (xs[m] <= v) lo = m + 1; else hi = m; }
  return lo;
}

// The k-th smallest value (from 0), reordering `a` as it goes. The same number a
// sort gives, in linear time: a chart scale is worked out on every frame of a pan.
export function nthSmallest(a, k) {
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >>> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}

// ── the house numbers ────────────────────────────────────────────────────
// Results are judged on 2026, and 2026 is split in two so a result has to hold in
// both halves.
export const Y2026 = Date.UTC(2026, 0, 1), APR_2026 = Date.UTC(2026, 3, 1);

// An approximate 95% interval for a pass rate (Wilson), in percent. Neighbouring
// windows share all but a day of their days, so the honest sample is about one
// window per windowDays -- which is why these are wide, and should be.
export function wilson(p, nEff) {
  if (!(nEff > 0)) return null;
  const z2 = 1.96 * 1.96, d = 1 + z2 / nEff;
  const c = (p + z2 / (2 * nEff)) / d, h = (1.96 * Math.sqrt((p * (1 - p)) / nEff + z2 / (4 * nEff * nEff))) / d;
  return [Math.max(0, c - h) * 100, Math.min(1, c + h) * 100];
}

// How the windows starting in [lo, hi) came out.
export function rateOver(windows, lo, hi, windowDays) {
  let n = 0, pass = 0, fail = 0;
  for (const w of windows) {
    if (w.startMs < lo || w.startMs >= hi) continue;
    n++;
    if (w.outcome === "PASS") pass++;
    else if (w.outcome === "FAIL") fail++;
  }
  if (!n) return null;
  return { n, pass, fail, rate: (pass / n) * 100, failRate: (fail / n) * 100, openRate: ((n - pass - fail) / n) * 100, ci: wilson(pass / n, n / windowDays) };
}

export const houseRates = (windows, windowDays) => ({
  y2026: rateOver(windows, Y2026, Infinity, windowDays),
  q1: rateOver(windows, Y2026, APR_2026, windowDays),
  q2: rateOver(windows, APR_2026, Infinity, windowDays),
});
