// Every level the study tests, as tracks on the 1-minute bars. Each is a study from
// src/studies.mjs, so anything that survives can go straight on the chart, except the
// round numbers, which need each contract's own prices.
//
// Families:
//   prior day    fixed at yesterday's close
//   overnight    fixed by 08:30, from tonight's sessions
//   opens        where a session, week or month began
//   week, month  from the last whole period, or the first sessions of this one
//   composite    profiles of the last 5, 20, 60 sessions and their volume nodes
//   round        the contract's round numbers
//   intraday     set during today's session, then fixed: opening ranges, swings
//   developing   moving as bars arrive: profiles, VWAPs, today's range, ADR targets
//   indicator    lines this project's strategies and filters already use

import * as Lab from "./lib_levels.mjs";
import { compositeLevels, nakedPocs, swingVwap, volumeShelf } from "../src/levels.mjs";

// Related levels tested together, for power.
export const POOLS = {
  "HOLD claim: prior POCs": ["PD POC (RTH)", "PD POC (full session)", "PD TPO POC", "VP5 POC", "VP20 POC", "VP60 POC", "PW POC", "PM POC"],
  "HOLD claim: HVNs": ["VP5 HVN", "VP20 HVN", "VP60 HVN"],
  "BREAK claim: PD high/low": ["PD high", "PD low"],
  "BREAK claim: overnight high/low": ["Overnight high", "Overnight low"],
  "BREAK claim: round 100/500": ["Round 100", "Round 500"],
  "neutral claim: PW/PM high/low": ["PW high", "PW low", "PM high", "PM low"],
  "Value area edges, prior": ["PD VAH (RTH)", "PD VAL (RTH)", "VP5 VAH", "VP5 VAL", "VP20 VAH", "VP20 VAL", "PW VAH", "PW VAL", "PM VAH", "PM VAL"],
  "LVNs": ["VP5 LVN", "VP20 LVN", "VP60 LVN"],
  "Naked POCs": ["Naked POC above", "Naked POC below"],
  "Round 50": ["Round 50"], "Round 25": ["Round 25"],
  "Floor pivots": ["Floor P", "Floor R1", "Floor S1", "Floor R2", "Floor S2"],
  "Camarilla": ["Camarilla H3", "Camarilla L3", "Camarilla H4", "Camarilla L4"],
  "Fib pivots": ["Fib pivot R1", "Fib pivot S1", "Fib pivot R2", "Fib pivot S2"],
  "Session opens": ["RTH open", "17:00 open", "NY midnight open"],
  "Week/month opens": ["Week open", "Month open"],
  "Monday's range": ["Monday high", "Monday low", "Monday mid", "Mon-Tue high", "Mon-Tue low", "Mon-Tue mid"],
  "Asia/London/pre-market": ["Asia high", "Asia low", "London high", "London low", "Pre-market high", "Pre-market low"],
  "Opening range edges": ["OR5 high", "OR5 low", "OR15 high", "OR15 low", "OR30 high", "OR30 low", "IB high", "IB low"],
  "IB extensions": ["IB +0.5", "IB -0.5", "IB +1", "IB -1", "IB +1.5", "IB -1.5", "IB +2", "IB -2"],
  "Swings": ["Swing high 2m", "Swing low 2m", "Swing high 5m", "Swing low 5m", "Swing high 15m", "Swing low 15m", "Swing high 1h", "Swing low 1h"],
  "Developing POCs": ["Dev POC (RTH)", "Dev POC (session)", "Dev POC (week)", "Dev POC (month)", "Dev TPO POC (RTH)"],
  "Developing value edges": ["Dev VAH (RTH)", "Dev VAL (RTH)", "Dev VAH (session)", "Dev VAL (session)", "Dev VAH (week)", "Dev VAL (week)", "Dev VAH (month)", "Dev VAL (month)"],
  "VWAPs": ["VWAP (RTH)", "VWAP (session)", "VWAP (week)", "VWAP (month)"],
  "VWAP 1σ bands": ["VWAP +1σ (RTH)", "VWAP -1σ (RTH)", "VWAP +1σ (session)", "VWAP -1σ (session)", "VWAP +1σ (week)", "VWAP -1σ (week)"],
  "VWAP 2σ bands": ["VWAP +2σ (RTH)", "VWAP -2σ (RTH)", "VWAP +2σ (session)", "VWAP -2σ (session)", "VWAP +2σ (week)", "VWAP -2σ (week)"],
  "Extremes so far": ["day high so far", "day low so far", "week high so far", "week low so far", "month high so far", "month low so far"],
  "Range retracements": ["day range 50%", "day range 38.2%", "day range 61.8%", "week range 50%", "week range 38.2%", "week range 61.8%"],
  "ADR targets": ["Open + ADR", "Open - ADR", "Open + half ADR", "Open - half ADR", "Day low + ADR", "Day high - ADR"],
  "VWAP from swings": ["VWAP from swing high 1m", "VWAP from swing low 1m", "VWAP from swing high 5m", "VWAP from swing low 5m", "VWAP from swing high 15m", "VWAP from swing low 15m"],
  "EMAs": ["EMA 9 (2m)", "EMA 21 (2m)", "EMA 50 (2m)", "EMA 125 (2m)", "EMA 500 (2m)", "EMA 9 (10m)", "EMA 21 (10m)", "EMA 21 (60m)", "EMA 50 (60m)"],
  "Trailing stops": ["Supertrend (5m)", "Parabolic SAR (5m)", "Chandelier long stop (5m)", "Chandelier short stop (5m)"],
  "Channels": ["Donchian 30 high (2m)", "Donchian 30 low (2m)", "Donchian 20 high (5m)", "Donchian 20 low (5m)", "Bollinger upper (5m)", "Bollinger lower (5m)", "Keltner upper (5m)", "Keltner lower (5m)", "Regression upper (5m)", "Regression lower (5m)"],
};

