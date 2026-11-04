// Cammy Capital's volume profile strategy, from the 44 videos of the Order Flow and
// Volume Profile playlists (2024-2025). The levels are the ones the Tradovate indicator
// TradingCustomIndicators/tradovate/cammyValueLevels.js draws, from the same arithmetic
// (src/valueprofile.mjs); test.mjs holds the two to the same levels. "VP 14" below is
// video 14 of the Volume Profile Series, "OF 5" video 5 of the Order Flow Series.
//
// FIXED, because the videos state them as rules:
//   - profiles in New York time, value area 70%, 1000 rows [VP 10, 15]: the previous
//     week (Sunday 18:00 -> Friday 17:00), the previous day's regular session (09:30 ->
//     16:00, until the next 16:00 close), the overnight (18:00 -> 09:29, for New York),
//     and the developing profile of the session traded (from 18:00, or 09:30)
//   - a level is traded on its first tap in the session [VP 4, 5, 14], with a resting
//     limit order and no candle confirmation [VP 14]: from above it is support (a buy),
//     from below resistance (a sell) [OF 7, VP 13, 17]
//   - the developing profile counts once it has had 30 minutes [VP 19, 20]
//   - a grade by confluence, sized A 100%, B 50%, C 25% of the risk [VP 13, 14, 20]
//   - a 1:1 target, the "base hit", by default [VP 5, 18, 30], and the day done after
//     one win or two losses [VP 26] (exec.dayMaxWins, exec.dayMaxLosses)
//   - risk per A trade: 10% of the eval's drawdown [VP 9, 18]
//
// SETTINGS, because they are the calls Cammy makes by eye; each has a few versions:
//   - which side: price accepted beyond the previous day's POC for `acceptMin` minutes
//     (held above = longs, failed below = shorts) [VP 13, 17, 24, 25, 26], the
//     developing POC's move since it formed [VP 22, 24, 25], both, or off
//   - nodes: a smoothed developing profile, a node where it reaches `nodeLevel` of its
//     POC's volume, and the node's edge where it falls below that
//   - no fade of a level with a node building in front of it, between price and the
//     level: a support shelf under a level to be sold [VP 17]
//   - the stop behind the nearest node, or behind the stack [VP 5, 13, 20]. Nodes are
//     read from the developing profile, which has no volume at or behind a level the
//     session has not traded at: a first tap of a previous profile's level takes the
//     stop behind the stack, and the node stop is for the developing profile's edges
//   - a balanced (D-shaped) profile's own edges as levels too [VP 29]
//   - the stack distance, the POC as an entry, the R:R check [VP 11]
//
// NOT CODED: the order-flow reads (DOM, Bookmap, tape) need data these bars do not
// have; runners, which Cammy keeps for funded accounts past their buffer [VP 18].
//
// RESULT (research/cammy_protocol.mjs, 2026-11-04): no edge.
//   - At Cammy's risk it cannot pass. It passes 0% of 2026's windows by either method, at
//     the $1,250 and $3,000 evals, making about $5 a trade on 1 or 2 lots.
//   - 2026, $1,250 eval: 168 trades, 60.1% won, PF 1.26, +$772. Forward, Jul 15 - Oct 30:
//     92 trades, 63% won, PF 1.48, +$705. No coin-flip twin nets as much in either.
//   - Placebo markets do as well. On paths that turn each bar up-for-down at random, where
//     no level can mean anything, it wins 60.6% and nets +$621 in 2026 (10 paths). It
//     matches the real bars in each half and forward (7, 10 and 9 of 20 paths net as much).
//   - The 60% is the bar a limit fills on. The engine credits the target whenever that bar's
//     high reached it (exec.limitFillTp "high"), though the high may have printed before
//     price came down to the order. That was 76 of the 168 trades. Counted only when the
//     bar closed beyond it, the book wins 43.6% and loses $1,710, and the placebo paths
//     lose $1,715.
//   - The coin-flip twin is fooled for the same reason: flipped, a buy limit is a sell stop,
//     and on the same bar the engine charges the stop's stop.
//   - No version of the settings holds. Across 41 of them, the edge over placebo in Jan-Mar
//     says nothing about Apr-Jul (rank correlation -0.17). Two beat all 10 of their placebo
//     paths, where chance alone gives about 4. The one the worse half picks, an 80-tick stop
//     where no node is behind, beat placebo in both halves and then lost to it forward:
//     +$783 against +$870, and 13 of 20 paths netted as much.
//   - A lead at most: a POC as an entry even when nothing stacks beat placebo forward
//     (+$1,286 against +$707, 2 of 20 paths as much). It was not the pick, it was read
//     after seeing the halves, and its Apr-Jul edge was weak (5 of 20 paths as much).

