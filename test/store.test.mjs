// The raw bar store (src/store.mjs).   node --disable-warning=ExperimentalWarning test/store.test.mjs
//
// Every file here is built for the purpose in a temporary folder. The one that matters most: a
// binary built from the store is byte for byte the binary built from the same CSVs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, addFile, readRows, buildOne, coverage, statusOf, compareSources, backup, sourceOf, minutesOf, TOPSTEPX_DAYS } from "../src/store.mjs";
import { SymbolTable, parseCsv, mergeFiles, buildSeries, holesOf, nyTradingDay } from "../src/series.mjs";
import { spawn } from "node:child_process";
import { Jobs, fromThisMachine, csvName } from "../src/datajobs.mjs";

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-test-"));
const P = (f) => path.join(dir, f);

// RTH bars on the weekdays of Sep 7-25 2026 (13:30-14:30 UTC), for two contracts in the same
// minutes, the second 290 points higher and busier from the 15th.
const iso = (ms) => `${new Date(ms).toISOString().slice(0, 19)}.000000000Z`, DAY = 86400000;
function rowsFor(days = 19) {
  const out = [];
  for (let d = 0; d < days; d++) {
    const ms = Date.UTC(2026, 8, 7) + d * DAY, wd = new Date(ms).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (let m = 0; m < 60; m++) {
      const t = ms + 13.5 * 3600000 + m * 60000, p = 25000 + d * 10 + (m % 7);
      out.push([t, p, p + 2, p - 2, p + 1, d >= 8 ? 50 : 500, "MNQU6"]);
      out.push([t, p + 290, p + 292, p + 288, p + 291, d >= 8 ? 500 : 50, "MNQZ6"]);
    }
  }
  return out;
}
const csv = (file, rows, extra = []) => {
  const lines = ["ts_event,open,high,low,close,volume,symbol", ...rows.map(([t, o, h, l, c, v, s]) => `${iso(t)},${o},${h},${l},${c},${v},${s}`), ...extra];
  fs.writeFileSync(P(file), `${lines.join("\n")}\n`);
  return P(file);
};
const fromCsv = (files) => { const syms = new SymbolTable(), runs = files.map((f) => parseCsv(fs.readFileSync(f), f, syms)), r = runs.length > 1 ? mergeFiles(runs) : runs[0]; return buildSeries(r, syms.names); };
const MAIN = { root: "MNQ", sources: ["databento"], out: "main.bin", frozen: true }, BETA = { root: "MNQ", sources: ["databento", "topstepx"], out: "beta.bin" };

const all = rowsFor(), half = all.filter(([t]) => t < Date.UTC(2026, 8, 17)), rest = all.filter(([t]) => t >= Date.UTC(2026, 8, 14));
const a = csv("a.ohlcv-1m.csv", half, [`${iso(Date.UTC(2026, 8, 8, 14))},290,291,289,290,5,MNQU6-MNQZ6`]), b = csv("b.ohlcv-1m.csv", rest);
const db = openStore(P("store.db"));

