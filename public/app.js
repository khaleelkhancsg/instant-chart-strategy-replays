// App orchestration.
//
// The responsiveness trick: the strategy module and the rules engine are the
// SAME ES modules the server runs, imported straight into the page. A parameter
// change therefore re-runs the real backtest over the visible window locally —
// no request, no round trip, no server-side state. The only thing that goes over
// the network is the one-off window blob and the (debounced) 5-year sweep.

import { ChartView, Navigator, fmtUsd } from "/chart.js";
import { runStrategy, resolveParams } from "/src/run.mjs";
import { replayWindow, DEFAULT_RULES } from "/src/challenge.mjs";
import { DEFAULT_EXEC } from "/src/engine.mjs";
import { indexAtOrAfter } from "/src/resample.mjs";

const $ = (id) => document.getElementById(id);
const DAY = 86400000;

// ─────────────────────── parameter descriptors ───────────────────────
const EXEC_PARAMS = [
  { key: "contracts", label: "Contracts", type: "int", min: 1, max: 10, step: 1, default: 8,
    hint: "Prop firms cap MNQ size — 10 is the rule this project works under." },
  { key: "slAtrMult", label: "Stop (× ATR)", type: "float", min: 0.25, max: 8, step: 0.25, default: 2 },
  { key: "tpAtrMult", label: "Target (× ATR)", type: "float", min: 0.25, max: 40, step: 0.25, default: 12 },
  { key: "maxBarsInTrade", label: "Time stop (bars)", type: "int", min: 0, max: 400, step: 1, default: 0, hint: "0 = off" },
  { key: "commissionModel", label: "Commission model", type: "select", default: "per-contract",
    options: [["per-contract", "Per contract (realistic)"], ["flat", "Flat per trade (legacy)"]],
    hint: "Legacy lite_backtester runs used flat $5/trade, which understates cost ~2-3× at 8-10 lots." },
  { key: "commissionPerSide", label: "Commission $/side/contract", type: "float", min: 0, max: 3, step: 0.05, default: 0.75 },
  { key: "commissionFlat", label: "Flat commission $/trade", type: "float", min: 0, max: 30, step: 0.5, default: 5 },
  { key: "slippageTicks", label: "Slippage (ticks/side)", type: "float", min: 0, max: 4, step: 0.25, default: 0 },
];

const RULES_PARAMS = [
  { key: "profitTarget", label: "Profit target $", type: "int", min: 500, max: 20000, step: 100, default: 3000 },
  { key: "trailingDD", label: "Trailing drawdown $", type: "int", min: 250, max: 10000, step: 50, default: 2000 },
  { key: "trailingMode", label: "Drawdown trails on", type: "select", default: "eod",
    options: [["eod", "Daily closes (lenient)"], ["intraday", "Intraday peak (strict)"]],
    hint: "EOD trailing means an intraday spike you give back before the close does not tighten your floor." },
  { key: "evaluateOn", label: "Breach measured on", type: "select", default: "realized",
    options: [["realized", "Realised P&L only"], ["intraday", "Open equity (per-trade MAE)"]],
    hint: "Real firms breach on live equity. 'Open equity' checks each trade's worst excursion, pessimistically ordered." },
  { key: "dailyLossLimit", label: "Firm daily loss limit $", type: "int", min: 0, max: 5000, step: 50, default: 1000,
    hint: "Soft lockout — stop for the session, resume next day. Never fails the account." },
  { key: "dailyProfitStop", label: "Daily profit stop $", type: "int", min: 0, max: 5000, step: 50, default: 1500 },
  { key: "circuitBreaker", label: "Your daily breaker $", type: "int", min: 0, max: 2000, step: 25, default: 150,
    hint: "Your own tighter stop. The single biggest pass-rate lever in this project's testing. 0 = off." },
  { key: "consistencyPct", label: "Consistency cap %", type: "int", min: 0, max: 100, step: 5, default: 50,
    hint: "No single day may exceed this share of total profit at payout." },
  { key: "minTradingDays", label: "Min trading days", type: "int", min: 0, max: 30, step: 1, default: 0 },
  { key: "windowDays", label: "Window length (days)", type: "int", min: 5, max: 90, step: 1, default: 30 },
];

