// Golden fixture for the $1,250 Donchian TopstepX bot (bot/mnq_donchian1250_bot.py).
//
// The bot re-implements this strategy in Python. This dumps what it must
// reproduce, from the same data and the same engine the research measured:
//
//   donchian1250_1m.bin      the RAW 1-minute bars the bot is fed, from 50
//                            sessions before 2026 (warm-up) to the end of the data
//   donchian1250_2m.bin      the engine's 2-minute bars and every reading the
//                            strategy uses, bar by bar: ATR, ADX, the Donchian
//                            channel, efficiency, the gated signal (with the
//                            slow-trend rescue), the 10-min EMA direction, the
//                            day's range used, the size, whether it is traded
//   donchian1250_trades.json every engine trade over the window, and the 2026
//                            pass rates the research reported
//
// The engine run is the one tradovate/verify_1250.mjs checks the Tradovate
// indicator against: research/lib_shipped.mjs with the $1,250 rules (daily
// limit $600, breaker -$300, profit block +$250), honest limit fills, 1 tick of
// slippage and $0.75 a side, cancelOpposite, the causal exit order, the 40-minute
// exit, 4 lots (2 late in the day), the 10-min EMA 9/21 filter.
//
// The files are gitignored (raw market data); regenerate with
//   node --max-old-space-size=8192 research/export_bot1250_fixture.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFilterContext, applyFilters, NO_FILTER } from "../src/filters.mjs";
import { adx as adxOf, atr as atrOf, donchian, ema, efficiencyRatio } from "../src/indicators.mjs";
import { resample } from "../src/resample.mjs";
import { loadBars } from "../src/data.mjs";
import * as S from "./lib_shipped.mjs";
import * as M from "./lib_donchian_mgmt.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "bot", "fixtures");
fs.mkdirSync(OUT, { recursive: true });
const WARMUP_SESSIONS = 50;
const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const FILL = { slipMult: 1, feeMult: 1, limitFillTp: "close", dayCap: 600, profitBlock: 250, cancelOpposite: true };

const { bars } = loadBars();
const tf = M.tf, nT = tf.close.length;

// ---- the signal, exactly as tradovate/verify_1250.mjs builds it ------------------------------
const ctx = buildFilterContext(tf);
const { adx: ax } = adxOf(tf.high, tf.low, tf.close, 14);
const A = atrOf(tf.high, tf.low, tf.close, 14);
const { high: dh, low: dl } = donchian(tf.high, tf.low, 30);
const eff = efficiencyRatio(tf.close, 20);
const raw = new Int8Array(nT);
for (let i = 30; i < nT; i++) {
  if (ax[i] < 25) continue;
  if (tf.close[i] > dh[i]) raw[i] = 1; else if (tf.close[i] < dl[i]) raw[i] = -1;
}
const plain = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.5 });
const low = applyFilters(raw, ctx, { ...NO_FILTER, startCt: 510, endCt: 900, effMin: 0.45 });
const ef = ema(tf.close, 125), es = ema(tf.close, 500);
const SIG = Int8Array.from(plain);
for (let k = 1499; k < nT; k++) if (!plain[k] && low[k] && (Math.sign(ef[k] - es[k]) || 0) === raw[k]) SIG[k] = low[k];
const HTF = new Int8Array(nT);
{
  const T10 = resample(bars, 10), f10 = ema(T10.close, 9), s10 = ema(T10.close, 21);
  let j = -1;
  for (let k = 0; k < nT; k++) {
    const lim = tf.ts[k] + 120000 - 600000;
    while (j + 1 < T10.ts.length && T10.ts[j + 1] <= lim) j++;
    HTF[k] = j >= 0 ? Math.sign(f10[j] - s10[j]) || 0 : 0;
  }
}
const gate = (k) => SIG[k] !== 0 && HTF[k] === SIG[k];
const exit20 = (k, d, st) => k - st.entBar >= 20 && (st.dir === 1 ? st.mx - st.fill : st.fill - st.mn) < st.atr;
const lib = S.run((a, c, s, arm) => (gate(arm - 1) ? (M.adrUsed(arm - 1) >= 0.9 ? 2 : 4) : 0),
                  { signals: SIG, ...FILL, breaker: 300, exitFn: exit20, exitFirst: true, detail: true });

// ---- the window: 50 sessions of warm-up, then 2026 to the end of the data ----------------------
const first26 = S.days[M.Y26[0]];
const startDay = S.days[S.days.indexOf(first26) - WARMUP_SESSIONS];
let i0 = 0; while (bars.tday[i0] < startDay) i0++;
let k0 = 0; while (tf.tday[k0] < startDay) k0++;
const n1 = bars.count - i0, n2 = nT - k0;