import { atr } from "../src/indicators.mjs";
import { Profile, levels, balanced } from "../src/valueprofile.mjs";
import { chk, trig, sized, info, verdict, mark, num, px, pts, clock, COLOR } from "../src/explain.mjs";

const TICK = 0.25;
const RTH_OPEN = 570, RTH_CLOSE = 960, GLOBEX = 1080;      // New York minutes
const FORMING_MIN = 30;
const RTH = 0, ON = 1, POST = 2;
// the twelve levels: previous week, previous day, overnight, developing
const NAME = ["PW VAH", "PW POC", "PW VAL", "PD VAH", "PD POC", "PD VAL", "ON VAH", "ON POC", "ON VAL", "dev VAH", "dev POC", "dev VAL"];
const PROF = [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3];
const PART = ["vah", "poc", "val"];
const COLORS = ["#ff9800", "#ff9800", "#ff9800", "#e6e6e6", "#e6e6e6", "#e6e6e6", "#9fa8da", "#9fa8da", "#9fa8da", "#2962ff", "#f23645", "#2962ff"];
const GRADE = ["", "C", "B", "A"];
const SIZE = [0, 0.25, 0.5, 1];
// why no level was considered
const NONE = ["", "between the 16:00 close and the 18:00 open", "a session this book does not trade", "the first 30 minutes of the profile",
              "no level left to tap", "no previous day profile loaded"];
// what was checked, one bit each
const B = { POC: 1, SIDE: 2, VETO: 4, STOP: 8, RR: 16, GRADE: 32, NODE_AT: 64, CTX: 128, NODE_STOP: 256, FORMED: 512 };
const ALL = B.POC | B.SIDE | B.VETO | B.STOP | B.RR | B.GRADE;

const onOff = [["on", "On"], ["off", "Off"]];
const weekOf = (td) => Math.floor((td + 3) / 7);