// ─────────────────────────────── state ───────────────────────────────
const S = {
  meta: null,
  strategyList: [],
  strategyDesc: null,
  strategyMod: null,
  params: {},
  exec: { ...DEFAULT_EXEC },
  rules: { ...DEFAULT_RULES },
  windowStart: null,
  blob: null,        // parsed window bars
  winStartLocal: 0,  // index of the window start inside the blob
  chart: null,
  nav: null,
  sweep: null,       // last full-history sweep result
  sweepStale: false, // params changed since that sweep ran
  sweeping: false,
  sweepTimer: 0,
  lastSweepKey: "",
};

// ───────────────────────── binary window parsing ─────────────────────────
function parseWindowBlob(ab) {
  const dv = new DataView(ab);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "MNQW") throw new Error("bad window blob");
  const n = dv.getUint32(8, true);
  const startIdx = dv.getUint32(12, true);
  let off = 16;
  const f64 = (c) => { const a = new Float64Array(ab, off, c); off += c * 8; return a; };
  const f32 = (c) => { const a = new Float32Array(ab, off, c); off += c * 4; return a; };
  const i32 = (c) => { const a = new Int32Array(ab, off, c); off += c * 4; return a; };
  return {
    ts: f64(n), open: f32(n), high: f32(n), low: f32(n),
    close: f32(n), volume: f32(n), tday: i32(n),
    count: n, startIdx,
  };
}

// ─────────────────────────── sidebar rendering ───────────────────────────
function buildParamControl(d, value, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "param";

  const head = document.createElement("div");
  head.className = "param-head";
  const lab = document.createElement("label");
  lab.textContent = d.label;
  head.appendChild(lab);

  if (d.type === "select") {
    wrap.appendChild(head);
    const sel = document.createElement("select");
    for (const [v, t] of d.options) {
      const o = document.createElement("option");
      o.value = v; o.textContent = t;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => onChange(sel.value));
    wrap.appendChild(sel);
  } else {
    const num = document.createElement("input");
    num.type = "number";
    num.className = "param-val";
    num.value = value;
    num.min = d.min; num.max = d.max; num.step = d.step;
    head.appendChild(num);
    wrap.appendChild(head);

    const rng = document.createElement("input");
    rng.type = "range";
    rng.min = d.min; rng.max = d.max; rng.step = d.step; rng.value = value;
    wrap.appendChild(rng);

    const emit = (raw) => {
      let v = Number(raw);
      if (!Number.isFinite(v)) return;
      v = Math.min(d.max, Math.max(d.min, v));
      if (d.type === "int") v = Math.round(v);
      rng.value = v; num.value = v;
      onChange(v);
    };
    rng.addEventListener("input", () => emit(rng.value));
    num.addEventListener("change", () => emit(num.value));
  }

  if (d.hint) {
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = d.hint;
    wrap.appendChild(h);
  }
  return wrap;
}

function buildGroup(title, collapsed = false) {
  const g = document.createElement("div");
  g.className = "group" + (collapsed ? " collapsed" : "");
  const head = document.createElement("div");
  head.className = "group-head";
  head.innerHTML = `<span class="group-title">${title}</span><span class="group-caret">▼</span>`;
  head.addEventListener("click", () => g.classList.toggle("collapsed"));
  const body = document.createElement("div");
  body.className = "group-body";
  g.appendChild(head); g.appendChild(body);
  g.body = body;
  return g;
}

function renderSidebar() {
  const host = $("paramGroups");
  host.innerHTML = "";

  // Live results first — it is what you watch while dragging a slider.
  const gStats = buildGroup("This window");
  gStats.body.innerHTML = `<div class="statgrid" id="statGrid"></div>`;
  host.appendChild(gStats);

  // …and the same view across every window in the dataset. One window is an
  // anecdote; this panel is the distribution the anecdote was drawn from.
  const gSweep = buildGroup("All windows");
  gSweep.body.innerHTML = `<div id="sweepPanel"></div>`;
  host.appendChild(gSweep);

  // Signal params, declared by the strategy itself.
  const sig = buildGroup("Signal");
  const tfDesc = {
    key: "timeframeMin", label: "Signal timeframe (min)", type: "int",
    min: 1, max: 60, step: 1, default: S.strategyDesc.timeframeMin,
    hint: "Bars are rebuilt clock-aligned from the 1-minute source.",
  };
  for (const d of [tfDesc, ...(S.strategyDesc.params || [])]) {
    sig.body.appendChild(buildParamControl(d, S.params[d.key], (v) => {
      S.params[d.key] = v;
      onParamsChanged(d.key === "timeframeMin");
    }));
  }
  host.appendChild(sig);

  const ex = buildGroup("Execution & costs");
  for (const d of EXEC_PARAMS) {
    ex.body.appendChild(buildParamControl(d, S.exec[d.key], (v) => {
      S.exec[d.key] = v;
      onParamsChanged();
    }));
  }
  host.appendChild(ex);

  const ru = buildGroup("Combine rules");
  for (const d of RULES_PARAMS) {
    ru.body.appendChild(buildParamControl(d, S.rules[d.key], (v) => {
      const needsReload = d.key === "windowDays";
      S.rules[d.key] = v;
      if (needsReload) loadWindow(S.windowStart);
      else onParamsChanged();
    }));
  }
  host.appendChild(ru);
  paintSweepStats();
}

