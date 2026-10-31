// The Data panel's routes, end to end: a real HTTP server, real uploads, and the real store.mjs in
// a process of its own, all on a temporary copy, so nothing here can touch the project's data.
//
//   node --disable-warning=ExperimentalWarning test/data_routes.test.mjs

import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dataRoutes } from "../src/datajobs.mjs";
import { dataNotes, heldRows, compareText, jobText } from "../public/ui.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), ".."), here = fs.mkdtempSync(path.join(os.tmpdir(), "data-routes-"));
const P = (...f) => path.join(here, ...f), uploads = (f = "") => P("data", "raw", "uploads", f), DAY = 86400000;
let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const has = (text, re, m = "") => { if (!re.test(text)) throw new Error(`${m} expected ${re}, got: ${text}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The project, as far as the store's commands need it.
fs.mkdirSync(P("src"));
for (const f of ["store.mjs", path.join("src", "store.mjs"), path.join("src", "series.mjs")]) fs.copyFileSync(path.join(ROOT, f), P(f));
fs.writeFileSync(P("store.config.json"), JSON.stringify({
  database: "data/store.db", backups: { dir: P("default backups"), keep: 2 },
  builds: {
    main: { root: "MNQ", sources: ["databento"], before: "2026-09-15", out: "data/main.bin", frozen: true },
    beta: { root: "MNQ", sources: ["databento", "topstepx"], out: "data/beta.bin" },
  },
}));

// The server's two helpers, as small as they can be.
function sendJson(res, code, obj) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }
const readBody = (req) => new Promise((resolve, reject) => {
  let s = "";
  req.on("data", (d) => { s += d; });
  req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});
function serve(options = {}, address = "127.0.0.1") {
  return new Promise((resolve) => {
    let route;
    const s = http.createServer((req, res) => route(req, res, new URL(req.url, "http://localhost")).catch((e) => sendJson(res, 500, { error: e.message })));
    s.listen(0, address, () => {
      s.port = s.address().port;
      route = dataRoutes({ here, port: s.port, sendJson, readBody, ...options });
      resolve(s);
    });
  });
}
const ask = (port, method, url, { body, headers = {}, host = "127.0.0.1" } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host, port, method, path: url, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
    let s = "";
    res.setEncoding("utf8");
    res.on("data", (d) => { s += d; });
    res.on("end", () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
  });
  req.on("error", reject);
  req.end(body);
});

const iso = (ms) => `${new Date(ms).toISOString().slice(0, 19)}.000000000Z`;
// An hour of bars on each weekday from Sep 7 2026, one contract.
function bars({ from = 0, days = 3, size = 1, symbol = "MNQZ6", add = 0, volume = 100 } = {}) {
  const out = [];
  for (let d = from; d < from + days; d++) {
    const ms = Date.UTC(2026, 8, 7) + d * DAY, wd = new Date(ms).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (let m = 0; m < 60; m += size) { const p = 25000 + d * 10 + add; out.push([ms + 13.5 * 3600000 + m * 60000, p, p + 2, p - 2, p + 1, volume, symbol]); }
  }
  return out;
}
const csv = (rows) => `${["ts_event,open,high,low,close,volume,symbol", ...rows.map(([t, ...r]) => `${iso(t)},${r.join()}`)].join("\n")}\n`;

const server = await serve(), port = server.port;
const status = async (p = port) => (await ask(p, "GET", "/api/data/status")).body;
const job = async (p = port) => (await ask(p, "GET", "/api/data/job")).body;
const finished = async (p = port) => { for (;;) { const j = await job(p); if (!j.running) return j; await sleep(15); } };
const run = (command, p = port) => ask(p, "POST", "/api/data/run", { body: JSON.stringify({ command }) });
const upload = (name, body, source = "databento", minutes = 1, p = port) => ask(p, "POST", `/api/data/upload?${new URLSearchParams({ name, source, minutes })}`, { body });
const pressed = async (command) => { eq((await run(command)).status, 202, `${command}:`); return finished(); };

await t("with no store yet, the panel says so, and a command explains itself", async () => {
  eq(await status(), { empty: true });
  eq(await job(), {}, "nothing has run:");
  const j = await pressed("backup");
  eq(j.exit, 1); has(j.lines.join(" "), /No store at/);
});

await t("only this computer's own pages get in", async () => {
  const post = (headers) => ask(port, "POST", "/api/data/run", { headers, body: `{"command":"backup"}` });
  const before = (await job()).id;
  eq((await post({ origin: "https://example.com" })).status, 403, "another web page:");
  eq((await post({ origin: `http://localhost:${port + 1}` })).status, 403, "another port here:");
  eq((await post({ origin: "null" })).status, 403, "a sandboxed page:");
  eq((await post({ host: "evil.example" })).status, 403, "a site pointing its name here:");
  eq((await post({ host: `localhost.evil.example:${port}` })).status, 403, "a name that starts the same:");
  eq((await ask(port, "GET", "/api/data/status", { headers: { origin: "https://example.com" } })).status, 403, "reading the status:");
  const up = await ask(port, "POST", "/api/data/upload?name=a.csv&source=databento&minutes=1", { headers: { origin: "https://example.com" }, body: "x" });
  eq(up.status, 403, "uploading:");
  eq(fs.existsSync(uploads()), false, "nothing written:");
  eq((await job()).id, before, "nothing ran:");
});