export default {
  id: "cammy_value_levels",
  name: "Cammy Capital value levels",
  description: "Cammy Capital's volume profile strategy: limit orders at the first tap of the previous week's, previous day's and overnight value levels, graded by how many stack, with the side, nodes and stops as settings. 1:1, one win or two losses a day. No edge: random placebo markets do as well, and its 60% win rate comes from how the bar a limit fills on is read.",

  timeframeMin: 1,
  warmupBars: 300,
  // the previous week's profile needs that whole week behind the window
  warmupSessions: 12,
  execDefaults: {
    sizingMode: "risk", riskDollars: 200, contracts: 4, maxContracts: 20,
    entryType: "limit", entryWindowBars: 1, flipOnOpposite: false, cancelOpposite: true,
    tpMode: "rr", tpRR: 1, slAtrMult: 2, slippageTicks: 1,
    dayMaxWins: 1, dayMaxLosses: 2,
  },
  // 10% of the drawdown on an A trade [VP 9, 18]
  evals: { "1250": { exec: { riskDollars: 100 } }, "3000": { exec: { riskDollars: 200 } } },

  params: [
    { key: "sessions", label: "Sessions traded", type: "select", default: "both",
      options: [["both", "Overnight and New York"], ["overnight", "Overnight only"], ["ny", "New York only"]] },
    { key: "overnightStart", label: "Overnight profile starts", type: "select", default: "globex",
      options: [["globex", "18:00, the Globex open"], ["close", "16:00, with the post-close volume"]], hint: "VP 10, 20 and 26." },
    { key: "formingWait", label: "First 30 minutes", type: "select", default: "dev",
      options: [["dev", "Levels trade at once; the developing profile waits"], ["all", "Nothing trades"]],
      hint: "Cammy traded overnight levels right off the New York open (VP 4) and waits 30 minutes for a developing profile (VP 19, 20)." },
    { key: "rows", label: "Profile rows (0 = a row a tick)", type: "int", min: 0, max: 2000, step: 50, default: 1000 },
    { key: "stackTicks", label: "Stack distance (ticks)", type: "int", min: 1, max: 80, step: 1, default: 16,
      hint: "Never stated. Cammy's NQ stacks sat about 4 points apart (VP 12), ES about 1.5 (VP 22)." },
    { key: "pocEntry", label: "A POC as the entry", type: "select", default: "stacked",
      options: [["stacked", "Only when stacked"], ["always", "Always"], ["never", "Never"]],
      hint: "Cammy prefers the value area's edges; a POC is noisy and a target more than an entry (VP 6, 23)." },
    { key: "sideRule", label: "Which side", type: "select", default: "fairValue",
      options: [["fairValue", "Held above / failed below the previous day's POC"], ["migration", "Where the developing POC moved"],
                ["both", "Neither against it"], ["off", "Both sides"]] },
    { key: "acceptMin", label: "Held or failed: minutes beyond the POC", type: "int", min: 5, max: 120, step: 5, default: 30 },
    { key: "migTicks", label: "Value moved: developing POC ticks", type: "int", min: 1, max: 200, step: 1, default: 16 },
    { key: "nodeSmooth", label: "Nodes: smoothing (ticks either side)", type: "int", min: 0, max: 20, step: 1, default: 4 },
    { key: "nodeLevel", label: "Nodes: share of the POC's volume", type: "float", min: 0.2, max: 0.95, step: 0.05, default: 0.6 },
    { key: "nodeVeto", label: "No fade with a node in front", type: "select", default: "on", options: onOff,
      hint: "A node between price and the level, past the stack: a shelf under a level to be sold, over one to be bought (VP 17)." },
    { key: "vetoTicks", label: "Node in front: within (ticks)", type: "int", min: 4, max: 200, step: 4, default: 40 },
    { key: "devEdges", label: "Developing VAH / VAL as levels", type: "select", default: "balanced",
      options: [["balanced", "When the profile is balanced (D-shaped)"], ["always", "Always"], ["off", "Never"]], hint: "VP 29." },
    { key: "balancePct", label: "Balanced: value area share of the range (%)", type: "int", min: 30, max: 95, step: 5, default: 60 },
    { key: "countNodes", label: "A node at the level adds to the grade", type: "select", default: "on", options: onOff,
      hint: "Within the stack distance: the profile's volume running up to the level, its hard edge there (VP 17). A node further in front is the veto's." },
    { key: "countContext", label: "The side agreeing adds to the grade", type: "select", default: "on", options: onOff },
    { key: "minGrade", label: "Lowest grade traded", type: "select", default: "C",
      options: [["C", "C: one confluence, a quarter size"], ["B", "B: two, half size"], ["A", "A: three or more, full size"]],
      hint: "Cammy sizes C at 25% (VP 14) and says to aim for two or more (VP 20)." },
    { key: "stopRule", label: "Stop", type: "select", default: "node",
      options: [["node", "Behind the nearest node"], ["fixed", "A fixed distance behind the stack"]] },
    { key: "stopTicks", label: "Stop with no node behind (ticks)", type: "int", min: 8, max: 400, step: 4, default: 48 },
    { key: "stopBuffer", label: "Stop beyond the node (ticks)", type: "int", min: 0, max: 40, step: 1, default: 2 },
    { key: "minStopTicks", label: "Stop at least (ticks)", type: "int", min: 4, max: 200, step: 4, default: 24,
      hint: "A 6-point stop is too tight on NQ, even in Asia (VP 11)." },
    { key: "maxStopTicks", label: "Stop at most (ticks)", type: "int", min: 20, max: 800, step: 10, default: 160 },
    { key: "target", label: "Target", type: "select", default: "1R",
      options: [["1R", "1:1"], ["opposing", "The opposing value level"]] },
    { key: "rrCheck", label: "Skip when the opposing level is under 1R", type: "select", default: "on", options: onOff, hint: "VP 11." },
  ],

  compute(bars, p) {
    const { high: H, low: L, close: C, volume: V, ts: TS, ctMin, tday } = bars;
    const n = C.length, tfMin = bars.tfMin || 1;
    const a = atr(H, L, C, 14);
    const sig = new Int8Array(n), sizeMult = new Float32Array(n);
    const orderPx = new Float32Array(n).fill(NaN), stopPts = new Float32Array(n).fill(NaN), targetPts = new Float32Array(n).fill(NaN);
    // what explain(k) and the overlays read back
    const cand = new Int8Array(n).fill(-1), none = new Int8Array(n), bits = new Uint16Array(n), grade = new Int8Array(n);
    const stackMask = new Uint16Array(n), tapMask = new Uint16Array(n), opp = new Float32Array(n).fill(NaN), vetoPx = new Float32Array(n).fill(NaN);
    const fvBias = new Int8Array(n), migBias = new Int8Array(n), devFrom = new Int32Array(n).fill(-1);
    const dev3 = new Float32Array(3 * n).fill(NaN);
    // the previous week's, day's and overnight levels change only between sessions:
    // a table of them, and its row for each bar
    const fixedSets = [new Float64Array(9).fill(NaN)], fixedOf = new Int32Array(n);

    const rows = Math.max(0, Math.trunc(p.rows)), tol = p.stackTicks * TICK + 1e-9;
    const acceptBars = Math.max(1, Math.round(p.acceptMin / tfMin)), r = Math.max(0, Math.trunc(p.nodeSmooth));
    const minG = p.minGrade === "A" ? 3 : p.minGrade === "B" ? 2 : 1;
    const sessions = [];             // one a trading day: its profiles by part, and its levels once known
    const lv = new Float64Array(12); // the levels at this bar, NaN when not in play
    let S = null, curTd = -1;
    let devId = -1, taps = 0, prevC = NaN, runUp = 0, runDn = 0, fv = 0, formedPoc = NaN;
    let weekL = null, weekW = -1;
    const scratchFixed = {}, scratchDev = {};
    let s2 = new Float64Array(0);

    // Which side may trade, and whether the side agrees (the context confluence).
    const allowed = (d, fv, mig) => (p.sideRule === "off" ? true : p.sideRule === "fairValue" ? fv === 0 || fv === d
      : p.sideRule === "migration" ? mig === 0 || mig === d : (fv === 0 || fv === d) && (mig === 0 || mig === d));
    const context = (d, fv, mig) => (p.sideRule === "migration" ? mig === d : p.sideRule === "both" ? fv === d && mig === d : fv === d);

    // The developing profile's nodes: a triangle-smoothed volume per tick, r ticks either
    // side, read from double prefix sums over a window round the level being judged; a
    // node is where it reaches nodeLevel of the POC's smoothed volume.
    // smoothed(t) = (S2[t+r] - 2 S2[t-1] + S2[t-r-2]) / (r+1)^2, S2 the prefix sum of the prefix sum
    const W = Math.max(p.maxStopTicks + p.stopBuffer, p.vetoTicks) + p.stackTicks + 2;
    let nList = null, nPoc = 0, s2lo = 0, wLo = 1, wHi = 0, thr = NaN;
    const raw = (t) => {
      if (nList.length === 1) { const pr = nList[0]; return t >= pr.lo && t <= pr.hi ? pr.v[t - pr.base] : 0; }
      let x = 0;
      for (const pr of nList) if (pr.v && t >= pr.lo && t <= pr.hi) x += pr.v[t - pr.base];
      return x;
    };
    const smAt = (t) => (s2[t + r - s2lo] - 2 * s2[t - 1 - s2lo] + s2[t - r - 2 - s2lo]) / ((r + 1) * (r + 1));
    const nodesAround = (pt) => {
      if (pt - W >= wLo && pt + W <= wHi) return;
      if (!(thr === thr)) {
        let sum = 0;
        for (let j = -r; j <= r; j++) sum += (r + 1 - Math.abs(j)) * raw(nPoc + j);
        thr = (p.nodeLevel * sum) / ((r + 1) * (r + 1));
      }
      wLo = pt - W; wHi = pt + W; s2lo = wLo - r - 3;
      const len = wHi + r + 1 - s2lo;
      if (s2.length < len) s2 = new Float64Array(len * 2);
      let s1 = 0, acc = 0;
      for (let k = 0; k < len; k++) { s1 += raw(s2lo + k); acc += s1; s2[k] = acc; }
    };
    const isNode = (t) => t >= wLo && t <= wHi && thr > 0 && smAt(t) >= thr;

    const levelsOf = (list) => {
      const x = levels(list, rows, scratchFixed);
      return x ? { vah: x.vahT * TICK, poc: x.pocT * TICK, val: x.valT * TICK } : null;
    };
    // PD: the latest regular session that has closed, loaded from 09:30
    const dayLevels = (s, part) => {
      let d = part === POST && s.prof[RTH].v ? s : null;
      if (!d) for (let k = sessions.length - 1; k >= 0; k--) if (sessions[k].td < s.td && sessions[k].prof[RTH].v) { d = sessions[k]; break; }
      if (!d || d.firstEt[RTH] !== RTH_OPEN) return null;
      if (d.rthL === undefined) d.rthL = levelsOf([d.prof[RTH]]);
      return d.rthL;
    };
    // ON: this trading day's 18:00 -> 09:29, loaded from 18:00
    const overnightLevels = (s) => {
      if (!s.prof[ON].v || s.firstEt[ON] !== GLOBEX) return null;
      if (s.onL === undefined) s.onL = levelsOf([s.prof[ON]]);
      return s.onL;
    };
    // PW: the previous week's sessions, when the bars hold it from its Sunday open
    const weekLevels = (s) => {
      const w = weekOf(s.td) - 1;
      if (w === weekW) return weekL;
      weekW = w; weekL = null;
      const ks = sessions.filter((x) => weekOf(x.td) === w);
      if (ks.length && (sessions[0].td < ks[0].td || ks[0].firstEtAny === GLOBEX)) weekL = levelsOf(ks.flatMap((x) => x.prof));
      return weekL;
    };

    for (let i = 0; i < n; i++) {
      const et = (ctMin[i] + 60) % 1440;
      const part = et >= RTH_OPEN && et < RTH_CLOSE ? RTH : et >= RTH_CLOSE && et < GLOBEX ? POST : ON;
      if (tday[i] !== curTd) {
        curTd = tday[i];
        S = { td: curTd, prof: [new Profile(), new Profile(), new Profile()], firstEt: [NaN, NaN, NaN], firstBar: [-1, -1, -1], firstEtAny: et };
        sessions.push(S);
        if (sessions.length > 16) sessions.splice(0, sessions.length - 16);   // older than the previous week
      }
      if (S.firstBar[part] < 0) { S.firstBar[part] = i; S.firstEt[part] = et; }
      if (V[i] > 0) S.prof[part].add(Math.round(L[i] / TICK), Math.round(H[i] / TICK), V[i]);

      // the developing profile of this bar's session, and the bar it started on
      let list = null, from = -1;
      if (part === RTH) { list = [S.prof[RTH]]; from = S.firstBar[RTH]; }
      else if (p.overnightStart === "close") {
        if (part === POST) { list = [S.prof[POST]]; from = S.firstBar[POST]; }
        else {
          const P = sessions.length > 1 ? sessions[sessions.length - 2] : null;
          if (P && P.prof[POST].v) { list = [P.prof[POST], S.prof[ON]]; from = P.firstBar[POST]; }
          else { list = [S.prof[ON]]; from = S.firstBar[ON]; }
        }
      } else if (part === ON) { list = [S.prof[ON]]; from = S.firstBar[ON]; }
      if (from !== devId) { devId = from; taps = 0; prevC = NaN; runUp = 0; runDn = 0; fv = 0; formedPoc = NaN; }
      devFrom[i] = from;

      // the levels in play
      lv.fill(NaN);
      const pdL = from >= 0 ? dayLevels(S, part) : null, onL = part === RTH ? overnightLevels(S) : null, pwL = from >= 0 ? weekLevels(S) : null;
      if (pwL) { lv[0] = pwL.vah; lv[1] = pwL.poc; lv[2] = pwL.val; }
      if (pdL) { lv[3] = pdL.vah; lv[4] = pdL.poc; lv[5] = pdL.val; }
      if (onL) { lv[6] = onL.vah; lv[7] = onL.poc; lv[8] = onL.val; }
      const last = fixedSets[fixedSets.length - 1];
      let same = true;
      for (let k = 0; k < 9; k++) if (!(lv[k] === last[k] || (lv[k] !== lv[k] && last[k] !== last[k]))) { same = false; break; }
      if (!same) fixedSets.push(Float64Array.from(lv.subarray(0, 9)));
      fixedOf[i] = fixedSets.length - 1;
      if (from < 0) { none[i] = 1; continue; }

      const formed = (TS[i] - TS[from]) / 60000 >= FORMING_MIN;
      const D = levels(list, rows, scratchDev);
      let bal = false;
      if (D) {
        dev3[3 * i] = D.vahT * TICK; dev3[3 * i + 1] = D.pocT * TICK; dev3[3 * i + 2] = D.valT * TICK;
        bal = balanced(D, p.balancePct);
        if (formed) { lv[9] = D.vahT * TICK; lv[10] = D.pocT * TICK; lv[11] = D.valT * TICK; }
      }

      // first taps: a bar that reached a level, or gapped across it inside the session
      for (let k = 0; k < 9; k++) {
        const P = lv[k];
        if (!(P === P) || taps & (1 << k)) continue;
        if ((L[i] - TICK / 4 <= P && P <= H[i] + TICK / 4) || (prevC === prevC && ((prevC < P && L[i] > P) || (prevC > P && H[i] < P)))) taps |= 1 << k;
      }
      tapMask[i] = taps;
      prevC = C[i];

      // held above or failed below the previous day's POC; where value has moved since it formed
      if (pdL) {
        if (C[i] > pdL.poc) { runUp++; runDn = 0; } else if (C[i] < pdL.poc) { runDn++; runUp = 0; } else { runUp = 0; runDn = 0; }
        if (runUp >= acceptBars) fv = 1; else if (runDn >= acceptBars) fv = -1;
      }
      if (formed && D && !(formedPoc === formedPoc)) formedPoc = D.pocT;
      const mig = formed && D ? (D.pocT - formedPoc >= p.migTicks ? 1 : formedPoc - D.pocT >= p.migTicks ? -1 : 0) : 0;
      fvBias[i] = fv; migBias[i] = mig;

      if ((p.sessions === "ny" && part !== RTH) || (p.sessions === "overnight" && part === RTH)) { none[i] = 2; continue; }
      if (p.formingWait === "all" && !formed) { none[i] = 3; continue; }

      // where an order can rest: the untapped PW, PD and ON levels, and the developing
      // profile's own VAH and VAL when it is balanced
      const entry = [];
      for (let k = 0; k < 9; k++) if (lv[k] === lv[k] && !(taps & (1 << k))) entry.push(k);
      if (formed && D && (p.devEdges === "always" || (p.devEdges === "balanced" && bal))) entry.push(9, 11);
      if (!entry.length) { none[i] = 4; continue; }
      const c = C[i];
      entry.sort((x, y) => Math.abs(lv[x] - c) - Math.abs(lv[y] - c));

      // this bar's nodes are read afresh
      nList = list.filter((pr) => pr && pr.v); nPoc = D ? D.pocT : 0; wLo = 1; wHi = 0; thr = NaN;

      // the nearest level that passes; failing that, the nearest, to say why not
      let pick = null, nearest = null;
      for (const k of entry) {
        const P = lv[k], d = c > P + 1e-9 ? 1 : c < P - 1e-9 ? -1 : 0;
        if (!d) continue;
        let ok = 0;
        // the stack: levels of different profiles within the stack distance, this one's own included
        let mask = 0, profs = 0, zLo = P, zHi = P;
        for (let j = 0; j < 12; j++) {
          const Q = lv[j];
          if (Q === Q && Math.abs(Q - P) <= tol) { mask |= 1 << j; profs |= 1 << PROF[j]; if (Q < zLo) zLo = Q; if (Q > zHi) zHi = Q; }
        }
        const nProf = (profs & 1) + ((profs >> 1) & 1) + ((profs >> 2) & 1) + ((profs >> 3) & 1);
        const isPoc = k === 1 || k === 4 || k === 7;
        if (!isPoc || p.pocEntry === "always" || (p.pocEntry === "stacked" && nProf >= 2)) ok |= B.POC;
        if (allowed(d, fv, mig)) ok |= B.SIDE;
        if (context(d, fv, mig)) ok |= B.CTX;
        // nodes: one at the level, one building in front of it -- on price's side, past the
        // stack, the shelf under a level to be sold [VP 17] -- and the one behind for the stop
        const pt = Math.round(P / TICK), st = p.stackTicks;
        let vetoAt = NaN, nodeAt = false, useNodes = formed && !!D;
        if (useNodes) {
          nodesAround(pt);
          ok |= B.FORMED;
          for (let t = pt - st; t <= pt + st && !nodeAt; t++) nodeAt = isNode(t);
          if (p.nodeVeto === "on") for (let j = st + 1; j <= p.vetoTicks; j++) { const t = pt + d * j; if (isNode(t)) { vetoAt = t * TICK; break; } }
        }
        if (nodeAt) ok |= B.NODE_AT;
        if (!(vetoAt === vetoAt)) ok |= B.VETO;
        // the stop: behind the stack, and behind the nearest node there when the rule says so
        const edge = d === 1 ? zLo : zHi;
        let stopPx = edge - d * p.stopTicks * TICK;
        if (p.stopRule === "node" && useNodes) {
          let t = pt, found = false;
          for (let j = 0; j <= p.maxStopTicks; j++, t -= d) if (isNode(t)) { found = true; break; }
          if (found) {
            while (isNode(t - d) && d * (pt - t) <= p.maxStopTicks + p.stopBuffer) t -= d;     // to the node's far edge
            const far = t * TICK - d * p.stopBuffer * TICK;
            stopPx = d === 1 ? Math.min(far, edge - p.stopBuffer * TICK) : Math.max(far, edge + p.stopBuffer * TICK);
            ok |= B.NODE_STOP;
          }
        }
        const stopD = Math.round(Math.max(d * (P - stopPx), p.minStopTicks * TICK) / TICK) * TICK;
        if (stopD <= p.maxStopTicks * TICK + 1e-9) ok |= B.STOP;
        // the opposing level: the nearest beyond the stack, the way the trade goes
        let oppD = Infinity;
        for (let j = 0; j < 12; j++) {
          const Q = lv[j];
          if (Q === Q && (d === 1 ? Q > zHi + 1e-9 : Q < zLo - 1e-9)) oppD = Math.min(oppD, d * (Q - P));
        }
        if (p.rrCheck !== "on" || oppD >= stopD - 1e-9) ok |= B.RR;
        const g = Math.min(3, nProf + ((ok & B.NODE_AT) && p.countNodes === "on" ? 1 : 0) + ((ok & B.CTX) && p.countContext === "on" ? 1 : 0));
        if (g >= minG) ok |= B.GRADE;
        const tgt = p.target === "opposing" && oppD < Infinity ? oppD : stopD;
        const here = { k, d, ok, stopD, tgt, g, mask, oppD, vetoAt };
        if (!nearest) nearest = here;
        if ((ok & ALL) === ALL) { pick = here; break; }
      }
      const R = pick || nearest;
      if (!R) { none[i] = 4; continue; }
      cand[i] = R.k; bits[i] = R.ok; grade[i] = R.g; stackMask[i] = R.mask; opp[i] = R.oppD; vetoPx[i] = R.vetoAt;
      stopPts[i] = R.stopD; targetPts[i] = R.tgt; orderPx[i] = lv[R.k];
      if (pick) { sig[i] = R.d; sizeMult[i] = SIZE[R.g]; }
    }

    // a level at bar k, as the loop had it
    const levelAt = (k, j) => (j >= 9 ? (devFrom[k] >= 0 && (TS[k] - TS[devFrom[k]]) / 60000 >= FORMING_MIN ? dev3[3 * k + j - 9] : NaN) : fixedSets[fixedOf[k]][j]);

    // Bar k as the loop read it: the order it rested for the next bar, or why none.
    const explain = (k) => {
      if (cand[k] < 0) {
        const why = NONE[none[k]] || "no level";
        return { dir: 0, checks: [trig("A level to rest an order at", false, { text: why })], marks: [], title: `No order: ${why}` };
      }
      const j = cand[k], P = orderPx[k], d = C[k] > P ? 1 : -1, b = bits[k], g = Math.max(1, Math.min(3, grade[k]));
      const since = devFrom[k] >= 0 ? clock((ctMin[devFrom[k]] + 60) % 1440) : "";
      const stacked = [];
      for (let q = 0; q < 12; q++) if (stackMask[k] & (1 << q)) stacked.push(`${NAME[q]} ${px(levelAt(k, q))}`);
      const fvText = fvBias[k] === 1 ? "held above" : fvBias[k] === -1 ? "failed below" : "not yet accepted either side of";
      const migText = migBias[k] === 1 ? "moved up" : migBias[k] === -1 ? "moved down" : "not moved";
      const sideText = p.sideRule === "off" ? "both sides traded" : p.sideRule === "fairValue" ? `price ${fvText} the previous day's POC`
        : p.sideRule === "migration" ? `the developing POC has ${migText}` : `price ${fvText} the previous day's POC; the developing POC has ${migText}`;
      const tapped = (q) => (tapMask[k] & (1 << q) ? "tapped" : "untapped");
      const checks = [
        trig(`${j >= 9 ? "A balanced developing profile's edge" : `First tap of ${NAME[j]} this session`}: ${px(P)} as ${d === 1 ? "support, a buy" : "resistance, a sell"}`, true,
             { text: `close ${px(C[k])}; the developing profile from ${since} ET${j < 9 ? `; ${NAME[j]} ${tapped(j)}` : ""}` }),
        chk(`A POC as the entry: ${p.pocEntry}`, !!(b & B.POC), { text: j === 1 || j === 4 || j === 7 ? `${stacked.length} level${stacked.length === 1 ? "" : "s"} together` : "not a POC" }),
        chk(`Which side: ${p.sideRule}`, !!(b & B.SIDE), { text: sideText }),
        chk("No node building in front", !!(b & B.VETO), { text: vetoPx[k] === vetoPx[k] ? `a node at ${px(vetoPx[k])}` : (b & B.FORMED) ? `none within ${p.vetoTicks} ticks` : "the profile is still forming" }),
        chk(`Stop at most ${pts(p.maxStopTicks * TICK)}`, !!(b & B.STOP), { text: `${pts(stopPts[k])}, ${(b & B.NODE_STOP) ? "behind the nearest node" : "behind the stack"}` }),
        chk("The opposing level at least 1R away", !!(b & B.RR), { text: Number.isFinite(opp[k]) ? `${pts(opp[k])} to it` : "none beyond" }),
        // a grade under the lowest traded is no order at all; a traded one sets the size
        chk(`Grade ${GRADE[g]}: ${stacked.join(" + ")}${(b & B.NODE_AT) && p.countNodes === "on" ? " + a node" : ""}${(b & B.CTX) && p.countContext === "on" ? " + the side" : ""}`,
            !!(b & B.GRADE), { text: `trades grade ${p.minGrade} and up` }),
        sized(`Size: ${SIZE[g] * 100}% of the risk`, SIZE[g] === 1, { text: `grade ${GRADE[g]}; A trades full size, B half, C a quarter` }),
      ];
      const dir = verdict(d, checks);
      const marks = [mark.level(P, Math.max(0, devFrom[k]), k, `${NAME[j]} ${px(P)}`, { color: COLORS[j] })];
      if (dir) {
        marks.push(mark.level(P - d * stopPts[k], k, k, `stop ${px(P - d * stopPts[k])}`, { color: COLOR.down }));
        marks.push(mark.level(P + d * targetPts[k], k, k, `target ${px(P + d * targetPts[k])}`, { color: COLOR.up }));
      }
      return { dir, size: dir ? SIZE[g] : 0, checks, marks,
               title: dir ? `${d === 1 ? "Buy" : "Sell"} limit at ${NAME[j]} ${px(P)}, grade ${GRADE[g]}` : `No order at ${NAME[j]} ${px(P)}` };
    };

    const out = { sig, atr: a, sizeMult, orderPx, stopPts, targetPts, explain, levelAt };
    // the levels as lines, built once and only when something asks for them
    let lines = null;
    Object.defineProperty(out, "overlays", {
      enumerable: true,
      get() {
        return lines || (lines = NAME.map((name, j) => {
          const data = new Float32Array(n);
          for (let k = 0; k < n; k++) data[k] = j >= 9 ? dev3[3 * k + j - 9] : fixedSets[fixedOf[k]][j];
          return { name, pane: "price", color: COLORS[j], data, ...(j < 9 ? {} : { dash: [3, 3] }) };
        }));
      },
    });
    return out;
  },
};