export function buildCatalog(sample) {
  const { b, meta } = sample, n = b.close.length, S = (type, tf, params) => Lab.studyLines(sample, type, tf, params);
  const out = [];
  const add = (family, tag, tracks, extra = {}) => out.push({ family, tag, series: Array.isArray(tracks) ? tracks : [tracks], ...extra });
  const mid = (x, y) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = (x[i] + y[i]) / 2; return a; };

  // ── prior day ──
  const dl = S("daylevels", 1), rp = S("vprofile", 1, { anchor: "rth", mode: "prior" }), sp = S("vprofile", 1, { anchor: "session", mode: "prior" }), tp = S("vprofile", 1, { anchor: "rth", mode: "prior", weight: "time" });
  add("prior day", "PD high", dl.PDH); add("prior day", "PD low", dl.PDL); add("prior day", "PD close", dl.PDC); add("prior day", "PD mid", mid(dl.PDH, dl.PDL));
  add("prior day", "PD POC (RTH)", rp.POC); add("prior day", "PD VAH (RTH)", rp.VAH); add("prior day", "PD VAL (RTH)", rp.VAL);
  add("prior day", "PD POC (full session)", sp.POC); add("prior day", "PD VAH (full session)", sp.VAH); add("prior day", "PD VAL (full session)", sp.VAL);
  add("prior day", "PD TPO POC", tp.POC);
  const fl = S("pivots", 1, { style: "floor" }), cam = S("pivots", 1, { style: "camarilla" }), fib = S("pivots", 1, { style: "fib" });
  for (const k of ["P", "R1", "S1", "R2", "S2"]) add("prior day", `Floor ${k}`, fl[k]);
  for (const k of ["H3", "L3", "H4", "L4"]) add("prior day", `Camarilla ${k}`, cam[k]);
  for (const k of ["R1", "S1", "R2", "S2"]) add("prior day", `Fib pivot ${k}`, fib[k]);

  // ── overnight ──
  const on = S("clockrange", 1, { span: "overnight" });
  add("overnight", "Overnight high", on.high); add("overnight", "Overnight low", on.low); add("overnight", "Overnight mid", mid(on.high, on.low));
  for (const [span, name] of [["asia", "Asia"], ["london", "London"], ["premarket", "Pre-market"]]) {
    const r = S("clockrange", 1, { span });
    add("overnight", `${name} high`, r.high); add("overnight", `${name} low`, r.low);
  }

  // ── opens ──
  const op = S("opens", 1);
  add("opens", "RTH open", op.RTH); add("opens", "17:00 open", op["17:00"]); add("opens", "NY midnight open", op.midnight); add("opens", "Week open", op.week); add("opens", "Month open", op.month);

  // ── week and month ──
  for (const [period, P] of [["week", "PW"], ["month", "PM"]]) {
    const r = S("periodlevels", 1, { period }), v = S("vprofile", 1, { anchor: period, mode: "prior" });
    add(period, `${P} high`, r["prior high"]); add(period, `${P} low`, r["prior low"]); add(period, `${P} close`, r["prior close"]); add(period, `${P} mid`, mid(r["prior high"], r["prior low"]));
    add(period, `${P} POC`, v.POC); add(period, `${P} VAH`, v.VAH); add(period, `${P} VAL`, v.VAL);
  }
  const q = S("periodlevels", 1, { period: "quarter" });
  add("month", "PQ high", q["prior high"]); add("month", "PQ low", q["prior low"]); add("month", "PQ close", q["prior close"]);
  for (const [sessions, name] of [[1, "Monday"], [2, "Mon-Tue"]]) {
    const r = S("firstrange", 1, { period: "week", sessions });
    add("week", `${name} high`, r.high); add("week", `${name} low`, r.low); add("week", `${name} mid`, mid(r.high, r.low));
  }
  const mf = S("firstrange", 1, { period: "month", sessions: 1 });
  add("month", "Month's first day high", mf.high); add("month", "Month's first day low", mf.low);
  const wp = S("pivots", 1, { style: "floor", period: "week" }), mp = S("pivots", 1, { style: "floor", period: "month" });
  for (const k of ["P", "R1", "S1"]) { add("week", `Weekly pivot ${k}`, wp[k]); add("month", `Monthly pivot ${k}`, mp[k]); }

  // ── composite profiles ──
  for (const sessions of [5, 20, 60]) {
    const c = compositeLevels(b, { sessions, nodes: 6 });
    add("composite", `VP${sessions} POC`, c.poc); add("composite", `VP${sessions} VAH`, c.vah); add("composite", `VP${sessions} VAL`, c.val);
    add("composite", `VP${sessions} HVN`, c.hvn); add("composite", `VP${sessions} LVN`, c.lvn);
  }
  const nk = nakedPocs(b, { maxAge: 20 });
  add("composite", "Naked POC above", nk.above, { side: -1 }); add("composite", "Naked POC below", nk.below, { side: 1 });

  // ── round numbers, on each contract's own prices ──
  const grid = (step, skip) => (d) => {
    const off = Lab.rawOffset(meta, d.ms + 12 * 3600000), o = b.open[d.a] - off, res = [];
    for (let p = Math.floor((o - 1.5 * d.U) / step) * step; p < o + 1.5 * d.U; p += step) if (!(skip && p % skip === 0)) res.push(p + off);
    return res;
  };
  out.push({ family: "round", tag: "Round 500", list: grid(500), maxTouches: 1 }, { family: "round", tag: "Round 100", list: grid(100, 500), maxTouches: 1 },
           { family: "round", tag: "Round 50", list: grid(50, 100), maxTouches: 1 }, { family: "round", tag: "Round 25", list: grid(25, 50), maxTouches: 1 });

  // ── intraday, then fixed ──
  for (const m of [5, 15, 30]) { const r = S("openrange", 1, { minutes: m }); add("intraday", `OR${m} high`, r["OR high"]); add("intraday", `OR${m} low`, r["OR low"]); add("intraday", `OR${m} mid`, r.mid); }
  const ib = S("initialbalance", 1, { minutes: 60 });
  add("intraday", "IB high", ib["IB high"]); add("intraday", "IB low", ib["IB low"]); add("intraday", "IB mid", ib.mid);
  for (const m of [0.5, 1, 1.5, 2]) { add("intraday", `IB +${m}`, ib[`+${m}`]); add("intraday", `IB -${m}`, ib[`−${m}`]); }
  const dayMid = S("clockrange", 1, { span: "midday" });
  add("intraday", "Midday high", dayMid.high); add("intraday", "Midday low", dayMid.low);
  for (const [tf, left, right, name] of [[2, 5, 5, "2m"], [5, 3, 3, "5m"], [15, 3, 3, "15m"], [60, 3, 3, "1h"]]) {
    const r = S("swings", tf, { left, right });
    add("intraday", `Swing high ${name}`, r["swing high"], { side: -1 }); add("intraday", `Swing low ${name}`, r["swing low"], { side: 1 });
  }

  // ── developing ──
  for (const [anchor, name] of [["rth", "RTH"], ["session", "session"], ["week", "week"], ["month", "month"]]) {
    const v = S("vprofile", 1, { anchor });
    add("developing", `Dev POC (${name})`, v.POC); add("developing", `Dev VAH (${name})`, v.VAH); add("developing", `Dev VAL (${name})`, v.VAL);
  }
  add("developing", "Dev TPO POC (RTH)", S("vprofile", 1, { anchor: "rth", weight: "time" }).POC);
  for (const [anchor, name] of [["rth", "RTH"], ["session", "session"], ["week", "week"], ["month", "month"]]) {
    const v1 = S("vwap", 1, { anchor, bands: 1 }), v2 = S("vwap", 1, { anchor, bands: 2 });
    add("developing", `VWAP (${name})`, v1.VWAP);
    add("developing", `VWAP +1σ (${name})`, v1["+1σ"]); add("developing", `VWAP -1σ (${name})`, v1["−1σ"]);
    add("developing", `VWAP +2σ (${name})`, v2["+2σ"]); add("developing", `VWAP -2σ (${name})`, v2["−2σ"]);
  }
  for (const [period, name] of [["day", "day"], ["week", "week"], ["month", "month"]]) {
    const r = S("rangelevels", 1, { period });
    add("developing", `${name} high so far`, r.high, { side: -1 }); add("developing", `${name} low so far`, r.low, { side: 1 });
    add("developing", `${name} range 50%`, r["50%"]); add("developing", `${name} range 38.2%`, r["38.2%"]); add("developing", `${name} range 61.8%`, r["61.8%"]);
  }
  const ad = S("adrproj", 1, { days: 10, mult: 1 });
  add("developing", "Open + ADR", ad["+ADR"]); add("developing", "Open - ADR", ad["−ADR"]); add("developing", "Open + half ADR", ad["+½"]); add("developing", "Open - half ADR", ad["−½"]);
  add("developing", "Day low + ADR", ad["low+ADR"]); add("developing", "Day high - ADR", ad["high−ADR"]);
  for (const [tf, left, right, name] of [[1, 20, 20, "1m"], [5, 10, 10, "5m"], [15, 5, 5, "15m"]]) {
    const r = S("swingvwap", tf, { left, right });
    add("developing", `VWAP from swing high ${name}`, r["from high"]); add("developing", `VWAP from swing low ${name}`, r["from low"]);
  }
  add("developing", "Volume shelf 1m", S("volshelf", 1, { length: 60, mult: 4 }).shelf);
  add("developing", "Volume shelf 5m", S("volshelf", 5, { length: 48, mult: 3 }).shelf);

  // ── what this project's strategies and filters read ──
  const line = (type, tf, params, key) => Object.values(S(type, tf, params))[key ?? 0];
  for (const [tf, length] of [[2, 9], [2, 21], [2, 50], [2, 125], [2, 500], [10, 9], [10, 21], [60, 21], [60, 50]]) add("indicator", `EMA ${length} (${tf}m)`, line("ema", tf, { length }));
  add("indicator", "SMA 200 (5m)", line("sma", 5, { length: 200 }));
  const dc = S("donchian", 2, { length: 30 }), dc5 = S("donchian", 5, { length: 20 });
  add("indicator", "Donchian 30 high (2m)", dc.high, { side: -1 }); add("indicator", "Donchian 30 low (2m)", dc.low, { side: 1 }); add("indicator", "Donchian 30 mid (2m)", dc.mid);
  add("indicator", "Donchian 20 high (5m)", dc5.high, { side: -1 }); add("indicator", "Donchian 20 low (5m)", dc5.low, { side: 1 });
  const bb = S("bollinger", 5, { length: 20, mult: 2 }), kc = S("keltner", 5, { length: 20, mult: 2 }), lr = S("linreg", 5, { length: 50, mult: 2 }), ich = S("ichimoku", 5, {}), ch = S("chandelier", 5, {});
  add("indicator", "Bollinger upper (5m)", bb.upper); add("indicator", "Bollinger lower (5m)", bb.lower); add("indicator", "Bollinger mid (5m)", bb.mid);
  add("indicator", "Keltner upper (5m)", kc.upper); add("indicator", "Keltner lower (5m)", kc.lower);
  add("indicator", "Regression fit (5m)", lr.fit); add("indicator", "Regression upper (5m)", lr.upper); add("indicator", "Regression lower (5m)", lr.lower);
  add("indicator", "Ichimoku base (5m)", ich.base); add("indicator", "Ichimoku span A (5m)", ich["span A"]); add("indicator", "Ichimoku span B (5m)", ich["span B"]);
  add("indicator", "Supertrend (5m)", (() => { const r = S("supertrend", 5, {}), a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = Number.isFinite(r.up[i]) ? r.up[i] : r.down[i]; return a; })());
  add("indicator", "Parabolic SAR (5m)", line("psar", 5, {}));
  add("indicator", "Chandelier long stop (5m)", ch["long stop"]); add("indicator", "Chandelier short stop (5m)", ch["short stop"]);
  add("indicator", "Hull 20 (5m)", line("hma", 5, { length: 20 })); add("indicator", "KAMA 10 (5m)", line("kama", 5, { length: 10 })); add("indicator", "VWMA 20 (5m)", line("vwma", 5, { length: 20 }));
  return out;
}
