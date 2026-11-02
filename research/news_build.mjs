// Builds src/news_calendar.mjs, the red-folder calendar, from the official schedules kept in
// research/news/. NODE-ONLY.   node research/news_build.mjs
//
// "Red folder" is ForexFactory's mark for a high-impact release. Read for 2026 (Sep - Nov, five
// weeks of its US calendar), the releases it marks red every time are: the jobs report, CPI, PPI,
// the FOMC decision and its press conference, the FOMC minutes, the advance GDP estimate, core
// PCE, and the Fed Chair's speeches. Retail sales and ISM manufacturing are red some months and
// orange in others; retail sales is kept, ISM is not. Chair speeches are left out: there is no
// timed record of them to build from. ForexFactory is read for which kinds of release count, never
// copied: every date and time below comes from the agency that publishes the release.
//
//   bls.txt                 BLS archives and schedules: CPI, the Employment Situation, PPI
//   census_retail.txt       Census: the Advance Monthly Retail Trade Report
//   alfred.txt              ALFRED vintage dates: GDP and core PCE before 2025
//   bea_release_dates.json  BEA, 2025 on, with exact times
//   bea_schedule.txt        BEA titles for 2025 - 2026, which name each GDP estimate
//   fomc.txt                The Fed's meeting calendars
//
// research/news/README.md says where each came from and how to refresh it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), SRC = path.join(HERE, "news");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const lines = (f) => read(f).split(/\r?\n/).filter((l) => l && !l.startsWith("#"));

// An Eastern wall-clock time as UTC milliseconds, through daylight saving.
const NY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
export function easternToUtc(date, hhmm) {
  const [y, m, d] = date.split("-").map(Number), [h, mi] = hhmm.split(":").map(Number), want = Date.UTC(y, m - 1, d, h, mi);
  let t = want + 5 * 3600000;
  for (let k = 0; k < 3; k++) {
    const p = Object.fromEntries(NY.formatToParts(t).map((x) => [x.type, x.value]));
    t += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return t;
}
const clock24 = (s) => { const m = /^(\d{1,2}):(\d{2}) ?([AP])M$/i.exec(s.trim()); if (!m) throw new Error(`a time: ${s}`); return `${String((+m[1] % 12) + (/p/i.test(m[3]) ? 12 : 0)).padStart(2, "0")}:${m[2]}`; };

export function buildEvents() {
  const ev = [], add = (t, kind) => ev.push([t, kind]);

  // BLS: archived releases (all at 8:30) and the schedule ahead, which gives each time.
  const BLS = { cpi: "CPI", empsit: "NFP", ppi: "PPI" };
  for (const l of lines("bls.txt")) {
    const [code, ...rest] = l.split(" "), base = code.replace(/-next$/, "");
    if (!BLS[base]) throw new Error(`bls.txt: ${code}`);
    for (const x of rest.join(" ").split(/ (?=\d{4}-)/)) {
      const [date, time] = x.split("@");
      add(easternToUtc(date, time ? clock24(time) : "08:30"), BLS[base]);
    }
  }

  // Census: every release at 8:30.
  for (const d of lines("census_retail.txt")) add(easternToUtc(d, "08:30"), "RETAIL");

  // GDP and PCE. Before 2025 from ALFRED's vintage dates: the first GDP vintage after a quarter
  // ends is that quarter's advance estimate, and every core PCE vintage is a Personal Income and
  // Outlays release, at 8:30 (none of them shared a day with GDP). From 2025 BEA's own list, which
  // has the times: three PCE releases moved to 10:00 on days GDP had 8:30.
  const vint = Object.fromEntries(lines("alfred.txt").map((l) => { const [k, ...d] = l.split(" "); return [k, d]; }));
  const quarterEnds = (from, to) => { const out = []; for (let y = from; y <= to; y++) for (const m of [3, 6, 9, 12]) out.push(new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)); return out; };
  for (const end of quarterEnds(2018, 2024).filter((e) => e >= "2018-12-31" && e <= "2024-09-30")) {
    const first = vint.GDPC1.find((d) => d > end);
    if (!first || first >= "2025-01-01") throw new Error(`no advance GDP after ${end}`);
    add(easternToUtc(first, "08:30"), "GDP");
  }
  for (const d of vint.PCEPILFE) if (d >= "2019-01-01" && d < "2025-01-01") add(easternToUtc(d, "08:30"), "PCE");
  const bea = JSON.parse(read("bea_release_dates.json")), titles = lines("bea_schedule.txt");
  const gdp = bea["Gross Domestic Product"].release_dates.map((s) => Date.parse(s)), utcDay = (t) => new Date(t).toISOString().slice(0, 10);
  for (const t of gdp) {
    const day = utcDay(t);
    if (day < "2027-01-01") {
      // 2025 - 2026: BEA's title says which estimate; the first after the 2025 shutdown was "Initial".
      if (titles.some((l) => l.startsWith(day) && /Gross Domestic Product|^\S+ \S+ \S+ GDP/.test(l) && /\((Advance|Initial) Estimate\)/.test(l))) add(t, "GDP");
    } else if (quarterEnds(2026, 2027).some((end) => gdp.find((x) => utcDay(x) > end) === t)) add(t, "GDP");
  }
  for (const s of bea["Personal Income and Outlays"].release_dates) add(Date.parse(s), "PCE");

  // FOMC: the statement at 2:00 and the press conference at 2:30 for every scheduled meeting
  // (one has followed each of them since 2019), the minutes at 2:00. Unscheduled statements at
  // their own times, with no press conference.
  for (const l of lines("fomc.txt")) {
    const [what, date, time] = l.split(" ");
    if (what === "decision") { add(easternToUtc(date, "14:00"), "FOMC"); add(easternToUtc(date, "14:30"), "PRESSER"); }
    else if (what === "decision-unscheduled") add(easternToUtc(date, time), "FOMC");
    else if (what === "minutes") add(easternToUtc(date, "14:00"), "MINUTES");
    else throw new Error(`fomc.txt: ${l}`);
  }

  ev.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return ev.filter((e, i) => i === 0 || e[0] !== ev[i - 1][0] || e[1] !== ev[i - 1][1]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const ev = buildEvents(), out = path.join(HERE, "..", "src", "news_calendar.mjs");
  const iso = (t) => new Date(t).toISOString().slice(0, 16).replace(":00", "");
  const body = ev.map(([t, k]) => `  [${t}, "${k}"],`).join("\n");
  fs.writeFileSync(out, `// GENERATED by research/news_build.mjs from the official schedules in research/news/. Do not edit:
// change those and rebuild. ISOMORPHIC. [UTC milliseconds, kind], sorted. ${ev.length} releases,
// ${iso(ev[0][0])} to ${iso(ev[ev.length - 1][0])} UTC; after the newest bar they are the schedule ahead.

export const RED_FOLDER = [
${body}
];
`);
  const count = {};
  for (const [t, k] of ev) { const y = new Date(t).getUTCFullYear(); (count[k] ||= {})[y] = (count[k][y] || 0) + 1; }
  console.log(`${ev.length} releases -> ${path.relative(process.cwd(), out)}`);
  const years = [...new Set(ev.map(([t]) => new Date(t).getUTCFullYear()))];
  console.log(`         ${years.join("  ")}`);
  for (const k of Object.keys(count)) console.log(`${k.padEnd(8)} ${years.map((y) => String(count[k][y] || 0).padStart(4)).join("  ")}`);
}