await t("another machine on the network is refused, whatever it says about itself", async () => {
  const ip = Object.values(os.networkInterfaces()).flat().find((a) => a.family === "IPv4" && !a.internal)?.address;
  if (!ip) return console.log("         (this computer has no network address to try from)");
  const open = await serve({}, "0.0.0.0");
  const r = await ask(open.port, "POST", "/api/data/run", { host: ip, headers: { origin: `http://localhost:${open.port}` }, body: `{"command":"backup"}` });
  open.close();
  eq(r.status, 403);
});

await t("a command has to be one of the buttons", async () => {
  const before = (await job()).id;
  for (const command of ["rm -rf", "add", "status", "constructor", "__proto__", "toString", 7, null, ["pull"], { pull: 1 }]) eq((await run(command)).status, 400, `${JSON.stringify(command)}:`);
  eq((await ask(port, "POST", "/api/data/run", { body: "null" })).status, 400, "null:");
  eq((await ask(port, "POST", "/api/data/run")).status, 400, "no body at all:");
  eq((await job()).id, before, "nothing ran:");
  eq((await ask(port, "GET", "/api/data/run")).status, 404, "a GET cannot start one:");
  eq((await ask(port, "GET", "/api/data/upload?name=a.csv")).status, 404);
  eq((await ask(port, "GET", "/api/data/nothing-here")).status, 404);
});

await t("an upload with no usable name, source or size writes nothing", async () => {
  for (const [q, why] of [["name=bot.env&source=databento&minutes=1", "not a CSV"], ["name=a.csv.zst&source=databento&minutes=1", "still compressed"], ["source=databento&minutes=1", "no name"],
    ["name=a.csv&source=elsewhere&minutes=1", "unknown source"], ["name=a.csv&minutes=1", "no source"], ["name=a.csv&source=databento&minutes=7", "unknown size"], ["name=a.csv&source=databento", "no size"]]) {
    eq((await ask(port, "POST", `/api/data/upload?${q}`, { body: "x" })).status, 400, `${why}:`);
  }
  eq(fs.existsSync(uploads()), false);
});

