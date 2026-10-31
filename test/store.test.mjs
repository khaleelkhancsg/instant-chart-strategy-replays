// The raw bar store (src/store.mjs).   node --disable-warning=ExperimentalWarning test/store.test.mjs
//
// Every file here is built for the purpose in a temporary folder. The one that matters most: a
// binary built from the store is byte for byte the binary built from the same CSVs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, addFile, fileProblem, readRows, buildOne, coverage, statusOf, compareSources, backup, sourceOf, minutesOf, TOPSTEPX_DAYS } from "../src/store.mjs";
import { SymbolTable, parseCsv, mergeFiles, buildSeries, holesOf, nyTradingDay } from "../src/series.mjs";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
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
  eq(s.rolledOff, 2); eq(s.conflicts, 1); eq(s.builds[0].holes.length, 1);
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

// ── what a file has to prove before it goes in ──
const bar = (k, size = 1, symbol = "MNQZ6") => [Date.UTC(2026, 8, 8, 14) + k * size * 60000, 25000, 25002, 24998, 25001, 10, symbol];
const barsOf = (count, size = 1) => Array.from({ length: count }, (_, k) => bar(k, size));
const fails = (fn, why) => { let e = null; try { fn(); } catch (x) { e = x; } if (!e) throw new Error(`it went through, expected ${why}`); if (!why.test(e.message)) throw new Error(`refused for the wrong reason: ${e.message}`); };
const count = (c, table) => c.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

