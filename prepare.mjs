// One-time preprocessor: 1-minute OHLCV CSV -> packed binary cache.
//
// The source file is ~317MB / ~2.87M rows. Parsing it as text on every server
// start costs ~12s and a lot of GC pressure, so we do it once here and write a
// flat typed-array blob the server can mmap-ish read in well under a second.
//
// What happens on the way through:
//   1. Rows are parsed straight out of the Buffer (no giant intermediate string,
//      no per-row objects) into preallocated typed arrays.
//   2. Calendar-spread rows (e.g. "MNQU1-MNQZ1") are dropped.
//   3. The dominant contract per UTC day is chosen by volume; only its rows are
//      kept, deduped by timestamp. That gives a single continuous front-month.
//   4. Panama Canal (additive) back-adjustment removes the price jump at each
//      quarterly rollover, so indicators never see a fake 120pt gap.
//   5. The CME trading-day index (17:00 America/New_York boundary, DST-aware)
//      is precomputed per bar, because doing it live via Intl is far too slow to
//      run inside a rules replay.
//
// Usage:  node prepare.mjs [--in <csv>] [--out <bin>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Databento delivers MNQ history in overlapping batches. Listing several here
// merges them into one continuous series; overlapping rows are deduplicated on
// (timestamp, symbol). Verified byte-identical where these two overlap, so
// either copy of a shared row is equally valid.
const DEFAULT_IN = [
  "C:\\Users\\khale\\Desktop\\Backtesting\\MNQ CSV\\glbx-mdp3-20100606-20260323.ohlcv-1m.csv",
  "C:\\Users\\khale\\Desktop\\Backtesting\\MNQ CSV\\glbx-mdp3-20210715-20260714.ohlcv-1m.csv",
];
const DEFAULT_OUT = path.join(HERE, "data", "mnq_1m.bin");

// ─────────────────────────── byte-level parsing ───────────────────────────
// Parsing from the Buffer directly rather than via .toString() keeps ~2.87M
// short-lived strings off the heap; this is the single biggest speed win here.

const CH_COMMA = 44, CH_NL = 10, CH_CR = 13, CH_DOT = 46, CH_MINUS = 45;

function parseNum(buf, s, e) {
  let i = s, neg = false;
  if (i < e && buf[i] === CH_MINUS) { neg = true; i++; }
  let v = 0;
  for (; i < e; i++) {
    const c = buf[i];
    if (c === CH_DOT) { i++; break; }
    if (c < 48 || c > 57) return neg ? -v : v;
    v = v * 10 + (c - 48);
  }
  let f = 0, scale = 1;
  for (; i < e; i++) {
    const c = buf[i];
    if (c < 48 || c > 57) break;
    f = f * 10 + (c - 48);
    scale *= 10;
  }
  if (scale > 1) v += f / scale;
  return neg ? -v : v;
}

const d2 = (b, i) => (b[i] - 48) * 10 + (b[i + 1] - 48);
const d4 = (b, i) => (b[i] - 48) * 1000 + (b[i + 1] - 48) * 100 + (b[i + 2] - 48) * 10 + (b[i + 3] - 48);

// Databento emits fixed-width RFC3339 ("2021-07-15T00:00:00.000000000Z"), so the
// fast path reads digits at known offsets. Anything else falls back to Date.parse
// so a differently-formatted CSV still loads (just slower).
function parseTs(buf, s, e) {
  if (e - s >= 19 && buf[s + 4] === CH_MINUS && buf[s + 7] === CH_MINUS &&
      (buf[s + 10] === 84 || buf[s + 10] === 32) && buf[s + 13] === 58) {
    return Date.UTC(d4(buf, s), d2(buf, s + 5) - 1, d2(buf, s + 8),
                    d2(buf, s + 11), d2(buf, s + 14), d2(buf, s + 17));
  }
  const t = Date.parse(buf.toString("latin1", s, e));
  return Number.isNaN(t) ? NaN : t;
}

