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
import { runStrategy } from "./src/run.mjs";
import { resolveExec, DEFAULT_EXEC } from "./src/engine.mjs";
import { sweepWindows, sweepFunded, DEFAULT_RULES, DEFAULT_FUNDED, resolveRules, resolveFunded } from "./src/challenge.mjs";
import { indexAtOrAfter } from "./src/resample.mjs";
import { evalBase, evalOf } from "./src/evals.mjs";
import { resolveStudies, gateKey, studyOnSignal, studyEdge } from "./src/studies.mjs";
import { listIndicators, loadTools, readIndicator } from "./tradovate/mock/library.mjs";

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

// Only the studies that gate change the trades, so only they key the cache.
function cacheKey(strategyId, params, exec, filter, studies) {
  return JSON.stringify([strategyId, params, exec, filter, gateKey(studies)]);
}

function fullRun(strategyId, params, exec, filter, studies) {
  const key = cacheKey(strategyId, params, exec, filter, studies);
  const hit = runCache.get(key);
  if (hit) return hit;

  const s = strategies.get(strategyId);
  if (!s) throw new Error(`Unknown strategy: ${strategyId}`);
  const t = Date.now();
  const res = runStrategy(bars, s, params, exec, { filter, studies });
  res.ms = Date.now() - t;

  runCache.set(key, res);
  if (runCache.size > RUN_CACHE_MAX) runCache.delete(runCache.keys().next().value);
  return res;
}

// ─────────────────────────── the chart link ───────────────────────────
// The page posts what it shows (strategy, settings, window, result) whenever that
// changes, and listens on an event stream for changes pushed to it. The MCP
// server's chart_state / chart_apply tools are the other end, so a prompt beside
// the chart can read what the person is looking at and change it.
const NO_PAGE = `no chart page is open: open http://localhost:${PORT}`;
const pages = new Set();          // open event streams, one per page
let chartState = null;            // the latest state a page posted
const waiting = new Map();        // apply id -> deliver the page's confirmation
let applySeq = 0;

// The link changes what the person sees, so posts to it are taken only from this
// server's own pages, or from tools on this machine (which send no Origin). A
// web page elsewhere could otherwise post a plain-text body here unprompted.
function fromOwnPage(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const u = new URL(o);
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && Number(u.port || 80) === PORT;
  } catch { return false; }
}

function chartEvents(req, res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(": connected\n\n");
  pages.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); pages.delete(res); });
}

function receiveState(s) {
  chartState = { ...s, receivedAt: new Date().toISOString() };
  const deliver = s && s.appliedId && waiting.get(s.appliedId);
  if (deliver) { waiting.delete(s.appliedId); deliver(chartState); }
}