t("a file that cannot be what it says is refused, and nothing of it is kept", () => {
  const c = openStore(P("checks.db")), add = (file, minutes = 1) => addFile(c, file, { source: "databento", minutes });
  fails(() => add(csv("empty.csv", [])), /holds no bars/);
  fails(() => add(csv("spreads.csv", [], [`${iso(bar(0)[0])},290,291,289,290,5,MNQU6-MNQZ6`])), /holds no bars/);
  fs.writeFileSync(P("nosym.csv"), `ts_event,open,high,low,close,volume\n${iso(bar(0)[0])},25000,25002,24998,25001,10\n`);
  fails(() => add(P("nosym.csv")), /no symbol column/);
  fails(() => add(csv("fives.csv", barsOf(30, 5))), /looks like 5-minute bars, not 1-minute/);
  fails(() => add(csv("hours.csv", barsOf(30, 60))), /looks like 60-minute bars, not 1-minute/);
  fails(() => add(csv("hours5.csv", barsOf(30, 60)), 5), /looks like 60-minute bars, not 5-minute/);
  fails(() => add(csv("ones.csv", barsOf(30, 1)), 5), /whole 5-minute bars/);
  fails(() => add(csv("one5.csv", [barsOf(30, 1)[7]]), 5), /whole 5-minute bars/);
  fails(() => add(csv("offset.csv", barsOf(30, 1).map(([t, ...r]) => [t + 30000, ...r]))), /whole 1-minute bars/);
  fails(() => add(csv("seconds.csv", barsOf(30, 1).map(([t, ...r], k) => [t + (k % 2) * 1000, ...r]))), /whole 1-minute bars/);
  const broken = (fix) => { const r = barsOf(30); r[7] = fix(r[7]); return r; };
  fails(() => add(csv("upside.csv", broken(([t, o, , , x, v, s]) => [t, o, 24990, 25010, x, v, s]))), /1 bar with impossible prices, the first at 2026-09-08 14:07 UTC/);
  fails(() => add(csv("zero.csv", broken(([t, , , , , v, s]) => [t, 0, 0, 0, 0, v, s]))), /impossible prices/);
  fails(() => add(csv("open.csv", broken(([t, , h, l, x, v, s]) => [t, 25003, h, l, x, v, s]))), /impossible prices/);
  fails(() => add(csv("close.csv", broken(([t, o, h, l, , v, s]) => [t, o, h, l, 24997, v, s]))), /impossible prices/);
  fails(() => add(csv("fixed-point.csv", barsOf(30).map(([t, o, h, l, x, v, s]) => [t, o * 1e9, h * 1e9, l * 1e9, x * 1e9, v, s]))), /30 bars with impossible prices/);
  eq([count(c, "bars"), count(c, "imports"), count(c, "contracts")], [0, 0, 0], "nothing kept:");
  eq(add(csv("good.csv", barsOf(30))).added, 30, "the right label goes in:");
  eq(addFile(c, csv("good5.csv", barsOf(30, 5)), { source: "topstepx", minutes: 5 }).added, 30);
  eq(add(csv("few.csv", [bar(100), bar(103)])).added, 2, "a few rows cannot prove a size:");
  eq(add(csv("same.csv", Array.from({ length: 25 }, (_, k) => bar(200, 1, `MNQ${String.fromCharCode(65 + k)}6`)))).added, 25, "many contracts in one minute:");
  c.close();
});
t("the checks read a file as a whole: one good bar does not cover for a bad one", () => {
  const syms = { names: ["MNQZ6"] }, of = (rows) => ({ n: rows.length, ts: rows.map((r) => r[0]), op: rows.map((r) => r[1]), hi: rows.map((r) => r[2]), lo: rows.map((r) => r[3]), cl: rows.map((r) => r[4]) });
  eq(fileProblem(of(barsOf(30)), 1, syms, "x"), null);
  const last = barsOf(30); last[29] = [...last[29]]; last[29][2] = 1;
  if (!/impossible/.test(fileProblem(of(last), 1, syms, "x"))) throw new Error("the last bar was not read");
});
t("a file saved by Excel reads the same: a byte-order mark and Windows line ends", () => {
  const c = openStore(P("excel.db")), rows = barsOf(3).map(([t, o, h, l, x, v, s]) => `${iso(t)},${o},${h},${l},${x},${v},${s}`);
  fs.writeFileSync(P("excel.ohlcv-1m.csv"), `\ufeffts_event,open,high,low,close,volume,symbol\r\n${rows.join("\r\n")}\r\n`);
  const r = addFile(c, P("excel.ohlcv-1m.csv"), { source: "databento" });
  eq([r.rows, r.added, r.unread], [3, 3, 0]);
  eq({ ...c.prepare("SELECT o, h, l, c, v FROM bars ORDER BY ts LIMIT 1").get() }, { o: 25000, h: 25002, l: 24998, c: 25001, v: 10 });
  eq(c.prepare("SELECT symbol FROM contracts").all().map((x) => x.symbol), ["MNQZ6"], "the symbol, with no stray return:");
  c.close();
});
t("a row that cannot be read is counted, not hidden", () => {
  const c = openStore(P("unread.db")), r = addFile(c, csv("torn.ohlcv-1m.csv", barsOf(4), ["2026-09-08T15:00:00.000000000Z,25000", "not a time,25000,25002,24998,25001,10,MNQZ6"]), { source: "databento" });
  eq([r.rows, r.added, r.unread], [4, 4, 2]);
  c.close();
});
t("a file that fails part way leaves nothing behind, and the store still works", () => {
  const c = openStore(P("rollback.db")), f = csv("fail.ohlcv-1m.csv", barsOf(10));
  c.exec(`CREATE TRIGGER stop BEFORE INSERT ON bars WHEN NEW.ts = ${barsOf(10)[6][0]} BEGIN SELECT RAISE(ABORT, 'the disk is full'); END`);
  fails(() => addFile(c, f, { source: "databento" }), /the disk is full/);
  eq([count(c, "bars"), count(c, "imports")], [0, 0], "six rows and the import rolled back:");
  c.exec("DROP TRIGGER stop");
  eq(addFile(c, f, { source: "databento" }).added, 10, "the same file can then go in:");
  c.close();
});
t("a source or a bar size that does not exist goes nowhere near the store", () => {
  fails(() => sourceOf("a.csv", "databnto"), /No source called databnto/);
  for (const bad of ["abc", "0", "-1", "1.5"]) fails(() => minutesOf("a.csv", bad), /whole number of minutes/);
  eq(minutesOf("a.csv", 5), 5); eq(minutesOf("x.ohlcv-15m.csv"), 15);
  fails(() => openStore(P("not-there.db"), { readOnly: true }), /No store at/);
  const c = openStore(P("none.db"));
  fails(() => readRows(c, MAIN), /Nothing in the store for MNQ/);
  eq(coverage(c, MAIN), { sessions: 0, holes: [] });
  c.close();
});

