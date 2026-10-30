// The indicators on disk, for the chart server and the CLI. Node only: the page
// gets these through /api/tradovate, and runs them with runtime.mjs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "vendor");
const DIRS = [path.join(HERE, ".."), path.join(HERE, "..", "..", "..", "TradingCustomIndicators", "tradovate")];

export function loadTools() {
  const dir = path.join(VENDOR, "tools"), tools = {};
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".js")) tools[f.slice(0, -3)] = fs.readFileSync(path.join(dir, f), "utf8");
  return tools;
}

// The chart an indicator is written for, from its own header or wrong-chart warning.
export function chartMinutes(source) {
  const m = /APPLY TO A (\d+)-MINUTE CHART|needs a (\d+)-MINUTE chart/i.exec(source);
  return m ? Number(m[1] || m[2]) : 1;
}

const entry = (name, file) => {
  const source = fs.readFileSync(file, "utf8"), d = /description:\s*["'`]([^"'`]+)/.exec(source);
  return { name, minutes: chartMinutes(source), description: d ? d[1] : "" };
};

// Yours (this project's tradovate/, then the TradingCustomIndicators repo), and
// Tradovate's own, which go by builtin:<name>.
export function listIndicators() {
  const mine = new Map();
  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const name = f.slice(0, -3);
      if (f.endsWith(".js") && !mine.has(name)) mine.set(name, entry(name, path.join(dir, f)));
    }
  }
  const dir = path.join(VENDOR, "builtin");
  const builtin = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => entry("builtin:" + f.slice(0, -3), path.join(dir, f)));
  return { mine: [...mine.values()].sort((a, b) => a.name.localeCompare(b.name)), builtin };
}

export function indicatorFile(name) {
  const m = /^(builtin:)?([A-Za-z0-9_-]+)$/.exec(name);
  if (!m) throw new Error(`"${name}" is not an indicator name`);
  const file = `${m[2]}.js`, dirs = m[1] ? [path.join(VENDOR, "builtin")] : DIRS;
  for (const dir of dirs) if (fs.existsSync(path.join(dir, file))) return path.join(dir, file);
  throw new Error(`no indicator called ${name}`);
}

export function readIndicator(name) {
  const source = fs.readFileSync(indicatorFile(name), "utf8");
  return { name, source, minutes: chartMinutes(source) };
}
