// What lets the page run the store's commands. NODE-ONLY.
//
// Each command runs as its own process, the same store.mjs a terminal runs, so a 25-second build
// never holds up the chart and there is one way of doing each thing. One runs at a time, because
// the store takes one writer, and its output is kept for the page to read.

import path from "node:path";

const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"], KEEP_LINES = 400;

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
  const base = path.basename(String(name || "").replace(/\\/g, "/")).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!/\.csv$/i.test(base) || /^\.+/.test(base)) throw new Error("Choose a .csv file. A Databento download may need unzipping first.");
  return base;
}

// run(args) starts a process. job is the latest one, running or finished.
export class Jobs {
  constructor(run) { this.run = run; this.job = null; this.seq = 0; }
  get busy() { return !!(this.job && this.job.running); }

  start(label, args) {
    if (this.busy) { const e = new Error(`${this.job.label} is still running`); e.busy = true; throw e; }
    const job = { id: ++this.seq, label, running: true, exit: null, lines: [], startedAt: Date.now(), endedAt: null };
    this.job = job;
    let rest = "";
    const say = (line) => { job.lines.push(line); if (job.lines.length > KEEP_LINES) job.lines.shift(); };
    const feed = (d) => { const parts = (rest + d).replace(/\r/g, "").split("\n"); rest = parts.pop(); for (const l of parts) say(l); };
    const end = (code) => { if (!job.running) return; if (rest) say(rest); rest = ""; job.running = false; job.exit = code; job.endedAt = Date.now(); };
    const child = this.run(args);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", feed); child.stderr.on("data", feed);
    child.on("error", (e) => { say(e.message); end(1); });
    child.on("close", (code) => end(code ?? 1));
    return job;
  }
}
