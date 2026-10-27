// The chart lab as an MCP server.   node mcp/server.mjs
//
// Claude calls these tools instead of writing one-off research scripts, so every
// answer runs through the tested engine (src/) rather than a fresh copy of it.
// Registered for this folder in .mcp.json. The protocol is JSON-RPC 2.0, one
// message per line over stdin/stdout; this server offers tools only, so it needs
// nothing beyond Node. Logs go to stderr.

import "./stdout_guard.mjs";
import { TOOLS } from "./tools.mjs";
import { UserError, bars, strategies } from "./lab.mjs";

const SERVER = { name: "mnq-chart-lab", version: "1.0.0" };
const INSTRUCTIONS = [
  "Backtesting and combine-pass research on 7 years of MNQ 1-minute data, through the same engine as the chart lab.",
  "Start with list_strategies / describe_strategy. backtest gives trade statistics; pass_rate gives combine pass rates by period;",
  "compare pairs two configurations on the same windows; search runs a grid with an in-sample/out-of-sample split and an overfitting check;",
  "walk_forward tests whether re-choosing from a grid month by month beats holding the base configuration; sensitivity shows how far the pass rate moves when each setting is nudged.",
  "chart_state reads what the person is looking at in the chart; chart_apply changes it. papers holds the methodology library.",
  "House rules: judge on 2026 and check inside 2026 (Jan-Mar vs Apr-Jul) -- the default periods do this; say which pass-rate method a number came from,",
  "and quote its ci95 -- neighbouring 30-day windows share most of their days, so 2026 holds only five or six independent samples;",
  "include costs -- a tick of slippage a side is the realistic baseline, and the tools warn when a configuration has none.",
].join(" ");

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

let preloaded = false;
function preload() {
  if (preloaded) return;
  preloaded = true;
  // After the handshake, so the client is not kept waiting for 7 years of bars.
  setImmediate(async () => {
    const t0 = Date.now();
    try { bars(); await strategies(); console.error(`[mnq-chart-lab] data loaded in ${Date.now() - t0} ms`); }
    catch (e) { console.error(`[mnq-chart-lab] preload failed: ${e.message}`); }
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case "initialize": {
        const asked = params && params.protocolVersion;
        // Tools are the same in every protocol revision, so whichever dated
        // version the client speaks is one this server can answer in.
        const protocolVersion = typeof asked === "string" && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : "2025-06-18";
        reply(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS });
        preload();
        return;
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        if (isRequest) reply(id, {});
        return;
      case "tools/list":
        reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        return;
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === (params && params.name));
        if (!tool) { fail(id, -32602, `unknown tool: ${params && params.name}`); return; }
        const t0 = Date.now();
        try {
          const out = await tool.run((params && params.arguments) || {});
          reply(id, { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] });
          console.error(`[mnq-chart-lab] ${tool.name} ${Date.now() - t0} ms`);
        } catch (e) {
          // A tool error the model can read and correct, not a protocol failure.
          const text = e instanceof UserError ? e.message : `${e.name}: ${e.message}`;
          if (!(e instanceof UserError)) console.error(e.stack);
          reply(id, { content: [{ type: "text", text }], isError: true });
        }
        return;
      }
      default:
        if (isRequest) fail(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (isRequest) fail(id, -32603, e.message);
  }
}

// Requests are handled one at a time, in order: the tools are CPU-bound, and a
// queue keeps responses in the order they were asked for.
let queue = Promise.resolve(), buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); continue; }
    queue = queue.then(() => handle(msg));
  }
});
process.stdin.on("end", () => queue.then(() => process.exit(0)));
