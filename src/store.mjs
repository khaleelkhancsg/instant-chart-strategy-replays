// The raw bar store. NODE-ONLY, and the engine never reads it.
//
// Every bar we have been given, as it came: one row per source, contract, bar size and minute,
// on the contract's own prices, with nothing spliced. Backtests read the binary built from it,
// so they run at the same speed. Reading all of this back takes seconds; the binary takes
// milliseconds. That is why it is a store and not a data source.
//
// SQLite, because the sources overlap. TopstepX pulls overlap each other and will overlap
// Databento, so a row has to be found by its key, a repeat ignored, and a difference kept where
// it can be seen. A bar already stored is never replaced: if a later file disagrees, the row
// stays and the disagreement goes in the conflicts table.
//
// See store.mjs for the commands and store.config.json for what gets built.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SymbolTable, parseCsv, buildSeries, holesOf, nyTradingDay } from "./series.mjs";

const DAY = 86400000;
export const TOPSTEPX_DAYS = 60;           // how far back TopstepX serves 1- and 5-minute bars

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sources(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
  CREATE TABLE IF NOT EXISTS contracts(id INTEGER PRIMARY KEY, symbol TEXT UNIQUE NOT NULL);
  CREATE TABLE IF NOT EXISTS bars(
    source INTEGER NOT NULL, contract INTEGER NOT NULL, minutes INTEGER NOT NULL, ts INTEGER NOT NULL,
    o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v INTEGER NOT NULL,
    PRIMARY KEY(source, contract, minutes, ts)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS imports(
    id INTEGER PRIMARY KEY, source INTEGER NOT NULL, file TEXT NOT NULL, sha256 TEXT NOT NULL, minutes INTEGER NOT NULL,
    rows INTEGER NOT NULL, added INTEGER NOT NULL, same INTEGER NOT NULL, differ INTEGER NOT NULL,
    first_ts INTEGER, last_ts INTEGER, at INTEGER NOT NULL, UNIQUE(source, sha256));
  CREATE TABLE IF NOT EXISTS conflicts(
    import INTEGER NOT NULL, contract INTEGER NOT NULL, minutes INTEGER NOT NULL, ts INTEGER NOT NULL,
    o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v INTEGER NOT NULL,
    PRIMARY KEY(import, contract, minutes, ts)) WITHOUT ROWID;`;

export function openStore(file, { readOnly = false } = {}) {
  if (readOnly && !fs.existsSync(file)) throw new Error(`No store at ${file}. Start one with: npm run data:add -- <csv>`);
  if (!readOnly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { readOnly });
  if (!readOnly) db.exec(`PRAGMA page_size = 8192; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; ${SCHEMA}`);
  return db;
}

const idOf = (db, table, col, value) => {
  const r = db.prepare(`SELECT id FROM ${table} WHERE ${col} = ?`).get(value);
  return r ? r.id : Number(db.prepare(`INSERT INTO ${table}(${col}) VALUES (?)`).run(value).lastInsertRowid);
};

// What a file holds, from its name unless told. A guess that could be wrong stops the import.
export function sourceOf(file, given) {
  if (given) return given;
  if (/topstepx/i.test(file)) return "topstepx";
  if (/glbx|databento/i.test(file)) return "databento";
  throw new Error(`Cannot tell where ${path.basename(file)} came from: add --source databento or --source topstepx`);
}
export function minutesOf(file, given) {
  if (given) return Number(given);
  const m = /ohlcv-(\d+)m/i.exec(path.basename(file));
  if (m) return Number(m[1]);
  throw new Error(`Cannot tell the bar size of ${path.basename(file)}: add --minutes 1`);
}

// One CSV into the store, in one transaction. The same file twice is a no-op.
export function addFile(db, file, { source, minutes, log = () => {} } = {}) {
  const name = sourceOf(file, source), size = minutesOf(file, minutes), sid = idOf(db, "sources", "name", name);
  const buf = fs.readFileSync(file), sha = crypto.createHash("sha256").update(buf).digest("hex");
  if (db.prepare("SELECT 1 FROM imports WHERE source = ? AND sha256 = ?").get(sid, sha)) return { file, source: name, minutes: size, skipped: true, rows: 0, added: 0, same: 0, differ: 0 };
  const syms = new SymbolTable(), r = parseCsv(buf, path.basename(file), syms, log), ids = syms.names.map((s) => idOf(db, "contracts", "symbol", s));
  const ins = db.prepare("INSERT INTO bars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING");
  const get = db.prepare("SELECT o, h, l, c, v FROM bars WHERE source = ? AND contract = ? AND minutes = ? AND ts = ?");
  const clash = db.prepare("INSERT OR IGNORE INTO conflicts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const at = Date.now(), res = { file, source: name, minutes: size, rows: r.n, added: 0, same: 0, differ: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    const imp = Number(db.prepare("INSERT INTO imports(source, file, sha256, minutes, rows, added, same, differ, first_ts, last_ts, at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)")
      .run(sid, path.resolve(file), sha, size, r.n, r.n ? r.ts[0] : null, r.n ? r.ts[r.n - 1] : null, at).lastInsertRowid);
    for (let i = 0; i < r.n; i++) {
      const c = ids[r.sym[i]], t = r.ts[i], o = r.op[i], h = r.hi[i], l = r.lo[i], x = r.cl[i], v = r.vol[i];
      if (Number(ins.run(sid, c, size, t, o, h, l, x, v).changes)) { res.added++; continue; }
      const s = get.get(sid, c, size, t);
      if (s.o === o && s.h === h && s.l === l && s.c === x && s.v === v) res.same++;
      else { res.differ++; clash.run(imp, c, size, t, o, h, l, x, v); }
    }
    db.prepare("UPDATE imports SET added = ?, same = ?, differ = ? WHERE id = ?").run(res.added, res.same, res.differ, imp);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return res;
}

const rootIds = (db, root) => db.prepare("SELECT id, symbol FROM contracts").all().filter((c) => new RegExp(`^${root}[A-Z]\\d{1,2}$`).test(c.symbol)).map((c) => c.id);
const sourceIds = (db, names) => names.map((n) => db.prepare("SELECT id FROM sources WHERE name = ?").get(n)).filter(Boolean).map((r) => r.id);

// The rows of a build, sorted, in the shape src/series.mjs takes. Where sources share a minute of
// a contract, the one listed first wins, so bought data replaces what filled in for it.
export function readRows(db, build) {
  const names = [];
  for (const c of db.prepare("SELECT id, symbol FROM contracts").all()) names[c.id] = c.symbol;
  const src = sourceIds(db, build.sources), con = rootIds(db, build.root), before = build.before ? Date.parse(`${build.before}T00:00:00Z`) : Number.MAX_SAFE_INTEGER;
  if (!src.length || !con.length) throw new Error(`Nothing in the store for ${build.root} from ${build.sources.join(", ")}`);
  const where = `minutes = 1 AND source IN (${src.join()}) AND contract IN (${con.join()}) AND ts < ?`, rank = `CASE source ${src.map((s, k) => `WHEN ${s} THEN ${k}`).join(" ")} END`;
  const cap = db.prepare(`SELECT count(*) AS n FROM bars WHERE ${where}`).get(before).n;
  const ts = new Float64Array(cap), op = new Float32Array(cap), hi = new Float32Array(cap), lo = new Float32Array(cap), cl = new Float32Array(cap), vol = new Float32Array(cap), sym = new Int16Array(cap);
  const q = db.prepare(`SELECT ts, contract, o, h, l, c, v FROM bars WHERE ${where} ORDER BY ts, contract, ${rank}`);
  q.setReturnArrays(true);
  let n = 0, lastT = -1, lastC = -1;
  for (const [t, c, o, h, l, x, v] of q.iterate(before)) {
    if (t === lastT && c === lastC) continue;
    lastT = t; lastC = c;
    ts[n] = t; sym[n] = c; op[n] = o; hi[n] = h; lo[n] = l; cl[n] = x; vol[n] = v; n++;
  }
  return { rows: { ts, op, hi, lo, cl, vol, sym, n }, names };
}

// One binary and its meta. A frozen build never changes silently: it is rebuilt and compared,
// and a difference is refused, because every published figure was measured on that file.
export function buildOne(db, name, build, { repo = ".", force = false, log = () => {} } = {}) {
  const { rows, names } = readRows(db, build), { out, meta } = buildSeries(rows, names, log), file = path.resolve(repo, build.out);
  const res = { name, file, bars: meta.bars, start: meta.start, end: meta.end, rollovers: meta.rollovers.length, holes: meta.holes };
  if (build.frozen && fs.existsSync(file)) {
    const old = fs.readFileSync(file);
    if (old.equals(out)) return { ...res, state: "unchanged" };
    if (!force) return { ...res, state: "refused", detail: `${build.out} is ${old.length.toLocaleString()} bytes and the rebuild ${out.length.toLocaleString()}, and they differ` };
  }
  const src = sourceIds(db, build.sources), files = db.prepare(`SELECT file FROM imports WHERE minutes = 1 AND source IN (${src.join()}) ORDER BY id`).all().map((r) => r.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, out);
  fs.renameSync(`${file}.tmp`, file);
  fs.writeFileSync(file.replace(/\.bin$/, ".meta.json"), JSON.stringify({ build: name, source: files[files.length - 1], sources: files, sourceOrder: build.sources, before: build.before || null, ...meta }, null, 2));
  return { ...res, state: "written" };
}

// The sessions a set of sources covers, from which hours have bars, and the gaps in them.
export function coverage(db, build) {
  const src = sourceIds(db, build.sources), con = rootIds(db, build.root);
  if (!src.length || !con.length) return { sessions: 0, holes: [] };
  const hours = db.prepare(`SELECT DISTINCT ts / 3600000 AS h FROM bars WHERE minutes = 1 AND source IN (${src.join()}) AND contract IN (${con.join()})`).all();
  const days = [...new Set(hours.map((r) => nyTradingDay(r.h * 3600000)))].sort((a, b) => a - b);
  return { sessions: days.length, holes: holesOf(days) };
}

// Everything `status` prints.
export function statusOf(db, config, { now = Date.now(), backupDir } = {}) {
  const sources = db.prepare(`SELECT s.name AS source, b.minutes, count(*) AS rows, count(DISTINCT b.contract) AS contracts, min(b.ts) AS first, max(b.ts) AS last
                              FROM bars b JOIN sources s ON s.id = b.source GROUP BY s.name, b.minutes ORDER BY s.id, b.minutes`).all();
  const conflicts = db.prepare("SELECT count(*) AS n FROM conflicts").get().n, imports = db.prepare("SELECT count(*) AS n, max(at) AS last FROM imports").get();
  const tsx = sources.find((s) => s.source === "topstepx" && s.minutes === 1), oldest = tsx ? now - TOPSTEPX_DAYS * DAY : null;
  const onlyHere = tsx ? db.prepare("SELECT count(*) AS n FROM bars WHERE source = (SELECT id FROM sources WHERE name = 'topstepx') AND minutes = 1 AND ts < ?").get(oldest).n : 0;
  let backup = null;
  if (backupDir && fs.existsSync(backupDir)) {
    const f = fs.readdirSync(backupDir).filter((x) => /^store_\d{4}-\d{2}-\d{2}\.db$/.test(x)).sort().pop();
    if (f) { const st = fs.statSync(path.join(backupDir, f)); backup = { file: f, at: st.mtimeMs, behind: st.mtimeMs < imports.last }; }
  }
  return { sources, conflicts, imports: imports.n, pullBy: tsx ? tsx.last + TOPSTEPX_DAYS * DAY : null, onlyHere, backup, builds: Object.entries(config.builds).map(([name, b]) => ({ name, ...coverage(db, b) })) };
}

// Minute by minute, where two sources both have a contract: how often they agree exactly.
export function compareSources(db, a, b) {
  const [x, y] = sourceIds(db, [a, b]);
  if (!x || !y) return [];
  return db.prepare(`SELECT c.symbol, count(*) AS both, sum(p.o = q.o AND p.h = q.h AND p.l = q.l AND p.c = q.c) AS samePrices, sum(p.v = q.v) AS sameVolume,
                            max(max(abs(p.o - q.o), abs(p.h - q.h), abs(p.l - q.l), abs(p.c - q.c))) AS worst
                     FROM bars p JOIN bars q ON q.source = ${y} AND q.contract = p.contract AND q.minutes = p.minutes AND q.ts = p.ts JOIN contracts c ON c.id = p.contract
                     WHERE p.source = ${x} AND p.minutes = 1 GROUP BY c.symbol ORDER BY min(p.ts)`).all();
}

// A consistent copy, checked, and only the newest few kept.
export function backup(db, dir, keep = 3, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `store_${now.toISOString().slice(0, 10)}.db`), tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const copy = new DatabaseSync(tmp, { readOnly: true }), rows = copy.prepare("SELECT count(*) AS n FROM bars").get().n, ok = copy.prepare("PRAGMA quick_check").get().quick_check;
  copy.close();
  const want = db.prepare("SELECT count(*) AS n FROM bars").get().n;
  if (ok !== "ok" || rows !== want) { fs.rmSync(tmp, { force: true }); throw new Error(`The backup failed its check: ${ok}, ${rows} rows of ${want}`); }
  fs.renameSync(tmp, file);
  const old = fs.readdirSync(dir).filter((x) => /^store_\d{4}-\d{2}-\d{2}\.db$/.test(x)).sort().reverse().slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f));
  return { file, rows, bytes: fs.statSync(file).size, removed: old };
}