// ───────────────────── all-windows (sweep) panel ─────────────────────
function median(arr) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function paintSweepStats() {
  const host = $("sweepPanel");
  if (!host) return;

  if (!S.sweep) {
    host.innerHTML = `<div class="sweep-empty">${
      S.sweeping ? "Sweeping every 30-day window…" : "Not run yet — press <b>Run full sweep</b>."
    }</div>`;
    return;
  }

  const { windows, summary: s, stats: g } = S.sweep;
  const stale = S.sweepStale;

  const nets = windows.map((w) => w.netPnl);
  const passed = windows.filter((w) => w.outcome === "PASS");
  const failed = windows.filter((w) => w.outcome === "FAIL");
  const sign = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");

  // Pass rate by calendar year. The spec puts realistic outcomes anywhere from
  // ~63% (choppy) to ~85% (trending), so the spread across years is the honest
  // picture of what a single attempt is actually exposed to.
  const byYear = new Map();
  for (const w of windows) {
    const y = new Date(w.startMs).getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, { n: 0, pass: 0 });
    const b = byYear.get(y);
    b.n++;
    if (w.outcome === "PASS") b.pass++;
  }
  const maxYearN = Math.max(...[...byYear.values()].map((b) => b.n));
  const yearRows = [...byYear.entries()].map(([y, b]) => {
    const pct = (b.pass / b.n) * 100;
    // A part-year (the dataset starts mid-2021 and ends mid-2026) rests on far
    // fewer windows, so mark it rather than let it read as an equal peer.
    const partial = b.n < maxYearN * 0.8;
    return `<div class="yr${partial ? " partial" : ""}" title="${b.n} windows${partial ? " (partial year)" : ""}">
      <span class="yr-k">${y}${partial ? "*" : ""}</span>
      <span class="yr-bar"><i style="width:${pct.toFixed(1)}%"></i></span>
      <span class="yr-v">${pct.toFixed(0)}%</span>
    </div>`;
  }).join("") + `<div class="yr-note">* partial year — fewer windows behind the number</div>`;

  host.innerHTML = `
    <div class="sweep-head ${stale ? "stale" : ""}">
      <div class="sweep-rate">${s.passRate.toFixed(1)}<span>%</span></div>
      <div class="sweep-sub">
        pass rate<br>
        <span class="k">${s.n.toLocaleString()} windows · every start date</span>
      </div>
    </div>

    <div class="stackbar" title="pass / fail / unresolved">
      <i class="sb-pass" style="width:${s.passRate}%"></i>
      <i class="sb-fail" style="width:${s.failRate}%"></i>
      <i class="sb-open" style="width:${s.openRate}%"></i>
    </div>
    <div class="stackkey">
      <span><b class="sb-pass"></b>${s.passRate.toFixed(1)}% pass</span>
      <span><b class="sb-fail"></b>${s.failRate.toFixed(1)}% breached</span>
      <span><b class="sb-open"></b>${s.openRate.toFixed(1)}% ran out of time</span>
    </div>

    <div class="statgrid" style="margin-top:9px">
      ${statCell("Median days to pass", s.medianDaysToPass ?? "—")}
      ${statCell("Median net / window", fmtUsd(median(nets) ?? 0), sign(median(nets) ?? 0))}
      ${statCell("Best window", fmtUsd(Math.max(...nets)), "pos")}
      ${statCell("Worst window", fmtUsd(Math.min(...nets)), "neg")}
      ${statCell("Median trades / window", median(windows.map((w) => w.trades)) ?? 0)}
      ${statCell("Median breach margin", fmtUsd(median(failed.map((w) => w.minCushion).filter((v) => v != null)) ?? 0), "neg")}
    </div>

    <div class="sweep-label">Pass rate by year</div>
    <div class="yrs">${yearRows}</div>

    <div class="sweep-label">Full history (all ${g.n.toLocaleString()} trades)</div>
    <div class="statgrid">
      ${statCell("Net P&L", fmtUsd(g.pnl), sign(g.pnl))}
      ${statCell("Profit factor", Number.isFinite(g.profitFactor) ? g.profitFactor.toFixed(3) : "∞")}
      ${statCell("Expectancy", fmtUsd(g.expectancy, 2), sign(g.expectancy))}
      ${statCell("Trades / day", g.tradesPerDay.toFixed(2))}
      ${statCell("Win rate", g.winRate.toFixed(1) + "%")}
      ${statCell("Avg win / loss", `${fmtUsd(g.avgWin)} / ${fmtUsd(g.avgLoss)}`)}
    </div>

    <div class="sweep-foot">${
      stale ? `<span class="warn">Parameters changed — re-sweeping…</span>`
            : `${S.sweep.backtestMs}ms backtest + ${S.sweep.sweepMs}ms sweep · ${passed.length} pass / ${failed.length} breach`
    }</div>
  `;
}