// Push a change to every open page and answer with the state the first one
// reports after applying it -- the numbers the person now sees.
function applyToChart(res, body) {
  if (!pages.size) return sendJson(res, 409, { error: NO_PAGE });
  const id = `apply-${++applySeq}`;
  const timeoutMs = body.sweep ? 240000 : 30000;
  const timer = setTimeout(() => {
    waiting.delete(id);
    sendJson(res, 504, { error: `the chart did not confirm the change within ${timeoutMs / 1000}s` });
  }, timeoutMs);
  waiting.set(id, (state) => {
    clearTimeout(timer);
    if (state.applyError) sendJson(res, 400, { error: state.applyError });
    else sendJson(res, 200, state);
  });
  const msg = `event: apply\ndata: ${JSON.stringify({ ...body, id })}\n\n`;
  for (const p of pages) p.write(msg);
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

// Static files, restricted to the folders the app actually needs. Checked after
// the path is resolved: an encoded "..%2f" gets past the prefix test, and bot/.env
// sits in this project.
const STATIC_ROOTS = ["public", "src", "strategies", path.join("tradovate", "mock")].map((d) => path.join(HERE, d) + path.sep);
function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/" || rel === "") rel = "/public/index.html";
  else if (!/^\/(public|src|strategies|tradovate\/mock)\//.test(rel)) rel = "/public" + rel;

  const full = path.normalize(path.join(HERE, rel));
  if (!STATIC_ROOTS.some((r) => full.startsWith(r)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
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

    // The measured table behind the README's (research/strategy_table.mjs), for the
    // strategy picker. Read fresh, so a re-measure shows without a restart.
    if (p === "/api/strategies/table") {
      try { return sendJson(res, 200, JSON.parse(fs.readFileSync(path.join(HERE, "research", "strategy_table_results.json"), "utf8"))); }
      catch { return sendJson(res, 200, { rows: [] }); }
    }

    if (p === "/api/strategies/reload") {
      strategies = await loadStrategies({ force: true });
      runCache.clear();
      console.log(`Reloaded ${strategies.size} strategies`);
      return sendJson(res, 200, [...strategies.values()].map(describe));
    }

    // ── Tradovate indicators, read fresh so an edited file shows on its next load ──
    if (p === "/api/tradovate") return sendJson(res, 200, { ...listIndicators(), tools: loadTools() });
    if (p === "/api/tradovate/source") {
      try { return sendJson(res, 200, readIndicator(url.searchParams.get("name") || "")); }
      catch (e) { return sendJson(res, 404, { error: e.message }); }
    }

    // ── window bars, binary ──
    // Returns the window PLUS a warm-up prefix, so indicators at the left edge
    // match a full-history run instead of restarting cold, and a tail, so a trade
    // opened inside the window can finish (see src/window.mjs).
    if (p === "/api/window") {
      const start = Number(url.searchParams.get("start"));
      const days = Number(url.searchParams.get("days") || 30);
      const warmupMin = Number(url.searchParams.get("warmupMin") || 5 * 24 * 60);
      const tailMin = Number(url.searchParams.get("tailMin") || 0);
      if (!Number.isFinite(start)) return sendJson(res, 400, { error: "start (epoch ms) required" });

      const s = indexAtOrAfter(bars.ts, start - warmupMin * 60000);
      const e = indexAtOrAfter(bars.ts, start + days * 86400000 + tailMin * 60000);
      return sendBin(res, packBars(bars, s, Math.min(e + 1, bars.count)));
    }

    // ── full-history run + window sweep ──
    if (p === "/api/sweep" && req.method === "POST") {
      const body = await readBody(req);
      const s = strategies.get(body.strategyId);
      if (!s) return sendJson(res, 400, { error: `Unknown strategy: ${body.strategyId}` });

      // A strategy's own defaults under the chosen evaluation are the BASE, with
      // the request layered on top. Without this the API silently ignores the
      // gate and risk envelope a strategy ships with, and returns numbers that do
      // not match the UI — which is exactly how a spec ends up quoting figures
      // nothing reproduces.
      let base, studies;
      try { base = evalBase(s, body.eval); studies = resolveStudies(body.studies); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
      const params = { ...base.params, ...(body.params || {}) };
      const exec = resolveExec({ ...base.exec, ...(body.exec || {}) });
      const rules = resolveRules({ ...base.rules, ...(body.rules || {}) });
      const filter = { ...base.filter, ...(body.filter || {}) };

      const run = fullRun(body.strategyId, params, exec, filter, studies);
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
      // Where the P&L comes from by time of day and day of the week, over all of
      // history and over 2026 alone -- the period results are judged on.
      const y2026 = Date.UTC(2026, 0, 1);
      const breakdown = (keyOf) => {
        const out = { all: new Map(), y2026: new Map() };
        for (const t of run.trades) {
          const k = keyOf(t);
          if (k == null) continue;
          for (const [name, m] of Object.entries(out)) {
            if (name === "y2026" && t.entryTime < y2026) continue;
            let g = m.get(k);
            if (!g) m.set(k, (g = { key: k, trades: 0, net: 0, wins: 0 }));
            g.trades++; g.net += t.pnl; if (t.pnl > 0) g.wins++;
          }
        }
        const rows = (m) => [...m.values()].map((g) => ({ ...g, net: Math.round(g.net) }));
        return { all: rows(out.all), y2026: rows(out.y2026) };
      };
      // Every study's states at the trades' signals: how the book did with and
      // against each indicator, gating or not.
      const tE = Date.now();
      const edge = studies.map((st) => ({ id: st.id ?? null, ...studyEdge(run.trades, studyOnSignal(bars, run.tf, st)) }));
      return sendJson(res, 200, {
        eval: evalOf(body.eval).id,
        stats: run.stats,
        backtestMs: run.ms,
        sweepMs,
        fundedMs: Date.now() - tF,
        edgeMs: Date.now() - tE,
        funded: funded.summary,
        // entry hour in Chicago time; weekday of the trading day the trade closed in
        byHourCt: breakdown((t) => (t.entryCt == null ? null : Math.floor(t.entryCt / 60))),
        byWeekday: breakdown((t) => new Date(t.tday * 86400000).getUTCDay()),
        studyGated: run.studyGated || 0,
        edge,
        ...sweep,
      });
    }

    // ── the chart link ──
    if (p === "/api/chart/events") return chartEvents(req, res);
    if (p.startsWith("/api/chart/") && req.method === "POST" && !fromOwnPage(req)) {
      return sendJson(res, 403, { error: "the chart link only takes posts from its own page" });
    }
    if (p === "/api/chart/state" && req.method === "POST") {
      receiveState(await readBody(req));
      res.writeHead(204);
      return res.end();
    }
    if (p === "/api/chart/state") {
      if (!pages.size || !chartState) return sendJson(res, 404, { error: NO_PAGE });
      return sendJson(res, 200, chartState);
    }
    if (p === "/api/chart/apply" && req.method === "POST") return applyToChart(res, await readBody(req));

    return serveStatic(res, p);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  MNQ Chart Lab  ->  http://localhost:${PORT}\n`);
});
