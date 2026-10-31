// What lets the page run the store's commands. NODE-ONLY.
//
// Each command runs as its own process, the same store.mjs a terminal runs, so a 25-second build
// never holds up the chart and there is one way of doing each thing. One runs at a time, because
// the store takes one writer, and its output is kept for the page to read.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"], KEEP_LINES = 400;
const SOURCES = ["databento", "topstepx"], BAR_SIZES = [1, 5];
const BUTTONS = { pull: "Pull TopstepX bars", build: "Rebuild the binaries", backup: "Back up" };

// These routes read and write files, and server.mjs listens on every interface, so they answer
// only this computer, and only its own pages. The address stops another machine on the network,
// the Host stops a site that points its name here, and the Origin stops any other web page.
export function fromThisMachine(req, port) {
  if (!LOOPBACK.includes(req.socket.remoteAddress)) return false;
  const here = (u) => ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && Number(u.port || 80) === port;
  try {
    if (!here(new URL(`http://${req.headers.host}`))) return false;
    return !req.headers.origin || here(new URL(req.headers.origin));
  } catch { return false; }
}

// A name the browser sent, as a plain file name in a folder of ours.
export function csvName(name) {
  const base = path.posix.basename(String(name || "").replace(/\\/g, "/")).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!/\.csv$/i.test(base) || /^\.+/.test(base)) throw new Error("Choose a .csv file. A Databento download may need unzipping first.");
  return base;
}

// run(args) starts a process. job is the latest one, running or finished. done(job) is called
// once, when it has ended.
export class Jobs {
  constructor(run) { this.run = run; this.job = null; this.seq = 0; }
  get busy() { return !!(this.job && this.job.running); }

  start(label, args, done = () => {}) {
    if (this.busy) { const e = new Error(`${this.job.label} is still running`); e.busy = true; throw e; }
    const job = { id: ++this.seq, label, running: true, exit: null, lines: [], startedAt: Date.now(), endedAt: null };
    this.job = job;
    const say = (line) => { job.lines.push(line); if (job.lines.length > KEEP_LINES) job.lines.shift(); };
    // Each stream builds its own lines, so what stdout and stderr write at once cannot splice.
    const rest = ["", ""];
    const feed = (k) => (d) => { const parts = (rest[k] + d).replace(/\r/g, "").split("\n"); rest[k] = parts.pop(); for (const l of parts) say(l); };
    const end = (code) => {
      if (!job.running) return;
      for (const r of rest) if (r) say(r);
      job.running = false; job.exit = code; job.endedAt = Date.now();
      try { done(job); } catch (e) { say(e.message); }
    };
    let child;
    try { child = this.run(args); } catch (e) { say(e.message); end(1); return job; }
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", feed(0)); child.stderr.on("data", feed(1));
    child.on("error", (e) => { say(e.message); end(1); });
    child.on("close", (code) => end(code ?? 1));
    return job;
  }
}

const storeProcess = (here) => (args) => spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--max-old-space-size=8192", path.join(here, "store.mjs"), ...args], { cwd: here, windowsHide: true });

function storeStatus(run) {
  return new Promise((resolve) => {
    const child = run(["status", "--json"]);
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => resolve({ error: e.message }));
    child.on("close", (code) => {
      if (code === 0) { try { return resolve(JSON.parse(out)); } catch (e) { return resolve({ error: e.message }); } }
      resolve(/No store at/.test(err) ? { empty: true } : { error: err.trim() || `status exited ${code}` });
    });
  });
}

// The /api/data routes. here is the project's folder, sendJson and readBody are the server's, and
// run starts a store.mjs command: the tests point all of it at a temporary copy.
export function dataRoutes({ here, port, sendJson, readBody, run = storeProcess(here) }) {
  const jobs = new Jobs(run), stillRunning = () => ({ error: `${jobs.job.label} is still running` });

  // A CSV from the page, kept under data/raw/uploads, then added like any other. It goes to a
  // .part file first, so a dropped upload leaves nothing that looks whole, and a file the store
  // refuses is not kept, because it would look as if it had gone in.
  async function receiveCsv(req, res, url) {
    const source = url.searchParams.get("source"), minutes = Number(url.searchParams.get("minutes"));
    let name;
    try { name = csvName(url.searchParams.get("name")); } catch (e) { req.resume(); return sendJson(res, 400, { error: e.message }); }
    if (!SOURCES.includes(source) || !BAR_SIZES.includes(minutes)) { req.resume(); return sendJson(res, 400, { error: "Choose the source and the bar size" }); }
    if (jobs.busy) { req.resume(); return sendJson(res, 409, stillRunning()); }
    const dir = path.join(here, "data", "raw", "uploads"), size = Number(req.headers["content-length"]);
    fs.mkdirSync(dir, { recursive: true });
    let file = path.join(dir, name);
    for (let k = 2; fs.existsSync(file) && fs.statSync(file).size !== size; k++) file = path.join(dir, name.replace(/(\.csv)$/i, `-${k}$1`));
    const part = `${file}.part`, isNew = !fs.existsSync(file), drop = () => { if (isNew) fs.rmSync(file, { force: true }); };
    try { await pipeline(req, fs.createWriteStream(part)); }
    catch (e) { fs.rmSync(part, { force: true, maxRetries: 5 }); return res.destroyed ? undefined : sendJson(res, 400, { error: `The upload stopped: ${e.message}` }); }
    fs.renameSync(part, file);
    if (jobs.busy) { drop(); return sendJson(res, 409, stillRunning()); }
    return sendJson(res, 202, jobs.start(`Add ${name}`, ["add", file, "--source", source, "--minutes", String(minutes)], (j) => { if (j.exit) drop(); }));
  }

  function setBackupFolder(res, dir) {
    const d = String(dir || "").trim(), full = d.startsWith("~") ? path.join(os.homedir(), d.slice(1)) : d;
    if (!path.isAbsolute(full)) return sendJson(res, 400, { error: "Give the whole path of a folder" });
    fs.mkdirSync(full, { recursive: true });
    fs.mkdirSync(path.join(here, "data"), { recursive: true });
    fs.writeFileSync(path.join(here, "data", "store.settings.json"), JSON.stringify({ backupDir: full }, null, 2));
    return sendJson(res, 200, { backupDir: full });
  }

  return async (req, res, url) => {
    const p = url.pathname, posted = req.method === "POST";
    if (!fromThisMachine(req, port)) { req.resume(); return sendJson(res, 403, { error: "The data panel only works on the computer the lab runs on" }); }
    if (p === "/api/data/status") return sendJson(res, 200, await storeStatus(run));
    if (p === "/api/data/job") return sendJson(res, 200, jobs.job || {});
    if (posted && p === "/api/data/upload") return await receiveCsv(req, res, url);
    if (posted && p === "/api/data/backup-folder") return setBackupFolder(res, ((await readBody(req)) || {}).dir);
    if (posted && p === "/api/data/run") {
      const { command } = (await readBody(req)) || {};
      if (typeof command !== "string" || !Object.hasOwn(BUTTONS, command)) return sendJson(res, 400, { error: `No command called ${command}` });
      if (jobs.busy) return sendJson(res, 409, stillRunning());
      return sendJson(res, 202, jobs.start(BUTTONS[command], [command]));
    }
    return sendJson(res, 404, { error: "Not found" });
  };
}