const first = csv(bars());
await t("a CSV goes in, a copy stays, and the status shows it", async () => {
  const r = await upload("first.ohlcv-1m.csv", first);
  eq(r.status, 202); eq(r.body.label, "Add first.ohlcv-1m.csv");
  const j = await finished();
  eq(j.exit, 0); has(j.lines.join(" "), /first\.ohlcv-1m\.csv: 180 rows, 180 new, 0 already held/);
  eq(fs.readFileSync(uploads("first.ohlcv-1m.csv"), "utf8"), first, "the copy is the file:");
  eq(fs.readdirSync(uploads()), ["first.ohlcv-1m.csv"], "no .part left:");
  const s = await status();
  eq(heldRows(s.sources)[0].slice(0, 4), ["databento", "1-minute", "180", "1"]);
  eq([s.imports, s.conflicts, s.megabytes >= 0, s.database], [1, 0, true, P("data", "store.db")]);
  eq(jobText(j).endsWith(" s"), true); has(jobText(j), /Add first\.ohlcv-1m\.csv: done/);
});

await t("the same file again changes nothing, and a different one of that name keeps both", async () => {
  await upload("first.ohlcv-1m.csv", first);
  has((await finished()).lines.join(" "), /already in the store/);
  eq(fs.readdirSync(uploads()), ["first.ohlcv-1m.csv"], "same name and size, one copy:");
  await upload("first.ohlcv-1m.csv", csv(bars({ from: 3, days: 1 })));
  eq((await finished()).exit, 0);
  eq(fs.readdirSync(uploads()).sort(), ["first.ohlcv-1m-2.csv", "first.ohlcv-1m.csv"]);
});

await t("a name from the browser cannot leave the uploads folder", async () => {
  for (const name of ["..\\..\\..\\outside.csv", "../../../outside.csv", "C:\\Windows\\outside.csv"]) {
    eq((await upload(name, csv(bars({ from: 4, days: 1 })))).status, 202, `${name}:`);
    await finished();
  }
  eq(fs.existsSync(P("outside.csv")), false); eq(fs.existsSync(P("data", "outside.csv")), false); eq(fs.existsSync(uploads("outside.csv")), true);
});

await t("a file the store refuses says why, adds nothing and is not kept", async () => {
  const held = (await status()).sources[0].rows;
  for (const [body, minutes, why] of [[csv(bars({ size: 5 })), 1, /looks like 5-minute bars, not 1-minute/], [csv(bars({ from: 10 })), 5, /whole 5-minute bars/], ["not a csv at all", 1, /no newline/], ["a,b\n1,2\n", 1, /missing a required column/], ["ts_event,open,high,low,close,volume,symbol\n", 1, /holds no bars/]]) {
    eq((await upload("refused.csv", body, "databento", minutes)).status, 202);
    const j = await finished();
    eq(j.exit, 1, `${why}:`); has(j.lines.join(" "), why); has(jobText(j), /stopped with an error/);
    eq(fs.existsSync(uploads("refused.csv")), false, "no copy left:");
  }
  eq((await status()).sources[0].rows, held, "no bars added:");
});

await t("a dropped upload leaves nothing, and starts nothing", async () => {
  const before = (await job()).id, part = uploads("dropped.csv.part"), c = net.connect(port, "127.0.0.1");
  c.on("error", () => {});
  c.write(`POST /api/data/upload?name=dropped.csv&source=databento&minutes=1 HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Length: 100000\r\n\r\nts_event,`);
  for (let k = 0; k < 300 && !fs.existsSync(part); k++) await sleep(10);
  eq(fs.existsSync(part), true, "it was under way:");
  c.destroy();
  for (let k = 0; k < 300 && fs.existsSync(part); k++) await sleep(10);
  eq(fs.existsSync(part), false, "no .part left:"); eq(fs.existsSync(uploads("dropped.csv")), false, "nothing that looks whole:");
  eq((await job()).id, before, "nothing ran:");
});

