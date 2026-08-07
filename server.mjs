// Zero-dependency HTTP server.
//
// Division of labour with the browser, which is what keeps the UI instant:
//   SERVER — holds all 5 years in RAM, runs full-history backtests, and sweeps
//            every 30-day window. Expensive, milliseconds-to-a-second, done on
//            demand (debounced) rather than per keystroke.
//   BROWSER — re-runs the SAME strategy module over just the visible window on
//            every slider move. ~8k bars, single-digit ms, no network at all.
//
// Both run identical code from src/ and strategies/, which this server also
// exposes as plain ES modules so the browser can import them directly.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadBars, packBars } from "./src/data.mjs";
import { loadStrategies, describe } from "./src/registry.mjs";
import { runStrategy, resolveParams } from "./src/run.mjs";
import { resolveExec, DEFAULT_EXEC } from "./src/engine.mjs";
import { sweepWindows, sweepFunded, DEFAULT_RULES, DEFAULT_FUNDED, resolveRules, resolveFunded } from "./src/challenge.mjs";
import { indexAtOrAfter } from "./src/resample.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5178;

// ─────────────────────────────── boot ───────────────────────────────
console.log("Loading binary cache ...");
const t0 = Date.now();
const { bars, meta } = loadBars();
console.log(`  ${bars.count.toLocaleString()} bars in ${Date.now() - t0}ms  (${meta.start ?? "?"} -> ${meta.end ?? "?"})`);

let strategies = await loadStrategies();
console.log(`  ${strategies.size} strategies: ${[...strategies.keys()].join(", ") || "(none)"}`);

// Full-history runs are the only slow thing here, so keep the last few.
const runCache = new Map();
const RUN_CACHE_MAX = 8;

function cacheKey(strategyId, params, exec, filter) {
  return JSON.stringify([strategyId, params, exec, filter]);
}

function fullRun(strategyId, params, exec, filter) {
  const key = cacheKey(strategyId, params, exec, filter);
  const hit = runCache.get(key);
  if (hit) return hit;

  const s = strategies.get(strategyId);
  if (!s) throw new Error(`Unknown strategy: ${strategyId}`);
  const t = Date.now();
  const res = runStrategy(bars, s, params, exec, { filter });
  res.ms = Date.now() - t;

  runCache.set(key, res);
  if (runCache.size > RUN_CACHE_MAX) runCache.delete(runCache.keys().next().value);
  return res;
}

// ─────────────────────────────── http ───────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendBin(res, buf) {
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// Static files, restricted to the three folders the app actually needs.
function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/" || rel === "") rel = "/public/index.html";
  else if (!/^\/(public|src|strategies)\//.test(rel)) rel = "/public" + rel;

  const full = path.normalize(path.join(HERE, rel));
  if (!full.startsWith(HERE) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  const body = fs.readFileSync(full);
  res.writeHead(200, {
    "content-type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // ── metadata ──
    if (p === "/api/meta") {
      return sendJson(res, 200, {
        bars: bars.count,
        startMs: bars.ts[0],
        endMs: bars.ts[bars.count - 1],
        meta,
        defaults: { exec: DEFAULT_EXEC, rules: DEFAULT_RULES, funded: DEFAULT_FUNDED },
      });
    }

    if (p === "/api/strategies") {
      return sendJson(res, 200, [...strategies.values()].map(describe));
    }

    if (p === "/api/strategies/reload") {
      strategies = await loadStrategies({ force: true });
      runCache.clear();
      console.log(`Reloaded ${strategies.size} strategies`);
      return sendJson(res, 200, [...strategies.values()].map(describe));
    }

    // ── window bars, binary ──
    // Returns the window PLUS a warm-up prefix, so indicators at the left edge
    // match a full-history run instead of restarting cold.
    if (p === "/api/window") {
      const start = Number(url.searchParams.get("start"));
      const days = Number(url.searchParams.get("days") || 30);
      const warmupMin = Number(url.searchParams.get("warmupMin") || 5 * 24 * 60);
      if (!Number.isFinite(start)) return sendJson(res, 400, { error: "start (epoch ms) required" });

      const s = indexAtOrAfter(bars.ts, start - warmupMin * 60000);
      const e = indexAtOrAfter(bars.ts, start + days * 86400000);
      return sendBin(res, packBars(bars, s, Math.min(e + 1, bars.count)));
    }

    // ── full-history run + window sweep ──
    if (p === "/api/sweep" && req.method === "POST") {
      const body = await readBody(req);
      const s = strategies.get(body.strategyId);
      if (!s) return sendJson(res, 400, { error: `Unknown strategy: ${body.strategyId}` });

      const params = resolveParams(s, body.params);
      const exec = resolveExec(body.exec);
      const rules = resolveRules(body.rules);

      const run = fullRun(body.strategyId, params, exec, body.filter);
      const tSweep = Date.now();
      const sweep = sweepWindows(
        run.trades, bars.ts[0], bars.ts[bars.count - 1], rules,
        Number(body.stepDays) || 1
      );
      const sweepMs = Date.now() - tSweep;

      // What the same book would earn AFTER passing — the number that actually
      // matters, since the evaluation is a gate, not the goal.
      const tF = Date.now();
      const funded = sweepFunded(
        run.trades, bars.ts[0], bars.ts[bars.count - 1],
        rules, resolveFunded(body.funded), 7
      );
      return sendJson(res, 200, {
        stats: run.stats,
        backtestMs: run.ms,
        sweepMs,
        fundedMs: Date.now() - tF,
        funded: funded.summary,
        ...sweep,
      });
    }

    return serveStatic(res, p);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  MNQ Chart Lab  ->  http://localhost:${PORT}\n`);
});