// ── what status says ──
t("status adds each source up across its contracts, in order", () => {
  const c = openStore(P("held.db")), add = (rows, source, minutes) => addFile(c, csv(`held${count(c, "imports")}.csv`, rows), { source, minutes });
  // The key's first contract has 5-minute bars alone, and its last holds both ends of the source.
  add(barsOf(2, 5), "topstepx", 5);
  add([bar(10, 1, "MNQU6"), bar(11, 1, "MNQU6")], "topstepx", 1);
  add([bar(0, 1, "MNQH7"), bar(20, 1, "MNQH7"), bar(21, 1, "MNQH7")], "topstepx", 1);
  add(barsOf(2), "databento", 1);
  const s = statusOf(c, { builds: {} }).sources;
  eq(s.map((r) => [r.source, r.minutes, r.rows, r.contracts]), [["topstepx", 1, 5, 2], ["topstepx", 5, 2, 1], ["databento", 1, 2, 1]]);
  eq([s[0].first, s[0].last], [bar(0)[0], bar(21)[0]], "both ends of the source:");
  c.close();
});
t("status knows when a backup or a build has fallen behind, and only for new bars", () => {
  const c = openStore(P("fresh.db")), to = P("fresh-backups"), build = { root: "MNQ", sources: ["databento"], out: "fresh.bin" };
  const look = () => { const s = statusOf(c, { builds: { beta: build } }, { backupDir: to, repo: dir }); return [s.backup && s.backup.behind, s.builds[0].stale]; };
  const stamp = (ms) => { for (const f of [P("fresh.bin"), path.join(to, fs.readdirSync(to)[0])]) fs.utimesSync(f, new Date(ms), new Date(ms)); };
  addFile(c, csv("f1.ohlcv-1m.csv", barsOf(3)), { source: "databento" });
  eq(look(), [null, true], "no backup and no file yet:");
  buildOne(c, "beta", build, { repo: dir }); backup(c, to);
  const last = statusOf(c, { builds: {} }).lastAdded;
  stamp(last + 1);
  eq(look(), [false, false], "both just after the bars:");
  stamp(last - 1);
  eq(look(), [true, true], "both just before them:");
  stamp(last + 1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  eq(addFile(c, csv("f2.ohlcv-1m.csv", barsOf(2)), { source: "databento" }).added, 0);
  eq(look(), [false, false], "a file with nothing new:");
  eq(addFile(c, csv("f3.ohlcv-1m.csv", [bar(50)]), { source: "databento" }).added, 1);
  eq(look(), [true, true], "a file with one new bar:");
  c.close();
});
t("what has rolled off TopstepX is counted to the minute, and the deadline runs from the newest bar", () => {
  const c = openStore(P("off.db")), rows = barsOf(5);
  addFile(c, csv("off.ohlcv-1m.csv", rows), { source: "topstepx" });
  const at = (k) => statusOf(c, { builds: {} }, { now: rows[k][0] + TOPSTEPX_DAYS * DAY });
  eq([at(0).rolledOff, at(1).rolledOff, at(4).rolledOff], [0, 1, 4], "a bar exactly 60 days old is still on the API:");
  eq(at(0).pullBy, rows[4][0] + TOPSTEPX_DAYS * DAY);
  const none = openStore(P("off2.db"));
  addFile(none, csv("off2.ohlcv-1m.csv", rows), { source: "databento" });
  eq([statusOf(none, { builds: {} }).rolledOff, statusOf(none, { builds: {} }).pullBy], [0, null], "no TopstepX bars:");
  none.close(); c.close();
});
t("a comparison reads the same either way round, and needs both sources", () => {
  const c = openStore(P("both.db"));
  eq(compareSources(c, "databento", "topstepx"), [], "an empty store:");
  addFile(c, csv("bd.csv", barsOf(4)), { source: "databento", minutes: 1 });
  eq(compareSources(c, "databento", "topstepx"), [], "one source:");
  eq(compareSources(c, "topstepx", "databento"), [], "one source, the other way:");
  const other = barsOf(4);
  other[1] = [other[1][0], 25000.5, 25002.5, 24998, 25001, 10, "MNQZ6"]; other[2] = [other[2][0], 25000, 25002, 24998, 25001, 11, "MNQZ6"];
  addFile(c, csv("bt.csv", [...other, bar(9)]), { source: "topstepx", minutes: 1 });
  const want = [{ symbol: "MNQZ6", both: 4, samePrices: 3, sameVolume: 3, worst: 0.5 }];
  eq(compareSources(c, "databento", "topstepx").map((r) => ({ ...r })), want);
  eq(compareSources(c, "topstepx", "databento").map((r) => ({ ...r })), want, "the other way:");
  addFile(c, csv("five.csv", barsOf(4, 5)), { source: "topstepx", minutes: 5 });
  addFile(c, csv("five2.csv", barsOf(4, 5)), { source: "databento", minutes: 5 });
  eq(compareSources(c, "databento", "topstepx")[0].both, 4, "only the 1-minute bars are compared:");
  c.close();
});

// ── builds and backups ──
t("a build is the same bytes every time, and leaves nothing half written", () => {
  const c = openStore(P("same.db")), folder = P("same-builds");
  addFile(c, csv("same.ohlcv-1m.csv", rowsFor(5)), { source: "databento" });
  const out = (f) => ({ root: "MNQ", sources: ["databento"], out: f });
  buildOne(c, "x", out("x.bin"), { repo: folder }); buildOne(c, "y", out("y.bin"), { repo: folder });
  eq(fs.readFileSync(path.join(folder, "x.bin")).equals(fs.readFileSync(path.join(folder, "y.bin"))), true);
  eq(fs.readdirSync(folder).sort(), ["x.bin", "x.meta.json", "y.bin", "y.meta.json"]);
  const m = JSON.parse(fs.readFileSync(path.join(folder, "x.meta.json"), "utf8"));
  eq([m.build, m.before, m.sourceOrder, m.bars], ["x", null, ["databento"], rowsFor(5).filter((r) => r[6] === "MNQU6").length]);
  c.close();
});
t("a frozen build with no file yet is simply written", () => {
  const c = openStore(P("first.db")), folder = P("first-build");
  addFile(c, csv("first.ohlcv-1m.csv", rowsFor(3)), { source: "databento" });
  eq(buildOne(c, "main", { root: "MNQ", sources: ["databento"], out: "m.bin", frozen: true }, { repo: folder }).state, "written");
  c.close();
});
t("a backup goes to any folder, replaces the same day's and leaves no temporary file", () => {
  const c = openStore(P("odd.db")), to = P("Bob's backups (1)"), day = new Date(Date.UTC(2026, 10, 1));
  addFile(c, csv("odd.ohlcv-1m.csv", barsOf(3)), { source: "databento" });
  const a = backup(c, to, 3, day);
  eq([path.basename(a.file), a.rows, a.removed], ["store_2026-11-01.db", 3, []]);
  addFile(c, csv("odd2.ohlcv-1m.csv", [bar(9)]), { source: "databento" });
  eq(backup(c, to, 3, day).rows, 4, "later the same day:");
  fs.writeFileSync(path.join(to, "my notes.txt"), "mine");
  fs.writeFileSync(path.join(to, "store_old.db"), "mine too");
  eq(backup(c, to, 1, new Date(Date.UTC(2026, 10, 2))).removed, ["store_2026-11-01.db"], "only its own files are pruned:");
  eq(fs.readdirSync(to).sort(), ["my notes.txt", "store_2026-11-02.db", "store_old.db"]);
  c.close();
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
  eq(ask("::1", "[::1]:5178", "http://[::1]:5178"), true, "the IPv6 address:");
  eq(ask("127.0.0.1", "LOCALHOST:5178"), true, "a name in capitals:");
  eq(ask("127.0.0.1", "localhost"), false, "no port, so port 80:");
  eq(ask("127.0.0.1", "localhost.evil.example:5178"), false, "a name that starts the same:");
  eq(ask("127.0.0.1", "127.0.0.1.evil.example:5178"), false);
  eq(ask("127.0.0.1", ""), false, "an empty Host:");
  eq(ask("127.0.0.1", "a b"), false, "a Host no URL can be made of:");
  eq(ask("127.0.0.1", undefined), false, "no Host:");
  eq(ask("127.0.0.1", "localhost:5178", "not a url"), false, "a broken Origin:");
  eq(ask(undefined, "localhost:5178"), false, "a closed socket:");
  eq(ask("10.0.0.5", "127.0.0.1:5178"), false);
  eq(ask("::ffff:192.168.1.20", "localhost:5178"), false, "another machine over IPv4 on a dual stack:");
  eq(fromThisMachine({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "localhost" } }, 80), true, "served on port 80:");
});
t("an uploaded name becomes a plain file name, and only a CSV", () => {
  eq(csvName("glbx-mdp3-2026.ohlcv-1m.csv"), "glbx-mdp3-2026.ohlcv-1m.csv");
  eq(csvName("C:\\Users\\me\\bars.csv"), "bars.csv"); eq(csvName("../../bars.csv"), "bars.csv"); eq(csvName("my bars (1).csv"), "my_bars__1_.csv");
  eq(csvName("BARS.CSV"), "BARS.CSV"); eq(csvName("barres été.csv"), "barres__t_.csv"); eq(csvName("..\\..\\..\\x.csv"), "x.csv"); eq(csvName("a/b/c.csv"), "c.csv");
  for (const bad of ["../../bot/.env", "bars.zip", "bars.csv.zst", "bars.csv.exe", "bars.csv ", ".csv", "..csv", ".hidden.csv", "/", "..", "", null, undefined]) { let threw = false; try { csvName(bad); } catch { threw = true; } eq(threw, true, `${bad}:`); }
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

// The same, with a pretend process, so what arrives and when is exact.
const pretend = () => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); return c; };
const tick = () => new Promise((r) => setTimeout(r, 5));
async function play(name, fn) { try { await fn(); pass++; console.log(`  ok   ${name}`); } catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}\n         ${e.message}`); } }
await play("lines are put together stream by stream, whatever the pieces", async () => {
  const c = pretend(), run = new Jobs(() => c), job = run.start("x", []);
  c.stdout.write("par"); await tick();
  c.stderr.write("from stderr\n"); await tick();
  c.stdout.write("tial\r\nnext"); await tick();
  c.stdout.write(" line\n"); await tick();
  c.stderr.write("no newline"); c.stdout.write("nor here"); await tick();
  c.emit("close", 0);
  eq(job.lines, ["from stderr", "partial", "next line", "nor here", "no newline"]);
});
await play("a character split between two pieces arrives whole", async () => {
  const c = pretend(), job = new Jobs(() => c).start("x", []), e = Buffer.from("é\n");
  c.stdout.write(e.subarray(0, 1)); await tick();
  c.stdout.write(e.subarray(1)); await tick();
  c.emit("close", 0);
  eq(job.lines, ["é"]);
});
await play("only the newest 400 lines are kept", async () => {
  const c = pretend(), job = new Jobs(() => c).start("x", []);
  c.stdout.write(Array.from({ length: 450 }, (_, k) => `line ${k}\n`).join("")); await tick();
  c.emit("close", 0);
  eq([job.lines.length, job.lines[0], job.lines[399]], [400, "line 50", "line 449"]);
});
await play("how a command ended is kept, and done is told exactly once", async () => {
  const seen = [], run = (c) => new Jobs(() => c).start("x", [], (j) => seen.push(j.exit));
  const a = pretend(), j1 = run(a); a.emit("close", 0); a.emit("close", 5);
  const b = pretend(), j2 = run(b); b.emit("close", null);
  const c = pretend(), j3 = run(c); c.emit("error", new Error("cannot start")); c.emit("close", 0);
  eq([j1.exit, j2.exit, j3.exit], [0, 1, 1], "exit 0, killed, never started:");
  eq(seen, [0, 1, 1]); eq(j3.lines, ["cannot start"]);
  if (j1.endedAt < j1.startedAt) throw new Error("ended before it started");
});
await play("a command that cannot even start does not leave the page stuck", () => {
  const seen = [], j = new Jobs(() => { throw new Error("no such file"); });
  const job = j.start("x", [], (d) => seen.push(d.id));
  eq([job.running, job.exit, job.lines, j.busy, seen], [false, 1, ["no such file"], false, [1]]);
  let second = null;
  j.run = () => { second = pretend(); return second; };
  eq(j.start("y", []).id, 2, "the next one runs:");
  second.emit("close", 0);
});
await play("a failure in done cannot take the server with it", () => {
  const c = pretend(), job = new Jobs(() => c).start("x", [], () => { throw new Error("the copy is locked"); });
  c.emit("close", 0);
  eq([job.running, job.exit, job.lines], [false, 0, ["the copy is locked"]]);
});

db.close();
try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a failed test left a store open, and the report below matters more */ }
console.log(`\n${"=".repeat(64)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(64)}`);
for (const f of failures) console.log(`  - ${f}`);
process.exitCode = fail ? 1 : 0;