await t("Rebuild writes beta, and leaves the frozen file alone", async () => {
  const a = await pressed("build");
  eq(a.exit, 0); has(a.lines[0], /^main: written, 300 bars/); has(a.lines[1], /^beta: written/);
  const bytes = fs.readFileSync(P("data", "main.bin")), s = await status();
  eq(s.builds.map((b) => [b.name, b.frozen, b.stale]), [["main", true, false], ["beta", false, false]]);
  const b = await pressed("build");
  has(b.lines[0], /^main: unchanged/);
  eq(fs.readdirSync(P("data")).filter((f) => f.endsWith(".tmp")), [], "no temporary files:");
  eq(JSON.parse(fs.readFileSync(P("data", "beta.meta.json"), "utf8")).bars, 300, "a whole meta file:");
  // A bar that lands inside the frozen dates: it stays out, and the rest of the build still runs.
  await upload("late.ohlcv-1m.csv", csv(bars({ from: 4, days: 1, symbol: "MNQU6", volume: 500 })));
  await finished();
  const c = await pressed("build");
  eq(c.exit, 1); has(c.lines.join(" "), /main: refused/); has(c.lines.join(" "), /--force replaces it/); has(c.lines.join(" "), /beta: written/);
  eq(fs.readFileSync(P("data", "main.bin")).equals(bytes), true, "main not touched:");
});

await t("Back up copies the store, and the folder can be changed on the page", async () => {
  const j = await pressed("backup");
  eq(j.exit, 0); has(j.lines[0], /^Backed up 3\d\d bars/);
  eq(fs.readdirSync(P("default backups")).length, 1, "the default folder:");
  let s = await status();
  eq([s.backupDir, s.backup && s.backup.behind], [P("default backups"), false]);
  const save = (dir) => ask(port, "POST", "/api/data/backup-folder", { body: JSON.stringify({ dir }) });
  for (const bad of ["", "   ", "relative/folder", null]) eq((await save(bad)).status, 400, `${JSON.stringify(bad)}:`);
  eq(fs.existsSync(P("data", "store.settings.json")), false, "a bad folder saves nothing:");
  const to = P("Bob's backups (1)");
  eq((await save(to)).body, { backupDir: to });
  s = await status();
  eq([s.backupDir, s.backup], [to, null], "an empty folder has no backup:");
  has(dataNotes(s, s.now)[0].text, /No backup yet/);
  await pressed("backup");
  s = await status();
  eq([s.backupDir, s.backup && s.backup.behind], [to, false]);
  eq(fs.readdirSync(to).filter((f) => /^store_.*\.db$/.test(f)).length, 1);
  const home = [process.env.USERPROFILE, process.env.HOME];
  process.env.USERPROFILE = process.env.HOME = P("pretend home");
  eq((await save("~/mnq")).body, { backupDir: P("pretend home", "mnq") }, "a home-folder path:");
  [process.env.USERPROFILE, process.env.HOME] = home;
  eq((await save(to)).status, 200);
});

await t("the page can read everything the status says", async () => {
  fs.writeFileSync(P("topstepx.ohlcv-1m.csv"), csv(bars({ add: 0.25 })));
  await upload("topstepx.ohlcv-1m.csv", csv(bars({ add: 0.25 })), "topstepx");
  eq((await finished()).exit, 0);
  await upload("five.ohlcv-5m.csv", csv(bars({ size: 5 })), "topstepx", 5);
  eq((await finished()).exit, 0);
  const s = await status(), notes = dataNotes(s, s.pullBy + 3 * DAY);
  eq(heldRows(s.sources).map((r) => r.slice(0, 2)), [["databento", "1-minute"], ["topstepx", "1-minute"], ["topstepx", "5-minute"]]);
  has(compareText(s.compare), /^MNQZ6: 180 minutes in both sources, 0\.0% same prices, 100\.0% same volume, worst 0\.25 points$/);
  eq(s.pullBy, Date.UTC(2026, 8, 9, 14, 29) + 60 * DAY);
  has(notes.map((n) => n.text).join(" "), /rolling off for 3 days/);
  eq(typeof s.rolledOff, "number", "a count the notes can read:");
  has(notes.map((n) => n.text).join(" "), /Rebuild the binaries to use them in beta/);
});

