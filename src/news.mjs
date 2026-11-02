// Red-folder news: the US releases ForexFactory marks high impact, at the times the agencies
// published them. ISOMORPHIC. The calendar is src/news_calendar.mjs, built from the official
// schedules by research/news_build.mjs.
//
// Each release is a minute in UTC. A rule stands aside from `before` minutes ahead of it to
// `after` minutes past it; a bar that overlaps that window at all is inside it, so on a 5-minute
// chart the 8:25 bar is already inside a 3-minute window ahead of an 8:30 release. That is the
// cautious reading: a live bot acting at the open of that bar would do the same.

import { RED_FOLDER } from "./news_calendar.mjs";

export const NEWS_KINDS = {
  NFP: { label: "Jobs report (NFP)", short: "NFP" },
  CPI: { label: "CPI", short: "CPI" },
  PPI: { label: "PPI", short: "PPI" },
  RETAIL: { label: "Retail sales", short: "Retail" },
  GDP: { label: "GDP, advance estimate", short: "GDP" },
  PCE: { label: "PCE (personal income and outlays)", short: "PCE" },
  FOMC: { label: "FOMC decision", short: "FOMC" },
  PRESSER: { label: "FOMC press conference", short: "Presser" },
  MINUTES: { label: "FOMC minutes", short: "Minutes" },
};
export const NEWS_FROM = RED_FOLDER[0][0], NEWS_TO = RED_FOLDER[RED_FOLDER.length - 1][0];

// The first release at or after t.
export function newsIndexAt(t) {
  let lo = 0, hi = RED_FOLDER.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (RED_FOLDER[m][0] < t) lo = m + 1; else hi = m; }
  return lo;
}
// Releases in [t0, t1), as { t, kind }.
export function newsBetween(t0, t1) {
  const out = [];
  for (let k = newsIndexAt(t0); k < RED_FOLDER.length && RED_FOLDER[k][0] < t1; k++) out.push({ t: RED_FOLDER[k][0], kind: RED_FOLDER[k][1] });
  return out;
}

// 1 for each bar that overlaps [release - before, release + after) of any release, else 0.
// bars.ts are bar opens; a bar spans bars.tfMin minutes (1 when absent). `events` is the
// calendar unless a study passes its own, as the placebo calendars of research/news_1250.mjs do.
export function newsWindowMask(bars, beforeMin, afterMin, events = RED_FOLDER) {
  const ts = bars.ts, n = ts.length, mask = new Uint8Array(n);
  const span = (bars.tfMin || 1) * 60000, before = Math.max(0, +beforeMin || 0) * 60000, after = Math.max(0, +afterMin || 0) * 60000;
  if (!n || before + after <= 0) return mask;
  const lower = (x) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < x) lo = m + 1; else hi = m; } return lo; };
  const first = events === RED_FOLDER ? newsIndexAt(ts[0] - after) : 0;
  for (let k = first; k < events.length; k++) {
    const t = events[k][0], from = t - before, to = t + after;
    if (to <= ts[0]) continue;
    if (from > ts[n - 1] + span) break;
    // A bar [ts, ts + span) overlaps [from, to) when ts < to and ts + span > from.
    for (let i = lower(from - span + 1); i < n && ts[i] < to; i++) mask[i] = 1;
  }
  return mask;
}
