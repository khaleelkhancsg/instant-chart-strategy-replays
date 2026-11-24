"""Builds the outside-event files the idea loop reads, from raw downloads in data/raw (git-ignored).

    python research/event_data_build.py

Sources, all free, downloaded 2026-11-24 with the person's OK:
- data/raw/sec/<TICKER>*.json: SEC EDGAR filing histories (data.sec.gov/submissions) for the eight
  largest Nasdaq-100 companies. An earnings release is an 8-K with item 2.02.
- data/raw/treasury/auctions.json: Treasury auction results (api.fiscaldata.treasury.gov, auctions_query).
- data/raw/cftc/fut_fin_txt_<year>.zip: CFTC Traders in Financial Futures, futures only, by year.
- Index days need no download: third Fridays.

Writes data/raw/events/:
- earnings.csv   ticker, accepted_ct (Chicago), session: the RTH session that first trades on it
                 (same day if accepted before 15:00 CT, else the next weekday).
- auctions.csv   coupon auctions (notes, bonds, TIPS, FRNs): date, type, term, close_et, high_yield,
                 bid_to_cover, btc_vs_prev6 (this bid-to-cover over the average of the same term's last
                 six; below 1 is a weaker auction than usual).
- cot_nq.csv     NASDAQ-100 Consolidated (CME): report date (Tuesday), usable_from (the Monday after the
                 Friday release), open interest, dealer / asset manager / leveraged fund longs and shorts.
- index_days.csv third Fridays: monthly options expiry, and the quarterly ones (Mar/Jun/Sep/Dec), when
                 the Nasdaq-100 rebalances at the close (December: the annual reconstitution).
"""
import csv, datetime as dt, glob, io, json, os, zipfile
from zoneinfo import ZoneInfo

RAW = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
OUT = os.path.join(RAW, "events")
os.makedirs(OUT, exist_ok=True)
CT = ZoneInfo("America/Chicago")


def next_weekday(d):
    d += dt.timedelta(days=1)
    while d.weekday() >= 5:
        d += dt.timedelta(days=1)
    return d


# earnings: 8-K item 2.02, from the recent block and every older page
rows = []
for path in sorted(glob.glob(os.path.join(RAW, "sec", "*.json"))):
    ticker = os.path.basename(path).split(".")[0].split("_")[0]
    j = json.load(open(path))
    block = j["filings"]["recent"] if "filings" in j else j
    for form, items, acc in zip(block["form"], block["items"], block["acceptanceDateTime"]):
        if form != "8-K" or "2.02" not in (items or ""):
            continue
        t = dt.datetime.fromisoformat(acc.replace("Z", "+00:00")).astimezone(CT)
        session = t.date() if t.hour < 15 else next_weekday(t.date())
        if session.weekday() >= 5:
            session = next_weekday(session)
        rows.append((ticker, t.strftime("%Y-%m-%d %H:%M"), session.isoformat()))
rows = sorted(set(rows), key=lambda r: (r[1], r[0]))
with open(os.path.join(OUT, "earnings.csv"), "w", newline="") as f:
    w = csv.writer(f); w.writerow(["ticker", "accepted_ct", "session"]); w.writerows(rows)
print("earnings", len(rows), rows[0][1] if rows else "", "to", rows[-1][1] if rows else "")

# coupon auctions
data = json.load(open(os.path.join(RAW, "treasury", "auctions.json")))["data"]
num = lambda v: float(v) if v not in (None, "null", "") else None
coupons = sorted((r for r in data if r["security_type"] in ("Note", "Bond", "TIPS", "FRN")), key=lambda r: r["auction_date"])
hist, out = {}, []
for r in coupons:
    btc, key = num(r["bid_to_cover_ratio"]), (r["security_type"], r["security_term"])
    prev = hist.get(key, [])
    rel = btc / (sum(prev[-6:]) / len(prev[-6:])) if btc and len(prev) >= 3 else None
    if btc:
        hist.setdefault(key, []).append(btc)
    out.append((r["auction_date"], r["security_type"], r["security_term"], r["closing_time_comp"], r["high_yield"], btc, None if rel is None else round(rel, 4)))
with open(os.path.join(OUT, "auctions.csv"), "w", newline="") as f:
    w = csv.writer(f); w.writerow(["date", "type", "term", "close_et", "high_yield", "bid_to_cover", "btc_vs_prev6"]); w.writerows(out)
print("auctions", len(out), out[0][0], "to", out[-1][0])

# CFTC positioning, NASDAQ-100 Consolidated
cot = {}
for path in sorted(glob.glob(os.path.join(RAW, "cftc", "fut_fin_txt_*.zip"))):
    z = zipfile.ZipFile(path)
    r = list(csv.reader(io.StringIO(z.read(z.namelist()[0]).decode("latin1"))))
    h = {c: i for i, c in enumerate(r[0])}
    for row in r[1:]:
        if not row[0].startswith("NASDAQ-100 Consolidated"):
            continue
        rep = dt.date.fromisoformat(row[h["Report_Date_as_YYYY-MM-DD"]])
        cot[rep] = [int(row[h[c]]) for c in ("Open_Interest_All", "Dealer_Positions_Long_All", "Dealer_Positions_Short_All",
                    "Asset_Mgr_Positions_Long_All", "Asset_Mgr_Positions_Short_All", "Lev_Money_Positions_Long_All", "Lev_Money_Positions_Short_All")]
with open(os.path.join(OUT, "cot_nq.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["report", "usable_from", "oi", "dealer_long", "dealer_short", "am_long", "am_short", "lev_long", "lev_short"])
    for rep in sorted(cot):
        w.writerow([rep.isoformat(), (rep + dt.timedelta(days=6)).isoformat()] + cot[rep])
print("cot", len(cot), min(cot), "to", max(cot))

# third Fridays
with open(os.path.join(OUT, "index_days.csv"), "w", newline="") as f:
    w = csv.writer(f); w.writerow(["date", "kind"])
    for y in range(2018, 2028):
        for m in range(1, 13):
            d = dt.date(y, m, 15)
            while d.weekday() != 4:
                d += dt.timedelta(days=1)
            w.writerow([d.isoformat(), "reconstitution" if m == 12 else "quarterly" if m in (3, 6, 9) else "monthly"])
print("index days written")
