// The commands for the raw bar store (src/store.mjs). What gets built, and from which sources,
// is in store.config.json.
//
//   npm run data:add -- <file.csv> [more.csv] [--source databento|topstepx] [--minutes 1]
//   npm run data:pull                 TopstepX's latest bars, read-only, into the store
//   npm run data:status               what is held, what is missing, what needs doing
//   npm run data:build -- [main beta] [--force]
//   npm run data:backup -- [--to <folder>]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openStore, addFile, buildOne, statusOf, compareSources, backup } from "./src/store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(HERE, "store.config.json"), "utf8"));
const home = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
// The backup folder as set on the page, which stays on this computer, or the project's default.
const local = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, "data", "store.settings.json"), "utf8")); } catch { return {}; } })();
const dbFile = path.resolve(HERE, config.database), backupDir = home(local.backupDir || config.backups.dir);
const [cmd, ...argv] = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return undefined; const [, v] = argv.splice(i, 2); return v; };
const log = (m) => process.stdout.write(`${m}\n`);
const day = (ms) => new Date(ms).toISOString().slice(0, 10), minute = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const num = (n) => n.toLocaleString("en-US"), plural = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;
const report = (r) => log(r.skipped ? `  ${path.basename(r.file)}: already in the store` : `  ${path.basename(r.file)}: ${plural(r.rows, "row")}, ${num(r.added)} new, ${num(r.same)} already held${r.differ ? `, ${num(r.differ)} DIFFER from what is stored (kept as stored, see the conflicts table)` : ""}${r.unread ? `, ${plural(r.unread, "row")} could not be read` : ""}`);

function add() {
  const source = flag("--source"), minutes = flag("--minutes");
  if (!argv.length) throw new Error("Which file? npm run data:add -- <file.csv>");
  const db = openStore(dbFile);
  for (const f of argv) report(addFile(db, f, { source, minutes }));
  db.close();
  if (process.stdout.isTTY) log("Then: npm run data:build");
}

function pull() {
  const r = spawnSync("python", ["-u", path.join("bot", "pull_topstepx_raw.py")], { cwd: HERE, stdio: "inherit", windowsHide: true });
  if (r.error) throw new Error(`Python did not start: ${r.error.message}`);
  const db = openStore(dbFile);
  for (const f of ["mnq_ohlcv-1m.csv", "mnq_ohlcv-5m.csv"]) report(addFile(db, path.join(HERE, "data", "raw", "topstepx", f), { source: "topstepx" }));
  db.close();
  if (r.status !== 0) throw new Error("The pull did not finish cleanly: what it saved is in the store, and the rest needs another run");
}

function build() {
  const force = argv.includes("--force"), names = argv.filter((a) => !a.startsWith("--")), list = names.length ? names : Object.keys(config.builds);
  const db = openStore(dbFile, { readOnly: true });
  let refused = 0;
  for (const name of list) {
    if (!config.builds[name]) throw new Error(`No build called ${name}: ${Object.keys(config.builds).join(", ")}`);
    const r = buildOne(db, name, config.builds[name], { repo: HERE, force });
    log(`${name}: ${r.state}, ${num(r.bars)} bars, ${r.start.slice(0, 10)} to ${r.end.slice(0, 10)}, ${r.rollovers} rolls${r.holes.length ? `, ${r.holes.length} gap${r.holes.length > 1 ? "s" : ""}: ${r.holes.map((h) => `${h.after} to ${h.before} (${h.missing} weekdays)`).join(", ")}` : ""}`);
    if (r.state === "refused") { refused++; log(`  ${r.detail}. Every published figure was measured on it, so nothing was written. --force replaces it.`); }
  }
  db.close();
  if (refused) process.exitCode = 1;
}

// The folder a cloud copy would go in, offered on the page when this computer has OneDrive.
function cloudFolder() {
  const d = process.env.OneDrive || path.join(os.homedir(), "OneDrive");
  return fs.existsSync(d) ? path.join(d, "MNQ store backups") : null;
}

function status() {
  const db = openStore(dbFile, { readOnly: true }), s = statusOf(db, config, { backupDir, repo: HERE });
  if (argv.includes("--json")) {
    const compare = compareSources(db, "databento", "topstepx");
    db.close();
    log(JSON.stringify({ ...s, compare, database: dbFile, megabytes: Math.round(fs.statSync(dbFile).size / 1048576), backupDir, cloudFolder: cloudFolder(), now: Date.now() }));
    return;
  }
  log(`Store: ${dbFile} (${(fs.statSync(dbFile).size / 1048576).toFixed(0)} MB), ${s.imports} files added`);
  for (const r of s.sources) log(`  ${r.source.padEnd(10)} ${String(r.minutes).padStart(2)}m  ${num(r.rows).padStart(10)} bars  ${String(r.contracts).padStart(2)} contracts  ${minute(r.first)} to ${minute(r.last)} UTC`);
  log(s.conflicts ? `Conflicts: ${num(s.conflicts)} rows differ from what is stored` : "Conflicts: none");
  for (const b of s.builds) log(`Build ${b.name}: ${num(b.sessions)} sessions, ${b.holes.length ? `gaps: ${b.holes.map((h) => `${h.after} to ${h.before} (${h.missing} weekdays)`).join(", ")}` : "no gaps"}`);
  if (s.pullBy) {
    const left = Math.floor((s.pullBy - Date.now()) / 86400000);
    log(`TopstepX: pull by ${day(s.pullBy)} (${left} days) or bars start rolling off before they are saved`);
    if (s.rolledOff) log(`  ${plural(s.rolledOff, "bar")} ${s.rolledOff === 1 ? "has" : "have"} rolled off TopstepX and cannot be pulled again`);
  }
  log(s.backup ? `Backup: ${s.backup.file}${s.backup.behind ? ", older than the latest data" : ", up to date"}` : "Backup: none yet. npm run data:backup");
  for (const r of compareSources(db, "databento", "topstepx")) log(`Databento against TopstepX, ${r.symbol}: ${num(r.both)} minutes in both, ${(100 * r.samePrices / r.both).toFixed(1)}% same prices, ${(100 * r.sameVolume / r.both).toFixed(1)}% same volume, worst ${r.worst} points`);
  db.close();
}

function save() {
  const to = flag("--to"), db = openStore(dbFile, { readOnly: true }), r = backup(db, to ? home(to) : backupDir, config.backups.keep);
  db.close();
  log(`Backed up ${num(r.rows)} bars to ${r.file} (${(r.bytes / 1048576).toFixed(0)} MB)${r.removed.length ? `, removed ${r.removed.join(", ")}` : ""}`);
}

const COMMANDS = { add, pull, status, build, backup: save };
try {
  if (!Object.hasOwn(COMMANDS, cmd ?? "")) throw new Error(`Commands: ${Object.keys(COMMANDS).join(", ")}`);
  COMMANDS[cmd]();
} catch (e) { console.error(e.message); process.exitCode = 1; }