// Symbol interning without allocating a string per row. Symbols arrive in runs
// and there are only ~40 distinct ones across 5 years, so a move-to-front byte
// compare beats both a Map<string> and a hash.
class SymbolTable {
  constructor() { this.bytes = []; this.names = []; this.order = []; }
  intern(buf, s, e) {
    const len = e - s;
    for (let oi = 0; oi < this.order.length; oi++) {
      const id = this.order[oi];
      const b = this.bytes[id];
      if (b.length !== len) continue;
      let match = true;
      for (let k = 0; k < len; k++) if (b[k] !== buf[s + k]) { match = false; break; }
      if (match) {
        if (oi > 0) { this.order.splice(oi, 1); this.order.unshift(id); }
        return id;
      }
    }
    const id = this.names.length;
    this.bytes.push(Uint8Array.prototype.slice.call(buf, s, e));
    this.names.push(buf.toString("latin1", s, e));
    this.order.unshift(id);
    return id;
  }
}

// ─────────────────────────── NY trading-day index ───────────────────────────
// A CME session runs 17:00 ET -> 17:00 ET, and 17:00 ET is 21:00 UTC in summer
// but 22:00 UTC in winter. Rather than call Intl 1.77M times we call it once per
// distinct UTC hour (~30k times) and reuse the result within the hour.

const NY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
});

function nyTradingDay(ms, resetHour = 17) {
  let Y = 0, M = 0, D = 0, H = 0;
  for (const p of NY_FMT.formatToParts(ms)) {
    if (p.type === "year") Y = +p.value;
    else if (p.type === "month") M = +p.value;
    else if (p.type === "day") D = +p.value;
    else if (p.type === "hour") H = +p.value;
  }
  if (H === 24) H = 0;
  let day = Math.floor(Date.UTC(Y, M - 1, D) / 86400000);
  if (H >= resetHour) day += 1;
  return day;
}

function buildTradingDays(ts, n) {
  const out = new Int32Array(n);
  let lastHour = -1, lastDay = 0;
  for (let i = 0; i < n; i++) {
    const hr = Math.floor(ts[i] / 3600000);
    if (hr !== lastHour) { lastHour = hr; lastDay = nyTradingDay(ts[i]); }
    out[i] = lastDay;
  }
  return out;
}

// Minute-of-day in America/Chicago (CME's own local time), 0..1439.
//
// Session rules are written in CT — "flat by 3:05 PM CT", "reopen 5:00 PM CT" —
// so storing CT directly means the engine compares against the rule as written,
// with no timezone arithmetic at the point of use. Intl is far too slow to call
// per bar, but the UTC offset only changes at DST transitions, so it is resolved
// once per UTC hour and the minutes within that hour are simple addition.
const CT_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", hour12: false, hour: "2-digit", minute: "2-digit",
});

function ctMinuteOfDay(ms) {
  let h = 0, m = 0;
  for (const p of CT_FMT.formatToParts(ms)) {
    if (p.type === "hour") h = +p.value;
    else if (p.type === "minute") m = +p.value;
  }
  if (h === 24) h = 0;
  return h * 60 + m;
}

function buildCtMinutes(ts, n) {
  const out = new Int16Array(n);
  let lastHour = -1, baseCt = 0;
  for (let i = 0; i < n; i++) {
    const hr = Math.floor(ts[i] / 3600000);
    if (hr !== lastHour) { lastHour = hr; baseCt = ctMinuteOfDay(hr * 3600000); }
    out[i] = (baseCt + Math.floor((ts[i] - hr * 3600000) / 60000)) % 1440;
  }
  return out;
}

// ─────────────────────────────── main ───────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// `--in a.csv --in b.csv` may be repeated; falls back to DEFAULT_IN.
function argList(name, fallback) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1]) out.push(process.argv[i + 1]);
  }
  return out.length ? out : fallback;
}

function log(msg) { process.stdout.write(msg + "\n"); }

