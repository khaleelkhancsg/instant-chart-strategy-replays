# The red-folder calendar's sources

`research/news_build.mjs` reads these files and writes `src/news_calendar.mjs`. Every date and
time comes from the agency that publishes the release. ForexFactory decided only which kinds of
release count as red folder (its US calendar, five weeks of Sep - Nov 2026), and nothing was
copied from it.

| file | holds | from |
| --- | --- | --- |
| `bls.txt` | CPI, the Employment Situation (NFP) and PPI: every release since 2019 (8:30 ET), and the schedule to Dec 2027 with times | the BLS archive pages (`bls.gov/bls/news-release/cpi.htm`, `empsit.htm`, `ppi.htm`: each archived release's file name is its release date) and schedule pages (`bls.gov/schedule/news_release/<code>.htm`) |
| `census_retail.txt` | Advance Monthly Retail Trade Report release dates, 8:30 ET | `census.gov/retail/marts/www/MARTSreleasedates.xlsx` and `census.gov/retail/release_schedule.html` |
| `alfred.txt` | vintage dates of RSAFS, GDPC1 and PCEPILFE: the days each was published | ALFRED (`alfred.stlouisfed.org/series?seid=...`), used for GDP and PCE before 2025 |
| `bea_release_dates.json` | GDP and Personal Income and Outlays from 2025, with exact times, through 2027 | `apps.bea.gov/API/signup/release_dates.json` |
| `bea_schedule.txt` | the titles of BEA's 2025 - 2026 GDP and PIO releases, which say which estimate each GDP one is | `bea.gov/news/schedule/full-2025` and `/full` |
| `fomc.txt` | FOMC decisions, minutes and the three 2020 emergency statements | `federalreserve.gov/monetarypolicy/fomccalendars.htm`, `fomchistorical2019.htm`, `fomchistorical2020.htm`, and the statements' own release times |

Read 2026-11-02. BLS refuses scripts, and ALFRED fills its list in the page, so those two were
read in a browser and copied out with a SHA-256 checked on both sides (`bls.txt` bd41631d...,
`alfred.txt` 913c9dc6...). The rest were fetched directly.

## What counts, and what does not

- **Red folder:** the jobs report, CPI, PPI, retail sales, the advance GDP estimate, PCE, the FOMC
  decision, its press conference and its minutes. Retail sales is red on ForexFactory most
  months, orange in some; it is kept. ISM manufacturing is red only some months and is left out,
  as are the orange ones (JOLTS, jobless claims, ISM services, consumer confidence, UoM).
- **Left out because there is no timed record:** the Fed Chair's speeches and testimony, which
  ForexFactory marks red. A rule built on this calendar does not stand aside for them.
- **The agencies' own irregularities are kept:** the 2019 and 2025 shutdowns (October 2025's CPI
  and jobs report were never published; the Oct 30 2025 GDP was scheduled and never released),
  the catch-up releases after them, the three 2026 PCE releases moved to 10:00 on GDP days, and
  the Fed's March 2020 emergency statements at 10:00, 17:00 (a Sunday) and 08:00 Eastern.
- **Future dates** are the agencies' schedules. FOMC minutes appear only once the Fed posts them.

## Checked against the market

`node --max-old-space-size=8192 research/news_check.mjs` measures each release's five minutes
against the same minutes on the 20 trading days before. Over 647 releases with bars, the median
release moved 3.16x its usual range and 75% moved at least 2x; the day before each, at the same
minute, gave 1.11x and 18%. Every kind is far above its own day-before figure, and the weakest
releases are ones with a reason (limit-down on Mar 12 2020, the November 2020 election week).

## Refreshing it

1. Fetch the pages above again (BLS and ALFRED in a browser), rewrite these files.
2. `node research/news_build.mjs`, then `node --max-old-space-size=8192 test/news.test.mjs`.
3. Restart the server: it loads `src/` once.