function writeBin(file, cols) {
  const n = cols[0][1].length;
  const size = 16 + cols.reduce((s, [, a]) => s + a.BYTES_PER_ELEMENT * n, 0);
  const buf = Buffer.alloc(size);
  buf.write("D125", 0, "latin1"); buf.writeUInt32LE(1, 4); buf.writeUInt32LE(n, 8); buf.writeUInt32LE(cols.length, 12);
  let off = 16;
  for (const [, a] of cols) { Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(buf, off); off += a.byteLength; }
  fs.writeFileSync(path.join(OUT, file), buf);
  return cols.map(([name, a]) => [name, a.constructor.name]);
}
const sub = (a) => a.subarray ? a.subarray : null;
const cut1 = (a) => a.slice(i0);
const cut2 = (a) => a.slice(k0);
const layout1 = writeBin("donchian1250_1m.bin", [
  ["ts", cut1(bars.ts)], ["open", cut1(bars.open)], ["high", cut1(bars.high)], ["low", cut1(bars.low)],
  ["close", cut1(bars.close)], ["volume", cut1(bars.volume)]]);
const used = Float64Array.from({ length: n2 }, (_, q) => M.adrUsed(k0 + q));
const lots = Int8Array.from({ length: n2 }, (_, q) => (M.adrUsed(k0 + q) >= 0.9 ? 2 : 4));
const enter = Int8Array.from({ length: n2 }, (_, q) => (gate(k0 + q) ? 1 : 0));
const trend = Int8Array.from({ length: n2 }, (_, q) => Math.sign(ef[k0 + q] - es[k0 + q]) || 0);
const layout2 = writeBin("donchian1250_2m.bin", [
  ["ts", cut2(tf.ts)], ["atr", cut2(A)], ["adx", cut2(ax)], ["dh", cut2(dh)], ["dl", cut2(dl)], ["eff", cut2(eff)], ["used", used],
  ["tday", cut2(tf.tday)],
  ["open", cut2(tf.open)], ["high", cut2(tf.high)], ["low", cut2(tf.low)], ["close", cut2(tf.close)],
  ["ct", cut2(tf.ctMin)],
  ["raw", cut2(raw)], ["sig", cut2(SIG)], ["htf", cut2(HTF)], ["trend", trend], ["enter", enter], ["lots", lots]]);

// ---- trades and pass rates --------------------------------------------------------------------
const trades = lib.filter((t) => t.tday >= startDay).map((t) => ({
  tday: t.tday, entTs: tf.ts[t.entBar], xTs: tf.ts[t.xBar], sigTs: tf.ts[t.sigBar], dir: t.dir, lots: t.lots,
  avg: t.avg, pnl: t.pnl, why: t.why, entCt: t.entCt, atr: t.atr }));
const arr = S.dayArr(lib, S.days);
const p = (ix) => S.passArr(ix.map((k) => arr[k]), RULES);
let cp = 0, cn = 0;
const d26 = M.Y26.map((k) => arr[k]);
for (let q = 0; q + 21 <= d26.length; q++) { cp += S.evWith(d26.slice(q, q + 21), RULES); cn++; }
const out = {
  note: "Engine run: research/lib_shipped.mjs, $1,250 rules, see research/export_bot1250_fixture.mjs",
  rules: RULES, warmupSessions: WARMUP_SESSIONS, startDay, first2026: first26,
  days2026: M.Y26.map((k) => S.days[k]), days2026a: M.Y26a.map((k) => S.days[k]), days2026b: M.Y26b.map((k) => S.days[k]),
  pass2026: { y: p(M.Y26), a: p(M.Y26a), b: p(M.Y26b), real: (100 * cp) / cn },
  layout1m: layout1, layout2m: layout2, trades,
};
fs.writeFileSync(path.join(OUT, "donchian1250_trades.json"), JSON.stringify(out));
const t26 = trades.filter((t) => t.tday >= first26);
console.log(`1-min bars ${n1.toLocaleString()}, 2-min bars ${n2.toLocaleString()}, from tday ${startDay} (${WARMUP_SESSIONS} sessions before 2026)`);
console.log(`engine trades in the window ${trades.length}, in 2026 ${t26.length}`);
console.log(`2026 pass rate ${out.pass2026.y.toFixed(1)}% (Jan-Mar ${out.pass2026.a.toFixed(1)}, Apr-Jul ${out.pass2026.b.toFixed(1)}), real windows ${out.pass2026.real.toFixed(1)}%`);
console.log(`written to ${OUT}`);
