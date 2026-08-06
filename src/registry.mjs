// Strategy discovery. NODE-ONLY.
//
// Everything in strategies/ that ends in .mjs and does not start with "_" is a
// strategy. Adding one is: drop the file in, click Reload. The cache-busting
// query string on re-import is what makes hot reload work without restarting
// the server (Node's ESM loader otherwise memoises by specifier forever).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STRATEGY_DIR = path.join(HERE, "..", "strategies");

let cache = new Map();
let generation = 0;

export async function loadStrategies({ force = false } = {}) {
  if (cache.size && !force) return cache;
  if (force) generation++;

  const found = new Map();
  const files = fs.existsSync(STRATEGY_DIR)
    ? fs.readdirSync(STRATEGY_DIR).filter((f) => f.endsWith(".mjs") && !f.startsWith("_"))
    : [];

  for (const f of files) {
    const url = pathToFileURL(path.join(STRATEGY_DIR, f)).href + (generation ? `?v=${generation}` : "");
    try {
      const mod = await import(url);
      const s = mod.default;
      if (!s || typeof s.compute !== "function") {
        console.warn(`  [skip] ${f}: no default export with a compute() function`);
        continue;
      }
      const id = s.id || f.replace(/\.mjs$/, "");
      found.set(id, { ...s, id, file: f });
    } catch (err) {
      console.warn(`  [skip] ${f}: ${err.message}`);
    }
  }
  cache = found;
  return cache;
}

// The shape the sidebar needs — params only, no functions.
export function describe(s) {
  return {
    id: s.id,
    name: s.name || s.id,
    description: s.description || "",
    file: s.file,
    timeframeMin: s.timeframeMin ?? 1,
    warmupBars: s.warmupBars ?? 300,
    params: s.params || [],
    // A signal is only meaningful alongside the risk envelope it was tuned with —
    // stop width, target, and sizing change the outcome more than the signal does.
    // Strategies may therefore ship execution defaults, applied when selected.
    execDefaults: s.execDefaults || null,
  };
}