t("a file goes in, calendar spreads stay out, and the same file twice is a no-op", () => {
  const r = addFile(db, a, { source: "databento" });
  eq([r.rows, r.added, r.same, r.differ], [half.length, half.length, 0, 0]);
  eq(addFile(db, a, { source: "databento" }).skipped, true);
  eq(db.prepare("SELECT count(*) AS n FROM bars").get().n, half.length);
  eq(db.prepare("SELECT count(*) AS n FROM contracts").get().n, 2, "no spread contract:");
});
t("an overlapping file adds only what is new", () => {
  const r = addFile(db, b, { source: "databento" }), both = rest.filter(([t]) => t < Date.UTC(2026, 8, 17)).length;
  eq([r.added, r.same, r.differ], [rest.length - both, both, 0]);
  eq(db.prepare("SELECT count(*) AS n FROM bars").get().n, all.length);
});
t("a binary built from the store is byte for byte the one built from the same CSVs", () => {
  const { rows, names } = readRows(db, MAIN), s = buildSeries(rows, names), c = fromCsv([a, b]);
  eq(s.out.equals(c.out), true, "the bytes:");
  eq(s.meta.rollovers, c.meta.rollovers, "the rolls:");
  eq(s.meta.rollovers.length, 1);
});
t("a bar that differs is reported and never replaces what is stored", () => {
  const [row] = rest, f = csv("c.ohlcv-1m.csv", [[row[0], row[1], row[2], row[3], row[4] + 0.25, row[5], row[6]]]);
  const r = addFile(db, f, { source: "databento" });
  eq([r.added, r.same, r.differ], [0, 0, 1]);
  eq(db.prepare("SELECT count(*) AS n FROM conflicts").get().n, 1);
  const c = db.prepare("SELECT b.c FROM bars b JOIN contracts k ON k.id = b.contract WHERE k.symbol = ? AND b.ts = ?").get(row[6], row[0]).c;
  eq(c, row[4], "stored close:");
});
t("sources keep their own rows, and the first listed wins a shared minute", () => {
  const t0 = Date.UTC(2026, 8, 25, 14, 30), shared = rest[1], f = csv("topstepx.ohlcv-1m.csv", [[shared[0], 1, 2, 0.5, 1.5, 7, shared[6]], [t0, 25200, 25201, 25199, 25200, 900, "MNQZ6"]]);
  eq(addFile(db, f).added, 2);
  const { rows } = readRows(db, BETA), at = rows.ts.findIndex((x, i) => x === shared[0] && rows.vol[i] === shared[5]);
  if (at < 0) throw new Error("Databento's row is gone");
  eq(Array.from(rows.vol.subarray(0, rows.n)).includes(7), false, "TopstepX's copy of a shared minute:");
  eq(Array.from(rows.ts.subarray(0, rows.n)).includes(t0), true, "a minute only TopstepX has:");
  eq(readRows(db, MAIN).rows.n, all.length, "the Databento build ignores it:");
});
t("sources are compared minute by minute", () => {
  const [r] = compareSources(db, "databento", "topstepx");
  eq([r.both, r.samePrices, r.sameVolume], [1, 0, 0]);
  if (!(r.worst > 1000)) throw new Error(`worst difference ${r.worst}`);
});
t("a build can stop at a date, whatever was added after it", () => {
  const { rows } = readRows(db, { ...MAIN, before: "2026-09-16" });
  eq(rows.n, all.filter(([x]) => x < Date.UTC(2026, 8, 16)).length);
});
t("a frozen build is compared, and a difference is refused unless forced", () => {
  const o = { repo: dir }, first = buildOne(db, "main", MAIN, o);
  eq(first.state, "written");
  eq(buildOne(db, "main", MAIN, o).state, "unchanged");
  const stamp = fs.statSync(P("main.meta.json")).mtimeMs;
  const r = buildOne(db, "main", { ...MAIN, before: "2026-09-16" }, o);
  eq(r.state, "refused"); eq(fs.statSync(P("main.meta.json")).mtimeMs, stamp, "nothing written:");
  eq(buildOne(db, "main", { ...MAIN, before: "2026-09-16" }, { ...o, force: true }).state, "written");
  eq(buildOne(db, "beta", BETA, o).state, "written"); eq(buildOne(db, "beta", BETA, o).state, "written", "an unfrozen build just rebuilds:");
  const m = JSON.parse(fs.readFileSync(P("beta.meta.json"), "utf8"));
  eq(m.sourceOrder, ["databento", "topstepx"]); eq(m.sources.length, 4); eq(m.source, m.sources[3]);
});
t("gaps: one missing weekday is a holiday, two are bars we do not have", () => {
  const d = (y, m, dd) => Math.floor(Date.UTC(y, m - 1, dd) / DAY);
  eq(holesOf([d(2026, 9, 3), d(2026, 9, 7)]), [], "Thu to Mon, the Friday a holiday:");
  eq(holesOf([d(2026, 9, 4), d(2026, 9, 7)]), [], "a weekend:");
  eq(holesOf([d(2026, 9, 2), d(2026, 9, 7)]), [{ after: "2026-09-02", before: "2026-09-07", missing: 2 }]);
  const f = csv("late.ohlcv-1m.csv", [[Date.UTC(2026, 9, 12, 14), 25000, 25001, 24999, 25000, 10, "MNQZ6"]]);
  addFile(db, f, { source: "databento" });
  eq(coverage(db, MAIN).holes.length, 1, "seen from the store:");
  eq(coverage(db, { ...MAIN, before: "2026-09-16" }).holes, [], "and not past where a build stops:");
});
t("a session count hops the store, and passes no session on the way", () => {
  const c = openStore(P("hops.db")), at = (y, m, d, h, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
  const summer = [at(2026, 7, 6, 13), at(2026, 7, 6, 20, 59), at(2026, 7, 6, 21), at(2026, 7, 6, 22), at(2026, 7, 7, 20, 59), at(2026, 7, 7, 21)];
  const winter = [at(2026, 12, 7, 14), at(2026, 12, 7, 21, 59), at(2026, 12, 7, 22), at(2026, 12, 8, 21, 30), at(2026, 12, 8, 22, 30)];
  const held = [...summer, ...winter];
  addFile(c, csv("hops.ohlcv-1m.csv", held.map((x) => [x, 100, 101, 99, 100, 5, "MNQZ6"])), { source: "databento" });
  const days = new Set(held.map((x) => nyTradingDay(x)));
  eq(coverage(c, MAIN).sessions, days.size, "every bar read:");
  eq(days.size, 6);
  eq(coverage(c, { ...MAIN, before: "2026-08-01" }).sessions, 3, "summer alone:");
  c.close();
});
t("status names the deadline and what only we hold", () => {
  const now = Date.UTC(2026, 11, 15), s = statusOf(db, { builds: { main: MAIN } }, { now });
  eq(s.pullBy, Date.UTC(2026, 8, 25, 14, 30) + TOPSTEPX_DAYS * DAY);
  eq(s.onlyHere, 2); eq(s.conflicts, 1); eq(s.builds[0].holes.length, 1);
});
t("a file that adds nothing is not new data", () => {
  const was = statusOf(db, { builds: {} }).lastAdded;
  eq(addFile(db, csv("again.ohlcv-1m.csv", rowsFor().slice(0, 2)), { source: "databento" }).added, 0);
  eq(statusOf(db, { builds: {} }).lastAdded, was);
});
t("a backup is a checked copy, and only the newest are kept", () => {
  const to = P("backups"), day = (d) => new Date(Date.UTC(2026, 10, d));
  for (const d of [1, 2, 3, 4]) backup(db, to, 3, day(d));
  eq(fs.readdirSync(to).sort(), ["store_2026-11-02.db", "store_2026-11-03.db", "store_2026-11-04.db"]);
  const c = openStore(path.join(to, "store_2026-11-04.db"), { readOnly: true });
  eq(c.prepare("SELECT count(*) AS n FROM bars").get().n, db.prepare("SELECT count(*) AS n FROM bars").get().n);
  c.close();
});
t("a file's source and bar size are read from its name, or it stops", () => {
  eq(sourceOf("x/glbx-mdp3-2026.ohlcv-1m.csv"), "databento"); eq(sourceOf("data/raw/topstepx/mnq.csv"), "topstepx"); eq(sourceOf("mystery.csv", "databento"), "databento");
  eq(minutesOf("mnq_ohlcv-5m.csv"), 5); eq(minutesOf("mystery.csv", "1"), 1);
  for (const fn of [() => sourceOf("mystery.csv"), () => minutesOf("mystery.csv")]) { let threw = false; try { fn(); } catch { threw = true; } eq(threw, true); }
});

t("the page's commands answer only this computer and its own pages", () => {
  const ask = (ip, host, origin) => fromThisMachine({ socket: { remoteAddress: ip }, headers: { host, ...(origin ? { origin } : {}) } }, 5178);
  eq(ask("127.0.0.1", "localhost:5178"), true, "a tool here:");
  eq(ask("::1", "127.0.0.1:5178", "http://localhost:5178"), true, "the page:");
  eq(ask("::ffff:127.0.0.1", "localhost:5178", "http://127.0.0.1:5178"), true, "the page, by address:");
  eq(ask("192.168.1.20", "192.168.1.5:5178"), false, "another machine on the network:");
  eq(ask("192.168.1.20", "localhost:5178", "http://localhost:5178"), false, "another machine saying it is local:");
  eq(ask("127.0.0.1", "evil.example:5178"), false, "a site pointing its name here:");
  eq(ask("127.0.0.1", "localhost:5178", "https://evil.example"), false, "another web page:");
  eq(ask("127.0.0.1", "localhost:5178", "http://localhost:9999"), false, "another port:");
  eq(ask("127.0.0.1", "localhost:5178", "null"), false, "a sandboxed page:");
});
t("an uploaded name becomes a plain file name, and only a CSV", () => {
  eq(csvName("glbx-mdp3-2026.ohlcv-1m.csv"), "glbx-mdp3-2026.ohlcv-1m.csv");
  eq(csvName("C:\\Users\\me\\bars.csv"), "bars.csv"); eq(csvName("../../bars.csv"), "bars.csv"); eq(csvName("my bars (1).csv"), "my_bars__1_.csv");
  for (const bad of ["../../bot/.env", "bars.zip", "bars.csv.zst", ".csv", "..csv", "", null]) { let threw = false; try { csvName(bad); } catch { threw = true; } eq(threw, true, `${bad}:`); }
});

// A command as the server runs one: its own process, its output kept, one at a time.
const jobs = new Jobs((args) => spawn(process.execPath, ["-e", args[0]])), done = async () => { while (jobs.busy) await new Promise((r) => setTimeout(r, 20)); };
const first = jobs.start("first", ["console.log('one'); console.error('two'); process.stdout.write('three')"]);
let refused = null;
try { jobs.start("second", ["0"]); } catch (e) { refused = e; }
await done();
const firstLines = first.lines.slice().sort();
const broke = jobs.start("broke", ["console.log('half'); process.exit(3)"]);
await done();
const none = new Jobs(() => spawn("no-such-program-here")), lost = none.start("lost", []);
while (none.busy) await new Promise((r) => setTimeout(r, 20));
t("one command runs at a time, and its output and exit are kept", () => {
  eq(refused && refused.busy, true, "a second while one runs:");
  eq(firstLines, ["one", "three", "two"], "both streams, and a last line with no newline:");
  eq([first.running, first.exit, first.id], [false, 0, 1]);
  eq([broke.exit, broke.lines, broke.id], [3, ["half"], 2], "a failure:");
  eq(lost.exit, 1, "a program that is not there:");
  eq(jobs.job.id, 2, "the latest is kept:");
});

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${"=".repeat(64)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(64)}`);
for (const f of failures) console.log(`  - ${f}`);
process.exitCode = fail ? 1 : 0;
