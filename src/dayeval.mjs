// Day-sequence evaluation. ISOMORPHIC.
//
// The second of the project's two pass-rate methods, kept in one place. The
// first, replayWindow in challenge.mjs, replays a trade list over a real
// calendar window with the full rule set. This one judges a run of trading
// DAYS by their net P&L -- target, trailing drawdown that locks at breakeven
// once the peak reaches it, and the consistency rule -- and estimates a pass
// rate by drawing many 21-day runs from a day vector, in blocks of consecutive
// days so short streaks survive the shuffle (a block bootstrap). The daily rules
// (day-loss cap, breaker, profit block) are not here: they act on trades, so the
// engine applies them before the days are summed.
//
// What the two methods measure differs. Calendar windows are the history as it
// happened, each start one sample, heavily overlapping. The bootstrap asks what
// a random month built from these days would do, which is smoother but treats
// blocks as exchangeable. The research numbers quoted for the live Donchian and
// MACD books (research/lib_shipped.mjs, lib_combo.mjs) are this method; the
// chart and its sweep are the other. Quote which one a number came from.

// Mulberry32: small, fast and seeded, so a pass rate reproduces exactly.
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One run of days: 1 if it reaches the target before breaching, else 0. The
// drawdown floor trails the peak by `dd` until the peak first reaches `dd`, then
// sits at breakeven for good; a pass also needs the best day within
// `consistency` of the total (0 = no consistency rule).
export function evalDays(days, { target = 3000, dd = 2000, consistency = 0.5 } = {}) {
  let c = 0, pk = 0, lk = false, md = -1e18;
  for (const v of days) {
    c += v; if (v > md) md = v;
    if (c <= (lk ? 0 : pk - dd)) return 0;
    if (c > pk) pk = c;
    if (!lk && pk >= dd) lk = true;
    if (c >= target && (consistency <= 0 || md <= consistency * c)) return 1;
  }
  return 0;
}

// Net P&L per trading day, in `keys` order (days without trades are 0).
// clampLoss > 0 floors the running day total at -clampLoss after every trade,
// the way research/lib_orb.mjs modelled the daily loss limit.
export function dayVector(trades, keys, { clampLoss = 0 } = {}) {
  const m = new Map();
  for (const d of keys) m.set(d, 0);
  for (const t of trades) {
    if (!m.has(t.tday)) continue;
    const v = m.get(t.tday) + t.pnl;
    m.set(t.tday, clampLoss > 0 ? Math.max(-clampLoss, v) : v);
  }
  return keys.map((k) => m.get(k));
}

// The draws: `draws` runs of `window` day indices, each built from blocks of
// `block` consecutive days (wrapping) at uniformly random starts.
export function blockSampler(len, { draws = 12000, seed = 4242, window = 21, block = 5 } = {}) {
  const rnd = mulberry32(seed), idx = new Int32Array(draws * window);
  let p = 0;
  for (let d = 0; d < draws; d++) {
    let mm = 0;
    while (mm < window) {
      const st = Math.floor(rnd() * Math.max(1, len - block));
      for (let j = 0; j < block && mm < window; j++) { idx[p++] = (st + j) % len; mm++; }
    }
  }
  return { idx, window, draws };
}

// Every run of `window` consecutive days: a real start on each trading day.
export function consecutiveSampler(len, window = 21) {
  const out = [];
  for (let q = 0; q + window <= len; q++) for (let k = 0; k < window; k++) out.push(q + k);
  return { idx: Int32Array.from(out), window, draws: out.length / window };
}

// Pass rate (%) of the day vector `vec`, read through `sub` (the subset of day
// indices being scored, e.g. 2026 only), over a sampler's draws.
export function passRate(vec, sub, smp, { target, dd, consistency: cons }) {
  const { idx, window, draws } = smp;
  let w = 0;
  for (let d = 0, p = 0; d < draws; d++, p += window) {
    let c = 0, pk = 0, lk = false, md = -1e18;
    for (let k = 0; k < window; k++) {
      const v = vec[sub[idx[p + k]]];
      c += v; if (v > md) md = v;
      if (c <= (lk ? 0 : pk - dd)) break;
      if (c > pk) pk = c;
      if (!lk && pk >= dd) lk = true;
      if (c >= target && (cons <= 0 || md <= cons * c)) { w++; break; }
    }
  }
  return (100 * w) / draws;
}

// The same, but each day takes `pV` or `dV` as `useP(cum, peak, room)` decides
// from the account's state that morning.
export function passRatePolicy(dV, pV, sub, smp, { target, dd, consistency: cons }, useP) {
  const { idx, window, draws } = smp;
  let w = 0;
  for (let d = 0, p = 0; d < draws; d++, p += window) {
    let c = 0, pk = 0, lk = false, md = -1e18;
    for (let k = 0; k < window; k++) {
      const q = sub[idx[p + k]], v = useP(c, pk, c - (lk ? 0 : pk - dd)) ? pV[q] : dV[q];
      c += v; if (v > md) md = v;
      if (c <= (lk ? 0 : pk - dd)) break;
      if (c > pk) pk = c;
      if (!lk && pk >= dd) lk = true;
      if (c >= target && (cons <= 0 || md <= cons * c)) { w++; break; }
    }
  }
  return (100 * w) / draws;
}

// Block-bootstrap pass rate (%) of a whole day vector: the common case.
export function bootstrapPass(arr, { draws = 12000, seed = 4242, window = 21, block = 5, target = 3000, dd = 2000, consistency = 0.5 } = {}) {
  const sub = new Int32Array(arr.length);
  for (let i = 0; i < arr.length; i++) sub[i] = i;
  return passRate(arr, sub, blockSampler(arr.length, { draws, seed, window, block }), { target, dd, consistency });
}