// ───────────────────────────── recompute ─────────────────────────────
let rafPending = 0;
let lastResult = null;

function onParamsChanged(needsWarmupCheck = false) {
  if (needsWarmupCheck) { loadWindow(S.windowStart); return; }
  if (rafPending) return;
  rafPending = requestAnimationFrame(() => { rafPending = 0; recompute(); });
  scheduleSweep();
}

function recompute() {
  if (!S.blob || !S.strategyMod) return;
  const t0 = performance.now();

  const res = runStrategy(S.blob, S.strategyMod, S.params, S.exec, { fromMs: S.windowStart });
  const replay = replayWindow(res.trades, S.windowStart, S.rules);
  const ms = performance.now() - t0;

  lastResult = { res, replay };
  paintChart(res, replay);
  paintStats(res, replay);

  $("perf").innerHTML =
    `<b>${ms.toFixed(1)} ms</b> local re-run<br>${res.tf.close.length.toLocaleString()} × ${S.params.timeframeMin}m bars`;
}

function paintChart(res, replay) {
  const blob = S.blob;

  // Rules decide which signals actually became trades, so annotate the strategy's
  // trades with the replay's verdict rather than drawing two separate sets.
  const byKey = new Map();
  for (const e of replay.events) byKey.set(e.k, e);

  const trades = res.trades.map((t, k) => {
    const e = byKey.get(k);
    return {
      ...t,
      xStart: t.entrySrc, xEnd: t.exitSrc,
      taken: e ? e.taken : false,
      skip: e ? e.skip : "outside",
      cum: e ? e.cum : null,
    };
  });

  const equityPts = replay.events.filter((e) => e.taken).map((e) => ({
    x: e.t.exitSrc, cum: e.cum, floor: e.floor, pnl: e.t.pnl,
  }));

  const dayBars = replay.days.map((d) => ({
    ...d,
    xStart: indexAtOrAfter(blob.ts, d.firstMs),
    xEnd: indexAtOrAfter(blob.ts, d.lastMs),
  }));

  const tf = res.tf;
  const priceOverlays = (res.overlays || []).filter((o) => o.pane !== "sub");
  const subOverlays = (res.overlays || []).filter((o) => o.pane === "sub");

  S.chart.setData({
    token: `${S.windowStart}:${blob.count}`,
    bars: blob,
    trades,
    replay,
    equityPts,
    dayBars,
    priceOverlays,
    subOverlays,
    // Overlays are indexed in signal-timeframe space; stride lets the renderer
    // convert a 1-minute pixel budget into a sane sampling step.
    tfToLocal: { localIdx: tf.srcLast, stride: S.params.timeframeMin || 1 },
    lockX: replay.lockMs ? indexAtOrAfter(blob.ts, replay.lockMs) : null,
    title: `MNQ · ${S.strategyDesc.name}`,
    initialView: [S.winStartLocal, blob.count],
  });
}

function statCell(k, v, cls = "") {
  return `<div class="stat"><div class="stat-k">${k}</div><div class="stat-v ${cls}">${v}</div></div>`;
}

