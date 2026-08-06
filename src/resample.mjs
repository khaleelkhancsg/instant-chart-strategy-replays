// Timeframe resampling. ISOMORPHIC.
//
// Bars are grouped CLOCK-ALIGNED (…:00, :05, :10 for 5-minute) rather than in
// fixed chunks of N by index. This matters: index chunking drifts out of phase
// after every weekend/holiday gap, so a backtest built that way can never be
// reproduced by a live bot, which necessarily builds clock-aligned bars.
//
// Each output bar carries `srcFirst` / `srcLast`: the 1-minute indices it was
// built from. The chart needs those to place a trade that was decided on a
// 5-minute bar back onto the 1-minute price axis.

export function resample(bars, tfMin) {
  const tf = Math.max(1, Math.trunc(tfMin));
  const n = bars.close.length;
  if (tf === 1) {
    const srcFirst = new Int32Array(n), srcLast = new Int32Array(n);
    for (let i = 0; i < n; i++) { srcFirst[i] = i; srcLast[i] = i; }
    return { ...bars, srcFirst, srcLast, tfMin: 1 };
  }

  const bucketMs = tf * 60000;
  // Upper bound on bucket count; trimmed to the real count at the end.
  const cap = n;
  const ts = new Float64Array(cap), open = new Float32Array(cap);
  const high = new Float32Array(cap), low = new Float32Array(cap);
  const close = new Float32Array(cap), volume = new Float32Array(cap);
  const tday = new Int32Array(cap);
  const srcFirst = new Int32Array(cap), srcLast = new Int32Array(cap);

  let m = -1, curBucket = NaN;
  for (let i = 0; i < n; i++) {
    const b = Math.floor(bars.ts[i] / bucketMs);
    if (b !== curBucket) {
      curBucket = b;
      m++;
      ts[m] = b * bucketMs;
      open[m] = bars.open[i];
      high[m] = bars.high[i];
      low[m] = bars.low[i];
      volume[m] = 0;
      srcFirst[m] = i;
    }
    if (bars.high[i] > high[m]) high[m] = bars.high[i];
    if (bars.low[i] < low[m]) low[m] = bars.low[i];
    close[m] = bars.close[i];
    volume[m] += bars.volume[i];
    tday[m] = bars.tday[i];
    srcLast[m] = i;
  }
  const count = m + 1;

  return {
    ts: ts.subarray(0, count),
    open: open.subarray(0, count),
    high: high.subarray(0, count),
    low: low.subarray(0, count),
    close: close.subarray(0, count),
    volume: volume.subarray(0, count),
    tday: tday.subarray(0, count),
    srcFirst: srcFirst.subarray(0, count),
    srcLast: srcLast.subarray(0, count),
    tfMin: tf,
  };
}

// Slice a bar set by index range, keeping the same shape.
export function sliceBars(bars, s, e) {
  const out = {
    ts: bars.ts.subarray(s, e),
    open: bars.open.subarray(s, e),
    high: bars.high.subarray(s, e),
    low: bars.low.subarray(s, e),
    close: bars.close.subarray(s, e),
    volume: bars.volume.subarray(s, e),
    tday: bars.tday.subarray(s, e),
  };
  if (bars.srcFirst) { out.srcFirst = bars.srcFirst.subarray(s, e); out.srcLast = bars.srcLast.subarray(s, e); }
  if (bars.tfMin) out.tfMin = bars.tfMin;
  return out;
}

// First index with ts >= target (binary search over a sorted ts array).
export function indexAtOrAfter(ts, target) {
  let lo = 0, hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ts[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Last index with ts <= target, or -1.
export function indexAtOrBefore(ts, target) {
  const i = indexAtOrAfter(ts, target);
  if (i < ts.length && ts[i] === target) return i;
  return i - 1;
}
