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

const DEFAULT_IN = "C:\\Users\\khale\\Desktop\\Backtesting\\data\\glbx-mdp3-20210715-20260714.ohlcv-1m.csv";
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

// ─────────────────────────────── main ───────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function log(msg) { process.stdout.write(msg + "\n"); }

function main() {
  const inPath = arg("--in", DEFAULT_IN);
  const outPath = arg("--out", DEFAULT_OUT);

  if (!fs.existsSync(inPath)) {
    console.error(`Input CSV not found: ${inPath}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const t0 = Date.now();
  log(`Reading ${inPath} ...`);
  const buf = fs.readFileSync(inPath);
  log(`  ${(buf.length / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Header: locate the columns we need by name.
  let hEnd = buf.indexOf(CH_NL);
  if (hEnd < 0) throw new Error("CSV has no newline — is this really a CSV?");
  const header = buf.toString("latin1", 0, hEnd).replace(/\r$/, "").split(",").map((h) => h.trim().toLowerCase());
  const col = (...names) => {
    for (const nm of names) {
      const i = header.findIndex((h) => h === nm);
      if (i >= 0) return i;
    }
    for (const nm of names) {
      const i = header.findIndex((h) => h.includes(nm));
      if (i >= 0) return i;
    }
    return -1;
  };
  const iTs = col("ts_event", "timestamp", "date", "time");
  const iO = col("open"), iH = col("high"), iL = col("low"), iC = col("close");
  const iV = col("volume", "vol"), iSym = col("symbol");
  if ([iTs, iO, iH, iL, iC].some((x) => x < 0)) {
    throw new Error(`CSV missing a required column. Header was: ${header.join(",")}`);
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
  log(`  ${rows.toLocaleString()} data rows`);

  const ts = new Float64Array(rows);
  const op = new Float32Array(rows), hi = new Float32Array(rows);
  const lo = new Float32Array(rows), cl = new Float32Array(rows);
  const vol = new Float32Array(rows);
  const sym = new Int16Array(rows);
  const syms = new SymbolTable();
  const fields = new Int32Array((maxCol + 2) * 2); // [start,end] per column

  let n = 0, skippedSpread = 0, skippedBad = 0;
  for (let p = hEnd + 1; p < buf.length;) {
    let nl = buf.indexOf(CH_NL, p);
    if (nl < 0) nl = buf.length;
    let end = nl;
    if (end > p && buf[end - 1] === CH_CR) end--;
    if (end <= p) { p = nl + 1; continue; }

    // Split the line into column ranges.
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
    ts[n] = t;
    op[n] = parseNum(buf, fields[iO * 2], fields[iO * 2 + 1]);
    hi[n] = parseNum(buf, fields[iH * 2], fields[iH * 2 + 1]);
    lo[n] = parseNum(buf, fields[iL * 2], fields[iL * 2 + 1]);
    cl[n] = parseNum(buf, fields[iC * 2], fields[iC * 2 + 1]);
    vol[n] = iV >= 0 ? parseNum(buf, fields[iV * 2], fields[iV * 2 + 1]) : 0;
    n++;
  }
  log(`  parsed ${n.toLocaleString()} outright rows (${skippedSpread.toLocaleString()} spreads, ${skippedBad} unparseable) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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

  // Measure every gap BEFORE shifting anything. The adjustment mutates oC in
  // place, so reading a gap mid-pass would see an already-shifted next piece and
  // compound the correction at every rollover.
  const gaps = new Float64Array(Math.max(0, nPieces - 1));
  for (let pi = 0; pi < nPieces - 1; pi++) {
    const b = pieceStart[pi + 1];
    gaps[pi] = oC[b] - oC[b - 1];
  }

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
  let worstSeam = 0, worstAt = 0;
  for (let pi = 1; pi < nPieces; pi++) {
    const i = pieceStart[pi];
    const jump = Math.abs(oC[i] - oC[i - 1]);
    if (jump > worstSeam) { worstSeam = jump; worstAt = oTs[i]; }
  }
  log(`  worst residual seam at a rollover: ${worstSeam.toFixed(4)} pts ${worstSeam > 1 ? `(!! at ${new Date(worstAt).toISOString()})` : "(clean)"}`);

  // ── CME trading-day index ──
  const tday = buildTradingDays(oTs, N);

  // ── write ──
  // Layout: 16B header, then ts(f64), open/high/low/close/volume(f32), tday(i32).
  // Float64 first keeps every subsequent array naturally aligned.
  const bytes = 16 + N * 8 + N * 4 * 5 + N * 4;
  const out = Buffer.allocUnsafe(bytes);
  out.write("MNQB", 0, "latin1");
  out.writeUInt32LE(1, 4);
  out.writeUInt32LE(N, 8);
  out.writeUInt32LE(0, 12);
  let off = 16;
  const put = (arr, BPE) => {
    Buffer.from(arr.buffer, arr.byteOffset, N * BPE).copy(out, off);
    off += N * BPE;
  };
  put(oTs, 8); put(oO, 4); put(oH, 4); put(oL, 4); put(oC, 4); put(oV, 4); put(tday, 4);
  fs.writeFileSync(outPath, out);

  const meta = {
    source: inPath,
    builtAt: new Date().toISOString(),
    bars: N,
    startMs: oTs[0], endMs: oTs[N - 1],
    start: new Date(oTs[0]).toISOString(), end: new Date(oTs[N - 1]).toISOString(),
    symbols: syms.names,
    rollovers,
    worstResidualSeam: Math.round(worstSeam * 10000) / 10000,
  };
  fs.writeFileSync(outPath.replace(/\.bin$/, ".meta.json"), JSON.stringify(meta, null, 2));

  log(`\nWrote ${outPath} (${(bytes / 1048576).toFixed(1)} MB)`);
  log(`  ${N.toLocaleString()} bars  ${meta.start} -> ${meta.end}`);
  log(`  total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