function paintStats(res, replay) {
  const st = replay.stats;
  const R = replay.rules;

  const badge = $("verdict").firstElementChild;
  badge.className = "badge " + (replay.outcome === "PASS" ? "pass" : replay.outcome === "FAIL" ? "fail" : "open");
  badge.textContent = replay.outcome === "IN_PROGRESS" ? "UNRESOLVED" : replay.outcome;

  const pct = Math.max(0, Math.min(100, (st.netPnl / R.profitTarget) * 100));
  const sign = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");

  $("statGrid").innerHTML =
    `<div class="stat wide">
       <div class="stat-k">Net P&amp;L · target ${fmtUsd(R.profitTarget)}</div>
       <div class="stat-v ${sign(st.netPnl)}">${fmtUsd(st.netPnl)}</div>
       <div class="progress"><div style="width:${pct}%"></div></div>
     </div>` +
    statCell("Trades taken", st.trades) +
    statCell("Skipped by rules", st.skipped, st.skipped ? "neg" : "") +
    statCell("Win rate", st.winRate.toFixed(1) + "%") +
    statCell("Profit factor", Number.isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : "∞") +
    statCell("Expectancy", fmtUsd(st.expectancy, 2), sign(st.expectancy)) +
    statCell("Trading days", st.tradingDays) +
    statCell("Best day", fmtUsd(st.maxDayPnl), sign(st.maxDayPnl)) +
    statCell("Consistency", st.netPnl > 0 ? st.consistencyRatio.toFixed(0) + "%" : "—",
             st.netPnl > 0 && st.consistencyRatio > R.consistencyPct ? "neg" : "") +
    statCell("Closest to breach", st.minCushion == null ? "—" : fmtUsd(st.minCushion),
             st.minCushion != null && st.minCushion < 500 ? "neg" : "") +
    statCell("Floor now", fmtUsd(st.finalFloor) + (st.locked ? " 🔒" : "")) +
    statCell("Days used", `${st.daysUsed} / ${R.windowDays}`) +
    // Fees for trades that were ACTUALLY taken before the window resolved — not
    // the whole 30 days, which would count trades that never happened.
    statCell("Commission", fmtUsd(replay.events.reduce((a, e) => a + (e.taken ? e.t.fees : 0), 0)), "neg");

  $("topStats").innerHTML =
    `<div class="tstat"><div class="tstat-k">Net P&amp;L</div><div class="tstat-v ${sign(st.netPnl)}">${fmtUsd(st.netPnl)}</div></div>` +
    `<div class="tstat"><div class="tstat-k">Trades</div><div class="tstat-v">${st.trades}${st.skipped ? ` <span style="color:var(--dim)">+${st.skipped} skipped</span>` : ""}</div></div>` +
    `<div class="tstat"><div class="tstat-k">Win rate</div><div class="tstat-v">${st.winRate.toFixed(1)}%</div></div>` +
    `<div class="tstat"><div class="tstat-k">Profit factor</div><div class="tstat-v">${Number.isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : "∞"}</div></div>` +
    `<div class="tstat"><div class="tstat-k">Closest to breach</div><div class="tstat-v ${st.minCushion != null && st.minCushion < 500 ? "neg" : ""}">${st.minCushion == null ? "—" : fmtUsd(st.minCushion)}</div></div>`;
}

// ─────────────────────────── window loading ───────────────────────────
async function loadWindow(startMs) {
  S.windowStart = startMs;
  const tf = S.params.timeframeMin || 1;
  const warmupBars = S.strategyDesc.warmupBars || 300;
  // Warm-up is measured in signal bars but requested in wall-clock minutes, so
  // pad generously for weekends and holidays where no bars exist at all.
  const warmupMin = Math.ceil(warmupBars * tf * 1.5) + 3 * 1440;

  const url = `/api/window?start=${startMs}&days=${S.rules.windowDays}&warmupMin=${warmupMin}`;
  const ab = await fetch(url).then((r) => r.arrayBuffer());
  S.blob = parseWindowBlob(ab);
  S.winStartLocal = indexAtOrAfter(S.blob.ts, startMs);

  const d = new Date(startMs);
  $("startDate").value = d.toISOString().slice(0, 10);
  const end = new Date(startMs + S.rules.windowDays * DAY);
  $("winRange").textContent = `→ ${end.toISOString().slice(0, 10)} · ${S.blob.count.toLocaleString()} 1-min bars`;
  if (S.nav) { S.nav.cursorMs = startMs; S.nav.draw(); }

  recompute();
  scheduleSweep();
}