// ── a command that holds on: one at a time, and what happens to an upload around it ──
const child = () => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); return c; };

await t("one command at a time, and nothing is uploaded while one runs", async () => {
  const kids = [], s = await serve({ run: () => { kids.push(child()); return kids[kids.length - 1]; } }), p = s.port;
  eq((await run("build", p)).status, 202);
  eq((await run("backup", p)).status, 409, "a second one:");
  eq((await run("backup", p)).body, { error: "Rebuild the binaries is still running" });
  eq((await upload("during.csv", "x", "databento", 1, p)).status, 409, "an upload:");
  eq(fs.existsSync(uploads("during.csv")), false, "and nothing written:");
  // Before a byte of it is sent: a 300 MB file should not cross only to be thrown away.
  const c = net.connect(p, "127.0.0.1");
  let said = "";
  c.on("data", (d) => { said += d; });
  c.write(`POST /api/data/upload?name=big.csv&source=databento&minutes=1 HTTP/1.1\r\nHost: localhost:${p}\r\nContent-Length: 100000\r\n\r\n`);
  for (let k = 0; k < 300 && !said; k++) await sleep(10);
  c.destroy();
  has(said, /^HTTP\/1\.1 409/, "with the file unsent:");
  kids[0].emit("close", 0);
  eq((await run("backup", p)).status, 202, "free again:");
  kids[1].emit("close", 0);
  s.close();
});

await t("a command that starts during an upload turns the upload away, and leaves no copy", async () => {
  const kids = [], s = await serve({ run: () => { kids.push(child()); return kids[kids.length - 1]; } }), p = s.port, c = net.connect(p, "127.0.0.1");
  let said = "";
  c.on("data", (d) => { said += d; });
  c.write(`POST /api/data/upload?name=race.csv&source=databento&minutes=1 HTTP/1.1\r\nHost: localhost:${p}\r\nContent-Length: 4\r\nConnection: close\r\n\r\nab`);
  const part = uploads("race.csv.part");
  for (let k = 0; k < 300 && !fs.existsSync(part); k++) await sleep(10);
  eq((await run("build", p)).status, 202);
  c.write("cd");
  for (let k = 0; k < 300 && !said; k++) await sleep(10);
  has(said, /^HTTP\/1\.1 409/);
  eq(fs.existsSync(uploads("race.csv")), false, "no copy:"); eq(fs.existsSync(part), false, "no .part:");
  kids[0].emit("close", 0);
  c.destroy(); s.close();
});

await t("a copy an earlier add relies on survives a later failure of the same file", async () => {
  let exit = 0;
  const s = await serve({ run: () => { const c = child(), code = exit; setImmediate(() => c.emit("close", code)); return c; } }), p = s.port;
  await upload("kept.csv", "same bytes", "databento", 1, p);
  await finished(p);
  eq(fs.existsSync(uploads("kept.csv")), true);
  exit = 1;
  await upload("kept.csv", "same bytes", "databento", 1, p);
  eq((await finished(p)).exit, 1);
  eq(fs.existsSync(uploads("kept.csv")), true, "it was there first:");
  await upload("lost.csv", "other bytes", "databento", 1, p);
  await finished(p);
  eq(fs.existsSync(uploads("lost.csv")), false, "this one was not:");
  s.close();
});

await t("a status read that goes wrong comes back as words, never as a hang", async () => {
  const replying = (say) => serve({ run: () => { const c = child(); setImmediate(() => say(c)); return c; } });
  const answer = async (say) => { const s = await replying(say), r = await status(s.port); s.close(); return r; };
  eq(await answer((c) => { c.stdout.write(`{"sources":[]}`); c.stdout.end(); c.emit("close", 0); }), { sources: [] });
  has((await answer((c) => { c.stdout.write("half a rep"); c.emit("close", 0); })).error, /JSON/, "not JSON:");
  eq(await answer((c) => { c.stderr.write("No store at C:\\x"); c.emit("close", 1); }), { empty: true });
  eq(await answer((c) => { c.stderr.write("disk full\n"); c.emit("close", 1); }), { error: "disk full" });
  eq(await answer((c) => c.emit("close", 3)), { error: "status exited 3" });
  eq(await answer((c) => c.emit("error", new Error("no node"))), { error: "no node" });
});

