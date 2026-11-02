// Does the market agree with the red-folder calendar? NODE-ONLY.
//   node --max-old-space-size=8192 research/news_check.mjs
//
// A release that really came out at its listed minute leaves a mark: MNQ's range over the five
// minutes from it is far above that clock-minute's usual range. Each release is measured against
// the median of the same five minutes on the 20 trading days before it that had no release then,
// and the same test on the day before each release (no release) shows what chance looks like. A
// listed time that is wrong shows up as a release with no mark, at the bottom of its kind.
//
// RESULT (2026-11-02, bars to 2026-10-30). Median ratio, and share at 2x or more; the day before in ():
//   NFP 5.3 97% (1.6 36%)   CPI 6.7 85% (0.9 10%)    PPI 3.0 74% (1.0 8%)    Retail 2.5 59% (1.0 17%)
//   GDP 2.8 66% (1.0 10%)   PCE 2.5 56% (1.8 41%)    FOMC 4.8 92% (1.1 7%)   Presser 2.7 81% (1.0 5%)
//   Minutes 2.1 58% (1.0 11%)                         all 647: 3.16 75% (1.11 18%)
// The weakest have reasons: Mar 12 2020's PPI came out with MNQ locked limit-down (0.0x), and the
// November 2020 election week had ranges so wide that a release barely stood out. The day before
// NFP and PCE reads high because it is mostly a Thursday, when weekly jobless claims, orange and so
// not in this calendar, come out at the same 8:30.

import { loadBars } from "../src/data.mjs";
import { RED_FOLDER } from "../src/news_calendar.mjs";
import { NEWS_KINDS } from "../src/news.mjs";

const MIN = 60000, SPAN = 5, LOOKBACK = 20;
const sets = [loadBars().bars, loadBars("data/mnq_1m_beta.bin").bars];
const main = sets[0], beta = sets[1], mainEnd = main.ts[main.count - 1];

function lowerBound(a, n, x) { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
// The range over [t, t + SPAN minutes), or NaN where the bars do not cover it.
function rangeAt(b, t) {
  const i = lowerBound(b.ts, b.count, t);
  if (i >= b.count || b.ts[i] !== t) return NaN;
  let hi = -Infinity, lo = Infinity;
  for (let j = i; j < b.count && b.ts[j] < t + SPAN * MIN; j++) { if (b.high[j] > hi) hi = b.high[j]; if (b.low[j] < lo) lo = b.low[j]; }
  return hi - lo;
}
const eventMinutes = new Set(RED_FOLDER.map(([t]) => t));

// The same clock minute on earlier trading days: 24 hours apart, skipping days with no bar there.
function baseline(b, t) {
  const xs = [];
  for (let d = 1; xs.length < LOOKBACK && d < 60; d++) {
    const u = t - d * 86400000;
    if (eventMinutes.has(u)) continue;
    const r = rangeAt(b, u);
    if (Number.isFinite(r)) xs.push(r);
  }
  if (xs.length < LOOKBACK / 2) return NaN;
  xs.sort((a, c) => a - c);
  return xs[xs.length >> 1];
}

const rows = {};
for (const [t, kind] of RED_FOLDER) {
  const b = t <= mainEnd ? main : beta;
  if (t < b.ts[0] + 40 * 86400000 || t > beta.ts[beta.count - 1]) continue;
  const r = rangeAt(b, t), base = baseline(b, t);
  // the day before: no release (skip if it had one at that minute)
  const p = t - 86400000, pr = eventMinutes.has(p) ? NaN : rangeAt(b, p), pbase = baseline(b, p);
  (rows[kind] ||= []).push({ t, ratio: r / base, placebo: pr / pbase });
}

const q = (xs, f) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN; };
const pct = (xs, f) => { const s = xs.filter(Number.isFinite); return s.length ? (100 * s.filter(f).length) / s.length : NaN; };
console.log(`Range over the ${SPAN} minutes from each release, against the median of the same minutes on the ${LOOKBACK} trading days before`);
console.log(`kind       n   median   25th   share >= 2x | day before: median, share >= 2x | the five weakest`);
for (const kind of Object.keys(NEWS_KINDS)) {
  const r = rows[kind] || [], ratios = r.map((x) => x.ratio), pl = r.map((x) => x.placebo);
  const weakest = r.filter((x) => Number.isFinite(x.ratio)).sort((a, b) => a.ratio - b.ratio).slice(0, 5)
    .map((x) => `${new Date(x.t).toISOString().slice(0, 16)} ${x.ratio.toFixed(1)}`).join(", ");
  console.log(`${kind.padEnd(8)} ${String(r.length).padStart(4)}   ${q(ratios, 0.5).toFixed(2).padStart(5)}  ${q(ratios, 0.25).toFixed(2).padStart(5)}    ${pct(ratios, (x) => x >= 2).toFixed(0).padStart(3)}%     |      ${q(pl, 0.5).toFixed(2)}   ${pct(pl, (x) => x >= 2).toFixed(0).padStart(3)}%          | ${weakest}`);
}
const all = Object.values(rows).flat();
console.log(`\nall      ${all.length}   median ${q(all.map((x) => x.ratio), 0.5).toFixed(2)}, ${pct(all.map((x) => x.ratio), (x) => x >= 2).toFixed(0)}% at 2x or more;   the day before: median ${q(all.map((x) => x.placebo), 0.5).toFixed(2)}, ${pct(all.map((x) => x.placebo), (x) => x >= 2).toFixed(0)}%`);