function stepWindow(days) {
  const lo = S.meta.startMs;
  const hi = S.meta.endMs - S.rules.windowDays * DAY;
  loadWindow(Math.max(lo, Math.min(hi, S.windowStart + days * DAY)));
}

// ──────────────────────── full-history sweep ────────────────────────
function sweepKey() {
  return JSON.stringify([S.strategyDesc.id, S.params, S.exec, S.rules]);
}

function scheduleSweep() {
  clearTimeout(S.sweepTimer);
  // The window panel updates instantly, but the sweep needs the server and all
  // 1.77M bars — so flag the numbers as stale the moment they stop being true.
  if (S.sweep && sweepKey() !== S.lastSweepKey && !S.sweepStale) {
    S.sweepStale = true;
    paintSweepStats();
  }
  S.sweepTimer = setTimeout(runSweep, 700);
}

async function runSweep() {
  const key = sweepKey();
  if (S.sweeping || key === S.lastSweepKey) return;
  S.sweeping = true;
  $("runSweep").disabled = true;
  if (!S.sweep) paintSweepStats();
  $("navSummary").innerHTML = `<span class="k">sweeping all 30-day windows…</span>`;

  try {
    const r = await fetch("/api/sweep", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        strategyId: S.strategyDesc.id,
        params: S.params, exec: S.exec, rules: S.rules,
        stepDays: 1,
      }),
    }).then((x) => x.json());

    if (r.error) throw new Error(r.error);
    S.lastSweepKey = key;
    S.sweep = r;
    S.sweepStale = false;

    S.nav.set(r.windows, [S.meta.startMs, S.meta.endMs], S.windowStart);
    paintSweepStats();
    const s = r.summary;
    $("navSummary").innerHTML =
      `<span class="k">${s.n.toLocaleString()} × ${S.rules.windowDays}-day windows</span> · ` +
      `<span class="pass">${s.passRate.toFixed(1)}% pass</span> · ` +
      `<span class="fail">${s.failRate.toFixed(1)}% breached</span> · ` +
      `${s.openRate.toFixed(1)}% unresolved` +
      (s.medianDaysToPass ? ` · median ${s.medianDaysToPass}d to pass` : "") +
      ` <span class="k">— see “All windows” in the sidebar</span>`;
  } catch (e) {
    toast(e.message, true);
    S.sweepStale = false;
    $("navSummary").innerHTML = `<span class="k">sweep failed</span>`;
  } finally {
    S.sweeping = false;
    $("runSweep").disabled = false;
  }
}