// ── the commands themselves, as a terminal runs them ──
const cli = (args, env = process.env) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", P("store.mjs"), ...args], { cwd: here, encoding: "utf8", env });

await t("store.mjs turns away anything that is not one of its commands", () => {
  for (const c of ["constructor", "__proto__", "toString", "nothing"]) { const r = cli([c]); eq(r.status, 1, `${c}:`); has(r.stderr, /Commands: add, pull, status, build, backup/); }
  const r = cli([]); eq(r.status, 1); has(r.stderr, /Commands:/);
  has(cli(["add"]).stderr, /Which file/);
  has(cli(["add", "x.csv", "--source", "elsewhere", "--minutes", "1"]).stderr, /No source called elsewhere/);
  has(cli(["add", "x.csv", "--source", "databento", "--minutes", "abc"]).stderr, /whole number of minutes/);
  has(cli(["build", "nothing"]).stderr, /No build called nothing/);
});

await t("store.mjs prints the same status a person reads", () => {
  const r = cli(["status"]);
  eq(r.status, 0); has(r.stdout, /databento\s+1m\s+\d+ bars/); has(r.stdout, /TopstepX: pull by/); has(r.stdout, /Databento against TopstepX, MNQZ6/);
});

const hasPython = spawnSync("python", ["--version"]).status === 0;
await t("Pull runs the pull script, then adds what it saved, even when the script fails", async () => {
  if (!hasPython) return console.log("         (no python here)");
  fs.mkdirSync(P("bot"), { recursive: true }); fs.mkdirSync(P("data", "raw", "topstepx"), { recursive: true });
  fs.writeFileSync(P("bot", "pull_topstepx_raw.py"), `import sys\nprint("the pull ran")\nsys.exit(int(open("exit.txt").read()))\n`);
  const save = (from) => { fs.writeFileSync(P("data", "raw", "topstepx", "mnq_ohlcv-1m.csv"), csv(bars({ from, days: 1, add: 0.25 }))); fs.writeFileSync(P("data", "raw", "topstepx", "mnq_ohlcv-5m.csv"), csv(bars({ from, days: 1, size: 5, add: 0.25 }))); };
  const rows = async () => (await status()).sources.find((r) => r.source === "topstepx" && r.minutes === 1).rows, was = await rows();
  fs.writeFileSync(P("exit.txt"), "0"); save(7);
  let j = await pressed("pull");
  eq(j.exit, 0, j.lines.join(" | ")); eq(j.lines[0], "the pull ran"); has(j.lines[1], /mnq_ohlcv-1m\.csv: 60 rows, 60 new/);
  eq(await rows(), was + 60);
  j = await pressed("pull");
  has(j.lines.join(" "), /mnq_ohlcv-1m\.csv: already in the store/);
  fs.writeFileSync(P("exit.txt"), "3"); save(8);
  j = await pressed("pull");
  eq(j.exit, 1); has(j.lines.join(" "), /did not finish cleanly/);
  eq(await rows(), was + 120, "what it did save is in the store:");
});

await t("Pull says so when Python cannot be found", () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k)));
  const r = cli(["pull"], { ...env, PATH: P("no-such-folder") });
  eq(r.status, 1); has(r.stderr, /Python did not start/);
});

server.close();
fs.rmSync(here, { recursive: true, force: true, maxRetries: 5 });
console.log(`\n${"=".repeat(64)}\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:"); for (const f of failures) console.log(`  - ${f}`); }
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
