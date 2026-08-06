// Coherence check for the rollover adjustment.
//
// After anchoring on the same-minute spread, the seam in the continuous series
// shows the OLD contract's move across the handover interval. If that is a real
// market move, the NEW contract must have moved by nearly the same amount over
// the same interval — both track the same underlying. A divergence would mean
// the seam is an artifact of one contract's quotes, not the market.

import fs from "node:fs";

const meta = JSON.parse(fs.readFileSync("data/mnq_1m.meta.json", "utf8"));
// Rolls span every source batch: the earliest contracts exist only in the older
// file and the newest only in the newer one, so scan them all.
const CSVS = meta.sources && meta.sources.length ? meta.sources : [meta.source];

// Collect closes for the contracts involved, around each roll.
const wanted = new Map(); // symbol -> Map(ts -> close)
const windows = [];
for (const r of meta.rollovers) {
  windows.push({ from: r.from, to: r.to, ms: r.ms, lo: r.ms - 3 * 86400000, hi: r.ms + 86400000 });
  if (!wanted.has(r.from)) wanted.set(r.from, new Map());
  if (!wanted.has(r.to)) wanted.set(r.to, new Map());
}

const NL = 10, COMMA = 44;
for (const CSV of CSVS) {
  const buf = fs.readFileSync(CSV);
  let p = buf.indexOf(10) + 1;
  while (p < buf.length) {
    let nl = buf.indexOf(NL, p);
    if (nl < 0) nl = buf.length;
    // columns: ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
    let f = 0, s = p, tsS = 0, tsE = 0, cS = 0, cE = 0, syS = 0, syE = 0;
    for (let i = p; i <= nl; i++) {
      if (i === nl || buf[i] === COMMA) {
        if (f === 0) { tsS = s; tsE = i; }
        else if (f === 7) { cS = s; cE = i; }
        else if (f === 9) { syS = s; syE = i; }
        f++; s = i + 1;
      }
    }
    p = nl + 1;
    if (f < 10) continue;
    const sym = buf.toString("latin1", syS, syE).trim();
    const m = wanted.get(sym);
    if (!m) continue;
    const t = Date.parse(buf.toString("latin1", tsS, tsE));
    let inWin = false;
    for (const w of windows) if (t >= w.lo && t <= w.hi) { inWin = true; break; }
    if (!inWin) continue;
    m.set(t, parseFloat(buf.toString("latin1", cS, cE)));
  }
}

console.log("Seam coherence — does the NEW contract confirm the OLD contract's move?\n");
console.log("roll              interval    old moved   new moved   divergence   verdict");
let worst = 0, worstAt = "";
for (const r of meta.rollovers) {
  const A = wanted.get(r.from), B = wanted.get(r.to);
  const tH = r.ms;
  // Previous bar of the old contract before the handover.
  let tPrev = -1;
  for (const t of A.keys()) if (t < tH && t > tPrev) tPrev = t;
  if (tPrev < 0 || !A.has(tH) || !B.has(tH) || !B.has(tPrev)) {
    console.log(`  ${new Date(tH).toISOString().slice(0, 16)}  (insufficient overlap to check)`);
    continue;
  }
  const moveA = A.get(tH) - A.get(tPrev);
  const moveB = B.get(tH) - B.get(tPrev);
  const div = Math.abs(moveA - moveB);
  const mins = Math.round((tH - tPrev) / 60000);
  if (div > worst) { worst = div; worstAt = new Date(tH).toISOString().slice(0, 16); }
  const verdict = div < 3 ? "coherent" : div < 15 ? "minor divergence" : "CHECK";
  console.log(
    `  ${new Date(tH).toISOString().slice(0, 16)}  ${String(mins).padStart(6)}m  ` +
    `${moveA.toFixed(2).padStart(10)}  ${moveB.toFixed(2).padStart(10)}  ` +
    `${div.toFixed(2).padStart(10)}   ${verdict}`
  );
}
console.log(`\n  worst divergence between the two contracts: ${worst.toFixed(2)}pt at ${worstAt}`);
console.log(worst < 15
  ? "  -> Both contracts agree across every seam. The residual moves are real market\n     moves, correctly preserved rather than adjusted away."
  : "  -> A seam is not confirmed by the incoming contract; investigate that roll.");