// ─────────────────────────────── misc UI ───────────────────────────────
let toastTimer = 0;
function toast(msg, isErr = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

function tradeTooltip(t, ev) {
  const el = $("tooltip");
  if (!t) { el.classList.add("hidden"); return; }
  const row = (k, v, cls = "") => `<div class="row"><span>${k}</span><span class="${cls}">${v}</span></div>`;
  const dir = t.dir === 1 ? "LONG" : "SHORT";
  const color = !t.taken ? "var(--dim)" : t.pnl > 0 ? "var(--bull)" : "var(--bear)";
  el.innerHTML =
    `<div class="t-head" style="color:${color}">${dir} ${t.contracts} @ ${t.entryPrice.toFixed(2)}${t.taken ? "" : " · SKIPPED"}</div>` +
    (t.taken
      ? row("P&L", fmtUsd(t.pnl, 2), t.pnl > 0 ? "" : "") + row("Exit", `${t.exitPrice.toFixed(2)} (${t.reason})`)
      : row("Blocked by", { profitStop: "daily profit stop", breaker: "your daily breaker", dailyLoss: "firm daily limit", outside: "outside window" }[t.skip] || t.skip)) +
    row("Stop / target", `${t.stop.toFixed(2)} / ${t.target.toFixed(2)}`) +
    row("MAE / MFE", `${fmtUsd(t.mae)} / ${fmtUsd(t.mfe)}`) +
    row("Bars held", t.bars) +
    row("Entered", new Date(t.entryTime).toISOString().slice(0, 16).replace("T", " ")) +
    (t.taken && t.cum != null ? row("Equity after", fmtUsd(t.cum)) : "");
  el.classList.remove("hidden");
  const pad = 14;
  el.style.left = Math.min(window.innerWidth - el.offsetWidth - 8, ev.clientX + pad) + "px";
  el.style.top = Math.min(window.innerHeight - el.offsetHeight - 8, ev.clientY + pad) + "px";
}

// ─────────────────────────────── boot ───────────────────────────────
async function selectStrategy(id) {
  S.strategyDesc = S.strategyList.find((s) => s.id === id) || S.strategyList[0];
  $("strategyDesc").textContent = S.strategyDesc.description || "";
  const mod = await import(`/strategies/${S.strategyDesc.file}?t=${Date.now()}`);
  S.strategyMod = mod.default;
  S.params = resolveParams(S.strategyMod, {});
  // Old sweep belongs to a different strategy — drop it rather than show numbers
  // that no longer describe anything on screen.
  S.sweep = null;
  S.sweepStale = false;
  S.lastSweepKey = "";
  renderSidebar();
  await loadWindow(S.windowStart);
}

async function boot() {
  S.meta = await fetch("/api/meta").then((r) => r.json());
  S.exec = { ...S.meta.defaults.exec };
  S.rules = { ...S.meta.defaults.rules };

  $("datasetInfo").textContent =
    `${S.meta.bars.toLocaleString()} 1-min bars · ${new Date(S.meta.startMs).toISOString().slice(0, 10)} → ${new Date(S.meta.endMs).toISOString().slice(0, 10)}`;

  S.strategyList = await fetch("/api/strategies").then((r) => r.json());
  if (!S.strategyList.length) { toast("No strategies found in strategies/", true); return; }

  const sel = $("strategy");
  sel.innerHTML = "";
  for (const s of S.strategyList) {
    const o = document.createElement("option");
    o.value = s.id; o.textContent = s.name;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => selectStrategy(sel.value));

  S.chart = new ChartView($("chartWrap"));
  S.chart.onHoverTrade = (t) => { window._hoverTrade = t; };
  $("chartWrap").addEventListener("mousemove", (e) => tradeTooltip(window._hoverTrade, e));
  $("chartWrap").addEventListener("mouseleave", () => tradeTooltip(null));

  S.nav = new Navigator($("nav"), (ms) => {
    const hi = S.meta.endMs - S.rules.windowDays * DAY;
    loadWindow(Math.max(S.meta.startMs, Math.min(hi, ms)));
  });

  // Start 30 days in so the warm-up prefix has real history behind it.
  S.windowStart = S.meta.startMs + 30 * DAY;
  await selectStrategy(S.strategyList[0].id);

  $("prevWin").onclick = () => stepWindow(-1);
  $("nextWin").onclick = () => stepWindow(1);
  $("startDate").onchange = (e) => {
    const ms = Date.parse(e.target.value + "T00:00:00Z");
    if (Number.isFinite(ms)) loadWindow(ms);
  };
  $("runSweep").onclick = () => { S.lastSweepKey = ""; runSweep(); };
  $("reloadStrategies").onclick = async () => {
    S.strategyList = await fetch("/api/strategies/reload").then((r) => r.json());
    sel.innerHTML = "";
    for (const s of S.strategyList) {
      const o = document.createElement("option");
      o.value = s.id; o.textContent = s.name;
      sel.appendChild(o);
    }
    toast(`Loaded ${S.strategyList.length} strategies`);
    await selectStrategy(S.strategyList.some((s) => s.id === S.strategyDesc.id) ? S.strategyDesc.id : S.strategyList[0].id);
  };
  $("resetParams").onclick = () => {
    S.params = resolveParams(S.strategyMod, {});
    S.exec = { ...S.meta.defaults.exec };
    S.rules = { ...S.meta.defaults.rules };
    renderSidebar();
    loadWindow(S.windowStart);
  };

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "ArrowLeft") { stepWindow(e.shiftKey ? -7 : -1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { stepWindow(e.shiftKey ? 7 : 1); e.preventDefault(); }
    else if (e.key === "r") S.chart.resetView();
  });
}

// Debug handle: lets the console (and the verification scripts) inspect exactly
// what the chart was handed, rather than re-deriving it and testing a copy.
window.lab = { S, get chart() { return S.chart; }, get last() { return lastResult; }, recompute };

boot().catch((e) => { console.error(e); toast(e.message, true); });