// ─────────────────────── parse one CSV into typed arrays ───────────────────────
// `syms` is shared across files so a symbol id means the same contract everywhere.
function parseFile(inPath, syms) {
  const t0 = Date.now();
  log(`Reading ${path.basename(inPath)} ...`);
  const buf = fs.readFileSync(inPath);
  log(`  ${(buf.length / 1048576).toFixed(1)} MB`);

  let hEnd = buf.indexOf(CH_NL);
  if (hEnd < 0) throw new Error(`${inPath}: no newline — is this really a CSV?`);
  const header = buf.toString("latin1", 0, hEnd).replace(/\r$/, "").split(",").map((h) => h.trim().toLowerCase());
  const col = (...names) => {
    for (const nm of names) { const i = header.findIndex((h) => h === nm); if (i >= 0) return i; }
    for (const nm of names) { const i = header.findIndex((h) => h.includes(nm)); if (i >= 0) return i; }
    return -1;
  };
  const iTs = col("ts_event", "timestamp", "date", "time");
  const iO = col("open"), iH = col("high"), iL = col("low"), iC = col("close");
  const iV = col("volume", "vol"), iSym = col("symbol");
  if ([iTs, iO, iH, iL, iC].some((x) => x < 0)) {
    throw new Error(`${inPath} missing a required column. Header was: ${header.join(",")}`);
  }
  const maxCol = Math.max(iTs, iO, iH, iL, iC, iV, iSym);

  // Count rows first so every array is allocated exactly once.
  let rows = 0;
  for (let p = hEnd + 1; p < buf.length;) {
    const nl = buf.indexOf(CH_NL, p);
    if (nl < 0) { if (buf.length - p > 1) rows++; break; }
    if (nl - p > 1) rows++;
    p = nl + 1;
  }

  const ts = new Float64Array(rows);
  const op = new Float32Array(rows), hi = new Float32Array(rows);
  const lo = new Float32Array(rows), cl = new Float32Array(rows);
  const vol = new Float32Array(rows);
  const sym = new Int16Array(rows);
  const fields = new Int32Array((maxCol + 2) * 2);

  let n = 0, skippedSpread = 0, skippedBad = 0, outOfOrder = 0;
  for (let p = hEnd + 1; p < buf.length;) {
    let nl = buf.indexOf(CH_NL, p);
    if (nl < 0) nl = buf.length;
    let end = nl;
    if (end > p && buf[end - 1] === CH_CR) end--;
    if (end <= p) { p = nl + 1; continue; }

    let f = 0, fs_ = p;
    for (let i = p; i <= end && f <= maxCol; i++) {
      if (i === end || buf[i] === CH_COMMA) {
        fields[f * 2] = fs_; fields[f * 2 + 1] = i;
        f++; fs_ = i + 1;
      }
    }
    p = nl + 1;
    if (f <= maxCol) { skippedBad++; continue; }

    if (iSym >= 0) {
      const ss = fields[iSym * 2], se = fields[iSym * 2 + 1];
      let isSpread = false;
      for (let i = ss; i < se; i++) if (buf[i] === CH_MINUS) { isSpread = true; break; }
      if (isSpread) { skippedSpread++; continue; }
      sym[n] = syms.intern(buf, ss, se);
    } else {
      sym[n] = 0;
    }

    const t = parseTs(buf, fields[iTs * 2], fields[iTs * 2 + 1]);
    if (!Number.isFinite(t)) { skippedBad++; continue; }
    if (n > 0 && t < ts[n - 1]) outOfOrder++;
    ts[n] = t;
    op[n] = parseNum(buf, fields[iO * 2], fields[iO * 2 + 1]);
    hi[n] = parseNum(buf, fields[iH * 2], fields[iH * 2 + 1]);
    lo[n] = parseNum(buf, fields[iL * 2], fields[iL * 2 + 1]);
    cl[n] = parseNum(buf, fields[iC * 2], fields[iC * 2 + 1]);
    vol[n] = iV >= 0 ? parseNum(buf, fields[iV * 2], fields[iV * 2 + 1]) : 0;
    n++;
  }

  log(`  ${n.toLocaleString()} outright rows (${skippedSpread.toLocaleString()} spreads, ${skippedBad} unparseable) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`  ${new Date(ts[0]).toISOString().slice(0, 16)} -> ${new Date(ts[n - 1]).toISOString().slice(0, 16)}`);
  // The merge below is a linear merge of sorted runs, so a file that is not
  // already timestamp-ordered would silently produce a scrambled series.
  if (outOfOrder) throw new Error(`${inPath}: ${outOfOrder} rows are out of timestamp order; the merge requires sorted input`);

  return { ts, op, hi, lo, cl, vol, sym, n, path: inPath };
}

// ─────────────────────── merge sorted files, dedupe ───────────────────────
// Linear k-way merge on timestamp. At each distinct timestamp every contributing
// file is drained, and a (timestamp, symbol) pair is emitted only once — earlier
// files in the list win ties. Overlapping rows were verified byte-identical, so
// which copy wins does not matter; the check below re-confirms that per run.
function mergeFiles(files) {
  const total = files.reduce((a, f) => a + f.n, 0);
  const ts = new Float64Array(total), op = new Float32Array(total), hi = new Float32Array(total);
  const lo = new Float32Array(total), cl = new Float32Array(total), vol = new Float32Array(total);
  const sym = new Int16Array(total);

  const cur = new Array(files.length).fill(0);
  let n = 0, dupes = 0, conflicts = 0;
  let firstConflict = null;
  const seen = new Map(); // symbol id -> index emitted at the current timestamp

  for (;;) {
    let t = Infinity;
    for (let k = 0; k < files.length; k++) {
      if (cur[k] < files[k].n && files[k].ts[cur[k]] < t) t = files[k].ts[cur[k]];
    }
    if (t === Infinity) break;

    seen.clear();
    for (let k = 0; k < files.length; k++) {
      const f = files[k];
      while (cur[k] < f.n && f.ts[cur[k]] === t) {
        const i = cur[k]++;
        const s = f.sym[i];
        const prev = seen.get(s);
        if (prev !== undefined) {
          dupes++;
          // Same bar from two batches: they should agree exactly.
          if (op[prev] !== f.op[i] || hi[prev] !== f.hi[i] || lo[prev] !== f.lo[i] ||
              cl[prev] !== f.cl[i] || vol[prev] !== f.vol[i]) {
            conflicts++;
            if (!firstConflict) firstConflict = { t, s, kept: [op[prev], hi[prev], lo[prev], cl[prev], vol[prev]], seen: [f.op[i], f.hi[i], f.lo[i], f.cl[i], f.vol[i]] };
          }
          continue;
        }
        seen.set(s, n);
        ts[n] = t; op[n] = f.op[i]; hi[n] = f.hi[i]; lo[n] = f.lo[i];
        cl[n] = f.cl[i]; vol[n] = f.vol[i]; sym[n] = s;
        n++;
      }
    }
  }

  return { ts, op, hi, lo, cl, vol, sym, n, dupes, conflicts, firstConflict };
}

function main() {
  const inPaths = argList("--in", DEFAULT_IN);
  const outPath = arg("--out", DEFAULT_OUT);

  const missing = inPaths.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    console.error(`Input CSV not found:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const t0 = Date.now();
  const syms = new SymbolTable();          // shared, so ids mean the same thing across files
  const parsed = inPaths.map((p) => parseFile(p, syms));

  let ts, op, hi, lo, cl, vol, sym, n;
  if (parsed.length === 1) {
    ({ ts, op, hi, lo, cl, vol, sym, n } = parsed[0]);
  } else {
    log(`\nMerging ${parsed.length} files ...`);
    const m = mergeFiles(parsed);
    ({ ts, op, hi, lo, cl, vol, sym, n } = m);
    log(`  ${n.toLocaleString()} unique rows (${m.dupes.toLocaleString()} overlapping rows deduplicated)`);
    if (m.conflicts) {
      // Same (timestamp, symbol) with different OHLCV in two batches means one
      // of them is revised or corrupt. Refuse to silently pick a winner.
      const c = m.firstConflict;
      log(`  !! ${m.conflicts.toLocaleString()} overlapping rows DISAGREE between files`);
      log(`     first at ${new Date(c.t).toISOString()} ${syms.names[c.s]}`);
      log(`     kept ${c.kept.join(",")}  vs  ${c.seen.join(",")}`);
      throw new Error("Overlapping rows disagree — resolve before trusting the merge");
    }
    log(`  all overlapping rows agreed exactly`);
  }

  log(`\n${n.toLocaleString()} outright rows total in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`  ${new Date(ts[0]).toISOString().slice(0, 16)} -> ${new Date(ts[n - 1]).toISOString().slice(0, 16)}`);
  log(`  symbols: ${syms.names.length} (${syms.names.slice(0, 6).join(", ")}${syms.names.length > 6 ? ", ..." : ""})`);

  // ── dominant contract per UTC day, by volume ──
  const dayDom = new Map(); // dayIdx -> Map(symId -> volume)
  for (let i = 0; i < n; i++) {
    const d = Math.floor(ts[i] / 86400000);
    let m = dayDom.get(d);
    if (!m) { m = new Map(); dayDom.set(d, m); }
    m.set(sym[i], (m.get(sym[i]) || 0) + vol[i]);
  }
  const dom = new Map();
  for (const [d, m] of dayDom) {
    let best = -1, bestV = -1;
    for (const [s, v] of m) if (v > bestV) { bestV = v; best = s; }
    dom.set(d, best);
  }

  // ── keep only the active contract, deduped by timestamp ──
  const kIdx = new Int32Array(n);
  let k = 0, prevTs = -1;
  for (let i = 0; i < n; i++) {
    if (sym[i] !== dom.get(Math.floor(ts[i] / 86400000))) continue;
    if (ts[i] === prevTs) continue;
    prevTs = ts[i];
    kIdx[k++] = i;
  }
  log(`  continuous front-month: ${k.toLocaleString()} bars`);

  const N = k;
  const oTs = new Float64Array(N), oO = new Float32Array(N), oH = new Float32Array(N);
  const oL = new Float32Array(N), oC = new Float32Array(N), oV = new Float32Array(N);
  const oS = new Int16Array(N);
  for (let j = 0; j < N; j++) {
    const i = kIdx[j];
    oTs[j] = ts[i]; oO[j] = op[i]; oH[j] = hi[i]; oL[j] = lo[i]; oC[j] = cl[i]; oV[j] = vol[i]; oS[j] = sym[i];
  }

  // ── Panama Canal back-adjustment ──
  // Split into contiguous same-symbol pieces, measure the close-to-close gap at
  // each handover, then shift every EARLIER piece by the cumulative gap so the
  // most recent contract keeps its true prices.
  const pieceStart = [0];
  for (let i = 1; i < N; i++) if (oS[i] !== oS[i - 1]) pieceStart.push(i);
  pieceStart.push(N);
  const nPieces = pieceStart.length - 1;

  // Measure the calendar spread from both contracts quoted at the SAME MINUTE.
  //
  // The naive method — (first bar of the new contract) minus (last bar of the
  // old one) — silently conflates the contract spread with however much price
  // moved in between. That is harmless when the handover lands mid-session, but
  // 4 of the 20 MNQ rolls land at the Sunday 22:00 reopen, where "in between" is
  // a 49-hour weekend. Adjusting by that combined figure removes the spread AND
  // erases a real weekend move from the series.
  //
  // Both contracts trade simultaneously for weeks before expiry, so the true
  // spread is directly observable with no time-passage component at all.
  function overlapSpread(symA, symB, handoverMs) {
    const lookbackMs = 10 * 86400000;
    let s = 0, e = n;
    while (s < e) { const m = (s + e) >>> 1; if (ts[m] < handoverMs - lookbackMs) s = m + 1; else e = m; }
    const a = new Map(), b = new Map();
    for (let i = s; i < n && ts[i] <= handoverMs; i++) {
      if (sym[i] === symA) a.set(ts[i], cl[i]);
      else if (sym[i] === symB) b.set(ts[i], cl[i]);
    }
    let at = -1;
    for (const t of a.keys()) if (t > at && b.has(t)) at = t;
    return at < 0 ? null : { gap: b.get(at) - a.get(at), at, overlapBars: b.size };
  }

  // Measure every gap BEFORE shifting anything. The adjustment mutates oC in
  // place, so reading a gap mid-pass would see an already-shifted next piece and
  // compound the correction at every rollover.
  const gaps = new Float64Array(Math.max(0, nPieces - 1));
  const gapMeta = [];
  for (let pi = 0; pi < nPieces - 1; pi++) {
    const b = pieceStart[pi + 1];
    const naive = oC[b] - oC[b - 1];
    const ov = overlapSpread(oS[b - 1], oS[b], oTs[b]);
    gaps[pi] = ov ? ov.gap : naive;
    gapMeta.push({
      method: ov ? "overlap" : "close-to-close",
      naive: Math.round(naive * 100) / 100,
      measuredAt: ov ? new Date(ov.at).toISOString() : null,
      overlapBars: ov ? ov.overlapBars : 0,
      elapsedMin: ov ? Math.round((oTs[b] - ov.at) / 60000) : null,
    });
  }
  const noOverlap = gapMeta.filter((g) => g.method !== "overlap").length;
  if (noOverlap) log(`  WARNING: ${noOverlap} rollover(s) had no overlapping quotes; fell back to close-to-close`);

  const rollovers = [];
  let cumAdj = 0;
  for (let pi = nPieces - 1; pi >= 0; pi--) {
    const s = pieceStart[pi], e = pieceStart[pi + 1];
    if (pi < nPieces - 1) {
      cumAdj += gaps[pi];
      rollovers.push({
        ms: oTs[pieceStart[pi + 1]],
        from: syms.names[oS[e - 1]],
        to: syms.names[oS[pieceStart[pi + 1]]],
        gap: Math.round(gaps[pi] * 100) / 100,
        ...gapMeta[pi],
      });
    }
    if (Math.abs(cumAdj) > 1e-9) {
      for (let i = s; i < e; i++) {
        oO[i] = Math.round((oO[i] + cumAdj) * 10000) / 10000;
        oH[i] = Math.round((oH[i] + cumAdj) * 10000) / 10000;
        oL[i] = Math.round((oL[i] + cumAdj) * 10000) / 10000;
        oC[i] = Math.round((oC[i] + cumAdj) * 10000) / 10000;
      }
    }
  }
  rollovers.reverse();
  log(`  ${nPieces} contract pieces, ${rollovers.length} rollovers back-adjusted`);

  // Sanity check: the adjustment should leave no seam bigger than a normal
  // weekend gap. Anything wilder means the dominance logic picked wrong.
  // A correct adjustment leaves no discontinuity that elapsed time cannot
  // explain. Mid-session handovers (1 minute apart) must be ~flat; handovers at
  // the Sunday reopen legitimately carry the weekend's real move, which we must
  // NOT flatten — doing so would delete a move that actually happened.
  let worstMid = 0, worstMidAt = 0;
  for (let pi = 1; pi < nPieces; pi++) {
    const i = pieceStart[pi];
    const elapsedMin = (oTs[i] - oTs[i - 1]) / 60000;
    const jump = Math.abs(oC[i] - oC[i - 1]);
    if (elapsedMin <= 5 && jump > worstMid) { worstMid = jump; worstMidAt = oTs[i]; }
  }
  // A mid-session seam is the outgoing contract's own 1-minute move across the
  // handover — a real move that must survive, not be flattened. Only a jump too
  // large to be one minute of trading indicates the spread was mis-measured.
  log(`  worst mid-session rollover seam: ${worstMid.toFixed(2)} pts (a 1-min market move)${worstMid > 30 ? ` !! implausibly large, at ${new Date(worstMidAt).toISOString()}` : ""}`);

  // ── CME trading-day index + Chicago wall-clock minute ──
  const tday = buildTradingDays(oTs, N);
  const ctMin = buildCtMinutes(oTs, N);

  // ── write ──
  // Layout: 16B header, ts(f64), open/high/low/close/volume(f32), tday(i32),
  // ctMin(i16). Float64 first keeps every subsequent array naturally aligned.
  const bytes = 16 + N * 8 + N * 4 * 5 + N * 4 + N * 2;
  const out = Buffer.allocUnsafe(bytes);
  out.write("MNQB", 0, "latin1");
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(N, 8);
  out.writeUInt32LE(0, 12);
  let off = 16;
  const put = (arr, BPE) => {
    Buffer.from(arr.buffer, arr.byteOffset, N * BPE).copy(out, off);
    off += N * BPE;
  };
  put(oTs, 8); put(oO, 4); put(oH, 4); put(oL, 4); put(oC, 4); put(oV, 4);
  put(tday, 4); put(ctMin, 2);
  fs.writeFileSync(outPath, out);

  const meta = {
    source: inPaths[inPaths.length - 1],   // kept for tools that expect one path
    sources: inPaths,
    builtAt: new Date().toISOString(),
    bars: N,
    startMs: oTs[0], endMs: oTs[N - 1],
    start: new Date(oTs[0]).toISOString(), end: new Date(oTs[N - 1]).toISOString(),
    symbols: syms.names,
    rollovers,
    worstMidSessionSeam: Math.round(worstMid * 10000) / 10000,
  };
  fs.writeFileSync(outPath.replace(/\.bin$/, ".meta.json"), JSON.stringify(meta, null, 2));

  log(`\nWrote ${outPath} (${(bytes / 1048576).toFixed(1)} MB)`);
  log(`  ${N.toLocaleString()} bars  ${meta.start} -> ${meta.end}`);
  log(`  total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
