// Forward check of research/macd_momentum_tight.mjs on TopstepX's own bars: the shipped
// MACD fade beside momentum variants, from the first session with the full 10-session
// volatility gate (TopstepX keeps ~60 days of 1-minute history, so the window moves).
// Signal code as forward_macd_sizing.mjs. Each cell: as the engine books it | best case.
//
//   python bot/export_topstepx_bin.py
//   node research/forward_macd_momentum.mjs [bin]
//
// RESULT, Sep 11-Oct 26 2026 (32 sessions): everything lost. The fade -$2,742 (21.9%
// drawn, 3 of 12 real windows); following every cross (vol gate, stop 0.5, target 1)
// -$4,385 as booked, -$39 at best; the strong-cross versions -$2,500 to -$3,750
// (0-9%). The crosses carried no direction either way since mid-September.
import path from "node:path";
import { fileURLToPath } from "node:url";
const bin = process.argv[2] || fileURLToPath(new URL("../data/topstepx_1m.bin", import.meta.url));
process.env.ORB_BIN = path.resolve(bin);
const { macd } = await import("../src/indicators.mjs");
const S = await import("./lib_shipped.mjs");
const RULES = { target: 1250, dd: 1000, consistency: 0.5 };
const F = { slipMult: 1, feeMult: 1, limitFillTp: "close", cancelOpposite: true, exitFirst: true,
            dayCap: 600, breaker: 200, profitBlock: 250, trig: 0.15, tpFromFill: true };
const BEST = { fillBarStop: "close", sameBarTie: "target" };
const E1 = S.engineFor(1), t1 = E1.tf, A1 = E1.atr, n1 = t1.close.length;
const { line: ML, hist: HS } = macd(t1.close, 12, 26, 9);
const SIGA = new Int8Array(n1);
for (let i = 1; i < n1; i++) if (t1.ctMin[i] >= 510 && t1.ctMin[i] < 900) SIGA[i] = -(HS[i] > 0 && HS[i - 1] <= 0 ? 1 : HS[i] < 0 && HS[i - 1] >= 0 ? -1 : 0);
const volRel = new Float64Array(n1).fill(NaN), SESS = [];
{
  const first = new Map(), last = new Map();
  for (let i = 0; i < n1; i++) if (t1.ctMin[i] >= 510 && t1.ctMin[i] < 900) { if (!first.has(t1.tday[i])) { first.set(t1.tday[i], i); SESS.push(t1.tday[i]); } last.set(t1.tday[i], i); }
  const am = new Map();
  for (const d of SESS) { let s = 0, c = 0; for (let i = first.get(d); i <= last.get(d); i++) { s += A1[i]; c++; } am.set(d, s / c); }
  SESS.forEach((d, k) => { if (k < 10) return; const avg = SESS.slice(k - 10, k).reduce((x, p) => x + am.get(p), 0) / 10;
    for (let i = first.get(d); i <= last.get(d); i++) volRel[i] = A1[i] / avg; });
}
const EV = SESS.slice(10), FROM = EV[0], TO = EV[EV.length - 1];
const day = (td) => new Date(td * 86400000).toISOString().slice(0, 10);
const MOM = Int8Array.from(SIGA, (x) => -x), vol = (k) => !(volRel[k] < 1);
const fadeGate = (k) => SIGA[k] !== 0 && Math.sign(ML[k]) === SIGA[k] && vol(k);
const everyVol = (k) => MOM[k] !== 0 && vol(k), strongVol = (k) => MOM[k] !== 0 && Math.sign(ML[k]) === MOM[k] && vol(k);
const CFG = [["the shipped FADE", SIGA, fadeGate, 5, "fade"], ["follow every cross + vol gate, stop 0.5, target 1", MOM, everyVol, 0.5, 1],
             ["follow strong + vol gate, stop 0.5, next cross only", MOM, strongVol, 0.5, null], ["follow strong + vol gate, stop 1, target 2", MOM, strongVol, 1, 2],
             ["follow strong + vol gate, stop 2, target 2", MOM, strongVol, 2, 2], ["follow strong + vol gate, stop 5, target 2", MOM, strongVol, 5, 2]];
console.log(`${bin}: ${EV.length} sessions ${day(FROM)} .. ${day(TO)} (full 10-session volatility gate)`);
console.log("   setup                                                 trades   win%      net $   pass (21-day draws)   real 21-day windows      [engine | best case]");
for (const [name, sig, gate, sl, tg] of CFG) {
  const cells = [{}, BEST].map((extra) => {
    const T = E1.run((a, c, s, arm) => (gate(arm - 1) ? 4 : 0), { signals: sig, ...F, slMult: sl, ...extra,
      tpFn: tg === "fade" ? (a, q) => Math.min(5.15 * a, 600 / (2 * q)) : (a) => (tg === null ? 1e6 : tg * a) }).filter((t) => t.tday >= FROM && t.tday <= TO);
    const by = new Map(EV.map((d) => [d, 0]));
    for (const t of T) by.set(t.tday, by.get(t.tday) + t.pnl);
    const arr = EV.map((d) => by.get(d));
    let rp = 0, rn = 0;
    for (let s = 0; s + 21 <= arr.length; s++, rn++) rp += S.evWith(arr.slice(s, s + 21), RULES);
    return { n: T.length, win: (100 * T.filter((t) => t.pnl > 0).length) / T.length, net: T.reduce((s, t) => s + t.pnl, 0), p: S.passArr(arr, RULES), rp, rn };
  });
  const [a, b] = cells;
  console.log(`   ${name.padEnd(53)} ${String(a.n).padStart(4)} | ${String(b.n).padEnd(4)} ${a.win.toFixed(0).padStart(3)} | ${b.win.toFixed(0).padEnd(3)}` +
              ` ${Math.round(a.net).toString().padStart(6)} | ${Math.round(b.net).toString().padEnd(6)} ${a.p.toFixed(1).padStart(6)} | ${b.p.toFixed(1).padEnd(6)}` +
              `        ${a.rp} | ${b.rp} of ${a.rn}`);
}
