// Binary cache loader. NODE-ONLY (uses fs) — never import this from a strategy.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BIN = path.join(HERE, "..", "data", "mnq_1m.bin");

export function loadBars(binPath = DEFAULT_BIN) {
  if (!fs.existsSync(binPath)) {
    throw new Error(
      `Binary cache not found at ${binPath}\n` +
      `Build it first:  node prepare.mjs`
    );
  }
  const buf = fs.readFileSync(binPath);
  if (buf.toString("latin1", 0, 4) !== "MNQB") throw new Error("Bad cache magic — rebuild with prepare.mjs");
  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new Error(`Cache version ${version} not supported (need 2) — rebuild with: node prepare.mjs`);
  const n = buf.readUInt32LE(8);

  // Views straight onto the file buffer: zero copy, zero parse.
  const ab = buf.buffer;
  let off = buf.byteOffset + 16;
  const take = (Ctor, count) => {
    const a = new Ctor(ab, off, count);
    off += count * Ctor.BYTES_PER_ELEMENT;
    return a;
  };
  const bars = {
    ts: take(Float64Array, n),
    open: take(Float32Array, n),
    high: take(Float32Array, n),
    low: take(Float32Array, n),
    close: take(Float32Array, n),
    volume: take(Float32Array, n),
    tday: take(Int32Array, n),
    ctMin: take(Int16Array, n),   // minute-of-day, America/Chicago
    count: n,
  };

  let meta = {};
  const metaPath = binPath.replace(/\.bin$/, ".meta.json");
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { /* optional */ }
  }
  return { bars, meta };
}

// Pack a bar range into the wire format the browser expects.
// Header (16B): "MNQW" | version | count | startIdx, then ts f64, OHLCV f32,
// tday i32, ctMin i16.
export function packBars(bars, s, e) {
  const n = Math.max(0, e - s);
  const bytes = 16 + n * 8 + n * 4 * 5 + n * 4 + n * 2;
  const out = Buffer.allocUnsafe(bytes);
  out.write("MNQW", 0, "latin1");
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(n, 8);
  out.writeUInt32LE(s, 12);
  let off = 16;
  const put = (arr) => {
    const view = arr.subarray(s, e);
    Buffer.from(view.buffer, view.byteOffset, view.byteLength).copy(out, off);
    off += view.byteLength;
  };
  put(bars.ts); put(bars.open); put(bars.high); put(bars.low);
  put(bars.close); put(bars.volume); put(bars.tday); put(bars.ctMin);
  return out;
}
