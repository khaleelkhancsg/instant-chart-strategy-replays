// CSV files -> the engine's binary, for a one-off file.
//
// The project's own bars live in the raw store and are built from it (store.mjs). This takes
// CSVs straight to a binary through the same build (src/series.mjs), which is how a file
// outside the store gets made, and how the store's output is checked.
//
// Usage:  node prepare.mjs --in <csv> [--in <csv> ...] --out <bin>

import fs from "node:fs";
import path from "node:path";
import { SymbolTable, parseCsv, mergeFiles, buildSeries } from "./src/series.mjs";

function argList(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === name && process.argv[i + 1]) out.push(process.argv[i + 1]);
  return out;
}
const log = (msg) => process.stdout.write(msg + "\n");

function main() {
  const inPaths = argList("--in"), [outPath] = argList("--out");
  if (!inPaths.length || !outPath) {
    console.error("Usage: node prepare.mjs --in <csv> [--in <csv> ...] --out <bin>\nThe project's bars come from the store: npm run data:build");
    process.exit(1);
  }
  const missing = inPaths.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    console.error(`Input CSV not found:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const t0 = Date.now();
  const syms = new SymbolTable();          // shared, so ids mean the same thing across files
  const parsed = inPaths.map((p) => parseCsv(fs.readFileSync(p), path.basename(p), syms, log));

  let rows;
  if (parsed.length === 1) {
    rows = parsed[0];
  } else {
    log(`\nMerging ${parsed.length} files ...`);
    rows = mergeFiles(parsed);
    log(`  ${rows.n.toLocaleString()} unique rows (${rows.dupes.toLocaleString()} overlapping rows deduplicated)`);
    if (rows.conflicts) {
      // Same (timestamp, symbol) with different OHLCV in two batches means one
      // of them is revised or corrupt. Refuse to silently pick a winner.
      const c = rows.firstConflict;
      log(`  !! ${rows.conflicts.toLocaleString()} overlapping rows DISAGREE between files`);
      log(`     first at ${new Date(c.t).toISOString()} ${syms.names[c.s]}`);
      log(`     kept ${c.kept.join(",")}  vs  ${c.seen.join(",")}`);
      throw new Error("Overlapping rows disagree — resolve before trusting the merge");
    }
    log(`  all overlapping rows agreed exactly`);
  }
  log(`\n${rows.n.toLocaleString()} outright rows total in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`  ${new Date(rows.ts[0]).toISOString().slice(0, 16)} -> ${new Date(rows.ts[rows.n - 1]).toISOString().slice(0, 16)}`);
  log(`  symbols: ${syms.names.length} (${syms.names.slice(0, 6).join(", ")}${syms.names.length > 6 ? ", ..." : ""})`);

  const { out, meta } = buildSeries(rows, syms.names, log);
  fs.writeFileSync(outPath, out);
  // source is kept for tools that expect one path
  fs.writeFileSync(outPath.replace(/\.bin$/, ".meta.json"), JSON.stringify({ source: inPaths[inPaths.length - 1], sources: inPaths, ...meta }, null, 2));
  log(`\nWrote ${outPath} (${(out.length / 1048576).toFixed(1)} MB)`);
  log(`  total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
