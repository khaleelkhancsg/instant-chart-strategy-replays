// The chart link, without a browser.   node test/chart_link.test.mjs
//
// Starts server.mjs on a spare port and plays the page's part: it holds the
// event stream open, posts what it "shows", and answers pushed changes the way
// public/app.js does. Checks the server relays both ways and fails loudly when
// no page is open.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5300 + Math.floor(Math.random() * 500), BASE = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
const eq = (a, b, m = "") => { if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const server = spawn(process.execPath, ["--max-old-space-size=4096", path.join(ROOT, "server.mjs")], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) } });
let log = "";
server.stdout.on("data", (d) => { log += d; });
server.stderr.on("data", (d) => { log += d; });
for (let k = 0; k < 120 && !log.includes("MNQ Chart Lab"); k++) await new Promise((r) => setTimeout(r, 250));

// A pretend page: an event stream, a state it posts, and an answer to "apply".
function openPage(apply) {
  const ctl = new AbortController();
  const ready = fetch(`${BASE}/api/chart/events`, { signal: ctl.signal }).then(async (res) => {
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let k;
          while ((k = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, k); buf = buf.slice(k + 2);
            const ev = /event: (\w+)/.exec(block), data = /data: (.*)/.exec(block);
            if (ev && ev[1] === "apply" && data) apply(JSON.parse(data[1]));
          }
        }
      } catch { /* closed */ }
    })();
  });
  return { ready, close: () => ctl.abort() };
}
const post = (p, body) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

console.log("\nchart link");
console.log("----------");
await t("with no page open, state and apply say so plainly", async () => {
  const s = await fetch(`${BASE}/api/chart/state`);
  eq(s.status, 404); if (!(await s.json()).error.includes("no chart page")) throw new Error("unclear error");
  eq((await post("/api/chart/apply", { exec: { contracts: 2 } })).status, 409);
});
let shown = { strategy: "orb", exec: { contracts: 8 }, window: { tradingDay: "2026-03-09" } };
const page = openPage((m) => {
  // apply as the page does: reject an unknown key, else merge and confirm
  if (m.exec && "contracs" in m.exec) { post("/api/chart/state", { ...shown, appliedId: m.id, applyError: "unknown exec key: contracs" }); return; }
  shown = { ...shown, ...(m.strategy ? { strategy: m.strategy } : {}), exec: { ...shown.exec, ...(m.exec || {}) }, ...(m.date ? { window: { tradingDay: m.date } } : {}) };
  post("/api/chart/state", { ...shown, appliedId: m.id });
});
await page.ready;
await t("a page's posted state is what chart_state reads", async () => {
  await post("/api/chart/state", shown);
  const s = await (await fetch(`${BASE}/api/chart/state`)).json();
  eq(s.strategy, "orb"); eq(s.exec.contracts, 8);
});
await t("apply reaches the page and answers with what it then shows", async () => {
  const r = await post("/api/chart/apply", { strategy: "donchian_shipped", exec: { contracts: 4 }, date: "2026-04-14" });
  eq(r.status, 200);
  const s = await r.json();
  eq(s.strategy, "donchian_shipped"); eq(s.exec.contracts, 4); eq(s.window.tradingDay, "2026-04-14");
  if (!s.appliedId) throw new Error("not the page's confirmation");
});
await t("a post from another site's page is refused", async () => {
  const r = await fetch(`${BASE}/api/chart/apply`, { method: "POST", headers: { "content-type": "text/plain", origin: "https://example.com" },
                                                       body: JSON.stringify({ exec: { contracts: 20 } }) });
  eq(r.status, 403);
  eq((await fetch(`${BASE}/api/chart/state`, { method: "POST", headers: { origin: "http://evil.localhost:5178" }, body: "{}" })).status, 403, "a look-alike host:");
});
await t("a change the page refuses comes back as an error", async () => {
  const r = await post("/api/chart/apply", { exec: { contracs: 3 } });
  eq(r.status, 400); if (!(await r.json()).error.includes("contracs")) throw new Error("the page's reason was lost");
});
await t("the sweep takes an eval and indicator studies, and refuses a bad study", async () => {
  const body = { strategyId: "donchian_shipped", eval: "1250", studies: [{ id: "s1", type: "emacross", tf: 10, params: { fast: 9, slow: 21 }, gate: "with" }, { id: "s2", type: "rsi" }] };
  const r = await (await post("/api/sweep", body)).json();
  eq(r.eval, "1250");
  eq(r.edge.length, 2); eq(r.edge[0].id, "s1"); eq(r.edge[0].gate, "with");
  if (!(r.studyGated > 0)) throw new Error("the gate refused nothing");
  if (!(r.summary.passRate > 0 && r.summary.passRate < 100)) throw new Error("no pass rate");
  const plain = await (await post("/api/sweep", { strategyId: "donchian_shipped", eval: "1250" })).json();
  if (plain.stats.n === r.stats.n) throw new Error("the gating study did not change the trades");
  eq((await post("/api/sweep", { strategyId: "donchian_shipped", studies: [{ type: "nope" }] })).status, 400, "a bad study:");
  eq((await post("/api/sweep", { strategyId: "donchian_shipped", eval: "999" })).status, 400, "a bad eval:");
});
await t("Tradovate indicators: listed with their tools, and read from their files", async () => {
  const lib = await (await fetch(`${BASE}/api/tradovate`)).json();
  if (!lib.mine.some((x) => x.name === "mnqDonchian1250" && x.minutes === 2)) throw new Error("no mnqDonchian1250 at 2 minutes");
  if (!lib.builtin.some((x) => x.name === "builtin:macd")) throw new Error("no built-ins");
  if (!lib.tools.EMA || !lib.tools.predef) throw new Error("no tools");
  const r = await (await fetch(`${BASE}/api/tradovate/source?name=mnqMacdFade1250`)).json();
  if (!r.source.includes("class mnqMacdFade1250")) throw new Error("not the file");
  eq((await fetch(`${BASE}/api/tradovate/source?name=..%2F..%2Fbot%2F.env`)).status, 404, "a path for a name:");
  eq((await fetch(`${BASE}/api/tradovate/source?name=nope`)).status, 404, "an unknown name:");
});
await t("the measured table is served for the strategy picker", async () => {
  const r = await (await fetch(`${BASE}/api/strategies/table`)).json();
  const row = r.rows.find((x) => x.id === "donchian_1250");
  if (!row || !(row.evals["1250"].pass2026OneTick > 0)) throw new Error("no rate for the book to beat");
});
await t("the page can load the mock, and static files stay inside their folders", async () => {
  eq((await fetch(`${BASE}/tradovate/mock/draw.mjs`)).status, 200);
  for (const p of ["/src/..%2fpackage.json", "/tradovate/mock/..%2f..%2fpackage.json", "/public/..%2f..%2f..%2fserver.mjs", "/tradovate/verify_1250.mjs"]) {
    eq((await fetch(BASE + p)).status, 404, `${p}:`);
  }
});
page.close();
await new Promise((r) => setTimeout(r, 300));
await t("once the page closes, the state is no longer offered as current", async () => {
  eq((await fetch(`${BASE}/api/chart/state`)).status, 404);
});

server.kill();
console.log(`\n${"=".repeat(64)}\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:"); for (const f of failures) console.log("  - " + f); console.log("\nserver log:\n" + log.slice(-1500)); }
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
